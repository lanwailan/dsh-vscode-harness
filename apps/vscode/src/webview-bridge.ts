/**
 * Attaches the `postMessage` <-> local DSH Host transport & IDE action bridge to one VS Code Webview.
 *
 * Security model:
 * - The Host auth cookie (`dsh-desktop-session=<secret>`) stays strictly inside Node (Extension Host)
 *   and is never exposed to Webview scripts.
 * - Every proxied HTTP/Bundle/WebSocket request is pinned to the local DSH Host origin (`127.0.0.1:<port>`).
 */
import * as vscode from 'vscode'
import WebSocket, { type RawData } from 'ws'
import type { DshHostManager, ReadyHost } from './host-manager.ts'
import type {
  ActiveTabState,
  HostToWebviewMessage,
  NavigateTarget,
  SurfaceConfig,
  WebviewToHostMessage,
} from './protocol.ts'

export interface WebviewBridgeCallbacks {
  readonly onOpenConversation?: (sessionId?: string, title?: string, workspaceId?: string) => void
  readonly onOpenPanel?: (panelId: string, title?: string) => void
  readonly onCloseTab?: () => void
  readonly onTabTitle?: (title: string) => void
  readonly onActiveSession?: (sessionId: string | undefined, panelId: string | null) => void
}

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'cookie',
  'content-length',
  'connection',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
])

const SKIP_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-encoding',
  'content-length',
])

/** Shared in-memory cache of revisioned client plugin bundles across all sidebar + editor Webviews. */
export class BundleCache {
  private readonly cache = new Map<string, string>()

  get(key: string): string | undefined {
    return this.cache.get(key)
  }

  set(key: string, code: string): void {
    if (this.cache.size > 400) this.cache.clear()
    this.cache.set(key, code)
  }

  clear(): void {
    this.cache.clear()
  }
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

export class WebviewBridge implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly inFlightHttp = new Map<number, AbortController>()
  private readonly sockets = new Map<number, WebSocket>()
  private disposed = false

  constructor(
    private readonly webview: vscode.Webview,
    private readonly hostManager: DshHostManager,
    private readonly bundleCache: BundleCache,
    private readonly surface: SurfaceConfig,
    private readonly assetBaseMap: Readonly<Record<string, string>>,
    private readonly callbacks: WebviewBridgeCallbacks = {},
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        if (this.disposed || typeof raw !== 'object' || raw === null || !('type' in raw)) return
        void this.handleMessage(raw as WebviewToHostMessage)
      }),
    )
  }

  post(message: HostToWebviewMessage): void {
    if (this.disposed) return
    void this.webview.postMessage(message)
  }

  navigate(target: NavigateTarget): void {
    this.post({ type: 'navigate', target })
  }

  notifyActiveTabChanged(state: ActiveTabState): void {
    this.post({ type: 'active-tab-changed', state })
  }

  private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'webview-ready': {
        try {
          const host = await this.hostManager.ensureReady()
          this.post({
            type: 'host-boot',
            injections: host.injections,
            streamBaseUrl: host.url,
            surface: this.surface,
            assetBaseMap: this.assetBaseMap,
          })
        } catch (error: unknown) {
          this.post({
            type: 'host-boot-error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }
      case 'http-req': {
        await this.proxyHttpRequest(msg)
        return
      }
      case 'http-abort': {
        const controller = this.inFlightHttp.get(msg.id)
        if (controller !== undefined) {
          controller.abort()
          this.inFlightHttp.delete(msg.id)
        }
        return
      }
      case 'load-bundle': {
        await this.proxyBundle(msg.id, msg.url)
        return
      }
      case 'ws-open': {
        await this.openWebSocket(msg.wsId, msg.url)
        return
      }
      case 'ws-send': {
        const socket = this.sockets.get(msg.wsId)
        if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
          socket.send(msg.data)
        }
        return
      }
      case 'ws-close': {
        const socket = this.sockets.get(msg.wsId)
        if (socket !== undefined) {
          this.sockets.delete(msg.wsId)
          try {
            socket.close(msg.code, msg.reason)
          } catch {
            socket.terminate()
          }
        }
        return
      }
      case 'open-conversation': {
        this.callbacks.onOpenConversation?.(msg.sessionId, msg.title, msg.workspaceId)
        return
      }
      case 'open-panel': {
        this.callbacks.onOpenPanel?.(msg.panelId, msg.title)
        return
      }
      case 'close-tab': {
        this.callbacks.onCloseTab?.()
        return
      }
      case 'tab-title': {
        this.callbacks.onTabTitle?.(msg.title)
        return
      }
      case 'active-session': {
        this.callbacks.onActiveSession?.(msg.sessionId, msg.panelId)
        return
      }
      case 'open-file': {
        await this.openFileInEditor(msg.filePath, msg.line, msg.column)
        return
      }
      case 'open-external': {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url))
        } catch {
          // Ignore malformed external URLs.
        }
        return
      }
    }
  }

  private resolveHostUrl(rawPath: string, host: ReadyHost): URL {
    const normalized = rawPath.startsWith('http://') || rawPath.startsWith('https://')
      ? rawPath
      : rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const target = new URL(normalized, host.url)
    if (target.origin !== host.origin) {
      throw new Error(`Refused cross-origin proxy request to ${target.origin}`)
    }
    return target
  }

  private async proxyHttpRequest(msg: Extract<WebviewToHostMessage, { type: 'http-req' }>): Promise<void> {
    const controller = new AbortController()
    this.inFlightHttp.set(msg.id, controller)
    try {
      const host = await this.hostManager.ensureReady()
      const target = this.resolveHostUrl(msg.path, host)
      const headers = new Headers()
      for (const [key, value] of Object.entries(msg.headers)) {
        if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
      }
      headers.set('cookie', `dsh-desktop-session=${host.secret}`)
      const body = msg.bodyBase64 === undefined ? undefined : Buffer.from(msg.bodyBase64, 'base64')
      const response = await fetch(target, {
        method: msg.method,
        headers,
        body,
        signal: controller.signal,
      })

      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value
      })

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      const isStream = contentType.includes('text/event-stream')
        || contentType.includes('application/x-ndjson')

      if (isStream && response.body !== null) {
        this.post({
          type: 'http-res-head',
          id: msg.id,
          status: response.status,
          headers: responseHeaders,
        })
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (this.disposed) {
            await reader.cancel()
            break
          }
          this.post({
            type: 'http-res-chunk',
            id: msg.id,
            chunkBase64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
          })
        }
        this.post({ type: 'http-res-end', id: msg.id })
        return
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      this.post({
        type: 'http-res',
        id: msg.id,
        status: response.status,
        headers: responseHeaders,
        ...(buffer.length > 0 ? { bodyBase64: buffer.toString('base64') } : {}),
      })
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        this.post({
          type: 'http-res-err',
          id: msg.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      this.inFlightHttp.delete(msg.id)
    }
  }

  private async proxyBundle(id: number, rawUrl: string): Promise<void> {
    try {
      const host = await this.hostManager.ensureReady()
      const target = this.resolveHostUrl(rawUrl, host)
      const cacheKey = `${host.origin}${target.pathname}${target.search}`
      const cached = this.bundleCache.get(cacheKey)
      if (cached !== undefined) {
        this.post({ type: 'load-bundle-res', id, code: cached })
        return
      }
      const response = await fetch(target, {
        headers: { cookie: `dsh-desktop-session=${host.secret}` },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)} loading bundle ${rawUrl}`)
      }
      const code = await response.text()
      if (target.searchParams.has('rev')) this.bundleCache.set(cacheKey, code)
      this.post({ type: 'load-bundle-res', id, code })
    } catch (error: unknown) {
      this.post({
        type: 'load-bundle-err',
        id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async openWebSocket(wsId: number, rawUrl: string): Promise<void> {
    try {
      const host = await this.hostManager.ensureReady()
      const hostUrl = new URL(host.url)
      const target = rawUrl.startsWith('ws://') || rawUrl.startsWith('wss://')
        ? new URL(rawUrl)
        : new URL(rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`, host.url)
      if (target.host !== hostUrl.host) {
        throw new Error(`Refused cross-origin WebSocket connection to ${target.host}`)
      }
      target.protocol = hostUrl.protocol === 'https:' ? 'wss:' : 'ws:'

      const socket = new WebSocket(target.href, {
        headers: {
          cookie: `dsh-desktop-session=${host.secret}`,
          origin: host.origin,
        },
      })
      this.sockets.set(wsId, socket)

      socket.on('open', () => {
        this.post({ type: 'ws-open', wsId })
      })
      socket.on('message', (data) => {
        this.post({ type: 'ws-message', wsId, data: rawDataToText(data) })
      })
      socket.on('close', (code, reason) => {
        this.sockets.delete(wsId)
        this.post({ type: 'ws-close', wsId, code, reason: reason.toString('utf8') })
      })
      socket.on('error', (error) => {
        this.post({ type: 'ws-error', wsId, message: error.message })
      })
    } catch (error: unknown) {
      this.post({
        type: 'ws-error',
        wsId,
        message: error instanceof Error ? error.message : String(error),
      })
      this.post({ type: 'ws-close', wsId, code: 1006, reason: 'connection failed' })
    }
  }

  private async openFileInEditor(filePath: string, line?: number, column?: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
      const selection = line !== undefined
        ? new vscode.Range(
            Math.max(0, line - 1),
            Math.max(0, (column ?? 1) - 1),
            Math.max(0, line - 1),
            Math.max(0, (column ?? 1) - 1),
          )
        : undefined
      await vscode.window.showTextDocument(doc, {
        preview: false,
        ...(selection === undefined ? {} : { selection }),
      })
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`Unable to open file ${filePath}: ${String(error)}`)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.inFlightHttp.values()) controller.abort()
    this.inFlightHttp.clear()
    for (const socket of this.sockets.values()) {
      try { socket.close() } catch { socket.terminate() }
    }
    this.sockets.clear()
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
  }
}
