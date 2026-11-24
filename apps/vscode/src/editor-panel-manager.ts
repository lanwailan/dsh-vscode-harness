/**
 * Manages VS Code Editor Tab `WebviewPanel`s for DSH Conversations and Global Panels
 * (Plugins, Schedules, Settings, etc.).
 *
 * - Clicking a session in the Sidebar opens a new VS Code Editor Tab (or focuses its existing tab).
 * - Multiple conversations can stay open side-by-side in separate VS Code Editor Tabs while
 *   sharing the same local DSH Host and `$DSH_HOME`.
 */
import * as vscode from 'vscode'
import { join } from 'node:path'
import type { DshHostManager } from './host-manager.ts'
import type { ActiveTabState, NavigateTarget } from './protocol.ts'
import type { ExtensionRuntimePaths } from './runtime-paths.ts'
import { BundleCache, WebviewBridge } from './webview-bridge.ts'
import {
  buildPackageAssetMap,
  buildWebviewHtml,
  localResourceRoots,
} from './webview-html.ts'

interface TrackedTab {
  readonly panel: vscode.WebviewPanel
  readonly bridge: WebviewBridge
  kind: 'conversation' | 'panel'
  sessionId: string | undefined
  panelId: string | null
}

export class DshEditorPanelManager implements vscode.Disposable {
  private readonly tabs = new Set<TrackedTab>()
  private readonly iconPath: vscode.Uri

  constructor(
    private readonly extensionPath: string,
    private readonly hostManager: DshHostManager,
    private readonly bundleCache: BundleCache,
    private readonly resources: ExtensionRuntimePaths,
    private readonly onActiveTabChanged: (state: ActiveTabState) => void,
  ) {
    this.iconPath = vscode.Uri.file(join(this.extensionPath, 'media', 'whale.svg'))
  }

  openConversation(sessionId?: string, title?: string, workspaceId?: string): void {
    if (sessionId !== undefined) {
      for (const tab of this.tabs) {
        if (tab.kind === 'conversation' && tab.sessionId === sessionId) {
          tab.panel.reveal(tab.panel.viewColumn ?? vscode.ViewColumn.Active)
          return
        }
      }
    }

    const displayTitle = title?.trim() ? title.trim() : 'DeepSeek Chat'
    const target: NavigateTarget = {
      kind: 'conversation',
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      title: displayTitle,
    }
    this.createTab(target, displayTitle)
  }

  openPanel(panelId: string, title?: string): void {
    for (const tab of this.tabs) {
      if (tab.kind === 'panel' && tab.panelId === panelId) {
        tab.panel.reveal(tab.panel.viewColumn ?? vscode.ViewColumn.Active)
        return
      }
    }
    const displayTitle = title?.trim() ? title.trim() : panelId
    this.createTab({ kind: 'panel', panelId, title: displayTitle }, displayTitle)
  }

  reloadAll(): void {
    for (const tab of this.tabs) {
      tab.panel.webview.html = buildWebviewHtml(tab.panel.webview, this.resources)
    }
  }

  private createTab(target: NavigateTarget, initialTitle: string): void {
    const viewType = target.kind === 'panel' ? `dsh.panel.${target.panelId ?? 'panel'}` : 'dsh.conversation'
    const panel = vscode.window.createWebviewPanel(
      viewType,
      initialTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: localResourceRoots(this.resources),
      },
    )
    panel.iconPath = this.iconPath

    const assetBaseMap = buildPackageAssetMap(panel.webview, this.resources)
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)

    const tracked: TrackedTab = {
      panel,
      bridge: undefined as unknown as WebviewBridge,
      kind: target.kind,
      sessionId: target.sessionId,
      panelId: target.kind === 'panel' ? (target.panelId ?? null) : null,
    }

    const bridge = new WebviewBridge(
      panel.webview,
      this.hostManager,
      this.bundleCache,
      {
        mode: 'editor',
        initialTarget: target,
        workspaceFolders,
      },
      assetBaseMap,
      {
        onOpenConversation: (sessionId, title, workspaceId) => {
          this.openConversation(sessionId, title, workspaceId)
        },
        onOpenPanel: (panelId, title) => {
          this.openPanel(panelId, title)
        },
        onCloseTab: () => {
          panel.dispose()
        },
        onTabTitle: (title) => {
          const clean = title.trim()
          if (clean.length > 0 && panel.title !== clean) panel.title = clean
        },
        onActiveSession: (sessionId, panelId) => {
          tracked.sessionId = sessionId
          tracked.panelId = panelId
          tracked.kind = panelId === null ? 'conversation' : 'panel'
          if (panel.active) {
            this.onActiveTabChanged({ sessionId, panelId })
          }
        },
      },
    )
    ;(tracked as { bridge: WebviewBridge }).bridge = bridge
    this.tabs.add(tracked)

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this.onActiveTabChanged({
          sessionId: tracked.sessionId,
          panelId: tracked.panelId,
        })
      }
    })

    panel.onDidDispose(() => {
      this.tabs.delete(tracked)
      bridge.dispose()
    })

    panel.webview.html = buildWebviewHtml(panel.webview, this.resources)
  }

  dispose(): void {
    for (const tab of [...this.tabs]) {
      tab.bridge.dispose()
      tab.panel.dispose()
    }
    this.tabs.clear()
  }
}
