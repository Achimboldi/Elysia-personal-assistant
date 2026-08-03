const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const AutoLaunch = require('auto-launch');
const { uIOhook } = require('uiohook-napi');
const { v4: uuidv4 } = require('uuid');
const CloudSync = require('./cloud-sync');
const UpdateManager = require('./update-manager');
const CryptoManager = require('./crypto-manager');
const { dataManager } = require('./data-manager');
const { safeLog, safeError, normalizeDate, generateContentHash, sendToAllWindows, getCurrentAppPath, grayscaleImage, copyDirSync, getCurrentVersion, getUserDataPath } = require('./main-utils');
const { getDataFilePath, getCurrentUserId, isOwnedByUser, writeUserSpecificData, updateAdminSettings, readAdminData, invalidateCache, readData, deduplicateItems, cleanupDuplicateData, writeData, cleanupForeignUserData, updateData } = require('./data-service');
const { streamChat, buildSimpleReply } = require('./xilian-agent');

// ★ 提醒模块（主进程收口：数据/频率/调度/执行/IPC）——模块异常不影响应用启动
let reminderManager = null;
try {
  reminderManager = require('./reminder-manager');
} catch (e) {
  safeError('[提醒] reminder-manager 加载失败:', e);
}

let lastBackupTime = 0;
let lastBackupHash = '';

// ★ 聊天室合并辅助函数（模块级别，供所有 IPC 处理函数使用）
function _mergeChatRoomsById(localRooms, cloudRooms) {
  const roomMap = new Map();
  for (const r of localRooms) {
    if (r && r.id) roomMap.set(String(r.id), r);
  }
  for (const r of cloudRooms) {
    if (!r || !r.id) continue;
    const local = roomMap.get(String(r.id));
    if (local) {
      const localTime = new Date(local.updateTime || local.createdAt || 0).getTime();
      const cloudTime = new Date(r.updateTime || r.createdAt || 0).getTime();
      if (cloudTime > localTime) { roomMap.set(String(r.id), r); }
    } else {
      roomMap.set(String(r.id), r);
    }
  }
  return Array.from(roomMap.values());
}

function _mergeChatHistoryStore(localStore, cloudStore) {
  const merged = {};
  const allKeys = new Set([...Object.keys(localStore), ...Object.keys(cloudStore)]);
  for (const key of allKeys) {
    const localMessages = localStore[key] || [];
    const cloudMessages = cloudStore[key] || [];
    if (localMessages.length === 0) { merged[key] = cloudMessages; }
    else if (cloudMessages.length === 0) { merged[key] = localMessages; }
    else { merged[key] = _mergeMessagesById(localMessages, cloudMessages); }
  }
  return merged;
}

function _mergeMessagesById(messagesA, messagesB) {
  const msgMap = new Map();
  for (const msg of messagesA) { if (msg.id) msgMap.set(msg.id, { ...msg }); }
  for (const msg of messagesB) {
    if (!msg.id) continue;
    const existing = msgMap.get(msg.id);
    if (existing) {
      if ((msg.timestamp || 0) > (existing.timestamp || 0)) { msgMap.set(msg.id, { ...msg }); }
    } else { msgMap.set(msg.id, { ...msg }); }
  }
  return [...msgMap.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

// ★ 读写竞态修复：将"同步期间（网络往返）新保存的本地项"补回到合并结果
// 自动同步基于同步开始时的旧快照做合并，直接 writeData 会覆盖掉同步窗口内用户新保存的
// 编辑/消息。此函数重新读取最新磁盘数据，把本地新增/更新的项保留下来，避免内容丢失。
function _reconcileWithFreshLocal(merged, fresh) {
  if (!merged) return merged;
  fresh = fresh || {};
  const preserveArr = (mergedArr, freshArr, timeKeys) => {
    const map = new Map();
    for (const it of (mergedArr || [])) {
      if (it && it.id != null) map.set(String(it.id), it);
    }
    for (const it of (freshArr || [])) {
      if (!it || it.id == null) continue;
      const k = String(it.id);
      const ex = map.get(k);
      if (!ex) {
        map.set(k, it);            // 同步期间新增的本地项 → 补回
      } else {
        const tM = _itemTime(ex, timeKeys);
        const tF = _itemTime(it, timeKeys);
        if (tF > tM) map.set(k, it); // 本地更新时间更新 → 以本地为准
      }
    }
    return Array.from(map.values());
  };
  merged.tasks = preserveArr(merged.tasks, fresh.tasks, ['updatedAt', 'lastModified', 'createdAt', 'editTime']);
  merged.memos = preserveArr(merged.memos, fresh.memos, ['updatedAt', 'lastModified', 'createdAt', 'editTime']);
  merged.expenses = preserveArr(merged.expenses, fresh.expenses, ['updatedAt', 'lastModified', 'createdAt', 'date']);
  merged.budgets = preserveArr(merged.budgets, fresh.budgets, ['updatedAt', 'lastModified', 'createdAt']);
  merged.categoryBudgets = preserveArr(merged.categoryBudgets, fresh.categoryBudgets, ['updatedAt', 'lastModified', 'createdAt']);
  merged.secrets = preserveArr(merged.secrets, fresh.secrets, ['updatedAt', 'lastModified', 'createdAt']);
  merged.journals = preserveArr(merged.journals, fresh.journals, ['updatedAt', 'lastModified', 'createdAt', 'date']);
  merged.dailyTasks = preserveArr(merged.dailyTasks, fresh.dailyTasks, ['updatedAt', 'createdAt']);
  merged.chatHistory = preserveArr(merged.chatHistory, fresh.chatHistory, ['timestamp', 'createdAt']);
  // 聊天室：本地优先（仅当云端更新时间严格更新时才覆盖）
  merged.chatRooms = _mergeChatRoomsById(fresh.chatRooms || [], merged.chatRooms || []);
  // 聊天记录存储：本地优先合并，保留同步期间新增的消息
  merged.chatHistoryStore = _mergeChatHistoryStore(fresh.chatHistoryStore || {}, merged.chatHistoryStore || {});
  return merged;
}

function _itemTime(it, timeKeys) {
  if (!timeKeys || !it) return 0;
  for (const k of timeKeys) {
    const v = it[k];
    if (v) {
      const t = (typeof v === 'number') ? v : new Date(v).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
  }
  return 0;
}

// ============================================================
// 备份工具函数（模块级别，供全局使用）
// ============================================================
function getBackupDir() {
    const exePath = app.getPath('exe');
    const appDir = path.dirname(exePath);
    const backupDir = path.join(appDir, 'app-cache', 'backups');
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
}

function generateDataHash(data) {
    const crypto = require('crypto');
    const jsonStr = JSON.stringify(data, (key, value) => {
        if (key === 'id' || key === 'createdAt' || key === 'lastModified') {
            return undefined;
        }
        return value;
    });
    return crypto.createHash('md5').update(jsonStr).digest('hex');
}

/** 合并预设列表：云端优先（相同ID以云端为准），保留两地独有预设 */
function mergePresetLists(cloudPresets, localPresets) {
    // 第一步：按 ID 合并（cloud 覆盖 local 同 ID）
    const map = new Map();
    for (const p of localPresets) { if (p.id) map.set(p.id, p); }
    for (const p of cloudPresets) { if (p.id) map.set(p.id, p); }
    const merged = Array.from(map.values());
    
    // 第二步：检测同名预设去重（不同设备独立创建导致的 ID 不同但名称相同）
    const nameMap = new Map();
    const result = [];
    for (const p of merged) {
        const name = (p.name || '').trim().toLowerCase();
        if (!name) { result.push(p); continue; }
        const existing = nameMap.get(name);
        if (existing) {
            // 存在同名预设 → 保留数据更丰富的一个（systemPrompt 更长、有 avatar）
            const existingScore = (existing.systemPrompt?.length || 0) + (existing.avatar ? 100 : 0);
            const newScore = (p.systemPrompt?.length || 0) + (p.avatar ? 100 : 0);
            if (newScore > existingScore) {
                // 替换：保留更丰富的那个
                const idx = result.indexOf(existing);
                if (idx >= 0) result[idx] = p;
                nameMap.set(name, p);
            }
            // 否则丢弃当前 p，保留 existing
        } else {
            result.push(p);
            nameMap.set(name, p);
        }
    }
    
    // 第三步：按名称排序（中文在前，字母在后）
    result.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    
    return result;
}

// 双版本管理配置
async function setCurrentVersion(version) {
  const currentData = readData();
  currentData.settings = currentData.settings || {};
  currentData.settings.appVersion = version;
  await writeData(
    currentData.tasks,
    currentData.memos,
    currentData.expenses,
    currentData.budgets,
    currentData.settings,
    currentData.translationStats,
    currentData.categoryBudgets || [],
    currentData.secrets || [],
    currentData.journals || []
  );
}

function getCloudSyncPath() {
  const settings = readData().settings || {};
  if (settings.cloudSyncPath && fs.existsSync(settings.cloudSyncPath)) {
    return settings.cloudSyncPath;
  }
  
  const defaultPath = path.join(path.dirname(path.dirname(app.getPath('exe'))), '..', 'BaiduSyncdisk');
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  
  return path.dirname(path.dirname(app.getPath('exe')));
}

// 云同步实例
let cloudSync = null;

// 更新管理器实例
let updateManager = null;

function getUpdateManager() {
  if (!updateManager) {
    updateManager = new UpdateManager();
    updateManager.setLogger((msg) => safeLog('[UpdateManager] ' + msg));
    // ★ Git 模式不再依赖百度网盘 cloudSync
  }
  return updateManager;
}

// 加密管理器实例
let cryptoManager = null;

function getCryptoManager() {
  if (!cryptoManager) {
    cryptoManager = new CryptoManager();
  }
  return cryptoManager;
}

// 判断当前运行的是正式版还是测试版
// 基于父目录名判断：xushi 为正式版，xushi-test 为测试版
function isTestVersion() {
  const exePath = app.getPath('exe');
  const parentDir = path.basename(path.dirname(path.dirname(exePath)));
  return parentDir === 'Elysia-test';
}

const IS_TEST_VERSION = isTestVersion();

let mainWindow;
let tray;
let reminderWindows = [];
let stickyNoteWindows = [];
let lastAltPressTime = 0;
let lastAltReleaseTime = 0;
let currentEditingTask = null;
let colorPickerWindow = null;
let colorPickerCallback = null;

function getResourcesPath() {
  const appPath = getCurrentAppPath();
  const resourcesPath = path.join(appPath, '..', '背景图');
  if (fs.existsSync(resourcesPath)) {
    return resourcesPath;
  }
  
  return path.join(appPath, '背景图');
}

function getCloudVersion() {
  try {
    const cloudSyncPath = getCloudSyncPath();
    const versionFile = path.join(cloudSyncPath, 'version.txt');
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf8');
      const match = content.match(/版本号[：:]\s*([\d.]+)/);
      if (match) {
        return match[1];
      }
    }
  } catch (e) {
    safeError('读取云同步版本失败:', e);
  }
  return null;
}

function syncDataToCloud() {
  try {
    const currentDataPath = getDataFilePath();
    const cloudSyncPath = getCloudSyncPath();
    const cloudDataPath = path.join(cloudSyncPath, 'win-unpacked', 'data.json');
    
    if (fs.existsSync(currentDataPath)) {
      fs.copyFileSync(currentDataPath, cloudDataPath);
      safeLog('数据已同步到云同步路径');
      return true;
    }
  } catch (e) {
    safeError('同步数据到云同步路径失败:', e);
  }
  return false;
}

// 同步 MC 记忆数据库到百度网盘
function syncMCDbToCloud() {
  try {
    const cloudSyncPath = getCloudSyncPath();
    if (!cloudSyncPath) return false;
    const mcDbPath = process.env.MC_DB_PATH || path.join(app.getPath('userData'), 'sanctuary.db');
    const cloudDbPath = path.join(cloudSyncPath, 'win-unpacked', 'sanctuary.db');
    if (fs.existsSync(mcDbPath)) {
      // WAL 模式下 copyFileSync 对 SQLite 安全（快照副本）
      fs.copyFileSync(mcDbPath, cloudDbPath);
      safeLog('MC 记忆数据库已同步到云同步路径');
      return true;
    }
  } catch (e) {
    safeError('同步 MC 数据库失败:', e.message);
  }
  return false;
}

// 从百度网盘恢复 MC 记忆数据库（启动时/手动触发）
function restoreMCDbFromCloud() {
  try {
    const cloudSyncPath = getCloudSyncPath();
    if (!cloudSyncPath) return false;
    const cloudDbPath = path.join(cloudSyncPath, 'win-unpacked', 'sanctuary.db');
    if (!fs.existsSync(cloudDbPath)) return false;
    const mcDbPath = process.env.MC_DB_PATH || path.join(app.getPath('userData'), 'sanctuary.db');
    // 如果云端的比本地新，才恢复
    const cloudStat = fs.statSync(cloudDbPath);
    if (fs.existsSync(mcDbPath)) {
      const localStat = fs.statSync(mcDbPath);
      if (cloudStat.mtimeMs <= localStat.mtimeMs) return false;  // 云端没更新
    }
    fs.copyFileSync(cloudDbPath, mcDbPath);
    safeLog('MC 记忆数据库已从云同步恢复（云端更新）');
    return true;
  } catch (e) {
    safeError('恢复 MC 数据库失败:', e.message);
  }
  return false;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: true,
    icon: getAppIcon(),
    minWidth: 1080,
    minHeight: 650,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // ★ 启动时不自动弹出主界面，仅在托盘常驻；用户点击托盘图标或快捷键时再显示
  mainWindow.webContents.on('did-finish-load', () => {
    // 默认保持隐藏（show:false），不调用 show()，避免开机/重启时自动打开窗口
  });

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('show', () => {
    mainWindow.setSkipTaskbar(false);
  });

  mainWindow.on('hide', () => {
    mainWindow.setSkipTaskbar(true);
  });

  // ★ 主窗口获得焦点时取消任务栏闪烁（提醒触发 flashFrame 后用户点开窗口即停止）
  mainWindow.on('focus', () => {
    try {
      mainWindow.flashFrame(false);
    } catch (e) {
      safeLog('[提醒] 取消任务栏闪烁失败: ' + e.message);
    }
  });
}

function getAppIcon() {
  try {
    const fs = require('fs');
    const iconPath = path.join(process.resourcesPath, 'Elysia.ico');
    if (fs.existsSync(iconPath)) {
      let icon = nativeImage.createFromPath(iconPath);
      if (IS_TEST_VERSION && icon && !icon.isEmpty()) {
        icon = grayscaleImage(icon);
      }
      return icon;
    }
  } catch (e) {
    safeError('getAppIcon error:', e);
  }
  return undefined;
}

function cleanupResources() {
  if (checkInterval) clearTimeout(checkInterval);
  if (cleanupEmptyDirsInterval) clearInterval(cleanupEmptyDirsInterval);
  
  uIOhook.stop();
  
  reminderWindows.forEach(r => {
    if (r.window && !r.window.isDestroyed()) {
      try {
        r.window.close();
      } catch (e) {
        safeError('Error closing reminder window:', e);
      }
    }
  });
  reminderWindows = [];
  
  stickyNoteWindows.forEach(s => {
    if (s.window && !s.window.isDestroyed()) {
      try {
        s.window.close();
      } catch (e) {
        safeError('Error closing sticky note window:', e);
      }
    }
  });
  stickyNoteWindows = [];
  
  if (colorPickerWindow && !colorPickerWindow.isDestroyed()) {
    try {
      colorPickerWindow.close();
    } catch (e) {
      safeError('Error closing color picker window:', e);
    }
  }
  
  if (tray) {
    tray.destroy();
  }
}

function createTray() {
  let icon;
  try {
    const fs = require('fs');
    const iconPath = path.join(process.resourcesPath, 'Elysia.ico');
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    }
  } catch (e) {
    icon = nativeImage.createEmpty();
  }
  
  if (icon && !icon.isEmpty() && IS_TEST_VERSION) {
    icon = grayscaleImage(icon);
  }
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => toggleMainWindow()
    },
    {
      label: '新建快速任务',
      click: () => createQuickTask()
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        cleanupResources();
        app.exit();
      }
    }
  ]);

  tray.setToolTip('Elysia');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => toggleMainWindow());
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 200);
  }
}

function setupGlobalHotkeys() {
  uIOhook.on('keydown', (e) => {
    if (e.keycode === 56) {
      lastAltPressTime = Date.now();
    }
  });
  
  uIOhook.on('keyup', (e) => {
    if (e.keycode === 56) {
      const now = Date.now();
      if (now - lastAltPressTime < 400 && now - lastAltReleaseTime < 500) {
        toggleMainWindow();
      }
      lastAltReleaseTime = now;
    }
  });
  
  uIOhook.start();
}

function createQuickTask() {
  const quickWin = new BrowserWindow({
    width: 400,
    height: 260,
    modal: true,
    parent: mainWindow,
    frame: true,
    icon: getAppIcon(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  quickWin.loadFile('quick-task.html');
}

async function checkReminders() {
  const data = readData();
  const now = new Date();
  now.setSeconds(0, 0);
  let changed = false;

  for (const task of data.tasks) {
    if (task.completed) continue;
    
    if (task.reminderEnabled && !task.reminded) {
      const dueDate = new Date(task.endDate || task.dueDate);
      if (!isNaN(dueDate.getTime())) {
        dueDate.setSeconds(0, 0);
        const remindOffsetMinutes = task.remindOffset || 10;
        const remindTime = new Date(dueDate.getTime() - remindOffsetMinutes * 60 * 1000);
        const timeUntilRemind = remindTime - now;
        
        if (timeUntilRemind <= 1000 && timeUntilRemind > -60000) {
          showReminder(task);
          task.reminded = true;
          changed = true;
        }
      }
    }
    
    if (task.subtasks && Array.isArray(task.subtasks)) {
      for (const subtask of task.subtasks) {
        if (subtask.completed || !subtask.endDate) continue;
        
        const subDueDate = new Date(subtask.endDate);
        if (isNaN(subDueDate.getTime())) continue;
        subDueDate.setSeconds(0, 0);
        
        const remindOffsetMinutes = subtask.remindOffset || 10;
        const remindTime = new Date(subDueDate.getTime() - remindOffsetMinutes * 60 * 1000);
        const timeUntilRemind = remindTime - now;
        
        if (timeUntilRemind <= 1000 && timeUntilRemind > -60000) {
          const subtaskReminder = {
            id: 'subtask-' + subtask.id,
            title: '子任务: ' + subtask.title,
            description: task.title,
            parentTaskId: task.id,
            subtaskId: subtask.id
          };
          showReminder(subtaskReminder);
          subtask.reminded = true;
          changed = true;
        }
      }
    }
  }

  // ★ 批量写入：一次 writeData 代替之前 N 次，大幅减少同步 I/O
  if (changed) {
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
    }
  }
  
  // ★ 递归调度：用 setTimeout 代替 setInterval，防止并发叠加
  if (checkInterval) {
    checkInterval = setTimeout(() => checkReminders(), 30000);
  }
}

function showReminder(task) {
  const remindWin = new BrowserWindow({
    width: 320,
    height: 140,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    showInactive: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const display = require('electron').screen.getPrimaryDisplay();
  const x = display.workArea.width - 340;
  const y = display.workArea.height - 160;
  remindWin.setPosition(x, y);
  remindWin.setOpacity(0);

  remindWin.loadFile('reminder.html');
  remindWin.webContents.on('did-finish-load', () => {
    remindWin.webContents.send('show-reminder', task);
    setTimeout(() => {
      remindWin.setOpacity(1);
    }, 50);
  });

  ipcMain.once(`reminder-clicked-${task.id}`, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    fadeOutAndClose(task.id);
  });

  reminderWindows.push({ id: task.id, window: remindWin });

  setTimeout(() => {
    fadeOutAndClose(task.id);
  }, 8000);
}

function fadeOutAndClose(taskId) {
  const reminder = reminderWindows.find(r => String(r.id) === String(taskId));
  if (!reminder || !reminder.window || reminder.window.isDestroyed()) {
    return;
  }
  
  let opacity = 1;
  const fadeInterval = setInterval(() => {
    if (!reminder.window || reminder.window.isDestroyed()) {
      clearInterval(fadeInterval);
      return;
    }
    
    opacity -= 0.1;
    if (opacity <= 0) {
      clearInterval(fadeInterval);
      closeReminder(taskId);
    } else {
      reminder.window.setOpacity(opacity);
    }
  }, 50);
  
  reminder.fadeInterval = fadeInterval;
}

function closeReminder(taskId) {
  const index = reminderWindows.findIndex(r => String(r.id) === String(taskId));
  if (index !== -1) {
    const reminder = reminderWindows[index];
    
    if (reminder.fadeInterval) {
      clearInterval(reminder.fadeInterval);
      reminder.fadeInterval = null;
    }
    
    if (reminder.window && !reminder.window.isDestroyed()) {
      try {
        reminder.window.close();
      } catch (e) {
        safeError('Error closing reminder window:', e);
      }
    }
    
    reminderWindows.splice(index, 1);
  }
}

async function snoozeReminder(taskId) {
  closeReminder(taskId);
  const data = readData();
  const task = data.tasks.find(t => String(t.id) === String(taskId));
  if (task) {
    task.reminded = false;
    await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
    }
  }
}

function setupAutoLaunch() {
  const autoLauncher = new AutoLaunch({
    name: 'Elysia'
  });

  ipcMain.handle('get-auto-launch', async () => {
    return await autoLauncher.isEnabled();
  });

  ipcMain.handle('set-auto-launch', async (event, enabled) => {
    if (enabled) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
  });
}

function setupIpcHandlers() {
  ipcMain.handle('get-version-type', () => {
    return {
      isTest: IS_TEST_VERSION,
      version: getCurrentVersion(),
      type: IS_TEST_VERSION ? '测试版' : '正式版'
    };
  });

  // ★ 统一数据加载 — 一次读盘返回全部数据，避免启动时多次 IPC 读同一个文件
  ipcMain.handle('load-all-data', async () => {
    const data = await dataManager.readData(true);  // force fresh read
    // ★ 预热 data-service 同步缓存，避免后续 readData() 重复读盘
    readData();
    return {
      tasks: data.tasks || [],
      memos: data.memos || [],
      expenses: (data.expenses || []).map(e => ({
        ...e,
        amount: typeof e.amount === 'string' ? parseFloat(e.amount) || 0 : e.amount,
        type: (e.type === 0 || e.type === '0') ? 'expense' : (e.type === 1 || e.type === '1') ? 'income' : e.type
      })),
      budgets: data.budgets || [],
      categoryBudgets: (data.settings && data.settings.categoryBudgets) || data.categoryBudgets || [],
      secrets: data.secrets || [],
      journals: (data.journals || []).filter(j => isOwnedByUser(j, getCurrentUserId())),
      settings: data.settings || {},
      // 聊天数据
      chatHistory: data.chatHistory || [],
      chatHistoryStore: data.chatHistoryStore || {},
      chatRooms: data.chatRooms || [],
      chatHistoryLimit: data.chatHistoryLimit ?? 50,
      dailyTasks: data.dailyTasks || [],
    };
  });

  ipcMain.handle('get-tasks', async () => {
    const data = await dataManager.readData();
    return data.tasks;
  });
  
  ipcMain.handle('add-task', async (event, task) => {
    const data = await dataManager.readData();
    task.id = uuidv4();
    task.createdAt = new Date().toISOString();
    data.tasks.push(task);
    const writeResult = await dataManager.writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
    }
    return { success: writeResult.success, task: task, message: writeResult.message };
  });
  
  ipcMain.handle('update-task', async (event, taskId, updates) => {
    const taskData = { ...updates, id: taskId };
    const result = await updateData('task', taskData);
    if (result.writeResult.success) {
      sendToAllWindows('tasks-updated');
    }
    return { success: result.writeResult.success, task: taskData, message: result.writeResult.message };
  });

  ipcMain.handle('toggle-task-completed', async (event, taskId) => {
    const data = await dataManager.readData();
    const index = data.tasks.findIndex(t => String(t.id) === String(taskId));
    if (index !== -1) {
      data.tasks[index].completed = !data.tasks[index].completed;
      data.tasks[index].completedAt = data.tasks[index].completed ? new Date().toISOString() : null;
      data.tasks[index].progress = data.tasks[index].completed ? 'completed' : 'pending';
      const writeResult = await dataManager.writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
      if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks-updated');
      }
      return { success: writeResult.success, task: data.tasks[index], message: writeResult.message };
    }
    return { success: false, task: null, message: '未找到任务' };
  });

  ipcMain.handle('pin-task', async (event, taskId) => {
    const data = await dataManager.readData();
    const index = data.tasks.findIndex(t => String(t.id) === String(taskId));
    if (index !== -1) {
      data.tasks[index].pinned = !data.tasks[index].pinned;
      const writeResult = await dataManager.writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
      if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks-updated');
      }
      return { success: writeResult.success, task: data.tasks[index], message: writeResult.message };
    }
    return { success: false, task: null, message: '未找到任务' };
  });
  
  ipcMain.handle('delete-task', async (event, taskId) => {
    const data = readData();
    data.tasks = data.tasks.filter(t => String(t.id) !== String(taskId));
    // ★ 墓碑：记录已删除 id，确保删除跨同步传播
    data.deletedItems = data.deletedItems || {};
    (data.deletedItems.tasks = data.deletedItems.tasks || []).push(String(taskId));
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true, undefined, undefined, undefined, undefined, data.deletedItems);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
    }
    return { success: writeResult.success, message: writeResult.message };
  });

  ipcMain.handle('edit-task-from-reminder', (event, task) => {
    if (!task || !task.id) {
      safeError('Invalid task passed to edit-task-from-reminder');
      return;
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('edit-task', task);
    }
  });
  
  ipcMain.handle('open-task-detail', (event, task) => {
    if (!task || !task.id) {
      safeError('Invalid task passed to open-task-detail');
      return;
    }
    
    currentEditingTask = task;
    const detailWin = new BrowserWindow({
      width: 500,
      height: 600,
      modal: true,
      parent: mainWindow,
      icon: getAppIcon(),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      show: false
    });
    
    detailWin.once('ready-to-show', () => {
      detailWin.show();
    });
    
    detailWin.loadFile('detail.html');
    
    detailWin.on('closed', () => {
      currentEditingTask = null;
    });
  });
  
  ipcMain.handle('get-current-editing-task', () => {
    return currentEditingTask;
  });
  
  ipcMain.handle('clear-current-editing-task', () => {
    currentEditingTask = null;
  });
  
  ipcMain.handle('show-reminder', (event, task) => showReminder(task));
  ipcMain.handle('close-reminder', (event, taskId) => closeReminder(taskId));
  ipcMain.handle('snooze-reminder', (event, taskId) => snoozeReminder(taskId));
  ipcMain.handle('refresh-main', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
    }
  });

  // ── 每日任务 CRUD（直接读写 data.json，避免 writeData 丢弃 dailyTasks）──
  async function _readDailyTasks() {
    const data = readData();
    return data.dailyTasks || [];
  }
  async function _writeDailyTasks(dailyTasks) {
    const dataPath = getDataFilePath();
    // 等待写入锁释放（最多等 2 秒）
    const maxWait = 2000;
    const startWait = Date.now();
    while (global._elysiaWriteLock && (Date.now() - startWait) < maxWait) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (global._elysiaWriteLock) {
      console.error('[MC-daily] _writeDailyTasks 写入超时，锁未释放');
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
      console.error('[MC-daily] _writeDailyTasks 失败:', e.message);
      return false;
    } finally {
      global._elysiaWriteLock = false;
    }
  }

  ipcMain.handle('daily-tasks-get', async () => {
    try {
      return await _readDailyTasks();
    } catch (e) {
      console.error('[MC-daily] get failed:', e.message);
      return [];
    }
  });

  ipcMain.handle('daily-task-create', async (event, dailyTask) => {
    try {
      const list = await _readDailyTasks();
      const now = new Date().toISOString();
      dailyTask.id = dailyTask.id || uuidv4();
      dailyTask.createdAt = dailyTask.createdAt || now;
      dailyTask.completed = dailyTask.completed || false;
      dailyTask.dailyDate = dailyTask.dailyDate || now.slice(0, 10);
      list.push(dailyTask);
      const ok = await _writeDailyTasks(list);
      console.log('[MC-daily] create:', dailyTask.title, 'ok=', ok);
      return { success: ok, dailyTask };
    } catch (e) {
      console.error('[MC-daily] create failed:', e.message);
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle('daily-task-update', async (event, taskId, updates) => {
    try {
      const list = await _readDailyTasks();
      const idx = list.findIndex(dt => String(dt.id) === String(taskId));
      if (idx === -1) return { success: false, message: 'task not found' };
      Object.assign(list[idx], updates, { updatedAt: new Date().toISOString() });
      const ok = await _writeDailyTasks(list);
      return { success: ok, dailyTask: list[idx] };
    } catch (e) {
      console.error('[MC-daily] update failed:', e.message);
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle('daily-task-delete', async (event, taskId) => {
    try {
      const list = await _readDailyTasks();
      const filtered = list.filter(dt => String(dt.id) !== String(taskId));
      if (filtered.length === list.length) return { success: false, message: 'task not found' };
      const ok = await _writeDailyTasks(filtered);
      return { success: ok };
    } catch (e) {
      console.error('[MC-daily] delete failed:', e.message);
      return { success: false, message: e.message };
    }
  });
  
  ipcMain.handle('get-memos', async () => {
    const data = await dataManager.readData();
    return data.memos;
  });
  
  ipcMain.handle('save-memo', async (event, memo) => {
    const now = new Date().toISOString();
    if (!memo.id) {
      memo.id = uuidv4();
      memo.createdAt = now;
    }
    memo.lastModified = now;
    const result = await updateData('memo', memo);
    return { success: result.writeResult.success, memo: memo, message: result.writeResult.message };
  });
  
  ipcMain.handle('delete-memo', async (event, memoId) => {
    const result = await updateData('delete-memo', memoId);
    return { success: result.writeResult.success, message: result.writeResult.message };
  });
  
  ipcMain.handle('pin-memo', async (event, memoId) => {
    const data = readData();
    const index = data.memos.findIndex(m => String(m.id) === String(memoId));
    if (index !== -1) {
      data.memos[index].pinned = !data.memos[index].pinned;
      // ★ Bug B 修复：更新时间戳，防止元数据变更被云端旧版本覆盖
      const now = new Date().toISOString();
      data.memos[index].lastModified = now;
      data.memos[index].updatedAt = now;
      const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
      if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('memos-updated');
      }
      return { success: writeResult.success, memo: data.memos[index], message: writeResult.message };
    }
    return { success: false, memo: null, message: '未找到笔记' };
  });

  ipcMain.handle('toggle-private-memo', async (event, memoId) => {
    const data = readData();
    const index = data.memos.findIndex(m => String(m.id) === String(memoId));
    if (index !== -1) {
      data.memos[index].isPrivate = !data.memos[index].isPrivate;
      // ★ Bug B 修复：更新时间戳，防止元数据变更被云端旧版本覆盖
      const now = new Date().toISOString();
      data.memos[index].lastModified = now;
      data.memos[index].updatedAt = now;
      const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
      if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('memos-updated');
      }
      return { success: writeResult.success, memo: data.memos[index], message: writeResult.message };
    }
    return { success: false, memo: null, message: '未找到笔记' };
  });

  ipcMain.handle('save-memo-order', async (event, orderedMemos) => {
    const data = readData();
    // ★ Bug B 修复：排序变更也更新时间戳
    const now = new Date().toISOString();
    orderedMemos.forEach((memo, index) => {
      const existingMemo = data.memos.find(m => String(m.id) === String(memo.id));
      if (existingMemo) {
        existingMemo.order = index;
        existingMemo.lastModified = now;
        existingMemo.updatedAt = now;
      }
    });
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    return { success: writeResult.success, message: writeResult.message };
  });
  
  ipcMain.handle('refresh-memos', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memos-updated');
    }
  });

  ipcMain.handle('get-secrets', () => {
    const data = readData();
    return data.secrets || [];
  });

  ipcMain.handle('save-secret', async (event, secret) => {
    const data = readData();
    if (!data.secrets) {
      data.secrets = [];
    }
    
    const now = new Date().toISOString();
    
    if (secret.id) {
      const index = data.secrets.findIndex(s => String(s.id) === String(secret.id));
      if (index !== -1) {
        data.secrets[index] = { ...data.secrets[index], ...secret, updatedAt: now, lastAccessedAt: now };
      } else {
        secret.id = Date.now().toString();
        secret.createdAt = now;
        secret.updatedAt = now;
        secret.lastAccessedAt = now;
        data.secrets.push(secret);
      }
    } else {
      secret.id = Date.now().toString();
      secret.createdAt = now;
      secret.updatedAt = now;
      secret.lastAccessedAt = now;
      data.secrets.push(secret);
    }
    
    data.secrets.sort((a, b) => {
      const aAccess = a.lastAccessedAt || a.createdAt;
      const bAccess = b.lastAccessedAt || b.createdAt;
      return new Date(bAccess).getTime() - new Date(aAccess).getTime();
    });
    
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('secrets-updated');
    }
    return { success: writeResult.success, secret, message: writeResult.message };
  });

  ipcMain.handle('delete-secret', async (event, secretId) => {
    const data = readData();
    if (data.secrets) {
      data.secrets = data.secrets.filter(s => String(s.id) !== String(secretId));
      // ★ 墓碑：记录已删除 id
      data.deletedItems = data.deletedItems || {};
      (data.deletedItems.secrets = data.deletedItems.secrets || []).push(String(secretId));
      const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true, undefined, undefined, undefined, undefined, data.deletedItems);
      if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('secrets-updated');
      }
      return { success: writeResult.success, message: writeResult.message };
    }
    return { success: false, message: '未找到密钥数据' };
  });

  ipcMain.handle('download-txt', async (event, memoId) => {
    try {
      const data = readData();
      const memo = data.memos.find(m => String(m.id) === String(memoId));
      if (!memo) {
        return { success: false, error: '未找到笔记' };
      }

      const { dialog } = require('electron');
      const title = memo.title || '笔记';
      const content = `标题：${title}\n\n${memo.content || ''}`;
      
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存TXT文件',
        defaultPath: `${title}.txt`,
        filters: [{ name: 'TXT文件', extensions: ['txt'] }]
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      fs.writeFileSync(result.filePath, content, 'utf8');
      return { success: true };
    } catch (e) {
      console.error('下载TXT失败:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('download-docx', async (event, memoId) => {
    try {
      const data = readData();
      const memo = data.memos.find(m => String(m.id) === String(memoId));
      if (!memo) {
        return { success: false, error: '未找到笔记' };
      }

      const { dialog } = require('electron');
      const title = memo.title || '笔记';
      
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存DOCX文件',
        defaultPath: `${title}.docx`,
        filters: [{ name: 'DOCX文件', extensions: ['docx'] }]
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      const content = memo.content || '';
      const docxContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>${title}</w:t>
      </w:r>
    </w:p>
    <w:p/>
    <w:p>
      <w:r>
        <w:t>${content.replace(/\n/g, '</w:t></w:r></w:p><w:p><w:r><w:t>')}</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

      const JSZip = require('jszip');
      const zip = new JSZip();
      
      zip.file('word/document.xml', docxContent);
      zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
      zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
      zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
      zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`);
      zip.file('word/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1>
        <a:sysClr val="windowText"/>
      </a:dk1>
      <a:lt1>
        <a:sysClr val="window"/>
      </a:lt1>
      <a:dk2>
        <a:sysClr val="grayText"/>
      </a:dk2>
      <a:lt2>
        <a:sysClr val="gray125"/>
      </a:lt2>
      <a:accent1>
        <a:srgbClr val="4472C4"/>
      </a:accent1>
      <a:accent2>
        <a:srgbClr val="ED7D31"/>
      </a:accent2>
      <a:accent3>
        <a:srgbClr val="A5A5A5"/>
      </a:accent3>
      <a:accent4>
        <a:srgbClr val="FFC000"/>
      </a:accent4>
      <a:accent5>
        <a:srgbClr val="00B050"/>
      </a:accent5>
      <a:accent6>
        <a:srgbClr val="70AD47"/>
      </a:accent6>
      <a:hlink>
        <a:srgbClr val="0066CC"/>
      </a:hlink>
      <a:folHlink>
        <a:srgbClr val="0066CC"/>
      </a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface="微软雅黑"/>
        <a:cs typeface="Calibri"/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface="微软雅黑"/>
        <a:cs typeface="Calibri"/>
      </a:minorFont>
    </a:fontScheme>
    <a:formatScheme name="Office"/>
  </a:themeElements>
</a:theme>`);
      zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Microsoft Office Word</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant>
        <vt:lpstr>Document</vt:lpstr>
      </vt:variant>
      <vt:variant>
        <vt:i4>1</vt:i4>
      </vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="1" baseType="lpstr">
      <vt:lpstr>${title}</vt:lpstr>
    </vt:vector>
  </TitlesOfParts>
</Properties>`);
      zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${title}</dc:title>
  <dc:creator>Elysia</dc:creator>
  <cp:lastModifiedBy>Elysia</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      fs.writeFileSync(result.filePath, buffer);
      return { success: true };
    } catch (e) {
      console.error('下载DOCX失败:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-expenses', () => {
    const data = readData();
    return data.expenses;
  });

  ipcMain.handle('add-expense', async (event, expense) => {
    const data = readData();
    expense.id = uuidv4();
    expense.createdAt = new Date().toISOString();
    data.expenses.push(expense);
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
      mainWindow.webContents.send('expenses-updated');
    }
    return { success: writeResult.success, expense: expense, message: writeResult.message };
  });

  ipcMain.handle('delete-expense', async (event, expenseId) => {
    const data = readData();
    data.expenses = data.expenses.filter(e => String(e.id) !== String(expenseId));
    // ★ 墓碑：记录已删除 id
    data.deletedItems = data.deletedItems || {};
    (data.deletedItems.expenses = data.deletedItems.expenses || []).push(String(expenseId));
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true, undefined, undefined, undefined, undefined, data.deletedItems);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
      mainWindow.webContents.send('expenses-updated');
    }
    return { success: writeResult.success, message: writeResult.message };
  });

  ipcMain.handle('update-expense', async (event, expenseId, updates) => {
    const data = readData();
    const index = data.expenses.findIndex(e => String(e.id) === String(expenseId));
    if (index !== -1) {
      data.expenses[index] = { ...data.expenses[index], ...updates, updatedAt: new Date().toISOString() };
      const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
      if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks-updated');
        mainWindow.webContents.send('expenses-updated');
      }
      return { success: writeResult.success, expense: data.expenses[index], message: writeResult.message };
    }
    return { success: false, expense: null, message: '未找到收支记录' };
  });

  ipcMain.handle('save-expense', async (event, expense) => {
    const data = readData();
    const index = data.expenses.findIndex(e => String(e.id) === String(expense.id));
    
    if (index !== -1) {
      data.expenses[index] = { ...data.expenses[index], ...expense };
    } else {
      data.expenses.push(expense);
    }
    
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
      mainWindow.webContents.send('expenses-updated');
    }
    return { success: writeResult.success, expense: expense, message: writeResult.message };
  });

  ipcMain.handle('get-journals', () => {
    const data = readData();
    const currentUserId = getCurrentUserId();
    return (data.journals || []).filter(journal => isOwnedByUser(journal, currentUserId));
});

  ipcMain.handle('save-journal', async (event, journal) => {
    const currentUserId = getCurrentUserId();
    const data = readData();
    
    if (!data.journals) {
      data.journals = [];
    }
    
    const existingIndex = data.journals.findIndex(j => j.date === journal.date && (!j.userId || j.userId === currentUserId));
    if (existingIndex !== -1) {
      // ★ 创建者标签不可变：编辑时保留原 creator，忽略 journal 中的 creator
      const originalCreator = data.journals[existingIndex].creator;
      data.journals[existingIndex] = { ...data.journals[existingIndex], ...journal, userId: currentUserId, updatedAt: new Date().toISOString() };
      if (originalCreator !== undefined) {
        data.journals[existingIndex].creator = originalCreator;
      }
    } else {
      const newJournal = {
        ...journal,
        id: uuidv4(),
        userId: currentUserId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      data.journals.push(newJournal);
    }
    
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets || [], data.secrets || [], data.journals, true);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('journals-updated');
    }
    return { success: writeResult.success, journal: journal, message: writeResult.message };
  });

  ipcMain.handle('delete-journal', async (event, journalId) => {
    const data = readData();
    if (data.journals) {
      data.journals = data.journals.filter(j => String(j.id) !== String(journalId));
    }
    // ★ 墓碑：记录已删除 id
    data.deletedItems = data.deletedItems || {};
    (data.deletedItems.journals = data.deletedItems.journals || []).push(String(journalId));
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets || [], data.secrets || [], data.journals || [], true, undefined, undefined, undefined, undefined, data.deletedItems);
    if (writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('journals-updated');
    }
    return { success: writeResult.success, message: writeResult.message };
  });

  ipcMain.handle('check-cloud-update', async () => {
    try {
      const cloudSyncPath = getCloudSyncPath();
      
      if (!fs.existsSync(cloudSyncPath)) {
        return { 
          success: false, 
          message: '云同步路径不存在：' + cloudSyncPath,
          hasUpdate: false 
        };
      }

      const cloudVersion = getCloudVersion();
      const currentVersion = getCurrentVersion();
      
      return {
        success: true,
        currentVersion: currentVersion,
        cloudVersion: cloudVersion,
        hasUpdate: cloudVersion && cloudVersion !== currentVersion
      };
    } catch (e) {
      return { success: false, message: '检查更新失败：' + e.message, hasUpdate: false };
    }
  });

  ipcMain.handle('perform-update', async (event, updateSourcePath = null) => {
    try {
      const currentAppPath = getCurrentAppPath();
      
      let sourcePath = updateSourcePath;
      if (!sourcePath) {
        const settings = readData().settings || {};
        sourcePath = settings.updateSourcePath || path.join(getCloudSyncPath(), 'Elysia', 'win-unpacked', 'resources', 'app');
      }
      
      if (!fs.existsSync(sourcePath)) {
        return { success: false, message: '更新源路径不存在：' + sourcePath };
      }

      const filesToUpdate = [
        'app.js', 'styles.css', 'index.html', 'main.js', 
        'detail.css', 'detail.html', 'detail.js',
        'quick-task.css', 'quick-task.html', 'quick-task.js',
        'reminder.css', 'reminder.html', 'reminder.js',
        'sticky-note.css', 'sticky-note.html', 'sticky-note.js',
        'color-picker.html', 'color-picker-module.js',
        'package.json'
      ];

      let updatedCount = 0;
      let errors = [];

      for (const file of filesToUpdate) {
        const sourceFile = path.join(sourcePath, file);
        const targetFile = path.join(currentAppPath, 'resources', 'app', file);
        
        if (fs.existsSync(sourceFile)) {
          try {
            fs.copyFileSync(sourceFile, targetFile);
            updatedCount++;
          } catch (e) {
            errors.push(file + ': ' + e.message);
          }
        }
      }

      let message = `更新完成！已更新 ${updatedCount} 个文件。请重启应用以应用更改。`;
      if (errors.length > 0) {
        message += '\n警告：' + errors.join('; ');
      }

      return {
        success: true,
        message: message,
        updatedCount: updatedCount,
        needRestart: true
      };
    } catch (e) {
      return { success: false, message: '更新失败：' + e.message };
    }
  });

  ipcMain.handle('save-update-source-path', async (event, updateSourcePath) => {
    try {
      const currentData = readData();
      currentData.settings = currentData.settings || {};
      currentData.settings.updateSourcePath = updateSourcePath;
      
      await writeData(
        currentData.tasks,
        currentData.memos,
        currentData.expenses,
        currentData.budgets,
        currentData.settings,
        currentData.translationStats,
        currentData.categoryBudgets || [],
        currentData.secrets || [],
        currentData.journals || []
      );
      
      return { success: true, message: '更新源路径已保存' };
    } catch (e) {
      safeError('保存更新源路径失败:', e);
      return { success: false, message: '保存更新源路径失败: ' + e.message };
    }
  });

  ipcMain.handle('restart-app', async () => {
    try {
      app.relaunch();
      app.exit();
      return { success: true };
    } catch (e) {
      return { success: false, message: '重启失败：' + e.message };
    }
  });

  ipcMain.handle('cloud-version-upload', async () => {
    try {
      if (!cloudSync) {
        // 如果云同步未初始化，尝试使用保存的配置自动初始化
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const versionInfo = {
        version: getCurrentVersion(),
        uploadTime: new Date().toISOString()
      };
      
      const result = await cloudSync.uploadVersion(versionInfo);
      if (result.success) {
        return { success: true, message: '版本信息已上传到云端' };
      } else {
        return result;
      }
    } catch (e) {
      safeError('上传版本信息失败:', e);
      return { success: false, message: '上传版本信息失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-version-download', async () => {
    try {
      if (!cloudSync) {
        // 如果云同步未初始化，尝试使用保存的配置自动初始化
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const currentAppPath = getCurrentAppPath();
      const targetDir = path.join(currentAppPath, 'resources', 'app');
      
      const versionList = await cloudSync.getVersionList();
      if (!versionList.success) {
        return { success: false, message: '获取版本列表失败: ' + versionList.message };
      }
      
      if (versionList.data.length === 0) {
        return { success: false, message: '云端没有可用的版本' };
      }
      
      const latestVersion = versionList.data[0];
      
      const result = await cloudSync.downloadAppFiles(targetDir, latestVersion.id);
      
      if (result.success || result.downloadedCount > 0) {
        return { 
          success: true, 
          message: `已从云端下载版本 ${latestVersion.version}（${latestVersion.uploadTime}）的 ${result.downloadedCount}/${result.totalCount} 个文件。请重启应用以应用更改。`,
          needRestart: true
        };
      } else {
        return { success: false, message: '下载失败: ' + (result.errors.join('; ') || '未知错误') };
      }
    } catch (e) {
      safeError('从云端下载版本失败:', e);
      return { success: false, message: '从云端下载版本失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-version-list', async () => {
    try {
      if (!cloudSync) {
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const result = await cloudSync.getVersionList();
      return result;
    } catch (e) {
      safeError('获取云端版本列表失败:', e);
      return { success: false, message: '获取云端版本列表失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-version-download-by-id', async (event, versionId) => {
    try {
      if (!cloudSync) {
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const versionList = await cloudSync.getVersionList();
      if (!versionList.success) {
        return { success: false, message: '获取版本列表失败: ' + versionList.message };
      }
      
      const targetVersion = versionList.data.find(v => v.id === versionId);
      if (!targetVersion) {
        return { success: false, message: '未找到指定的版本' };
      }
      
      const currentAppPath = getCurrentAppPath();
      const targetDir = path.join(currentAppPath, 'resources', 'app');
      
      const result = await cloudSync.downloadAppFiles(targetDir, versionId, (progress) => {
        event.sender.send('cloud-app-download-progress', progress);
      });
      
      if (result.success || result.downloadedCount > 0) {
        return { 
          success: true, 
          message: `已从云端下载版本 ${targetVersion.version}（${targetVersion.uploadTime}）的 ${result.downloadedCount}/${result.totalCount} 个文件。请重启应用以应用更改。`,
          needRestart: true
        };
      } else {
        return { success: false, message: '下载失败: ' + (result.errors.join('; ') || '未知错误') };
      }
    } catch (e) {
      safeError('从云端下载指定版本失败:', e);
      return { success: false, message: '从云端下载指定版本失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-version-delete', async (event, versionId) => {
    try {
      if (!cloudSync) {
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const result = await cloudSync.deleteVersion(versionId, (progress) => {
        event.sender.send('cloud-version-delete-progress', progress);
      });
      return result;
    } catch (e) {
      safeError('删除云端版本失败:', e);
      return { success: false, message: '删除云端版本失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-version-check', async () => {
    try {
      if (!cloudSync) {
        // 如果云同步未初始化，尝试使用保存的配置自动初始化
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const result = await cloudSync.checkCloudVersion();
      if (result.success) {
        return { 
          success: true, 
          cloudVersion: result.data.version,
          localVersion: getCurrentVersion(),
          hasUpdate: result.data.version && result.data.version !== getCurrentVersion()
        };
      } else {
        return result;
      }
    } catch (e) {
      safeError('检查云端版本失败:', e);
      return { success: false, message: '检查云端版本失败: ' + e.message };
    }
  });

  // ★ Git 版：代码推送到 GitHub（含仓库元数据: 简介/主页/README）
  ipcMain.handle('cloud-app-upload', async (event, newVersion, newVersionNote, description, homepage, readmeContent, githubToken) => {
    try {
      const updateMgr = getUpdateManager();
      const currentAppPath = getCurrentAppPath();
      const sourceDir = path.join(currentAppPath, 'resources', 'app');

      // ── 1. 版本号 & package.json ──
      if (newVersion && newVersion.trim()) {
        const packageJsonPath = path.join(sourceDir, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          pkg.version = newVersion.trim();
          fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
          setCurrentVersion(newVersion.trim());
        }
      }

      // ── 2. README 内容更新 ──
      let readmeUpdated = false;
      if (readmeContent !== undefined && readmeContent !== null) {
        const readmePath = path.join(sourceDir, 'README.md');
        const existingContent = fs.existsSync(readmePath)
          ? fs.readFileSync(readmePath, 'utf-8')
          : '';
        if (readmeContent !== existingContent) {
          fs.writeFileSync(readmePath, readmeContent, 'utf-8');
          readmeUpdated = true;
        }
      }

      // ── 3. 提交与推送 ──
      const commitMsg = newVersionNote
        ? newVersionNote
        : `v${getCurrentVersion()} - 版本同步`;

      const result = await updateMgr.pushChanges(sourceDir, commitMsg);

      // ── 4. GitHub API 元数据 PATCH（简介 / 主页）──
      let metaResult = { updated: false, message: '' };
      const token = githubToken || '';
      const hasDesc = description && description.trim();
      const hasHome = homepage && homepage.trim();
      if (result.success && token && (hasDesc || hasHome)) {
        try {
          const owner = 'Achimboldi';
          const repo = 'Elysia-personal-assistant';
          // 净化字段：去除 GitHub API 不接受的控制字符（\n \r \t 等）
          const sanitize = (str) => String(str || '')
            .replace(/[\x00-\x1F\x7F]+/g, ' ')  // ASCII 控制字符 → 空格
            .replace(/\s+/g, ' ')              // 合并连续空白
            .trim();
          const patchBody = {};
          if (hasDesc) patchBody.description = sanitize(description).slice(0, 350); // GitHub 限制 350 字
          if (hasHome) patchBody.homepage = sanitize(homepage);

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);

          const apiResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(patchBody),
              signal: controller.signal,
            }
          );
          clearTimeout(timeoutId);

          if (apiResp.ok) {
            metaResult = {
              updated: true,
              message: '仓库简介/主页已更新。',
            };
          } else if (apiResp.status === 401 || apiResp.status === 403) {
            metaResult = {
              updated: false,
              message: '⚠️ GitHub Token 认证失败（401/403），请检查 Token 是否有效且具有 repo 权限。代码已成功推送。',
            };
          } else {
            const errText = await apiResp.text().catch(() => '');
            metaResult = {
              updated: false,
              message: `⚠️ 仓库元数据更新失败 (${apiResp.status}): ${errText.slice(0, 200)}。代码已成功推送。`,
            };
          }
        } catch (fetchErr) {
          if (fetchErr.name === 'AbortError') {
            metaResult = { updated: false, message: '⚠️ GitHub API 请求超时（15秒），元数据未更新。代码已成功推送。' };
          } else {
            metaResult = { updated: false, message: `⚠️ GitHub API 网络错误: ${fetchErr.message}。代码已成功推送。` };
          }
        }
      } else if (result.success && !token && (description || homepage)) {
        metaResult = {
          updated: false,
          message: '⚠️ 未配置 GitHub Token，跳过仓库元数据更新。代码已成功推送。',
        };
      }

      // 将元数据更新结果附加到返回消息
      if (result.success && metaResult.message) {
        result.message = result.message + '\n' + metaResult.message;
      }
      result.metaUpdated = metaResult.updated;

      return result;
    } catch (e) {
      safeError('代码同步失败:', e);
      return { success: false, message: '代码同步失败: ' + e.message };
    }
  });

  // ★ Git 版：检查远程更新
  ipcMain.handle('incremental-update-check', async (event) => {
    try {
      const updateMgr = getUpdateManager();
      const currentAppPath = getCurrentAppPath();
      const targetDir = path.join(currentAppPath, 'resources', 'app');

      const result = await updateMgr.checkForUpdate(getCurrentVersion(), targetDir);

      return result;
    } catch (e) {
      safeError('检查更新失败:', e);
      return { success: false, message: '检查更新失败: ' + e.message };
    }
  });

  // ★ Git 版：执行代码更新（git pull）
  ipcMain.handle('incremental-update-perform', async (event, versionId = null) => {
    try {
      const updateMgr = getUpdateManager();
      const currentAppPath = getCurrentAppPath();
      const targetDir = path.join(currentAppPath, 'resources', 'app');

      const result = await updateMgr.performIncrementalUpdate(targetDir, versionId, (progress) => {
        event.sender.send('incremental-update-progress', progress);
      });

      return result;
    } catch (e) {
      safeError('执行更新失败:', e);
      return { success: false, message: '执行更新失败: ' + e.message };
    }
  });

  // ★ Git 版：推送代码到 GitHub
  ipcMain.handle('incremental-update-create-manifest', async (event) => {
    try {
      const updateMgr = getUpdateManager();
      const currentAppPath = getCurrentAppPath();
      const sourceDir = path.join(currentAppPath, 'resources', 'app');

      const result = await updateMgr.pushChanges(sourceDir, '更新代码版本');
      return result;
    } catch (e) {
      safeError('代码同步失败:', e);
      return { success: false, message: '代码同步失败: ' + e.message };
    }
  });

  ipcMain.handle('sync-to-cloud', async () => {
    try {
      if (!cloudSync) {
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          safeLog('云同步配置未完成，仅进行本地同步');
          const localResult = syncDataToCloud();
          syncMCDbToCloud();
          return {
            success: localResult,
            message: localResult ? '数据已同步到本地云盘目录（未配置云端同步）' : '同步失败'
          };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }

      // 确保每次同步前 cloudSync 实例使用当前用户ID
      cloudSync.setUserId(getCurrentUserId());

      // ★ 防御性保障：通知前端将内存中所有未保存的聊天记录刷入磁盘
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('flush-chat-history');
        // 等待 300ms 让前端完成异步写入
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // ★ 强制从磁盘重新读取数据（绕过缓存），确保包含最新聊天记录
      const currentData = readData(true);
      
      // ★ 诊断日志：确认 chatHistoryStore 是否有数据
      const storeKeys = Object.keys(currentData.chatHistoryStore || {});
      let totalMsgs = 0;
      for (const k of storeKeys) totalMsgs += (currentData.chatHistoryStore[k] || []).length;
      console.log(`[CloudSync-Upload] chatHistoryStore: ${storeKeys.length} 个会话, 共 ${totalMsgs} 条消息`);
      const dataToSync = {
        tasks: currentData.tasks || [],
        memos: currentData.memos || [],
        expenses: currentData.expenses || [],
        budgets: currentData.budgets || [],
        categoryBudgets: currentData.categoryBudgets || [],
        secrets: currentData.secrets || [],
        journals: currentData.journals || [],
        settings: currentData.settings || {},
        translationStats: currentData.translationStats || {},
        chatHistory: currentData.chatHistory || [],
        chatRooms: currentData.chatRooms || [],
        chatHistoryStore: currentData.chatHistoryStore || {},
        chatHistoryLimit: currentData.chatHistoryLimit ?? 50,
        deletedItems: currentData.deletedItems || {}
      };

      // ★ 墓碑调解：如果上传数据中包含某个聊天室，则清除该聊天室的墓碑
      // 防止云端同时存在一个房间和它的墓碑（导致下载端误删）
      const uploadRoomIds = new Set((dataToSync.chatRooms || []).map(r => String(r.id || '')));
      if (uploadRoomIds.size > 0 && dataToSync.deletedItems && Array.isArray(dataToSync.deletedItems.chatRooms)) {
        const reconciled = dataToSync.deletedItems.chatRooms.filter(id => !uploadRoomIds.has(String(id)));
        if (reconciled.length !== dataToSync.deletedItems.chatRooms.length) {
          console.log(`[CloudSync-Upload] 墓碑调解：清理了 ${dataToSync.deletedItems.chatRooms.length - reconciled.length} 个过期聊天室墓碑`);
          dataToSync.deletedItems = { ...dataToSync.deletedItems, chatRooms: reconciled };
          // 持久化调解后的墓碑
          const writeResult = await writeData(
            currentData.tasks, currentData.memos, currentData.expenses, currentData.budgets,
            currentData.settings, currentData.translationStats, currentData.categoryBudgets || [],
            currentData.secrets || [], currentData.journals || [],
            false, currentData.chatHistory, currentData.chatRooms, currentData.chatHistoryStore,
            currentData.chatHistoryLimit, dataToSync.deletedItems
          );
        }
      }

      const cloudResult = await cloudSync.syncData(dataToSync);

      if (cloudResult.success) {
        const localResult = syncDataToCloud();
        syncMCDbToCloud();
        return {
          success: true,
          message: localResult ? '数据已同步到云端和本地云盘目录' : '数据已同步到云端（本地同步失败）'
        };
      } else {
        safeLog('云端同步失败，尝试本地同步:', cloudResult.message);
        const localResult = syncDataToCloud();
        syncMCDbToCloud();
        return {
          success: localResult,
          message: localResult ? '云端同步失败，已备份到本地云盘目录: ' + cloudResult.message : '同步失败: ' + cloudResult.message
        };
      }
    } catch (e) {
      safeError('同步到云盘失败:', e);
      return {
        success: false,
        message: '同步失败: ' + e.message
      };
    }
  });

  ipcMain.handle('cloud-sync-init', async (event, config) => {
    try {
      cloudSync = new CloudSync();
      
      const currentData = readData();
      const settings = currentData.settings || {};
      const token = settings.cloudToken || '';
      const refreshToken = settings.cloudRefreshToken || '';
      const tokenExpireTime = settings.cloudTokenExpireTime || 0;
      const currentUserId = settings.cloudCurrentUserId || 'admin';
      
      cloudSync.setUserId(currentUserId);
      
      const initConfig = {
        ...config,
        token: token,
        refreshToken: refreshToken,
        tokenExpireTime: tokenExpireTime,
        onTokenUpdate: async (tokenData) => {
          const currentData = readData();
          currentData.settings = currentData.settings || {};
          currentData.settings.cloudToken = tokenData.token;
          currentData.settings.cloudRefreshToken = tokenData.refreshToken;
          currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
          await writeData(
            currentData.tasks,
            currentData.memos,
            currentData.expenses,
            currentData.budgets,
            currentData.settings,
            currentData.translationStats,
            currentData.categoryBudgets || [],
            currentData.secrets || [],
            currentData.journals || []
          );
        }
      };
      
      await cloudSync.init(initConfig);
      return { success: true, message: '云同步初始化成功' };
    } catch (e) {
      safeError('云同步初始化失败:', e);
      return { success: false, message: '云同步初始化失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-upload', async () => {
    try {
      const currentUserId = getCurrentUserId();
      
      if (!cloudSync) {
        // 如果云同步未初始化，尝试使用保存的配置自动初始化
        const data = readData();
        const settings = data.settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }

      // 确保每次同步前 cloudSync 实例使用当前用户ID
      cloudSync.setUserId(currentUserId);

      // ★ 防御性保障：通知前端将内存中所有未保存的聊天记录刷入磁盘
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('flush-chat-history');
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // ★ 强制从磁盘重新读取数据（绕过缓存），确保包含最新聊天记录
      let currentData = readData(true);

      currentData.settings = currentData.settings || {};
      currentData.settings.dataLastModified = Date.now();
      const lastUpdated = new Date().toISOString();
      currentData.settings.lastUpdated = lastUpdated;
      
      await writeData(
        currentData.tasks,
        currentData.memos,
        currentData.expenses,
        currentData.budgets,
        currentData.settings,
        currentData.translationStats,
        currentData.categoryBudgets || [],
        currentData.secrets || [],
        currentData.journals || [],
        true,
        currentData.chatHistory || [],
        currentData.chatRooms || [],
        currentData.chatHistoryStore || {},
        currentData.chatHistoryLimit ?? 50,
        currentData.deletedItems // ★ 上传时一并写入墓碑集合，防止任何路径清空已删除标记
      );
      
      // ★ 强制从磁盘重读，确保包含刚刚写入的 lastUpdated
      currentData = readData(true);
      currentData.lastUpdated = lastUpdated;
      const result = await cloudSync.syncData(currentData);
      
      if (result.success) {
        return { success: true, message: '数据已上传到云端' };
      } else {
        return result;
      }
    } catch (e) {
      safeError('云端上传失败:', e);
      return { success: false, message: '云端上传失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-download', async () => {
    try {
      if (!cloudSync) {
        // 如果云同步未初始化，尝试使用保存的配置自动初始化
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        const currentUserId = settings.cloudCurrentUserId || 'admin';
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(currentUserId);
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }

      // 确保每次同步前 cloudSync 实例使用当前用户ID
      cloudSync.setUserId(getCurrentUserId());

      const result = await cloudSync.fetchData();

      if (result.success) {
        let cloudData = result.data;
        cloudData = filterCloudDataByUser(cloudData);

        const localData = readData();
        
        const cloudLastUpdated = cloudData.lastUpdated || cloudData.settings?.lastUpdated;
        const localLastUpdated = localData.lastUpdated || localData.settings?.lastUpdated;

        console.log('[CloudSync] 云端更新时间:', cloudLastUpdated);
        console.log('[CloudSync] 本地更新时间:', localLastUpdated);

        // 手动下载始终执行合并（mergeItems 会保留本地独有数据，不会丢失）
        const mergedSettings = {
          ...localData.settings,
          ...cloudData.settings,
          cloudAppId: localData.settings?.cloudAppId || '',
          cloudAppKey: localData.settings?.cloudAppKey || '',
          cloudAppSecret: localData.settings?.cloudAppSecret || '',
          cloudToken: localData.settings?.cloudToken || '',
          cloudRefreshToken: localData.settings?.cloudRefreshToken || '',
          cloudTokenExpireTime: localData.settings?.cloudTokenExpireTime || 0,
          backgroundImage: localData.settings?.backgroundImage || '',
          themeMode: localData.settings?.themeMode || '',
          cardOpacity: localData.settings?.cardOpacity || '',
          fontSize: localData.settings?.fontSize || '',
          darkBackground: localData.settings?.darkBackground || '',
          lightBackground: localData.settings?.lightBackground || '',
          // 昔涟 AI 配置：本地有值优先本地（安全），本地无值时取云端（新设备首次下载）
          aiProvider: localData.settings?.aiProvider || cloudData.settings?.aiProvider || '',
          aiApiKey: localData.settings?.aiApiKey || cloudData.settings?.aiApiKey || '',
          aiBaseUrl: localData.settings?.aiBaseUrl || cloudData.settings?.aiBaseUrl || '',
          aiModel: localData.settings?.aiModel || cloudData.settings?.aiModel || 'deepseek-v4-flash',
          aiAgentName: localData.settings?.aiAgentName || cloudData.settings?.aiAgentName || '',
          aiSystemPrompt: localData.settings?.aiSystemPrompt || cloudData.settings?.aiSystemPrompt || '',
          aiContextRounds: localData.settings?.aiContextRounds || cloudData.settings?.aiContextRounds || 10,
          aiTemperature: localData.settings?.aiTemperature ?? cloudData.settings?.aiTemperature ?? 1.0,
          aiStreamEnabled: localData.settings?.aiStreamEnabled !== undefined ? localData.settings.aiStreamEnabled : (cloudData.settings?.aiStreamEnabled !== undefined ? cloudData.settings.aiStreamEnabled : true),
          aiDeleteConfirmEnabled: localData.settings?.aiDeleteConfirmEnabled !== undefined ? localData.settings.aiDeleteConfirmEnabled : (cloudData.settings?.aiDeleteConfirmEnabled !== undefined ? cloudData.settings.aiDeleteConfirmEnabled : false),
          aiOperationLogEnabled: localData.settings?.aiOperationLogEnabled || cloudData.settings?.aiOperationLogEnabled || false,
          aiMaxToolRounds: localData.settings?.aiMaxToolRounds || cloudData.settings?.aiMaxToolRounds || 30,  // ★ P2-1
          aiUserName: localData.settings?.aiUserName || cloudData.settings?.aiUserName || '',
          // ★ 头像：云端优先（头像属于共享身份，应跨设备一致；云端为空时才保留本地，避免"变回默认"）
          aiUserAvatar: cloudData.settings?.aiUserAvatar || localData.settings?.aiUserAvatar || '',
          aiAgentAvatar: cloudData.settings?.aiAgentAvatar || localData.settings?.aiAgentAvatar || '',
          aiPresets: mergePresetLists(cloudData.settings?.aiPresets || [], localData.settings?.aiPresets || []),
          aiCurrentPresetId: localData.settings?.aiCurrentPresetId || cloudData.settings?.aiCurrentPresetId || '',
          autoSyncEnabled: localData.settings?.autoSyncEnabled || false,
          autoSyncInterval: localData.settings?.autoSyncInterval || 10,
          cloudCurrentUserId: localData.settings?.cloudCurrentUserId || 'admin',
          lastUpdated: cloudLastUpdated || new Date().toISOString()
        };
        
        // 诊断日志：确认预设数据来源
        const cloudPresetsLen = (cloudData.settings?.aiPresets || []).length;
        const localPresetsLen = (localData.settings?.aiPresets || []).length;
        const diagMsg = `预设诊断: 云端=${cloudPresetsLen}个, 本地=${localPresetsLen}个, 最终=${mergedSettings.aiPresets.length}个`;
        console.log('[CloudSync] ' + diagMsg);
        if (cloudPresetsLen > 0) {
          console.log('[CloudSync] 云端预设详情:', JSON.stringify(cloudData.settings.aiPresets.map(p => ({ id: p.id, name: p.name }))));
        }
        
        const processedExpenses = (cloudData.expenses || []).map(expense => ({
          ...expense,
          amount: typeof expense.amount === 'string' ? parseFloat(expense.amount) || 0 : expense.amount
        }));

        let mergedTasks = mergeItems(localData.tasks || [], cloudData.tasks || []);
        let mergedMemos = mergeItems(localData.memos || [], cloudData.memos || []);
        let mergedExpenses = mergeItems(localData.expenses || [], processedExpenses);
        
        let cloudCategoryBudgets = cloudData.categoryBudgets || [];
        if (cloudData.budgets && Array.isArray(cloudData.budgets)) {
          cloudData.budgets.forEach(budget => {
            if (budget.categoryBudgets && Array.isArray(budget.categoryBudgets)) {
              budget.categoryBudgets.forEach(catBudget => {
                const catBudgetWithBudgetId = { ...catBudget, budgetId: budget.id };
                cloudCategoryBudgets.push(catBudgetWithBudgetId);
              });
            }
          });
        }
        
        let mergedBudgets = mergeItems(localData.budgets || [], cloudData.budgets || []);
        let mergedCategoryBudgets = mergeItems(localData.categoryBudgets || [], cloudCategoryBudgets);
        let mergedSecrets = mergeItems(localData.secrets || [], cloudData.secrets || []);
        let mergedJournals = mergeItems(localData.journals || [], cloudData.journals || []);
        const mergedChatHistory = mergeItems(localData.chatHistory || [], cloudData.chatHistory || []);

        // ★ 墓碑：剔除双端已删除的条目，删除集合一并回传云端
        const _tombMerged = applyDeletionTombstones(
          {
            tasks: mergedTasks, memos: mergedMemos, expenses: mergedExpenses,
            budgets: mergedBudgets, categoryBudgets: mergedCategoryBudgets,
            secrets: mergedSecrets, journals: mergedJournals
          },
          localData, cloudData
        );
        mergedTasks = _tombMerged.tasks;
        mergedMemos = _tombMerged.memos;
        mergedExpenses = _tombMerged.expenses;
        mergedBudgets = _tombMerged.budgets;
        mergedCategoryBudgets = _tombMerged.categoryBudgets;
        mergedSecrets = _tombMerged.secrets;
        mergedJournals = _tombMerged.journals;
        const mergedDeletedItems = _tombMerged.deletedItems;
        
        // ★ 聊天室：使用 _mergeChatRoomsById 按时间戳合并（与自动同步路径一致）
        const mergedChatRooms = _mergeChatRoomsById(localData.chatRooms || [], cloudData.chatRooms || []);
        
        // ★ chatHistoryStore：使用 _mergeChatHistoryStore 深度合并（按消息 id 去重）
        // 原先的浅合并会导致本地共享 key 的消息被云端覆盖丢失
        const mergedChatHistoryStore = _mergeChatHistoryStore(localData.chatHistoryStore || {}, cloudData.chatHistoryStore || {});
        
        await writeData(
          mergedTasks,
          mergedMemos,
          mergedExpenses,
          mergedBudgets,
          mergedSettings,
          cloudData.translationStats || {},
          mergedCategoryBudgets,
          mergedSecrets,
          mergedJournals,
          false,
          mergedChatHistory,
          mergedChatRooms,              // ★ 第12个参数：聊天室
          mergedChatHistoryStore,       // ★ 第13个参数：聊天记录存储
          cloudData.chatHistoryLimit ?? 50,  // ★ 第14个参数：聊天记录上限
          mergedDeletedItems            // ★ 第15个参数：墓碑删除集合
        );
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tasks-updated');
          mainWindow.webContents.send('memos-updated');
          mainWindow.webContents.send('expenses-updated');
          mainWindow.webContents.send('secrets-updated');
          mainWindow.webContents.send('journals-updated');
          // ★ 通知前端刷新聊天记录
          mainWindow.webContents.send('chat-history-updated');
          mainWindow.webContents.send('chat-rooms-updated');
        }
        
        const mergedData = {
          tasks: mergedTasks,
          memos: mergedMemos,
          expenses: mergedExpenses,
          budgets: mergedBudgets,
          categoryBudgets: mergedCategoryBudgets,
          secrets: mergedSecrets,
          journals: mergedJournals,
          settings: mergedSettings,
          translationStats: cloudData.translationStats || {},
          chatHistory: mergedChatHistory,
          chatRooms: mergedChatRooms,              // ★ 加入聊天室
          chatHistoryStore: mergedChatHistoryStore,  // ★ 加入聊天记录存储
          chatHistoryLimit: cloudData.chatHistoryLimit ?? 50,  // ★ 保持云端上限
          deletedItems: mergedDeletedItems,           // ★ 墓碑删除集合
          lastUpdated: new Date().toISOString()
        };
        
        await cloudSync.syncData(mergedData);
        safeLog('[CloudSync] 下载后重新上传完成');
        
        return { 
          success: true, 
          message: '已从云端同步并合并数据。' + diagMsg,
          diag: { cloudPresets: cloudPresetsLen, localPresets: localPresetsLen, finalPresets: mergedSettings.aiPresets.length }
        };
      } else if (result.notFound) {
        return { success: false, message: '云端无数据，将使用本地数据' };
      } else {
        return result;
      }
    } catch (e) {
      safeError('云端下载失败:', e);
      return { success: false, message: '云端下载失败: ' + e.message };
    }
  });

  function mergeItems(localItems, cloudItems) {
    const itemMap = new Map();

    // 以云端数据为基准，先填充云端到 Map
    for (const item of cloudItems) {
      const id = String(item.id || JSON.stringify(item));
      itemMap.set(id, { ...item, source: 'cloud' });
    }

    // 对于双方都有的数据，取时间戳较新的那个
    for (const item of localItems) {
      const id = String(item.id || JSON.stringify(item));
      const cloudItem = itemMap.get(id);

      if (cloudItem) {
        const cloudUpdated = cloudItem.lastUpdated || cloudItem.updatedAt || cloudItem.createdAt;
        const localUpdated = item.lastUpdated || item.updatedAt || item.createdAt;

        if (cloudUpdated && localUpdated) {
          try {
            const cloudTime = new Date(cloudUpdated);
            const localTime = new Date(localUpdated);

            if (localTime.getTime() > cloudTime.getTime()) {
              itemMap.set(id, { ...item, source: 'local' });
            }
          } catch (e) {
            // 时间解析失败，保留云端
          }
        }
      }
      // 如果云端没有此项（已被删除），则不添加回 Map
    }

    return deduplicateItems(Array.from(itemMap.values()));
  }

  function deduplicateItems(items) {
    const seen = new Set();
    const result = [];

    for (const item of items) {
      const itemId = String(item.id || JSON.stringify(item));
      if (!seen.has(itemId)) {
        seen.add(itemId);
        result.push(item);
      }
    }

    return result;
  }

  // ★ 墓碑机制：合并时丢弃对方已删除的条目，并合并两端的删除集合
  // 这样删除会在双端、所有板块正确传播，不再被"重新下载"
  function applyDeletionTombstones(mergedData, localData, cloudData) {
    const collections = ['tasks', 'memos', 'expenses', 'budgets', 'categoryBudgets', 'secrets', 'journals', 'chatRooms'];
    const localDeleted = (localData && localData.deletedItems) || {};
    const cloudDeleted = (cloudData && cloudData.deletedItems) || {};
    const combined = {};

    collections.forEach(c => {
      const set = new Set();
      (localDeleted[c] || []).forEach(id => set.add(String(id)));
      (cloudDeleted[c] || []).forEach(id => set.add(String(id)));

      if (mergedData[c] && Array.isArray(mergedData[c])) {
        if (c === 'chatRooms') {
          // ★ 聊天室调解：只有双方都有的房间才认为墓碑过期
          // （双方都有 = 不可能被任一方删除过 = 墓碑是历史残留）
          // 只在一端有的房间，墓碑有效——另一端已删除
          const localIds = new Set((localData[c] || []).map(item => String(item.id)));
          const cloudIds = new Set((cloudData[c] || []).map(item => String(item.id)));
          const bothHave = new Set([...localIds].filter(id => cloudIds.has(id)));
          const effectiveSet = new Set([...set].filter(id => !bothHave.has(id)));
          mergedData[c] = mergedData[c].filter(item => !effectiveSet.has(String(item.id)));
          combined[c] = Array.from(effectiveSet);
        } else {
          // 其他集合：删除优先（墓碑始终生效）
          mergedData[c] = mergedData[c].filter(item => !set.has(String(item.id)));
          combined[c] = Array.from(set);
        }
      } else {
        combined[c] = Array.from(set);
      }
    });

    // 清理已删除聊天室对应的聊天历史记录
    const deletedRoomIds = combined.chatRooms || [];
    if (deletedRoomIds.length > 0 && mergedData.chatHistoryStore && typeof mergedData.chatHistoryStore === 'object') {
      for (const roomId of deletedRoomIds) {
        const key = `room:${roomId}`;
        delete mergedData.chatHistoryStore[key];
      }
    }

    mergedData.deletedItems = combined;
    return mergedData;
  }

  function filterCloudDataByUser(cloudData) {
    const currentUserId = getCurrentUserId();
    const collections = ['tasks', 'memos', 'expenses', 'budgets', 'categoryBudgets', 'secrets', 'journals'];
    const filteredData = { ...cloudData };
    let totalFiltered = 0;

    for (const collection of collections) {
      if (filteredData[collection] && Array.isArray(filteredData[collection])) {
        const beforeCount = filteredData[collection].length;
        filteredData[collection] = filteredData[collection].filter(item => isOwnedByUser(item, currentUserId));
        totalFiltered += (beforeCount - filteredData[collection].length);
      }
    }

    if (totalFiltered > 0) {
      safeLog(`[CloudSync] 已过滤 ${totalFiltered} 条其他用户数据，当前用户: ${currentUserId}`);
    }

    return filteredData;
  }

  ipcMain.handle('cloud-sync-auto', async () => {
    try {
      if (!cloudSync) {
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(getCurrentUserId());
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }

      // 确保每次同步前 cloudSync 实例使用当前用户ID
      cloudSync.setUserId(getCurrentUserId());

      // ★ 超时保护：30秒上限
      const _syncPromise = performAutoSync();
      const _timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('同步超时')), 30000));
      try {
        return await Promise.race([_syncPromise, _timeoutPromise]);
      } catch(e) { return { success: false, message: e.message }; };
    } catch (e) {
      safeError('自动同步失败:', e);
      return { success: false, message: '自动同步失败: ' + e.message };
    }
  });

  async function performAutoSync() {
    // ★ 强制从磁盘重读，确保包含最新的聊天记录和其他数据
    const localData = readData(true);
    const localTimestamp = localData.settings?.dataLastModified || localData.settings?.lastModified;
    const hasLocalSyncRecord = !!localTimestamp;
    const localLastModified = localTimestamp || 0;
    
    const hasLocalData = (localData.tasks?.length || 0) > 0 || 
                         (localData.memos?.length || 0) > 0 || 
                         (localData.expenses?.length || 0) > 0 || 
                         (localData.budgets?.length || 0) > 0 ||
                         (localData.secrets?.length || 0) > 0 ||
                         (localData.journals?.length || 0) > 0;
    
    safeLog(`[自动同步] 开始同步 - 本地数据时间戳: ${localLastModified}`);
    safeLog(`[自动同步] 本地是否有同步记录: ${hasLocalSyncRecord}`);
    safeLog(`[自动同步] 本地备忘录数量: ${localData.memos?.length || 0}`);
    safeLog(`[自动同步] 本地是否有数据: ${hasLocalData}`);
    
    const cloudResult = await cloudSync.fetchData();

    if (!cloudResult.success) {
      if (cloudResult.notFound) {
        if (hasLocalData) {
          await cloudSync.syncData(localData);
          return { success: true, dataChanged: false, message: '云端无数据，已上传本地数据' };
        } else {
          safeLog('[自动同步] 本地无数据，跳过上传');
          return { success: true, dataChanged: false, message: '本地无数据，跳过同步' };
        }
      }
      return cloudResult;
    }

    let cloudData = cloudResult.data;
    cloudData = filterCloudDataByUser(cloudData);
    let cloudLastModified = cloudData.lastUpdated || cloudData.syncTimestamp || cloudData.settings?.dataLastModified || cloudData.settings?.lastModified || 0;
    
    if (cloudLastModified === 0) {
      cloudLastModified = _extractLatestTimestampFromCloudData(cloudData);
    }
    
    safeLog(`[自动同步] 云端数据时间戳: ${cloudLastModified}`);
    safeLog(`[自动同步] 云端备忘录数量: ${cloudData.memos?.length || 0}`);
    
    const conflictResult = await resolveConflict(localData, cloudData, localLastModified, cloudLastModified, hasLocalSyncRecord);

    
    if (conflictResult.dataChanged) {
      // ★ 修复读写竞态：重新读取最新磁盘数据，把同步期间（网络往返）用户新保存的
      // 编辑/消息补回到合并结果，避免 writeData 用陈旧快照覆盖掉这些内容
      const freshLocal = readData(true);
      conflictResult.data = _reconcileWithFreshLocal(conflictResult.data, freshLocal);

      const newSettings = conflictResult.data.settings || {};
      newSettings.dataLastModified = Date.now();
      
      await writeData(
        conflictResult.data.tasks || [],
        conflictResult.data.memos || [],
        conflictResult.data.expenses || [],
        conflictResult.data.budgets || [],
        newSettings,
        conflictResult.data.translationStats || {},
        conflictResult.data.categoryBudgets || [],
        conflictResult.data.secrets || [],
        conflictResult.data.journals || [],
        true,
        conflictResult.data.chatHistory || [],
        conflictResult.data.chatRooms || [],
        conflictResult.data.chatHistoryStore || {},
        conflictResult.data.chatHistoryLimit ?? 50,
        conflictResult.data.deletedItems || {}   // ★ 墓碑：持久化合并后的删除集合
      );

      // ★ 修复：把已与本地最新数据调和后的结果重新上传云端，确保云端也包含同步期间新增的本地项
      try {
        await cloudSync.syncData(conflictResult.data);
      } catch (e) {
        safeError('[自动同步] 调和后上传云端失败（本地已保留）:', e);
      }
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks-updated');
        mainWindow.webContents.send('memos-updated');
        mainWindow.webContents.send('expenses-updated');
        mainWindow.webContents.send('secrets-updated');
        mainWindow.webContents.send('journals-updated');
      }
    }
    
    return conflictResult;
  }
  
  async function resolveConflict(localData, cloudData, localTime, cloudTime, hasLocalSyncRecord = true) {
    try {
        let mergedData = { ...localData };
        let dataChanged = false;
        const conflicts = [];
        const syncLog = [];

    const hasLocalData = (localData.tasks?.length || 0) > 0 ||
                         (localData.memos?.length || 0) > 0 ||
                         (localData.expenses?.length || 0) > 0 ||
                         (localData.budgets?.length || 0) > 0 ||
                         (localData.secrets?.length || 0) > 0 ||
                         (localData.journals?.length || 0) > 0;

    const hasCloudData = (cloudData.tasks?.length || 0) > 0 ||
                         (cloudData.memos?.length || 0) > 0 ||
                         (cloudData.expenses?.length || 0) > 0 ||
                         (cloudData.budgets?.length || 0) > 0 ||
                         (cloudData.secrets?.length || 0) > 0 ||
                         (cloudData.journals?.length || 0) > 0;

    const localLatestItemTime = _extractLatestTimestampFromCloudData(localData);
    const cloudLatestItemTime = _extractLatestTimestampFromCloudData(cloudData);
    const localNewer = localLatestItemTime > cloudLatestItemTime;

    safeLog(`同步判定: 本地时间=${localTime}, 云端时间=${cloudTime}`);
    safeLog(`同步判定: 本地数据最新项时间=${localLatestItemTime}, 云端数据最新项时间=${cloudLatestItemTime}`);
    safeLog(`同步判定: 本地有数据=${hasLocalData}, 云端有数据=${hasCloudData}`);
    safeLog(`同步判定: 本地有同步记录=${hasLocalSyncRecord}, 本地更新=${localNewer}`);

    if (!hasLocalData && hasCloudData) {
      safeLog('本地无数据，下载云端数据');
      syncLog.push({ type: 'download', reason: '本地无数据' });
      mergedData = await _downloadCloudData(localData, cloudData);
      // ★ 墓碑：即便本地无业务数据，也可能有本地删除标记需要传播
      mergedData = applyDeletionTombstones(mergedData, localData, cloudData);
      dataChanged = true;
      await backupDataVersion(mergedData, 'download');
    } else if (!hasCloudData && hasLocalData) {
      safeLog('云端无数据，上传本地数据');
      syncLog.push({ type: 'upload', reason: '云端无数据' });
      localData.settings = localData.settings || {};
      localData.settings.dataLastModified = Date.now();
      await backupDataVersion(localData, 'upload');
      await cloudSync.syncData(localData);
    } else if (!hasLocalData && !hasCloudData) {
      safeLog('双方都无数据，无需同步');
      syncLog.push({ type: 'none', reason: '双方都无数据' });
    } else {
      safeLog('双方都有数据，执行双向合并（逐项取较新版本）');
      syncLog.push({ type: 'merge', reason: '双向合并', localTime, cloudTime, localNewer });
      const mergeResult = await _mergeWithConflictDetection(localData, cloudData);
      mergedData = mergeResult.data;
      // ★ 墓碑：合并后剔除双端已删除的条目，删除集合一并上传
      mergedData = applyDeletionTombstones(mergedData, localData, cloudData);
      conflicts.push(...mergeResult.conflicts);

      const localHash = generateDataHash(localData);
      const mergedHash = generateDataHash(mergedData);
      const actualDataChanged = localHash !== mergedHash;

      mergedData.settings = mergedData.settings || {};
      mergedData.settings.dataLastModified = Date.now();
      dataChanged = actualDataChanged;

      if (actualDataChanged) {
        await backupDataVersion(mergedData, 'merge');
      }

      await cloudSync.syncData(mergedData);
      safeLog('双向合并完成，已同步到云端');
    }

    mergedData.settings = mergedData.settings || {};
    mergedData.settings.lastModified = Date.now();
    mergedData.syncProtocolVersion = '1.0';
    mergedData.syncTimestamp = Date.now();

    await cleanupOldVersions();

    if (conflicts.length > 0) {
      safeLog(`[冲突检测] 检测到 ${conflicts.length} 个冲突`);
      _notifyConflict(conflicts);
    }

    _logSyncResult(syncLog, conflicts);

    return { success: true, dataChanged, data: mergedData, conflicts, syncLog };
    } catch (error) {
    safeError('resolveConflict 错误:', error);
    return { success: false, message: '同步过程发生错误: ' + (error.message || '未知错误'), dataChanged: false, data: localData, conflicts: [], syncLog: [{ type: 'error', reason: '同步过程发生错误: ' + (error.message || '未知错误') }] };
  }
  
  async function _downloadCloudData(localData, cloudData) {
    const filteredCloud = filterCloudDataByUser(cloudData);
    return {
      ...filteredCloud,
      tasks: filteredCloud.tasks || [],
      memos: filteredCloud.memos || [],
      expenses: filteredCloud.expenses || [],
      budgets: filteredCloud.budgets || [],
      categoryBudgets: filteredCloud.categoryBudgets || [],
      // ★ secrets 合并：云端优先覆盖同 id，本地独有保留
      secrets: mergeItemsWithConflictDetection(localData.secrets || [], filteredCloud.secrets || [], 'secret'),
      journals: mergeItemsWithConflictDetection(localData.journals || [], filteredCloud.journals || [], 'journal'),
      settings: mergeSettings(localData.settings || {}, filteredCloud.settings || {}),
      translationStats: localData.translationStats || {},
      chatHistory: mergeItems(localData.chatHistory || [], filteredCloud.chatHistory || []),
      // ★ 聊天室 & 聊天记录：合并本地和云端，防止覆盖丢失
      chatRooms: _mergeChatRoomsById(localData.chatRooms || [], filteredCloud.chatRooms || []),
      chatHistoryStore: _mergeChatHistoryStore(localData.chatHistoryStore || {}, filteredCloud.chatHistoryStore || {}),
      chatHistoryLimit: localData.chatHistoryLimit ?? filteredCloud.chatHistoryLimit ?? 50
    };
  }
  
  async function _mergeCloudPriority(localData, cloudData) {
    return {
      ...cloudData,
      tasks: mergeItemsWithConflictDetection(localData.tasks || [], cloudData.tasks || [], 'task'),
      memos: mergeItemsWithConflictDetection(localData.memos || [], cloudData.memos || [], 'memo'),
      expenses: mergeItemsWithConflictDetection(localData.expenses || [], cloudData.expenses || [], 'expense'),
      budgets: mergeItemsWithConflictDetection(localData.budgets || [], cloudData.budgets || [], 'budget'),
      categoryBudgets: mergeItemsWithConflictDetection(localData.categoryBudgets || [], cloudData.categoryBudgets || [], 'categoryBudget'),
      secrets: mergeItemsWithConflictDetection(localData.secrets || [], cloudData.secrets || [], 'secret'),
      journals: mergeItemsWithConflictDetection(localData.journals || [], cloudData.journals || [], 'journal'),
      settings: mergeSettings(localData.settings || {}, cloudData.settings || {}),
      chatHistory: mergeItems(localData.chatHistory || [], cloudData.chatHistory || []),
      // ★ 合并聊天室和聊天记录
      chatRooms: _mergeChatRoomsById(localData.chatRooms || [], cloudData.chatRooms || []),
      chatHistoryStore: _mergeChatHistoryStore(localData.chatHistoryStore || {}, cloudData.chatHistoryStore || {}),
      chatHistoryLimit: localData.chatHistoryLimit ?? cloudData.chatHistoryLimit ?? 50
    };
  }
  
  function _getItemLastModifiedTime(item) {
    if (!item) return 0;
    const candidates = [
      item.lastModified,
      item.lastUpdated,
      item.updatedAt,
      item.modifiedAt,
      item.createdAt
    ];
    let maxTime = 0;
    for (const t of candidates) {
      if (t) {
        const time = new Date(t).getTime();
        if (!isNaN(time) && time > maxTime) {
          maxTime = time;
        }
      }
    }
    return maxTime;
  }
  
  function _extractLatestTimestampFromCloudData(cloudData) {
    let latestTime = 0;
    const collections = ['tasks', 'memos', 'expenses', 'budgets', 'secrets', 'journals'];
    
    for (const collection of collections) {
      const items = cloudData[collection];
      if (items && Array.isArray(items)) {
        for (const item of items) {
          const itemTime = _getItemLastModifiedTime(item);
          if (itemTime > latestTime) {
            latestTime = itemTime;
          }
        }
      }
    }
    
    return latestTime;
  }
  
  async function _mergeWithConflictDetection(localData, cloudData) {
    const conflicts = [];
    
    const result = {
      ...localData,
      tasks: await _mergeCollectionWithConflict(localData.tasks || [], cloudData.tasks || [], 'task', conflicts),
      memos: await _mergeCollectionWithConflict(localData.memos || [], cloudData.memos || [], 'memo', conflicts),
      expenses: await _mergeCollectionWithConflict(localData.expenses || [], cloudData.expenses || [], 'expense', conflicts),
      budgets: await _mergeCollectionWithConflict(localData.budgets || [], cloudData.budgets || [], 'budget', conflicts),
      categoryBudgets: await _mergeCollectionWithConflict(localData.categoryBudgets || [], cloudData.categoryBudgets || [], 'categoryBudget', conflicts),
      secrets: await _mergeCollectionWithConflict(localData.secrets || [], cloudData.secrets || [], 'secret', conflicts),
      journals: await _mergeCollectionWithConflict(localData.journals || [], cloudData.journals || [], 'journal', conflicts),
      settings: mergeSettings(localData.settings || {}, cloudData.settings || {}),
      translationStats: localData.translationStats || {},
      chatHistory: mergeItems(localData.chatHistory || [], cloudData.chatHistory || []),
      // ★ 聊天室：按 id 合并，云端版本覆盖本地同 id，本地独有保留
      chatRooms: _mergeChatRoomsById(localData.chatRooms || [], cloudData.chatRooms || []),
      // ★ chatHistoryStore：深度合并（本地独有 key 保留，云端覆盖同 key）
      chatHistoryStore: _mergeChatHistoryStore(localData.chatHistoryStore || {}, cloudData.chatHistoryStore || {}),
      // ★ chatHistoryLimit：本地优先
      chatHistoryLimit: localData.chatHistoryLimit ?? cloudData.chatHistoryLimit ?? 50
    };
    
    return { data: result, conflicts };
  }
  
  async function _mergeCollectionWithConflict(localItems, cloudItems, type, conflicts) {
    const localMap = new Map(localItems.map(item => [item.id, item]));
    const cloudMap = new Map(cloudItems.map(item => [item.id, item]));
    const merged = [];
    const processedContentHashes = new Set();
    const changeSummary = { added: 0, updated: 0, deleted: 0, conflicts: 0 };

    for (const [id, cloudItem] of cloudMap) {
      const contentHash = generateContentHash(cloudItem);

      if (processedContentHashes.has(contentHash)) {
        safeLog(`[合并][${type}] ID ${id}: 内容重复，跳过`);
        continue;
      }

      if (localMap.has(id)) {
        const localItem = localMap.get(id);
        const localTime = _getItemLastModifiedTime(localItem);
        const cloudTime = _getItemLastModifiedTime(cloudItem);

        if (Math.abs(cloudTime - localTime) < 1000) {
          merged.push(localItem);
          processedContentHashes.add(generateContentHash(localItem));
          safeLog(`[合并][${type}] ID ${id}: 时间相近，优先保留本地数据`);
        } else if (cloudTime > localTime) {
          merged.push(cloudItem);
          processedContentHashes.add(contentHash);
          changeSummary.updated++;
          safeLog(`[合并][${type}] ID ${id}: 云端更新较新，使用云端数据`);
        } else {
          merged.push(localItem);
          processedContentHashes.add(generateContentHash(localItem));
          changeSummary.updated++;
          conflicts.push({
            id,
            type,
            local: localItem,
            cloud: cloudItem,
            resolved: true,
            resolution: 'local',
            reason: '本地更新较新'
          });
          safeLog(`[合并][${type}] ID ${id}: 检测到冲突，本地更新较新，已解决`);
        }
      } else {
        merged.push(cloudItem);
        processedContentHashes.add(contentHash);
        changeSummary.added++;
        safeLog(`[合并][${type}] ID ${id}: 云端独有，添加`);
      }
    }

    for (const [id, localItem] of localMap) {
      if (!cloudMap.has(id)) {
        const contentHash = generateContentHash(localItem);
        if (!processedContentHashes.has(contentHash)) {
          merged.push(localItem);
          processedContentHashes.add(contentHash);
          changeSummary.added++;
          safeLog(`[合并][${type}] ID ${id}: 本地独有，保留（新增数据）`);
        }
      }
    }

    safeLog(`[合并][${type}] 统计: 新增${changeSummary.added} 更新${changeSummary.updated} 删除${changeSummary.deleted} 冲突${changeSummary.conflicts}`);

    return merged;
  }
  
  function _notifyConflict(conflicts) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-conflict', {
        conflicts: conflicts.slice(0, 10),
        total: conflicts.length
      });
    }
  }
  
  function _logSyncResult(syncLog, conflicts) {
    const logStr = JSON.stringify({
      timestamp: Date.now(),
      actions: syncLog,
      conflictCount: conflicts.length,
      version: '1.0'
    }, null, 2);
    
    safeLog(`[同步结果] ${logStr}`);
  }
  
  async function _checkIncrementalChanges(localData, cloudData) {
    let hasChanges = false;
    const mergedData = { ...localData };
    const changeSummary = {
      total: 0,
      tasks: { added: 0, updated: 0, deleted: 0 },
      memos: { added: 0, updated: 0, deleted: 0 },
      expenses: { added: 0, updated: 0, deleted: 0 },
      budgets: { added: 0, updated: 0, deleted: 0 },
      secrets: { added: 0, updated: 0, deleted: 0 },
      journals: { added: 0, updated: 0, deleted: 0 }
    };
    
    const collections = ['tasks', 'memos', 'expenses', 'budgets', 'secrets', 'journals'];
    
    for (const collection of collections) {
      const localItems = localData[collection] || [];
      const cloudItems = cloudData[collection] || [];
      
      const localMap = new Map(localItems.map(item => [item.id, item]));
      const cloudMap = new Map(cloudItems.map(item => [item.id, item]));
      
      for (const [id, cloudItem] of cloudMap) {
        const localItem = localMap.get(id);
        
        if (!localItem) {
          changeSummary[collection].added++;
          changeSummary.total++;
          hasChanges = true;
          safeLog(`[增量][${collection}] ID ${id}: 云端新增`);
        } else {
          const cloudTime = _getItemLastModifiedTime(cloudItem);
          const localTime = _getItemLastModifiedTime(localItem);
          
          if (cloudTime > localTime) {
            changeSummary[collection].updated++;
            changeSummary.total++;
            hasChanges = true;
            safeLog(`[增量][${collection}] ID ${id}: 云端更新较新`);
          }
        }
      }
      
      for (const [id, localItem] of localMap) {
        if (!cloudMap.has(id)) {
          changeSummary[collection].deleted++;
          changeSummary.total++;
          hasChanges = true;
          safeLog(`[增量][${collection}] ID ${id}: 本地独有（可能已删除）`);
        }
      }
    }
    
    if (hasChanges) {
      safeLog(`[增量同步] 检测到 ${changeSummary.total} 个变更`);
      
      mergedData.tasks = mergeItemsWithConflictDetection(localData.tasks || [], cloudData.tasks || [], 'task');
      mergedData.memos = mergeItemsWithConflictDetection(localData.memos || [], cloudData.memos || [], 'memo');
      mergedData.expenses = mergeItemsWithConflictDetection(localData.expenses || [], cloudData.expenses || [], 'expense');
      mergedData.budgets = mergeItemsWithConflictDetection(localData.budgets || [], cloudData.budgets || [], 'budget');
      mergedData.secrets = mergeItemsWithConflictDetection(localData.secrets || [], cloudData.secrets || [], 'secret');
      mergedData.journals = mergeItemsWithConflictDetection(localData.journals || [], cloudData.journals || [], 'journal');
      mergedData.settings = mergeSettings(localData.settings || {}, cloudData.settings || {});
    }
    
    return { hasChanges, mergedData, changeSummary };
  }
  
  function mergeItemsWithConflictDetection(localItems, cloudItems, type) {
    const localMap = new Map();
    for (const item of localItems) {
      if (item.id) {
        localMap.set(item.id, item);
      }
    }
    
    const cloudMap = new Map();
    for (const item of cloudItems) {
      if (item.id) {
        cloudMap.set(item.id, item);
      }
    }
    
    const merged = [];
    const processedContentHashes = new Set();
    
    for (const [id, cloudItem] of cloudMap) {
      const contentHash = generateContentHash(cloudItem);
      
      if (processedContentHashes.has(contentHash)) {
        safeLog(`[合并][${type}] ID ${id}: 内容重复，跳过`);
        continue;
      }
      
      if (localMap.has(id)) {
        const localItem = localMap.get(id);
        const localTime = _getItemLastModifiedTime(localItem);
        const cloudTime = _getItemLastModifiedTime(cloudItem);
        
        if (cloudTime > localTime) {
          merged.push(cloudItem);
          processedContentHashes.add(contentHash);
          safeLog(`[合并][${type}] ID ${id}: 云端更新较新`);
        } else if (localTime > cloudTime) {
          merged.push(localItem);
          processedContentHashes.add(generateContentHash(localItem));
          safeLog(`[合并][${type}] ID ${id}: 本地更新较新`);
        } else {
          merged.push(localItem);
          processedContentHashes.add(generateContentHash(localItem));
          safeLog(`[合并][${type}] ID ${id}: 时间相近，优先保留本地数据`);
        }
      } else {
        merged.push(cloudItem);
        processedContentHashes.add(contentHash);
        safeLog(`[合并][${type}] ID ${id}: 云端独有，添加`);
      }
    }
    
    for (const [id, localItem] of localMap) {
      if (!cloudMap.has(id)) {
        const contentHash = generateContentHash(localItem);
        if (processedContentHashes.has(contentHash)) {
          safeLog(`[合并][${type}] ID ${id}: 本地独有但内容重复，跳过`);
          continue;
        }
        merged.push(localItem);
        processedContentHashes.add(contentHash);
        safeLog(`[合并][${type}] ID ${id}: 本地独有，保留（新增数据）`);
      }
    }

    return merged;
  }

  function mergeItems(localItems, cloudItems) {
    safeLog(`[mergeItems] 本地项数量: ${localItems.length}, 云端项数量: ${cloudItems.length}`);
    
    const localMap = new Map();
    const localItemsWithoutId = [];
    for (const item of localItems) {
      const id = item.id != null ? String(item.id) : null;
      if (id !== null && id !== '') {
        localMap.set(id, item);
      } else {
        localItemsWithoutId.push(item);
      }
    }
    
    const cloudMap = new Map();
    const cloudItemsWithoutId = [];
    for (const item of cloudItems) {
      const id = item.id != null ? String(item.id) : null;
      if (id !== null && id !== '') {
        cloudMap.set(id, item);
      } else {
        cloudItemsWithoutId.push(item);
      }
    }
    
    safeLog(`[mergeItems] 本地Map大小: ${localMap.size}, 云端Map大小: ${cloudMap.size}`);
    safeLog(`[mergeItems] 本地无ID项数量: ${localItemsWithoutId.length}, 云端无ID项数量: ${cloudItemsWithoutId.length}`);
    
    const merged = [];
    const processedIds = new Set();
    const processedContentHashes = new Set();
    
    for (const [id, cloudItem] of cloudMap) {
      processedIds.add(id);
      const contentHash = generateContentHash(cloudItem);
      
      if (processedContentHashes.has(contentHash)) {
        safeLog(`[mergeItems] ID ${id}: 内容重复，跳过`);
        continue;
      }
      
      if (localMap.has(id)) {
        const localItem = localMap.get(id);
        const localTime = _getItemLastModifiedTime(localItem);
        const cloudTime = _getItemLastModifiedTime(cloudItem);
        
        if (cloudTime > localTime) {
          merged.push(cloudItem);
          processedContentHashes.add(contentHash);
          safeLog(`[mergeItems] ID ${id}: 云端更新较新，使用云端数据`);
        } else {
          merged.push(localItem);
          processedContentHashes.add(generateContentHash(localItem));
          safeLog(`[mergeItems] ID ${id}: 本地更新较新或相同，使用本地数据`);
        }
      } else {
        merged.push(cloudItem);
        processedContentHashes.add(contentHash);
        safeLog(`[mergeItems] ID ${id}: 云端独有，添加到合并结果`);
      }
    }
    
    for (const [id, localItem] of localMap) {
      if (!processedIds.has(id)) {
        const contentHash = generateContentHash(localItem);
        if (processedContentHashes.has(contentHash)) {
          safeLog(`[mergeItems] ID ${id}: 本地独有但内容重复，跳过`);
          continue;
        }
        // 本地独有数据：保留（用户新增但尚未上传到云端的数据）
        merged.push(localItem);
        processedContentHashes.add(contentHash);
        safeLog(`[mergeItems] ID ${id}: 本地独有，保留（新增数据）`);
      }
    }
    
    if (cloudItemsWithoutId.length > 0) {
      merged.push(...cloudItemsWithoutId);
      safeLog(`[mergeItems] 添加 ${cloudItemsWithoutId.length} 个云端无ID项到合并结果`);
    }

    // 本地无ID的项视为没有唯一标识，无法判断是否被删除，也一并保留
    if (localItemsWithoutId.length > 0) {
      merged.push(...localItemsWithoutId);
      safeLog(`[mergeItems] 添加 ${localItemsWithoutId.length} 个本地无ID项到合并结果`);
    }
    
    safeLog(`[mergeItems] 合并结果数量: ${merged.length}`);
    return merged;
  }
  
  function mergeSettings(localSettings, cloudSettings) {
    return {
      ...cloudSettings,
      cloudAppId: localSettings.cloudAppId || '',
      cloudAppKey: localSettings.cloudAppKey || '',
      cloudAppSecret: localSettings.cloudAppSecret || '',
      cloudToken: localSettings.cloudToken || '',
      cloudRefreshToken: localSettings.cloudRefreshToken || '',
      cloudTokenExpireTime: localSettings.cloudTokenExpireTime || 0,
      backgroundImage: localSettings.backgroundImage || '',
      themeMode: localSettings.themeMode || '',
      cardOpacity: localSettings.cardOpacity || '',
      fontSize: localSettings.fontSize || '',
      darkBackground: localSettings.darkBackground || '',
      lightBackground: localSettings.lightBackground || '',
      autoSyncEnabled: localSettings.autoSyncEnabled || false,
      autoSyncInterval: localSettings.autoSyncInterval || 10,
      cloudCurrentUserId: localSettings.cloudCurrentUserId || 'admin',
      // 智能体数据：本地优先，防止云端空数据覆盖
      aiPresets: mergePresetLists(cloudSettings?.aiPresets || [], localSettings?.aiPresets || []),
      aiCurrentPresetId: localSettings.aiCurrentPresetId || cloudSettings.aiCurrentPresetId || '',
      aiApiKey: localSettings.aiApiKey || cloudSettings.aiApiKey || '',
      aiModel: localSettings.aiModel || cloudSettings.aiModel || 'deepseek-v4-flash',
      aiAgentName: localSettings.aiAgentName || cloudSettings.aiAgentName || '',
      aiSystemPrompt: localSettings.aiSystemPrompt || cloudSettings.aiSystemPrompt || '',
      // ★ 头像：云端优先（base64 data URL），头像为共享身份应跨设备一致；云端为空时保留本地，避免"变回默认"
      aiUserAvatar: cloudSettings.aiUserAvatar || localSettings.aiUserAvatar || '',
      aiAgentAvatar: cloudSettings.aiAgentAvatar || localSettings.aiAgentAvatar || ''
    };
  }

  async function backupDataVersion(data, syncType) {
    const now = Date.now();
    
    if (now - lastBackupTime < 5 * 60 * 1000) {
      safeLog('[版本管理] 距离上次备份不足5分钟，跳过备份');
      return;
    }
    
    const currentHash = generateDataHash(data);
    if (currentHash === lastBackupHash && lastBackupHash !== '') {
      safeLog('[版本管理] 数据内容未变化，跳过备份');
      return;
    }
    
    const backupDir = getBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${timestamp}_${syncType}.json`;
    const backupPath = path.join(backupDir, backupFileName);
    
    try {
      const backupData = {
        version: '1.0',
        timestamp: now,
        syncType: syncType,
        data: data
      };
      
      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
      safeLog(`[版本管理] 已创建备份: ${backupFileName}`);
      
      lastBackupTime = now;
      lastBackupHash = currentHash;
    } catch (error) {
      safeError('[版本管理] 创建备份失败:', error);
    }
  }

  async function cleanupOldVersions() {
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) return;
    
    try {
      const files = fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.json'))
        .map(file => {
          const filePath = path.join(backupDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            time: stats.mtime.getTime(),
            size: stats.size
          };
        })
        .sort((a, b) => b.time - a.time);
      
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      const oneDay = 24 * oneHour;
      const thirtyDays = 30 * oneDay;
      
      const keepList = [];
      let hourlyCount = 0;
      let dailyCount = 0;
      let lastDay = -1;
      
      for (const file of files) {
        const age = now - file.time;
        
        if (age > thirtyDays) {
          continue;
        }
        
        if (age <= oneHour) {
          if (hourlyCount < 3) {
            keepList.push(file);
            hourlyCount++;
          }
        } else if (age <= oneDay) {
          if (dailyCount < 10) {
            keepList.push(file);
            dailyCount++;
          }
        } else {
          const fileDay = Math.floor(file.time / oneDay);
          if (fileDay !== lastDay) {
            keepList.push(file);
            lastDay = fileDay;
          }
        }
      }
      
      const maxTotalVersions = 50;
      const finalKeepList = keepList.slice(0, maxTotalVersions);
      const keepNames = new Set(finalKeepList.map(f => f.name));
      
      let deletedCount = 0;
      let freedBytes = 0;
      
      for (const file of files) {
        if (!keepNames.has(file.name)) {
          fs.unlinkSync(file.path);
          deletedCount++;
          freedBytes += file.size;
          safeLog(`[版本管理] 删除旧版本: ${file.name}`);
        }
      }
      if (deletedCount > 0) {
        const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
        safeLog(`[版本管理] 清理完成: 删除 ${deletedCount} 个旧版本，释放 ${freedMB} MB`);
      }
    } catch (error) {
      safeError('[版本管理] 清理旧版本失败:', error);
    }
  }
}

function listBackupVersions() {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) {
    return { success: true, data: [] };
  }
  
  try {
    const files = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        let backupData = null;
        let memoCount = 0;
        let taskCount = 0;
        let expenseCount = 0;
        let budgetCount = 0;
        let journalCount = 0;
        let chatCount = 0;
        let secretCount = 0;
        let presetCount = 0;
        
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          backupData = JSON.parse(content);
          memoCount = backupData.data?.memos?.length || 0;
          taskCount = backupData.data?.tasks?.length || 0;
          expenseCount = backupData.data?.expenses?.length || 0;
          budgetCount = backupData.data?.budgets?.length || 0;
          journalCount = backupData.data?.journals?.length || 0;
          chatCount = backupData.data?.chatHistory?.length || 0;
          secretCount = backupData.data?.secrets?.length || 0;
          presetCount = (backupData.data?.settings?.aiPresets || []).length;
        } catch (e) {
          safeLog(`[版本管理] 无法读取备份文件: ${file}`);
        }
        
        const match = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(\w+)\.json$/);
        const timestamp = match ? new Date(match[1].replace(/-/g, ':').replace('T', ' ')).getTime() : stats.mtime.getTime();
        const syncType = match ? match[2] : 'unknown';
        
        return {
          fileName: file,
          path: filePath,
          timestamp: timestamp,
          syncType: syncType,
          size: stats.size,
          memoCount: memoCount,
          taskCount: taskCount,
          expenseCount: expenseCount,
          budgetCount: budgetCount,
          journalCount: journalCount,
          chatCount: chatCount,
          secretCount: secretCount,
          presetCount: presetCount
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
    
    return { success: true, data: files };
  } catch (error) {
    safeError('[版本管理] 获取备份列表失败:', error);
    return { success: false, message: error.message };
  }
}

async function restoreFromBackup(fileName) {
  const backupDir = getBackupDir();
  const filePath = path.join(backupDir, fileName);
  
  if (!fs.existsSync(filePath)) {
    return { success: false, message: '备份文件不存在' };
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const backupData = JSON.parse(content);
    
    if (!backupData.data) {
      return { success: false, message: '备份数据格式错误' };
    }
    
    const data = backupData.data;
    await writeData(
      data.tasks || [],
      data.memos || [],
      data.expenses || [],
      data.budgets || [],
      data.settings || {},
      data.translationStats || {},
      data.categoryBudgets || [],
      data.secrets || [],
      data.journals || [],
      true,
      data.chatHistory || []
    );
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tasks-updated');
      mainWindow.webContents.send('memos-updated');
      mainWindow.webContents.send('expenses-updated');
      mainWindow.webContents.send('journals-updated');
      mainWindow.webContents.send('budgets-updated');
      mainWindow.webContents.send('secrets-updated');
    }
    
    return { success: true, message: '数据恢复成功' };
  } catch (error) {
    safeError('[版本管理] 恢复备份失败:', error);
    return { success: false, message: error.message };
  }
}

async function deleteBackup(fileName) {
  const backupDir = getBackupDir();
  const filePath = path.join(backupDir, fileName);
  
  if (!fs.existsSync(filePath)) {
    return { success: false, message: '备份文件不存在' };
  }
  
  try {
    fs.unlinkSync(filePath);
    return { success: true, message: '备份删除成功' };
  } catch (error) {
    safeError('[版本管理] 删除备份失败:', error);
    return { success: false, message: error.message };
  }
}

ipcMain.handle('backup-list', () => {
  return listBackupVersions();
});

ipcMain.handle('backup-restore', (event, fileName) => {
  return restoreFromBackup(fileName);
});

ipcMain.handle('backup-delete', (event, fileName) => {
  return deleteBackup(fileName);
});

ipcMain.handle('cleanup-duplicates', () => {
  return cleanupDuplicateData();
});

ipcMain.handle('cloud-sync-check', async () => {
    try {
      if (!cloudSync) {
        // 如果云同步未初始化，尝试使用保存的配置自动初始化
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        const token = settings.cloudToken || '';
        const refreshToken = settings.cloudRefreshToken || '';
        const tokenExpireTime = settings.cloudTokenExpireTime || 0;
        
        if (!appId || !appKey || !appSecret) {
          return { success: false, message: '请先填写云同步配置' };
        }
        
        cloudSync = new CloudSync();
        cloudSync.setUserId(getCurrentUserId());
        await cloudSync.init({
          appId: appId,
          appKey: appKey,
          appSecret: appSecret,
          token: token,
          refreshToken: refreshToken,
          tokenExpireTime: tokenExpireTime,
          onTokenUpdate: async (tokenData) => {
            const currentData = readData();
            currentData.settings = currentData.settings || {};
            currentData.settings.cloudToken = tokenData.token;
            currentData.settings.cloudRefreshToken = tokenData.refreshToken;
            currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
            await writeData(
              currentData.tasks,
              currentData.memos,
              currentData.expenses,
              currentData.budgets,
              currentData.settings,
              currentData.translationStats,
              currentData.categoryBudgets || [],
              currentData.secrets || [],
              currentData.journals || []
            );
          }
        });
      }
      
      const result = await cloudSync.getTokenInfo();
      if (result.success) {
        return { success: true, data: result.data };
      } else {
        return result;
      }
    } catch (e) {
      safeError('检查云同步状态失败:', e);
      return { success: false, message: '检查云同步状态失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-get-config', async () => {
    try {
      const currentData = readData();
      const settings = currentData.settings || {};
      const now = Date.now();
      const tokenExpireTime = settings.cloudTokenExpireTime || 0;
      const isTokenExpired = tokenExpireTime > 0 && now >= tokenExpireTime;
      const tokenValidSeconds = tokenExpireTime > now ? Math.floor((tokenExpireTime - now) / 1000) : 0;
      
      return {
        success: true,
        appId: settings.cloudAppId || '',
        appKey: settings.cloudAppKey || '',
        appSecret: settings.cloudAppSecret || '',
        autoSync: settings.cloudAutoSync || false,
        syncInterval: settings.cloudSyncInterval || 30,
        token: settings.cloudToken || '',
        refreshToken: settings.cloudRefreshToken || '',
        tokenExpireTime: tokenExpireTime,
        isTokenExpired: isTokenExpired,
        tokenValidSeconds: tokenValidSeconds,
        currentUserId: settings.cloudCurrentUserId || 'admin'
      };
    } catch (e) {
      safeError('获取云同步配置失败:', e);
      return { success: false, message: '获取云同步配置失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-set-user', async (event, userId) => {
    try {
      const currentUserId = getCurrentUserId();
      const currentData = readData();
      
      if (currentUserId !== 'admin') {
        writeUserSpecificData(currentUserId, currentData);
      }
      
      const exePath = path.dirname(app.getPath('exe'));
      const targetUserDataPath = path.join(exePath, 'users', userId, 'data.json');
      const targetUserExists = fs.existsSync(targetUserDataPath);
      
      const hasData = currentData.tasks.length > 0 || 
                     currentData.memos.length > 0 || 
                     currentData.expenses.length > 0 || 
                     currentData.budgets.length > 0;
      
      if (!targetUserExists && hasData) {
        writeUserSpecificData(userId, currentData);
      }
      
      updateAdminSettings({ cloudCurrentUserId: userId });
      
      if (cloudSync) {
        cloudSync.setUserId(userId);
      }
      
      const updatedSettings = {
        ...currentData.settings,
        cloudCurrentUserId: userId
      };
      
      await writeData([], [], [], [], updatedSettings, currentData.translationStats || {}, [], []);
      
      return { success: true, message: '用户已切换', userId: userId, migrated: !targetUserExists };
    } catch (e) {
      safeError('切换用户失败:', e);
      return { success: false, message: '切换用户失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-get-user-list', async () => {
    try {
      const settings = readAdminData().settings || {};
      const users = settings.cloudUsers || [{ id: 'admin', name: '管理员', isDefault: true }];
      return { success: true, users: users };
    } catch (e) {
      safeError('获取用户列表失败:', e);
      return { success: false, message: '获取用户列表失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-add-user', async (event, user) => {
      try {
        const currentData = readAdminData();
        
        currentData.settings = currentData.settings || {};
        currentData.settings.cloudUsers = currentData.settings.cloudUsers || [{ id: 'admin', name: '管理员', isDefault: true }];
        
        const exists = currentData.settings.cloudUsers.some(u => u.id === user.id);
        if (exists) {
          return { success: false, message: '用户已存在' };
        }
        
        currentData.settings.cloudUsers.push({
          id: user.id,
          name: user.name || user.id,
          isDefault: false
        });
        
        const exePath = path.dirname(app.getPath('exe'));
        const adminDataPath = path.join(exePath, 'data.json');
        fs.writeFileSync(adminDataPath, JSON.stringify(currentData, null, 2));
        
        return { success: true, message: '用户添加成功', users: currentData.settings.cloudUsers };
      } catch (e) {
        safeError('添加用户失败:', e);
        return { success: false, message: '添加用户失败: ' + e.message };
      }
    });

  ipcMain.handle('cloud-sync-remove-user', async (event, userId) => {
    try {
      if (userId === 'admin') {
        return { success: false, message: '不能删除管理员用户' };
      }
      
      const currentData = readAdminData();
      currentData.settings = currentData.settings || {};
      currentData.settings.cloudUsers = currentData.settings.cloudUsers || [{ id: 'admin', name: '管理员', isDefault: true }];
      
      const initialCount = currentData.settings.cloudUsers.length;
      currentData.settings.cloudUsers = currentData.settings.cloudUsers.filter(u => u.id !== userId);
      
      if (currentData.settings.cloudUsers.length === initialCount) {
        return { success: false, message: '用户不存在' };
      }
      
      const exePath = path.dirname(app.getPath('exe'));
      const adminDataPath = path.join(exePath, 'data.json');
      fs.writeFileSync(adminDataPath, JSON.stringify(currentData, null, 2));
      
      const userDataDir = path.join(exePath, 'users', userId);
      if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
      
      return { success: true, message: '用户已删除', users: currentData.settings.cloudUsers };
    } catch (e) {
      safeError('删除用户失败:', e);
      return { success: false, message: '删除用户失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-cleanup-empty-dirs', async () => {
    try {
      if (!cloudSync) {
        return { success: false, message: '云同步未初始化' };
      }
      
      const result = await cloudSync.cleanupEmptyDirectories();
      return result;
    } catch (e) {
      return { success: false, message: '清理失败: ' + e.message };
    }
  });

  ipcMain.handle('show-input-dialog', async (event, options) => {
    try {
      const { dialog } = require('electron');
      const { title, label, defaultValue = '' } = options;
      
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: title || '输入',
        message: label,
        detail: '',
        buttons: ['确定', '取消'],
        defaultId: 0,
        cancelId: 1,
        inputValue: defaultValue,
        inputPlaceholder: '请输入...'
      });
      
      if (result.response === 0 && result.input) {
        return { success: true, value: result.input.trim() };
      } else {
        return { success: false, value: null };
      }
    } catch (e) {
      safeError('显示输入对话框失败:', e);
      return { success: false, message: '显示输入对话框失败: ' + e.message };
    }
  });

  ipcMain.handle('show-confirm-dialog', async (event, options) => {
    try {
      const { dialog } = require('electron');
      const { title, message } = options;
      
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: title || '确认',
        message: message || '',
        buttons: ['确定', '取消'],
        defaultId: 1,
        cancelId: 1
      });
      
      return { success: result.response === 0 };
    } catch (e) {
      safeError('显示确认对话框失败:', e);
      return { success: false, message: '显示确认对话框失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-save-config', async (event, config) => {
    try {
      safeLog('保存配置:', config);
      const currentData = readData();
      safeLog('当前数据:', JSON.stringify(currentData.settings));
      currentData.settings = currentData.settings || {};
      currentData.settings.cloudAppId = config.appId;
      currentData.settings.cloudAppKey = config.appKey;
      currentData.settings.cloudAppSecret = config.appSecret;
      currentData.settings.cloudAutoSync = config.autoSync || false;
      currentData.settings.cloudSyncInterval = config.syncInterval || 30;
      if (config.token) currentData.settings.cloudToken = config.token;
      if (config.refreshToken) currentData.settings.cloudRefreshToken = config.refreshToken;
      if (config.tokenExpireTime) currentData.settings.cloudTokenExpireTime = config.tokenExpireTime;
      
      await writeData(
        currentData.tasks,
        currentData.memos,
        currentData.expenses,
        currentData.budgets,
        currentData.settings,
        currentData.translationStats,
        currentData.categoryBudgets,
        currentData.secrets || [],
        currentData.journals || []
      );
      
      const verifyData = readData();
      safeLog('保存后数据:', JSON.stringify(verifyData.settings));
      
      return { success: true, message: '云同步配置已保存' };
    } catch (e) {
      safeError('保存云同步配置失败:', e);
      return { success: false, message: '保存云同步配置失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-get-auth-url', async (event, config) => {
    try {
      cloudSync = new CloudSync();
      await cloudSync.init({ appId: config.appId, appKey: config.appKey, appSecret: config.appSecret });
      
      const url = cloudSync.getAuthUrl();
      return { success: true, url: url };
    } catch (e) {
      safeError('获取授权URL失败:', e);
      return { success: false, message: '获取授权URL失败: ' + e.message };
    }
  });

  ipcMain.handle('get-resources-path', async () => {
    try {
      return { 
        success: true, 
        resourcesPath: getResourcesPath(),
        appPath: getCurrentAppPath()
      };
    } catch (e) {
      safeError('获取资源路径失败:', e);
      return { success: false, message: '获取资源路径失败: ' + e.message };
    }
  });

  ipcMain.handle('cloud-sync-exchange-code', async (event, params) => {
    try {
      cloudSync = new CloudSync();
      await cloudSync.init({ appId: params.appId, appKey: params.appKey, appSecret: params.appSecret });
      
      const result = await cloudSync.exchangeCode(params.code);
      
      const currentData = readData();
      currentData.settings = currentData.settings || {};
      currentData.settings.cloudToken = result.token;
      currentData.settings.cloudRefreshToken = result.refreshToken;
      currentData.settings.cloudTokenExpireTime = result.tokenExpireTime;
      
      const writeResult = await writeData(
        currentData.tasks,
        currentData.memos,
        currentData.expenses,
        currentData.budgets,
        currentData.settings,
        currentData.translationStats,
        currentData.categoryBudgets || [],
        currentData.secrets || []
      );
      
      if (!writeResult.success) {
        safeError('Token保存失败:', writeResult.message);
        return { success: false, message: '授权成功，但Token保存失败: ' + writeResult.message };
      }
      
      return { success: true, message: '授权成功', data: result };
    } catch (e) {
      safeError('交换授权码失败:', e);
      return { success: false, message: '交换授权码失败: ' + e.message };
    }
  });

  ipcMain.handle('show-open-dialog', async (event, options) => {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(mainWindow, options);
      if (!result.canceled && result.filePaths.length > 0) {
        return { success: true, path: result.filePaths[0] };
      }
      return { success: false };
    } catch (e) {
      safeError('打开文件对话框失败:', e);
      return { success: false, message: '打开文件对话框失败: ' + e.message };
    }
  });

  ipcMain.handle('import-data-file', async (event) => {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择数据文件',
        filters: [
          { name: 'JSON文件', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, message: '已取消选择' };
      }

      const filePath = result.filePaths[0];
      
      if (!fs.existsSync(filePath)) {
        return { success: false, message: '文件不存在' };
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const importedData = JSON.parse(content);

      const currentData = readData();
      
      const preservedSettings = {
        cloudAppId: currentData.settings?.cloudAppId || '',
        cloudAppKey: currentData.settings?.cloudAppKey || '',
        cloudAppSecret: currentData.settings?.cloudAppSecret || '',
        cloudToken: currentData.settings?.cloudToken || '',
        cloudRefreshToken: currentData.settings?.cloudRefreshToken || '',
        cloudTokenExpireTime: currentData.settings?.cloudTokenExpireTime || 0,
        backgroundImage: currentData.settings?.backgroundImage || '',
        themeMode: currentData.settings?.themeMode || '',
        cardOpacity: currentData.settings?.cardOpacity || '',
        fontSize: currentData.settings?.fontSize || '',
        darkBackground: currentData.settings?.darkBackground || '',
        lightBackground: currentData.settings?.lightBackground || '',
        autoSyncEnabled: currentData.settings?.autoSyncEnabled || false,
        autoSyncInterval: currentData.settings?.autoSyncInterval || 10,
        cloudCurrentUserId: currentData.settings?.cloudCurrentUserId || 'admin',
        // 保护昔涟 AI 配置
        aiProvider: currentData.settings?.aiProvider || '',
        aiApiKey: currentData.settings?.aiApiKey || '',
        aiBaseUrl: currentData.settings?.aiBaseUrl || '',
        aiModel: currentData.settings?.aiModel || 'deepseek-v4-flash',
        aiAgentName: currentData.settings?.aiAgentName || '昔涟',
        aiSystemPrompt: currentData.settings?.aiSystemPrompt || '',
        aiContextRounds: currentData.settings?.aiContextRounds || 10,
        aiTemperature: currentData.settings?.aiTemperature ?? 1.0,
        aiStreamEnabled: currentData.settings?.aiStreamEnabled !== false,
        aiDeleteConfirmEnabled: currentData.settings?.aiDeleteConfirmEnabled !== false,
        aiOperationLogEnabled: currentData.settings?.aiOperationLogEnabled || false,
        aiMaxToolRounds: currentData.settings?.aiMaxToolRounds || 30,  // ★ P2-1
        aiUserName: currentData.settings?.aiUserName || '我',
        aiUserAvatar: currentData.settings?.aiUserAvatar || '',
        aiAgentAvatar: currentData.settings?.aiAgentAvatar || '',
        aiPresets: currentData.settings?.aiPresets || [],
        aiCurrentPresetId: currentData.settings?.aiCurrentPresetId || ''
      };

      const writeResult = await writeData(
        importedData.tasks || [],
        importedData.memos || [],
        importedData.expenses || [],
        importedData.budgets || [],
        preservedSettings,
        importedData.translationStats || {},
        importedData.categoryBudgets || [],
        importedData.secrets || [],
        importedData.journals || []
      );

      if (!writeResult.success) {
        return { success: false, message: '导入失败: ' + writeResult.message };
      }

      return { 
        success: true, 
        message: `导入成功！\n任务: ${importedData.tasks?.length || 0} 条\n笔记: ${importedData.memos?.length || 0} 条\n收支: ${importedData.expenses?.length || 0} 条\n预算: ${importedData.budgets?.length || 0} 条\n密钥: ${importedData.secrets?.length || 0} 条\n日志: ${importedData.journals?.length || 0} 条`
      };
    } catch (e) {
      safeError('导入数据失败:', e);
      return { success: false, message: '导入数据失败: ' + e.message };
    }
  });

  ipcMain.handle('open-external-url', async (event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      safeError('打开外部链接失败:', e);
      return { success: false, message: '打开外部链接失败: ' + e.message };
    }
  });

  ipcMain.handle('window-minimize', async () => {
    if (mainWindow) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle('window-maximize', async () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window-close', async () => {
    if (mainWindow) {
      mainWindow.close();
    }
  });

  // ★ 刷新按钮 IPC — 通过创建/销毁微型不可见窗口，触发主窗口的完整焦点周期
  // 解决删除数据后 webContents 焦点链断裂导致所有输入框无法聚焦的问题。
  // 原理：便利贴（BrowserWindow）创建→关闭 会让主窗口经历 失焦→获焦 的完整周期，
  // Electron 内部的 webContents 焦点状态在此过程中被重置。
  // 本 handler 用 1px 透明窗口模拟同样的效果，用户完全无感知。
  ipcMain.handle('refresh-window-focus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };

    // 创建 1 像素透明微型窗口，仅用于触发焦点转移
    const microWin = new BrowserWindow({
      width: 1,
      height: 1,
      x: -100,
      y: -100,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      focusable: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    // 加载空白页 → 显示（抢走焦点） → 60ms 后关闭 → 显式将焦点归还主窗口
    microWin.loadURL('about:blank');
    microWin.once('ready-to-show', () => {
      microWin.show();
      setTimeout(() => {
        if (!microWin.isDestroyed()) microWin.close();
        // ★ 关键修复：关闭微型窗口后必须显式将焦点归还主窗口
        // 便利贴关闭时 Windows 会自动归还焦点，但 1px 透明窗口太特殊，
        // Windows 不一定能正确处理焦点转移，需要手动 focus
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus();
          // 同时 focus webContents，确保输入框能正确接收焦点
          mainWindow.webContents.focus();
        }
      }, 60);
    });

    // 安全兜底：200ms 后强制清理 + 归还焦点
    setTimeout(() => {
      if (!microWin.isDestroyed()) microWin.close();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    }, 200);

    return { success: true };
  });

  ipcMain.handle('create-sticky-note', (event, memo) => {
    const existingSticky = stickyNoteWindows.find(s => s.memoId === memo.id);
    if (existingSticky) {
      existingSticky.window.focus();
      return;
    }

    const stickyWin = new BrowserWindow({
      width: 300,
      height: 400,
      frame: false,
      resizable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      icon: getAppIcon(),
      minWidth: 80,
      minHeight: 40,
      thickFrame: false,
      titleBarStyle: 'hidden',
      visualEffectState: 'disabled',
      hasShadow: false,
      transparent: true,
      show: false,  // ★ 修复：先隐藏窗口，等内容渲染完成后再显示，避免透明窗口"消失"
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false        
      }
    });

    stickyWin.loadFile('sticky-note.html');
    stickyWin.webContents.on('did-finish-load', () => {
      stickyWin.webContents.send('load-memo', memo);
      // ★ 修复：内容加载完成后再显示窗口，确保便利贴不会"闪现消失"
      stickyWin.show();
    });

    stickyNoteWindows.push({ memoId: memo.id, window: stickyWin });

    stickyWin.on('closed', () => {
      const index = stickyNoteWindows.findIndex(s => s.memoId === memo.id);
      if (index !== -1) {
        stickyNoteWindows.splice(index, 1);
      }
    });
  });

  ipcMain.handle('close-sticky-note', (event, memoId) => {
    const sticky = stickyNoteWindows.find(s => s.memoId === memoId);
    if (sticky && sticky.window && !sticky.window.isDestroyed()) {
      sticky.window.close();
    }
  });

  ipcMain.handle('minimize-sticky-note', () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.minimize();
    }
  });

  ipcMain.handle('toggle-sticky-pin', (event, isPinned) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.setAlwaysOnTop(isPinned);
    }
  });

  ipcMain.handle('update-sticky-memo', async (event, memoId, title, content, htmlContent) => {
    // ★ 便利贴升级为富文本：优先使用编辑器传入的 htmlContent，否则退回纯文本转 <br>
    const isRich = typeof htmlContent === 'string' && htmlContent.trim().length > 0;
    const memoData = {
      id: memoId,
      title: title,
      content: content,
      htmlContent: isRich ? htmlContent : (content ? content.replace(/\n/g, '<br>') : ''),
      lastModified: new Date().toISOString()
    };

    const result = await updateData('memo', memoData);
    // ★ 编辑便利贴后同步刷新主窗口备忘录列表（与换色行为一致）
    if (result.writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memos-updated');
    }
    return result;
  });

  ipcMain.handle('update-sticky-color', async (event, memoId, color) => {
    const memoData = {
      id: memoId,
      color: color,
      lastModified: new Date().toISOString()
    };
    
    const result = await updateData('memo', memoData);
    if (result.writeResult.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memos-updated');
    }
  });

  ipcMain.handle('read-file-content', async (event, filePath) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      let content = '';
      
      if (ext === '.txt') {
        content = fs.readFileSync(filePath, 'utf8');
      } else if (ext === '.docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value || '';
      }
      
      return { success: true, content };
    } catch (error) {
      safeError('读取文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('open-color-picker', (event, memoId) => {
    openColorPicker(memoId);
  });

  // 预算相关
  ipcMain.handle('get-budgets', () => {
    data = readData();
    return data.budgets || [];
  });

  ipcMain.handle('save-budget', async (event, budget) => {
    data = readData();
    if (!data.budgets) {
      data.budgets = [];
    }
    const now = new Date().toISOString();
    budget.updatedAt = now;
    if (budget.id) {
      const index = data.budgets.findIndex(b => String(b.id) === String(budget.id));
      if (index !== -1) {
        data.budgets[index] = { ...data.budgets[index], ...budget, updatedAt: now };
      }
    } else {
      budget.id = uuidv4();
      data.budgets.push(budget);
    }
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success) {
      sendToAllWindows('tasks-updated');
    }
    return { success: writeResult.success, budget: budget, message: writeResult.message };
  });

  ipcMain.handle('delete-budget', async (event, budgetId) => {
    data = readData();
    if (!data.budgets) {
      data.budgets = [];
    }
    const index = data.budgets.findIndex(b => String(b.id) === String(budgetId));
    if (index !== -1) {
      data.budgets.splice(index, 1);
    }
    // ★ 墓碑：记录已删除 id（含关联 categoryBudgets）
    data.deletedItems = data.deletedItems || {};
    (data.deletedItems.budgets = data.deletedItems.budgets || []).push(String(budgetId));
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true, undefined, undefined, undefined, undefined, data.deletedItems);
    if (writeResult.success) {
      sendToAllWindows('tasks-updated');
    }
    return { success: writeResult.success, message: writeResult.message };
  });

  ipcMain.handle('get-category-budgets', () => {
    data = readData();
    return data.categoryBudgets || [];
  });

  ipcMain.handle('save-category-budgets', async (event, { budgets }) => {
    data = readData();
    data.categoryBudgets = budgets || [];
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets, data.secrets || [], data.journals || [], true);
    if (writeResult.success) {
      sendToAllWindows('tasks-updated');
    }
    return { success: writeResult.success, message: writeResult.message };
  });

  ipcMain.handle('save-budgets', async (event, params) => {
    const budgets = params.budgets || [];
    const selectedIndex = params.selectedIndex;
    
    data = readData();
    
    // 为没有 id 的预算生成 id
    const now = new Date().toISOString();
    budgets.forEach(budget => {
      if (!budget.id) {
        budget.id = uuidv4();
        budget.createdAt = now;
      }
      budget.updatedAt = now;
    });
    
    data.budgets = budgets;
    
    // 从预算周期中提取分类预算，用于主界面显示
    let currentCategoryBudgets = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (data.budgets && data.budgets.length > 0) {
      let currentBudget = null;
      
      // 优先使用用户正在编辑的预算周期索引
      if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < data.budgets.length) {
        currentBudget = data.budgets[selectedIndex];
        console.log('使用用户编辑的预算周期，索引:', selectedIndex);
      } else {
        // 查找当前日期所在的预算周期
        for (const budget of data.budgets) {
          const parseDate = (dateStr) => {
            const normalizedStr = dateStr.replace(/\//g, '-');
            const date = new Date(normalizedStr);
            return date;
          };
          
          const startDate = parseDate(budget.startDate);
          const endDate = parseDate(budget.endDate);
          
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            console.error('日期解析失败:', budget.startDate, budget.endDate);
            continue;
          }
          
          startDate.setHours(0, 0, 0, 0);
          endDate.setHours(23, 59, 59, 999);
          
          if (today >= startDate && today <= endDate) {
            currentBudget = budget;
            console.log('找到当前日期所在的预算周期:', budget.startDate, budget.endDate, budget.categoryBudgets);
            break;
          }
        }
        
        // 如果没找到当前日期所在的预算周期，取最后一个
        if (!currentBudget) {
          currentBudget = data.budgets[data.budgets.length - 1];
          console.log('未找到当前日期所在的预算周期，使用最后一个:', currentBudget?.startDate, currentBudget?.endDate);
        }
      }
      
      if (currentBudget && currentBudget.categoryBudgets && currentBudget.categoryBudgets.length > 0) {
        currentCategoryBudgets = currentBudget.categoryBudgets;
        console.log('提取到分类预算:', currentCategoryBudgets);
      } else {
        console.log('未提取到分类预算:', currentBudget?.categoryBudgets);
      }
    }
    
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, currentCategoryBudgets, data.secrets || [], data.journals || [], true);
    
    if (writeResult.success) {
      sendToAllWindows('tasks-updated');
    }
    return { success: writeResult.success, message: writeResult.message };
  });

  ipcMain.handle('get-settings', () => {
    data = readData(true); // 强制刷新
    return data.settings || {};
  });

  // 返回背景图目录的绝对路径（自适应任意磁盘/路径）
  ipcMain.handle('get-bg-dir', () => {
    return getResourcesPath();
  });

  ipcMain.handle('save-settings', async (event, newSettings) => {
    data = readData(true); // 强制刷新，避免缓存导致丢失最新值
    data.settings = data.settings || {};
    
    const preservedSettings = {
      cloudAppId: data.settings.cloudAppId,
      cloudAppKey: data.settings.cloudAppKey,
      cloudAppSecret: data.settings.cloudAppSecret,
      cloudSyncPath: data.settings.cloudSyncPath,
      cloudToken: data.settings.cloudToken,
      cloudRefreshToken: data.settings.cloudRefreshToken,
      cloudTokenExpireTime: data.settings.cloudTokenExpireTime,
      cloudAutoSync: data.settings.cloudAutoSync,
      cloudSyncInterval: data.settings.cloudSyncInterval,
      autoSyncEnabled: data.settings.autoSyncEnabled,
      autoSyncInterval: data.settings.autoSyncInterval,
      lastSyncTime: data.settings.lastSyncTime,
      dataLastModified: data.settings.dataLastModified,
      lastModified: data.settings.lastModified,
      cloudUsers: data.settings.cloudUsers,
      cloudCurrentUserId: data.settings.cloudCurrentUserId,
      theme: data.settings.theme,
      taskCardOpacity: data.settings.taskCardOpacity,
      expenseCardOpacity: data.settings.expenseCardOpacity,
      financeCardOpacity: data.settings.financeCardOpacity,
      calendarOpacity: data.settings.calendarOpacity,
      budgetOpacity: data.settings.budgetOpacity,
      secretCardOpacity: data.settings.secretCardOpacity,
      reminderCardOpacity: data.settings.reminderCardOpacity,
      memoCardOpacity: data.settings.memoCardOpacity,
      darkBackgroundImage: data.settings.darkBackgroundImage,
      darkBackgroundPositionX: data.settings.darkBackgroundPositionX,
      darkBackgroundPositionY: data.settings.darkBackgroundPositionY,
      darkBackgroundSizeWidth: data.settings.darkBackgroundSizeWidth,
      darkBackgroundOpacity: data.settings.darkBackgroundOpacity,
      darkOverlayColor: data.settings.darkOverlayColor,
      darkOverlayOpacity: data.settings.darkOverlayOpacity,
      darkInvert: data.settings.darkInvert,
      lightBackgroundImage: data.settings.lightBackgroundImage,
      lightBackgroundPositionX: data.settings.lightBackgroundPositionX,
      lightBackgroundPositionY: data.settings.lightBackgroundPositionY,
      lightBackgroundSizeWidth: data.settings.lightBackgroundSizeWidth,
      lightBackgroundOpacity: data.settings.lightBackgroundOpacity,
      lightOverlayColor: data.settings.lightOverlayColor,
      lightOverlayOpacity: data.settings.lightOverlayOpacity,
      lightInvert: data.settings.lightInvert,
      chatBackgroundImage: data.settings.chatBackgroundImage,
      chatBackgroundPositionX: data.settings.chatBackgroundPositionX,
      chatBackgroundPositionY: data.settings.chatBackgroundPositionY,
      chatBackgroundSizeWidth: data.settings.chatBackgroundSizeWidth,
      chatBackgroundOpacity: data.settings.chatBackgroundOpacity,
      chatBackgroundBlur: data.settings.chatBackgroundBlur,
      chatOverlayColor: data.settings.chatOverlayColor,
      chatOverlayOpacity: data.settings.chatOverlayOpacity,
      // 🆕 昔涟 AI 配置（保护不被前端覆盖）
      aiProvider: data.settings.aiProvider,
      aiApiKey: data.settings.aiApiKey,
      aiBaseUrl: data.settings.aiBaseUrl,
      aiModel: data.settings.aiModel,
      aiAgentName: data.settings.aiAgentName,
      aiSystemPrompt: data.settings.aiSystemPrompt,
      aiContextRounds: data.settings.aiContextRounds,
      aiTemperature: data.settings.aiTemperature,
      aiStreamEnabled: data.settings.aiStreamEnabled,
      aiDeleteConfirmEnabled: data.settings.aiDeleteConfirmEnabled,
      aiOperationLogEnabled: data.settings.aiOperationLogEnabled,
      aiMaxToolRounds: data.settings.aiMaxToolRounds,  // ★ P2-1
      aiUserName: data.settings.aiUserName,
      aiUserAvatar: data.settings.aiUserAvatar,
      aiAgentAvatar: data.settings.aiAgentAvatar,
      // 预设管理
      aiPresets: data.settings.aiPresets,
      aiCurrentPresetId: data.settings.aiCurrentPresetId,
      // GitHub 版本同步配置
      githubToken: data.settings.githubToken
    };
    
    const mergedSettings = { ...preservedSettings, ...newSettings };
    const writeResult = await writeData(data.tasks, data.memos, data.expenses, data.budgets, mergedSettings, data.translationStats, data.categoryBudgets || [], data.secrets || [], data.journals || [], false, data.chatHistory, data.chatRooms, data.chatHistoryStore, data.chatHistoryLimit);
    
    // 写入后立即验证：确保 aiPresets 已正确持久化
    const verifyData = readData(true);
    const savedPresets = verifyData.settings?.aiPresets || [];
    const expectedPresets = mergedSettings.aiPresets || [];
    if (savedPresets.length !== expectedPresets.length) {
      safeLog(`[save-settings] ⚠️ 预设保存异常！预期${expectedPresets.length}个，实际${savedPresets.length}个`);
    }
    
    return { success: writeResult.success, message: writeResult.message };
  });

  // ★ GitHub 版本同步：读取仓库文件（README.md / LICENSE）
  ipcMain.handle('read-app-file', async (event, relativePath) => {
    try {
      const currentAppPath = getCurrentAppPath();
      const sourceDir = path.join(currentAppPath, 'resources', 'app');
      const filePath = path.join(sourceDir, relativePath);
      // 安全检查：禁止读取 ../ 越权
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(sourceDir))) {
        return { success: false, content: '', message: '路径越权。' };
      }
      if (!fs.existsSync(resolved)) {
        return { success: false, content: '', message: '文件不存在。' };
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      return { success: true, content, message: 'OK' };
    } catch (e) {
      safeError('读取应用文件失败:', e);
      return { success: false, content: '', message: e.message };
    }
  });

  // 处理颜色选择
  ipcMain.on('color-picked', (event, colorData) => {
    if (colorPickerWindow && !colorPickerWindow.isDestroyed()) {
      colorPickerWindow.close();
    }

    if (colorData && colorPickerCallback) {
      const hexColor = `#${colorData.r.toString(16).padStart(2, '0')}${colorData.g.toString(16).padStart(2, '0')}${colorData.b.toString(16).padStart(2, '0')}`.toUpperCase();
      
      // 找到对应的便利贴窗口并应用颜色
      const sticky = stickyNoteWindows.find(s => s.memoId === colorPickerCallback);
      if (sticky && sticky.window && !sticky.window.isDestroyed()) {
        sticky.window.webContents.send('apply-color', hexColor);
      }
    }
  });

  ipcMain.handle('crypto-init-master-key', async (event, masterPassword, existingSalt = null) => {
    try {
      const cryptoMgr = getCryptoManager();
      const result = await cryptoMgr.initMasterKey(masterPassword, existingSalt);
      
      if (result.success) {
        const keyStoragePath = path.join(getUserDataPath(), 'crypto-key.json');
        await cryptoMgr.saveKeyToStorage(keyStoragePath, true);
      }
      
      return result;
    } catch (e) {
      safeError('初始化主密钥失败:', e);
      return { success: false, message: '初始化主密钥失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-check-key-initialized', () => {
    const cryptoMgr = getCryptoManager();
    return { initialized: cryptoMgr.isKeyInitialized() };
  });

  ipcMain.handle('crypto-encrypt-data', (event, data) => {
    try {
      const cryptoMgr = getCryptoManager();
      const encrypted = cryptoMgr.encrypt(data);
      return { success: true, data: encrypted };
    } catch (e) {
      safeError('加密数据失败:', e);
      return { success: false, message: '加密数据失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-decrypt-data', (event, encryptedData, iv, authTag) => {
    try {
      const cryptoMgr = getCryptoManager();
      const decrypted = cryptoMgr.decrypt(encryptedData, iv, authTag);
      return { success: true, data: decrypted };
    } catch (e) {
      safeError('解密数据失败:', e);
      return { success: false, message: '解密数据失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-encrypt-object', (event, obj) => {
    try {
      const cryptoMgr = getCryptoManager();
      const encrypted = cryptoMgr.encryptObject(obj);
      return { success: true, data: encrypted };
    } catch (e) {
      safeError('加密对象失败:', e);
      return { success: false, message: '加密对象失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-decrypt-object', (event, encryptedString) => {
    try {
      const cryptoMgr = getCryptoManager();
      const decrypted = cryptoMgr.decryptObject(encryptedString);
      return { success: true, data: decrypted };
    } catch (e) {
      safeError('解密对象失败:', e);
      return { success: false, message: '解密对象失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-verify-password', async (event, password, salt) => {
    try {
      const cryptoMgr = getCryptoManager();
      const isValid = await cryptoMgr.verifyPassword(password, salt);
      return { success: true, isValid: isValid };
    } catch (e) {
      safeError('验证密码失败:', e);
      return { success: false, message: '验证密码失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-load-key-info', async () => {
    try {
      const cryptoMgr = getCryptoManager();
      const keyStoragePath = path.join(getUserDataPath(), 'crypto-key.json');
      const result = await cryptoMgr.loadKeyFromStorage(keyStoragePath);
      return result;
    } catch (e) {
      safeError('加载密钥信息失败:', e);
      return { success: false, message: '加载密钥信息失败: ' + e.message };
    }
  });

  ipcMain.handle('crypto-generate-key', () => {
    try {
      const cryptoMgr = getCryptoManager();
      const key = cryptoMgr.generateSecureKey();
      return { success: true, key: key };
    } catch (e) {
      safeError('生成安全密钥失败:', e);
      return { success: false, message: '生成安全密钥失败: ' + e.message };
    }
  });

  // ============================================================
  // 昔涟智能体 IPC Handlers
  // ============================================================
  let chatStreamAbortController = null;

  // 流式聊天启动
  ipcMain.on('chat-start-stream', async (event, { messages, config }) => {
    const sender = event.sender;
    const currentData = readData();
    const settings = currentData.settings || {};

    // 合并配置：用户设置 + 系统设置
    const mergedConfig = {
      apiKey: config?.apiKey || settings.aiApiKey || '',
      baseUrl: config?.baseUrl || settings.aiBaseUrl || 'https://api.deepseek.com',
      model: config?.model || settings.aiModel || 'deepseek-chat',
      agentName: config?.agentName || settings.aiAgentName || '昔涟',
      systemPrompt: config?.systemPrompt || settings.aiSystemPrompt || '',
      contextRounds: config?.contextRounds || settings.aiContextRounds || 10,
      temperature: config?.temperature ?? settings.aiTemperature ?? 1.0,
      streamEnabled: config?.streamEnabled !== undefined ? config.streamEnabled : settings.aiStreamEnabled !== false,
      deleteConfirmEnabled: config?.deleteConfirmEnabled !== undefined ? config.deleteConfirmEnabled : settings.aiDeleteConfirmEnabled !== false,
      maxToolRounds: parseInt(config?.maxToolRounds) || parseInt(settings.aiMaxToolRounds) || 30  // ★ P2-1: 可配置，默认30，确保数字类型
    };

    // 检查 API Key
    if (!mergedConfig.apiKey) {
      // 无 API Key，使用本地简单回复
      const lastUserMsg = messages?.[messages.length - 1]?.content || '';
      const chatHistory = currentData.chatHistory || [];
      const reply = buildSimpleReply(lastUserMsg, chatHistory);

      // 模拟流式输出
      const chars = reply.split('');
      let i = 0;
      const interval = setInterval(() => {
        if (i < chars.length) {
          sender.send('chat-chunk', { type: 'content', data: chars[i] });
          i++;
        } else {
          clearInterval(interval);
          sender.send('chat-done', { content: reply, toolCallCount: 0, offlineMode: true });
        }
      }, 30);

      return;
    }

    // 处理确认回调（渲染进程通过IPC弹窗确认删除）
    const confirmCallback = async (action, itemId, itemTitle) => {
      if (mergedConfig.deleteConfirmEnabled !== false) {
        // 发送确认请求到渲染进程
        sender.send('chat-confirm-request', { action, itemId, itemTitle });
        // 等待渲染进程响应（用 ipcMain.once 一次性监听）
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            ipcMain.removeHandler('chat-confirm-response-once');
            resolve(false);
          }, 30000); // 30秒超时

          const handler = (evt, response) => {
            clearTimeout(timeout);
            resolve(response?.confirmed || false);
          };
          // 临时注册一次性响应
          ipcMain.once('chat-confirm-response-once', handler);
        });
      }
      return true;
    };

    try {
      // ★ 注入当前会话频道上下文，供 xilian-tools 的 createReminder 等工具读取（参照 creator 注入机制）
      try {
        const chatState = currentData.settings?.chatRoomState || {};
        const presetByName = (currentData.settings?.aiPresets || []).find(p => p.name === mergedConfig.agentName);
        const activePresetId = presetByName ? presetByName.id : (settings.aiCurrentPresetId || 'default');
        global._currentAIAgentChannel = {
          targetType: chatState.isRoomMode && chatState.roomId ? 'room' : 'private',
          targetId: chatState.isRoomMode && chatState.roomId ? chatState.roomId : activePresetId,
          agentPresetId: activePresetId
        };
      } catch (e) {
        safeLog('[提醒] 注入频道上下文失败: ' + e.message);
      }

      // 创建新的 AbortController，保存引用供停止按钮使用
      chatStreamAbortController = new AbortController();
      const signal = chatStreamAbortController.signal;
      // ★ 修复：将 signal 传递给 agent，使 chat-stop-stream 的 abort 能实际中断 fetch
      mergedConfig._signal = signal;
      
      await streamChat(messages || [], mergedConfig, {
        onContent(chunk) {
          if (!sender.isDestroyed()) {
            sender.send('chat-chunk', { type: 'content', data: chunk });
          }
        },
        onToolCall(toolCallInfo) {
          if (!sender.isDestroyed()) {
            sender.send('chat-chunk', {
              type: 'tool-call',
              data: {
                toolCallId: toolCallInfo.toolCallId,
                toolName: toolCallInfo.toolName,
                arguments: toolCallInfo.arguments
              }
            });
          }
        },
        onToolResult(toolResultInfo) {
          if (!sender.isDestroyed()) {
            sender.send('chat-chunk', {
              type: 'tool-result',
              data: {
                toolCallId: toolResultInfo.toolCallId,
                toolName: toolResultInfo.toolName,
                result: toolResultInfo.result
              }
            });
          }
        },
        onConfirmDelete: confirmCallback,
        onDone(result) {
          if (!sender.isDestroyed()) {
            sender.send('chat-done', result);
          }
        },
        onError(error) {
          if (!sender.isDestroyed()) {
            sender.send('chat-error', { message: error.message || String(error) });
          }
        }
      });
    } catch (e) {
      safeError('[昔涟] chat-start-stream error:', e);
      if (!sender.isDestroyed()) {
        sender.send('chat-error', { message: e.message || '未知错误' });
      }
    }
  });

  // 停止流式聊天
  ipcMain.on('chat-stop-stream', (event) => {
    if (chatStreamAbortController) {
      try { chatStreamAbortController.abort(); } catch (e) {}
      chatStreamAbortController = null;
    }
    event.sender.send('chat-done', { content: '', toolCallCount: 0, stopped: true });
  });

  // 获取对话历史
  ipcMain.handle('chat-get-history', () => {
    const data = readData();
    return data.chatHistory || [];
  });

  // 保存对话历史
  ipcMain.handle('chat-save-history', async (event, history) => {
    const data = readData();
    const writeResult = await writeData(
      data.tasks, data.memos, data.expenses, data.budgets,
      data.settings, data.translationStats, data.categoryBudgets || [],
      data.secrets || [], data.journals || [],
      false, history
    );
    return { success: writeResult.success };
  });

  // 清空对话历史
  ipcMain.handle('chat-clear-history', async () => {
    const data = readData();
    const writeResult = await writeData(
      data.tasks, data.memos, data.expenses, data.budgets,
      data.settings, data.translationStats, data.categoryBudgets || [],
      data.secrets || [], data.journals || [],
      false, []
    );
    return { success: writeResult.success };
  });

  // ★ P0-3 修复：移除错误的转发处理器
  // 原先 renderer 发 'chat-confirm-response'，这里转发回 renderer 的 'chat-confirm-response-once'，
  // 但 main 进程的 ipcMain.once('chat-confirm-response-once') 等的是 main 进程内部事件，永远收不到。
  // 现在 renderer 直接发 'chat-confirm-response-once'，无需转发。
  // （保留一个空处理器兼容旧版 renderer，防止报错）
  ipcMain.on('chat-confirm-response', (event, response) => {
    safeLog('[Chat] 收到旧版 chat-confirm-response，已废弃，请更新渲染进程');
  });

  // ============================================================
  // 聊天室预设管理 IPC
  // ============================================================

  ipcMain.handle('chat-room-get-all', () => {
    const data = readData();
    return data.chatRooms || [];
  });

  ipcMain.handle('chat-room-save-all', async (event, rooms) => {
    // ★ 复用 writeData 统一写入路径，避免重复读盘 + 损坏其他数据
    // 原实现直接读取/写入整个 data.json 文件，仅修改 chatRooms 字段，
    // 这种"partial overwrite"方式在大数据量下会阻塞主进程且浪费 I/O。
    // writeData 现在使用 fs.promises 实现真正的异步 I/O，不会阻塞事件循环。
    try {
      const data = readData();
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        false, data.chatHistory, Array.isArray(rooms) ? rooms : (data.chatRooms || []),
        data.chatHistoryStore, data.chatHistoryLimit
      );
      return writeResult;
    } catch (e) {
      console.error('[chat-room-save-all] 异常:', e.stack || e);
      return { success: false, message: '保存聊天室异常: ' + (e.message || e) };
    }
  });

  ipcMain.handle('chat-room-get-state', () => {
    const data = readData();
    return data.settings?.chatRoomState || { roomId: null, isRoomMode: false };
  });

  ipcMain.handle('chat-room-save-state', async (event, state) => {
    try {
      const data = readData();
      data.settings = data.settings || {};
      data.settings.chatRoomState = state;
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        false, data.chatHistory, data.chatRooms, data.chatHistoryStore, data.chatHistoryLimit
      );
      return { success: writeResult.success, message: writeResult.message };
    } catch (e) {
      console.error('[chat-room-save-state] 异常:', e.stack || e);
      return { success: false, message: '保存聊天室状态异常: ' + (e.message || e) };
    }
  });

  // ★ 同步保存聊天室状态（供渲染进程 beforeunload 调用，不能用 invoke）
  ipcMain.on('chat-room-save-state-sync', async (event, state) => {
    try {
      const data = readData();
      data.settings = data.settings || {};
      data.settings.chatRoomState = state;
      await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        false, data.chatHistory, data.chatRooms, data.chatHistoryStore, data.chatHistoryLimit
      );
    } catch (e) { console.error('[chat-room-save-state-sync] 保存失败:', e); }
  });

  // 聊天记录存储（按聊天室/智能体隔离）
  ipcMain.handle('chat-history-get', async (event, { type, id }) => {
    // type: 'private' | 'room', id: agentPresetId | roomId
    const data = readData();
    const store = data.chatHistoryStore || {};
    const key = type === 'private' ? `private:${id}` : `room:${id}`;
    return store[key] || [];
  });

  ipcMain.handle('chat-history-save', async (event, { type, id, history }) => {
    try {
      const data = readData();
      const store = data.chatHistoryStore || {};
      const key = type === 'private' ? `private:${id}` : `room:${id}`;
      store[key] = history || [];
      // ★ 修复：新版存储接管后，清除旧版 chatHistory 避免云端同步时旧数据复活
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        false, [], data.chatRooms, store, data.chatHistoryLimit
      );
      return { success: writeResult.success, message: writeResult.message };
    } catch (e) {
      console.error('[chat-history-save] 异常:', e.stack || e);
      return { success: false, message: '保存聊天记录异常: ' + (e.message || e) };
    }
    });

  // ★ 直接保存 chatHistoryStore（供渲染进程清理残留数据用）
  ipcMain.handle('chat-history-store-save', async (event, store) => {
    try {
      const data = readData();
      // ★ 修复：新版存储接管后，清除旧版 chatHistory 避免云端同步时旧数据复活
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        false, [], data.chatRooms, store, data.chatHistoryLimit
      );
      return { success: writeResult.success, message: writeResult.message };
    } catch (e) {
      console.error('[chat-history-store-save] 异常:', e.stack || e);
      return { success: false, message: '保存聊天记录存储异常: ' + (e.message || e) };
    }
  });

  ipcMain.handle('chat-room-delete-history', async (event, roomId) => {
    try {
      const data = readData();
      const store = data.chatHistoryStore || {};
      const key = `room:${roomId}`;
      delete store[key];
      // 记录聊天室删除墓碑，供云同步传播
      if (!data.deletedItems) data.deletedItems = {};
      if (!data.deletedItems.chatRooms) data.deletedItems.chatRooms = [];
      if (!data.deletedItems.chatRooms.includes(String(roomId))) {
        data.deletedItems.chatRooms.push(String(roomId));
      }
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        false, data.chatHistory, data.chatRooms, store, data.chatHistoryLimit,
        data.deletedItems
      );
      return { success: writeResult.success, message: writeResult.message };
    } catch (e) {
      console.error('[chat-room-delete-history] 异常:', e.stack || e);
      return { success: false, message: '删除聊天记录异常: ' + (e.message || e) };
    }
  });

  // 聊天记录上限
  ipcMain.handle('chat-history-limit-get', () => {
    const data = readData();
    return data.chatHistoryLimit ?? 50;
  });

  ipcMain.handle('chat-history-limit-set', async (event, limit) => {
    const data = readData();
    const writeResult = await writeData(
      data.tasks, data.memos, data.expenses, data.budgets,
      data.settings, data.translationStats, data.categoryBudgets || [],
      data.secrets || [], data.journals || [],
      false, data.chatHistory, data.chatRooms, data.chatHistoryStore, limit
    );
    return { success: writeResult.success };
  });

  // 获取所有聊天记录（云端同步用）
  ipcMain.handle('chat-history-get-all-store', () => {
    const data = readData();
    return {
      chatHistory: data.chatHistory || [],
      chatHistoryStore: data.chatHistoryStore || {},
      chatRooms: data.chatRooms || [],
      chatHistoryLimit: data.chatHistoryLimit ?? 50
    };
  });

  ipcMain.handle('chat-history-save-all-store', async (event, storeData) => {
    const data = readData();
    const writeResult = await writeData(
      data.tasks, data.memos, data.expenses, data.budgets,
      data.settings, data.translationStats, data.categoryBudgets || [],
      data.secrets || [], data.journals || [],
      false, storeData.chatHistory, storeData.chatRooms, storeData.chatHistoryStore, storeData.chatHistoryLimit
    );
    return { success: writeResult.success };
  });

  // ============================================================
  // 数据标签（创建者标签）
  // ============================================================

  ipcMain.handle('creator-tag-set', async (event, { type, itemId, creatorName }) => {
    const data = readData();
    let collection;
    switch (type) {
      case 'task': collection = data.tasks; break;
      case 'memo': collection = data.memos; break;
      case 'expense': collection = data.expenses; break;
      case 'journal': collection = data.journals; break;
      default: return { success: false, message: '不支持的类型' };
    }
    const index = collection.findIndex(item => String(item.id) === String(itemId));
    if (index !== -1) {
      collection[index].creator = creatorName || '我';
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        true, data.chatHistory, data.chatRooms, data.chatHistoryStore, data.chatHistoryLimit
      );
      return { success: writeResult.success };
    }
    return { success: false, message: '未找到项目' };
  });

  ipcMain.handle('creator-tag-migrate-legacy', async (event, { userName }) => {
    // 给所有没有 creator 标签的历史数据打上用户名标签
    const data = readData();
    let migratedCount = 0;
    const collections = [
      { name: 'tasks', items: data.tasks },
      { name: 'memos', items: data.memos },
      { name: 'expenses', items: data.expenses },
      { name: 'journals', items: data.journals }
    ];
    for (const col of collections) {
      for (const item of col.items) {
        if (!item.creator) {
          item.creator = userName || '我';
          migratedCount++;
        }
      }
    }
    if (migratedCount > 0) {
      const writeResult = await writeData(
        data.tasks, data.memos, data.expenses, data.budgets,
        data.settings, data.translationStats, data.categoryBudgets || [],
        data.secrets || [], data.journals || [],
        true, data.chatHistory, data.chatRooms, data.chatHistoryStore, data.chatHistoryLimit
      );
      return { success: writeResult.success, migratedCount };
    }
    return { success: true, migratedCount: 0 };
  });
}

// 屏幕取色器相关函数
function openColorPicker(memoId) {
  if (colorPickerWindow && !colorPickerWindow.isDestroyed()) {
    colorPickerWindow.focus();
    return;
  }

  const { desktopCapturer, screen } = require('electron');
  const displays = screen.getAllDisplays();
  const primaryDisplay = displays[0];
  
  // 创建全屏取色器窗口
  colorPickerWindow = new BrowserWindow({
    width: primaryDisplay.bounds.width,
    height: primaryDisplay.bounds.height,
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  colorPickerCallback = memoId;

  colorPickerWindow.loadFile('color-picker.html');
  
  colorPickerWindow.on('closed', () => {
    colorPickerWindow = null;
    colorPickerCallback = null;
  });

  // 捕获屏幕截图
  desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: primaryDisplay.bounds.width,
      height: primaryDisplay.bounds.height
    }
  }).then(sources => {
    if (sources.length > 0 && colorPickerWindow && !colorPickerWindow.isDestroyed()) {
      const dataUrl = sources[0].thumbnail.toDataURL();
      colorPickerWindow.webContents.send('init-picker', { dataUrl: dataUrl });
    }
  }).catch(err => {
    safeError('捕获屏幕失败:', err);
  });
}

const exePath = path.dirname(app.getPath('exe'));
const customUserDataPath = path.join(exePath, 'app-cache');

if (!fs.existsSync(customUserDataPath)) {
  fs.mkdirSync(customUserDataPath, { recursive: true });
}

app.setPath('userData', customUserDataPath);

let cleanupEmptyDirsInterval;

async function scheduleEmptyDirCleanup() {
  const cleanupTask = async () => {
    try {
      if (cloudSync) {
        await cloudSync.cleanupEmptyDirectories(true);
      } else {
        const settings = readData().settings || {};
        const appId = settings.cloudAppId || '';
        const appKey = settings.cloudAppKey || '';
        const appSecret = settings.cloudAppSecret || '';
        
        if (appId && appKey && appSecret) {
          cloudSync = new CloudSync();
          await cloudSync.init({
            appId: appId,
            appKey: appKey,
            appSecret: appSecret,
            token: settings.cloudToken || '',
            refreshToken: settings.cloudRefreshToken || '',
            tokenExpireTime: settings.cloudTokenExpireTime || 0,
            onTokenUpdate: async (tokenData) => {
              const currentData = readData();
              currentData.settings = currentData.settings || {};
              currentData.settings.cloudToken = tokenData.token;
              currentData.settings.cloudRefreshToken = tokenData.refreshToken;
              currentData.settings.cloudTokenExpireTime = tokenData.tokenExpireTime;
              await writeData(
                currentData.tasks,
                currentData.memos,
                currentData.expenses,
                currentData.budgets,
                currentData.settings,
                currentData.translationStats,
                currentData.categoryBudgets || [],
                currentData.secrets || []
              );
            }
          });
          await cloudSync.cleanupEmptyDirectories(true);
        }
      }
    } catch (e) {
      safeError('定时清理空目录失败:', e);
    }
  };

  cleanupTask();
  // 周期从 24 小时缩短到 4 小时，避免空目录生成速度超过清理速度
  cleanupEmptyDirsInterval = setInterval(cleanupTask, 4 * 60 * 60 * 1000);
}

// ★ 单实例锁：关闭窗口仅隐藏（托盘常驻），用户易在不知情时多开实例，
//   多个实例同时读写 data.json 会互相覆盖，且旧实例可能运行修复前的旧代码（如提醒删除 IPC 缺失）。
//   抢锁失败 → 本实例直接退出；二次启动 → 聚焦已有实例主窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  safeLog('[启动] 检测到已有 Elysia 实例在运行，本实例自动退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    safeLog('[启动] 收到二次启动请求，聚焦已有实例主窗口');
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (e) {
      safeError('[启动] 聚焦已有窗口失败:', e);
    }
  });
}

app.whenReady().then(() => {
  cleanupForeignUserData();
  
  try {
    cleanupDuplicateData();
  } catch (e) {
    console.error('启动时清理重复数据失败:', e);
  }
  
  createMainWindow();
  createTray();
  setupGlobalHotkeys();
  setupAutoLaunch();
  setupIpcHandlers();

  // ★ 提醒触发成功 → 任务栏闪烁（回调注册；模块缺失/异常不影响应用启动）
  if (reminderManager && typeof reminderManager.setOnReminderFired === 'function') {
    try {
      reminderManager.setOnReminderFired(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
        } catch (e) {
          safeLog('[提醒] flashFrame 失败: ' + e.message);
        }
      });
    } catch (e) {
      safeError('[提醒] 注册 reminder-fired 回调失败:', e);
    }
  }

  // MC 后端集成（失败不影响 Elysia 主流程）
  // ★ 先尝试从百度网盘恢复 sanctuary.db（如果云端版本更新）
  try { restoreMCDbFromCloud(); } catch(_) {}
  try { require('./mc-bridge').initMC(); } catch(e){ console.error('[MC] init skipped:', e.message); }

  checkInterval = setTimeout(() => checkReminders(), 30000);
  
  // ★ 提醒调度器启动（独立于任务截止弹窗 checkReminders；30s tick）
  if (reminderManager && typeof reminderManager.startReminderScheduler === 'function') {
    try { reminderManager.startReminderScheduler(); } catch (e) { safeError('[提醒] 启动调度器失败:', e); }
  }
  
  scheduleEmptyDirCleanup();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanupResources();
  }
});
