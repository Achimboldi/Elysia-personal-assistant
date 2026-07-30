# Elysia

个人效率工具，桌面端（Electron）与移动端（Flutter）双端同步，集成 AI 助手「昔涟」，涵盖任务、备忘录、收支、日记、密码与记忆星图。

## ⚠️ 关于本项目的代码来源

**本项目所有代码完全由 AI（人工智能）生成，没有任何人工编写的代码。**

无能的人类（鄙人）在本项目中的角色**仅限于**：

1. **提出想法**——定义想要什么功能、什么体验；
2. **使用**——实际操作运行，验证功能是否符合预期；
3. **反馈问题**——发现 bug、描述不满意的地方，由 AI 负责定位与修复。

换言之，需求、体验与使用由人负责，而代码的设计、编写、调试、优化全部由 AI 完成。本仓库作为这一协作模式的实践记录而存在。

## 功能

- **AI 助手「昔涟」**：自然对话式交互，支持任务管理、备忘记录、收支记账、日记等 25+ 工具调用
- **任务管理**：待办事项、今日任务（跨天持久化，每日重置完成状态）
- **备忘录**：Quill 富文本编辑器，飞书式标题大纲导航
- **收支记账**：分类预算、收支记录、月度统计
- **日记**：支持 Markdown 编辑
- **密码管理**：本地加密存储
- **聊天室**：多会话对话历史
- **云同步**：桌面端与移动端通过网盘同步数据（百度网盘 OAuth2）
- **记忆星图**（开发中）：基于 MemoryConstellations 的长期记忆与关系可视化

## 技术栈

| 端 | 技术 |
|---|---|
| 桌面端 | Electron 28, Node.js, better-sqlite3, Quill |
| 移动端 | Flutter, sqflite, Provider |
| AI | DeepSeek API, Function Calling |
| 同步 | 百度网盘 OAuth2, JSON 合并 |

## 项目结构

```
├── main.js              # Electron 主进程
├── app.js               # 渲染进程主逻辑
├── index.html           # 主页面
├── styles.css           # 样式
├── xilian-agent.js      # 昔涟 AI 助手核心
├── xilian-tools.js      # AI 工具定义（25+）
├── data-service.js      # 数据读写服务
├── theme-manager.js     # 主题管理
├── mc-bridge.js         # MemoryConstellations 桥接
├── package.json
└── .gitignore
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动
npm start
```

> **注意**：运行需要配置 DeepSeek API Key。代码已支持从环境变量 `API_KEY` 读取，也可在应用设置中配置。

## 许可证

MIT
