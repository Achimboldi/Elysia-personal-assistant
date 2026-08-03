const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { safeLog, safeError, generateContentHash, sendToAllWindows, getCurrentVersion } = require('./main-utils');

// 数据缓存（同步版，供 main.js 中的 IPC handler 使用）
let cachedData = null;
let lastDataLoadTime = 0;
const DATA_CACHE_TTL = 30000; // 延长到30秒，减少工具循环期间的重复文件读取

function getExePath() {
  return path.dirname(app.getPath('exe'));
}

function getDataFilePath(userId = null) {
  const currentUserId = userId || getCurrentUserId();
  const exePath = getExePath();

  if (currentUserId && currentUserId !== 'admin') {
    const userDataDir = path.join(exePath, 'users', currentUserId);
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

function getCurrentUserId() {
  try {
    const dataPath = path.join(getExePath(), 'data.json');
    if (fs.existsSync(dataPath)) {
      const content = fs.readFileSync(dataPath, 'utf8');
      const data = JSON.parse(content);
      return data.settings?.cloudCurrentUserId || data.cloudCurrentUserId || 'admin';
    }
  } catch (e) {
  }
  return 'admin';
}

function isOwnedByUser(item, currentUserId = null) {
  if (!currentUserId) {
    currentUserId = getCurrentUserId();
  }
  const itemUserId = item.userId || item.user_id || 'admin';
  const itemIsAdmin = (item.userId == null && item.user_id == null) || itemUserId === 'admin';
  const currentIsAdmin = !currentUserId || currentUserId === 'admin';
  // 'admin' 是系统默认标记，代表"无特定子用户 / 通用身份"。
  // 跨设备同步时两端 userId 可能不一致（一端 admin、一端已切换用户），
  // 此时不应按 userId 静默丢弃对方同步过来的数据：
  //   任一方为 admin(默认/通用) 即视为同属当前账户，正常同步；
  //   仅当两端都是具体且不同的用户名时才做隔离。
  if (itemIsAdmin || currentIsAdmin) return true;
  return itemUserId === currentUserId;
}

function writeUserSpecificData(userId, data) {
  if (!userId || userId === 'admin') return;

  const exePath = getExePath();
  const userDataDir = path.join(exePath, 'users', userId);

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const userDataPath = path.join(userDataDir, 'data.json');
  const userData = {
    tasks: data.tasks || [],
    memos: data.memos || [],
    expenses: data.expenses || [],
    budgets: data.budgets || [],
    categoryBudgets: data.categoryBudgets || [],
    secrets: data.secrets || [],
    journals: data.journals || [],
    translationStats: data.translationStats || {},
    chatHistory: data.chatHistory || [],
    chatRooms: data.chatRooms || [],
    chatHistoryStore: data.chatHistoryStore || {},
    chatHistoryLimit: data.chatHistoryLimit ?? 50
  };

  fs.writeFileSync(userDataPath, JSON.stringify(userData, null, 2));
}

function updateAdminSettings(newSettings) {
  const exePath = getExePath();
  const adminDataPath = path.join(exePath, 'data.json');

  let adminData = { settings: {} };
  if (fs.existsSync(adminDataPath)) {
    const content = fs.readFileSync(adminDataPath, 'utf8');
    adminData = JSON.parse(content);
  }

  adminData.settings = adminData.settings || {};
  Object.assign(adminData.settings, newSettings);

  fs.writeFileSync(adminDataPath, JSON.stringify(adminData, null, 2));
}

function readAdminData() {
  const exePath = getExePath();
  const adminDataPath = path.join(exePath, 'data.json');

  if (fs.existsSync(adminDataPath)) {
    const content = fs.readFileSync(adminDataPath, 'utf8');
    return JSON.parse(content);
  }

  return { settings: {} };
}

function invalidateCache() {
  cachedData = null;
  lastDataLoadTime = 0;
}

function readData(forceReload = false) {
  const now = Date.now();

  if (!forceReload && cachedData && (now - lastDataLoadTime) < DATA_CACHE_TTL) {
    return cachedData;
  }

  const dataPath = getDataFilePath();
  const currentUserId = getCurrentUserId();

  try {
    if (fs.existsSync(dataPath)) {
      const content = fs.readFileSync(dataPath, 'utf8');
      const data = JSON.parse(content);

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
          return isOwnedByUser(task, currentUserId);
        });
      }

      if (data.memos && typeof data.memos === 'object') {
        memos = data.memos;
        const memoSeenIds = new Set();
        memos = memos.filter(memo => {
          if (!memo.id) return true;
          const id = String(memo.id);
          if (memoSeenIds.has(id)) return false;
          memoSeenIds.add(id);
          return isOwnedByUser(memo, currentUserId);
        });
      }

      if (data.expenses && typeof data.expenses === 'object') {
        expenses = data.expenses;
        const expenseSeenIds = new Set();
        expenses = expenses.filter(expense => {
          if (!expense.id) return true;
          const id = String(expense.id);
          if (expenseSeenIds.has(id)) return false;
          expenseSeenIds.add(id);
          return isOwnedByUser(expense, currentUserId);
        });
      }

      if (data.budgets && typeof data.budgets === 'object') {
        budgets = data.budgets.filter(budget => isOwnedByUser(budget, currentUserId));
      }

      if (data.categoryBudgets && typeof data.categoryBudgets === 'object') {
        categoryBudgets = data.categoryBudgets.filter(cb => isOwnedByUser(cb, currentUserId));
      }

      if (data.secrets && typeof data.secrets === 'object') {
        secrets = data.secrets;
        const secretSeenIds = new Set();
        secrets = secrets.filter(secret => {
          if (!secret.id) return true;
          const id = String(secret.id);
          if (secretSeenIds.has(id)) return false;
          secretSeenIds.add(id);
          return isOwnedByUser(secret, currentUserId);
        });
      }

      if (data.journals && Array.isArray(data.journals)) {
        journals = data.journals;
        const journalSeenIds = new Set();
        journals = journals.filter(journal => {
          if (!journal.id) return true;
          const id = String(journal.id);
          if (journalSeenIds.has(id)) return false;
          journalSeenIds.add(id);
          return isOwnedByUser(journal, currentUserId);
        });
      }

      cachedData = {
        tasks: tasks || [],
        memos: memos || [],
        expenses: expenses || [],
        budgets: budgets || [],
        categoryBudgets: categoryBudgets || [],
        secrets: secrets || [],
        journals: journals || [],
        settings: data.settings || {},
        translationStats: data.translationStats || {},
        chatHistory: (data.chatHistory || []).filter(msg => isOwnedByUser(msg, currentUserId)),
        chatRooms: data.chatRooms || [],
        chatHistoryStore: data.chatHistoryStore || {},
        chatHistoryLimit: data.chatHistoryLimit ?? 50,
        dailyTasks: data.dailyTasks || [],
        // ★ 墓碑：读取时一并返回，供合并逻辑判断已删除条目
        deletedItems: data.deletedItems || {}
      };
      lastDataLoadTime = now;
      return cachedData;
    }
  } catch (e) {
    safeError('读取数据失败:', e);
  }
  return {
    tasks: [],
    memos: [],
    expenses: [],
    budgets: [],
    categoryBudgets: [],
    secrets: [],
    journals: [],
    settings: {},
    translationStats: {},
    chatHistory: [],
    chatRooms: [],
    chatHistoryStore: {},
    chatHistoryLimit: 50,
    dailyTasks: [],
    deletedItems: {}
  };
}

// ============================================================
// 每日任务直接读写（供主进程内 xilian-tools 使用，避免 IPC）
// ============================================================
function readDailyTasks() {
  return readData().dailyTasks || [];
}

async function _writeDailyTasksRaw(dailyTasks) {
  const dataPath = getDataFilePath();
  const maxWait = 2000;
  const startWait = Date.now();
  while (global._elysiaWriteLock && (Date.now() - startWait) < maxWait) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (global._elysiaWriteLock) {
    console.error('[data-service] _writeDailyTasksRaw 写入超时，锁未释放');
    return false;
  }
  global._elysiaWriteLock = true;
  try {
    const exists = fs.existsSync(dataPath);
    const raw = exists ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : {};
    raw.dailyTasks = dailyTasks;
    raw.dataModified = new Date().toISOString();
    fs.writeFileSync(dataPath, JSON.stringify(raw, null, 2), 'utf8');
    invalidateCache();
    return true;
  } catch (e) {
    console.error('[data-service] _writeDailyTasksRaw 失败:', e.message);
    return false;
  } finally {
    global._elysiaWriteLock = false;
  }
}

async function createDailyTask(dailyTask) {
  const list = readDailyTasks();
  const now = new Date().toISOString();
  const task = {
    ...dailyTask,
    id: dailyTask.id || require('uuid').v4(),
    createdAt: dailyTask.createdAt || now,
    completed: dailyTask.completed || false,
    dailyDate: dailyTask.dailyDate || now.slice(0, 10)
  };
  list.push(task);
  const ok = await _writeDailyTasksRaw(list);
  if (ok) sendToAllWindows('daily-tasks-updated');
  return { success: ok, dailyTask: task };
}

async function updateDailyTask(taskId, updates) {
  const list = readDailyTasks();
  const idx = list.findIndex(dt => String(dt.id) === String(taskId));
  if (idx === -1) return { success: false, message: 'task not found' };
  Object.assign(list[idx], updates, { updatedAt: new Date().toISOString() });
  const ok = await _writeDailyTasksRaw(list);
  if (ok) sendToAllWindows('daily-tasks-updated');
  return { success: ok, dailyTask: list[idx] };
}

async function deleteDailyTask(taskId) {
  const list = readDailyTasks();
  const filtered = list.filter(dt => String(dt.id) !== String(taskId));
  if (filtered.length === list.length) return { success: false, message: 'task not found' };
  const ok = await _writeDailyTasksRaw(filtered);
  if (ok) sendToAllWindows('daily-tasks-updated');
  return { success: ok };
}

function deduplicateItems(items) {
  const seenContentHashes = new Set();
  return items.filter(item => {
    if (!item) return true;
    const contentHash = generateContentHash(item);
    if (seenContentHashes.has(contentHash)) return false;
    seenContentHashes.add(contentHash);
    return true;
  });
}

function cleanupDuplicateData() {
  const data = readData() || {};
  const currentUserId = getCurrentUserId();

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const memos = Array.isArray(data.memos) ? data.memos : [];
  const expenses = Array.isArray(data.expenses) ? data.expenses : [];
  const budgets = Array.isArray(data.budgets) ? data.budgets : [];
  const secrets = Array.isArray(data.secrets) ? data.secrets : [];
  const journals = Array.isArray(data.journals) ? data.journals : [];

  const originalTaskCount = tasks.length;
  const originalMemoCount = memos.length;
  const originalExpenseCount = expenses.length;
  const originalBudgetCount = budgets.length;
  const originalSecretCount = secrets.length;
  const originalJournalCount = journals.length;

  const uniqueTasks = deduplicateItems(tasks);
  const uniqueMemos = deduplicateItems(memos);
  const uniqueExpenses = deduplicateItems(expenses);
  const uniqueBudgets = deduplicateItems(budgets);
  const uniqueSecrets = deduplicateItems(secrets);
  const uniqueJournals = deduplicateItems(journals);

  const removedTasks = originalTaskCount - uniqueTasks.length;
  const removedMemos = originalMemoCount - uniqueMemos.length;
  const removedExpenses = originalExpenseCount - uniqueExpenses.length;
  const removedBudgets = originalBudgetCount - uniqueBudgets.length;
  const removedSecrets = originalSecretCount - uniqueSecrets.length;
  const removedJournals = originalJournalCount - uniqueJournals.length;

  const totalRemoved = removedTasks + removedMemos + removedExpenses + removedBudgets + removedSecrets + removedJournals;

  if (totalRemoved > 0) {
    // ★ 注意：cleanupDuplicateData 本身是同步函数，writeData 现在是异步的。
    // 返回 { pending: true, promise } 供调用者使用。
    const writePromise = writeData(
      uniqueTasks,
      uniqueMemos,
      uniqueExpenses,
      uniqueBudgets,
      data.settings || {},
      data.translationStats || {},
      data.categoryBudgets || [],
      uniqueSecrets,
      uniqueJournals,
      true,
      data.chatHistory
    );

    // 后台处理写入结果
    writePromise.then(writeResult => {
      if (writeResult.success) {
        safeLog(`[重复数据清理] 已清理 ${totalRemoved} 条重复数据: 任务${removedTasks} 备忘录${removedMemos} 收支${removedExpenses} 预算${removedBudgets} 密钥${removedSecrets} 日志${removedJournals}`);
        sendToAllWindows('tasks-updated');
        sendToAllWindows('memos-updated');
        sendToAllWindows('expenses-updated');
      }
    });

    return {
      success: true,
      message: `正在清理 ${totalRemoved} 条重复数据...`,
      removed: {
        tasks: removedTasks,
        memos: removedMemos,
        expenses: removedExpenses,
        budgets: removedBudgets,
        secrets: removedSecrets,
        journals: removedJournals,
        total: totalRemoved
      }
    };
  } else {
    return {
      success: true,
      message: '未发现重复数据',
      removed: {
        tasks: 0,
        memos: 0,
        expenses: 0,
        budgets: 0,
        secrets: 0,
        journals: 0,
        total: 0
      }
    };
  }
}

async function writeData(tasks, memos, expenses, budgets, settings, translationStats, categoryBudgets, secrets, journals, updateDataModified, chatHistory, chatRooms, chatHistoryStore, chatHistoryLimit, deletedItems) {
  // ★ 写锁：防止并发写入
  if (global._elysiaWriteLock) { return { success: false, message: '写入繁忙，请重试' }; }
  global._elysiaWriteLock = true;
  
  try {
    invalidateCache();
    const dataPath = getDataFilePath();
    const currentUserId = getCurrentUserId();
    
    let existingData = null;
    try { if (fs.existsSync(dataPath)) existingData = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch { existingData = null; }
    const dataLastModified = updateDataModified ? Date.now() : (existingData?.settings?.dataLastModified || Date.now());
    const journalsArray = Array.isArray(journals) ? journals : [];
    const localSettings = existingData?.settings || {};
    const mergedSettings = { ...localSettings, ...(settings || {}), dataLastModified, lastModified: Date.now() };
    
    // ★ 修复：所有字段统一处理 undefined 的情况
    // 原理：调用方如果没传某个参数（undefined），说明它不想改这个字段，
    //       应该从磁盘现有数据里保留，而不是直接写空数组覆盖
    const uniqueTasks = deduplicateItems(tasks !== undefined ? (tasks || []) : (existingData?.tasks || []));
    const uniqueMemos = deduplicateItems(memos !== undefined ? (memos || []) : (existingData?.memos || []));
    const uniqueExpenses = deduplicateItems(expenses !== undefined ? (expenses || []) : (existingData?.expenses || []));
    const uniqueBudgets = deduplicateItems(budgets !== undefined ? (budgets || []) : (existingData?.budgets || []));
    const uniqueSecrets = deduplicateItems(secrets !== undefined ? (secrets || []) : (existingData?.secrets || []));
    const uniqueJournals = deduplicateItems(journals !== undefined ? journalsArray : (existingData?.journals || []));

    const resolvedChatHistory = chatHistory !== undefined ? chatHistory : (existingData?.chatHistory || []);
    const resolvedChatRooms = chatRooms !== undefined ? (Array.isArray(chatRooms) ? chatRooms : (existingData?.chatRooms || [])) : (existingData?.chatRooms || []);
    const resolvedChatHistoryStore = chatHistoryStore !== undefined ? (Object.keys(chatHistoryStore || {}).length > 0 ? chatHistoryStore : (existingData?.chatHistoryStore || {})) : (existingData?.chatHistoryStore || {});
    const resolvedChatHistoryLimit = chatHistoryLimit !== undefined ? chatHistoryLimit : (existingData?.chatHistoryLimit ?? 50);
    
    const data = {
      tasks: uniqueTasks.map(task => ({ ...task, userId: currentUserId })),
      memos: uniqueMemos.map(memo => ({ ...memo, userId: currentUserId })),
      expenses: uniqueExpenses.map(expense => ({ ...expense, userId: currentUserId })),
      budgets: uniqueBudgets.map(budget => ({ ...budget, userId: currentUserId })),
      categoryBudgets: (categoryBudgets || []).map(cb => ({ ...cb, userId: currentUserId })),
      secrets: uniqueSecrets.map(secret => ({ ...secret, userId: currentUserId })),
      journals: uniqueJournals.map(journal => ({ ...journal, userId: currentUserId })),
      settings: mergedSettings,
      translationStats: translationStats || {},
      chatHistory: resolvedChatHistory,
      chatRooms: resolvedChatRooms,
      chatHistoryStore: resolvedChatHistoryStore,
      chatHistoryLimit: resolvedChatHistoryLimit,
      // ★ 墓碑：删除标记集合，未显式传入时保留磁盘已有值（保证删除跨同步传播）
      deletedItems: deletedItems !== undefined ? deletedItems : (existingData?.deletedItems || {}),
      // ★ 每日任务：未显式传入时保留磁盘已有值（避免 _writeDailyTasks 的写入被覆盖）
      dailyTasks: existingData?.dailyTasks || [],
      lastUpdated: new Date().toISOString()
    };
    
    const dir = path.dirname(dataPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    // ★ 安全原子写入
    // 问题：unlink + rename 在 Windows 上不可靠（unlink 后 rename 可能因文件锁/EPERM 失败）
    // 导致 data.json 被删但 tmp 无法重命名 → 数据丢失
    // 方案：先写 tmp → 备份旧文件 → rename tmp → 成功后删备份
    //   rename 失败时回退到 copyFile（最坏情况数据在 tmp 中不丢失）
    const jsonStr = JSON.stringify(data, null, 2);
    const tmpPath = dataPath + '.' + Date.now() + '.tmp';
    const bakPath = dataPath + '.bak';

    // 1. 写入临时文件
    await fs.promises.writeFile(tmpPath, jsonStr, 'utf8');

    // 2. 把原文件移走（做备份），腾出 dataPath
    try { await fs.promises.rename(dataPath, bakPath); } catch {}

    // 3. 把临时文件重命名为正式文件
    try {
      await fs.promises.rename(tmpPath, dataPath);
    } catch (renameErr) {
      // Windows rename 可能因跨设备/文件锁失败，回退到 copyFile
      safeLog('[writeData] rename 失败，使用 copyFile 备用方案:', renameErr.message);
      try {
        await fs.promises.copyFile(tmpPath, dataPath);
        await fs.promises.unlink(tmpPath).catch(() => {});
      } catch (copyErr) {
        // 两个方案都失败 → 数据仍在 tmpPath，不丢
        safeLog('[writeData] copyFile 也失败，数据保存在临时文件:', tmpPath);
        return { success: false, message: '写入失败，完整数据保存在: ' + path.basename(tmpPath) };
      }
    }

    // 4. 清理备份
    try { await fs.promises.unlink(bakPath); } catch {}

    return { success: true, message: 'OK', path: dataPath };
  } catch (e) {
    // 出错时保留临时文件（可能包含重要数据），只清理旧备份
    const fallbackDataPath = getDataFilePath();
    try {
      const bakFilePath = fallbackDataPath + '.bak';
      try { await fs.promises.unlink(bakFilePath); } catch {}
    } catch {}
    console.error('[writeData] 失败:', e.message);
    return { success: false, message: '写入失败: ' + e.message };
  } finally {
    global._elysiaWriteLock = false;
  }
}

function cleanupForeignUserData() {
  const currentUserId = getCurrentUserId();
  const currentData = readData();

  const originalTaskCount = currentData.tasks.length;
  const originalMemoCount = currentData.memos.length;
  const originalExpenseCount = currentData.expenses.length;
  const originalBudgetCount = currentData.budgets.length;
  const originalCategoryBudgetCount = currentData.categoryBudgets?.length || 0;
  const originalSecretCount = currentData.secrets.length;
  const originalJournalCount = currentData.journals.length;

  const filteredTasks = currentData.tasks.filter(task => isOwnedByUser(task, currentUserId));
  const filteredMemos = currentData.memos.filter(memo => isOwnedByUser(memo, currentUserId));
  const filteredExpenses = currentData.expenses.filter(expense => isOwnedByUser(expense, currentUserId));
  const filteredBudgets = currentData.budgets.filter(budget => isOwnedByUser(budget, currentUserId));
  const filteredCategoryBudgets = (currentData.categoryBudgets || []).filter(cb => isOwnedByUser(cb, currentUserId));
  const filteredSecrets = currentData.secrets.filter(secret => isOwnedByUser(secret, currentUserId));
  const filteredJournals = currentData.journals.filter(journal => isOwnedByUser(journal, currentUserId));

  const removedTasks = originalTaskCount - filteredTasks.length;
  const removedMemos = originalMemoCount - filteredMemos.length;
  const removedExpenses = originalExpenseCount - filteredExpenses.length;
  const removedBudgets = originalBudgetCount - filteredBudgets.length;
  const removedCategoryBudgets = originalCategoryBudgetCount - filteredCategoryBudgets.length;
  const removedSecrets = originalSecretCount - filteredSecrets.length;
  const removedJournals = originalJournalCount - filteredJournals.length;

  if (removedTasks > 0 || removedMemos > 0 || removedExpenses > 0 || removedBudgets > 0 || removedCategoryBudgets > 0 || removedSecrets > 0 || removedJournals > 0) {
    safeLog(`[数据清理] 当前用户: ${currentUserId}`);
    safeLog(`[数据清理] 删除任务: ${removedTasks}, 删除备忘录: ${removedMemos}, 删除收支: ${removedExpenses}, 删除预算: ${removedBudgets}, 删除分类预算: ${removedCategoryBudgets}, 删除密钥: ${removedSecrets}, 删除日志: ${removedJournals}`);

    // ★ 异步写入（不阻塞），后台处理结果
    writeData(
      filteredTasks,
      filteredMemos,
      filteredExpenses,
      filteredBudgets,
      currentData.settings || {},
      currentData.translationStats || {},
      filteredCategoryBudgets,
      filteredSecrets,
      filteredJournals,
      false,
      currentData.chatHistory
    );

    return {
      success: true,
      message: `清理完成: 任务(${removedTasks})、笔记(${removedMemos})、收支(${removedExpenses})、预算(${removedBudgets})、分类预算(${removedCategoryBudgets})、密钥(${removedSecrets})、日志(${removedJournals})`,
      removed: { tasks: removedTasks, memos: removedMemos, expenses: removedExpenses, budgets: removedBudgets, categoryBudgets: removedCategoryBudgets, secrets: removedSecrets, journals: removedJournals }
    };
  }

  return { success: true, message: '无需清理', removed: { tasks: 0, memos: 0, expenses: 0, budgets: 0, categoryBudgets: 0, secrets: 0, journals: 0 } };
}

async function updateData(type, updates) {
  const { dataManager } = require('./data-manager');
  const result = await dataManager.updateData(type, updates);

  if (result.writeResult.success) {
    switch (type) {
      case 'task':
      case 'delete-task':
        sendToAllWindows('tasks-updated');
        break;
      case 'memo':
      case 'delete-memo':
        sendToAllWindows('memos-updated');
        break;
      case 'expense':
      case 'delete-expense':
        sendToAllWindows('expenses-updated');
        break;
    }
  }

  return result;
}

module.exports = {
  getExePath,
  getDataFilePath,
  getCurrentUserId,
  isOwnedByUser,
  writeUserSpecificData,
  updateAdminSettings,
  readAdminData,
  invalidateCache,
  readData,
  readDailyTasks,
  createDailyTask,
  updateDailyTask,
  deleteDailyTask,
  deduplicateItems,
  cleanupDuplicateData,
  writeData,
  cleanupForeignUserData,
  updateData
};
