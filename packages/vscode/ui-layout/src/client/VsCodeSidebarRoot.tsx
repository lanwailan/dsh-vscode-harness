/**
 * Compact VS Code sidebar shell replacing `@deepseek-ai/dsh-client-ui-sidebar`:
 * - No DSH logo header.
 * - Row 1: New Session button on the left; right-aligned icon entries for registered
 *   global panels (Plugins, Schedules, etc.) followed by the Settings gear icon on the far right.
 * - Main body: stock `sidebar.workspaces` slot (Workspaces & Sessions) preserved intact.
 * - No bottom account/settings footer.
 */
import { useMemo, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  IconNewChatOutlineMedium,
  IconSettingsOutlineMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FactoryComponentPropsOf,
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRenderFactories,
  PropsRenderSlots,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  SidebarPanelMetadata,
  SidebarSectionHookContext,
} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createScrollHandoff } from './scroll-handoff.ts'
import css from './VsCodeSidebarRoot.module.css'

export interface VsCodeSidebarInjected {
  readonly settingsPanelId: MainPanelId
  readonly startSession: (workspaceId?: WorkspaceId) => void
  readonly selectPanel: (id: MainPanelId) => void
  readonly openSettings: () => void
  readonly hooks: {
    readonly panels: HostObservable<readonly SidebarPanelMetadata[]>
  }
}

export type VsCodeSidebarRootProps =
  & PropsRuntime<'sidebar'>
  & PropsRenderSlots<'sidebar.workspaces' | 'sidebar.session.action'>
  & PropsRenderFactories
  & PropsLocale<'vscodeUi'>
  & InjectFace<VsCodeSidebarInjected>

/** Shared panel icon factory matching `sidebar.panel.icon` contract. */
export function VsCodePanelIcon({ id, size, active, renderSlot }: FactoryComponentPropsOf<'sidebar.panel.icon'>): ReactNode {
  return renderSlot('sidebar.panellist', { size, active }, { only: id })
}

/** Shared panel trailing factory matching `sidebar.panel.trailing` contract. */
export function VsCodePanelTrailing({ id, wide, active, renderSlot }: FactoryComponentPropsOf<'sidebar.panel.trailing'>): ReactNode {
  return renderSlot('sidebar.panellist.trailing', { wide, active }, { only: id })
}

function PanelIconButton({
  id,
  label,
  usePanelInfo,
  selectPanel,
  renderFactorySlot,
}: Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<VsCodeSidebarInjected>, 'selectPanel'>
  & PropsRenderFactories): ReactNode {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <Tooltip label={label} side="bottom" delayMs={300} portal>
      <button
        type="button"
        className={`${css.iconButton}${active ? ` ${css.iconButtonActive}` : ''}`}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        data-vscode-panel-entry={id}
        onClick={() => { selectPanel(id) }}
      >
        {renderFactorySlot('sidebar.panel.icon', { id, size: 16, active })}
      </button>
    </Tooltip>
  )
}

export function VsCodeSidebarRoot({
  settingsPanelId,
  startSession,
  selectPanel,
  openSettings,
  usePanels,
  usePanelInfo,
  useRemoteAccess,
  t,
  renderSlot,
  renderFactorySlot,
}: VsCodeSidebarRootProps): ReactNode {
  const panels = usePanels(snapshot => snapshot)
  const canStartSession = useRemoteAccess('session/create')
  const settingsActive = usePanelInfo(info => info.activePanelId === settingsPanelId)
  const [scrollHandoff] = useState(createScrollHandoff)
  const sectionHookContext = useMemo<SidebarSectionHookContext>(
    () => ({ useSectionScroller: scrollHandoff.useSectionScroller }),
    [scrollHandoff],
  )

  const [pointerInside, setPointerInside] = useState(false)
  const trackPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setPointerInside(
      event.clientX >= rect.left && event.clientX < rect.right
      && event.clientY >= rect.top && event.clientY < rect.bottom,
    )
  }

  return (
    <div
      className={`${css.root}${pointerInside ? '' : ` ${css.quietBars}`}`}
      data-vscode-sidebar-root
      onPointerEnter={trackPointer}
      onPointerMove={trackPointer}
      onPointerLeave={() => { setPointerInside(false) }}
    >
      <div className={css.toolbar} data-vscode-sidebar-toolbar>
        {canStartSession && (
          <div className={css.newSessionSlot}>
            {renderSlot('sidebar.session.action', { wide: true }, {
              children: (
                <button
                  type="button"
                  className={css.newSession}
                  aria-label={t('session.new.label')}
                  data-vscode-new-session
                  onClick={() => { startSession() }}
                >
                  <IconNewChatOutlineMedium size={14} />
                  <span className={css.newSessionLabel}>{t('session.new')}</span>
                </button>
              ),
            })}
          </div>
        )}

        <nav className={css.trailingIcons} aria-label={t('panels.label')}>
          {panels.map(({ id, label }) => (
            <PanelIconButton
              key={id}
              id={id}
              label={label}
              usePanelInfo={usePanelInfo}
              selectPanel={selectPanel}
              renderFactorySlot={renderFactorySlot}
            />
          ))}

          <Tooltip label={t('settings.label')} side="bottom" align="end" delayMs={300} portal>
            <button
              type="button"
              className={`${css.iconButton}${settingsActive ? ` ${css.iconButtonActive}` : ''}`}
              aria-label={t('settings.label')}
              aria-current={settingsActive ? 'page' : undefined}
              data-vscode-open-settings
              onClick={openSettings}
            >
              <IconSettingsOutlineMedium size={16} />
            </button>
          </Tooltip>
        </nav>
      </div>

      <div className={css.scrollRegion}>
        <div
          ref={scrollHandoff.bindViewportRef}
          className={css.scrollArea}
          data-sidebar-scrollport=""
        >
          <div className={css.regionArea}>
            {renderSlot('sidebar.workspaces', {
              wide: true,
              expandSidebar: () => {},
            }, { hookContext: sectionHookContext })}
          </div>
        </div>
        <span className={css.scrollFade} aria-hidden="true" />
      </div>
    </div>
  )
}
