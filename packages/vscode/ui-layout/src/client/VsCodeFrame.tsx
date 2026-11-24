/**
 * VS Code split-surface root frame:
 * - In `sidebar` mode (VS Code Activity Bar view): renders DSH's left sidebar at 100% width.
 * - In `editor` mode (VS Code Editor Tab): renders DSH's main panel (Conversation / Plugins / Schedules / Settings)
 *   plus the optional rightbar track (used only for Plan / Changed-Files Review).
 * - Outside VS Code (plain browser fallback): renders both sidebar and main panel side-by-side.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { VsCodeBridge, VsCodeSurfaceMode } from './bridge.ts'
import {
  CENTER_MIN, clampWidth, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  type createVsCodeLayoutStore,
} from './stores.ts'
import css from './VsCodeFrame.module.css'

export interface VsCodeFrameInjected {
  readonly mode: VsCodeSurfaceMode | 'standalone'
  readonly bridge: VsCodeBridge | undefined
  readonly resolvePanelTitle: (panelId: string) => string
}

export type VsCodeFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay' | 'shell.leading'>
  & PropsStore<ReturnType<typeof createVsCodeLayoutStore>>
  & PropsLocale<'common'>
  & InjectFace<VsCodeFrameInjected>

function MainPanel({
  usePanelInfo,
  renderSlot,
}: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>): ReactNode {
  const panelId = usePanelInfo(info => info.activePanelId)
  return (
    <div className={css.mainPanel} data-global-panel={panelId !== null || undefined}>
      {renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })}
    </div>
  )
}

function EditorTabTitleSync({
  bridge,
  useSessions,
  usePanelInfo,
  resolvePanelTitle,
}: {
  readonly bridge: VsCodeBridge
  readonly useSessions: PropsRuntime<'root'>['useSessions']
  readonly usePanelInfo: PropsRuntime<'root'>['usePanelInfo']
  readonly resolvePanelTitle: (panelId: string) => string
}): null {
  const panelId = usePanelInfo(info => info.activePanelId)
  const activeSession = useSessions((state) => {
    const main = Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
    return main === undefined ? undefined : { id: main.id, title: main.title, blank: main.blank }
  })

  useEffect(() => {
    if (panelId !== null) {
      const title = resolvePanelTitle(panelId)
      document.title = title
      bridge.setTabTitle(title)
      bridge.notifyActiveSession(undefined, panelId)
      return
    }
    const rawTitle = activeSession?.title?.trim()
    const title = rawTitle && rawTitle.length > 0 ? rawTitle : 'DeepSeek Chat'
    document.title = title
    bridge.setTabTitle(title)
    bridge.notifyActiveSession(activeSession?.id, null)
  }, [bridge, panelId, activeSession?.id, activeSession?.title, resolvePanelTitle])

  return null
}

function RightbarDragHandle(props: {
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}): ReactNode {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    capture.current = { element: event.currentTarget, id: event.pointerId }
    origin.current = event.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(event.clientX - origin.current)
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(event.clientX - origin.current)
    endDrag()
  }, [endDrag])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    />
  )
}

export function VsCodeFrame({
  mode,
  bridge,
  resolvePanelTitle,
  useStore,
  useSessions,
  usePanelInfo,
  actions,
  renderSlot,
}: VsCodeFrameProps): ReactNode {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  useLayoutEffect(() => {
    const el = frameRef.current
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = (): void => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])
  const bottom = useMemo(() => renderSlot('shell.bottom', {}), [renderSlot])

  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  const canShowRightbar = viewport >= CENTER_MIN + RIGHTBAR_MIN
  const rightbarNormal = canShowRightbar
    ? clampWidth(rightbarPreference, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO)
    : 0
  const rightbarTrackWidth = layoutInfo.rightbarTrack ? rightbarNormal : 0
  const rightbarBase = useRef(0)
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarNormal }, [rightbarNormal])
  const onRightbarDrag = useCallback((dx: number) => {
    actions.setRightbar(rightbarBase.current - dx)
  }, [actions])
  const onRightbarEnd = useCallback(() => {}, [])

  if (mode === 'sidebar') {
    return (
      <div ref={frameRef} className={`${css.frame} ${css.sidebarOnly}`} data-vscode-surface="sidebar">
        <div className={css.sidebarCol}>
          {renderSlot('sidebar', {
            collapsed: false,
            width: Math.max(viewport, 220),
            drawer: false,
          })}
        </div>
        <div className={css.bottomRow} data-shell-bottom>{bottom}</div>
        <div className={css.overlayLayer} data-shell-overlay>{overlays}</div>
      </div>
    )
  }

  if (mode === 'editor') {
    return (
      <div
        ref={frameRef}
        className={`${css.frame} ${css.editorOnly}`}
        data-vscode-surface="editor"
        style={{
          gridTemplateColumns:
            `minmax(${rightbarTrackWidth === 0 ? 0 : CENTER_MIN}px, 1fr) minmax(0px, ${rightbarTrackWidth}px)`,
        }}
        data-rightbar-collapsed={rightbarTrackWidth === 0 || undefined}
        data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      >
        {bridge !== undefined && (
          <EditorTabTitleSync
            bridge={bridge}
            useSessions={useSessions}
            usePanelInfo={usePanelInfo}
            resolvePanelTitle={resolvePanelTitle}
          />
        )}
        <div className={css.centerCol}>
          <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
        </div>
        <div className={css.rightbarCol} data-rightbar-col>
          {renderSlot('rightbar', {
            width: rightbarNormal,
            viewportWidth: viewport,
            canShow: canShowRightbar,
          })}
        </div>
        <div className={css.bottomRow} data-shell-bottom>{bottom}</div>
        <div className={css.overlayLayer} data-shell-overlay>{overlays}</div>
        {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && rightbarNormal > 0 && (
          <RightbarDragHandle
            left={viewport - rightbarNormal}
            onStart={onRightbarStart}
            onDrag={onRightbarDrag}
            onEnd={onRightbarEnd}
          />
        )}
      </div>
    )
  }

  // Standalone browser fallback when not hosted inside VS Code.
  return (
    <div ref={frameRef} className={`${css.frame} ${css.fallbackFrame}`}>
      <div className={css.sidebarCol}>
        {renderSlot('sidebar', { collapsed: false, width: 260, drawer: false })}
      </div>
      <div className={css.fallbackCenter}>
        <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
      </div>
      <div className={css.bottomRow} data-shell-bottom>{bottom}</div>
      <div className={css.overlayLayer} data-shell-overlay>{overlays}</div>
    </div>
  )
}
