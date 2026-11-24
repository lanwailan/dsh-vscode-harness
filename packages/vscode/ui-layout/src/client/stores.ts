/** Root layout state for the VS Code split-surface frame. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

export const RIGHTBAR_MIN = 300
export const RIGHTBAR_DEFAULT_RATIO = 0.42
export const RIGHTBAR_MAX_RATIO = 0.65
export const CENTER_MIN = 360

export interface VsCodeLayoutInfo {
  viewportWidth: number
  rightbar: number | null
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
}

export interface VsCodeLayoutState {
  panelInfo: {
    activePanelId: MainPanelId | null
  }
  layoutInfo: VsCodeLayoutInfo
}

export type VsCodeLayoutActions = {
  selectPanel: (draft: VsCodeLayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: VsCodeLayoutState, panelIds: readonly string[]) => void
  setViewportWidth: (draft: VsCodeLayoutState, width: number) => void
  setRightbar: (draft: VsCodeLayoutState, px: number) => void
  openRightbar: (draft: VsCodeLayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: VsCodeLayoutState) => void
}

export function clampWidth(value: number, min: number, max: number): number {
  if (max <= min) return Math.max(0, max)
  return Math.min(max, Math.max(min, value))
}

export function createVsCodeLayoutStore(
  initialPanelId: MainPanelId | null = null,
): EngineStoreHandle<VsCodeLayoutState, VsCodeLayoutActions> {
  return defineStore({
    init: (): VsCodeLayoutState => ({
      panelInfo: { activePanelId: initialPanelId },
      layoutInfo: {
        viewportWidth: typeof window === 'undefined' ? 800 : window.innerWidth,
        rightbar: null,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
      },
    }),
    actions: {
      selectPanel: (draft, panelId: MainPanelId | null) => {
        draft.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (draft, panelIds: readonly string[]) => {
        if (draft.panelInfo.activePanelId !== null && !panelIds.includes(draft.panelInfo.activePanelId)) {
          draft.panelInfo.activePanelId = null
        }
      },
      setViewportWidth: (draft, width: number) => {
        draft.layoutInfo.viewportWidth = width
      },
      setRightbar: (draft, px: number) => {
        const max = Math.max(RIGHTBAR_MIN, draft.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO)
        draft.layoutInfo.rightbar = clampWidth(px, RIGHTBAR_MIN, max)
      },
      openRightbar: (draft, track: boolean, fullscreen: boolean) => {
        draft.layoutInfo.rightbarShown = true
        draft.layoutInfo.rightbarTrack = track
        draft.layoutInfo.rightbarFullscreen = fullscreen
      },
      closeRightbar: (draft) => {
        draft.layoutInfo.rightbarShown = false
        draft.layoutInfo.rightbarTrack = false
        draft.layoutInfo.rightbarFullscreen = false
      },
    },
  })
}
