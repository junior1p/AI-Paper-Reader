"""
Modal API 服务器 - PDF 翻译服务 (带 Token 认证)
部署: modal deploy modal_server.py
"""

import os
import time
import hashlib
import secrets
from typing import Optional, Dict
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from collections import defaultdict

import modal

# 创建 Modal app
app = modal.App("pdf-translator")

# 定义镜像
image = modal.Image.debian_slim().pip_install(
    "fastapi",
    "uvicorn",
    "pydantic",
    "httpx"
)


# ============ 配置 ============

# 临时密钥盐值（与前端保持一致）
TEMP_KEY_SALT = "pdf-translator-2024-salt"

# 从环境变量读取主密钥（用于生成 token，可选）
MASTER_KEY = os.environ.get("MASTER_KEY", secrets.token_hex(32))
# 从环境变量读取 GLM API Key
GLM_API_KEY = os.environ.get("GLM_API_KEY")
GLM_API_BASE = os.environ.get(
    "GLM_API_BASE",
    "https://open.bigmodel.cn/api/paas/v4/chat/completions"
)
GLM_MODEL = os.environ.get("GLM_MODEL", "glm-4")

# Token 配置
TOKEN_EXPIRE_SECONDS = 3600  # Token 有效期：1小时
RATE_LIMIT_PER_MINUTE = 30   # 每分钟请求限制


# ============ 存储（生产环境建议使用 Redis） ============

# 存储活跃的 token: {token: {"expire_at": timestamp, "created_at": timestamp}}
active_tokens: Dict[str, dict] = {}

# 速率限制存储: {token: [timestamp1, timestamp2, ...]}
rate_limit_store: Dict[str, list] = defaultdict(list)

# 使用的 nonce（防重放攻击）: {nonce: expire_at}
used_nonces: Dict[str, float] = {}


# ============ API 请求模型 ============

class TokenRequest(BaseModel):
    master_key: str  # 主密钥（仅用于获取 token）
    client_id: Optional[str] = None  # 客户端标识（可选）


class TokenResponse(BaseModel):
    token: str
    expires_at: str


class TranslateRequest(BaseModel):
    text: str
    page_number: Optional[int] = None
    timestamp: int  # 请求时间戳
    nonce: str      # 随机字符串（防重放）
    signature: str  # 请求签名


class TranslateResponse(BaseModel):
    translation: str


class QuestionRequest(BaseModel):
    content: str  # PDF 内容
    question: str  # 用户问题
    timestamp: int
    nonce: str
    signature: str


class QuestionResponse(BaseModel):
    answer: str


# ============ FastAPI 应用 ============

web_app = FastAPI(title="PDF Translator API")

# 添加 CORS 支持
web_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 工具函数 ============

def generate_temp_key() -> str:
    """生成当前小时的临时密钥（使用 UTC 时间）"""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    hour_string = f"{now.year}-{str(now.month).zfill(2)}-{str(now.day).zfill(2)}-{str(now.hour).zfill(2)}"
    data = TEMP_KEY_SALT + hour_string
    return hashlib.sha256(data.encode()).hexdigest()[:32]


def verify_temp_key(temp_key: str) -> bool:
    """验证临时密钥是否有效"""
    expected = generate_temp_key()
    return temp_key == expected


def cleanup_expired_tokens():
    """清理过期的 token 和 nonce"""
    now = time.time()

    # 清理过期 token
    expired_tokens = [
        token for token, data in active_tokens.items()
        if data["expire_at"] < now
    ]
    for token in expired_tokens:
        del active_tokens[token]
        if token in rate_limit_store:
            del rate_limit_store[token]

    # 清理过期 nonce
    expired_nonces = [
        nonce for nonce, expire_at in used_nonces.items()
        if expire_at < now
    ]
    for nonce in expired_nonces:
        del used_nonces[nonce]


def generate_token(client_id: Optional[str] = None) -> tuple[str, str]:
    """生成访问 token"""
    cleanup_expired_tokens()

    # 生成随机 token
    token = secrets.token_urlsafe(32)
    now = time.time()
    expire_at = now + TOKEN_EXPIRE_SECONDS

    active_tokens[token] = {
        "expire_at": expire_at,
        "created_at": now,
        "client_id": client_id
    }

    expires_at_str = datetime.fromtimestamp(expire_at).isoformat()
    return token, expires_at_str


def verify_token(token: str) -> bool:
    """验证 token 是否有效"""
    cleanup_expired_tokens()

    if token not in active_tokens:
        return False

    if active_tokens[token]["expire_at"] < time.time():
        del active_tokens[token]
        return False

    return True


def check_rate_limit(token: str) -> bool:
    """检查速率限制"""
    now = time.time()
    minute_ago = now - 60

    # 清理超过1分钟的记录
    rate_limit_store[token] = [
        ts for ts in rate_limit_store[token] if ts > minute_ago
    ]

    # 检查是否超过限制
    if len(rate_limit_store[token]) >= RATE_LIMIT_PER_MINUTE:
        return False

    rate_limit_store[token].append(now)
    return True


def verify_request_signature(request: TranslateRequest | QuestionRequest, token: str) -> bool:
    """验证请求签名"""
    # 1. 验证时间戳（5分钟内有效）
    now = int(time.time())
    if abs(now - request.timestamp) > 300:
        raise HTTPException(status_code=401, detail="Request expired")

    # 2. 验证 nonce（防重放）
    nonce_expire = time.time() + 300  # nonce 5分钟后过期
    if request.nonce in used_nonces:
        raise HTTPException(status_code=401, detail="Nonce already used")
    used_nonces[request.nonce] = nonce_expire

    # 3. 验证签名
    # 签名算法: SHA256(token + timestamp + nonce + request_body)
    if isinstance(request, TranslateRequest):
        body_content = f"{request.text[:100]}{request.page_number or ''}"
    else:
        body_content = f"{request.content[:100]}{request.question}"

    sign_data = f"{token}{request.timestamp}{request.nonce}{body_content}"
    expected_signature = hashlib.sha256(sign_data.encode()).hexdigest()

    if request.signature != expected_signature:
        raise HTTPException(status_code=401, detail="Invalid signature")

    return True


# ============ 公开端点 ============

@web_app.get("/")
async def root():
    return {"message": "PDF Translator API", "status": "running", "version": "2.0"}


@web_app.get("/health")
async def health():
    return {"status": "healthy", "active_tokens": len(active_tokens)}


@web_app.post("/auth/token", response_model=TokenResponse)
async def get_token(request: TokenRequest):
    """
    获取访问 Token
    支持两种认证方式：
    1. 主密钥（MASTER_KEY）
    2. 当前小时的临时密钥（自动生成）
    """
    # 验证主密钥或临时密钥
    is_valid_master = request.master_key == MASTER_KEY
    is_valid_temp = verify_temp_key(request.master_key)

    if not (is_valid_master or is_valid_temp):
        raise HTTPException(status_code=401, detail="Invalid key")

    # 生成 token
    token, expires_at = generate_token(request.client_id)

    return TokenResponse(token=token, expires_at=expires_at)


# ============ 受保护端点 ============

@web_app.post("/translate", response_model=TranslateResponse)
async def translate(request: TranslateRequest, authorization: str = Header(...)):
    """
    翻译文本接口（需要 Token 认证）
    """
    # 提取 Bearer token
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]

    # 验证 token
    if not verify_token(token):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # 验证签名
    verify_request_signature(request, token)

    # 检查速率限制
    if not check_rate_limit(token):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # 检查 GLM API Key
    if not GLM_API_KEY:
        raise HTTPException(status_code=500, detail="GLM API key not configured")

    try:
        # 构建 prompt
        if request.page_number:
            prompt = f"请将以下 PDF 文献的第 {request.page_number} 页内容翻译成中文。保持原文的格式和结构，只返回翻译结果，不要添加任何解释。\n\n原文：\n{request.text}"
        else:
            prompt = f"请将以下 PDF 文献内容翻译成中文。保持原文的格式和结构，只返回翻译结果，不要添加任何解释。\n\n原文：\n{request.text}"

        # 调用 GLM API
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                GLM_API_BASE,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {GLM_API_KEY}"
                },
                json={
                    "model": GLM_MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": prompt
                        }
                    ],
                    "temperature": 0.3
                }
            )

            if response.status_code != 200:
                error_data = response.json()
                raise HTTPException(
                    status_code=response.status_code,
                    detail=error_data.get("error", {}).get("message", "Translation failed")
                )

            result = response.json()
            translation = result["choices"][0]["message"]["content"]

            return TranslateResponse(translation=translation)

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Translation timeout")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@web_app.post("/question", response_model=QuestionResponse)
async def ask_question(request: QuestionRequest, authorization: str = Header(...)):
    """
    基于 PDF 内容回答问题（需要 Token 认证）
    """
    # 提取 Bearer token
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[7:]

    # 验证 token
    if not verify_token(token):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # 验证签名
    verify_request_signature(request, token)

    # 检查速率限制
    if not check_rate_limit(token):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # 检查 GLM API Key
    if not GLM_API_KEY:
        raise HTTPException(status_code=500, detail="GLM API key not configured")

    try:
        # 构建 prompt
        prompt = f"""请基于以下 PDF 文献内容回答用户的问题。请用中文回答。

PDF 内容：
{request.content}

用户问题：
{request.question}

请提供准确、详细的回答。如果问题内容不在 PDF 中，请明确说明。"""

        # 调用 GLM API
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                GLM_API_BASE,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {GLM_API_KEY}"
                },
                json={
                    "model": GLM_MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": prompt
                        }
                    ],
                    "temperature": 0.5
                }
            )

            if response.status_code != 200:
                error_data = response.json()
                raise HTTPException(
                    status_code=response.status_code,
                    detail=error_data.get("error", {}).get("message", "Question answering failed")
                )

            result = response.json()
            answer = result["choices"][0]["message"]["content"]

            return QuestionResponse(answer=answer)

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Question answering timeout")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Modal 函数入口
@app.function(
    image=image,
    secrets=[modal.Secret.from_name("glm-credentials")]  # 从 Modal secrets 读取敏感信息
)
@modal.asgi_app()
def fastapi_app():
    return web_app
