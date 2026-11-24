/**
 * Theme DOM applier for VS Code Webviews: projects ctx.theme tokens onto the document
 * and follows VS Code's active color theme (`body.vscode-dark` / `body.vscode-light`)
 * whenever the user's DSH theme preference is `system`.
 */
import type { FontRole, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

export const DARK_ATTRIBUTE = 'data-ds-dark-theme'
export const THEME_SOURCE_ATTRIBUTE = 'data-ds-theme-source'

const FONT_SIZE_VARIABLES = {
  text: '--dsh-content-font-size',
  code: '--dsh-code-font-size',
  terminal: '--dsh-terminal-font-size',
} as const satisfies Record<FontRole, string>

const FONT_FAMILY_VARIABLES = {
  text: '--dsh-font-family-text',
  code: '--dsh-font-family-code',
  terminal: '--dsh-font-family-terminal',
} as const satisfies Record<FontRole, string>

function readVsCodeColorScheme(): 'dark' | 'light' | undefined {
  if (typeof document === 'undefined') return undefined
  const cls = document.body.classList
  if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return 'dark'
  if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) return 'light'
  return undefined
}

export class VsCodeThemePresenter {
  private appliedTokens: string[] = []
  private lastSnapshot: ThemeSnapshot | undefined
  private bodyObserver: MutationObserver | undefined

  start(): void {
    if (this.bodyObserver !== undefined || typeof MutationObserver === 'undefined') return
    this.bodyObserver = new MutationObserver(() => {
      if (this.lastSnapshot !== undefined && this.lastSnapshot.preference === 'system') {
        this.apply(this.lastSnapshot)
      }
    })
    this.bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] })
  }

  apply(snapshot: ThemeSnapshot): void {
    this.lastSnapshot = snapshot
    const vsCodeScheme = snapshot.preference === 'system' ? readVsCodeColorScheme() : undefined
    const scheme = vsCodeScheme ?? snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    document.documentElement.setAttribute(
      THEME_SOURCE_ATTRIBUTE,
      snapshot.preference === 'system' ? 'system' : scheme,
    )
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)

    for (const [role, name] of Object.entries(FONT_SIZE_VARIABLES)) {
      body.style.setProperty(name, `${snapshot.fontSizes[role as FontRole]}px`)
    }
    for (const [kind, name] of Object.entries(FONT_FAMILY_VARIABLES)) {
      const list = snapshot.fontFamilies[kind as FontRole]
      if (list === '') body.style.removeProperty(name)
      else body.style.setProperty(name, list)
    }
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
  }

  dispose(): void {
    this.bodyObserver?.disconnect()
    this.bodyObserver = undefined
    document.documentElement.style.removeProperty('color-scheme')
    document.documentElement.removeAttribute(THEME_SOURCE_ATTRIBUTE)
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of Object.values(FONT_SIZE_VARIABLES)) body.style.removeProperty(name)
    for (const name of Object.values(FONT_FAMILY_VARIABLES)) body.style.removeProperty(name)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
  }
}
