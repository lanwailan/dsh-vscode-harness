import * as esbuild from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'out/extension.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const webviewBootConfig = {
  entryPoints: [resolve(root, 'src/webview-boot/index.ts')],
  outfile: resolve(root, 'out/webview-boot.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
}

if (watch) {
  const [extCtx, bootCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewBootConfig),
  ])
  await Promise.all([extCtx.watch(), bootCtx.watch()])
  console.log('[dsh-vscode] watching extension + webview-boot...')
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewBootConfig),
  ])
}
