const axios = require('axios').default;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataManager } = require('./data-manager');

const instance = axios.create({
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json'
    }
});

function extractErrorMessage(error) {
    if (error.response?.data) {
        return error.response.data.errmsg || error.response.data.error || error.response.data.error_description || JSON.stringify(error.response.data);
    }
    return error.message || '未知错误';
}

function maskSensitiveValue(value, showLength = 4) {
    if (!value || typeof value !== 'string') {
        return value;
    }
    if (value.length <= showLength * 2) {
        return '*'.repeat(value.length);
    }
    return value.substring(0, showLength) + '*'.repeat(value.length - showLength * 2) + value.substring(value.length - showLength);
}

async function retryOperation(operation, maxRetries = 3, delayMs = 1000) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const backoffDelay = delayMs * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
    }
    throw lastError;
}

function calculateFileHash(filePath, algorithm = 'sha256') {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const fileBuffer = fs.readFileSync(filePath);
        const hash = crypto.createHash(algorithm).update(fileBuffer).digest('hex');
        return hash;
    } catch (error) {
        console.error(`计算文件哈希失败 ${filePath}: ${error.message}`);
        return null;
    }
}

class CloudSync {
    constructor() {
        this.config = null;
        this.token = null;
        this.refreshToken = null;
        this.tokenExpireTime = null;
        this.baseUrl = 'https://pan.baidu.com/rest/2.0/xpan';
        this.initialized = false;
        this.userId = null;
        this.axios = instance;
        this._lastAutoCleanupTime = 0; // 用于 syncData 成功后自动清理的去抖
    }
    
    getAxiosInstance() {
        return this.axios;
    }
    
    static calculateFileHash(filePath, algorithm = 'sha256') {
        return calculateFileHash(filePath, algorithm);
    }
    
    setUserId(userId) {
        this.userId = userId;
    }
    
    getUserId() {
        return this.userId;
    }
    
    getDataPath() {
        if (this.userId && this.userId.trim() !== '' && this.userId !== 'admin') {
            return `/apps/Elysia/users/${encodeURIComponent(this.userId)}/data.json`;
        }
        return '/apps/Elysia/data.json';
    }

    async init(config) {
        this.config = config;
        if (config.token && config.tokenExpireTime) {
            this.token = config.token;
            this.tokenExpireTime = config.tokenExpireTime;
        }
        if (config.refreshToken) {
            this.refreshToken = config.refreshToken;
        }
        return this;
    }

    async getAccessToken() {
        if (this.token && this.tokenExpireTime && Date.now() < this.tokenExpireTime) {
            return this.token;
        }

        if (this.refreshToken) {
            return await this.refreshAccessToken();
        }

        throw new Error('需要用户授权');
    }

    async refreshAccessToken() {
        try {
            const response = await retryOperation(async () => {
                return axios.post('https://openapi.baidu.com/oauth/2.0/token', null, {
                    params: {
                        grant_type: 'refresh_token',
                        refresh_token: this.refreshToken,
                        client_id: this.config.appKey,
                        client_secret: this.config.appSecret
                    }
                });
            });

            if (response.data.access_token) {
                this.token = response.data.access_token;
                this.refreshToken = response.data.refresh_token;
                this.tokenExpireTime = Date.now() + (response.data.expires_in || 3600) * 1000;
                console.log('刷新令牌成功: access_token=' + maskSensitiveValue(response.data.access_token));
                
                if (this.config.onTokenUpdate) {
                    this.config.onTokenUpdate({
                        token: this.token,
                        refreshToken: this.refreshToken,
                        tokenExpireTime: this.tokenExpireTime
                    });
                }
                
                return this.token;
            }
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            console.error('刷新令牌失败:', errorMsg);
            throw new Error('刷新令牌失败: ' + errorMsg);
        }
        throw new Error('无法刷新访问令牌');
    }

    getAuthUrl() {
        const redirectUri = encodeURIComponent('oob');
        return `https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=${this.config.appKey}&redirect_uri=${redirectUri}&scope=basic,netdisk&display=popup`;
    }

    async exchangeCode(code) {
        try {
            const response = await retryOperation(async () => {
                return axios.post('https://openapi.baidu.com/oauth/2.0/token', null, {
                    params: {
                        grant_type: 'authorization_code',
                        code: code,
                        client_id: this.config.appKey,
                        client_secret: this.config.appSecret,
                        redirect_uri: 'oob'
                    }
                });
            });

            if (response.data.access_token) {
                this.token = response.data.access_token;
                this.refreshToken = response.data.refresh_token;
                this.tokenExpireTime = Date.now() + (response.data.expires_in || 3600) * 1000;
                console.log('交换授权码成功: access_token=' + maskSensitiveValue(response.data.access_token));
                
                return {
                    token: this.token,
                    refreshToken: this.refreshToken,
                    tokenExpireTime: this.tokenExpireTime
                };
            }
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            console.error('交换授权码失败:', errorMsg);
            throw new Error('交换授权码失败: ' + errorMsg);
        }
        throw new Error('无法交换授权码');
    }

    async uploadFile(filePath, cloudPath) {
        const token = await this.getAccessToken();
        
        try {
            const response = await retryOperation(async () => {
                return axios.post(`${this.baseUrl}/file`, null, {
                    params: {
                        method: 'upload',
                        access_token: token,
                        path: cloudPath,
                        filecontent: Buffer.from(fs.readFileSync(filePath)).toString('base64')
                    }
                });
            });
            return response.data;
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            console.error('上传文件失败:', errorMsg);
            throw new Error('上传文件失败: ' + errorMsg);
        }
    }

    async downloadFile(cloudPath, localPath) {
        const token = await this.getAccessToken();
        
        try {
            const response = await retryOperation(async () => {
                return axios.get(`${this.baseUrl}/file`, {
                    params: {
                        method: 'download',
                        access_token: token,
                        path: cloudPath
                    },
                    responseType: 'arraybuffer'
                });
            });
            
            fs.writeFileSync(localPath, response.data);
            return true;
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            console.error('下载文件失败:', errorMsg);
            throw new Error('下载文件失败: ' + errorMsg);
        }
    }

    async cleanupEmptyDirectories(autoClean = false) {
      const token = await this.getAccessToken();

      try {
        // 用 retryOperation 包装 list 调用，提高网络抖动下的成功率
        const response = await retryOperation(async () => {
          return axios.post(`${this.baseUrl}/file`, null, {
            params: {
              method: 'list',
              access_token: token,
              path: '/apps/Elysia'
            }
          });
        });

        if (response.data.errno !== 0) {
          return { success: false, message: '获取文件列表失败: ' + (response.data.errmsg || '未知错误') };
        }

        const files = response.data.list || [];

        // 放宽过滤：百度网盘 API 对目录 size 字段返回不稳定，不再严格要求 size === 0
        // 改为按命名规则匹配：Elysia_YYYYMMDD_HHMMSS
        const ELYSIA_TS_PATTERN = /^Elysia_\d{8}_\d{6}$/;
        const candidateDirs = files.filter(file =>
          file.isdir === 1 &&
          ELYSIA_TS_PATTERN.test(file.name)
        );

        let cleanedCount = 0;
        let skippedCount = 0;
        const cleanedDirs = [];
        const MAX_CLEAN_PER_RUN = 100;          // 单次最多清理 100 个，避免一次调用太多 API
        const SAFE_SIZE_THRESHOLD = 1024;       // 1KB 以下视为空目录或仅含临时文件

        for (const dir of candidateDirs) {
          if (cleanedCount >= MAX_CLEAN_PER_RUN) {
            console.log(`[空目录清理] 已达单次上限 ${MAX_CLEAN_PER_RUN}，剩余 ${candidateDirs.length - cleanedCount} 个目录将在下次清理`);
            break;
          }
          try {
            // 对 size 较大的目录做二次确认，避免误删含真实数据的目录
            if ((dir.size || 0) > SAFE_SIZE_THRESHOLD) {
              console.log(`[空目录清理] 跳过 ${dir.name}（size=${dir.size}，超过安全阈值）`);
              skippedCount++;
              continue;
            }

            // deleteFile 内部已包 retryOperation，无需再包一层
            const deleteResult = await this.deleteFile(dir.path);
            if (deleteResult && (deleteResult.success || deleteResult.errno === 0)) {
              cleanedCount++;
              cleanedDirs.push(dir.name);
              console.log(`[空目录清理] 已清理: ${dir.path}`);
            } else {
              console.log(`[空目录清理] 删除失败 ${dir.path}`, deleteResult);
              skippedCount++;
            }
          } catch (e) {
            console.log(`[空目录清理] 清理目录失败 ${dir.path}:`, e.message);
            skippedCount++;
          }
        }

        if (autoClean) {
          console.log(`[自动清理] 共匹配 ${candidateDirs.length} 个，已清理 ${cleanedCount} 个，跳过 ${skippedCount} 个`);
        }

        return {
          success: true,
          message: `已清理 ${cleanedCount} 个空目录${skippedCount > 0 ? `，跳过 ${skippedCount} 个` : ''}`,
          cleanedCount,
          cleanedDirs,
          skippedCount,
          totalCandidates: candidateDirs.length
        };
      } catch (error) {
        console.error('[空目录清理] 失败:', error);
        return { success: false, message: '清理空目录失败: ' + (error.message || '未知错误') };
      }
    }

    async listFiles(path = '/') {
        const token = await this.getAccessToken();

        try {
            const response = await retryOperation(async () => {
                return axios.get(`${this.baseUrl}/file`, {
                    params: {
                        method: 'list',
                        access_token: token,
                        path: path
                    }
                });
            });
            return response.data;
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            console.error('获取文件列表失败:', errorMsg);
            throw new Error('获取文件列表失败: ' + errorMsg);
        }
    }

    async deleteFile(cloudPath) {
        const token = await this.getAccessToken();
        
        try {
            const response = await retryOperation(async () => {
                return axios.post(`${this.baseUrl}/file`, null, {
                    params: {
                        method: 'delete',
                        access_token: token,
                        path: cloudPath
                    }
                });
            });
            return response.data;
        } catch (error) {
            const errorMsg = extractErrorMessage(error);
            console.error('删除文件失败:', errorMsg);
            throw new Error('删除文件失败: ' + errorMsg);
        }
    }

    normalizeDataForSync(data) {
        const normalized = { ...data };
        
        if (data.tasks && Array.isArray(data.tasks)) {
            normalized.tasks = data.tasks.map(task => {
                const t = { ...task };
                if (!t.lastUpdated) {
                    t.lastUpdated = t.updatedAt || t.createdAt;
                }
                return t;
            });
        }
        
        if (data.memos && Array.isArray(data.memos)) {
            normalized.memos = data.memos.map(memo => {
                const m = { ...memo };
                if (!m.lastUpdated) {
                    m.lastUpdated = m.updatedAt || m.createdAt;
                }
                // 确保手机端能识别私密状态
                if (m.isPrivate !== undefined && m.private === undefined) {
                    m.private = m.isPrivate;
                }
                return m;
            });
        }
        
        if (data.expenses && Array.isArray(data.expenses)) {
            normalized.expenses = data.expenses.map(expense => {
                const e = { ...expense };
                if (!e.lastUpdated) {
                    e.lastUpdated = e.updatedAt || e.createdAt;
                }
                return e;
            });
        }
        
        if (data.budgets && Array.isArray(data.budgets)) {
            const allCategoryBudgets = [];
            
            normalized.budgets = data.budgets.map(budget => {
                const b = { ...budget };
                if (!b.id) {
                    b.id = require('uuid').v4();
                }
                if (!b.lastUpdated) {
                    b.lastUpdated = b.updatedAt || b.createdAt;
                }
                
                if (b.categoryBudgets && Array.isArray(b.categoryBudgets)) {
                    const categoryBudgets = [];
                    for (const cb of b.categoryBudgets) {
                        const cbMap = { ...cb };
                        cbMap.budgetId = b.id;
                        categoryBudgets.push(cbMap);
                        allCategoryBudgets.push(cbMap);
                    }
                    b.categoryBudgets = categoryBudgets;
                }
                
                return b;
            });
            
            const existingCategoryBudgets = data.categoryBudgets && Array.isArray(data.categoryBudgets) ? data.categoryBudgets : [];
            normalized.categoryBudgets = [...existingCategoryBudgets, ...allCategoryBudgets];
        }
        
        if (data.secrets && Array.isArray(data.secrets)) {
            normalized.secrets = data.secrets.map(secret => {
                const s = { ...secret };
                if (!s.lastUpdated) {
                    s.lastUpdated = s.updatedAt || s.createdAt;
                }
                return s;
            });
        }
        
        if (data.journals && Array.isArray(data.journals)) {
            normalized.journals = data.journals.map(journal => {
                const j = { ...journal };
                if (!j.lastUpdated) {
                    j.lastUpdated = j.updatedAt || j.createdAt;
                }
                return j;
            });
        }
        
        // 🆕 聊天历史同步
        if (data.chatHistory && Array.isArray(data.chatHistory)) {
            normalized.chatHistory = data.chatHistory.map(msg => {
                const m = { ...msg };
                if (!m.lastUpdated) {
                    m.lastUpdated = m.timestamp || new Date().toISOString();
                }
                return m;
            });
        }
        
        if (data.settings && typeof data.settings === 'object') {
            normalized.settings = { ...data.settings };
        }
        
        // ★ 聊天室数据同步（按 id 合并，本地有云端无则保留本地）
        if (data.chatRooms && Array.isArray(data.chatRooms)) {
            normalized.chatRooms = data.chatRooms;
        }
        
        // ★ 聊天记录存储同步（按聊天 key 合并）
        if (data.chatHistoryStore && typeof data.chatHistoryStore === 'object') {
            normalized.chatHistoryStore = { ...data.chatHistoryStore };
        }
        
        normalized.syncProtocolVersion = '1.0';
        normalized.syncTimestamp = new Date().toISOString();
        
        return normalized;
    }
    
    async syncData(data) {
        const token = await this.getAccessToken();
        
        const normalizedData = this.normalizeDataForSync(data);
        
        const jsonData = JSON.stringify(normalizedData, null, 2);
        const cloudPath = this.getDataPath();
        const fileBuffer = Buffer.from(jsonData);
        const fileSize = fileBuffer.length;
        const fileName = 'data.json';
        
        const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
        console.log('文件MD5:', md5);
        console.log('文件大小:', fileSize, 'bytes');
        
        const BLOCK_SIZE = 4 * 1024 * 1024;
        const blocks = [];
        for (let i = 0; i < fileBuffer.length; i += BLOCK_SIZE) {
            blocks.push(fileBuffer.slice(i, Math.min(i + BLOCK_SIZE, fileBuffer.length)));
        }
        
        const blockMD5s = blocks.map(block => crypto.createHash('md5').update(block).digest('hex'));
        console.log('分块数量:', blocks.length);
        
        try {
            const mkdirResult = await this.createDirectory(token, '/apps/Elysia');
            if (!mkdirResult.success && mkdirResult.message.indexOf('已存在') === -1) {
                return mkdirResult;
            }
            
            const preuploadResult = await this.preupload(token, cloudPath, fileSize, md5, blockMD5s);
            if (!preuploadResult.success) {
                return preuploadResult;
            }
            
            const uploadid = preuploadResult.data.uploadid;
            console.log('预上传成功，uploadid:', uploadid);
            
            const skipBlocks = preuploadResult.data.block_list || [];
            console.log('可跳过的分片:', skipBlocks);
            
            for (let i = 0; i < blocks.length; i++) {
                if (skipBlocks.includes(blockMD5s[i])) {
                    console.log(`跳过已上传分片 ${i}`);
                    continue;
                }
                
                const uploadResult = await this.uploadBlock(token, uploadid, i, blockMD5s[i], blocks[i], cloudPath);
                if (!uploadResult.success) {
                    return uploadResult;
                }
                console.log(`分片 ${i} 上传成功`);
            }
            
            const createResult = await this.createFile(token, cloudPath, uploadid, fileSize, md5, blockMD5s);
            if (!createResult.success) {
                return createResult;
            }

            // 同步成功后，fire-and-forget 触发一次空目录清理（5 分钟去抖，避免 API 限流）
            const AUTO_CLEANUP_DEBOUNCE = 5 * 60 * 1000;
            const nowMs = Date.now();
            if (nowMs - this._lastAutoCleanupTime > AUTO_CLEANUP_DEBOUNCE) {
                this._lastAutoCleanupTime = nowMs;
                // 不阻塞 syncData 返回
                this.cleanupEmptyDirectories(true).catch(e => {
                    console.log('[syncData] 同步后自动清理空目录失败:', e.message);
                });
            }

            return { success: true, data: createResult.data };
        } catch (error) {
            console.error('同步数据失败:', error);
            return { success: false, message: '同步数据失败: ' + (error.message || '未知错误') };
        }
    }
    
    async uploadBlock(token, uploadid, partseq, md5, fileBuffer, cloudPath) {
        try {
            console.log('分片上传参数:', { uploadid, partseq, md5, path: cloudPath });
            
            const FormData = require('form-data');
            const form = new FormData();
            form.append('file', fileBuffer, { filename: 'data.json' });
            
            const response = await axios.post('https://c.pcs.baidu.com/rest/2.0/pcs/superfile2', form, {
                params: {
                    method: 'upload',
                    access_token: token,
                    type: 'tmpfile',
                    path: cloudPath,
                    uploadid: uploadid,
                    partseq: partseq
                },
                headers: {
                    ...form.getHeaders()
                }
            });
            
            console.log('分片上传响应:', JSON.stringify(response.data));
            
            if (!response.data.errno || response.data.errno === 0) {
                return { success: true, data: response.data };
            } else {
                return { success: false, message: '分片上传失败: errno=' + response.data.errno + ', ' + (response.data.errmsg || '未知错误') };
            }
        } catch (error) {
            console.error('分片上传失败:', error);
            console.error('分片上传失败 - 响应:', error.response?.data);
            console.error('分片上传失败 - 状态:', error.response?.status);
            const errorMsg = error.response?.data?.errmsg || error.response?.data?.error || error.message || '未知错误';
            return { success: false, message: '分片上传失败: ' + errorMsg };
        }
    }
    
    async createDirectory(token, path) {
        try {
            console.log('创建目录:', path);
            const response = await axios.post('https://pan.baidu.com/rest/2.0/xpan/file', `path=${encodeURIComponent(path)}&isdir=1&rtype=1`, {
                timeout: 30000,
                params: {
                    method: 'create',
                    access_token: token
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            console.log('创建目录响应:', response.data);
            
            if (response.data.errno === 0 || response.data.errno === -10) {
                return { success: true, message: response.data.errno === -10 ? '目录已存在' : '目录创建成功' };
            } else {
                return { success: false, message: '创建目录失败: errno=' + response.data.errno + ', ' + (response.data.errmsg || '未知错误') };
            }
        } catch (error) {
            console.error('创建目录失败:', error.response?.data || error.message);
            const errorMsg = error.response?.data?.errmsg || error.response?.data?.error || error.message || '未知错误';
            return { success: false, message: '创建目录失败: ' + errorMsg };
        }
    }

    async preupload(token, cloudPath, fileSize, md5, blockMD5s = [md5]) {
        try {
            console.log('预上传参数:', { token: maskSensitiveValue(token), path: cloudPath, size: fileSize, md5: md5 });
            
            const payload = `path=${encodeURIComponent(cloudPath)}&size=${fileSize}&isdir=0&autoinit=1&rtype=3&block_list=${encodeURIComponent(JSON.stringify(blockMD5s))}`;
            
            const response = await axios.post('https://pan.baidu.com/rest/2.0/xpan/file', payload, {
                params: {
                    method: 'precreate',
                    access_token: token
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            console.log('预上传响应状态:', response.status);
            console.log('预上传响应头:', JSON.stringify(response.headers));
            console.log('预上传响应数据:', JSON.stringify(response.data));
            
            if (response.data.errno === 0) {
                if (!response.data.uploadid) {
                    console.error('预上传失败: uploadid字段缺失');
                    return { success: false, message: '预上传失败: 响应数据格式错误，缺少uploadid字段' };
                }
                return { success: true, data: {
                    uploadid: response.data.uploadid,
                    block_list: response.data.block_list || []
                } };
            } else {
                return { success: false, message: '预上传失败: errno=' + response.data.errno + ', ' + (response.data.errmsg || '未知错误') };
            }
        } catch (error) {
            console.error('预上传失败 - 异常:', error);
            console.error('预上传失败 - 响应数据:', error.response?.data);
            console.error('预上传失败 - 响应状态:', error.response?.status);
            const errorMsg = error.response?.data?.errmsg || error.response?.data?.error || error.message || '未知错误';
            return { success: false, message: '预上传失败: ' + errorMsg };
        }
    }

    async uploadToServer(url, fileBuffer) {
        await axios.put(url, fileBuffer, {
            headers: {
                'Content-Type': 'application/octet-stream'
            }
        });
    }

    async createFile(token, cloudPath, uploadid, fileSize, md5, blockMD5s = [md5]) {
        try {
            const response = await axios.post('https://pan.baidu.com/rest/2.0/xpan/file', `path=${encodeURIComponent(cloudPath)}&size=${fileSize}&isdir=0&block_list=${encodeURIComponent(JSON.stringify(blockMD5s))}&uploadid=${uploadid}&rtype=3`, {
                params: {
                    method: 'create',
                    access_token: token
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            console.log('创建文件响应:', response.data);
            
            if (response.data.errno === 0) {
                return { success: true, data: response.data };
            } else {
                return { success: false, message: '创建文件失败: errno=' + response.data.errno + ', ' + (response.data.errmsg || '未知错误') };
            }
        } catch (error) {
            console.error('创建文件失败:', error);
            return { success: false, message: '创建文件失败: ' + (error.response?.data?.errmsg || error.message) };
        }
    }

    normalizeDataFromSync(data) {
        const normalized = { ...data };
        
        if (data.tasks && Array.isArray(data.tasks)) {
            normalized.tasks = data.tasks.map(task => {
                const t = { ...task };
                if (!t.updatedAt && t.lastUpdated) {
                    t.updatedAt = t.lastUpdated;
                }
                return dataManager.normalizeTask(t);
            });
        }
        
        if (data.memos && Array.isArray(data.memos)) {
            normalized.memos = data.memos.map(memo => {
                const m = { ...memo };
                if (!m.updatedAt && m.lastUpdated) {
                    m.updatedAt = m.lastUpdated;
                }
                if (!m.isPrivate && m.private !== undefined) {
                    m.isPrivate = m.private;
                }
                if (!m.orderIndex && m.order !== undefined) {
                    m.orderIndex = m.order;
                }
                return dataManager.normalizeMemo(m);
            });
        }
        
        if (data.expenses && Array.isArray(data.expenses)) {
            normalized.expenses = data.expenses.map(expense => {
                const e = { ...expense };
                if (!e.updatedAt && e.lastUpdated) {
                    e.updatedAt = e.lastUpdated;
                }
                return dataManager.normalizeExpense(e);
            });
        }
        
        if (data.budgets && Array.isArray(data.budgets)) {
            normalized.budgets = data.budgets.map(budget => {
                const b = { ...budget };
                if (!b.updatedAt && b.lastUpdated) {
                    b.updatedAt = b.lastUpdated;
                }
                return dataManager.normalizeBudget(b);
            });
        }
        
        if (data.secrets && Array.isArray(data.secrets)) {
            normalized.secrets = data.secrets.map(secret => {
                const s = { ...secret };
                if (!s.updatedAt && s.lastUpdated) {
                    s.updatedAt = s.lastUpdated;
                }
                return dataManager.normalizeSecret(s);
            });
        }
        
        if (data.journals && Array.isArray(data.journals)) {
            normalized.journals = data.journals.map(journal => {
                const j = { ...journal };
                if (!j.updatedAt && j.lastUpdated) {
                    j.updatedAt = j.lastUpdated;
                }
                return dataManager.normalizeJournal(j);
            });
        }
        
        // 🆕 聊天历史同步
        if (data.chatHistory && Array.isArray(data.chatHistory)) {
            normalized.chatHistory = data.chatHistory;
        }
        
        if (data.categoryBudgets && Array.isArray(data.categoryBudgets)) {
            normalized.categoryBudgets = data.categoryBudgets.map(cb => ({
                ...cb,
                budgetId: cb.budgetId || cb.budget_id || ''
            }));
        } else {
            normalized.categoryBudgets = [];
        }
        
        if (data.budgets && Array.isArray(data.budgets)) {
            data.budgets.forEach(budget => {
                if (budget.categoryBudgets && Array.isArray(budget.categoryBudgets)) {
                    budget.categoryBudgets.forEach(cb => {
                        const catBudgetWithBudgetId = { ...cb, budgetId: budget.id };
                        normalized.categoryBudgets.push(catBudgetWithBudgetId);
                    });
                }
            });
        }
        
        if (data.settings && typeof data.settings === 'object') {
            normalized.settings = { ...data.settings };
        }
        
        // ★ 聊天室数据（云端下载后合并到本地）
        if (data.chatRooms && Array.isArray(data.chatRooms)) {
            normalized.chatRooms = data.chatRooms;
        }
        
        // ★ 聊天记录存储（云端下载后合并到本地）
        if (data.chatHistoryStore && typeof data.chatHistoryStore === 'object') {
            normalized.chatHistoryStore = { ...data.chatHistoryStore };
        }
        
        return normalized;
    }
    
    compareTimestamps(localTime, cloudTime) {
        if (!localTime) return -1;
        if (!cloudTime) return 1;
        
        const localDate = new Date(localTime);
        const cloudDate = new Date(cloudTime);
        
        if (localDate.getTime() > cloudDate.getTime()) return 1;
        if (localDate.getTime() < cloudDate.getTime()) return -1;
        return 0;
    }
    
    detectConflicts(localData, cloudData) {
        const conflicts = [];
        const toSync = {
            tasks: { add: [], update: [], delete: [] },
            memos: { add: [], update: [], delete: [] },
            expenses: { add: [], update: [], delete: [] },
            budgets: { add: [], update: [], delete: [] },
            secrets: { add: [], update: [], delete: [] },
            journals: { add: [], update: [], delete: [] },
            chatRooms: { add: [], update: [], localOnly: [] },   // ★ 新增
            chatHistoryStore: { merge: {} }                         // ★ 新增
        };
        
        const compareCollections = (collectionName) => {
            const localItems = localData[collectionName] || [];
            const cloudItems = cloudData[collectionName] || [];
            
            const localMap = new Map();
            localItems.forEach(item => {
                if (item.id) {
                    localMap.set(String(item.id), item);
                }
            });
            
            const cloudMap = new Map();
            cloudItems.forEach(item => {
                if (item.id) {
                    cloudMap.set(String(item.id), item);
                }
            });
            
            // 本地有、云端也有 → 按时间戳决定用哪边
            localMap.forEach((localItem, id) => {
                if (cloudMap.has(id)) {
                    const cloudItem = cloudMap.get(id);
                    const comparison = this.compareTimestamps(
                        localItem.lastUpdated || localItem.updatedAt,
                        cloudItem.lastUpdated || cloudItem.updatedAt
                    );
                    
                    if (comparison > 0) {
                        toSync[collectionName].update.push(localItem);
                    } else if (comparison < 0) {
                        toSync[collectionName].update.push(cloudItem);
                    }
                } else {
                    // 本地有、云端没有 → 上传到云端
                    toSync[collectionName].add.push(localItem);
                }
            });
            
            // 云端有、本地没有 → 下载到本地
            cloudMap.forEach((cloudItem, id) => {
                if (!localMap.has(id)) {
                    toSync[collectionName].add.push(cloudItem);
                }
            });
        };
        
        ['tasks', 'memos', 'expenses', 'budgets', 'secrets', 'journals', 'chatHistory'].forEach(compareCollections);
        
        // ★ 聊天室冲突处理（按 id 合并）
        const localRooms = localData.chatRooms || [];
        const cloudRooms = cloudData.chatRooms || [];
        const localRoomMap = new Map();
        localRooms.forEach(r => { if (r.id) localRoomMap.set(String(r.id), r); });
        const cloudRoomMap = new Map();
        cloudRooms.forEach(r => { if (r.id) cloudRoomMap.set(String(r.id), r); });
        
        // 本地有、云端没有 → 保留本地（上传时用本地的）
        localRoomMap.forEach((localRoom, id) => {
            if (!cloudRoomMap.has(id)) {
                toSync.chatRooms.localOnly.push(localRoom);
            } else {
                // 两边都有 → 按 updateTime 决定
                const cloudRoom = cloudRoomMap.get(id);
                const cmp = this.compareTimestamps(
                    localRoom.updateTime || localRoom.createdAt,
                    cloudRoom.updateTime || cloudRoom.createdAt
                );
                if (cmp > 0) {
                    toSync.chatRooms.update.push(localRoom);
                } else if (cmp < 0) {
                    toSync.chatRooms.update.push(cloudRoom);
                }
            }
        });
        // 云端有、本地没有 → 下载
        cloudRoomMap.forEach((cloudRoom, id) => {
            if (!localRoomMap.has(id)) {
                toSync.chatRooms.add.push(cloudRoom);
            }
        });
        
        // ★ chatHistoryStore 合并（按聊天 key 深度合并）
        const localStore = localData.chatHistoryStore || {};
        const cloudStore = cloudData.chatHistoryStore || {};
        const mergedStore = { ...cloudStore };
        // 本地有、云端没有的 key → 保留本地
        Object.keys(localStore).forEach(key => {
            if (!mergedStore[key]) {
                mergedStore[key] = localStore[key];
            }
        });
        toSync.chatHistoryStore.merge = mergedStore;
        
        return {
            conflicts,
            toSync,
            hasConflicts: conflicts.length > 0,
            hasChanges: [
                'tasks', 'memos', 'expenses', 'budgets', 'secrets', 'journals', 'chatHistory'
            ].some(coll => toSync[coll].add.length > 0 || toSync[coll].update.length > 0 || toSync[coll].delete.length > 0)
                || toSync.chatRooms.add.length > 0 || toSync.chatRooms.update.length > 0 || toSync.chatRooms.localOnly.length > 0
        };
    }
    
    // 下载单个云端路径，返回解析后的对象；404 返回 null；其它错误向上抛出
    async _downloadRawFromPath(token, cloudPath) {
        try {
            const response = await axios.get(`${this.baseUrl}/file`, {
                params: { method: 'download', access_token: token, path: cloudPath },
                responseType: 'arraybuffer'
            });
            const jsonString = Buffer.from(response.data).toString('utf8');
            return JSON.parse(jsonString);
        } catch (error) {
            if (error.response && error.response.status === 404) return null;
            throw error;
        }
    }

    // 合并多个云端数据源（按 id 去重，前者优先），用于跨路径 / 跨用户数据归集
    _mergeCloudSources(sources) {
        const collections = ['tasks', 'memos', 'expenses', 'budgets', 'categoryBudgets', 'secrets', 'journals', 'chatHistory', 'chatRooms'];
        const merged = {};
        const seen = {};
        for (const key of collections) seen[key] = new Set();
        for (const src of sources) {
            if (!src) continue;
            for (const key of collections) {
                const arr = Array.isArray(src[key]) ? src[key] : [];
                if (!merged[key]) merged[key] = [];
                for (const item of arr) {
                    const id = item && item.id != null ? String(item.id) : null;
                    if (id && seen[key].has(id)) continue;
                    if (id) seen[key].add(id);
                    merged[key].push(item);
                }
            }
        }
        // settings：后者覆盖前者，缺失字段用前者补全
        const settingsList = sources.filter(s => s && s.settings).map(s => s.settings);
        let settings = {};
        for (const s of settingsList) settings = { ...settings, ...s };
        merged.settings = settings;
        // 墓碑：取并集
        const deleted = {};
        const delKeys = new Set();
        for (const s of sources) { if (s && s.deletedItems) Object.keys(s.deletedItems).forEach(k => delKeys.add(k)); }
        for (const k of delKeys) {
            const set = new Set();
            for (const s of sources) { if (s && s.deletedItems && Array.isArray(s.deletedItems[k])) s.deletedItems[k].forEach(id => set.add(String(id))); }
            deleted[k] = Array.from(set);
        }
        merged.deletedItems = deleted;
        return merged;
    }

    async fetchData() {
        const token = await this.getAccessToken();
        const primaryPath = this.getDataPath();
        const adminPath = '/apps/Elysia/data.json';

        const primary = await this._downloadRawFromPath(token, primaryPath);
        // 主路径是“按用户隔离”的文件时，额外尝试默认(admin)文件，
        // 以兼容另一端（如手机端）使用默认账户写入的数据，避免跨设备同步时数据“看不见”。
        const admin = (primaryPath !== adminPath) ? await this._downloadRawFromPath(token, adminPath) : null;

        if (!primary && !admin) {
            return { success: false, message: '云端数据不存在', notFound: true };
        }

        const rawSources = [primary, admin].filter(Boolean);
        const mergedRaw = rawSources.length === 1 ? rawSources[0] : this._mergeCloudSources(rawSources);

        const normalizedData = this.normalizeDataFromSync(mergedRaw);
        return { success: true, data: normalizedData, protocolVersion: mergedRaw.syncProtocolVersion || '0.1' };
    }

    async checkCloudVersion() {
        const token = await this.getAccessToken();
        const cloudPath = '/apps/Elysia/versions.json';
        
        try {
            const response = await axios.get(`${this.baseUrl}/file`, {
                params: {
                    method: 'download',
                    access_token: token,
                    path: cloudPath
                },
                responseType: 'arraybuffer'
            });
            
            const jsonString = Buffer.from(response.data).toString('utf8');
            const data = JSON.parse(jsonString);
            const versions = data.versions || [];
            
            if (versions.length === 0) {
                return { success: false, message: '版本文件不存在', notFound: true };
            }
            
            return { success: true, data: versions[0] };
        } catch (error) {
            if (error.response?.status === 404) {
                return { success: false, message: '版本文件不存在', notFound: true };
            }
            return { success: false, message: '获取版本信息失败: ' + (error.response?.data?.error_msg || error.message || '未知错误') };
        }
    }

    async uploadVersion(versionInfo) {
        const token = await this.getAccessToken();
        const MAX_VERSIONS = 5;
        
        try {
            const mkdirResult = await this.createDirectory(token, '/apps/Elysia');
            if (!mkdirResult.success && mkdirResult.message.indexOf('已存在') === -1) {
                return mkdirResult;
            }
            
            let versions = [];
            const currentVersions = await this.getVersionList();
            if (currentVersions.success) {
                versions = currentVersions.data || [];
            }
            
            const newVersion = {
                ...versionInfo,
                id: Date.now().toString(),
                uploadTime: new Date().toISOString()
            };
            
            versions.unshift(newVersion);
            
            if (versions.length > MAX_VERSIONS) {
                const oldVersions = versions.slice(MAX_VERSIONS);
                versions = versions.slice(0, MAX_VERSIONS);
                
                for (const oldVersion of oldVersions) {
                    await this.deleteOldVersionFiles(token, oldVersion.id);
                }
            }
            
            const jsonData = JSON.stringify({ versions }, null, 2);
            const fileBuffer = Buffer.from(jsonData);
            const fileSize = fileBuffer.length;
            const cloudPath = '/apps/Elysia/versions.json';
            
            const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
            
            const preuploadResult = await this.preupload(token, cloudPath, fileSize, md5);
            if (!preuploadResult.success) {
                return preuploadResult;
            }
            
            const uploadid = preuploadResult.data.uploadid;
            const uploadResult = await this.uploadBlock(token, uploadid, 0, md5, fileBuffer, cloudPath);
            if (!uploadResult.success) {
                return uploadResult;
            }
            
            const createResult = await this.createFile(token, cloudPath, uploadid, fileSize, md5);
            if (!createResult.success) {
                return createResult;
            }
            
            return { success: true, data: createResult.data, versionId: newVersion.id };
        } catch (error) {
            console.error('上传版本信息失败:', error);
            return { success: false, message: '上传版本信息失败: ' + (error.message || '未知错误') };
        }
    }

    async getVersionList() {
        const token = await this.getAccessToken();
        const cloudPath = '/apps/Elysia/versions.json';
        
        try {
            const response = await axios.get(`${this.baseUrl}/file`, {
                params: {
                    method: 'download',
                    access_token: token,
                    path: cloudPath
                },
                responseType: 'arraybuffer'
            });
            
            const jsonString = Buffer.from(response.data).toString('utf8');
            const data = JSON.parse(jsonString);
            return { success: true, data: data.versions || [] };
        } catch (error) {
            if (error.response?.status === 404) {
                return { success: false, message: '版本列表不存在', notFound: true };
            }
            return { success: false, message: '获取版本列表失败: ' + (error.response?.data?.error_msg || error.message || '未知错误') };
        }
    }

    async deleteOldVersionFiles(token, versionId, onProgress = null) {
        const cloudBasePath = `/apps/Elysia/versions/${versionId}`;
        let filesToDelete = [];
        
        try {
            const manifestPath = `${cloudBasePath}/manifest.json`;
            const response = await axios.get(`${this.baseUrl}/file`, {
                params: {
                    method: 'download',
                    access_token: token,
                    path: manifestPath
                },
                responseType: 'arraybuffer'
            });
            const jsonString = Buffer.from(response.data).toString('utf8');
            const manifestData = JSON.parse(jsonString);
            const remoteFiles = manifestData.files || [];
            filesToDelete = remoteFiles.map(f => `${cloudBasePath}/${f.name}`);
        } catch (e) {
            console.log('无法获取版本清单，使用默认文件列表');
            filesToDelete = [
                `${cloudBasePath}/app.js`,
                `${cloudBasePath}/styles.css`,
                `${cloudBasePath}/index.html`,
                `${cloudBasePath}/main.js`,
                `${cloudBasePath}/detail.css`,
                `${cloudBasePath}/detail.html`,
                `${cloudBasePath}/detail.js`,
                `${cloudBasePath}/quick-task.css`,
                `${cloudBasePath}/quick-task.html`,
                `${cloudBasePath}/quick-task.js`,
                `${cloudBasePath}/reminder.css`,
                `${cloudBasePath}/reminder.html`,
                `${cloudBasePath}/reminder.js`,
                `${cloudBasePath}/sticky-note.css`,
                `${cloudBasePath}/sticky-note.html`,
                `${cloudBasePath}/sticky-note.js`,
                `${cloudBasePath}/color-picker.html`,
                `${cloudBasePath}/color-picker-module.js`,
                `${cloudBasePath}/cloud-sync.js`,
                `${cloudBasePath}/package.json`,
                `${cloudBasePath}/manifest.json`
            ];
        }
        
        let deletedCount = 0;
        
        if (onProgress) {
            onProgress({ status: 'started', current: 0, total: filesToDelete.length, fileName: '' });
        }
        
        for (let i = 0; i < filesToDelete.length; i++) {
            const filePath = filesToDelete[i];
            const fileName = filePath.split('/').pop();
            
            if (onProgress) {
                onProgress({ status: 'deleting', current: i, total: filesToDelete.length, fileName: fileName });
            }
            
            try {
                await axios.post(`${this.baseUrl}/file`, null, {
                    params: {
                        method: 'delete',
                        access_token: token,
                        path: filePath
                    }
                });
                deletedCount++;
                
                if (onProgress) {
                    onProgress({ status: 'completed', current: deletedCount, total: filesToDelete.length, fileName: fileName });
                }
            } catch (e) {
                console.log(`删除旧版本文件失败 ${filePath}:`, e.message);
            }
        }
        
        if (onProgress) {
            onProgress({ status: 'finished', current: deletedCount, total: filesToDelete.length, fileName: '' });
        }
    }

    async deleteVersion(versionId, onProgress = null) {
        const token = await this.getAccessToken();
        
        try {
            const versionList = await this.getVersionList();
            if (!versionList.success) {
                return versionList;
            }
            
            const versions = versionList.data || [];
            const newVersions = versions.filter(v => v.id !== versionId);
            
            await this.deleteOldVersionFiles(token, versionId, onProgress);
            
            const jsonData = JSON.stringify({ versions: newVersions }, null, 2);
            const fileBuffer = Buffer.from(jsonData);
            const fileSize = fileBuffer.length;
            const cloudPath = '/apps/Elysia/versions.json';
            
            const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
            
            const preuploadResult = await this.preupload(token, cloudPath, fileSize, md5);
            if (!preuploadResult.success) {
                return preuploadResult;
            }
            
            const uploadid = preuploadResult.data.uploadid;
            const uploadResult = await this.uploadBlock(token, uploadid, 0, md5, fileBuffer, cloudPath);
            if (!uploadResult.success) {
                return uploadResult;
            }
            
            const createResult = await this.createFile(token, cloudPath, uploadid, fileSize, md5);
            if (!createResult.success) {
                return createResult;
            }
            
            return { success: true, message: '版本已删除' };
        } catch (error) {
            console.error('删除版本失败:', error);
            return { success: false, message: '删除版本失败: ' + (error.message || '未知错误') };
        }
    }

    async uploadAppFiles(sourceDir, onProgress = null, versionId = null) {
        const token = await this.getAccessToken();
        
        const allowedExtensions = ['.js', '.html', '.css', '.json', '.md'];
        const excludedFiles = ['node_modules', '.git', 'package-lock.json', 'yarn.lock', 'dist', 'build', 'data.json'];
        const excludedDirs = ['node_modules', '.git', 'dist', 'build', '.electron-builder', 'users', 'tests'];
        
        const filesToUpload = [];
        
        const scanDirectory = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (excludedFiles.includes(item)) continue;
                
                const fullPath = path.join(dir, item);
                let relativePath = path.relative(sourceDir, fullPath);
                relativePath = relativePath.replace(/\\/g, '/');
                
                if (fs.statSync(fullPath).isDirectory()) {
                    if (!excludedDirs.includes(item)) {
                        scanDirectory(fullPath);
                    }
                    continue;
                }
                
                const ext = path.extname(item).toLowerCase();
                if (allowedExtensions.includes(ext)) {
                    filesToUpload.push(relativePath);
                }
            }
        };
        
        scanDirectory(sourceDir);
        filesToUpload.sort();
        
        let uploadedCount = 0;
        let skippedCount = 0;
        let errors = [];
        let directoryCreated = false;
        
        const cloudBasePath = versionId ? `/apps/Elysia/versions/${versionId}` : '/apps/Elysia/app';
        
        if (onProgress) {
            onProgress({ status: 'started', current: 0, total: filesToUpload.length, fileName: '' });
        }
        
        let filesActuallyUpload = [];
        let remoteManifest = null;
        
        try {
            const manifestPath = `${cloudBasePath}/manifest.json`;
            const response = await this.axios.get(`${this.baseUrl}/file`, {
                params: {
                    method: 'download',
                    access_token: token,
                    path: manifestPath
                },
                responseType: 'arraybuffer'
            });
            const jsonString = Buffer.from(response.data).toString('utf8');
            const manifestData = JSON.parse(jsonString);
            remoteManifest = manifestData.files || manifestData;
            console.log(`[增量上传] 远程清单已获取，共 ${remoteManifest.length} 个文件记录`);
        } catch (e) {
            const errMsg = e.response?.data ? String(e.response.data) : (e.message || e);
            console.log(`远程清单获取失败: ${errMsg}，将全量上传`);
        }
        
        for (let i = 0; i < filesToUpload.length; i++) {
            const fileName = filesToUpload[i];
            
            const filePath = path.join(sourceDir, fileName);
            if (!fs.existsSync(filePath)) {
                errors.push(fileName + ': 文件不存在');
                continue;
            }
            
            const fileBuffer = fs.readFileSync(filePath);
            const localHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            
            if (remoteManifest) {
                const remoteFile = remoteManifest.find(f => f.name === fileName);
                if (remoteFile && remoteFile.hash === localHash) {
                    skippedCount++;
                    console.log(`跳过: ${fileName} (文件未变化)`);
                    continue;
                }
            }
            
            filesActuallyUpload.push({
                name: fileName,
                path: filePath,
                buffer: fileBuffer,
                hash: localHash
            });
        }
        
        if (filesActuallyUpload.length === 0) {
            if (onProgress) {
                onProgress({ status: 'finished', current: 0, total: filesToUpload.length, fileName: '' });
            }
            return {
                success: true,
                uploadedCount: 0,
                skippedCount: filesToUpload.length,
                totalCount: filesToUpload.length,
                errors: []
            };
        }
        
        const mkdirResult = await this.createDirectory(token, cloudBasePath);
        if (!mkdirResult.success && mkdirResult.message.indexOf('已存在') === -1) {
            return {
                success: false,
                uploadedCount: 0,
                skippedCount: skippedCount,
                totalCount: filesToUpload.length,
                errors: ['创建目录失败: ' + mkdirResult.message]
            };
        }
        directoryCreated = true;
        
        for (let i = 0; i < filesActuallyUpload.length; i++) {
            const fileInfo = filesActuallyUpload[i];
            const fileName = fileInfo.name;
            
            if (onProgress) {
                onProgress({ status: 'uploading', current: skippedCount + i, total: filesToUpload.length, fileName: fileName });
            }
            
            try {
                const fileBuffer = fileInfo.buffer;
                const fileSize = fileBuffer.length;
                const cloudPath = `${cloudBasePath}/${fileName}`;
                const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
                
                const preuploadResult = await this.preupload(token, cloudPath, fileSize, md5);
                if (!preuploadResult.success) {
                    errors.push(fileName + ': ' + preuploadResult.message);
                    continue;
                }
                
                const uploadid = preuploadResult.data.uploadid;
                const uploadResult = await this.uploadBlock(token, uploadid, 0, md5, fileBuffer, cloudPath);
                if (!uploadResult.success) {
                    errors.push(fileName + ': ' + uploadResult.message);
                    continue;
                }
                
                const createResult = await this.createFile(token, cloudPath, uploadid, fileSize, md5);
                if (!createResult.success) {
                    errors.push(fileName + ': ' + createResult.message);
                    continue;
                }
                
                uploadedCount++;
                
                if (onProgress) {
                    onProgress({ status: 'completed', current: uploadedCount + skippedCount, total: filesToUpload.length, fileName: fileName });
                }
                
                console.log(`已上传: ${fileName}`);
            } catch (error) {
                errors.push(fileName + ': ' + (error.message || '未知错误'));
            }
        }
        
        if (onProgress) {
            onProgress({ status: 'finished', current: uploadedCount + skippedCount, total: filesToUpload.length, fileName: '' });
        }
        
        return {
            success: errors.length === 0,
            uploadedCount: uploadedCount,
            skippedCount: skippedCount,
            totalCount: filesToUpload.length,
            errors: errors
        };
    }

    async downloadAppFiles(targetDir, versionId = null, onProgress = null) {
        const token = await this.getAccessToken();
        
        const cloudBasePath = versionId ? `/apps/Elysia/versions/${versionId}` : '/apps/Elysia/app';
        
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        
        let filesToDownload = [];
        let remoteManifest = null;
        
        try {
          const manifestPath = `${cloudBasePath}/manifest.json`;
          const response = await axios.get(`${this.baseUrl}/file`, {
            params: {
              method: 'download',
              access_token: token,
              path: manifestPath
            },
            responseType: 'arraybuffer'
          });
          const jsonString = Buffer.from(response.data).toString('utf8');
          const manifest = JSON.parse(jsonString);
          remoteManifest = manifest.files || [];
          filesToDownload = remoteManifest.map(f => f.name);
        } catch (e) {
          console.log('无法获取版本清单，使用默认文件列表');
          filesToDownload = [
            'app.js', 'styles.css', 'index.html', 'main.js',
            'detail.css', 'detail.html', 'detail.js',
            'quick-task.css', 'quick-task.html', 'quick-task.js',
            'reminder.css', 'reminder.html', 'reminder.js',
            'sticky-note.css', 'sticky-note.html', 'sticky-note.js',
            'color-picker.html', 'color-picker-module.js',
            'cloud-sync.js', 'package.json',
            'update-manager.js', 'crypto-manager.js', 'manifest-sample.json'
          ];
        }
        
        let downloadedCount = 0;
        let skippedCount = 0;
        let errors = [];
        
        if (onProgress) {
          onProgress({ status: 'started', current: 0, total: filesToDownload.length, fileName: '' });
        }
        
        for (let i = 0; i < filesToDownload.length; i++) {
          const fileName = filesToDownload[i];
          
          if (onProgress) {
            onProgress({ status: 'downloading', current: skippedCount + i, total: filesToDownload.length, fileName: fileName });
          }
          
          try {
            const cloudPath = `${cloudBasePath}/${fileName}`;
            const targetPath = path.join(targetDir, fileName);
            
            if (remoteManifest && fs.existsSync(targetPath)) {
              const remoteFile = remoteManifest.find(f => f.name === fileName);
              if (remoteFile && remoteFile.hash) {
                const localBuffer = fs.readFileSync(targetPath);
                const localHash = crypto.createHash('sha256').update(localBuffer).digest('hex');
                
                if (localHash === remoteFile.hash) {
                  skippedCount++;
                  console.log(`跳过: ${fileName} (文件未变化)`);
                  continue;
                }
              }
            }
            
            const response = await axios.get(`${this.baseUrl}/file`, {
              params: {
                method: 'download',
                access_token: token,
                path: cloudPath
              },
              responseType: 'arraybuffer'
            });
            
            const targetDirPath = path.dirname(targetPath);
            if (!fs.existsSync(targetDirPath)) {
              fs.mkdirSync(targetDirPath, { recursive: true });
            }
            
            fs.writeFileSync(targetPath, response.data);
            downloadedCount++;
            
            if (onProgress) {
              onProgress({ status: 'completed', current: downloadedCount + skippedCount, total: filesToDownload.length, fileName: fileName });
            }
            
            console.log(`已下载: ${fileName}`);
          } catch (error) {
            errors.push(fileName + ': ' + (error.response?.data?.error_msg || error.message || '未知错误'));
          }
        }
        
        if (onProgress) {
          onProgress({ status: 'finished', current: downloadedCount + skippedCount, total: filesToDownload.length, fileName: '' });
        }
        
        return {
          success: errors.length === 0,
          downloadedCount: downloadedCount,
          skippedCount: skippedCount,
          totalCount: filesToDownload.length,
          errors: errors
        };
    }

    async getTokenInfo() {
        try {
            const token = await this.getAccessToken();
            return { 
                success: true, 
                data: {
                    access_token: token,
                    expires_in: Math.max(0, Math.floor((this.tokenExpireTime - Date.now()) / 1000))
                } 
            };
        } catch (error) {
            console.error('获取令牌信息失败:', error);
            return { success: false, message: '获取令牌信息失败: ' + error.message };
        }
    }

    getTokenExpireTime() {
        return this.tokenExpireTime;
    }

    resetToken() {
        this.token = null;
        this.refreshToken = null;
        this.tokenExpireTime = null;
    }
}

module.exports = CloudSync;