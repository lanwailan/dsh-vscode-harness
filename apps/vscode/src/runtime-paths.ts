/**
 * Resolves runtime and static asset locations for `dsh-vscode-harness`.
 *
 * - Packaged VSIX mode: reads self-contained `runtime/`, `web-dist/`, and `plugin-assets/`
 *   shipped inside `context.extensionPath`.
 * - Monorepo development mode (F5): reads built outputs directly from the workspace root.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ExtensionRuntimePaths {
  readonly packaged: boolean
  readonly hostEntry: string
  readonly webDistDir: string
  readonly extensionOutDir: string
  readonly pluginAssetsDir: string | undefined
  readonly packagesDir: string | undefined
}

export function resolveExtensionRuntimePaths(extensionPath: string): ExtensionRuntimePaths {
  const packagedHost = join(extensionPath, 'runtime', 'lib', 'index.js')
  if (existsSync(packagedHost)) {
    return {
      packaged: true,
      hostEntry: packagedHost,
      webDistDir: join(extensionPath, 'web-dist'),
      extensionOutDir: join(extensionPath, 'out'),
      pluginAssetsDir: join(extensionPath, 'plugin-assets'),
      packagesDir: undefined,
    }
  }
  const repoRoot = resolve(extensionPath, '../..')
  return {
    packaged: false,
    hostEntry: resolve(repoRoot, 'apps/vscode-host/lib/index.js'),
    webDistDir: resolve(repoRoot, 'apps/web/dist'),
    extensionOutDir: join(extensionPath, 'out'),
    pluginAssetsDir: undefined,
    packagesDir: resolve(repoRoot, 'packages'),
  }
}
