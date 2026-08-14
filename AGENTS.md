# Elysia 桌面版 — Agent 工作约定

本文件是桌面端仓库的默认入口。开工先读本文；需要背景知识时再按 `docs/README.md` 的索引补读专题文档。

## 项目是什么

Elysia 是一个个人效率助手桌面应用（便利贴·日程·财务·AI 助手），Electron 28 + 原生 JS（无框架）。内置「昔涟」AI 智能体（DeepSeek API + Function Calling）和记忆子系统（MemoryConstellations 集成）。移动端姐妹项目见 [Elysia-mobile](https://github.com/Achimboldi/Elysia-mobile)。

- 仓库：`https://github.com/Achimboldi/Elysia-personal-assistant.git`（分支 main）
- 本仓库目录：`win-unpacked/resources/app/`（**git 主源**）
- Linux 运行目录：`linux-app/resources/app/`（asar:false 源码直跑，与主源保持同步）

## 默认流程

1. 先读本文与相关专题文档，再动代码。
2. 改动前先 `git status` / `git log --oneline -5` 了解现状。
3. 每次改动一个明确主题，改完 `node --check <改动的.js>` 验证语法。
4. 完成后在 `docs/records/YYYY-MM-DD.md` 追加工作日志（现象→根因→修复→验证四段式）。
5. commit（规范 message：`fix:`/`feat:`/`docs:`/`chore:` 前缀），push 前先 git fetch 检查冲突。
6. 桌面端双目录同步（见 docs/runbook.md 第六节）。

## 硬红线

- **主源唯一**：永远从 `win-unpacked/resources/app` 改代码并提交；完成后把改动文件复制到 `linux-app/resources/app`（直接生效，无需构建）。
- **敏感信息**：`data.json`、`memory/.env`、`*.log` 含真实密钥，绝不输出、绝不提交（已 gitignore）。文档中只允许写"存在敏感配置"，不给具体值。
- **数据文件**：`data.json` 是用户全部身家，改数据前先备份（`app-cache/backups/` 有启动自动备份），禁止直接改线上 data.json 测试。
- **AI 引擎保护**：`xilian-agent.js` / `main.js` 是 AI 自改代码的写保护黑名单，人工改动需格外谨慎（影响面最大）。
- **Linux 兼容**：所有改动保持 `process.platform === 'linux'` 或路径回退判断，Windows 版不受影响。
- **验证下限**：任何行为变化必须至少 `node --check` + 重启应用实测；改动云同步逻辑勿破坏 `mergeSettings`/`mergeItemsWithConflictDetection` 的合并语义。

## 任务路由

| 任务类型 | 先读 |
|---|---|
| 功能/模块改动 | `docs/architecture/desktop-arch.md` |
| 数据格式/读写 | `docs/architecture/data-model.md` |
| AI 对话/工具/幻觉 | `docs/architecture/ai-engine.md` |
| 记忆/星图 | `docs/architecture/memory-system.md` |
| 云同步/冲突合并 | `docs/architecture/cloud-sync.md` |
| 部署/启动/构建/Linux | `docs/runbook.md` |
| 任何改动 | `docs/records/` 近期日志（了解演进历史） |

## 完成

- 工具调用成功且 `node --check` 通过才算完成；文档与代码冲突时以代码为准（代码是事实基线）。
- 不在没验证的情况下声称"改好了"。
