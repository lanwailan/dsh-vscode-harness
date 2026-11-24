/**
 * VS Code implementation of `ctx.layout` (`ILayout`).
 * In `sidebar` mode, selecting a global panel or revealing a conversation forwards
 * navigation to the VS Code Extension Host so each conversation or panel opens as
 * a VS Code Editor Tab instead of rendering inside the narrow Activity Bar view.
 */
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createVsCodeLayoutStore } from './stores.ts'

export type VsCodePanelActions = BoundActions<ReturnType<typeof createVsCodeLayoutStore>>

export interface VsCodeLayoutCallbacks {
  readonly onSelectPanel?: (panelId: MainPanelId | null) => void
  readonly onToggleSidebar?: () => void
}

export class VsCodeLayoutController implements ILayout {
  private navigation = new AbortController()

  constructor(
    private readonly actions: VsCodePanelActions,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    readonly panelInfo: HostObservable<PanelInfo>,
    private readonly callbacks: VsCodeLayoutCallbacks = {},
  ) {}

  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`vscode-layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.actions.selectPanel(panelId)
    this.callbacks.onSelectPanel?.(panelId)
  }

  /** Update local panel state without emitting an outbound VS Code navigation message. */
  syncLocalPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) return
    this.actions.selectPanel(panelId)
  }

  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  dispose(): void {
    this.navigation.abort()
  }

  toggleSidebar(): void {
    this.callbacks.onToggleSidebar?.()
  }

  openRightbar(track: boolean, fullscreen: boolean): void {
    this.actions.openRightbar(track, fullscreen)
  }

  closeRightbar(): void {
    this.actions.closeRightbar()
  }
}
