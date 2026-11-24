/** Right-side Settings dialog rendered inside a VS Code Editor Tab (`vscode-settings`). */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconAgentPresetOutlineMedium,
  IconArchiveOutlineMedium,
  IconCloseOutlineRegular,
  IconDataOutlineMedium,
  IconPersonalizationOutlineMedium,
  IconRemoteConnectionOutlineMedium,
  IconSettingsOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import css from './SettingsTabPanel.module.css'

export interface SettingsTabSectionRow {
  readonly id: string
  readonly order: number
  readonly label: string
}

export interface SettingsTabPanelInjected {
  readonly onClose: () => void
  readonly hooks: {
    readonly sections: HostObservable<readonly SettingsTabSectionRow[]>
  }
}

export type SettingsTabPanelProps =
  & PropsRuntime<'main'>
  & PropsRenderFactories
  & PropsLocale<'vscodeUi'>
  & InjectFace<SettingsTabPanelInjected>

function navIcon(id: string): ReactNode {
  if (id === 'models') return <IconDataOutlineMedium size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium size={16} />
  if (id === 'remote-connection') return <IconRemoteConnectionOutlineMedium size={16} />
  return <IconSettingsOutlineMedium size={16} />
}

export function SettingsTabPanel({
  onClose,
  useSections,
  renderFactorySlot,
  t,
}: SettingsTabPanelProps): ReactNode {
  const rows = useSections(snapshot => snapshot)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const defaultRow = rows.find(row => row.id === 'models') ?? rows[0]
  const activeRow = rows.find(row => row.id === selectedId) ?? defaultRow
  const activeId = activeRow?.id

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Let nested confirmation/provider modals handle Escape first.
      const nestedDialogs = document.querySelectorAll('[role="dialog"]:not([data-vscode-settings-dialog])')
      if (nestedDialogs.length > 0) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  return (
    <div
      className={css.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        data-vscode-settings-dialog
      >
        <div className={css.navTitle}>{t('settings.title')}</div>
        <div className={css.header}>
          <button
            type="button"
            className={css.closeButton}
            aria-label={t('settings.close')}
            data-vscode-settings-close
            onClick={onClose}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>

        <nav className={css.nav} aria-label={t('settings.title')}>
          {rows.map(row => (
            <button
              key={row.id}
              type="button"
              className={`${css.navItem}${row.id === activeId ? ` ${css.navItemActive}` : ''}`}
              aria-current={row.id === activeId ? 'page' : undefined}
              data-vscode-settings-nav={row.id}
              onClick={() => { setSelectedId(row.id) }}
            >
              <span className={css.navIcon} aria-hidden="true">{navIcon(row.id)}</span>
              <span className={css.navLabel}>{row.label || row.id}</span>
            </button>
          ))}
        </nav>

        <div className={css.content}>
          {activeId !== undefined
            ? renderFactorySlot('settings.section.view', { id: activeId, close: onClose })
            : <div className={css.empty}>{t('settings.loading')}</div>}
        </div>
      </div>
    </div>
  )
}
