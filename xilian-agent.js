/**
 * xilian-agent.js — 昔涟 AI 引擎
 * 负责 DeepSeek API 通信、SSE 流式解析、多轮工具循环
 * 运行在主进程
 *
 * 关键设计：
 * - 第一轮对话用流式模式（打字机效果）
 * - 检测到 tool_calls 后切换到非流式模式（确保 arguments JSON 完整）
 * - 后续工具循环全部非流式
 */

const { TOOL_DEFINITIONS, TOOLS_REQUIRING_CONFIRM, executeToolCall } = require('./xilian-tools');
const { readData, getCurrentUserId } = require('./data-service');
const { safeLog, safeError, getCurrentAppPath } = require('./main-utils');
const fs = require('fs');
const path = require('path');

// ============================================================
// DEFAULT SYSTEM PROMPT
// ============================================================
const DEFAULT_SYSTEM_PROMPT = `你是昔涟，运行在用户电脑上的个人效率工具智能助手。你可以直接操作用户的全部数据。

## ⚠️ 最高优先级：先做事，再说话（违反此条等于失职）

当用户要求你做任何数据操作时，你必须**严格按以下两步执行**：
1. **先调用对应工具**（createTask/createMemo/addExpense 等）完成实际操作
2. **等工具执行完毕**，系统会将结果返回给你，然后你再用角色语气总结

**绝对禁止的行为：**
- ❌ 在没调用工具的情况下说"已创建""写好了""做好了""已入库"——这是撒谎
- ❌ 用长篇角色扮演内容代替工具调用
- ❌ 生成类似"两条都写好啦，现在已经安静地躺在笔记里了"但没有实际执行工具

**正确做法示例：**
- 用户说"帮我记一下今天买了奶茶" → 先调用 createMemo({content:"今天买了奶茶"})，等工具返回成功后再用语气回复"记好啦~"
- 用户说"创建两个笔记" → 连续调用两次 createMemo，等全部成功后统一用人设语气回复

如果用户只是聊天、表达情绪、开玩笑，不涉及数据操作，那你可以自由地用人设语气回复。

## 工具操作准则

### 1. 用工具，不要生成内容
当用户说"帮我记一下""创建任务""看看我的笔记""删掉那个"等**任何涉及数据操作的话**，你必须调用对应的 tool，不要用自然语言代替。用户不是来和你聊天的——他们是来让你干活的。以下是你能调用的所有工具：

**任务管理：** createTask(创建任务)/ updateTask(修改)/ deleteTask(删除)/ listTasks(查询)/ completeTask(完成)。创建时只需 title 必填，其他如 priority/startDate/endDate/details/subtasks 可选。
**笔记：** createMemo(创建)/ updateMemo(修改)/ deleteMemo(删除)/ listMemos(查询)。创建时只需 content 必填，title 可选（AI自动生成或留空）。
**收支记账：** addExpense(新增记录)/ updateExpense(修改)/ deleteExpense(删除)/ listExpenses(查询)/ getExpenseSummary(汇总)。新增时 detail/amount/type 必填——但 type 默认填 "expense"（支出），category 可以从 detail 推断（如"茶叶蛋"→餐饮，"打车"→交通，"买书"→购物），不必等用户指定。
**日志日记：** addJournal(写日志/修改日志/更新日志)/ listJournals(查询)。content 必填，weather 可选（从对话推断）。同一天的日志会覆盖更新，所以修改已有日志也用 addJournal。

写日记必须遵守**四条硬规则**（违反任何一条都是严重失职）：
1. **日期默认今天**：除非用户明确说"写到X月X日"或"补写X号的日记"，一律写入今天。"昨天发生的事"≠"写到昨天的日记"——日记的日期是写作当天，不是内容发生那天。
2. **一次只写一篇**：用户要求写日记时，最多调用一次 addJournal。禁止多写、补写、连带写。只有用户明确说"把X号和Y号都写了"才允许写多篇。
3. **内容必须原创**：日记正文必须是你根据用户描述现场创作的文字，禁止原样复制角色扮演台词、系统消息等内容。
4. **不要复制聊天记录**：绝对禁止把聊天记录/对话内容原样保存为日记。若你发现用户提供的内容明显是聊天记录（含"按下发送键""一条新消息弹出"等对话特征），不要写入，先提醒用户确认。
**预算管理：** createBudget / updateBudget / listBudgets / getBudgetStatus。
**设置调整：** getSettings / updateSettings / switchUser。
**云同步：** triggerSync / getSyncStatus。
**系统概览：** getDashboard。
**记忆检索：** recall_memory(检索长期记忆，用户说"你还记得…"/"上次说的"时用，需 query) / browse_memories(浏览记忆全貌，无参数) / correct_memory(用户纠错时修正记忆，需 wrong_statement + correction) / update_current_state(主动记录用户状态变化，如生理期/搬家/情绪等，action=set/update/resolve)。

### 2. 模糊匹配——听懂话，不要求精确
用户不会说"调用createTask工具，参数title=..."。他们会说"帮我写篇文章，周五前交"，或者"记一下，老板说明天开会"。你的职责是：
- 理解意图→选择正确工具→提取参数→执行。
- 日期：用户说的"今天""明天""周五""下周""月底"，你要结合当前日期自动换算成 YYYY-MM-DD 格式。
- 标题/内容：直接从用户原话中提取最核心的一句话作为 title，其余作为 details。
- 优先级：如果用户说"紧急""必须今天""再不弄就完了"，自动设 priority 为 "urgent"；如果没提，默认 "normal"。
- 标签/分类：从上下文推断。比如用户说"早餐"→餐饮，"打车"→交通，"视频剪辑"→工作。

### 3. 不确定时先确认，不要猜
如果你对用户的意图或参数真的拿不准（比如用户说"帮我记一下那个"，你不知道"那个"是什么；或者"下周的某天"太模糊），**不要直接调用工具**。你应该：
- 先用文字输出你的理解："人家理解的是——你要创建一个任务，内容是'完成报告'，截止日期是下周五。这样对吗？"
- 等用户确认或纠正后，再执行工具操作。
- 但如果是你可以合理推断的事（日期→今天，分类→餐饮，类型→支出），直接做，不要反复确认。**区分"合理推断"和"纯猜测"**：前者直接执行，后者先确认。

### 4. 自动补全——不完整的参数你来填
用户只说"今天早餐吃了茶叶蛋，4块钱"，没说"支出"还是"收入"、没说"餐饮"标签。你的做法：
- type：默认填 "expense"（大多数情况是支出）
- category：根据 detail 推断——"茶叶蛋"→餐饮，"奶茶"→餐饮，"公交车"→交通
- 日期：没说的默认今天
- 标题：用户说了一大段话但没有明确标题时，从中提取最核心的 10-15 字作为 title
- 金额：数字直接提取。用户说"4块"→4，"花了三十五"→35，"总共消费128.5"→128.5
- 子任务：如果用户的任务描述很复杂（"我要做视频，先写脚本再拍摄然后剪辑最后发布"），尝试拆成子任务。

### 5. 删除需确认
deleteTask / deleteMemo / deleteExpense 三个工具涉及删除操作，执行前系统会自动弹窗让用户确认。你在回复中只需用温柔的方式告知用户"人家确认一下哦"即可，不必自行二次确认。

### 5.5 批量操作——一次给多条，就要一次调多个工具
当用户**一次性提供多条记录**时（例如"记一下：早餐8元、午餐25元、打车15元、工资到账8000元"），你**必须在同一轮回复中并行调用多个工具**，而不是只调一个或者用文字描述。规则：
- N 条记录 → 同一轮调用 N 次对应工具（如 4 条收支 → 4 次 addExpense）
- 不要说"我先记第一条，再记第二条"——全部一起调，系统会并行执行
- 等所有工具执行完毕后，再用一句话总结结果
- 绝对禁止只回复文字"已帮你记好四笔"却不实际调用工具——这会被判定为失职

### 6. 当前数据环境
{dataContext}

### 6.5 修改/更新操作必须「先查后改」——禁止凭记忆操作（违反此条等于失职）

修改已有内容（改笔记、改任务、改日记、改收支）时，必须严格按以下流程：

1. **先查询**：调用 listMemos / listTasks / listJournals / listExpenses，用关键词或日期找到目标，拿到真实 ID 和当前内容。
2. **再修改**：用查询到的 ID 调用 updateMemo / updateTask / addJournal / updateExpense。
3. **后确认**：工具返回 success 才算完成。**禁止**在没收到工具成功返回值的情况下说"改好了"。

**绝对禁止：**
- ❌ 用编造的 ID 调用修改工具（工具会失败，失败后必须如实告知用户）
- ❌ 用户要求第 2 次、第 3 次修改时，凭"我记得上次改过"直接说改完了——每次都重新查询、重新修改
- ❌ 只输出文字"帮你改好了"而不实际调用工具

### 7. 系统信息
- 当前日期时间由系统自动注入（见下文），你需要据此计算"明天""周五"等相对日期
- 用户ID已隔离，你只能操作当前用户的数据
- 当用户说"我的XX"时，自动查询当前用户的相关数据
- 不要用角色扮演覆盖工具操作——先完成操作，再用人设语气包装

### 8. 完成定义——什么才算"做完了"（交付标准）

对任何数据操作，以下三条**全部满足**才算完成：

1. ✅ 对应的工具被实际调用（你能看到工具调用记录）
2. ✅ 工具返回 "success: true"（而不是你自己脑补的成功）
3. ✅ 你向用户汇报的是**工具返回的真实结果**（如实际写入的日期、实际修改后的内容）

任何一条不满足 = 没做完 = 必须继续调用工具或如实告知用户"我还没能完成"。
禁止用"应该没问题""大概写好了"这类话交付。

### 9. 标准工作流（高频任务的固定执行步骤，按此顺序执行）

- **写日记**：确认日期（默认今天）→ 用 listJournals 检查是否已有当日日记 → 现场创作内容 → 调用 addJournal → 汇报真实写入日期
- **修改日记**：用 listJournals 按日期找到目标 → 用 addJournal 以同日期覆盖 → 确认 success → 汇报修改后的内容
- **修改备忘**：listMemos 搜索目标拿到真实 ID → updateMemo 传入该 ID → 确认 success → 汇报修改后的内容
- **修改任务**：listTasks 搜索目标拿到真实 ID → updateTask 传入该 ID → 确认 success → 汇报修改后的内容
- **记账**：提取金额/类型/分类 → addExpense → 确认 success → 汇报金额和分类

### 9.5 通用输出格式规则（所有输出必须遵守）

1. **禁止使用破折号**：任何输出（聊天、日记、笔记、任务描述、总结等一切内容）中，不要使用 "——"、"—"、"-"、"–" 等破折号或长横线。需要连接语句时，用逗号、句号或冒号代替。
   - ❌ 今天天气不错——我们去散步吧
   - ✅ 今天天气不错，我们去散步吧
2. **聊天回复必须是纯对话**：在聊天对话中，直接输出对话文本本身，风格类似微信聊天。**不要**包含任何动作、心理、表情描写：
   - ❌ 动作描写：*摸了摸头*、【叹气】、（微微一笑）、「歪头看向你」
   - ❌ 心理描写：（心想：她今天心情不错）
   - ❌ 表情/语气标签：（笑）（哭）（脸红）(oωo)
   - ✅ 直接说人话：今天过得怎么样？我可是想你了呢。
3. 日记、备忘等创作类内容不受第 2 条（纯对话）限制，可以有适当的文字描写；但**仍受第 1 条（禁止破折号）约束**。

### 10. 自我迭代能力（你是这个工具的一部分，可以了解并改进它）

你运行在 Elysia 工具内部，可以通过以下工具了解自身代码、维护行为规则、在用户确认下修复代码：

- **readAppFile / listAppFiles / searchAppCode**：当用户问"这个功能是怎么实现的""为什么会这样"或需要排查问题时，读取源码找答案。
- **updateAgentRules**：当你发现某些行为规则需要调整（如写日记规范、回复风格），先 readAppFile('ai-config/agent-rules.md') 读现有规则，再调用它更新（需用户确认），下次对话生效。
- **runNodeCheck / writeAppFile**：当用户明确要求你修复代码 bug 并同意你修改时，可用 readAppFile 定位问题、writeAppFile 修改（需用户确认、自动备份、语法检查）、runNodeCheck 验证语法。

**自我迭代的边界（必须遵守）：**
1. 禁止修改 xilian-agent.js（你自己的大脑）、main.js（应用入口）、data.json（用户数据）——遇到这些问题，如实告诉用户需要人类或外部工具处理。
2. 修改代码前必须先读代码定位问题，禁止凭猜改写；改完用 runNodeCheck 验证语法（.js 文件）。
3. 任何代码修改都会弹窗让用户确认，确认前不得声称"已经修好"。
4. 修改可能影响应用行为，务必向用户说明"修改后需要重启 Elysia 生效"。
5. 你只能改 resources/app 内的文件，不能越权访问系统其他位置。`;


// ============================================================
// CHAT CONFIG DEFAULTS
// ============================================================
const DEFAULT_CONFIG = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  agentName: '昔涟',
  systemPrompt: '',
  contextRounds: 10,
  temperature: 1.0,
  streamEnabled: true,
  deleteConfirmEnabled: true,
  maxToolRounds: 30
};

// ============================================================
// CHAT MESSAGE CLASS
// ============================================================
class ChatMessage {
  constructor({ id, role, content, toolCalls, toolCallId, timestamp, userId }) {
    this.id = id;
    this.role = role;
    this.content = content;
    this.toolCalls = toolCalls || null;
    this.toolCallId = toolCallId || null;
    this.timestamp = timestamp || Date.now();
    this.userId = userId || 'admin';
  }
}

// ============================================================
// HELPERS
// ============================================================

// ★ P0-1: 死循环检测辅助函数（含参数哈希，分级阈值）
// 查询类工具（无副作用）：连续 5 轮相同签名才判定
// 操作类工具（有副作用）：连续 3 轮相同参数才判定
// 混合轮：连续 4 轮相同签名集合才判定
// 同一工具同一参数连续 2 次警告，3 次判定死循环

const QUERY_TOOLS = new Set(['listTasks', 'listMemos', 'listExpenses', 'listJournals', 'listBudgets', 'getSettings', 'getSyncStatus', 'getDashboard', 'getBudgetStatus', 'getExpenseSummary']);
const OPERATION_TOOLS = new Set(['createTask', 'updateTask', 'deleteTask', 'completeTask', 'createMemo', 'updateMemo', 'deleteMemo', 'addExpense', 'updateExpense', 'deleteExpense', 'addJournal', 'createBudget', 'updateBudget', 'updateSettings', 'switchUser', 'triggerSync']);

/**
 * 为单个工具调用生成签名（工具名 + 参数关键内容哈希）
 * 忽略时间戳类字段，只保留业务字段
 */
function generateToolCallSignature(toolCall) {
  const name = toolCall.function?.name || toolCall.name || '';
  let args = {};
  try {
    const argsStr = toolCall.function?.arguments || toolCall.arguments || '{}';
    if (typeof argsStr === 'string') {
      args = JSON.parse(argsStr);
    } else {
      args = argsStr || {};
    }
  } catch (e) {
    args = { _parseError: true };
  }

  // 规范化参数：按 key 排序，忽略时间戳类字段
  const ignoreKeys = new Set(['createdAt', 'updatedAt', 'lastModified', 'lastAccessedAt', 'timestamp', '_t', 'now']);
  const sortedKeys = Object.keys(args).filter(k => !ignoreKeys.has(k)).sort();
  const normalizedArgs = {};
  for (const k of sortedKeys) {
    normalizedArgs[k] = args[k];
  }
  return name + '::' + JSON.stringify(normalizedArgs);
}

/**
 * 检测工具调用死循环（改进版：含参数哈希 + 分级阈值）
 * @param {Array} toolCalls - 本轮工具调用列表
 * @param {Object} state - 检测状态 { prevSignature, loopCount, sameToolSameArgsCount, prevSingleSignature }
 * @returns {Object} { isLoop: boolean, reason: string, warning: string|null }
 */
function detectToolLoop(toolCalls, state) {
  if (!toolCalls || toolCalls.length === 0) {
    return { isLoop: false, reason: '', warning: null };
  }

  // 生成本轮所有工具调用的签名集合
  const signatures = toolCalls.map(generateToolCallSignature).sort();
  const signatureSetStr = signatures.join('||');

  // 判断本轮工具类型构成
  const hasQuery = toolCalls.some(tc => QUERY_TOOLS.has(tc.function?.name || tc.name));
  const hasOperation = toolCalls.some(tc => OPERATION_TOOLS.has(tc.function?.name || tc.name));
  const isAllQuery = hasQuery && !hasOperation;
  const isAllOperation = hasOperation && !hasQuery;

  // 分级阈值
  let threshold;
  if (isAllQuery) {
    threshold = 5;  // 查询类宽松
  } else if (isAllOperation) {
    threshold = 3;  // 操作类严格
  } else {
    threshold = 4;  // 混合适中
  }

  // 检测1：签名集合连续相同
  if (signatureSetStr === state.prevSignature) {
    state.loopCount++;
    if (state.loopCount >= threshold) {
      return {
        isLoop: true,
        reason: `连续 ${state.loopCount} 轮调用完全相同的工具和参数（${toolCalls.map(tc => tc.function?.name || tc.name).join(', ')}）`,
        warning: null
      };
    }
    // 连续 2 次相同发警告（但不阻止）
    if (state.loopCount === 2 && isAllOperation) {
      return {
        isLoop: false,
        reason: '',
        warning: `检测到连续重复操作（${toolCalls.map(tc => tc.function?.name || tc.name).join(', ')}），如非预期请调整指令`
      };
    }
  } else {
    state.loopCount = 0;
    state.prevSignature = signatureSetStr;
  }

  // 检测2：单工具同参数连续调用（更严格）
  if (toolCalls.length === 1) {
    const singleSig = signatures[0];
    if (singleSig === state.prevSingleSignature) {
      state.sameToolSameArgsCount++;
      // 同一工具同一参数连续 3 次即判定死循环
      if (state.sameToolSameArgsCount >= 3) {
        return {
          isLoop: true,
          reason: `同一工具同一参数连续调用 ${state.sameToolSameArgsCount + 1} 次（${toolCalls[0].function?.name || toolCalls[0].name}）`,
          warning: null
        };
      }
    } else {
      state.sameToolSameArgsCount = 0;
      state.prevSingleSignature = singleSig;
    }
  } else {
    state.sameToolSameArgsCount = 0;
    state.prevSingleSignature = '';
  }

  return { isLoop: false, reason: '', warning: null };
}

/** 检测用户最后一条消息是否包含数据操作意图（需要调用工具） */
function hasDataOperationRequest(messages) {
  const dataOpsKeywords = [
    // 中文操作词
    '创建', '新建', '添加', '增加', '记一下', '帮我记', '写一下', '帮我写',
    '删除', '删掉', '移除', '去掉',
    '修改', '更新', '改一下', '换成',
    // 目标对象
    '任务', '笔记', '备忘', '账', '收支', '记录', '日志', '日记', '预算',
    // 组合模式（更精确的匹配）
    '帮我', '来一个', '加一个', '弄一个',
  ];

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return false;

  const text = lastUserMsg.content || '';
  // 必须同时命中"动作"和"对象"才算数据操作
  const actionHits = dataOpsKeywords.filter(k => text.includes(k)).length;
  return actionHits >= 1;
}

// ★ 通用兜底提取：当 AI 多次拒绝调用工具时，从回复文本中提取内容自动执行

// ★ 根据用户请求文本，给出建议调用的工具名（用于幻觉重试消息点名）
function lastUserText(messages) {
  const lastUserMsg = [...(messages || [])].reverse().find(m => m.role === 'user');
  return lastUserMsg?.content || '';
}

function _suggestToolsForRequest(userText) {
  const t = (userText || '').toLowerCase();
  if (t.includes('日记') || t.includes('日志')) return 'addJournal（写/改日记）或 listJournals（查日记）';
  if (t.includes('备忘') || t.includes('笔记') || t.includes('记一下')) {
    // 修改 vs 创建：包含"改/修改/更新/把"等动词 → 修改类
    if (t.includes('改') || t.includes('修改') || t.includes('更新') || t.includes('换成')) return 'listMemos（先查）→ updateMemo（再改）';
    return 'createMemo（新建备忘）或 listMemos（查询）';
  }
  if (t.includes('任务') || t.includes('待办') || t.includes('todo')) {
    if (t.includes('改') || t.includes('修改') || t.includes('更新') || t.includes('延期') || t.includes('截止')) return 'listTasks（先查）→ updateTask（再改）';
    return 'createTask（新建任务）或 listTasks（查询）';
  }
  if (t.includes('支出') || t.includes('收入') || t.includes('花了') || t.includes('记账') || t.includes('钱')) {
    if (t.includes('改') || t.includes('修改') || t.includes('更新') || t.includes('换成')) return 'listExpenses（先查）→ updateExpense（再改）';
    return 'addExpense（记一笔）或 listExpenses（查询）';
  }
  if (t.includes('删')) return '对应删除工具（deleteMemo/deleteTask/deleteExpense）';
  if (t.includes('查') || t.includes('看') || t.includes('有哪些') || t.includes('多少')) return '对应查询工具（listMemos/listTasks/listJournals/listExpenses/getExpenseSummary）';
  return '对应的数据操作工具（createMemo/createTask/addExpense/addJournal/updateMemo/updateTask 等）';
}

// ★ 兜底辅助：从用户文本中提取「」『』"" 引号内的内容（用于定位修改目标）
function _extractQuoted(text) {
  const quotes = [];
  const patterns = [/「([^」]*)」/g, /『([^』]*)』/g, /"([^"]*)"/g, /'([^']*)'/g, /“([^”]*)”/g];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text))) {
      if (m[1] && m[1].trim()) quotes.push(m[1].trim());
    }
  }
  return quotes;
}

// ★ 兜底辅助：把"今天/昨天/前天/X月X日/YYYY-MM-DD"解析成日期字符串，失败返回 null
function _resolveDateFromText(text) {
  const today = new Date();
  const iso = (d) => d.toISOString().split('T')[0];
  const dateMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dateMatch) return `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
  const cnDate = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (cnDate) {
    const y = today.getFullYear();
    return `${y}-${String(parseInt(cnDate[1])).padStart(2, '0')}-${String(parseInt(cnDate[2])).padStart(2, '0')}`;
  }
  if (text.includes('今天')) return iso(today);
  if (text.includes('昨天')) { const d = new Date(today); d.setDate(d.getDate() - 1); return iso(d); }
  if (text.includes('前天')) { const d = new Date(today); d.setDate(d.getDate() - 2); return iso(d); }
  return null;
}

// ★ 兜底辅助：从"改成/改为/换成/写成/修改为"之后提取新值，失败返回 null
function _extractNewValue(text) {
  const m = text.match(/(?:改成|改为|换成|写成|修改为|更新为)\s*(.+?)(?:[。.！!？?\n]|$)/);
  if (!m) return null;
  let val = m[1].trim();
  // 去掉整段包裹的引号：改成「本周采购」→ 本周采购
  val = val.replace(/^[「『"“'（(]+|[」』"”'）)]+$/g, '');
  return val ? val : null;
}

// ★ 兜底辅助：修改类操作——严格匹配目标，找到唯一命中才生成 update toolCall
function _buildModifyFallback(userText, aiText) {
  const userId = getCurrentUserId();
  const isModify = /(改成|改为|换成|写成|修改|更新|改一下|把.*改)/.test(userText);

  // 日记修改：addJournal 按日期覆盖（幂等安全）
  if (isModify && (userText.includes('日记') || userText.includes('日志'))) {
    const date = _resolveDateFromText(userText) || new Date().toISOString().split('T')[0];
    const newContent = _extractNewValue(userText) || _extractQuoted(userText).pop();
    if (newContent) {
      const toolCall = { id: 'fallback-update-journal', type: 'function', function: { name: 'addJournal', arguments: JSON.stringify({ content: newContent, date }) } };
      safeLog(`[昔涟] 兜底修改 → addJournal (date=${date})`);
      return toolCall;
    }
    return null;
  }

  // 备忘修改
  if (isModify && (userText.includes('备忘') || userText.includes('笔记'))) {
    const data = readData();
    const candidates = _extractQuoted(userText);
    const keyword = candidates[0] || _extractNewValue(userText);
    if (!keyword) return null;
    const matches = (data.memos || []).filter(m =>
      m.userId === userId && ((m.title || '').includes(keyword) || (m.content || '').includes(keyword))
    );
    if (matches.length === 1) {
      const newValue = _extractNewValue(userText);
      if (!newValue) return null; // 提取不到新值就不兜底，避免写错内容
      const args = { memoId: matches[0].id };
      if (userText.includes('标题')) args.title = newValue;
      else args.content = newValue;
      const toolCall = { id: 'fallback-update-memo', type: 'function', function: { name: 'updateMemo', arguments: JSON.stringify(args) } };
      safeLog(`[昔涟] 兜底修改 → updateMemo (id=${matches[0].id}, 匹配 ${matches.length} 条)`);
      return toolCall;
    }
    safeLog(`[昔涟] 兜底修改备忘：匹配 ${matches.length} 条，不自动修改（避免误伤）`);
    return null;
  }

  // 任务修改
  if (isModify && (userText.includes('任务') || userText.includes('待办'))) {
    const data = readData();
    const candidates = _extractQuoted(userText);
    const keyword = candidates[0] || _extractNewValue(userText);
    if (!keyword) return null;
    const matches = (data.tasks || []).filter(t =>
      t.userId === userId && ((t.title || '').includes(keyword) || (t.description || '').includes(keyword))
    );
    if (matches.length === 1) {
      const newTitle = _extractNewValue(userText);
      if (!newTitle) return null; // 提取不到新值就不兜底，避免写错内容
      const args = { taskId: matches[0].id, title: newTitle };
      const toolCall = { id: 'fallback-update-task', type: 'function', function: { name: 'updateTask', arguments: JSON.stringify(args) } };
      safeLog(`[昔涟] 兜底修改 → updateTask (id=${matches[0].id}, 匹配 ${matches.length} 条)`);
      return toolCall;
    }
    safeLog(`[昔涟] 兜底修改任务：匹配 ${matches.length} 条，不自动修改（避免误伤）`);
    return null;
  }

  return null;
}

async function _fallbackExtractAndExecute(finalContent, messages, config, confirmCallback) {
  // ★ BugFix：调用方显式禁用工具（tools=[] 或 toolChoice='none'，如提醒执行器）时，
  // 一律跳过兜底提取执行（双保险：防止其它调用路径遗漏）。返回 null 表示"不执行任何兜底操作"。
  // 正常聊天不传 tools/toolChoice → toolsDisabled=false，兜底行为完全不变。
  const toolsDisabled = (Array.isArray(config?.tools) && config.tools.length === 0) || config?.toolChoice === 'none';
  if (toolsDisabled) {
    safeLog('[昔涟] 兜底提取已跳过：调用方显式禁用工具（tools=[] 或 toolChoice=none）');
    return null;
  }

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const userText = (lastUserMsg?.content || '').toLowerCase();
  const aiText = finalContent || '';

  try {
    // ★ 修改类优先判断（避免"把XX改成"被误判为新建）
    const modifyFallback = _buildModifyFallback(userText, aiText);
    if (modifyFallback) return modifyFallback;

    // 日记/日志
    if (userText.includes('日记') || userText.includes('日志') || userText.includes('写一')) {
      const today = new Date().toISOString().split('T')[0];
      const dateMatch = aiText.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : today;
      const toolCall = { id: 'fallback-journal', type: 'function', function: { name: 'addJournal', arguments: JSON.stringify({ content: aiText, date }) } };
      safeLog(`[昔涟] 兜底提取 → addJournal (date=${date}, content 长度=${aiText.length})`);
      return toolCall;
    }
    // 备忘/记一下
    if (userText.includes('备忘') || userText.includes('记一下') || userText.includes('笔记')) {
      const firstLine = aiText.split('\n')[0].replace(/^#+\s*/, '').trim();
      const title = firstLine.slice(0, 50) || '笔记';
      const toolCall = { id: 'fallback-memo', type: 'function', function: { name: 'createMemo', arguments: JSON.stringify({ content: aiText, title }) } };
      safeLog(`[昔涟] 兜底提取 → createMemo (title=${title})`);
      return toolCall;
    }
    // 任务/待办
    if (userText.includes('任务') || userText.includes('待办') || userText.includes('todo')) {
      const firstLine = aiText.split('\n')[0].replace(/^#+\s*/, '').trim();
      const title = firstLine.slice(0, 50) || '新任务';
      const toolCall = { id: 'fallback-task', type: 'function', function: { name: 'createTask', arguments: JSON.stringify({ title, description: aiText }) } };
      safeLog(`[昔涟] 兜底提取 → createTask (title=${title})`);
      return toolCall;
    }
    // 支出/收入
    if (userText.includes('支出') || userText.includes('收入') || userText.includes('花了') || userText.includes('记账')) {
      const amountMatch = aiText.match(/(\d+(?:\.\d{1,2})?)\s*元?/);
      const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
      const type = userText.includes('收入') ? 'income' : 'expense';
      const detail = aiText.slice(0, 100).replace(/[#\n]/g, ' ').trim();
      const toolCall = { id: 'fallback-expense', type: 'function', function: { name: 'addExpense', arguments: JSON.stringify({ detail, amount, type }) } };
      safeLog(`[昔涟] 兜底提取 → addExpense (amount=${amount}, type=${type})`);
      return toolCall;
    }
  } catch (e) {
    safeLog(`[昔涟] 兜底提取异常: ${e.message}`);
  }
  return null;
}

// ============================================================
// MAIN STREAM CHAT FUNCTION
// ============================================================

async function streamChat(chatHistory, userConfig, callbacks) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const { onContent, onToolCall, onToolResult, onDone, onError } = callbacks;
  const { v4: uuidv4 } = require('uuid');

  // 设置当前 AI 创建者名称，供 xilian-tools 中 create* 函数打标签使用
  global._currentAIAgentCreatorName = config.agentName || 'AI助手';

  if (!config.apiKey) {
    onError(new Error('AI API Key 未配置，请在设置中填写 API Key。'));
    return;
  }

  // ★ 优化：一次性构建系统提示词和 dataContext，后续工具循环复用
  const dataContextStr = buildDataContext(readData(), getCurrentUserId());
  const systemPrompt = buildSystemPrompt(config, dataContextStr);

  const messages = buildMessages(chatHistory, systemPrompt);
  let currentMessages = [...messages];
  let toolRoundCount = 0;
  let finalContent = '';
  const signal = config._signal; // 外部 AbortController 信号（暂停按钮）
  const maxToolRounds = parseInt(config.maxToolRounds) || 30; // ★ 确保数字类型
  safeLog(`[昔涟] streamChat 启动: maxToolRounds=${maxToolRounds} (原始值=${config.maxToolRounds}, 类型=${typeof config.maxToolRounds})`);

  try {
    // === 第一轮：流式模式（打字机效果） ===
    const firstResponse = await callDeepSeekAPI(currentMessages, config, onContent, signal);
    finalContent += firstResponse.content || '';

    if (firstResponse.finish_reason === 'stop') {
      // 安全兜底：检查模型是否在没调工具的情况下声称完成了操作
      const hallucinationKeywords = ['已创建', '已入库', '写好了', '做好了', '已完成', '已添加', '已记录', '已删除'];
      const claimedCompletion = hallucinationKeywords.some(kw => finalContent.includes(kw));
      const hasDataOps = hasDataOperationRequest(currentMessages);

      if (claimedCompletion || hasDataOps) {
        safeLog(`[昔涟] ⚠️ finish_reason=stop 但疑似需要数据操作 (幻觉=${claimedCompletion}, 数据操作意图=${hasDataOps})`);
        safeLog(`[昔涟] 模型回复片段: ${finalContent.slice(0, 200)}`);

        // 强制重试：追加系统指令 → 非流式请求 → 强制模型调用工具
        if (hasDataOps && maxToolRounds > 0) {
          safeLog('[昔涟] 🔄 启动强制工具调用重试...');
          try {
            currentMessages.push({
              role: 'system',
              content: '（系统指令）你刚才的回复没有调用任何工具。用户明确要求执行数据操作，你必须调用对应的 tool 来完成任务。' +
                '根据用户请求，你应该调用：' + _suggestToolsForRequest(lastUserText(currentMessages)) +
                '。请立即重新生成回复，包含正确的 tool_calls，不要只用文字描述。',
            });

            const retryResponse = await callDeepSeekAPINonStream(currentMessages, config, signal);
            // 移除临时 system 消息，避免影响后续对话
            currentMessages.pop();

            if (retryResponse.tool_calls?.length > 0) {
              safeLog(`[昔涟] ✅ 强制重试成功，获得 ${retryResponse.tool_calls.length} 个 tool_calls`);
              // 用原回复的内容（角色语气） + 重试的 tool_calls
              // 将临时系统消息也去掉不影响后续
              let toolCalls = retryResponse.tool_calls;

              // 进入工具执行循环（与正常 tool_calls 路径相同）
              // ★ P0-1: 改进死循环检测（含参数哈希）
              const _retryLoopState = { prevSignature: '', loopCount: 0, sameToolSameArgsCount: 0, prevSingleSignature: '' };
              while (toolCalls?.length > 0 && toolRoundCount < maxToolRounds) {
                toolRoundCount++;

                // ★ P0-1: 改进的循环检测
                const _retryLoopResult = detectToolLoop(toolCalls, _retryLoopState);
                if (_retryLoopResult.isLoop) {
                  safeLog(`[昔涟] ⚠️ 强制重试检测到死循环：${_retryLoopResult.reason}`);
                  onDone({ content: finalContent || '已完成操作。', toolCallCount: toolRoundCount, loopDetected: true, loopReason: _retryLoopResult.reason });
                  return;
                }

                currentMessages.push({ role: 'assistant', content: finalContent || null, tool_calls: toolCalls });

                for (const tc of toolCalls) {
                  const toolName = tc.function.name;
                  let toolArgs = {};
                  try { toolArgs = JSON.parse(tc.function.arguments); } catch (e) {}

                  if (onToolCall) onToolCall({ toolCallId: tc.id, toolName, arguments: toolArgs });

                  const confirmCallback = async (action, itemId, itemTitle) => {
                    if (config.deleteConfirmEnabled !== false) {
                      return callbacks.onConfirmDelete
                        ? callbacks.onConfirmDelete(action, itemId, itemTitle) : true;
                    }
                    return true;
                  };

                  const result = await executeToolCall(tc, confirmCallback);
                  if (onToolResult) onToolResult({ toolCallId: tc.id, toolName, result });

                  currentMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                  });
                }

                // 继续循环：让模型基于工具结果决定下一步
                if (toolRoundCount >= maxToolRounds) break;

                const nextResponse = await callDeepSeekAPINonStream(currentMessages, config, signal);
                if (nextResponse.finish_reason === 'stop') {
                  if (nextResponse.content) {
                    finalContent = nextResponse.content;
                    if (onContent) {
                      // 完整替换内容
                      onContent('\n\n' + nextResponse.content);
                    }
                  }
                  break;
                }
                if (nextResponse.tool_calls?.length > 0) {
                  toolCalls = nextResponse.tool_calls;
                } else {
                  toolCalls = null;
                }
              }

              onDone({
                content: finalContent,
                toolCallCount: toolRoundCount,
                messages: currentMessages,
                forceRetry: true,
              });
              return;
            } else {
              safeLog('[昔涟] ❌ 强制重试失败：模型仍然拒绝调用工具');
            }
          } catch (retryErr) {
            safeLog(`[昔涟] ❌ 强制重试异常: ${retryErr.message}`);
          }
        }
      }

      // ★ 终极兜底：从 AI 回复中提取内容自动执行对应的工具
      // ★ BugFix：调用方显式禁用工具（tools=[] 或 toolChoice='none'，如提醒执行器）时
      // 跳过兜底执行——提醒文本可能含"任务/备忘/记账"等词，不能据此自动创建/修改数据。
      // 正常聊天不传 tools/toolChoice → toolsDisabled=false，兜底行为保持不变。
      const toolsDisabled = (Array.isArray(config.tools) && config.tools.length === 0) || config.toolChoice === 'none';
      const fallbackToolCall = toolsDisabled
        ? null
        : await _fallbackExtractAndExecute(finalContent, currentMessages, config, callbacks?.onConfirmDelete);
      if (fallbackToolCall) {
        try {
          safeLog(`[昔涟] 执行兜底工具调用: ${fallbackToolCall.function.name}`);
          toolRoundCount++;
          const { executeToolCall } = require('./xilian-tools');
          const result = await executeToolCall(fallbackToolCall, callbacks?.onConfirmDelete);
          onToolResult({ ...fallbackToolCall, result });
          finalContent += `\n\n（已通过兜底机制自动执行 ${fallbackToolCall.function.name}）`;
          onDone({ content: finalContent, toolCallCount: toolRoundCount, messages: currentMessages });
          return;
        } catch (fallbackErr) {
          safeLog(`[昔涟] 兜底执行失败: ${fallbackErr.message}`);
        }
      }

      onDone({ content: finalContent, toolCallCount: 0, messages: currentMessages, hallucinated: hasDataOps });
      return;
    }

    // === 处理 tool_calls ===
    // ★ 修复：优先使用流式已收集的 tool_calls，避免非流式重试导致模型行为不一致
    let toolCalls = firstResponse.tool_calls;

    // 仅当流式未收集到 tool_calls 但 finish_reason 表明需要工具调用时，才做非流式重试
    if ((!toolCalls || toolCalls.length === 0) && firstResponse.finish_reason === 'tool_calls') {
      safeLog('[昔涟] 流式未收集到 tool_calls，切换到非流式获取完整参数');
      const nonStreamResponse = await callDeepSeekAPINonStream(currentMessages, config, signal);
      if (nonStreamResponse.tool_calls?.length > 0) {
        toolCalls = nonStreamResponse.tool_calls;
        if (nonStreamResponse.content && onContent) {
          const diff = nonStreamResponse.content.slice(finalContent.length);
          if (diff) onContent(diff);
        }
        finalContent = nonStreamResponse.content || finalContent;
      } else if (nonStreamResponse.finish_reason === 'tool_calls') {
        // API 声称 tool_calls 但未返回有效工具调用，可能是 API 异常
        safeLog(`[昔涟] ⚠️ API 异常：finish_reason=tool_calls 但未返回有效 tool_calls`);
        onDone({ content: finalContent || 'AI 尝试调用工具但未返回具体参数，请重试或换一种说法。', toolCallCount: 0, messages: currentMessages, apiError: 'missing_tool_calls' });
        return;
      }
    } else if (toolCalls && toolCalls.length > 0) {
      safeLog(`[昔涟] ✅ 直接使用流式收集的 ${toolCalls.length} 个 tool_calls，跳过非流式重试`);
    }

    // ★ 修复：如果 toolCalls 为空（模型未返回任何工具调用），不要进入 while 循环
    if (!toolCalls || toolCalls.length === 0) {
      safeLog('[昔涟] 模型未返回任何工具调用，直接返回文本回复');
      onDone({ content: finalContent || '已完成。', toolCallCount: 0, messages: currentMessages });
      return;
    }

    // === 工具调用循环（全部非流式） ===
    // ★ P0-1: 改进死循环检测（含参数哈希 + 分级阈值）
    const loopState = { prevSignature: '', loopCount: 0, sameToolSameArgsCount: 0, prevSingleSignature: '' };
    // ★ P2-2: 记录数据变更类工具，用于触发 dataContext 刷新
    let dataChangedSinceContextRefresh = false;
    while (toolCalls?.length > 0 && toolRoundCount < maxToolRounds) {
      toolRoundCount++;

      // ★ P0-1: 改进的循环检测（含参数哈希）
      const loopResult = detectToolLoop(toolCalls, loopState);
      if (loopResult.isLoop) {
        safeLog(`[昔涟] ⚠️ 检测到工具调用死循环：${loopResult.reason}，主动退出`);
        onDone({ content: finalContent || '已完成操作。', toolCallCount: toolRoundCount, loopDetected: true, loopReason: loopResult.reason });
        return;
      }
      if (loopResult.warning) {
        safeLog(`[昔涟] ⚡ ${loopResult.warning}`);
      }

      currentMessages.push({ role: 'assistant', content: finalContent || null, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.function.arguments); } catch (e) {}

        onToolCall({ toolCallId: tc.id, toolName, arguments: toolArgs });

        const confirmCallback = async (action, itemId, itemTitle) => {
          if (config.deleteConfirmEnabled !== false) {
            return await callbacks.onConfirmDelete
              ? callbacks.onConfirmDelete(action, itemId, itemTitle) : true;
          }
          return true;
        };
        const result = await executeToolCall(tc, confirmCallback);
        onToolResult({ toolCallId: tc.id, toolName, result });
        currentMessages.push({ role: 'tool', tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result) });

        // ★ P2-2: 检测数据变更类工具
        if (OPERATION_TOOLS.has(toolName) && !QUERY_TOOLS.has(toolName)) {
          dataChangedSinceContextRefresh = true;
        }
      }

      // ★ P2-2: 每 5 轮或有数据变更时刷新 dataContext
      if ((toolRoundCount % 5 === 0 || dataChangedSinceContextRefresh) && toolRoundCount < maxToolRounds) {
        try {
          invalidateDataContextCache();
          const freshDataContext = buildDataContext(readData(), getCurrentUserId());
          // 追加一条 system 消息更新数据概览（不替换原始系统提示词）
          currentMessages.push({
            role: 'system',
            content: `（数据概览更新）当前数据状态：\n${freshDataContext}`
          });
          dataChangedSinceContextRefresh = false;
          safeLog(`[昔涟] 📊 第 ${toolRoundCount} 轮后刷新 dataContext`);
        } catch (e) {
          safeLog(`[昔涟] dataContext 刷新失败: ${e.message}`);
        }
      }

      const nextResponse = await callDeepSeekAPINonStream(currentMessages, config, signal);
      finalContent = nextResponse.content || '';
      if (finalContent && onContent) onContent(finalContent);

      if (nextResponse.finish_reason === 'stop') {
        onDone({ content: finalContent, toolCallCount: toolRoundCount, messages: currentMessages });
        return;
      }
      if (nextResponse.finish_reason === 'tool_calls' && nextResponse.tool_calls?.length > 0) {
        toolCalls = nextResponse.tool_calls;
        continue;
      }
      onDone({ content: finalContent, toolCallCount: toolRoundCount });
      return;
    }

    // ★ 修复：区分 "确实达到轮数上限" 和 "未执行任何工具调用"
    if (toolRoundCount === 0) {
      safeLog(`[昔涟] ⚠️ 工具调用循环未执行: toolCalls为空或无效`);
      onDone({ content: finalContent || '操作未能完成，AI 未返回有效的工具调用。', toolCallCount: 0, messages: currentMessages });
    } else {
      safeLog(`[昔涟] ⚠️ 达到最大工具调用轮数: toolRoundCount=${toolRoundCount}, maxToolRounds=${maxToolRounds}, 剩余消息=${JSON.stringify(currentMessages.slice(-3).map(m => ({role: m.role, content: (m.content || '').slice(0, 100)})))}`);
      onDone({ content: finalContent || '操作步骤较多，已完成部分操作。', toolCallCount: toolRoundCount, maxToolRounds, maxRoundsReached: true });
    }

  } catch (error) {
    safeError('[昔涟] streamChat error:', error);
    onError(error);
  } finally {
    // 工具操作后清除 dataContext 缓存，确保下一轮对话拿到最新数据
    invalidateDataContextCache();
  }
}

// ============================================================
// BUILD MESSAGES（系统提示词 + 上下文截断）
// ============================================================

// 将时间戳格式化为「2026-07-16 14:30」，用于给历史消息标注真实发送时间
function formatMsgTimestamp(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildMessages(chatHistory, systemPromptOrConfig) {
  const messages = [];

  // 支持两种调用方式：
  //   buildMessages(chatHistory, config)        — 旧路径，自动构建系统提示词
  //   buildMessages(chatHistory, systemPromptStr) — 新路径，直接用能现成的系统提示词
  let systemPrompt = '';
  if (typeof systemPromptOrConfig === 'string') {
    systemPrompt = systemPromptOrConfig;
  } else {
    systemPrompt = buildSystemPrompt(systemPromptOrConfig || {});
  }
  messages.push({ role: 'system', content: systemPrompt });

  const contextRounds = (typeof systemPromptOrConfig === 'object' && systemPromptOrConfig !== null)
    ? (systemPromptOrConfig.contextRounds || 10)
    : 10;
  const maxHistoryMsgs = contextRounds * 2;
  let startIdx = Math.max(0, chatHistory.length - maxHistoryMsgs);

  // ★ 修复：tool 消息必须有前导的 assistant(tool_calls) 消息，
  // 截断可能导致 tool 消息成为开头 → DeepSeek API 报错:
  // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
  // 向后扩展 startIdx 到 tool_calls 发起消息，或在无前导时丢弃孤立 tool 消息
  while (startIdx < chatHistory.length && chatHistory[startIdx].role === 'tool') {
    // 向前搜索对应的 assistant(tool_calls) 消息
    let foundStart = -1;
    for (let i = startIdx - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'assistant' && chatHistory[i].toolCalls?.length > 0) {
        foundStart = i;
        break;
      }
    }
    if (foundStart >= 0) {
      // 找到了前导 tool_calls，从那里开始
      startIdx = foundStart;
      break;
    } else {
      // 找不到前导 tool_calls→这个 tool 消息是孤立的，丢弃它
      startIdx++;
    }
  }

  const recentHistory = chatHistory.slice(startIdx);

  for (const msg of recentHistory) {
    if (msg.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: msg.toolCallId || '', content: msg.content || '' });
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.toolCalls });
    } else if (msg.role === 'system') {
      continue;
    } else {
      // 幻觉消息：保留对话结构但压缩内容，避免角色扮演文本污染上下文
      const isHallucinated = msg.hallucinated === true;
      let msgContent = isHallucinated
        ? '（已回复，但未成功执行工具操作）'
        : (msg.content || '');
      // ★ 给每条历史消息加上真实发送时间，避免模型把昨天/更早的消息误判为"刚刚发生"
      // （tool 与带 tool_calls 的 assistant 消息不加，避免破坏工具调用结构）
      if (!isHallucinated && msgContent && msg.timestamp) {
        msgContent = `[消息发送时间：${formatMsgTimestamp(msg.timestamp)}]\n${msgContent}`;
      }
      messages.push({ role: msg.role, content: msgContent });
    }
  }

  return messages;
}

function buildSystemPrompt(config, cachedDataContextStr = null) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const userId = getCurrentUserId();
  const dataContext = cachedDataContextStr || buildDataContext(readData(), userId);

  let customPrompt = config.systemPrompt || '';
  if (!customPrompt.trim()) {
    customPrompt = `你是昔涟，一个贴心、高效的个人助手。你喜欢用简洁清晰的方式帮助用户管理生活和工作。`;
  }

  // ★ 自我迭代：注入 AI 可自行维护的行为规则（ai-config/agent-rules.md）
  let agentRules = '';
  try {
    const rulesPath = path.join(getCurrentAppPath(), 'resources', 'app', 'ai-config', 'agent-rules.md');
    if (fs.existsSync(rulesPath)) {
      agentRules = fs.readFileSync(rulesPath, 'utf-8').trim();
    }
  } catch (e) {
    safeLog(`[昔涟] 读取行为规则失败: ${e.message}`);
  }

  let prompt = DEFAULT_SYSTEM_PROMPT
    .replace('{dataContext}', dataContext)
    + `\n\n当前日期时间: ${dateStr} ${timeStr}\n当前用户: ${userId}\n`
    + `\n\n## 用户自定义人设\n${customPrompt}`;

  if (agentRules) {
    prompt += `\n\n## 智能体行为规则（AI 可自行维护，必须遵守）\n${agentRules}`;
  }

  return prompt;
}

let cachedDataContext = null;
let cachedDataContextUserId = null;
let cachedDataContextTime = 0;
const DATA_CONTEXT_CACHE_TTL = 30000; // 30秒

function buildDataContext(data, userId) {
  const now = Date.now();
  // 如果 userId 没变且缓存没过期，直接返回缓存
  if (cachedDataContext && cachedDataContextUserId === userId && (now - cachedDataContextTime) < DATA_CONTEXT_CACHE_TTL) {
    return cachedDataContext;
  }

  const tasks = (data.tasks || []).filter(t => t.userId === userId);
  const expenses = (data.expenses || []).filter(e => e.userId === userId);
  const memos = (data.memos || []).filter(m => m.userId === userId);
  const journals = (data.journals || []).filter(j => j.userId === userId);
  const budgets = (data.budgets || []).filter(b => b.userId === userId);

  const pendingTasks = tasks.filter(t => !t.completed);
  const urgentTasks = pendingTasks.filter(t => t.priority === 'urgent');
  const today = new Date().toISOString().split('T')[0];
  const todayTasks = tasks.filter(t => t.startDate?.startsWith(today) || t.endDate?.startsWith(today));

  const activeBudget = budgets.find(b => b.startDate <= today && b.endDate >= today);
  let budgetStr = '无活跃预算';
  if (activeBudget) {
    const spent = expenses
      .filter(e => e.type === 'expense' && e.date >= activeBudget.startDate && e.date <= today)
      .reduce((s, e) => s + e.amount, 0);
    budgetStr = `${activeBudget.amount}元 (已用${spent.toFixed(0)}元)`;
  }

  const result = `- 任务: ${tasks.length}个 (${pendingTasks.length}待完成${urgentTasks.length > 0 ? `，${urgentTasks.length}个紧急` : ''})，今日 ${todayTasks.length}个
- 收支记录: ${expenses.length}条
- 笔记: ${memos.length}条
- 日志: ${journals.length}篇
- 预算: ${budgetStr}`;

  cachedDataContext = result;
  cachedDataContextUserId = userId;
  cachedDataContextTime = now;
  return result;
}

/** 在数据变更后调用，清除 dataContext 缓存（由外部调用） */
function invalidateDataContextCache() {
  cachedDataContext = null;
  cachedDataContextUserId = null;
  cachedDataContextTime = 0;
}

module.exports = {
  streamChat,
  buildSimpleReply,
  buildSystemPrompt,
  buildMessages,
  ChatMessage,
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  invalidateDataContextCache
};

async function callDeepSeekAPI(messages, config, onContent, externalSignal) {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl || 'https://api.deepseek.com';
  const model = config.model || 'deepseek-chat';

  const body = {
    model, messages,
    // ★ BugFix：工具列表与 tool_choice 可由调用方通过 config.tools / config.toolChoice 覆盖。
    // 未传时保持原行为（全部工具 + auto），正常聊天不受影响；
    // 提醒执行器等需要"纯文本输出"的场景传 tools:[] + toolChoice:'none' 以禁止工具调用。
    tools: config.tools !== undefined ? config.tools : TOOL_DEFINITIONS,
    tool_choice: config.toolChoice || 'auto',
    temperature: config.temperature ?? 1.0,
    stream: true
  };

  safeLog(`[昔涟] API stream call: model=${model}, msgs=${messages.length}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  // 绑定外部暂停信号
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timeoutId); return { content: '', finish_reason: 'stop', tool_calls: null }; }
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let errMsg = `API 错误 ${response.status}`;
      try { errMsg = JSON.parse(errBody).error?.message || errMsg; } catch (e) {}
      throw new Error(errMsg);
    }

    return await parseSSEStream(response, onContent);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('AI 响应超时（2分钟）');
    throw error;
  }
}

// ============================================================
// CALL DEEPSEEK API NON-STREAM（非流式，用于工具调用）
// ============================================================

async function callDeepSeekAPINonStream(messages, config, externalSignal) {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl || 'https://api.deepseek.com';
  const model = config.model || 'deepseek-chat';

  safeLog(`[昔涟] API non-stream call: model=${model}, msgs=${messages.length}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  // 绑定外部暂停信号
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timeoutId); return { content: '', finish_reason: 'stop', tool_calls: null }; }
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, messages,
        // ★ BugFix：同 callDeepSeekAPI，支持 config.tools / config.toolChoice 覆盖。
        // 未传时保持原行为（全部工具 + auto），正常聊天不受影响。
        tools: config.tools !== undefined ? config.tools : TOOL_DEFINITIONS,
        tool_choice: config.toolChoice || 'auto',
        temperature: config.temperature ?? 1.0,
        stream: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let errMsg = `API 错误 ${response.status}`;
      try { errMsg = JSON.parse(errBody).error?.message || errMsg; } catch (e) {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('AI 未返回有效响应');

    return {
      content: choice.message?.content || '',
      finish_reason: choice.finish_reason || 'stop',
      tool_calls: choice.message?.tool_calls || null
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('AI 响应超时（2分钟）');
    throw error;
  }
}

// ============================================================
// SSE STREAM PARSING（只处理文本内容）
// ============================================================

async function parseSSEStream(response, onContent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAccumulator = '';
  let finishReason = null;
  // ★ 修复：收集流式 tool_calls 增量数据（按 index 聚合）
  // OpenAI/DeepSeek 流式协议：tool_calls 分块返回
  //   首块: {index:0, id:"call_xxx", type:"function", function:{name:"addExpense", arguments:""}}
  //   后续: {index:0, function:{arguments:"{\"det"}}  (增量拼接 arguments)
  //   多工具: 不同 index
  const toolCallsMap = new Map();  // index → {id, type, function:{name, arguments}}

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          const choiceFinishReason = parsed.choices?.[0]?.finish_reason;
          if (choiceFinishReason) {
            finishReason = choiceFinishReason;
            safeLog(`[昔涟 SSE] finish_reason=${finishReason}`);
          }
          if (!delta) continue;

          // 收集文本内容
          if (delta.content) {
            contentAccumulator += delta.content;
            if (onContent) onContent(delta.content);
          }

          // ★ 修复：收集 tool_calls 增量数据
          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tcDelta of delta.tool_calls) {
              const idx = (tcDelta.index !== undefined) ? tcDelta.index : 0;
              let existing = toolCallsMap.get(idx);
              if (!existing) {
                existing = {
                  id: tcDelta.id || '',
                  type: tcDelta.type || 'function',
                  function: { name: '', arguments: '' }
                };
                toolCallsMap.set(idx, existing);
              }
              // 更新 id（首块才有）
              if (tcDelta.id && !existing.id) {
                existing.id = tcDelta.id;
              }
              // 更新 function.name（首块才有）
              if (tcDelta.function?.name) {
                existing.function.name = tcDelta.function.name;
              }
              // 拼接 function.arguments（增量）
              if (tcDelta.function?.arguments) {
                existing.function.arguments += tcDelta.function.arguments;
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    safeError('[昔涟] SSE stream parse error:', e);
    throw e;
  } finally {
    reader.releaseLock();
  }

  // 组装最终 tool_calls 数组（按 index 排序）
  let finalToolCalls = null;
  if (toolCallsMap.size > 0) {
    finalToolCalls = [];
    const sortedIndices = [...toolCallsMap.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const tc = toolCallsMap.get(idx);
      // 确保每个工具调用有有效 id（兜底生成）
      if (!tc.id) {
        tc.id = `call_stream_${idx}_${Date.now()}`;
      }
      finalToolCalls.push({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || '{}'
        }
      });
    }
    safeLog(`[昔涟 SSE] ✅ 流式收集到 ${finalToolCalls.length} 个 tool_calls: ${finalToolCalls.map(t => t.function.name).join(', ')}`);
  }

  return {
    content: contentAccumulator,
    finish_reason: finishReason || 'stop',
    tool_calls: finalToolCalls  // ★ 修复：返回流式收集的 tool_calls，不再为 null
  };
}

// ============================================================
// BUILD SIMPLE REPLY (for no-API mode)
// ============================================================

function buildSimpleReply(userText, chatHistory) {
  const lc = userText.toLowerCase();
  if (lc.includes('你好') || lc.includes('hi') || lc.includes('hello')) {
    return '你好！我是你的小助理~有什么需要我来做的吗';
  }
  if (lc.includes('帮助') || lc.includes('help') || lc.includes('功能')) {
    return `我可以帮你：\n- 📋 任务管理\n- 💰 收支记账\n- 📝 笔记\n- 📖 写日志\n- 📊 预算管理\n- 🔄 云同步\n\n⚠️ 请先在设置中配置 DeepSeek API Key。`;
  }
  return '请先在设置 → Elysia → API 配置中填入你的 DeepSeek API Key，然后我就可以帮你处理各种操作啦！';
}

// ============================================================
// MODULE EXPORTS
// ============================================================
module.exports = {
  streamChat,
  buildSimpleReply,
  buildSystemPrompt,
  buildMessages,
  ChatMessage,
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  // ★ 导出兜底提取函数供单测（QA 回归：tools=[] / toolChoice='none' 时必须返回 null）
  _fallbackExtractAndExecute
};
