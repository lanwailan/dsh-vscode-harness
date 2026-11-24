/**
 * Manages the single local `apps/vscode-host` Node child process for this VS Code window.
 * Shares the user's `$DSH_HOME` (`~/.dsh` by default) with CLI and Desktop.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { IndexInjection } from './protocol.ts'
import type { ExtensionRuntimePaths } from './runtime-paths.ts'

export interface ReadyHost {
  readonly url: string
  readonly origin: string
  readonly secret: string
  readonly injections: readonly IndexInjection[]
  readonly homeDir: string
  readonly workspaceIds: Readonly<Record<string, string>>
}

interface NodeCandidate {
  readonly command: string
  readonly env?: Readonly<Record<string, string>>
}

function parseNodeMajorMinor(versionText: string): [number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(versionText.trim())
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)]
}

function isSupportedNodeVersion(versionText: string): boolean {
  const parsed = parseNodeMajorMinor(versionText)
  if (parsed === undefined) return false
  const [major, minor] = parsed
  return major > 22 || (major === 22 && minor >= 19)
}

function probeNodeVersion(command: string, extraEnv?: Readonly<Record<string, string>>): string | undefined {
  try {
    return execFileSync(command, ['-v'], {
      timeout: 3_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    }).trim()
  } catch {
    return undefined
  }
}

function discoverWindowsNodes(): string[] {
  if (process.platform !== 'win32') return []
  const found: string[] = []
  try {
    const output = execFileSync('where.exe', ['node'], {
      timeout: 3_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim()
      if (candidate.length > 0 && existsSync(candidate)) found.push(candidate)
    }
  } catch {
    // Fall through to common Windows installation paths.
  }

  const knownPaths = [
    process.env.NVM_SYMLINK ? join(process.env.NVM_SYMLINK, 'node.exe') : undefined,
    process.env.FNM_MULTISHELL_PATH ? join(process.env.FNM_MULTISHELL_PATH, 'node.exe') : undefined,
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : undefined,
    join(homedir(), '.volta', 'bin', 'node.exe'),
    join(homedir(), 'scoop', 'shims', 'node.exe'),
  ].filter((item): item is string => typeof item === 'string' && existsSync(item))
  found.push(...knownPaths)

  const nvmHome = process.env.NVM_HOME || (process.env.APPDATA ? join(process.env.APPDATA, 'nvm') : undefined)
  if (nvmHome !== undefined && existsSync(nvmHome)) {
    try {
      const nvmNodes = readdirSync(nvmHome)
        .filter(entry => /^v?\d+\./.test(entry))
        .sort()
        .reverse()
        .map(entry => join(nvmHome, entry, 'node.exe'))
        .filter(candidate => existsSync(candidate))
      found.push(...nvmNodes)
    } catch {
      // Ignore unreadable nvm-windows directories.
    }
  }

  found.push('node.exe')
  return found
}

function probeLoginShellNode(): string | undefined {
  if (process.platform === 'win32') return undefined
  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(
    (item): item is string => typeof item === 'string' && item.length > 0 && existsSync(item),
  )
  for (const shell of shells) {
    try {
      const output = execFileSync(shell, ['-ilc', 'command -v node'], {
        timeout: 4_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          DISABLE_AUTO_UPDATE: 'true',
          ZSH_TMUX_AUTOSTARTED: 'true',
          ZSH_TMUX_AUTOSTART: 'false',
        },
      })
      const candidate = output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith('/') && existsSync(line))
        .pop()
      if (candidate !== undefined) return candidate
    } catch {
      // Try the next shell candidate.
    }
  }
  return undefined
}

function discoverNvmNodes(): string[] {
  const nvmDir = process.env.NVM_DIR || join(homedir(), '.nvm')
  const versionsDir = join(nvmDir, 'versions', 'node')
  if (!existsSync(versionsDir)) return []
  try {
    return readdirSync(versionsDir)
      .sort()
      .reverse()
      .map(ver => join(versionsDir, ver, 'bin', 'node'))
      .filter(candidate => existsSync(candidate))
  } catch {
    return []
  }
}

function resolveNodeExecutable(configuredPath: string, log: (line: string) => void): NodeCandidate {
  const candidates: string[] = []
  if (configuredPath.trim().length > 0) candidates.push(configuredPath.trim())
  if (process.env.DSH_NODE_PATH) candidates.push(process.env.DSH_NODE_PATH)
  if (process.platform === 'win32') {
    candidates.push(...discoverWindowsNodes())
  } else {
    const shellNode = probeLoginShellNode()
    if (shellNode !== undefined) candidates.push(shellNode)
    if (process.platform === 'darwin') {
      candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node')
    } else if (process.platform === 'linux') {
      candidates.push('/usr/local/bin/node', '/usr/bin/node')
    }
    candidates.push(...discoverNvmNodes())
  }
  candidates.push('node')

  const seen = new Set<string>()
  for (const command of candidates) {
    if (seen.has(command)) continue
    seen.add(command)
    const version = probeNodeVersion(command)
    if (version !== undefined && isSupportedNodeVersion(version)) {
      log(`Using Node.js ${version} at ${command}`)
      return { command }
    }
  }

  // Fallback to VS Code's Electron binary in Node mode if its Node version is recent enough.
  const electronNodeVersion = probeNodeVersion(process.execPath, { ELECTRON_RUN_AS_NODE: '1' })
  if (electronNodeVersion !== undefined && isSupportedNodeVersion(electronNodeVersion)) {
    log(`Falling back to Electron Node mode (${electronNodeVersion}) at ${process.execPath}`)
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }

  throw new Error(
    'DeepSeek Harness requires Node.js >= 22.19 (recommended >= 24). '
    + 'Install Node.js or set "dsh.nodePath" in VS Code settings.',
  )
}

export class DshHostManager implements vscode.Disposable {
  private child: ChildProcess | undefined
  private readyPromise: Promise<ReadyHost> | undefined
  private readyHost: ReadyHost | undefined
  private nextRequestId = 1
  private readonly pendingWorkspaces = new Map<number, {
    resolve: (ids: Record<string, string>) => void
    reject: (error: Error) => void
  }>()
  private disposed = false

  constructor(
    private readonly runtimePaths: ExtensionRuntimePaths,
    private readonly output: vscode.OutputChannel,
  ) {}

  get current(): ReadyHost | undefined {
    return this.readyHost
  }

  private log(line: string): void {
    this.output.appendLine(`[dsh-host] ${line}`)
  }

  ensureReady(): Promise<ReadyHost> {
    if (this.disposed) {
      return Promise.reject(new Error('DeepSeek Harness extension is disposed'))
    }
    if (this.readyPromise !== undefined) return this.readyPromise
    this.readyPromise = this.start().catch((error: unknown) => {
      this.readyPromise = undefined
      this.readyHost = undefined
      throw error
    })
    return this.readyPromise
  }

  async restart(): Promise<ReadyHost> {
    this.log('Restarting local DeepSeek Harness Host...')
    await this.stopChild()
    this.readyPromise = undefined
    this.readyHost = undefined
    return this.ensureReady()
  }

  async ensureWorkspaces(paths: readonly string[]): Promise<Record<string, string>> {
    if (paths.length === 0) return {}
    await this.ensureReady()
    const child = this.child
    if (child === undefined || !child.connected) return {}
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkspaces.delete(requestId)
        reject(new Error('Timed out registering VS Code workspace folders with DSH Host'))
      }, 15_000)
      this.pendingWorkspaces.set(requestId, {
        resolve: (ids) => { clearTimeout(timer); resolve(ids) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      child.send({ type: 'ensure-workspaces', requestId, paths })
    })
  }

  private start(): Promise<ReadyHost> {
    const config = vscode.workspace.getConfiguration('dsh')
    const configuredNode = config.get<string>('nodePath', '')
    const configuredHome = config.get<string>('home', '').trim()
    const autoSyncWorkspace = config.get<boolean>('autoSyncWorkspace', true)

    const hostEntry = this.runtimePaths.hostEntry
    if (!existsSync(hostEntry)) {
      return Promise.reject(new Error(
        this.runtimePaths.packaged
          ? `Packaged DeepSeek Harness Host not found at ${hostEntry}. Try reinstalling the extension.`
          : `Built host entry not found at ${hostEntry}. Run "pnpm run build:artifacts" first.`,
      ))
    }

    const node = resolveNodeExecutable(configuredNode, line => { this.log(line) })
    const secret = randomBytes(32).toString('base64url')
    const workspacePaths = autoSyncWorkspace
      ? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
      : []

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...node.env,
      ...(configuredHome.length > 0 ? { DSH_HOME: configuredHome } : {}),
    }

    this.log(`Spawning ${hostEntry}${configuredHome.length > 0 ? ` (DSH_HOME=${configuredHome})` : ' (sharing default ~/.dsh)'}`)

    const child = spawn(node.command, [hostEntry], {
      cwd: workspacePaths[0] ?? homedir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    this.child = child

    const stderrTail: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => {
      this.output.append(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.output.append(text)
      stderrTail.push(text)
      if (stderrTail.length > 40) stderrTail.shift()
    })

    return new Promise<ReadyHost>((resolveReady, rejectReady) => {
      let settled = false
      const settleReject = (error: Error): void => {
        if (settled) return
        settled = true
        rejectReady(error)
      }
      const settleResolve = (host: ReadyHost): void => {
        if (settled) return
        settled = true
        this.readyHost = host
        resolveReady(host)
      }

      const startupTimer = setTimeout(() => {
        settleReject(new Error('DeepSeek Harness Host timed out during startup (60s). Check the "DeepSeek Harness" Output channel.'))
        void this.stopChild()
      }, 60_000)

      child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('type' in message)) return
        const record = message as Record<string, unknown>
        if (record.type === 'starting') {
          child.send({ type: 'auth', secret, workspacePaths })
          return
        }
        if (record.type === 'ready' && typeof record.url === 'string' && Array.isArray(record.injections)) {
          clearTimeout(startupTimer)
          const url = record.url
          const origin = new URL(url).origin
          const homeDir = typeof record.homeDir === 'string' ? record.homeDir : ''
          const workspaceIds = (typeof record.workspaceIds === 'object' && record.workspaceIds !== null
            ? record.workspaceIds as Record<string, string>
            : {})
          this.log(`Host ready at ${url} (DSH_HOME=${homeDir})`)
          settleResolve({
            url,
            origin,
            secret,
            injections: record.injections as IndexInjection[],
            homeDir,
            workspaceIds,
          })
          return
        }
        if (record.type === 'fatal') {
          clearTimeout(startupTimer)
          const msg = typeof record.message === 'string' ? record.message : 'Host startup failed'
          this.log(`Fatal error: ${msg}`)
          settleReject(new Error(msg))
          return
        }
        if (record.type === 'ensure-workspaces-result' && typeof record.requestId === 'number') {
          const pending = this.pendingWorkspaces.get(record.requestId)
          if (pending === undefined) return
          this.pendingWorkspaces.delete(record.requestId)
          if (typeof record.error === 'string') pending.reject(new Error(record.error))
          else pending.resolve((record.workspaceIds as Record<string, string>) ?? {})
        }
      })

      child.once('error', (error) => {
        clearTimeout(startupTimer)
        this.log(`Process error: ${error.message}`)
        settleReject(error)
      })

      child.once('exit', (code, signal) => {
        clearTimeout(startupTimer)
        if (this.child === child) {
          this.child = undefined
          this.readyHost = undefined
          this.readyPromise = undefined
        }
        for (const pending of this.pendingWorkspaces.values()) {
          pending.reject(new Error('DeepSeek Harness Host exited'))
        }
        this.pendingWorkspaces.clear()
        const tail = stderrTail.join('').trim()
        this.log(`Host exited (code=${String(code)}, signal=${String(signal)})`)
        settleReject(new Error(
          `DeepSeek Harness Host exited unexpectedly (code=${String(code)}, signal=${String(signal)})`
          + (tail.length > 0 ? `\n${tail.slice(-1200)}` : ''),
        ))
      })
    })
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null || child.killed) return
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
        resolve()
      }, 4_000)
      child.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      if (child.connected) {
        try { child.send({ type: 'shutdown' }) } catch { child.kill('SIGTERM') }
      } else {
        child.kill('SIGTERM')
      }
    })
  }

  dispose(): void {
    this.disposed = true
    void this.stopChild()
  }
}
