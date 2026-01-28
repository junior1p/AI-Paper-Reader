/**
 * 配置文件示例
 *
 * 将此文件重命名为 config.js 并填入你的配置
 *
 * 注意：config.js 已加入 .gitignore，不会上传到 GitHub
 */

const CONFIG = {
    // Modal API 地址（部署后填入）
    // 留空则使用本地 GLM API
    MODAL_URL: '',

    // GLM API 配置（备用）
    GLM_API_KEY: '',  // 你的 GLM API Key
    GLM_API_BASE: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    GLM_MODEL: 'glm-4'
};

// 自动配置到 localStorage
if (CONFIG.MODAL_URL) {
    localStorage.setItem('modal_url', CONFIG.MODAL_URL);
    localStorage.setItem('use_modal', 'true');
}
if (CONFIG.GLM_API_KEY) {
    localStorage.setItem('glm_api_key', CONFIG.GLM_API_KEY);
    localStorage.setItem('glm_api_base', CONFIG.GLM_API_BASE);
    localStorage.setItem('glm_model', CONFIG.GLM_MODEL);
}
