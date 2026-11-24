# dsh-vscode-harness

DeepSeek Harness 的 VS Code 插件版工程：完整保留官方 DeepSeek Harness 核心能力与原生交互体验，将其适配为 **VS Code 侧边栏（Activity Bar）+ 独立编辑器标签页（Editor Tabs）** 的分屏架构，并与 `dsh` CLI / Desktop 共用同一个 `$DSH_HOME`（默认 `~/.dsh`）用户目录。

## 架构概览

```text
VS Code Extension Host (apps/vscode)
  ├── DshHostManager ──IPC/Cookie──▶ Local Node Host (apps/vscode-host)
  │                                    ├── 共享 ~/.dsh (sessions / workspaces / credentials / settings / skills)
  │                                    └── Profile: ~/.dsh/profiles/vscode
  │                                          ├── @deepseek-ai/dsh-base       (官方 vendor)
  │                                          ├── @deepseek-ai/dsh-web-app    (官方 vendor)
  │                                          └── @deepseek-ai/dsh-vscode-app (VS Code 裁剪与布局补丁)
  │
  ├── Activity Bar Sidebar (dsh.sidebar)
  │     └── 渲染 DSH 原生左侧栏（工作区、会话列表、新会话、插件/定时任务入口、设置）
  │         点击会话/面板 -> 通知 Extension Host 打开或聚焦对应 VS Code 标签页
  │
  └── Editor Tabs (WebviewPanel，支持多会话并排打开)
        ├── 对话标签页：渲染完整 DSH 对话流、工具卡片、审批交互、Plan/变更审查
        ├── 插件/定时任务标签页：复用原生 DSH 页面
        └── 设置标签页（dsh.openSettings）：宽屏全量设置页
```

### 裁剪与 Vendor 策略

- **官方源码作为 vendor 保持原样**：`vendor/`、`packages/`（除 `packages/vscode/*` 外）、`native/`、`apps/cli`、`apps/web` 未做侵入式修改，详见 [`VENDOR.md`](./VENDOR.md)。
- **移除非插件外围工程**：已移除 `apps/desktop*`、`apps/plugin-market-generator`、`python/`、`website/`、`benchmarks/`、`snapshots/`。
- **裁剪与 VS Code 原生重叠的右侧面板**：通过 [`packages/vscode/bundle/cordis.patch.yml`](./packages/vscode/bundle/cordis.patch.yml) 禁用 `ui-sidebar-files`、`ui-sidebar-terminal`、`ui-sidebar-browser`、`ui-sidebar-documentpreview`，同时保留 `ui-sidebar-right` 以确保 Plan 审阅、变更文件审阅与定时任务正常工作。
- **共享 DSH 用户目录**：默认复用 `~/.dsh`（或环境变量 `DSH_HOME` / 设置项 `dsh.home`），在 `~/.dsh/profiles/vscode` 下维护独立的 VS Code profile 清单，不会破坏 CLI 或 Desktop 的 profile 配置。

## 新增的 VS Code 适配层

| 目录 | 包名 | 职责 |
|---|---|---|
| `packages/vscode/ui-layout` | `@deepseek-ai/dsh-vscode-ui-layout` | 替代 `ui-layout` 的分屏布局插件：侧边栏模式仅渲染左侧栏并拦截导航事件，标签页模式仅渲染主内容区并自动同步标签页标题与 VS Code 明暗主题 |
| `packages/vscode/bundle` | `@deepseek-ai/dsh-vscode-app` | Cordis profile patch 层：替换 `ui-layout`、禁用重叠右侧面板与桌面遥测 |
| `apps/vscode-host` | `@deepseek-ai/dsh-vscode-host` | 本地 Node Host 启动器：IPC 私有凭据认证、初始化 `~/.dsh/profiles/vscode`、自动同步 VS Code 工作区目录 |
| `apps/vscode` | `dsh-vscode-harness` | VS Code 扩展主体：Host 进程管理、`postMessage` HTTP/WebSocket/Bundle 代理、Sidebar View 与多标签页 Editor Panel 管理 |

## 快速开始

### 1. 安装依赖与构建

要求 Node.js `>= 22.19`（推荐 `>= 24`）和 `pnpm`。

```sh
pnpm install
pnpm run build:all
```

仅重新编译 VS Code 扩展主体（修改 `apps/vscode/src` 后）：

```sh
pnpm run build:vscode
# 或持续监听编译：
pnpm run watch:vscode
```

### 2. 打包并安装 `.vsix`（macOS arm64）

```sh
pnpm run package:vsix:mac:arm64
```

产物输出至 `apps/vscode/dist/dsh-vscode-harness-0.1.0-darwin-arm64.vsix`，可通过命令行或在 VS Code 扩展面板选择 **Install from VSIX…** 安装：

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension apps/vscode/dist/dsh-vscode-harness-0.1.0-darwin-arm64.vsix
```

### 3. 在 VS Code 中运行调试（F5）

1. 用 VS Code 打开本仓库根目录。
2. 按 **`F5`** 启动预设调试配置 `Run DeepSeek Harness VS Code Extension`（定义于 [`.vscode/launch.json`](./.vscode/launch.json)）。
3. 在弹出的 Extension Development Host 窗口左侧 Activity Bar 点击 **DeepSeek Harness** 鲸鱼图标即可使用。

### 4. 常用命令与配置

- 命令面板（`Cmd+Shift+P`）：
  - `DeepSeek Harness: New Chat` — 在当前工作区新建对话标签页
  - `DeepSeek Harness: Open Settings` — 打开宽屏设置标签页
  - `DeepSeek Harness: Open Plugins` — 打开插件管理标签页
  - `DeepSeek Harness: Restart Local Host` — 重启本地 DSH Host
  - `DeepSeek Harness: Show Host Logs` — 查看 Host 输出日志
- 扩展设置：
  - `dsh.nodePath` — 指定运行本地 Host 的 Node.js 路径（留空自动探测）
  - `dsh.home` — 自定义 `DSH_HOME` 路径（留空默认共享 `~/.dsh`）
  - `dsh.autoSyncWorkspace` — 启动时自动将当前 VS Code 打开的目录注册到 DSH 工作区（默认 `true`）
