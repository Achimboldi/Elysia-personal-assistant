/**
 * reminder-manager.js — Elysia「提醒」模块（主进程单文件收口）
 *
 * 职责：
 *   1. 数据层   ：settings.reminders 读写（list/save/delete/setEnabled），写盘统一走
 *                 data-service.writeData 的 settings 合并路径（方案 A，云同步天然覆盖）。
 *   2. 频率计算 ：computeNextTriggerAt 纯函数，支持 8 种 schedule 类型 + dateRange 边界。
 *   3. 调度器   ：30s 递归 setTimeout、单飞、isFiring 守卫、错过不补发推进、once 过期停用。
 *   4. 执行器   ：fireReminder（系统消息落库 → prompt 非空走 streamChat → 降级 → history 20 条）。
 *   5. IPC      ：reminders-get / save / delete / set-enabled / trigger-now + reminders-updated 广播。
 *
 * 约束（架构文档 §8）：
 *   - 数据只存 settings.reminders；时间戳统一 ISO 字符串；id 用 utils.generateId()；
 *   - 执行器 abort 用独立 reminderStreamAbortController，禁止动 chatStreamAbortController；
 *   - 流式广播复用 chat-chunk 事件；electron 相关 require 用 try/catch 包裹（测试环境无 electron）。
 */

// ── electron（try/catch：纯 node 单测环境无 electron，模块加载不崩溃）──
let ipcMain = null;
let BrowserWindow = null;
try {
  const electron = require('electron');
  ipcMain = electron.ipcMain;
  BrowserWindow = electron.BrowserWindow;
} catch (e) {
  // 测试环境：无 electron 属正常，IPC/广播能力降级为空实现
}

const { readData, writeData } = require('./data-service');
const { safeLog, safeError, sendToAllWindows } = require('./main-utils');
const { streamChat } = require('./xilian-agent');
const { generateId } = require('./utils');

// ============================================================
// 常量
// ============================================================
const CHECK_INTERVAL_MS = 30 * 1000;      // 调度器 tick 间隔
const TRIGGER_WINDOW_MS = 60 * 1000;      // 触发窗口（now-60s ~ now）
const REMINDER_HISTORY_LIMIT = 20;        // 执行历史保留条数
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ============================================================
// 调度器状态（模块级私有）
// ============================================================
let reminderCheckTimer = null;            // 递归 setTimeout 句柄
let reminderChecking = false;             // 单飞标志
let reminderFiring = new Set();           // isFiring 守卫（reminder.id）
let reminderStreamAbortController = null; // 执行器独立 abort（勿动 chatStreamAbortController）
let ipcRegistered = false;                // IPC 幂等注册守卫
let onReminderFiredCallback = null;       // 提醒触发成功回调（main.js 注册 → 任务栏闪烁）

/**
 * 注册提醒触发成功回调（幂等覆盖；非函数则清空）
 * @param {Function|null} fn
 */
function setOnReminderFired(fn) {
  onReminderFiredCallback = typeof fn === 'function' ? fn : null;
}

// ============================================================
// 纯函数：时间解析 / 频率计算
// ============================================================

/**
 * 解析 HH:mm 为 {h, min}，非法返回 null
 * @param {string} timeStr
 * @returns {{h:number, min:number}|null}
 */
function parseTime(timeStr) {
  if (typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

/**
 * 解析 YYYY-MM-DD 为本地时区 Date（当天 00:00），非法返回 null
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseDateOnly(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

/**
 * daily / workday / restday 候选：从 from 当天起逐日找首个满足星期条件且严格 > from 的时间点
 */
function nextDailyLike(schedule, from, weekdayFilter) {
  const t = parseTime(schedule.time);
  if (!t) return null;
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, t.h, t.min, 0, 0);
    if (cand.getTime() <= from.getTime()) continue;
    if (weekdayFilter && !weekdayFilter(cand.getDay())) continue;
    return cand;
  }
  return null;
}

/**
 * weekly 候选：weekday 多选（0=周日），从 from 当天起逐日找
 */
function nextWeekly(schedule, from) {
  const weekdays = (schedule.weekday || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  if (weekdays.length === 0) return null;
  return nextDailyLike(schedule, from, day => weekdays.includes(day));
}

/**
 * monthly 候选：dayOfMonth 超限取当月最后一天；从 from 所在月起逐月找（最多 12 个月防死循环）
 */
function nextMonthly(schedule, from) {
  const dayOfMonth = Number(schedule.dayOfMonth);
  const t = parseTime(schedule.time);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31 || !t) return null;
  const year = from.getFullYear();
  const month = from.getMonth();
  for (let i = 0; i < 12; i++) {
    const d = new Date(year, month + i, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const day = Math.min(dayOfMonth, lastDay);
    const cand = new Date(d.getFullYear(), d.getMonth(), day, t.h, t.min, 0, 0);
    if (cand.getTime() > from.getTime()) return cand;
  }
  return null;
}

/**
 * yearly 候选：month 1-12、dayOfMonth 超限取当月最后一天；当年已过则下一年
 */
function nextYearly(schedule, from) {
  const month = Number(schedule.month);
  const dayOfMonth = Number(schedule.dayOfMonth);
  const t = parseTime(schedule.time);
  if (!Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31 || !t) {
    return null;
  }
  const build = (y) => {
    const lastDay = new Date(y, month, 0).getDate(); // month 1-12 → 索引 month-1；day 0 = 上月末
    const day = Math.min(dayOfMonth, lastDay);
    return new Date(y, month - 1, day, t.h, t.min, 0, 0);
  };
  const candThis = build(from.getFullYear());
  if (candThis.getTime() > from.getTime()) return candThis;
  return build(from.getFullYear() + 1);
}

/**
 * interval 候选：以 startAt（缺省=from）为固定锚点，返回锚点 + k*intervalMinutes 中首个严格 > from 的点
 * 使用固定锚点累加，避免重启后漂移；连续两次计算单调递增。
 */
function nextInterval(schedule, from) {
  const intervalMinutes = Number(schedule.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) return null;
  const intervalMs = intervalMinutes * 60 * 1000;
  let anchor = schedule.startAt ? new Date(schedule.startAt) : new Date(from);
  if (isNaN(anchor.getTime())) anchor = new Date(from);
  const fromTime = from.getTime();
  if (anchor.getTime() > fromTime) {
    // startAt 在未来 → 下一个触发点就是 startAt 本身
    return anchor;
  }
  const k = Math.floor((fromTime - anchor.getTime()) / intervalMs) + 1;
  return new Date(anchor.getTime() + k * intervalMs);
}

/**
 * once 候选：datetime 严格 > from 才有效，否则过期（null）
 */
function nextOnce(schedule, from) {
  const dt = new Date(schedule.datetime);
  if (isNaN(dt.getTime())) return null;
  if (dt.getTime() > from.getTime()) return dt;
  return null;
}

/**
 * 按 schedule.type 计算候选时间点（严格 > fromDate）
 * @param {Object} schedule
 * @param {Date} from
 * @returns {Date|null}
 */
function computeCandidate(schedule, from) {
  switch (schedule.type) {
    case 'daily':
      return nextDailyLike(schedule, from, null);
    case 'weekly':
      return nextWeekly(schedule, from);
    case 'workday':
      return nextDailyLike(schedule, from, day => day >= 1 && day <= 5);
    case 'restday':
      return nextDailyLike(schedule, from, day => day === 0 || day === 6);
    case 'monthly':
      return nextMonthly(schedule, from);
    case 'yearly':
      return nextYearly(schedule, from);
    case 'interval':
      return nextInterval(schedule, from);
    case 'once':
      return nextOnce(schedule, from);
    default:
      return null;
  }
}

/**
 * 计算下一个触发时间（纯函数，不依赖任何外部状态）
 *
 * @param {Object} schedule   schedule 结构（见架构 §2.3）
 * @param {Date|string} fromDate  起始时间（严格 > fromDate；interval 同时作为锚点缺省值）
 * @param {Object} [dateRange]    {start:'YYYY-MM-DD'|null, end:'YYYY-MM-DD'|null}，null=不限
 * @returns {Date|null} 下一个触发时间；超出 dateRange / 永不触发返回 null
 */
function computeNextTriggerAt(schedule, fromDate, dateRange) {
  if (!schedule || !schedule.type) return null;
  const from = fromDate instanceof Date ? new Date(fromDate) : new Date(fromDate);
  if (isNaN(from.getTime())) return null;

  const range = dateRange || {};
  const rangeStart = range.start ? parseDateOnly(range.start) : null;
  const rangeEnd = range.end ? parseDateOnly(range.end) : null;
  const startDay = rangeStart ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate(), 0, 0, 0, 0) : null;
  const endDay = rangeEnd ? new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), 23, 59, 59, 999) : null;

  // 已过有效期 → 永不触发
  if (endDay && endDay.getTime() < from.getTime()) return null;

  let current = from;
  // 最多 2 轮：候选早于 start → 从 start 当天 00:00 重算一次（once 已过期会自然返回 null）
  for (let guard = 0; guard < 2; guard++) {
    const candidate = computeCandidate(schedule, current);
    if (!candidate) return null;
    if (endDay && candidate.getTime() > endDay.getTime()) return null;
    if (startDay && candidate.getTime() < startDay.getTime()) {
      current = startDay;
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * 由 reminder 对象计算 nextTriggerAt 的 ISO 字符串
 * @param {Object} reminder
 * @param {Date} [fromOverride] 覆盖起始时间（错过推进时传 now，保证严格未来）
 * @returns {string|null}
 */
function computeNextTriggerIso(reminder, fromOverride) {
  const from = fromOverride || (reminder.lastTriggeredAt ? new Date(reminder.lastTriggeredAt) : new Date());
  const next = computeNextTriggerAt(reminder.schedule, from, reminder.dateRange);
  return next ? next.toISOString() : null;
}

/**
 * 频率的人类可读描述（供工具层 / 测试 / 日志使用）
 * @param {Object} schedule
 * @returns {string}
 */
function describeSchedule(schedule) {
  if (!schedule || !schedule.type) return '未设置';
  const t = schedule.time || '';
  switch (schedule.type) {
    case 'daily':
      return `每天 ${t}`;
    case 'weekly': {
      const days = (schedule.weekday || []).map(d => WEEKDAY_NAMES[d]).join('、');
      return days ? `每周${days} ${t}` : `每周 ${t}`;
    }
    case 'workday':
      return `工作日 ${t}`;
    case 'restday':
      return `休息日 ${t}`;
    case 'monthly':
      return `每月${schedule.dayOfMonth}日 ${t}`;
    case 'yearly':
      return `每年${schedule.month}月${schedule.dayOfMonth}日 ${t}`;
    case 'interval':
      return `每${schedule.intervalMinutes}分钟`;
    case 'once':
      return '单次';
    default:
      return schedule.type;
  }
}

// ============================================================
// 数据层：settings.reminders 读写
// ============================================================

/**
 * 读取全部提醒（settings.reminders，无则空数组）
 * @returns {Array}
 */
function listReminders() {
  try {
    const data = readData();
    const settings = data.settings || {};
    return Array.isArray(settings.reminders) ? settings.reminders : [];
  } catch (e) {
    safeError('[提醒] listReminders 读取失败:', e);
    return [];
  }
}

/**
 * 持久化 reminders（settings 合并路径，不丢其它 settings 字段）
 * @param {Array} reminders
 * @param {boolean} [updateDataModified]
 * @returns {Promise<Object>} writeData 返回
 */
async function persistReminders(reminders, updateDataModified = false) {
  const data = readData();
  const settings = { ...(data.settings || {}), reminders };
  const writeResult = await writeData(
    data.tasks, data.memos, data.expenses, data.budgets,
    settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [],
    updateDataModified, data.chatHistory, data.chatRooms, data.chatHistoryStore,
    data.chatHistoryLimit, data.deletedItems
  );
  return writeResult;
}

/**
 * 广播数据变更（参照 tasks-updated）
 */
function broadcastRemindersUpdated() {
  try {
    if (typeof sendToAllWindows === 'function') {
      sendToAllWindows('reminders-updated');
    }
  } catch (e) {
    safeLog('[提醒] 广播 reminders-updated 失败: ' + e.message);
  }
}

/**
 * 新建 / 更新提醒（upsert）。写盘后广播 reminders-updated。
 * @param {Object} reminder
 * @param {Object} [options] { createdBy: 'user'|'agent' }
 * @returns {Promise<{success:boolean, message:string, reminder?:Object}>}
 */
async function saveReminder(reminder, options = {}) {
  const now = new Date().toISOString();
  const reminders = listReminders();
  const existing = reminder && reminder.id ? reminders.find(r => String(r.id) === String(reminder.id)) : null;

  if (existing) {
    const merged = { ...existing, ...reminder, updatedAt: now };
    merged.schedule = merged.schedule || {};
    merged.dateRange = merged.dateRange || { start: null, end: null };
    merged.enabled = merged.enabled !== false;
    merged.nextTriggerAt = computeNextTriggerIso(merged);
    if (merged.enabled === false) merged.nextTriggerAt = null;
    const idx = reminders.findIndex(r => String(r.id) === String(reminder.id));
    reminders[idx] = merged;
    const wr = await persistReminders(reminders);
    if (wr.success) broadcastRemindersUpdated();
    return {
      success: wr.success,
      message: wr.success ? '提醒已更新' : (wr.message || '保存失败'),
      reminder: merged
    };
  }

  const targetType = reminder.targetType === 'room' ? 'room' : 'private';
  const targetId = reminder.targetId || '';
  const newReminder = {
    id: generateId(),
    name: String(reminder.name || '').trim(),
    prompt: reminder.prompt || '',
    schedule: reminder.schedule || {},
    dateRange: reminder.dateRange || { start: null, end: null },
    notifyEnabled: !!reminder.notifyEnabled,
    notifyTime: reminder.notifyTime || '',
    notifyWeekday: Array.isArray(reminder.notifyWeekday) ? reminder.notifyWeekday : [],
    enabled: reminder.enabled !== false,
    targetType,
    targetId,
    agentPresetId: reminder.agentPresetId || targetId || '',
    createdBy: reminder.createdBy || options.createdBy || 'user',
    creator: reminder.creator || '',
    createdAt: now,
    updatedAt: now,
    lastTriggeredAt: null,
    nextTriggerAt: null,
    triggerCount: 0,
    history: []
  };
  newReminder.nextTriggerAt = computeNextTriggerIso(newReminder);
  if (newReminder.enabled === false) newReminder.nextTriggerAt = null;
  reminders.push(newReminder);
  const wr = await persistReminders(reminders);
  if (wr.success) broadcastRemindersUpdated();
  return {
    success: wr.success,
    message: wr.success ? '提醒已创建' : (wr.message || '保存失败'),
    reminder: newReminder
  };
}

/**
 * 删除提醒（MVP 不做墓碑——settings 为整体覆盖合并，墓碑无意义）
 * @param {string} id
 * @returns {Promise<{success:boolean, message:string}>}
 */
async function deleteReminder(id) {
  const reminders = listReminders();
  const idx = reminders.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return { success: false, message: '提醒不存在' };
  reminders.splice(idx, 1);
  const wr = await persistReminders(reminders);
  if (wr.success) broadcastRemindersUpdated();
  return { success: wr.success, message: wr.success ? '提醒已删除' : (wr.message || '删除失败') };
}

/**
 * 暂停 / 恢复提醒；暂停清空 nextTriggerAt，恢复重算。
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<{success:boolean, message:string, reminder?:Object}>}
 */
async function setReminderEnabled(id, enabled) {
  const reminders = listReminders();
  const r = reminders.find(x => String(x.id) === String(id));
  if (!r) return { success: false, message: '提醒不存在' };
  r.enabled = !!enabled;
  r.updatedAt = new Date().toISOString();
  if (!r.enabled) {
    r.nextTriggerAt = null;
  } else {
    r.nextTriggerAt = computeNextTriggerIso(r, new Date());
  }
  const wr = await persistReminders(reminders);
  if (wr.success) broadcastRemindersUpdated();
  return {
    success: wr.success,
    message: wr.success ? (r.enabled ? '提醒已恢复' : '提醒已暂停') : (wr.message || '操作失败'),
    reminder: r
  };
}

// ============================================================
// 调度器：30s 递归 setTimeout + 单飞 + isFiring
// ============================================================

/**
 * 启动调度器（main.js 启动钩子调用；幂等）
 */
function startReminderScheduler() {
  if (reminderCheckTimer) return;
  reminderCheckTimer = setTimeout(tickReminders, CHECK_INTERVAL_MS);
  safeLog('[提醒] 调度器已启动（30s tick）');
}

/**
 * 停止调度器（应用退出时进程回收，无需显式调用；保留供测试/调试）
 */
function stopReminderScheduler() {
  if (reminderCheckTimer) {
    clearTimeout(reminderCheckTimer);
    reminderCheckTimer = null;
  }
}

/**
 * 调度 tick：扫描到期提醒 → 触发；错过（超窗口）→ 推进不补发；once 过期 → 停用。
 */
async function tickReminders() {
  if (reminderChecking) {
    // 单飞：上一轮未结束，跳过本轮，仍排下一次
    reminderCheckTimer = setTimeout(tickReminders, CHECK_INTERVAL_MS);
    return;
  }
  reminderChecking = true;
  try {
    const now = Date.now();
    const reminders = listReminders();
    for (const r of reminders) {
      if (!r.enabled || !r.nextTriggerAt || reminderFiring.has(r.id)) continue;
      const t = new Date(r.nextTriggerAt).getTime();
      if (isNaN(t)) {
        await advanceNextTrigger(r);
        continue;
      }
      if (t <= now && t > now - TRIGGER_WINDOW_MS) {
        reminderFiring.add(r.id);
        try {
          await fireReminder(r, { manual: false });
        } catch (e) {
          safeError('[提醒] fireReminder 异常:', e);
        } finally {
          reminderFiring.delete(r.id);
        }
      } else if (t < now - TRIGGER_WINDOW_MS) {
        // 错过（关机/休眠/未启动）：不补发，直接推进到下一次；once 过期 → 停用
        await advanceNextTrigger(r);
      }
    }
  } catch (e) {
    safeError('[提醒] tickReminders 异常:', e);
  } finally {
    reminderChecking = false;
    reminderCheckTimer = setTimeout(tickReminders, CHECK_INTERVAL_MS);
  }
}

/**
 * 推进下次触发（错过策略）。once 过期 → enabled=false + nextTriggerAt=null。
 * @param {Object} reminder
 */
async function advanceNextTrigger(reminder) {
  const reminders = listReminders();
  const r = reminders.find(x => String(x.id) === String(reminder.id));
  if (!r) return;
  r.updatedAt = new Date().toISOString();
  if (r.schedule && r.schedule.type === 'once') {
    r.enabled = false;
    r.nextTriggerAt = null;
  } else {
    // 用 now 作为起始点，保证推进后的 next 严格在未来，避免反复推进
    r.nextTriggerAt = computeNextTriggerIso(r, new Date());
  }
  const wr = await persistReminders(reminders);
  if (wr.success) broadcastRemindersUpdated();
  else safeLog('[提醒] 推进下次触发写盘失败: ' + (wr.message || ''));
}

// ============================================================
// 执行器：fireReminder
// ============================================================

/**
 * 解析触发用智能体预设（agentPresetId → aiPresets；缺省回退当前/首个预设）
 * apiKey/baseUrl/model 缺失时回退 settings 顶层配置（与 chat-start-stream mergedConfig 一致）
 * @param {Object} reminder
 * @returns {Object|null}
 */
function resolvePreset(reminder) {
  const data = readData();
  const settings = data.settings || {};
  const presets = Array.isArray(settings.aiPresets) ? settings.aiPresets : [];
  if (presets.length === 0) return null;
  const presetId = reminder.agentPresetId || reminder.targetId || settings.aiCurrentPresetId || presets[0].id;
  const found =
    presets.find(p => p.id === presetId) ||
    presets.find(p => p.id === settings.aiCurrentPresetId) ||
    presets[0];
  if (!found) return null;
  return {
    ...found,
    apiKey: found.apiKey || settings.aiApiKey || '',
    baseUrl: found.baseUrl || settings.aiBaseUrl || 'https://api.deepseek.com',
    model: found.model || settings.aiModel || 'deepseek-v4-flash'
  };
}

/**
 * 向频道历史追加一条消息（chat-history-save 同款逻辑，走 data-service.writeData）
 * @param {'private'|'room'} type
 * @param {string} id
 * @param {Object} message
 */
async function appendChatMessage(type, id, message) {
  const data = readData();
  const store = data.chatHistoryStore || {};
  const key = type === 'private' ? `private:${id}` : `room:${id}`;
  const history = Array.isArray(store[key]) ? store[key] : [];
  history.push(message);
  store[key] = history;
  const writeResult = await writeData(
    data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [],
    false, [], data.chatRooms, store, data.chatHistoryLimit
  );
  if (!writeResult.success) {
    throw new Error(writeResult.message || '写入聊天历史失败');
  }
  // ★ 消息落库后广播，让渲染端昔涟聊天界面刷新（与 chat-history-save 路径一致）
  try {
    if (typeof sendToAllWindows === 'function') {
      sendToAllWindows('chat-history-updated', { type, id });
    }
  } catch (e) {
    safeLog('[提醒] 广播 chat-history-updated 失败: ' + e.message);
  }
  return writeResult;
}

/**
 * 截断 summary（执行历史用）
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateSummary(text, max = 50) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * 向所有窗口推送 chat-chunk（流式展示复用，不新增事件名）
 * @param {Object} payload
 */
function sendChatChunk(payload) {
  try {
    if (typeof sendToAllWindows === 'function') {
      sendToAllWindows('chat-chunk', payload);
    }
  } catch (e) {
    safeLog('[提醒] 推送 chat-chunk 失败: ' + e.message);
  }
}

/**
 * 执行一条提醒的完整触发流程（系统消息落库 → prompt 非空调 streamChat → 降级 → 状态落库）
 *
 * @param {Object} reminder
 * @param {Object} [options] { manual: boolean }
 * @returns {Promise<{success:boolean, message:string, status:string}>}
 */
async function fireReminder(reminder, options = {}) {
  const manual = !!options.manual;
  const nowIso = new Date().toISOString();
  const targetType = reminder.targetType === 'room' ? 'room' : 'private';
  const targetId = reminder.targetId || reminder.agentPresetId || '';
  const status = { ok: true, degraded: false, failed: false, summary: '' };

  try {
    if (!targetId) throw new Error('目标频道为空');

    // 1. 系统消息（固定落库；prompt 为空时即止，不调 LLM 省 token）
    const sysContent = `提醒「${reminder.name}」到时间了` + (reminder.prompt ? `\n内容：${reminder.prompt}` : '');
    const sysMsg = {
      id: generateId(),
      role: 'system',
      content: sysContent,
      toolCalls: null,
      toolCallId: null,
      timestamp: Date.now(),
      userId: 'admin'
    };
    await appendChatMessage(targetType, targetId, sysMsg);

    // 2. prompt 非空 && 有 API Key → 调 streamChat；否则降级系统消息
    const promptText = (reminder.prompt || '').trim();
    if (promptText) {
      const preset = resolvePreset(reminder);
      if (preset && preset.apiKey) {
        try {
          const content = await runReminderStream(reminder, targetType, targetId, preset);
          status.summary = truncateSummary(content || '（无输出）');
        } catch (llmErr) {
          safeError('[提醒] LLM 执行失败:', llmErr);
          status.degraded = true;
          status.summary = truncateSummary(llmErr.message || '智能体调用失败');
          const degradeMsg = {
            id: generateId(),
            role: 'system',
            content: '（智能体暂时不可用，仅系统提醒）',
            toolCalls: null,
            toolCallId: null,
            timestamp: Date.now(),
            userId: 'admin'
          };
          await appendChatMessage(targetType, targetId, degradeMsg);
        }
      } else {
        status.degraded = true;
        status.summary = '未配置 API Key，仅系统提醒';
        const degradeMsg = {
          id: generateId(),
          role: 'system',
          content: '（未配置 API Key，仅系统提醒）',
          toolCalls: null,
          toolCallId: null,
          timestamp: Date.now(),
          userId: 'admin'
        };
        await appendChatMessage(targetType, targetId, degradeMsg);
      }
    } else {
      status.summary = '系统消息（无提示词）';
    }

    // 3. 更新 reminder 状态：lastTriggeredAt / triggerCount / nextTriggerAt / history(20)
    await updateAfterFire(reminder.id, nowIso, status, manual);

    safeLog(`[提醒] 触发完成: ${reminder.name} (${manual ? '手动' : '自动'}) status=${status.degraded ? 'degraded' : 'ok'}`);
    // ★ 通知主进程（任务栏闪烁）与渲染端（昔涟红点）；任一失败不影响触发结果
    if (onReminderFiredCallback) {
      try { onReminderFiredCallback(reminder); } catch (e) { safeLog('[提醒] onReminderFired 回调异常: ' + e.message); }
    }
    try {
      if (typeof sendToAllWindows === 'function') {
        sendToAllWindows('reminder-fired', {
          name: reminder.name,
          agentName: (resolvePreset(reminder) || {}).name || '昔涟'
        });
      }
    } catch (e) {
      safeLog('[提醒] 广播 reminder-fired 失败: ' + e.message);
    }
    return {
      success: true,
      message: status.degraded ? '已触发（降级）' : '已触发',
      status: status.degraded ? 'degraded' : 'ok'
    };
  } catch (e) {
    safeError('[提醒] fireReminder 异常:', e);
    status.failed = true;
    status.summary = truncateSummary(e.message || '触发失败');
    try {
      await updateAfterFire(reminder.id, nowIso, status, manual);
    } catch (e2) {
      safeError('[提醒] 更新状态失败:', e2);
    }
    return { success: false, message: '触发失败: ' + (e.message || e), status: 'failed' };
  }
}

/**
 * 触发后更新 reminder 状态并落库广播
 * @param {string} id
 * @param {string} nowIso
 * @param {Object} status  {ok, degraded, failed, summary}
 * @param {boolean} manual 手动触发不改变下次调度（once 除外）
 */
async function updateAfterFire(id, nowIso, status, manual) {
  const reminders = listReminders();
  const idx = reminders.findIndex(x => String(x.id) === String(id));
  if (idx === -1) return;
  const r = reminders[idx];
  r.lastTriggeredAt = nowIso;
  r.triggerCount = (r.triggerCount || 0) + 1;
  r.updatedAt = nowIso;
  if (!manual) {
    r.nextTriggerAt = computeNextTriggerIso(r);
  }
  if (r.schedule && r.schedule.type === 'once') {
    // 单次提醒触发后即完成：停用 + 清空下次触发
    r.enabled = false;
    r.nextTriggerAt = null;
  }
  const historyEntry = {
    triggeredAt: nowIso,
    status: status.failed ? 'failed' : (status.degraded ? 'degraded' : 'ok'),
    summary: status.summary || '',
    agentName: (resolvePreset(r) || {}).name || '昔涟'
  };
  r.history = [historyEntry, ...(Array.isArray(r.history) ? r.history : [])].slice(0, REMINDER_HISTORY_LIMIT);
  const wr = await persistReminders(reminders);
  if (wr.success) broadcastRemindersUpdated();
  else safeLog('[提醒] 触发后状态写盘失败: ' + (wr.message || ''));
}

/**
 * 调 streamChat 生成提醒正文（流式广播 chat-chunk；独立 abort controller）
 * @param {Object} reminder
 * @param {'private'|'room'} targetType
 * @param {string} targetId
 * @param {Object} preset
 * @returns {Promise<string>} 最终内容
 */
function runReminderStream(reminder, targetType, targetId, preset) {
  return new Promise((resolve, reject) => {
    try {
      const data = readData();
      const store = data.chatHistoryStore || {};
      const key = targetType === 'private' ? `private:${targetId}` : `room:${targetId}`;
      const history = Array.isArray(store[key]) ? store[key] : [];

      // 触发 user 消息：把提醒上下文 + 提示词作为输入（不污染 system 常驻）
      const triggerMsg = {
        id: generateId(),
        role: 'user',
        content: `【系统触发提醒】提醒「${reminder.name}」到时间了。请按提示词执行：\n提示词：${reminder.prompt}`,
        toolCalls: null,
        toolCallId: null,
        timestamp: Date.now(),
        userId: 'admin'
      };
      // ★ BugFix：提醒执行器必须"只输出文本"，禁止任何工具调用。
      // tools:[] + toolChoice:'none'（DeepSeek 官方支持 'none'，tool_choice 取值 [none, auto, required]）
      // → LLM 无工具可用，只能生成消息，从根源杜绝 createTask/updateTask/completeTask/createMemo 等
      // 写工具被智能体自由调用、改动用户数据。若个别兼容网关不接受 'none'，
      // 空 tools + 'auto' 同样达到"无工具可用"效果（auto 无可选工具时不会发起调用）。
      const chatHistoryForLLM = [
        // 历史中可能残留上次工具调用的 tool 消息 / assistant(tool_calls) 消息；
        // 本轮已禁用工具（无 tools 声明），携带它们请求 API 可能被拒绝
        // （tool 消息必须伴随 assistant tool_calls），这里做最小清洗：
        // ① 移除 role='tool'/'function' 消息；② assistant 的 toolCalls 剥离为纯文本，
        //    无文本内容的纯工具调用消息整条丢弃。仅影响提醒路径，不影响正常聊天。
        ...history
          .filter(m => m.role !== 'tool' && m.role !== 'function')
          .map(m => {
            if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
              return { ...m, toolCalls: null, toolCallId: null };
            }
            return m;
          })
          .filter(m => !(m.role === 'assistant' && !String(m.content || '').trim())),
        triggerMsg
      ];

      // userConfig（参照 main.js chat-start-stream mergedConfig 范式）
      const userConfig = {
        apiKey: preset.apiKey || '',
        baseUrl: preset.baseUrl || 'https://api.deepseek.com',
        model: preset.model || 'deepseek-v4-flash',
        agentName: preset.name || '昔涟',
        systemPrompt: (preset.systemPrompt || '') + '\n你现在正在执行一条定时提醒，请直接输出结果，不要询问确认。' +
          '\n你现在正在执行一条定时提醒，只需直接输出提醒内容文本，禁止声称执行了任何数据操作（创建/修改/删除任务、备忘、记账等），也不要建议执行这类操作。',
        temperature: preset.temperature != null ? preset.temperature : 1.0,
        contextRounds: preset.contextRounds || 10,
        streamEnabled: preset.streamEnabled !== false,
        deleteConfirmEnabled: false,
        maxToolRounds: 10,
        // ★ BugFix：禁止工具调用（配合上方 tools:[] 透传到 callDeepSeekAPI）。
        // 提醒执行只输出聊天内容，不得创建/修改任何数据。
        tools: [],
        toolChoice: 'none'
      };

      // ★ 独立 abort controller（禁止动 chatStreamAbortController）
      reminderStreamAbortController = new AbortController();
      userConfig._signal = reminderStreamAbortController.signal;

      let accumulated = '';
      streamChat(chatHistoryForLLM, userConfig, {
        onContent(chunk) {
          accumulated += chunk || '';
          sendChatChunk({ type: 'content', data: chunk || '' });
        },
        onToolCall(toolCallInfo) {
          sendChatChunk({
            type: 'tool-call',
            data: {
              toolCallId: toolCallInfo.toolCallId,
              toolName: toolCallInfo.toolName,
              arguments: toolCallInfo.arguments
            }
          });
        },
        onToolResult(toolResultInfo) {
          sendChatChunk({
            type: 'tool-result',
            data: {
              toolCallId: toolResultInfo.toolCallId,
              toolName: toolResultInfo.toolName,
              result: toolResultInfo.result
            }
          });
        },
        onConfirmDelete: async () => false,
        onDone(result) {
          const content = (result && result.content) || accumulated || '';
          const trimmed = String(content).trim();
          if (trimmed) {
            const assistantMsg = {
              id: generateId(),
              role: 'assistant',
              content: trimmed,
              toolCalls: [],
              toolCallId: null,
              timestamp: Date.now(),
              userId: 'admin',
              agentPresetId: reminder.agentPresetId || targetId
            };
            appendChatMessage(targetType, targetId, assistantMsg)
              .then(() => resolve(trimmed))
              .catch(err => reject(err));
          } else {
            resolve(trimmed);
          }
        },
        onError(error) {
          reject(error);
        }
      }).catch(err => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

// ============================================================
// 手动触发
// ============================================================

/**
 * 手动立即触发（跳过窗口校验，仍走 fireReminder；不改变下次调度）
 * @param {string} id
 * @returns {Promise<{success:boolean, message:string}>}
 */
async function triggerReminderNow(id) {
  const reminders = listReminders();
  const r = reminders.find(x => String(x.id) === String(id));
  if (!r) return { success: false, message: '提醒不存在' };
  if (reminderFiring.has(r.id)) return { success: false, message: '该提醒正在触发中，请稍候' };
  reminderFiring.add(r.id);
  try {
    return await fireReminder(r, { manual: true });
  } finally {
    reminderFiring.delete(r.id);
  }
}

// ============================================================
// IPC 注册（幂等；main.js require 时自动生效）
// ============================================================

/**
 * 注册提醒 IPC handler（幂等，重复调用安全）
 */
function registerReminderIpc() {
  if (!ipcMain || ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('reminders-get', () => {
    try {
      return { reminders: listReminders() };
    } catch (e) {
      safeError('[提醒] reminders-get 异常:', e);
      return { reminders: [] };
    }
  });

  ipcMain.handle('reminders-save', async (event, payload) => {
    try {
      const reminder = payload && payload.reminder ? payload.reminder : payload;
      return await saveReminder(reminder);
    } catch (e) {
      safeError('[提醒] reminders-save 异常:', e);
      return { success: false, message: '保存失败: ' + (e.message || e) };
    }
  });

  ipcMain.handle('reminders-delete', async (event, id) => {
    try {
      return await deleteReminder(id);
    } catch (e) {
      safeError('[提醒] reminders-delete 异常:', e);
      return { success: false, message: '删除失败: ' + (e.message || e) };
    }
  });

  ipcMain.handle('reminders-set-enabled', async (event, payload) => {
    try {
      const id = payload && payload.id !== undefined ? payload.id : payload;
      const enabled = payload && payload.enabled !== undefined ? !!payload.enabled : true;
      return await setReminderEnabled(id, enabled);
    } catch (e) {
      safeError('[提醒] reminders-set-enabled 异常:', e);
      return { success: false, message: '操作失败: ' + (e.message || e) };
    }
  });

  ipcMain.handle('reminders-trigger-now', async (event, id) => {
    try {
      return await triggerReminderNow(id);
    } catch (e) {
      safeError('[提醒] reminders-trigger-now 异常:', e);
      return { success: false, message: '触发失败: ' + (e.message || e) };
    }
  });

  safeLog('[提醒] IPC handler 已注册');
}

// 模块加载时自动注册（main.js require 即生效；异常不影响应用启动）
try {
  registerReminderIpc();
} catch (e) {
  safeError('[提醒] IPC 注册失败:', e);
}

// ============================================================
// MODULE EXPORTS
// ============================================================
module.exports = {
  // 纯函数（测试友好）
  computeNextTriggerAt,
  computeNextTriggerIso,
  describeSchedule,
  parseTime,
  parseDateOnly,
  // 数据层
  listReminders,
  saveReminder,
  deleteReminder,
  setReminderEnabled,
  // 调度器 / 执行器
  startReminderScheduler,
  stopReminderScheduler,
  fireReminder,
  triggerReminderNow,
  setOnReminderFired,
  // IPC
  registerReminderIpc
};
