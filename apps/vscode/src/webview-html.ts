/**
 * Builds the VS Code Webview HTML document from the built Web frontend (`index.html`),
 * rewriting static asset URIs through `webview.asWebviewUri`, injecting `out/webview-boot.js` ahead
 * of the stock client entry module, and computing synchronous package-asset URI mappings.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { ExtensionRuntimePaths } from './runtime-paths.ts'

export function localResourceRoots(paths: ExtensionRuntimePaths): vscode.Uri[] {
  const roots = [
    vscode.Uri.file(paths.webDistDir),
    vscode.Uri.file(paths.extensionOutDir),
  ]
  if (paths.pluginAssetsDir !== undefined && existsSync(paths.pluginAssetsDir)) {
    roots.push(vscode.Uri.file(paths.pluginAssetsDir))
  }
  if (paths.packagesDir !== undefined && existsSync(paths.packagesDir)) {
    roots.push(vscode.Uri.file(paths.packagesDir))
  }
  return roots
}

/**
 * Map package names to their asset base URIs so `require.asset('plugins/<pkg>/assets/<file>')`
 * resolves synchronously to a native `vscode-webview://` URI in both packaged and dev modes.
 */
export function buildPackageAssetMap(webview: vscode.Webview, paths: ExtensionRuntimePaths): Record<string, string> {
  const map: Record<string, string> = {}

  if (paths.pluginAssetsDir !== undefined && existsSync(paths.pluginAssetsDir)) {
    for (const entry of readdirSync(paths.pluginAssetsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const entryDir = join(paths.pluginAssetsDir, entry.name)
      if (entry.name.startsWith('@')) {
        for (const pkg of readdirSync(entryDir, { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue
          const pkgDir = join(entryDir, pkg.name)
          map[`${entry.name}/${pkg.name}`] = webview.asWebviewUri(vscode.Uri.file(pkgDir)).toString().replace(/\/+$/, '')
        }
      } else {
        map[entry.name] = webview.asWebviewUri(vscode.Uri.file(entryDir)).toString().replace(/\/+$/, '')
      }
    }
    return map
  }

  if (paths.packagesDir !== undefined && existsSync(paths.packagesDir)) {
    for (const group of readdirSync(paths.packagesDir, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const groupDir = join(paths.packagesDir, group.name)
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const pkgDir = join(groupDir, entry.name)
        const assetsDir = join(pkgDir, 'lib', 'assets')
        const manifestPath = join(pkgDir, 'package.json')
        if (!existsSync(assetsDir) || !existsSync(manifestPath)) continue
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
          if (typeof manifest.name === 'string') {
            map[manifest.name] = webview.asWebviewUri(vscode.Uri.file(assetsDir)).toString().replace(/\/+$/, '')
          }
        } catch {
          // Ignore malformed package manifests during asset discovery.
        }
      }
    }
  }
  return map
}

export function buildWebviewHtml(webview: vscode.Webview, paths: ExtensionRuntimePaths): string {
  const indexPath = join(paths.webDistDir, 'index.html')
  if (!existsSync(indexPath)) {
    return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /></head>
  <body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px;">
    <h3>DeepSeek Harness Web UI not built</h3>
    <p>Expected built frontend at <code>${indexPath}</code>.</p>
    <p>Run <code>pnpm run build:artifacts</code> in the repository root, then reload.</p>
  </body>
</html>`
  }

  const webDistUri = webview.asWebviewUri(vscode.Uri.file(paths.webDistDir)).toString().replace(/\/+$/, '')
  const bootScriptUri = webview.asWebviewUri(vscode.Uri.file(join(paths.extensionOutDir, 'webview-boot.js'))).toString()

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: http: data: blob:`,
    `font-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' blob:`,
    `connect-src ${webview.cspSource} data: blob:`,
    `media-src ${webview.cspSource} data: blob:`,
    `worker-src ${webview.cspSource} blob:`,
  ].join('; ')

  let html = readFileSync(indexPath, 'utf8')

  // Remove browser-only manifest/favicon links that fail inside vscode-webview://.
  html = html.replace(/<link[^>]+rel="(?:manifest|icon|apple-touch-icon)"[^>]*>\s*/gi, '')

  // Rewrite relative and root-relative asset URLs to the webview dist URI.
  html = html.replace(
    /\b(src|href)="(\.?\/)([^"]+)"/g,
    (_full, attr: string, _prefix: string, rel: string) => `${attr}="${webDistUri}/${rel}"`,
  )

  const headInject = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    `<style>html, body, #root { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }</style>`,
    `<script src="${bootScriptUri}"></script>`,
  ].join('\n    ')

  html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${headInject}`)
  return html
}
