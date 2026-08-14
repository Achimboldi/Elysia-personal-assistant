# Elysia 桌面版文档索引

> 文档地图：遇到问题先来这里找路。所有文档随仓库版本控制，改动代码请同步更新相关文档。

## 阅读顺序（新接手者）

1. 先读 `AGENTS.md`（入口约定）和本索引
2. 按需读 `architecture/` 理解系统
3. 遇到环境/部署问题读 `runbook.md`
4. 想了解项目演进史翻 `records/`（按日期）和 `CHANGELOG.md`

## 文档清单

| 文档 | 内容 | 何时读 |
|---|---|---|
| [AGENTS.md](../AGENTS.md) | Agent/AI 协作入口约定、硬红线、任务路由 | 每次动工前 |
| [architecture/desktop-arch.md](architecture/desktop-arch.md) | 桌面端整体架构：进程模型、模块清单、页面结构 | 理解系统/定位功能 |
| [architecture/data-model.md](architecture/data-model.md) | data.json 数据模型：全部字段、读写层、墓碑/去重/多用户 | 动数据相关代码 |
| [architecture/ai-engine.md](architecture/ai-engine.md) | 昔涟 AI 引擎：系统提示词、工具集、幻觉检测、兜底 | 改 AI 行为/工具 |
| [architecture/memory-system.md](architecture/memory-system.md) | 记忆子系统：MemoryConstellations 集成、数据流、DB | 改记忆/星图 |
| [architecture/cloud-sync.md](architecture/cloud-sync.md) | 百度网盘云同步：合并算法、冲突、墓碑、竞态保护 | 改同步逻辑 |
| [runbook.md](runbook.md) | 运维手册：部署/启动/构建/双端同步/坑位/安全风险 | 环境与部署问题 |
| [decisions/](decisions/) | ADR 决策记录：重要架构决策的来龙去脉 | 想了解"为什么这么做" |
| [records/](records/) | 工作日志（按日期，四段式：现象→根因→修复→验证） | 了解最近改了什么 |
| [CHANGELOG.md](../CHANGELOG.md) | 变更日志（按日期归纳） | 快速看版本演进 |

## 外部参考

- `../LINUX交接文档.md`（Elysia 目录下）：Linux 部署/适配交接文档（环境、启动、GitHub 同步、适配改动清单、系统级配置）
- `../智能体优化方案_v1.md`：AI 智能体优化提案（P0/P1 已执行，P2 Skill 注册表未做）
- `../ai_guide.md`：AI 编程协作方法论笔记（信息分层、单源真理、记录规范，本文档体系的设计思想来源）

## 记录规范

- 每次改动：在 `records/YYYY-MM-DD.md` 追加「现象→根因→修复→验证」四段式记录
- 重要架构决策：在 `decisions/` 新建 ADR（模板见 `decisions/README.md`）
- commit message 用 `fix:` / `feat:` / `docs:` / `chore:` 前缀，一个主题一个 commit
