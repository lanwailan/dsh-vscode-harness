/** Right-side Settings dialog rendered inside a VS Code Editor Tab (`vscode-settings`). */
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconAgentPresetOutlineMedium,
  IconArchiveOutlineMedium,
  IconCloseOutlineRegular,
  IconDataOutlineMedium,
  IconPersonalizationOutlineMedium,
  IconRemoteConnectionOutlineMedium,
  IconSettingsOutlineMedium,
  SegmentedTabs,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { VsCodeUiKey } from './locales.ts'
import { PluginInventoryPanel } from './PluginInventoryPanel.tsx'
import css from './SettingsTabPanel.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type AgentPresetGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
type BuiltinPluginsTab = 'inventory' | 'config'

export interface SettingsTabSectionRow {
  readonly id: string
  readonly order: number
  readonly label: string
}

export interface SettingsTabPanelProps extends PropsRenderFactories {
  readonly rows: readonly SettingsTabSectionRow[]
  readonly onClose: () => void
  readonly renderActions: () => ReactNode
  readonly renderSectionIcon: (id: string, active: boolean, fallback: ReactNode) => ReactNode
  readonly renderPluginsPanel: () => ReactNode
  readonly listPluginInventory: () => Promise<PluginInventorySnapshot>
  readonly resolvePresetName: (preset: AgentPresetGroup) => string
  readonly resolveLocalizedText: (
    text: NonNullable<NonNullable<PluginInventoryEntry['meta']>['description']>,
  ) => string
  readonly t: (key: VsCodeUiKey, params?: Readonly<Record<string, string>>) => string
}

function defaultNavIcon(id: string): ReactNode {
  if (id === 'models') return <IconDataOutlineMedium size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium size={16} />
  if (id === 'remote-connection') return <IconRemoteConnectionOutlineMedium size={16} />
  return <IconSettingsOutlineMedium size={16} />
}

export function SettingsTabPanel({
  rows,
  onClose,
  renderFactorySlot,
  renderActions,
  renderSectionIcon,
  renderPluginsPanel,
  listPluginInventory,
  resolvePresetName,
  resolveLocalizedText,
  t,
}: SettingsTabPanelProps): ReactNode {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [pluginsTab, setPluginsTab] = useState<BuiltinPluginsTab>('inventory')
  const tabsId = useId()
  const defaultRow = rows.find(row => row.id === 'models') ?? rows[0]
  const activeRow = rows.find(row => row.id === selectedId) ?? defaultRow
  const activeId = activeRow?.id
  const isEmbeddedPlugins = activeId === 'plugins'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Let nested confirmation/provider/shortcut modals handle Escape first.
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
        data-shortcut-modal="settings"
        data-vscode-settings-dialog
      >
        <div className={css.navTitle}>{t('settings.title')}</div>
        <div className={css.header}>
          <div className={css.headerActions}>{renderActions()}</div>
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
          {rows.map((row) => {
            const active = row.id === activeId
            return (
              <button
                key={row.id}
                type="button"
                className={`${css.navItem}${active ? ` ${css.navItemActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
                data-vscode-settings-nav={row.id}
                onClick={() => { setSelectedId(row.id) }}
              >
                <span className={css.navIcon} aria-hidden="true">
                  {renderSectionIcon(row.id, active, defaultNavIcon(row.id))}
                </span>
                <span className={css.navLabel}>
                  {row.id === 'plugins' ? t('settings.builtinPlugins') : row.label || row.id}
                </span>
              </button>
            )
          })}
        </nav>

        <div
          className={isEmbeddedPlugins ? css.contentEmbedded : css.content}
          data-vscode-builtin-plugins={isEmbeddedPlugins || undefined}
          data-vscode-plugins-tab={isEmbeddedPlugins ? pluginsTab : undefined}
        >
          {activeId === undefined
            ? <div className={css.empty}>{t('settings.loading')}</div>
            : isEmbeddedPlugins
              ? (
                <>
                  <div className={css.embeddedHeader}>
                    <h2 className={css.embeddedTitle}>{t('settings.builtinPlugins')}</h2>
                    <SegmentedTabs
                      size="sm"
                      label={t('plugins.tabs.label')}
                      value={pluginsTab}
                      onChange={setPluginsTab}
                      items={[
                        {
                          value: 'inventory',
                          label: t('plugins.tab.inventory'),
                          id: `${tabsId}-tab-inventory`,
                          panelId: `${tabsId}-panel-inventory`,
                        },
                        {
                          value: 'config',
                          label: t('plugins.tab.config'),
                          id: `${tabsId}-tab-config`,
                          panelId: `${tabsId}-panel-config`,
                        },
                      ]}
                    />
                  </div>
                  {pluginsTab === 'inventory'
                    ? (
                      <div
                        id={`${tabsId}-panel-inventory`}
                        role="tabpanel"
                        aria-labelledby={`${tabsId}-tab-inventory`}
                        className={css.inventoryBody}
                      >
                        <PluginInventoryPanel
                          list={listPluginInventory}
                          presetName={resolvePresetName}
                          resolveText={resolveLocalizedText}
                          t={t}
                        />
                      </div>
                    )
                    : (
                      <div
                        id={`${tabsId}-panel-config`}
                        role="tabpanel"
                        aria-labelledby={`${tabsId}-tab-config`}
                        className={css.embeddedBody}
                      >
                        {renderPluginsPanel()}
                      </div>
                    )}
                </>
              )
              : renderFactorySlot('settings.section.view', { id: activeId, close: onClose })}
        </div>
      </div>
    </div>
  )
}
