/** Shared typed message protocol between VS Code Extension Host and Webviews. */

export type SurfaceMode = 'sidebar' | 'editor'

export interface NavigateTarget {
  readonly kind: 'conversation' | 'panel'
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly panelId?: string
  readonly title?: string
}

export interface SurfaceConfig {
  readonly mode: SurfaceMode
  readonly initialTarget?: NavigateTarget
  readonly workspaceFolders: readonly string[]
}

export interface ActiveTabState {
  readonly sessionId?: string
  readonly panelId?: string | null
}

/** Structured index injection row mirroring `@deepseek-ai/dsh-host-webserver`. */
export type IndexInjection =
  | { readonly kind: 'global'; readonly name: string; readonly value: unknown }
  | { readonly kind: 'script'; readonly placement: 'head' | 'body'; readonly text: string }
  | { readonly kind: 'script-src'; readonly placement: 'head' | 'body'; readonly src: string }
  | { readonly kind: 'script-preload'; readonly src: string }
  | { readonly kind: 'style'; readonly text: string }
  | { readonly kind: 'html'; readonly placement: 'head' | 'body'; readonly html: string }

/** Messages sent FROM Webview TO Extension Host. */
export type WebviewToHostMessage =
  | { readonly type: 'webview-ready' }
  | {
      readonly type: 'http-req'
      readonly id: number
      readonly method: string
      readonly path: string
      readonly headers: Readonly<Record<string, string>>
      readonly bodyBase64?: string
    }
  | { readonly type: 'http-abort'; readonly id: number }
  | { readonly type: 'load-bundle'; readonly id: number; readonly url: string }
  | { readonly type: 'ws-open'; readonly wsId: number; readonly url: string }
  | { readonly type: 'ws-send'; readonly wsId: number; readonly data: string }
  | { readonly type: 'ws-close'; readonly wsId: number; readonly code?: number; readonly reason?: string }
  | { readonly type: 'open-conversation'; readonly sessionId?: string; readonly title?: string; readonly workspaceId?: string }
  | { readonly type: 'open-panel'; readonly panelId: string; readonly title?: string }
  | { readonly type: 'close-tab' }
  | { readonly type: 'tab-title'; readonly title: string }
  | { readonly type: 'active-session'; readonly sessionId?: string; readonly panelId: string | null }
  | { readonly type: 'open-file'; readonly filePath: string; readonly line?: number; readonly column?: number }
  | { readonly type: 'open-external'; readonly url: string }

/** Messages sent FROM Extension Host TO Webview. */
export type HostToWebviewMessage =
  | {
      readonly type: 'host-boot'
      readonly injections: readonly IndexInjection[]
      readonly streamBaseUrl: string
      readonly surface: SurfaceConfig
      readonly assetBaseMap: Readonly<Record<string, string>>
    }
  | { readonly type: 'host-boot-error'; readonly message: string }
  | {
      readonly type: 'http-res'
      readonly id: number
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      readonly bodyBase64?: string
    }
  | {
      readonly type: 'http-res-head'
      readonly id: number
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
    }
  | { readonly type: 'http-res-chunk'; readonly id: number; readonly chunkBase64: string }
  | { readonly type: 'http-res-end'; readonly id: number }
  | { readonly type: 'http-res-err'; readonly id: number; readonly message: string }
  | { readonly type: 'load-bundle-res'; readonly id: number; readonly code: string }
  | { readonly type: 'load-bundle-err'; readonly id: number; readonly message: string }
  | { readonly type: 'ws-open'; readonly wsId: number }
  | { readonly type: 'ws-message'; readonly wsId: number; readonly data: string }
  | { readonly type: 'ws-close'; readonly wsId: number; readonly code: number; readonly reason: string }
  | { readonly type: 'ws-error'; readonly wsId: number; readonly message: string }
  | { readonly type: 'navigate'; readonly target: NavigateTarget }
  | { readonly type: 'active-tab-changed'; readonly state: ActiveTabState }
