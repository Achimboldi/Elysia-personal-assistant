/**
 * xilian-manager.js — 昔涟聊天状态管理（渲染进程）
 * 负责聊天状态、IPC 通信、消息管理
 */

/**
 * MC 星图：让 AI 主星名跟随当前所选智能体。
 * 在切换智能体 / 发送消息时调用：
 *  1) 更新前端 window.MEMORY_UI_CONFIG.ai.name（星图 render.js 每帧读取 UI.ai.name）
 *  2) 通知主进程持久化（mc:set-ai-name），使后端 universe.core 过滤名与显示保持一致
 * 找不到对应预设时静默跳过，绝不阻断聊天主流程。
 */
function mcUpdateAiStarName(presetId) {
    try {
        let aiName = null;

        // ① 多源查找预设对象
        let preset = null;
        if (presetId) {
            const presets = window.__xilianPresets || [];
            preset = presets.find(p => p.id === presetId);
            if (!preset && typeof XilianSettings !== 'undefined' && Array.isArray(XilianSettings._presets)) {
                preset = XilianSettings._presets.find(p => p.id === presetId);
            }
        }

        if (preset && preset.name) {
            aiName = preset.name;
        }

        // ② 兜底：直接从 XilianSettings 取当前激活预设的名字
        if (!aiName && typeof XilianSettings !== 'undefined') {
            try {
                if (typeof XilianSettings.getActivePresetConfig === 'function') {
                    const cfg = XilianSettings.getActivePresetConfig();
                    if (cfg && cfg.agentName) aiName = cfg.agentName;
                }
            } catch (e) { /* ignore */ }
            if (!aiName && XilianSettings._currentPresetId && Array.isArray(XilianSettings._presets)) {
                const p2 = XilianSettings._presets.find(p => p.id === XilianSettings._currentPresetId);
                if (p2 && p2.name) aiName = p2.name;
            }
        }

        // ③ 实在拿不到：延迟 500ms 重试一次（可能预设还在加载）
        if (!aiName) {
            if (typeof XilianSettings !== 'undefined' && XilianSettings._currentPresetId) {
                if (!mcUpdateAiStarName._tried) {
                    mcUpdateAiStarName._tried = true;
                    setTimeout(function () {
                        mcUpdateAiStarName._tried = false;
                        mcUpdateAiStarName(XilianSettings._currentPresetId);
                    }, 500);
                }
            }
            return;
        }

        // 0) 用户主星显示名：取自 Elysia 设置中的"用户名称"（aiUserName），取不到则回退"我"
        const userName = (typeof XilianSettings !== 'undefined' && XilianSettings._config && XilianSettings._config.aiUserName) || '我';

        // 1) 前端：星图 AI 主星显示名（drawCore 每帧读 UI.ai.name；UI 对象为引用，直接 mutate 即可）
        if (!window.MEMORY_UI_CONFIG) {
            window.MEMORY_UI_CONFIG = { user: { name: userName, color: '#e8b96d' }, ai: { name: aiName, color: '#6d9e8b' } };
        } else if (!window.MEMORY_UI_CONFIG.ai) {
            window.MEMORY_UI_CONFIG.ai = { name: aiName, color: '#6d9e8b' };
        } else {
            window.MEMORY_UI_CONFIG.ai.name = aiName;
        }

        // 1-b) 同步用户主星名：确保 MEMORY_UI_CONFIG.user 存在且 name 为设置里的真实用户名
        //      覆盖 index.html 初始硬编码的 '我'，使主星显示用户在设置中填的名字（panels.js 的 displayUserName 取此值）
        if (window.MEMORY_UI_CONFIG) {
            if (!window.MEMORY_UI_CONFIG.user) {
                window.MEMORY_UI_CONFIG.user = { name: userName, color: '#e8b96d' };
            } else {
                window.MEMORY_UI_CONFIG.user.name = userName;
            }
        }
        // 2) 主进程：持久化 ai 核心名（不阻塞）
        if (typeof require !== 'undefined') {
            const electron = require('electron');
            if (electron && electron.ipcRenderer && typeof electron.ipcRenderer.invoke === 'function') {
                electron.ipcRenderer.invoke('mc:set-ai-name', { name: aiName }).catch(() => {});
                electron.ipcRenderer.invoke('mc:set-user-name', { name: userName, color: '#e8b96d' }).catch(() => {});
            }
        }
        // 调试用：用户可在 DevTools Console 看到是否生效
        if (typeof console !== 'undefined' && console.log) {
            console.log('[MC] 星图 AI 主星名已更新:', aiName, '(presetId=' + presetId + ')');
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
            console.warn('[MC] mcUpdateAiStarName 失败:', e && e.message);
        }
    }
}

class XilianManager {
    constructor(appController) {
        this.app = appController;
        this.chatHistory = [];
        this.isStreaming = false;
        this.currentAssistantMsg = null;
        this.streamBuffer = '';
        this._listenersSetup = false;
        this._onStreamStateChange = null;  // 回调：通知 UI 流式状态变化

        // 聊天室支持
        this.chatRoomManager = null;  // ChatRoomManager 实例引用
        this._currentChatKey = null;  // 当前聊天存储键: 'private:agentId' 或 'room:roomId'
        this._activeAgentPresetId = null;  // 当前活跃的智能体预设ID（私聊模式）

        // 多智能体链式发言
        this._pendingReplyQueue = [];   // 待回复智能体队列 [{agentId, isPrimary}]
        this._currentReplyAgentId = null;  // 正在回复的智能体ID

        // MC 数据桥：track 已 ingest 的 chatHistory 下标（避免重复写入）
        this._mcLastIngestedIndex = 0;

        // 绑定方法
        this.handleStreamChunk = this.handleStreamChunk.bind(this);
        this.handleStreamDone = this.handleStreamDone.bind(this);
        this.handleStreamError = this.handleStreamError.bind(this);
        this.handleConfirmRequest = this.handleConfirmRequest.bind(this);
        this.sendMessage = this.sendMessage.bind(this);
        this.stopStreaming = this.stopStreaming.bind(this);
    }

    // ============================================================
    // 初始化
    // ============================================================

    async init() {
        // 初始化时设置默认私聊上下文（使用第一个预设或默认 ID）
        const presets = window.__xilianPresets || [];
        const defaultPresetId = XilianSettings._currentPresetId || (presets.length > 0 ? presets[0].id : 'default');
        this._activeAgentPresetId = defaultPresetId;
        this.setChatContext('private', defaultPresetId);
        await this.loadHistory();
        this.setupListeners();
    }

    /**
     * 用预加载数据初始化（免 IPC，性能优化关键）
     * @param {Object} preloaded - { chatHistory, chatHistoryStore, chatRooms, chatHistoryLimit, settings }
     */
    initFromCache(preloaded) {
        // ★ 优先从 preloaded.settings 获取预设（避免依赖全局变量 window.__xilianPresets 的加载时序）
        const presets = preloaded.settings?.aiPresets || window.__xilianPresets || [];
        const defaultPresetId = preloaded.settings?.aiCurrentPresetId 
            || XilianSettings._currentPresetId 
            || (presets.length > 0 ? presets[0].id : 'default');

        // 1. 恢复聊天上下文：先验证 chatRoomState 的有效性
        const chatRoomState = preloaded.settings?.chatRoomState;
        const rooms = preloaded.chatRooms || [];
        let restoredToRoom = false;

        if (chatRoomState && chatRoomState.isRoomMode && chatRoomState.roomId) {
            // ★ 验证房间是否还存在（防止已删除房间残留状态）
            const roomExists = rooms.some(r => r.id === chatRoomState.roomId);
            if (roomExists) {
                this._activeAgentPresetId = null;
                this.setChatContext('room', chatRoomState.roomId);
                restoredToRoom = true;
            } else {
                console.warn('[initFromCache] 聊天室 %s 已不存在，回退到私聊', chatRoomState.roomId);
                this._activeAgentPresetId = defaultPresetId;
                this.setChatContext('private', defaultPresetId);
                // ★ 清理 chatHistoryStore 里已删除聊天室的残留数据
                if (preloaded.chatHistoryStore && chatRoomState.roomId) {
                    const deadKey = `room:${chatRoomState.roomId}`;
                    if (preloaded.chatHistoryStore[deadKey]) {
                        delete preloaded.chatHistoryStore[deadKey];
                        // 异步保存清理后的数据
                        this._cleanupDeadHistoryStore(preloaded.chatHistoryStore);
                    }
                }
            }
        }

        if (!restoredToRoom) {
            this._activeAgentPresetId = defaultPresetId;
            this.setChatContext('private', defaultPresetId);
        }

        // 2. 加载聊天记录（直接从缓存，无 IPC）
        if (preloaded.chatHistoryStore && this._currentChatKey) {
            const storeHistory = preloaded.chatHistoryStore[this._currentChatKey] || [];
            if (storeHistory.length > 0) {
                this.chatHistory = storeHistory;
            } else {
                // 回退到旧版 chatHistory
                this.chatHistory = preloaded.chatHistory || [];
                // 自动迁移旧数据
                if (this.chatHistory.length > 0) {
                    preloaded.chatHistoryStore[this._currentChatKey] = this.chatHistory;
                    this._saveHistoryFromCache(preloaded);
                }
            }
        } else {
            this.chatHistory = preloaded.chatHistory || [];
        }
        // 初始加载后同步 MC ingest 指针，避免历史被重复 ingest
        this._mcLastIngestedIndex = this.chatHistory.length;

        // 3. 设置流式监听器
        this.setupListeners();

        // 4. 注册预设切换回调
        this._registerPresetSwitchCallback();

        // 5. 如果恢复到聊天室模式，同步更新 chatRoomManager 的内存状态
        if (restoredToRoom && this.chatRoomManager) {
            this.chatRoomManager.currentRoomId = chatRoomState.roomId;
            this.chatRoomManager.isRoomMode = true;
        }

        // 6. 渲染消息到界面
        if (typeof XilianUI !== 'undefined' && XilianUI.renderMessages) {
            XilianUI.renderMessages(this.chatHistory);
            XilianUI.scrollToBottom();
        }

        // 7. 更新头部显示
        if (restoredToRoom && this.chatRoomManager) {
            const room = this.chatRoomManager.getCurrentRoom();
            if (room) {
                const agentAvatars = room.agentIds.slice(0, 5).map(id => {
                    const p = presets.find(pr => pr.id === id);
                    return (p && p.avatar && typeof XilianSettings !== 'undefined')
                        ? XilianSettings.getAvatarUrl(p.avatar) : '';
                });
                XilianUI.updateHeaderForRoom(room.name, agentAvatars, null, room.agentIds);
            }
        } else {
            if (typeof XilianSettings !== 'undefined') {
                XilianUI.updateHeaderForPrivate(
                    (presets.find(p => p.id === defaultPresetId) || {}).name || 'Elysia',
                    XilianSettings.getAgentAvatarUrl()
                );
            }
        }
    }

    /**
     * 后台异步保存迁移后的聊天记录（不阻塞 UI）
     */
    async _cleanupDeadHistoryStore(cleanedStore) {
        try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('chat-history-store-save', cleanedStore);
            console.log('[ChatHistory] 已清理已删除聊天室的残留记录');
        } catch (e) { console.warn('[ChatHistory] 清理残留记录失败:', e); }
    }

    /**
     * 后台异步保存迁移后的聊天记录（不阻塞 UI）
     */
    async _saveHistoryFromCache(preloaded) {
        try {
            const { ipcRenderer } = require('electron');
            const key = this._currentChatKey;
            const [type, id] = key.split(':');
            await ipcRenderer.invoke('chat-history-save', {
                type,
                id,
                history: this.chatHistory
            });
            console.log(`[ChatMigration] 已自动迁移 ${this.chatHistory.length} 条旧版聊天记录`);
        } catch (e) {
            // 静默失败，下次启动会重新尝试
        }
    }

    setupListeners() {
        if (this._listenersSetup) return;
        this._listenersSetup = true;

        const { ipcRenderer } = require('electron');

        ipcRenderer.on('chat-chunk', this.handleStreamChunk);
        ipcRenderer.on('chat-done', this.handleStreamDone);
        ipcRenderer.on('chat-error', this.handleStreamError);
        ipcRenderer.on('chat-confirm-request', this.handleConfirmRequest);

        // ★ 工具进度面板折叠状态持久化（XilianUI 触发）
        window.addEventListener('xilian-tool-progress-toggled', (e) => {
            const { msgId, collapsed } = e.detail || {};
            if (!msgId) return;
            const msg = this.chatHistory.find(m => m.id === msgId);
            if (msg) {
                msg.toolProgressCollapsed = !!collapsed;
                this.saveHistory();
            }
        });

        // 数据更新监听
        ipcRenderer.on('tasks-updated', () => {
            // 聊天视图激活时才刷新，避免不必要的操作
            if (this.isViewActive()) {
                this.app.loadAllData?.();
            }
        });

        // ★ 云端下载后刷新聊天记录：确保其他设备下载到的聊天记录能立即显示
        ipcRenderer.on('chat-history-updated', () => {
            if (this.isViewActive()) {
                this.loadHistory();
            }
        });

        ipcRenderer.on('chat-rooms-updated', () => {
            if (this.isViewActive()) {
                this.loadHistory();
            }
        });

        // ★ 上传前刷盘：主进程通知前端将内存中的聊天记录写入磁盘
        ipcRenderer.on('flush-chat-history', () => {
            this.saveHistory().catch(e => console.warn('[ChatHistory] flush-chat-history 保存失败:', e));
        });
    }

    // ============================================================
    // 对话历史（支持聊天室隔离）
    // ============================================================

    /**
     * 设置当前聊天上下文键
     * @param {'private'|'room'} type
     * @param {string} id - agentPresetId 或 roomId
     */
    setChatContext(type, id) {
        this._currentChatKey = `${type}:${id}`;
    }

    /**
     * 设置私聊模式（切换到指定智能体）
     */
    async switchToPrivateChat(agentPresetId) {
        this._activeAgentPresetId = agentPresetId;
        // MC 星图：AI 主星名跟随当前所选智能体
        if (typeof mcUpdateAiStarName === 'function') mcUpdateAiStarName(agentPresetId);
        this.setChatContext('private', agentPresetId);
        // ★ 防止递归：仅在 ChatRoomManager 仍处于房间模式时才切换到私聊
        // 若状态已通过回调正确设置，跳过以避免无限递归。
        if (this.chatRoomManager && this.chatRoomManager.isRoomMode) {
            this.chatRoomManager.switchToPrivateMode();
        }
        await this.loadHistory();
        XilianUI.renderMessages(this.chatHistory);
        XilianUI.scrollToBottom();
    }

    /**
     * 注册预设切换回调（settings 里切换智能体时通知聊天管理器切私聊）
     */
    _registerPresetSwitchCallback() {
        window._onPresetSwitched = (presetId) => {
            this.switchToPrivateChat(presetId);
        };
    }

    /**
     * 切换到聊天室
     */
    async switchToRoom(roomId) {
        this._activeAgentPresetId = null;
        this.setChatContext('room', roomId);
        // ★ 防止递归：仅在 ChatRoomManager 状态不一致时才同步
        // ChatRoomManager.switchToRoom 会触发 _notifyStateChange，
        // 而 state change 回调又会调用本方法，形成无限递归。
        // 通过检查 currentRoomId/isRoomMode 打破循环。
        if (this.chatRoomManager) {
            if (this.chatRoomManager.currentRoomId !== roomId || !this.chatRoomManager.isRoomMode) {
                this.chatRoomManager.switchToRoom(roomId);
            }
        }
        await this.loadHistory();
        XilianUI.renderMessages(this.chatHistory);
        XilianUI.scrollToBottom();
    }

    async loadHistory() {
        try {
            const { ipcRenderer } = require('electron');
            // 如果有当前上下文键，优先从 chatHistoryStore 加载
            if (this._currentChatKey) {
                const [type, id] = this._currentChatKey.split(':');
                if (type && id) {
                    const storeHistory = await ipcRenderer.invoke('chat-history-get', { type, id });
                    // ★ 修复：新版存储接管后，直接使用 storeHistory（即使为空数组），
                    // 不再回退到旧版 chatHistory，避免已删除的旧消息被重新加载
                    if (Array.isArray(storeHistory)) {
                        this.chatHistory = storeHistory;
                        // 切换聊天记录后重置 MC ingest 指针，避免历史被重复 ingest
                        this._mcLastIngestedIndex = this.chatHistory.length;
                        return;
                    }
                }
            }
            // 回退：从旧版全局 chatHistory 加载（仅在没有 _currentChatKey 时使用）
            const legacyHistory = await ipcRenderer.invoke('chat-get-history');
            this.chatHistory = legacyHistory || [];
            // 切换聊天记录后重置 MC ingest 指针
            this._mcLastIngestedIndex = this.chatHistory.length;
            // 如果旧版有数据，自动迁移到新版存储
            if (this.chatHistory.length > 0 && this._currentChatKey) {
                const [type, id] = this._currentChatKey.split(':');
                if (type && id) {
                    try {
                        await ipcRenderer.invoke('chat-history-save', { type, id, history: this.chatHistory });
                        console.log(`[ChatMigration] 已自动迁移 ${this.chatHistory.length} 条旧版聊天记录到 ${this._currentChatKey}`);
                    } catch (e) { /* 静默失败 */ }
                }
            }
        } catch (e) {
            console.error('[昔涟] 加载对话历史失败:', e);
            this.chatHistory = [];
            this._mcLastIngestedIndex = 0;
        }
    }

    async saveHistory() {
        try {
            const { ipcRenderer } = require('electron');
            // 按聊天记录上限裁剪
            let limit = 50;
            try { limit = await ipcRenderer.invoke('chat-history-limit-get'); } catch(e) {}
            while (this.chatHistory.length > limit) {
                this.chatHistory.shift(); // 移除最旧的消息
                // 裁剪后同步调整 MC ingest 指针，避免下标错位
                if (this._mcLastIngestedIndex > 0) this._mcLastIngestedIndex--;
            }
            // 如果有当前上下文键，保存到对应位置
            if (this._currentChatKey) {
                const [type, id] = this._currentChatKey.split(':');
                if (type && id) {
                    await ipcRenderer.invoke('chat-history-save', { type, id, history: this.chatHistory });
                    // MC 数据桥：增量 ingest 新消息到 MC（Scribe 下次扫描处理）
                    await this._mcIngestNewMessages();
                    return;
                }
            }
            // 兼容旧版
            await ipcRenderer.invoke('chat-save-history', this.chatHistory);
            // MC 数据桥：增量 ingest 新消息到 MC（Scribe 下次扫描处理）
            await this._mcIngestNewMessages();
        } catch (e) {
            console.error('[昔涟] 保存对话历史失败:', e);
        }
    }

    /**
     * MC 数据桥：增量 ingest chatHistory 中新增的消息到 MC
     * 仅处理 user/assistant 角色，其余（tool/system）跳过
     */
    async _mcIngestNewMessages() {
        try {
            const { ipcRenderer } = require('electron');
            for (let i = this._mcLastIngestedIndex; i < this.chatHistory.length; i++) {
                const m = this.chatHistory[i];
                if (!m || !m.content || typeof m.content !== 'string' || !m.content.trim()) continue;
                // role 映射：user→'user'，assistant→'draco'，其余(tool/system)跳过
                let sender = null;
                if (m.role === 'user') sender = 'user';
                else if (m.role === 'assistant') sender = 'draco';
                else continue;
                await ipcRenderer.invoke('mc:ingest', {
                    sender,
                    content: m.content,
                    timestamp: m.timestamp || new Date().toISOString(),
                    messageType: 'text'
                });
            }
            this._mcLastIngestedIndex = this.chatHistory.length;
        } catch (e) {
            console.warn('[MC] ingest bridge skipped:', e.message);
        }
    }

    /**
     * MC 数据桥：回填当前 chatHistory 中的所有历史消息到 MC
     * 用于把已有聊天记录一次性录入星图（调用方控制去重）
     * @returns {Promise<number>} 已 ingest 的消息条数
     */
    async _mcBackfillCurrentChat() {
        try {
            const { ipcRenderer } = require('electron');
            let ingested = 0;
            for (const m of this.chatHistory) {
                if (!m || !m.content || typeof m.content !== 'string' || !m.content.trim()) continue;
                let sender = null;
                if (m.role === 'user') sender = 'user';
                else if (m.role === 'assistant') sender = 'draco';
                else continue;
                await ipcRenderer.invoke('mc:ingest', {
                    sender,
                    content: m.content,
                    timestamp: m.timestamp || new Date().toISOString(),
                    messageType: 'text'
                });
                ingested++;
            }
            this._mcLastIngestedIndex = this.chatHistory.length;
            console.log('[MC] 当前聊天历史回填完成:', ingested, '条消息');
            return ingested;
        } catch (e) {
            console.warn('[MC] 历史回填失败:', e.message);
            return 0;
        }
    }

    async clearHistory() {
        this.chatHistory = [];
        this._mcLastIngestedIndex = 0;
        try {
            const { ipcRenderer } = require('electron');
            // 如果有当前上下文键，只清空对应聊天的记录
            if (this._currentChatKey) {
                const [type, id] = this._currentChatKey.split(':');
                if (type && id) {
                    await ipcRenderer.invoke('chat-history-save', { type, id, history: [] });
                    return;
                }
            }
            // 兼容旧版
            await ipcRenderer.invoke('chat-clear-history');
        } catch (e) {
            console.error('[昔涟] 清空对话历史失败:', e);
        }
    }

    // ============================================================
    // 停止流式输出
    // ============================================================

    stopStreaming() {
        if (!this.isStreaming) return;

        this._setStreaming(false);
        XilianUI.setInputEnabled(true);
        XilianUI.showToolStatus(false, '');
        XilianUI.hideToolCards();

        // ★ 隐藏内嵌工具进度面板
        if (this.currentAssistantMsg) {
            XilianUI.hideToolProgress(this.currentAssistantMsg.id);
        }

        // 清空多智能体待回复队列
        this._pendingReplyQueue = [];
        this._currentToolRound = 0;

        // 保存已生成的部分内容
        if (this.currentAssistantMsg) {
            this.currentAssistantMsg.content = this.streamBuffer || '(已暂停)';
            this.currentAssistantMsg.timestamp = Date.now();
            this.chatHistory.push(this.currentAssistantMsg);
            XilianUI.finalizeAssistantContent(this.currentAssistantMsg.id);
            this.saveHistory();
        }
        this.currentAssistantMsg = null;
        this.streamBuffer = '';

        XilianUI.appendSystemMessage('⏸ 已停止生成');
        XilianUI.scrollToBottom();

        // 通知主进程停止（尽力）
        try {
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('chat-stop-stream');
        } catch (e) {}
    }

    // ============================================================
    // 删除单条消息
    // ============================================================

    async deleteMessage(msgId) {
        const idx = this.chatHistory.findIndex(m => m.id === msgId);
        if (idx === -1) return;
        
        this.chatHistory.splice(idx, 1);
        await this.saveHistory();
        
        // 重新渲染
        XilianUI.renderMessages(this.chatHistory);
        if (this.chatHistory.length === 0) {
            XilianUI.showWelcome();
        }
    }

    // ============================================================
    // 流式状态管理
    // ============================================================

    _setStreaming(value) {
        this.isStreaming = value;
        if (typeof this._onStreamStateChange === 'function') {
            this._onStreamStateChange(value);
        }
    }

    // ============================================================
    // 发送消息
    // ============================================================

    async sendMessage(text) {
        if (this.isStreaming || !text.trim()) return;

        const { ipcRenderer } = require('electron');
        const { v4: uuidv4 } = require('uuid');

        let agentPresetId = null;
        let displayText = text.trim();

        // 检测 @提及，获取回复顺序
        let replyOrder = null;
        if (this.chatRoomManager && this.chatRoomManager.isRoomMode) {
            const mention = this.chatRoomManager.parseMention(displayText);
            if (mention.target) {
                const agent = this.chatRoomManager.findAgentByMention(mention.target);
                if (agent) {
                    agentPresetId = agent.id;
                    displayText = mention.content;
                }
            }
            // 重置本轮发言计数
            this.chatRoomManager.resetReplyCounts();
            // 获取回复顺序（@时只有1个，没@时返回全部随机打乱）
            replyOrder = this.chatRoomManager.getReplyOrder(agentPresetId);
            if (replyOrder.length > 0) {
                // 第一个智能体是当前要回复的
                agentPresetId = replyOrder[0].agentId;
                // 剩余的放入队列，在 handleStreamDone 中链式处理
                this._pendingReplyQueue = replyOrder.slice(1);
            }
        }

        // 1. 添加用户消息
        const userMsg = {
            id: uuidv4(),
            role: 'user',
            content: displayText,
            toolCalls: null,
            toolCallId: null,
            timestamp: Date.now(),
            userId: 'admin', // 会由主进程用 getCurrentUserId 覆盖
            mentionedAgentId: agentPresetId || null
        };
        this.chatHistory.push(userMsg);
        XilianUI.appendMessage(userMsg);
        XilianUI.scrollToBottom();
        XilianUI.setInputEnabled(false);
        XilianUI.hideWelcome();

        // 2. 创建助手消息占位
        const assistantMsgId = uuidv4();
        this.currentAssistantMsg = {
            id: assistantMsgId,
            role: 'assistant',
            content: '',
            toolCalls: [],
            toolCallId: null,
            timestamp: Date.now(),
            userId: 'admin',
            agentPresetId: agentPresetId || null,
            toolEvents: []  // ★ 工具调用事件持久化数组
        };
        this.streamBuffer = '';
        XilianUI.appendAssistantPlaceholder(assistantMsgId);

        // 3. 准备 AI 配置（使用激活的预设配置，或@指定的智能体配置）
        let config = XilianSettings.getActivePresetConfig();
        if (agentPresetId) {
            // 聊天室模式：使用 @指定的智能体配置
            const presets = window.__xilianPresets || [];
            const targetPreset = presets.find(p => p.id === agentPresetId);
            if (targetPreset) {
                config = {
                    ...config,
                    agentName: targetPreset.name,
                    systemPrompt: targetPreset.systemPrompt ?? config.systemPrompt,
                    avatar: targetPreset.avatar || config.avatar
                };
            }
        } else if (this._activeAgentPresetId) {
            // ★ 私聊模式：使用用户在聊天头部下拉选中的智能体
            // 此前无论选哪个智能体，都使用 XilianSettings._currentPresetId
            // （设置面板的当前预设），导致选桑多涅但回复是哥伦比娅的口吻。
            const presets = window.__xilianPresets || [];
            const targetPreset = presets.find(p => p.id === this._activeAgentPresetId);
            if (targetPreset) {
                config = {
                    ...config,
                    agentName: targetPreset.name,
                    systemPrompt: targetPreset.systemPrompt ?? config.systemPrompt,
                    avatar: targetPreset.avatar || config.avatar
                };
            }
        }

        // MC 星图：AI 主星名跟随当前所选智能体（@提及或私聊）
        if (typeof mcUpdateAiStarName === 'function') mcUpdateAiStarName(agentPresetId || this._activeAgentPresetId);
        // 记录正在回复的智能体（聊天室模式下记录发言）
        this._currentReplyAgentId = agentPresetId;
        if (this.chatRoomManager && this.chatRoomManager.isRoomMode && agentPresetId) {
            this.chatRoomManager.recordAgentSpeak(agentPresetId);
        }

        // 4. 构建消息数组
        const messages = this.buildMessages(userMsg);

        // 5. 启动流式聊天
        this._setStreaming(true);
        XilianUI.showToolStatus(false, '');
        XilianUI.setModelBadge(config.model || 'deepseek-v4-flash');
        // 更新头部显示
        if (agentPresetId) {
            XilianUI.updateHeaderForMentionedAgent(agentPresetId);
        }

        ipcRenderer.send('chat-start-stream', { messages, config });
    }

    buildMessages(currentUserMsg) {
        // 当前用户消息已经在 chatHistory 中，系统提示词由主进程构造
        // 传送最近的消息到主进程，主进程会加上系统提示词和截断
        const messages = [];

        // 传递对话历史（主进程会根据 contextRounds 截断）
        for (const msg of this.chatHistory) {
            if (msg.role === 'system') continue; // 跳过历史 system 消息

            if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                messages.push({
                    role: 'assistant',
                    content: msg.content || null,
                    tool_calls: msg.toolCalls,
                    timestamp: msg.timestamp
                });
            } else if (msg.role === 'tool') {
                messages.push({
                    role: 'tool',
                    tool_call_id: msg.toolCallId || '',
                    content: msg.content || '',
                    timestamp: msg.timestamp
                });
            } else {
                messages.push({
                    role: msg.role,
                    content: msg.content || '',
                    hallucinated: msg.hallucinated || false,
                    timestamp: msg.timestamp
                });
            }
        }

        return messages;
    }

    // ============================================================
    // 流式响应处理
    // ============================================================

    handleStreamChunk(event, chunk) {
        if (!this.isStreaming) return;

        switch (chunk.type) {
            case 'content':
                // 打字机效果
                this.streamBuffer += chunk.data;
                XilianUI.updateAssistantContent(this.currentAssistantMsg.id, this.streamBuffer);
                break;

            case 'tool-call':
                // 工具调用开始
                const toolInfo = {
                    toolCallId: chunk.data.toolCallId,
                    name: chunk.data.toolName,
                    arguments: chunk.data.arguments
                };
                XilianUI.showToolStatus(true, `正在执行: ${this.getToolLabel(chunk.data.toolName)}...`);
                XilianUI.appendToolCard({
                    name: chunk.data.toolName,
                    status: 'running',
                    args: chunk.data.arguments
                });
                // ★ 内嵌进度面板：在助手消息气泡内显示工具调用
                if (this.currentAssistantMsg) {
                    XilianUI.showToolProgress(
                        this.currentAssistantMsg.id,
                        chunk.data.toolName,
                        'running',
                        { arguments: chunk.data.arguments, toolCallId: chunk.data.toolCallId }
                    );
                    // ★ 持久化工具调用事件到消息对象
                    this.currentAssistantMsg.toolEvents = this.currentAssistantMsg.toolEvents || [];
                    this.currentAssistantMsg.toolEvents.push({
                        toolCallId: chunk.data.toolCallId,
                        name: chunk.data.toolName,
                        args: chunk.data.arguments,
                        status: 'running',
                        result: null,
                        timestamp: Date.now()
                    });
                }
                this._currentToolRound = (this._currentToolRound || 0) + 1;
                break;

            case 'tool-result':
                // 工具执行完成
                const result = chunk.data.result;
                const success = result?.success !== false;
                XilianUI.showToolStatus(true,
                    `${success ? '✅' : '❌'} ${this.getToolLabel(chunk.data.toolName)}: ${result?.message || ''}`);

                // 更新工具卡片状态
                XilianUI.updateLastToolCard({
                    name: chunk.data.toolName,
                    status: success ? 'done' : 'error',
                    message: result?.message || '',
                    args: chunk.data.arguments
                });

                // ★ 内嵌进度面板：更新为完成/失败状态
                if (this.currentAssistantMsg) {
                    XilianUI.showToolProgress(
                        this.currentAssistantMsg.id,
                        chunk.data.toolName,
                        success ? 'done' : 'error',
                        { message: result?.message || '', toolCallId: chunk.data.toolCallId }
                    );
                    // ★ 更新持久化的工具调用事件状态
                    const events = this.currentAssistantMsg.toolEvents || [];
                    const ev = events.find(e => e.toolCallId === chunk.data.toolCallId || e.name === chunk.data.toolName);
                    if (ev) {
                        ev.status = success ? 'done' : 'error';
                        ev.result = result?.message || (success ? '完成' : '失败');
                        ev.finishedAt = Date.now();
                    } else {
                        // 兜底：如果没找到对应事件（罕见），追加一条
                        events.push({
                            toolCallId: chunk.data.toolCallId,
                            name: chunk.data.toolName,
                            args: chunk.data.arguments,
                            status: success ? 'done' : 'error',
                            result: result?.message || '',
                            timestamp: Date.now()
                        });
                    }
                }
                break;
        }
    }

    handleStreamDone(event, result) {
        // 如果用户已手动停止，忽略后续的 done 事件
        if (!this.isStreaming && this.currentAssistantMsg === null) return;

        this._setStreaming(false);
        XilianUI.hideToolCards();

        // 隐藏工具状态（延迟一下让用户看到最后状态）
        setTimeout(() => XilianUI.showToolStatus(false, ''), 1500);

        // ★ 内嵌面板：不立即隐藏（让它自己渐隐，showToolProgress(done)里已有延迟逻辑）
        // 重置工具轮次计数
        this._currentToolRound = 0;

        // 保存助手消息（幻觉消息标记后不入API上下文）
        this.currentAssistantMsg.content = this.streamBuffer;
        this.currentAssistantMsg.timestamp = Date.now();
        if (result.hallucinated) {
          this.currentAssistantMsg.hallucinated = true;
        }
        this.chatHistory.push(this.currentAssistantMsg);

        // 移除光标
        XilianUI.finalizeAssistantContent(this.currentAssistantMsg.id);
        XilianUI.scrollToBottom();

        // 保存历史
        this.saveHistory();

        // 离线模式提示
        if (result.offlineMode) {
            XilianUI.showToolStatus(true, '💡 请在设置中配置 DeepSeek API Key 获得完整 AI 体验');
            setTimeout(() => XilianUI.showToolStatus(false, ''), 4000);
        }

        // 如果 maxRoundsReached，追加提示
        if (result.maxRoundsReached && this.streamBuffer) {
            XilianUI.appendSystemMessage('⚠️ 已达到最大工具调用轮数（已执行 ' + (result.toolCallCount || 0) + ' 步，限制 ' + (result.maxToolRounds || '?') + ' 步），已完成部分操作。你可以继续和我对话完成剩余操作。');
        }

        // ★ P1-2: 死循环检测提示
        if (result.loopDetected) {
            const reason = result.loopReason || '检测到重复操作';
            XilianUI.appendSystemMessage('⚠️ ' + reason + '，已自动停止。已完成 ' + (result.toolCallCount || 0) + ' 步操作。如需继续，请换一种说法或拆分任务。');
        }

        this.currentAssistantMsg = null;
        this.streamBuffer = '';

        // 刷新其他视图（工具可能修改了数据）
        if (result.toolCallCount > 0) {
            XilianUI.refreshOtherViews();
        }

        // ============================================================
        // 多智能体链式发言：检查队列中是否有下一个智能体
        // ============================================================
        if (this._pendingReplyQueue && this._pendingReplyQueue.length > 0) {
            const next = this._pendingReplyQueue.shift();
            this._startAgentReply(next.agentId, next.isPrimary);
        } else {
            // 全部发言完毕，恢复输入
            XilianUI.setInputEnabled(true);
        }
    }

    handleStreamError(event, error) {
        if (!this.isStreaming && this.currentAssistantMsg === null) return;
        
        this._setStreaming(false);
        XilianUI.showToolStatus(false, '');

        const errMsg = error?.message || '未知错误';
        const agentName = this._getAgentNameById(this._currentReplyAgentId);

        if (this.currentAssistantMsg) {
            this.currentAssistantMsg.content = this.streamBuffer || `❌ ${agentName ? agentName + '：' : ''}${errMsg}`;
            this.currentAssistantMsg.timestamp = Date.now();
            this.chatHistory.push(this.currentAssistantMsg);
            XilianUI.finalizeAssistantContent(this.currentAssistantMsg.id);
        }

        this.currentAssistantMsg = null;
        this.streamBuffer = '';

        // ============================================================
        // 多智能体容错：出错时跳过当前智能体，继续下一个
        // ============================================================
        if (this._pendingReplyQueue && this._pendingReplyQueue.length > 0) {
            const next = this._pendingReplyQueue.shift();
            XilianUI.appendSystemMessage(`⚠️ ${agentName || '智能体'} 回复失败: ${errMsg}`);
            this._startAgentReply(next.agentId, next.isPrimary);
        } else {
            XilianUI.appendSystemMessage(`❌ ${errMsg}`);
            XilianUI.setInputEnabled(true);
        }
    }

    // ============================================================
    // 多智能体链式发言辅助
    // ============================================================

    /**
     * 启动指定智能体的流式回复（由 handleStreamDone / handleStreamError 链式调用）
     */
    _startAgentReply(agentId, isPrimary) {
        const { ipcRenderer } = require('electron');
        const { v4: uuidv4 } = require('uuid');

        const presets = window.__xilianPresets || [];
        const preset = presets.find(p => p.id === agentId);
        if (!preset) {
            // 找不到预设，跳过并尝试下一个
            if (this._pendingReplyQueue.length > 0) {
                const next = this._pendingReplyQueue.shift();
                this._startAgentReply(next.agentId, next.isPrimary);
            } else {
                XilianUI.setInputEnabled(true);
            }
            return;
        }

        // 构建该智能体的配置
        let config = { ...XilianSettings.getActivePresetConfig() };
        config.agentName = preset.name;
        config.systemPrompt = preset.systemPrompt ?? config.systemPrompt;
        config.avatar = preset.avatar || config.avatar;

        // 非主力智能体：在 system prompt 追加"反应模式"指令
        if (!isPrimary) {
            const reactionHint = '\n\n【注意】你正在参与群聊讨论，本轮你只需要对用户的发言给出简短的个人反应和评论（控制在2-3句话内），不需要调用任何工具。';
            config.systemPrompt = (config.systemPrompt || '') + reactionHint;
        }

        // 记录发言
        this._currentReplyAgentId = agentId;
        if (this.chatRoomManager) {
            this.chatRoomManager.recordAgentSpeak(agentId);
        }

        // 创建助手消息占位
        const assistantMsgId = uuidv4();
        this.currentAssistantMsg = {
            id: assistantMsgId,
            role: 'assistant',
            content: '',
            toolCalls: [],
            toolCallId: null,
            timestamp: Date.now(),
            userId: 'admin',
            agentPresetId: agentId
        };
        this.streamBuffer = '';

        // 更新头部显示
        XilianUI.updateHeaderForMentionedAgent(agentId);

        // 添加占位并启动流式
        XilianUI.appendAssistantPlaceholder(assistantMsgId);
        this._setStreaming(true);
        XilianUI.showToolStatus(false, '');
        XilianUI.setModelBadge(config.model || 'deepseek-v4-flash');

        // 构建消息（不包含刚刚追加的助手消息）
        const messages = this.buildMessagesForAgent();
        ipcRenderer.send('chat-start-stream', { messages, config });
    }

    /**
     * 为后续智能体构建消息（跳过其他智能体刚回复的消息，仅保留用户+历史上下文）
     */
    buildMessagesForAgent() {
        const messages = [];
        for (const msg of this.chatHistory) {
            if (msg.role === 'system') continue;
            if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                messages.push({
                    role: 'assistant',
                    content: msg.content || null,
                    tool_calls: msg.toolCalls,
                    timestamp: msg.timestamp
                });
            } else if (msg.role === 'tool') {
                messages.push({
                    role: 'tool',
                    tool_call_id: msg.toolCallId,
                    content: msg.content,
                    timestamp: msg.timestamp
                });
            } else {
                messages.push({
                    role: msg.role,
                    content: msg.content,
                    timestamp: msg.timestamp
                });
            }
        }
        return messages;
    }

    /**
     * 根据智能体ID获取名称
     */
    _getAgentNameById(agentId) {
        if (!agentId) return null;
        const presets = window.__xilianPresets || [];
        const preset = presets.find(p => p.id === agentId);
        return preset ? preset.name : null;
    }

    // ============================================================
    // 确认请求处理（删除确认）
    // ============================================================

    async handleConfirmRequest(event, { action, itemId, itemTitle }) {
        const { ipcRenderer } = require('electron');

        const confirmInfo = {
            deleteTask: { label: '任务', verb: '删除' },
            deleteMemo: { label: '备忘录', verb: '删除' },
            deleteExpense: { label: '收支记录', verb: '删除' },
            writeAppFile: { label: '代码文件', verb: '修改' },
            updateAgentRules: { label: '智能体行为规则', verb: '更新' }
        };
        const info = confirmInfo[action] || { label: '项目', verb: '执行' };
        const label = info.label;
        const verb = info.verb;
        const title = itemTitle ? `「${itemTitle}」` : '';

        // 使用 confirm 弹窗
        const confirmed = window.confirm(
            `⚠️ 昔涟请求${verb}${label}${title}\n\n` +
            `操作: ${action}\n目标: ${itemId || '(无)'}\n\n确定要${verb}吗？`
        );

        // ★ P0-3 修复：直接发送 chat-confirm-response-once（与 main.js 的 ipcMain.once 对齐）
        // 原先发送 'chat-confirm-response'，main.js 转发回 renderer，导致 ipcMain.once 永远收不到
        ipcRenderer.send('chat-confirm-response-once', { confirmed });
    }

    // ============================================================
    // 工具
    // ============================================================

    getToolLabel(name) {
        const labels = {
            createTask: '创建任务', updateTask: '更新任务', deleteTask: '删除任务',
            listTasks: '查询任务', completeTask: '完成任务',
            createMemo: '创建备忘录', updateMemo: '更新备忘录',
            deleteMemo: '删除备忘录', listMemos: '查询备忘录',
            addExpense: '记账', updateExpense: '更新记录',
            deleteExpense: '删除记录', listExpenses: '查询账单',
            getExpenseSummary: '收支汇总',
            addJournal: '写日志', listJournals: '查询日志',
            createBudget: '创建预算', updateBudget: '更新预算',
            listBudgets: '查询预算', getBudgetStatus: '预算状态',
            getSettings: '读取设置', updateSettings: '更新设置',
            switchUser: '切换用户',
            triggerSync: '云同步', getSyncStatus: '同步状态',
            getDashboard: '获取概览',
            listAppFiles: '列出源码文件', readAppFile: '读取源码', searchAppCode: '搜索代码',
            runNodeCheck: '语法检查', writeAppFile: '修改代码', updateAgentRules: '更新行为规则'
        };
        return labels[name] || name;
    }

    isViewActive() {
        const xilianView = document.getElementById('xilianView');
        return xilianView && xilianView.classList.contains('active');
    }

    // ============================================================
    // 视图激活/停用
    // ============================================================

    onViewActivated() {
        // ★ 修复：流式输出时不要重建 DOM，否则会销毁正在显示的流式内容
        if (this.isStreaming) {
            XilianUI.scrollToBottom();
            XilianUI.focusInput();
            return;
        }
        XilianUI.renderMessages(this.chatHistory);
        XilianUI.scrollToBottom();
        XilianUI.focusInput();
    }

    onViewDeactivated() {
        // 如果正在流式输出，暂不处理（保持后台）
    }
}

// 单例
let xilianManagerInstance = null;
function getXilianManager(appController) {
    if (!xilianManagerInstance && appController) {
        xilianManagerInstance = new XilianManager(appController);
    }
    return xilianManagerInstance;
}
