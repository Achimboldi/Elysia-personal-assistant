/**
 * xilian-tools.js — 昔涟智能体工具注册表
 * 运行在主进程，直接访问 data-service.js
 * 25个工具，8大类（不含密钥操作）
 */

const { readData, writeData, getCurrentUserId, readDailyTasks, createDailyTask, updateDailyTask, deleteDailyTask } = require('./data-service');
const { sendToAllWindows: broadcast } = require('./main-utils');
const { v4: uuidv4 } = require('uuid');
const { safeLog, safeError } = require('./main-utils');

// ============================================================
// EXPENSE CATEGORIES（与前端一致）
// ============================================================
const EXPENSE_CATEGORIES = [
  '餐饮', '交通', '购物', '娱乐', '医疗',
  '教育', '住房', '通讯', '服饰', '美容',
  '运动', '社交', '宠物', '旅行', '其他'
];

const INCOME_CATEGORIES = [
  '工资', '奖金', '投资', '兼职', '红包',
  '报销', '退款', '理财', '其他'
];

// ============================================================
// TOOL DEFINITIONS（OpenAI Function Calling 格式）
// ============================================================
const TOOL_DEFINITIONS = [
  // ========== 任务管理 (5) ==========
  {
    type: 'function',
    function: {
      name: 'createTask',
      description: '创建一个新任务。当用户说"帮我创建任务"、"添加任务"、"新增任务"等时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题（必填）' },
          description: { type: 'string', description: '任务详细描述' },
          priority: {
            type: 'string',
            enum: ['urgent', 'priority', 'normal', 'secondary'],
            description: '优先级：urgent=紧急, priority=重要, normal=普通, secondary=次要'
          },
          startDate: { type: 'string', description: '开始日期，格式 YYYY-MM-DD，默认为今天' },
          endDate: { type: 'string', description: '截止日期，格式 YYYY-MM-DD，默认与开始日期相同' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表，如 ["工作","项目"]' },
          subtasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string', description: '子任务标题' } },
              required: ['title']
            },
            description: '子任务列表'
          }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateTask',
      description: '更新已有任务的信息（不包括完成操作）。用户说"修改任务"、"更新任务"、"把任务改成..."时使用。要先通过 listTasks 获取任务ID。标记任务完成请使用 completeTask 工具。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要更新的任务ID（必填）' },
          title: { type: 'string', description: '新标题' },
          description: { type: 'string', description: '新描述' },
          priority: { type: 'string', enum: ['urgent', 'priority', 'normal', 'secondary'] },
          startDate: { type: 'string', description: '新开始日期 YYYY-MM-DD' },
          endDate: { type: 'string', description: '新截止日期 YYYY-MM-DD' },
          progress: {
            type: 'string',
            enum: ['pending', 'in-progress', 'stalled'],  // ★ P2-3: 移除 completed，完成操作用 completeTask
            description: '进度：pending=待开始, in-progress=进行中, stalled=停滞, completed=已完成'
          },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteTask',
      description: '删除一个任务。⚠️ 需要用户确认。如果不确定任务ID，请先调用 listTasks 按标题搜索。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要删除的任务ID（必填）' },
          taskTitle: { type: 'string', description: '任务标题（用于确认提示）' }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listTasks',
      description: '列出/搜索任务。用户问"有哪些任务"、"查看任务"、"搜索任务"时使用。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '按日期筛选 YYYY-MM-DD' },
          status: {
            type: 'string',
            enum: ['pending', 'completed', 'all'],
            description: '状态筛选：pending=未完成, completed=已完成, all=全部'
          },
          priority: { type: 'string', enum: ['urgent', 'priority', 'normal', 'secondary'] },
          keyword: { type: 'string', description: '标题关键词搜索' },
          tag: { type: 'string', description: '按标签筛选' },
          limit: { type: 'number', description: '返回条数限制，默认20' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'completeTask',
      description: '将任务标记为已完成。如果不确定任务ID，请先调用 listTasks 按标题搜索任务。用户说"完成任务"、"搞定"、"做完了"时使用。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要完成的任务ID（必填）' }
        },
        required: ['taskId']
      }
    }
  },

  // ========== 备忘录 (4) ==========
  {
    type: 'function',
    function: {
      name: 'createMemo',
      description: '创建一条新备忘录。用户说"记一下"、"备忘"、"帮我记下来"时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '备忘录标题' },
          content: { type: 'string', description: '备忘录内容（必填）' },
          isPrivate: { type: 'boolean', description: '是否设为私密，默认false' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateMemo',
      description: '更新备忘录的标题或内容。如果不确定备忘录ID，请先调用 listMemos 按关键词搜索。',
      parameters: {
        type: 'object',
        properties: {
          memoId: { type: 'string', description: '备忘录ID（必填）' },
          title: { type: 'string', description: '新标题' },
          content: { type: 'string', description: '新内容' }
        },
        required: ['memoId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteMemo',
      description: '删除一条备忘录。⚠️ 需要用户确认。如果不确定ID，请先调用 listMemos 按关键词搜索。',
      parameters: {
        type: 'object',
        properties: {
          memoId: { type: 'string', description: '备忘录ID（必填）' },
          memoTitle: { type: 'string', description: '备忘录标题（用于确认提示）' }
        },
        required: ['memoId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listMemos',
      description: '列出所有备忘录。用户说"查看备忘录"、"搜索备忘录"时使用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '返回条数限制，默认20' }
        }
      }
    }
  },

  // ========== 收支记账 (5) ==========
  {
    type: 'function',
    function: {
      name: 'addExpense',
      description: '添加一笔收支记录。用户说"我花了XX元"、"记账"、"收入"、"支出了"时使用。',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'string', description: '交易详情/备注（必填），如"午餐麦当劳"' },
          amount: { type: 'number', description: '金额，正数（必填）' },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: 'expense=支出, income=收入（必填）'
          },
          category: {
            type: 'string',
            description: '分类。支出一类：餐饮/交通/购物/娱乐/医疗/教育/住房/通讯/服饰/美容/运动/社交/宠物/旅行/其他。收入一类：工资/奖金/投资/兼职/红包/报销/退款/理财/其他'
          },
          date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' }
        },
        required: ['detail', 'amount', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateExpense',
      description: '修改一条收支记录的金额、分类、详情或日期。如果不确定记录ID，请先调用 listExpenses 按日期或关键词查找。用户说"把那笔改成XX元"、"改一下那笔支出"时使用。',
      parameters: {
        type: 'object',
        properties: {
          expenseId: { type: 'string', description: '收支记录ID（必填）' },
          detail: { type: 'string', description: '新详情' },
          amount: { type: 'number', description: '新金额' },
          type: { type: 'string', enum: ['expense', 'income'] },
          category: { type: 'string' },
          date: { type: 'string' }
        },
        required: ['expenseId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteExpense',
      description: '删除一笔收支记录。⚠️ 需要用户确认。如果不确定ID，请先调用 listExpenses 按日期或关键词查找。',
      parameters: {
        type: 'object',
        properties: {
          expenseId: { type: 'string', description: '收支记录ID（必填）' },
          expenseDetail: { type: 'string', description: '记录详情（用于确认提示）' }
        },
        required: ['expenseId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listExpenses',
      description: '列出收支记录。支持按日期、类型、分类、关键词筛选。用户问"我这个月花了多少"、"查看账单"、"收支明细"、"找一下奶茶那笔"时使用。',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          endDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          type: { type: 'string', enum: ['expense', 'income'], description: '支出或收入' },
          category: { type: 'string', description: '按分类筛选' },
          keyword: { type: 'string', description: '按详情描述关键词搜索' },
          limit: { type: 'number', description: '返回条数限制，默认30' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getExpenseSummary',
      description: '获取收支汇总统计。用户问"我这个月花了多少钱"、"收支总览"、"财务概况"时使用。',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          endDate: { type: 'string', description: '结束日期 YYYY-MM-DD' }
        }
      }
    }
  },

  // ========== 日志日记 (2) ==========
  {
    type: 'function',
    function: {
      name: 'addJournal',
      description: '添加、修改或更新一篇日记/日志。用户说"写日记"、"修改日志"、"更新日记"、"改一下今天的日记"、"记录日志"、"今天天气不错"时使用。同一天的日志会自动更新而非新增，所以修改已有日志也用此工具。⚠️ 必须将完整的日记正文传入 content 参数，不能只在聊天中回复文字而不调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
          content: { type: 'string', description: '日志内容（必填）' },
          weather: {
            type: 'string',
            enum: ['sunny', 'cloudy', 'rainy', 'snowy', 'foggy'],
            description: '天气：sunny=晴, cloudy=多云, rainy=雨, snowy=雪, foggy=雾'
          }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listJournals',
      description: '列出日志日记。用户说"查看日记"、"之前的日志"时使用。',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: '起始日期' },
          endDate: { type: 'string', description: '结束日期' },
          limit: { type: 'number', description: '返回条数，默认10' }
        }
      }
    }
  },

  // ========== 预算管理 (4) ==========
  {
    type: 'function',
    function: {
      name: 'createBudget',
      description: '创建一个预算计划。用户说"设预算"、"制定预算"、"规划开支"时使用。',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: '预算开始日期 YYYY-MM-DD，默认今天' },
          endDate: { type: 'string', description: '预算结束日期 YYYY-MM-DD，默认本月末' },
          amount: { type: 'number', description: '预算总额（必填）' },
          categoryBudgets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', description: '分类名称' },
                amount: { type: 'number', description: '该分类预算金额' }
              },
              required: ['category', 'amount']
            },
            description: '按分类设置预算（可选）'
          }
        },
        required: ['amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateBudget',
      description: '更新现有预算的金额或日期范围。如果不确定预算ID，请先调用 listBudgets 查看。',
      parameters: {
        type: 'object',
        properties: {
          budgetId: { type: 'string', description: '预算ID（必填）' },
          amount: { type: 'number', description: '新总额' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          categoryBudgets: { type: 'array', items: { type: 'object' } }
        },
        required: ['budgetId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listBudgets',
      description: '列出所有预算。用户说"查看预算"、"预算情况"时使用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getBudgetStatus',
      description: '查看预算执行状态（已花多少、剩余多少、各类别使用率）。用户问"预算还剩多少"、"预算够不够"时使用。',
      parameters: {
        type: 'object',
        properties: {
          budgetId: { type: 'string', description: '预算ID，不传则查看当前活跃预算' }
        }
      }
    }
  },

  // ========== 设置调整 (3) ==========
  {
    type: 'function',
    function: {
      name: 'getSettings',
      description: '获取当前应用设置（不含敏感信息如API Key）。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateSettings',
      description: '更新应用设置。用户说"切换主题"、"改成深色模式"等时使用。',
      parameters: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['light', 'dark', 'auto'], description: '主题模式' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'switchUser',
      description: '切换到其他用户。用户说"切换用户"、"换账号"时使用。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: '要切换到的用户ID（必填）' }
        },
        required: ['userId']
      }
    }
  },

  // ========== 云同步 (2) ==========
  {
    type: 'function',
    function: {
      name: 'triggerSync',
      description: '触发云同步。用户说"同步数据"、"备份到云端"时使用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getSyncStatus',
      description: '查看云同步状态。用户问"同步状态"、"上次同步是什么时候"时使用。',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ========== 系统概览 (1) ==========
  {
    type: 'function',
    function: {
      name: 'getDashboard',
      description: '获取系统概览仪表盘数据。用户说"概览"、"今天有什么"、"汇总"、"首页"时使用。包含今日任务、本周收支、待办数量等。',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ========== 记忆检索 (2) ==========
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: '检索昔涟的长期记忆（从过往对话中抽取的事实/事件/人物/偏好）。当用户说"你还记得…""上次说的那个""我之前提过"或需要跨会话上下文时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或短语（必填）' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browse_memories',
      description: '浏览记忆全貌（各星系的人物/地点/事件/项目实体计数 + 文本概览）。当用户说"你记得哪些人""你都记了什么"或你想主动回顾已知信息时使用。无需参数。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'correct_memory',
      description: '修正昔涟的错误记忆。当用户说"你记错了""不对""不是这样的"并给出正确版本时使用。需提供 wrong_statement（你说错的内容）和 correction（用户给出的正确版本）。可选传入 memory_id（从上下文中 #数字 获取）精确定位错误记忆。',
      parameters: {
        type: 'object',
        properties: {
          wrong_statement: { type: 'string', description: '你说错的内容（你刚刚引用的错误事实）' },
          correction: { type: 'string', description: '用户给出的正确版本' },
          memory_id: { type: 'integer', description: '可选的记忆ID，从上下文 #数字 获取' }
        },
        required: ['wrong_statement', 'correction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_current_state',
      description: '主动记录用户当前状态（生理期/情绪/生活状态等）。四种操作：set（新建状态）、update（修改已有状态）、resolve（结束某状态）、update_overview（更新星座描述）。当用户在对话中透露近况变化时主动使用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'set / update / resolve / update_overview', enum: ['set', 'update', 'resolve', 'update_overview'] },
          state_id: { type: 'integer', description: '要修改的状态ID（update/resolve 时必填）' },
          content: { type: 'string', description: '状态描述，≤500字。set/update 时必填。' },
          expires_at: { type: 'string', description: 'ISO 8601 格式过期时间。set/update 时必填。最长90天。' },
          resolve_reason: { type: 'string', description: '结束原因，≤200字。resolve 时必填。' },
          entity: { type: 'string', description: '实体名，如"千变慢慢"。update_overview 时必填。' },
          overview: { type: 'string', description: '新的完整星座描述，≤500字。update_overview 时必填。' }
        },
        required: ['action']
      }
    }
  },
  // ── 今日任务工具 ──
  {
    type: 'function',
    function: {
      name: 'createDailyTask',
      description: '创建一条今日任务。今日任务是独立的简短待办，与普通任务分开管理。用户说"今天要..."、"加个今日任务"等时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务名称，简短清晰，≤100字' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listDailyTasks',
      description: '查看今日所有今日任务。用户说"今天有什么任务"、"今日任务有哪些"、"看一下今日待办"等时使用。无参数。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateDailyTask',
      description: '更新今日任务状态（完成/取消完成）。用户说"把XX勾掉"、"XX做完了"、"标记完成"等时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务名称（与创建时的 title 一致）' },
          taskId: { type: 'string', description: '任务ID（知道时传入）' },
          completed: { type: 'boolean', description: '是否完成，true=标记完成，false=取消完成' }
        },
        required: ['completed']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteDailyTask',
      description: '删除一条今日任务。用户说"删除XX"、"移除XX"等时使用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务名称' },
          taskId: { type: 'string', description: '任务ID（知道时传入）' }
        },
        required: []
      }
    }
  }
];

// ============================================================
// CONFIRM-REQUIRED TOOLS
// ============================================================
const TOOLS_REQUIRING_CONFIRM = ['deleteTask', 'deleteMemo', 'deleteExpense'];

// ============================================================
// TOOL EXECUTION DISPATCH
// ============================================================

/**
 * 执行单个工具调用
 * @param {Object} toolCall - OpenAI 格式的 tool_call 对象
 * @param {Object} confirmCallback - 确认回调 async (action, itemId, itemTitle) => boolean
 * @returns {Object} { success, data/message }
 */
async function executeToolCall(toolCall, confirmCallback) {
  const { name, arguments: argsStr } = toolCall.function;
  let args;
  try {
    args = JSON.parse(argsStr);
  } catch (e) {
    safeLog(`[昔涟] 参数解析失败，原始值(${argsStr.length}字): ${argsStr.substring(0, 200)}`);
    
    // 尝试修复1：清理换行符（SSE中可能残留的换行符）
    try {
      const cleaned = argsStr.replace(/[\n\r]/g, '\\n');
      args = JSON.parse(cleaned);
      safeLog('[昔涟] 参数修复成功(清理换行符)');
    } catch (e2) {
      // 尝试修复2：清理换行符后直接连接
      try {
        const cleaned = argsStr.replace(/[\n\r]/g, '');
        args = JSON.parse(cleaned);
        safeLog('[昔涟] 参数修复成功(移除换行符)');
      } catch (e3) {
        // 尝试修复3：如果字符串缺少闭合的 } 或 ]，尝试补全
        try {
          let repaired = argsStr.trim();
          if (repaired.endsWith('"')) {
            repaired += '}';
          } else if (!repaired.endsWith('}') && !repaired.endsWith(']')) {
            repaired += '"}';
          }
          args = JSON.parse(repaired);
          safeLog('[昔涟] 参数修复成功(补全闭合符)');
        } catch (e4) {
          return { success: false, message: `参数解析失败: ${e.message}` };
        }
      }
    }
  }

  // 删除确认检查
  if (TOOLS_REQUIRING_CONFIRM.includes(name) && confirmCallback) {
    const idField = name === 'deleteTask' ? 'taskId' : name === 'deleteMemo' ? 'memoId' : 'expenseId';
    const titleField = name === 'deleteTask' ? 'taskTitle' : name === 'deleteMemo' ? 'memoTitle' : 'expenseDetail';
    const confirmed = await confirmCallback(name, args[idField], args[titleField] || '');
    if (!confirmed) {
      return { success: false, message: '用户取消了删除操作' };
    }
  }

  // 分发执行
  const executors = {
    createTask, updateTask, deleteTask, listTasks, completeTask,
    createMemo, updateMemo, deleteMemo, listMemos,
    addExpense, updateExpense, deleteExpense, listExpenses, getExpenseSummary,
    addJournal, listJournals,
    createBudget, updateBudget, listBudgets, getBudgetStatus,
    getSettings, updateSettings, switchUser,
    triggerSync, getSyncStatus,
    getDashboard
  };

  // 记忆工具走 lazy require（encryption.js 需 .env 已加载，避免顶层 require 导致初始化失败）
  if (name === 'recall_memory') {
    try {
      const memoryTools = require('./memory/services/tools/memoryTools');
      const tool = memoryTools.find(t => t.name === 'recall_memory');
      if (!tool) return { success: false, message: '记忆系统未就绪。' };
      const result = await tool.handler({ query: args.query }, { chatId: 1, lastClaraMessage: null });
      return { success: result.success !== false, message: result.formatted || '无结果' };
    } catch (e) {
      safeError('[昔涟工具] recall_memory 执行失败:', e);
      return { success: false, message: `记忆检索失败: ${e.message}` };
    }
  }

  if (name === 'browse_memories') {
    try {
      const memoryTools = require('./memory/services/tools/memoryTools');
      const tool = memoryTools.find(t => t.name === 'browse_memories');
      if (!tool) return { success: false, message: '记忆系统未就绪。' };
      const result = await tool.handler({}, { chatId: 1, lastClaraMessage: null });
      return { success: result.success !== false, message: result.formatted || '无结果' };
    } catch (e) {
      safeError('[昔涟工具] browse_memories 执行失败:', e);
      return { success: false, message: `记忆浏览失败: ${e.message}` };
    }
  }

  if (name === 'correct_memory') {
    try {
      const memoryTools = require('./memory/services/tools/memoryTools');
      const tool = memoryTools.find(t => t.name === 'correct_memory');
      if (!tool) return { success: false, message: '记忆系统未就绪。' };
      const result = await tool.handler(
        { wrong_statement: args.wrong_statement, correction: args.correction, memory_id: args.memory_id },
        { chatId: 1 }
      );
      return { success: result.success !== false, message: result.formatted || result.message || '记忆已修正' };
    } catch (e) {
      safeError('[昔涟工具] correct_memory 执行失败:', e);
      return { success: false, message: `记忆修正失败: ${e.message}` };
    }
  }

  if (name === 'update_current_state') {
    try {
      const manageUserState = require('./memory/services/tools/manageUserState');
      const result = await manageUserState.handler(args, { chatId: 1 });
      return { success: result.success !== false, message: result.formatted || result.message || '状态已更新' };
    } catch (e) {
      safeError('[昔涟工具] update_current_state 执行失败:', e);
      return { success: false, message: `状态更新失败: ${e.message}` };
    }
  }

  // 今日任务工具（主进程内直接读写，避免 IPC）
  if (name === 'createDailyTask') {
    const task = { title: args.title, completed: false, dailyDate: new Date().toISOString().slice(0, 10) };
    const r = await createDailyTask(task);
    return { success: r.success, message: r.success ? `已创建今日任务「${args.title}」` : (r.message || '创建失败') };
  }
  if (name === 'listDailyTasks') {
    const tasks = readDailyTasks();
    if (!tasks || !tasks.length) return { success: true, message: '当前没有今日任务。' };
    const today = new Date().toISOString().slice(0, 10);
    const list = tasks.filter(t => !t.dailyDate || t.dailyDate === today)
      .map(t => `${t.completed ? '✓' : '○'} ${t.title}`).join('\n');
    return { success: true, message: '今日任务：\n' + (list || '全部已完成 ✓') };
  }
  if (name === 'updateDailyTask') {
    const all = readDailyTasks();
    const found = (all || []).find(dt => dt.title === args.title || String(dt.id) === String(args.taskId));
    if (!found) return { success: false, message: `未找到今日任务「${args.title || args.taskId}」` };
    const r = await updateDailyTask(found.id, { completed: args.completed !== false });
    return { success: r.success, message: r.success ? `今日任务「${found.title}」已${args.completed !== false ? '完成' : '取消完成'}` : (r.message || '更新失败') };
  }
  if (name === 'deleteDailyTask') {
    const all = readDailyTasks();
    const found = (all || []).find(dt => dt.title === args.title || String(dt.id) === String(args.taskId));
    if (!found) return { success: false, message: `未找到今日任务「${args.title || args.taskId}」` };
    const r = await deleteDailyTask(found.id);
    return { success: r.success, message: r.success ? `已删除今日任务「${found.title}」` : (r.message || '删除失败') };
  }

  const executor = executors[name];
  if (!executor) {
    return { success: false, message: `未知工具: ${name}` };
  }

  try {
    const result = await executor(args);
    return { success: true, ...result };
  } catch (e) {
    safeError(`[昔涟工具] ${name} 执行失败:`, e);
    return { success: false, message: `执行 ${name} 失败: ${e.message}` };
  }
}

// ============================================================
// TOOL EXECUTORS — 数据操作
// ============================================================

// ★ P1-1: 创建类工具查重辅助函数
// 策略：创建但提示（不阻断），返回 duplicateWarning 让 AI 转达给用户

/**
 * 字符串相似度检查（简单的包含 + 去空格相等判断）
 * @returns {boolean} 是否相似
 */
function isStringSimilar(a, b) {
  if (!a || !b) return false;
  const na = String(a).trim().toLowerCase();
  const nb = String(b).trim().toLowerCase();
  if (na === nb) return true;
  // 包含关系（短串被长串包含）
  if (na.length > 2 && nb.length > 2) {
    if (na.includes(nb) || nb.includes(na)) return true;
  }
  return false;
}

/**
 * 日期范围是否重叠
 */
function isDateRangeOverlap(s1, e1, s2, e2) {
  const start1 = new Date(s1).getTime();
  const end1 = new Date(e1).getTime();
  const start2 = new Date(s2).getTime();
  const end2 = new Date(e2).getTime();
  return start1 <= end2 && start2 <= end1;
}

/**
 * 查重：任务（按 title 相似 + 同一用户）
 */
function checkDuplicateTask(data, args, userId) {
  const title = args.title || '';
  for (const t of (data.tasks || [])) {
    if (t.userId !== userId) continue;
    if (isStringSimilar(t.title, title)) {
      return { existing: t, warning: `已有相似任务「${t.title}」（创建于 ${t.createdAt?.split('T')[0]}）` };
    }
  }
  return null;
}

/**
 * 查重：备忘录（按 title 相同 或 content 相似）
 */
function checkDuplicateMemo(data, args, userId) {
  const title = args.title || '';
  const content = args.content || '';
  for (const m of (data.memos || [])) {
    if (m.userId !== userId) continue;
    if (title && m.title && isStringSimilar(m.title, title)) {
      return { existing: m, warning: `已有相似标题的备忘录「${m.title || '无标题'}」` };
    }
    if (content && m.content && isStringSimilar(m.content, content) && content.length > 5) {
      return { existing: m, warning: `已有内容相似的备忘录「${m.title || '无标题'}」` };
    }
  }
  return null;
}

/**
 * 查重：收支记录（detail 相同 + amount 相同 + date 相同）
 */
function checkDuplicateExpense(data, args, userId) {
  const detail = args.detail || '';
  const amount = Math.abs(args.amount || 0);
  const date = args.date || new Date().toISOString().split('T')[0];
  for (const e of (data.expenses || [])) {
    if (e.userId !== userId) continue;
    if (e.detail === detail && Math.abs(e.amount - amount) < 0.01 && e.date === date) {
      return { existing: e, warning: `${date} 已有一笔「${e.detail} ${e.amount.toFixed(2)}元」的记录，可能重复记账` };
    }
  }
  return null;
}

/**
 * 查重：预算（时间周期重叠）
 */
function checkDuplicateBudget(data, args, userId) {
  const today = new Date().toISOString().split('T')[0];
  const startDate = args.startDate || today;
  const d = new Date();
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
  const endDate = args.endDate || monthEnd;
  for (const b of (data.budgets || [])) {
    if (b.userId !== userId) continue;
    if (isDateRangeOverlap(startDate, endDate, b.startDate, b.endDate)) {
      return { existing: b, warning: `已有时间重叠的预算（${b.startDate} 至 ${b.endDate}，总额 ${b.amount}元），如需替换请先删除旧预算` };
    }
  }
  return null;
}

// --- 任务管理 ---

async function createTask(args) {
  const userId = getCurrentUserId();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  const task = {
    id: uuidv4(),
    title: args.title,
    description: args.description || '',
    category: '默认',
    priority: args.priority || 'normal',
    startDate: args.startDate || today,
    endDate: args.endDate || args.startDate || today,
    reminderDate: null,
    subtasks: (args.subtasks || []).map(st => ({
      id: uuidv4(), title: st.title, completed: false,
      priority: 'normal', progress: 'pending', dueDate: null
    })),
    completed: false,
    progress: 'pending',
    createdAt: now,
    updatedAt: now,
    reminderEnabled: false,
    remindOffset: 10,
    tags: args.tags || [],
    userId: userId,
    creator: global._currentAIAgentCreatorName || 'AI助手'
  };

  const data = readData();
  // ★ P1-1: 查重（创建但提示策略）
  const dupCheck = checkDuplicateTask(data, args, userId);
  data.tasks.push(task);
  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('tasks-updated');

  const priorityLabel = { urgent: '🔴紧急', priority: '🟠重要', normal: '🟢普通', secondary: '⚪次要' };
  const result = {
    message: `✅ 已创建任务「${task.title}」${priorityLabel[task.priority] || ''}，截止日期: ${task.endDate}`,
    data: { id: task.id, title: task.title }
  };
  // ★ P1-1: 查重命中则附加警告（不阻断，让 AI 转达给用户）
  if (dupCheck) {
    result.duplicateWarning = dupCheck.warning;
    result.message += `\n⚠️ 注意：${dupCheck.warning}`;
  }
  return result;
}

async function updateTask(args) {
  const userId = getCurrentUserId();
  const data = readData();
  const idx = data.tasks.findIndex(t => t.id === args.taskId && t.userId === userId);

  if (idx === -1) {
    return { message: `未找到任务 ID: ${args.taskId}` };
  }

  const task = data.tasks[idx];
  if (args.title !== undefined) task.title = args.title;
  if (args.description !== undefined) task.description = args.description;
  if (args.priority !== undefined) task.priority = args.priority;
  if (args.startDate !== undefined) task.startDate = args.startDate;
  if (args.endDate !== undefined) task.endDate = args.endDate;
  if (args.progress !== undefined) task.progress = args.progress;
  if (args.tags !== undefined) task.tags = args.tags;
  task.updatedAt = new Date().toISOString();

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('tasks-updated');

  return { message: `✅ 已更新任务「${task.title}」`, data: { id: task.id, title: task.title } };
}

async function deleteTask(args) {
  return await _deleteGeneric(args.taskId, 'tasks', '任务', args.taskTitle);
}

async function listTasks(args) {
  const data = readData();
  let tasks = [...data.tasks];

  // 筛选
  if (args.status === 'pending') tasks = tasks.filter(t => !t.completed);
  else if (args.status === 'completed') tasks = tasks.filter(t => t.completed);
  if (args.priority) tasks = tasks.filter(t => t.priority === args.priority);
  if (args.keyword) {
    const kw = args.keyword.toLowerCase();
    tasks = tasks.filter(t => t.title?.toLowerCase().includes(kw) || t.description?.toLowerCase().includes(kw));
  }
  if (args.tag) tasks = tasks.filter(t => (t.tags || []).includes(args.tag));
  if (args.date) {
    tasks = tasks.filter(t => t.startDate?.startsWith(args.date) || t.endDate?.startsWith(args.date));
  }

  // 排序：未完成在前，按截止日期
  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const pOrder = { urgent: 0, priority: 1, normal: 2, secondary: 3 };
    return (pOrder[a.priority] || 2) - (pOrder[b.priority] || 2);
  });

  const limit = args.limit || 20;
  tasks = tasks.slice(0, limit);

  const summary = tasks.map(t => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    completed: t.completed,
    endDate: t.endDate,
    progress: t.progress
  }));

  return {
    message: tasks.length > 0
      ? `找到 ${tasks.length} 个任务:\n${summary.map(t => `- [${t.completed ? '✓' : ' '}] ${t.title} (${t.endDate})`).join('\n')}`
      : '没有找到符合条件的任务。',
    data: { tasks: summary, total: tasks.length }
  };
}

async function completeTask(args) {
  const userId = getCurrentUserId();
  const data = readData();
  const idx = data.tasks.findIndex(t => t.id === args.taskId && t.userId === userId);

  if (idx === -1) {
    return { message: `未找到任务 ID: ${args.taskId}` };
  }

  data.tasks[idx].completed = true;
  data.tasks[idx].progress = 'completed';
  data.tasks[idx].updatedAt = new Date().toISOString();

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('tasks-updated');

  return { message: `✅ 任务「${data.tasks[idx].title}」已标记为完成！` };
}

// --- 备忘录 ---

async function createMemo(args) {
  const userId = getCurrentUserId();
  const now = new Date().toISOString();

  const memo = {
    id: uuidv4(),
    title: args.title || '',
    content: args.content,
    htmlContent: null,
    orderIndex: null,
    isPrivate: args.isPrivate || false,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    userId: userId,
    creator: global._currentAIAgentCreatorName || 'AI助手'
  };

  const data = readData();
  // ★ P1-1: 查重（创建但提示策略）
  const dupCheck = checkDuplicateMemo(data, args, userId);
  data.memos.push(memo);
  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('memos-updated');

  const result = {
    message: `✅ 已创建备忘录「${memo.title || '无标题'}」${memo.isPrivate ? '🔒(私密)' : ''}`,
    data: { id: memo.id, title: memo.title }
  };
  if (dupCheck) {
    result.duplicateWarning = dupCheck.warning;
    result.message += `\n⚠️ 注意：${dupCheck.warning}`;
  }
  return result;
}

async function updateMemo(args) {
  const userId = getCurrentUserId();
  const data = readData();
  const idx = data.memos.findIndex(m => m.id === args.memoId && m.userId === userId);

  if (idx === -1) return { message: `未找到备忘录 ID: ${args.memoId}` };

  if (args.title !== undefined) data.memos[idx].title = args.title;
  if (args.content !== undefined) data.memos[idx].content = args.content;
  data.memos[idx].updatedAt = new Date().toISOString();

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('memos-updated');

  return { message: `✅ 已更新备忘录「${data.memos[idx].title || '无标题'}」` };
}

async function deleteMemo(args) {
  return await _deleteGeneric(args.memoId, 'memos', '备忘录', args.memoTitle);
}

async function listMemos(args) {
  const data = readData();
  let memos = [...data.memos];
  if (args.keyword) {
    const kw = args.keyword.toLowerCase();
    memos = memos.filter(m => m.title?.toLowerCase().includes(kw) || m.content?.toLowerCase().includes(kw));
  }
  const limit = args.limit || 20;
  memos = memos.slice(0, limit);

  const summary = memos.map(m => ({
    id: m.id,
    title: m.title || '无标题',
    isPrivate: !!m.isPrivate,
    createdAt: m.createdAt
  }));

  return {
    message: memos.length > 0
      ? `找到 ${memos.length} 条备忘录:\n${summary.map(m => `- ${m.isPrivate ? '🔒 ' : ''}${m.title}`).join('\n')}`
      : '没有找到备忘录。',
    data: { memos: summary, total: memos.length }
  };
}

// --- 收支记账 ---

async function addExpense(args) {
  const userId = getCurrentUserId();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  const expense = {
    id: uuidv4(),
    detail: args.detail,
    category: args.category || (args.type === 'income' ? '其他' : '其他'),
    amount: Math.abs(args.amount),
    type: args.type,
    date: args.date || today,
    createdAt: now,
    updatedAt: now,
    userId: userId,
    creator: global._currentAIAgentCreatorName || 'AI助手'
  };

  const data = readData();
  // ★ P1-1: 查重（创建但提示策略）
  const dupCheck = checkDuplicateExpense(data, args, userId);
  data.expenses.push(expense);
  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('expenses-updated');

  const typeLabel = args.type === 'income' ? '💰收入' : '💸支出';
  const result = {
    message: `✅ 已记录${typeLabel}：${expense.detail} ${expense.amount.toFixed(2)}元 (${expense.category})`,
    data: { id: expense.id }
  };
  if (dupCheck) {
    result.duplicateWarning = dupCheck.warning;
    result.message += `\n⚠️ 注意：${dupCheck.warning}`;
  }
  return result;
}

async function updateExpense(args) {
  const userId = getCurrentUserId();
  const data = readData();
  const idx = data.expenses.findIndex(e => e.id === args.expenseId && e.userId === userId);

  if (idx === -1) return { message: `未找到收支记录 ID: ${args.expenseId}` };

  if (args.detail !== undefined) data.expenses[idx].detail = args.detail;
  if (args.amount !== undefined) data.expenses[idx].amount = Math.abs(args.amount);
  if (args.type !== undefined) data.expenses[idx].type = args.type;
  if (args.category !== undefined) data.expenses[idx].category = args.category;
  if (args.date !== undefined) data.expenses[idx].date = args.date;
  data.expenses[idx].updatedAt = new Date().toISOString();

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('expenses-updated');

  return { message: `✅ 已更新收支记录「${data.expenses[idx].detail}」` };
}

async function deleteExpense(args) {
  return await _deleteGeneric(args.expenseId, 'expenses', '收支记录', args.expenseDetail);
}

async function listExpenses(args) {
  const data = readData();
  let expenses = [...data.expenses];

  if (args.type) expenses = expenses.filter(e => e.type === args.type);
  if (args.category) expenses = expenses.filter(e => e.category === args.category);
  if (args.startDate) expenses = expenses.filter(e => e.date >= args.startDate);
  if (args.endDate) expenses = expenses.filter(e => e.date <= args.endDate);
  if (args.keyword) {
    const kw = args.keyword.toLowerCase();
    expenses = expenses.filter(e => e.detail?.toLowerCase().includes(kw));
  }

  const limit = args.limit || 30;
  const sorted = expenses.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);

  const summary = sorted.map(e => ({
    id: e.id,
    detail: e.detail,
    amount: e.amount,
    type: e.type,
    category: e.category,
    date: e.date
  }));

  const totalIncome = sorted.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const totalExpense = sorted.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);

  return {
    message: `找到 ${sorted.length} 条记录。收入合计: ${totalIncome.toFixed(2)} 元，支出合计: ${totalExpense.toFixed(2)} 元。`,
    data: { expenses: summary, totalIncome, totalExpense, total: sorted.length }
  };
}

async function getExpenseSummary(args) {
  const data = readData();
  const today = new Date().toISOString().split('T')[0];
  const startDate = args.startDate || today;
  const endDate = args.endDate || today;

  const expenses = data.expenses.filter(e => e.date >= startDate && e.date <= endDate);
  const income = expenses.filter(e => e.type === 'income');
  const outgoing = expenses.filter(e => e.type === 'expense');

  const totalIncome = income.reduce((s, e) => s + e.amount, 0);
  const totalExpense = outgoing.reduce((s, e) => s + e.amount, 0);

  // 按分类统计
  const byCategory = {};
  for (const e of outgoing) {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  }
  const categorySummary = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `${cat}: ${amt.toFixed(2)}元`);

  return {
    message: `📊 ${startDate} 至 ${endDate} 财务概况:\n`
      + `总收入: ${totalIncome.toFixed(2)} 元\n`
      + `总支出: ${totalExpense.toFixed(2)} 元\n`
      + `结余: ${(totalIncome - totalExpense).toFixed(2)} 元\n`
      + (categorySummary.length > 0 ? `支出分类:\n${categorySummary.map(c => `  - ${c}`).join('\n')}` : ''),
    data: { totalIncome, totalExpense, balance: totalIncome - totalExpense, byCategory }
  };
}

// --- 日志日记 ---

async function addJournal(args) {
  // ★ 修复：content 必须非空，防止 AI 只输出文字不传日记内容
  if (!args.content || String(args.content).trim().length === 0) {
    return { success: false, message: '日记内容不能为空，请在 content 参数中传入完整的日记正文。' };
  }
  const userId = getCurrentUserId();
  const now = new Date().toISOString();
  const today = now.split('T')[0];
  const journalDate = args.date || today;

  const data = readData();
  const existingIdx = data.journals.findIndex(j => j.date === journalDate && j.userId === userId);

  if (existingIdx !== -1) {
    // 更新已有日志
    data.journals[existingIdx].content = args.content;
    if (args.weather) data.journals[existingIdx].weather = args.weather;
    data.journals[existingIdx].updatedAt = now;
    if (!data.journals[existingIdx].creator) {
      data.journals[existingIdx].creator = global._currentAIAgentCreatorName || 'AI助手';
    }
  } else {
    // 新增
    data.journals.push({
      id: uuidv4(),
      date: journalDate,
      content: args.content,
      weather: args.weather || '',
      userId: userId,
      createdAt: now,
      updatedAt: now,
      creator: global._currentAIAgentCreatorName || 'AI助手'
    });
  }

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);

  // 广播刷新事件，让前端日志视图自动更新
  broadcast('journals-updated');

  const weatherEmoji = { sunny: '☀️', cloudy: '☁️', rainy: '🌧️', snowy: '❄️', foggy: '🌫️' };
  const wx = weatherEmoji[args.weather] || '';
  return {
    message: `✅ 已${existingIdx !== -1 ? '更新' : '记录'}${journalDate}的日志 ${wx}\n内容: ${args.content.slice(0, 100)}${args.content.length > 100 ? '...' : ''}`,
    data: { date: journalDate }
  };
}

async function listJournals(args) {
  const data = readData();
  let journals = [...data.journals];

  if (args.startDate) journals = journals.filter(j => j.date >= args.startDate);
  if (args.endDate) journals = journals.filter(j => j.date <= args.endDate);

  const limit = args.limit || 10;
  journals.sort((a, b) => b.date.localeCompare(a.date));
  journals = journals.slice(0, limit);

  const weatherEmoji = { sunny: '☀️', cloudy: '☁️', rainy: '🌧️', snowy: '❄️', foggy: '🌫️' };

  return {
    message: journals.length > 0
      ? `找到 ${journals.length} 篇日志:\n${journals.map(j => `- ${j.date} ${weatherEmoji[j.weather] || ''} ${j.content.slice(0, 50)}${j.content.length > 50 ? '...' : ''}`).join('\n')}`
      : '没有找到日志。',
    data: { journals: journals.map(j => ({ date: j.date, weather: j.weather, preview: j.content.slice(0, 100) })) }
  };
}

// --- 预算管理 ---

async function createBudget(args) {
  const userId = getCurrentUserId();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  // 默认本月
  const d = new Date();
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];

  const budget = {
    id: uuidv4(),
    startDate: args.startDate || today,
    endDate: args.endDate || monthEnd,
    amount: args.amount,
    createdAt: now,
    updatedAt: now,
    userId: userId
  };

  const categoryBudgets = (args.categoryBudgets || []).map(cb => ({
    id: uuidv4(),
    budgetId: budget.id,
    category: cb.category,
    amount: cb.amount,
    createdAt: now,
    userId: userId
  }));

  const data = readData();
  // ★ P1-1: 查重（创建但提示策略）
  const dupCheck = checkDuplicateBudget(data, args, userId);
  data.budgets.push(budget);
  if (categoryBudgets.length > 0) {
    data.categoryBudgets = (data.categoryBudgets || []).concat(categoryBudgets);
  }

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('expenses-updated');

  const result = {
    message: `✅ 已创建预算: 总额 ${budget.amount} 元，${budget.startDate} 至 ${budget.endDate}`
      + (categoryBudgets.length > 0 ? `\n分类预算:\n${categoryBudgets.map(c => `  - ${c.category}: ${c.amount}元`).join('\n')}` : ''),
    data: { id: budget.id }
  };
  if (dupCheck) {
    result.duplicateWarning = dupCheck.warning;
    result.message += `\n⚠️ 注意：${dupCheck.warning}`;
  }
  return result;
}

async function updateBudget(args) {
  const userId = getCurrentUserId();
  const data = readData();
  const idx = data.budgets.findIndex(b => b.id === args.budgetId && b.userId === userId);

  if (idx === -1) return { message: `未找到预算 ID: ${args.budgetId}` };

  if (args.amount !== undefined) data.budgets[idx].amount = args.amount;
  if (args.startDate !== undefined) data.budgets[idx].startDate = args.startDate;
  if (args.endDate !== undefined) data.budgets[idx].endDate = args.endDate;
  data.budgets[idx].updatedAt = new Date().toISOString();

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);
  broadcast('expenses-updated');

  return { message: `✅ 已更新预算` };
}

async function listBudgets(args) {
  const data = readData();
  const budgets = [...data.budgets];
  const categoryBudgets = (data.categoryBudgets || []);

  const today = new Date().toISOString().split('T')[0];

  const summary = budgets.map(b => {
    const cbs = categoryBudgets.filter(cb => cb.budgetId === b.id);
    const active = b.startDate <= today && b.endDate >= today;
    return {
      id: b.id, startDate: b.startDate, endDate: b.endDate,
      amount: b.amount, active,
      categories: cbs.map(c => ({ category: c.category, amount: c.amount }))
    };
  });

  return {
    message: budgets.length > 0
      ? `共 ${budgets.length} 个预算:\n${summary.map(b => `- ${b.active ? '🟢' : '⚪'} ${b.startDate}~${b.endDate}: 总额 ${b.amount}元`).join('\n')}`
      : '暂无预算计划。用「设预算」来创建一个吧！',
    data: { budgets: summary }
  };
}

async function getBudgetStatus(args) {
  const data = readData();
  let budget;
  const today = new Date().toISOString().split('T')[0];

  if (args.budgetId) {
    budget = data.budgets.find(b => b.id === args.budgetId);
  } else {
    // 找当前活跃预算
    budget = data.budgets.find(b => b.startDate <= today && b.endDate >= today);
    if (!budget) budget = data.budgets[data.budgets.length - 1]; // 最近一个
  }

  if (!budget) return { message: '暂无预算数据。' };

  const budgetExpenses = data.expenses.filter(
    e => e.type === 'expense' && e.date >= budget.startDate && e.date <= today
  );
  const spent = budgetExpenses.reduce((s, e) => s + e.amount, 0);
  const remaining = budget.amount - spent;
  const progressPct = ((spent / budget.amount) * 100).toFixed(1);

  // 按分类统计
  const byCategory = {};
  for (const e of budgetExpenses) {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  }

  const categoryBudgets = (data.categoryBudgets || []).filter(cb => cb.budgetId === budget.id);
  const categoryStatus = categoryBudgets.map(cb => ({
    category: cb.category,
    budget: cb.amount,
    spent: byCategory[cb.category] || 0,
    remaining: cb.amount - (byCategory[cb.category] || 0)
  }));

  return {
    message: `📊 预算执行情况 (${budget.startDate} ~ ${budget.endDate}):\n`
      + `预算总额: ${budget.amount}元\n`
      + `已支出: ${spent.toFixed(2)}元 (${progressPct}%)\n`
      + `剩余: ${remaining.toFixed(2)}元\n`
      + (categoryStatus.length > 0
        ? `分类明细:\n${categoryStatus.map(c => `  - ${c.category}: ${c.spent.toFixed(2)}/${c.budget}元 (${((c.spent / c.budget) * 100).toFixed(0)}%)`).join('\n')}`
        : ''),
    data: { budgetId: budget.id, total: budget.amount, spent, remaining, progressPct, categoryStatus }
  };
}

// --- 设置 ---

async function getSettings(args) {
  const data = readData();
  const s = data.settings || {};

  // 返回公开设置，脱敏 API Key
  return {
    message: `当前设置:\n- 主题: ${s.theme || 'auto'}\n- AI 模型: ${s.aiModel || 'deepseek-chat'}\n- 智能体: ${s.aiAgentName || '昔涟'}`,
    data: {
      theme: s.theme || 'auto',
      aiModel: s.aiModel || 'deepseek-chat',
      aiAgentName: s.aiAgentName || '昔涟',
      aiStreamEnabled: s.aiStreamEnabled !== false,
      aiContextRounds: s.aiContextRounds || 10,
      aiTemperature: s.aiTemperature ?? 1.0
    }
  };
}

async function updateSettings(args) {
  const data = readData();
  data.settings = data.settings || {};

  if (args.theme !== undefined) data.settings.theme = args.theme;

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);

  return { message: `✅ 已更新设置` };
}

async function switchUser(args) {
  const data = readData();
  const users = data.settings?.cloudUsers || [];
  const userExists = users.some(u => u.id === args.userId);

  if (!userExists) {
    return { message: `用户「${args.userId}」不存在。请先在云同步设置中创建。` };
  }

  data.settings.cloudCurrentUserId = args.userId;
  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);

  broadcast('user-changed');

  return { message: `✅ 已切换到用户「${args.userId}」。界面将自动刷新。` };
}

// --- 云同步 ---

async function triggerSync(args) {
  try {
    const { performSync } = require('./cloud-sync');
    const result = await performSync();
    return {
      message: result.success ? `✅ 云同步完成: ${result.message}` : `⚠️ 云同步失败: ${result.message}`,
      data: result
    };
  } catch (e) {
    return { message: `⚠️ 云同步出错: ${e.message}` };
  }
}

async function getSyncStatus(args) {
  const data = readData();
  const s = data.settings || {};
  const lastSync = s.lastSyncTime || 0;
  const status = s.cloudToken ? '已配置' : '未配置';

  let msg = `云同步状态: ${status}`;
  if (lastSync > 0) {
    const ago = Math.floor((Date.now() - lastSync) / 60000);
    msg += `\n上次同步: ${ago < 1 ? '刚刚' : ago < 60 ? `${ago}分钟前` : `${Math.floor(ago / 60)}小时前`}`;
  }

  return { message: msg, data: { configured: !!s.cloudToken, lastSync } };
}

// --- 系统概览 ---

async function getDashboard(args) {
  const data = readData();
  const today = new Date().toISOString().split('T')[0];

  // 本日任务
  const todayTasks = data.tasks.filter(t => t.startDate.startsWith(today) || t.endDate.startsWith(today));
  const pendingTasks = data.tasks.filter(t => !t.completed);
  const urgentTasks = pendingTasks.filter(t => t.priority === 'urgent');

  // 本周收支
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const ws = weekStart.toISOString().split('T')[0];
  const weekExpenses = data.expenses.filter(e => e.date >= ws && e.date <= today);
  const weekSpent = weekExpenses.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const weekIncome = weekExpenses.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);

  // 活跃预算
  const activeBudget = data.budgets.find(b => b.startDate <= today && b.endDate >= today);
  let budgetInfo = '';
  if (activeBudget) {
    const spent = data.expenses
      .filter(e => e.type === 'expense' && e.date >= activeBudget.startDate && e.date <= today)
      .reduce((s, e) => s + e.amount, 0);
    budgetInfo = `\n活跃预算: ${activeBudget.amount}元 (已用${spent.toFixed(0)}元)`;
  }

  // 今日日志
  const todayJournal = data.journals.find(j => j.date === today);

  return {
    message: `📋 今日概览:\n`
      + `今日任务: ${todayTasks.length}个 (总共${pendingTasks.length}个待完成${urgentTasks.length > 0 ? `，${urgentTasks.length}个紧急` : ''})\n`
      + `本周收入: ${weekIncome.toFixed(2)}元 | 本周支出: ${weekSpent.toFixed(2)}元\n`
      + `备忘录: ${data.memos.length}条 | 日志: ${data.journals.length}篇${todayJournal ? ' | 今天已写日志' : ' | 今天还没写日志'}`,
    data: {
      todayTasks: todayTasks.length,
      pendingTasks: pendingTasks.length,
      urgentTasks: urgentTasks.length,
      weekIncome, weekSpent,
      memos: data.memos.length,
      journals: data.journals.length,
      hasTodayJournal: !!todayJournal
    }
  };
}

// ============================================================
// HELPERS
// ============================================================

async function _deleteGeneric(id, collection, label, title) {
  const userId = getCurrentUserId();
  const data = readData();
  const arr = data[collection];
  const idx = arr.findIndex(item => item.id === id && item.userId === userId);

  if (idx === -1) {
    return { message: `未找到${label} ID: ${id}` };
  }

  const itemTitle = title || arr[idx].title || arr[idx].detail || arr[idx].name || '';
  arr.splice(idx, 1);

  await writeData(data.tasks, data.memos, data.expenses, data.budgets,
    data.settings, data.translationStats, data.categoryBudgets || [],
    data.secrets || [], data.journals || [], true, data.chatHistory);

  // 广播更新
  const events = { tasks: 'tasks-updated', memos: 'memos-updated', expenses: 'expenses-updated' };
  if (events[collection]) broadcast(events[collection]);

  return { message: `✅ 已删除${label}「${itemTitle}」` };
}

// ============================================================
// MODULE EXPORTS
// ============================================================
module.exports = {
  TOOL_DEFINITIONS,
  TOOLS_REQUIRING_CONFIRM,
  executeToolCall,
  // 单独暴露以便测试
  createTask, updateTask, deleteTask, listTasks, completeTask,
  createMemo, updateMemo, deleteMemo, listMemos,
  addExpense, updateExpense, deleteExpense, listExpenses, getExpenseSummary,
  addJournal, listJournals,
  createBudget, updateBudget, listBudgets, getBudgetStatus,
  getSettings, updateSettings, switchUser,
  triggerSync, getSyncStatus,
  getDashboard
};
