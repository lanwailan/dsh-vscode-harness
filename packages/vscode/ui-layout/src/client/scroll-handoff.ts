/**
 * Wheel & drag scroll hand-off between the VS Code sidebar viewport and the
 * `sidebar.workspaces` section scroller. Matches the `SidebarSectionHookContext`
 * contract expected by `@deepseek-ai/dsh-client-ui-workspace`.
 */
import type { RefCallback } from 'react'
import type { SectionScroller, UseSectionScroller } from '@deepseek-ai/dsh-client-ui-sidebar/client'

export interface ScrollHandoff {
  readonly bindViewportRef: RefCallback<HTMLElement>
  readonly useSectionScroller: UseSectionScroller
}

const GESTURE_GAP_MS = 100
const DRAG_EDGE_PX = 48
const DRAG_MAX_SPEED_PX_PER_MS = 1
const DRAG_STALE_MS = 600
const DRAG_MAX_STEP_MS = 50

function verticalWheelPixels(event: WheelEvent, page: number): number | undefined {
  if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return undefined
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * page
  return event.deltaY
}

function scrollClamped(element: HTMLElement, delta: number): number {
  const before = element.scrollTop
  element.scrollTop = before + delta
  return element.scrollTop - before
}

function scrollSplit(viewport: HTMLElement, scroller: HTMLElement | null, delta: number): void {
  if (scroller === null) {
    scrollClamped(viewport, delta)
    return
  }
  if (delta > 0) {
    const rest = delta - scrollClamped(viewport, delta)
    if (rest > 0) scrollClamped(scroller, rest)
    return
  }
  const rest = delta - scrollClamped(scroller, delta)
  if (rest < 0) scrollClamped(viewport, rest)
}

function dragVelocity(viewport: HTMLElement, scroller: HTMLElement | null, y: number): number {
  const outer = viewport.getBoundingClientRect()
  const inner = scroller?.getBoundingClientRect() ?? outer
  const top = Math.max(outer.top, inner.top)
  const bottom = Math.min(outer.bottom, inner.bottom)
  const band = Math.min(DRAG_EDGE_PX, (bottom - top) / 2)
  if (band <= 0) return 0
  const speed = (depth: number): number => DRAG_MAX_SPEED_PX_PER_MS * Math.min(1, depth / band)
  if (y < top + band) return -speed(top + band - y)
  if (y > bottom - band) return speed(y - (bottom - band))
  return 0
}

function atEnd(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1
}

export function createScrollHandoff(): ScrollHandoff {
  let scroller: HTMLElement | null = null
  let releaseViewport: (() => void) | undefined
  let lastSplit = Number.NEGATIVE_INFINITY
  const handle = (viewport: HTMLElement, event: WheelEvent): void => {
    if (scroller === null || event.defaultPrevented) return
    const delta = verticalWheelPixels(event, viewport.clientHeight)
    if (delta === undefined || delta === 0) return
    const continuing = event.cancelable && event.timeStamp - lastSplit < GESTURE_GAP_MS
    if (!continuing) {
      const native = atEnd(viewport) && scroller.contains(event.target as Node | null)
      if (native && (delta > 0 || scroller.scrollTop + delta >= 0)) return
      if (!event.cancelable) {
        if (native) scrollClamped(viewport, delta + scroller.scrollTop)
        return
      }
    }
    event.preventDefault()
    lastSplit = event.timeStamp
    scrollSplit(viewport, scroller, delta)
  }
  let drag: { y: number; at: number } | undefined
  let frame: number | undefined
  let lastFrame = 0
  const stopDrag = (): void => {
    drag = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const step = (viewport: HTMLElement, now: number): void => {
    frame = undefined
    if (drag === undefined || now - drag.at > DRAG_STALE_MS) {
      drag = undefined
      return
    }
    const velocity = dragVelocity(viewport, scroller, drag.y)
    if (velocity === 0) return
    scrollSplit(viewport, scroller, velocity * Math.min(Math.max(now - lastFrame, 0), DRAG_MAX_STEP_MS))
    lastFrame = now
    frame = requestAnimationFrame((time) => { step(viewport, time) })
  }
  const dragOver = (viewport: HTMLElement, event: DragEvent): void => {
    drag = { y: event.clientY, at: performance.now() }
    if (frame !== undefined || dragVelocity(viewport, scroller, event.clientY) === 0) return
    lastFrame = drag.at
    frame = requestAnimationFrame((time) => { step(viewport, time) })
  }
  const sectionScroller: SectionScroller = {
    bindScrollerRef: (element) => { scroller = element },
  }
  return {
    bindViewportRef: (element) => {
      releaseViewport?.()
      releaseViewport = undefined
      if (element === null) return
      const onWheel = (event: WheelEvent): void => { handle(element, event) }
      const onDragOver = (event: DragEvent): void => { dragOver(element, event) }
      const onDragLeave = (event: DragEvent): void => {
        if (!element.contains(event.relatedTarget as Node | null)) stopDrag()
      }
      element.addEventListener('wheel', onWheel, { passive: false })
      element.addEventListener('dragover', onDragOver, true)
      element.addEventListener('dragleave', onDragLeave, true)
      element.addEventListener('drop', stopDrag, true)
      element.addEventListener('dragend', stopDrag, true)
      releaseViewport = () => {
        stopDrag()
        element.removeEventListener('wheel', onWheel)
        element.removeEventListener('dragover', onDragOver, true)
        element.removeEventListener('dragleave', onDragLeave, true)
        element.removeEventListener('drop', stopDrag, true)
        element.removeEventListener('dragend', stopDrag, true)
      }
    },
    useSectionScroller: () => sectionScroller,
  }
}
