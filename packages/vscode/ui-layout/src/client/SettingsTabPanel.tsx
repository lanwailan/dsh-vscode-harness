/** Full-width Settings panel rendered inside a VS Code Editor Tab (`vscode-settings`). */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  HostObservable, InjectFace, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import css from './SettingsTabPanel.module.css'

export interface SettingsTabSectionRow {
  readonly id: string
  readonly order: number
  readonly label: string
}

export interface SettingsTabPanelInjected {
  readonly hooks: {
    readonly sections: HostObservable<readonly SettingsTabSectionRow[]>
  }
}

export type SettingsTabPanelProps =
  & PropsRuntime<'main'>
  & PropsRenderFactories
  & InjectFace<SettingsTabPanelInjected>

const NOOP_CLOSE = (): void => {}

export function SettingsTabPanel({
  useSections,
  renderFactorySlot,
}: SettingsTabPanelProps): ReactNode {
  const rows = useSections(snapshot => snapshot)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const activeId = rows.find(row => row.id === selectedId)?.id ?? rows[0]?.id

  return (
    <div className={css.root}>
      <nav className={css.nav} aria-label="Settings">
        <div className={css.heading}>DeepSeek Harness Settings</div>
        {rows.map(row => (
          <button
            key={row.id}
            type="button"
            className={`${css.navItem}${row.id === activeId ? ` ${css.navItemActive}` : ''}`}
            aria-current={row.id === activeId ? 'page' : undefined}
            onClick={() => { setSelectedId(row.id) }}
          >
            {row.label || row.id}
          </button>
        ))}
      </nav>
      <div className={css.content}>
        {activeId !== undefined
          ? renderFactorySlot('settings.section.view', { id: activeId, close: NOOP_CLOSE })
          : <div className={css.empty}>Loading settings…</div>}
      </div>
    </div>
  )
}
