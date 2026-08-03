/**
 * xilian-ui.js — 昔涟聊天 UI 渲染（渲染进程）
 * 负责 DOM 操作、消息渲染、交互
 */

const XilianUI = {
    // ============================================================
    // 流式更新节流（性能优化）
    // ============================================================
    _pendingUpdate: null,    // RAF 句柄
    _pendingMsgId: null,     // 待更新的消息ID
    _pendingContent: null,    // 待更新的内容
    _pendingScroll: false,    // 是否有待执行的滚动
    _lastRenderedContent: {},  // 每个消息已渲染的内容缓存（避免重复innerHTML）

    /**
     * 调度流式内容更新（RAF节流，合并高频调用）
     */
    _scheduleUpdate(msgId, content) {
        this._pendingMsgId = msgId;
        this._pendingContent = content;
        this._pendingScroll = true;
        if (this._pendingUpdate) return; // 已有RAF等待，直接返回
        this._pendingUpdate = requestAnimationFrame(() => {
            this._pendingUpdate = null;
            this._flushUpdate();
        });
    },

    /**
     * 执行被节流的 DOM 更新
     */
    _flushUpdate() {
        const { _pendingMsgId, _pendingContent } = this;
        if (!_pendingMsgId || _pendingContent === undefined) return;

        const msgEl = document.querySelector(`[data-msg-id="${_pendingMsgId}"]`);
        if (msgEl) {
            const contentEl = msgEl.querySelector('.xilian-message-content');
            if (contentEl) {
                // 只有内容真正变化时才写 innerHTML
                const cacheKey = _pendingMsgId;
                if (this._lastRenderedContent[cacheKey] !== _pendingContent) {
                    contentEl.innerHTML = this.formatContent(_pendingContent);
                    this._lastRenderedContent[cacheKey] = _pendingContent;
                }
                contentEl.classList.add('xilian-cursor');
            }
        }

        if (this._pendingScroll) {
            this._pendingScroll = false;
            this.scrollToBottom();
        }

        this._pendingMsgId = null;
        this._pendingContent = null;
    },

    // ============================================================
    // 智能体头像（GIF动图）
    // ============================================================
    
    getAvatarHtml(size) {
        const s = size || 32;
        const url = XilianSettings.getAgentAvatarUrl();
        return url ? `<img src="${url}" class="xilian-avatar-img" width="${s}" height="${s}" alt="">` : '💜';
    },
    getUserAvatarHtml(size) {
        const s = size || 32;
        const url = XilianSettings.getUserAvatarUrl();
        return url ? `<img src="${url}" class="xilian-avatar-img" width="${s}" height="${s}" alt="">` : '👤';
    },
    
    getUserName() {
        return (XilianSettings._config && XilianSettings._config.aiUserName) || '我';
    },
    getAgentName() {
        if (!XilianSettings._presets) return '昔涟';
        const p = XilianSettings._presets.find(p => p.id === XilianSettings._currentPresetId);
        return (p && p.name) || '昔涟';
    },

    // ============================================================
    // 消息渲染
    // ============================================================

    /**
     * 渲染所有消息
     */
    renderMessages(messages) {
        const container = document.getElementById('xilianMessages');
        if (!container) return;

        // 清除除欢迎页面外的内容
        const welcome = container.querySelector('.xilian-welcome');
        container.innerHTML = '';
        if (messages.length === 0 && welcome) {
            container.appendChild(welcome);
            return;
        }

        for (const msg of messages) {
            if (msg.role === 'tool') continue; // 工具消息不在聊天区显示
            this.appendMessage(msg, false);
        }
    },

    /**
     * 格式化消息时间（聊天气泡下方显示）
     * 今天：HH:mm；今年：M月D日 HH:mm；更早：YYYY年M月D日 HH:mm
     */
    formatMsgTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const sameDay = d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
        if (sameDay) return hm;
        if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    },

    /**
     * 追加一条消息
     */
    appendMessage(msg, skipScroll = false) {
        const container = document.getElementById('xilianMessages');
        if (!container) return null;

        const msgEl = document.createElement('div');
        msgEl.className = `xilian-message ${msg.role}`;
        msgEl.setAttribute('data-msg-id', msg.id);

        if (msg.role === 'user') {
            msgEl.innerHTML = `
                <div class="xilian-message-avatar">${this.getUserAvatarHtml(44)}</div>
                <div class="xilian-message-main">
                    <div class="xilian-message-name">${this.getUserName()}</div>
                    <div class="xilian-message-bubble">
                        <div class="xilian-message-content">${this.escapeHtml(msg.content)}</div>
                    </div>
                    <div class="xilian-message-actions">
                        <div class="xilian-message-action-buttons">
                            <button class="xilian-msg-action" data-action="copy" title="复制">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                            </button>
                            <button class="xilian-msg-action" data-action="delete" title="删除">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                        </div>
                        <span class="xilian-message-time">${this.formatMsgTime(msg.timestamp)}</span>
                    </div>
                </div>
            `;
        } else if (msg.role === 'assistant') {
            msgEl.innerHTML = `
                <div class="xilian-message-avatar">${this.getAvatarHtml(44)}</div>
                <div class="xilian-message-main">
                    <div class="xilian-message-name">${this.getAgentName()}</div>
                    <div class="xilian-message-bubble">
                        <div class="xilian-message-content">${this.formatContent(msg.content)}</div>
                        <!-- 内嵌工具执行进度面板（历史记录重建，默认折叠） -->
                        <div class="xilian-tool-progress-panel" id="toolProgress_${msg.id}" style="display:none;" data-collapsed="true">
                            <div class="xilian-tool-progress-header" onclick="XilianUI._toggleToolProgressPanel('${msg.id}')" style="cursor:pointer; user-select:none;">
                                <span class="xilian-tool-progress-title">🔧 工具操作</span>
                                <span class="xilian-tool-progress-round"></span>
                                <span class="xilian-tool-progress-toggle">▶</span>
                            </div>
                            <div class="xilian-tool-progress-steps"></div>
                        </div>
                    </div>
                    <div class="xilian-message-actions">
                        <span class="xilian-message-time">${this.formatMsgTime(msg.timestamp)}</span>
                        <div class="xilian-message-action-buttons">
                            <button class="xilian-msg-action" data-action="copy" title="复制">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                            </button>
                            <button class="xilian-msg-action" data-action="delete" title="删除">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        } else if (msg.role === 'system') {
            msgEl.innerHTML = `
                <div class="xilian-message-bubble">
                    <div class="xilian-message-content">${msg.content}</div>
                </div>
            `;
        }

        container.appendChild(msgEl);

        // ★ 关键修复：先 appendChild 到 DOM，restore 里的 getElementById 才能找到 panel
        // 同时把消息对象上的折叠状态保留下来（用户上次是展开还是收起）
        if (msg.role === 'assistant' && msg.toolEvents && msg.toolEvents.length > 0) {
            this.restoreToolProgressFromEvents(msg.id, msg.toolEvents, msg.toolProgressCollapsed);
        }

        if (!skipScroll) this.scrollToBottom();
        return msgEl;
    },

    /**
     * 追加助手占位消息（流式输出用）
     * ★ 包含内嵌工具进度面板容器
     */
    appendAssistantPlaceholder(msgId) {
        const container = document.getElementById('xilianMessages');
        if (!container) return null;

        const msgEl = document.createElement('div');
        msgEl.className = 'xilian-message assistant';
        msgEl.setAttribute('data-msg-id', msgId);
        msgEl.innerHTML = `
            <div class="xilian-message-avatar">${this.getAvatarHtml(44)}</div>
            <div class="xilian-message-main">
                <div class="xilian-message-bubble">
                    <div class="xilian-message-content xilian-cursor"></div>
                    <!-- 内嵌工具执行进度面板（默认隐藏，完成后折叠保留） -->
                    <div class="xilian-tool-progress-panel" id="toolProgress_${msgId}" style="display:none;" data-collapsed="false">
                        <div class="xilian-tool-progress-header" onclick="XilianUI._toggleToolProgressPanel('${msgId}')" style="cursor:pointer; user-select:none;">
                            <span class="xilian-tool-progress-title">🔧 正在执行操作</span>
                            <span class="xilian-tool-progress-round"></span>
                            <span class="xilian-tool-progress-toggle">▼</span>
                        </div>
                        <div class="xilian-tool-progress-steps"></div>
                    </div>
                </div>
                <div class="xilian-message-actions">
                    <span class="xilian-message-time">${this.formatMsgTime(Date.now())}</span>
                    <div class="xilian-message-action-buttons">
                        <button class="xilian-msg-action" data-action="copy" title="复制">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                        </button>
                        <button class="xilian-msg-action" data-action="delete" title="删除">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(msgEl);
        this.scrollToBottom();
        return msgEl;
    },

    /**
     * 更新助手消息内容（流式追加）
     * ★ 改为RAF节流，避免每个token都触发DOM写入
     */
    updateAssistantContent(msgId, content) {
        this._scheduleUpdate(msgId, content);
    },

    /**
     * 完成助手消息（移除光标）
     * ★ 先强制执行一次flush，确保最终内容已渲染
     */
    finalizeAssistantContent(msgId) {
        // 强制执行待处理的更新，确保最终内容已写入DOM
        if (this._pendingMsgId === msgId || this._pendingUpdate) {
            cancelAnimationFrame(this._pendingUpdate);
            this._pendingUpdate = null;
            this._flushUpdate();
        }
        const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgEl) {
            const contentEl = msgEl.querySelector('.xilian-message-content');
            if (contentEl) {
                contentEl.classList.remove('xilian-cursor');
                // 最终渲染后清除该消息的内容缓存
                delete this._lastRenderedContent[msgId];
            }
        }
    },

    // ============================================================
    // 工具调用卡片
    // ============================================================

    appendToolCard({ name, status, args }) {
        const container = document.getElementById('xilianMessages');
        if (!container) return;

        const icons = { running: '⏳', done: '✅', error: '❌' };
        const labels = { running: '执行中', done: '已完成', error: '失败' };
        const displayName = this.getToolDisplayName(name);
        const argsText = args ? this._formatToolArgs(name, args) : '';
        const cardId = 'tool-card-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

        const cardEl = document.createElement('div');
        cardEl.className = 'xilian-tool-card';
        cardEl.id = cardId;
        cardEl.setAttribute('data-tool-status', status);
        cardEl.setAttribute('data-tool-name', name);
        // 运行中默认展开，完成后默认折叠
        cardEl.setAttribute('data-expanded', status === 'running' ? 'true' : 'false');
        cardEl.innerHTML = `
            <div class="xilian-tool-card-header">
                <span class="xilian-tool-card-icon">${icons[status] || '🔧'}</span>
                <span class="xilian-tool-card-name">${displayName}</span>
                <span class="xilian-tool-card-status">${labels[status] || status}</span>
                <span class="xilian-tool-card-toggle">${status === 'running' ? '▼' : '▶'}</span>
            </div>
            <div class="xilian-tool-card-body">
                ${argsText ? `<div class="xilian-tool-card-section"><span class="xilian-tool-card-label">参数</span><pre class="xilian-tool-card-args">${this.escapeHtml(argsText)}</pre></div>` : ''}
                <div class="xilian-tool-card-section xilian-tool-card-result-section" style="display:none;">
                    <span class="xilian-tool-card-label">结果</span>
                    <pre class="xilian-tool-card-result"></pre>
                </div>
            </div>
        `;

        // 点击头部切换展开/折叠
        const header = cardEl.querySelector('.xilian-tool-card-header');
        header.addEventListener('click', () => this._toggleToolCard(cardId));

        container.appendChild(cardEl);
        this.scrollToBottom();
    },

    _toggleToolCard(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;
        const expanded = card.getAttribute('data-expanded') === 'true';
        card.setAttribute('data-expanded', expanded ? 'false' : 'true');
        const toggle = card.querySelector('.xilian-tool-card-toggle');
        if (toggle) toggle.textContent = expanded ? '▶' : '▼';
    },

    _formatToolArgs(name, args) {
        try {
            if (!args || typeof args !== 'object') return String(args || '');
            // 对日志、备忘录等内容型参数做友好展示
            if (args.content && typeof args.content === 'string') {
                return args.content.length > 120 ? args.content.slice(0, 120) + '...' : args.content;
            }
            if (args.title && typeof args.title === 'string') {
                return args.title;
            }
            if (args.description && typeof args.description === 'string') {
                return args.description;
            }
            return JSON.stringify(args, null, 2);
        } catch (e) {
            return String(args || '');
        }
    },

    updateLastToolCard({ name, status, message, args }) {
        const cards = document.querySelectorAll('.xilian-tool-card[data-tool-status="running"]');
        const card = cards[cards.length - 1];
        if (!card) {
            // 如果没有运行中的卡片，可能是延迟到达的结果，追加一张已完成的卡片
            this.appendToolCard({ name, status, args });
            const newCards = document.querySelectorAll('.xilian-tool-card');
            this._finalizeToolCard(newCards[newCards.length - 1], status, message);
            return;
        }

        this._finalizeToolCard(card, status, message);
    },

    _finalizeToolCard(card, status, message) {
        const icons = { done: '✅', error: '❌' };
        const labels = { done: '已完成', error: '失败' };
        card.setAttribute('data-tool-status', status);
        card.setAttribute('data-expanded', 'false');

        const iconEl = card.querySelector('.xilian-tool-card-icon');
        if (iconEl) iconEl.textContent = icons[status] || '🔧';

        const statusEl = card.querySelector('.xilian-tool-card-status');
        if (statusEl) statusEl.textContent = labels[status] || status;

        const toggleEl = card.querySelector('.xilian-tool-card-toggle');
        if (toggleEl) toggleEl.textContent = '▶';

        const resultSection = card.querySelector('.xilian-tool-card-result-section');
        const resultEl = card.querySelector('.xilian-tool-card-result');
        if (message && resultEl) {
            resultEl.textContent = message;
            if (resultSection) resultSection.style.display = '';
        }

        // 不再自动移除，永久保留在聊天记录中
    },

    hideToolCards() {
        // 把所有仍在 running 状态的卡片标记为 done（兜底）
        const cards = document.querySelectorAll('.xilian-tool-card[data-tool-status="running"]');
        cards.forEach(card => {
            this._finalizeToolCard(card, 'done', '流式响应结束');
        });
    },

    // ============================================================
    // ★ 内嵌工具执行进度面板（助手消息气泡内）
    // ============================================================

    /**
     * 显示工具进度面板（嵌入当前助手消息气泡内部）
     * @param {string} msgId - 当前助手消息ID
     * @param {string} toolName - 工具名称（英文key）
     * @param {string} status - 'running' | 'done' | 'error'
     * @param {object} opts - { stepIndex?, totalSteps?, message?, arguments?, toolCallId? }
     */
    showToolProgress(msgId, toolName, status, opts = {}) {
        const panel = document.getElementById(`toolProgress_${msgId}`);
        if (!panel) return;

        const displayName = this.getToolDisplayName(toolName);
        const stepsContainer = panel.querySelector('.xilian-tool-progress-steps');
        const roundEl = panel.querySelector('.xilian-tool-progress-round');
        const titleEl = panel.querySelector('.xilian-tool-progress-title');

        // 显示面板
        panel.style.display = '';
        panel.style.opacity = '';
        panel.style.transition = '';

        // 更新轮次信息
        if (opts.totalSteps && opts.stepIndex !== undefined) {
            roundEl.textContent = `${opts.stepIndex + 1}/${opts.totalSteps}`;
        }

        if (status === 'running') {
            titleEl.textContent = `🔧 正在调用 ${displayName}`;
            titleEl.className = 'xilian-tool-progress-title running';
            // 运行中默认展开
            panel.setAttribute('data-collapsed', 'false');

            // 创建/更新步骤条目
            let stepEl = stepsContainer.querySelector(`[data-tool-name="${toolName}"]`);
            if (!stepEl) {
                stepEl = document.createElement('div');
                stepEl.className = 'xilian-tool-step';
                stepEl.setAttribute('data-tool-name', toolName);
                stepEl.setAttribute('data-tool-call-id', opts.toolCallId || toolName);
                stepEl.innerHTML = `
                    <span class="xilian-tool-step-icon">⏳</span>
                    <span class="xilian-tool-step-info">
                        <span class="xilian-tool-step-name">${displayName}</span>
                        <span class="xilian-tool-step-args"></span>
                    </span>
                `;
                stepsContainer.appendChild(stepEl);
            } else {
                stepEl.querySelector('.xilian-tool-step-icon').textContent = '⏳';
                stepEl.className = 'xilian-tool-step running';
            }

            // 显示参数摘要
            const argsEl = stepEl.querySelector('.xilian-tool-step-args');
            if (opts.arguments && typeof opts.arguments === 'object') {
                const argsText = Object.entries(opts.arguments)
                    .filter(([k]) => !['userId', '_internal'].includes(k))
                    .slice(0, 3)
                    .map(([k, v]) => `${k}: ${typeof v === 'string' ? (v.length > 20 ? v.slice(0,20)+'…' : v) : JSON.stringify(v).slice(0,30)}`)
                    .join(' | ');
                argsEl.textContent = argsText;
            }
        } else {
            // done 或 error — 更新对应步骤的状态
            const stepEl = stepsContainer.querySelector(`[data-tool-name="${toolName}"]`);
            if (stepEl) {
                const iconEl = stepEl.querySelector('.xilian-tool-step-icon');
                if (status === 'done') {
                    iconEl.textContent = '✅';
                    stepEl.className = 'xilian-tool-step done';
                    titleEl.textContent = `✅ 操作完成`;
                    titleEl.className = 'xilian-tool-progress-title';

                    // 显示结果摘要（持久化在步骤里，不再清空）
                    if (opts.message) {
                        // 避免重复添加结果元素
                        let resultEl = stepEl.querySelector('.xilian-tool-step-result');
                        if (!resultEl) {
                            resultEl = document.createElement('div');
                            resultEl.className = 'xilian-tool-step-result';
                            stepEl.appendChild(resultEl);
                        }
                        resultEl.textContent = opts.message.length > 80 ? opts.message.slice(0, 80) + '…' : opts.message;
                    }
                } else {
                    iconEl.textContent = '❌';
                    stepEl.className = 'xilian-tool-step error';
                    titleEl.textContent = `❌ 操作失败`;
                    titleEl.className = 'xilian-tool-progress-title';
                    if (opts.message) {
                        let resultEl = stepEl.querySelector('.xilian-tool-step-result');
                        if (!resultEl) {
                            resultEl = document.createElement('div');
                            resultEl.className = 'xilian-tool-step-result error';
                            stepEl.appendChild(resultEl);
                        }
                        resultEl.textContent = opts.message.length > 80 ? opts.message.slice(0, 80) + '…' : opts.message;
                    }
                }
            }

            // ★ 关键修复：所有步骤完成后，折叠面板而非隐藏+清空
            const runningSteps = stepsContainer.querySelectorAll('.xilian-tool-step.running');
            if (runningSteps.length === 0) {
                // 短暂延迟让用户看到完成状态，然后折叠
                setTimeout(() => {
                    panel.setAttribute('data-collapsed', 'true');
                    titleEl.textContent = `✅ 已完成 ${stepsContainer.children.length} 项操作`;
                }, 1200);
            }
        }

        this.scrollToBottom();
    },

    /**
     * 设置工具进度的总轮次（多轮工具调用时显示 "第2/3轮"）
     */
    setToolProgressRound(msgId, current, total) {
        const panel = document.getElementById(`toolProgress_${msgId}`);
        if (!panel) return;
        const roundEl = panel.querySelector('.xilian-tool-progress-round');
        if (roundEl) {
            roundEl.textContent = total > 1 ? `第${current}/${total}轮` : '';
        }
    },

    /**
     * 隐藏工具进度面板（停止/出错时调用）
     */
    hideToolProgress(msgId) {
        const panel = document.getElementById(`toolProgress_${msgId}`);
        if (panel) {
            panel.style.display = 'none';
            const stepsContainer = panel.querySelector('.xilian-tool-progress-steps');
            if (stepsContainer) stepsContainer.innerHTML = '';
        }
    },

    /**
     * ★ 切换工具进度面板的折叠/展开状态（点击标题栏触发）
     */
    _toggleToolProgressPanel(msgId) {
        const panel = document.getElementById(`toolProgress_${msgId}`);
        if (!panel) return;
        const collapsed = panel.getAttribute('data-collapsed') === 'true';
        panel.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
        const toggle = panel.querySelector('.xilian-tool-progress-toggle');
        if (toggle) toggle.textContent = collapsed ? '▼' : '▶';
        // ★ 通知管理器：把折叠状态持久化到消息对象并保存历史
        try {
            window.dispatchEvent(new CustomEvent('xilian-tool-progress-toggled', {
                detail: { msgId, collapsed: !collapsed }
            }));
        } catch (e) {}
    },

    /**
     * ★ 从持久化的 toolEvents 数组重建工具进度面板（历史渲染时用）
     * @param {string} msgId - 消息ID
     * @param {Array} toolEvents - [{ name, args, status, result, toolCallId }]
     */
    restoreToolProgressFromEvents(msgId, toolEvents, collapsed = true) {
        if (!toolEvents || toolEvents.length === 0) return;
        const panel = document.getElementById(`toolProgress_${msgId}`);
        if (!panel) return;

        const stepsContainer = panel.querySelector('.xilian-tool-progress-steps');
        const titleEl = panel.querySelector('.xilian-tool-progress-title');
        const roundEl = panel.querySelector('.xilian-tool-progress-round');

        // 清空可能存在的旧步骤
        stepsContainer.innerHTML = '';

        const icons = { running: '⏳', done: '✅', error: '❌' };
        const hasError = toolEvents.some(e => e.status === 'error');
        const allDone = toolEvents.every(e => e.status === 'done');

        for (const ev of toolEvents) {
            const displayName = this.getToolDisplayName(ev.name);
            const stepEl = document.createElement('div');
            stepEl.className = `xilian-tool-step ${ev.status}`;
            stepEl.setAttribute('data-tool-name', ev.name);
            stepEl.setAttribute('data-tool-call-id', ev.toolCallId || ev.name);
            stepEl.innerHTML = `
                <span class="xilian-tool-step-icon">${icons[ev.status] || '🔧'}</span>
                <span class="xilian-tool-step-info">
                    <span class="xilian-tool-step-name">${displayName}</span>
                    <span class="xilian-tool-step-args"></span>
                </span>
            `;
            // 参数摘要
            const argsEl = stepEl.querySelector('.xilian-tool-step-args');
            if (ev.args && typeof ev.args === 'object') {
                const argsText = Object.entries(ev.args)
                    .filter(([k]) => !['userId', '_internal'].includes(k))
                    .slice(0, 3)
                    .map(([k, v]) => `${k}: ${typeof v === 'string' ? (v.length > 20 ? v.slice(0,20)+'…' : v) : JSON.stringify(v).slice(0,30)}`)
                    .join(' | ');
                argsEl.textContent = argsText;
            }
            // 结果摘要
            if (ev.result) {
                const resultEl = document.createElement('div');
                resultEl.className = `xilian-tool-step-result${ev.status === 'error' ? ' error' : ''}`;
                const msg = typeof ev.result === 'string' ? ev.result : (ev.result.message || JSON.stringify(ev.result));
                resultEl.textContent = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
                stepEl.appendChild(resultEl);
            }
            stepsContainer.appendChild(stepEl);
        }

        // 设置标题和折叠状态（历史记录默认折叠）
        if (allDone) {
            titleEl.textContent = `✅ 已完成 ${toolEvents.length} 项操作`;
            titleEl.className = 'xilian-tool-progress-title';
        } else if (hasError) {
            titleEl.textContent = `⚠️ 完成 ${toolEvents.length} 项操作（含失败）`;
            titleEl.className = 'xilian-tool-progress-title';
        } else {
            titleEl.textContent = `🔧 正在执行操作`;
            titleEl.className = 'xilian-tool-progress-title running';
        }
        roundEl.textContent = '';

        // 显示面板并按用户上次状态折叠/展开（默认折叠）
        panel.style.display = '';
        panel.style.opacity = '';
        const collapsedBool = !!collapsed;
        panel.setAttribute('data-collapsed', collapsedBool ? 'true' : 'false');
        const toggle = panel.querySelector('.xilian-tool-progress-toggle');
        if (toggle) toggle.textContent = collapsedBool ? '▶' : '▼';
    },

    // ============================================================
    // 系统消息
    // ============================================================

    appendSystemMessage(text) {
        const container = document.getElementById('xilianMessages');
        if (!container) return;

        const el = document.createElement('div');
        el.className = 'xilian-message system';
        el.innerHTML = `<div class="xilian-message-bubble">${this.escapeHtml(text)}</div>`;
        container.appendChild(el);
        this.scrollToBottom();
    },

    // ============================================================
    // UI 状态控制
    // ============================================================

    showToolStatus(show, text) {
        // 已禁用输入框下方的工具状态提示
        // 工具调用状态现在只通过聊天中的 .xilian-tool-card 展示
        return;

        // 保留原实现注释，便于后续恢复：
        // const statusEl = document.getElementById('xilianToolStatus');
        // const textEl = document.getElementById('xilianToolStatusText');
        // if (!statusEl) return;
        // statusEl.style.display = show ? 'flex' : 'none';
        // if (textEl && text) textEl.textContent = text;
    },

    setModelBadge(model) {
        const badge = document.getElementById('xilianModelBadge');
        if (badge) badge.textContent = model || 'deepseek-chat';
    },

    setInputEnabled(enabled) {
        const input = document.getElementById('xilianInput');
        const sendBtn = document.getElementById('xilianSendBtn');
        if (input) input.disabled = !enabled;
        if (sendBtn) sendBtn.disabled = !enabled;

        if (enabled) {
            this.focusInput();
        }
    },

    focusInput() {
        const input = document.getElementById('xilianInput');
        if (input && document.getElementById('xilianView')?.classList.contains('active')) {
            setTimeout(() => input.focus(), 100);
        }
    },

    hideWelcome() {
        const welcome = document.querySelector('.xilian-welcome');
        if (welcome && welcome.parentNode) {
            welcome.style.display = 'none';
        }
    },

    showWelcome() {
        const welcome = document.querySelector('.xilian-welcome');
        if (welcome) {
            welcome.style.display = '';
        }
    },

    scrollToBottom() {
        if (this._scrollRaf) return; // 已有待执行的RAF，直接返回（_flushUpdate里会统一执行）
        this._scrollRaf = requestAnimationFrame(() => {
            this._scrollRaf = null;
            const container = document.getElementById('xilianMessages');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        });
    },

    refreshOtherViews() {
        // 触发数据刷新（通过全局 appController）
        if (window._app && typeof window._app.loadAllData === 'function') {
            window._app.loadAllData();
        }
    },

    // ============================================================
    // 聊天室头部更新
    // ============================================================

    /**
     * 更新头部为私聊模式
     */
    updateHeaderForPrivate(agentName, agentAvatarUrl) {
        const headerTitle = document.getElementById('xilianHeaderTitle');
        if (headerTitle) headerTitle.textContent = 'Elysia Chat';

        const avatarsContainer = document.getElementById('xilianHeaderAvatars');
        if (avatarsContainer) {
            const userAvatarUrl = XilianSettings.getUserAvatarUrl();
            avatarsContainer.innerHTML = `
                <div class="avatar-stack">
                    <img src="${agentAvatarUrl || ''}" class="avatar-stack-item" alt="${agentName}" 
                         onerror="this.style.display='none'" style="width:28px;height:28px;">
                    <img src="${userAvatarUrl || ''}" class="avatar-stack-item" alt="我"
                         onerror="this.style.display='none'" style="width:28px;height:28px;margin-left:-6px;">
                </div>
            `;
        }

        // 更新 + 按钮下拉菜单
        this.updateHeaderDropdown();
    },

    /**
     * 更新头部为聊天室模式
     */
    updateHeaderForRoom(roomName, agentAvatars) {
        const headerTitle = document.getElementById('xilianHeaderTitle');
        if (headerTitle) headerTitle.textContent = roomName || '聊天室';

        const avatarsContainer = document.getElementById('xilianHeaderAvatars');
        if (avatarsContainer) {
            const userAvatarUrl = XilianSettings.getUserAvatarUrl();
            let avatarsHtml = agentAvatars.slice(0, 5).map(url =>
                `<img src="${url || ''}" class="avatar-stack-item" alt="" onerror="this.style.display='none'" style="width:28px;height:28px;">`
            ).join('');
            avatarsHtml += `<img src="${userAvatarUrl || ''}" class="avatar-stack-item" alt="我" onerror="this.style.display='none'" style="width:28px;height:28px;margin-left:-6px;">`;
            avatarsContainer.innerHTML = `<div class="avatar-stack">${avatarsHtml}</div>`;
        }

        this.updateHeaderDropdown();
    },

    /**
     * 更新@指定的智能体头部
     */
    updateHeaderForMentionedAgent(agentPresetId) {
        try {
            const presets = window.__xilianPresets || [];
            const preset = presets.find(p => p.id === agentPresetId);
            if (preset) {
                const avatarUrl = (typeof XilianSettings !== 'undefined')
                    ? XilianSettings.getAvatarUrl(preset.avatar) : '';
                this.updateHeaderForPrivate(preset.name, avatarUrl);
            }
        } catch (e) {}
    },

    /**
     * 更新头部+号下拉菜单
     */
    updateHeaderDropdown() {
        const dropdown = document.getElementById('xilianHeaderDropdown');
        const roomsContainer = document.getElementById('xilianDropdownRooms');
        if (!dropdown || !roomsContainer) return;

        // 聊天室列表
        let roomsHtml = '';
        try {
            const chatRoomManager = window._chatRoomManager;
            if (chatRoomManager) {
                const rooms = chatRoomManager.chatRooms || [];
                rooms.forEach(room => {
                    roomsHtml += `<div class="xilian-dropdown-subitem" data-action="switch-room" data-room-id="${room.id}">📢 ${this.escapeHtml(room.name)}</div>`;
                });
            }
        } catch (e) {
            console.error('[updateHeaderDropdown] 获取聊天室列表失败:', e);
        }
        if (!roomsHtml) {
            roomsHtml = '<div class="xilian-dropdown-subitem" style="color:var(--text-muted); font-size:11px; padding: 8px 16px;">请在设置中创建聊天室</div>';
        }
        roomsContainer.innerHTML = roomsHtml;
        // ★ 强制浏览器立即重排，避免菜单显示后内容空白
        dropdown.offsetHeight;
    },

    // ============================================================
    // @提及面板
    // ============================================================

    showMentionPanel(agents) {
        const panel = document.getElementById('xilianMentionPanel');
        const list = document.getElementById('xilianMentionList');
        if (!panel || !list) return;

        let html = '';
        agents.forEach(agent => {
            const avatarUrl = (typeof XilianSettings !== 'undefined')
                ? XilianSettings.getAvatarUrl(agent.avatar) : '';
            html += `
                <div class="xilian-mention-item" data-agent-id="${agent.id}" data-agent-name="${agent.name}">
                    ${avatarUrl ? `<img src="${avatarUrl}" class="xilian-mention-avatar" onerror="this.style.display='none'">` : '<div class="xilian-mention-avatar">🤖</div>'}
                    <span class="xilian-mention-name">${this.escapeHtml(agent.name)}</span>
                </div>
            `;
        });
        list.innerHTML = html;
        panel.style.display = 'block';
    },

    hideMentionPanel() {
        const panel = document.getElementById('xilianMentionPanel');
        if (panel) panel.style.display = 'none';
    },

    // ============================================================
    // 创建者标签渲染
    // ============================================================

    /**
     * 渲染创建者标签角标
     */
    renderCreatorBadge(creatorName) {
        const name = creatorName || (XilianSettings._config?.aiUserName) || '我';
        return `<span class="creator-badge" title="创建者: ${this.escapeHtml(name)}">${this.escapeHtml(name)}</span>`;
    },

    // ============================================================
    // 工具方法
    // ============================================================

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    formatContent(text) {
        if (!text) return '';
        // 简单的 Markdown 格式化
        let html = this.escapeHtml(text);

        // ★ Markdown 表格渲染（在换行替换之前处理，表格需要按行块解析）
        html = this._renderMarkdownTables(html);

        // 换行
        html = html.replace(/\n/g, '<br>');

        // 粗体 **text**
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // 代码 `code`
        html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(124,58,237,0.1);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>');

        // 列表项 - item
        html = html.replace(/^[-•]\s+(.+)$/gm, '<span style="display:block;padding-left:8px;">• $1</span>');

        return html;
    },

    /**
     * 解析 Markdown 表格并转换为 HTML <table>
     * 表格格式：
     *   | 表头1 | 表头2 |
     *   |:-----:|------:|
     *   | 单元格 | 单元格 |
     */
    _renderMarkdownTables(html) {
        // 匹配连续的以 | 开头的行（表格块）
        // 表格块至少3行：表头 + 分隔行 + 数据行
        const tableBlockRegex = /((?:^\|.*\n?){3,})/gm;
        return html.replace(tableBlockRegex, (block) => {
            const lines = block.trim().split('\n').filter(l => l.trim());
            if (lines.length < 2) return block; // 至少需要表头+分隔行

            // 第二行必须是分隔行（只含 |、-、:、空格）
            const separator = lines[1];
            if (!/^\|?[\s:-]+\|[\s:\-|]*$/.test(separator)) return block;

            // 解析对齐方式
            const aligns = separator.split('|')
                .filter((c, i, arr) => i > 0 && i < arr.length - 1 || (i === arr.length - 1 && c.trim()))
                .map(c => {
                    c = c.trim();
                    if (c.startsWith(':') && c.endsWith(':')) return 'center';
                    if (c.endsWith(':')) return 'right';
                    return 'left';
                });

            // 解析表头
            const parseRow = (line) => {
                return line.split('|')
                    .filter((c, i, arr) => {
                        // 去掉首尾空段（行首|和行尾|产生的空串）
                        if (i === 0 && c.trim() === '') return false;
                        if (i === arr.length - 1 && c.trim() === '') return false;
                        return true;
                    })
                    .map(c => c.trim());
            };

            const headers = parseRow(lines[0]);
            const dataRows = lines.slice(2).map(parseRow);

            // 构建 HTML 表格
            let tableHtml = '<div style="overflow-x:auto;margin:8px 0;"><table style="border-collapse:collapse;width:100%;font-size:13px;">';

            // 表头
            tableHtml += '<thead><tr>';
            headers.forEach((h, i) => {
                const align = aligns[i] || 'left';
                tableHtml += `<th style="border:1px solid rgba(124,58,237,0.2);padding:6px 10px;text-align:${align};background:rgba(124,58,237,0.08);font-weight:600;">${h}</th>`;
            });
            tableHtml += '</tr></thead>';

            // 数据行
            tableHtml += '<tbody>';
            dataRows.forEach(row => {
                tableHtml += '<tr>';
                headers.forEach((_, i) => {
                    const align = aligns[i] || 'left';
                    const cell = row[i] || '';
                    tableHtml += `<td style="border:1px solid rgba(124,58,237,0.15);padding:6px 10px;text-align:${align};">${cell}</td>`;
                });
                tableHtml += '</tr>';
            });
            tableHtml += '</tbody></table></div>';

            return tableHtml;
        });
    },

    getToolDisplayName(name) {
        const labels = {
            createTask: '创建任务', updateTask: '更新任务', deleteTask: '删除任务',
            listTasks: '查询任务', completeTask: '完成任务',
            createMemo: '创建笔记', updateMemo: '更新笔记',
            deleteMemo: '删除笔记', listMemos: '查询笔记',
            addExpense: '记账', updateExpense: '更新记录',
            deleteExpense: '删除记录', listExpenses: '查询账单',
            getExpenseSummary: '收支汇总',
            addJournal: '写日志', listJournals: '查询日志',
            createBudget: '创建预算', updateBudget: '更新预算',
            listBudgets: '查询预算', getBudgetStatus: '预算状态',
            getSettings: '读取设置', updateSettings: '更新设置',
            switchUser: '切换用户', triggerSync: '云同步',
            getSyncStatus: '同步状态', getDashboard: '获取概览'
        };
        return labels[name] || name;
    },

    /**
     * 轻提示
     */
    showToast(text, duration = 1500) {
        let toast = document.querySelector('.xilian-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'xilian-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = text;
        toast.classList.add('xilian-toast-visible');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.classList.remove('xilian-toast-visible');
        }, duration);
    }
};
