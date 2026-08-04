const path = require('path');
const fs = require('fs');
const { BrowserWindow, nativeImage, app } = require('electron');

/**
 * 获取应用用户数据目录路径
 */
function getUserDataPath() {
  return app.getPath('userData');
}

// ★ 日志大小上限：超过后轮转归档（保留最近 2 份），防止 app.log 无限膨胀
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * 日志文件超过上限时轮转：app.log → app.log.old → app.log.old2
 */
function rotateLogIfNeeded(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= MAX_LOG_SIZE) return;
    const bakPath = logPath + '.old';
    const oldBakPath = logPath + '.old2';
    if (fs.existsSync(bakPath)) {
      fs.renameSync(bakPath, oldBakPath);
    }
    fs.renameSync(logPath, bakPath);
  } catch (e) {
  }
}

/**
 * 安全写入日志
 */
function safeLog(...args) {
  try {
    const logPath = path.join(getUserDataPath(), 'app.log');
    rotateLogIfNeeded(logPath);
    const logLine = `[${new Date().toISOString()}] ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ')}\n`;
    fs.appendFileSync(logPath, logLine);
  } catch (e) {
  }
}

/**
 * 安全写入错误日志
 */
function safeError(...args) {
  try {
    const logPath = path.join(getUserDataPath(), 'error.log');
    rotateLogIfNeeded(logPath);
    const logLine = `[${new Date().toISOString()}] ERROR: ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ')}\n`;
    fs.appendFileSync(logPath, logLine);
    console.error('[Elysia Error]', ...args);
  } catch (e) {
    console.error('[Elysia] Failed to write error log:', e);
  }
}

/**
 * 标准化日期字符串为 YYYY-MM-DD 格式
 */
function normalizeDate(dateStr) {
  if (!dateStr) return '';

  if (typeof dateStr === 'string') {
    const tIndex = dateStr.indexOf('T');
    if (tIndex !== -1) {
      return dateStr.substring(0, tIndex);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }
  }

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return String(dateStr);
  return date.toISOString().split('T')[0];
}

/**
 * 生成数据项的内容哈希，用于去重
 */
function generateContentHash(item) {
  if (!item) return '';

  // ★ 修复：必须把 id 纳入哈希。否则"金额+类型+分类+日期"相同的两条不同收支
  // 会产生相同哈希，在同步合并的 processedContentHashes 去重中，
  // 本地新增的收支会被当成"重复项"静默丢弃（症状：新增收支同步后消失）。
  // 同时收支字段是 detail 而非 description，原先 description 恒为 '' 也削弱了区分度。
  const idPart = item.id != null ? String(item.id) : '';

  if (item.amount !== undefined) {
    const date = normalizeDate(item.date || item.createdAt || item.time || '');
    const category = item.category || (item.tags && Array.isArray(item.tags) ? item.tags.join(',') : '');
    return `${item.amount}|${item.type}|${category}|${date}|${item.detail || ''}|${idPart}`;
  }

  if (item.title !== undefined) {
    const date = normalizeDate(item.startDate || item.createdAt || item.date || item.lastUpdated || '');
    const category = item.category || (item.tags && Array.isArray(item.tags) ? item.tags.join(',') : '');
    return `${item.title}|${item.description || ''}|${item.content || ''}|${category}|${date}|${idPart}`;
  }

  if (item.name !== undefined) {
    const date = normalizeDate(item.createdAt || item.date || '');
    return `${item.name}|${item.amount || ''}|${item.type || ''}|${date}|${idPart}`;
  }

  // 兜底：JSON 序列化已包含 id，天然唯一
  return JSON.stringify(item);
}

/**
 * 向所有已打开的窗口发送消息
 */
function sendToAllWindows(channel, ...args) {
  BrowserWindow.getAllWindows().forEach(window => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  });
}

/**
 * 获取当前应用可执行文件所在目录路径
 */
function getCurrentAppPath() {
  if (app.isPackaged) {
    return path.dirname(app.getPath('exe'));
  } else {
    return app.getAppPath();
  }
}

/**
 * 将图片转为灰度图（测试版标识）
 */
function grayscaleImage(image) {
  try {
    const size = image.getSize();
    const width = size.width;
    const height = size.height;
    const bitmap = image.toBitmap();

    for (let i = 0; i < bitmap.length; i += 4) {
      const r = bitmap[i];
      const g = bitmap[i + 1];
      const b = bitmap[i + 2];
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      bitmap[i] = gray;
      bitmap[i + 1] = gray;
      bitmap[i + 2] = gray;
    }

    return nativeImage.createFromBitmap(bitmap, width, height);
  } catch (e) {
    return image;
  }
}

/**
 * 递归复制文件夹
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 获取当前应用程序版本号
 */
function getCurrentVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    return packageJson.version || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

module.exports = {
  getUserDataPath,
  safeLog,
  safeError,
  normalizeDate,
  generateContentHash,
  sendToAllWindows,
  getCurrentAppPath,
  grayscaleImage,
  copyDirSync,
  getCurrentVersion
};
