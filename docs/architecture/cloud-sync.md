# 云同步架构文档（百度网盘）

> 桌面端与移动端共用同一个百度网盘账号、同一份 data.json 实现双向同步。

## 一、整体机制

- **传输**：百度网盘 PCS API（cloud-sync.js 主进程）
- **数据单元**：整份 data.json 快照（下载→合并→写回 / 收集→上传）
- **凭证**：OAuth token 存于 `data.json settings.cloudToken/cloudRefreshToken/cloudTokenExpireTime`（明文，敏感）
- **应用标识**：cloudAppId / cloudAppKey / cloudAppSecret（data.json settings 中）

## 二、同步流程

### 手动同步（上传 / 下载）
- 上传：收集本地全部数据 → 写为云端文件
- 下载：拉取云端 data.json → 按类型逐项合并（mergeItems）→ 墓碑处理 → 写回本地

### 自动同步（autoSyncEnabled + cloudAutoSync）
- 间隔：cloudSyncInterval（秒），数据变更后触发
- 触发点：启动时、数据变更后、周期定时器
- 编辑防抖：编辑中的备忘录（Quill）先自动保存再同步，`editingMemoId` 检查避免打断编辑

## 三、合并算法（关键，勿破坏）

### mergeItemsWithConflictDetection
- 按 **id** 合并，时间戳新者胜（updatedAt / lastModified / createdAt / editTime 等）
- 云端有但本地无 → 新增；本地有但云端无 → 保留本地；都有 → 比较时间戳

### 特化合并
| 类型 | 特化逻辑 |
|---|---|
| 预算 budget | 按 **startDate+endDate** 去重（`_deduplicateBudgetsByDateRange`），保留 updatedAt 最新，防重复累积（曾实测 3 个相同周期） |
| 设置 settings | `mergeSettings`：`cloudAutoSync` / `cloudSyncInterval` **本地优先**（防自动同步设置被重置） |
| 聊天室 chatRooms | `_mergeChatRoomsById`：按 id + updateTime 合并 |
| 聊天记录 chatHistoryStore | `_mergeChatHistoryStore`：浅层 key 合并，消息按 id+timestamp |

### 同步窗口竞态保护（`_reconcileWithFreshLocal`）
同步基于开始时的旧快照合并，若同步期间用户新保存了数据，重新读磁盘把新项补回合并结果（`protectAfter` 时间窗内的本地编辑无条件以本地为准），防止内容丢失。

### 墓碑处理（applyDeletionTombstones）
deletedItems 中记录的删除项在合并时从云端结果中剔除（双向传播删除）。

## 四、冲突与去重

- 冲突检测：同 id 双端均有修改 → 时间戳新者胜（无人工冲突面板，桌面端自动裁决；移动端有冲突对照表人工裁决）
- 去重：deduplicateItems 按 id；budget 按日期范围（见上）

## 五、常见坑位

1. **同步窗口覆盖**：改同步逻辑务必保留 `_reconcileWithFreshLocal`，否则用户同步期间的新编辑会被云端旧快照覆盖
2. **预算重复累积**：mergeItems 只按 id 合并 budget，日期范围去重必须在 budget 特化逻辑里做
3. **自动同步被重置**：mergeSettings 必须保留 cloudAutoSync/cloudSyncInterval 本地优先
4. **网络错误文案**：friendlyCloudError 把瞬时网络错误转成用户可读提示，勿直接抛裸报错
5. **移动端互通**：字段别名（updatedAt↔lastUpdated、isPrivate↔private、orderIndex↔order）双端必须保持一致
