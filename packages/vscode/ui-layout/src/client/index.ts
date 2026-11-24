/**
 * VS Code split-surface layout plugin (`@deepseek-ai/dsh-vscode-ui-layout`).
 * Replaces `@deepseek-ai/dsh-client-ui-layout` in the VS Code profile while
 * preserving the exact `ctx.layout` service interface and child slot declarations
 * so all official vendor UI plugins (`ui-sidebar`, `ui-workspace`, `ui-chat`,
 * `ui-settings*`, `ui-plugin-manager`, etc.) work without modification.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { resolveSlotLabel, type HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { getVsCodeBridge, type VsCodeNavigateTarget } from './bridge.ts'
import { VsCodeLayoutController } from './service.ts'
import { createVsCodeLayoutStore } from './stores.ts'
import { VsCodeThemePresenter } from './theme-presenter.ts'
import { VsCodeFrame, type VsCodeFrameInjected } from './VsCodeFrame.tsx'
import {
  SettingsTabPanel,
  type SettingsTabPanelInjected,
  type SettingsTabSectionRow,
} from './SettingsTabPanel.tsx'

export type { ILayout, MainPanelId, PanelInfo }
export type {
  VsCodeActiveTabState,
  VsCodeBridge,
  VsCodeNavigateTarget,
  VsCodeSurfaceMode,
  VsCodeSurfaceState,
} from './bridge.ts'
export { VsCodeLayoutController } from './service.ts'

export const SETTINGS_PANEL_ID = 'vscode-settings' as MainPanelId

/** Required services (same core dependencies as official `ui-layout`). */
export const inject = ['slots', 'theme', 'locale', 'shortcuts']

export function apply(ctx: ClientContext): void {
  const bridge = getVsCodeBridge()
  const mode = bridge?.surface.mode ?? 'standalone'

  const resolvePanelTitle = (panelId: string): string => {
    if (panelId === SETTINGS_PANEL_ID) return 'Settings'
    const entry = ctx.slots.entriesOfSlot('sidebar.panellist').find(item => item.options.id === panelId)
    return (entry === undefined ? undefined : resolveSlotLabel(entry.options.label)) ?? panelId
  }

  ctx.effect(() => {
    const initialPanel = mode === 'editor' && bridge?.surface.initialTarget?.kind === 'panel'
      ? (bridge.surface.initialTarget.panelId as MainPanelId | undefined) ?? null
      : null
    const handle = createVsCodeLayoutStore(initialPanel)
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }

    let pendingEditorPanel: MainPanelId | null = initialPanel

    const hasMainPanel = (id: MainPanelId): boolean =>
      ctx.slots.entries('main').some(entry => entry.options.key === id)

    const retainMainPanels = (): void => {
      const registered = ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key],
      )
      if (pendingEditorPanel !== null && registered.includes(pendingEditorPanel)) {
        const target = pendingEditorPanel
        pendingEditorPanel = null
        instance.actions.selectPanel(target)
        return
      }
      // Keep a pending editor panel selection until its plugin finishes activating.
      if (pendingEditorPanel !== null) return
      instance.actions.retainMainPanels(registered)
    }

    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }

    const findRetainedMainSession = (): { id: string; title: string | undefined } | undefined => {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) return undefined
      const state = sessions.list.getSnapshot()
      const main = Object.values(state.byId).find(item => (item.retainedBy.mainView ?? 0) > 0)
      return main === undefined ? undefined : { id: main.id, title: main.title }
    }

    const layout = new VsCodeLayoutController(
      instance.actions,
      hasMainPanel,
      panelInfo,
      mode === 'sidebar' && bridge !== undefined
        ? {
            onSelectPanel: (panelId) => {
              if (panelId !== null) {
                bridge.openPanel(panelId, resolvePanelTitle(panelId))
                return
              }
              const main = findRetainedMainSession()
              if (main !== undefined) {
                bridge.openConversation(main.id, main.title)
                return
              }
              const list = ctx.get('sessions')?.list.getSnapshot()
              if (list !== undefined && list.ids.length === 0) {
                bridge.openConversation(undefined, 'DeepSeek Chat')
              }
            },
          }
        : {},
    )

    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const disposeService = ctx.reflect.provide('layout', layout)

    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'common',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.bottom': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
      },
      store,
      inject: (): VsCodeFrameInjected => ({ mode, bridge, resolvePanelTitle }),
    }, VsCodeFrame)

    // Full-width Settings panel for the VS Code Editor Tab (`dsh.openSettings`).
    let sectionsVersion = -1
    let sectionsLocale = -1
    let sectionRows: readonly SettingsTabSectionRow[] = []
    const settingsSections: HostObservable<readonly SettingsTabSectionRow[]> = {
      getSnapshot: () => {
        const version = ctx.slots.getVersion('settings.section')
        const revision = ctx.locale.getSnapshot().revision
        if (version !== sectionsVersion || revision !== sectionsLocale) {
          sectionsVersion = version
          sectionsLocale = revision
          sectionRows = ctx.slots.entries('settings.section')
            .map(entry => ({
              id: entry.options.id ?? '',
              order: entry.options.order ?? 0,
              label: resolveSlotLabel(entry.options.label) ?? entry.options.id ?? '',
            }))
            .sort((a, b) => a.order - b.order)
        }
        return sectionRows
      },
      subscribe: (listener) => {
        const offSlots = ctx.slots.subscribe('settings.section', listener)
        const offLocale = ctx.locale.subscribe(listener)
        return () => {
          offSlots()
          offLocale()
        }
      },
    }
    const disposeSettingsTab = ctx.slots.register({
      name: 'main',
      key: SETTINGS_PANEL_ID,
      inject: (): SettingsTabPanelInjected => ({ hooks: { sections: settingsSections } }),
    }, SettingsTabPanel)

    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()

    // Editor navigation coordinator: bind requested conversation or global panel once ready.
    let pendingTarget: VsCodeNavigateTarget | undefined =
      mode === 'editor' ? bridge?.surface.initialTarget : undefined
    let stopPendingNavigation: (() => void) | undefined

    const clearPendingNavigation = (): void => {
      stopPendingNavigation?.()
      stopPendingNavigation = undefined
    }

    const applyEditorTarget = (target: VsCodeNavigateTarget): void => {
      clearPendingNavigation()
      pendingTarget = target
      if (target.kind === 'panel' && target.panelId !== undefined) {
        const panelId = target.panelId as MainPanelId
        if (hasMainPanel(panelId)) {
          pendingEditorPanel = null
          layout.syncLocalPanel(panelId)
        } else {
          pendingEditorPanel = panelId
          instance.actions.selectPanel(panelId)
        }
        return
      }
      pendingEditorPanel = null
      layout.syncLocalPanel(null)

      const fiber = ctx.inject(['sessions', 'uiWorkspace'], (readyCtx) => {
        const tryBind = (): boolean => {
          const currentTarget = pendingTarget
          if (currentTarget === undefined || currentTarget.kind !== 'conversation') return true
          const list = readyCtx.sessions.list.getSnapshot()
          if (list.phase !== 'ready') return false
          if (currentTarget.sessionId !== undefined) {
            const retained = findRetainedMainSession()
            if (retained?.id !== currentTarget.sessionId) {
              readyCtx.uiWorkspace.openSession(currentTarget.sessionId as SessionId)
            }
            pendingTarget = undefined
            return true
          }
          if (currentTarget.workspaceId !== undefined) {
            readyCtx.uiWorkspace.startSession(currentTarget.workspaceId as WorkspaceId)
            pendingTarget = undefined
            return true
          }
          pendingTarget = undefined
          return true
        }
        if (tryBind()) return
        const unsub = readyCtx.sessions.list.subscribe(() => {
          if (tryBind()) unsub()
        })
        readyCtx.effect(() => unsub, 'vscode-ui-layout: pending conversation binding')
      })
      stopPendingNavigation = () => { void fiber.dispose() }
    }

    const disposeBridgeListeners: Array<() => void> = []
    if (bridge !== undefined) {
      if (mode === 'editor') {
        if (pendingTarget !== undefined) applyEditorTarget(pendingTarget)
        disposeBridgeListeners.push(bridge.onNavigate(applyEditorTarget))
      } else if (mode === 'sidebar') {
        disposeBridgeListeners.push(bridge.onActiveTabChanged(({ panelId }) => {
          if (panelId === undefined) return
          layout.syncLocalPanel(panelId as MainPanelId | null)
        }))
      }
    }

    return () => {
      clearPendingNavigation()
      for (const dispose of disposeBridgeListeners) dispose()
      layout.dispose()
      disposePanels()
      disposeSettingsTab()
      disposeRegistration()
      disposePanelInfo()
      void disposeService()
    }
  }, 'vscode-ui-layout: service + root registration')

  ctx.effect(() => {
    const presenter = new VsCodeThemePresenter()
    presenter.start()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'vscode-ui-layout: theme presenter')
}
