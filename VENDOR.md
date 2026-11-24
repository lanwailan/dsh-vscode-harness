# Vendor Baseline

This repository (`dsh-vscode-harness`) vendors upstream DeepSeek Harness packages without invasive edits so upstream updates can be synced cleanly.

- **Upstream repository**: `https://github.com/lanwailan/deepseek-harness` (`master`)
- **Upstream commit**: `4b399c39a6`
- **Upstream release version**: `0.2.3-alpha.2`

## Directory Ownership

### Official Vendor Core (keep untouched)
- `vendor/` — Vendored Cordis framework packages
- `packages/*/` (all groups except `packages/vscode/`) — Official `@deepseek-ai/dsh-*` core, host, API, tools, and UI plugins
- `native/` — `@deepseek-ai/node-addon-system`
- `apps/cli/` — Official `dsh` profile boot library & CLI
- `apps/web/` — Official Web shell bundle consumed by the VS Code Webview

### VS Code Adaptation Layer (owned by `dsh-vscode-harness`)
- `packages/vscode/ui-layout/` — Split-surface layout plugin (`@deepseek-ai/dsh-vscode-ui-layout`)
- `packages/vscode/bundle/` — VS Code Cordis profile bundle patch (`@deepseek-ai/dsh-vscode-app`)
- `apps/vscode-host/` — Local Node Host process (`@deepseek-ai/dsh-vscode-host`)
- `apps/vscode/` — VS Code Extension (`dsh-vscode-harness`)
- `.vscode/launch.json`, `.vscode/tasks.json` — Extension Development Host launch configs

### Pruned Non-Extension Subprojects
- `apps/desktop`, `apps/desktop-host`, `apps/desktop-publisher`, `apps/plugin-market-generator`
- `python/`, `website/`, `benchmarks/`, `snapshots/`
