/**
 * Read-only Host plugin inventory panel rendered inside the VS Code Settings dialog.
 *
 * Reads live `pluginInventory.list()` from the Host and displays:
 * - Session plugins per Agent preset (`persona`, `tool-bash`, `tool-fs`, `tool-web`, `plan-mode`, `skill`, ...)
 * - Global plugins shared across the system and all sessions (`llm`, `session`, `settings`, `api-gateway`, ...)
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutlineRegular,
  IconSearchOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { VsCodeUiKey } from './locales.ts'
import css from './PluginInventoryPanel.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type AgentPresetGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
type AgentPresetRow = AgentPresetGroup['rows'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

export interface PluginInventoryPanelProps {
  readonly list: () => Promise<PluginInventorySnapshot>
  readonly presetName: (preset: AgentPresetGroup) => string
  readonly resolveText: (text: NonNullable<NonNullable<PluginInventoryEntry['meta']>['description']>) => string
  readonly t: (key: VsCodeUiKey, params?: Readonly<Record<string, string>>) => string
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'inventory.pending',
  loading: 'inventory.loadingPhase',
  active: 'inventory.active',
  failed: 'inventory.failed',
  unloading: 'inventory.unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, VsCodeUiKey>

function phaseLabel(phase: PluginFiberPhase, t: PluginInventoryPanelProps['t']): string {
  return phase === null ? t('inventory.unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a Cordis/DSH module specifier into the short plugin name (e.g. `persona`, `tool-bash`). */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

function matches(
  moduleName: string,
  entryId: string | null,
  displayTitle: string | undefined,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) return true
  return [
    moduleName,
    moduleShortName(moduleName),
    ...entryId === null ? [] : [entryId],
    ...displayTitle === undefined ? [] : [displayTitle],
  ].some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

function fallbackPreset(presets: readonly AgentPresetGroup[]): AgentPresetGroup | undefined {
  return presets.find(preset => preset.isDefault) ?? presets[0]
}

function presetLabel(
  preset: AgentPresetGroup,
  t: PluginInventoryPanelProps['t'],
  presetName: (preset: AgentPresetGroup) => string,
): string {
  const name = presetName(preset)
  if (preset.broken !== undefined) return t('inventory.presetOptionBroken', { name })
  if (preset.isDefault) return t('inventory.presetOptionDefault', { name })
  return name
}

function PluginCard({
  rowKey,
  moduleName,
  entryId,
  trailing,
  ariaLabel,
  failed,
  expanded,
  onToggle,
  children,
}: {
  readonly rowKey: string
  readonly moduleName: string
  readonly entryId: string | null
  readonly trailing: ReactNode
  readonly ariaLabel: string
  readonly failed: boolean
  readonly expanded: string | null
  readonly onToggle: (key: string) => void
  readonly children: ReactNode
}): ReactNode {
  const open = expanded === rowKey
  const detailId = `plugin-details-${encodeURIComponent(rowKey)}`
  return (
    <li
      className={css.card}
      data-plugin-entry={entryId ?? undefined}
      data-plugin-module={moduleName}
      data-failed={failed ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <button
        className={css.cardContent}
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={ariaLabel}
        onClick={() => { onToggle(rowKey) }}
      >
        <strong className={css.cardTitle} title={moduleName}>{moduleShortName(moduleName)}</strong>
        <span className={css.cardTrailing}>
          {trailing}
          <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
        </span>
      </button>
      {open ? <div className={css.cardDetails} id={detailId}>{children}</div> : null}
    </li>
  )
}

function CardFacts({
  moduleName,
  moduleLabel,
  entryId,
  facts,
}: {
  readonly moduleName: string
  readonly moduleLabel: string
  readonly entryId: string | null
  readonly facts: readonly (readonly [label: string, value: ReactNode])[]
}): ReactNode {
  return (
    <>
      {entryId === null ? null : <code className={css.entryValue} data-loader-entry>{entryId}</code>}
      <dl className={css.details}>
        <div>
          <dt>{moduleLabel}</dt>
          <dd>{moduleName}</dd>
        </div>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

function PhaseDot({
  phase,
  t,
}: {
  readonly phase: NonNullable<PluginFiberPhase>
  readonly t: PluginInventoryPanelProps['t']
}): ReactNode {
  const status = phaseLabel(phase, t)
  return (
    <span
      className={css.statusDot}
      data-phase={phase}
      role="img"
      aria-label={status}
      title={status}
    />
  )
}

function StateTag({ kind, label }: { readonly kind: string; readonly label: string }): ReactNode {
  return <span className={css.configTag} data-kind={kind}>{label}</span>
}

export function PluginInventoryPanel({
  list,
  presetName,
  resolveText,
  t,
}: PluginInventoryPanelProps): ReactNode {
  const sectionId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [chosenPreset, setChosenPreset] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState<boolean | null>(null)
  const [globalOpen, setGlobalOpen] = useState<boolean | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      (error: unknown) => {
        console.error('PluginInventoryPanel failed to load inventory:', error)
        if (current) setState({ status: 'error' })
      },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const presets = snapshot?.agentPresets ?? []
  const selected = presets.find(preset => preset.id === chosenPreset) ?? fallbackPreset(presets)

  const enabledIn = useMemo(() => {
    const found = new Map<string, [AgentPresetGroup, ...AgentPresetGroup[]]>()
    for (const preset of presets) {
      for (const row of preset.rows) {
        if (row.enabled !== true) continue
        const groups = found.get(row.moduleName)
        if (groups === undefined) found.set(row.moduleName, [preset])
        else if (!groups.includes(preset)) groups.push(preset)
      }
    }
    return found
  }, [presets])

  const entries = snapshot?.entries ?? []
  const failedEntries: PluginInventoryEntry[] = []
  const regularEntries: PluginInventoryEntry[] = []
  for (const entry of entries) {
    if (entry.fiberPhase === 'failed') failedEntries.push(entry)
    else regularEntries.push(entry)
  }

  const titleOf = (meta: PluginInventoryEntry['meta']): string | undefined =>
    meta?.title === undefined ? undefined : resolveText(meta.title) || undefined
  const descOf = (meta: PluginInventoryEntry['meta']): string | undefined =>
    meta?.description === undefined ? undefined : resolveText(meta.description) || undefined

  const entryMatch = (entry: PluginInventoryEntry): boolean =>
    matches(entry.moduleName, entry.entryId, titleOf(entry.meta), normalizedQuery)
  const rowMatch = (row: AgentPresetRow): boolean =>
    matches(row.moduleName, row.entryId, titleOf(row.meta), normalizedQuery)

  const filteredFailed = failedEntries.filter(entryMatch)
  const filteredRegular = regularEntries.filter(entryMatch)
  const globalCount = filteredFailed.length + filteredRegular.length
  const selectedRows = selected === undefined ? [] : selected.rows.filter(rowMatch)
  const otherPresetMatches = searching
    ? presets.filter(preset => preset !== selected && preset.rows.some(rowMatch))
    : []
  const otherMatchCount = otherPresetMatches
    .reduce((total, preset) => total + preset.rows.filter(rowMatch).length, 0)

  // Both Session (preset) plugins and Global plugins open by default so both groups are immediately visible.
  const presetEffectiveOpen = searching || (presetOpen ?? true)
  const globalEffectiveOpen = searching || (globalOpen ?? true)
  const nothingMatches = searching && globalCount === 0 && selectedRows.length === 0
    && otherPresetMatches.length === 0

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }
  const toggleRow = (key: string): void => {
    setExpanded(current => current === key ? null : key)
  }

  const presetRowCard = (preset: AgentPresetGroup, row: AgentPresetRow, index: number): ReactNode => {
    const key = `preset:${preset.id}:${String(index)}`
    const title = moduleShortName(row.moduleName)
    const failed = row.fiberPhase === 'failed'
    const stateText = failed
      ? t('inventory.failedTag')
      : row.enabled === true
        ? t('inventory.enabledTag')
        : row.enabled === false
          ? t('inventory.disabledTag')
          : t('inventory.conditionalTag')
    const kind = failed ? 'failed' : row.enabled === true ? 'enabled' : row.enabled === false ? 'disabled' : 'conditional'
    const description = descOf(row.meta)
    return (
      <PluginCard
        key={key}
        rowKey={key}
        moduleName={row.moduleName}
        entryId={row.entryId}
        failed={failed}
        expanded={expanded}
        onToggle={toggleRow}
        ariaLabel={`${title}, ${stateText}`}
        trailing={(
          <>
            {row.enabled === true && !failed && row.fiberPhase !== null
              ? <PhaseDot phase={row.fiberPhase} t={t} />
              : null}
            <StateTag kind={kind} label={stateText} />
          </>
        )}
      >
        <CardFacts
          moduleName={row.moduleName}
          moduleLabel={t('inventory.moduleLabel')}
          entryId={row.entryId}
          facts={[
            ...description === undefined ? [] : [[t('inventory.descriptionLabel'), description] as const],
            [t('inventory.fromPreset'), presetName(preset)],
            [t('inventory.configuration'), stateText],
            ...row.fiberPhase === null ? [] : [[t('inventory.runtime'), phaseLabel(row.fiberPhase, t)] as const],
            ...row.condition === undefined ? [] : [[t('inventory.condition'), <code key="condition">{row.condition}</code>] as const],
          ]}
        />
      </PluginCard>
    )
  }

  const globalRowCard = (
    entry: PluginInventoryEntry,
    providers?: readonly [AgentPresetGroup, ...AgentPresetGroup[]],
  ): ReactNode => {
    const key = `global:${entry.entryId}`
    const title = moduleShortName(entry.moduleName)
    const failed = entry.fiberPhase === 'failed'
    const stateText = failed
      ? t('inventory.failedTag')
      : providers !== undefined
        ? t('inventory.presetEnabledTag')
        : t(entry.enabled ? 'inventory.enabledTag' : 'inventory.disabledTag')
    const kind = failed ? 'failed' : providers !== undefined ? 'preset' : entry.enabled ? 'enabled' : 'disabled'
    const description = descOf(entry.meta)
    return (
      <PluginCard
        key={key}
        rowKey={key}
        moduleName={entry.moduleName}
        entryId={entry.entryId}
        failed={failed}
        expanded={expanded}
        onToggle={toggleRow}
        ariaLabel={`${title}, ${stateText}`}
        trailing={(
          <>
            {entry.enabled && !failed && entry.fiberPhase !== null
              ? <PhaseDot phase={entry.fiberPhase} t={t} />
              : null}
            <StateTag kind={kind} label={stateText} />
          </>
        )}
      >
        <CardFacts
          moduleName={entry.moduleName}
          moduleLabel={t('inventory.moduleLabel')}
          entryId={entry.entryId}
          facts={providers !== undefined
            ? [
              ...description === undefined ? [] : [[t('inventory.descriptionLabel'), description] as const],
              [t('inventory.configuration'), t('inventory.presetProvidedDetail')],
              [t('inventory.enabledIn'), (
                <span className={css.enabledIn}>
                  <span>{providers.map(preset => presetName(preset)).join(' · ')}</span>
                  <button
                    type="button"
                    className={css.jumpLink}
                    onClick={() => {
                      setChosenPreset(providers[0].id)
                      setPresetOpen(true)
                    }}
                  >
                    {t('inventory.viewInPreset')}
                  </button>
                </span>
              )],
            ]
            : [
              ...description === undefined ? [] : [[t('inventory.descriptionLabel'), description] as const],
              [t('inventory.configuration'), t(entry.enabled ? 'inventory.enabledTag' : 'inventory.disabledTag')],
              ...entry.enabled ? [[t('inventory.runtime'), phaseLabel(entry.fiberPhase, t)] as const] : [],
              ...entry.diagnostic === undefined ? [] : [[t('inventory.diagnosticLabel'), entry.diagnostic] as const],
            ]}
        />
      </PluginCard>
    )
  }

  return (
    <div className={css.section} data-vscode-plugin-inventory aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('inventory.loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('inventory.error')}</p>
          <button type="button" onClick={retry}>{t('inventory.retry')}</button>
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutlineRegular size={16} aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('inventory.search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('inventory.search')}
              aria-label={t('inventory.search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          {entries.length === 0 && presets.length === 0 ? <p className={css.status}>{t('inventory.empty')}</p> : null}
          {nothingMatches ? <p className={css.status}>{t('inventory.emptySearch')}</p> : null}

          {selected !== undefined ? (
            <section className={css.group} data-plugin-scope="preset" data-preset-id={selected.id}>
              <div className={css.groupTitleRow}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={presetEffectiveOpen}
                  aria-controls={`${sectionId}-preset`}
                  onClick={() => { setPresetOpen(!presetEffectiveOpen) }}
                >
                  <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
                  <span className={css.groupTitle}>{t('inventory.presetTitle')}</span>
                </button>
                <div className={css.headerEnd}>
                  <Menu
                    open={switcherOpen}
                    onClose={() => { setSwitcherOpen(false) }}
                    items={presets.map(preset => ({ id: preset.id, label: presetLabel(preset, t, presetName) }))}
                    selectedId={selected.id}
                    onSelect={(id) => {
                      setSwitcherOpen(false)
                      setChosenPreset(id)
                    }}
                    align="end"
                    portal
                    anchor={(
                      <button
                        type="button"
                        className={css.switcher}
                        aria-haspopup="menu"
                        aria-expanded={switcherOpen}
                        aria-label={t('inventory.switcherLabel')}
                        onClick={() => { setSwitcherOpen(value => !value) }}
                      >
                        <span className={css.switcherLabel}>{presetLabel(selected, t, presetName)}</span>
                        <IconChevronDownOutlineRegular className={css.chevron} size={14} aria-hidden="true" />
                      </button>
                    )}
                  />
                </div>
              </div>
              <p className={css.groupSub}>
                {t('inventory.presetSubtitle')}
                <span data-preset-plugin-count={selectedRows.length}>
                  {` · ${String(selectedRows.length)} ${t('inventory.countUnit')}`}
                </span>
              </p>
              {presetEffectiveOpen ? (
                <div id={`${sectionId}-preset`} className={css.groupBody}>
                  {selected.broken !== undefined ? (
                    <p className={css.brokenNote} role="alert">{selected.broken}</p>
                  ) : null}
                  {selectedRows.length > 0 ? (
                    <ul className={css.cards}>
                      {selectedRows.map((row, index) => presetRowCard(selected, row, index))}
                    </ul>
                  ) : null}
                  {otherMatchCount > 0 ? (
                    <p className={css.hint}>
                      {t('inventory.matchesInOtherPresets', { count: String(otherMatchCount) })}
                      {otherPresetMatches.map(preset => (
                        <button
                          key={preset.id}
                          type="button"
                          className={css.jumpLink}
                          onClick={() => { setChosenPreset(preset.id) }}
                        >
                          {presetName(preset)}
                        </button>
                      ))}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {entries.length > 0 ? (
            <section className={css.group} data-plugin-scope="global">
              <div className={css.groupTitleRow}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={globalEffectiveOpen}
                  aria-controls={`${sectionId}-global`}
                  onClick={() => { setGlobalOpen(!globalEffectiveOpen) }}
                >
                  <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
                  <span className={css.groupTitle}>{t('inventory.globalTitle')}</span>
                </button>
              </div>
              <p className={css.groupSub}>
                {t('inventory.globalSubtitle')}
                <span data-plugin-count={globalCount}>{` · ${String(globalCount)} ${t('inventory.countUnit')}`}</span>
                {filteredFailed.length > 0 ? (
                  <span className={css.failedCount}>{filteredFailed.length} {t('inventory.failedCountLabel')}</span>
                ) : null}
              </p>
              {globalEffectiveOpen && globalCount > 0 ? (
                <ul className={css.cards} id={`${sectionId}-global`}>
                  {filteredFailed.map(entry => globalRowCard(entry))}
                  {filteredRegular.map(entry => globalRowCard(
                    entry,
                    entry.enabled ? undefined : enabledIn.get(entry.moduleName),
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
