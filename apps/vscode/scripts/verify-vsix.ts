/**
 * Standalone smoke verifier for a built `dsh-vscode-harness` `.vsix` archive.
 *
 * Extracts the `.vsix` to an isolated temporary directory outside the repository and verifies:
 * 1. `extension.vsixmanifest` declares the expected `TargetPlatform`.
 * 2. Core extension bundles, web frontend, plugin assets, and runtime host entrypoint exist.
 * 3. Zero symlinks remain under `extension/runtime/node_modules`.
 * 4. Platform native prebuilds (`node-pty`, `koffi`, `@vscode/ripgrep`) are present (and executable on Unix).
 * 5. When running on a native host matching `--target`, boots `extension/runtime/lib/index.js` in an
 *    isolated temporary `DSH_HOME`, completes IPC auth, verifies pruned/replaced client plugins,
 *    fetches a revisioned bundle, checks authenticated vs unauthenticated RPC, and exits cleanly with 0.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(extensionDir, '../..')

type ExtractZipFn = (source: string, options: { dir: string }) => Promise<void>

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[verify-vsix] ${message}`)
}

function findFirstSymlink(rootDir: string): string | undefined {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) return full
    if (stat.isDirectory()) {
      const nested = findFirstSymlink(full)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function verifyNativeHostBoot(extRoot: string, tempRoot: string): Promise<void> {
  const hostEntry = join(extRoot, 'runtime', 'lib', 'index.js')
  const fakeHome = join(tempRoot, 'dsh-home')
  const secret = randomBytes(32).toString('base64url')

  const child = spawn(process.execPath, [hostEntry], {
    cwd: tempRoot,
    env: {
      ...process.env,
      DSH_HOME: fakeHome,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })

  const stderrTail: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk.toString('utf8'))
    if (stderrTail.length > 40) stderrTail.shift()
  })

  try {
    const ready = await new Promise<{ url: string; injections: Array<Record<string, unknown>> }>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(new Error(`Host timed out waiting for ready:\n${stderrTail.join('')}`))
      }, 60_000)

      child.on('message', (raw: unknown) => {
        if (typeof raw !== 'object' || raw === null || !('type' in raw)) return
        const msg = raw as Record<string, unknown>
        if (msg.type === 'starting') {
          child.send({ type: 'auth', secret, workspacePaths: [tempRoot] })
          return
        }
        if (msg.type === 'ready' && typeof msg.url === 'string' && Array.isArray(msg.injections)) {
          clearTimeout(timer)
          resolveReady({
            url: msg.url,
            injections: msg.injections as Array<Record<string, unknown>>,
          })
          return
        }
        if (msg.type === 'fatal') {
          clearTimeout(timer)
          rejectReady(new Error(`Host reported fatal: ${String(msg.message ?? 'unknown')}`))
        }
      })

      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        rejectReady(new Error(`Host exited before ready (code=${String(code)}, signal=${String(signal)}):\n${stderrTail.join('')}`))
      })
    })

    const bootGlobal = ready.injections.find(
      item => item.kind === 'global' && item.name === '__DSH_BOOT__' && typeof item.value === 'object' && item.value !== null,
    )
    const graph = bootGlobal?.value as {
      entries?: Array<{ id?: string; url?: string }>
      batches?: Array<{ url?: string }>
    } | undefined
    const entries = Array.isArray(graph?.entries) ? graph.entries : []
    const batches = Array.isArray(graph?.batches) ? graph.batches : []
    const mountedIds = new Set(entries.map(e => e.id).filter((id): id is string => typeof id === 'string'))
    assert(mountedIds.has('@deepseek-ai/dsh-vscode-ui-layout'), 'Mounted client plugins missing @deepseek-ai/dsh-vscode-ui-layout')
    assert(!mountedIds.has('@deepseek-ai/dsh-client-ui-layout'), 'Stock @deepseek-ai/dsh-client-ui-layout should be disabled')
    for (const pruned of [
      '@deepseek-ai/dsh-client-ui-sidebar-files',
      '@deepseek-ai/dsh-client-ui-sidebar-terminal',
      '@deepseek-ai/dsh-client-ui-sidebar-browser',
      '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    ]) {
      assert(!mountedIds.has(pruned), `Pruned panel still mounted: ${pruned}`)
    }
    console.log(`[verify-vsix] Host booted cleanly at ${ready.url} (${String(mountedIds.size)} mounted client plugins, ${String(batches.length)} batch(es))`)

    const firstBundle = batches.find(b => typeof b.url === 'string' && b.url.length > 0)?.url
      ?? entries.find(e => typeof e.url === 'string' && e.url.length > 0)?.url
    assert(firstBundle !== undefined, 'No client bundle URL found in __DSH_BOOT__')
    const bundleRes = await fetch(new URL(firstBundle, ready.url), {
      headers: { cookie: `dsh-desktop-session=${secret}` },
    })
    assert(bundleRes.status === 200, `Bundle fetch failed with HTTP ${String(bundleRes.status)}`)

    const authedRpc = await fetch(new URL('/api/settings/describe', ready.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `dsh-desktop-session=${secret}`,
      },
      body: JSON.stringify({ payload: { args: {} } }),
    })
    assert(authedRpc.status === 200, `Authenticated /api/settings/describe failed with HTTP ${String(authedRpc.status)}`)

    const unauthedRpc = await fetch(new URL('/api/settings/describe', ready.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { args: {} } }),
    })
    assert(unauthedRpc.status === 401, `Expected HTTP 401 for unauthenticated RPC, got ${String(unauthedRpc.status)}`)

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        rejectExit(new Error('Host timed out during graceful shutdown'))
      }, 15_000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
      child.send({ type: 'shutdown' })
    })
    assert(exitCode === 0, `Expected clean host exit code 0, got ${String(exitCode)}`)
    console.log('[verify-vsix] Native Host boot, auth, RPC, bundle fetch, and shutdown checks PASSED')
  } finally {
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  const argv = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string', default: `${process.platform}-${process.arch}` },
      vsix: { type: 'string' },
    },
    allowPositionals: false,
  })

  const target = values.target
  const [targetOs, targetCpu] = target.split('-') as [string, string]
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8')) as { name?: string; version?: string }
  const defaultVsix = join(
    extensionDir,
    'dist',
    `${manifest.name ?? 'dsh-vscode-harness'}-${manifest.version ?? '0.1.0'}-${target}.vsix`,
  )
  const vsixPath = resolve(values.vsix ?? defaultVsix)
  assert(existsSync(vsixPath), `VSIX file not found: ${vsixPath}`)

  const rootRequire = createRequire(join(repoRoot, 'package.json'))
  const extractZip = rootRequire('extract-zip') as ExtractZipFn

  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-vsix-verify-'))
  try {
    const extractDir = join(tempRoot, 'unpacked')
    await extractZip(vsixPath, { dir: extractDir })

    const vsixManifestPath = join(extractDir, 'extension.vsixmanifest')
    assert(existsSync(vsixManifestPath), 'Missing extension.vsixmanifest in VSIX')
    const vsixManifest = readFileSync(vsixManifestPath, 'utf8')
    assert(
      vsixManifest.includes(`TargetPlatform="${target}"`),
      `extension.vsixmanifest does not declare TargetPlatform="${target}"`,
    )

    const extRoot = join(extractDir, 'extension')
    for (const rel of [
      'package.json',
      'out/extension.js',
      'out/webview-boot.js',
      'web-dist/index.html',
      'plugin-assets/@deepseek-ai/dsh-client-ui-brand-official',
      'runtime/lib/index.js',
      'runtime/node_modules',
    ]) {
      assert(existsSync(join(extRoot, rel)), `Missing required VSIX entry: extension/${rel}`)
    }

    const runtimeNodeModules = join(extRoot, 'runtime', 'node_modules')
    const straySymlink = findFirstSymlink(runtimeNodeModules)
    assert(straySymlink === undefined, `Found unresolved symlink inside runtime/node_modules: ${straySymlink}`)

    // Verify target ripgrep binary.
    const rgBin = join(runtimeNodeModules, '@vscode', `ripgrep-${target}`, 'bin', targetOs === 'win32' ? 'rg.exe' : 'rg')
    assert(existsSync(rgBin), `Missing target ripgrep binary: ${rgBin}`)

    // Verify target node-pty prebuild.
    const ptyPrebuild = join(runtimeNodeModules, 'node-pty', 'prebuilds', target)
    assert(existsSync(ptyPrebuild), `Missing node-pty prebuild directory: ${ptyPrebuild}`)
    if (targetOs === 'win32') {
      for (const rel of ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
        assert(existsSync(join(ptyPrebuild, rel)), `Missing Windows node-pty binary: ${rel}`)
      }
      assert(
        existsSync(join(runtimeNodeModules, '@deepseek-ai', 'dsh-sandbox-windows-acl', 'assets')),
        'Missing Windows ACL sandbox assets',
      )
    } else if (targetOs === 'darwin') {
      assert(existsSync(join(ptyPrebuild, 'pty.node')), 'Missing macOS node-pty pty.node')
      const spawnHelper = join(ptyPrebuild, 'spawn-helper')
      assert(existsSync(spawnHelper), 'Missing macOS node-pty spawn-helper')
      if (process.platform !== 'win32') {
        const mode = statSync(spawnHelper).mode & 0o111
        assert(mode !== 0, 'macOS node-pty spawn-helper is missing execute permissions')
      }
    } else if (targetOs === 'linux') {
      assert(existsSync(join(ptyPrebuild, 'pty.node')), 'Missing Linux node-pty pty.node')
    }

    // Verify target koffi prebuild.
    const koffiScopedPkg = join(runtimeNodeModules, '@koromix', `koffi-${target}`)
    const koffiBuiltDir = join(runtimeNodeModules, 'koffi', 'build', 'koffi', `${targetOs}_${targetCpu}`)
    assert(
      existsSync(koffiScopedPkg) || existsSync(koffiBuiltDir),
      `Missing target koffi native prebuild (${koffiScopedPkg} or ${koffiBuiltDir})`,
    )

    console.log(`[verify-vsix] Archive structure & target (${target}) binary checks PASSED`)

    if (`${process.platform}-${process.arch}` === target) {
      await verifyNativeHostBoot(extRoot, tempRoot)
    } else {
      console.log(`[verify-vsix] Skipping live Host boot (runner is ${process.platform}-${process.arch}, VSIX target is ${target})`)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
