/**
 * xilian-settings.js — 昔涟智能体设置面板逻辑
 */
const { v4: uuidv4 } = require('uuid');

const XilianSettings = {
    _config: {},
    _presets: [],
    _currentPresetId: '',

    async init() {
        // 先获取背景图目录（需在 loadConfig 之前，头像渲染依赖它）
        await this._getBgDir();
        await this.loadConfig();
        this.bindEvents();
        // 同步全局变量供聊天室管理器使用
        window.__xilianPresets = this._presets;
        window.__xilianCurrentPresetId = this._currentPresetId;
    },

    // ============================================================
    // 加载
    // ============================================================
    async loadConfig() {
        try {
            const { ipcRenderer } = require('electron');
            const settings = await ipcRenderer.invoke('get-settings');
            this._config = {
                aiProvider: settings.aiProvider || 'deepseek',
                aiApiKey: settings.aiApiKey || '',
                aiBaseUrl: settings.aiBaseUrl || 'https://api.deepseek.com',
                aiModel: settings.aiModel || 'deepseek-v4-flash',
                aiDeleteConfirmEnabled: settings.aiDeleteConfirmEnabled !== false,
                aiOperationLogEnabled: settings.aiOperationLogEnabled || false,
                aiUserName: settings.aiUserName || '我',
                aiUserAvatar: settings.aiUserAvatar || '',
            };
            this._presets = settings.aiPresets || [];
            
            // ★ 启动时清理同名重复预设（保留数据最丰富的那个）
            let cleaned = false;
            const seenNames = new Map();
            this._presets = this._presets.filter(p => {
                const name = (p.name || '').trim().toLowerCase();
                if (!name) return true; // 无名称的保留
                const existing = seenNames.get(name);
                if (existing) {
                    // 出现重复 → 比较谁的 systemPrompt 更长、是否有头像
                    const existingScore = (existing.systemPrompt?.length || 0) + (existing.avatar ? 100 : 0);
                    const currentScore = (p.systemPrompt?.length || 0) + (p.avatar ? 100 : 0);
                    if (currentScore > existingScore) {
                        // 当前这个更丰富 → 替换掉之前保留的
                        cleaned = true;
                        seenNames.set(name, p);
                        return true; // 保留这个
                    }
                    cleaned = true;
                    return false; // 丢弃这个（已有更丰富的）
                }
                seenNames.set(name, p);
                return true;
            });
            if (cleaned) {
                console.log('[昔涟] 启动时清理了重复预设，当前列表:', this._presets.map(p => p.name));
                await this.saveSettingsSilent();
            }
            
            // 确保有默认预设
            if (this._presets.length === 0) {
                this._presets = [{
                    id: 'default',
                    name: settings.aiAgentName || '昔涟',
                    avatar: settings.aiAgentAvatar || '昔涟.gif',
                    systemPrompt: settings.aiSystemPrompt || '',
                    temperature: settings.aiTemperature ?? 1.0,
                    contextRounds: settings.aiContextRounds ?? 10,
                    streamEnabled: settings.aiStreamEnabled !== false
                }];
                // 首次创建默认预设时自动保存
                await this.saveSettingsSilent();
            }
            this._currentPresetId = settings.aiCurrentPresetId || '';
            // 修正：如果 aiCurrentPresetId 指向的预设不存在，回退到第一个
            const foundPreset = this._presets.find(p => p.id === this._currentPresetId);
            if (!foundPreset) {
                this._currentPresetId = this._presets[0]?.id || '';
                // 自动修正文件中的错误引用
                if (this._currentPresetId && settings.aiCurrentPresetId) {
                    await this.saveSettingsSilent();
                }
            }
            this.renderAPIConfig();   // API 配置字段（Key/URL/Model等）
            this.renderPresetSelect();
            this.renderActivePreset();
            this.renderUserForm();
            this.updateChatHeader();
        } catch (e) { console.error('[昔涟] 加载失败:', e); }
    },

    // ============================================================
    // 预设下拉框
    // ============================================================
    renderPresetSelect() {
        const sel = document.getElementById('aiPresetSelect');
        if (!sel) return;
        
        // 检测同名预设，给重复的添加 ID 后缀以区分
        const nameCount = {};
        for (const p of this._presets) {
            const key = (p.name || '未命名').trim();
            nameCount[key] = (nameCount[key] || 0) + 1;
        }
        
        sel.innerHTML = this._presets.map(p => {
            const displayName = this._esc(p.name || '未命名');
            const key = (p.name || '未命名').trim();
            const label = nameCount[key] > 1
                ? `${displayName} [${p.id.slice(-6)}]`
                : displayName;
            const selected = p.id === this._currentPresetId ? 'selected' : '';
            return `<option value="${p.id}" ${selected}>${label}</option>`;
        }).join('');
        document.getElementById('aiPresetDelBtn').style.display = this._presets.length > 1 ? '' : 'none';
    },

    // ============================================================
    // 渲染当前预设到表单
    // ============================================================
    renderActivePreset() {
        const p = this._presets.find(p => p.id === this._currentPresetId);
        if (!p) return;
        document.getElementById('aiAgentName').value = p.name || '昔涟';
        document.getElementById('aiAgentAvatar').value = p.avatar || '';
        document.getElementById('aiSystemPrompt').value = p.systemPrompt || '';
        document.getElementById('aiTemperature').value = p.temperature ?? 1.0;
        document.getElementById('aiTemperatureValue').textContent = p.temperature ?? 1.0;
        document.getElementById('aiContextRounds').value = p.contextRounds ?? 10;
        document.getElementById('aiContextRoundsValue').textContent = p.contextRounds ?? 10;
        document.getElementById('aiStreamEnabled').checked = p.streamEnabled !== false;
    },

    // ============================================================
    // 渲染用户设置
    // ============================================================
    renderUserForm() {
        document.getElementById('aiUserName').value = this._config.aiUserName || '我';
        document.getElementById('aiUserAvatar').value = this._config.aiUserAvatar || '';
    },

    // 渲染 API 配置字段（不依赖预设）
    renderAPIConfig() {
        const s = (id, val) => { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = !!val; else el.value = val || ''; } };
        const c = this._config;
        s('aiProvider', c.aiProvider); s('aiApiKey', c.aiApiKey); s('aiBaseUrl', c.aiBaseUrl);
        s('aiModel', c.aiModel);
        s('aiDeleteConfirmEnabled', c.aiDeleteConfirmEnabled);
        s('aiOperationLogEnabled', c.aiOperationLogEnabled);
        // ★ P2-1: 渲染 maxToolRounds 配置
        const maxRoundsEl = document.getElementById('aiMaxToolRounds');
        const maxRoundsVal = document.getElementById('aiMaxToolRoundsValue');
        if (maxRoundsEl) maxRoundsEl.value = c.aiMaxToolRounds || 30;
        if (maxRoundsVal) maxRoundsVal.textContent = c.aiMaxToolRounds || 30;
    },

    // ============================================================
    // 当前预设内容保存到 _presets
    // ============================================================
    _syncFormToPreset() {
        const p = this._presets.find(p => p.id === this._currentPresetId);
        if (!p) return;
        p.name = document.getElementById('aiAgentName').value.trim() || '昔涟';
        p.avatar = document.getElementById('aiAgentAvatar').value.trim();
        p.systemPrompt = document.getElementById('aiSystemPrompt').value;
        p.temperature = parseFloat(document.getElementById('aiTemperature').value);
        p.contextRounds = parseInt(document.getElementById('aiContextRounds').value);
        p.streamEnabled = document.getElementById('aiStreamEnabled').checked;
    },

    // ============================================================
    // 切换预设
    // ============================================================
    async switchPreset(presetId) {
        if (presetId === this._currentPresetId) return;
        // 保存当前预设
        this._syncFormToPreset();
        this._currentPresetId = presetId;
        this.renderActivePreset();
        await this.saveSettings();
        this._syncGlobals();
        this.updateChatHeader();
        // MC 星图：设置面板切换预设即切换私聊智能体 → AI 主星名跟随
        if (typeof mcUpdateAiStarName === 'function') mcUpdateAiStarName(presetId);
        // ★ 通知聊天管理器：私聊模式下需要切换到新预设的聊天记录
        if (typeof window._onPresetSwitched === 'function') {
            window._onPresetSwitched(presetId);
        }
    },

    // ============================================================
    // 新增预设（基于当前表单值，自动保存）
    // ============================================================
    async addPreset() {
        const name = (document.getElementById('aiAgentName').value.trim() || '新预设') + ' (副本)';
        const newPreset = {
            id: 'preset_' + uuidv4(),
            name: name,
            avatar: document.getElementById('aiAgentAvatar').value.trim(),
            systemPrompt: document.getElementById('aiSystemPrompt').value,
            temperature: parseFloat(document.getElementById('aiTemperature').value),
            contextRounds: parseInt(document.getElementById('aiContextRounds').value),
            streamEnabled: document.getElementById('aiStreamEnabled').checked
        };
        this._presets.push(newPreset);
        this._currentPresetId = newPreset.id;
        this.renderPresetSelect();
        await this.saveSettings();
        this._syncGlobals();
        this.updateChatHeader();
    },

    // ============================================================
    // 删除当前预设
    // ============================================================
    async deletePreset() {
        if (this._presets.length <= 1) return;
        
        // 检测同名重复预设：如果存在多个同名预设，提示用户一并删除
        const targetPreset = this._presets.find(p => p.id === this._currentPresetId);
        const targetName = targetPreset?.name?.trim().toLowerCase();
        let dupCount = 0;
        if (targetName) {
            dupCount = this._presets.filter(p => 
                p.id !== this._currentPresetId && (p.name || '').trim().toLowerCase() === targetName
            ).length;
        }
        
        let confirmMsg = '确定删除当前预设？';
        if (dupCount > 0) {
            confirmMsg = `检测到还有 ${dupCount} 个同名预设「${targetPreset.name}」\n\n（可能是同步产生的重复副本）\n\n是否一并删除全部同名预设？`;
        }
        if (!confirm(confirmMsg)) return;
        
        // 删除当前预设 + 同名重复预设
        this._presets = this._presets.filter(p => {
            if (p.id === this._currentPresetId) return false;
            if (dupCount > 0 && (p.name || '').trim().toLowerCase() === targetName) return false;
            return true;
        });
        
        // 保持当前位置（不跳转），如果当前预设被删则回退到第一个
        if (!this._presets.some(p => p.id === this._currentPresetId)) {
            this._currentPresetId = this._presets[0]?.id || '';
        }
        
        this.renderPresetSelect();
        this.renderActivePreset();
        await this.saveSettings();
        this._syncGlobals();
        this.updateChatHeader();
    },

    // ============================================================
    // 头像URL
    // ============================================================
    _bgDir: null,
    async _getBgDir() {
        if (this._bgDir) return this._bgDir;
        const { ipcRenderer } = require('electron');
        this._bgDir = await ipcRenderer.invoke('get-bg-dir');
        return this._bgDir;
    },
    getAvatarUrl(filename) {
        if (!filename) return '';
        // 支持 base64 data URL（云同步头像）
        if (typeof filename === 'string' && filename.startsWith('data:')) {
            return filename;
        }
        if (!this._bgDir) return '';
        return 'file:///' + this._bgDir.replace(/\\/g, '/') + '/' + encodeURI(filename);
    },
    getAgentAvatarUrl() {
        const p = this._presets.find(p => p.id === this._currentPresetId);
        return this.getAvatarUrl(p?.avatar || '搜图神器_1780030825128.gif');
    },
    getUserAvatarUrl() {
        return this.getAvatarUrl(this._config.aiUserAvatar || '');
    },

    // ============================================================
    // 聊天头部
    // ============================================================
    updateChatHeader() {
        const p = this._presets.find(p => p.id === this._currentPresetId);
        const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || ''; };
        const setImg = (id, url) => { const el = document.getElementById(id); if (el) { el.src = url || ''; el.style.display = url ? '' : 'none'; } };
        setEl('xilianHeaderAgentName', p?.name || '昔涟');
        setEl('xilianHeaderUserName', this._config.aiUserName || '我');
        setImg('xilianHeaderAgentAvatar', this.getAgentAvatarUrl());
        setImg('xilianHeaderUserAvatar', this.getUserAvatarUrl());
        
        // 如果在私聊模式（非聊天室），同步更新新版头部布局
        // ★ 启动初期 chatRoomManager 可能未初始化，此时默认按私聊处理
        const isRoomMode = window._chatRoomManager && window._chatRoomManager.isRoomMode;
        if (!isRoomMode && typeof XilianUI !== 'undefined' && XilianUI.updateHeaderForPrivate) {
            XilianUI.updateHeaderForPrivate(
                p?.name || 'Elysia',
                this.getAgentAvatarUrl()
            );
        }
    },

    // ============================================================
    // 获取激活预设的配置（给 AI 引擎用）
    // ============================================================
    getActivePresetConfig() {
        const base = this.collectFromForm();
        const p = this._presets.find(p => p.id === this._currentPresetId);
        if (p) {
            return {
                ...base,
                agentName: p.name || base.aiAgentName,
                systemPrompt: p.systemPrompt || '',
                temperature: p.temperature ?? base.aiTemperature,
                contextRounds: p.contextRounds ?? base.aiContextRounds,
                streamEnabled: p.streamEnabled !== undefined ? p.streamEnabled : base.aiStreamEnabled,
                maxToolRounds: base.aiMaxToolRounds || 30,  // ★ P2-1: 传递可配置的 maxToolRounds
            };
        }
        return { ...base, maxToolRounds: base.aiMaxToolRounds || 30 };
    },

    // ============================================================
    // 收集表单
    // ============================================================
    collectFromForm() {
        const g = (id, dv) => { const e = document.getElementById(id); if (!e) return dv; if (e.type === 'checkbox') return e.checked; if (e.type === 'range') return e.step === '0.1' ? parseFloat(e.value) : parseInt(e.value); return e.value; };
        return {
            aiProvider: g('aiProvider', 'deepseek'), aiApiKey: g('aiApiKey', ''),
            aiBaseUrl: g('aiBaseUrl', 'https://api.deepseek.com'), aiModel: g('aiModel', 'deepseek-v4-flash'),
            aiAgentName: g('aiAgentName', '昔涟'), aiSystemPrompt: g('aiSystemPrompt', ''),
            aiContextRounds: g('aiContextRounds', 10), aiTemperature: g('aiTemperature', 1.0),
            aiStreamEnabled: g('aiStreamEnabled', true), aiDeleteConfirmEnabled: g('aiDeleteConfirmEnabled', true),
            aiOperationLogEnabled: g('aiOperationLogEnabled', false),
            aiMaxToolRounds: g('aiMaxToolRounds', 30),  // ★ P2-1: 最大工具调用轮数（5-100，默认30）
            aiUserName: g('aiUserName', '我'), aiUserAvatar: g('aiUserAvatar', ''),
            aiAgentAvatar: g('aiAgentAvatar', '搜图神器_1780030825128.gif'),
        };
    },

    getConfig() { return document.getElementById('aiApiKey') ? this.collectFromForm() : this._config; },

    // ============================================================
    // 保存
    // ============================================================
    async saveSettings() {
        try {
            const { ipcRenderer } = require('electron');
            const settings = await ipcRenderer.invoke('get-settings');
            const aiConfig = this.collectFromForm();
            this._syncFormToPreset();
            // 保护敏感字段：表单为空时保留旧值
            if (!aiConfig.aiApiKey && settings.aiApiKey) {
                aiConfig.aiApiKey = settings.aiApiKey;
            }
            // 显式构造，避免 spread 顺序导致字段被意外覆盖
            const newSettings = { ...settings, ...aiConfig };
            newSettings.aiPresets = JSON.parse(JSON.stringify(this._presets));
            newSettings.aiCurrentPresetId = this._currentPresetId;
            await ipcRenderer.invoke('save-settings', newSettings);
            this._config = { ...this._config, ...aiConfig };
            this.updateChatHeader();
            // 可选增强：保存"用户名称"时同步刷新星图用户主星名，使改完名立即进星图无需先发消息
            if (typeof window !== 'undefined' && window.MEMORY_UI_CONFIG) {
                const uName = (this._config && this._config.aiUserName) || '我';
                if (!window.MEMORY_UI_CONFIG.user) {
                    window.MEMORY_UI_CONFIG.user = { name: uName, color: '#e8b96d' };
                } else {
                    window.MEMORY_UI_CONFIG.user.name = uName;
                }
                // 同步后端 memory_config.json，避免前后端核心实体名不一致
                try {
                    const { ipcRenderer } = require('electron');
                    ipcRenderer.invoke('mc:set-user-name', { name: uName, color: '#e8b96d' }).catch(() => {});
                } catch (_) { /* ignore */ }
            }
            return { success: true };
        } catch (e) { console.error('[昔涟] 保存失败:', e); return { success: false }; }
    },

    // 静默保存（用于首次初始化，不触发UI更新）
    async saveSettingsSilent() {
        try {
            const { ipcRenderer } = require('electron');
            const settings = await ipcRenderer.invoke('get-settings');
            const newSettings = { ...settings };
            newSettings.aiPresets = JSON.parse(JSON.stringify(this._presets));
            newSettings.aiCurrentPresetId = this._currentPresetId;
            await ipcRenderer.invoke('save-settings', newSettings);
            this._syncGlobals();
        } catch (e) { console.error('[昔涟] 静默保存失败:', e); }
    },

    _syncGlobals() {
        window.__xilianPresets = this._presets;
        window.__xilianCurrentPresetId = this._currentPresetId;
    },

    // ============================================================
    // 事件
    // ============================================================
    bindEvents() {
        // ★ 防止重复绑定（init() 可能被调用多次：onDOMReady + setupXilianEvents）
        if (this._eventsBound) return;
        this._eventsBound = true;

        ['aiContextRounds', 'aiTemperature', 'aiMaxToolRounds'].forEach(id => {
            const el = document.getElementById(id);
            const ve = document.getElementById(id + 'Value');
            if (el && ve) el.addEventListener('input', () => { ve.textContent = el.value; });
        });
        document.getElementById('toggleAiKeyBtn')?.addEventListener('click', () => {
            const inp = document.getElementById('aiApiKey');
            if (inp) { const pw = inp.type === 'password'; inp.type = pw ? 'text' : 'password'; document.getElementById('toggleAiKeyBtn').textContent = pw ? '🙈' : '👁'; }
        });
        // 预设切换
        document.getElementById('aiPresetSelect')?.addEventListener('change', (e) => this.switchPreset(e.target.value));
        document.getElementById('aiPresetNewBtn')?.addEventListener('click', () => this.addPreset());
        document.getElementById('aiPresetDelBtn')?.addEventListener('click', () => this.deletePreset());
        // 头像文件选择
        this._setupAvatarPicker('selectAgentAvatarBtn', 'aiAgentAvatarFile', 'aiAgentAvatar');
        this._setupAvatarPicker('selectUserAvatarBtn', 'aiUserAvatarFile', 'aiUserAvatar');
        // 全局保存回调
        window._xilianSaveCallback = async () => await this.saveSettings();
    },

    _setupAvatarPicker(btnId, fileInputId, targetInputId) {
        const btn = document.getElementById(btnId);
        const fileInput = document.getElementById(fileInputId);
        const targetInput = document.getElementById(targetInputId);
        if (!btn || !fileInput || !targetInput) return;
        btn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this._processAvatarImage(file, (dataUrl) => {
                targetInput.value = dataUrl;
                fileInput.value = '';
            });
        });
    },

    _processAvatarImage(file, callback) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const maxSize = 200;
                let { width, height } = img;
                if (width > height) {
                    if (width > maxSize) { height = Math.round(height * maxSize / width); width = maxSize; }
                } else {
                    if (height > maxSize) { width = Math.round(width * maxSize / height); height = maxSize; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                callback(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    },

    async onPanelActivated() { await this.loadConfig(); },
    _esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
};
