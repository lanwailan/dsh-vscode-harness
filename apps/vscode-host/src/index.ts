/**
 * Dedicated local Node Host process spawned by the `dsh-vscode-harness` VS Code Extension.
 *
 * Shares the user's standard `$DSH_HOME` (`~/.dsh` by default) so sessions, workspaces,
 * settings, credentials, and skills stay unified with `dsh` CLI and Desktop, while keeping
 * its own profile directory (`$DSH_HOME/profiles/vscode`) layered with `@deepseek-ai/dsh-vscode-app`.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import {
  initProfile,
  loadProfileDirectory,
  readProfileManifest,
  reportSkippedBundles,
  resolveProfileDir,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'

const VSCODE_PROFILE_NAME = 'vscode'
const VSCODE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-vscode-app',
] as const

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u

interface AuthHandshake {
  readonly secret: string
  readonly workspacePaths: readonly string[]
}

function sendIpc(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) {
      resolve()
      return
    }
    process.send(message, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

function waitForAuthHandshake(): Promise<AuthHandshake> {
  return new Promise((resolve, reject) => {
    if (!process.connected) {
      reject(new Error('vscode-host: parent IPC channel is not connected'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('vscode-host: timed out waiting for auth handshake'))
    }, 30_000)

    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      const record = message as Record<string, unknown>
      if (record.type === 'shutdown') {
        cleanup()
        reject(new Error('vscode-host: shutdown requested before auth'))
        return
      }
      if (record.type !== 'auth') return
      const secret = record.secret
      if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
        cleanup()
        reject(new Error('vscode-host: invalid authentication secret'))
        return
      }
      const rawPaths = Array.isArray(record.workspacePaths) ? record.workspacePaths : []
      const workspacePaths = rawPaths.filter((item): item is string => typeof item === 'string' && item.length > 0)
      cleanup()
      resolve({ secret, workspacePaths })
    }

    const onDisconnect = (): void => {
      cleanup()
      reject(new Error('vscode-host: parent disconnected before auth'))
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      process.off('message', onMessage)
      process.off('disconnect', onDisconnect)
    }

    process.on('message', onMessage)
    process.once('disconnect', onDisconnect)
  })
}

function ensureVsCodeProfile(homeDir: string): string {
  const profileDir = resolveProfileDir(VSCODE_PROFILE_NAME, homeDir)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  initProfile(profileDir, VSCODE_BUNDLES)
  // Ensure required VS Code bundles stay present even if a user edited an older profile manifest.
  const manifest = readProfileManifest('dsh', profileDir)
  const existing = manifest.dsh?.profile?.bundles ?? []
  const missing = VSCODE_BUNDLES.filter(bundle => !existing.includes(bundle))
  if (missing.length > 0) {
    const merged = [...existing]
    for (const bundle of VSCODE_BUNDLES) {
      if (!merged.includes(bundle)) merged.push(bundle)
    }
    writeProfileManifest(profileDir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles: merged,
        },
      },
    })
  }
  return profileDir
}

async function ensureWorkspaces(
  ctx: { get(name: 'workspaceRegistry'): { create(path: string): Promise<{ readonly id: string }> } | undefined },
  paths: readonly string[],
): Promise<Record<string, string>> {
  const registry = ctx.get('workspaceRegistry')
  const mapped: Record<string, string> = {}
  if (registry === undefined) return mapped
  for (const folderPath of paths) {
    if (!existsSync(folderPath)) continue
    try {
      const entity = await registry.create(folderPath)
      mapped[folderPath] = entity.id
    } catch (error: unknown) {
      process.stderr.write(`vscode-host: failed to register workspace ${folderPath}: ${String(error)}\n`)
    }
  }
  return mapped
}

async function main(): Promise<void> {
  await sendIpc({ type: 'starting' })
  const { secret, workspacePaths } = await waitForAuthHandshake()

  const homeDir = resolveDshHome()
  const profileDir = ensureVsCodeProfile(homeDir)
  const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
  const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
  reportSkippedBundles('dsh', profile)

  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: VSCODE_PROFILE_NAME,
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await sendIpc({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    if (running !== undefined) process.exit(0)
  })()

  process.once('disconnect', () => { void stop() })
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    const record = message as Record<string, unknown>
    if (record.type === 'shutdown') {
      void stop()
      return
    }
    if (record.type === 'ensure-workspaces' && typeof record.requestId === 'number' && Array.isArray(record.paths)) {
      const requestId = record.requestId
      const paths = record.paths.filter((item): item is string => typeof item === 'string' && item.length > 0)
      void (async () => {
        try {
          const { ctx } = await application
          const workspaceIds = await ensureWorkspaces(ctx, paths)
          await sendIpc({ type: 'ensure-workspaces-result', requestId, workspaceIds })
        } catch (error: unknown) {
          await sendIpc({
            type: 'ensure-workspaces-result',
            requestId,
            workspaceIds: {},
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }
  })

  const { ctx } = await application
  if (stopping !== undefined || !process.connected) return

  await ctx.plugin(DesktopAuthentication, { readSecret: () => secret }).await()
  if (stopping !== undefined || !process.connected) return

  const admission = ctx.connection.authentication.authenticate({
    headers: { cookie: `dsh-desktop-session=${secret}` },
  })
  if ('rejection' in admission) {
    throw new Error('vscode-host: authentication provider rejected its startup credential')
  }

  const workspaceIds = await ensureWorkspaces(ctx, workspacePaths)
  const url = `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}/`
  const injections = ctx.webServer.collectIndexInjections(admission.peer)
  if (stopping !== undefined || !process.connected) return

  await sendIpc({ type: 'ready', url, injections, homeDir, workspaceIds })
}

const isEntrypoint = Boolean(import.meta.main)
  || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))

if (isEntrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const diagnostic = inspect(error, { depth: 4, maxStringLength: 8192 })
    void sendIpc({ type: 'fatal', message, diagnostic }).finally(() => {
      process.stderr.write(`${diagnostic}\n`)
      process.exitCode = 1
      if (process.connected) process.disconnect()
    })
  })
}
