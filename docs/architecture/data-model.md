# Elysia 数据模型文档（data.json）

> 单文件 JSON 是桌面端的唯一数据源（"以数据文件为核心"架构）。文件位于运行目录：`linux-app/data.json`（Linux）/ `win-unpacked/data.json`（Windows），**已 gitignore，不入库**。

## 一、顶层结构

```jsonc
{
  "tasks": [...],            // 任务（含子任务）
  "memos": [...],            // 备忘录（富文本 htmlContent + 纯文本 content）
  "expenses": [...],         // 收支记录
  "budgets": [...],          // 预算周期（含 categoryBudgets）
  "categoryBudgets": [...],  // 分类预算
  "secrets": [...],          // 密钥/密码
  "journals": [...],         // 日记
  "settings": { ... },       // 全部设置（含 aiConfig/aiPresets/reminders/云同步 token/主题）
  "translationStats": {...}, // 翻译统计
  "chatHistory": [...],      // 兼容旧结构聊天记录
  "chatRooms": [...],        // 聊天室
  "chatHistoryStore": {...}, // 聊天记录存储（key: private:<presetId> | room:<roomId>）
  "chatHistoryLimit": 50,
  "deletedItems": {...},     // 删除墓碑（tasks/memos/expenses/budgets/.../chatRooms）
  "dailyTasks": [...],       // 今日任务
  "lastUpdated": "ISO时间"
}
```

## 二、各实体关键字段

| 实体 | 关键字段 |
|---|---|
| task | id, title, description, category, priority, startDate, endDate, reminderDate, subtasks[], completed, progress, createdAt, updatedAt, userId, creator |
| memo | id, content, htmlContent, color, isPrivate/private, orderIndex/order, createdAt, lastModified, userId, creator |
| expense | id, amount, detail, category, type, date, source, createdAt, updatedAt, userId, creator |
| budget | id, amount, startDate, endDate, categoryBudgets[], createdAt, updatedAt, userId |
| secret | id, name, categories[], fields[], url, notes, pinned, lastAccessedAt, updatedAt, userId |
| journal | id, content, date, weather, createdAt, updatedAt, userId, creator |
| settings 子项 | aiConfig{aiProvider,aiApiKey,aiBaseUrl,aiModel,aiAgentName,aiSystemPrompt,aiPresets[],...}, cloudAppId/cloudAppKey/cloudAppSecret/cloudToken(百度网盘), autoSyncEnabled, cloudAutoSync, cloudSyncInterval, githubToken, theme/背景图, reminders[] |

## 三、读写层与数据安全机制

### 读写入口（data-service.js）
- `readData(forceReload)`：读 data.json（带内存缓存），缺失时返回空默认结构并首次运行自动生成
- `writeData(...)`：全量写回，原子性由调用方保证
- `updateData(type, updates)`：增量更新指定类型
- `getDataFilePath()` / `getCurrentUserId()` / `isOwnedByUser()`：多用户路径与归属判断（当前用户 admin）

### 数据一致性机制
1. **墓碑（deletedItems）**：删除的条目写入对应类型的墓碑列表（含 id），云同步时用于从云端"拉回删除"；data-manager 已正确实现
2. **去重（deduplicateItems / cleanupDuplicateData）**：按 id 去重；预算额外按 `startDate+endDate` 去重（防云同步重复累积）
3. **多用户隔离（cleanupForeignUserData）**：按 userId 清理不属于当前用户的数据
4. **启动自动备份**：启动时把 data.json 备份到 `app-cache/backups/`

### 云同步合并语义（cloud-sync.js / main.js）
- `mergeItemsWithConflictDetection`：按 id 合并，时间戳新者胜（updatedAt/lastModified 等）
- 预算周期按日期范围去重（`_deduplicateBudgetsByDateRange`）
- `mergeSettings`：云同步合并时 `cloudAutoSync`/`cloudSyncInterval` 本地优先
- `_reconcileWithFreshLocal`：同步窗口内本地新保存的项补回合并结果（防覆盖用户刚做的编辑）
- 聊天室 `_mergeChatRoomsById`、聊天记录 `_mergeChatHistoryStore`（按消息 id+timestamp）

## 四、数据安全警告（重要）

⚠️ `settings.aiApiKey`（DeepSeek Key）、`settings.githubToken`、`settings.cloudToken`（百度网盘）等**明文存储**在 data.json 中，且 `app-cache/app.log` 会打印完整 data.json 内容。处理此类数据时：
- 绝不在文档/对话/日志中输出真实值
- 不改动线上 data.json 做测试，先备份
- 相关凭证建议定期轮换（详见 runbook.md 安全风险节）

## 五、与移动端的数据互通

移动端（Flutter + SQLite）通过同一份百度网盘 `data.json` 快照与桌面端互通，字段完全兼容（详见移动端 docs/architecture/database-mobile.md）：字段别名 `updatedAt↔lastUpdated`、`isPrivate↔private`、`orderIndex↔order`；UUID 共享同一 ID 空间；时间戳新者胜；墓碑双向传播。
