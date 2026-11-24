/**
 * VS Code split-surface layout and sidebar plugin (`@deepseek-ai/dsh-vscode-ui-layout`).
 *
 * Replaces both `@deepseek-ai/dsh-client-ui-layout` and `@deepseek-ai/dsh-client-ui-sidebar`
 * in the VS Code profile while preserving the exact `ctx.layout` service interface and
 * child slot contracts (`sidebar.panellist`, `sidebar.workspaces`, `settings.section.view`, etc.)
 * so official vendor plugins (`ui-workspace`, `ui-chat`, `ui-settings-models`, `ui-plugin-manager`,
 * `ui-schedule`, etc.) work without modification.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {
  SidebarPanelMetadata,
  SidebarSectionInjected,
} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel, type HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { getVsCodeBridge, type VsCodeNavigateTarget } from './bridge.ts'
import { de, en, es, fr, ja, pt, ru, zh, type VsCodeUiKey } from './locales.ts'
import { VsCodeLayoutController } from './service.ts'
import { createVsCodeLayoutStore } from './stores.ts'
import { VsCodeThemePresenter } from './theme-presenter.ts'
import { VsCodeFrame, type VsCodeFrameInjected } from './VsCodeFrame.tsx'
import {
  VsCodePanelIcon,
  VsCodePanelTrailing,
  VsCodeSidebarRoot,
  type VsCodeSidebarInjected,
} from './VsCodeSidebarRoot.tsx'
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

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** VS Code sidebar toolbar and Settings dialog copy. */
    vscodeUi: VsCodeUiKey
  }
}

const NS = 'vscodeUi'
export const SETTINGS_PANEL_ID = 'vscode-settings' as MainPanelId

const SIDEBAR_SECTION_INJECT: SidebarSectionInjected = {
  hooks: { sectionScroller: (_standard, { useSectionScroller }) => useSectionScroller },
}

/** Required services (same core dependencies as official `ui-layout`). */
export const inject = ['slots', 'theme', 'locale', 'shortcuts']

export function apply(ctx: ClientContext): void {
  const bridge = getVsCodeBridge()
  const mode = bridge?.surface.mode ?? 'standalone'

  ctx.effect(
    () => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }),
    'vscode-ui-layout: dictionaries',
  )
  const t = ctx.locale.bind(NS)

  const resolvePanelTitle = (panelId: string): string => {
    if (panelId === SETTINGS_PANEL_ID) return t('settings.title')
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
                bridge.openConversation(undefined, t('session.new'))
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

    // Sidebar shell: compact top toolbar (New Session + right-aligned plugin icons + Settings gear)
    // above stock `sidebar.workspaces`, with no DSH logo and no bottom account/settings footer.
    const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])
    const syncPanels = (): void => {
      const next = ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => {
        const id = options.id as MainPanelId
        return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }
      }).sort((a, b) => a.order - b.order)
      const previous = panels.getSnapshot()
      if (previous.length === next.length && previous.every((panel, index) => {
        const candidate = next[index] as SidebarPanelMetadata
        return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
      })) return
      panels.set(next)
    }
    const disposePanelIconFactory = ctx.slots.registerFactory({
      name: 'sidebar.panel.icon',
      scope: 'root',
      children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } },
    }, VsCodePanelIcon)
    const disposePanelTrailingFactory = ctx.slots.registerFactory({
      name: 'sidebar.panel.trailing',
      scope: 'root',
      children: { 'sidebar.panellist.trailing': { kind: 'list', scope: 'root', inline: true } },
    }, VsCodePanelTrailing)
    const disposeSidebar = ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      children: {
        'sidebar.workspaces': { kind: 'single', scope: 'root', inject: SIDEBAR_SECTION_INJECT },
        'sidebar.session.action': { kind: 'hoc', scope: 'root' },
      },
      inject: (): VsCodeSidebarInjected => ({
        settingsPanelId: SETTINGS_PANEL_ID,
        startSession: (workspaceId) => {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace !== undefined) {
            uiWorkspace.startSession(workspaceId)
          } else {
            bridge?.openConversation(undefined, t('session.new'), workspaceId)
          }
        },
        selectPanel: (id) => { layout.selectPanel(id) },
        openSettings: () => { layout.selectPanel(SETTINGS_PANEL_ID) },
        hooks: { panels },
      }),
    }, VsCodeSidebarRoot)
    const offPanelSlots = ctx.slots.subscribe('sidebar.panellist', syncPanels)
    const offPanelLocale = ctx.locale.subscribe(syncPanels)
    syncPanels()

    // Right-side Settings dialog rendered inside a VS Code Editor Tab (`vscode-settings`).
    // Places Models (third-party / custom model configuration) first and filters out DeepSeek account.
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
              order: entry.options.id === 'models' ? -1 : (entry.options.order ?? 0),
              label: resolveSlotLabel(entry.options.label) ?? entry.options.id ?? '',
            }))
            .filter(row => row.id.length > 0 && row.id !== 'account')
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
      locale: NS,
      inject: (): SettingsTabPanelInjected => ({
        onClose: () => {
          if (bridge !== undefined) bridge.closeTab()
          else layout.selectPanel(null)
        },
        hooks: { sections: settingsSections },
      }),
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
      offPanelSlots()
      offPanelLocale()
      disposeSidebar()
      disposePanelTrailingFactory()
      disposePanelIconFactory()
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
