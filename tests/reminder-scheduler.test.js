/**
 * tests/reminder-scheduler.test.js — 提醒模块频率计算单测
 *
 * 运行：node --test tests/reminder-scheduler.test.js
 *
 * 说明：reminder-manager 依赖 electron / data-service / xilian-agent，
 * 纯 node 环境下先注入 electron mock，再 require 模块即可测试纯函数。
 */

'use strict';

// ── electron mock（必须在 require reminder-manager 之前注入）──
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => __dirname, getAppPath: () => __dirname },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      nativeImage: { createFromBitmap: () => ({}) }
    };
  }
  return originalLoad.apply(this, arguments);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeNextTriggerAt,
  computeNextTriggerIso,
  describeSchedule
} = require('../reminder-manager');

// 兜底提取执行函数（QA 回归：验证 tools=[] / toolChoice='none' 时不再自动执行数据操作）
const {
  _fallbackExtractAndExecute
} = require('../xilian-agent');

// 本地时区 Date 构造辅助（月份 1-12）
function dt(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h || 0, mi || 0, 0, 0);
}

function isoEquals(date, y, mo, d, h, mi) {
  assert.ok(date instanceof Date, '应返回 Date，实际: ' + date);
  assert.equal(date.getFullYear(), y);
  assert.equal(date.getMonth() + 1, mo);
  assert.equal(date.getDate(), d);
  assert.equal(date.getHours(), h || 0);
  assert.equal(date.getMinutes(), mi || 0);
}

// ============================================================
// daily
// ============================================================
test('daily：当天未来时间直接命中', () => {
  const next = computeNextTriggerAt({ type: 'daily', time: '09:00' }, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 8, 1, 9, 0);
});

test('daily：当天已过则推到次日', () => {
  const next = computeNextTriggerAt({ type: 'daily', time: '09:00' }, dt(2026, 8, 1, 9, 30));
  isoEquals(next, 2026, 8, 2, 9, 0);
});

test('daily：跨午夜（23:30 触发 → 次日 00:05）', () => {
  const next = computeNextTriggerAt({ type: 'daily', time: '00:05' }, dt(2026, 8, 1, 23, 30));
  isoEquals(next, 2026, 8, 2, 0, 5);
});

// ============================================================
// weekly
// ============================================================
test('weekly：2026-08-01 是周六，[0,3] 命中周日', () => {
  const next = computeNextTriggerAt({ type: 'weekly', weekday: [0, 3], time: '10:00' }, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 8, 2, 10, 0); // 周日
});

test('weekly：当天命中的星期且时间已过 → 下一周同星期', () => {
  // 2026-08-02 是周日，10:00 已过 → 下周日
  const next = computeNextTriggerAt({ type: 'weekly', weekday: [0], time: '10:00' }, dt(2026, 8, 2, 11, 0));
  isoEquals(next, 2026, 8, 9, 10, 0);
});

// ============================================================
// workday / restday
// ============================================================
test('workday：周六起 → 下周一', () => {
  const next = computeNextTriggerAt({ type: 'workday', time: '09:00' }, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 8, 3, 9, 0); // 周一
});

test('restday：周一起 → 本周六', () => {
  const next = computeNextTriggerAt({ type: 'restday', time: '09:00' }, dt(2026, 8, 3, 8, 0));
  isoEquals(next, 2026, 8, 8, 9, 0); // 周六
});

test('workday：周五 09:00 已过 → 下周一', () => {
  const next = computeNextTriggerAt({ type: 'workday', time: '09:00' }, dt(2026, 8, 7, 10, 0));
  isoEquals(next, 2026, 8, 10, 9, 0);
});

// ============================================================
// monthly
// ============================================================
test('monthly：当月 20 日未来命中', () => {
  const next = computeNextTriggerAt({ type: 'monthly', dayOfMonth: 20, time: '10:00' }, dt(2026, 8, 15, 8, 0));
  isoEquals(next, 2026, 8, 20, 10, 0);
});

test('monthly：当月已过 → 下月', () => {
  const next = computeNextTriggerAt({ type: 'monthly', dayOfMonth: 10, time: '10:00' }, dt(2026, 8, 15, 8, 0));
  isoEquals(next, 2026, 9, 10, 10, 0);
});

test('monthly：2/30 超限取月末（2026 平年 → 2/28）', () => {
  const next = computeNextTriggerAt({ type: 'monthly', dayOfMonth: 30, time: '09:00' }, dt(2026, 2, 1, 8, 0));
  isoEquals(next, 2026, 2, 28, 9, 0);
});

test('monthly：2/31 闰年取 2/29', () => {
  const next = computeNextTriggerAt({ type: 'monthly', dayOfMonth: 31, time: '09:00' }, dt(2028, 2, 1, 8, 0));
  isoEquals(next, 2028, 2, 29, 9, 0);
});

// ============================================================
// yearly
// ============================================================
test('yearly：当年未到 → 当年', () => {
  const next = computeNextTriggerAt({ type: 'yearly', month: 10, dayOfMonth: 1, time: '09:00' }, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 10, 1, 9, 0);
});

test('yearly：当年已过 → 次年', () => {
  const next = computeNextTriggerAt({ type: 'yearly', month: 3, dayOfMonth: 15, time: '09:00' }, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2027, 3, 15, 9, 0);
});

test('yearly：2/30 超限取月末', () => {
  const next = computeNextTriggerAt({ type: 'yearly', month: 2, dayOfMonth: 30, time: '09:00' }, dt(2026, 1, 1, 8, 0));
  isoEquals(next, 2026, 2, 28, 9, 0);
});

// ============================================================
// interval
// ============================================================
test('interval：固定锚点累加（startAt 过去）', () => {
  const schedule = { type: 'interval', intervalMinutes: 90, startAt: '2026-08-01T08:00:00' };
  const next = computeNextTriggerAt(schedule, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 8, 1, 9, 30); // 08:00 + 90min
});

test('interval：锚点取整（from 在锚点后 5 分钟）', () => {
  const schedule = { type: 'interval', intervalMinutes: 90, startAt: '2026-08-01T08:00:00' };
  const next = computeNextTriggerAt(schedule, dt(2026, 8, 1, 8, 5));
  isoEquals(next, 2026, 8, 1, 9, 30);
});

test('interval：缺省 startAt 以 from 为锚点', () => {
  const schedule = { type: 'interval', intervalMinutes: 60 };
  const next = computeNextTriggerAt(schedule, dt(2026, 8, 1, 10, 0));
  isoEquals(next, 2026, 8, 1, 11, 0);
});

test('interval：startAt 在未来 → 返回 startAt 本身', () => {
  const schedule = { type: 'interval', intervalMinutes: 60, startAt: '2026-08-01T12:00:00' };
  const next = computeNextTriggerAt(schedule, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 8, 1, 12, 0);
});

// ============================================================
// once
// ============================================================
test('once：未来命中', () => {
  const next = computeNextTriggerAt({ type: 'once', datetime: '2026-08-01T09:00:00' }, dt(2026, 8, 1, 8, 0));
  isoEquals(next, 2026, 8, 1, 9, 0);
});

test('once：已过 → null', () => {
  const next = computeNextTriggerAt({ type: 'once', datetime: '2026-08-01T09:00:00' }, dt(2026, 8, 1, 10, 0));
  assert.equal(next, null);
});

// ============================================================
// dateRange 边界
// ============================================================
test('dateRange：候选早于 start → 从 start 当天重算', () => {
  const next = computeNextTriggerAt(
    { type: 'daily', time: '09:00' },
    dt(2026, 8, 1, 8, 0),
    { start: '2026-08-05', end: null }
  );
  isoEquals(next, 2026, 8, 5, 9, 0);
});

test('dateRange：候选晚于 end → null', () => {
  const next = computeNextTriggerAt(
    { type: 'daily', time: '09:00' },
    dt(2026, 8, 10, 8, 0),
    { start: null, end: '2026-08-05' }
  );
  assert.equal(next, null);
});

test('dateRange：end 当天仍有效', () => {
  const next = computeNextTriggerAt(
    { type: 'daily', time: '09:00' },
    dt(2026, 8, 5, 8, 0),
    { start: null, end: '2026-08-05' }
  );
  isoEquals(next, 2026, 8, 5, 9, 0);
});

test('dateRange：start 晚于 end → null（已过有效期）', () => {
  const next = computeNextTriggerAt(
    { type: 'daily', time: '09:00' },
    dt(2026, 8, 10, 8, 0),
    { start: '2026-08-01', end: '2026-08-05' }
  );
  assert.equal(next, null);
});

// ============================================================
// 单调性 / 无效输入
// ============================================================
test('单调性：同一 schedule 连续两次计算必须递增', () => {
  const schedule = { type: 'daily', time: '09:00' };
  let from = dt(2026, 8, 1, 8, 0);
  let prev = null;
  for (let i = 0; i < 5; i++) {
    const next = computeNextTriggerAt(schedule, from);
    assert.ok(next.getTime() > from.getTime(), '候选必须严格大于 from');
    if (prev !== null) assert.ok(next.getTime() > prev, '候选必须单调递增');
    prev = next.getTime();
    from = next;
  }
});

test('无效 schedule → null', () => {
  assert.equal(computeNextTriggerAt(null, dt(2026, 8, 1, 8, 0)), null);
  assert.equal(computeNextTriggerAt({ type: 'unknown' }, dt(2026, 8, 1, 8, 0)), null);
  assert.equal(computeNextTriggerAt({ type: 'daily' }, dt(2026, 8, 1, 8, 0)), null); // 缺 time
  assert.equal(computeNextTriggerAt({ type: 'weekly', weekday: [], time: '09:00' }, dt(2026, 8, 1, 8, 0)), null);
});

// ============================================================
// computeNextTriggerIso / describeSchedule
// ============================================================
test('computeNextTriggerIso：新建提醒（无 lastTriggeredAt）从当前时刻算', () => {
  const reminder = {
    schedule: { type: 'daily', time: '23:59' },
    dateRange: { start: null, end: null },
    lastTriggeredAt: null
  };
  const iso = computeNextTriggerIso(reminder);
  assert.equal(typeof iso, 'string');
  assert.ok(!isNaN(new Date(iso).getTime()));
});

test('describeSchedule：8 类型可读描述', () => {
  assert.equal(describeSchedule({ type: 'daily', time: '09:00' }), '每天 09:00');
  assert.equal(describeSchedule({ type: 'weekly', weekday: [1, 3], time: '09:00' }), '每周周一、周三 09:00');
  assert.equal(describeSchedule({ type: 'workday', time: '09:00' }), '工作日 09:00');
  assert.equal(describeSchedule({ type: 'restday', time: '10:00' }), '休息日 10:00');
  assert.equal(describeSchedule({ type: 'monthly', dayOfMonth: 20, time: '09:00' }), '每月20日 09:00');
  assert.equal(describeSchedule({ type: 'yearly', month: 10, dayOfMonth: 1, time: '09:00' }), '每年10月1日 09:00');
  assert.equal(describeSchedule({ type: 'interval', intervalMinutes: 90 }), '每90分钟');
  assert.equal(describeSchedule({ type: 'once' }), '单次');
});

// ============================================================
// 回归（QA Round 2）：提醒执行路径禁用工具后，兜底提取执行也必须关闭
// 缺陷：runReminderStream 传 tools:[] + toolChoice:'none' 堵住了「LLM 主动调用工具」通道，
// 但 streamChat 的 finish_reason='stop' 分支仍无条件调用 _fallbackExtractAndExecute，
// 按最后一条 user 消息关键词（如"任务"）从 AI 文本兜底提取 createTask 并执行，
// 导致提醒到点仍可能自动创建/修改数据。
// 覆盖方式：直接单测 _fallbackExtractAndExecute（已导出）——tools=[] / toolChoice='none'
// 时必须返回 null（不产生任何 toolCall，即不产生任何数据写入）；正常聊天（不传）行为不变。
// ============================================================
test('回归：tools=[] 或 toolChoice=none 时兜底提取必须返回 null（不产生任何数据写入）', async () => {
  // 模拟提醒执行路径的输入：最后一条 user 消息含"任务"关键词，AI 文本声称"已创建任务"
  const messages = [
    { role: 'user', content: '【系统触发提醒】提醒「交任务」到时间了。请按提示词执行：\n提示词：提醒我明天交任务' }
  ];
  const aiText = '好的，已为你创建任务：明天交报告。';

  // ① 提醒执行路径：tools=[] + toolChoice='none' → 兜底必须返回 null（否则会创建任务）
  const r1 = await _fallbackExtractAndExecute(aiText, messages, { tools: [], toolChoice: 'none' }, null);
  assert.equal(r1, null, 'tools=[] + toolChoice=none 时兜底必须返回 null（不得创建任务）');

  // ② 仅 toolChoice='none'（部分调用方只传 toolChoice）→ 同样返回 null
  const r2 = await _fallbackExtractAndExecute(aiText, messages, { toolChoice: 'none' }, null);
  assert.equal(r2, null, 'toolChoice=none 时兜底必须返回 null');

  // ③ 仅 tools=[]（部分调用方只传 tools）→ 同样返回 null
  const r3 = await _fallbackExtractAndExecute(aiText, messages, { tools: [] }, null);
  assert.equal(r3, null, 'tools=[] 时兜底必须返回 null');
});

test('回归：正常聊天（不传 tools/toolChoice）兜底行为保持不变', async () => {
  const messages = [
    { role: 'user', content: '提醒我明天交任务' }
  ];
  const aiText = '已创建任务：明天交报告';

  // 正常聊天未禁用工具 → 兜底仍按关键词提取 createTask（证明守卫不破坏原行为）
  const toolCall = await _fallbackExtractAndExecute(aiText, messages, {}, null);
  assert.ok(toolCall && toolCall.function, '正常聊天兜底应返回 toolCall');
  assert.equal(toolCall.function.name, 'createTask', '正常聊天兜底应提取 createTask');
  const args = JSON.parse(toolCall.function.arguments);
  assert.ok(args.title && String(args.title).length > 0, '兜底 createTask 应带非空 title');
});
