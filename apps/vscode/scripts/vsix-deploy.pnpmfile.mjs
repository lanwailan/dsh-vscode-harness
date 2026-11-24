/**
 * Cross-platform pnpm deploy hook for packaging `apps/vscode-host` into a platform-specific VSIX.
 *
 * - Translates relative `@file:` entries in `allowBuilds` to exact `file://` URLs anchored at the repo root.
 * - Sets `supportedArchitectures` to the requested VSIX target (`DSH_VSIX_TARGET_OS` / `DSH_VSIX_TARGET_CPU`)
 *   so pnpm installs prebuilt platform optionalDependencies for the target OS/arch.
 * - During cross-OS/arch packaging, disables native host-compiled build scripts (`koffi`, `node-pty`,
 *   `esbuild`, and `dsh-subprocess-local`'s Unix spawn-helper postinstall) so pnpm does not attempt to
 *   compile binaries for the build host; target prebuilds are verified directly by `package-vsix.ts`.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')

function updateConfig(config) {
  const targetOs = process.env.DSH_VSIX_TARGET_OS || process.platform
  const targetCpu = process.env.DSH_VSIX_TARGET_CPU || process.arch
  const isCrossTarget = targetOs !== process.platform || targetCpu !== process.arch

  let allowBuilds = config.allowBuilds
  if (allowBuilds !== undefined) {
    allowBuilds = Object.fromEntries(Object.entries(allowBuilds).map(([key, value]) => {
      const marker = key.indexOf('@file:')
      const normalizedKey = marker >= 0 && !key.slice(marker + 6).startsWith('//')
        ? `${key.slice(0, marker + 1)}${pathToFileURL(resolve(repoRoot, key.slice(marker + 6))).href}`
        : key
      if (isCrossTarget && value === true) {
        if (
          key === 'koffi'
          || key === 'node-pty'
          || key === 'esbuild'
          || key.startsWith('@deepseek-ai/dsh-subprocess-local@')
        ) {
          return [normalizedKey, false]
        }
      }
      return [normalizedKey, value]
    }))
  }

  return {
    ...config,
    ...(allowBuilds === undefined ? {} : { allowBuilds }),
    supportedArchitectures: {
      os: [targetOs],
      cpu: [targetCpu],
      ...(targetOs === 'linux' ? { libc: ['glibc'] } : {}),
    },
  }
}

export const hooks = { updateConfig }
