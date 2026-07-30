// =============================================================
// 星图自动刷新核心逻辑（可单测、依赖注入版）
// -------------------------------------------------------------
// 从 app.js 中原内联实现抽离而来，行为与之一致：
//   渲染进程每隔 15 秒探测一次 MC 数据量（totalFragments /
//   activeConstellations / entityProfiles），若相对上次探测
//   发生变化，立即派发 window 上的 'memory-refresh' 事件，
//   由 memory/js/memory/main.js 监听并刷新星图。
//
// 为便于单元测试，ipcRenderer 与 window 通过参数注入，
// 模块加载期不依赖 electron，也不依赖任何 DOM 环境。
// =============================================================
'use strict';

let _lastMcSig = null;       // 上一次探测到的数据签名；null 表示尚未建立基线
let _timer = null;           // 轮询定时器句柄，保证幂等（只启动一次）
let _warmupTimer = null;     // 启动后延后首探的定时器句柄

const DEFAULT_INTERVAL_MS = 15000; // 每 15 秒探测一次
const DEFAULT_WARMUP_MS = 2000;    // 启动后延后 2 秒先探一次（错开 MC 初始化）

/**
 * 由 mc:debug-status 返回的状态对象生成签名字符串。
 * 只关心会反映到星图可见内容的三项计数。
 * @param {{totalFragments?:number,activeConstellations?:number,entityProfiles?:number}} s
 * @returns {string}
 */
function makeSig(s) {
  return `${s.totalFragments}|${s.activeConstellations}|${s.entityProfiles}`;
}

/**
 * 探测一次 MC 数据量；若相对上次探测发生变化，派发 memory-refresh 事件。
 * 瞬时错误（如主进程尚未就绪、IPC 调用抛错）被静默吞掉，下次轮询自动重试。
 * @param {{ipcRenderer:object, targetWindow:object}} deps
 * @returns {Promise<void>}
 */
async function pollOnce(deps) {
  const { ipcRenderer, targetWindow } = deps;
  try {
    const s = await ipcRenderer.invoke('mc:debug-status');
    if (s && !s.error && typeof s.totalFragments === 'number') {
      const sig = makeSig(s);
      // 已建立基线且本次签名与上次不同 → 数据已变化，触发星图刷新
      if (_lastMcSig !== null && sig !== _lastMcSig) {
        targetWindow.dispatchEvent(new targetWindow.Event('memory-refresh'));
      }
      _lastMcSig = sig;
    }
  } catch (_) { /* 忽略瞬时错误，下次轮询重试 */ }
}

/**
 * 重置基线：清空上次探测到的数据签名。
 * 下次轮询会重新建立基线（不立即派发 memory-refresh）；
 * 之后当 MC 数据量（totalFragments 等）相对新基线发生变化时再触发刷新。
 * 用于「录入对话」后——新碎片写入会使计数增加，从而在下一个轮询周期内自然刷新星图。
 */
function resetBaseline() {
  _lastMcSig = null;
}

/**
 * 启动星图自动刷新轮询。幂等：重复调用不会创建多个定时器。
 * 每 intervalMs 探测一次；启动后延后 warmupMs 先探一次（错开 MC 初始化）。
 * @param {{ipcRenderer:object, targetWindow:object, intervalMs?:number, warmupMs?:number}} opts
 */
function init(opts) {
  if (_timer) return; // 幂等，避免重复启动
  const intervalMs = typeof opts.intervalMs === 'number' ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const warmupMs = typeof opts.warmupMs === 'number' ? opts.warmupMs : DEFAULT_WARMUP_MS;
  const deps = { ipcRenderer: opts.ipcRenderer, targetWindow: opts.targetWindow };
  _timer = setInterval(() => { pollOnce(deps); }, intervalMs);
  // 启动后立刻探一次（延后 warmupMs，避免与 MC 初始化抢资源）
  _warmupTimer = setTimeout(() => { pollOnce(deps); }, warmupMs);
}

/**
 * 停止轮询并清理定时器（主要用于测试与退出）。
 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_warmupTimer) { clearTimeout(_warmupTimer); _warmupTimer = null; }
  _lastMcSig = null;
}

/**
 * 仅供测试读取内部状态。
 * @returns {{lastMcSig:?string, hasTimer:boolean}}
 */
function _debugState() {
  return { lastMcSig: _lastMcSig, hasTimer: _timer !== null };
}

module.exports = {
  makeSig,
  pollOnce,
  resetBaseline,
  init,
  stop,
  _debugState,
  DEFAULT_INTERVAL_MS,
  DEFAULT_WARMUP_MS,
};
