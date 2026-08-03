const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const AutoLaunch = require('auto-launch');
const { safeLog, safeError, getCurrentVersion, getCurrentAppPath, sendToAllWindows } = require('./main-utils');
const { readData, writeData, invalidateCache } = require('./data-service');

// 备份管理（纯数据操作，不依赖 cloudSync 实例）
let lastBackupTime = 0;
let lastBackupHash = '';

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
  const jsonStr = JSON.stringify(data, (key, value) => {
    if (key === 'id' || key === 'createdAt' || key === 'lastModified') {
      return undefined;
    }
    return value;
  });
  return crypto.createHash('md5').update(jsonStr).digest('hex');
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

      if (age > thirtyDays) continue;

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

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          backupData = JSON.parse(content);
          memoCount = backupData.data?.memos?.length || 0;
          taskCount = backupData.data?.tasks?.length || 0;
          expenseCount = backupData.data?.expenses?.length || 0;
          budgetCount = backupData.data?.budgets?.length || 0;
          journalCount = backupData.data?.journals?.length || 0;
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
          journalCount: journalCount
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return { success: true, data: files };
  } catch (error) {
    safeError('[版本管理] 获取备份列表失败:', error);
    return { success: false, message: error.message };
  }
}

function restoreFromBackup(fileName) {
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
    writeData(
      data.tasks || [],
      data.memos || [],
      data.expenses || [],
      data.budgets || [],
      data.settings || {},
      data.translationStats || {},
      data.categoryBudgets || [],
      data.secrets || [],
      data.journals || []
    );

    sendToAllWindows('tasks-updated');
    sendToAllWindows('memos-updated');
    sendToAllWindows('expenses-updated');
    sendToAllWindows('journals-updated');

    return { success: true, message: '数据恢复成功' };
  } catch (error) {
    safeError('[版本管理] 恢复备份失败:', error);
    return { success: false, message: error.message };
  }
}

function deleteBackup(fileName) {
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
    cloudCurrentUserId: localSettings.cloudCurrentUserId || 'admin'
  };
}

let autoLauncher = null;

function setupAutoLaunch() {
  try {
    const exePath = app.getPath('exe');
    autoLauncher = new AutoLaunch({
      name: 'Elysia',
      path: exePath,
      isHidden: true
    });
  } catch (e) {
    safeError('设置自动启动失败:', e);
  }
}

function setupSettingsServiceIpc() {
  // 开机自启
  autoLauncher = autoLauncher || (() => {
    try {
      const exePath = app.getPath('exe');
      return new AutoLaunch({
        name: 'Elysia',
        path: exePath,
        isHidden: true
      });
    } catch (e) {
      safeError('创建自动启动失败:', e);
      return { isEnabled: async () => false, enable: async () => {}, disable: async () => {} };
    }
  })();

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

  // 设置读取/保存
  ipcMain.handle('get-settings', () => {
    const data = readData();
    return data.settings || {};
  });

  ipcMain.handle('save-settings', (event, newSettings) => {
    const data = readData();
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
      chatOverlayOpacity: data.settings.chatOverlayOpacity
    };

    const mergedSettings = { ...preservedSettings, ...newSettings };
    const writeResult = writeData(data.tasks, data.memos, data.expenses, data.budgets, mergedSettings, data.translationStats, data.categoryBudgets || [], data.secrets || [], data.journals || []);
    return { success: writeResult.success, message: writeResult.message };
  });

  // 翻译统计
  ipcMain.handle('get-translation-stats', () => {
    const data = readData();
    return data.translationStats || {};
  });

  ipcMain.handle('update-translation-stats', (event, stats) => {
    const data = readData();
    data.translationStats = stats;
    const writeResult = writeData(data.tasks, data.memos, data.expenses, data.budgets, data.settings, data.translationStats, data.categoryBudgets || [], data.secrets || [], data.journals || []);
    return { success: writeResult.success, message: writeResult.message };
  });

  // 资源路径
  ipcMain.handle('get-resources-path', () => {
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

  // 备份管理
  ipcMain.handle('backup-list', () => {
    return listBackupVersions();
  });

  ipcMain.handle('backup-restore', (event, fileName) => {
    return restoreFromBackup(fileName);
  });

  ipcMain.handle('backup-delete', (event, fileName) => {
    return deleteBackup(fileName);
  });

  // 数据清理
  ipcMain.handle('cleanup-duplicates', () => {
    const { cleanupDuplicateData } = require('./data-service');
    return cleanupDuplicateData();
  });

  // 确认对话框
  ipcMain.handle('show-confirm-dialog', async (event, options) => {
    try {
      const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: options.title || '确认',
        message: options.message || '',
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

  // 云版本信息
  ipcMain.handle('get-cloud-version', () => {
    try {
      const cloudSyncPath = (readData().settings || {}).cloudSyncPath;
      if (cloudSyncPath && fs.existsSync(cloudSyncPath)) {
        const versionFile = path.join(cloudSyncPath, 'version.txt');
        if (fs.existsSync(versionFile)) {
          const content = fs.readFileSync(versionFile, 'utf8');
          const match = content.match(/版本号[：:]\s*([\d.]+)/);
          if (match) {
            return { success: true, version: match[1] };
          }
        }
      }
      return { success: true, version: null };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });
}

function getResourcesPath() {
  const resourcesPath = path.join(getCurrentAppPath(), '..', '背景图');
  if (fs.existsSync(resourcesPath)) {
    return resourcesPath;
  }
  return path.join(getCurrentAppPath(), '背景图');
}

module.exports = {
  setupSettingsServiceIpc,
  setupAutoLaunch,
  getBackupDir,
  generateDataHash,
  backupDataVersion,
  cleanupOldVersions,
  listBackupVersions,
  restoreFromBackup,
  deleteBackup,
  mergeSettings,
  getResourcesPath
};
