/** VS Code Activity Bar / Primary Sidebar WebviewViewProvider rendering DSH's left sidebar. */
import * as vscode from 'vscode'
import type { DshHostManager } from './host-manager.ts'
import type { ActiveTabState } from './protocol.ts'
import { BundleCache, WebviewBridge } from './webview-bridge.ts'
import {
  buildPackageAssetMap,
  buildWebviewHtml,
  localResourceRoots,
  type WebviewResourcePaths,
} from './webview-html.ts'

export interface SidebarNavigationHandler {
  openConversation(sessionId?: string, title?: string, workspaceId?: string): void
  openPanel(panelId: string, title?: string): void
}

export class DshSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'dsh.sidebar'

  private view: vscode.WebviewView | undefined
  private bridge: WebviewBridge | undefined

  constructor(
    private readonly hostManager: DshHostManager,
    private readonly bundleCache: BundleCache,
    private readonly resources: WebviewResourcePaths,
    private readonly navigation: SidebarNavigationHandler,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.bridge?.dispose()
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: localResourceRoots(this.resources),
    }

    const assetBaseMap = buildPackageAssetMap(webviewView.webview, this.resources.packagesDir)
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)

    this.bridge = new WebviewBridge(
      webviewView.webview,
      this.hostManager,
      this.bundleCache,
      { mode: 'sidebar', workspaceFolders },
      assetBaseMap,
      {
        onOpenConversation: (sessionId, title, workspaceId) => {
          this.navigation.openConversation(sessionId, title, workspaceId)
        },
        onOpenPanel: (panelId, title) => {
          this.navigation.openPanel(panelId, title)
        },
      },
    )

    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.resources)
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.bridge?.dispose()
        this.bridge = undefined
        this.view = undefined
      }
    })
  }

  notifyActiveTabChanged(state: ActiveTabState): void {
    this.bridge?.notifyActiveTabChanged(state)
  }

  reload(): void {
    if (this.view === undefined) return
    this.resolveWebviewView(this.view)
  }

  dispose(): void {
    this.bridge?.dispose()
    this.bridge = undefined
    this.view = undefined
  }
}
