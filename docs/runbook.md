# Elysia 桌面版运维手册（Runbook）

> 部署、启动、构建、双端同步、常见坑位与安全风险。Linux 详细交接见 Elysia 目录下的 `LINUX交接文档.md`（本手册为其结构化补充）。

## 一、目录结构速览

```
妙妙小工具/Elysia/
├── win-unpacked/           ← Windows 版 + Git 仓库主源
│   └── resources/app/      ← 源码仓库（git，主源，改代码在这里）
│       └── data.json       ← Windows 运行数据（gitignored）
├── linux-app/              ← Linux 运行目录（实际执行）
│   ├── elysia              ← Electron 主程序（--no-sandbox 启动）
│   ├── data.json           ← Linux 运行数据（核心！）
│   ├── app-cache/          ← 缓存/日志/backups（启动自动备份 data.json）
│   └── resources/app/      ← 源码目录（asar:false，与主源同步）
├── LINUX交接文档.md
├── ai_guide.md
└── 智能体优化方案_v1.md
```

## 二、启动 / 停止（Linux）

```bash
# 启动（必须 --no-sandbox）
cd /mnt/data/妙妙小工具/Elysia/linux-app
./elysia --no-sandbox
# 带调试端口
./elysia --no-sandbox --remote-debugging-port=9222
# 停止（勿用 pkill -f，会误杀自身 bash）
pkill -x elysia
```

开机自启：`~/.config/niri/config.kdl` 的自动启动区（spawn-sh-at-startup，延迟 3 秒）。niri 不读取 `~/.config/autostart/*.desktop`。

## 三、开发 / 提交 / 双端同步（关键流程）

```bash
# 1. 改代码（永远在 win-unpacked 主源）
cd /mnt/data/妙妙小工具/Elysia/win-unpacked/resources/app

# 2. 语法检查
node --check main.js && node --check app.js

# 3. 提交并推送
git add -A && git commit -m "fix: 说明"
git push origin main

# 4. 同步到 Linux 运行目录（asar:false 直接生效，无需构建）
cp <改动的文件> /mnt/data/妙妙小工具/Elysia/linux-app/resources/app/

# 5. 更新 linux-app 的 git 状态（保持两端 HEAD 一致）
cd /mnt/data/妙妙小工具/Elysia/linux-app/resources/app
rm -rf .git && cp -r /mnt/data/妙妙小工具/Elysia/win-unpacked/resources/app/.git .git
git checkout -- .   # 恢复 electron-builder 排除的文件

# 6. 重启应用
pkill -x elysia
cd /mnt/data/妙妙小工具/Elysia/linux-app && setsid ./elysia --no-sandbox >/tmp/elysia-run.log 2>&1 &
```

## 四、重新构建 Linux 版（一般不需要）

```bash
cd /mnt/data/妙妙小工具/Elysia/win-unpacked/resources/app
npx electron-builder --linux dir --config.directories.output=/tmp/opencode/elysia-build
rsync -a --delete --exclude 'data.json' --exclude 'app-cache' --exclude '.git' \
  /tmp/opencode/elysia-build/linux-unpacked/ /mnt/data/妙妙小工具/Elysia/linux-app/
# 之后恢复 .git 并 git checkout -- .
```

## 五、GitHub 版本同步（应用内）

- update-manager.js 调 git CLI：fetch / pull --rebase --autostash / push
- 前提：运行目录是 git 仓库、origin 指向 GitHub、凭据已配（Linux: `~/.git-credentials`）
- ⚠️ 同步规范：永远从 win-unpacked 主源改代码；electron-builder 打包会排除 `.gitignore / Elysia.ico/png / package-lock.json`，部署后需 `git checkout -- .` 恢复
- ⚠️ `~/.git-credentials` 里是 GitHub PAT，建议定期轮换

## 六、系统级配置（不在仓库内）

| 配置 | 文件 | 作用 |
|---|---|---|
| 便利贴浮动/无边框 | `~/.config/niri/dms/windowrules.kdl` | open-floating + focus-ring off |
| 开机自启 | `~/.config/niri/config.kdl` | spawn-sh-at-startup |
| git 推送凭据 | `~/.git-credentials` | GitHub PAT |
| 其他 niri 配置 | `~/.config/niri/` | 快捷键/布局/DMS |

## 七、快速诊断

```bash
pgrep -x elysia                          # 是否运行
tail -50 /tmp/elysia-run.log             # 启动日志
tail -50 app-cache/app.log               # 运行日志
git log --oneline -1 && git ls-remote origin HEAD   # git 是否同步
niri msg --json windows                  # 便利贴应显示 floating:true
busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher \
  org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems   # 托盘是否注册
```

## 八、坑位清单

1. **`--no-sandbox` 必须**：chrome-sandbox 无 setcap 权限
2. **数据安全**：data.json 是全部身家，改前先备份（app-cache/backups/ 有自动备份）
3. **托盘图标**：已修复为 PNG（Linux 无法解码 .ico）；消失则检查 resources/Elysia.png
4. **便利贴**：靠 niri 窗口规则浮动；改 niri 配置后 `niri msg action load-config-file`
5. **取色器**：依赖 grim（Wayland 截图），无 grim 回退 desktopCapturer 可能黑屏
6. **pkill**：用 `pkill -x elysia`，勿用 `-f`
7. **Windows 兼容**：所有适配改动带平台判断，Windows 不受影响
8. **日志位置**：`/tmp/elysia-run.log`（手动）/`/tmp/elysia-autostart.log`（自启）/`app-cache/app.log`（应用）

## 九、⚠️ 安全风险记录（本轮确认：只记录，不处理）

| # | 风险 | 位置 | 建议 |
|---|---|---|---|
| 1 | DeepSeek API Key、GitHub Token、百度网盘 token **明文存储** | `data.json settings.*` | 轮换凭证；后续考虑加密存储 |
| 2 | **应用日志会完整打印 data.json 内容**（含全部密钥） | `app-cache/app.log` | 日志脱敏：打印前屏蔽 settings 敏感字段 |
| 3 | 移动端 `assets/initial_data.json` 硬编码百度网盘云凭证 | 移动端仓库 | 轮换 appKey/appSecret/token；改为运行时注入 |
| 4 | GitHub PAT 存于 `~/.git-credentials`，曾在对话中出现 | 系统文件 | 定期轮换，格式 `https://oauth2:<TOKEN>@github.com` |
| 5 | memory/.env 含记忆库加密键/session 密钥/登录密码/API Key | `resources/app/memory/.env` | 勿改加密键（否则已加密数据无法解密）；勿提交 |

**处理原则**：文档与对话中一律不输出真实凭证值；凭证轮换或脱敏改造前需用户明确授权。
