/**
 * Package `dsh-vscode-harness` as a self-contained, platform-specific `.vsix` archive.
 *
 * Stages:
 * 1. Extension bundle (`out/extension.js`, `out/webview-boot.js`), icons, README, LICENSE.
 * 2. Built Web frontend (`apps/web/dist` -> `web-dist/`).
 * 3. Client plugin static assets (`packages/*\/*\/lib/assets` -> `plugin-assets/<pkg>/`).
 * 4. Standalone production Host runtime (`pnpm deploy` of `@deepseek-ai/dsh-vscode-host` -> `runtime/`),
 *    dereferencing all symlinks, deduplicating workspace packages, and pruning non-target platform binaries.
 * 5. Packs the staged directory via `@vscode/vsce` with `--target <platform-arch>`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, glob, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  deduplicateStagedWorkspacePackages,
  materializeStagedLinks,
} from '../../../scripts/build-exe-for-python-sdk-staging.ts'
import { pnpmCommand } from '../../../scripts/release/process.ts'

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(extensionDir, '../..')

const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
])

const PLATFORM_PACKAGE_SUFFIX = /(?:^|-)(darwin|linux|win32|win|windows)-(arm64|x64|ia32|arm|ppc64|riscv64|s390x)(?:-(?:msvc|gnu|musl))?$/i

function normalizeOsToken(token: string): string {
  const lower = token.toLowerCase()
  if (lower === 'win' || lower === 'windows') return 'win32'
  return lower
}

function isOtherPlatformPackage(entryName: string, targetOs: string, targetCpu: string): boolean {
  if (/-wasm$/i.test(entryName)) return true
  const match = PLATFORM_PACKAGE_SUFFIX.exec(entryName)
  if (match?.[1] === undefined || match[2] === undefined) return false
  const pkgOs = normalizeOsToken(match[1])
  const pkgCpu = match[2].toLowerCase()
  return pkgOs !== targetOs || pkgCpu !== targetCpu
}

function run(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  extraEnv?: Readonly<Record<string, string>>,
): void {
  console.log(`[package-vsix] ${label}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`[package-vsix] ${label} failed with exit code ${String(result.status ?? result.signal)}`)
  }
}

function runPnpm(
  label: string,
  args: readonly string[],
  cwd: string,
  extraEnv?: Readonly<Record<string, string>>,
): void {
  const [command, ...prefix] = pnpmCommand()
  run(label, command, [...prefix, ...args], cwd, extraEnv)
}

function collectPluginAssets(packagesDir: string): Array<{ name: string; assetsDir: string }> {
  const results: Array<{ name: string; assetsDir: string }> = []
  if (!existsSync(packagesDir)) return results
  for (const group of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(packagesDir, group.name)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgDir = join(groupDir, entry.name)
      const assetsDir = join(pkgDir, 'lib', 'assets')
      const manifestPath = join(pkgDir, 'package.json')
      if (!existsSync(assetsDir) || !existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
      if (typeof manifest.name === 'string') {
        results.push({ name: manifest.name, assetsDir })
      }
    }
  }
  return results
}

async function pruneNonTargetBinaries(runtimeDir: string, targetOs: string, targetCpu: string): Promise<void> {
  const target = `${targetOs}-${targetCpu}`
  const nodeModules = join(runtimeDir, 'node_modules')
  if (!existsSync(nodeModules)) return

  // Remove docs, sourcemaps, and TypeScript declarations from runtime node_modules.
  for await (const file of glob(
    'node_modules/**/{README*.md,CHANGELOG*.md,HISTORY*.md,*.map,*.d.ts,*.d.mts,*.d.cts}',
    { cwd: runtimeDir, exclude: ['node_modules/**/assets/**'] },
  )) {
    await rm(join(runtimeDir, file), { force: true })
  }

  // Remove source, test, and doc directories inside workspace @deepseek-ai packages (runtime executes lib/).
  const scopeDir = join(nodeModules, '@deepseek-ai')
  if (existsSync(scopeDir)) {
    for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      for (const dirName of ['src', 'tests', 'stress-tests', 'docs']) {
        const targetDir = join(scopeDir, pkg.name, dirName)
        if (existsSync(targetDir)) {
          await rm(targetDir, { recursive: true, force: true })
        }
      }
    }
  }

  // Keep dsh-web-frontend/dist (host-frontend-static validates it at startup), excluding worker preview files.
  const webDistInRuntime = join(scopeDir, 'dsh-web-frontend', 'dist')
  if (existsSync(webDistInRuntime)) {
    await rm(join(webDistInRuntime, 'preview'), { recursive: true, force: true })
    await rm(join(webDistInRuntime, 'preview.html'), { force: true })
  }

  // Koffi: keep only target build directory (if present) and remove documentation; keep koffi/src (runtime JS entry).
  const koffiDir = join(nodeModules, 'koffi')
  if (existsSync(koffiDir)) {
    await rm(join(koffiDir, 'doc'), { recursive: true, force: true })
    const koffiBuild = join(koffiDir, 'build', 'koffi')
    if (existsSync(koffiBuild)) {
      const koffiTargetDir = `${targetOs}_${targetCpu}`
      for (const entry of readdirSync(koffiBuild)) {
        if (entry !== koffiTargetDir) {
          await rm(join(koffiBuild, entry), { recursive: true, force: true })
        }
      }
    }
  }

  // node-pty: remove build sources/third_party copies, keep only target prebuilds, and strip Windows .pdb symbols.
  const ptyDir = join(nodeModules, 'node-pty')
  if (existsSync(ptyDir)) {
    await rm(join(ptyDir, 'build'), { recursive: true, force: true })
    await rm(join(ptyDir, 'third_party'), { recursive: true, force: true })
    await rm(join(ptyDir, 'src'), { recursive: true, force: true })
    const ptyPrebuilds = join(ptyDir, 'prebuilds')
    if (existsSync(ptyPrebuilds)) {
      for (const entry of readdirSync(ptyPrebuilds)) {
        if (entry !== target) {
          await rm(join(ptyPrebuilds, entry), { recursive: true, force: true })
        }
      }
      const targetPrebuild = join(ptyPrebuilds, target)
      if (existsSync(targetPrebuild)) {
        for (const entry of readdirSync(targetPrebuild)) {
          if (entry.endsWith('.pdb')) {
            await rm(join(targetPrebuild, entry), { force: true })
          }
        }
        if (targetOs === 'darwin') {
          const spawnHelper = join(targetPrebuild, 'spawn-helper')
          if (existsSync(spawnHelper)) await chmod(spawnHelper, 0o755)
        }
      }
    }
  }

  // libreoffice-kit frame-forwarding prebuilds: keep only target platform.
  const loFramePrebuilds = join(scopeDir, 'libreoffice-kit', 'frame-forwarding', 'prebuilds')
  if (existsSync(loFramePrebuilds)) {
    for (const entry of readdirSync(loFramePrebuilds)) {
      if (entry !== target) {
        await rm(join(loFramePrebuilds, entry), { recursive: true, force: true })
      }
    }
  }

  // Prune non-target platform packages at top-level and inside every @scope in runtime/node_modules.
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      const scopedRoot = join(nodeModules, entry.name)
      for (const pkg of readdirSync(scopedRoot, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        if (isOtherPlatformPackage(pkg.name, targetOs, targetCpu)) {
          await rm(join(scopedRoot, pkg.name), { recursive: true, force: true })
        }
      }
    } else if (isOtherPlatformPackage(entry.name, targetOs, targetCpu)) {
      await rm(join(nodeModules, entry.name), { recursive: true, force: true })
    }
  }

  // Restore executable permissions for Unix target binaries.
  if (targetOs !== 'win32') {
    const unixExecutables = [
      join(nodeModules, '@vscode', 'ripgrep', 'bin', 'rg'),
      join(nodeModules, '@vscode', `ripgrep-${target}`, 'bin', 'rg'),
      join(scopeDir, `libreoffice-kit-${target}`, 'bin', 'dsoffice'),
    ]
    for (const binPath of unixExecutables) {
      if (existsSync(binPath)) await chmod(binPath, 0o755)
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
      out: { type: 'string' },
      'keep-stage': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const target = values.target
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(
      `[package-vsix] unsupported target "${target}". Supported targets: ${[...SUPPORTED_TARGETS].join(', ')}`,
    )
  }
  const [targetOs, targetCpu] = target.split('-') as [string, string]

  const rawManifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8')) as Record<string, unknown>
  const name = String(rawManifest.name ?? 'dsh-vscode-harness')
  const version = String(rawManifest.version ?? '0.1.0')

  const distDir = join(extensionDir, 'dist')
  mkdirSync(distDir, { recursive: true })
  const outPath = resolve(values.out ?? join(distDir, `${name}-${version}-${target}.vsix`))

  // Ensure extension bundles are up to date.
  run('build extension', process.execPath, [join(extensionDir, 'scripts/build.mjs')], extensionDir)

  const requiredFiles = [
    join(extensionDir, 'out/extension.js'),
    join(extensionDir, 'out/webview-boot.js'),
    join(repoRoot, 'apps/vscode-host/lib/index.js'),
    join(repoRoot, 'apps/web/dist/index.html'),
  ]
  for (const file of requiredFiles) {
    if (!existsSync(file)) {
      throw new Error(`[package-vsix] missing built artifact ${file}. Run "pnpm run build:artifacts" first.`)
    }
  }

  const stageDir = join(extensionDir, '.vsix-stage')
  await rm(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  try {
    // 1. Write packaged extension manifest (dependencies are bundled into out/extension.js).
    const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : 'https://github.com/lanwailan/dsh-vscode-harness'
    const packagedManifest: Record<string, unknown> = {
      ...rawManifest,
      repository: {
        type: 'git',
        url: repoUrl,
      },
      dependencies: {},
      devDependencies: {},
      scripts: {},
    }
    delete packagedManifest.private
    await writeFile(join(stageDir, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`)

    // 2. Copy extension compiled bundles, icons, docs.
    mkdirSync(join(stageDir, 'out'), { recursive: true })
    await cp(join(extensionDir, 'out/extension.js'), join(stageDir, 'out/extension.js'))
    await cp(join(extensionDir, 'out/webview-boot.js'), join(stageDir, 'out/webview-boot.js'))
    await cp(join(extensionDir, 'media'), join(stageDir, 'media'), { recursive: true })
    if (existsSync(join(repoRoot, 'README.md'))) {
      await cp(join(repoRoot, 'README.md'), join(stageDir, 'README.md'))
    }
    if (existsSync(join(repoRoot, 'LICENSE'))) {
      await cp(join(repoRoot, 'LICENSE'), join(stageDir, 'LICENSE'))
    }

    // 3. Copy built Web frontend into web-dist/ (excluding sourcemaps and worker preview).
    const webDistTarget = join(stageDir, 'web-dist')
    await cp(join(repoRoot, 'apps/web/dist'), webDistTarget, {
      recursive: true,
      filter: (source) => {
        if (source.endsWith('.map')) return false
        const base = basename(source)
        if (base === 'preview.html' || base === 'preview') return false
        return true
      },
    })

    // 4. Copy client plugin static assets into plugin-assets/<pkgName>/.
    const pluginAssetsRoot = join(stageDir, 'plugin-assets')
    mkdirSync(pluginAssetsRoot, { recursive: true })
    const assetEntries = collectPluginAssets(join(repoRoot, 'packages'))
    for (const { name: pkgName, assetsDir } of assetEntries) {
      const dest = join(pluginAssetsRoot, pkgName)
      mkdirSync(dirname(dest), { recursive: true })
      await cp(assetsDir, dest, { recursive: true })
    }
    console.log(`[package-vsix] staged ${String(assetEntries.length)} plugin asset package(s)`)

    // 5. Deploy standalone production Host runtime into runtime/.
    const runtimeDir = join(stageDir, 'runtime')
    runPnpm(
      `pnpm deploy vscode-host (${target})`,
      [
        '--filter',
        '@deepseek-ai/dsh-vscode-host',
        'deploy',
        '--prod',
        '--config.allow-unused-patches=true',
        '--config.node-linker=hoisted',
        `--config.pnpmfile=${join(extensionDir, 'scripts/vsix-deploy.pnpmfile.mjs')}`,
        '--config.link-workspace-packages=true',
        '--config.hoist-workspace-packages=false',
        runtimeDir,
      ],
      repoRoot,
      {
        DSH_VSIX_TARGET_OS: targetOs,
        DSH_VSIX_TARGET_CPU: targetCpu,
      },
    )
    await materializeStagedLinks(runtimeDir)
    await deduplicateStagedWorkspacePackages(runtimeDir, runtimeDir)
    await pruneNonTargetBinaries(runtimeDir, targetOs, targetCpu)

    // 6. Keep every staged file inside the VSIX.
    await writeFile(join(stageDir, '.vscodeignore'), '.DS_Store\n**/*.map\n')

    // 7. Pack VSIX via @vscode/vsce (non-interactive).
    runPnpm(
      'vsce package',
      [
        'dlx',
        '--allow-build=@vscode/vsce-sign',
        '@vscode/vsce',
        'package',
        '--target',
        target,
        '--no-dependencies',
        '--no-git-tag-version',
        '-o',
        outPath,
      ],
      stageDir,
    )

    const bytes = statSync(outPath).size
    const mb = (bytes / (1024 * 1024)).toFixed(2)
    console.log(`[package-vsix] SUCCESS: ${outPath} (${mb} MiB)`)
  } finally {
    if (!values['keep-stage']) {
      await rm(stageDir, { recursive: true, force: true })
    }
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
