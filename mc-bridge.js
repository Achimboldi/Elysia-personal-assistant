// mc-bridge.js
// Elysia 主进程侧 MC 桥接器：加载 .env → 初始化 MC DB → 注册 ipcMain 通道 → 启动 Archivist
// 全部包在 try/catch 里，MC 任何失败都不得拖垮 Elysia

const path = require('path');
const crypto = require('crypto');
const { app, ipcMain } = require('electron');
const { toMs } = require('./memory/utils/time');

let _initialized = false;
let _timers = [];
let _archivistStarted = false;
let _getDb = null;  // 模块级引用，供 mc:debug-status 在 initMC() 之外使用
let _lastScribeError = null;  // 存储最近一次 checkAndRunScribe 崩溃信息（供 mc:debug-status 暴露）
let _scribe = null;  // 模块级引用，供 _triggerScribe() 在 initMC() 之外使用
let _initError = null;  // ★ 记录 initMC() 失败的具体错误（暴露给前端诊断）
let _initAttempted = false;  // 是否已经尝试过 init（用于支持重试）

// ★ content_hash 去重：加密用随机 IV（AES-256-GCM），无法比对密文，
//   改用 SHA-256(sender|timestamp|content) 做去重键，避免同步后重复录入
function _contentHash(sender, content, timestamp) {
    return crypto.createHash('sha256')
        .update(`${sender}|${timestamp || ''}|${content}`)
        .digest('hex')
        .substring(0, 32);  // 32 字符够用，碰撞概率极低
}

// ★ 时间戳归一化迁移：把 messages.timestamp / scribe_runs.processed_until 中
//   混存的 TEXT（ISO 字符串）统一转成 INTEGER 毫秒，消除 SQLite INTEGER<TEXT 比较错误
//   （INTEGER 时间戳 > TEXT 阈值 恒为 FALSE，导致 Scribe 永久漏处理聊天消息）。
//   只改这两列，不动 memory_fragments / entity_profiles / 任何碎片内容，
//   因此现有的 62 条碎片、6 个星座不受影响。幂等：首次跑后 TEXT 行清零，后续启动仅空扫。
function normalizeMcTimestamps(db) {
    try {
        const rows = db.prepare("SELECT id, timestamp FROM messages WHERE typeof(timestamp) = 'text'").all();
        const upd = db.prepare("UPDATE messages SET timestamp = ? WHERE id = ?");
        db.transaction(() => {
            for (const r of rows) {
                const n = Date.parse(r.timestamp);
                if (Number.isFinite(n)) upd.run(n, r.id);
            }
        })();
        const runs = db.prepare("SELECT id, processed_until FROM scribe_runs WHERE typeof(processed_until) = 'text'").all();
        const updR = db.prepare("UPDATE scribe_runs SET processed_until = ? WHERE id = ?");
        db.transaction(() => {
            for (const r of runs) {
                const n = Date.parse(r.processed_until);
                if (Number.isFinite(n)) updR.run(n, r.id);
            }
        })();
        if (rows.length || runs.length) {
            console.log(`[MC] 时间戳归一化: messages ${rows.length} 条, scribe_runs ${runs.length} 条 → INTEGER 毫秒`);
        }
    } catch (e) {
        console.error('[MC] 时间戳归一化失败:', e.message);
    }
}

// 辅助：延迟触发 Scribe（合并连续 ingest，降低 LLM 调用频率）
function _triggerScribe() {
    if (!_scribe || typeof _scribe.checkAndRunScribe !== 'function') return;
    if (globalThis._mcPendingScribe) clearTimeout(globalThis._mcPendingScribe);
    globalThis._mcPendingScribe = setTimeout(() => {
        _scribe.checkAndRunScribe().catch(e => {
            _lastScribeError = { time: new Date().toISOString(), source: 'ingest-delayed', message: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join('\n') };
            console.error('[MC] scribe delayed run:', e.message);
        });
    }, 5000);
}

/**
 * 初始化 MC 后端集成。
 * 必须在 Electron app.whenReady() 之后调用（需要 app.getPath('userData')）。
 * 幂等：重复调用直接返回。
 */
function initMC() {
    if (_initialized) return;
    _initAttempted = true;
    _initError = null;  // 清空旧错误
    try {
        // 1) 先加载 MC 的 .env（设置 SANCTUARY_ENCRYPTION_KEY 等），必须在 require MC 模块前
        require('dotenv').config({ path: path.join(__dirname, 'memory', '.env') });

        // 2) sanctuary.db 放 userData 目录，避免污染 app 目录或被 cwd 影响
        process.env.MC_DB_PATH = path.join(app.getPath('userData'), 'sanctuary.db');

        // 3) 初始化 MC 数据库（运行所有迁移）
        const { initDatabase, getDb } = require('./memory/database');
        initDatabase();
        _getDb = getDb;  // 保存引用供模块级 IPC handler 使用

        // ★ 添加 content_hash 列（去重用，幂等）
        try {
            const db0 = getDb();
            const cols = db0.pragma('table_info(messages)');
            if (!cols.some(c => c.name === 'content_hash')) {
                db0.exec('ALTER TABLE messages ADD COLUMN content_hash TEXT DEFAULT NULL');
                db0.exec('CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(content_hash)');
                console.log('[MC] content_hash 列已添加到 messages 表');
            }
        } catch (_) { /* 列已存在或表未创建，忽略 */ }

        // ★ 一次性迁移：把存量 TEXT 时间戳归一化为 INTEGER 毫秒（幂等，仅影响 TEXT 行）
        normalizeMcTimestamps(getDb());

        // 4) universe 数据（从路由抽出的可复用函数）
        const { getUniverseData } = require('./memory/services/universe');

        // 5) 检索/浏览（复用 MC 自带的 companion tools）
        const memoryTools = require('./memory/services/tools/memoryTools');
        const recallTool = memoryTools.find(t => t.name === 'recall_memory');
        const browseTool = memoryTools.find(t => t.name === 'browse_memories');

        // ── 注册 IPC 通道 ──

        // 星空可视化全量数据
        ipcMain.handle('mc:universe', async () => {
            try {
                const data = getUniverseData(getDb());
                // ★ 关键修复：fresh MC database（刚装的新设备）会返回有效空对象，
                //   不再返回 null，否则前端 fetch /api/memory/universe 会拿到 "null" JSON
                //   触发 `data.constellations` TypeError → 误显示"connection lost"
                return data || { constellations: [], core: [], cognitiveModel: [], patterns: [], archlog: [], mergeProposals: [], entities: [], total_fragments: 0, total_categories: 0 };
            } catch (e) {
                console.error('[MC] universe err', e.message);
                // 即使出错也返回空对象，避免前端误判为"连接断开"
                return { constellations: [], core: [], cognitiveModel: [], patterns: [], archlog: [], mergeProposals: [], entities: [], total_fragments: 0, total_categories: 0, _error: e.message };
            }
        });

        // 记忆检索（复用 recall_memory tool handler → librarian 向量+FTS 混合搜索）
        ipcMain.handle('mc:recall', async (_e, { query, limit } = {}) => {
            try {
                if (!query || typeof query !== 'string') {
                    return { success: false, formatted: '请提供检索关键词（query）。' };
                }
                if (!recallTool) {
                    return { success: false, formatted: 'recall_memory 工具未加载。' };
                }
                // recall_memory.handler 签名: handler(args, context) → {success, formatted}
                // context 需要 chatId 和 lastClaraMessage（messageGuard 用）
                const result = await recallTool.handler(
                    { query },
                    { chatId: 1, lastClaraMessage: null }
                );
                return result;
            } catch (e) {
                console.error('[MC] recall err', e.message);
                return { success: false, formatted: `检索失败: ${e.message}` };
            }
        });

        // 实体概览（people/places/events/projects 计数）
        ipcMain.handle('mc:browse', async () => {
            try {
                const db = getDb();
                // 按类别统计活跃实体
                const counts = db.prepare(`
                    SELECT category, COUNT(*) as count
                    FROM entity_profiles
                    WHERE status = 'active' AND fragment_count > 0
                    GROUP BY category
                    ORDER BY count DESC
                `).all();
                const totalEntities = counts.reduce((s, c) => s + c.count, 0);
                const totalFragments = db.prepare(
                    "SELECT COUNT(*) as c FROM memory_fragments WHERE status = 'active'"
                ).get().c;
                // 同时提供 browse_memories 的文本概览（不传参数 = 列出所有顶层分区）
                let overview = '';
                if (browseTool) {
                    try {
                        const browseResult = await browseTool.handler(
                            {},
                            { chatId: 1, lastClaraMessage: null }
                        );
                        overview = browseResult?.formatted || '';
                    } catch (_) { /* 忽略 browse 失败 */ }
                }
                return { totalEntities, totalFragments, byCategory: counts, overview };
            } catch (e) {
                console.error('[MC] browse err', e.message);
                return null;
            }
        });

        // 写入消息到 MC（Scribe 下次扫描会处理它）
        ipcMain.handle('mc:ingest', async (_e, msg) => {
            try {
                const ok = ingestMessage(getDb(), msg);
                if (ok) _triggerScribe();
                return ok;
            } catch (e) {
                console.error('[MC] ingest err', e.message);
                return false;
            }
        });

        // ── 备忘录 ingest（阶段 2）──
        ipcMain.handle('mc:ingest-memo', async (_e, memo) => {
            try {
                if (!memo || !memo.title) return false;
                // 私密备忘录不记录
                if (memo.isPrivate) return false;
                const title = memo.title.slice(0, 200);
                const body = (memo.content || '').slice(0, 1500);
                const content = `📝 备忘录《${title}》\n${body}\n（创建: ${memo.createdAt || '未知'} · 更新: ${memo.lastModified || memo.createdAt || '未知'}）`;
                const ok = ingestMessage(getDb(), {
                    sender: 'user',
                    content,
                    timestamp: memo.lastModified || memo.createdAt || new Date().toISOString(),
                    messageType: 'text'
                });
                if (ok) {
                    getDb().prepare("UPDATE messages SET source = 'memo' WHERE id = last_insert_rowid()").run();
                }
                _triggerScribe();
                return ok;
            } catch (e) {
                console.error('[MC] ingest-memo err:', e.message);
                return false;
            }
        });

        // ── 任务 ingest（阶段 2）──
        ipcMain.handle('mc:ingest-task', async (_e, task) => {
            try {
                if (!task || !task.title) return false;
                const title = task.title.slice(0, 200);
                const desc = (task.description || '').slice(0, 1500);
                const priority = task.priority || 'normal';
                const progress = task.progress || 'pending';
                const tags = (task.tags && task.tags.length) ? ` · 标签: ${task.tags.join(', ')}` : '';
                const content = `📋 任务《${title}》\n描述: ${desc}\n状态: ${progress} · 优先级: ${priority}${tags}\n（创建: ${task.createdAt || '未知'}）`;
                const ok = ingestMessage(getDb(), {
                    sender: 'user',
                    content,
                    timestamp: task.createdAt || task.endDate || new Date().toISOString(),
                    messageType: 'text'
                });
                if (ok) {
                    getDb().prepare("UPDATE messages SET source = 'task' WHERE id = last_insert_rowid()").run();
                }
                _triggerScribe();
                return ok;
            } catch (e) {
                console.error('[MC] ingest-task err:', e.message);
                return false;
            }
        });

        // MC 桥接状态
        ipcMain.handle('mc:status', async () => ({
            initialized: _initialized,
            dbPath: process.env.MC_DB_PATH || null,
            timers: _timers.length,
            archivistStarted: _archivistStarted,
        }));

        // 手动触发一次 Archivist tick（【录入】后立刻整合，无需等 2 分钟；也用于诊断）
        ipcMain.handle('mc:force-tick', async () => {
            try {
                const archivist = require('./memory/services/archivist');
                if (typeof archivist.start === 'function' && !_archivistStarted) {
                    archivist.start().catch(e => console.error('[MC] archivist start err:', e.message));
                    _archivistStarted = true;
                }
                if (typeof archivist.forceTick === 'function') {
                    const r = await archivist.forceTick();
                    console.log('[MC] force-tick result:', JSON.stringify(r));
                    return r;
                }
                if (typeof archivist.runArchivist === 'function') {
                    const r = await archivist.runArchivist();
                    return { ok: true, legacy: true, result: r };
                }
                return { ok: false, error: 'no tick fn' };
            } catch (e) {
                console.error('[MC] force-tick err:', e.message);
                return { ok: false, error: e.message };
            }
        });

        // ── 批量回填：备忘录 → MC（阶段 2）──
        ipcMain.handle('mc:ingest-all-memos', async () => {
            try {
                const { readData } = require('./data-service');
                const data = readData(true);
                const memos = data.memos || [];
                let count = 0;
                for (const memo of memos) {
                    if (memo.isPrivate) continue;
                    if (!memo.title || !memo.content) continue;
                    const title = (memo.title || '').slice(0, 200);
                    const body = (memo.content || '').slice(0, 1500);
                    const content = `📝 备忘录《${title}》\n${body}\n（创建: ${memo.createdAt || '未知'} · 更新: ${memo.lastModified || memo.createdAt || '未知'}）`;
                    const ts = memo.lastModified || memo.createdAt || new Date().toISOString();
                    const ok = ingestMessage(getDb(), { sender: 'user', content, timestamp: ts, messageType: 'text' });
                    if (ok) {
                        getDb().prepare("UPDATE messages SET source = 'memo' WHERE id = last_insert_rowid()").run();
                        count++;
                    }
                }
                if (count > 0) _triggerScribe();
                console.log('[MC] 备忘录回填完成:', count, '条');
                return { ok: true, count };
            } catch (e) {
                console.error('[MC] ingest-all-memos err:', e.message);
                return { ok: false, error: e.message };
            }
        });

        // ── 批量回填：任务 → MC（阶段 2）──
        ipcMain.handle('mc:ingest-all-tasks', async () => {
            try {
                const { readData } = require('./data-service');
                const data = readData(true);
                const tasks = data.tasks || [];
                let count = 0;
                for (const task of tasks) {
                    if (!task.title) continue;
                    const title = (task.title || '').slice(0, 200);
                    const desc = (task.description || '').slice(0, 1500);
                    const priority = task.priority || 'normal';
                    const progress = task.progress || 'pending';
                    const tags = (task.tags && task.tags.length) ? ` · 标签: ${task.tags.join(', ')}` : '';
                    const content = `📋 任务《${title}》\n描述: ${desc}\n状态: ${progress} · 优先级: ${priority}${tags}\n（创建: ${task.createdAt || '未知'}）`;
                    const ts = task.createdAt || task.endDate || new Date().toISOString();
                    const ok = ingestMessage(getDb(), { sender: 'user', content, timestamp: ts, messageType: 'text' });
                    if (ok) {
                        getDb().prepare("UPDATE messages SET source = 'task' WHERE id = last_insert_rowid()").run();
                        count++;
                    }
                }
                if (count > 0) _triggerScribe();
                console.log('[MC] 任务回填完成:', count, '条');
                return { ok: true, count };
            } catch (e) {
                console.error('[MC] ingest-all-tasks err:', e.message);
                return { ok: false, error: e.message };
            }
        });

        // ── 批量回填：全部（备忘录+任务，阶段 2 一键）──
        ipcMain.handle('mc:ingest-all-content', async () => {
            try {
                const { readData } = require('./data-service');
                const data = readData(true);
                let memoCount = 0, taskCount = 0;

                for (const memo of (data.memos || [])) {
                    if (memo.isPrivate || !memo.title || !memo.content) continue;
                    const body = (memo.content || '').slice(0, 1500);
                    const ts = memo.lastModified || memo.createdAt || new Date().toISOString();
                    ingestMessage(getDb(), { sender: 'user', content: `📝 备忘录《${(memo.title||'').slice(0,200)}》\n${body}\n（更新: ${ts}）`, timestamp: ts, messageType: 'text' });
                    getDb().prepare("UPDATE messages SET source = 'memo' WHERE id = last_insert_rowid()").run();
                    memoCount++;
                }
                for (const task of (data.tasks || [])) {
                    if (!task.title) continue;
                    const desc = (task.description || '').slice(0, 1500);
                    const tags = (task.tags && task.tags.length) ? ` · 标签: ${task.tags.join(', ')}` : '';
                    const ts = task.createdAt || task.endDate || new Date().toISOString();
                    ingestMessage(getDb(), { sender: 'user', content: `📋 任务《${(task.title||'').slice(0,200)}》\n描述: ${desc}\n状态: ${task.progress||'pending'} · 优先级: ${task.priority||'normal'}${tags}\n（创建: ${ts}）`, timestamp: ts, messageType: 'text' });
                    getDb().prepare("UPDATE messages SET source = 'task' WHERE id = last_insert_rowid()").run();
                    taskCount++;
                }
                if (memoCount + taskCount > 0) {
                    // 清空 scribe_runs 历史记录，强制下次 Scribe 全量扫描（since=0）
                    // 用 DELETE 而非 UPDATE 避免被并发自动定时器覆盖
                    getDb().prepare("DELETE FROM scribe_runs").run();
                    console.log('[MC] 已重置 scribe 处理进度，下次将全量扫描 ' + (memoCount + taskCount) + ' 条新资料');
                    _triggerScribe();
                }
                console.log('[MC] 全部回填完成: 备忘录=' + memoCount + ' 任务=' + taskCount);
                return { ok: true, memoCount, taskCount, total: memoCount + taskCount };
            } catch (e) {
                console.error('[MC] ingest-all-content err:', e.message);
                return { ok: false, error: e.message };
            }
        });

        // ── 同步后自动喂数据：手机端数据通过 Baidu 云同步到桌面端后，
        //    桌面端调用此 IPC 把同步下来的备忘录/任务/聊天记录喂给 MC 管线。
        //    用 content_hash 去重，确保同一条数据不会被重复录入。
        ipcMain.handle('mc:ingest-synced-data', async () => {
            try {
                const { readData } = require('./data-service');
                const data = readData(true);
                let memoCount = 0, taskCount = 0, chatCount = 0;
                const db = getDb();

                // 1) 备忘录（跳过私密）
                for (const memo of (data.memos || [])) {
                    if (memo.isPrivate || !memo.title || !memo.content) continue;
                    const body = (memo.content || '').slice(0, 1500);
                    const ts = memo.lastModified || memo.createdAt || new Date().toISOString();
                    const content = `📝 备忘录《${(memo.title||'').slice(0,200)}》\n${body}\n（创建: ${memo.createdAt || '未知'} · 更新: ${ts}）`;
                    const ok = ingestMessage(db, { sender: 'user', content, timestamp: ts, messageType: 'text' });
                    if (ok) {
                        db.prepare("UPDATE messages SET source = 'memo' WHERE id = last_insert_rowid()").run();
                        memoCount++;
                    }
                }

                // 2) 任务
                for (const task of (data.tasks || [])) {
                    if (!task.title) continue;
                    const desc = (task.description || '').slice(0, 1500);
                    const priority = task.priority || 'normal';
                    const progress = task.progress || 'pending';
                    const tags = (task.tags && task.tags.length) ? ` · 标签: ${task.tags.join(', ')}` : '';
                    const ts = task.createdAt || task.endDate || new Date().toISOString();
                    const content = `📋 任务《${(task.title||'').slice(0,200)}》\n描述: ${desc}\n状态: ${progress} · 优先级: ${priority}${tags}\n（创建: ${ts}）`;
                    const ok = ingestMessage(db, { sender: 'user', content, timestamp: ts, messageType: 'text' });
                    if (ok) {
                        db.prepare("UPDATE messages SET source = 'task' WHERE id = last_insert_rowid()").run();
                        taskCount++;
                    }
                }

                // 3) 聊天记录（从 chatHistoryStore 读取全部聊天上下文）
                const chatHistoryStore = data.chatHistoryStore || {};
                for (const [chatKey, messages] of Object.entries(chatHistoryStore)) {
                    if (!Array.isArray(messages)) continue;
                    for (const m of messages) {
                        if (!m || !m.content || typeof m.content !== 'string' || !m.content.trim()) continue;
                        let sender = null;
                        if (m.role === 'user') sender = 'user';
                        else if (m.role === 'assistant') sender = 'draco';
                        else continue;
                        const ok = ingestMessage(db, {
                            sender,
                            content: m.content,
                            timestamp: m.timestamp || new Date().toISOString(),
                            messageType: 'text'
                        });
                        if (ok) chatCount++;
                    }
                }

                const total = memoCount + taskCount + chatCount;
                if (total > 0) {
                    console.log(`[MC] 同步后喂数据: 备忘录=${memoCount} 任务=${taskCount} 聊天=${chatCount} 总计=${total}（去重后新增）`);
                    _triggerScribe();
                }
                return { ok: true, memoCount, taskCount, chatCount, total };
            } catch (e) {
                console.error('[MC] ingest-synced-data err:', e.message);
                return { ok: false, error: e.message };
            }
        });

        // 动态设置星图 AI 主星名（跟随当前所选智能体）
        // 同时更新内存中的 memoryConfig.AI.name 与持久化 memory_config.json，
        // 让后端核心实体（universe.core）与前端显示名保持一致。
        ipcMain.handle('mc:set-ai-name', async (_e, { name, color }) => {
            try {
                if (!name || typeof name !== 'string' || !name.trim()) return false;
                const cfg = require('./memory/services/memoryConfig');
                if (cfg && cfg.AI) {
                    cfg.AI.name = name.trim();
                    if (cfg.config && cfg.config.ai) cfg.config.ai.name = name.trim();
                }
                if (cfg && cfg.UI && color) {
                    cfg.UI.ai_color = color;
                    if (cfg.config && cfg.config.ui) cfg.config.ui.ai_color = color;
                }
                // 持久化到 memory_config.json（不存在则从 example 复制后改写）
                const fs = require('fs');
                const path = require('path');
                const memDir = path.join(__dirname, 'memory');
                let base;
                const realPath = path.join(memDir, 'memory_config.json');
                const examplePath = path.join(memDir, 'memory_config.example.json');
                if (fs.existsSync(realPath)) {
                    base = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
                } else if (fs.existsSync(examplePath)) {
                    base = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
                } else {
                    base = { user: { name: 'User' }, ai: { name: 'Companion' }, ui: {} };
                }
                base.ai = base.ai || {};
                base.ai.name = name.trim();
                if (color) { base.ui = base.ui || {}; base.ui.ai_color = color; }
                fs.writeFileSync(realPath, JSON.stringify(base, null, 2), 'utf-8');
                console.log('[MC] ai core name set to:', name.trim());
                return true;
            } catch (e) {
                console.error('[MC] set-ai-name err', e.message);
                return false;
            }
        });

        // 动态设置星图 User 主星名（跟随 Elysia 设置中的"用户名称"）
        // 同步后端 memoryConfig 与持久化 memory_config.json，避免前后端名字不一致。
        ipcMain.handle('mc:set-user-name', async (_e, { name, color }) => {
            try {
                if (!name || typeof name !== 'string' || !name.trim()) return false;
                const cfg = require('./memory/services/memoryConfig');
                if (cfg && cfg.USER) {
                    cfg.USER.name = name.trim();
                    if (cfg.config && cfg.config.user) cfg.config.user.name = name.trim();
                }
                if (cfg && cfg.UI && color) {
                    cfg.UI.user_color = color;
                    if (cfg.config && cfg.config.ui) cfg.config.ui.user_color = color;
                }
                const fs = require('fs');
                const path = require('path');
                const memDir = path.join(__dirname, 'memory');
                let base;
                const realPath = path.join(memDir, 'memory_config.json');
                const examplePath = path.join(memDir, 'memory_config.example.json');
                if (fs.existsSync(realPath)) {
                    base = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
                } else if (fs.existsSync(examplePath)) {
                    base = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
                } else {
                    base = { user: { name: 'User' }, ai: { name: 'Companion' }, ui: {} };
                }
                base.user = base.user || {};
                base.user.name = name.trim();
                if (color) { base.ui = base.ui || {}; base.ui.user_color = color; }
                fs.writeFileSync(realPath, JSON.stringify(base, null, 2), 'utf-8');
                console.log('[MC] user core name set to:', name.trim());
                return true;
            } catch (e) {
                console.error('[MC] set-user-name err', e.message);
                return false;
            }
        });

        // ── 注入 Elysia 的 DeepSeek key 到 MC api_configs ──
        // 让 Scribe/Archivist/Librarian 的 LLM 调用能成功（provider=openai_compatible, is_default=1）
        // 同时把管线常用 config_id 行（36=archivist LLM, 38=archivist verify, 52=scribe/cognitiveModel）也更新为 DeepSeek
        try {
            const { readData } = require('./data-service');
            const { encryption } = require('./memory/encryption');
            const data = readData ? (typeof readData === 'function' ? readData() : readData) : null;
            const s = (data && data.settings) || {};
            const apiKey = s.aiApiKey || process.env.API_KEY;
            const endpoint = s.aiBaseUrl || 'https://api.deepseek.com';
            const model = s.aiModel || 'deepseek-chat';
            if (apiKey) {
                const db = getDb();
                const encKey = encryption.encrypt(apiKey);
                // 1) upsert DeepSeek 为默认 config（name='deepseek', is_default=1）
                const exist = db.prepare("SELECT id FROM api_configs WHERE name = ?").get('deepseek');
                if (exist) {
                    db.prepare(
                        "UPDATE api_configs SET provider='openai_compatible', endpoint=?, api_key=?, model_name=?, is_default=1, supports_tools=1 WHERE name=?"
                    ).run(endpoint, encKey, model, 'deepseek');
                } else {
                    db.prepare(
                        "INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools) VALUES (?, 'openai_compatible', ?, ?, ?, 1, 1)"
                    ).run('deepseek', endpoint, encKey, model);
                }
                // ★ 清除其它 default：initDatabase seed 了「Gemini官方」default(is_default=1)，
                //   若不清，callLLM 的 `WHERE is_default=1 .get()` 会取到 Gemini 行(空key)而非 deepseek → 管线 LLM 调用失败
                db.prepare("UPDATE api_configs SET is_default=0 WHERE name != 'deepseek'").run();
                // 2) 把管线常用 config_id 行也更新为 DeepSeek（确保 archivist/scribe 调用能成功）
                //    config_id 36 = archivist LLM + consolidator + entityProfile (DS)
                //    config_id 38 = archivist verify (flash)
                //    config_id 52 = scribe + cognitiveModel (flash-lite)
                const pipelineConfigIds = [36, 38, 52];
                for (const cid of pipelineConfigIds) {
                    const row = db.prepare("SELECT id FROM api_configs WHERE id = ?").get(cid);
                    if (row) {
                        db.prepare(
                            "UPDATE api_configs SET provider='openai_compatible', endpoint=?, api_key=?, model_name=?, supports_tools=1 WHERE id=?"
                        ).run(endpoint, encKey, model, cid);
                    } else {
                        // 行不存在时 INSERT（SQLite 会用指定 id）
                        db.prepare(
                            "INSERT INTO api_configs (id, name, provider, endpoint, api_key, model_name, is_default, supports_tools) VALUES (?, ?, 'openai_compatible', ?, ?, ?, 0, 1)"
                        ).run(cid, 'pipeline-' + cid, endpoint, encKey, model);
                    }
                }
                console.log('[MC] DeepSeek key injected (api_configs)');
            } else {
                console.warn('[MC] 未找到 DeepSeek key (settings.aiApiKey)，管线 LLM 调用将失败');
            }
        } catch (e) {
            console.warn('[MC] key injection skipped:', e.message);
        }

        // ── 启动 Archivist 定时器 ──
        // archivist.start() 内部通过 scheduleTick() + setTimeout 设置 2 分钟 tick 循环
        // 每个 tick 内部有 try/catch；LLM key 未配时 tick 内部会失败但不崩
        const archivist = require('./memory/services/archivist');
        const scribe = require('./memory/services/scribe');
        _scribe = scribe;  // 保存模块级引用，供 _triggerScribe() 和批量回填使用
        if (typeof archivist.start === 'function') {
            archivist.start().catch(e =>
                console.error('[MC] archivist start err:', e.message)
            );
            _archivistStarted = true;
        } else if (typeof archivist.runArchivist === 'function') {
            // 回退方案：手动 2 分钟间隔调用 runArchivist（legacy 一次性完整周期）
            _timers.push(setInterval(() => {
                archivist.runArchivist().catch(e =>
                    console.error('[MC] archivist cycle:', e.message)
                );
            }, 2 * 60 * 1000));
        }

        // ── 启动 Scribe 调度器 ──
        // Scribe 负责把 messages 表加工成 memory_fragments；Archivist 再整理成星座/实体。
        // 设 60 秒周期 + 启动后 3 秒立即跑一次（forceStartup=true 绕过沉默检查），
        // 确保重启前积压的消息不被沉默阈值挡住。
        if (scribe && typeof scribe.checkAndRunScribe === 'function') {
            setTimeout(() => {
                scribe.checkAndRunScribe({ forceStartup: true }).catch(e => {
                    _lastScribeError = { time: new Date().toISOString(), source: 'initial-run', message: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join('\n') };
                    console.error('[MC] scribe initial run:', e.message);
                });
            }, 3000);
            _timers.push(setInterval(() => {
                scribe.checkAndRunScribe().catch(e => {
                    _lastScribeError = { time: new Date().toISOString(), source: 'cycle', message: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join('\n') };
                    console.error('[MC] scribe cycle:', e.message);
                });
            }, 60 * 1000));
        }

        _initialized = true;
        console.log('[MC] bridge initialized at', process.env.MC_DB_PATH);
    } catch (e) {
        _initError = { time: new Date().toISOString(), message: e.message, stack: (e.stack || '').slice(0, 600) };
        console.error('[MC] bridge init FAILED (Elysia continues without MC):', e.message, e.stack);
    }
}

/**
 * 写一条消息进 MC 的 chats+messages 表（Scribe 下次扫描会处理它）
 * @param {import('better-sqlite3').Database} db
 * @param {object} msg - { sender, content, timestamp, messageType }
 * @returns {boolean} 是否写入成功
 */
function ingestMessage(db, { sender, content, timestamp, messageType } = {}) {
    if (!sender || !content) return false;

    const { encryption } = require('./memory/encryption');

    // 确保 Elysia 专用 chat 存在（id=1，单条聚合用）
    // chats 表唯一 NOT NULL 无默认值的列是 name
    let chat = db.prepare("SELECT id FROM chats WHERE id = 1").get();
    if (!chat) {
        db.prepare("INSERT INTO chats (id, name) VALUES (1, ?)").run('Elysia');
    }

    // ★ 去重：用 content_hash 检查是否已录入（防止同步后重复录入同一条数据）
    // 统一为 INTEGER 毫秒，避免 messages.timestamp 混存 INTEGER/TEXT 导致 Scribe 比较错误
    const ts = toMs(timestamp);
    const hash = _contentHash(sender, content, ts);
    const existing = db.prepare("SELECT id FROM messages WHERE content_hash = ? LIMIT 1").get(hash);
    if (existing) return false;  // 已存在，跳过

    // 加密消息内容
    const enc = encryption.encrypt(content);

    // message_type 有 CHECK 约束: ('text', 'voice', 'proactive')
    const mt = ['text', 'voice', 'proactive'].includes(messageType) ? messageType : 'text';

    // source 列由 migration v50 添加 (TEXT DEFAULT NULL)
    db.prepare(
        `INSERT INTO messages (chat_id, sender, content, is_encrypted, message_type, timestamp, source, content_hash)
         VALUES (1, ?, ?, 1, ?, ?, 'elysia', ?)`
    ).run(sender, enc, mt, ts, hash);

    return true;
}

// ── 调试：从渲染进程查询 MC 管线状态 ──
// 模块级注册，不受 _initialized 守卫限制，无论 initMC 是否跑过都能响应
ipcMain.handle('mc:debug-status', async () => {
    try {
        if ((!_initialized || !_getDb) && _initError) {
            return {
                error: _initError.message,
                initFailed: true,
                initErrorTime: _initError.time,
                stack: _initError.stack,
                dbPath: process.env.MC_DB_PATH || null,
                help: '请检查：1) DeepSeek API Key 是否已设置且有效（设置→AI设置）; 2) 是否有网络; 3) 重启 Elysia 重试'
            };
        }
        if (!_initialized || !_getDb) {
            return {
                error: 'MC 未初始化（无错误记录），可能因 app.whenReady() 中 initMC() 尚未完成或被跳过。请重启 Elysia，若问题持续请在 DevTools 控制台（F12）查看 "[MC] bridge init FAILED" 日志。',
                dbPath: process.env.MC_DB_PATH || null
            };
        }
        const db = _getDb();
        const totalMessages = db.prepare('SELECT COUNT(*) as cnt FROM messages').get()?.cnt || 0;
        const totalFragments = db.prepare("SELECT COUNT(*) as cnt FROM memory_fragments WHERE status = 'active'").get()?.cnt || 0;
        const scribeRuns = db.prepare("SELECT COUNT(*) as cnt FROM scribe_runs WHERE status='done'").get()?.cnt || 0;
        const lastScribeRun = db.prepare("SELECT MAX(processed_until) as ts FROM scribe_runs WHERE status='done'").get()?.ts || null;

        // 新增：查询失败运行和最近错误
        const failedRuns = db.prepare("SELECT COUNT(*) as cnt FROM scribe_runs WHERE status='failed'").get()?.cnt || 0;
        const lastFailed = db.prepare(
            "SELECT run_at, processed_until, messages_processed, fragments_written FROM scribe_runs WHERE status='failed' ORDER BY run_at DESC LIMIT 1"
        ).get();
        const lastScribeError = lastFailed ? {
            runAt: lastFailed.run_at,
            processedUntil: lastFailed.processed_until,
            messagesProcessed: lastFailed.messages_processed,
            fragmentsWritten: lastFailed.fragments_written,
            error: 'scribe_runs 表无 error_message 列，无法获取详细错误原因。常见原因：LLM API 调用失败——请检查 DeepSeek API key 是否有效、网络是否可达、模型额度是否耗尽。'
        } : null;

        // ── Archivist / 星座可见性（此前完全缺失）──
        let entityProfiles = null, fragmentEntities = null, activeConstellations = null;
        try {
            entityProfiles = db.prepare("SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'active'").get()?.c ?? null;
            fragmentEntities = db.prepare("SELECT COUNT(*) as c FROM fragment_entities").get()?.c ?? null;
            activeConstellations = db.prepare("SELECT COUNT(*) as c FROM entity_profiles WHERE status='active' AND fragment_count > 0").get()?.c ?? null;
        } catch (_) {}

        return {
            totalMessages, totalFragments, scribeRuns, lastScribeRun, failedRuns, lastScribeError,
            lastScribeCrash: _lastScribeError,
            archivistStarted: _archivistStarted,
            entityProfiles, fragmentEntities, activeConstellations
        };
    } catch (e) {
        return { error: e.message };
    }
});

// ★ 手动重试 MC 初始化（用于 initMC() 失败后的恢复）
ipcMain.handle('mc:retry-init', async () => {
    if (_initialized) return { ok: true, msg: '已初始化' };
    try {
        _initError = null;
        _initAttempted = false;
        require('./mc-bridge').initMC();
        if (_initialized) return { ok: true, msg: '初始化成功' };
        return { ok: false, err: _initError?.message || '初始化失败（无错误信息）' };
    } catch (e) {
        return { ok: false, err: e.message };
    }
});

module.exports = { initMC };
