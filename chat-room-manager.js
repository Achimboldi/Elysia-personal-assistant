/**
 * chat-room-manager.js — 聊天室管理器（渲染进程）
 * 负责：聊天室预设管理、@选择、模式切换（私聊/聊天室）、多智能体对话逻辑
 */

(function() {
  // 防止文件被 <script> 重复加载导致 class/function 重复声明而报 SyntaxError
  if (window.__chatRoomManagerLoaded) {
    return;
  }
  window.__chatRoomManagerLoaded = true;

  var { ipcRenderer } = require('electron');

// 安全获取 uuid：优先使用 uuid 模块，否则回退到 crypto.randomUUID
// 使用 var 而非 let，防止文件在全局作用域被加载两次时报重复声明错误
var uuidv4;
try {
  ({ v4: uuidv4 } = require('uuid'));
} catch (e) {
  uuidv4 = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // 极简回退：时间戳 + 随机数
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  };
}

class ChatRoomManager {
    constructor() {
        this.chatRooms = [];           // 聊天室预设列表
        this.currentRoomId = null;     // 当前聊天室ID（null=私聊模式）
        this.isRoomMode = false;       // 是否聊天室模式
        this.mentionedAgentId = null;  // 当前被@的智能体预设ID
        this._onStateChange = null;    // 状态变化回调
        this._pendingAgentReplies = []; // 待处理的智能体回复队列
        this._agentReplyCounts = {};   // 每轮每个智能体已发言次数
        this._notifying = false;       // ★ 防递归锁
    }

    // ============================================================
    // 初始化
    // ============================================================

    async init() {
        await this.loadChatRooms();
        // 检查是否有保存的上次模式状态
        try {
            const state = await ipcRenderer.invoke('chat-room-get-state');
            if (state && state.roomId && this.chatRooms.find(r => r.id === state.roomId)) {
                this.currentRoomId = state.roomId;
                this.isRoomMode = true;
            }
        } catch (e) {}
    }

    async loadChatRooms() {
        try {
            this.chatRooms = await ipcRenderer.invoke('chat-room-get-all');
        } catch (e) {
            console.error('[聊天室] 加载聊天室预设失败:', e);
            this.chatRooms = [];
        }
    }

    async saveChatRooms() {
        try {
            const result = await ipcRenderer.invoke('chat-room-save-all', this.chatRooms);
            if (!result || !result.success) {
                throw new Error('写入失败: ' + (result?.message || '未知错误'));
            }
        } catch (e) {
            console.error('[聊天室] 保存聊天室预设失败:', e);
            throw e; // 向上传播让调用方感知
        }
    }

    // ============================================================
    // 聊天室预设 CRUD
    // ============================================================

    async addChatRoom(name, agentPresetIds) {
        if (agentPresetIds.length > 10) {
            throw new Error('聊天室最多支持10个智能体');
        }
        const room = {
            id: uuidv4(),
            name: name || '新聊天室',
            agentIds: agentPresetIds,
            createdAt: Date.now()
        };
        this.chatRooms.push(room);
        try {
            await this.saveChatRooms();
        } catch (e) {
            // 保存失败 → 回滚本地状态，避免内存有但磁盘无
            this.chatRooms = this.chatRooms.filter(r => r.id !== room.id);
            throw new Error('保存聊天室失败: ' + (e.message || e));
        }
        this._notifyStateChange();
        return room;
    }

    async updateChatRoom(roomId, updates) {
        const idx = this.chatRooms.findIndex(r => r.id === roomId);
        if (idx === -1) throw new Error('聊天室不存在');
        const oldState = { ...this.chatRooms[idx] };
        Object.assign(this.chatRooms[idx], updates);
        try {
            await this.saveChatRooms();
        } catch (e) {
            // 保存失败 → 回滚
            Object.assign(this.chatRooms[idx], oldState);
            throw new Error('更新聊天室失败: ' + (e.message || e));
        }
        this._notifyStateChange();
    }

    async deleteChatRoom(roomId) {
        const idx = this.chatRooms.findIndex(r => r.id === roomId);
        if (idx === -1) return;
        const removed = this.chatRooms.splice(idx, 1)[0];
        // 同时清理该聊天室的聊天记录
        await ipcRenderer.invoke('chat-room-delete-history', roomId);
        if (this.currentRoomId === roomId) {
            this.switchToPrivateMode();
        }
        try {
            await this.saveChatRooms();
        } catch (e) {
            // 保存失败 → 回滚
            this.chatRooms.splice(idx, 0, removed);
            throw new Error('删除聊天室失败: ' + (e.message || e));
        }
        this._notifyStateChange();
    }

    // ============================================================
    // 模式切换
    // ============================================================

    switchToRoom(roomId) {
        const room = this.chatRooms.find(r => r.id === roomId);
        if (!room) return;
        this.currentRoomId = roomId;
        this.isRoomMode = true;
        this.mentionedAgentId = null;
        this._agentReplyCounts = {};
        this._pendingAgentReplies = [];
        this._saveState();
        this._notifyStateChange();
    }

    switchToPrivateMode() {
        this.currentRoomId = null;
        this.isRoomMode = false;
        this.mentionedAgentId = null;
        this._agentReplyCounts = {};
        this._pendingAgentReplies = [];
        this._saveState();
        this._notifyStateChange();
    }

    getCurrentRoom() {
        if (!this.isRoomMode || !this.currentRoomId) return null;
        return this.chatRooms.find(r => r.id === this.currentRoomId) || null;
    }

    async _saveState() {
        try {
            await ipcRenderer.invoke('chat-room-save-state', {
                roomId: this.currentRoomId,
                isRoomMode: this.isRoomMode
            });
        } catch (e) {}
    }

    // ============================================================
    // @提及处理
    // ============================================================

    parseMention(text) {
        // 匹配 @智能体名 或 @智能体id
        const match = text.match(/^@(\S+)\s+(.*)/);
        if (match) {
            const target = match[1];
            const content = match[2];
            return { target, content };
        }
        return { target: null, content: text };
    }

    findAgentByMention(target) {
        // 先通过名字匹配，再通过ID匹配
        const presets = this._getPresets();
        let agent = presets.find(p => p.name === target);
        if (!agent) {
            agent = presets.find(p => p.id === target);
        }
        return agent || null;
    }

    _getPresets() {
        // 从设置中获取智能体预设列表
        try {
            // ★ 优先读取全局变量，回退到 XilianSettings 内部状态（防止加载时序问题）
            return window.__xilianPresets 
                || (typeof XilianSettings !== 'undefined' && XilianSettings._presets) 
                || [];
        } catch (e) {
            return [];
        }
    }

    // 获取当前可用的智能体列表
    getAvailableAgents() {
        const presets = this._getPresets();
        if (this.isRoomMode) {
            const room = this.getCurrentRoom();
            if (!room) return [];
            return presets.filter(p => room.agentIds.includes(p.id));
        }
        // 私聊模式：当前激活的预设
        const activePresetId = this._getActivePresetId();
        return presets.filter(p => p.id === activePresetId);
    }

    _getActivePresetId() {
        try {
            return window.__xilianCurrentPresetId || null;
        } catch (e) {
            return null;
        }
    }

    // ============================================================
    // 智能体回复管理（多智能体场景）
    // ============================================================

    /**
     * 检查本轮是否允许指定智能体发言
     */
    canAgentSpeak(agentPresetId) {
        if (!this.isRoomMode) return true; // 私聊模式无限制
        const count = this._agentReplyCounts[agentPresetId] || 0;
        return count < 1; // 每轮每个智能体最多1条
    }

    /**
     * 记录智能体发言
     */
    recordAgentSpeak(agentPresetId) {
        this._agentReplyCounts[agentPresetId] = (this._agentReplyCounts[agentPresetId] || 0) + 1;
    }

    /**
     * 重置本轮发言计数（用户发送新消息时调用）
     */
    resetReplyCounts() {
        this._agentReplyCounts = {};
        this._pendingAgentReplies = [];
    }

    /**
     * 获取需要回复的智能体列表（按随机顺序）
     * @param {string|null} triggeredAgentId - @指定的智能体ID，为null时全员随机反应
     * @returns {Array<{agentId: string, isPrimary: boolean}>} 回复队列
     */
    getReplyOrder(triggeredAgentId) {
        if (!this.isRoomMode) {
            return triggeredAgentId ? [{ agentId: triggeredAgentId, isPrimary: true }] : [];
        }

        const room = this.getCurrentRoom();
        if (!room) return [];

        // @了特定智能体：只有该智能体回复（干活的主力）
        if (triggeredAgentId) {
            return [{ agentId: triggeredAgentId, isPrimary: true }];
        }

        // 没有@：所有智能体按随机顺序依次发言
        // 第一个是"主力"（可以调工具干活），后续是"反应"（简短评论即可）
        const availableAgents = room.agentIds.filter(id => this.canAgentSpeak(id));
        if (availableAgents.length === 0) return [];

        // Fisher-Yates 洗牌
        const shuffled = [...availableAgents];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        return shuffled.map((agentId, index) => ({
            agentId,
            isPrimary: index === 0  // 第一个是主力
        }));
    }

    /**
     * 检查是否所有智能体都已发言完毕
     */
    allAgentsReplied() {
        if (!this.isRoomMode) return true;
        const room = this.getCurrentRoom();
        if (!room || room.agentIds.length <= 1) return true;
        return room.agentIds.every(id => (this._agentReplyCounts[id] || 0) >= 1);
    }

    // ============================================================
    // 回调
    // ============================================================

    _notifyStateChange() {
        // ★ 防递归：若已在通知中，跳过以避免无限循环
        if (this._notifying) return;
        this._notifying = true;
        try {
            if (typeof this._onStateChange === 'function') {
                this._onStateChange({
                    isRoomMode: this.isRoomMode,
                    currentRoom: this.getCurrentRoom(),
                    mentionedAgentId: this.mentionedAgentId
                });
            }
        } finally {
            this._notifying = false;
        }
    }

    onStateChange(callback) {
        this._onStateChange = callback;
    }
}

// 单例：使用 window 存储实例，避免 let 重复声明风险（文件可能被多次加载）
function getChatRoomManager() {
    if (!window.__chatRoomManagerInstance) {
        window.__chatRoomManagerInstance = new ChatRoomManager();
    }
    return window.__chatRoomManagerInstance;
}

module.exports = { ChatRoomManager, getChatRoomManager };

// ★ 显式挂载到全局，确保 require() 加载的模块（如 settings-manager.js）也能访问
// 因为 settings-manager.js 通过 require 加载，处于 CommonJS 模块作用域，
// 无法直接访问 <script> 标签加载的 chat-room-manager.js 中的函数
window.getChatRoomManager = getChatRoomManager;

})();
