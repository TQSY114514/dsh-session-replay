/** Replay view: cursor-driven playback of the raw session event log. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ReplayEngine } from '@deepseek-ai/dsh-session-replay/src/engine/index.ts'
import type { Speed } from '@deepseek-ai/dsh-session-replay/src/types.ts'
import { ReplayControls } from './ReplayControls.tsx'
import { EMPTY_REPLAY_SNAPSHOT } from './replay-definitions.ts'
import {
  renderWindow, rowFromEntry, toolNameOf, type ReplayRow,
} from './replay-layout.ts'
import { ReplayTimeline } from './ReplayTimeline.tsx'
import css from './replay.module.css'

const EMPTY_EVENTS: readonly SessionEvent[] = []
const EMPTY_ROWS: readonly ReplayRow[] = []
const EMPTY_EXPANDED: ReadonlySet<number> = new Set()

/** Session-bound controls not already supplied by the conversation view slot. */
export interface ReplayViewInjected {
  loadOlder: () => Promise<void>
}

export type ReplayViewProps =
  ConvViewProps & InjectFace<ReplayViewInjected> & PropsLocale<'replay'>

interface SessionFacts {
  readonly loading: boolean
  readonly failed: boolean
  readonly errorMessage: string | null
  readonly running: boolean
  readonly hasMore: boolean
  readonly loadingOlder: boolean
}

/**
 * Build one engine with the replay callbacks attached. The callbacks read
 * only refs and functional state setters, so the same factory serves both
 * the initial engine and the older-history rebuild.
 */
function createEngine(events: readonly SessionEvent[], setRows: (update: (prev: readonly ReplayRow[]) => readonly ReplayRow[]) => void, timeBySeq: Map<number, number>, setPlaying: (playing: boolean) => void, setAtEnd: (atEnd: boolean) => void): ReplayEngine {
  const engine = new ReplayEngine(events)
  engine.onEmit = entry => {
    setRows(prev => [...prev, rowFromEntry(entry, timeBySeq.get(entry.seq) ?? 0)])
  }
  engine.onEnd = () => {
    setPlaying(false)
    setAtEnd(true)
  }
  return engine
}

export function ReplayView({ useSession, loadOlder, t }: ReplayViewProps) {
  const replay = useSession(snapshot => snapshot.views.get('replay') ?? EMPTY_REPLAY_SNAPSHOT)
  const sessionFacts: SessionFacts = useSession(snapshot => ({
    loading: snapshot.openState === 'cold' || snapshot.openState === 'loading',
    failed: snapshot.openState === 'error',
    errorMessage: typeof snapshot.openError?.message === 'string'
      ? snapshot.openError.message
      : null,
    running: snapshot.running,
    hasMore: snapshot.hasMore,
    loadingOlder: snapshot.loadingOlder,
  }))

  const [rows, setRows] = useState<readonly ReplayRow[]>(EMPTY_ROWS)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const [atEnd, setAtEnd] = useState(false)
  const [progress, setProgress] = useState(0)
  const [scrub, setScrub] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(EMPTY_EXPANDED)
  const [timeBySeq] = useState(() => new Map<number, number>())
  const engineRef = useRef<ReplayEngine | null>(null)
  const appendedTailSeq = useRef(-1)
  const firstSeq = useRef(-1)
  const lastCursor = useRef(-1)

  if (engineRef.current === null) {
    engineRef.current = createEngine(EMPTY_EVENTS, setRows, timeBySeq, setPlaying, setAtEnd)
  }

  /**
   * Sync the engine with the assembled log. Live tail appends feed the
   * engine O(delta); a head change (older history prepended) rebuilds the
   * engine over the full window and restores the position by seq.
   */
  useLayoutEffect(() => {
    const events = replay.events
    const engine = engineRef.current
    if (engine === null) return
    const first = events[0]?.seq ?? -1
    if (first !== firstSeq.current) {
      const previousCursor = engine.snapshot.cursor
      const positionSeq = engine.events[previousCursor - 1]?.seq
      const wasPlaying = engine.snapshot.playing
      const next = createEngine(events, setRows, timeBySeq, setPlaying, setAtEnd)
      next.setSpeed(engine.snapshot.speed)
      if (positionSeq !== undefined) next.seekToSeq(positionSeq)
      if (wasPlaying) next.play()
      engineRef.current = next
      firstSeq.current = first
      appendedTailSeq.current = events[events.length - 1]?.seq ?? -1
      timeBySeq.clear()
      for (const event of events) timeBySeq.set(event.seq, event.time)
      setRows(renderWindow(events, next.snapshot.cursor, toolNameOf(events, next.snapshot.cursor)))
      setPlaying(next.snapshot.playing)
      setAtEnd(next.snapshot.atEnd)
      return
    }
    const tail = appendedTailSeq.current
    let start = 0
    if (tail >= 0) {
      let low = 0
      let high = events.length
      while (low < high) {
        const mid = (low + high) >> 1
        if ((events[mid]?.seq ?? -1) <= tail) low = mid + 1
        else high = mid
      }
      start = low
    }
    const delta = events.slice(start)
    if (delta.length > 0) {
      engine.append(delta)
      for (const event of delta) timeBySeq.set(event.seq, event.time)
      appendedTailSeq.current = delta[delta.length - 1]?.seq ?? tail
      setAtEnd(engine.snapshot.atEnd)
    }
  }, [replay])

  /** Animation frame loop while playing: advance the engine clock. */
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const loop = () => {
      const engine = engineRef.current
      if (engine !== null) {
        engine.tick(Date.now())
        const cursor = engine.snapshot.cursor
        if (cursor !== lastCursor.current) {
          lastCursor.current = cursor
          const total = engine.snapshot.total
          setProgress(total === 0 ? 0 : cursor / total)
        }
        if (!engine.snapshot.playing) setPlaying(false)
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(frame) }
  }, [playing])

  const rebuildRows = useCallback((engine: ReplayEngine) => {
    const events = engine.events
    const cursor = engine.snapshot.cursor
    const total = engine.snapshot.total
    setRows(renderWindow(events, cursor, toolNameOf(events, cursor)))
    setProgress(total === 0 ? 0 : cursor / total)
    setAtEnd(engine.snapshot.atEnd)
    setPlaying(engine.snapshot.playing)
  }, [])

  const handlePlayPause = useCallback(() => {
    const engine = engineRef.current
    if (engine === null || engine.snapshot.atEnd) return
    engine.togglePlay()
    setPlaying(engine.snapshot.playing)
  }, [])

  const handleStep = useCallback(() => {
    const engine = engineRef.current
    if (engine === null || engine.snapshot.atEnd) return
    engine.step()
    lastCursor.current = engine.snapshot.cursor
    const total = engine.snapshot.total
    setProgress(total === 0 ? 0 : engine.snapshot.cursor / total)
    setAtEnd(engine.snapshot.atEnd)
  }, [])

  const handleSpeedChange = useCallback((next: Speed) => {
    engineRef.current?.setSpeed(next)
    setSpeed(next)
  }, [])

  const handleTurnStep = useCallback((direction: -1 | 1) => {
    const engine = engineRef.current
    if (engine === null) return
    const current = engine.folded.turn ?? 1
    const target = Math.max(1, current + direction)
    if (engine.seekToTurn(target)) rebuildRows(engine)
  }, [rebuildRows])

  const handleSeek = useCallback((fraction: number) => {
    const engine = engineRef.current
    if (engine === null || engine.events.length === 0) return
    const index = Math.min(
      engine.events.length - 1,
      Math.max(0, Math.round(fraction * engine.events.length)),
    )
    const event = engine.events[index]
    if (event === undefined) return
    const wasPlaying = engine.snapshot.playing
    if (engine.seekToSeq(event.seq)) {
      if (wasPlaying) engine.play()
      lastCursor.current = engine.snapshot.cursor
      rebuildRows(engine)
    }
  }, [rebuildRows])

  const handleScrub = useCallback((fraction: number | null) => {
    setScrub(fraction)
  }, [])

  const handleToggleExpanded = useCallback((seq: number) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }, [])

  const handleLoadOlder = useCallback(() => {
    void loadOlder()
  }, [loadOlder])

  const engine = engineRef.current
  const total = engine?.snapshot.total ?? 0
  const cursor = engine?.snapshot.cursor ?? 0
  const finished = (atEnd && total > 0) || (total > 0 && cursor >= total)
  const live = sessionFacts.running && finished

  let body: ReactNode
  if (sessionFacts.failed) {
    body = (
      <div className={css.statePanel}>
        <div className={css.stateTitle}>{t('state.error')}</div>
        {sessionFacts.errorMessage !== null && (
          <div className={css.stateDetail}>{sessionFacts.errorMessage}</div>
        )}
      </div>
    )
  } else if (sessionFacts.loading) {
    body = <div className={css.statePanel}>{t('state.loading')}</div>
  } else if (total === 0) {
    body = <div className={css.statePanel}>{t('state.empty')}</div>
  } else {
    body = (
      <>
        {sessionFacts.hasMore && (
          <div className={css.olderRow}>
            <button
              type="button"
              className={css.button}
              onClick={handleLoadOlder}
              disabled={sessionFacts.loadingOlder}
            >
              {sessionFacts.loadingOlder ? t('state.loadingOlder') : t('state.loadOlder')}
            </button>
          </div>
        )}
        <ReplayTimeline
          rows={rows}
          expanded={expanded}
          onToggleExpanded={handleToggleExpanded}
          t={t}
        />
      </>
    )
  }

  return (
    <div className={css.root} data-conversation-composer-overlay="">
      <ReplayControls
        playing={playing}
        finished={finished}
        speed={speed}
        progress={progress}
        scrub={scrub}
        cursor={cursor}
        total={total}
        live={live}
        onPlayPause={handlePlayPause}
        onStep={handleStep}
        onSpeedChange={handleSpeedChange}
        onPrevTurn={() => { handleTurnStep(-1) }}
        onNextTurn={() => { handleTurnStep(1) }}
        onScrub={handleScrub}
        onSeek={handleSeek}
        t={t}
      />
      {body}
      {finished && !live && (
        <div className={css.finishedStrip}>{t('state.finished')}</div>
      )}
    </div>
  )
}
