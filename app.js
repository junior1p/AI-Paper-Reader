// 配置 PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// 全局变量
let pdfDoc = null;
let currentPageNum = 1;
let currentTranslationPageNum = 1;
let totalPages = 0;
let currentScale = 1.5;
let pageData = []; // 存储每页的数据（文本、图片、布局）
let translatedPages = []; // 存储每页的翻译结果

// DOM 元素
const pdfUpload = document.getElementById('pdfUpload');
const pdfContainer = document.getElementById('pdfContainer');
const translationContainer = document.getElementById('translationContainer');
const translateBtn = document.getElementById('translateBtn');
const pdfControls = document.getElementById('pdfControls');
const translationControls = document.getElementById('translationControls');
const currentPageSpan = document.getElementById('currentPage');
const currentTranslationPageSpan = document.getElementById('currentTranslationPage');
const pageInfo = document.getElementById('pageInfo');
const loadingIndicator = document.getElementById('loadingIndicator');

// API 配置
const API_CONFIG = {
    // Modal API 地址（已内置）
    modalUrl: 'https://junioryu607--pdf-translator-fastapi-app.modal.run',
    // 主密钥（用于获取 token）
    masterKey: localStorage.getItem('master_key') || '',
    // 当前访问 token
    accessToken: null,
    tokenExpireAt: null
};

// ============ 使用限额配置 ============

const USAGE_LIMITS = {
    pdfUploads: 10,    // 每月 PDF 上传次数
    questions: 20,      // 每月问答次数
    period: 'month'     // 统计周期
};

// 获取当前月份标识
function getCurrentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// 获取使用记录
function getUsageStats() {
    const stats = JSON.parse(localStorage.getItem('usage_stats') || '{}');
    const currentMonth = getCurrentMonthKey();

    if (!stats[currentMonth]) {
        stats[currentMonth] = {
            pdfUploads: 0,
            questions: 0,
            pdfIds: [] // 记录已上传的 PDF ID，避免重复计数
        };
    }

    return stats;
}

// 保存使用记录
function saveUsageStats(stats) {
    localStorage.setItem('usage_stats', JSON.stringify(stats));
}

// 检查是否超过限额
function checkLimit(type) {
    const stats = getUsageStats();
    const currentMonth = getCurrentMonthKey();
    const monthStats = stats[currentMonth];

    if (type === 'pdf') {
        return monthStats.pdfUploads < USAGE_LIMITS.pdfUploads;
    } else if (type === 'question') {
        return monthStats.questions < USAGE_LIMITS.questions;
    }
    return true;
}

// 记录使用
function recordUsage(type, pdfId = null) {
    const stats = getUsageStats();
    const currentMonth = getCurrentMonthKey();
    const monthStats = stats[currentMonth];

    if (type === 'pdf' && pdfId) {
        // 检查是否已记录过此 PDF
        if (!monthStats.pdfIds.includes(pdfId)) {
            monthStats.pdfUploads += 1;
            monthStats.pdfIds.push(pdfId);
        }
    } else if (type === 'question') {
        monthStats.questions += 1;
    }

    saveUsageStats(stats);
    updateUsageDisplay();
}

// 获取剩余次数
function getRemainingUsage() {
    const stats = getUsageStats();
    const currentMonth = getCurrentMonthKey();
    const monthStats = stats[currentMonth];

    return {
        pdfUploads: USAGE_LIMITS.pdfUploads - monthStats.pdfUploads,
        questions: USAGE_LIMITS.questions - monthStats.questions
    };
}

// 更新使用次数显示
function updateUsageDisplay() {
    const remaining = getRemainingUsage();

    // 更新 PDF 上传按钮提示
    const uploadBtn = document.querySelector('.btn-primary[onclick*="pdfUpload"]');
    if (uploadBtn) {
        const pdfInfo = remaining.pdfUploads > 0
            ? `(本月剩余 ${remaining.pdfUploads}/${USAGE_LIMITS.pdfUploads} 次)`
            : `(本月额度已用完)`;
        // 不修改按钮文本，只更新 title
    }

    // 更新问答按钮提示
    const askBtn = document.getElementById('askBtn');
    if (askBtn) {
        const questionInfo = remaining.questions > 0
            ? `(本月剩余 ${remaining.questions}/${USAGE_LIMITS.questions} 次)`
            : `(本月额度已用完)`;
    }

    // 在设置面板中显示
    const usageInfo = document.getElementById('usageInfo');
    if (usageInfo) {
        usageInfo.innerHTML = `
            <div style="font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 15px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                <div style="margin-bottom: 5px;">📊 本月使用额度</div>
                <div>📄 PDF 上传: ${USAGE_LIMITS.pdfUploads - remaining.pdfUploads}/${USAGE_LIMITS.pdfUploads}</div>
                <div>💬 问答次数: ${USAGE_LIMITS.questions - remaining.questions}/${USAGE_LIMITS.questions}</div>
            </div>
        `;
    }
}

// ============ 临时密钥生成 ============

// 固定盐值（前后端保持一致）
const TEMP_KEY_SALT = 'pdf-translator-2024-salt';

/**
 * 生成当前小时的临时密钥
 * 算法：SHA256(盐值 + 当前小时字符串)
 * 使用 UTC 时间确保前后端一致
 */
async function generateTempKey() {
    const now = new Date();
    // 使用 UTC 时间
    const utcYear = now.getUTCFullYear();
    const utcMonth = String(now.getUTCMonth() + 1).padStart(2, '0');
    const utcDay = String(now.getUTCDate()).padStart(2, '0');
    const utcHour = String(now.getUTCHours()).padStart(2, '0');
    const hourString = `${utcYear}-${utcMonth}-${utcDay}-${utcHour}`;

    const data = TEMP_KEY_SALT + hourString;
    const encoder = new TextEncoder();
    const buffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

/**
 * 更新显示的临时密钥
 */
async function updateTempKeyDisplay() {
    const tempKey = await generateTempKey();
    const displayEl = document.getElementById('tempKeyDisplay');
    const copyBtn = document.getElementById('copyTempKeyBtn');

    if (displayEl) {
        displayEl.textContent = tempKey;
        // 添加复制提示
        displayEl.onclick = () => {
            navigator.clipboard.writeText(tempKey);
            displayEl.style.background = 'rgba(16, 185, 129, 0.2)';
            setTimeout(() => {
                displayEl.style.background = 'rgba(0, 0, 0, 0.4)';
            }, 500);
        };
    }

    if (copyBtn) {
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(tempKey);
            copyBtn.textContent = '✓ 已复制';
            setTimeout(() => {
                copyBtn.textContent = '📋 复制';
            }, 2000);
        };
    }
}

// 每分钟更新一次临时密钥显示
setInterval(updateTempKeyDisplay, 60000);


// ============ Token 认证相关函数 ============

/**
 * 生成随机字符串（用于 nonce）
 */
function generateNonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * 生成请求签名
 * 签名算法: SHA256(token + timestamp + nonce + bodyContent)
 */
async function generateSignature(token, timestamp, nonce, bodyContent) {
    const signData = `${token}${timestamp}${nonce}${bodyContent}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(signData);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 检查并刷新 token
 */
async function ensureValidToken() {
    // 如果 token 有效且未过期，直接返回
    if (API_CONFIG.accessToken && API_CONFIG.tokenExpireAt) {
        const now = Date.now();
        if (now < API_CONFIG.tokenExpireAt - 60000) { // 提前1分钟刷新
            return API_CONFIG.accessToken;
        }
    }

    // 需要获取新 token
    if (!API_CONFIG.masterKey) {
        throw new Error('请先配置 Master Key。在浏览器控制台执行: localStorage.setItem("master_key", "你的主密钥")');
    }

    try {
        const response = await fetch(`${API_CONFIG.modalUrl}/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                master_key: API_CONFIG.masterKey,
                client_id: 'web-client'
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || '获取 Token 失败');
        }

        const data = await response.json();
        API_CONFIG.accessToken = data.token;
        API_CONFIG.tokenExpireAt = new Date(data.expires_at).getTime();

        console.log('Token 已更新，过期时间:', data.expires_at);
        return data.token;

    } catch (error) {
        console.error('获取 Token 失败:', error);
        throw error;
    }
}

/**
 * 发起已认证的 API 请求
 */
async function authenticatedFetch(endpoint, requestData) {
    // 1. 获取有效 token
    const token = await ensureValidToken();

    // 2. 生成时间戳和 nonce
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = generateNonce();

    // 3. 计算签名内容
    let bodyContent;
    if (endpoint === '/translate') {
        bodyContent = `${requestData.text.substring(0, 100)}${requestData.page_number || ''}`;
    } else if (endpoint === '/question') {
        bodyContent = `${requestData.content.substring(0, 100)}${requestData.question}`;
    }

    // 4. 生成签名
    const signature = await generateSignature(token, timestamp, nonce, bodyContent);

    // 5. 构建请求
    const payload = {
        ...requestData,
        timestamp,
        nonce,
        signature
    };

    // 6. 发送请求
    const response = await fetch(`${API_CONFIG.modalUrl}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
    });

    // 7. 处理响应
    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: '请求失败' }));

        // Token 过期，清除缓存并重试一次
        if (response.status === 401 && error.detail.includes('expired')) {
            API_CONFIG.accessToken = null;
            API_CONFIG.tokenExpireAt = null;
            return authenticatedFetch(endpoint, requestData);
        }

        throw new Error(error.detail || `请求失败: ${response.status}`);
    }

    return response.json();
}

// 初始化
window.addEventListener('DOMContentLoaded', async () => {
    // 加载已保存的配置
    loadSettings();

    // 更新临时密钥显示
    await updateTempKeyDisplay();

    // 更新使用额度显示
    updateUsageDisplay();

    // 检查是否配置了 Master Key
    if (!API_CONFIG.masterKey) {
        // 自动打开设置面板
        setTimeout(() => openSettings(), 500);
    }
});


// ============ 设置面板功能 ============

/**
 * 打开设置面板
 */
function openSettings() {
    const modal = document.getElementById('settingsModal');
    modal.style.display = 'flex';

    // 填充当前值（只填充主密钥）
    document.getElementById('masterKeyInput').value = API_CONFIG.masterKey || '';
    document.getElementById('settingStatus').textContent = '';
    document.getElementById('settingStatus').className = 'setting-status';

    // 确保临时密钥已显示
    updateTempKeyDisplay();

    // 更新使用额度显示
    updateUsageDisplay();
}

/**
 * 关闭设置面板
 */
function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

/**
 * 保存设置
 */
async function saveSettings() {
    const masterKey = document.getElementById('masterKeyInput').value.trim();
    const statusDiv = document.getElementById('settingStatus');

    // 验证输入
    if (!masterKey) {
        showStatus('请先复制并粘贴上方显示的临时密钥', 'error');
        return;
    }

    showStatus('正在验证配置...', 'info');

    // 保存到 localStorage
    localStorage.setItem('master_key', masterKey);

    // 更新当前配置
    API_CONFIG.masterKey = masterKey;
    API_CONFIG.accessToken = null;
    API_CONFIG.tokenExpireAt = null;

    // 验证配置（尝试获取 Token）
    try {
        const response = await fetch(`${API_CONFIG.modalUrl}/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                master_key: masterKey,
                client_id: 'web-client'
            })
        });

        if (response.ok) {
            const data = await response.json();
            API_CONFIG.accessToken = data.token;
            API_CONFIG.tokenExpireAt = new Date(data.expires_at).getTime();

            showStatus('✓ 配置保存成功！', 'success');

            // 2秒后关闭弹窗
            setTimeout(() => closeSettings(), 2000);
        } else {
            const error = await response.json().catch(() => ({ detail: '验证失败' }));
            showStatus(`✗ ${error.detail || '密钥无效或已过期'}`, 'error');
        }
    } catch (error) {
        showStatus(`✗ 连接失败: ${error.message}`, 'error');
    }
}

/**
 * 显示状态信息
 */
function showStatus(message, type) {
    const statusDiv = document.getElementById('settingStatus');
    statusDiv.textContent = message;
    statusDiv.className = `setting-status ${type}`;
}

/**
 * 加载已保存的设置
 */
function loadSettings() {
    const savedUrl = localStorage.getItem('modal_url');
    const savedKey = localStorage.getItem('master_key');

    if (savedUrl) {
        API_CONFIG.modalUrl = savedUrl;
    }
    if (savedKey) {
        API_CONFIG.masterKey = savedKey;
    }
}

// PDF 文件上传处理
pdfUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
        alert('请选择 PDF 文件');
        return;
    }

    // 检查 PDF 上传限额
    if (!checkLimit('pdf')) {
        alert(`本月 PDF 上传额度已用完！\n\n每月限制：${USAGE_LIMITS.pdfUploads} 次\n下月自动重置`);
        return;
    }

    pdfContainer.innerHTML = '<div class="placeholder"><p>📄 加载中...</p></div>';

    try {
        const arrayBuffer = await file.arrayBuffer();
        pdfDoc = await pdfjsLib.getDocument(arrayBuffer).promise;
        totalPages = pdfDoc.numPages;
        currentPageNum = 1;
        currentTranslationPageNum = 1;
        pageData = [];
        translatedPages = [];

        // 生成 PDF ID（用于避免重复计数）
        const pdfId = await generatePDFId(arrayBuffer);

        pageInfo.textContent = `共 ${totalPages} 页`;
        currentPageSpan.textContent = `第 ${currentPageNum} 页`;

        pdfControls.style.display = 'flex';
        translateBtn.disabled = false;
        translationControls.style.display = 'none';

        // 启用问答按钮
        document.getElementById('askBtn').disabled = false;

        await extractAllPageData();
        await renderPage(currentPageNum);

        translationContainer.innerHTML = '<div class="placeholder"><p>📖 点击"翻译全文"开始翻译</p></div>';

        // 重置问答历史
        const qaHistory = document.getElementById('qaHistory');
        qaHistory.innerHTML = '<div class="placeholder"><p>💬 基于 PDF 内容提问</p></div>';

        // 记录 PDF 上传使用
        recordUsage('pdf', pdfId);

    } catch (error) {
        console.error('PDF 加载失败:', error);
        pdfContainer.innerHTML = '<div class="placeholder"><p>❌ PDF 加载失败，请重试</p></div>';
    }
});

// 生成 PDF 唯一 ID
async function generatePDFId(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

// 提取页面数据
async function extractAllPageData() {
    for (let i = 1; i <= totalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: currentScale });
        const textContent = await page.getTextContent();
        const operatorList = await page.getOperatorList();
        const images = await extractImagesFromPage(page, operatorList);
        const canvas = await renderPageToCanvas(page, viewport);

        pageData.push({
            pageNum: i,
            width: viewport.width,
            height: viewport.height,
            textItems: textContent.items,
            images: images,
            canvas: canvas
        });

        // 初始化翻译数组
        translatedPages.push(null);
    }
}

// 渲染页面到 canvas
async function renderPageToCanvas(page, viewport) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
        canvasContext: context,
        viewport: viewport
    }).promise;

    return canvas;
}

// 从页面提取图片
async function extractImagesFromPage(page, operatorList) {
    const images = [];

    for (let i = 0; i < operatorList.fnArray.length; i++) {
        if (operatorList.fnArray[i] === pdfjsLib.OPS.paintImageXObject ||
            operatorList.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {

            const imgName = operatorList.argsArray[i][0];

            try {
                let img = null;

                if (operatorList.fnArray[i] === pdfjsLib.OPS.paintImageXObject) {
                    img = await page.objs.get(imgName);
                } else {
                    img = imgName;
                }

                if (img) {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');

                    const imageData = ctx.createImageData(img.width, img.height);
                    const data = imageData.data;

                    if (img.data) {
                        for (let j = 0; j < img.data.length; j++) {
                            data[j] = img.data[j];
                        }
                    }

                    ctx.putImageData(imageData, 0, 0);

                    images.push({
                        dataUrl: canvas.toDataURL(),
                        width: img.width,
                        height: img.height
                    });
                }
            } catch (e) {
                console.log('图片提取失败:', e);
            }
        }
    }

    return images;
}

// 渲染原文指定页面
async function renderPage(pageNum) {
    if (!pageData || pageData.length === 0) return;

    const data = pageData[pageNum - 1];

    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.style.position = 'relative';
    pageDiv.style.width = data.width + 'px';
    pageDiv.style.margin = '0 auto';

    const bgCanvas = data.canvas.cloneNode(true);
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.drawImage(data.canvas, 0, 0);
    bgCanvas.style.width = '100%';
    bgCanvas.style.height = 'auto';
    bgCanvas.style.display = 'block';
    pageDiv.appendChild(bgCanvas);

    pdfContainer.innerHTML = '';
    pdfContainer.appendChild(pageDiv);

    currentPageNum = pageNum;
    currentPageSpan.textContent = `第 ${pageNum} / ${totalPages} 页`;
}

// 原文翻页
function prevPage() {
    if (currentPageNum > 1) {
        renderPage(currentPageNum - 1);
    }
}

function nextPage() {
    if (currentPageNum < totalPages) {
        renderPage(currentPageNum + 1);
    }
}

// 渲染翻译指定页面
function renderTranslationPage(pageNum) {
    if (!translatedPages[pageNum - 1]) {
        translationContainer.innerHTML = '<div class="placeholder"><p>📖 该页尚未翻译</p></div>';
        currentTranslationPageNum = pageNum;
        currentTranslationPageSpan.textContent = `第 ${pageNum} / ${totalPages} 页`;
        return;
    }

    const pageDataInfo = pageData[pageNum - 1];
    const translation = translatedPages[pageNum - 1];

    const pageDiv = document.createElement('div');
    pageDiv.className = 'translated-page';
    pageDiv.style.position = 'relative';
    pageDiv.style.width = pageDataInfo.width + 'px';
    pageDiv.style.margin = '0 auto';

    // 背景 canvas（PDF 原页面）
    const bgCanvas = pageDataInfo.canvas.cloneNode(true);
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.drawImage(pageDataInfo.canvas, 0, 0);
    bgCanvas.style.width = '100%';
    bgCanvas.style.height = 'auto';
    bgCanvas.style.display = 'block';
    bgCanvas.style.opacity = '0.3';
    pageDiv.appendChild(bgCanvas);

    // 翻译层
    const translationOverlay = document.createElement('div');
    translationOverlay.className = 'translation-overlay';
    translationOverlay.style.position = 'absolute';
    translationOverlay.style.top = '0';
    translationOverlay.style.left = '0';
    translationOverlay.style.right = '0';
    translationOverlay.style.bottom = '0';
    translationOverlay.style.padding = '20px';
    translationOverlay.style.background = 'rgba(255, 255, 255, 0.92)';
    translationOverlay.style.lineHeight = '1.8';
    translationOverlay.style.color = '#2c3e50';
    translationOverlay.style.fontSize = '14px';

    const formattedTranslation = translation
        .replace(/--- 第 \d+ 页 ---/g, '')
        .trim();

    translationOverlay.innerHTML = `
        <div class="translation-text">${formattedTranslation.replace(/\n/g, '<br>')}</div>
    `;

    pageDiv.appendChild(translationOverlay);

    translationContainer.innerHTML = '';
    translationContainer.appendChild(pageDiv);

    currentTranslationPageNum = pageNum;
    currentTranslationPageSpan.textContent = `第 ${pageNum} / ${totalPages} 页`;
}

// 翻译翻页
function prevTranslationPage() {
    if (currentTranslationPageNum > 1) {
        renderTranslationPage(currentTranslationPageNum - 1);
    }
}

function nextTranslationPage() {
    if (currentTranslationPageNum < totalPages) {
        renderTranslationPage(currentTranslationPageNum + 1);
    }
}

// 调用翻译 API（使用 Token 认证）
async function translateText(text, pageNumber) {
    try {
        const data = await authenticatedFetch('/translate', {
            text: text,
            page_number: pageNumber
        });
        return data.translation;
    } catch (error) {
        console.error('翻译失败:', error);
        throw error;
    }
}

// 翻译按钮点击事件
translateBtn.addEventListener('click', async () => {
    if (!pdfDoc) {
        alert('请先上传 PDF 文件');
        return;
    }

    translationContainer.innerHTML = '<div class="placeholder"><p>📖 开始翻译...</p></div>';
    loadingIndicator.style.display = 'flex';
    translateBtn.disabled = true;

    // 显示翻页控制
    translationControls.style.display = 'flex';
    currentTranslationPageNum = 1;

    try {
        for (let i = 0; i < pageData.length; i++) {
            const page = pageData[i];

            // 更新进度显示
            translationContainer.innerHTML = `<div class="placeholder"><p>🌐 正在翻译第 ${page.pageNum} / ${totalPages} 页...</p></div>`;

            let pageText = '';
            for (const item of page.textItems) {
                pageText += item.str;
            }

            const translation = await translateText(pageText, page.pageNum);
            translatedPages[i] = translation;

            // 立即显示刚翻译好的页面
            renderTranslationPage(page.pageNum);
        }

        // 翻译完成，回到第一页
        renderTranslationPage(1);

    } catch (error) {
        console.error('翻译过程出错:', error);
        translationContainer.innerHTML = `<div class="placeholder"><p>❌ 翻译失败：${error.message}</p></div>`;
    } finally {
        loadingIndicator.style.display = 'none';
        translateBtn.disabled = false;
    }
});

// ========== 问答功能 ==========

// 标签页切换
function switchTab(tabName) {
    // 更新标签按钮状态
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.tab === tabName) {
            btn.classList.add('active');
        }
    });

    // 更新内容显示
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName + 'Tab').classList.add('active');

    // 如果切换到问答标签，启用问答按钮
    if (tabName === 'qa' && pageData.length > 0) {
        document.getElementById('askBtn').disabled = false;
    }
}

// 提取全部 PDF 文本（用于问答）
function extractFullPDFText() {
    if (!pageData || pageData.length === 0) return '';

    let fullText = '';
    for (const page of pageData) {
        let pageText = '';
        for (const item of page.textItems) {
            pageText += item.str;
        }
        fullText += `\n\n[第 ${page.pageNum} 页]\n${pageText}`;
    }
    return fullText;
}

// 处理回车键发送问题
function handleQuestionEnter(event) {
    if (event.key === 'Enter') {
        askQuestion();
    }
}

// 预设问题提问
async function askPresetQuestion(question) {
    if (!pageData || pageData.length === 0) {
        alert('请先上传 PDF 文件');
        return;
    }

    // 检查问答限额
    if (!checkLimit('question')) {
        alert(`本月问答额度已用完！\n\n每月限制：${USAGE_LIMITS.questions} 次\n下月自动重置`);
        return;
    }

    const qaHistory = document.getElementById('qaHistory');

    // 清空初始占位符
    if (qaHistory.querySelector('.placeholder')) {
        qaHistory.innerHTML = '';
    }

    // 添加问题到历史记录
    const questionDiv = document.createElement('div');
    questionDiv.className = 'qa-message';
    questionDiv.innerHTML = `<div class="qa-question">${question}</div>`;
    qaHistory.appendChild(questionDiv);

    // 添加加载状态
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'qa-message';
    loadingDiv.innerHTML = `<div class="qa-answer">正在思考...</div>`;
    qaHistory.appendChild(loadingDiv);

    // 滚动到底部
    qaHistory.scrollTop = qaHistory.scrollHeight;

    try {
        // 提取 PDF 全部内容
        const pdfContent = extractFullPDFText();

        // 使用认证请求
        const data = await authenticatedFetch('/question', {
            content: pdfContent,
            question: question
        });

        // 移除加载状态
        loadingDiv.remove();

        // 添加回答到历史记录
        const answerDiv = document.createElement('div');
        answerDiv.className = 'qa-message';
        answerDiv.innerHTML = `<div class="qa-answer">${data.answer}</div>`;
        qaHistory.appendChild(answerDiv);

        // 滚动到底部
        qaHistory.scrollTop = qaHistory.scrollHeight;

        // 记录问答使用
        recordUsage('question');

    } catch (error) {
        console.error('问答失败:', error);
        loadingDiv.innerHTML = `<div class="qa-answer">❌ 回答失败：${error.message}</div>`;
    }
}

// 提问功能
async function askQuestion() {
    const questionInput = document.getElementById('questionInput');
    const question = questionInput.value.trim();

    if (!question) return;

    if (!pageData || pageData.length === 0) {
        alert('请先上传 PDF 文件');
        return;
    }

    // 检查问答限额
    if (!checkLimit('question')) {
        alert(`本月问答额度已用完！\n\n每月限制：${USAGE_LIMITS.questions} 次\n下月自动重置`);
        return;
    }

    const qaHistory = document.getElementById('qaHistory');

    // 清空初始占位符
    if (qaHistory.querySelector('.placeholder')) {
        qaHistory.innerHTML = '';
    }

    // 添加问题到历史记录
    const questionDiv = document.createElement('div');
    questionDiv.className = 'qa-message';
    questionDiv.innerHTML = `<div class="qa-question">${question}</div>`;
    qaHistory.appendChild(questionDiv);

    // 清空输入框
    questionInput.value = '';

    // 添加加载状态
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'qa-message';
    loadingDiv.innerHTML = `<div class="qa-answer">正在思考...</div>`;
    qaHistory.appendChild(loadingDiv);

    // 滚动到底部
    qaHistory.scrollTop = qaHistory.scrollHeight;

    try {
        // 提取 PDF 全部内容
        const pdfContent = extractFullPDFText();

        // 使用认证请求
        const data = await authenticatedFetch('/question', {
            content: pdfContent,
            question: question
        });

        // 移除加载状态
        loadingDiv.remove();

        // 添加回答到历史记录
        const answerDiv = document.createElement('div');
        answerDiv.className = 'qa-message';
        answerDiv.innerHTML = `<div class="qa-answer">${data.answer}</div>`;
        qaHistory.appendChild(answerDiv);

        // 滚动到底部
        qaHistory.scrollTop = qaHistory.scrollHeight;

        // 记录问答使用
        recordUsage('question');

    } catch (error) {
        console.error('问答失败:', error);
        loadingDiv.innerHTML = `<div class="qa-answer">❌ 回答失败：${error.message}</div>`;
    }
}
