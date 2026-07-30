var { ipcRenderer, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { dom } = require('./dom-utils.js');
const utils = require('./utils.js');
const { TaskManager } = require('./task-manager.js');
const { MemoManager } = require('./memo-manager.js');
const { ExpenseManager } = require('./expense-manager.js');
const { BudgetManager } = require('./budget-manager.js');
const { SecretManager } = require('./secret-manager.js');
const { JournalManager } = require('./journal-manager.js');
const { ThemeManager } = require('./theme-manager.js');
const { SettingsManager } = require('./settings-manager.js');

// ─────────────────────────────────────────────────────────────────────────────
// 星图自动刷新：后台 Scribe/Archivist 抽取碎片/星座写入数据库后，
// 渲染进程每隔 15 秒探测一次 MC 数据量；若发生了变化，立即派发 'memory-refresh'
// 让星图（memory/js/memory/main.js 已监听该事件）在数秒内刷新，
// 而不必等原有的 5 分钟兜底定时器，也无需用户手动点「录入对话」。
// 用签名（totalFragments|activeConstellations|entityProfiles）比较，
// 仅在数据真正变化时才刷新，避免无变化时频繁刷新造成的抖动与性能浪费。
// ─────────────────────────────────────────────────────────────────────────────
const mcAutoRefresh = require('./mc-auto-refresh.js');

/**
 * 启动星图自动刷新轮询（实现见 mc-auto-refresh.js）。
 * 注入渲染进程的 ipcRenderer 与 window，避免模块加载期依赖 electron。
 */
function initMcAutoRefresh() {
  mcAutoRefresh.init({ ipcRenderer, targetWindow: window });
}

class AppController {
  constructor() {
    this.tasks = [];
    this.memos = [];
    this.expenses = [];
    this.budgets = [];
    this.secrets = [];
    this.journals = [];
    this.dailyTasks = [];
    this.editingMemoId = null;
    this.searchKeyword = '';
    this.currentYear = new Date().getFullYear();
    this.currentMonth = new Date().getMonth();
    this.selectedDate = new Date();
    this.selectedDateStr = utils.formatDateKey(new Date());
    this.expenseTags = [];
    this.expenseCategory = '';
    this.taskTags = [];
    this.currentEditingItem = null;
    this.currentEditingType = null;
    this.currentEditingSecretId = null;

    this.longPressTimer = null;
    this.longPressCard = null;
    this.longPressStartX = 0;
    this.longPressStartY = 0;
    this.hasLongPressed = false;
    this.isDraggingCard = false;
    this.draggedCard = null;
    this.placeholder = null;
    
    // 显示私密备忘录状态
    this.showPrivateMemos = false;

    // 初始化模块管理器
    this.taskManager = new TaskManager(this);
    this.memoManager = new MemoManager(this);
    this.expenseManager = new ExpenseManager(this);
    this.budgetManager = new BudgetManager(this);
    this.secretManager = new SecretManager(this);
    this.journalManager = new JournalManager(this);
    this.themeManager = new ThemeManager(this);
    this.settingsManager = new SettingsManager(this);
    this.xilianManager = getXilianManager(this);
    window.xilianManager = this.xilianManager; // 暴露全局，供星图"录入当前对话"按钮调用
    // 暴露全局，供星图"录入当前对话"按钮调用；录入后强制下次轮询刷新星图
    window.mcBackfillCurrentChat = async () => {
      const n = (this.xilianManager && typeof this.xilianManager._mcBackfillCurrentChat === 'function')
        ? await this.xilianManager._mcBackfillCurrentChat()
        : 0;
      // 录入对话后重置基线：下次轮询重新建立签名；新碎片写入使计数变化，按期刷新星图
      // （resetBaseline 仅清空基线，不强制派发；避免无变化的冗余刷新，符合签名去抖动设计）
      mcAutoRefresh.resetBaseline();
      return n;
    };
    this.chatRoomManager = null; // 聊天室管理器，在 onDOMReady 中初始化
    window._app = this; // 暴露全局引用供 XilianUI 刷新使用

    this.init();
  }

  init() {
    document.addEventListener('DOMContentLoaded', () => this.onDOMReady());
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
    // ★ 修复：备忘录复制到外部多空行——选区在备忘录内时，丢弃 Quill 的 <p> 富文本，改用单行 \n 纯文本写入剪贴板
    document.addEventListener('copy', (e) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString()) return;
      let node = sel.anchorNode;
      let inMemo = false;
      while (node && node !== document.body) {
        if (node.classList && (node.classList.contains('quill-editor') || node.classList.contains('ql-editor') || node.classList.contains('memo-content'))) {
          inMemo = true;
          break;
        }
        node = node.parentNode;
      }
      if (!inMemo) return;
      let text = sel.toString().replace(/\r\n/g, '\n');
      // 折叠 Quill/<p> 复制产生的多余空行（2+ 连续换行 -> 1 个），避免每段之间多出空白行
      text = text.replace(/\n{2,}/g, '\n');
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    });
  }

  async onDOMReady() {
    // ★ 最优先：立即切换到昔涟视图（同步执行，保证 UI 立即可见）
    try { this.switchView('xilian'); } catch (e) { console.error('[onDOMReady] switchView 失败:', e); }

    // ── 步骤1：加载全部数据（直读 data.json，不依赖 IPC）──
    try { await this.loadAllData(); } catch (e) { console.error('[onDOMReady] loadAllData 失败:', e); }
    try { this.renderDailyTasksSection(); } catch (e) {}

    // ── 步骤1.5：初始化昔涟设置（必须在 initFromCache 之前完成，否则 window.__xilianPresets 为空导致聊天记录 key 算错）──
    try { await XilianSettings.init(); } catch (e) { console.error('[onDOMReady] XilianSettings.init 失败:', e); }

    // ── 步骤2：渲染 UI ──
    try { this.renderCalendar(); } catch (e) { console.error(e); }
    try { this.renderDateNav(); } catch (e) { console.error(e); }
    try { this.renderMemos(); } catch (e) { console.error(e); }
    try { this.renderSecrets(); } catch (e) { console.error(e); }

    // ── 步骤3：设置事件监听 ──
    try { this.setupEventListeners(); } catch (e) { console.error(e); }
    try { this.setupXilianEvents(); } catch (e) { console.error(e); }

    // ── 步骤4：初始化聊天室管理器 ──
    try {
      this.chatRoomManager = getChatRoomManager();
      window._chatRoomManager = this.chatRoomManager;
      this.xilianManager.chatRoomManager = this.chatRoomManager;
      console.log('[onDOMReady] CRM 初始化成功:', !!this.chatRoomManager);
    } catch (e) {
      console.error('[onDOMReady] CRM 初始化失败:', e.message);
      // 兜底：如果 getChatRoomManager 未定义（chat-room-manager.js 加载失败），通过 require 重新加载
      try {
        const { getChatRoomManager: getCRM } = require('./chat-room-manager.js');
        if (typeof getCRM === 'function') {
          this.chatRoomManager = getCRM();
          window._chatRoomManager = this.chatRoomManager;
          this.xilianManager.chatRoomManager = this.chatRoomManager;
          console.log('[onDOMReady] CRM 通过 require 重新加载成功');
        } else {
          console.error('[onDOMReady] require 返回的 getCRM 不是函数');
        }
      } catch (reqErr) {
        console.error('[onDOMReady] require 加载 chat-room-manager.js 失败:', reqErr.message);
      }
    }

    // ── 步骤5：初始化聊天记录和聊天室（用预加载缓存避免重复读盘）──
    if (this._preloaded) {
      try {
        // 聊天室管理器用缓存初始化（统一入口，避免内联重复）
        this._initChatRoomFromCache();
        // ★ 即使有缓存，也调用 init() 以确保聊天室数据完全加载
        // _preloaded 可能不含 chatRooms（旧版 data-manager 未返回），
        // init() 通过 chat-room-get-all IPC 从 data-service.js 读取完整数据做兜底
        try { await this.chatRoomManager.init(); } catch (e) { console.error(e); }
        // 聊天记录用缓存初始化 + 渲染（若缓存为空会自动 fallback 到 IPC 重新加载）
        await this.xilianManager.initFromCache(this._preloaded);
      } catch (e) {
        console.error('[App] initFromCache 失败:', e);
      }
    } else {
      try { await this.xilianManager.init(); } catch (e) { console.error(e); }
      try { await this.chatRoomManager.init(); } catch (e) { console.error(e); }
    }

    // ── 步骤6：更新聊天头部 ──
    try { this._updateChatHeader(); } catch (e) { console.error(e); }

    // ── 步骤7：注册聊天室状态变化回调 ──
    if (this.chatRoomManager) {
      this.chatRoomManager.onStateChange(async (state) => {
        if (state.isRoomMode && state.currentRoom) {
          const presets = window.__xilianPresets || [];
          const room = state.currentRoom;
          const agentAvatars = room.agentIds.slice(0, 5).map(id => {
            const p = presets.find(pr => pr.id === id);
            return p && p.avatar ? XilianSettings.getAvatarUrl(p.avatar) : '';
          });
          XilianUI.updateHeaderForRoom(room.name, agentAvatars);
          await this.xilianManager.switchToRoom(room.id);
        } else {
          XilianUI.updateHeaderForPrivate(
            (window.__xilianPresets || []).find(p => p.id === XilianSettings._currentPresetId)?.name || 'Elysia',
            XilianSettings.getAgentAvatarUrl()
          );
          await this.xilianManager.switchToPrivateChat(XilianSettings._currentPresetId || 'default');
        }
      });
    }

    // ── 步骤8：creator 标签迁移（最多一次）──
    try { await this._runCreatorMigration(); } catch (e) { console.error('[CreatorTag]', e); }

    // 兜底：确保视图正确
    this.switchView('xilian');

    // ★ 关闭前保存聊天室状态（防止直接点 X 关闭窗口时状态丢失）
    window.addEventListener('beforeunload', () => {
      try {
        if (this.chatRoomManager) {
          // 同步触发一次状态保存（beforeunload 里不能用 async/await）
          const { ipcRenderer } = require('electron');
          const state = {
            roomId: this.chatRoomManager.currentRoomId,
            isRoomMode: this.chatRoomManager.isRoomMode
          };
          // 用 send（同步）而非 invoke（异步）
          ipcRenderer.send('chat-room-save-state-sync', state);
        }
      } catch (e) {}
    });

    // 隐藏启动屏
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) loadingScreen.style.display = 'none';

    // ── 步骤9：启动星图自动刷新轮询（详见文件顶部 initMcAutoRefresh 说明）──
    try { initMcAutoRefresh(); } catch (e) { console.error('[onDOMReady] initMcAutoRefresh 失败:', e); }
  }

  /**
   * 根据当前聊天室/私聊状态更新头部头像（启动时调用，不触发 onStateChange 避免重复加载）
   */
  _updateChatHeader() {
    if (this.chatRoomManager && this.chatRoomManager.isRoomMode && this.chatRoomManager.currentRoomId) {
      const presets = window.__xilianPresets || [];
      const room = this.chatRoomManager.chatRooms.find(r => r.id === this.chatRoomManager.currentRoomId);
      if (room) {
        const agentAvatars = room.agentIds.slice(0, 5).map(id => {
          const p = presets.find(pr => pr.id === id);
          return p && p.avatar ? XilianSettings.getAvatarUrl(p.avatar) : '';
        });
        XilianUI.updateHeaderForRoom(room.name, agentAvatars);
        return;
      }
    }
    // 默认：私聊头部（使用 XilianSettings 的动态路径，避免硬编码）
    if (typeof XilianSettings !== 'undefined') {
      XilianUI.updateHeaderForPrivate(
        XilianSettings._currentPresetId
          ? (window.__xilianPresets || []).find(p => p.id === XilianSettings._currentPresetId)?.name || 'Elysia'
          : 'Elysia',
        XilianSettings.getAgentAvatarUrl()
      );
    }
  }

  /**
   * 用预加载数据初始化聊天室管理器，跳过 IPC 读盘
   */
  _initChatRoomFromCache() {
    if (!this._preloaded) return;
    // 设置聊天室预设
    if (this._preloaded.chatRooms && this._preloaded.chatRooms.length > 0) {
      this.chatRoomManager.chatRooms = this._preloaded.chatRooms;
    }
    // 检查是否有保存的上次聊天室状态
    const state = this._preloaded.settings?.chatRoomState;
    if (state && state.roomId && this.chatRoomManager.chatRooms.find(r => r.id === state.roomId)) {
      this.chatRoomManager.currentRoomId = state.roomId;
      this.chatRoomManager.isRoomMode = true;
    }
  }

  async _runCreatorMigration() {
    // 已迁移过的直接跳过
    if (XilianSettings._config?._creatorTagMigrated) return;
    try {
      const { ipcRenderer } = require('electron');
      const userName = XilianSettings._config?.aiUserName || '我';
      const migrateResult = await ipcRenderer.invoke('creator-tag-migrate-legacy', { userName });
      // 标记为已完成
      XilianSettings._config._creatorTagMigrated = true;
      XilianSettings.saveSettings();
      if (migrateResult.migratedCount > 0) {
        console.log(`[CreatorTag] 已迁移 ${migrateResult.migratedCount} 条历史数据 (之后启动跳过)`);
        await this.loadAllData();
      }
    } catch (e) {
      console.error('[CreatorTag] 迁移失败:', e);
    }
  }

  

  async showVersionType() {
    try {
      const result = await ipcRenderer.invoke('get-version-type');
      window.isTestVersion = result.isTest;
      const titleEl = document.querySelector('.titlebar-title');
      if (titleEl) {
        const isDarkMode = document.documentElement.classList.contains('dark-mode');
        if (isDarkMode) {
          titleEl.textContent = result.isTest ? 'Philia Beta' : 'Philia';
        } else {
          titleEl.textContent = result.isTest ? 'Elysia Beta' : 'Elysia';
        }
      }
      const menuUpdateEl = document.getElementById('menuUpdate');
      if (menuUpdateEl) {
        menuUpdateEl.textContent = '更新';
      }
    } catch (e) {
      console.error('获取版本类型失败:', e);
    }
  }

  hideLoadingScreen() {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.classList.add('hidden');
      setTimeout(() => {
        loadingScreen.classList.add('completely-hidden');
      }, 350);
    }
  }

  /**
   * 统一数据加载 — ★ 直接用 fs 读取 data.json（零 IPC，不依赖主进程 handler）
   * 原来的 7 次独立 IPC 调用 → 改为 1 次同步磁盘读取
   */
  async loadAllData() {
    try {
      // ★ 统一通过 IPC 加载，确保和主进程读写同一个 data.json
      // （主进程会根据 cloudCurrentUserId 决定读 users/xxx/data.json 还是 data.json）
      const data = await ipcRenderer.invoke('load-all-data');

      const tasks = data.tasks || [];
      const memos = data.memos || [];
      const expenses = (data.expenses || []).map(e => ({
        ...e,
        amount: typeof e.amount === 'string' ? parseFloat(e.amount) || 0 : e.amount,
        type: (e.type === 0 || e.type === '0') ? 'expense' : (e.type === 1 || e.type === '1') ? 'income' : e.type
      }));
      const budgets = data.budgets || [];
      const categoryBudgets = data.categoryBudgets || [];
      const secrets = data.secrets || [];
      const journals = data.journals || [];
      const settings = data.settings || {};
      const chatHistory = data.chatHistory || [];
      const chatHistoryStore = data.chatHistoryStore || {};
      const chatRooms = data.chatRooms || [];
      const chatHistoryLimit = data.chatHistoryLimit || 50;
      const dailyTasks = data.dailyTasks || [];

      this.tasks = tasks;
      this.memos = memos;
      this.expenses = expenses;
      this.budgets = budgets;
      this.categoryBudgets = categoryBudgets;
      this.secrets = secrets;
      this.journals = journals;
      this.dailyTasks = dailyTasks;

      this.taskManager.tasks = tasks;
      this.memoManager.memos = memos;
      this.expenseManager.expenses = expenses;
      this.budgetManager.budgets = budgets;
      this.budgetManager.categoryBudgets = categoryBudgets;
      this.secretManager.secrets = secrets;
      this.journalManager.journals = journals;

      this._preloaded = {
        chatHistory,
        chatHistoryStore,
        chatRooms,
        chatHistoryLimit,
        settings,
      };

      if (settings && Object.keys(settings).length > 0) {
        XilianSettings._config = { ...XilianSettings._config, ...settings };
      }

    } catch (error) {
      console.error('[loadAllData] IPC 加载失败，回退到独立 IPC:', error.message);
      try {
        const results = await Promise.allSettled([
          ipcRenderer.invoke('get-tasks').then(d => d.tasks || d),
          ipcRenderer.invoke('get-memos'),
          ipcRenderer.invoke('get-expenses'),
          ipcRenderer.invoke('get-journals'),
          ipcRenderer.invoke('get-budgets'),
          ipcRenderer.invoke('get-secrets'),
        ]);
        const [tasksR, memosR, expensesR, journalsR, budgetsR, secretsR] = results;
        this.tasks = tasksR.status === 'fulfilled' ? (tasksR.value || []) : [];
        this.memos = memosR.status === 'fulfilled' ? (memosR.value || []) : [];
        this.expenses = expensesR.status === 'fulfilled' ? (expensesR.value || []) : [];
        this.journals = journalsR.status === 'fulfilled' ? (journalsR.value || []) : [];
        this.budgets = budgetsR.status === 'fulfilled' ? (budgetsR.value || []) : [];
        this.secrets = secretsR.status === 'fulfilled' ? (secretsR.value || []) : [];
        this.taskManager.tasks = this.tasks;
        this.memoManager.memos = this.memos;
        this.expenseManager.expenses = this.expenses;
        this.journalManager.journals = this.journals;
        this.budgetManager.budgets = this.budgets;
        this.secretManager.secrets = this.secrets;
        this._preloaded = null;
      } catch (e2) {
        this.handleError(e2, '回退 IPC 加载也失败');
        this._preloaded = null;
      }
    }
  }

  // 以下函数保留给非启动时的独立刷新调用（如 loadBudgets 在 Budget UI 独立刷新时使用）
  async loadBudgets() {
    try {
      const result = await this.budgetManager.loadBudgets();
      this.budgets = result.budgets;
      this.categoryBudgets = result.categoryBudgets;
    } catch (error) {
      this.handleError(error, '加载预算失败');
      this.budgets = [];
      this.categoryBudgets = [];
    }
  }

  async loadCategoryBudgets() {
    try {
      await this.budgetManager.loadBudgets();
      this.categoryBudgets = this.budgetManager.getCategoryBudgets();
    } catch (error) {
      this.handleError(error, '加载分类预算失败');
      this.categoryBudgets = [];
    }
  }

  async loadSecrets() {
    try {
      this.secrets = await this.secretManager.loadSecrets();
      this.renderSecrets();
    } catch (error) {
      this.handleError(error, '加载密钥失败');
      this.secrets = [];
    }
  }

  async loadJournals() {
    try {
      this.journals = await this.journalManager.loadJournals();
    } catch (error) {
      this.handleError(error, '加载日志失败');
      this.journals = [];
    }
  }

  async saveJournal(journal) {
    try {
      const result = await this.journalManager.saveJournal(journal);
      this.journals = this.journalManager.getJournals();
      return result;
    } catch (error) {
      this.handleError(error, '保存日志失败');
      throw error;
    }
  }

  async deleteJournal(id) {
    try {
      await this.journalManager.deleteJournal(id);
      this.journals = this.journalManager.getJournals();
    } catch (error) {
      this.handleError(error, '删除日志失败');
      throw error;
    }
  }

  async saveSecret(secret) {
    try {
      const result = await this.secretManager.saveSecret(secret);
      this.secrets = this.secretManager.getSecrets();
      this.renderSecrets();
      return result;
    } catch (error) {
      this.handleError(error, '保存密钥失败');
      throw error;
    }
  }

  async deleteSecret(id) {
    try {
      await this.secretManager.deleteSecret(id);
      this.secrets = this.secretManager.getSecrets();
      this.renderSecrets();
    } catch (error) {
      this.handleError(error, '删除密钥失败');
      throw error;
    }
  }

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.error('复制失败:', error);
      return false;
    }
  }

  showToast(message) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      toast.className = 'app-toast';
      document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  handleError(error, context = '') {
    const errorMessage = typeof error === 'string' ? error : (error.message || '未知错误');
    const fullMessage = context ? `${context}: ${errorMessage}` : errorMessage;
    
    console.error('[Elysia Error]', fullMessage);
    
    ipcRenderer.invoke('log-error', { message: fullMessage, stack: error.stack }).catch(() => {});
    
    this.showToast(`出错了: ${errorMessage}`);
    
    return error;
  }

  async pinSecret(id) {
    const result = await this.secretManager.pinSecret(id);
    if (result.success) {
      this.secrets = this.secretManager.getSecrets();
      this.renderSecrets();
    }
  }

  renderSecrets() {
    const container = document.getElementById('secretsContainer');

    let filteredSecrets = this.secretManager.searchSecrets('');
    
    filteredSecrets.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      const aModified = new Date(a.lastModified || a.createdAt || 0);
      const bModified = new Date(b.lastModified || b.createdAt || 0);
      return bModified - aModified;
    });
    
    if (filteredSecrets.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div>🔐 暂无密钥</div>
          <div class="empty-tip">点击上方按钮添加您的密钥</div>
        </div>
      `;
      return;
    }
    
    const fragment = document.createDocumentFragment();
    filteredSecrets.forEach(secret => {
      const card = this.createSecretCardElement(secret);
      fragment.appendChild(card);
    });
    
    container.innerHTML = '';
    container.appendChild(fragment);
  }

  createSecretCardElement(secret) {
    const card = document.createElement('div');
    card.className = 'secret-card';
    card.dataset.secretId = secret.id;
    card.dataset.action = 'edit-secret';
    
    const header = document.createElement('div');
    header.className = 'secret-card-header';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'secret-name';
    nameSpan.textContent = secret.name;
    header.appendChild(nameSpan);
    
    const categoriesDiv = document.createElement('div');
    categoriesDiv.className = 'secret-categories';
    if (secret.categories) {
      secret.categories.forEach(cat => {
        const catSpan = document.createElement('span');
        catSpan.className = `secret-type${cat === 'api' ? ' api' : cat === 'custom' ? ' custom' : cat === 'work' ? ' work' : cat === 'study' ? ' study' : cat === 'email' ? ' email' : ''}`;
        catSpan.textContent = cat;
        categoriesDiv.appendChild(catSpan);
      });
    }
    header.appendChild(categoriesDiv);
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'secret-info';
    
    if (secret.fields) {
      secret.fields.forEach((field, index) => {
        const row = document.createElement('div');
        row.className = 'secret-info-row';
        
        const labelSpan = document.createElement('span');
        labelSpan.className = 'secret-info-label';
        labelSpan.textContent = `${field.label}:`;
        row.appendChild(labelSpan);
        
        const isPassword = field.label.toLowerCase().includes('密码') || field.label.toLowerCase().includes('密钥');
        const displayValue = isPassword ? '*'.repeat(field.value?.length || 8) : field.value;
        
        const valueSpan = document.createElement('span');
        valueSpan.className = `secret-info-value${isPassword ? ' secret-password' : ''}`;
        valueSpan.textContent = displayValue;
        row.appendChild(valueSpan);
        
        const copySpan = document.createElement('span');
        copySpan.className = 'copy-icon';
        copySpan.dataset.index = index;
        copySpan.dataset.id = secret.id;
        copySpan.title = '复制';
        copySpan.textContent = '📋';
        row.appendChild(copySpan);
        
        infoDiv.appendChild(row);
      });
    }
    
    if (secret.url) {
      const row = document.createElement('div');
      row.className = 'secret-info-row';
      
      const labelSpan = document.createElement('span');
      labelSpan.className = 'secret-info-label';
      labelSpan.textContent = 'URL:';
      row.appendChild(labelSpan);
      
      const valueSpan = document.createElement('span');
      valueSpan.className = 'secret-info-value';
      valueSpan.textContent = secret.url;
      row.appendChild(valueSpan);
      
      infoDiv.appendChild(row);
    }
    
    card.appendChild(header);
    card.appendChild(infoDiv);
    
    return card;
  }

  openSecretModal(secret = null) {
    const modal = document.getElementById('secretModal');
    const title = document.querySelector('#secretModal h3');
    const deleteBtn = document.getElementById('deleteSecretBtn');
    const fieldsContainer = document.getElementById('secretFieldsContainer');
    const categoryTags = document.getElementById('secretCategoryTags');
    
    if (secret) {
      title.textContent = '编辑密钥';
      document.getElementById('secretName').value = secret.name;
      document.getElementById('secretNotes').value = secret.notes || '';
      
      categoryTags.innerHTML = '';
      secret.categories?.forEach(cat => this.addCategoryTag(cat));
      
      fieldsContainer.innerHTML = '';
      const fields = secret.fields || [{label: '用户名', value: ''}, {label: '密码', value: ''}];
      let fieldsHtml = '';
      fields.forEach((field, index) => {
        fieldsHtml += `
          <div class="secret-field-row">
            <input type="text" class="field-label-input" placeholder="字段名称" value="${field.label}">
            <input type="text" class="field-value-input" placeholder="字段值" value="${field.value || ''}">
            <button type="button" class="btn-remove-field">✕</button>
          </div>
        `;
      });
      fieldsContainer.innerHTML = fieldsHtml;
      
      this.currentEditingSecretId = secret.id;
      deleteBtn.style.display = 'inline-block';
    } else {
      title.textContent = '添加密钥';
      this.clearSecretForm();
      this.currentEditingSecretId = null;
      deleteBtn.style.display = 'none';
    }
    
    modal.style.display = 'flex';
  }

  closeSecretModal() {
    const modal = document.getElementById('secretModal');
    modal.style.display = 'none';
    this.clearSecretForm();
    this.currentEditingSecretId = null;
  }

  clearSecretForm() {
    document.getElementById('secretName').value = '';
    document.getElementById('secretNotes').value = '';
    document.getElementById('secretCategoryInput').value = '';
    document.getElementById('secretCategoryTags').innerHTML = '';
    
    const fieldsContainer = document.getElementById('secretFieldsContainer');
    fieldsContainer.innerHTML = `
      <div class="secret-field-row">
        <input type="text" class="field-label-input" placeholder="字段名称" value="用户名">
        <input type="text" class="field-value-input" placeholder="字段值">
        <button type="button" class="btn-remove-field">✕</button>
      </div>
      <div class="secret-field-row">
        <input type="text" class="field-label-input" placeholder="字段名称" value="密码">
        <input type="text" class="field-value-input" placeholder="字段值">
        <button type="button" class="btn-remove-field">✕</button>
      </div>
    `;
  }

  addCategoryTag(category) {
    const categoryTags = document.getElementById('secretCategoryTags');
    if (!category || category.trim() === '') return;
    
    const existingTags = Array.from(categoryTags.querySelectorAll('.selected-tag')).map(t => t.dataset.category);
    if (existingTags.includes(category.trim())) return;
    
    const tag = document.createElement('span');
    tag.className = 'selected-tag';
    tag.dataset.category = category.trim();
    tag.innerHTML = `${category.trim()} <span class="remove-tag" onclick="appController.removeCategoryTag(this)">✕</span>`;
    categoryTags.appendChild(tag);
  }

  removeCategoryTag(element) {
    element.parentElement.remove();
  }

  addSecretField() {
    const fieldsContainer = document.getElementById('secretFieldsContainer');
    const row = document.createElement('div');
    row.className = 'secret-field-row';
    row.innerHTML = `
      <input type="text" class="field-label-input" placeholder="字段名称">
      <input type="text" class="field-value-input" placeholder="字段值">
      <button type="button" class="btn-remove-field">✕</button>
    `;
    fieldsContainer.appendChild(row);
  }

  async saveSecretData() {
    const name = document.getElementById('secretName').value.trim();
    
    if (!name) {
      alert('请输入密钥名称');
      return;
    }
    
    const categoryTags = document.getElementById('secretCategoryTags');
    const categories = Array.from(categoryTags.querySelectorAll('.selected-tag')).map(t => t.dataset.category);
    
    const fieldsContainer = document.getElementById('secretFieldsContainer');
    const fieldRows = fieldsContainer.querySelectorAll('.secret-field-row');
    const fields = [];
    
    fieldRows.forEach(row => {
      const label = row.querySelector('.field-label-input').value.trim();
      const value = row.querySelector('.field-value-input').value;
      if (label) {
        fields.push({ label, value });
      }
    });
    
    if (fields.length === 0) {
      alert('请至少添加一个字段');
      return;
    }
    
    const secret = {
      id: this.currentEditingSecretId,
      name,
      categories,
      fields,
      notes: document.getElementById('secretNotes').value.trim(),
      createdAt: this.currentEditingSecretId ? undefined : new Date().toISOString()
    };
    
    try {
      await this.saveSecret(secret);
      this.currentEditingSecretId = null;
      this.closeSecretModal();
    } catch (error) {
      alert('保存失败: ' + error.message);
    }
  }

  async handleSecretAction(action, value, id) {
    switch (action) {
      case 'copy-field':
        const secret = this.secretManager.getSecretById(id);
        if (secret && secret.fields) {
          const fieldIndex = parseInt(value);
          if (!isNaN(fieldIndex) && secret.fields[fieldIndex]) {
            await this.copyToClipboard(secret.fields[fieldIndex].value);
            this.showToast(`${secret.fields[fieldIndex].label}已复制到剪贴板`);
          }
        }
        break;
      case 'edit-secret':
        const editSecret = this.secretManager.getSecretById(id);
        if (editSecret) {
          this.openSecretModal(editSecret);
        }
        break;
      case 'delete-secret':
        if (confirm('确定要删除这个密钥吗？')) {
          await this.deleteSecret(id);
          this.renderSecrets();
          
          setTimeout(() => {
            const firstInput = document.querySelector('input, textarea, [contenteditable="true"]');
            if (firstInput) {
              firstInput.focus();
            }
          }, 100);
        }
        break;
    }
  }

  async loadTasks() {
    try {
      this.tasks = await this.taskManager.loadTasks();
    } catch (error) {
      console.error('加载任务失败:', error);
      this.tasks = [];
    }
  }

  async loadMemos() {
    try {
      this.memos = await this.memoManager.loadMemos();
    } catch (error) {
      console.error('加载备忘录失败:', error);
      this.memos = [];
    }
  }

  async loadExpenses() {
    try {
      this.expenses = await this.expenseManager.loadExpenses();
    } catch (error) {
      console.error('加载收支失败:', error);
      this.expenses = [];
    }
  }

  

  startOfDay(date) {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
  }

  endOfDay(date) {
    const result = new Date(date);
    result.setHours(23, 59, 59, 999);
    return result;
  }

  getDaysInPeriod(startDate, endDate) {
    const start = this.startOfDay(startDate);
    const end = this.startOfDay(endDate);
    return Math.max(1, Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1);
  }

  getDaysPassed(startDate, currentDate) {
    const start = this.startOfDay(startDate);
    const current = this.startOfDay(currentDate);
    if (current < start) return 0;
    return Math.floor((current - start) / (1000 * 60 * 60 * 24)) + 1;
  }

  setupModalDrag(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');
    const resizeHandle = modal.querySelector('.resize-handle');
    if (!content || !header) return;

    let isDragging = false;
    let isResizing = false;
    let startX, startY, startLeft, startTop;
    let startWidth, startHeight;

    header.addEventListener('mousedown', (e) => {
      if (isResizing) return;
      if (e.target.classList.contains('modal-close')) {
        return;
      }
      
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = content.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      content.style.left = `${startLeft}px`;
      content.style.top = `${startTop}px`;
      content.style.transform = 'none';
      
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
      if (isResizing) return;
      if (!isDragging) return;
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      let newLeft = startLeft + deltaX;
      let newTop = startTop + deltaY;
      
      const maxLeft = window.innerWidth - content.offsetWidth;
      const maxTop = window.innerHeight - content.offsetHeight;
      
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));
      
      content.style.left = `${newLeft}px`;
      content.style.top = `${newTop}px`;
    }

    function onResizeUp() {
      // 在 resize 结束时的清理工作（onMouseUp 已统一处理 isResizing 状态，此处为占位函数避免 ReferenceError）
    }

    function onMouseUp() {
      isDragging = false;
      isResizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeUp);
    }

    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startWidth = content.offsetWidth;
        startHeight = content.offsetHeight;
        
        document.addEventListener('mousemove', onResizeMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    }

    function onResizeMove(e) {
      if (isDragging) return;
      if (!isResizing) return;
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      let newWidth = startWidth + deltaX;
      let newHeight = startHeight + deltaY;
      
      const minWidth = 400;
      const minHeight = 400;
      const maxWidth = window.innerWidth - 40;
      const maxHeight = window.innerHeight - 40;
      
      newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
      newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
      
      content.style.width = `${newWidth}px`;
      content.style.height = `${newHeight}px`;
    }
  }

  isTaskOnDate(task, dateStr) {
    if (!task.startDate && !task.endDate) {
      return true;
    }
    
    const startDateStr = task.startDate ? task.startDate.substring(0, 10) : null;
    const endDateStr = task.endDate ? task.endDate.substring(0, 10) : null;
    
    if (!startDateStr && endDateStr) {
      return dateStr <= endDateStr;
    }
    
    if (startDateStr && !endDateStr) {
      return dateStr >= startDateStr;
    }
    
    return dateStr >= startDateStr && dateStr <= endDateStr;
  }

  setupEventListeners() {
    this.setupWindowControls();
    this.setupDatePickerNavigation();
    this.setupAddButton();
    this.setupModals();
    this.setupIpcListeners();
    this.initTaskTags();
    this.initExpenseTags();
    this.setupNewMemoButton();
    this.setupDragAndDrop();
    this.setupBudgetModal();
    this.setupFinanceReportButton();
    this.setupGlobalSearch();
    this.setupTaskSubtaskCheckbox();
    this.setupExpenseCalendarNavigation();
    this.setupJournalCalendarNavigation();
    this.setupJournalEditor();
    // 分割线拖动功能已移除，使用固定布局
  }

  setupXilianEvents() {
    // 初始化设置
    XilianSettings.init();
    
    // 发送按钮（发送/停止二合一）
    const sendBtn = document.getElementById('xilianSendBtn');
    const input = document.getElementById('xilianInput');
    const clearBtn = document.getElementById('xilianClearHistoryBtn');
    const sendIcon = document.querySelector('.xilian-send-icon');
    const stopIcon = document.querySelector('.xilian-stop-icon');
    
    if (sendBtn && input) {
      const send = () => {
        // 如果正在流式输出，则停止
        if (this.xilianManager.isStreaming) {
          this.xilianManager.stopStreaming();
          return;
        }
        const text = input.value.trim();
        if (text) {
          input.value = '';
          input.style.height = 'auto';
          this.xilianManager.sendMessage(text);
        }
      };
      
      sendBtn.addEventListener('click', send);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      
      // 自动调整输入框高度
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
    }
    
    // 流式状态切换按钮图标
    this.xilianManager._onStreamStateChange = (streaming) => {
      if (sendIcon) sendIcon.style.display = streaming ? 'none' : '';
      if (stopIcon) stopIcon.style.display = streaming ? '' : 'none';
      if (sendBtn) {
        sendBtn.title = streaming ? '停止生成' : '发送';
        sendBtn.style.background = streaming 
          ? 'linear-gradient(135deg, #ef4444, #dc2626)' 
          : '';
      }
    };
    
    // 消息操作（复制/删除）—— 事件委托
    const messagesContainer = document.getElementById('xilianMessages');
    if (messagesContainer) {
      messagesContainer.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('.xilian-msg-action[data-action="copy"]');
        const deleteBtn = e.target.closest('.xilian-msg-action[data-action="delete"]');
        const msgId = e.target.closest('[data-msg-id]')?.getAttribute('data-msg-id');
        
        if (copyBtn && msgId) {
          const msg = this.xilianManager.chatHistory.find(m => m.id === msgId);
          if (msg) {
            navigator.clipboard.writeText(msg.content).then(() => {
              XilianUI.showToast('已复制');
            }).catch(() => {});
          }
        }
        
        if (deleteBtn && msgId) {
          if (confirm('确定要删除这条消息吗？')) {
            this.xilianManager.deleteMessage(msgId);
          }
        }
      });
    }
    
    // 清空对话按钮
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (confirm('确定要清空所有对话历史吗？此操作不可恢复。')) {
          await this.xilianManager.clearHistory();
          XilianUI.showWelcome();
          XilianUI.renderMessages([]);
        }
      });
    }
    
    // 建议按钮
    document.addEventListener('click', (e) => {
      const suggestion = e.target.closest('.xilian-suggestion');
      if (suggestion && input) {
        const prompt = suggestion.dataset.prompt;
        input.value = prompt;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        if (this.xilianManager.isStreaming) {
          this.xilianManager.stopStreaming();
        }
        setTimeout(() => {
          const text = input.value.trim();
          if (text) {
            input.value = '';
            input.style.height = 'auto';
            this.xilianManager.sendMessage(text);
          }
        }, 100);
      }
    });
    
    // ============================================================
    // 聊天室头部事件绑定
    // ============================================================
    this._setupChatRoomHeaderEvents(input);
    
    // ============================================================
    // @提及面板事件
    // ============================================================
    this._setupMentionPanelEvents(input);
  }

  // ============================================================
  _setupChatRoomHeaderEvents(input) {
    const plusBtn = document.getElementById('xilianHeaderPlusBtn');
    const dropdown = document.getElementById('xilianHeaderDropdown');
    
    if (plusBtn && dropdown) {
      // + 按钮点击：切换下拉菜单显示
      // ★ 先移除旧监听器（防止重复绑定），再添加新的
      if (this._onPlusBtnClick) {
        plusBtn.removeEventListener('click', this._onPlusBtnClick);
      }
      this._onPlusBtnClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // ★ 先更新内容，再切换显示，确保内容已渲染
        XilianUI.updateHeaderDropdown();
        // 强制同步重排，确保内容立即可见
        dropdown.offsetHeight;
        if (dropdown.style.display === 'none') {
          dropdown.style.display = 'block';
        } else {
          dropdown.style.display = 'none';
        }
      };
      plusBtn.addEventListener('click', this._onPlusBtnClick);
      
      // 点击页面其他地方关闭下拉菜单
      if (this._onDocClick) {
        document.removeEventListener('click', this._onDocClick);
      }
      this._onDocClick = (e) => {
        if (!dropdown.contains(e.target) && e.target !== plusBtn && !plusBtn.contains(e.target)) {
          dropdown.style.display = 'none';
        }
      };
      document.addEventListener('click', this._onDocClick);
      
      // 下拉菜单委托事件
      if (this._onDropdownClick) {
        dropdown.removeEventListener('click', this._onDropdownClick);
      }
      this._onDropdownClick = async (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        const action = item.dataset.action;
        
        if (action === 'switch-private') {
          dropdown.style.display = 'none';
          this.chatRoomManager.switchToPrivateMode();
        } else if (action === 'switch-room') {
          const roomId = item.dataset.roomId;
          if (roomId) {
            dropdown.style.display = 'none';
            this.chatRoomManager.switchToRoom(roomId);
          }
        }
      };
      dropdown.addEventListener('click', this._onDropdownClick);
    }
  }

  // ============================================================
  // @提及面板事件
  // ============================================================
  _setupMentionPanelEvents(input) {
    if (!input) return;
    const mentionPanel = document.getElementById('xilianMentionPanel');
    const mentionList = document.getElementById('xilianMentionList');
    
    if (!mentionPanel || !mentionList) return;
    
    let mentionStartPos = -1;
    let mentionFilter = '';
    
    // 监听输入框输入
    input.addEventListener('input', () => {
      const text = input.value;
      const cursorPos = input.selectionStart;
      
      // 检测 @ 符号
      const textBeforeCursor = text.slice(0, cursorPos);
      const atIdx = textBeforeCursor.lastIndexOf('@');
      
      if (atIdx !== -1) {
        // 检查 @ 后面是否合法（不能是已有内容的中间）
        const afterAt = textBeforeCursor.slice(atIdx);
        // @后不能有空格
        if (!afterAt.includes(' ')) {
          mentionFilter = afterAt.slice(1).toLowerCase();
          const agents = this.chatRoomManager.getAvailableAgents();
          if (agents.length > 0) {
            const filtered = mentionFilter 
              ? agents.filter(a => a.name.toLowerCase().includes(mentionFilter))
              : agents;
            if (filtered.length > 0) {
              XilianUI.showMentionPanel(filtered);
              mentionStartPos = atIdx;
              return;
            }
          }
        }
      }
      
      // 没有匹配，隐藏面板
      XilianUI.hideMentionPanel();
      mentionStartPos = -1;
    });
    
    // 逃逸键隐藏面板
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        XilianUI.hideMentionPanel();
        mentionStartPos = -1;
      }
    });
    
    // 点击选择智能体
    mentionList.addEventListener('click', (e) => {
      const item = e.target.closest('.xilian-mention-item');
      if (!item || mentionStartPos === -1) return;
      
      const agentName = item.dataset.agentName;
      const text = input.value;
      const cursorPos = input.selectionStart;
      const textBeforeCursor = text.slice(0, cursorPos);
      const atIdx = textBeforeCursor.lastIndexOf('@');
      
      if (atIdx !== -1) {
        const beforeAt = text.slice(0, atIdx);
        const afterCursor = text.slice(cursorPos);
        input.value = beforeAt + '@' + agentName + ' ' + afterCursor;
        
        // 将光标移到 @agentName 后面
        const newPos = beforeAt.length + agentName.length + 2;
        input.setSelectionRange(newPos, newPos);
      }
      
      XilianUI.hideMentionPanel();
      mentionStartPos = -1;
      input.focus();
    });
  }

  setupExpenseCalendarNavigation() {
    const prevBtn = document.getElementById('expenseCalendarPrevMonth');
    const nextBtn = document.getElementById('expenseCalendarNextMonth');
    const addBtn = document.getElementById('addExpenseBtn');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        const date = this.selectedDate || new Date();
        const newDate = new Date(date.getFullYear(), date.getMonth() - 1, date.getDate());
        this.selectedDate = newDate;
        this.selectedDateStr = utils.formatDateKey(newDate);
        this.renderDailyExpenses();
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const date = this.selectedDate || new Date();
        const newDate = new Date(date.getFullYear(), date.getMonth() + 1, date.getDate());
        this.selectedDate = newDate;
        this.selectedDateStr = utils.formatDateKey(newDate);
        this.renderDailyExpenses();
      });
    }

    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this.openExpenseModal();
      });
    }
  }

  setupJournalCalendarNavigation() {
    const prevBtn = document.getElementById('journalCalendarPrevMonth');
    const nextBtn = document.getElementById('journalCalendarNextMonth');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        const date = this.selectedDate || new Date();
        const newDate = new Date(date.getFullYear(), date.getMonth() - 1, date.getDate());
        this.selectedDate = newDate;
        this.selectedDateStr = utils.formatDateKey(newDate);
        this.renderJournalCalendar();
        this.loadJournalForDate(this.selectedDateStr);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const date = this.selectedDate || new Date();
        const newDate = new Date(date.getFullYear(), date.getMonth() + 1, date.getDate());
        this.selectedDate = newDate;
        this.selectedDateStr = utils.formatDateKey(newDate);
        this.renderJournalCalendar();
        this.loadJournalForDate(this.selectedDateStr);
      });
    }
  }

  setupJournalEditor() {
    const journalContent = document.getElementById('journalContent');
    const saveBtn = document.getElementById('saveJournalBtn');
    const wordCount = document.getElementById('journalWordCount');
    const weatherDropdownBtn = document.getElementById('weatherDropdownBtn');
    const weatherDropdown = document.querySelector('.weather-dropdown');
    const weatherOptions = document.querySelectorAll('.weather-option');

    if (journalContent) {
      journalContent.addEventListener('input', () => {
        const count = journalContent.value.length;
        if (wordCount) {
          wordCount.textContent = `${count} 字`;
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this.saveJournalData();
      });
    }

    if (weatherDropdownBtn) {
      weatherDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        weatherDropdown.classList.toggle('open');
      });
    }

    weatherOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const weather = option.dataset.weather;
        const weatherIcon = document.getElementById('weatherIcon');
        const iconMap = {
          sunny: '☀️',
          cloudy: '⛅',
          rainy: '🌧️',
          snowy: '❄️',
          foggy: '🌫️'
        };
        if (weatherIcon) {
          weatherIcon.textContent = iconMap[weather] || '🌤️';
        }
        weatherDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      weatherDropdown.classList.remove('open');
    });
  }

  renderJournalCalendar() {
    const grid = document.getElementById('journalCalendarGrid');
    const titleEl = document.getElementById('journalCalendarTitle');

    const date = this.selectedDate || new Date();
    const year = date.getFullYear();
    const month = date.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    titleEl.textContent = `${year}年${month + 1}月`;

    let html = '';

    for (let i = 0; i < startDay; i++) {
      html += `<div class="calendar-day empty"></div>`;
    }

    const today = new Date();
    const todayStr = utils.formatDateKey(today);
    const selectedStr = this.selectedDateStr;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = dateStr === todayStr;
      const isSelected = dateStr === selectedStr;
      const hasJournal = this.journalManager.hasJournalForDate(dateStr);

      let dayClass = 'journal-calendar-day';
      if (isToday) dayClass += ' today';
      if (isSelected) dayClass += ' selected';
      if (hasJournal) dayClass += ' has-journal';

      html += `<button class="${dayClass}" data-date="${dateStr}">${day}</button>`;
    }

    grid.innerHTML = html;

    grid.querySelectorAll('.journal-calendar-day').forEach(dayBtn => {
      dayBtn.addEventListener('click', () => {
        this.selectedDateStr = dayBtn.dataset.date;
        const [year, month, dayNum] = this.selectedDateStr.split('-').map(Number);
        this.selectedDate = new Date(year, month - 1, dayNum);
        this.renderJournalCalendar();
        this.loadJournalForDate(this.selectedDateStr);
      });
    });
  }

  loadJournalForDate(dateStr) {
    const journal = this.journalManager.getJournalByDate(dateStr);
    const contentEl = document.getElementById('journalContent');
    const dateTitleEl = document.getElementById('journalDetailDate');
    const wordCountEl = document.getElementById('journalWordCount');
    const weatherIconEl = document.getElementById('weatherIcon');

    const date = new Date(dateStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const weekday = weekdays[date.getDay()];
    
    if (dateTitleEl) {
      let dateTitle = `${month}月${day}日 ${weekday}`;
      // 只有当日志有内容时才显示创建者标签
      if (journal?.content && journal.content.trim()) {
        dateTitle += ' <span class="journal-creator-badge">' + XilianUI.renderCreatorBadge(journal.creator) + '</span>';
      }
      dateTitleEl.innerHTML = dateTitle;
    }

    if (contentEl) {
      contentEl.value = journal?.content || '';
      if (wordCountEl) {
        wordCountEl.textContent = `${(journal?.content?.length || 0)} 字`;
      }
    }

    const iconMap = {
      sunny: '☀️',
      cloudy: '⛅',
      rainy: '🌧️',
      snowy: '❄️',
      foggy: '🌫️'
    };
    if (weatherIconEl) {
      weatherIconEl.textContent = journal?.weather ? iconMap[journal.weather] || '🌤️' : '🌤️';
    }
    this.currentWeather = journal?.weather || '';
  }

  async saveJournalData() {
    const content = document.getElementById('journalContent').value.trim();
    const weatherIconEl = document.getElementById('weatherIcon');
    const iconMap = {
      '☀️': 'sunny',
      '⛅': 'cloudy',
      '🌧️': 'rainy',
      '❄️': 'snowy',
      '🌫️': 'foggy',
      '🌤️': ''
    };
    const weather = weatherIconEl ? iconMap[weatherIconEl.textContent] || '' : '';

    if (!content && !weather) {
      return;
    }

    const journal = {
      date: this.selectedDateStr,
      content: content,
      weather: weather,
      creator: XilianSettings._config?.aiUserName || '我'
    };

    try {
      await this.saveJournal(journal);
      this.renderJournalCalendar();
      this.showToast('日志保存成功');
    } catch (error) {
      alert('保存失败: ' + error.message);
    }
  }

  setupBudgetModal() {
    // 关闭按钮
    dom.get('closeBudgetModal').addEventListener('click', () => {
      this.closeBudgetModal();
    });

    // 取消按钮
    dom.get('cancelBudgetBtn').addEventListener('click', () => {
      this.hideBudgetDetail();
    });

    // 弹窗拖动功能
    this.setupModalDrag('budgetModal');

    // 分类预算设置按钮
    const editCategoryBtn = document.getElementById('editCategoryBudgetBtn');
    if (editCategoryBtn) {
      editCategoryBtn.addEventListener('click', () => {
        this.openBudgetModal();
      });
    }

    // 添加分类预算项
    dom.get('addCategoryBudgetBtn').addEventListener('click', () => {
      this.addCategoryBudgetItem();
    });

    // 创建新周期按钮
    dom.get('addNewCycleBtn').addEventListener('click', () => {
      this.createNewBudgetCycle();
    });

    // 取消编辑按钮
    dom.get('cancelEditBtn').addEventListener('click', () => {
      this.hideBudgetDetail();
    });

    // 保存按钮
    dom.get('saveBudgetBtn').addEventListener('click', async () => {
      const startDate = dom.get('budgetStartDate').value;
      const endDate = dom.get('budgetEndDate').value;
      const amount = parseFloat(dom.get('budgetAmount').value);

      // 验证总预算信息
      const errors = [];
      if (!startDate) errors.push('请选择预算开始日期');
      if (!endDate) errors.push('请选择预算结束日期');
      if (isNaN(amount) || amount <= 0) errors.push('请输入有效的总预算金额');
      
      // 收集分类预算
      const categoryBudgets = [];
      const container = document.getElementById('categoryBudgetItems');
      if (!container) {
        alert('错误：找不到分类预算容器');
        return;
      }
      
      const items = container.querySelectorAll('.category-budget-item');
      items.forEach((item, index) => {
        const category = item.querySelector('.category-select');
        const amountInput = item.querySelector('.category-budget-amount');
        
        if (category && amountInput) {
          const categoryValue = category.value;
          const catAmount = parseFloat(amountInput.value);
          
          if (categoryValue && !isNaN(catAmount) && catAmount > 0) {
            categoryBudgets.push({ category: categoryValue, amount: catAmount });
          }
        }
      });
      
      // 如果有错误，显示错误提示
      if (errors.length > 0) {
        alert('保存失败，原因：\n' + errors.join('\n'));
        return;
      }

      // 如果选中了某个预算周期，更新它；否则创建新的
      if (this.selectedBudgetIndex !== null && this.selectedBudgetIndex >= 0 && this.selectedBudgetIndex < this.budgets.length) {
        this.budgets[this.selectedBudgetIndex] = {
          startDate,
          endDate,
          amount,
          categoryBudgets
        };
      } else {
        this.budgets.push({
          startDate,
          endDate,
          amount,
          categoryBudgets
        });
      }

      // 保存所有预算（主进程会自动提取分类预算）
      const saveResult = await this.budgetManager.saveBudgets(this.budgets, this.selectedBudgetIndex);
      
      if (saveResult.success) {
        // 保存成功后隐藏详细区域，刷新列表
        this.hideBudgetDetail();
        await this.loadBudgets();
        this.renderBudgetCycleList();
        
        // 重新加载分类预算并刷新显示
        await this.loadCategoryBudgets();
        this.renderCategoryBudget();
        this.renderStatistics();
        
        // 关闭弹窗
        dom.get('budgetModal').style.display = 'none';
      } else {
        alert('保存失败: ' + (saveResult.message || '未知错误'));
      }
    });

    // 点击外部关闭
    dom.get('budgetModal').addEventListener('click', (e) => {
      if (e.target.id === 'budgetModal') {
        dom.get('budgetModal').style.display = 'none';
      }
    });
  }

  addCategoryBudgetItem(existingItem = null) {
    const container = dom.get('categoryBudgetItems');
    const categories = ['餐饮', '交通', '购物', '娱乐', '医疗', '教育', '居住', '通讯', '其他'];
    
    const item = document.createElement('div');
    item.className = 'category-budget-item';
    item.innerHTML = `
      <select class="category-select">
        ${categories.map(cat => `<option value="${cat}" ${existingItem?.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
      </select>
      <input type="number" class="category-budget-amount" placeholder="预算金额" step="0.01" value="${existingItem?.amount || ''}">
      <button class="remove-category-btn">×</button>
    `;
    
    item.querySelector('.remove-category-btn').addEventListener('click', () => {
      item.remove();
    });
    
    container.appendChild(item);
  }

  loadCategoryBudgetItems() {
    const container = dom.get('categoryBudgetItems');
    container.innerHTML = '';
    
    if (this.categoryBudgets && this.categoryBudgets.length > 0) {
      this.categoryBudgets.forEach(item => {
        this.addCategoryBudgetItem(item);
      });
    } else {
      this.addCategoryBudgetItem();
    }
  }

  closeBudgetModal() {
    const modal = dom.get('budgetModal');
    const content = modal.querySelector('.modal-content');
    
    // 重置弹窗位置
    content.style.left = '';
    content.style.top = '';
    
    // 关闭弹窗
    modal.style.display = 'none';
    
    // 重置选中状态
    this.selectedBudgetIndex = null;
  }

  showBudgetDetail() {
    dom.get('budgetDetailSection').style.display = 'block';
    dom.get('budgetModalFooter').style.display = 'flex';
  }

  hideBudgetDetail() {
    dom.get('budgetDetailSection').style.display = 'none';
    dom.get('budgetModalFooter').style.display = 'none';
    this.selectedBudgetIndex = null;
    this.renderBudgetCycleList();
  }

  createNewBudgetCycle() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    
    let defaultStart = `${year}-${month}-10`;
    let nextMonth = today.getMonth() + 2;
    let nextYear = year;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear++;
    }
    let defaultEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-10`;
    
    dom.get('budgetStartDate').value = defaultStart;
    dom.get('budgetEndDate').value = defaultEnd;
    dom.get('budgetAmount').value = '';
    
    const categoryItems = dom.get('categoryBudgetItems');
    categoryItems.innerHTML = '';
    this.addCategoryBudgetItem();
    
    this.selectedBudgetIndex = null;
    this.showBudgetDetail();
    this.renderBudgetCycleList();
  }

  clearBudgetForm() {
    dom.get('budgetStartDate').value = '';
    dom.get('budgetEndDate').value = '';
    dom.get('budgetAmount').value = '';
    
    const categoryItems = dom.get('categoryBudgetItems');
    categoryItems.innerHTML = '';
    this.addCategoryBudgetItem();
  }

  async renderBudgetCycleList() {
    const container = dom.get('budgetCycleList');
    
    if (!this.budgets || this.budgets.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div>暂无预算周期</div>
          <div class="empty-tip">点击下方按钮创建</div>
        </div>
      `;
      return;
    }

    let html = '';
    this.budgets.forEach((budget, index) => {
      const startDate = budget.startDate.split('T')[0] || budget.startDate.split(' ')[0] || budget.startDate;
      const endDate = budget.endDate.split('T')[0] || budget.endDate.split(' ')[0] || budget.endDate;
      const categoryCount = budget.categoryBudgets ? budget.categoryBudgets.length : 0;
      const isSelected = this.selectedBudgetIndex === index;
      html += `
        <div class="budget-cycle-item ${isSelected ? 'selected' : ''}" data-index="${index}">
          <div class="cycle-info">
            <div class="cycle-date">${startDate} ~ ${endDate}</div>
            <div class="cycle-amount">总预算: ¥${budget.amount.toFixed(2)}</div>
            ${categoryCount > 0 ? `<div class="cycle-category-count">已设置 ${categoryCount} 个预算分类</div>` : ''}
          </div>
          <div class="cycle-actions">
            <button class="cycle-edit-btn" data-index="${index}">编辑</button>
            <button class="cycle-category-btn" data-index="${index}">预算分类</button>
            <button class="cycle-delete-btn" data-index="${index}">删除</button>
          </div>
        </div>
      `;
    });
    
    container.innerHTML = html;

    // 添加点击选中事件
    container.querySelectorAll('.budget-cycle-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (!e.target.classList.contains('cycle-edit-btn') && 
            !e.target.classList.contains('cycle-category-btn') && 
            !e.target.classList.contains('cycle-delete-btn')) {
          const index = parseInt(item.dataset.index);
          this.selectBudgetCycle(index);
        }
      });
    });

    // 添加编辑事件
    container.querySelectorAll('.cycle-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.editBudgetCycle(index);
      });
    });

    // 添加分类预算按钮事件
    container.querySelectorAll('.cycle-category-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.editCategoryBudgetForCycle(index);
      });
    });

    // 添加删除事件
    container.querySelectorAll('.cycle-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const index = parseInt(e.target.dataset.index);
        await this.deleteBudgetCycle(index);
      });
    });
  }

  selectBudgetCycle(index) {
    this.selectedBudgetIndex = index;
    this.renderBudgetCycleList();
  }

  editBudgetCycle(index) {
    const budget = this.budgets[index];
    if (budget) {
      this.selectedBudgetIndex = index;
      dom.get('budgetStartDate').value = budget.startDate.split('T')[0] || budget.startDate.split(' ')[0] || budget.startDate;
      dom.get('budgetEndDate').value = budget.endDate.split('T')[0] || budget.endDate.split(' ')[0] || budget.endDate;
      dom.get('budgetAmount').value = budget.amount;
      
      // 加载该预算周期的分类预算
      const categoryItems = dom.get('categoryBudgetItems');
      categoryItems.innerHTML = '';
      
      if (budget.categoryBudgets && budget.categoryBudgets.length > 0) {
        budget.categoryBudgets.forEach(item => {
          this.addCategoryBudgetItem(item);
        });
      } else {
        this.addCategoryBudgetItem();
      }
      
      this.showBudgetDetail();
      this.renderBudgetCycleList();
    }
  }

  editCategoryBudgetForCycle(index) {
    this.editBudgetCycle(index);
  }

  async deleteBudgetCycle(index) {
    if (confirm('确定要删除这个预算周期吗？')) {
      const budget = this.budgets[index];
      if (budget) {
        let result;
        if (budget.id) {
          result = await this.budgetManager.deleteBudget(budget.id);
        } else {
          this.budgets.splice(index, 1);
          result = await this.budgetManager.saveBudgets(this.budgets, null);
        }
        if (result.success) {
          this.budgets = this.budgetManager.getBudgets();
          this.renderBudgetCycleList();
          await this.loadCategoryBudgets();
          this.renderCategoryBudget();
          this.renderStatistics();
        } else {
          alert('删除失败: ' + (result.message || '未知错误'));
        }
      }
    }
  }

  renderCategoryBudget() {
    const container = dom.get('categoryBudgetList');

    const checkDate = this.selectedDate ? new Date(this.selectedDate) : new Date();
    checkDate.setHours(0, 0, 0, 0);
    
    let currentBudget = null;
    let budgetStartDate = null;
    let budgetEndDate = null;
    
    if (this.budgets && this.budgets.length > 0) {
      for (const budget of this.budgets) {
        const startDate = utils.parseDate(budget.startDate);
        const endDate = utils.parseDate(budget.endDate);
        
        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          startDate.setHours(0, 0, 0, 0);
          endDate.setHours(23, 59, 59, 999);
          
          if (checkDate >= startDate && checkDate <= endDate) {
            currentBudget = budget;
            budgetStartDate = startDate;
            budgetEndDate = endDate;
            break;
          }
        }
      }
    }
    
    if (!currentBudget) {
      container.innerHTML = '<div class="empty-state-small">暂无有效预算周期</div>';
      return;
    }

    const categoryBudgets = currentBudget.categoryBudgets || [];
    
    if (categoryBudgets.length === 0) {
      container.innerHTML = '<div class="empty-state-small">暂无预算分类</div>';
      return;
    }

    let html = '';
    categoryBudgets.forEach(item => {
      const categoryExpenses = this.expenses.filter(e => {
        const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
        const expenseDate = new Date(normalizedDate);
        expenseDate.setHours(0, 0, 0, 0);
        return e.type === 'expense' && 
               (e.category === item.category || e.tag === item.category) &&
               expenseDate >= budgetStartDate && expenseDate <= budgetEndDate;
      });
      
      const spent = categoryExpenses.reduce((sum, e) => sum + e.amount, 0);
      const remaining = item.amount - spent;
      const percentage = item.amount > 0 ? Math.min(100, (spent / item.amount) * 100) : 0;
      const isOverBudget = percentage > 100;
      
      html += `
        <div class="category-budget-item-display">
          <div class="category-info">
            <span class="category-name">${item.category}</span>
            <span class="category-amount">¥${spent.toFixed(2)}/${item.amount.toFixed(2)}</span>
          </div>
          <div class="category-progress">
            <div class="category-progress-bar">
              <div class="category-progress-fill ${isOverBudget ? 'over-budget' : ''}" style="width: ${Math.min(100, percentage)}%"></div>
            </div>
          </div>
          <div class="category-remaining">${remaining >= 0 ? '剩余' : '超支'} ¥${Math.abs(remaining).toFixed(2)}</div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  changeDay(delta) {
    const currentDate = this.selectedDate || new Date();
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + delta);
    this.selectedDate = newDate;
    this.selectedDateStr = utils.formatDateKey(newDate);
    this.updateDateDisplay();
    this.renderDailyTasks();
    this.renderDailyTasksSection();
    this.renderDailyExpenses();
    this.renderStatistics();
  }

  updateDateDisplay() {
    const date = this.selectedDate || new Date();
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const weekday = weekdays[date.getDay()];
    
    const dateFullEl = document.getElementById('currentDateFull');
    const titleEl = document.getElementById('selectedDateTitle');
    
    if (dateFullEl) {
      dateFullEl.textContent = `${year}年${month}月${day}日 ${weekday}`;
    }
    
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    
    if (titleEl) {
      titleEl.textContent = isToday ? '今日' : `${month}月${day}日`;
    }
  }

  openDatePicker() {
    const date = this.selectedDate || new Date();
    this.currentYear = date.getFullYear();
    this.currentMonth = date.getMonth();
    this.renderDatePicker();
    
    const modal = document.getElementById('datePickerModal');
    const datePickerToggle = document.getElementById('datePickerToggle');
    
    if (modal && datePickerToggle) {
      setTimeout(() => {
        const rect = datePickerToggle.getBoundingClientRect();
        const pickerModal = modal.querySelector('.date-picker-modal');
        
        if (pickerModal) {
          const pickerWidth = pickerModal.offsetWidth;
          const pickerHeight = pickerModal.offsetHeight;
          let calculatedLeft = rect.left;
          let calculatedTop = rect.bottom + 8;
          
          const windowWidth = window.innerWidth;
          const windowHeight = window.innerHeight;
          
          if (calculatedLeft + pickerWidth > windowWidth) {
            calculatedLeft = windowWidth - pickerWidth - 16;
          }
          if (calculatedLeft < 16) {
            calculatedLeft = 16;
          }
          
          if (calculatedTop + pickerHeight > windowHeight) {
            calculatedTop = rect.top - pickerHeight - 8;
          }
          
          pickerModal.style.left = `${calculatedLeft}px`;
          pickerModal.style.top = `${calculatedTop}px`;
          pickerModal.style.transform = 'translateX(0)';
        }
        
        modal.style.display = 'flex';
      }, 50);
    }
  }

  closeDatePicker() {
    document.getElementById('datePickerModal').style.display = 'none';
  }

  renderDatePicker() {
    const grid = document.getElementById('datePickerGrid');
    const titleEl = document.getElementById('datePickerTitle');

    const firstDay = new Date(this.currentYear, this.currentMonth, 1);
    const lastDay = new Date(this.currentYear, this.currentMonth + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    titleEl.textContent = `${this.currentYear}年${this.currentMonth + 1}月`;

    let html = '';

    const prevMonthLastDay = new Date(this.currentYear, this.currentMonth, 0).getDate();
    for (let i = startDay - 1; i >= 0; i--) {
      const day = prevMonthLastDay - i;
      const prevMonth = this.currentMonth - 1 >= 0 ? this.currentMonth - 1 : 11;
      const prevYear = this.currentMonth - 1 >= 0 ? this.currentYear : this.currentYear - 1;
      const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      html += `<button class="date-picker-day other-month" data-date="${dateStr}">${day}</button>`;
    }

    const today = new Date();
    const todayStr = utils.formatDateKey(today);
    const selectedStr = this.selectedDateStr;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${this.currentYear}-${String(this.currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = dateStr === todayStr;
      const isSelected = dateStr === selectedStr;

      let dayClass = 'date-picker-day';
      if (isToday) dayClass += ' today';
      if (isSelected) dayClass += ' selected';

      html += `<button class="${dayClass}" data-date="${dateStr}">${day}</button>`;
    }

    const remainingCells = 42 - (startDay + daysInMonth);
    for (let day = 1; day <= remainingCells; day++) {
      const nextMonth = this.currentMonth + 1 <= 11 ? this.currentMonth + 1 : 0;
      const nextYear = this.currentMonth + 1 <= 11 ? this.currentYear : this.currentYear + 1;
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      html += `<button class="date-picker-day other-month" data-date="${dateStr}">${day}</button>`;
    }

    grid.innerHTML = html;

    grid.querySelectorAll('.date-picker-day').forEach(dayBtn => {
      dayBtn.addEventListener('click', () => {
        this.selectedDateStr = dayBtn.dataset.date;
        const [year, month, dayNum] = this.selectedDateStr.split('-').map(Number);
        this.selectedDate = new Date(year, month - 1, dayNum);
        this.closeDatePicker();
        this.updateDateDisplay();
        this.renderDailyTasks();
        this.renderDailyExpenses();
        this.renderStatistics();
        this.renderDateNav();
      });
    });
  }

  setupDatePickerNavigation() {
    document.getElementById('datePickerPrevYear').addEventListener('click', () => {
      this.currentYear--;
      this.renderDatePicker();
    });

    document.getElementById('datePickerPrevMonth').addEventListener('click', () => {
      this.currentMonth--;
      if (this.currentMonth < 0) {
        this.currentMonth = 11;
        this.currentYear--;
      }
      this.renderDatePicker();
    });

    document.getElementById('datePickerNextMonth').addEventListener('click', () => {
      this.currentMonth++;
      if (this.currentMonth > 11) {
        this.currentMonth = 0;
        this.currentYear++;
      }
      this.renderDatePicker();
    });

    document.getElementById('datePickerNextYear').addEventListener('click', () => {
      this.currentYear++;
      this.renderDatePicker();
    });

    document.getElementById('datePickerToday').addEventListener('click', () => {
      const today = new Date();
      this.selectedDateStr = utils.formatDateKey(today);
      this.selectedDate = today;
      this.closeDatePicker();
      this.updateDateDisplay();
      this.renderDailyTasks();
      this.renderDailyExpenses();
      this.renderStatistics();
    });

    document.getElementById('datePickerClose').addEventListener('click', () => {
      this.closeDatePicker();
    });

    document.getElementById('datePickerModal').addEventListener('click', (e) => {
      if (e.target.id === 'datePickerModal') {
        this.closeDatePicker();
      }
    });

    this.setupDateNavNavigation();
  }

  setupDateNavNavigation() {
    const prevBtn = document.getElementById('prevDayBtn');
    const nextBtn = document.getElementById('nextDayBtn');
    
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        this.navigateDate(-1);
      });
    }
    
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        this.navigateDate(1);
      });
    }
    
    this.setupLeftNav();
  }

  setupLeftNav() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const view = item.dataset.view;
        this.switchView(view);
      });
    });
  }

  switchView(view) {
    console.log('[switchView] start', view);
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => item.classList.remove('active'));
    const navTarget = document.querySelector(`[data-view="${view}"]`);
    if (navTarget) navTarget.classList.add('active');
    else console.warn('[switchView] nav item not found for', view);

    // 显式控制所有 view-panel 的显示/隐藏
    const viewPanels = document.querySelectorAll('.view-panel');
    viewPanels.forEach(panel => {
      panel.classList.remove('active');
      panel.style.display = 'none';
    });
    const targetPanel = document.getElementById(`${view}View`);
    if (targetPanel) {
      targetPanel.classList.add('active');
      targetPanel.style.display = 'flex';
      console.log('[switchView] activated panel', targetPanel.id, 'display=', getComputedStyle(targetPanel).display, 'size=', targetPanel.clientWidth, 'x', targetPanel.clientHeight);
      // MC 星图：canvas 用 innerWidth/innerHeight 兜底初始化，切到可见面板后需重新校准坐标
      if (view === 'memory') { setTimeout(() => window.dispatchEvent(new Event('resize')), 50); }
    } else {
      console.error('[switchView] target panel not found:', view + 'View');
    }

    // 切换 panel-header 右侧 + 按钮的可见性
    const addTaskBtn = document.getElementById('addTaskBtn');
    const addSecretBtn = document.getElementById('addSecretBtn');
    if (addTaskBtn) {
      addTaskBtn.style.display = view === 'tasks' ? 'flex' : 'none';
    }
    if (addSecretBtn) {
      addSecretBtn.style.display = view === 'secrets' ? 'flex' : 'none';
    }

    // 昔涟 / 星图视图时隐藏日期导航和右侧财务面板（星图独占整块区域）
    const panelHeader = document.querySelector('.panel-header');
    if (panelHeader) {
      panelHeader.style.display = (view === 'xilian' || view === 'memory') ? 'none' : '';
    }
    const financeSection = document.querySelector('.finance-section');
    if (financeSection) {
      financeSection.style.display = (view === 'xilian' || view === 'memory') ? 'none' : '';
    }

    // 星图模式：让 .main-content 独占除左侧导航外的整个区域
    const mainContainer = document.querySelector('.main-container');
    if (mainContainer) {
      mainContainer.classList.toggle('memory-mode', view === 'memory');
    }

    if (view === 'users') {
      this.loadUsersView();
    }
    
    if (view === 'journal') {
      this.renderJournalCalendar();
      this.loadJournalForDate(this.selectedDateStr);
    }
    
    if (view === 'xilian') {
      this.xilianManager.onViewActivated();
    }

    // 星图面板：首次显示时触发 canvas resize（MC main.js 已监听 window resize）
    if (view === 'memory') {
      // ★ 打开星图时刷新 AI 主星名（兜底：即便之前没触发，也能保证星图显示当前智能体）
      if (typeof mcUpdateAiStarName === 'function') mcUpdateAiStarName();
      setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 60);
    }
  }

  navigateDate(days) {
    const [year, month, day] = this.selectedDateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + days);
    this.selectedDate = date;
    this.selectedDateStr = utils.formatDateKey(date);
    this.updateDateDisplay();
    this.renderDailyTasks();
    this.renderDailyExpenses();
    this.renderStatistics();
    this.renderDateNav();
  }

  renderDateNav() {
    const dateNavDays = document.getElementById('dateNavDays');
    if (!dateNavDays) return;

    const today = new Date();
    const todayStr = utils.formatDateKey(today);
    const [selectedYear, selectedMonth, selectedDay] = this.selectedDateStr.split('-').map(Number);
    const selectedDate = new Date(selectedYear, selectedMonth - 1, selectedDay);

    let html = '';
    
    for (let i = -3; i <= 3; i++) {
      const date = new Date(selectedDate);
      date.setDate(date.getDate() + i);
      const dateStr = utils.formatDateKey(date);
      const dayNum = date.getDate();
      
      let dayClass = 'date-nav-day';
      if (dateStr === todayStr) dayClass += ' today';
      if (dateStr === this.selectedDateStr) dayClass += ' active';
      
      html += `<button class="${dayClass}" data-date="${dateStr}">${dayNum}</button>`;
    }
    
    dateNavDays.innerHTML = html;

    if (!this.dateNavListenerAttached) {
      dateNavDays.addEventListener('click', (e) => {
        const dayBtn = e.target.closest('.date-nav-day');
        if (dayBtn) {
          this.handleDateNavClick(dayBtn.dataset.date);
        }
      });
      this.dateNavListenerAttached = true;
    }
  }

  handleDateNavClick(dateStr) {
    if (this.dateNavDebounceTimer) {
      clearTimeout(this.dateNavDebounceTimer);
    }
    
    this.dateNavDebounceTimer = setTimeout(() => {
      this.selectedDateStr = dateStr;
      const [year, month, dayNum] = this.selectedDateStr.split('-').map(Number);
      this.selectedDate = new Date(year, month - 1, dayNum);
      this.updateDateDisplay();
      this.renderDailyTasks();
      this.renderDailyExpenses();
      this.renderStatistics();
      this.renderDateNav();
    }, 50);
  }

  async openBudgetModal() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    
    // 预填默认日期（从10号开始，下月10号结束）
    let defaultStart = `${year}-${month}-10`;
    let nextMonth = today.getMonth() + 2;
    let nextYear = year;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear++;
    }
    let defaultEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-10`;
    
    dom.get('budgetStartDate').value = defaultStart;
    dom.get('budgetEndDate').value = defaultEnd;
    dom.get('budgetAmount').value = '';
    dom.get('budgetModal').style.display = 'flex';
    
    // 渲染预算周期列表
    await this.loadBudgets();
    this.renderBudgetCycleList();
  }

  setupFinanceReportButton() {
    const financeReportBtn = dom.get('financeReportBtn');
    if (financeReportBtn) {
      financeReportBtn.addEventListener('click', () => {
        this.generateFinanceReport();
      });
    }
  }

  async generateFinanceReport() {
    const displayDate = this.selectedDate || new Date();
    
    let currentBudget = null;
    for (const budget of this.budgets) {
      const startDate = this.startOfDay(new Date(budget.startDate));
      const endDate = this.endOfDay(new Date(budget.endDate));
      
      if (displayDate >= startDate && displayDate <= endDate) {
        currentBudget = budget;
        break;
      }
    }

    if (!currentBudget) {
      alert('未找到当前日期所在的预算周期');
      return;
    }

    const startDate = this.startOfDay(new Date(currentBudget.startDate));
    const endDate = this.endOfDay(new Date(currentBudget.endDate));

    const periodIncomes = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate >= startDate && expenseDate <= endDate && e.type === 'income';
    });
    const totalIncome = periodIncomes.reduce((sum, e) => sum + e.amount, 0);

    const periodExpenses = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate >= startDate && expenseDate <= endDate && e.type === 'expense';
    });
    const totalExpense = periodExpenses.reduce((sum, e) => sum + e.amount, 0);

    const totalBudget = currentBudget.amount + totalIncome;
    const balance = totalBudget - totalExpense;

    const expenseByCategory = {};
    periodExpenses.forEach(e => {
      const category = e.category || '其他';
      if (!expenseByCategory[category]) {
        expenseByCategory[category] = 0;
      }
      expenseByCategory[category] += e.amount;
    });

    const incomeByCategory = {};
    periodIncomes.forEach(e => {
      const category = e.category || '其他';
      if (!incomeByCategory[category]) {
        incomeByCategory[category] = 0;
      }
      incomeByCategory[category] += e.amount;
    });

    const today = this.startOfDay(new Date());
    const occurredExpenses = periodExpenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate <= today;
    });
    const occurredExpenseTotal = occurredExpenses.reduce((sum, e) => sum + e.amount, 0);
    const remainingBudget = totalBudget - occurredExpenseTotal;

    const startDateStr = utils.formatDateKey(startDate);
    const endDateStr = utils.formatDateKey(endDate);

    const totalDays = this.getDaysInPeriod(startDate, endDate);
    const passedDays = this.getDaysPassed(startDate, displayDate);
    const remainingDays = Math.max(0, totalDays - passedDays);
    
    const currentBalance = totalBudget - totalExpense;
    const suggestedDailyBudget = Math.max(0, currentBalance / Math.max(1, remainingDays));
    
    const sevenDaysAgo = new Date(displayDate);
    sevenDaysAgo.setDate(displayDate.getDate() - 7);
    const weekExpenses = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate > sevenDaysAgo && expenseDate <= displayDate && e.type === 'expense';
    });
    const weekExpenseTotal = weekExpenses.reduce((sum, e) => sum + e.amount, 0);
    
    const fixedCategories = ['餐饮', '交通', '医疗', '教育', '居住'];
    const fixedExpenses = periodExpenses.filter(e => fixedCategories.includes(e.category || ''));
    const fixedExpenseTotal = fixedExpenses.reduce((sum, e) => sum + e.amount, 0);
    
    const fixedDailyAverage = fixedExpenseTotal / Math.max(1, passedDays);
    const predictedEndingBalance = totalBudget - (totalExpense + fixedDailyAverage * remainingDays);

    let reportContent = `# 用户财务数据\n`;
    reportContent += `===== 以下为原始数据，请勿修改 =====\n\n`;
    
    reportContent += `预算周期：${startDateStr} 至 ${endDateStr}\n`;
    reportContent += `基准预算：${currentBudget.amount.toFixed(2)} 元\n`;
    reportContent += `周期内总收入：${totalIncome.toFixed(2)} 元\n`;
    reportContent += `总预算：${totalBudget.toFixed(2)} 元\n`;
    reportContent += `已支出总额：${totalExpense.toFixed(2)} 元\n`;
    reportContent += `当前结余：${currentBalance.toFixed(2)} 元\n`;
    reportContent += `剩余天数：${remainingDays} 天\n`;
    reportContent += `今日建议预算：${suggestedDailyBudget.toFixed(2)} 元/天\n`;
    reportContent += `本周结余：${(totalBudget / totalDays * 7 - weekExpenseTotal).toFixed(2)} 元\n`;
    reportContent += `预计期末结余：${predictedEndingBalance.toFixed(2)} 元（按周期平均日支出计算：${totalExpense.toFixed(2)}/${passedDays} × ${remainingDays}）\n\n`;
    
    reportContent += `支出分类汇总：\n`;
    if (Object.keys(expenseByCategory).length > 0) {
      Object.entries(expenseByCategory).forEach(([category, amount]) => {
        const percentage = (amount / totalExpense * 100).toFixed(1);
        reportContent += `- ${category}: ${amount.toFixed(2)} 元 (${percentage}%)\n`;
      });
    } else {
      reportContent += `- 暂无支出记录\n`;
    }
    reportContent += `\n`;
    
    reportContent += `详细收支流水（按日期倒序）：\n`;
    const allPeriodTransactions = [...periodIncomes, ...periodExpenses];
    allPeriodTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (allPeriodTransactions.length > 0) {
      allPeriodTransactions.forEach(e => {
        const type = e.type === 'income' ? '收入' : '支出';
        reportContent += `${e.date} ${type} ${e.amount.toFixed(2)} 元 ${e.category || '其他'} ${e.detail || ''}\n`;
      });
    } else {
      reportContent += `暂无收支记录\n`;
    }
    reportContent += `\n`;
    
    reportContent += `# 角色设定\n`;
    reportContent += `你是一位专业的财务分析师，擅长从个人收支数据中发现问题、总结规律，并提供具体、可执行的改善建议。你的分析风格客观、直接，不夸大也不含糊。\n\n`;
    
    reportContent += `# 输入数据说明\n`;
    reportContent += `以下是用户某预算周期的完整财务统计文档，请根据数据进行分析。\n\n`;
    
    reportContent += `# 你的任务\n`;
    reportContent += `请根据数据完成以下分析：\n`;
    reportContent += `1. 总体健康度评估（当前结余、预测期末结余、是否在预算内）\n`;
    reportContent += `2. 支出结构分析（占比过高的类别、非必要支出、固定与弹性比例）\n`;
    reportContent += `3. 异常或值得注意的流水（大额消费、习惯性小额消费）\n`;
    reportContent += `4. 改进建议（分优先级：立即停止、优化替换、长期调整）\n`;
    reportContent += `5. 具体行动计划（带数字的可行性方案）\n\n`;
    
    reportContent += `# 输出格式\n`;
    reportContent += `使用标题分段，关键数字加粗，建议用编号列表。语气平和，重点在"如何改善"。\n`;

    const memo = {
      id: null,
      title: `财务报告 - ${startDateStr} 至 ${endDateStr}`,
      content: reportContent,
      htmlContent: reportContent,
      isPrivate: false,
      creator: XilianSettings._config?.aiUserName || '我'
    };

    await this.memoManager.saveMemo(memo);
    alert('财务报告已生成并保存到备忘录！');
  }

  setupWindowControls() {
    const minimizeBtn = document.getElementById('minimizeBtn');
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => ipcRenderer.invoke('window-minimize'));
    }

    const maximizeBtn = document.getElementById('maximizeBtn');
    if (maximizeBtn) {
      maximizeBtn.addEventListener('click', () => ipcRenderer.invoke('window-maximize'));
    }

    const closeBtn = document.getElementById('closeBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => ipcRenderer.invoke('window-close'));
    }

    const scheduleIcon = document.getElementById('scheduleIcon');
    if (scheduleIcon) {
      scheduleIcon.addEventListener('click', async () => {
        try {
          const result = await ipcRenderer.invoke('sync-to-cloud');
          if (result.success) {
            alert(result.message);
          }
        } catch (e) {
          alert('同步出错：' + e.message);
        }
      });
    }

    this.setupActionButton();
  }

  setupActionButton() {
    document.getElementById('navSettingsBtn')?.addEventListener('click', () => {
      this.openSettingsModal();
    });

    document.getElementById('navRestartBtn')?.addEventListener('click', async () => {
      if (confirm('确定要重启应用吗？')) {
        try {
          await ipcRenderer.invoke('restart-app');
        } catch (e) {
          alert('重启出错：' + e.message);
        }
      }
    });

    // ★ 刷新按钮：通过微型窗口触发主窗口焦点周期，修复删除数据后输入框无法聚焦的问题
    document.getElementById('navRefreshBtn')?.addEventListener('click', async () => {
      await ipcRenderer.invoke('refresh-window-focus');
    });

    document.getElementById('addTaskBtn')?.addEventListener('click', () => {
      this.openTaskModal();
    });

    const actionBtn = document.getElementById('actionBtn');
    const dropdownMenu = document.getElementById('actionDropdownMenu');
    
    if (actionBtn && dropdownMenu) {
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownMenu.classList.toggle('show');
      });

      document.addEventListener('click', (e) => {
        if (!actionBtn.contains(e.target) && !dropdownMenu.contains(e.target)) {
          dropdownMenu.classList.remove('show');
        }
      });

      document.getElementById('menuTask')?.addEventListener('click', () => {
        dropdownMenu.classList.remove('show');
        this.openTaskModal();
      });

      document.getElementById('menuExpense')?.addEventListener('click', () => {
        dropdownMenu.classList.remove('show');
        this.openExpenseModal();
      });

      document.getElementById('menuRestart')?.addEventListener('click', async () => {
        dropdownMenu.classList.remove('show');
        if (confirm('确定要重启应用吗？')) {
          try {
            await ipcRenderer.invoke('restart-app');
          } catch (e) {
            alert('重启出错：' + e.message);
          }
        }
      });

      document.getElementById('menuSettings')?.addEventListener('click', () => {
        dropdownMenu.classList.remove('show');
        this.openSettingsModal();
      });
    }

    this.themeManager.loadTheme();
    this.themeManager.loadCardOpacitySettings();
  }

  

  openSettingsModal() {
    this.settingsManager.openSettingsModal();
  }
  
  switchSettingsPanel(section) {
    document.querySelectorAll('.sidebar-item').forEach(item => {
      item.classList.remove('active');
    });
    document.querySelector(`[data-section="${section}"]`).classList.add('active');

    document.querySelectorAll('.settings-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    document.getElementById(`settings${section.charAt(0).toUpperCase() + section.slice(1)}`).classList.add('active');

    if (section === 'finance') {
      this.settingsManager.loadFinanceStats();
    }

    if (section === 'elysia') {
      if (typeof XilianSettings !== 'undefined' && XilianSettings.onPanelActivated) {
        XilianSettings.onPanelActivated();
      }
      this.settingsManager.setupChatRoomPresetsUI();
    }
    
    if (section === 'cloud') {
      console.log('[DEBUG] switchSettingsPanel: cloud section');
      this.settingsManager.loadVersionInfo();
      this.settingsManager.loadCloudUserList();
      this.settingsManager.loadCurrentCloudUser();
      this.settingsManager.setupCloudUserManagement();
    }
  }

  

  async saveCurrentSettings() {
    try {
      const settings = await ipcRenderer.invoke('get-settings');
      this.settingsManager.savedTheme = settings.theme || 'light';
      this.themeManager.savedTaskOpacity = settings.taskCardOpacity || '80';
      this.themeManager.savedExpenseOpacity = settings.expenseCardOpacity || '80';
      this.themeManager.savedFinanceOpacity = settings.financeCardOpacity || '80';
    } catch {
      this.settingsManager.savedTheme = 'light';
      this.themeManager.savedTaskOpacity = '80';
      this.themeManager.savedExpenseOpacity = '80';
      this.themeManager.savedFinanceOpacity = '80';
    }
    
    try {
      const cloudConfig = await ipcRenderer.invoke('cloud-sync-get-config');
      this.settingsManager.savedAutoSync = cloudConfig.autoSync || false;
      this.settingsManager.savedSyncInterval = cloudConfig.syncInterval || 10;
    } catch {
      this.settingsManager.savedAutoSync = false;
      this.settingsManager.savedSyncInterval = 10;
    }
  }

  closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const content = modal.querySelector('.modal-content');
    
    modal.classList.remove('show');
    
    setTimeout(() => {
      content.style.left = '50%';
      content.style.top = '50%';
      content.style.transform = 'translate(-50%, -50%)';
      content.style.width = '600px';
      content.style.height = 'auto';
    }, 300);
    
    this.settingsManager.restoreSettings();
  }

  restoreSettings() {
    this.themeManager.toggleDarkMode(this.settingsManager.savedTheme === 'dark');
    document.getElementById('taskCardOpacity').value = this.themeManager.savedTaskOpacity;
    document.getElementById('taskCardOpacityValue').textContent = this.themeManager.savedTaskOpacity + '%';
    document.getElementById('expenseCardOpacity').value = this.themeManager.savedExpenseOpacity;
    document.getElementById('expenseCardOpacityValue').textContent = this.themeManager.savedExpenseOpacity + '%';
    document.getElementById('financeCardOpacity').value = this.themeManager.savedFinanceOpacity;
    document.getElementById('financeCardOpacityValue').textContent = this.themeManager.savedFinanceOpacity + '%';
    this.themeManager.applyCardOpacity();
    
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    if (autoSyncToggle) {
      autoSyncToggle.checked = this.settingsManager.savedAutoSync || false;
    }
    const autoSyncInterval = document.getElementById('autoSyncInterval');
    if (autoSyncInterval) {
      autoSyncInterval.value = this.settingsManager.savedSyncInterval || 10;
      document.getElementById('autoSyncIntervalValue').textContent = this.settingsManager.savedSyncInterval || 10;
    }
  }

  async saveSettings() {
    const themeMode = document.querySelector('input[name="themeMode"]:checked').value;
    const taskOpacity = document.getElementById('taskCardOpacity').value;
    const expenseOpacity = document.getElementById('expenseCardOpacity').value;
    const financeOpacity = document.getElementById('financeCardOpacity').value;
    const calendarOpacity = document.getElementById('calendarOpacity').value;
    const budgetOpacity = document.getElementById('budgetOpacity').value;
    const secretOpacity = document.getElementById('secretCardOpacity').value;
    
    const darkBackgroundImage = this.themeManager.savedDarkBackgroundImage || '';
    const darkBackgroundPositionX = document.getElementById('darkBackgroundPositionX').value;
    const darkBackgroundPositionY = document.getElementById('darkBackgroundPositionY').value;
    const darkBackgroundSizeWidth = document.getElementById('darkBackgroundSizeWidth').value;
    const darkBackgroundOpacity = document.getElementById('darkBackgroundOpacity').value;
    const darkOverlayColor = document.getElementById('darkOverlayColor').value;
    const darkOverlayOpacity = document.getElementById('darkOverlayOpacity').value;
    const darkInvert = document.querySelector('input[name="darkInvert"]:checked').value;
    
    const lightBackgroundImage = this.themeManager.savedLightBackgroundImage || '';
    const lightBackgroundPositionX = document.getElementById('lightBackgroundPositionX').value;
    const lightBackgroundPositionY = document.getElementById('lightBackgroundPositionY').value;
    const lightBackgroundSizeWidth = document.getElementById('lightBackgroundSizeWidth').value;
    const lightBackgroundOpacity = document.getElementById('lightBackgroundOpacity').value;
    const lightOverlayColor = document.getElementById('lightOverlayColor').value;
    const lightOverlayOpacity = document.getElementById('lightOverlayOpacity').value;
    const lightInvert = document.querySelector('input[name="lightInvert"]:checked').value;
    
    try {
      await ipcRenderer.invoke('save-settings', {
        theme: themeMode,
        taskCardOpacity: taskOpacity,
        expenseCardOpacity: expenseOpacity,
        financeCardOpacity: financeOpacity,
        calendarOpacity: calendarOpacity,
        budgetOpacity: budgetOpacity,
        secretCardOpacity: secretOpacity,
        darkBackgroundImage: darkBackgroundImage ? encodeURIComponent(darkBackgroundImage) : '',
        darkBackgroundPositionX: darkBackgroundPositionX,
        darkBackgroundPositionY: darkBackgroundPositionY,
        darkBackgroundSizeWidth: darkBackgroundSizeWidth,
        darkBackgroundOpacity: darkBackgroundOpacity,
        darkOverlayColor: darkOverlayColor,
        darkOverlayOpacity: darkOverlayOpacity,
        darkInvert: darkInvert,
        lightBackgroundImage: lightBackgroundImage ? encodeURIComponent(lightBackgroundImage) : '',
        lightBackgroundPositionX: lightBackgroundPositionX,
        lightBackgroundPositionY: lightBackgroundPositionY,
        lightBackgroundSizeWidth: lightBackgroundSizeWidth,
        lightBackgroundOpacity: lightBackgroundOpacity,
        lightOverlayColor: lightOverlayColor,
        lightOverlayOpacity: lightOverlayOpacity,
        lightInvert: lightInvert
      });
    } catch {
      console.error('保存设置失败');
    }
    
    await this.settingsManager.saveCloudConfigSilently();
  }

  async saveCloudConfigSilently() {
    try {
      const cloudAppId = document.getElementById('cloudAppId');
      const cloudAppKey = document.getElementById('cloudAppKey');
      const cloudAppSecret = document.getElementById('cloudAppSecret');
      
      if (!cloudAppId || !cloudAppKey || !cloudAppSecret) {
        return;
      }
      
      const autoSyncToggle = document.getElementById('autoSyncToggle');
      const autoSyncInterval = document.getElementById('autoSyncInterval');
      
      const config = {
        appId: cloudAppId.value,
        appKey: cloudAppKey.value,
        appSecret: cloudAppSecret.value,
        autoSync: autoSyncToggle ? autoSyncToggle.checked : false,
        syncInterval: autoSyncInterval ? parseInt(autoSyncInterval.value) : 10,
        token: this.settingsManager.savedCloudToken || '',
        refreshToken: this.settingsManager.savedCloudRefreshToken || '',
        tokenExpireTime: this.settingsManager.savedCloudTokenExpireTime || 0
      };
      
      const result = await ipcRenderer.invoke('cloud-sync-save-config', config);
      if (result.success) {
        this.settingsManager.saveCloudConfigToCache(config);
      }
    } catch (e) {
      console.error('自动保存云同步配置失败:', e);
    }
  }

  async saveSettings() {
    const themeMode = document.querySelector('input[name="themeMode"]:checked').value;
    const taskOpacity = document.getElementById('taskCardOpacity').value;
    const expenseOpacity = document.getElementById('expenseCardOpacity').value;
    const financeOpacity = document.getElementById('financeCardOpacity').value;
    const calendarOpacity = document.getElementById('calendarOpacity').value;
    const budgetOpacity = document.getElementById('budgetOpacity').value;
    const secretOpacity = document.getElementById('secretCardOpacity').value;
    
    const darkBackgroundImage = this.themeManager.savedDarkBackgroundImage || '';
    const darkBackgroundPositionX = document.getElementById('darkBackgroundPositionX').value;
    const darkBackgroundPositionY = document.getElementById('darkBackgroundPositionY').value;
    const darkBackgroundSizeWidth = document.getElementById('darkBackgroundSizeWidth').value;
    const darkBackgroundOpacity = document.getElementById('darkBackgroundOpacity').value;
    const darkOverlayColor = document.getElementById('darkOverlayColor').value;
    const darkOverlayOpacity = document.getElementById('darkOverlayOpacity').value;
    const darkInvert = document.querySelector('input[name="darkInvert"]:checked').value;
    
    const lightBackgroundImage = this.themeManager.savedLightBackgroundImage || '';
    const lightBackgroundPositionX = document.getElementById('lightBackgroundPositionX').value;
    const lightBackgroundPositionY = document.getElementById('lightBackgroundPositionY').value;
    const lightBackgroundSizeWidth = document.getElementById('lightBackgroundSizeWidth').value;
    const lightBackgroundOpacity = document.getElementById('lightBackgroundOpacity').value;
    const lightOverlayColor = document.getElementById('lightOverlayColor').value;
    const lightOverlayOpacity = document.getElementById('lightOverlayOpacity').value;
    const lightInvert = document.querySelector('input[name="lightInvert"]:checked').value;
    
    try {
      await ipcRenderer.invoke('save-settings', {
        theme: themeMode,
        taskCardOpacity: taskOpacity,
        expenseCardOpacity: expenseOpacity,
        financeCardOpacity: financeOpacity,
        calendarOpacity: calendarOpacity,
        budgetOpacity: budgetOpacity,
        secretCardOpacity: secretOpacity,
        darkBackgroundImage: darkBackgroundImage ? encodeURIComponent(darkBackgroundImage) : '',
        darkBackgroundPositionX: darkBackgroundPositionX,
        darkBackgroundPositionY: darkBackgroundPositionY,
        darkBackgroundSizeWidth: darkBackgroundSizeWidth,
        darkBackgroundOpacity: darkBackgroundOpacity,
        darkOverlayColor: darkOverlayColor,
        darkOverlayOpacity: darkOverlayOpacity,
        darkInvert: darkInvert,
        lightBackgroundImage: lightBackgroundImage ? encodeURIComponent(lightBackgroundImage) : '',
        lightBackgroundPositionX: lightBackgroundPositionX,
        lightBackgroundPositionY: lightBackgroundPositionY,
        lightBackgroundSizeWidth: lightBackgroundSizeWidth,
        lightBackgroundOpacity: lightBackgroundOpacity,
        lightOverlayColor: lightOverlayColor,
        lightOverlayOpacity: lightOverlayOpacity,
        lightInvert: lightInvert
      });
    } catch {
      console.error('保存设置失败');
    }
    
    await this.settingsManager.saveCloudConfigSilently();
    
    this.settingsManager.savedTheme = themeMode;
    this.themeManager.savedTaskOpacity = taskOpacity;
    this.themeManager.savedExpenseOpacity = expenseOpacity;
    this.themeManager.savedFinanceOpacity = financeOpacity;
    this.themeManager.savedCalendarOpacity = calendarOpacity;
    this.themeManager.savedBudgetOpacity = budgetOpacity;
    
    this.themeManager.savedDarkBackgroundImage = darkBackgroundImage;
    this.themeManager.savedDarkBackgroundPositionX = darkBackgroundPositionX;
    this.themeManager.savedDarkBackgroundPositionY = darkBackgroundPositionY;
    this.themeManager.savedDarkBackgroundSizeWidth = darkBackgroundSizeWidth;
    this.themeManager.savedDarkBackgroundOpacity = darkBackgroundOpacity;
    this.themeManager.savedDarkOverlayColor = darkOverlayColor;
    this.themeManager.savedDarkOverlayOpacity = darkOverlayOpacity;
    this.themeManager.savedDarkInvert = darkInvert;
    
    this.themeManager.savedLightBackgroundImage = lightBackgroundImage;
    this.themeManager.savedLightBackgroundPositionX = lightBackgroundPositionX;
    this.themeManager.savedLightBackgroundPositionY = lightBackgroundPositionY;
    this.themeManager.savedLightBackgroundSizeWidth = lightBackgroundSizeWidth;
    this.themeManager.savedLightBackgroundOpacity = lightBackgroundOpacity;
    this.themeManager.savedLightOverlayColor = lightOverlayColor;
    this.themeManager.savedLightOverlayOpacity = lightOverlayOpacity;
    this.themeManager.savedLightInvert = lightInvert;
    
    this.themeManager.applyBackgroundSettings();
    this.themeManager.applyCardOpacity();
    
    const modal = document.getElementById('settingsModal');
    modal.classList.remove('show');
    const content = modal.querySelector('.modal-content');
    content.style.left = '50%';
    content.style.top = '50%';
  }

  async saveBackgroundSettings() {
    try {
      const themeMode = document.querySelector('input[name="themeMode"]:checked').value;
      const taskOpacity = document.getElementById('taskCardOpacity').value;
      const expenseOpacity = document.getElementById('expenseCardOpacity').value;
      const financeOpacity = document.getElementById('financeCardOpacity').value;
      const calendarOpacity = document.getElementById('calendarOpacity').value;
      const budgetOpacity = document.getElementById('budgetOpacity').value;
      const secretOpacity = document.getElementById('secretCardOpacity').value;
      
      const darkBackgroundPositionX = document.getElementById('darkBackgroundPositionX').value;
      const darkBackgroundPositionY = document.getElementById('darkBackgroundPositionY').value;
      const darkBackgroundSizeWidth = document.getElementById('darkBackgroundSizeWidth').value;
      const darkBackgroundOpacity = document.getElementById('darkBackgroundOpacity').value;
      const darkOverlayColor = document.getElementById('darkOverlayColor').value;
      const darkOverlayOpacity = document.getElementById('darkOverlayOpacity').value;
      const darkInvert = document.querySelector('input[name="darkInvert"]:checked').value;
      
      const lightBackgroundPositionX = document.getElementById('lightBackgroundPositionX').value;
      const lightBackgroundPositionY = document.getElementById('lightBackgroundPositionY').value;
      const lightBackgroundSizeWidth = document.getElementById('lightBackgroundSizeWidth').value;
      const lightBackgroundOpacity = document.getElementById('lightBackgroundOpacity').value;
      const lightOverlayColor = document.getElementById('lightOverlayColor').value;
      const lightOverlayOpacity = document.getElementById('lightOverlayOpacity').value;
      const lightInvert = document.querySelector('input[name="lightInvert"]:checked').value;

      await ipcRenderer.invoke('save-settings', {
        theme: themeMode,
        taskCardOpacity: taskOpacity,
        expenseCardOpacity: expenseOpacity,
        financeCardOpacity: financeOpacity,
        calendarOpacity: calendarOpacity,
        budgetOpacity: budgetOpacity,
        secretCardOpacity: secretOpacity,
        darkBackgroundImage: this.themeManager.savedDarkBackgroundImage ? encodeURIComponent(this.themeManager.savedDarkBackgroundImage) : '',
        darkBackgroundPositionX: darkBackgroundPositionX,
        darkBackgroundPositionY: darkBackgroundPositionY,
        darkBackgroundSizeWidth: darkBackgroundSizeWidth,
        darkBackgroundOpacity: darkBackgroundOpacity,
        darkOverlayColor: darkOverlayColor,
        darkOverlayOpacity: darkOverlayOpacity,
        darkInvert: darkInvert,
        lightBackgroundImage: this.themeManager.savedLightBackgroundImage ? encodeURIComponent(this.themeManager.savedLightBackgroundImage) : '',
        lightBackgroundPositionX: lightBackgroundPositionX,
        lightBackgroundPositionY: lightBackgroundPositionY,
        lightBackgroundSizeWidth: lightBackgroundSizeWidth,
        lightBackgroundOpacity: lightBackgroundOpacity,
        lightOverlayColor: lightOverlayColor,
        lightOverlayOpacity: lightOverlayOpacity,
        lightInvert: lightInvert
      });

      this.themeManager.savedDarkBackgroundPositionX = darkBackgroundPositionX;
      this.themeManager.savedDarkBackgroundPositionY = darkBackgroundPositionY;
      this.themeManager.savedDarkBackgroundSizeWidth = darkBackgroundSizeWidth;
      this.themeManager.savedDarkBackgroundOpacity = darkBackgroundOpacity;
      this.themeManager.savedDarkOverlayColor = darkOverlayColor;
      this.themeManager.savedDarkOverlayOpacity = darkOverlayOpacity;
      this.themeManager.savedDarkInvert = darkInvert;
      
      this.themeManager.savedLightBackgroundPositionX = lightBackgroundPositionX;
      this.themeManager.savedLightBackgroundPositionY = lightBackgroundPositionY;
      this.themeManager.savedLightBackgroundSizeWidth = lightBackgroundSizeWidth;
      this.themeManager.savedLightBackgroundOpacity = lightBackgroundOpacity;
      this.themeManager.savedLightOverlayColor = lightOverlayColor;
      this.themeManager.savedLightOverlayOpacity = lightOverlayOpacity;
      this.themeManager.savedLightInvert = lightInvert;
    } catch {
      console.error('保存背景设置失败');
    }
  }

  previewThemeChange(isDark) {
    const root = document.documentElement;
    const titleEl = document.querySelector('.titlebar-title');
    const isTest = window.isTestVersion === true;
    
    if (isDark) {
      root.classList.add('dark-mode');
      if (titleEl) {
        titleEl.textContent = isTest ? 'Philia Beta' : 'Philia';
      }
    } else {
      root.classList.remove('dark-mode');
      if (titleEl) {
        titleEl.textContent = isTest ? 'Elysia Beta' : 'Elysia';
      }
    }
    this.themeManager.applyBackgroundSettings();
  }

  previewCardOpacity() {
    const taskOpacity = document.getElementById('taskCardOpacity').value / 100;
    const expenseOpacity = document.getElementById('expenseCardOpacity').value / 100;
    const financeOpacity = document.getElementById('financeCardOpacity').value / 100;
    const calendarOpacity = document.getElementById('calendarOpacity').value / 100;
    const budgetOpacity = document.getElementById('budgetOpacity').value / 100;
    const secretOpacity = document.getElementById('secretCardOpacity').value / 100;
    
    document.documentElement.style.setProperty('--task-card-opacity', taskOpacity);
    document.documentElement.style.setProperty('--expense-card-opacity', expenseOpacity);
    document.documentElement.style.setProperty('--finance-card-opacity', financeOpacity);
    document.documentElement.style.setProperty('--calendar-opacity', calendarOpacity);
    document.documentElement.style.setProperty('--budget-opacity', budgetOpacity);
    document.documentElement.style.setProperty('--secret-card-opacity', secretOpacity);
    
    document.querySelectorAll('.task-card, .task-group').forEach(card => {
      card.style.opacity = taskOpacity;
    });
    
    document.querySelectorAll('.expense-item, .expenses-list .item-card.expense-card').forEach(card => {
      card.style.opacity = expenseOpacity;
    });
    
    document.querySelectorAll('.statistics-panel').forEach(panel => {
      panel.style.opacity = financeOpacity;
    });
    
    document.querySelectorAll('.expenses-calendar-section, .calendar-grid, .calendar-weekdays').forEach(calendar => {
      calendar.style.opacity = calendarOpacity;
    });
    
    document.querySelectorAll('.category-budget-panel, .category-budget-list, .category-budget-item-display').forEach(budget => {
      budget.style.opacity = budgetOpacity;
    });
    
    document.querySelectorAll('.secret-card').forEach(card => {
      card.style.opacity = secretOpacity;
    });
  }

  saveCardOpacitySettings() {
  }

  setupAddButton() {
    const addBtn = document.getElementById('addBtn');
    
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this.openTaskModal();
      });
    }
  }

  setupModals() {
    this.setupTaskModal();
    this.setupExpenseModal();
    this.setupSettingsModal();
    this.setupSecretModal();
  }

  setupSettingsModal() {
    document.getElementById('closeSettingsModal').addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('cancelSettingsBtn').addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.settingsManager.saveSettings());
    document.getElementById('settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') this.closeSettingsModal();
    });
    
    document.getElementById('taskCardOpacity').addEventListener('input', (e) => {
      document.getElementById('taskCardOpacityValue').textContent = e.target.value + '%';
      this.themeManager.previewCardOpacity();
    });
    
    document.getElementById('expenseCardOpacity').addEventListener('input', (e) => {
      document.getElementById('expenseCardOpacityValue').textContent = e.target.value + '%';
      this.themeManager.previewCardOpacity();
    });
    
    document.getElementById('financeCardOpacity').addEventListener('input', (e) => {
      document.getElementById('financeCardOpacityValue').textContent = e.target.value + '%';
      this.themeManager.previewCardOpacity();
    });
    
    document.getElementById('calendarOpacity').addEventListener('input', (e) => {
      document.getElementById('calendarOpacityValue').textContent = e.target.value + '%';
      this.themeManager.previewCardOpacity();
    });
    
    document.getElementById('budgetOpacity').addEventListener('input', (e) => {
      document.getElementById('budgetOpacityValue').textContent = e.target.value + '%';
      this.themeManager.previewCardOpacity();
    });
    
    document.getElementById('secretCardOpacity').addEventListener('input', (e) => {
      document.getElementById('secretCardOpacityValue').textContent = e.target.value + '%';
      this.themeManager.previewCardOpacity();
    });
    
    document.getElementById('selectDarkBackgroundBtn').addEventListener('click', () => {
      document.getElementById('darkBackgroundImageInput').click();
    });
    
    document.getElementById('darkBackgroundImageInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        let imagePath = file.path;
        imagePath = imagePath.replace(/\\/g, '/');
        this.themeManager.savedDarkBackgroundImage = imagePath;
        this.themeManager.applyBackgroundSettings();
        document.getElementById('darkCurrentBackgroundPath').textContent = file.path;
        this.themeManager.saveBackgroundSettings();
      }
    });
    
    document.getElementById('selectLightBackgroundBtn').addEventListener('click', () => {
      document.getElementById('lightBackgroundImageInput').click();
    });
    
    document.getElementById('lightBackgroundImageInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        let imagePath = file.path;
        imagePath = imagePath.replace(/\\/g, '/');
        this.themeManager.savedLightBackgroundImage = imagePath;
        this.themeManager.applyBackgroundSettings();
        document.getElementById('lightCurrentBackgroundPath').textContent = file.path;
        this.themeManager.saveBackgroundSettings();
      }
    });

    document.getElementById('clearDarkBackgroundBtn').addEventListener('click', () => {
      this.themeManager.savedDarkBackgroundImage = '';
      this.themeManager.applyBackgroundSettings();
      document.getElementById('darkCurrentBackgroundPath').textContent = '未设置背景图';
      document.getElementById('darkBackgroundImageInput').value = '';
      this.themeManager.saveBackgroundSettings();
    });

    document.getElementById('clearLightBackgroundBtn').addEventListener('click', () => {
      this.themeManager.savedLightBackgroundImage = '';
      this.themeManager.applyBackgroundSettings();
      document.getElementById('lightCurrentBackgroundPath').textContent = '未设置背景图';
      document.getElementById('lightBackgroundImageInput').value = '';
      this.themeManager.saveBackgroundSettings();
    });

    document.getElementById('resetBackgroundBtn').addEventListener('click', () => {
      this.themeManager.savedDarkBackgroundImage = '';
      this.themeManager.savedDarkBackgroundPositionX = '50';
      this.themeManager.savedDarkBackgroundPositionY = '100';
      this.themeManager.savedDarkBackgroundSizeWidth = '70';
      this.themeManager.savedDarkBackgroundOpacity = '100';
      this.themeManager.savedDarkOverlayColor = '#000000';
      this.themeManager.savedDarkOverlayOpacity = '0';
      this.themeManager.savedDarkInvert = 'invert';
      
      this.themeManager.savedLightBackgroundImage = '';
      this.themeManager.savedLightBackgroundPositionX = '50';
      this.themeManager.savedLightBackgroundPositionY = '100';
      this.themeManager.savedLightBackgroundSizeWidth = '70';
      this.themeManager.savedLightBackgroundOpacity = '100';
      this.themeManager.savedLightOverlayColor = '#000000';
      this.themeManager.savedLightOverlayOpacity = '0';
      this.themeManager.savedLightInvert = 'none';
      
      document.getElementById('darkBackgroundPositionX').value = '50';
      document.getElementById('darkBackgroundPositionXValue').textContent = '50%';
      document.getElementById('darkBackgroundPositionY').value = '100';
      document.getElementById('darkBackgroundPositionYValue').textContent = '100%';
      document.getElementById('darkBackgroundSizeWidth').value = '70';
      document.getElementById('darkBackgroundSizeWidthValue').textContent = '70%';
      document.getElementById('darkBackgroundOpacity').value = '100';
      document.getElementById('darkBackgroundOpacityValue').textContent = '100%';
      document.getElementById('darkBackgroundBlur').value = '0';
      document.getElementById('darkBackgroundBlurValue').textContent = '0px';
      document.getElementById('darkOverlayColor').value = '#000000';
      document.getElementById('darkOverlayOpacity').value = '0';
      document.getElementById('darkOverlayOpacityValue').textContent = '0%';
      document.querySelector('input[name="darkInvert"][value="invert"]').checked = true;
      
      document.getElementById('lightBackgroundPositionX').value = '50';
      document.getElementById('lightBackgroundPositionXValue').textContent = '50%';
      document.getElementById('lightBackgroundPositionY').value = '100';
      document.getElementById('lightBackgroundPositionYValue').textContent = '100%';
      document.getElementById('lightBackgroundSizeWidth').value = '70';
      document.getElementById('lightBackgroundSizeWidthValue').textContent = '70%';
      document.getElementById('lightBackgroundOpacity').value = '100';
      document.getElementById('lightBackgroundOpacityValue').textContent = '100%';
      document.getElementById('lightBackgroundBlur').value = '0';
      document.getElementById('lightBackgroundBlurValue').textContent = '0px';
      document.getElementById('lightOverlayColor').value = '#000000';
      document.getElementById('lightOverlayOpacity').value = '0';
      document.getElementById('lightOverlayOpacityValue').textContent = '0%';
      document.querySelector('input[name="lightInvert"][value="none"]').checked = true;
      
      this.themeManager.applyBackgroundSettings();
      document.getElementById('darkCurrentBackgroundPath').textContent = '使用默认背景图';
      document.getElementById('darkBackgroundImageInput').value = '';
      document.getElementById('lightCurrentBackgroundPath').textContent = '使用默认背景图';
      document.getElementById('lightBackgroundImageInput').value = '';
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('darkBackgroundPositionX').addEventListener('input', (e) => {
      this.themeManager.savedDarkBackgroundPositionX = e.target.value;
      document.getElementById('darkBackgroundPositionXValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('darkBackgroundPositionY').addEventListener('input', (e) => {
      this.themeManager.savedDarkBackgroundPositionY = e.target.value;
      document.getElementById('darkBackgroundPositionYValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('darkBackgroundSizeWidth').addEventListener('input', (e) => {
      this.themeManager.savedDarkBackgroundSizeWidth = e.target.value;
      document.getElementById('darkBackgroundSizeWidthValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('darkBackgroundOpacity').addEventListener('input', (e) => {
      this.themeManager.savedDarkBackgroundOpacity = e.target.value;
      document.getElementById('darkBackgroundOpacityValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('darkOverlayColor').addEventListener('input', (e) => {
      this.themeManager.savedDarkOverlayColor = e.target.value;
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('darkOverlayOpacity').addEventListener('input', (e) => {
      this.themeManager.savedDarkOverlayOpacity = e.target.value;
      document.getElementById('darkOverlayOpacityValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.querySelectorAll('input[name="darkInvert"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.themeManager.savedDarkInvert = e.target.value;
        this.themeManager.applyBackgroundSettings();
        this.themeManager.saveBackgroundSettings();
      });
    });
    
    document.getElementById('lightBackgroundPositionX').addEventListener('input', (e) => {
      this.themeManager.savedLightBackgroundPositionX = e.target.value;
      document.getElementById('lightBackgroundPositionXValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('lightBackgroundPositionY').addEventListener('input', (e) => {
      this.themeManager.savedLightBackgroundPositionY = e.target.value;
      document.getElementById('lightBackgroundPositionYValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('lightBackgroundSizeWidth').addEventListener('input', (e) => {
      this.themeManager.savedLightBackgroundSizeWidth = e.target.value;
      document.getElementById('lightBackgroundSizeWidthValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('lightBackgroundOpacity').addEventListener('input', (e) => {
      this.themeManager.savedLightBackgroundOpacity = e.target.value;
      document.getElementById('lightBackgroundOpacityValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('lightOverlayColor').addEventListener('input', (e) => {
      this.themeManager.savedLightOverlayColor = e.target.value;
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.getElementById('lightOverlayOpacity').addEventListener('input', (e) => {
      this.themeManager.savedLightOverlayOpacity = e.target.value;
      document.getElementById('lightOverlayOpacityValue').textContent = e.target.value + '%';
      this.themeManager.applyBackgroundSettings();
      this.themeManager.saveBackgroundSettings();
    });
    
    document.querySelectorAll('input[name="lightInvert"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.themeManager.savedLightInvert = e.target.value;
        this.themeManager.applyBackgroundSettings();
        this.themeManager.saveBackgroundSettings();
      });
    });
    
    document.querySelectorAll('input[name="darkInvert"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.themeManager.savedDarkInvert = e.target.value;
        this.themeManager.applyBackgroundSettings();
        this.themeManager.saveBackgroundSettings();
      });
    });
    
    document.querySelectorAll('input[name="lightInvert"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.themeManager.savedLightInvert = e.target.value;
        this.themeManager.applyBackgroundSettings();
        this.themeManager.saveBackgroundSettings();
      });
    });
    
    document.querySelectorAll('input[name="themeMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.themeManager.previewThemeChange(e.target.value === 'dark');
      });
    });

    document.querySelectorAll('.sidebar-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('sidebar-subitem')) {
          return;
        }
        const section = e.currentTarget.dataset.section;
        this.settingsManager.switchSettingsPanel(section);
        e.currentTarget.querySelector('.sidebar-submenu').classList.toggle('active');
      });
    });

    document.querySelectorAll('.sidebar-subitem').forEach(subitem => {
      subitem.addEventListener('click', (e) => {
        e.stopPropagation();
        const section = e.currentTarget.dataset.section;
        const targetId = e.currentTarget.dataset.target;
        
        if (section) {
          this.settingsManager.switchSettingsPanel(section);
        }
        
        setTimeout(() => {
          const targetElement = document.getElementById(targetId);
          if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            targetElement.classList.add('highlight-section');
            setTimeout(() => {
              targetElement.classList.remove('highlight-section');
            }, 1500);
          }
        }, 100);
      });
    });

    setTimeout(() => {
      this.setupCloudSyncListeners();
    }, 100);
  }

  setupSecretModal() {
    document.getElementById('closeSecretModal')?.addEventListener('click', () => this.closeSecretModal());
    document.getElementById('saveSecretBtn')?.addEventListener('click', () => this.saveSecretData());
    document.getElementById('deleteSecretBtn')?.addEventListener('click', () => {
      if (this.currentEditingSecretId) {
        this.handleSecretAction('delete-secret', null, this.currentEditingSecretId);
        this.closeSecretModal();
      }
    });
    document.getElementById('secretModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'secretModal') this.closeSecretModal();
    });
    
    document.getElementById('secretCategoryInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addCategoryTag(e.target.value);
        e.target.value = '';
      }
    });
    
    document.getElementById('addSecretFieldBtn')?.addEventListener('click', () => this.addSecretField());
    
    document.getElementById('secretFieldsContainer')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-remove-field')) {
        const row = e.target.parentElement;
        const container = document.getElementById('secretFieldsContainer');
        if (container.children.length > 1) {
          row.remove();
        }
      }
    });
    
    document.getElementById('addSecretBtn')?.addEventListener('click', () => this.openSecretModal());

    document.getElementById('secretsContainer')?.addEventListener('click', (e) => {
      const copyIcon = e.target.closest('.copy-icon');
      const secretCard = e.target.closest('.secret-card');
      
      if (copyIcon) {
        e.stopPropagation();
        const index = parseInt(copyIcon.dataset.index);
        const id = copyIcon.dataset.id;
        const secret = this.secrets.find(s => String(s.id) === String(id));
        if (secret && secret.fields && secret.fields[index]) {
          const field = secret.fields[index];
          this.copyToClipboard(field.value).then(() => {
            copyIcon.textContent = '✓';
            copyIcon.classList.add('copied');
            this.showToast(`${field.label}已复制到剪贴板`);
            setTimeout(() => {
              copyIcon.textContent = '📋';
              copyIcon.classList.remove('copied');
            }, 2000);
          }).catch(() => {
            this.showToast('复制失败，请重试');
          });
        }
      } else if (secretCard) {
        const id = secretCard.dataset.secretId;
        const secret = this.secrets.find(s => String(s.id) === String(id));
        if (secret) {
          this.pinSecret(id);
          this.openSecretModal(secret);
        }
      }
    });
  }

  setupCloudSyncListeners() {
    const uploadBtn = document.getElementById('cloudUploadBtn');
    const downloadBtn = document.getElementById('cloudDownloadBtn');
    const checkBtn = document.getElementById('cloudCheckBtn');
    const getAuthCodeBtn = document.getElementById('getAuthCodeBtn');
    const confirmAuthCodeBtn = document.getElementById('confirmAuthCodeBtn');
    
    const appUploadBtn = document.getElementById('cloudAppUploadBtn');
    const versionListBtn = document.getElementById('cloudVersionListBtn');
    const versionAutoIncreaseBtn = document.getElementById('versionAutoIncreaseBtn');
    
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    const autoSyncInterval = document.getElementById('autoSyncInterval');
    
    if (uploadBtn) uploadBtn.addEventListener('click', () => this.uploadToCloud());
    if (downloadBtn) downloadBtn.addEventListener('click', () => this.downloadFromCloud());
    if (checkBtn) checkBtn.addEventListener('click', () => this.checkCloudConnection());
    if (getAuthCodeBtn) getAuthCodeBtn.addEventListener('click', () => this.getAuthCode());
    if (confirmAuthCodeBtn) confirmAuthCodeBtn.addEventListener('click', () => this.exchangeAuthCode());
    
    if (appUploadBtn) appUploadBtn.addEventListener('click', () => this.uploadAppToCloud());
    if (versionListBtn) versionListBtn.addEventListener('click', () => this.pullFromGitHub());
    if (versionAutoIncreaseBtn) versionAutoIncreaseBtn.addEventListener('click', () => this.autoIncreaseVersion());
    
    if (autoSyncToggle) autoSyncToggle.addEventListener('change', (e) => this.toggleAutoSync(e.target.checked));
    if (autoSyncInterval) autoSyncInterval.addEventListener('input', (e) => this.onAutoSyncIntervalChange(e.target.value));
    
    const refreshBackupBtn = document.getElementById('refreshBackupListBtn');
    if (refreshBackupBtn) refreshBackupBtn.addEventListener('click', () => this.loadBackupList());
    
    this.initAutoSync();
    this.loadBackupList();
  }
  
  async loadBackupList() {
    const result = await ipcRenderer.invoke('backup-list');
    const backupList = document.getElementById('backupList');
    const emptyState = document.getElementById('backupEmptyState');
    
    if (!result.success) {
      console.error('加载备份列表失败:', result.message);
      return;
    }
    
    if (result.data.length === 0) {
      backupList.style.display = 'none';
      emptyState.style.display = 'flex';
      return;
    }
    
    backupList.style.display = 'flex';
    emptyState.style.display = 'none';
    
    backupList.innerHTML = result.data.map(backup => this.createBackupCard(backup)).join('');
  }
  
  createBackupCard(backup) {
    const date = new Date(backup.timestamp);
    const timeStr = date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    const sizeStr = (backup.size / 1024).toFixed(1) + 'KB';
    const typeLabel = backup.syncType === 'upload' ? '上传' : (backup.syncType === 'merge' ? '合并' : '下载');
    const typeClass = backup.syncType === 'upload' ? 'upload' : (backup.syncType === 'merge' ? 'merge' : 'download');
    
    return `
      <div class="backup-item-card" data-file="${backup.fileName}">
        <div class="backup-item-header">
          <span class="backup-item-time">${timeStr}</span>
          <span class="backup-item-badge ${typeClass}">${typeLabel}</span>
        </div>
        <div class="backup-item-body">
          <span class="backup-stat-item">备忘录: <span class="backup-stat-value">${backup.memoCount}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">任务: <span class="backup-stat-value">${backup.taskCount}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">收支: <span class="backup-stat-value">${backup.expenseCount}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">预算: <span class="backup-stat-value">${backup.budgetCount}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">日志: <span class="backup-stat-value">${backup.journalCount || 0}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">聊天: <span class="backup-stat-value">${backup.chatCount || 0}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">预设: <span class="backup-stat-value">${backup.presetCount || 0}</span></span>
          <span class="backup-stat-divider">|</span>
          <span class="backup-stat-item">大小: <span class="backup-stat-value">${sizeStr}</span></span>
          <div class="backup-actions">
            <button class="backup-action-btn backup-restore-btn" onclick="window.appController.restoreBackup('${backup.fileName}')">恢复</button>
            <button class="backup-action-btn backup-delete-btn" onclick="window.appController.deleteBackup('${backup.fileName}')">删除</button>
          </div>
        </div>
      </div>
    `;
  }
  
  async restoreBackup(fileName) {
    if (!confirm(`确定要从备份恢复数据吗？这将覆盖当前所有数据。`)) {
      return;
    }
    
    const result = await ipcRenderer.invoke('backup-restore', fileName);
    if (result.success) {
      alert('数据恢复成功！');
      this.loadBackupList();
    } else {
      alert('恢复失败: ' + result.message);
    }
  }
  
  async deleteBackup(fileName) {
    if (!confirm(`确定要删除这个备份吗？删除后无法恢复。`)) {
      return;
    }
    
    const result = await ipcRenderer.invoke('backup-delete', fileName);
    if (result.success) {
      this.loadBackupList();
    } else {
      alert('删除失败: ' + result.message);
    }
  }
  
  onAutoSyncIntervalChange(value) {
    const valueDisplay = document.getElementById('autoSyncIntervalValue');
    if (valueDisplay) {
      valueDisplay.textContent = value;
    }
    this.updateAutoSyncInterval(value);
  }
  
  async initAutoSync() {
    const settings = await ipcRenderer.invoke('get-settings');
    // ★ 修复：以 cloudAutoSync（UI 复选框实际写入的字段）为唯一权威来源
    // autoSyncEnabled 是旧字段，仅在 cloudAutoSync 未定义时作向后兼容回退
    const autoSyncEnabled = settings.cloudAutoSync !== undefined
      ? settings.cloudAutoSync
      : (settings.autoSyncEnabled || false);
    const autoSyncInterval = settings.cloudSyncInterval || settings.autoSyncInterval || 10;
    
    const toggle = document.getElementById('autoSyncToggle');
    const intervalSlider = document.getElementById('autoSyncInterval');
    const intervalValue = document.getElementById('autoSyncIntervalValue');
    
    if (toggle) toggle.checked = autoSyncEnabled;
    if (intervalSlider) intervalSlider.value = autoSyncInterval;
    if (intervalValue) intervalValue.textContent = autoSyncInterval;
    
    // 缓存当前自动同步开关状态，供 notifyDataChange 等无需 DOM 即可判断
    this._autoSyncEnabledCached = autoSyncEnabled;
    this.autoSyncInterval = autoSyncInterval;
    
    if (autoSyncEnabled) {
      this.startAutoSync(autoSyncInterval);
    } else {
      // ★ 确保关闭状态下定时器被清理，防止旧定时器残留触发同步
      this.stopAutoSync();
    }
    
    const lastSyncTime = settings.lastSyncTime;
    if (lastSyncTime) {
      this.updateLastSyncTime(lastSyncTime);
    }
  }
  
  toggleAutoSync(enabled) {
    // ★ 缓存当前状态，供 notifyDataChange 使用
    this._autoSyncEnabledCached = enabled;
    if (enabled) {
      const interval = document.getElementById('autoSyncInterval')?.value || 10;
      this.startAutoSync(interval);
    } else {
      this.stopAutoSync();
    }
    this.saveAutoSyncSettings(enabled, this.autoSyncInterval || 10);
  }
  
  updateAutoSyncInterval(interval) {
    this.autoSyncInterval = parseInt(interval);
    if (this.autoSyncTimer) {
      this.stopAutoSync();
      this.startAutoSync(this.autoSyncInterval);
    }
    const enabled = document.getElementById('autoSyncToggle')?.checked || false;
    this.saveAutoSyncSettings(enabled, this.autoSyncInterval);
  }
  
  startAutoSync(interval) {
    this.autoSyncInterval = interval;
    
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
    }
    
    // ★ 递归 setTimeout 代替 setInterval：等本次完成后再排下次，防止并发阻塞
    const scheduleNextSync = () => {
      this.autoSyncTimer = setTimeout(() => {
        this.performAutoSync().finally(() => {
          if (this.autoSyncTimer) scheduleNextSync();
        });
      }, interval * 60 * 1000);
    };
    scheduleNextSync();
    
    this.showAutoSyncStatus(true);
    
    setTimeout(() => {
      this.performAutoSync();
    }, 5000);
  }
  
  stopAutoSync() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.showAutoSyncStatus(false);
  }
  
  async saveAutoSyncSettings(enabled, interval) {
    // ★ 同时写入 autoSyncEnabled（旧字段，向后兼容）和 cloudAutoSync（UI 权威字段）
    // 确保 initAutoSync 读取的 cloudAutoSync 与复选框状态始终一致
    await ipcRenderer.invoke('save-settings', {
      autoSyncEnabled: enabled,
      autoSyncInterval: interval,
      cloudAutoSync: enabled,
      cloudSyncInterval: interval
    });
  }
  
  showAutoSyncStatus(enabled) {
    const statusElement = document.getElementById('autoSyncStatus');
    if (statusElement) {
      statusElement.style.display = enabled ? 'flex' : 'none';
    }
  }
  
  updateLastSyncTime(timestamp) {
    const lastSyncTimeElement = document.getElementById('lastSyncTime');
    if (lastSyncTimeElement) {
      const date = new Date(timestamp);
      const formatted = date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      lastSyncTimeElement.textContent = formatted;
    }
  }
  
  async performAutoSync() {
    // ★ 防重入锁：上次同步未完成时直接跳过，避免 setInterval 叠加阻塞主线程
    if (this._syncInProgress) {
      console.warn('[AutoSync] 上次同步尚未完成，跳过本次');
      return;
    }
    this._syncInProgress = true;

    try {
      const hasConfig = await this.checkCloudConfig();
      if (!hasConfig) {
        this._syncInProgress = false;
        return;
      }
      
      this.updateSyncStatus('syncing', '同步中...');
      
      
      const result = await ipcRenderer.invoke('cloud-sync-auto');
      
      if (result.success) {
        const now = Date.now();
        let syncType = '同步';
        if (result.syncLog && result.syncLog.length > 0) {
          const firstAction = result.syncLog[0];
          if (firstAction.type === 'download') {
            syncType = '下载';
          } else if (firstAction.type === 'upload') {
            syncType = '上传';
          } else if (firstAction.type === 'merge') {
            syncType = '合并';
          }
        }
        this.updateSyncStatus('success', '同步成功');
        this.updateLastSyncInfo(now, syncType);
        this.updateLastSyncTime(now);
        // ★ 修复：仅当自动同步处于开启状态时才保存设置，避免在用户已关闭同步时
        // 因同步成功而意外重新开启（saveAutoSyncSettings 会写入 cloudAutoSync=true）
        if (this._autoSyncEnabledCached) {
          this.saveAutoSyncSettings(true, this.autoSyncInterval);
        }
        
        await ipcRenderer.invoke('save-settings', { lastSyncTime: now });
        
        if (result.dataChanged) {
          await this.loadAllData();
          // 同步后同步聊天室管理器状态（防止 loadAllData 只更新 _preloaded 导致状态陈旧）
          this._initChatRoomFromCache();
          this.renderDailyTasks();
          this.renderDailyExpenses();
          this.renderMemos();
          this.renderStatistics();
          this.renderJournalCalendar();
          this.loadJournalForDate(this.selectedDateStr);
          // 同步后刷新聊天记录（xilianManager 缓存需要重新加载）
          // ★ 修复：若智能体正在流式生成回复，跳过本次聊天记录重载，避免打断当前对话
          if (!this.xilianManager?.isStreaming) {
            try {
              await this.xilianManager.loadHistory();
              if (this.xilianManager.isViewActive()) {
                XilianUI.renderMessages(this.xilianManager.chatHistory);
              }
            } catch (e) {
              console.error('[Sync] 刷新聊天记录失败:', e);
            }
          }
          // ★ 同步后把手机端数据喂给 MC 记忆管线（content_hash 去重，不会重复录入）
          try {
            const mcResult = await ipcRenderer.invoke('mc:ingest-synced-data');
            if (mcResult.ok && mcResult.total > 0) {
              console.log(`[MC] 同步后已喂 ${mcResult.total} 条新数据给记忆管线`);
              // ★ 立即触发一次 Scribe+Archivist（不等 60s 周期），让同步后星图能尽快亮起
              try {
                const tickResult = await ipcRenderer.invoke('mc:force-tick');
                console.log('[MC] 同步后 force-tick:', JSON.stringify(tickResult));
              } catch (_) { /* force-tick 失败不影响同步主流程 */ }
            }
          } catch (_) { /* MC 未初始化时静默忽略 */ }
        }
      } else {
        this.updateSyncStatus('failed', '同步失败: ' + result.message);
      }
    } catch (e) {
      console.error('自动同步失败:', e);
      this.updateSyncStatus('failed', '同步失败: ' + e.message);
    } finally {
      this._syncInProgress = false;
    }
  }
  
  updateSyncStatus(status, text) {
    const statusElement = document.getElementById('syncStatusText');
    if (statusElement) {
      statusElement.textContent = text;
      statusElement.className = `status-value ${status}`;
    }
  }
  
  updateLastSyncInfo(timestamp, type) {
    const lastSyncElement = document.getElementById('lastSyncInfo');
    if (lastSyncElement) {
      const date = new Date(timestamp);
      const formatted = date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      lastSyncElement.textContent = `${type} - ${formatted}`;
    }
  }
  
  async checkCloudConfig() {
    const settings = await ipcRenderer.invoke('get-settings');
    return !!(settings.cloudAppId && settings.cloudAppKey && settings.cloudAppSecret);
  }
  
  notifyDataChange() {
    // ★ 修复：优先使用缓存的自动同步状态（由 initAutoSync / toggleAutoSync 维护）
    // 其次回退到 DOM 复选框状态，避免依赖可能未初始化的 DOM 元素
    const isAutoSyncEnabled = this._autoSyncEnabledCached
      ?? (document.getElementById('autoSyncToggle')?.checked ?? false);
    
    if (!isAutoSyncEnabled) return;
    
    const hasConfig = this.checkCloudConfigSync();
    if (!hasConfig) return;
    
    if (this.pendingSyncTimeout) {
      clearTimeout(this.pendingSyncTimeout);
    }
    
    this.pendingSyncTimeout = setTimeout(() => {
      this.performAutoSync();
    }, 3000);
  }
  
  checkCloudConfigSync() {
    const appId = document.getElementById('cloudAppId')?.value;
    const appKey = document.getElementById('cloudAppKey')?.value;
    const appSecret = document.getElementById('cloudAppSecret')?.value;
    return !!(appId && appKey && appSecret);
  }



  async loadCloudConfig() {
    try {
      const result = await ipcRenderer.invoke('cloud-sync-get-config');
      if (result.success) {
        this.applyCloudConfig(result);
        this.settingsManager.saveCloudConfigToCache(result);
      } else {
        const cachedConfig = this.getCloudConfigFromCache();
        if (cachedConfig) {
          console.log('使用缓存的云同步配置');
          this.applyCloudConfig(cachedConfig);
        }
      }
    } catch (e) {
      console.error('加载云同步配置失败:', e);
      const cachedConfig = this.getCloudConfigFromCache();
      if (cachedConfig) {
        console.log('使用缓存的云同步配置');
        this.applyCloudConfig(cachedConfig);
      }
    }
  }

  applyCloudConfig(config) {
    document.getElementById('cloudAppId').value = config.appId || '';
    document.getElementById('cloudAppKey').value = config.appKey || '';
    document.getElementById('cloudAppSecret').value = config.appSecret || '';
    
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    if (autoSyncToggle) {
      autoSyncToggle.checked = config.autoSync || false;
    }
    
    const autoSyncInterval = document.getElementById('autoSyncInterval');
    if (autoSyncInterval) {
      autoSyncInterval.value = config.syncInterval || 10;
    }
    
    this.settingsManager.savedCloudToken = config.token || '';
    this.settingsManager.savedCloudRefreshToken = config.refreshToken || '';
    this.settingsManager.savedCloudTokenExpireTime = config.tokenExpireTime || 0;
    
    this.updateCloudStatusFromConfig(config);
  }

  saveCloudConfigToCache(config) {
    try {
      const cache = {
        appId: config.appId || '',
        appKey: config.appKey || '',
        appSecret: config.appSecret || '',
        autoSync: config.autoSync || false,
        syncInterval: config.syncInterval || 30,
        token: config.token || '',
        refreshToken: config.refreshToken || '',
        tokenExpireTime: config.tokenExpireTime || 0,
        cachedAt: Date.now()
      };
      localStorage.setItem('elysia-cloud-config', JSON.stringify(cache));
    } catch (e) {
      console.error('保存云配置到缓存失败:', e);
    }
  }

  getCloudConfigFromCache() {
    try {
      const cacheStr = localStorage.getItem('elysia-cloud-config');
      if (cacheStr) {
        const cache = JSON.parse(cacheStr);
        const cacheAge = Date.now() - cache.cachedAt;
        if (cacheAge < 24 * 60 * 60 * 1000) {
          return cache;
        }
      }
    } catch (e) {
      console.error('读取云配置缓存失败:', e);
    }
    return null;
  }

  updateCloudStatusFromConfig(config) {
    const hasBasicConfig = config.appId && config.appKey && config.appSecret;
    const hasToken = config.token && config.refreshToken && config.tokenExpireTime;
    const isTokenValid = hasToken && Date.now() < config.tokenExpireTime;
    
    if (hasBasicConfig && hasToken) {
      if (isTokenValid) {
        this.updateCloudStatus(true, '已连接');
      } else {
        this.updateCloudStatus(true, 'token已过期，请重新授权');
      }
    } else if (hasBasicConfig) {
      this.updateCloudStatus(false, '已配置，未授权');
    } else {
      this.updateCloudStatus(false, '未配置');
    }
  }

  async saveCloudConfig() {
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    const autoSyncInterval = document.getElementById('autoSyncInterval');
    
    const config = {
      appId: document.getElementById('cloudAppId').value,
      appKey: document.getElementById('cloudAppKey').value,
      appSecret: document.getElementById('cloudAppSecret').value,
      autoSync: autoSyncToggle ? autoSyncToggle.checked : false,
      syncInterval: autoSyncInterval ? parseInt(autoSyncInterval.value) : 10,
      token: this.settingsManager.savedCloudToken || '',
      refreshToken: this.settingsManager.savedCloudRefreshToken || '',
      tokenExpireTime: this.settingsManager.savedCloudTokenExpireTime || 0
    };

    const saveResult = await ipcRenderer.invoke('cloud-sync-save-config', config);
    if (saveResult.success) {
      const verifyResult = await ipcRenderer.invoke('cloud-sync-get-config');
      if (verifyResult.success) {
        const isConfigMatch = 
          verifyResult.appId === config.appId &&
          verifyResult.appKey === config.appKey &&
          verifyResult.appSecret === config.appSecret;
        
        if (isConfigMatch) {
          alert('云同步配置已保存并验证成功');
          this.updateCloudStatusFromConfig(verifyResult);
          await this.initCloudSync(config);
        } else {
          alert('配置保存成功，但验证失败，请重新保存');
        }
      } else {
        alert('配置保存成功，但无法验证，请重新打开设置');
      }
    } else {
      alert('保存失败: ' + saveResult.message);
    }
  }

  async initCloudSync(config) {
    const configResult = await ipcRenderer.invoke('cloud-sync-get-config');
    const cloudConfig = {
      ...config,
      token: configResult.token,
      refreshToken: configResult.refreshToken,
      tokenExpireTime: configResult.tokenExpireTime
    };
    
    this.settingsManager.savedCloudToken = configResult.token || '';
    this.settingsManager.savedCloudRefreshToken = configResult.refreshToken || '';
    this.settingsManager.savedCloudTokenExpireTime = configResult.tokenExpireTime || 0;
    
    const result = await ipcRenderer.invoke('cloud-sync-init', cloudConfig);
    if (result.success) {
      this.updateCloudStatus(true, '已连接');
    } else {
      this.updateCloudStatus(false, '连接失败: ' + result.message);
    }
  }

  async getAuthCode() {
    const appId = document.getElementById('cloudAppId').value;
    const appKey = document.getElementById('cloudAppKey').value;
    const appSecret = document.getElementById('cloudAppSecret').value;
    
    if (!appId || !appKey || !appSecret) {
      alert('请先填写 APP ID、App Key 和 App Secret');
      return;
    }

    const result = await ipcRenderer.invoke('cloud-sync-get-auth-url', { appId, appKey, appSecret });
    if (result.success) {
      await ipcRenderer.invoke('open-external-url', result.url);
      setTimeout(() => {
        const authCodeInput = document.getElementById('cloudAuthCode');
        if (authCodeInput) {
          authCodeInput.focus();
          authCodeInput.select();
        }
      }, 100);
    } else {
      alert('获取授权链接失败: ' + result.message);
    }
  }

  async exchangeAuthCode() {
    const appId = document.getElementById('cloudAppId').value;
    const appKey = document.getElementById('cloudAppKey').value;
    const appSecret = document.getElementById('cloudAppSecret').value;
    const authCode = document.getElementById('cloudAuthCode').value;
    
    if (!appId || !appKey || !appSecret || !authCode) {
      alert('请填写所有字段');
      return;
    }

    const result = await ipcRenderer.invoke('cloud-sync-exchange-code', { appId, appKey, appSecret, code: authCode });
    if (result.success) {
      const verifyResult = await ipcRenderer.invoke('cloud-sync-get-config');
      if (verifyResult.success && verifyResult.token && verifyResult.refreshToken) {
        this.settingsManager.savedCloudToken = verifyResult.token;
        this.settingsManager.savedCloudRefreshToken = verifyResult.refreshToken;
        this.settingsManager.savedCloudTokenExpireTime = verifyResult.tokenExpireTime;
        alert('授权成功！token已保存');
        this.updateCloudStatus(true, '已连接');
      } else {
        alert('授权成功，但token保存失败，请重新授权');
        return;
      }
      
      document.getElementById('cloudAuthCode').value = '';
      
      setTimeout(() => {
        document.body.focus();
        const activeElement = document.activeElement;
        if (activeElement) {
          activeElement.blur();
        }
        const firstInput = document.querySelector('input, textarea');
        if (firstInput) {
          firstInput.focus();
        }
      }, 100);
    } else {
      alert('授权失败: ' + result.message);
    }
  }

  async uploadToCloud() {
    const appId = document.getElementById('cloudAppId').value;
    const appKey = document.getElementById('cloudAppKey').value;
    const appSecret = document.getElementById('cloudAppSecret').value;
    
    if (!appId || !appKey || !appSecret) {
      alert('请先填写 APP ID、App Key 和 App Secret');
      return;
    }

    await this.initCloudSync({ appId, appKey, appSecret });
    
    this.updateSyncStatus('syncing', '同步中...');
    
    const result = await ipcRenderer.invoke('cloud-sync-upload');
    if (result.success) {
      this.updateSyncStatus('success', '同步成功');
      this.updateLastSyncInfo(Date.now(), '上传');
      this.addSyncHistory('上传', '成功');
      alert('数据已上传到云端');
    } else {
      this.addSyncHistory('上传', '失败: ' + result.message);
      alert('上传失败: ' + result.message);
    }
  }

  async downloadFromCloud() {
    const appId = document.getElementById('cloudAppId').value;
    const appKey = document.getElementById('cloudAppKey').value;
    const appSecret = document.getElementById('cloudAppSecret').value;
    
    if (!appId || !appKey || !appSecret) {
      alert('请先填写 APP ID、App Key 和 App Secret');
      return;
    }

    await this.initCloudSync({ appId, appKey, appSecret });
    
    this.updateSyncStatus('syncing', '同步中...');
    
    const result = await ipcRenderer.invoke('cloud-sync-download');
    if (result.success) {
      this.updateSyncStatus('success', '同步成功');
      this.updateLastSyncInfo(Date.now(), '下载');
      this.addSyncHistory('下载', '成功');
      const diagInfo = result.diag ? `\n\n${result.message}` : '';
      alert('已从云端下载最新数据' + diagInfo);
      await this.loadAllData();
      // 同步后同步聊天室管理器状态
      this._initChatRoomFromCache();
      this.renderDailyTasks();
      this.renderDailyExpenses();
      this.renderMemos();
      this.renderStatistics();
      this.renderJournalCalendar();
      this.loadJournalForDate(this.selectedDateStr);
      // 同步下载后刷新聊天记录
      try {
        await this.xilianManager.loadHistory();
        if (this.xilianManager.isViewActive()) {
          XilianUI.renderMessages(this.xilianManager.chatHistory);
        }
      } catch (e) {
        console.error('[Sync] 刷新聊天记录失败:', e);
      }
      // ★ 同步下载后也把数据喂给 MC 记忆管线
      try {
        const mcResult = await ipcRenderer.invoke('mc:ingest-synced-data');
        if (mcResult.ok && mcResult.total > 0) {
          console.log(`[MC] 下载同步后已喂 ${mcResult.total} 条新数据给记忆管线`);
          // ★ 立即触发一次 Scribe+Archivist，不用等周期
          try {
            const tickResult = await ipcRenderer.invoke('mc:force-tick');
            console.log('[MC] 下载同步后 force-tick:', JSON.stringify(tickResult));
          } catch (_) {}
        }
      } catch (_) {}
    } else {
      this.addSyncHistory('下载', result.notFound ? '云端无数据' : '失败: ' + result.message);
      alert(result.message);
    }
  }

  async checkCloudConnection() {
    const appId = document.getElementById('cloudAppId').value;
    const appKey = document.getElementById('cloudAppKey').value;
    const appSecret = document.getElementById('cloudAppSecret').value;
    
    if (!appId || !appKey || !appSecret) {
      alert('请先填写 APP ID、App Key 和 App Secret');
      return;
    }

    await this.initCloudSync({ appId, appKey, appSecret });
    const result = await ipcRenderer.invoke('cloud-sync-check');
    
    if (result.success) {
      this.updateCloudStatus(true, '连接正常');
      this.addSyncHistory('检查', '连接正常');
    } else {
      this.updateCloudStatus(false, '连接失败');
      this.addSyncHistory('检查', '失败: ' + result.message);
    }
  }

  async loadCloudUserList() {
    const result = await ipcRenderer.invoke('cloud-sync-get-user-list');
    if (result.success && result.users && Array.isArray(result.users)) {
      const userList = document.getElementById('cloudUserList');
      const userSelect = document.getElementById('cloudUserSelect');
      
      if (!userList || !userSelect) {
        console.error('用户管理界面元素未找到');
        return;
      }
      
      userList.innerHTML = '';
      userSelect.innerHTML = '';
      
      result.users.forEach(user => {
        const userItem = document.createElement('div');
        userItem.className = `user-item ${user.id === 'admin' ? 'admin-user' : ''}`;
        userItem.innerHTML = `
          <div class="user-info">
            <span class="user-name">${user.name}</span>
            <span class="user-id">${user.id}</span>
          </div>
          <div class="user-actions">
            ${user.isDefault ? '<span class="user-default">默认</span>' : ''}
            ${user.id !== 'admin' ? '<button class="remove-user-btn" data-user-id="' + user.id + '">删除</button>' : ''}
          </div>
        `;
        userList.appendChild(userItem);
        
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.id === 'admin' ? `${user.name} (默认路径)` : user.name;
        userSelect.appendChild(option);
      });
      
      userList.querySelectorAll('.remove-user-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const userId = e.target.dataset.userId;
          this.removeCloudUser(userId);
        });
      });
    }
  }

  async loadCurrentCloudUser() {
    const result = await ipcRenderer.invoke('cloud-sync-get-config');
    if (result.success) {
      const userId = result.currentUserId || 'admin';
      const userName = userId === 'admin' ? '管理员' : userId;
      const userPath = userId === 'admin' ? '/apps/Elysia/data.json' : `/apps/Elysia/users/${encodeURIComponent(userId)}/data.json`;
      
      document.getElementById('currentCloudUserId').textContent = userName;
      document.getElementById('currentCloudUserPath').textContent = userPath;
      
      const userSelect = document.getElementById('cloudUserSelect');
      if (userSelect) {
        userSelect.value = userId;
      }
    }
  }

  async switchCloudUser() {
    const userSelect = document.getElementById('cloudUserSelect');
    const newUserId = userSelect.value;
    
    if (!newUserId) {
      alert('请选择一个用户');
      return;
    }
    
    const result = await ipcRenderer.invoke('cloud-sync-set-user', newUserId);
    if (result.success) {
      alert(`已切换到用户: ${newUserId === 'admin' ? '管理员' : newUserId}`);
      await this.settingsManager.loadCurrentCloudUser();
    } else {
      alert('切换用户失败: ' + result.message);
    }
  }

  addCloudUser() {
    document.getElementById('newUserId').value = '';
    document.getElementById('newUserName').value = '';
    document.getElementById('addUserModal').style.display = 'flex';
    document.getElementById('newUserId').focus();
  }
  
  async submitAddUser() {
    const userId = document.getElementById('newUserId').value.trim();
    const userName = document.getElementById('newUserName').value.trim() || userId;
    
    if (!userId) {
      alert('请输入用户ID');
      return;
    }
    
    if (userId === 'admin') {
      alert('不能创建名为 "admin" 的用户');
      return;
    }
    
    document.getElementById('addUserModal').style.display = 'none';
    
    try {
      const result = await ipcRenderer.invoke('cloud-sync-add-user', { id: userId, name: userName });
      
      if (result.success) {
        await this.settingsManager.loadCloudUserList();
        await this.settingsManager.loadCurrentCloudUser();
        alert('用户添加成功');
      } else {
        alert('添加用户失败: ' + result.message);
      }
    } catch (e) {
      alert('添加用户失败: ' + e.message);
    }
  }

  removeCloudUser(userId) {
    this.pendingAction = {
      action: 'removeUser',
      userId: userId
    };
    document.getElementById('confirmMessage').textContent = `确定要删除用户 "${userId}" 吗？`;
    document.getElementById('confirmModal').style.display = 'flex';
  }
  
  async confirmAction() {
    document.getElementById('confirmModal').style.display = 'none';
    
    if (this.pendingAction.action === 'removeUser') {
      const userId = this.pendingAction.userId;
      const result = await ipcRenderer.invoke('cloud-sync-remove-user', userId);
      if (result.success) {
        await this.settingsManager.loadCloudUserList();
        await this.settingsManager.loadCurrentCloudUser();
        alert('用户删除成功');
      } else {
        alert('删除用户失败: ' + result.message);
      }
    }
    this.pendingAction = null;
  }

  async loadUsersView() {
    await this.loadUsersList();
    await this.loadUsersCurrentUser();
    this.setupUsersViewEvents();
  }

  async loadUsersList() {
    const result = await ipcRenderer.invoke('cloud-sync-get-user-list');
    if (result.success && result.users && Array.isArray(result.users)) {
      const userList = document.getElementById('usersListContainer');
      const userSelect = document.getElementById('usersUserSelect');
      
      userList.innerHTML = '';
      userSelect.innerHTML = '';
      
      result.users.forEach(user => {
        const userItem = document.createElement('div');
        userItem.className = `user-item ${user.id === 'admin' ? 'admin-user' : ''}`;
        userItem.innerHTML = `
          <div class="user-info">
            <span class="user-name">${user.name}</span>
            <span class="user-id">${user.id}</span>
          </div>
          <div class="user-actions">
            ${user.isDefault ? '<span class="user-default">默认</span>' : ''}
            ${user.id !== 'admin' ? '<button class="remove-user-btn" data-user-id="' + user.id + '">删除</button>' : ''}
          </div>
        `;
        userList.appendChild(userItem);
        
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.id === 'admin' ? `${user.name} (默认路径)` : user.name;
        userSelect.appendChild(option);
      });
      
      userList.querySelectorAll('.remove-user-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const userId = e.target.dataset.userId;
          this.removeCloudUser(userId);
        });
      });
    }
  }

  async loadUsersCurrentUser() {
    const result = await ipcRenderer.invoke('cloud-sync-get-config');
    if (result.success) {
      const userId = result.currentUserId || 'admin';
      const userName = userId === 'admin' ? '管理员' : userId;
      const userPath = userId === 'admin' ? '/apps/Elysia/data.json' : `/apps/Elysia/users/${encodeURIComponent(userId)}/data.json`;
      
      document.getElementById('usersCurrentUserName').textContent = userName;
      document.getElementById('usersCurrentUserPath').textContent = userPath;
      
      const userSelect = document.getElementById('usersUserSelect');
      if (userSelect) {
        userSelect.value = userId;
      }
    }
  }

  setupUsersViewEvents() {
    const switchBtn = document.getElementById('usersSwitchBtn');
    const addBtn = document.getElementById('usersAddBtn');
    
    if (switchBtn) {
      switchBtn.removeEventListener('click', this.handleUsersSwitch.bind(this));
      switchBtn.addEventListener('click', this.handleUsersSwitch.bind(this));
    }
    
    if (addBtn) {
      addBtn.removeEventListener('click', this.settingsManager.addCloudUser.bind(this));
      addBtn.addEventListener('click', this.settingsManager.addCloudUser.bind(this));
    }
  }

  async handleUsersSwitch() {
    const userSelect = document.getElementById('usersUserSelect');
    const newUserId = userSelect.value;
    
    if (!newUserId) {
      alert('请选择一个用户');
      return;
    }
    
    const result = await ipcRenderer.invoke('cloud-sync-set-user', newUserId);
    if (result.success) {
      alert(`已切换到用户: ${newUserId === 'admin' ? '管理员' : newUserId}`);
      await this.loadUsersView();
    } else {
      alert('切换用户失败: ' + result.message);
    }
  }

  updateCloudStatus(isConnected, message) {
    const statusIndicator = document.querySelector('#cloudStatus .status-indicator');
    const statusText = document.querySelector('#cloudStatus .status-text');
    
    statusIndicator.classList.remove('offline', 'online');
    statusIndicator.classList.add(isConnected ? 'online' : 'offline');
    statusText.textContent = message;
  }

  autoIncreaseVersion() {
    const currentVersion = document.getElementById('currentVersion').textContent;
    const newVersion = this.incrementVersion(currentVersion);
    document.getElementById('newVersionInput').value = newVersion;
  }

  incrementVersion(version) {
    if (!version || version === '未知') {
      return '1.0.0';
    }
    
    const parts = version.split('.');
    if (parts.length !== 3) {
      return '1.0.0';
    }
    
    let major = parseInt(parts[0]) || 0;
    let minor = parseInt(parts[1]) || 0;
    let patch = parseInt(parts[2]) || 0;
    
    patch++;
    if (patch >= 10) {
      patch = 0;
      minor++;
    }
    if (minor >= 10) {
      minor = 0;
      major++;
    }
    
    return `${major}.${minor}.${patch}`;
  }

  // ★ Git 版：代码推送到 GitHub
  async uploadAppToCloud() {
    const uploadBtn = document.getElementById('cloudAppUploadBtn');
    const progressDiv = document.getElementById('uploadProgress');
    const progressTitle = document.getElementById('uploadProgressTitle');
    const progressStatus = document.getElementById('uploadProgressStatus');
    const progressBar = document.getElementById('uploadProgressBar');
    const progressDetails = document.getElementById('uploadProgressDetails');
    const newVersionInput = document.getElementById('newVersionInput');
    const newVersionNoteInput = document.getElementById('newVersionNote');

    if (!uploadBtn || !progressDiv || !progressBar) {
      alert('同步界面元素未就绪，请重新打开设置页面');
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = '同步中...';
    progressDiv.style.display = 'block';
    progressBar.style.width = '30%';
    if (progressTitle) progressTitle.textContent = '正在推送到 GitHub...';
    if (progressStatus) progressStatus.textContent = '';
    if (progressDetails) progressDetails.innerHTML = '';

    try {
      const newVersion = newVersionInput ? newVersionInput.value.trim() : '';
      const newVersionNote = newVersionNoteInput ? newVersionNoteInput.value.trim() : '';
      const result = await ipcRenderer.invoke('cloud-app-upload', newVersion, newVersionNote);

      if (result.success) {
        progressBar.style.width = '100%';
        if (progressTitle) progressTitle.textContent = '同步完成';
        alert(result.message);

        if (newVersion) {
          await ipcRenderer.invoke('update-local-version', newVersion);
          const currentVersionEl = document.getElementById('currentVersion');
          if (currentVersionEl) {
            currentVersionEl.textContent = newVersion;
          }
        }
      } else {
        alert('同步失败: ' + result.message);
      }
    } catch (e) {
      alert('同步失败: ' + e.message);
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = '同步到 GitHub';
      setTimeout(() => {
        progressDiv.style.display = 'none';
        progressBar.style.width = '0%';
        if (progressDetails) progressDetails.innerHTML = '';
      }, 3000);
    }
  }

  // ★ Git 版：从 GitHub 拉取更新
  async pullFromGitHub() {
    if (!confirm('确定要从 GitHub 拉取最新代码吗？\n更新后需要重启应用使更改生效。')) {
      return;
    }

    try {
      const result = await ipcRenderer.invoke('incremental-update-perform');

      if (result.success) {
        alert(result.message);
        if (result.needRestart) {
          if (confirm('代码已更新，是否立即重启应用？')) {
            await ipcRenderer.invoke('restart-app');
          }
        }
      } else {
        alert('拉取失败: ' + result.message);
      }
    } catch (e) {
      alert('拉取失败: ' + e.message);
    }
  }

  async showVersionList() {
    const versionListContainer = document.getElementById('versionListContainer');
    const versionList = document.getElementById('versionList');
    
    try {
      const result = await ipcRenderer.invoke('cloud-version-list');
      
      if (result.success) {
        if (result.data.length === 0) {
          versionList.innerHTML = `
            <div class="version-empty">
              <div class="version-empty-icon">📦</div>
              <p>云端没有可用的版本</p>
              <p class="version-empty-hint">请先上传应用到云端</p>
            </div>
          `;
        } else {
          let html = '';
          result.data.forEach((version, index) => {
            const date = new Date(version.uploadTime);
            const dateStr = date.toLocaleString('zh-CN');
            const isLatest = index === 0;
            html += `
              <div class="version-item-card ${isLatest ? 'version-latest' : ''}">
                <div class="version-item-header">
                  <div class="version-item-badge">v${version.version}</div>
                  ${isLatest ? '<div class="version-latest-badge">最新版本</div>' : ''}
                </div>
                <div class="version-item-body">
                  <div class="version-item-time">
                    <span class="version-time-icon">🕐</span>
                    <span>${dateStr}</span>
                  </div>
                  ${version.note ? `
                  <div class="version-item-note">
                    <span class="version-note-icon">📝</span>
                    <span>${version.note}</span>
                  </div>
                  ` : ''}
                </div>
                <div class="version-item-footer">
                  <button class="version-action-btn version-update-btn" data-version-id="${version.id}">
                    ${isLatest ? '更新' : '回退'}
                  </button>
                  <button class="version-action-btn version-delete-btn" data-version-id="${version.id}">
                    删除
                  </button>
                </div>
              </div>
            `;
          });
          versionList.innerHTML = html;
          
          document.querySelectorAll('.version-update-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              const versionId = e.target.getAttribute('data-version-id');
              this.downloadVersionById(versionId);
            });
          });
          
          document.querySelectorAll('.version-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              const versionId = e.target.getAttribute('data-version-id');
              this.deleteVersionById(versionId);
            });
          });
        }
        
        versionListContainer.style.display = versionListContainer.style.display === 'none' ? 'block' : 'none';
      } else {
        alert('获取版本列表失败: ' + result.message);
      }
    } catch (e) {
      alert('获取版本列表失败: ' + e.message);
    }
  }

  async deleteVersionById(versionId) {
    if (!confirm('确定要删除此版本吗？删除后无法恢复！')) {
      return;
    }
    
    const progressDiv = document.getElementById('deleteProgress');
    const progressTitle = document.getElementById('deleteProgressTitle');
    const progressStatus = document.getElementById('deleteProgressStatus');
    const progressBar = document.getElementById('deleteProgressBar');
    const progressDetails = document.getElementById('deleteProgressDetails');
    
    progressDiv.style.display = 'block';
    progressBar.style.width = '0%';
    progressDetails.innerHTML = '';
    
    const progressHandler = (event, progress) => {
      const current = progress.current ?? 0;
      const total = progress.total ?? 0;
      progressStatus.textContent = `${current}/${total}`;
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      progressBar.style.width = `${percentage}%`;
      
      switch (progress.status) {
        case 'started':
          progressTitle.textContent = '正在准备...';
          break;
        case 'deleting':
          progressTitle.textContent = `正在删除: ${progress.fileName || ''}`;
          if (progress.fileName) {
            progressDetails.insertAdjacentHTML('beforeend', `<div data-file-name="${progress.fileName}" style="color: #6B7280;">删除中: ${progress.fileName}</div>`);
          }
          break;
        case 'completed':
          if (progress.fileName) {
            const el = progressDetails.querySelector(`[data-file-name="${CSS.escape(progress.fileName)}"]`);
            if (el) {
              el.style.color = '#10B981';
              el.textContent = `✓ ${progress.fileName}`;
            }
          }
          break;
        case 'finished':
          progressTitle.textContent = '删除完成';
          break;
      }
    };
    
    ipcRenderer.on('cloud-version-delete-progress', progressHandler);
    
    try {
      const result = await ipcRenderer.invoke('cloud-version-delete', versionId);
      
      if (result.success) {
        alert('版本已删除');
        this.showVersionList();
      } else {
        alert('删除失败: ' + result.message);
      }
    } catch (e) {
      alert('删除失败: ' + e.message);
    } finally {
      progressDiv.style.display = 'none';
      progressBar.style.width = '0%';
      progressDetails.innerHTML = '';
      ipcRenderer.removeListener('cloud-version-delete-progress', progressHandler);
    }
  }

  async downloadVersionById(versionId) {
    if (!confirm('确定要下载此版本吗？更新后需要重启应用。')) {
      return;
    }
    
    const progressDiv = document.getElementById('downloadProgress');
    const progressTitle = document.getElementById('downloadProgressTitle');
    const progressStatus = document.getElementById('downloadProgressStatus');
    const progressBar = document.getElementById('downloadProgressBar');
    const progressDetails = document.getElementById('downloadProgressDetails');
    
    progressDiv.style.display = 'block';
    progressBar.style.width = '0%';
    progressDetails.innerHTML = '';
    
    const progressHandler = (event, progress) => {
      const current = progress.current ?? 0;
      const total = progress.total ?? 0;
      progressStatus.textContent = `${current}/${total}`;
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      progressBar.style.width = `${percentage}%`;
      
      switch (progress.status) {
        case 'started':
          progressTitle.textContent = '正在准备...';
          break;
        case 'downloading':
          progressTitle.textContent = `正在下载: ${progress.fileName || ''}`;
          if (progress.fileName) {
            progressDetails.insertAdjacentHTML('beforeend', `<div data-file-name="${progress.fileName}" style="color: #6B7280;">下载中: ${progress.fileName}</div>`);
          }
          break;
        case 'completed':
          if (progress.fileName) {
            const el = progressDetails.querySelector(`[data-file-name="${CSS.escape(progress.fileName)}"]`);
            if (el) {
              el.style.color = '#10B981';
              el.textContent = `✓ ${progress.fileName}`;
            }
          }
          break;
        case 'finished':
          progressTitle.textContent = '下载完成';
          break;
      }
    };
    
    ipcRenderer.on('cloud-app-download-progress', progressHandler);
    
    try {
      const result = await ipcRenderer.invoke('cloud-version-download-by-id', versionId);
      
      if (result.success) {
        alert(result.message);
        if (result.needRestart) {
          if (confirm('是否立即重启应用？')) {
            await ipcRenderer.invoke('restart-app');
          }
        }
      } else {
        alert('下载失败: ' + result.message);
      }
    } catch (e) {
      alert('下载失败: ' + e.message);
    } finally {
      progressBar.style.width = '0%';
      progressDetails.innerHTML = '';
      ipcRenderer.removeListener('cloud-app-download-progress', progressHandler);
    }
  }

  async checkCloudVersion() {
    try {
      const result = await ipcRenderer.invoke('cloud-version-check');
      
      if (result.success) {
        const localVersion = result.localVersion || '未知';
        const cloudVersion = result.cloudVersion || '暂无';
        
        document.getElementById('currentVersion').textContent = localVersion;
        document.getElementById('cloudVersion').textContent = cloudVersion;
        
        this.updateVersionStatus(localVersion, cloudVersion);
        
        if (result.hasUpdate) {
          alert(`发现新版本！\n当前版本: ${localVersion}\n云端版本: ${cloudVersion}`);
        } else if (cloudVersion && cloudVersion !== '暂无') {
          alert('当前已是最新版本');
        }
      } else {
        this.resetVersionStatus();
        alert('检查失败: ' + result.message);
      }
    } catch (e) {
      this.resetVersionStatus();
      alert('检查失败: ' + e.message);
    }
  }

  addSyncHistory(type, result) {
    const historyList = document.getElementById('syncHistoryList');
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN');
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.innerHTML = `<span class="history-time">${timeStr}</span> <span class="history-type">${type}</span> <span class="history-result ${result.includes('成功') ? 'success' : 'error'}">${result}</span>`;
    
    historyList.innerHTML = '';
    historyList.appendChild(historyItem);
  }

  async loadVersionInfo() {
    try {
      const result = await ipcRenderer.invoke('cloud-version-check');
      
      if (result.success) {
        const localVersion = result.localVersion || '未知';
        const cloudVersion = result.cloudVersion || '暂无';
        
        document.getElementById('currentVersion').textContent = localVersion;
        document.getElementById('cloudVersion').textContent = cloudVersion;
        
        this.updateVersionStatus(localVersion, cloudVersion);
      } else {
        this.resetVersionStatus();
      }
    } catch (e) {
      this.resetVersionStatus();
    }
  }
  
  updateVersionStatus(localVersion, cloudVersion) {
    const statusBar = document.getElementById('versionStatusBar');
    const statusIcon = document.querySelector('.version-status-icon');
    const statusText = document.querySelector('.version-status-text');
    const currentStatus = document.getElementById('currentVersionStatus');
    const cloudBadge = document.getElementById('cloudVersionBadge');
    const arrow = document.querySelector('.version-arrow');
    
    if (!currentStatus || !cloudBadge || !arrow || !statusBar || !statusIcon || !statusText) {
      return;
    }
    
    currentStatus.textContent = '';
    currentStatus.className = 'version-status local hidden';
    
    if (!cloudVersion || cloudVersion === '暂无' || cloudVersion === '未知') {
      cloudBadge.textContent = '';
      cloudBadge.className = 'version-badge unknown hidden';
      arrow.className = 'version-arrow';
      statusBar.style.display = 'none';
      return;
    }
    
    const compareResult = this.compareVersions(cloudVersion, localVersion);
    const hasUpdate = compareResult > 0;
    const isLocalNewer = compareResult < 0;
    
    if (hasUpdate) {
      cloudBadge.textContent = '';
      cloudBadge.className = 'version-badge has-update hidden';
      arrow.className = 'version-arrow has-update';
      
      statusBar.style.display = 'flex';
      statusIcon.className = 'version-status-icon update-available';
      statusText.textContent = `GitHub 有新的提交，点击「从 GitHub 拉取更新」进行升级`;
    } else if (isLocalNewer) {
      cloudBadge.textContent = '';
      cloudBadge.className = 'version-badge outdated hidden';
      arrow.className = 'version-arrow local-newer';
      arrow.textContent = '←';
      
      statusBar.style.display = 'flex';
      statusIcon.className = 'version-status-icon up-to-date';
      statusText.textContent = `本地版本 ${localVersion} 高于云端，建议上传新版本`;
    } else {
      cloudBadge.textContent = '';
      cloudBadge.className = 'version-badge latest hidden';
      arrow.className = 'version-arrow';
      arrow.textContent = '=';
      
      statusBar.style.display = 'flex';
      statusIcon.className = 'version-status-icon up-to-date';
      statusText.textContent = '当前已是最新版本';
    }
  }
  
  resetVersionStatus() {
    const currentVersionEl = document.getElementById('currentVersion');
    const cloudVersionEl = document.getElementById('cloudVersion');
    
    if (currentVersionEl) currentVersionEl.textContent = '未知';
    if (cloudVersionEl) cloudVersionEl.textContent = '暂无';
    
    const currentStatus = document.getElementById('currentVersionStatus');
    const cloudBadge = document.getElementById('cloudVersionBadge');
    const arrow = document.querySelector('.version-arrow');
    const statusBar = document.getElementById('versionStatusBar');
    
    if (currentStatus) {
      currentStatus.textContent = '';
      currentStatus.className = 'version-status';
    }
    if (cloudBadge) {
      cloudBadge.textContent = '';
      cloudBadge.className = 'version-badge';
    }
    if (arrow) arrow.className = 'version-arrow';
    if (statusBar) statusBar.style.display = 'none';
  }
  
  compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const length = Math.max(parts1.length, parts2.length);
    
    for (let i = 0; i < length; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

  async loadFinanceStats() {
    await this.expenseManager.loadExpenses();
    const data = this.expenseManager.getExpenses();
    await this.loadBudgets();
    console.log('Finance data loaded:', data.length);
    
    const selectedDate = this.selectedDate || new Date();
    
    let startDate, endDate;
    let hasBudget = false;
    let budgetName = '';
    
    for (const budget of this.budgets) {
      const budgetStart = new Date(budget.startDate);
      const budgetEnd = new Date(budget.endDate);
      budgetStart.setHours(0, 0, 0, 0);
      budgetEnd.setHours(23, 59, 59, 999);
      
      if (selectedDate >= budgetStart && selectedDate <= budgetEnd) {
        startDate = budgetStart;
        endDate = budgetEnd;
        hasBudget = true;
        budgetName = budget.name || '';
        break;
      }
    }
    
    if (!hasBudget) {
      startDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
      endDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
    }

    let totalExpense = 0;
    let totalIncome = 0;
    const categoryExpenses = {};
    const dailyExpenses = {};

    data.forEach(item => {
      const expenseDate = item.date ? new Date(item.date) : new Date(item.createdAt || Date.now());
      expenseDate.setHours(0, 0, 0, 0);
      const amount = parseFloat(item.amount) || 0;
      const checkDate = new Date(expenseDate);
      checkDate.setHours(0, 0, 0, 0);

      if (checkDate >= startDate && checkDate <= endDate) {
        if (item.type === 'expense') {
          totalExpense += amount;
          const dateStr = item.date || (item.createdAt ? item.createdAt.split('T')[0] : selectedDate.toISOString().split('T')[0]);
          dailyExpenses[dateStr] = (dailyExpenses[dateStr] || 0) + amount;
          
          const category = item.category || '未分类';
          categoryExpenses[category] = (categoryExpenses[category] || 0) + amount;
        } else {
          totalIncome += amount;
        }
      }
    });

    document.getElementById('financeExpense').textContent = '-¥' + totalExpense.toFixed(2);
    document.getElementById('financeIncome').textContent = '+¥' + totalIncome.toFixed(2);
    document.getElementById('financeBalance').textContent = '¥' + (totalIncome - totalExpense).toFixed(2);

    const periodLabel = document.getElementById('finance-period-label');
    const expenseLabel = document.getElementById('expenseLabel');
    const incomeLabel = document.getElementById('incomeLabel');
    const balanceLabel = document.getElementById('balanceLabel');
    
    if (periodLabel) {
      if (hasBudget && budgetName) {
        periodLabel.textContent = budgetName;
      } else {
        const startStr = startDate.toLocaleDateString('zh-CN', {month: 'short', day: 'numeric'});
        const endStr = endDate.toLocaleDateString('zh-CN', {month: 'short', day: 'numeric'});
        periodLabel.textContent = `${startStr} - ${endStr}`;
      }
    }
    
    if (expenseLabel) expenseLabel.textContent = hasBudget ? '周期支出' : '本月支出';
    if (incomeLabel) incomeLabel.textContent = hasBudget ? '周期收入' : '本月收入';
    if (balanceLabel) balanceLabel.textContent = hasBudget ? '周期结余' : '本月结余';

    this.drawCategoryChart(categoryExpenses);
    this.drawDailyChart(dailyExpenses, totalExpense, startDate, endDate);
  }

  drawCategoryChart(categoryExpenses) {
    const canvas = document.getElementById('categoryChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = 280;
    
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    const categories = Object.keys(categoryExpenses);
    const total = categories.reduce((sum, cat) => sum + categoryExpenses[cat], 0);
    const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16'];
    const centerX = size / 2;
    const centerY = size / 2;
    const radius = 90;
    const innerRadius = 55;

    let hoveredIndex = null;

    const legendItems = [];
    categories.forEach((cat, index) => {
      const amount = categoryExpenses[cat];
      const percentage = (amount / total) * 100;
      legendItems.push({ name: cat, amount: amount, percentage: percentage, color: colors[index % colors.length] });
    });

    const legendHTML = legendItems.map(item => `
      <div class="legend-item">
        <span class="legend-color" style="background: ${item.color}"></span>
        <span class="legend-text">
          <span class="legend-name">${item.name}</span>
          <span class="legend-value">¥${item.amount.toFixed(2)} (${item.percentage.toFixed(1)}%)</span>
        </span>
      </div>
    `).join('');
    document.getElementById('categoryLegend').innerHTML = legendHTML;

    const drawChart = (hoveredIdx = null) => {
      ctx.clearRect(0, 0, size, size);

      if (total === 0) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', size / 2, size / 2);
        return;
      }

      let startAngle = -Math.PI / 2;
      
      categories.forEach((cat, index) => {
        const amount = categoryExpenses[cat];
        const percentage = (amount / total) * 100;
        const angle = (percentage / 100) * Math.PI * 2;
        const color = colors[index % colors.length];
        const isHovered = hoveredIdx === index;
        const currentRadius = isHovered ? radius + 8 : radius;

        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, currentRadius, startAngle, startAngle + angle);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (isHovered) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 15;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        }

        startAngle += angle;
      });

      const isDarkMode = document.documentElement.classList.contains('dark-mode');
      const centerBgColor = isDarkMode ? '#1e1b4b' : '#f3f4f6';
      const centerTextColor = isDarkMode ? '#ffffff' : '#1f2937';
      const centerSubTextColor = isDarkMode ? '#9ca3af' : '#6b7280';

      ctx.beginPath();
      ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
      ctx.fillStyle = centerBgColor;
      ctx.fill();

      ctx.fillStyle = centerTextColor;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('¥' + total.toFixed(2), centerX, centerY + 5);

      ctx.fillStyle = centerSubTextColor;
      ctx.font = '11px sans-serif';
      ctx.fillText('本月总支出', centerX, centerY + 22);

      if (hoveredIdx !== null && hoveredIdx >= 0) {
        const hoveredItem = legendItems[hoveredIdx];
        const tooltipY = centerY - innerRadius - 45;
        const tooltipX = centerX - 70;
        const tooltipWidth = 140;
        const tooltipHeight = 30;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.roundRect(tooltipX, tooltipY - tooltipHeight, tooltipWidth, tooltipHeight, 8);
        ctx.fill();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(hoveredItem.name, centerX, tooltipY - tooltipHeight + 9);
        
        ctx.fillStyle = hoveredItem.color;
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText(`¥${hoveredItem.amount.toFixed(2)} (${hoveredItem.percentage.toFixed(1)}%)`, centerX, tooltipY - tooltipHeight + 22);

        ctx.textBaseline = 'alphabetic';
      }
    };

    drawChart();

    canvas.addEventListener('mousemove', (e) => {
      if (total === 0) return;

      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / canvas.offsetWidth * size - centerX;
      const y = (e.clientY - rect.top) / canvas.offsetHeight * size - centerY;
      const distance = Math.sqrt(x * x + y * y);

      if (distance >= innerRadius && distance <= radius + 8) {
        let angle = Math.atan2(y, x);
        if (angle < -Math.PI / 2) angle += Math.PI * 2;

        let cumulativeAngle = -Math.PI / 2;
        let foundIndex = null;
        
        categories.forEach((cat, index) => {
          const amount = categoryExpenses[cat];
          const percentage = (amount / total) * 100;
          const sliceAngle = (percentage / 100) * Math.PI * 2;
          
          if (angle >= cumulativeAngle && angle <= cumulativeAngle + sliceAngle) {
            foundIndex = index;
          }
          cumulativeAngle += sliceAngle;
        });

        if (foundIndex !== hoveredIndex) {
          hoveredIndex = foundIndex;
          drawChart(hoveredIndex);
        }
      } else {
        if (hoveredIndex !== null) {
          hoveredIndex = null;
          drawChart();
        }
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoveredIndex !== null) {
        hoveredIndex = null;
        drawChart();
      }
    });
  }

  drawDailyChart(dailyExpenses, totalExpense, periodStartDate, periodEndDate) {
    const canvas = document.getElementById('dailyChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const containerWidth = canvas.parentElement.clientWidth || 600;
    
    const dates = Object.keys(dailyExpenses).sort();
    const daysInPeriod = Math.ceil((periodEndDate - periodStartDate) / (1000 * 60 * 60 * 24)) + 1;
    
    const minWidthPerDay = 30;
    const calculatedWidth = Math.max(containerWidth - 40, daysInPeriod * minWidthPerDay + 140);
    const width = calculatedWidth;
    const height = 280;
    
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    
    const dailyBudget = totalExpense > 0 && daysInPeriod > 0 ? totalExpense / daysInPeriod : 0;

    const padding = { top: 25, right: 60, bottom: 45, left: 70 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const maxValue = dates.length > 0 ? Math.max(...dates.map(d => dailyExpenses[d]), dailyBudget * 1.5, 50) : 50;
    const barWidth = Math.min(14, chartWidth / daysInPeriod);
    const gap = Math.max(6, (chartWidth - daysInPeriod * barWidth) / (daysInPeriod + 1));

    let hoveredDay = null;

    const drawChart = (hoverDay = null) => {
      hoveredDay = hoverDay;
      ctx.clearRect(0, 0, width, height);

      if (dates.length === 0) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', width / 2, height / 2);
        return;
      }

      const isDarkMode = document.documentElement.classList.contains('dark-mode');
      const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';
      const textColor = isDarkMode ? '#d1d5db' : '#4b5563';
      const labelColor = isDarkMode ? '#9ca3af' : '#6b7280';
      
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        const y = padding.top + (chartHeight / 3) * i;
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        ctx.setLineDash([]);

        const value = Math.round(maxValue - (maxValue / 3) * i);
        ctx.fillStyle = textColor;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('¥' + value, padding.left - 8, y + 4);
      }

      ctx.fillStyle = textColor;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      
      let lastMonth = -1;
      for (let i = 0; i < daysInPeriod; i++) {
        const currentDate = new Date(periodStartDate);
        currentDate.setDate(periodStartDate.getDate() + i);
        const dayOfMonth = currentDate.getDate();
        const month = currentDate.getMonth();
        const x = padding.left + gap + i * (barWidth + gap) + barWidth / 2;
        
        if (i % 5 === 0) {
          ctx.fillText(dayOfMonth, x, height - 25);
        }
        
        if (month !== lastMonth) {
          ctx.fillStyle = labelColor;
          ctx.font = '10px sans-serif';
          ctx.fillText(`${month + 1}月`, x, height - 8);
          ctx.fillStyle = textColor;
          ctx.font = '11px sans-serif';
          lastMonth = month;
        }
      }

      if (dailyBudget > 0) {
        const budgetY = padding.top + chartHeight - (dailyBudget / maxValue) * chartHeight;
        
        ctx.beginPath();
        ctx.setLineDash([8, 4]);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.moveTo(padding.left, budgetY);
        ctx.lineTo(width - padding.right, budgetY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#f59e0b';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`日均预算 ¥${dailyBudget.toFixed(1)}`, width - padding.right - 6, budgetY - 8);
      }

      ctx.fillStyle = labelColor;
      ctx.save();
      ctx.translate(22, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.font = '12px sans-serif';
      ctx.fillText('支出金额', 0, 0);
      ctx.restore();

      dates.forEach(date => {
        const dateObj = new Date(date);
        const periodStart = new Date(periodStartDate);
        periodStart.setHours(0, 0, 0, 0);
        dateObj.setHours(0, 0, 0, 0);
        const dayOffset = Math.floor((dateObj - periodStart) / (1000 * 60 * 60 * 24));
        
        if (dayOffset >= 0 && dayOffset < daysInPeriod) {
          const amount = dailyExpenses[date];
          const x = padding.left + gap + dayOffset * (barWidth + gap) + (barWidth / 2);
          const barHeight = (amount / maxValue) * chartHeight;
          const dayOfMonth = dateObj.getDate();
          const isHovered = hoveredDay === dayOfMonth;
          const currentBarWidth = isHovered ? barWidth * 1.3 : barWidth;
          
          const gradient = ctx.createLinearGradient(x - currentBarWidth/2, padding.top + chartHeight, x - currentBarWidth/2, padding.top + chartHeight - barHeight);
          gradient.addColorStop(0, '#4f46e5');
          gradient.addColorStop(0.5, '#6366f1');
          gradient.addColorStop(1, '#8b5cf6');
          
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.roundRect(x - currentBarWidth/2, padding.top + chartHeight - barHeight, currentBarWidth, barHeight, currentBarWidth / 3);
          ctx.fill();

          ctx.shadowColor = isHovered ? 'rgba(99, 102, 241, 0.5)' : 'rgba(99, 102, 241, 0.3)';
          ctx.shadowBlur = isHovered ? 8 : 4;
          ctx.shadowOffsetY = 2;
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;

          if (isHovered && barHeight > 10) {
            ctx.fillStyle = isDarkMode ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.9)';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            const labelY = padding.top + chartHeight - barHeight - 8;
            ctx.fillText('¥' + Math.round(amount), x, labelY);
          }
        }
      });
    };

    drawChart();

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / canvas.offsetWidth * width;
      const y = (e.clientY - rect.top) / canvas.offsetHeight * height;

      let foundDay = null;
      for (const date of dates) {
        const dateObj = new Date(date);
        const periodStart = new Date(periodStartDate);
        periodStart.setHours(0, 0, 0, 0);
        dateObj.setHours(0, 0, 0, 0);
        const dayOffset = Math.floor((dateObj - periodStart) / (1000 * 60 * 60 * 24));
        
        if (dayOffset >= 0 && dayOffset < daysInPeriod) {
          const barX = padding.left + gap + dayOffset * (barWidth + gap) + (barWidth / 2);
          const barHeight = (dailyExpenses[date] / maxValue) * chartHeight;
          
          if (x >= barX - barWidth/2 && x <= barX + barWidth/2 &&
              y >= padding.top + chartHeight - barHeight && y <= padding.top + chartHeight) {
            foundDay = dateObj.getDate();
            break;
          }
        }
      }

      if (foundDay !== hoveredDay) {
        hoveredDay = foundDay;
        drawChart(hoveredDay);
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoveredDay !== null) {
        hoveredDay = null;
        drawChart();
      }
    });
  }

  setupSubtaskScrollDetection() {
    const subtaskLists = document.querySelectorAll('.subtasks-list');
    subtaskLists.forEach(list => {
      let scrollTimeout;
      list.addEventListener('scroll', () => {
        list.classList.add('scrolling');
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          list.classList.remove('scrolling');
        }, 1500);
      });
    });
  }

  setupTaskModal() {
    document.getElementById('closeTaskModal').addEventListener('click', () => this.closeTaskModal());
    document.getElementById('saveTaskBtn').addEventListener('click', () => this.saveTask());
    document.getElementById('taskModal').addEventListener('click', (e) => {
      if (e.target.id === 'taskModal') this.closeTaskModal();
    });
    
    

    document.getElementById('addTaskSubtaskBtn').addEventListener('click', () => this.addTaskSubtask());
  }

  taskSubtasks = [];

  addTaskSubtask() {
    const newSubtask = {
      id: Date.now().toString(),
      title: '',
      dueDate: '',
      completed: false,
      priority: 'normal',
      progress: 'pending'
    };
    this.taskSubtasks.push(newSubtask);
    this.renderTaskSubtasks();
  }

  removeTaskSubtask(index) {
    this.taskSubtasks.splice(index, 1);
    this.renderTaskSubtasks();
  }

  // ★ 主界面子任务删除（带确认框，操作 task.subtasks 原数据并持久化）
  async removeMainBoardSubtask(taskId, subtaskIndex) {
    const task = this.tasks.find(t => String(t.id) === String(taskId));
    if (!task || !task.subtasks || !task.subtasks[subtaskIndex]) return;

    const subtaskTitle = task.subtasks[subtaskIndex].title || '该子任务';
    const confirmed = confirm(`确定要删除子任务「${subtaskTitle}」吗？`);
    if (!confirmed) return;

    task.subtasks.splice(subtaskIndex, 1);
    await this.saveTasksDirect(task);
    this.renderDailyTasks();
  }

  updateTaskSubtaskTitle(index, value) {
    if (this.taskSubtasks[index]) {
      this.taskSubtasks[index].title = value;
    }
  }

  updateTaskSubtaskDueDate(index, value) {
    if (this.taskSubtasks[index]) {
      this.taskSubtasks[index].dueDate = value;
    }
  }

  updateTaskSubtaskPriority(index, value) {
    if (this.taskSubtasks[index]) {
      this.taskSubtasks[index].priority = value;
    }
  }

  updateTaskSubtaskProgress(index, value) {
    if (this.taskSubtasks[index]) {
      this.taskSubtasks[index].progress = value;
    }
  }

  toggleTaskSubtaskCompleted(index) {
    if (this.taskSubtasks[index]) {
      this.taskSubtasks[index].progress = this.taskSubtasks[index].progress === 'completed' ? 'pending' : 'completed';
      this.renderTaskSubtasks();
    }
  }

  renderTaskSubtasks() {
    const container = document.getElementById('taskSubtasksContainer');
    
    if (this.taskSubtasks.length === 0) {
      container.innerHTML = '<div class="no-subtasks">暂无子任务，点击上方按钮添加</div>';
      return;
    }

    container.innerHTML = this.taskSubtasks.map((subtask, index) => `
      <div class="subtask-item" data-index="${index}">
        <div class="subtask-title" contenteditable="${subtask.progress !== 'completed' ? 'true' : 'false'}"
             data-placeholder="子任务内容"
             oninput="window.appController.updateTaskSubtaskTitle(${index}, this.textContent.trim())">${subtask.title || ''}</div>
        <div class="subtask-controls">
          <input type="date" class="task-date-input" value="${subtask.dueDate || ''}"
                 onchange="window.appController.updateTaskSubtaskDueDate(${index}, this.value)"
                 ${subtask.progress === 'completed' ? 'disabled' : ''}>
          <select class="subtask-priority" 
                  onchange="window.appController.updateTaskSubtaskPriority(${index}, this.value)"
                  ${subtask.progress === 'completed' ? 'disabled' : ''}>
            <option value="urgent" ${subtask.priority === 'urgent' ? 'selected' : ''}>紧急</option>
            <option value="priority" ${subtask.priority === 'priority' ? 'selected' : ''}>优先</option>
            <option value="normal" ${subtask.priority === 'normal' || !subtask.priority ? 'selected' : ''}>普通</option>
            <option value="secondary" ${subtask.priority === 'secondary' ? 'selected' : ''}>次要</option>
          </select>
          <select class="subtask-progress" 
                  onchange="window.appController.updateTaskSubtaskProgress(${index}, this.value)"
                  ${subtask.progress === 'completed' ? 'disabled' : ''}>
            <option value="pending" ${subtask.progress === 'pending' || !subtask.progress ? 'selected' : ''}>待开始</option>
            <option value="in-progress" ${subtask.progress === 'in-progress' ? 'selected' : ''}>进行中</option>
            <option value="stalled" ${subtask.progress === 'stalled' ? 'selected' : ''}>已停滞</option>
            <option value="completed" ${subtask.progress === 'completed' ? 'selected' : ''}>已完成</option>
          </select>
          <button class="btn-delete-subtask" onclick="window.appController.removeTaskSubtask(${index})">×</button>
        </div>
      </div>
    `).join('');
  }

  clearTaskSubtasks() {
    this.taskSubtasks = [];
    this.renderTaskSubtasks();
  }

  setupExpenseModal() {
    document.getElementById('closeExpenseModal').addEventListener('click', () => this.closeExpenseModal());
    document.getElementById('saveExpenseBtn').addEventListener('click', () => this.saveExpense());
    document.getElementById('expenseModal').addEventListener('click', (e) => {
      if (e.target.id === 'expenseModal') this.closeExpenseModal();
    });
  }

  setupIpcListeners() {
    ipcRenderer.on('edit-task', (event, task) => {
      if (task && task.id) {
        this.openEditModal(task.id, 'task');
      }
    });

    ipcRenderer.on('tasks-updated', async () => {
      this.tasks = this.taskManager.getTasks();
      this.renderCalendar();
      this.renderDailyContent();
    });

    ipcRenderer.on('daily-tasks-updated', async () => {
      await this.loadDailyTasks();
    });

    ipcRenderer.on('memos-updated', async () => {
      // 重新从主进程加载最新的备忘录数据，确保与便利贴同步
      await this.loadMemos();
      
      // 完全清理所有状态，不管之前是什么
      if (window.currentQuill) {
        window.currentQuill = null;
      }
      
      // 检查编辑的备忘录是否还存在
      if (this.editingMemoId !== null) {
        if (this.editingMemoId === '') {
          // 删除备忘录后，重置新建状态
          this.editingMemoId = null;
        } else {
          const memoExists = this.memos.find(m => String(m.id) === String(this.editingMemoId));
          if (!memoExists) {
            this.editingMemoId = null;
          }
        }
      }
      
      this.renderMemos();
    });

    ipcRenderer.on('expenses-updated', async () => {
      this.expenses = this.expenseManager.getExpenses();
      this.renderDailyContent();
      this.renderStatistics();
    });

    ipcRenderer.on('secrets-updated', async () => {
      await this.loadSecrets();
      this.renderSecrets();
    });

    ipcRenderer.on('journals-updated', async () => {
      await this.loadJournals();
      this.renderJournalCalendar();
      this.loadJournalForDate(this.selectedDateStr);
    });

    ipcRenderer.on('data-changed', () => {
      this.notifyDataChange();
    });
  }

  setupDragAndDrop() {
    const memoContainer = document.getElementById('memosContainer');
    const rightPanel = document.querySelector('.right-panel');

    const handleDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
      rightPanel.classList.add('drag-over');
    };

    const handleDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      rightPanel.classList.remove('drag-over');
    };

    const handleDrop = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      rightPanel.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      let successCount = 0;
      for (const file of files) {
        const ext = file.name.toLowerCase();
        if (ext.endsWith('.txt') || ext.endsWith('.docx')) {
          try {
            const result = await ipcRenderer.invoke('read-file-content', file.path);
            if (result.success) {
              const memo = {
                title: file.name.replace(/\.(txt|docx)$/i, ''),
                content: result.content,
                creator: XilianSettings._config?.aiUserName || '我'
              };
              await this.memoManager.saveMemo(memo);
              successCount++;
            } else {
              alert(`读取文件失败：${result.error}`);
            }
          } catch (error) {
            console.error('处理文件失败：', error);
            alert(`处理文件失败：${error.message}`);
          }
        }
      }
      
      if (successCount > 0) {
        await this.loadMemos();
        this.renderMemos();
        alert(`成功添加了 ${successCount} 个文件`);
      }
    };

    rightPanel.addEventListener('dragover', handleDragOver);
    rightPanel.addEventListener('dragleave', handleDragLeave);
    rightPanel.addEventListener('drop', handleDrop);
  }

  initTaskTags() {
    const tagInput = document.getElementById('taskTagInput');
    const presetTagsContainer = document.getElementById('taskPresetTags');

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && tagInput.value.trim()) {
        e.preventDefault();
        this.addTaskTag(tagInput.value.trim());
        tagInput.value = '';
      }
    });

    presetTagsContainer.addEventListener('click', (e) => {
      if (e.target.classList.contains('preset-tag')) {
        this.addTaskTag(e.target.dataset.tag);
      }
    });
  }

  initExpenseTags() {
    const tagInput = document.getElementById('expenseTagInput');
    const presetTagsContainer = document.getElementById('expensePresetTags');

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && tagInput.value.trim()) {
        e.preventDefault();
        this.addExpenseTag(tagInput.value.trim());
        tagInput.value = '';
      }
    });

    presetTagsContainer.addEventListener('click', (e) => {
      if (e.target.classList.contains('preset-tag')) {
        this.addExpenseTag(e.target.dataset.tag);
      }
    });
  }

  setupNewMemoButton() {
    const newMemoBtn = document.getElementById('newMemoBtn');
    if (newMemoBtn) {
      newMemoBtn.addEventListener('click', () => this.startNewMemo());
    }
    
    const toggleBtn = document.getElementById('togglePrivateBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.togglePrivateView());
    }
  }
  
  // 切换私密视图
  togglePrivateView() {
    this.showPrivateMemos = !this.showPrivateMemos;
    const toggleBtn = document.getElementById('togglePrivateBtn');
    
    if (!toggleBtn) return;
    
    if (this.showPrivateMemos) {
      toggleBtn.textContent = '🔒 私密备忘录';
      toggleBtn.title = '显示公开备忘录';
    } else {
      toggleBtn.textContent = '备忘录';
      toggleBtn.title = '显示私密备忘录';
    }
    
    // 清理编辑状态
    this.editingMemoId = null;
    if (window.currentQuill) {
      window.currentQuill = null;
    }
    
    this.renderMemos();
  }

  loadPresetExpenseTags() {
    const allCategories = new Set();
    this.expenses.forEach(e => {
      if (e.category) allCategories.add(e.category);
    });

    const defaultTags = ['餐饮', '交通', '购物', '娱乐', '医疗', '教育', '居住', '工资', '奖金', '投资'];
    const presetTagsContainer = document.getElementById('expensePresetTags');
    presetTagsContainer.innerHTML = '';

    const allTags = new Set([...defaultTags, ...allCategories]);
    allTags.forEach(tag => {
      const span = document.createElement('span');
      span.className = 'preset-tag';
      span.dataset.tag = tag;
      span.textContent = tag;
      presetTagsContainer.appendChild(span);
    });
  }

  loadPresetTaskTags() {
    const allCategories = new Set();
    this.tasks.forEach(t => {
      if (t.tags) t.tags.forEach(tag => allCategories.add(tag));
    });

    const defaultTags = ['工作', '生活', '学习', '重要'];
    const presetTagsContainer = document.getElementById('taskPresetTags');
    presetTagsContainer.innerHTML = '';

    const allTags = new Set([...defaultTags, ...allCategories]);
    allTags.forEach(tag => {
      const span = document.createElement('span');
      span.className = 'preset-tag';
      span.dataset.tag = tag;
      span.textContent = tag;
      presetTagsContainer.appendChild(span);
    });
  }

  addExpenseTag(tag) {
    if (tag && !this.expenseTags.includes(tag)) {
      this.expenseTags = [tag];
      this.renderExpenseTags();
      this.expenseCategory = tag;
    }
  }

  removeExpenseTag(tag) {
    this.expenseTags = this.expenseTags.filter(t => t !== tag);
    this.renderExpenseTags();
    if (this.expenseCategory === tag) {
      this.expenseCategory = '';
    }
  }

  renderExpenseTags() {
    const container = document.getElementById('expenseTagsContainer');
    container.innerHTML = this.expenseTags.map(tag => `
      <span class="tag-item">
        ${tag}
        <span class="remove-tag" onclick="window.appController.removeExpenseTag('${tag}')">×</span>
      </span>
    `).join('');
  }

  addTaskTag(tag) {
    if (tag && !this.taskTags.includes(tag)) {
      this.taskTags.push(tag);
      this.renderTaskTags();
    }
  }

  removeTaskTag(tag) {
    this.taskTags = this.taskTags.filter(t => t !== tag);
    this.renderTaskTags();
  }

  renderTaskTags() {
    const container = document.getElementById('taskTagsContainer');
    container.innerHTML = this.taskTags.map(tag => `
      <span class="tag-item">
        ${tag}
        <span class="remove-tag" onclick="window.appController.removeTaskTag('${tag}')">×</span>
      </span>
    `).join('');
  }

  renderCalendar() {
    const currentDateFullEl = dom.get('currentDateFull');

    const [year, month, day] = this.selectedDateStr.split('-').map(Number);
    this.currentYear = year;
    this.currentMonth = month - 1;

    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const selectedDateObj = new Date(year, month - 1, day);
    const weekDay = weekDays[selectedDateObj.getDay()];
    currentDateFullEl.textContent = `${this.currentYear}年${this.currentMonth + 1}月${day}日 ${weekDay}`;

    this.renderDailyContent();
    this.renderStatistics();
  }

    

  isExpenseOnDate(expense, dateStr) {
    if (typeof expense.date === 'string') {
      const normalizedDate = expense.date.replace(/\//g, '-');
      if (normalizedDate.length === 10) {
        return normalizedDate === dateStr;
      }
      if (normalizedDate.length >= 10) {
        return normalizedDate.substring(0, 10) === dateStr;
      }
    }
    const expenseDate = new Date(expense.date);
    if (isNaN(expenseDate.getTime())) {
      return false;
    }
    return utils.formatDateKey(expenseDate) === dateStr;
  }

  renderDailyContent() {
    const titleEl = dom.get('selectedDateTitle');
    const todayStr = utils.formatDateKey(new Date());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = utils.formatDateKey(yesterday);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = utils.formatDateKey(tomorrow);

    if (titleEl) {
      if (this.selectedDateStr === todayStr) {
        titleEl.textContent = '今日';
      } else if (this.selectedDateStr === yesterdayStr) {
        titleEl.textContent = '昨天';
      } else if (this.selectedDateStr === tomorrowStr) {
        titleEl.textContent = '明天';
      } else {
        titleEl.textContent = this.selectedDateStr;
      }
    }

    this.renderDailyTasks();
    this.renderDailyExpenses();
  }

  setupTaskSubtaskCheckbox() {
    document.addEventListener('change', (e) => {
      if (e.target.classList.contains('task-subtask-checkbox')) {
        const isChecked = e.target.checked;
        const subtaskItem = e.target.closest('.subtask-preview-item');
        
        const taskId = e.target.dataset.taskId;
        const subtaskIndex = parseInt(e.target.dataset.subtaskIndex);
        
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        if (task && task.subtasks && task.subtasks[subtaskIndex]) {
          task.subtasks[subtaskIndex].completed = isChecked;
          task.subtasks[subtaskIndex].progress = isChecked ? 'completed' : 'pending';
          
          if (subtaskItem) {
            subtaskItem.classList.toggle('completed', isChecked);
          }
          
          this.saveTasksDirect(task);
        }
      }
    });
  }

  async saveTasksDirect(task) {
    await this.taskManager.updateTask(task.id, task);
  }

  async saveTasks() {
    for (const task of this.tasks) {
      await this.taskManager.updateTask(task.id, task);
    }
  }

  // ── 今日任务独立分区 ──
  renderDailyTasksSection() {
    const section = dom.get('dailyTasksSection');
    const listEl = dom.get('dailyTasksContainerList');
    const countEl = dom.get('dailyTasksCount');
    const addRow = document.getElementById('dailyTaskAddRow');

    if (!section || !listEl) return;

    const today = new Date().toISOString().slice(0, 10);
    // ★ 所有今日任务永不消失，跨天自动重置勾选
    const tasks = [...(this.dailyTasks || [])];
    // 跨天重置：如果 dailyDate !== today，强制 completed = false（今天是新的一天）
    for (const t of tasks) {
      if (t.dailyDate !== today) t.completed = false;
    }
    tasks.sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0));

    if (countEl) {
      const remaining = tasks.filter(t => !t.completed).length;
      countEl.textContent = remaining > 0 ? `${remaining} 项待完成` : '';
    }

    section.style.display = 'block';

    listEl.innerHTML = '';
    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="daily-tasks-empty">暂无今日任务，点击下方「+」添加</div>';
    } else {
      const frag = document.createDocumentFragment();
      for (const dt of tasks) {
        const item = document.createElement('div');
        const isDone = dt.completed === true;
        item.className = 'daily-task-item' + (isDone ? ' completed' : '');
        item.dataset.id = dt.id;
        item.innerHTML = `
          <input type="checkbox" class="daily-task-checkbox" data-id="${dt.id}" ${isDone ? 'checked' : ''}>
          <div class="daily-task-title" contenteditable="true" data-id="${dt.id}" data-original="${utils.escapeHtml(dt.title || '').replace(/"/g, '&quot;')}">${dt.title ? dt.title.replace(/\n/g, '<br>') : ''}</div>
          <button class="daily-task-delete" data-id="${dt.id}" title="删除">×</button>
        `;
        frag.appendChild(item);
      }
      listEl.appendChild(frag);
    }

    // ------ 内联编辑：contenteditable div ------
    const handleTitleEdit = (div) => {
      const original = div.dataset.original || '';
      const id = div.dataset.id;
      let saved = false;
      const save = async () => {
        if (saved) return;
        saved = true;
        const text = div.innerText.trim();
        if (text && text !== original) {
          await ipcRenderer.invoke('daily-task-update', id, { title: text });
        } else if (!text) {
          // 空内容恢复原文，等 loadDailyTasks 重新渲染
        }
        this.loadDailyTasks();
      };
      const exit = () => { div.contentEditable = 'false'; save(); };
      div.addEventListener('blur', exit);
      div.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && ev.shiftKey) return; // Shift+Enter → 换行
        if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); exit(); return; }
        if (ev.key === 'Escape') { div.contentEditable = 'false'; this.loadDailyTasks(); }
      });
    };
    listEl.querySelectorAll('.daily-task-title[contenteditable]').forEach(handleTitleEdit);

    // 列表事件委托
    listEl.onclick = (e) => {
      const checkbox = e.target.closest('.daily-task-checkbox');
      if (checkbox) return;
      const delBtn = e.target.closest('.daily-task-delete');
      if (delBtn) return;
    };

    // checkbox 事件（独立于 onclick 避免冲突）
    listEl.onchange = (e) => {
      const checkbox = e.target.closest('.daily-task-checkbox');
      if (checkbox) {
        const id = checkbox.dataset.id;
        // ★ 勾选/取消勾选时同步写入当天日期，这样第二天跨天自动重置
        const today = new Date().toISOString().slice(0, 10);
        ipcRenderer.invoke('daily-task-update', id, { completed: checkbox.checked, dailyDate: today }).then(() => this.loadDailyTasks());
      }
    };

    // 删除按钮事件（独立处理）
    listEl.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.daily-task-delete');
      if (!delBtn) return;
      e.stopPropagation();
      const id = delBtn.dataset.id;
      ipcRenderer.invoke('daily-task-delete', id).then(() => this.loadDailyTasks());
    }, { once: false });

    // + 添加今日任务 行
    if (addRow) {
      addRow.onclick = () => {
        if (listEl.querySelector('.daily-task-edit-input[data-id=""]')) return; // 已有新建行
        const empty = listEl.querySelector('.daily-tasks-empty');
        if (empty) empty.remove();

        const editRow = document.createElement('div');
        editRow.className = 'daily-task-item';
        editRow.innerHTML = `
          <input type="checkbox" class="daily-task-checkbox" disabled>
          <input type="text" class="daily-task-edit-input" placeholder="输入任务名，Enter 确认">
          <button class="daily-task-delete" title="取消">×</button>
        `;
        listEl.appendChild(editRow);
        const input = editRow.querySelector('.daily-task-edit-input');
        input.focus();

        let _confirming = false; // ★ 防双击创建
        const cancel = () => {
          if (_confirming) return;
          editRow.remove();
          if (!listEl.children.length) this.renderDailyTasksSection();
        };
        const confirm = async () => {
          if (_confirming) return;
          _confirming = true;
          const title = input.value.trim();
          if (!title) { cancel(); return; }
          try {
            const task = { title, completed: false, dailyDate: new Date().toISOString().slice(0, 10) };
            const r = await ipcRenderer.invoke('daily-task-create', task);
            if (r && r.success) {
              const list = await ipcRenderer.invoke('daily-tasks-get');
              this.dailyTasks = list || [];
              this.renderDailyTasksSection();
            }
          } catch (e) {
            console.error('[每日任务] confirm error:', e);
            _confirming = false;
          }
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirm(); }
          if (e.key === 'Escape') cancel();
        });
        input.addEventListener('blur', () => { if (input.value.trim()) confirm(); else cancel(); });
        editRow.querySelector('.daily-task-delete').onclick = cancel;
      };
    }
  }

  async loadDailyTasks() {
    try {
      const tasks = await ipcRenderer.invoke('daily-tasks-get');
      this.dailyTasks = tasks || [];
      this.renderDailyTasksSection();
    } catch (e) {
      console.error('加载每日任务失败:', e);
    }
  }

  renderDailyTasks() {
    const tasksContainer = dom.get('dailyTasksContainer');
    const dayTasks = this.tasks.filter(t => this.isTaskOnDate(t, this.selectedDateStr));

    const priorityOrder = { urgent: 0, priority: 1, normal: 2, secondary: 3 };
    
    dayTasks.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      
      const isCompletedA = a.progress === 'completed';
      const isCompletedB = b.progress === 'completed';
      
      if (isCompletedA && !isCompletedB) return 1;
      if (!isCompletedA && isCompletedB) return -1;
      
      const priorityA = priorityOrder[a.priority] !== undefined ? priorityOrder[a.priority] : 2;
      const priorityB = priorityOrder[b.priority] !== undefined ? priorityOrder[b.priority] : 2;
      return priorityA - priorityB;
    });

    if (dayTasks.length === 0) {
      // ★ 修复：innerHTML 替换前释放容器内焦点，避免焦点链异常
      const activeEl = document.activeElement;
      if (activeEl && tasksContainer.contains(activeEl)) {
        activeEl.blur();
      }
      tasksContainer.innerHTML = '<div class="empty-state-small">暂无任务</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    
    for (const task of dayTasks) {
      const subtasks = task.subtasks ? [...task.subtasks] : [];
      const sortedSubtasks = subtasks.map((subtask, idx) => ({ ...subtask, originalIndex: idx })).sort((a, b) => {
        const isCompletedA = a.progress === 'completed';
        const isCompletedB = b.progress === 'completed';
        
        if (isCompletedA && !isCompletedB) return 1;
        if (!isCompletedA && isCompletedB) return -1;
        
        const priorityA = priorityOrder[a.priority] !== undefined ? priorityOrder[a.priority] : 2;
        const priorityB = priorityOrder[b.priority] !== undefined ? priorityOrder[b.priority] : 2;
        return priorityA - priorityB;
      });
      const completedCount = subtasks.filter(s => s.progress === 'completed').length;
      const totalSubtasks = subtasks.length;
      const progressPercent = totalSubtasks > 0 ? Math.round((completedCount / totalSubtasks) * 100) : 0;
      
      const priorityClass = this.getPriorityClass(task.priority);
      const priorityLabel = this.getPriorityLabel(task.priority);
      const progressLabel = this.getProgressLabel(task.progress);
      const progressClass = this.getProgressClass(task.progress);
      const isCompleted = task.progress === 'completed';
      
      const priorityGroupClass = this.getPriorityGroupClass(task.priority);
      
      const taskGroup = document.createElement('div');
      // ★ 方案E：默认展开，添加 task-group-expanded 类
      taskGroup.className = `task-group task-group-expanded${isCompleted ? ' task-group-completed' : ''} ${priorityGroupClass}`;
      taskGroup.setAttribute('data-id', task.id);
      // ★ 核选项：inline style 确保外层容器绝不裁剪内容（优先级高于一切CSS规则）
      taskGroup.style.overflow = 'visible';
      taskGroup.innerHTML = `
        <div class="task-main ${isCompleted ? 'task-completed' : ''} ${task.pinned ? 'task-pinned' : ''}" data-id="${task.id}">
          <div class="task-header-row" style="display:flex; align-items:center; width:100%;">
            <button class="task-collapse-btn" data-id="${task.id}" title="点击折叠/展开" aria-label="折叠展开">▼</button>
            <div class="task-info" style="flex:1 1 auto; min-width:0;">
              <div class="task-title editable" contenteditable="true" data-field="task-title" data-id="${task.id}">${utils.escapeHtml(task.title).replace(/\n/g, '<br>')}</div>
            </div>
            <div class="task-actions" style="display:inline-flex; align-items:center; justify-content:center; margin-left:auto;">
              <button class="menu-btn" style="display:inline-flex; align-items:center; justify-content:center;" data-id="${task.id}" data-type="task" data-completed="${isCompleted}" data-pinned="${task.pinned}">...</button>
            </div>
          </div>
          <div class="task-description editable" contenteditable="true" data-field="task-description" data-id="${task.id}" data-placeholder="点击添加任务描述...">${utils.escapeHtml(task.description || '').replace(/\n/g, '<br>')}</div>
          <div class="task-meta-row">
            <span class="task-progress">${completedCount}/${totalSubtasks} 个子任务</span>
            ${XilianUI.renderCreatorBadge(task.creator)}
            <div class="priority-dropdown-container">
              <button class="priority-btn ${priorityClass}" data-type="priority" data-id="${task.id}" data-current="${task.priority || 'normal'}">
                ${priorityLabel}
              </button>
              <div class="priority-dropdown-menu">
                <button class="priority-option priority-urgent" data-value="urgent">紧急</button>
                <button class="priority-option priority-high" data-value="priority">优先</button>
                <button class="priority-option priority-medium" data-value="normal">普通</button>
                <button class="priority-option priority-low" data-value="secondary">次要</button>
              </div>
            </div>
            <div class="priority-dropdown-container progress-container">
              <button class="priority-btn ${progressClass}" data-type="progress" data-id="${task.id}" data-current="${task.progress || 'pending'}">
                ${progressLabel}
              </button>
              <div class="priority-dropdown-menu">
                <button class="priority-option progress-pending" data-value="pending">待开始</button>
                <button class="priority-option progress-in-progress" data-value="in-progress">进行中</button>
                <button class="priority-option progress-stalled" data-value="stalled">已停滞</button>
                <button class="priority-option progress-completed" data-value="completed">已完成</button>
              </div>
            </div>
            <span class="task-date-range">
              <input type="date" class="task-date-input" data-field="startDate" data-id="${task.id}" value="${this.formatDateForInput(task.startDate)}" placeholder="开始日期">
              <span class="task-date-arrow">→</span>
              <input type="date" class="task-date-input" data-field="endDate" data-id="${task.id}" value="${this.formatDateForInput(task.endDate)}" placeholder="截止日期">
            </span>
          </div>
        </div>
      `;
      
      if (totalSubtasks > 0) {
        const subtasksContainer = document.createElement('div');
        subtasksContainer.className = 'task-subtasks-container';
        // ★ 核选项：inline style 确保子任务容器绝不裁剪
        subtasksContainer.style.cssText = 'max-height: none !important; overflow: visible !important; display: flex; flex-direction: column; gap: 6px;';
        
        const subtasksHeader = document.createElement('div');
        subtasksHeader.className = 'task-subtasks-header';
        subtasksHeader.innerHTML = `
          <span class="task-subtasks-title">子任务（${totalSubtasks}）</span>
          <div class="task-subtasks-progress-wrapper">
            <div class="task-subtasks-progress-bar">
              <div class="task-subtasks-progress-fill" style="width: ${progressPercent}%"></div>
            </div>
            <span class="task-subtasks-count">${completedCount}/${totalSubtasks}</span>
          </div>
        `;
        subtasksContainer.appendChild(subtasksHeader);
        
        const subtasksList = document.createElement('div');
        subtasksList.className = 'subtasks-list';
        // ★ 核选项：inline style 确保列表容器不限制高度
        subtasksList.style.cssText = 'max-height: none !important; overflow: visible !important; display: flex; flex-direction: column; gap: 6px; width: 100%;';
        
        for (const subtaskWrapper of sortedSubtasks) {
          const subtask = subtaskWrapper;
          const originalIndex = subtaskWrapper.originalIndex;
          const subPriorityClass = this.getPriorityClass(subtask.priority);
          const subProgressClass = this.getProgressClass(subtask.progress);
          const isSubCompleted = subtask.progress === 'completed';
          
          const subtaskRow = document.createElement('div');
          subtaskRow.className = `subtask-row${isSubCompleted ? ' subtask-completed' : ''}`;
          subtaskRow.setAttribute('data-task-id', task.id);
          subtaskRow.setAttribute('data-subtask-index', originalIndex);
          // ★ 两行布局：上标题+圆点，下控件靠左
          subtaskRow.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:10px 12px; overflow:visible !important; min-height:auto !important; height:auto !important; width:100%; box-sizing:border-box;';
          // ★ 标题行在上，控件行在下
          subtaskRow.innerHTML = `
            <div class="subtask-title-row" style="display:flex; align-items:flex-start; gap:6px; min-width:0;">
              <span class="subtask-bullet">◦</span>
              <div class="subtask-title editable" contenteditable="true" data-field="subtask-title" data-task-id="${task.id}" data-subtask-index="${originalIndex}" data-placeholder="子任务标题..." style="white-space:pre-wrap !important; word-break:break-word !important; overflow-wrap:break-word !important; line-height:1.5; display:block; flex:1; min-width:0;">${utils.escapeHtml(subtask.title).replace(/\n/g, '<br>')}</div>
            </div>
            <div class="subtask-controls">
              <input type="date" class="task-date-input subtask-date" data-field="subtask-dueDate" data-task-id="${task.id}" data-subtask-index="${originalIndex}" value="${subtask.dueDate ? subtask.dueDate.substring(0, 10) : ''}" ${isSubCompleted ? 'disabled' : ''} title="截止日期">
              <div class="priority-dropdown-container">
                <button class="priority-btn ${subPriorityClass}" data-type="subtask" data-task-id="${task.id}" data-subtask-index="${originalIndex}" data-current="${subtask.priority || 'normal'}">
                  ${this.getPriorityLabel(subtask.priority)}
                </button>
                <div class="priority-dropdown-menu">
                  <button class="priority-option priority-urgent" data-value="urgent">紧急</button>
                  <button class="priority-option priority-high" data-value="priority">优先</button>
                  <button class="priority-option priority-medium" data-value="normal">普通</button>
                  <button class="priority-option priority-low" data-value="secondary">次要</button>
                </div>
              </div>
              <div class="priority-dropdown-container progress-container">
                <button class="priority-btn ${subProgressClass}" data-type="subtask-progress" data-task-id="${task.id}" data-subtask-index="${originalIndex}" data-current="${subtask.progress || 'pending'}">
                  ${this.getProgressLabel(subtask.progress)}
                </button>
                <div class="priority-dropdown-menu">
                  <button class="priority-option progress-pending" data-value="pending">待开始</button>
                  <button class="priority-option progress-in-progress" data-value="in-progress">进行中</button>
                  <button class="priority-option progress-stalled" data-value="stalled">已停滞</button>
                  <button class="priority-option progress-completed" data-value="completed">已完成</button>
                </div>
              </div>
              <button class="btn-delete-subtask main-subtask-delete-btn" data-task-id="${task.id}" data-subtask-index="${originalIndex}" title="删除子任务">×</button>
            </div>
          `;
          subtasksList.appendChild(subtaskRow);
        }
        
        subtasksContainer.appendChild(subtasksList);
        
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-subtask main-add-subtask-btn';
        addBtn.setAttribute('data-task-id', task.id);
        addBtn.textContent = '+ 添加子任务';
        subtasksContainer.appendChild(addBtn);
        
        taskGroup.appendChild(subtasksContainer);
      } else {
        // ★ 方案E：无子任务时也显示添加按钮
        const subtasksContainer = document.createElement('div');
        subtasksContainer.className = 'task-subtasks-container task-subtasks-empty';
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-subtask main-add-subtask-btn';
        addBtn.setAttribute('data-task-id', task.id);
        addBtn.textContent = '+ 添加子任务';
        subtasksContainer.appendChild(addBtn);
        taskGroup.appendChild(subtasksContainer);
      }
      
      fragment.appendChild(taskGroup);
    }
    
    // ★ 修复：innerHTML 清空前释放容器内焦点，防止焦点链断裂
    const taskActiveEl = document.activeElement;
    if (taskActiveEl && tasksContainer.contains(taskActiveEl)) {
      taskActiveEl.blur();
    }
    tasksContainer.innerHTML = '';
    tasksContainer.appendChild(fragment);
    
    this.setupEditableFields();
    this.setupPrioritySelectors();
    this.setupTaskCollapse();
  }

  // ★ 方案E：任务折叠/展开交互
  setupTaskCollapse() {
    // 初始化折叠状态存储
    if (!this._collapsedTasks) this._collapsedTasks = new Set();
    
    const collapseBtns = document.querySelectorAll('.task-collapse-btn');
    collapseBtns.forEach(btn => {
      // 恢复折叠状态
      const taskId = btn.getAttribute('data-id');
      const taskGroup = btn.closest('.task-group');
      if (taskGroup && this._collapsedTasks.has(taskId)) {
        taskGroup.classList.add('task-group-collapsed');
        taskGroup.classList.remove('task-group-expanded');
        btn.classList.add('collapsed');
      }
      
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = btn.getAttribute('data-id');
        const tGroup = btn.closest('.task-group');
        if (!tGroup) return;
        
        const isCollapsed = tGroup.classList.contains('task-group-collapsed');
        if (isCollapsed) {
          tGroup.classList.remove('task-group-collapsed');
          tGroup.classList.add('task-group-expanded');
          btn.classList.remove('collapsed');
          this._collapsedTasks.delete(tid);
        } else {
          tGroup.classList.add('task-group-collapsed');
          tGroup.classList.remove('task-group-expanded');
          btn.classList.add('collapsed');
          this._collapsedTasks.add(tid);
        }
      });
    });
  }

  getPriorityClass(priority) {
    switch(priority) {
      case 'urgent': return 'priority-urgent';
      case 'priority': return 'priority-high';
      case 'secondary': return 'priority-low';
      default: return 'priority-medium';
    }
  }

  getPriorityGroupClass(priority) {
    switch(priority) {
      case 'urgent': return 'task-group-urgent';
      case 'priority': return 'task-group-high';
      case 'secondary': return 'task-group-low';
      default: return 'task-group-medium';
    }
  }

  getPriorityLabel(priority) {
    switch(priority) {
      case 'urgent': return '紧急';
      case 'priority': return '优先';
      case 'secondary': return '次要';
      default: return '普通';
    }
  }

  getProgressClass(progress) {
    switch(progress) {
      case 'in-progress': return 'progress-in-progress';
      case 'stalled': return 'progress-stalled';
      case 'completed': return 'progress-completed';
      default: return 'progress-pending';
    }
  }

  getProgressLabel(progress) {
    switch(progress) {
      case 'in-progress': return '进行中';
      case 'stalled': return '已停滞';
      case 'completed': return '已完成';
      default: return '待开始';
    }
  }

  formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  formatDateForInput(dateStr) {
    if (!dateStr) return '';
    return utils.formatDate(new Date(dateStr), 'YYYY-MM-DD');
  }

  setupEditableFields() {
    if (this.editableBlurHandler) {
      document.querySelectorAll('.editable').forEach(el => {
        el.removeEventListener('blur', this.editableBlurHandler);
      });
    }
    if (this.editableKeyHandler) {
      document.querySelectorAll('.editable').forEach(el => {
        el.removeEventListener('keydown', this.editableKeyHandler);
      });
      this.editableKeyHandler = null;
    }
    if (this.dateInputChangeHandler) {
      document.querySelectorAll('.task-date-input').forEach(input => {
        input.removeEventListener('change', this.dateInputChangeHandler);
      });
    }
    if (this.addSubtaskClickHandler) {
      document.querySelectorAll('.main-add-subtask-btn').forEach(btn => {
        btn.removeEventListener('click', this.addSubtaskClickHandler);
      });
    }

    document.querySelectorAll('.editable').forEach(el => {
      // ★ Enter 保存、Shift+Enter 换行：与每日任务统一操作逻辑
      el.addEventListener('keydown', this.editableKeyHandler = (e) => {
        if (e.key === 'Enter' && e.shiftKey) return;                  // Shift+Enter → 换行
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.target.blur(); } // Enter → 保存
        if (e.key === 'Escape') { e.target.blur(); }                  // Escape → 退出
      });
      el.addEventListener('blur', this.editableBlurHandler = async (e) => {
        const field = e.target.dataset.field;
        const taskId = e.target.dataset.id || e.target.dataset.taskId;
        const subtaskIndex = e.target.dataset.subtaskIndex;
        // ★ 关键修复：用 innerText 而非 textContent
        // textContent 读取 <div>第一行</div><div>第二行</div> 会丢失换行符（返回"第一行第二行"）
        // innerText 尊重渲染结构，正确返回"第一行\n第二行"
        let newValue = (e.target.innerText || e.target.textContent || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
        
        if (subtaskIndex !== undefined) {
          const task = this.tasks.find(t => String(t.id) === String(taskId));
          if (task && task.subtasks && task.subtasks[subtaskIndex]) {
            task.subtasks[subtaskIndex].title = newValue;
            await this.saveTasksDirect(task);
            this.renderDailyTasks();
          }
        } else {
          const task = this.tasks.find(t => String(t.id) === String(taskId));
          if (task) {
            if (field === 'task-title') {
              task.title = newValue;
            } else if (field === 'task-description') {
              task.description = newValue;
            }
            await this.saveTasksDirect(task);
            this.renderDailyTasks();
          }
        }
      });
    });

    document.querySelectorAll('.task-date-input').forEach(input => {
      input.addEventListener('change', this.dateInputChangeHandler = (e) => {
        const field = e.target.dataset.field;
        const taskId = e.target.dataset.id || e.target.dataset.taskId;
        const subtaskIndex = e.target.dataset.subtaskIndex;
        const newValue = e.target.value;
        
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        if (task) {
          if (subtaskIndex !== undefined && task.subtasks && task.subtasks[subtaskIndex]) {
            if (field === 'subtask-dueDate') {
              task.subtasks[subtaskIndex].dueDate = newValue || undefined;
            }
          } else {
            task[field] = newValue || undefined;
          }
          this.saveTasksDirect(task);
          this.renderDailyTasks();
        }
      });
    });

    document.querySelectorAll('.main-add-subtask-btn').forEach(btn => {
      btn.addEventListener('click', this.addSubtaskClickHandler = async (e) => {
        e.stopPropagation();
        const taskId = e.target.dataset.taskId;
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        if (task) {
          if (!task.subtasks) {
            task.subtasks = [];
          }
          const newSubtask = {
            id: Date.now().toString(),
            title: '',
            completed: false,
            priority: 'normal',
            progress: 'pending'
          };
          task.subtasks.push(newSubtask);
          await this.saveTasksDirect(task);
          this.renderDailyTasks();
        }
      });
    });

    // ★ 主界面子任务删除按钮事件绑定
    if (this.mainSubtaskDeleteHandler) {
      document.querySelectorAll('.main-subtask-delete-btn').forEach(btn => {
        btn.removeEventListener('click', this.mainSubtaskDeleteHandler);
      });
    }
    document.querySelectorAll('.main-subtask-delete-btn').forEach(btn => {
      btn.addEventListener('click', this.mainSubtaskDeleteHandler = (e) => {
        e.stopPropagation();
        const taskId = e.target.dataset.taskId;
        const subtaskIndex = parseInt(e.target.dataset.subtaskIndex);
        this.removeMainBoardSubtask(taskId, subtaskIndex);
      });
    });
  }

  setupPrioritySelectors() {
    if (this.priorityClickHandler) {
      document.removeEventListener('click', this.priorityClickHandler);
    }

    document.querySelectorAll('.priority-btn').forEach(btn => {
      btn.removeEventListener('click', this.priorityBtnClickHandler);
      btn.addEventListener('click', this.priorityBtnClickHandler = (e) => {
        e.stopPropagation();
        const currentBtn = e.currentTarget;
        
        const existingMenu = document.querySelector('.priority-dropdown-menu.show');
        if (existingMenu) {
          existingMenu.remove();
          return;
        }
        
        document.querySelectorAll('.priority-dropdown-menu').forEach(m => {
          if (!m.classList.contains('show')) {
            m.remove();
          }
        });
        
        const menu = document.createElement('div');
        menu.className = 'priority-dropdown-menu';
        menu.innerHTML = `
          <button class="priority-option priority-urgent" data-value="urgent">紧急</button>
          <button class="priority-option priority-high" data-value="priority">优先</button>
          <button class="priority-option priority-medium" data-value="normal">普通</button>
          <button class="priority-option priority-low" data-value="secondary">次要</button>
        `;
        
        const type = currentBtn.dataset.type;
        if (type === 'progress' || type === 'subtask-progress') {
          menu.innerHTML = `
            <button class="priority-option progress-pending" data-value="pending">待开始</button>
            <button class="priority-option progress-in-progress" data-value="in-progress">进行中</button>
            <button class="priority-option progress-stalled" data-value="stalled">已停滞</button>
            <button class="priority-option progress-completed" data-value="completed">已完成</button>
          `;
        }
        
        document.body.appendChild(menu);
        
        const btnRect = currentBtn.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        
        menu.style.position = 'fixed';
        menu.style.display = 'flex';
        
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        
        let left = btnRect.right - menuWidth;
        let top = btnRect.bottom + 4;
        
        if (left + menuWidth > windowWidth) {
          left = btnRect.left;
        }
        if (left < 0) left = 0;
        if (top + menuHeight > windowHeight) {
          top = btnRect.top - menuHeight - 4;
        }
        if (top < 0) top = btnRect.bottom + 4;
        
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        
        menu.classList.add('show');
        
        const handleOptionClick = (e) => {
          e.stopPropagation();
          const value = e.target.dataset.value;
          const taskId = currentBtn.dataset.taskId || currentBtn.dataset.id;
          const subtaskIndex = currentBtn.dataset.subtaskIndex;
          
          const task = this.tasks.find(t => String(t.id) === String(taskId));
          if (task) {
            if (type === 'subtask' && subtaskIndex !== undefined && task.subtasks && task.subtasks[subtaskIndex]) {
              task.subtasks[subtaskIndex].priority = value;
            } else if (type === 'subtask-progress' && subtaskIndex !== undefined && task.subtasks && task.subtasks[subtaskIndex]) {
              task.subtasks[subtaskIndex].progress = value;
            } else if (type === 'progress') {
              task.progress = value;
              if (value === 'completed' && task.subtasks) {
                task.subtasks.forEach(subtask => {
                  subtask.progress = 'completed';
                });
              }
            } else {
              task.priority = value;
            }
            this.saveTasksDirect(task);
            this.renderDailyTasks();
          }
          
          menu.remove();
          document.removeEventListener('click', handleDocumentClick);
        };
        
        const handleDocumentClick = (e) => {
          if (!menu.contains(e.target) && !currentBtn.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', handleDocumentClick);
          }
        };
        
        menu.querySelectorAll('.priority-option').forEach(option => {
          option.addEventListener('click', handleOptionClick);
        });
        
        setTimeout(() => {
          document.addEventListener('click', handleDocumentClick);
        }, 0);
      });
    });



    

  }

  renderDailyExpenses() {
    const expensesContainer = dom.get('dailyExpensesContainer');
    const dayExpenses = this.expenses.filter(e => this.isExpenseOnDate(e, this.selectedDateStr));

    const dateStr = this.selectedDateStr;
    const dateObj = new Date(dateStr);
    const formattedDate = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
    const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dateObj.getDay()];
    const element = dom.get('expenseDetailDate');
    if (element) {
      element.textContent = `${formattedDate} ${dayOfWeek} 收支明细`;
    }

    this.renderExpenseCalendar();

    if (dayExpenses.length === 0) {
      // ★ 修复：innerHTML 替换前释放容器内焦点
      const expActiveEl = document.activeElement;
      if (expActiveEl && expensesContainer.contains(expActiveEl)) {
        expActiveEl.blur();
      }
      expensesContainer.innerHTML = '<div class="empty-state-small">暂无收支记录</div>';
    } else {
      // ★ 修复：innerHTML 替换前释放容器内焦点
      const expActiveEl = document.activeElement;
      if (expActiveEl && expensesContainer.contains(expActiveEl)) {
        expActiveEl.blur();
      }
      expensesContainer.innerHTML = dayExpenses.map(expense => {
        const categoryIcon = this.getCategoryIcon(expense.category);
        return `
          <div class="item-card expense-card ${expense.type}" data-id="${expense.id}">
            <div class="expense-icon">${categoryIcon}</div>
            <div class="expense-info">
              <div class="expense-name">${utils.escapeHtml(expense.detail)}</div>
              <div class="expense-category">${utils.escapeHtml(expense.category)} <span class="expense-creator-badge">${XilianUI.renderCreatorBadge(expense.creator)}</span></div>
            </div>
            <div class="expense-amount">
              ${expense.type === 'income' ? '+' : '-'}¥${expense.amount.toFixed(2)}
            </div>
            <div class="item-actions">
              <button class="menu-btn" data-id="${expense.id}" data-type="expense">...</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  renderExpenseCalendar() {
    const calendarGrid = document.getElementById('expenseCalendarGrid');
    const calendarTitle = document.getElementById('expenseCalendarTitle');
    if (!calendarGrid || !calendarTitle) return;

    const date = this.selectedDate || new Date();
    const year = date.getFullYear();
    const month = date.getMonth();

    calendarTitle.textContent = `${year}年${month + 1}月`;

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDateObj = new Date(year, month, date.getDate());

    const dayExpenseMap = this.getDailyExpenseMap(year, month);

    let html = '';
    for (let i = 0; i < startDay; i++) {
      html += '<div class="calendar-day empty"></div>';
    }

    for (let day = 1; day <= totalDays; day++) {
      const dayDate = new Date(year, month, day);
      const dateKey = utils.formatDateKey(dayDate);
      const isToday = dayDate.getTime() === today.getTime();
      const isSelected = dayDate.getTime() === selectedDateObj.getTime();
      const netAmount = dayExpenseMap[dateKey] || 0;
      const hasAmount = netAmount !== 0;
      const isIncome = netAmount > 0;

      let classes = 'calendar-day';
      if (isToday) classes += ' today';
      if (isSelected) classes += ' selected';
      if (hasAmount) classes += ' has-expense';

      const amountText = hasAmount ? `${isIncome ? '+' : '-'}¥${Math.abs(netAmount).toFixed(2)}` : '';
      const amountClass = hasAmount ? `expense-amount ${isIncome ? 'income' : 'expense'}` : '';

      html += `
        <div class="${classes}" data-date="${dateKey}">
          <span class="day-number">${day}</span>
          ${hasAmount ? `<span class="${amountClass}">${amountText}</span>` : ''}
        </div>
      `;
    }

    const totalCells = startDay + totalDays;
    const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 0; i < remainingCells; i++) {
      html += '<div class="calendar-day empty"></div>';
    }

    calendarGrid.innerHTML = html;

    if (!this.calendarGridListenerAttached) {
      calendarGrid.addEventListener('click', (e) => {
        const dayEl = e.target.closest('.calendar-day');
        if (dayEl && !dayEl.classList.contains('empty')) {
          const dateKey = dayEl.dataset.date;
          if (dateKey) {
            this.handleCalendarDayClick(dateKey);
          }
        }
      });
      this.calendarGridListenerAttached = true;
    }
  }

  handleCalendarDayClick(dateKey) {
    if (this.calendarDebounceTimer) {
      clearTimeout(this.calendarDebounceTimer);
    }
    
    this.calendarDebounceTimer = setTimeout(() => {
      const [y, m, d] = dateKey.split('-').map(Number);
      this.selectedDate = new Date(y, m - 1, d);
      this.selectedDateStr = dateKey;
      this.renderDateNav();
      this.renderDailyExpenses();
      this.renderStatistics();
      this.renderCategoryBudget();
    }, 50);
  }

  getDailyExpenseMap(year, month) {
    const map = {};
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0);

    this.expenses.forEach(expense => {
      const expenseDate = new Date(expense.date);
      if (expenseDate >= startDate && expenseDate <= endDate) {
        const dateKey = utils.formatDateKey(expenseDate);
        if (expense.type === 'expense') {
          map[dateKey] = (map[dateKey] || 0) - expense.amount;
        } else if (expense.type === 'income') {
          map[dateKey] = (map[dateKey] || 0) + expense.amount;
        }
      }
    });

    return map;
  }

  renderExpenseSummary() {
    const date = this.selectedDate || new Date();
    const year = date.getFullYear();
    const month = date.getMonth();
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0);

    const monthExpenses = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = new Date(normalizedDate);
      return expenseDate >= startDate && expenseDate <= endDate && e.type === 'expense';
    });
    const totalExpense = monthExpenses.reduce((sum, e) => sum + e.amount, 0);

    const monthIncomes = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = new Date(normalizedDate);
      return expenseDate >= startDate && expenseDate <= endDate && e.type === 'income';
    });
    const totalIncome = monthIncomes.reduce((sum, e) => sum + e.amount, 0);

    const balance = totalIncome - totalExpense;

    const expenseSummary = document.querySelector('.summary-value.expense');
    const incomeSummary = document.querySelector('.summary-value.income');
    const balanceSummary = document.querySelector('.summary-value.balance');

    if (expenseSummary) expenseSummary.textContent = `-¥${totalExpense.toFixed(2)}`;
    if (incomeSummary) incomeSummary.textContent = `+¥${totalIncome.toFixed(2)}`;
    if (balanceSummary) balanceSummary.textContent = balance >= 0 ? `¥${balance.toFixed(2)}` : `-¥${Math.abs(balance).toFixed(2)}`;
  }

  getCategoryIcon(category) {
    const icons = {
      '餐饮': '🍽️',
      '交通': '🚇',
      '购物': '🛒',
      '娱乐': '🎮',
      '医疗': '🏥',
      '教育': '📚',
      '居住': '🏠',
      '工资': '💼',
      '奖金': '🎁',
      '投资': '📈',
      '其他': '📦'
    };
    return icons[category] || '📋';
  }

  renderStatistics() {
    const selectedDate = this.selectedDate || new Date();
    const selectedDateStr = utils.formatDateKey(selectedDate);
    
    let currentBudget = null;
    let isInPeriod = false;
    
    const selectedDateMidnight = new Date(selectedDate);
    selectedDateMidnight.setHours(0, 0, 0, 0);
    
    for (const budget of this.budgets) {
      const startDate = new Date(budget.startDate);
      const endDate = new Date(budget.endDate);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      
      if (selectedDateMidnight >= startDate && selectedDateMidnight <= endDate) {
        currentBudget = budget;
        isInPeriod = true;
        break;
      }
    }

    if (!currentBudget) {
      dom.get('suggestedBudget').textContent = '--';
      dom.get('suggestedBudgetTip').textContent = '';
      dom.get('todayExpense').textContent = '--';
      dom.get('predictedBalance').textContent = '--';
      dom.get('predictedBalance').className = 'finance-value';
      dom.get('remainingDays').textContent = '--';
      dom.get('expenseBar').style.width = '0%';
      dom.get('remainingBar').style.width = '0%';
      dom.get('progressText').textContent = '--';
      dom.get('budgetPeriodInfo').textContent = '暂无预算配置';
      return;
    }

    const startDate = this.startOfDay(new Date(currentBudget.startDate));
    const endDate = this.endOfDay(new Date(currentBudget.endDate));

    const periodIncomes = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate >= startDate && expenseDate <= endDate && e.type === 'income';
    });
    const periodIncomeTotal = periodIncomes.reduce((sum, e) => sum + e.amount, 0);

    const totalBudget = currentBudget.amount + periodIncomeTotal;

    const passedExpenses = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate >= startDate && expenseDate <= selectedDate && e.type === 'expense';
    });
    const passedExpenseTotal = passedExpenses.reduce((sum, e) => sum + e.amount, 0);

    const fixedCategories = ['餐饮', '交通', '医疗', '教育', '居住'];
    const fixedPassedExpenses = passedExpenses.filter(e => fixedCategories.includes(e.category || ''));
    const fixedPassedExpenseTotal = fixedPassedExpenses.reduce((sum, e) => sum + e.amount, 0);
    const nonFixedPassedExpenseTotal = passedExpenseTotal - fixedPassedExpenseTotal;

    const totalDays = this.getDaysInPeriod(startDate, endDate);
    const passedDays = isInPeriod ? this.getDaysPassed(startDate, selectedDate) : totalDays;

    const remainingDays = isInPeriod ? Math.max(0, totalDays - passedDays) : 0;

    let predictedEndingBalance = 0;
    if (isInPeriod) {
      if (remainingDays === 0) {
        predictedEndingBalance = totalBudget - passedExpenseTotal;
      } else if (passedDays > 0) {
        const fixedDailyAverage = fixedPassedExpenseTotal / passedDays;
        const predictedRemainingFixedExpense = fixedDailyAverage * remainingDays;
        const predictedTotalExpense = passedExpenseTotal + predictedRemainingFixedExpense;
        predictedEndingBalance = totalBudget - predictedTotalExpense;
      }
    }
    
    const selectedToday = this.startOfDay(selectedDate);
    const selectedYesterday = new Date(selectedToday);
    selectedYesterday.setDate(selectedYesterday.getDate() - 1);
    
    const expensesBeforeSelected = this.expenses.filter(e => {
      const normalizedDate = typeof e.date === 'string' ? e.date.replace(/\//g, '-') : e.date;
      const expenseDate = this.startOfDay(new Date(normalizedDate));
      return expenseDate >= startDate && expenseDate <= selectedYesterday && e.type === 'expense';
    });
    const expenseTotalBeforeSelected = expensesBeforeSelected.reduce((sum, e) => sum + e.amount, 0);
    
    const balanceBeforeSelected = totalBudget - expenseTotalBeforeSelected;
    const daysRemaining = isInPeriod ? Math.max(1, totalDays - this.getDaysPassed(startDate, selectedYesterday)) : 1;
    const suggestedDailyBudget = Math.max(0, balanceBeforeSelected / daysRemaining);

    const selectedDayExpense = this.expenses
      .filter(e => this.isExpenseOnDate(e, selectedDateStr) && e.type === 'expense')
      .reduce((sum, e) => sum + e.amount, 0);

    const suggestedBudgetEl = dom.get('suggestedBudget');
    const suggestedBudgetTipEl = dom.get('suggestedBudgetTip');
    
    if (totalBudget > 0) {
      suggestedBudgetEl.textContent = `¥${suggestedDailyBudget.toFixed(2)}`;
    } else {
      suggestedBudgetEl.textContent = '--';
    }
    suggestedBudgetTipEl.textContent = '';

    dom.get('todayExpense').textContent = `¥${selectedDayExpense.toFixed(2)}`;

    const predictedBalanceEl = dom.get('predictedBalance');
    predictedBalanceEl.textContent = totalBudget > 0
      ? (predictedEndingBalance >= 0 ? `+¥${predictedEndingBalance.toFixed(2)}` : `¥${predictedEndingBalance.toFixed(2)}`)
      : '--';
    predictedBalanceEl.className = `finance-value ${predictedEndingBalance >= 0 ? 'positive' : 'negative'}`;

    dom.get('remainingDays').textContent = remainingDays;

    const progressPercent = totalBudget > 0
      ? Math.min(100, (passedExpenseTotal / totalBudget) * 100)
      : 0;
    const remainingBudget = totalBudget - passedExpenseTotal;
    const remainingPercent = totalBudget > 0 ? (remainingBudget / totalBudget) * 100 : 0;

    dom.get('expenseBar').style.width = `${progressPercent}%`;
    dom.get('remainingBar').style.width = `${Math.max(0, remainingPercent)}%`;
    dom.get('progressText').textContent = totalBudget > 0
      ? `总预算: ¥${totalBudget.toFixed(2)} | 支出: ¥${passedExpenseTotal.toFixed(2)} | 剩余: ¥${remainingBudget.toFixed(2)}`
      : '--';

    const budgetPeriodInfoEl = dom.get('budgetPeriodInfo');
    const startDateStr = utils.formatDateKey(startDate);
    const endDateStr = utils.formatDateKey(endDate);
    budgetPeriodInfoEl.textContent = `${startDateStr} - ${endDateStr}`;
    
    this.renderCategoryBudget();
  }

  renderMemos() {
    const container = dom.get('memosContainer');
    if (this.editingMemoId !== null) {
      const memo = this.editingMemoId && this.editingMemoId !== '' 
        ? this.memos.find(m => String(m.id) === String(this.editingMemoId)) 
        : null;
      container.innerHTML = this.createMemoEditor(memo);
      
      // 渲染编辑器后，先绑定按钮事件，再初始化Quill
      this.setupMemoEditorEvents(container);
      this.bindDragEvents(container);
      
      // 立即初始化Quill编辑器
      this.initQuillEditor();
    } else {
      // 渲染列表前，完全清理编辑状态！
      if (window.currentQuill) {
        window.currentQuill = null;
      }
      
      // ★ 修复：删除数据后输入框失焦 BUG
      // 删除操作通过 confirm() 原生对话框阻塞渲染进程，之后 container.innerHTML = html
      // 会销毁容器内所有 DOM 元素。若 document.activeElement 在此容器内且未主动释放，
      // Electron/Chromium 的焦点链可能进入不一致状态，表现为窗口内所有输入框无法获得焦点。
      // 现象：鼠标移入输入框不变光标、点击无反应 → 需重启或用便利贴窗口焦点周期恢复。
      // 解决：innerHTML 替换前主动 blur 容器内的已聚焦元素，确保焦点链正确断开。
      const activeEl = document.activeElement;
      if (activeEl && container.contains(activeEl)) {
        activeEl.blur();
      }
      
      // 根据状态筛选是私密还是公开
      let filteredMemos;
      if (this.showPrivateMemos) {
        filteredMemos = this.memos.filter(m => m.isPrivate === true);
      } else {
        filteredMemos = this.memos.filter(m => !m.isPrivate || m.isPrivate === undefined);
      }
      
      // 搜索过滤
      if (this.searchKeyword) {
        filteredMemos = filteredMemos.filter(m => 
          m.content.toLowerCase().includes(this.searchKeyword) || 
          (m.title && m.title.toLowerCase().includes(this.searchKeyword))
        );
      }

      filteredMemos.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const aModified = new Date(a.lastModified || a.createdAt);
        const bModified = new Date(b.lastModified || b.createdAt);
        return bModified - aModified;
      });

      let html = filteredMemos.map(memo => this.createMemoCard(memo)).join('');

      const emptyText = this.showPrivateMemos 
        ? `<div class="empty-state"><h2>还没有私密备忘录</h2><p>点击备忘录的菜单，设为私密</p></div>`
        : `<div class="empty-state"><h2>还没有备忘录</h2><p>点击"新建备忘"记录你的想法吧！</p></div>`;

      if (filteredMemos.length === 0) {
        html = this.searchKeyword 
          ? `<div class="empty-state"><h2>未找到匹配的备忘录</h2><p>试试其他搜索词</p></div>`
          : emptyText;
      }

      container.innerHTML = html;
      
      this.bindDragEvents(container);
      this.setupMemoEditorEvents(container);
    }
  }
  
  // 备忘录卡片，带私密标记
  createMemoCard(memo) {
    let preview = memo.htmlContent || memo.content || '';
    preview = preview.replace(/<[^>]*>/g, '');
    if (preview.length > 150) {
      preview = preview.substring(0, 150) + '...';
    }
    
    let title = memo.title || '备忘';
    
    // 搜索高亮
    if (this.searchKeyword) {
      const escapedPreview = utils.escapeHtml(preview);
      const regex = new RegExp(`(${utils.escapeHtml(this.searchKeyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      preview = escapedPreview.replace(regex, '<mark>$1</mark>');
      const escapedTitle = utils.escapeHtml(title);
      title = escapedTitle.replace(regex, '<mark>$1</mark>');
    } else {
      preview = utils.escapeHtml(preview);
      title = utils.escapeHtml(title);
    }
    
    const dateStr = this.formatMemoDate(new Date(memo.createdAt));
    const contentText = (memo.htmlContent || memo.content || '').replace(/<[^>]*>/g, '');
    const wordCount = contentText.length;
    
    // 如果是私密模式下显示，加上🔒图标
    const prefix = memo.isPrivate ? '🔒 ' : '';
    
    return `
      <div class="memo-card ${memo.pinned ? 'memo-pinned' : ''}" data-id="${memo.id}">
        <div class="memo-header">
          <div class="memo-title">${prefix}${title}</div>
          <div class="memo-actions">
            <button class="menu-btn" data-id="${memo.id}" data-type="memo" data-pinned="${memo.pinned}" data-private="${memo.isPrivate ? 'true' : 'false'}">...</button>
          </div>
        </div>
        <div class="memo-content">${preview}</div>
        <div class="memo-footer">
          <span class="memo-time">${dateStr}</span>
          <div class="memo-footer-right">
            ${XilianUI.renderCreatorBadge(memo.creator)}
            <span class="memo-word-count">${wordCount} 字</span>
          </div>
        </div>
      </div>
    `;
  }

  createMemoEditor(memo) {
    const content = memo ? (memo.htmlContent || memo.content || '') : '';
    const title = memo ? (memo.title || memo.name || '') : '';

    return `
      <div class="memo-card memo-editor-card memo-editor-full nav-open" data-id="${memo ? memo.id : ''}">
        <div class="memo-header">
          <input type="text" class="memo-title-input" placeholder="请输入标题..." value="${title ? utils.escapeHtml(title) : ''}">
        </div>
        <div class="memo-editor-body">
          <aside class="memo-outline-nav" id="memoOutlineNav" aria-hidden="false">
            <div class="memo-outline-nav-title">目录</div>
            <div class="memo-outline-nav-inner" id="memoOutlineInner"></div>
          </aside>
          <div class="quill-editor-container">
            <div class="quill-editor" data-id="${memo ? memo.id : ''}">${memo && memo.htmlContent ? memo.htmlContent : (memo && memo.content ? utils.escapeHtml(memo.content) : '')}</div>
          </div>
        </div>
        <div class="memo-editor-actions">
          <button class="memo-outline-toggle" id="memoOutlineToggle" title="展开/收起目录导航" type="button">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            <span>目录</span>
          </button>
          <button class="memo-cancel-btn">✖ 取消</button>
          <button class="memo-save-btn">💾 保存</button>
        </div>
      </div>
    `;
  }

  setupMemoEditorEvents(container) {
    const memoCards = container.querySelectorAll('.memo-card');
    memoCards.forEach(card => {
      card.addEventListener('click', (e) => {
        // ★ 排除编辑器内部点击（含表格控件 overlay）：
        //   overlay(.memo-table-overlay) 挂在 .quill-editor-container 上，
        //   不在 .ql-container 内部，必须单独排除，否则 +/- 的 click 冒泡会触发 renderMemos() →
        //   编辑器被销毁重建 → 用旧 htmlContent 重载 → 表格增删被还原。
        if (e.target.closest('.menu-btn') ||
            e.target.closest('.memo-save-btn') ||
            e.target.closest('.memo-cancel-btn') ||
            e.target.closest('.memo-outline-toggle') ||
            e.target.closest('.memo-outline-nav') ||
            e.target.closest('.memo-title-input') ||
            e.target.closest('.memo-content-editor') ||
            e.target.closest('.ql-container') ||
            e.target.closest('.memo-table-overlay') ||
            e.target.closest('.memo-table-add')) {  // ★ 冗余保险：表格 +/- 按钮本身（stopPropagation 失效时兜底）
          return;
        }
        const id = card.dataset.id;
        this.editingMemoId = id;
        this.renderMemos();
      });
    });

    const saveBtn = container.querySelector('.memo-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const titleInput = container.querySelector('.memo-title-input');
        const title = titleInput ? titleInput.value.trim() : '';
        
        if (window.currentQuill) {
          const htmlContent = window.currentQuill.root.innerHTML;
          const textContent = window.currentQuill.getText().trim();
          
          // 允许保存只有标题或只有内容的备忘录
          if (textContent || title) {
            // 获取原备忘录，保留 isPrivate 标记
            const existingMemo = this.editingMemoId ? this.memos.find(m => String(m.id) === String(this.editingMemoId)) : null;
            const memo = {
              id: this.editingMemoId && this.editingMemoId !== '' ? this.editingMemoId : null,
              content: textContent,
              htmlContent: htmlContent,
              title: title,
              isPrivate: existingMemo ? existingMemo.isPrivate : (this.showPrivateMemos ? true : false),
              creator: existingMemo?.creator || XilianSettings._config?.aiUserName || '我'
            };
            const saveResult = await this.memoManager.saveMemo(memo);
            if (saveResult.success) {
              this.editingMemoId = null;
              window.currentQuill = null;
              this.memos = this.memoManager.getMemos();
              this.renderMemos();
              this.notifyDataChange();
              // 阶段 2：备忘录保存后异步喂给 MC 记忆管线
              if (!memo.isPrivate) {
                ipcRenderer.invoke('mc:ingest-memo', memo).catch(() => {});
              }
            } else {
              alert('保存备忘录失败: ' + saveResult.message);
            }
          }
        }
      });
    }

    const cancelBtn = container.querySelector('.memo-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingMemoId = null;
        window.currentQuill = null;
        this.renderMemos();
      });
    }

    // ★ 目录导航：展开/收起抽屉
    const outlineToggle = container.querySelector('.memo-outline-toggle');
    if (outlineToggle) {
      outlineToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMemoOutline();
      });
    }
  }

  // ===== 备忘录目录导航（飞书式标题大纲，抽屉式展开/收起，默认收起）=====
  toggleMemoOutline() {
    const card = document.querySelector('.memo-editor-card');
    if (!card) return;
    const open = card.classList.toggle('nav-open');
    const nav = document.getElementById('memoOutlineNav');
    if (nav) nav.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) this.buildMemoOutline();
  }

  buildMemoOutline() {
    const inner = document.getElementById('memoOutlineInner');
    if (!inner) return;
    const quill = window.currentQuill;
    if (!quill) return;
    const root = quill.root;
    const heads = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    if (heads.length === 0) {
      inner.innerHTML = '<div class="memo-outline-empty">暂无标题<br><span>行首输入 # / ## / ### 可生成标题</span></div>';
      return;
    }
    inner.innerHTML = heads.map((h, i) => {
      const level = parseInt(h.tagName.substring(1), 10);
      const text = (h.textContent || '').trim() || '（无标题）';
      return `<a class="memo-outline-item" data-level="${level}" data-idx="${i}" title="${utils.escapeHtml(text)}" style="padding-left:${4 + (level - 1) * 8}px">${utils.escapeHtml(text)}</a>`;
    }).join('');
    inner.querySelectorAll('.memo-outline-item').forEach((item, i) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.scrollMemoToHeading(heads[i]);
        inner.querySelectorAll('.memo-outline-item').forEach(x => x.classList.remove('active'));
        item.classList.add('active');
      });
    });
  }

  scrollMemoToHeading(heading) {
    const quill = window.currentQuill;
    if (!quill || !heading) return;
    const root = quill.root;
    const rootTop = root.getBoundingClientRect().top;
    const hTop = heading.getBoundingClientRect().top;
    root.scrollTo({ top: root.scrollTop + (hTop - rootTop) - 10, behavior: 'smooth' });
  }

  initQuillEditor() {
    // ★ 注册 Divider Blot（Quill 1.3.7 官方无 divider，需手动注册 hr 为合法 block embed）
    // 否则直接 DOM 插入 <hr> 会被 quill.update() 当未知节点删除 → 分割线不可见
    if (window.Quill && !window.__dividerBlotRegistered) {
      try {
        const BlockEmbed = window.Quill.import('blots/block/embed');
        class DividerBlot extends BlockEmbed {}
        DividerBlot.blotName = 'divider';
        DividerBlot.tagName = 'hr';
        window.Quill.register(DividerBlot);
        window.__dividerBlotRegistered = true;
      } catch (e) {
        console.warn('注册 Divider Blot 失败:', e);
      }
    }

    // ★ 注册表格 Blot（Quill 1.3.7 无原生表格，自定义为「不透明原子嵌入块」）
    // 核心设计：只注册 TableContainer 一个 Blot（继承 BlockEmbed，与 Divider 分割线同一策略）。
    //   - clipboard 管线（dangerouslyPasteHTML）把整张 <table> 当作不可分割的嵌入块保留；
    //   - 内部 <tbody>/<tr>/<td>/<p> 不再注册为子 Blot，build() 也不为其创建 Parchment 子节点，
    //     它们只是普通 DOM；单元格编辑交给浏览器原生 contenteditable；
    //   - update() 设为空操作，MutationObserver 把表格内部改动归属到这个嵌入块而不重渲染。
    // 这是「点 + / - 表格消失」的根因修复：之前内部子 Blot 被注册，点击增删行列后 Quill 的
    // 异步 reconcile 把这套非标准结构判定为非法、整块丢弃。改为原子嵌入块后，纯 DOM 增删安全保留。
    if (window.Quill && !window.__tableBlotRegistered) {
      try {
        const BlockEmbed = window.Quill.import('blots/block/embed');

        class TableContainer extends BlockEmbed {
          static create(value) {
            const domNode = document.createElement('table');
            domNode.classList.add('memo-table');
            // 从存储的 HTML 值还原表格内部结构（整体作为嵌入块内容）
            if (typeof value === 'string' && value.includes('<table')) {
              try {
                const tmp = document.createElement('div');
                tmp.innerHTML = value;
                const src = tmp.querySelector('table');
                if (src) {
                  domNode.className = src.className || 'memo-table';
                  domNode.innerHTML = src.innerHTML;
                }
              } catch (_) { /* 回退空表 */ }
            }
            return domNode;
          }
          static value(domNode) { return domNode.outerHTML; }
          // ★ 关键：在「构造函数」里解包 Quill Embed 的 contentNode span。
          //   Quill 的 Embed 构造（quill.core.js:5866）会把 domNode 的所有子节点塞进一个
          //   <span contenteditable=false>（contentNode），并补 leftGuard/rightGuard 文本节点，
          //   使表格内部变成 <table>guard<span><tbody>…</tbody></span>guard</table> 畸形结构。
          //   注意：build() 在 Embed/Leaf/ShadowBlot 构造链里【根本不会被调用】（只有 ContainerBlot
          //   才在构造时调 build），所以必须在 constructor 里解包才会真正执行。
          //   解包后 <table> 直接持有 <tbody>/<tr>/<td>，结构正常且对 Quill 完全不透明，
          //   增删行列不会被 Quill 按旧结构 reconcile 还原。
          constructor(domNode) {
            super(domNode);
            try {
              if (this.contentNode && this.contentNode.parentNode === this.domNode) {
                while (this.contentNode.firstChild) {
                  this.domNode.insertBefore(this.contentNode.firstChild, this.contentNode);
                }
                this.contentNode.parentNode.removeChild(this.contentNode);
              }
              [this.leftGuard, this.rightGuard].forEach(g => {
                if (g && g.parentNode === this.domNode) this.domNode.removeChild(g);
              });
            } catch (_) { /* 解包失败不影响兜底 */ }
          }
          // 不透明嵌入块：忽略子节点变更，保留原生编辑内容，防止 Quill 在 update 时重渲染覆盖
          update() {}
          // ★ 不透明嵌入块：阻止 optimize 遍历时删除/重建。
          //   constructor 解包了 contentNode span（子节点从 <span> 移回 <table>），
          //   导致 Embed 内部结构不再符合 Quill 的"contentNode 持有所有内容"约定。
          //   若不覆写 optimize，Scroll.optimize() 遍历 blot 树时可能判定此嵌入块结构损坏
          //   → 整块删除或用 value() 重建（回到修改前的旧 HTML）→ 表格在 ~100-300ms 后消失。
          optimize() {}
        }
        TableContainer.blotName = 'table-container';
        TableContainer.tagName = 'table';

        window.Quill.register(TableContainer, true);
        window.__tableBlotRegistered = true;
      } catch (e) {
        console.warn('注册 Table Blot 失败:', e);
      }
    }

    const quillElement = document.querySelector('.quill-editor');

    // 确保只在元素存在时继续
    if (!quillElement) return;
    
    // 保存原始内容，以防初始化失败
    const originalContent = quillElement.innerHTML;
    
    // 先完全清理旧编辑器
    if (window.currentQuill) {
      try {
        // 尝试销毁旧编辑器
        const oldEditor = window.currentQuill;
        window.currentQuill = null;
        
        // 清理 DOM 上可能残留的 Quill 类和内容
        if (quillElement.classList) {
          quillElement.innerHTML = '';
        }
      } catch (e) {
        console.warn('清理旧编辑器失败:', e);
        window.currentQuill = null;
      }
    }
    
    // 强制重新初始化，不管之前有没有
    // 隐藏工具栏，用户直接通过复制粘贴插入图片
    try {
      window.currentQuill = new Quill(quillElement, {
        theme: 'snow',
        modules: {
          toolbar: false
        },
        placeholder: '在这里写下你的想法...'
      });

      // ★ 粘贴清洗：剥离所有 color 格式（备忘录无颜色工具栏，白色文字来自外部深色主题网页粘贴）
      //   Quill 默认 clipboard 会保留内联 color 样式 → 白底上白字不可见
      try {
        window.currentQuill.clipboard.addMatcher(Node.ELEMENT_NODE, function(node, delta) {
          delta.ops = delta.ops.map(function(op) {
            if (op.attributes && op.attributes.color) {
              delete op.attributes.color;
            }
            return op;
          });
          return delta;
        });
      } catch (e) {
        console.warn('注册 clipboard color matcher 失败:', e);
      }
      
      // 如果是编辑已有备忘录，填充内容
      if (this.editingMemoId && this.editingMemoId !== '') {
        const memo = this.memos.find(m => String(m.id) === String(this.editingMemoId));
        if (memo) {
          // 优先使用 htmlContent，如果没有则使用 content
          // ★ 用 clipboard 管线加载：确保自定义 blot（表格/分割线）在云同步往返时正确重建，
          // 不再依赖 root.innerHTML 让 MutationObserver 异步 reconcile（对嵌套自定义 blot 不稳）。
          const loadHtml = (html) => {
            try {
              window.currentQuill.setText('');
              // source 用 'api'：避免重载时再次触发 Markdown 快捷键监听器（其只处理 source==='user'）
              window.currentQuill.clipboard.dangerouslyPasteHTML(0, html, 'api');
            } catch (e) {
              console.warn('dangerouslyPasteHTML 失败，回退 innerHTML:', e);
              window.currentQuill.root.innerHTML = html;
            }
          };
          if (memo.htmlContent && memo.htmlContent.trim()) {
            if (memo.htmlContent.length > 5000000) {
              console.warn('备忘录内容过大');
              const hasImages = memo.htmlContent.includes('<img');
              if (hasImages) {
                loadHtml(memo.htmlContent);
              } else {
                loadHtml(memo.htmlContent.substring(0, 5000000) + '<p>...内容已截断</p>');
              }
            } else {
              loadHtml(memo.htmlContent);
            }
          } else if (memo.content && memo.content.trim()) {
            window.currentQuill.setText(memo.content);
          }
        } else {
          console.warn('未找到对应的备忘录:', this.editingMemoId);
        }
      }
      
      // 添加图片粘贴支持
      this.setupImagePasteSupport(window.currentQuill);
      // ★ 增强：Markdown 语法快捷输入（- 列表、# 标题、> 引用、1. 有序、``` 代码块），无需工具栏
      this.setupMarkdownShortcuts(window.currentQuill);
      // ★ 增强：点击链接用系统浏览器打开
      this.setupLinkClickHandler(window.currentQuill);
      // ★ 增强：表格快捷键插入（| 表头1 | 表头2 | 回车）
      this._setupTableShortcut(window.currentQuill);
      // ★ 增强：飞书式 hover「+」控件（增删行列）
      this._setupTableControls(window.currentQuill);

      // ★ 目录导航：内容变化时刷新大纲（仅在导航展开时，节流 300ms）
      try {
        let outlineDebounce = null;
        window.currentQuill.on('text-change', () => {
          const card = document.querySelector('.memo-editor-card');
          if (!card || !card.classList.contains('nav-open')) return;
          if (outlineDebounce) clearTimeout(outlineDebounce);
          outlineDebounce = setTimeout(() => this.buildMemoOutline(), 300);
        });
      } catch (e) { /* 忽略大纲刷新注册失败 */ }

      // ★ 默认展开目录：初始化后立即构建一次大纲
      try {
        const card = document.querySelector('.memo-editor-card');
        if (card && !card.classList.contains('nav-open')) card.classList.add('nav-open');
        this.buildMemoOutline();
      } catch (e) { /* 忽略默认构建失败 */ }
    } catch (e) {
      console.error('初始化 Quill 编辑器失败:', e);
      // 恢复原始内容，确保界面不被破坏
      quillElement.innerHTML = originalContent;
    }
  }
  
  setupImagePasteSupport(quill) {
    if (!quill) return;
    
    // URL 正则：匹配 http/https/ftp/mailto 开头的链接
    const urlRegex = /(https?:\/\/[^\s<>"]+|ftp:\/\/[^\s<>"]+|mailto:[^\s<>"]+)/gi;
    
    quill.root.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      
      // ── 1) 图片粘贴（原有逻辑）──
      let hasImage = false;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault();
          hasImage = true;
          const file = item.getAsFile();
          if (file) {
            this.handlePasteImage(quill, file);
          }
          break;
        }
      }
      if (hasImage) return;
      
      // ── 2) 文本粘贴：检测纯 URL 并转为可点击链接 ──
      // 获取剪贴板纯文本
      const textPlain = e.clipboardData.getData('text/plain') || '';
      const textHtml = e.clipboardData.getData('text/html') || '';
      
      // 如果粘贴内容是一个完整的 URL（或主要是 URL），则手动插入为链接
      const trimmed = textPlain.trim();
      // 检测：整段文本就是 URL，或文本以 URL 开头且 URL 占大部分
      const urlMatch = trimmed.match(urlRegex);
      if (urlMatch && (urlMatch[0].length >= trimmed.length * 0.7)) {
        e.preventDefault();
        const url = urlMatch[0];
        const selection = quill.getSelection(true);  // 获取光标位置（聚焦时 fallback 到末尾）
        const index = selection ? selection.index : quill.getLength();
        
        // 如果 HTML 剪贴板中有标题文本（浏览器复制链接时常见），用它作为显示文字
        let displayText = url;
        const htmlTitleMatch = textHtml.match(/<a[^>]*title=["']([^"']*)["'][^>]*>/i) ||
                             textHtml.match(/<a[^>]*>([^<]*)<\/a>/i);
        if (htmlTitleMatch && htmlTitleMatch[1] && htmlTitleMatch[1] !== url) {
          displayText = htmlTitleMatch[1];
        }
        
        // 插入链接：用 Quill 的 link 格式
        quill.insertText(index, displayText, 'link', url, 'user');
        quill.setSelection(index + displayText.length, 0, 'silent');
        return;
      }
      
      // ── 3) 普通文本：让 Quill 默认处理后，再扫描未链接的 URL（异步兜底）──
      // 某些情况下 Quill 可能不自动链接（如从某些应用复制的富文本）
      setTimeout(() => {
        this.autoLinkUrls(quill);
      }, 50);
    });
    
    // ★ 自动扫描编辑器内容中的裸 URL，转为可点击链接
    this._autoLinkUrlsHandler = () => { this.autoLinkUrls(quill); };
  }
  
  /**
   * 扫描 Quill 编辑器内容，将未链接的裸 URL 自动转为 <a> 链接
   * @param {Quill} quill - Quill 实例
   */
  autoLinkUrls(quill) {
    if (!quill) return;
    // 匹配 http/https/ftp 链接（纯文本场景，无需 lookbehind/lookahead）
    const urlRegex = /(https?:\/\/[^\s<>"'\)\]]+|ftp:\/\/[^\s<>"'\)\]]+)/gi;
    const text = quill.getText();
    let match;
    const opsToFormat = [];
    
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      const start = match.index;
      // 检查该位置是否已有 link 格式（避免重复处理用户手动链接）
      try {
        const formats = quill.getFormat(start, url.length);
        if (formats && formats.link) continue;
      } catch (e) { /* 范围越界则跳过检查 */ }
      opsToFormat.push({ start, urlLen: url.length, url });
    }
    
    // 从后往前应用格式（避免偏移问题），逐个添加链接
    for (let i = opsToFormat.length - 1; i >= 0; i--) {
      const { start, urlLen, url } = opsToFormat[i];
      try {
        quill.formatText(start, urlLen, 'link', url, 'api');
      } catch (e) {
        // 忽略格式化错误
      }
    }
  }
  
  /**
   * 点击编辑器内的 <a> 链接时，用系统默认浏览器打开（而非在编辑器内跳转）
   * @param {Quill} quill - Quill 实例
   */
  setupLinkClickHandler(quill) {
    if (!quill) return;
    quill.root.addEventListener('click', (e) => {
      const linkEl = e.target.closest('a[href]');
      if (linkEl) {
        e.preventDefault();
        const url = linkEl.getAttribute('href');
        if (url && /^https?:\/\//i.test(url)) {
          // 通过主进程用系统浏览器打开（ipcRenderer 为模块级变量）
          ipcRenderer.invoke('open-external-url', url).catch(() => {});
        }
      }
    });
  }

  // ★ 表格快捷键：行内输入 `| 表头1 | 表头2 |` 后按回车，转换为表格
  _setupTableShortcut(quill) {
    if (!quill) return;
    quill.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const sel = quill.getSelection();
      if (!sel) return;
      const lineInfo = quill.getLine(sel.index);
      if (!lineInfo || !lineInfo[0]) return;
      const text = (lineInfo[0].domNode && lineInfo[0].domNode.textContent) || '';
      // ★ 简化快捷键：行首输入「=表格」或「=【表格】」回车 → 默认 3x3 表格（= 在退格键旁，单键即打）
      if (/^=\s*【?表格】?\s*$/.test(text)) {
        e.preventDefault();
        this._insertTable(quill, sel.index, 3); // 数字 = 列数，默认 3 列 3 行
        return;
      }
      // 兼容旧式 Markdown 语法：| 表头1 | 表头2 | 回车（仍保留，不冲突）
      const spec = text.match(/^\s*\|(.+)\|\s*$/);
      if (!spec) return;
      const cells = spec[1].split('|').map(s => s.trim());
      if (cells.length < 1) return;
      e.preventDefault();
      this._insertTable(quill, sel.index, cells);
    });
  }

  // 在指定位置插入表格（text-change 机制专用：调用方已删除原文本）
  _insertTableAtPosition(quill, pos, headers) {
    if (!quill) return;
    let headerCells, colCount, rowCount;
    if (typeof headers === 'number') {
      colCount = Math.max(1, headers);
      rowCount = 3;
      headerCells = [];
      for (let i = 0; i < colCount; i++) headerCells.push('表头' + (i + 1));
    } else {
      colCount = headers.length;
      rowCount = 2;
      headerCells = headers;
    }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '<table class="memo-table"><tbody>';
    html += '<tr class="memo-table-head">';
    headerCells.forEach(h => { html += '<td><p>' + esc(h) + '</p></td>'; });
    html += '</tr>';
    for (let r = 1; r < rowCount; r++) {
      html += '<tr>';
      for (let i = 0; i < colCount; i++) html += '<td><p><br></p></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    try {
      // ★ 关键修复：必须用 clipboard 管线插入，确保 Quill 正确 reconcile 自定义表格 Blot。
      // 直接 insertBefore + quill.update() 时，update() 先于 MutationObserver 记录到该节点而执行，
      // Quill 会把"游离"的 <table> 当成未知节点在下一周期删除 → 表现为空白。
      // source 用 'api'：避免本次粘贴再次触发 Markdown 快捷键监听器（其只处理 source==='user'），防止递归。
      quill.clipboard.dangerouslyPasteHTML(pos, html, 'api');
      // 光标进入第一个数据单元格（表格为不透明嵌入块，用原生 Selection 定位，不能用 Quill 选区）
      setTimeout(() => {
        const tbl = quill.root.querySelector('table.memo-table');
        if (tbl) {
          const cell = tbl.querySelector('tbody tr:nth-child(2) td') || tbl.querySelector('td');
          if (cell) {
            const range = document.createRange();
            range.selectNodeContents(cell);
            range.collapse(true);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(range);
          }
        }
      }, 10);
    } catch (err) {
      console.warn('插入表格失败:', err);
    }
  }

  // 在指定位置插入表格
  // headers 为数组时：首行用 headers 作表头，第二行为空数据行（兼容旧式 Markdown 语法）
  // headers 为数字时：生成 headers 列 × 3 行默认表格（首行「表头N」，其余空），即简化快捷键 `=表格`
  _insertTable(quill, index, headers) {
    if (!quill) return;
    let headerCells, colCount, rowCount;
    if (typeof headers === 'number') {
      colCount = Math.max(1, headers);
      rowCount = 3; // 表头 + 2 数据行 = 3 行
      headerCells = [];
      for (let i = 0; i < colCount; i++) headerCells.push('表头' + (i + 1));
    } else {
      colCount = headers.length;
      rowCount = 2; // 兼容旧式：表头 + 1 数据行
      headerCells = headers;
    }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '<table class="memo-table"><tbody>';
    // 表头行
    html += '<tr class="memo-table-head">';
    headerCells.forEach(h => { html += '<td><p>' + esc(h) + '</p></td>'; });
    html += '</tr>';
    // 空数据行
    for (let r = 1; r < rowCount; r++) {
      html += '<tr>';
      for (let i = 0; i < colCount; i++) html += '<td><p><br></p></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';

    // 删除触发行（spec 文本 + 其后换行）
    const lineInfo = quill.getLine(index);
    if (!lineInfo || !lineInfo[0]) return;
    const lineOffset = lineInfo[1];
    const lineStart = index - lineOffset;
    const specText = lineInfo[0].domNode.textContent || '';
    quill.deleteText(lineStart, specText.length + 1, 'api');

    // 构建 HTML 并交由 clipboard 管线插入（可靠 reconcile 自定义 blot，避免被当未知节点删除）
    try {
      // source 用 'api'：避免本次粘贴再次触发 Markdown 快捷键监听器（其只处理 source==='user'），防止递归。
      quill.clipboard.dangerouslyPasteHTML(lineStart, html, 'api');
      // 光标进入第一个数据单元格（表格为不透明嵌入块，用原生 Selection 定位，不能用 Quill 选区）
      const tbl = quill.root.querySelector('table.memo-table');
      if (tbl) {
        const cell = tbl.querySelector('tbody tr:nth-child(2) td') || tbl.querySelector('td');
        if (cell) {
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(range);
        }
      }
    } catch (err) {
      console.warn('插入表格失败:', err);
    }
  }

  // ★ 飞书式表格控件：鼠标移到表格边缘出现「+ / -」，点击增删行列
  _setupTableControls(quill) {
    if (!quill) return;
    const root = quill.root;
    const container = root.closest('.quill-editor-container') || root.parentElement;
    if (!container) return;
    container.style.position = 'relative';

    // 控件层（默认不拦截鼠标，仅按钮可点）
    const overlay = document.createElement('div');
    overlay.className = 'memo-table-overlay';
    container.appendChild(overlay);

    const makeBtn = (cls, label, title) => {
      const b = document.createElement('div');
      b.className = 'memo-table-add ' + cls;
      b.innerHTML = '<span>' + label + '</span>';
      b.title = title;
      overlay.appendChild(b);
      return b;
    };
    const addColBtn = makeBtn('memo-table-add-col', '+', '在右侧插入一列');
    const delColBtn = makeBtn('memo-table-del-col', '-', '删除当前列（鼠标所指列）');
    const addRowBtn = makeBtn('memo-table-add-row', '+', '在下方插入一行');
    const delRowBtn = makeBtn('memo-table-del-row', '-', '删除当前行（鼠标所指行）');
    overlay.style.display = 'none';

    let currentTable = null;
    let currentCell = null;

    const hide = () => { overlay.style.display = 'none'; currentTable = null; currentCell = null; };

    const showFor = (table) => {
      if (!table || !table.isConnected) return;
      currentTable = table;
      const cRect = container.getBoundingClientRect();
      const tRect = table.getBoundingClientRect();
      const relLeft = tRect.left - cRect.left;
      const relTop = tRect.top - cRect.top;
      const GAP = 22;
      // 右边缘：+ 在垂直中点，- 在中点上方（避开转角）
      addColBtn.style.left = (relLeft + tRect.width) + 'px';
      addColBtn.style.top = (relTop + tRect.height / 2) + 'px';
      delColBtn.style.left = (relLeft + tRect.width) + 'px';
      delColBtn.style.top = (relTop + tRect.height / 2 - GAP) + 'px';
      // 下边缘：+ 在水平中点，- 在中点左侧
      addRowBtn.style.left = (relLeft + tRect.width / 2) + 'px';
      addRowBtn.style.top = (relTop + tRect.height) + 'px';
      delRowBtn.style.left = (relLeft + tRect.width / 2 - GAP) + 'px';
      delRowBtn.style.top = (relTop + tRect.height) + 'px';
      overlay.style.display = 'block';
    };

    container.addEventListener('mousemove', (e) => {
      const td = e.target.closest('table.memo-table td');
      if (td) {
        currentCell = td;
        showFor(td.closest('table.memo-table'));
        return;
      }
      const table = e.target.closest('table.memo-table');
      if (table) {
        showFor(table);
      } else if (currentTable && !overlay.contains(e.target)) {
        hide();
      }
    });
    container.addEventListener('mouseleave', hide);
    root.addEventListener('scroll', hide, true);

    // ★ 单元格内编辑守卫：表格为不透明嵌入块，Quill 会把整表当单个字符。
    //   当原生光标落在单元格内时，在捕获阶段拦截按键交给浏览器原生 contenteditable 处理，
    //   阻止 Quill 退格/删除直接删掉整张表；并屏蔽 Enter 触发的块级插入（改用 <br> 单元格内换行）。
    root.addEventListener('keydown', (e) => {
      const sel = window.getSelection();
      if (!sel || !sel.anchorNode) return;
      const anchorEl = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      if (!anchorEl || !anchorEl.closest) return;
      const cell = anchorEl.closest('table.memo-table td');
      if (!cell) return;
      // 阻止 Quill 键盘模块处理（捕获阶段拦截，浏览器原生编辑仍生效）
      e.stopImmediatePropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        // 单元格内换行：插入 <br>，避免破坏 <p> 结构或生成新块
        try { document.execCommand('insertHTML', false, '<br>'); } catch (_) {}
        // 单元格内换行产生的结构变更也抽干 observer 队列，避免被 reconcile 还原
        Promise.resolve().then(() => {
          if (quill.scroll && quill.scroll.observer) quill.scroll.observer.takeRecords();
        });
      }
      // Backspace / Delete / 普通输入：不 preventDefault，由原生 contenteditable 处理
    }, true);

    // ★ 操作期间临时「断开」Quill 的 MutationObserver：disconnect → 执行 DOM 增删 → 重新 observe。
    //   比单纯 takeRecords 更彻底——连已排队记录和已调度回调一并清掉，确保 Quill 不会把表格
    //   按旧结构 reconcile 还原。断开窗口仅同步几微秒，不影响正常编辑。
    //
    // ★ 关键防御（v3）：在 fn() 执行期间将 table 从 DOM 树中临时移除（detach），
    //   操作完成后再放回原位（reattach）。这能彻底隔离 **scroll.js 的同步 DOMNodeInserted
    //   Mutation Events**（截图中 scroll.js:25 警告证实 Quill 1.3.7 使用了这套废弃 API）。
    //   MutationObserver.disconnect() 只影响异步 MO API，不影响同步 DOMNodeInserted！
    //   若不 detach，appendChild 等 DOM 操作会触发 scroll.js 的 DOMNodeInserted handler →
    //   该 handler 调度一个微/macrotask 在 ~60-100ms 后执行 update/optimize → 表格被删除/重建。
    //   删列（removeChild）触发 DOMNodeRemoved，scroll.js 对此事件处理不同 → 故删列不出问题。
    const OBS_CFG = { attributes: true, characterData: true, characterDataOldValue: true, childList: true, subtree: true };
    const pauseObserver = (fn) => {
      let obs = null;
      try { obs = quill.scroll && quill.scroll.observer; } catch (_) {}
      if (obs) { try { obs.takeRecords(); obs.disconnect(); } catch (_) {} }

      // ★ detach: 将表格从 DOM 树中临时移除，隔离同步 DOMNodeInserted（scroll.js:25）
      let tableParent = null, tableNextSibling = null;
      if (currentTable && currentTable.parentNode) {
        tableParent = currentTable.parentNode;
        tableNextSibling = currentTable.nextSibling;
        if (currentTable.isConnected) {
          try { tableParent.removeChild(currentTable); } catch (_) {}
        }
      }

      let fnOk = true;
      try { fn(); } catch (e) { fnOk = false; console.warn('[表格诊断] 表格操作失败:', e); }

      // ★ reattach: 无论 fn 是否成功，都确保表格回到原位（防御 fn 异常导致表格丢失）
      if (tableParent && currentTable) {
        if (currentTable.parentNode !== tableParent) {
          try {
            if (tableNextSibling && tableNextSibling.parentNode === tableParent) {
              tableParent.insertBefore(currentTable, tableNextSibling);
            } else {
              tableParent.appendChild(currentTable);
            }
          } catch (_) {}
        }
      }

      if (obs) { try { obs.takeRecords(); obs.observe(quill.scroll.domNode, OBS_CFG); } catch (_) {} }
    };

    // ★ 整表替换 helper（行操作专用）：删除旧 table 嵌入块，用 dangerouslyPasteHTML 插入新表。
    //   与创建表格（_insertTable / _insertTableAtPosition）走同一条已验证可靠的 clipboard 管线，
    //   使 Quill 把「行变化」视为「整块替换」而非「嵌入块内部 block 级（tr 数量）变更」，
    //   彻底避开 Quill 对嵌入块内部 block 结构变更的 reconcile 还原。
    //   列操作改的是 tr 内 td（叶子级）被 Quill 容忍故可用；行操作改 tr 数量（block 级）必然还原，
    //   故行必须用整表替换。
    const replaceTableBlot = (newHtml) => {
      try {
        const blot = window.Quill.find(currentTable);
        if (!blot) { console.warn('[表格诊断] 整表替换: 找不到 blot'); return false; }
        const index = blot.offset(quill.scroll);
        const len = (blot.length && blot.length()) ? blot.length() : 1;
        let obs = quill.scroll.observer;
        if (obs) { obs.takeRecords(); obs.disconnect(); }
        // ★ 原子替换：一次 updateContents 完成「删除旧块 + 插入新表」，避免两步法
        //   （deleteText + dangerouslyPasteHTML）之间触发 scroll.js 的 DOMNodeInserted
        //   异步 reconcile 删新表（用户日志：+60ms tr=4 存活，+100ms disconnected）。
        //   convert(html) 走 clipboard 管线解析（与创建表格同路），确保嵌入块正确创建。
        const Delta = window.Quill.import('delta');
        let pasteDelta;
        try { pasteDelta = quill.clipboard.convert(newHtml); }
        catch (_) { pasteDelta = new Delta().insert({ 'table-container': newHtml }); }
        const delta = new Delta().retain(index).delete(len).concat(pasteDelta);
        quill.updateContents(delta, 'api');
        if (obs) obs.observe(quill.scroll.domNode, OBS_CFG);
        const nt = quill.root.querySelector('table.memo-table');
        if (nt) currentTable = nt;
        return true;
      } catch (e) {
        console.warn('[表格诊断] 整表替换失败:', e);
        return false;
      }
    };

    // ★ 诊断：拦截 observer 回调，记录还原发生时机（用户可从控制台 Ctrl+Shift+I 贴回）
    if (!quill.__tblObsHooked) {
      quill.__tblObsHooked = true;
      const _origUpdate = quill.scroll.update.bind(quill.scroll);
      quill.scroll.update = function (m, c) {
        const before = (currentTable && currentTable.isConnected) ? currentTable.querySelectorAll('tr').length : null;
        const res = _origUpdate(m, c);
        if (before !== null) {
          const after = (currentTable && currentTable.isConnected) ? currentTable.querySelectorAll('tr').length : 'no-table';
          if (after !== before) {
            console.log('[表格诊断] observer update 改变了行数: before=', before, ' after=', after, ' 记录数=', (m && m.length) || 0);
          }
        }
        return res;
      };
    }
    const snapRows = () => {
      if (!currentTable) return 'no-ref';
      if (!currentTable.isConnected) return 'disconnected';
      // 详细状态：行数 + DOM路径 + 父节点tag
      const trs = currentTable.querySelectorAll('tr').length;
      const parent = currentTable.parentElement;
      const parentTag = parent ? parent.tagName : 'none';
      const grandParent = parent ? parent.parentElement : null;
      const gpTag = grandParent ? grandParent.tagName : 'none';
      return trs + ' (parent=' + parentTag + '/gp=' + gpTag + ')';
    };

    // ★ 精密诊断：监控 .ql-editor 直接子节点变化（增/删/排序），精确定位表格被谁移除
    let editorChildMonitor = null;
    const startEditorChildMonitor = () => {
      if (editorChildMonitor) return;
      try {
        editorChildMonitor = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type !== 'childList') continue;
            // 只关注 .ql-editor 直接子节点变化
            if (m.target !== quill.root) continue;
            m.removedNodes.forEach(n => {
              const isTable = n.tagName === 'TABLE' || (n.querySelector && n.querySelector('table.memo-table'));
              console.log('[表格诊断-子节点] .ql-editor 子节点被删除!', 
                'node=', n.tagName, 'class=', n.className, 
                'isTable=', !!isTable,
                'removedAt=', Date.now() % 100000,
                'stack=', new Error().stack.split('\n').slice(1, 5).join(' | '));
            });
            m.addedNodes.forEach(n => {
              const isTable = n.tagName === 'TABLE' || (n.querySelector && n.querySelector('table.memo-table'));
              if (isTable) {
                console.log('[表格诊断-子节点] .ql-editor 新增含table的子节点!',
                  'node=', n.tagName, 'class=', n.className,
                  'addedAt=', Date.now() % 100000);
              }
            });
          }
        });
        editorChildMonitor.observe(quill.root, { childList: true });
      } catch (_) {}
    };
    startEditorChildMonitor();

    // ★ 表格节点级守护者：监控 currentTable 自身的 parentNode 变化
    //   上轮诊断发现表格变成 disconnected 但 .ql-editor 子节点删除日志未出现
    //   → 说明不是 removeChild(table)，而是整个祖先容器被替换（如 container.innerHTML = ...）
    //   此 Observer 直接挂在表格上，即使父容器整体被替换也能捕获到
    let tableNodeMonitor = null;
    const startTableNodeMonitor = (tbl) => {
      if (tableNodeMonitor) try { tableNodeMonitor.disconnect(); } catch(_) {}
      if (!tbl) return;
      try {
        tableNodeMonitor = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'childList') {
              console.log('[表格诊断-节点] 表格内部子节点变化!',
                'added=', m.addedNodes.length, 'removed=', m.removedNodes.length,
                'tableConnected=', tbl.isConnected,
                'parent=', (tbl.parentNode && tbl.parentNode.tagName) || 'none',
                'at=', Date.now() % 100000);
            }
          }
        });
        tableNodeMonitor.observe(tbl, { childList: true, subtree: true });

        // 同时用一个专门的 Observer 监控表格与父节点的关系
        const parentObserver = new MutationObserver(() => {});
        // 用定时器检查 isConnected 状态变化
        const prevParent = tbl.parentNode;
        setInterval(() => {
          if (currentTable === tbl && !tbl.isConnected && prevParent !== null) {
            console.log('[表格诊断-守护] ⚠️ 表格脱离DOM树!',
              'prevParent=', prevParent ? prevParent.tagName : 'none',
              'currentTable===tbl', currentTable === tbl,
              'stack=', new Error().stack.split('\n').slice(1, 6).join(' | '));
          }
        }, 50);
        // 10秒后自动清理定时器
        setTimeout(() => {/* 定时器会在 GC 时回收 */}, 10000);
      } catch (_) {}
    };

    // ★ 通用：增删行列后处理。
    const rebuildTable = () => {
      try {
        if (!currentTable || !currentTable.isConnected) return;
        showFor(currentTable);
        const tdCount = currentTable.querySelectorAll('td').length;
        console.log('[表格诊断] 操作完成, td数=', tdCount, 'tr数=', snapRows());
        // 多时间点精密采样，定位消失时刻
        [10, 30, 60, 100, 150, 200, 300, 500].forEach(ms => {
          setTimeout(() => {
            console.log('[表格诊断] 快照 +' + ms + 'ms tr数=', snapRows());
          }, ms);
        });
      } catch (e) {
        console.warn('重定位表格控件失败:', e);
      }
    };

    // 增列：为每一行克隆最后一格（清空为空白单元格）追加
    addColBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止 mousedown 冒泡
      if (!currentTable || !currentTable.isConnected) return;
      pauseObserver(() => {
        currentTable.querySelectorAll('tr').forEach(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length === 0) return;
          const clone = tds[tds.length - 1].cloneNode(true);
          clone.innerHTML = '<p><br></p>';   // 清空为空白单元格（与默认结构一致）
          tr.appendChild(clone);
        });
      });
      rebuildTable();
    });
    addColBtn.addEventListener('click', (e) => e.stopPropagation()); // ★ 阻止 click 冒泡到 .memo-card → renderMemos()

    // 增行：用「整表替换」实现。先克隆一份在内存中增行，再用 dangerouslyPasteHTML 替换旧嵌入块。
    // 原因：Quill 对嵌入块内部「行数（tr，block 级）变化」会 reconcile 还原；列操作改的是 tr
    // 内的 td（叶子级，被容忍）故可用，行操作改 tr 数量（block 级）必然还原。整表替换让 Quill
    // 看到的是「删除旧块 + 插入新块」（原子操作，不 reconcile 内部），与创建表格走同一条可靠路径。
    addRowBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentTable || !currentTable.isConnected) return;
      const beforeRows = currentTable.querySelectorAll('tr').length;
      const tmp = currentTable.cloneNode(true);
      const tmpTbody = tmp.querySelector('tbody') || tmp;
      const tmpTrs = tmpTbody.querySelectorAll('tr');
      if (tmpTrs.length === 0) return;
      const clone = tmpTrs[tmpTrs.length - 1].cloneNode(true);
      clone.classList.remove('memo-table-head');
      clone.querySelectorAll('td').forEach(c => { c.innerHTML = '<p><br></p>'; });
      tmpTbody.appendChild(clone);
      const ok = replaceTableBlot(tmp.outerHTML);
      console.log('[表格诊断] 增行: before=', beforeRows, 'after=', currentTable.querySelectorAll('tr').length, 'ok=', ok, 'connected=', currentTable.isConnected);
      if (ok) rebuildTable();
    });
    addRowBtn.addEventListener('click', (e) => e.stopPropagation()); // ★ 阻止 click 冒泡到 .memo-card → renderMemos()

    // 删列：删除鼠标所指列（无所指则删最后一列），至少保留 1 列
    delColBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止 mousedown 冒泡
      if (!currentTable || !currentTable.isConnected) return;
      const firstRow = currentTable.querySelector('tr');
      if (!firstRow || firstRow.children.length <= 1) return; // 至少保留 1 列
      let colIndex;
      if (currentCell && currentTable.contains(currentCell)) {
        const cells = Array.prototype.slice.call(currentCell.parentElement.children)
          .filter(n => n.tagName === 'TD');
        colIndex = cells.indexOf(currentCell);
      } else {
        colIndex = firstRow.children.length - 1;
      }
      if (colIndex < 0) return;
      pauseObserver(() => {
        currentTable.querySelectorAll('tr').forEach(tr => {
          const cells = Array.prototype.slice.call(tr.children).filter(n => n.tagName === 'TD');
          if (cells[colIndex]) tr.removeChild(cells[colIndex]);
        });
      });
      currentCell = null;
      rebuildTable();
    });
    delColBtn.addEventListener('click', (e) => e.stopPropagation()); // ★ 阻止 click 冒泡到 .memo-card → renderMemos()

    // 删行：同样用「整表替换」实现，避免 block 级结构变化被 reconcile 还原。
    delRowBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentTable || !currentTable.isConnected) return;
      const beforeRows = currentTable.querySelectorAll('tr').length;
      const tmp = currentTable.cloneNode(true);
      const tmpTbody = tmp.querySelector('tbody') || tmp;
      const tmpTrs = tmpTbody.querySelectorAll('tr');
      if (tmpTrs.length <= 1) return; // 至少保留 1 行
      let target = tmpTrs[tmpTrs.length - 1];
      if (currentCell && currentTable.contains(currentCell)) {
        const cellTr = currentCell.closest('tr');
        if (cellTr) {
          const idx = Array.prototype.indexOf.call(currentTable.querySelectorAll('tr'), cellTr);
          if (idx >= 0 && tmpTrs[idx]) target = tmpTrs[idx];
        }
      }
      tmpTbody.removeChild(target);
      currentCell = null;
      const ok = replaceTableBlot(tmp.outerHTML);
      console.log('[表格诊断] 删行: before=', beforeRows, 'after=', currentTable.querySelectorAll('tr').length, 'ok=', ok, 'connected=', currentTable.isConnected);
      if (ok) rebuildTable();
    });
    delRowBtn.addEventListener('click', (e) => e.stopPropagation()); // ★ 阻止 click 冒泡到 .memo-card → renderMemos()
  }

  // ★ 增强：Markdown 语法快捷输入（完整版）
  // 支持行首前缀触发（# > - 1. ``` --- ***）+ 包裹格式（**bold** *italic* ~~strike~~ `code`）
  // 无需依赖工具栏，纯前端实现、兼容离线。
  setupMarkdownShortcuts(quill) {
    if (!quill) return;

    // ── 行首前缀：输入后按空格即触发 ──
    const linePrefixes = [
      { regex: /^#\s$/,       format: 'header',     value: 1 },
      { regex: /^##\s$/,      format: 'header',     value: 2 },
      { regex: /^###\s$/,     format: 'header',     value: 3 },
      { regex: /^####\s$/,    format: 'header',     value: 4 },
      { regex: /^#####\s$/,   format: 'header',     value: 5 },
      { regex: /^######\s$/,  format: 'header',     value: 6 },
      { regex: /^[-*+]\s$/,   format: 'list',       value: 'bullet' },
      { regex: /^\d+\.\s$/,   format: 'list',       value: 'ordered' },
      { regex: /^>\s$/,       format: 'blockquote', value: true },
      { regex: /^```\s$/,     format: 'code-block', value: true },
    ];

    // ── 分割线：独立一行输入 --- 或 *** 按空格/回车触发 ──
    const hrPatterns = [
      { regex: /^---\s?$/ },
      { regex: /^\*\*\*\s?$/ },
      { regex: /^___\s?$/ },
    ];

    // ── 包裹格式：闭合后按空格触发转换 ──
    // 匹配整行文本中的包裹语法
    const wrapPatterns = [
      { open: '**', close: '**',   format: 'bold' },
      { open: '__', close: '__',   format: 'bold' },        // 备选粗体
      { open: '*',  close: '*',    format: 'italic' },
      { open: '_',  close: '_',    format: 'italic' },      // 备选斜体
      { open: '~~', close: '~~',   format: 'strike' },
      { open: '`',  close: '`',    format: 'code' },        // 行内代码（非代码块）
    ];

    quill.on('text-change', (delta, oldDelta, source) => {
      if (source !== 'user') return;
      setTimeout(() => {
        const sel = quill.getSelection();
        if (!sel) return;

        const lineInfo = quill.getLine(sel.index);
        if (!lineInfo || !lineInfo[0]) return;
        const line = lineInfo[0];
        const lineOffset = lineInfo[1];
        const lineStart = sel.index - lineOffset;
        const text = (line.domNode && line.domNode.textContent) || '';
        const lineEnd = lineStart + text.length;

        // ── 0) 表格快捷键检测（优先级最高）：前一行文本为「=表格」或「=【表格】」→ 替换为 3x3 表格 ──
        //    用户在 =表格 这行按回车后，光标已到新行，所以检测"前一行"
        if (sel.index > 0) {
          const prevLineInfo = quill.getLine(sel.index - 1);
          if (prevLineInfo && prevLineInfo[0]) {
            const prevText = (prevLineInfo[0].domNode && prevLineInfo[0].domNode.textContent) || '';
            if (/^=\s*【?表格】?\s*$/.test(prevText)) {
              const prevLineStart = (sel.index - 1) - prevLineInfo[1];
              // 删除 "=表格" 文本所在行（含换行）
              quill.deleteText(prevLineStart, prevText.length + 1, 'api');
              // 插入默认 3×3 表格
              this._insertTableAtPosition(quill, prevLineStart, 3);
              return;
            }
            // 兼容旧式 Markdown 表格语法 | 标题 | 标题 |
            const spec = prevText.match(/^\s*\|(.+)\|\s*$/);
            if (spec) {
              const cells = spec[1].split('|').map(s => s.trim());
              if (cells.length >= 1) {
                const prevLineStart = (sel.index - 1) - prevLineInfo[1];
                quill.deleteText(prevLineStart, prevText.length + 1, 'api');
                this._insertTableAtPosition(quill, prevLineStart, cells);
                return;
              }
            }
          }
        }

        // ── 1) 分割线检测（独立占一行）──
        for (const p of hrPatterns) {
          if (p.regex.test(text)) {
            quill.deleteText(lineStart, text.length);
            // 用 Quill 官方 Divider Blot 插入（已注册）：insertText 在行首插入换行并应用 divider 格式
            // 注意：source 必须用 'api'，否则会递归触发本监听器的快捷键逻辑
            quill.insertText(lineStart, '\n', 'divider', true, 'api');
            // ★ JS 保险：Quill 可能将 <hr> 包裹在 <p> 内，导致左右不等距
            // 解决方案：延迟执行，将 <hr> 直接提升为 .ql-editor 的子元素（脱离 <p> 的 padding 影响）
            setTimeout(() => {
              const hr = quill.root.querySelector('hr') ||
                         quill.root.querySelector('.ql-divider') ||
                         quill.root.querySelector('.memo-divider');
              if (hr && hr.parentElement && hr.parentElement !== quill.root) {
                const parent = hr.parentElement;
                // 把 <hr> 插到 parent 之后（即 .ql-editor 的直接子元素位置）
                if (parent.nextSibling) {
                  parent.parentNode.insertBefore(hr, parent.nextSibling);
                } else {
                  parent.parentNode.appendChild(hr);
                }
                // 如果 parent 变成空 <p>，清理掉
                if (parent.tagName === 'P' && (!parent.textContent || parent.textContent.trim() === '') && parent.children.length === 0) {
                  parent.remove();
                }
              }
            }, 10);
            quill.setSelection(lineStart + 1, 0, 'silent');
            return;
          }
        }

        // ── 2) 行首前缀检测 ──
        for (const p of linePrefixes) {
          const m = text.match(p.regex);
          if (m) {
            const matchLen = m[0].length;
            quill.deleteText(lineStart, matchLen);
            quill.formatLine(lineStart, 1, p.format, p.value);
            quill.setSelection(lineStart, 0, 'silent');
            return;
          }
        }

        // ── 3) 包裹格式检测（光标在闭合标记紧后方时触发）──
        // 条件：最后一个字符是空格，且空格前有完整的闭合包裹
        if (text.length >= 4 && /\s$/.test(text)) {
          const trimmed = text.slice(0, -1); // 去掉尾部空格
          for (const wp of wrapPatterns) {
            // 找第一个出现的 open...close 对
            const openIdx = trimmed.indexOf(wp.open);
            if (openIdx === -1) continue;
            const closeIdx = trimmed.lastIndexOf(wp.close);
            if (closeIdx <= openIdx + wp.open.length) continue; // close 必须在 open 之后且有内容

            // 确认没有嵌套干扰：open 和 close 之间不包含同类型标记
            const inner = trimmed.slice(openIdx + wp.open.length, closeIdx);
            if (inner.includes(wp.open) || inner.includes(wp.close)) continue;

            // 转换！删除整行，重新插入格式化内容
            const prefix = trimmed.slice(0, openIdx);
            const suffix = trimmed.slice(closeIdx + wp.close.length);
            const fullLen = text.length; // 含尾部空格

            quill.deleteText(lineStart, fullLen);

            // 先插前缀（如果有）
            let cursorPos = lineStart;
            if (prefix) {
              quill.insertText(cursorPos, prefix, 'silent');
              cursorPos += prefix.length;
            }

            // 插入格式化的内部文本
            quill.insertText(cursorPos, inner, 'silent');
            quill.formatText(cursorPos, inner.length, wp.format, true, 'silent');

            // 插入后缀（如果有）
            cursorPos += inner.length;
            if (suffix) {
              quill.insertText(cursorPos, suffix, 'silent');
              cursorPos += suffix.length;
            }

            quill.setSelection(cursorPos, 0, 'silent');
            return;
          }
        }
      }, 0);
    });

    // ── 4) 按回车后清除新行的格式继承（飞书/Notion 行为）──
    // Quill 默认会把上一行格式（粗体/斜体/引用/标题/代码等）传染到新行。
    // 此处拦截 Enter：回车后检测到新行有继承的行级格式时自动清除。
    const FORMAT_CLEAR_ON_ENTER = [
      'bold', 'italic', 'strike', 'underline',
      'header', 'blockquote', 'code-block', 'code', 'list'
    ];
    let pendingNewLineIndex = -1;

    quill.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const sel = quill.getSelection();
        if (sel) {
          // 记录回车前的光标位置，用于后续定位新行
          pendingNewLineIndex = sel.index;
        }
      }
    });

    // 在 text-change 中检测并清除新行格式
    const origHandler = null; // 我们用独立的监听而非覆写
    quill.on('text-change', (delta, oldDelta, source) => {
      if (source !== 'user' || pendingNewLineIndex < 0) return;

      setTimeout(() => {
        const sel = quill.getSelection();
        if (!sel || sel.index <= pendingNewLineIndex) {
          pendingNewLineIndex = -1;
          return;
        }

        // 回车后的光标位置就是新行起始位置附近
        // 取当前行，检查是否有需要清除的格式
        const lineInfo = quill.getLine(sel.index);
        if (!lineInfo || !lineInfo[0]) { pendingNewLineIndex = -1; return; }

        const lineStart = sel.index - lineInfo[1];
        const lineText = (lineInfo[0].domNode && lineInfo[0].domNode.textContent) || '';

        // 只在新行内容为空或只有空白时清除（避免误伤已有文字的行）
        // 但也处理刚输入一个字符的情况——用户按回车后立刻开始打字
        if (lineText.trim().length <= 2) {
          // 获取新行的所有格式
          const formats = quill.getFormat(lineStart, Math.max(1, lineText.length || 1));
          const hasFormatToClear = FORMAT_CLEAR_ON_ENTER.some(f => formats[f]);

          if (hasFormatToClear) {
            // 清除所有行级格式（保留文本本身）
            for (const fmt of FORMAT_CLEAR_ON_ENTER) {
              if (formats[fmt]) {
                quill.formatText(lineStart, Math.max(1, lineText.length || 1), fmt, false, 'silent');
              }
            }
          }
        }

        pendingNewLineIndex = -1;
      }, 0);
    });
  }
  
  handlePasteImage(quill, file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Data = e.target.result;
      this.compressImage(base64Data, (compressedData) => {
        const range = quill.getSelection();
        quill.insertEmbed(range ? range.index : quill.getLength(), 'image', compressedData);
        quill.setSelection(range ? range.index + 1 : quill.getLength());
      });
    };
    reader.readAsDataURL(file);
  }
  
  compressImage(base64Data, callback) {
    const maxWidth = 800;
    const maxHeight = 800;
    const quality = 0.5;
    
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      
      if (width > maxWidth || height > maxHeight) {
        if (width > height) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        } else {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      const compressedData = canvas.toDataURL('image/jpeg', quality);
      
      const originalSize = this.getBase64Size(base64Data);
      const compressedSize = this.getBase64Size(compressedData);
      
      const originalFormat = base64Data.match(/data:image\/(\w+);/);
      const isPng = originalFormat && originalFormat[1].toLowerCase() === 'png';
      
      if (isPng || compressedSize < originalSize * 1.2) {
        console.log(`图片压缩: ${(originalSize/1024/1024).toFixed(2)}MB -> ${(compressedSize/1024/1024).toFixed(2)}MB (${((1-compressedSize/originalSize)*100).toFixed(0)}% reduction)`);
        callback(compressedData);
      } else {
        callback(base64Data);
      }
    };
    img.onerror = () => {
      callback(base64Data);
    };
    img.src = base64Data;
  }
  
  getBase64Size(base64Data) {
    const base64Str = base64Data.split(',')[1];
    return (base64Str.length * 3) / 4;
  }

  startNewMemo() {
    this.editingMemoId = '';
    this.renderMemos();
  }

  formatMemoDate(date) {
    const now = new Date();
    const diff = now - date;
    const oneDay = 24 * 60 * 60 * 1000;

    if (diff < 60 * 1000) {
      return '刚刚';
    } else if (diff < 60 * 60 * 1000) {
      return `${Math.floor(diff / (60 * 1000))}分钟前`;
    } else if (diff < oneDay && date.getDate() === now.getDate()) {
      return `今天 ${utils.formatDate(date, 'HH:mm')}`;
    } else if (diff < 2 * oneDay) {
      return `昨天 ${utils.formatDate(date, 'HH:mm')}`;
    } else {
      return utils.formatDate(date, 'YYYY-MM-DD');
    }
  }

  

  onMouseMove(e) {
    if (this.longPressCard) {
      const dx = Math.abs(e.clientX - this.longPressStartX);
      const dy = Math.abs(e.clientY - this.longPressStartY);

      if (dx > 10 || dy > 10) {
        if (!this.hasLongPressed && this.longPressTimer) {
          clearTimeout(this.longPressTimer);
          this.longPressTimer = null;
          this.longPressCard = null;
        }
      }

      if (this.hasLongPressed && !this.isDraggingCard) {
        this.startDrag(e);
        e.preventDefault();
      }
    }

    if (this.isDraggingCard && this.draggedCard) {
      this.performDrag(e);
      e.preventDefault();
    }
  }

  onMouseUp(e) {
    clearTimeout(this.longPressTimer);
    this.longPressTimer = null;

    if (this.hasLongPressed && this.longPressCard) {
      const container = document.getElementById('memosContainer');
      this.endDrag(e, container);
    }

    this.longPressCard = null;
    this.hasLongPressed = false;
  }

  bindDragEvents(container) {
    const cards = container.querySelectorAll('.memo-card');

    cards.forEach(card => {
      if (card.classList.contains('memo-editor-card')) return;

      card.addEventListener('mousedown', (e) => {
        if (e.target.closest('.menu-btn')) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        this.longPressCard = card;
        this.longPressStartX = e.clientX;
        this.longPressStartY = e.clientY;
        this.hasLongPressed = false;

        this.longPressTimer = setTimeout(() => {
          this.hasLongPressed = true;
          card.style.cursor = 'grabbing';
        }, 200);
      });
    });
  }

  startDrag(e) {
    this.isDraggingCard = true;
    this.draggedCard = this.longPressCard;

    this.placeholder = document.createElement('div');
    this.placeholder.className = 'memo-card placeholder';
    this.placeholder.style.height = this.draggedCard.offsetHeight + 'px';
    this.placeholder.style.minHeight = this.draggedCard.offsetHeight + 'px';
    this.placeholder.style.border = '2px dashed #667eea';
    this.placeholder.style.borderRadius = '8px';
    this.placeholder.style.marginBottom = '8px';

    this.draggedCard.parentNode.insertBefore(this.placeholder, this.draggedCard.nextSibling);

    const clone = this.draggedCard.cloneNode(true);
    clone.style.position = 'fixed';
    clone.style.zIndex = '99999';
    clone.style.pointerEvents = 'none';
    clone.style.opacity = '0.8';
    clone.style.width = this.draggedCard.offsetWidth + 'px';
    clone.style.boxShadow = '0 4px 20px rgba(0,0,0,0.2)';

    document.body.appendChild(clone);
    this.draggedCard._clone = clone;
    this.draggedCard.style.visibility = 'hidden';

    this.updateDragPosition(e);
  }

  performDrag(e) {
    if (!this.draggedCard || !this.draggedCard._clone) return;

    this.updateDragPosition(e);

    const container = document.getElementById('memosContainer');
    const cards = Array.from(container.querySelectorAll('.memo-card:not(.placeholder)'));

    let insertBefore = null;
    for (const card of cards) {
      if (card === this.draggedCard) continue;

      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (e.clientY < midY) {
        insertBefore = card;
        break;
      }
    }

    if (this.placeholder) {
      if (insertBefore) {
        if (this.placeholder.previousSibling !== insertBefore) {
          container.insertBefore(this.placeholder, insertBefore);
        }
      } else {
        container.appendChild(this.placeholder);
      }
    }
  }

  updateDragPosition(e) {
    if (!this.draggedCard || !this.draggedCard._clone) return;

    const clone = this.draggedCard._clone;
    clone.style.left = (e.clientX - this.draggedCard.offsetWidth / 2) + 'px';
    clone.style.top = (e.clientY - this.draggedCard.offsetHeight / 2) + 'px';
  }

  async endDrag(e, container) {
    this.isDraggingCard = false;

    if (!this.draggedCard) return;

    const draggedId = this.draggedCard.dataset.id;

    const containerRect = container.getBoundingClientRect();
    const isOutside = e.clientX < containerRect.left || 
                      e.clientX > containerRect.right || 
                      e.clientY < containerRect.top || 
                      e.clientY > containerRect.bottom;

    if (isOutside) {
      const memo = this.memos.find(m => String(m.id) === String(draggedId));
      if (memo) {
        await ipcRenderer.invoke('create-sticky-note', memo);
      } else {
        console.warn('拖动创建便利贴时未找到对应的备忘录:', draggedId);
      }
      this.cleanupDrag();
    } else {
      if (this.placeholder && this.placeholder.parentNode) {
        this.placeholder.parentNode.insertBefore(this.draggedCard, this.placeholder);
      }

      const currentCards = Array.from(container.querySelectorAll('.memo-card:not(.placeholder)'));
      const newMemos = [];
      for (const card of currentCards) {
        const id = card.dataset.id;
        const memo = this.memos.find(m => String(m.id) === String(id));
        if (memo) newMemos.push(memo);
      }

      this.memos.length = 0;
      this.memos.push(...newMemos);

      const memosWithOrder = this.memos.map((memo, index) => ({ ...memo, order: index }));
      await this.memoManager.saveMemoOrder(memosWithOrder);

      this.cleanupDrag();
    }
  }

  cleanupDrag() {
    if (this.draggedCard && this.draggedCard._clone) {
      this.draggedCard._clone.remove();
      delete this.draggedCard._clone;
    }
    if (this.placeholder) {
      this.placeholder.remove();
      this.placeholder = null;
    }
    if (this.draggedCard) {
      this.draggedCard.style.visibility = '';
      this.draggedCard.style.cursor = '';
    }
    this.draggedCard = null;
  }

  openTaskModal() {
    this.currentEditingItem = null;
    this.currentEditingType = null;
    document.querySelector('#taskModal h3').textContent = '添加任务';
    document.getElementById('taskModal').style.display = 'flex';
    document.getElementById('taskStartDate').value = this.selectedDateStr;
    document.getElementById('taskEndDate').value = this.selectedDateStr;
    this.clearTaskForm();
    this.loadPresetTaskTags();
  }

  closeTaskModal() {
    document.getElementById('taskModal').style.display = 'none';
    this.clearTaskForm();
    this.clearTaskSubtasks();
    this.currentEditingItem = null;
    this.currentEditingType = null;
    document.querySelector('#taskModal h3').textContent = '添加任务';
  }

  clearTaskForm() {
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDescription').value = '';
    document.getElementById('taskStartDate').value = '';
    document.getElementById('taskEndDate').value = '';
    this.taskTags = [];
    this.renderTaskTags();
  }

  async saveTask() {
    const title = document.getElementById('taskTitle').value.trim();
    const description = document.getElementById('taskDescription').value.trim();
    const startDate = document.getElementById('taskStartDate').value;
    const endDate = document.getElementById('taskEndDate').value;
    const priority = document.getElementById('taskPriority').value;
    const progress = document.getElementById('taskProgress').value;

    if (!title) {
      alert('请填写任务标题');
      return;
    }

    const validSubtasks = this.taskSubtasks.filter(s => s.title.trim());
    
    const taskData = {
      title: title,
      description: description,
      priority: priority,
      progress: progress,
      startDate: startDate,
      endDate: endDate,
      tags: this.taskTags,
      subtasks: validSubtasks,
      completed: progress === 'completed',
      creator: XilianSettings._config?.aiUserName || '我'
    };

    let saveSuccess = true;
    if (this.currentEditingType === 'task' && this.currentEditingItem) {
      const existingTask = this.tasks.find(t => String(t.id) === String(this.currentEditingItem));
      if (existingTask) {
        const fullTaskData = {
          ...existingTask,
          ...taskData
        };
        const result = await this.taskManager.updateTask(this.currentEditingItem, fullTaskData);
        saveSuccess = result.success;
        if (!saveSuccess) {
          alert('保存任务失败: ' + result.message);
        }
      } else {
        const result = await this.taskManager.updateTask(this.currentEditingItem, taskData);
        saveSuccess = result.success;
        if (!saveSuccess) {
          alert('保存任务失败: ' + result.message);
        }
      }
    } else {
      const result = await this.taskManager.addTask(taskData);
      saveSuccess = result.success;
      if (!saveSuccess) {
        alert('添加任务失败: ' + result.message);
      }
    }

    if (saveSuccess) {
      this.closeTaskModal();
      this.tasks = this.taskManager.getTasks();
      this.renderDailyTasks();
      this.notifyDataChange();
      // 阶段 2：任务保存后异步喂给 MC 记忆管线
      ipcRenderer.invoke('mc:ingest-task', taskData).catch(() => {});
    }
  }

  openExpenseModal() {
    this.currentEditingItem = null;
    this.currentEditingType = null;
    document.querySelector('#expenseModal h3').textContent = '添加收支';
    document.getElementById('expenseModal').style.display = 'flex';
    this.clearExpenseForm();
    this.loadPresetExpenseTags();
  }

  closeExpenseModal() {
    document.getElementById('expenseModal').style.display = 'none';
    this.clearExpenseForm();
    this.currentEditingItem = null;
    this.currentEditingType = null;
    document.querySelector('#expenseModal h3').textContent = '添加收支';
  }

  clearExpenseForm() {
    document.getElementById('expenseDetail').value = '';
    document.getElementById('expenseAmount').value = '';
    document.querySelector('input[name="expenseTypeRadio"][value="expense"]').checked = true;
    this.expenseTags = [];
    this.expenseCategory = '';
    this.renderExpenseTags();
  }

  async saveExpense() {
    const detail = document.getElementById('expenseDetail').value.trim();
    const category = this.expenseCategory || '其他';
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const type = document.querySelector('input[name="expenseTypeRadio"]:checked').value;

    if (!detail || isNaN(amount)) {
      alert('请填写完整信息');
      return;
    }

    const expense = {
      detail: detail,
      category: category,
      amount: amount,
      type: type,
      date: this.selectedDateStr,
      creator: XilianSettings._config?.aiUserName || '我'
    };

    let saveSuccess = true;
    if (this.currentEditingType === 'expense' && this.currentEditingItem) {
      const result = await this.expenseManager.updateExpense(this.currentEditingItem, expense);
      saveSuccess = result.success;
      if (!saveSuccess) {
        alert('保存收支失败: ' + result.message);
      }
    } else {
      const result = await this.expenseManager.addExpense(expense);
      saveSuccess = result.success;
      if (!saveSuccess) {
        alert('添加收支失败: ' + result.message);
      }
    }

    if (saveSuccess) {
      this.closeExpenseModal();
      this.expenses = this.expenseManager.getExpenses();
      this.renderDailyExpenses();
      this.renderStatistics();
      this.notifyDataChange();
    }
  }

  openEditModal(id, type) {
    this.currentEditingItem = id;
    this.currentEditingType = type;

    if (type === 'task') {
      const task = this.tasks.find(t => String(t.id) === String(id));
      if (task) {
        document.getElementById('taskTitle').value = task.title || '';
        document.getElementById('taskPriority').value = task.priority || 'normal';
        document.getElementById('taskProgress').value = task.progress || 'pending';
        document.getElementById('taskDescription').value = task.description || '';
        
        const startDate = task.startDate || '';
        const endDate = task.endDate || '';
        
        document.getElementById('taskStartDate').value = startDate ? startDate.substring(0, 10) : '';
        document.getElementById('taskEndDate').value = endDate ? endDate.substring(0, 10) : '';
        
        this.taskTags = task.tags || [];
        this.taskSubtasks = task.subtasks || [];
        this.renderTaskTags();
        this.renderTaskSubtasks();
        document.getElementById('taskModal').style.display = 'flex';
        document.querySelector('#taskModal h3').textContent = '编辑任务';
      }
    } else if (type === 'memo') {
      this.editingMemoId = id;
      this.renderMemos();
    } else if (type === 'expense') {
      const expense = this.expenses.find(e => String(e.id) === String(id));
      if (expense) {
        document.getElementById('expenseDetail').value = expense.detail || '';
        document.getElementById('expenseAmount').value = expense.amount || '';
        document.querySelector(`input[name="expenseTypeRadio"][value="${expense.type}"]`).checked = true;
        this.expenseTags = expense.category ? [expense.category] : [];
        this.expenseCategory = expense.category || '';
        this.renderExpenseTags();
        document.getElementById('expenseModal').style.display = 'flex';
        document.querySelector('#expenseModal h3').textContent = '编辑收支';
      }
    }
  }

  // ========== 全局搜索 ==========
  setupGlobalSearch() {
    const searchInput = document.getElementById('globalSearchInput');
    const searchResults = document.getElementById('globalSearchResults');
    if (!searchInput || !searchResults) return;

    let debounceTimer = null;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const keyword = e.target.value.trim();
      if (!keyword) {
        searchResults.style.display = 'none';
        searchResults.innerHTML = '';
        return;
      }
      debounceTimer = setTimeout(() => {
        const results = this.performGlobalSearch(keyword);
        this.renderGlobalSearchResults(results, keyword);
      }, 200);
    });

    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('globalSearchWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        searchResults.style.display = 'none';
      }
    });

    searchInput.addEventListener('click', (e) => {
      e.stopPropagation();
      if (searchResults.children.length > 0) {
        searchResults.style.display = 'block';
      }
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchResults.style.display = 'none';
        searchResults.innerHTML = '';
      }
    });
  }

  performGlobalSearch(keyword) {
    const lowerKeyword = keyword.toLowerCase();
    const results = [];

    if (this.tasks) {
      this.tasks.forEach(task => {
        const title = (task.title || '').toLowerCase();
        const desc = (task.description || '').toLowerCase();
        const tags = (task.tags || []).join(' ').toLowerCase();
        if (title.includes(lowerKeyword) || desc.includes(lowerKeyword) || tags.includes(lowerKeyword)) {
          results.push({
            type: 'task', typeLabel: '任务', id: task.id,
            title: task.title || '无标题',
            preview: task.description || (task.tags && task.tags.length ? '#' + task.tags.join(' #') : ''),
            data: task
          });
        }
      });
    }

    if (this.memos) {
      this.memos.forEach(memo => {
        const title = (memo.title || '').toLowerCase();
        const content = (memo.content || '').toLowerCase();
        if (title.includes(lowerKeyword) || content.includes(lowerKeyword)) {
          results.push({
            type: 'memo', typeLabel: '备忘录', id: memo.id,
            title: memo.title || '无标题',
            preview: memo.content ? memo.content.substring(0, 80) : '',
            data: memo
          });
        }
      });
    }

    if (this.secrets) {
      this.secrets.forEach(secret => {
        const name = (secret.name || '').toLowerCase();
        const categories = (secret.categories || []).join(' ').toLowerCase();
        const fields = (secret.fields || []).map(f => (f.label || '') + ' ' + (f.value || '')).join(' ').toLowerCase();
        const notes = (secret.notes || '').toLowerCase();
        if (name.includes(lowerKeyword) || categories.includes(lowerKeyword) || fields.includes(lowerKeyword) || notes.includes(lowerKeyword)) {
          results.push({
            type: 'secret', typeLabel: '密钥', id: secret.id,
            title: secret.name || '无标题',
            preview: (secret.categories && secret.categories.length ? secret.categories.join(' / ') : '') + (secret.fields && secret.fields.length ? ' · ' + secret.fields.length + '个字段' : ''),
            data: secret
          });
        }
      });
    }

    if (this.journals) {
      this.journals.forEach(journal => {
        const content = (journal.content || '').toLowerCase();
        if (content.includes(lowerKeyword)) {
          results.push({
            type: 'journal', typeLabel: '日志', id: journal.date,
            title: journal.date,
            preview: journal.content ? journal.content.substring(0, 80) : '',
            data: journal
          });
        }
      });
    }

    if (this.expenses) {
      this.expenses.forEach(expense => {
        const detail = (expense.detail || '').toLowerCase();
        const category = (expense.category || '').toLowerCase();
        if (detail.includes(lowerKeyword) || category.includes(lowerKeyword)) {
          results.push({
            type: 'expense', typeLabel: expense.type === 'income' ? '收入' : '支出', id: expense.id,
            title: expense.detail || '无明细',
            preview: (expense.category || '') + ' · ¥' + (expense.amount || 0),
            data: expense
          });
        }
      });
    }

    return results;
  }

  renderGlobalSearchResults(results, keyword) {
    const searchResults = document.getElementById('globalSearchResults');
    if (!searchResults) return;

    if (results.length === 0) {
      searchResults.innerHTML = '<div class="gs-no-results">未找到匹配结果</div>';
      searchResults.style.display = 'block';
      return;
    }

    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.typeLabel]) grouped[r.typeLabel] = [];
      grouped[r.typeLabel].push(r);
    });

    const MAX_PER_GROUP = 8;
    let html = '';
    Object.keys(grouped).forEach(typeLabel => {
      const items = grouped[typeLabel];
      html += '<div class="gs-group">';
      html += '<div class="gs-group-header">' + typeLabel + ' <span class="gs-group-count">' + items.length + '</span></div>';
      items.slice(0, MAX_PER_GROUP).forEach(r => {
        const highlightedTitle = this.highlightKeyword(r.title, keyword);
        const highlightedPreview = r.preview ? this.highlightKeyword(r.preview, keyword) : '';
        html += '<div class="gs-item" data-type="' + r.type + '" data-id="' + r.id + '">';
        html += '<div class="gs-item-title">' + highlightedTitle + '</div>';
        if (highlightedPreview) {
          html += '<div class="gs-item-preview">' + highlightedPreview + '</div>';
        }
        html += '</div>';
      });
      if (items.length > MAX_PER_GROUP) {
        html += '<div class="gs-group-more">还有 ' + (items.length - MAX_PER_GROUP) + ' 条结果...</div>';
      }
      html += '</div>';
    });

    searchResults.innerHTML = html;
    searchResults.style.display = 'block';

    searchResults.querySelectorAll('.gs-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = item.dataset.type;
        const id = item.dataset.id;
        this.openSearchResult(type, id);
        searchResults.style.display = 'none';
        searchResults.innerHTML = '';
        document.getElementById('globalSearchInput').value = '';
      });
    });
  }

  highlightKeyword(text, keyword) {
    if (!text || !keyword) return text || '';
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(' + escaped + ')', 'gi');
    return text.replace(regex, '<mark class="gs-highlight">$1</mark>');
  }

  openSearchResult(type, id) {
    if (type === 'task') {
      this.switchView('tasks');
      const task = this.tasks.find(t => String(t.id) === String(id));
      if (task) {
        if (task.startDate) {
          const dateStr = this.normalizeDateStr(task.startDate);
          if (dateStr) {
            const [y, m, d] = dateStr.split('-').map(Number);
            this.selectedDateStr = dateStr;
            this.selectedDate = new Date(y, m - 1, d);
            this.updateDateDisplay();
            this.renderDateNav();
            this.renderDailyTasks();
          }
        }
        this.openEditModal(id, 'task');
      }
    } else if (type === 'memo') {
      this.openEditModal(id, 'memo');
    } else if (type === 'secret') {
      this.switchView('secrets');
      const secret = this.secretManager.getSecretById(id);
      if (secret) {
        this.openSecretModal(secret);
      }
    } else if (type === 'journal') {
      this.switchView('journal');
      const dateStr = this.normalizeDateStr(id);
      if (dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        this.selectedDateStr = dateStr;
        this.selectedDate = new Date(y, m - 1, d);
        this.updateDateDisplay();
        this.renderJournalCalendar();
        this.loadJournalForDate(dateStr);
      }
    } else if (type === 'expense') {
      this.switchView('expenses');
      const expense = this.expenses.find(e => String(e.id) === String(id));
      if (expense && expense.date) {
        const dateStr = this.normalizeDateStr(expense.date);
        if (dateStr) {
          const [y, m, d] = dateStr.split('-').map(Number);
          this.selectedDateStr = dateStr;
          this.selectedDate = new Date(y, m - 1, d);
          this.updateDateDisplay();
          this.renderDailyExpenses();
        }
      }
    }
  }

  normalizeDateStr(raw) {
    if (!raw) return null;
    const str = String(raw).trim();
    if (!str) return null;
    const datePart = str.split('T')[0].split(' ')[0];
    const parts = datePart.split('-').map(Number);
    if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
      const y = parts[0];
      const m = String(parts[1]).padStart(2, '0');
      const d = String(parts[2]).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return null;
  }

}

const MenuManager = (() => {
  let currentMenuData = null;
  const globalMenu = document.getElementById('globalCardMenu');

  function closeMenu() {
    globalMenu.classList.remove('show');
    globalMenu.style.left = '';
    globalMenu.style.top = '';
    currentMenuData = null;
  }

  function updateMenuContent(type, completed, pinned, isPrivate = 'false') {
    const editItem = globalMenu.querySelector('[data-action="edit"]');
    const completeItem = globalMenu.querySelector('[data-action="complete"]');
    const pinItem = globalMenu.querySelector('[data-action="pin"]');
    const downloadTxtItem = globalMenu.querySelector('[data-action="download-txt"]');
    const downloadDocxItem = globalMenu.querySelector('[data-action="download-docx"]');
    const privateItem = globalMenu.querySelector('[data-action="toggle-private"]');
    const deleteItem = globalMenu.querySelector('[data-action="delete"]');

    editItem.style.display = 'block';
    completeItem.style.display = 'block';
    pinItem.style.display = 'block';
    downloadTxtItem.style.display = 'none';
    downloadDocxItem.style.display = 'none';
    privateItem.style.display = 'none';
    deleteItem.style.display = 'block';

    if (type === 'task') {
      completeItem.textContent = completed === 'true' ? '取消完成' : '完成';
      pinItem.textContent = pinned === 'true' ? '取消置顶' : '置顶';
    } else if (type === 'memo') {
      completeItem.style.display = 'none';
      pinItem.textContent = pinned === 'true' ? '取消置顶' : '置顶';
      downloadTxtItem.style.display = 'block';
      downloadDocxItem.style.display = 'block';
      privateItem.style.display = 'block';
      privateItem.textContent = isPrivate === 'true' ? '取消私密' : '设为私密';
    } else {
      completeItem.style.display = 'none';
      pinItem.style.display = 'none';
    }
  }

  async function handleAction(action) {
    if (!currentMenuData) return;

    const { id, type } = currentMenuData;
    closeMenu();

    switch (action) {
      case 'edit':
        if (window.appController) {
          window.appController.openEditModal(id, type);
        }
        break;
      case 'complete':
        if (type === 'task') {
          await window.appController.taskManager.toggleTaskCompleted(id);
          window.appController.tasks = window.appController.taskManager.getTasks();
          window.appController.renderDailyTasks();
        }
        break;
      case 'pin':
        if (type === 'task') {
          await window.appController.taskManager.pinTask(id);
          window.appController.tasks = window.appController.taskManager.getTasks();
          window.appController.renderDailyTasks();
        } else if (type === 'memo') {
          await window.appController.memoManager.pinMemo(id);
          window.appController.memos = window.appController.memoManager.getMemos();
          window.appController.renderMemos();
        }
        break;
      case 'download-txt':
        if (type === 'memo') {
          const result = await ipcRenderer.invoke('download-txt', id);
          if (result.success) {
            alert('TXT文件下载成功！');
          } else if (!result.canceled) {
            alert(`下载失败：${result.error}`);
          }
        }
        break;
      case 'download-docx':
        if (type === 'memo') {
          const result = await ipcRenderer.invoke('download-docx', id);
          if (result.success) {
            alert('DOCX文件下载成功！');
          } else if (!result.canceled) {
            alert(`下载失败：${result.error}`);
          }
        }
        break;
      case 'toggle-private':
        if (type === 'memo' && window.appController) {
          const result = await window.appController.memoManager.togglePrivateMemo(id);
          if (result.success) {
            window.appController.renderMemos();
          } else {
            alert('保存备忘录失败: ' + result.message);
          }
        }
        break;
      case 'delete':
        if (confirm('确定要删除这条记录吗？')) {
          // ★ 修复：confirm() 是同步原生对话框，返回后 WebContents 焦点链尚未恢复。
          // 立即操作 DOM（closeMenu/editingMemoId/renderMemos=innerHTML）会导致
          // 焦点链在恢复中被中断，此后所有输入框点击无法聚焦（但 Ctrl+V 粘贴仍可执行）。
          // 解决：将所有操作延迟到下一个事件循环，让窗口焦点先完成恢复。
          setTimeout(async () => {
          closeMenu();
          currentMenuData = null;
          
          if (type === 'memo') {
            if (window.appController) {
              window.appController.editingMemoId = null;
            }
            if (window.currentQuill) {
              window.currentQuill = null;
            }
          }
          
          let deleteSuccess = true;
          if (type === 'task') {
            const result = await window.appController.taskManager.deleteTask(id);
            deleteSuccess = result.success;
            if (!deleteSuccess) {
              alert('删除任务失败: ' + result.message);
            }
          } else if (type === 'memo') {
            const result = await window.appController.memoManager.deleteMemo(id);
            deleteSuccess = result.success;
            if (!deleteSuccess) {
              alert('删除备忘录失败: ' + result.message);
            }
          } else {
            const result = await window.appController.expenseManager.deleteExpense(id);
            deleteSuccess = result.success;
            if (!deleteSuccess) {
              alert('删除收支失败: ' + result.message);
            }
          }
          
          if (deleteSuccess && window.appController) {
            window.appController.memos = window.appController.memoManager.getMemos();
            window.appController.tasks = window.appController.taskManager.getTasks();
            window.appController.expenses = window.appController.expenseManager.getExpenses();
            window.appController.renderMemos();
            window.appController.renderDailyTasks();
            window.appController.renderDailyExpenses();
            window.appController.renderStatistics();
            
            setTimeout(() => {
              const firstInput = document.querySelector('input, textarea, [contenteditable="true"]');
              if (firstInput) {
                firstInput.focus();
              }
            }, 100);
          }
          }, 0);
        }
        break;
    }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-btn') && !e.target.closest('.card-menu')) {
      closeMenu();
    }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.menu-btn');
    if (!btn) return;

    e.stopPropagation();

    const id = btn.dataset.id;
    const type = btn.dataset.type;
    const completed = btn.dataset.completed;
    const pinned = btn.dataset.pinned;
    const isPrivate = btn.dataset.private || 'false';

    const isMenuOpen = globalMenu.classList.contains('show');
    const isSameTarget = currentMenuData && currentMenuData.id === id && currentMenuData.type === type;

    closeMenu();

    if (!isMenuOpen || !isSameTarget) {
      updateMenuContent(type, completed, pinned, isPrivate);
      currentMenuData = { id, type };

      const rect = btn.getBoundingClientRect();
      const menuWidth = 100;
      const menuHeight = 160; // 增加了高度来容纳更多选项

      let left = rect.right - menuWidth;
      let top = rect.bottom + 2;

      if (top + menuHeight > window.innerHeight) {
        top = rect.top - menuHeight - 2;
      }
      if (left < 0) {
        left = 4;
      }

      globalMenu.style.left = left + 'px';
      globalMenu.style.top = top + 'px';
      globalMenu.classList.add('show');
    }
  });

  globalMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;

    e.stopPropagation();
    const action = item.dataset.action;
    await handleAction(action);
  });

  return { closeMenu };
})();

window.appController = new AppController();