const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class DataManager {
  constructor() {
    this.cachedData = null;
    this.lastDataLoadTime = 0;
    this.DATA_CACHE_TTL = 5000;
    this.writeQueue = [];
    this.isWriting = false;
    this.writeDebounceTimer = null;
    this.WRITE_DEBOUNCE_DELAY = 100;
    this.MAX_QUEUE_SIZE = 50;
  }

  async getDataFilePath(userId = null) {
    const app = require('electron').app;
    
    if (!userId) {
      userId = this.getCurrentUserId();
    }

    const exePath = path.dirname(app.getPath('exe'));
    
    if (userId && userId !== 'admin') {
      const userDataDir = path.join(exePath, 'users', userId);
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }
      return path.join(userDataDir, 'data.json');
    }

    const exeDataPath = path.join(exePath, 'data.json');

    if (fs.existsSync(exeDataPath)) {
      return exeDataPath;
    }

    const appPath = app.getAppPath();
    return path.join(appPath, 'data.json');
  }

  getCurrentUserId() {
    const app = require('electron').app;
    const exePath = path.dirname(app.getPath('exe'));
    const dataPath = path.join(exePath, 'data.json');
    
    try {
      if (fs.existsSync(dataPath)) {
        const content = fs.readFileSync(dataPath, 'utf8');
        const data = JSON.parse(content);
        return data.settings?.cloudCurrentUserId || data.cloudCurrentUserId || 'admin';
      }
    } catch (e) {
      console.error('[DataManager] 获取当前用户ID失败:', e);
    }
    return 'admin';
  }

  async invalidateCache() {
    this.cachedData = null;
    this.lastDataLoadTime = 0;
  }

  parseDate(dateStr) {
    if (!dateStr) return null;
    try {
      const parsed = new Date(dateStr);
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch (_) {
      return null;
    }
  }

  async readData(forceReload = false) {
    const now = Date.now();

    if (!forceReload && this.cachedData && (now - this.lastDataLoadTime) < this.DATA_CACHE_TTL) {
      return { ...this.cachedData };
    }

    const dataPath = await this.getDataFilePath();
    const appPath = require('electron').app.getAppPath();
    const fallbackDataPath = path.join(appPath, 'data.json');
    const currentUserId = this.getCurrentUserId();

    try {
      let content = null;
      let data = null;

      const primaryExists = await fsp.access(dataPath).then(() => true).catch(() => false);
      const fallbackExists = await fsp.access(fallbackDataPath).then(() => true).catch(() => false);

      if (primaryExists) {
        content = await fsp.readFile(dataPath, 'utf8');
        data = JSON.parse(content);
      }

      if ((!data || (!data.budgets || data.budgets.length === 0)) && fallbackExists) {
        const fallbackContent = await fsp.readFile(fallbackDataPath, 'utf8');
        const fallbackData = JSON.parse(fallbackContent);
        
        if (fallbackData && fallbackData.budgets && fallbackData.budgets.length > 0) {
          if (!data) {
            data = fallbackData;
          } else {
            data.budgets = [...(data.budgets || []), ...(fallbackData.budgets || [])];
            if (fallbackData.categoryBudgets) {
              data.categoryBudgets = [...(data.categoryBudgets || []), ...(fallbackData.categoryBudgets || [])];
            }
          }
        }
      }

      if (!data) {
        return {
          tasks: [],
          memos: [],
          expenses: [],
          budgets: [],
          secrets: [],
          journals: [],
          settings: {},
          translationStats: {}
        };
      }

      let tasks = [];
      let memos = [];
      let expenses = [];
      let budgets = [];
      let categoryBudgets = [];
      let secrets = [];
      let journals = [];

      if (data.tasks && typeof data.tasks === 'object') {
        if (data.tasks.tasks) {
          tasks = data.tasks.tasks;
        } else {
          tasks = data.tasks;
        }
        const taskSeenIds = new Set();
        tasks = tasks.filter(task => {
          if (!task.id) return true;
          const id = String(task.id);
          if (taskSeenIds.has(id)) return false;
          taskSeenIds.add(id);
          return this.isOwnedByUser(task, currentUserId);
        }).map(task => this.normalizeTask(task));
      }

      if (data.memos && typeof data.memos === 'object') {
        memos = data.memos;
        const memoSeenIds = new Set();
        memos = memos.filter(memo => {
          if (!memo.id) return true;
          const id = String(memo.id);
          if (memoSeenIds.has(id)) return false;
          memoSeenIds.add(id);
          return this.isOwnedByUser(memo, currentUserId);
        }).map(memo => this.normalizeMemo(memo));
      }

      if (data.expenses && typeof data.expenses === 'object') {
        expenses = data.expenses;
        const expenseSeenIds = new Set();
        expenses = expenses.filter(expense => {
          if (!expense.id) return true;
          const id = String(expense.id);
          if (expenseSeenIds.has(id)) return false;
          expenseSeenIds.add(id);
          return this.isOwnedByUser(expense, currentUserId);
        }).map(expense => this.normalizeExpense(expense));
      }

      if (data.budgets && typeof data.budgets === 'object') {
        budgets = data.budgets.filter(budget => this.isOwnedByUser(budget, currentUserId))
          .map(budget => this.normalizeBudget(budget));
      }

      if (data.categoryBudgets && typeof data.categoryBudgets === 'object') {
        categoryBudgets = data.categoryBudgets;
      }
        
      budgets.forEach((budget, index) => {
        if (!budget.id) {
          budget.id = 'budget_' + Date.now() + '_' + index;
        }
        if (budget.categoryBudgets && Array.isArray(budget.categoryBudgets)) {
          budget.categoryBudgets = budget.categoryBudgets.map(cb => ({
            ...cb,
            budgetId: budget.id
          }));
        } else {
          budget.categoryBudgets = [];
        }
      });

      if (data.secrets && typeof data.secrets === 'object') {
        secrets = data.secrets;
        const secretSeenIds = new Set();
        secrets = secrets.filter(secret => {
          if (!secret.id) return true;
          const id = String(secret.id);
          if (secretSeenIds.has(id)) return false;
          secretSeenIds.add(id);
          return this.isOwnedByUser(secret, currentUserId);
        }).map(secret => this.normalizeSecret(secret));
      }

      if (data.journals && Array.isArray(data.journals)) {
        journals = data.journals;
        const journalSeenIds = new Set();
        journals = journals.filter(journal => {
          if (!journal.id) return true;
          const id = String(journal.id);
          if (journalSeenIds.has(id)) return false;
          journalSeenIds.add(id);
          return this.isOwnedByUser(journal, currentUserId);
        }).map(journal => this.normalizeJournal(journal));
      }

      this.cachedData = {
        tasks: tasks || [],
        memos: memos || [],
        expenses: expenses || [],
        budgets: budgets || [],
        categoryBudgets: categoryBudgets || [],
        secrets: secrets || [],
        journals: journals || [],
        settings: data.settings || {},
        translationStats: data.translationStats || {},
        chatHistory: data.chatHistory || [],
        chatRooms: data.chatRooms || [],
        chatHistoryStore: data.chatHistoryStore || {},
        chatHistoryLimit: data.chatHistoryLimit ?? 50,
        dailyTasks: data.dailyTasks || []
      };
      this.lastDataLoadTime = now;
      return { ...this.cachedData };
    } catch (e) {
      console.error('[DataManager] 读取数据失败:', e);
    }
    return {
      tasks: [],
      memos: [],
      expenses: [],
      budgets: [],
      secrets: [],
      journals: [],
      settings: {},
      translationStats: {},
      chatHistory: [],
      chatRooms: [],
      chatHistoryStore: {},
      chatHistoryLimit: 50,
      dailyTasks: []
    };
  }

  normalizeTask(task) {
    const normalized = { ...task };
    normalized.id = String(task.id || '');
    
    if (task.start_date) {
      normalized.startDate = task.start_date;
      delete normalized.start_date;
    } else if (task.startDate !== undefined) {
      normalized.startDate = task.startDate;
    }
    
    if (task.end_date) {
      normalized.endDate = task.end_date;
      delete normalized.end_date;
    } else if (task.endDate !== undefined) {
      normalized.endDate = task.endDate;
    }
    
    if (task.reminder_date) {
      normalized.reminderDate = task.reminder_date;
      delete normalized.reminder_date;
    } else if (task.reminderDate !== undefined) {
      normalized.reminderDate = task.reminderDate;
    }
    
    if (task.reminder_enabled !== undefined) {
      normalized.reminderEnabled = task.reminder_enabled === 1 || task.reminder_enabled === true;
      delete normalized.reminder_enabled;
    } else if (task.reminderEnabled !== undefined) {
      normalized.reminderEnabled = task.reminderEnabled === 1 || task.reminderEnabled === true;
    }
    
    if (task.remind_offset !== undefined) {
      normalized.remindOffset = task.remind_offset;
      delete normalized.remind_offset;
    } else if (task.remindOffset !== undefined) {
      normalized.remindOffset = task.remindOffset;
    }
    
    if (task.created_at) {
      normalized.createdAt = task.created_at;
      delete normalized.created_at;
    } else if (task.createdAt !== undefined) {
      normalized.createdAt = task.createdAt;
    }
    
    if (task.updated_at) {
      normalized.updatedAt = task.updated_at;
      delete normalized.updated_at;
    } else if (task.updatedAt !== undefined) {
      normalized.updatedAt = task.updatedAt;
    }
    
    if (task.user_id) {
      normalized.userId = task.user_id;
      delete normalized.user_id;
    } else if (task.userId !== undefined) {
      normalized.userId = task.userId;
    }
    
    if (task.completed === 1 || task.completed === 0) {
      normalized.completed = task.completed === 1;
    } else if (typeof task.completed === 'boolean') {
      normalized.completed = task.completed;
    }
    
    if (!normalized.lastUpdated) {
      normalized.lastUpdated = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    }
    
    if (task.subtasks && Array.isArray(task.subtasks)) {
      normalized.subtasks = task.subtasks.map(st => this.normalizeSubtask(st));
    }
    
    if (task.tags && Array.isArray(task.tags)) {
      normalized.tags = task.tags;
    }
    
    if (task.progress === undefined) {
      normalized.progress = normalized.completed ? 'completed' : 'pending';
    }
    
    return normalized;
  }

  normalizeSubtask(subtask) {
    const normalized = { ...subtask };
    normalized.id = String(subtask.id || '');
    if (subtask.completed === 1 || subtask.completed === 0) {
      normalized.completed = subtask.completed === 1;
    }
    return normalized;
  }

  normalizeMemo(memo) {
    const normalized = { ...memo };
    normalized.id = String(memo.id || '');
    if (memo.html_content) {
      normalized.htmlContent = memo.html_content;
      delete normalized.html_content;
    }
    if (memo.order_index !== undefined) {
      normalized.orderIndex = memo.order_index;
      delete normalized.order_index;
    }
    if (memo.order !== undefined && normalized.orderIndex === undefined) {
      normalized.orderIndex = memo.order;
    }
    if (memo.is_private !== undefined) {
      normalized.isPrivate = memo.is_private === 1 || memo.is_private === true;
      delete normalized.is_private;
    }
    if (memo.private !== undefined && normalized.isPrivate === undefined) {
      normalized.isPrivate = memo.private === 1 || memo.private === true;
    }
    if (memo.created_at) {
      normalized.createdAt = memo.created_at;
      delete normalized.created_at;
    }
    if (memo.updated_at) {
      normalized.updatedAt = memo.updated_at;
      delete normalized.updated_at;
    }
    if (memo.last_accessed_at) {
      normalized.lastAccessedAt = memo.last_accessed_at;
      delete normalized.last_accessed_at;
    }
    if (!normalized.lastUpdated) {
      normalized.lastUpdated = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    }
    return normalized;
  }

  normalizeExpense(expense) {
    const normalized = { ...expense };
    normalized.id = String(expense.id || '');
    if (expense.date) {
      normalized.date = expense.date;
    }
    if (expense.type === 0 || expense.type === 1) {
      normalized.type = expense.type === 1 ? 'income' : 'expense';
    }
    if (expense.amount && typeof expense.amount === 'number') {
      normalized.amount = expense.amount;
    }
    if (expense.created_at) {
      normalized.createdAt = expense.created_at;
      delete normalized.created_at;
    }
    if (expense.updated_at) {
      normalized.updatedAt = expense.updated_at;
      delete normalized.updated_at;
    }
    if (expense.user_id) {
      normalized.userId = expense.user_id;
      delete normalized.user_id;
    }
    if (!normalized.lastUpdated) {
      normalized.lastUpdated = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    }
    return normalized;
  }

  normalizeBudget(budget) {
    const normalized = { ...budget };
    normalized.id = String(budget.id || require('uuid').v4());
    
    if (budget.start_date) {
      normalized.startDate = budget.start_date;
      delete normalized.start_date;
    } else if (budget.startDate !== undefined) {
      normalized.startDate = budget.startDate;
    }
    
    if (budget.end_date) {
      normalized.endDate = budget.end_date;
      delete normalized.end_date;
    } else if (budget.endDate !== undefined) {
      normalized.endDate = budget.endDate;
    }
    
    if (budget.created_at) {
      normalized.createdAt = budget.created_at;
      delete normalized.created_at;
    } else if (budget.createdAt !== undefined) {
      normalized.createdAt = budget.createdAt;
    }
    
    if (budget.updated_at) {
      normalized.updatedAt = budget.updated_at;
      delete normalized.updated_at;
    } else if (budget.updatedAt !== undefined) {
      normalized.updatedAt = budget.updatedAt;
    }
    
    if (budget.user_id) {
      normalized.userId = budget.user_id;
      delete normalized.user_id;
    } else if (budget.userId !== undefined) {
      normalized.userId = budget.userId;
    }
    
    if (budget.amount && typeof budget.amount === 'number') {
      normalized.amount = budget.amount;
    }
    
    if (budget.categoryBudgets && Array.isArray(budget.categoryBudgets)) {
      normalized.categoryBudgets = budget.categoryBudgets;
    }
    
    if (!normalized.lastUpdated) {
      normalized.lastUpdated = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    }
    return normalized;
  }

  normalizeSecret(secret) {
    const normalized = { ...secret };
    normalized.id = String(secret.id || '');
    if (secret.created_at) {
      normalized.createdAt = secret.created_at;
      delete normalized.created_at;
    }
    if (secret.updated_at) {
      normalized.updatedAt = secret.updated_at;
      delete normalized.updated_at;
    }
    if (secret.last_accessed_at) {
      normalized.lastAccessedAt = secret.last_accessed_at;
      delete normalized.last_accessed_at;
    }
    if (secret.user_id) {
      normalized.userId = secret.user_id;
      delete normalized.user_id;
    }
    if (secret.fields && Array.isArray(secret.fields)) {
      normalized.fields = secret.fields.map(f => ({
        label: f.label || '',
        value: f.value || ''
      }));
    }
    if (!normalized.lastUpdated) {
      normalized.lastUpdated = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    }
    return normalized;
  }

  normalizeJournal(journal) {
    const normalized = { ...journal };
    normalized.id = String(journal.id || '');
    
    if (journal.date) {
      normalized.date = journal.date;
    }
    
    if (journal.created_at) {
      normalized.createdAt = journal.created_at;
      delete normalized.created_at;
    } else if (journal.createdAt !== undefined) {
      normalized.createdAt = journal.createdAt;
    }
    
    if (journal.updated_at) {
      normalized.updatedAt = journal.updated_at;
      delete normalized.updated_at;
    } else if (journal.updatedAt !== undefined) {
      normalized.updatedAt = journal.updatedAt;
    }
    
    if (journal.user_id) {
      normalized.userId = journal.user_id;
      delete normalized.user_id;
    } else if (journal.userId !== undefined) {
      normalized.userId = journal.userId;
    } else {
      normalized.userId = 'admin';
    }
    
    if (journal.content === undefined) {
      normalized.content = '';
    }
    
    if (!normalized.lastUpdated) {
      normalized.lastUpdated = normalized.updatedAt || normalized.createdAt || new Date().toISOString();
    }
    
    return normalized;
  }

  isOwnedByUser(item, currentUserId = null) {
    if (!currentUserId) {
      currentUserId = this.getCurrentUserId();
    }
    const itemUserId = item.userId || item.user_id || 'admin';
    const itemIsAdmin = (item.userId == null && item.user_id == null) || itemUserId === 'admin';
    const currentIsAdmin = !currentUserId || currentUserId === 'admin';
    // 'admin' 是系统默认标记（无特定子用户 / 通用身份）。
    // 跨设备同步时两端 userId 可能不一致，任一方为 admin 即视为同属当前账户，避免被静默丢弃。
    if (itemIsAdmin || currentIsAdmin) return true;
    return itemUserId === currentUserId;
  }

  async enqueueWrite(tasks, memos, expenses, budgets, settings, translationStats, categoryBudgets, secrets = [], journals = [], updateDataModified = false) {
    const writeItem = {
      tasks,
      memos,
      expenses,
      budgets,
      settings,
      translationStats,
      categoryBudgets,
      secrets,
      journals,
      updateDataModified,
      timestamp: Date.now()
    };

    this.writeQueue.push(writeItem);

    if (this.writeQueue.length >= this.MAX_QUEUE_SIZE) {
      await this.flushWriteQueue();
    } else {
      this.scheduleWrite();
    }
  }

  scheduleWrite() {
    if (this.writeDebounceTimer) {
      clearTimeout(this.writeDebounceTimer);
    }
    this.writeDebounceTimer = setTimeout(() => {
      this.flushWriteQueue();
    }, this.WRITE_DEBOUNCE_DELAY);
  }

  async flushWriteQueue() {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    const queue = [...this.writeQueue];
    this.writeQueue = [];

    try {
      const latestWrite = queue[queue.length - 1];
      await this._writeData(
        latestWrite.tasks,
        latestWrite.memos,
        latestWrite.expenses,
        latestWrite.budgets,
        latestWrite.settings,
        latestWrite.translationStats,
        latestWrite.categoryBudgets,
        latestWrite.secrets,
        latestWrite.journals,
        latestWrite.updateDataModified
      );
    } finally {
      this.isWriting = false;
    }
  }

  async writeData(tasks, memos, expenses, budgets, settings, translationStats, categoryBudgets, secrets = [], journals = [], updateDataModified = false) {
    await this.enqueueWrite(tasks, memos, expenses, budgets, settings, translationStats, categoryBudgets, secrets, journals, updateDataModified);
    return { success: true, message: '数据已加入写入队列' };
  }

  async _writeData(tasks, memos, expenses, budgets, settings, translationStats, categoryBudgets, secrets = [], journals = [], updateDataModified = false) {
    await this.invalidateCache();

    const dataPath = await this.getDataFilePath();
    const currentUserId = this.getCurrentUserId();

    try {
      const exists = await fsp.access(dataPath).then(() => true).catch(() => false);
      const existingData = exists ? JSON.parse(await fsp.readFile(dataPath, 'utf8')) : null;

      const data = {
        tasks: tasks || [],
        memos: memos || [],
        expenses: expenses || [],
        budgets: budgets || [],
        categoryBudgets: categoryBudgets || [],
        secrets: secrets || [],
        journals: journals || [],
        settings: settings || {},
        translationStats: translationStats || {},
        dataModified: updateDataModified ? new Date().toISOString() : (existingData?.dataModified || new Date().toISOString())
      };

      if (existingData) {
        Object.keys(existingData).forEach(key => {
          if (!data[key]) {
            data[key] = existingData[key];
          }
        });
      }

      await fsp.writeFile(dataPath, JSON.stringify(data, null, 2), 'utf8');

      return { success: true, message: '保存成功' };
    } catch (e) {
      console.error('[DataManager] 写入数据失败:', e);
      return { success: false, message: '保存失败: ' + e.message };
    }
  }

  async updateData(type, updates) {
    const data = await this.readData();
    // ★ 墓碑集合初始化（保证任何删除都能被记录并跨同步传播）
    if (!data.deletedItems) data.deletedItems = {};

    switch (type) {
      case 'task':
        const taskIndex = data.tasks.findIndex(t => String(t.id) === String(updates.id));
        if (taskIndex !== -1) {
          // ★ 创建者标签不可变：编辑时保留原 creator，忽略 updates 中的 creator
          const originalCreator = data.tasks[taskIndex].creator;
          data.tasks[taskIndex] = { ...data.tasks[taskIndex], ...updates };
          data.tasks[taskIndex].updatedAt = new Date().toISOString();
          if (originalCreator !== undefined) {
            data.tasks[taskIndex].creator = originalCreator;
          }
        } else {
          updates.updatedAt = updates.updatedAt || new Date().toISOString();
          data.tasks.push(updates);
        }
        break;
      case 'memo':
        const memoIndex = data.memos.findIndex(m => String(m.id) === String(updates.id));
        if (memoIndex !== -1) {
          // ★ 创建者标签不可变
          const originalCreator = data.memos[memoIndex].creator;
          data.memos[memoIndex] = { ...data.memos[memoIndex], ...updates };
          data.memos[memoIndex].updatedAt = new Date().toISOString();
          if (originalCreator !== undefined) {
            data.memos[memoIndex].creator = originalCreator;
          }
        } else {
          updates.updatedAt = updates.updatedAt || new Date().toISOString();
          data.memos.push(updates);
        }
        break;
      case 'expense':
        const expenseIndex = data.expenses.findIndex(e => String(e.id) === String(updates.id));
        if (expenseIndex !== -1) {
          // ★ 创建者标签不可变
          const originalCreator = data.expenses[expenseIndex].creator;
          data.expenses[expenseIndex] = { ...data.expenses[expenseIndex], ...updates };
          data.expenses[expenseIndex].updatedAt = new Date().toISOString();
          if (originalCreator !== undefined) {
            data.expenses[expenseIndex].creator = originalCreator;
          }
        } else {
          updates.updatedAt = updates.updatedAt || new Date().toISOString();
          data.expenses.push(updates);
        }
        break;
      case 'delete-task':
        data.tasks = data.tasks.filter(t => String(t.id) !== String(updates));
        (data.deletedItems.tasks = data.deletedItems.tasks || []).push(String(updates));
        break;
      case 'delete-memo':
        data.memos = data.memos.filter(m => String(m.id) !== String(updates));
        (data.deletedItems.memos = data.deletedItems.memos || []).push(String(updates));
        break;
      case 'delete-expense':
        data.expenses = data.expenses.filter(e => String(e.id) !== String(updates));
        (data.deletedItems.expenses = data.deletedItems.expenses || []).push(String(updates));
        break;
    }

    this.cachedData = { ...data };
    this.lastDataLoadTime = Date.now();

    const writeResult = await this.writeData(
      data.tasks,
      data.memos,
      data.expenses,
      data.budgets,
      data.settings,
      data.translationStats,
      data.categoryBudgets,
      data.secrets || [],
      data.journals || [],
      true,
      undefined, // chatHistory（未变更时由 writeData 回退磁盘值）
      undefined, // chatRooms
      undefined, // chatHistoryStore
      undefined, // chatHistoryLimit
      data.deletedItems // ★ 第15参数：墓碑集合，必须显式传入，否则本地删除无法落盘、云端数据会被重新同步回来
    );

    return { data: data, writeResult: writeResult };
  }
}

const dataManager = new DataManager();

module.exports = { DataManager, dataManager };