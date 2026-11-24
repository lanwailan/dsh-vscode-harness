/**
 * Pre-Cordis VS Code Webview bootstrapper (`out/webview-boot.js`).
 *
 * Loaded synchronously ahead of `apps/web/dist/assets/index-*.js`:
 * 1. Holds `globalThis.__DSH_BOOT_READY__` until the Extension Host finishes starting DSH Host.
 * 2. Bridges HTTP (`fetch`), WebSockets (`createWebSocket`), dynamic plugin bundles (`loadBundle`),
 *    package assets (`resolveAsset`), and file uploads (`__DSH_FILE_UPLOAD__`) over `vscode.postMessage`.
 * 3. Exposes `globalThis.__DSH_VSCODE__` for `@deepseek-ai/dsh-vscode-ui-layout`.
 * 4. Executes the Host's structured index injection table and resolves `__DSH_BOOT_READY__`.
 */
import type {
  ActiveTabState,
  HostToWebviewMessage,
  IndexInjection,
  NavigateTarget,
  SurfaceConfig,
  WebviewToHostMessage,
} from '../protocol.ts'

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function encodeRequestBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>,
): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') {
    return bytesToBase64(new TextEncoder().encode(body))
  }
  if (body instanceof ArrayBuffer) {
    return bytesToBase64(new Uint8Array(body))
  }
  if (ArrayBuffer.isView(body)) {
    return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }
  if (body instanceof URLSearchParams) {
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    }
    return bytesToBase64(new TextEncoder().encode(body.toString()))
  }
  if (body instanceof Blob) {
    if (body.type && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = body.type
    }
    return bytesToBase64(new Uint8Array(await body.arrayBuffer()))
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // Serialize FormData through Response so the exact multipart boundary is preserved.
    const serialized = new Response(body)
    const contentType = serialized.headers.get('content-type')
    if (contentType !== null) headers['content-type'] = contentType
    return bytesToBase64(new Uint8Array(await serialized.arrayBuffer()))
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    const serialized = new Response(body)
    return bytesToBase64(new Uint8Array(await serialized.arrayBuffer()))
  }
  throw new Error(`dsh-vscode: unsupported fetch request body`)
}

type WsEventName = 'open' | 'message' | 'close' | 'error'
type WsListener = (event: unknown) => void

class ProxiedWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = ProxiedWebSocket.CONNECTING
  private readonly listeners = new Map<WsEventName, Set<{ fn: WsListener; once: boolean }>>()

  constructor(
    readonly wsId: number,
    private readonly post: (msg: WebviewToHostMessage) => void,
    private readonly onClosed: (wsId: number) => void,
  ) {}

  send(data: string): void {
    if (this.readyState !== ProxiedWebSocket.OPEN) return
    this.post({ type: 'ws-send', wsId: this.wsId, data })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === ProxiedWebSocket.CLOSING || this.readyState === ProxiedWebSocket.CLOSED) return
    this.readyState = ProxiedWebSocket.CLOSING
    this.post({
      type: 'ws-close',
      wsId: this.wsId,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    })
  }

  addEventListener(event: WsEventName, listener: WsListener, options?: { readonly once?: boolean }): void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add({ fn: listener, once: options?.once === true })
  }

  removeEventListener(event: WsEventName, listener: WsListener): void {
    const set = this.listeners.get(event)
    if (set === undefined) return
    for (const entry of set) {
      if (entry.fn === listener) set.delete(entry)
    }
  }

  dispatch(event: WsEventName, payload: unknown): void {
    if (event === 'open') this.readyState = ProxiedWebSocket.OPEN
    else if (event === 'close') {
      this.readyState = ProxiedWebSocket.CLOSED
      this.onClosed(this.wsId)
    }
    const set = this.listeners.get(event)
    if (set === undefined) return
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry)
      try {
        entry.fn(payload)
      } catch (error: unknown) {
        console.error('[dsh-vscode] ws listener error:', error)
      }
    }
  }
}

async function applyInjections(
  rows: readonly IndexInjection[],
  loadScript: (src: string) => Promise<void>,
): Promise<void> {
  for (const row of rows) {
    switch (row.kind) {
      case 'global':
        (globalThis as Record<string, unknown>)[row.name] = row.value
        break
      case 'script': {
        const el = document.createElement('script')
        el.textContent = row.text
        ;(row.placement === 'head' ? document.head : document.body).append(el)
        break
      }
      case 'script-src':
        await loadScript(row.src)
        break
      case 'script-preload':
        break
      case 'style': {
        const el = document.createElement('style')
        el.textContent = row.text
        document.head.append(el)
        break
      }
      case 'html':
        (row.placement === 'head' ? document.head : document.body).insertAdjacentHTML('beforeend', row.html)
        break
    }
  }
}

function bootstrap(): void {
  const bootReady = createDeferred<void>()
  ;(globalThis as { __DSH_BOOT_READY__?: Deferred<void> }).__DSH_BOOT_READY__ = bootReady
  void bootReady.promise.catch(() => {})

  const vscodeApi = acquireVsCodeApi()
  const originalFetch = globalThis.fetch.bind(globalThis)

  let nextId = 1
  let streamBaseUrl = ''
  let hostOrigin = ''
  let assetBaseMap: Readonly<Record<string, string>> = {}

  const pendingHttp = new Map<number, {
    resolve: (res: Response) => void
    reject: (err: Error) => void
  }>()
  const streamBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const pendingBundles = new Map<number, {
    resolve: (code: string) => void
    reject: (err: Error) => void
  }>()
  const sockets = new Map<number, ProxiedWebSocket>()
  const navigateListeners = new Set<(target: NavigateTarget) => void>()
  const activeTabListeners = new Set<(state: ActiveTabState) => void>()

  const isHostRelativeUrl = (raw: string): boolean => {
    if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('vscode-webview:') || raw.startsWith('vscode-resource:')) {
      return false
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return hostOrigin.length > 0 && raw.startsWith(hostOrigin)
    }
    if (raw.startsWith('./assets/') || raw.startsWith('assets/') || raw.startsWith('/assets/')) {
      return false
    }
    return true
  }

  const normalizeHostPath = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return input.url
  }

  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = normalizeHostPath(input)
    if (!isHostRelativeUrl(rawUrl)) {
      return originalFetch(input, init)
    }
    const signal = init?.signal
    if (signal?.aborted === true) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const id = nextId++
    const headers: Record<string, string> = {}
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => { headers[key] = value })
    } else if (input instanceof Request) {
      input.headers.forEach((value, key) => { headers[key] = value })
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const rawBody = init?.body ?? (input instanceof Request && method !== 'GET' && method !== 'HEAD'
      ? await input.clone().arrayBuffer()
      : undefined)
    const bodyBase64 = await encodeRequestBody(rawBody, headers)

    const promise = new Promise<Response>((resolve, reject) => {
      pendingHttp.set(id, { resolve, reject })
    })

    const onAbort = (): void => {
      pendingHttp.delete(id)
      const stream = streamBodies.get(id)
      if (stream !== undefined) {
        streamBodies.delete(id)
        try { stream.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* closed */ }
      }
      vscodeApi.postMessage({ type: 'http-abort', id })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    vscodeApi.postMessage({
      type: 'http-req',
      id,
      method,
      path: rawUrl,
      headers,
      ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
    })

    try {
      return await promise
    } finally {
      if (!streamBodies.has(id)) {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }

  const loadBundle = async (url: string): Promise<void> => {
    const id = nextId++
    const code = await new Promise<string>((resolve, reject) => {
      pendingBundles.set(id, { resolve, reject })
      vscodeApi.postMessage({ type: 'load-bundle', id, url })
    })
    const script = document.createElement('script')
    script.textContent = `${code}\n//# sourceURL=${url}`
    document.head.append(script)
    script.remove()
  }

  const resolveAsset = (reference: string): string => {
    const match = /^\/?plugins\/((?:@[^/]+\/)?[^/]+)\/assets\/(.+)$/.exec(reference)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const base = assetBaseMap[match[1]]
      if (base !== undefined) return `${base}/${match[2]}`
    }
    return reference
  }

  const createWebSocket = (url: string): ProxiedWebSocket => {
    const wsId = nextId++
    const socket = new ProxiedWebSocket(
      wsId,
      msg => { vscodeApi.postMessage(msg) },
      closedId => { sockets.delete(closedId) },
    )
    sockets.set(wsId, socket)
    vscodeApi.postMessage({ type: 'ws-open', wsId, url })
    return socket
  }

  const installSurfaceBridge = (surface: SurfaceConfig): void => {
    // Pre-seed the Editor Tab's initial session before ui-workspace restores localStorage.
    if (
      surface.mode === 'editor'
      && surface.initialTarget?.kind === 'conversation'
      && surface.initialTarget.sessionId !== undefined
    ) {
      try {
        localStorage.setItem(
          'dsh.sessions.current',
          JSON.stringify({ sessionId: surface.initialTarget.sessionId }),
        )
      } catch {
        // Ignore storage errors inside restricted webviews.
      }
    }

    ;(globalThis as Record<string, unknown>).__DSH_VSCODE__ = {
      surface,
      openConversation(sessionId?: string, title?: string, workspaceId?: string) {
        vscodeApi.postMessage({
          type: 'open-conversation',
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(title === undefined ? {} : { title }),
          ...(workspaceId === undefined ? {} : { workspaceId }),
        })
      },
      openPanel(panelId: string, title?: string) {
        vscodeApi.postMessage({
          type: 'open-panel',
          panelId,
          ...(title === undefined ? {} : { title }),
        })
      },
      setTabTitle(title: string) {
        vscodeApi.postMessage({ type: 'tab-title', title })
      },
      notifyActiveSession(sessionId: string | undefined, panelId: string | null) {
        vscodeApi.postMessage({
          type: 'active-session',
          ...(sessionId === undefined ? {} : { sessionId }),
          panelId,
        })
      },
      openFile(filePath: string, line?: number, column?: number) {
        vscodeApi.postMessage({
          type: 'open-file',
          filePath,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
        })
      },
      openExternal(url: string) {
        vscodeApi.postMessage({ type: 'open-external', url })
      },
      onNavigate(listener: (target: NavigateTarget) => void) {
        navigateListeners.add(listener)
        return () => { navigateListeners.delete(listener) }
      },
      onActiveTabChanged(listener: (state: ActiveTabState) => void) {
        activeTabListeners.add(listener)
        return () => { activeTabListeners.delete(listener) }
      },
    }
  }

  window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
    const msg = event.data
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) return
    switch (msg.type) {
      case 'host-boot': {
        streamBaseUrl = msg.streamBaseUrl
        hostOrigin = new URL(msg.streamBaseUrl).origin
        assetBaseMap = msg.assetBaseMap

        installSurfaceBridge(msg.surface)

        ;(globalThis as Record<string, unknown>).__DSH_TRANSPORT__ = {
          fetch: proxyFetch,
          createWebSocket,
          loadBundle,
          resolveAsset,
          ownsHost: true,
          streamBaseUrl,
        }
        ;(globalThis as Record<string, unknown>).__DSH_FILE_UPLOAD__ = {
          fetch: proxyFetch,
        }
        // Intercept relative host fetches in official client plugins (deliverables, file-actions, open-in-app).
        globalThis.fetch = proxyFetch as typeof globalThis.fetch

        void (async () => {
          if (document.body === null) {
            await new Promise<void>((resolve) => {
              document.addEventListener('DOMContentLoaded', () => { resolve() }, { once: true })
            })
          }
          await applyInjections(msg.injections, loadBundle)
        })()
          .then(() => { bootReady.resolve() })
          .catch((error: unknown) => { bootReady.reject(error) })
        return
      }
      case 'host-boot-error': {
        bootReady.reject(new Error(msg.message))
        const root = document.getElementById('root')
        if (root !== null && root.childElementCount === 0) {
          root.innerHTML = `<div style="padding:16px;font-family:var(--vscode-font-family,sans-serif);color:var(--vscode-errorForeground,#f48771)">
            <strong>DeepSeek Harness failed to start</strong>
            <pre style="white-space:pre-wrap;margin-top:8px;font-size:12px;opacity:0.9"></pre>
          </div>`
          const pre = root.querySelector('pre')
          if (pre !== null) pre.textContent = msg.message
        }
        return
      }
      case 'http-res': {
        const pending = pendingHttp.get(msg.id)
        if (pending === undefined) return
        pendingHttp.delete(msg.id)
        const body = NULL_BODY_STATUS.has(msg.status)
          ? null
          : msg.bodyBase64 === undefined ? new Uint8Array(0) : base64ToBytes(msg.bodyBase64)
        pending.resolve(new Response(body, { status: msg.status, headers: msg.headers }))
        return
      }
      case 'http-res-head': {
        const pending = pendingHttp.get(msg.id)
        if (pending === undefined) return
        pendingHttp.delete(msg.id)
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamBodies.set(msg.id, controller)
          },
          cancel() {
            streamBodies.delete(msg.id)
            vscodeApi.postMessage({ type: 'http-abort', id: msg.id })
          },
        })
        pending.resolve(new Response(stream, { status: msg.status, headers: msg.headers }))
        return
      }
      case 'http-res-chunk': {
        streamBodies.get(msg.id)?.enqueue(base64ToBytes(msg.chunkBase64))
        return
      }
      case 'http-res-end': {
        const controller = streamBodies.get(msg.id)
        if (controller !== undefined) {
          streamBodies.delete(msg.id)
          try { controller.close() } catch { /* already closed */ }
        }
        return
      }
      case 'http-res-err': {
        const error = new Error(msg.message)
        const pending = pendingHttp.get(msg.id)
        if (pending !== undefined) {
          pendingHttp.delete(msg.id)
          pending.reject(error)
          return
        }
        const controller = streamBodies.get(msg.id)
        if (controller !== undefined) {
          streamBodies.delete(msg.id)
          try { controller.error(error) } catch { /* already closed */ }
        }
        return
      }
      case 'load-bundle-res': {
        const pending = pendingBundles.get(msg.id)
        if (pending !== undefined) {
          pendingBundles.delete(msg.id)
          pending.resolve(msg.code)
        }
        return
      }
      case 'load-bundle-err': {
        const pending = pendingBundles.get(msg.id)
        if (pending !== undefined) {
          pendingBundles.delete(msg.id)
          pending.reject(new Error(msg.message))
        }
        return
      }
      case 'ws-open': {
        sockets.get(msg.wsId)?.dispatch('open', {})
        return
      }
      case 'ws-message': {
        sockets.get(msg.wsId)?.dispatch('message', { data: msg.data })
        return
      }
      case 'ws-close': {
        sockets.get(msg.wsId)?.dispatch('close', { code: msg.code, reason: msg.reason })
        return
      }
      case 'ws-error': {
        sockets.get(msg.wsId)?.dispatch('error', { message: msg.message })
        return
      }
      case 'navigate': {
        for (const listener of [...navigateListeners]) listener(msg.target)
        return
      }
      case 'active-tab-changed': {
        for (const listener of [...activeTabListeners]) listener(msg.state)
        return
      }
    }
  })

  vscodeApi.postMessage({ type: 'webview-ready' })
}

bootstrap()
