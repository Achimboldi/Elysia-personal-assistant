# Elysia 桌面端架构文档

> 版本对应仓库 main 分支（2026-08）。文档与代码冲突时以代码为准。

## 一、总体架构

Electron 28 应用，**无框架纯原生 JS**，单数据文件（`data.json`）为核心。

```
┌─────────────────────────────────────────────────────┐
│ 主进程 (main.js, 5537 行)                             │
│  ├─ 窗口/托盘/菜单/IPC 收口                            │
│  ├─ data-service.js  数据读写层（读/写/墓碑/多用户/去重）  │
│  ├─ data-manager.js  DataManager（变更管理/快照）       │
│  ├─ reminder-manager.js 提醒调度（8频率+AI执行）        │
│  ├─ cloud-sync.js   百度网盘双向同步（懒加载 Proxy）     │
│  ├─ update-manager.js  GitHub 版本同步（git CLI）      │
│  ├─ xilian-agent.js  昔涟 AI 引擎（懒加载，DeepSeek）   │
│  ├─ mc-bridge.js     记忆子系统桥（MemoryConstellations）│
│  └─ 其他：theme/secret/crypto/settings/chat-room...    │
├─────────────────────────────────────────────────────┤
│ 渲染层 (app.js, 9187 行, AppController 类)            │
│  ├─ index.html 主界面（多面板：备忘/任务/收支/密钥/提醒/  │
│  │   日记/记忆/聊天）                                   │
│  ├─ detail.html 详情弹窗、quick-task.html 快捷任务     │
│  ├─ sticky-note.html 便利贴、reminder.html 提醒窗      │
│  ├─ color-picker.html 取色器                           │
│  ├─ xilian-manager.js / xilian-ui.js / xilian-settings.js │
│  └─ 各功能 manager：task/memo/expense/budget/secret/journal │
└─────────────────────────────────────────────────────┘
```

## 二、模块清单与职责

### 主进程模块

| 文件 | 行数 | 职责 |
|---|---|---|
| main.js | 5537 | 入口：窗口/托盘/IPC/备份/云同步合并/提醒/取色器/便利贴 |
| data-service.js | 692 | **数据读写核心**：readData/writeData/updateData、墓碑、deduplicateItems、cleanupForeignUserData、多用户隔离 |
| data-manager.js | 850 | DataManager：数据变更管理、快照、保存节流 |
| cloud-sync.js | 1579 | 百度网盘云同步（OAuth、分片上传、双向合并、冲突检测） |
| xilian-agent.js | 1296 | 昔涟 AI 引擎：DeepSeek 通信、SSE 流式、工具循环、幻觉检测、兜底 |
| xilian-tools.js | 2068 | 35+ 工具定义与执行器（含记忆 4 个 + 自我迭代 6 个 + 提醒 4 个） |
| xilian-manager.js | 1160 | 聊天状态管理（渲染层）、MC 数据桥 ingest |
| reminder-manager.js | 1015 | 提醒调度：8 种频率、nextTriggerAt 计算、AI 执行器 |
| theme-manager.js | 615 | 主题/背景图管理（含 Linux 路径归一化 normalizeBgPath） |
| update-manager.js | 379 | GitHub 版本同步（git fetch/pull/push CLI） |
| chat-room-manager.js | 352 | 聊天室：多智能体、@提及、链式回复 |
| budget-manager.js | 190 | 预算管理（渲染层） |
| mc-bridge.js | 747 | 记忆子系统桥：加载 .env、初始化 DB、注册 IPC 通道、触发 Scribe |
| crypto-manager.js | 225 | 加密工具 |
| secret-manager.js | 120 | 密钥管理（渲染层） |
| utils.js / main-utils.js / dom-utils.js | ~761 | 通用工具 |

### 记忆子系统（memory/ 目录，详见 memory-system.md）

MemoryConstellations 集成：SQLite（sanctuary.db）+ LLM 流水线（Scribe 提取 → Archivist 分类 → Librarian 检索 → 四层认知模型），通过 mc-bridge IPC 直连，非独立 HTTP 服务。`routes/memory-api.js`（Express Router）未被挂载，仅保留原版逻辑。

## 三、主界面结构（index.html）

左侧导航面板（`data-view` 切换）：`memos`（默认）/ `tasks` / `expenses` / `secrets` / `reminders` / `journal` / `memory`（星图），底部导航含聊天入口。app.js 的 AppController 通过 `switchView(view)` 切换面板。

## 四、关键设计模式

1. **延迟加载**：xilian-agent、cloud-sync、uiohook 等重模块用 Proxy/lazy require，仅需要时加载（提升启动速度）
2. **模块容错**：reminderManager 等 try/catch 包裹，模块异常不影响应用启动
3. **数据一致性**：所有写操作走 data-service/data-manager，云同步合并有同步窗口竞态保护（`_reconcileWithFreshLocal`）
4. **AI 自我迭代**：xilian-tools 提供 listAppFiles/readAppFile/searchAppCode/runNodeCheck/writeAppFile/updateAgentRules 六个工具，AI 可读/改自身代码（写保护黑名单：xilian-agent.js/main.js/data.json）

## 五、代码规模统计（2026-08 快照）

- 主进程 JS：约 15,500 行
- 渲染层 JS：约 16,700 行（app.js 9187 + 各 manager）
- HTML：index.html 约 140KB（139891B）
- 记忆子系统：约 17,900 行（services 为主）
- 合计约 3.2 万行（不含 memory 与 node_modules）
