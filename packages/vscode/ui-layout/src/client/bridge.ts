/** Typed contract for the pre-Cordis VS Code Webview bridge on `globalThis.__DSH_VSCODE__`. */

export type VsCodeSurfaceMode = 'sidebar' | 'editor'

export interface VsCodeNavigateTarget {
  readonly kind: 'conversation' | 'panel'
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly panelId?: string
  readonly title?: string
}

export interface VsCodeSurfaceState {
  readonly mode: VsCodeSurfaceMode
  readonly initialTarget?: VsCodeNavigateTarget
  readonly workspaceFolders: readonly string[]
}

export interface VsCodeActiveTabState {
  readonly sessionId?: string
  readonly panelId?: string | null
}

export interface VsCodeBridge {
  readonly surface: VsCodeSurfaceState
  openConversation(sessionId?: string, title?: string, workspaceId?: string): void
  openPanel(panelId: string, title?: string): void
  closeTab(): void
  setTabTitle(title: string): void
  notifyActiveSession(sessionId: string | undefined, panelId: string | null): void
  openFile(filePath: string, line?: number, column?: number): void
  openExternal(url: string): void
  onNavigate(listener: (target: VsCodeNavigateTarget) => void): () => void
  onActiveTabChanged(listener: (state: VsCodeActiveTabState) => void): () => void
}

interface VsCodeBridgeGlobal {
  __DSH_VSCODE__?: VsCodeBridge
}

/** Read the VS Code Webview bridge when mounted inside VS Code; undefined in plain browsers. */
export function getVsCodeBridge(): VsCodeBridge | undefined {
  return (globalThis as VsCodeBridgeGlobal).__DSH_VSCODE__
}
