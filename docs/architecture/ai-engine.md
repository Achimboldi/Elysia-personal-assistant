# 昔涟 AI 引擎文档（xilian-agent / xilian-tools）

> 运行在主进程。DeepSeek API（OpenAI 兼容）实现 Function Calling 多轮工具循环。

## 一、系统提示词三层结构

```
引擎层 DEFAULT_SYSTEM_PROMPT（xilian-agent.js 硬编码）
  + 实时数据概览 {dataContext}（任务/收支/备忘/日志/预算统计，每 5 轮或数据变更刷新）
  + 当前日期时间 + 用户 ID
  + 用户自定义人设（data.json settings.aiPresets，如 昔涟/桑多涅/哥伦比娅）
  + ai-config/agent-rules.md（AI 可自维护的行为规则，updateAgentRules 工具写入）
```

引擎层核心规则（防幻觉护栏）：
1. **最高优先级：先做事，再说话**——数据操作必须先调工具，禁止没调工具就说"写好了"
2. **修改类操作「先查后改」硬规则**（6.5 节）：先 list 拿到真实 ID → update → 工具返回 success 才算完成
3. **日记四原则**：日期默认今天 / 一次只写一篇 / 内容必须原创 / 不复制聊天记录
4. **完成定义**（8 节）：工具被调用 + success:true + 汇报真实结果，三条全满足才算完成
5. **标准工作流**（9 节）：写日记/改日记/改备忘/改任务/记账的固定步骤
6. **通用输出格式**（9.5 节）：禁止破折号、聊天回复纯对话、禁止动作/心理描写

agent-rules.md 补充规则（AI 可自行修改）：工具调用边界防误触（纯汇报/闲聊不建数据、描述性提及不触发、"宁可少建不可多建"）。

## 二、引擎机制

### 对话流程
1. **首轮流式**（SSE 打字机效果）→ 检测到 tool_calls 切换到非流式（保证 arguments JSON 完整）
2. **多轮工具循环**（maxToolRounds 默认 30），每 5 轮或数据变更时刷新 dataContext 并追加 system 消息
3. 工具执行结果回填 → 继续下一轮

### 防幻觉/防死循环
- **幻觉检测**：`finish_reason='stop'` 但回复含"已创建/已入库/写好了/做好了"等关键词且用户有数据操作意图 → 强制追加 system 消息重试，并点名建议工具（`_suggestToolsForRequest` 按用户文本关键词映射）
- **工具死循环检测**（detectToolLoop）：参数哈希签名；查询类工具阈值 5 次 / 操作类 3 次 / 同工具同参数连续 3 次即中断
- **兜底机制**（终极退路）：模型始终拒绝调工具时，`_fallbackExtractAndExecute` 从回复文本正则提取内容自动构造 toolCall：
  - 创建类：createMemo/createTask/addExpense/addJournal
  - 修改类（`_buildModifyFallback`）：按日期覆盖 addJournal、按引号关键词匹配 updateMemo/updateTask（**恰好匹配 1 条才改，多条不自动改防误伤**；提取不到新值不兜底；只用用户原话提取的值，不用 AI 幻觉回复当内容）
- **网络容错**：fetchWithRetry（仅网络类错误重试、指数退避）、AbortController 2 分钟超时、用户可读错误文案
- **无 API 模式**：buildSimpleReply 关键词兜底回复

### API 调用
- `callDeepSeekAPI`（流式）/ `callDeepSeekAPINonStream`（工具循环）→ `{baseUrl}/v1/chat/completions`
- 默认：provider=deepseek，baseUrl=https://api.deepseek.com，model=deepseek-v4-flash

## 三、工具集（xilian-tools.js，35+ 个）

| 分组 | 工具 |
|---|---|
| 任务 (5) | createTask / updateTask / deleteTask / listTasks / completeTask |
| 笔记 (4) | createMemo / updateMemo / deleteMemo / listMemos |
| 记账 (5) | addExpense / updateExpense / deleteExpense / listExpenses / getExpenseSummary |
| 日志 (2) | addJournal / listJournals |
| 预算 (4) | createBudget / updateBudget / listBudgets / getBudgetStatus |
| 设置 (3) | getSettings / updateSettings / switchUser |
| 云同步 (2) | triggerSync / getSyncStatus |
| 概览 (1) | getDashboard |
| 记忆 (4) | recall_memory / browse_memories / correct_memory / update_current_state |
| 自我迭代 (6) | listAppFiles / readAppFile / searchAppCode / runNodeCheck / writeAppFile / updateAgentRules |
| 提醒 (4) | createReminder / listReminders / updateReminder / deleteReminder |

- **删除确认**：deleteTask/deleteMemo/deleteExpense/deleteReminder + writeAppFile/updateAgentRules 需要弹窗确认（TOOLS_REQUIRING_CONFIRM）
- **写保护黑名单**：xilian-agent.js / main.js / data.json 不可写
- **参数容错**：3 级修复（清换行/移除换行/补闭合 JSON）
- **记忆工具懒加载**：Lazy require memory 模块（encryption 需 .env 已加载），失败返回"记忆系统未就绪"

## 四、聊天状态管理（渲染层）

- xilian-manager.js：聊天状态、IPC、消息管理、**MC 数据桥**（`_mcIngestNewMessages` 增量把 user/assistant 消息喂进记忆系统）、聊天室 @提及、多预设切换
- xilian-ui.js：DOM 渲染、流式更新 RAF 节流、滚动管理
- xilian-settings.js：provider/模型配置、预设管理（建/删/克隆）

## 五、优化历史（参考）

《智能体优化方案_v1.md》P0（系统提示词强化：先查后改/完成定义/日记四原则/标准工作流）+ P1（幻觉重试点名工具、兜底覆盖修改类）已执行（2026-07-31）。P2（代码级 Skill 注册表）未做，观察中。
