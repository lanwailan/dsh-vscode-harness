/**
 * DeepSeek Harness VS Code Extension entrypoint (`dsh-vscode-harness`).
 *
 * Architecture:
 * - Spawns one local Node `@deepseek-ai/dsh-vscode-host` process sharing `$DSH_HOME` (`~/.dsh`).
 * - Mounts DSH's left sidebar inside the VS Code Activity Bar (`dsh.sidebar`).
 * - Opens conversations, Plugins, Schedules, and Settings as native VS Code Editor Tabs.
 */
import { resolve } from 'node:path'
import * as vscode from 'vscode'
import { DshEditorPanelManager } from './editor-panel-manager.ts'
import { DshHostManager } from './host-manager.ts'
import { DshSidebarViewProvider } from './sidebar-provider.ts'
import { BundleCache } from './webview-bridge.ts'
import { resolveWebviewResources } from './webview-html.ts'

let activeHostManager: DshHostManager | undefined

export function activate(context: vscode.ExtensionContext): void {
  const repoRoot = resolve(context.extensionPath, '../..')
  const output = vscode.window.createOutputChannel('DeepSeek Harness')
  const hostManager = new DshHostManager(repoRoot, output)
  activeHostManager = hostManager
  const bundleCache = new BundleCache()
  const resources = resolveWebviewResources(repoRoot, context.extensionPath)

  let sidebarProvider: DshSidebarViewProvider | undefined
  const editorManager = new DshEditorPanelManager(
    context.extensionPath,
    hostManager,
    bundleCache,
    resources,
    (state) => { sidebarProvider?.notifyActiveTabChanged(state) },
  )

  sidebarProvider = new DshSidebarViewProvider(
    hostManager,
    bundleCache,
    resources,
    {
      openConversation: (sessionId, title, workspaceId) => {
        editorManager.openConversation(sessionId, title, workspaceId)
      },
      openPanel: (panelId, title) => {
        editorManager.openPanel(panelId, title)
      },
    },
  )

  context.subscriptions.push(
    output,
    hostManager,
    editorManager,
    sidebarProvider,
    vscode.window.registerWebviewViewProvider(
      DshSidebarViewProvider.viewId,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      const autoSync = vscode.workspace.getConfiguration('dsh').get<boolean>('autoSyncWorkspace', true)
      if (!autoSync || event.added.length === 0) return
      const addedPaths = event.added.map(folder => folder.uri.fsPath)
      void hostManager.ensureWorkspaces(addedPaths).catch((error: unknown) => {
        output.appendLine(`[dsh-vscode] workspace sync failed: ${String(error)}`)
      })
    }),
    vscode.commands.registerCommand('dsh.newChat', async () => {
      try {
        const host = await hostManager.ensureReady()
        const activeFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        const workspaceId = activeFolder === undefined ? undefined : host.workspaceIds[activeFolder]
        editorManager.openConversation(undefined, 'New Chat', workspaceId)
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(`DeepSeek Harness: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),
    vscode.commands.registerCommand('dsh.openSettings', () => {
      editorManager.openPanel('vscode-settings', 'DeepSeek Harness Settings')
    }),
    vscode.commands.registerCommand('dsh.openPlugins', () => {
      editorManager.openPanel('plugins', 'DeepSeek Harness Plugins')
    }),
    vscode.commands.registerCommand('dsh.restartHost', async () => {
      try {
        bundleCache.clear()
        await hostManager.restart()
        sidebarProvider?.reload()
        editorManager.reloadAll()
        void vscode.window.showInformationMessage('DeepSeek Harness Host restarted.')
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(`Failed to restart DeepSeek Harness Host: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),
    vscode.commands.registerCommand('dsh.showHostLogs', () => {
      output.show(true)
    }),
  )

  // Warm up the local Host process in the background right on activation.
  void hostManager.ensureReady().catch((error: unknown) => {
    output.appendLine(`[dsh-vscode] startup error: ${String(error)}`)
  })
}

export function deactivate(): void {
  activeHostManager?.dispose()
  activeHostManager = undefined
}
