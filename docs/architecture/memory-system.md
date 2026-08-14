# 记忆子系统文档（MemoryConstellations 集成）

> Elysia 把开源项目 MemoryConstellations（AI 伴侣自组织记忆系统）整体集成进 Electron 应用，作为「昔涟」的长期记忆"大脑"。**注意：它不是独立 HTTP 服务，而是通过 IPC 桥（mc-bridge.js）直连主进程。**

## 一、架构总览

```
用户对话 (xilian 聊天)
    │ chatHistory 保存时
    ▼ mc:ingest(user/assistant 消息)
mc-bridge._triggerScribe ──(延迟 5s 合并)──▶ scribe.checkAndRunScribe
                                                     │ LLM 提炼
                                                     ▼
                              memory_fragments 碎片 ← entityResolver 绑定 entity_id
                                                     ▼
                        archivist agentTick(2min) 分类/召回/认知模型维护
                                                     ▼
                AI 回复时主动调用 recall_memory / browse_memories / correct_memory
                    (xilian-tools → memory/services/tools → librarian 检索)
```

| 层 | 原版（MemoryConstellations） | Elysia 实际用法 |
|---|---|---|
| 启动 | Express HTTP 服务 (3000 端口) + PWA 前端 | **IPC 桥直连**，无独立端口 |
| 数据库 | sanctuary.db（better-sqlite3） | 同样，位于 userData/sanctuary.db（WAL 模式） |
| 路由 | routes/memory-api.js（Express Router） | **未挂载**，逻辑被 IPC 复用 |
| 向量检索 | ChromaDB 常驻服务 + 本地 embedding | **已降级**：不可用，检索兜底走 FTS5 |
| LLM | llm.js / openai-compat.js | 记忆内部用 llm.js；对话智能体用 xilian-agent.js（两者 key 来源不同，勿混用） |

## 二、模块职责

### 提取/认知层（对话 → 记忆）
| 文件 | 职责 |
|---|---|
| scribe.js（书记员） | 扫描新增对话消息，LLM 提炼成 memory_fragments 碎片，写回 DB 并建实体关联 |
| consolidator.js（整合器） | Saga 聚类、相似片段分组、矛盾检测、Flash 即时整合 |
| entityResolver.js | 碎片写后同步绑定 entity_id（关键词 + LLM 指代消解） |
| entityProfile.js | 维护人物/地点/事件/作品档案的最新状态 |
| summary.js | 对话自动总结（token 控制） |
| context.js | 智能上下文构建 + 健康数据简报 |
| nameResolver.js / memoryConfig.js | 名字/配置解析（{{user.name}} 模板替换） |
| worldContext.js | 所有 LLM prompt 的公共世界观前缀 |

### 认知模型层（长期人格/状态）
| 文件 | 职责 |
|---|---|
| cognitiveModel.js（132KB） | **四层认知模型**：immutable_fact / stable_trait / current_state（7 天半衰期衰减）/ active_hypothesis（3 次确认升级）；存 clara_model 表 |
| intuition.js | 直觉引擎：上下文触发的认知直觉注入（current_state 始终注入等分层触发） |
| skillManager.js | Archivist 自我进化技能系统（hypothesis→追踪→自评估→升级） |
| claraModel.js | 别名转发（=cognitiveModel） |
| cognitiveEvolution.js / ontology.js | ⚠️ **STUB 空桩**：上游缺失，no-op，相关功能惰性 |

### 检索层（记忆 → 对话）
| 文件 | 职责 |
|---|---|
| memory.js（冥想盆） | 记忆检索核心：硬触发检索 + 向量检索（ChromaDB HTTP）+ 陈旧条目清理 |
| librarian.js（图书管理员） | **双路混合检索** searchHybrid：FTS5 全文 + 向量（退化后纯 FTS5），衰减权重、novelty 惩罚、实体过滤、意图分类 |

### 生命周期/其他
| 文件 | 职责 |
|---|---|
| lifecycle.js | 记忆新陈代谢：每天凌晨碎片 GC、episode 衰减、实体提取、纠正反馈、权重重算 |
| archivist.js（307KB，最大） | **Archivist 智能体**：2 分钟 tick 自主循环（空闲 ≥60 分钟走"🌙深度整合"否则"☀️轻量"），分类碎片/维护星座/发现实体关系/提取洞察；记忆门控（内存不足跳过 LLM 任务、每日 LLM 调用量限制） |
| universe.js | 组装"星星图宇宙"数据（供 IPC/Elysia 复用） |
| workingMemory.js | 话题感知工作记忆池（MemGPT 模式：最近 5 条主动召回片段） |

### 工具（services/tools/）
- index.js：工具注册表（getEnabledTools 按设置过滤 + executeTool 分发）
- memoryTools.js：recall_memory（模糊搜索/深度追溯）、browse_memories（浏览全貌）、correct_memory（纠错修正）
- manageUserState.js：update_current_state（AI 主动维护对用户的认知，set/update/resolve）

### 基础设施
- database.js：SQLite 核心，85+ schema 迁移，初始化全部表 + FTS5 中文分词索引
- encryption.js：「庇护所加密」AES-256-GCM（SANCTUARY_ENCRYPTION_KEY，64 位 hex），密文格式 `enc:iv:authTag:ciphertext`
- openai-compat.js：Gemini↔OpenAI 格式转换层（含 ToolCallAccumulator 增量工具调用累积）
- config.js / .env：端口、session 密钥、token 上限等（**.env 存在敏感配置**：加密键/session 密钥/登录密码/API Key，勿改加密键否则已加密数据无法解密）

## 三、数据库核心表

- memory_fragments（碎片，status/layer/entity，FTS5 索引）
- memories（冥想盆长期记忆，tag/有效时间/permanent）
- clara_model（四层认知模型）
- entity_profiles（实体档案）+ fragment_entities / entity_timeline
- consolidation_runs / scribe_runs（运行记录）
- working_memory_pool（工作记忆池）
- 业务表：chats / messages / snitch / books / cinema / health_data 等

## 四、与昔涟的关系

| 方向 | 机制 |
|---|---|
| 对话 → 记忆 | xilian-manager 通过 mc:ingest 喂消息 → Scribe 提炼碎片 → Archivist 分类维护 |
| 记忆 → 对话 | 昔涟主动调用 4 个记忆工具（**检索不自动注入，靠 AI 主动召回**） |
| 身份同步 | 切换智能体时 mcUpdateAiStarName 同步星图 AI 主星名 |
| 失败隔离 | mc-bridge 全部 try/catch，记忆系统故障不拖垮 Elysia |

## 五、给接手者的注意点

1. **双轨架构**：routes/memory-api.js（原版 Express 路由）与活跃 IPC 路径并存，别误以为有 HTTP 服务
2. **向量已降级**：检索实际走 FTS5，别指望向量语义召回
3. **STUB 文件**：cognitiveEvolution.js / ontology.js 是空桩
4. **敏感配置**：memory/.env 的加密键不能改，否则已加密数据无法解密
5. **真正常驻集成在 mc-bridge.js**（initMC），含时间戳归一化、content_hash 去重等 Elysia 特有修补
