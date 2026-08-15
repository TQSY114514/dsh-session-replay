import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldedState, PlaybackSnapshot, Speed, TranscriptEntry } from '../types.ts'
import { applyFoldEvent, newFoldAccumulator } from './fold.ts'
import { renderEvent } from './render.ts'
import type { RenderDeps } from './render.ts'

/**
 * A cursor-driven playback state machine over an ordered session event log.
 *
 * The engine owns the position and transport state; players (CLI, Web) drive
 * it through `tick(now)` and render whatever `onEmit` delivers. It is a pure
 * TypeScript module with no cordis or UI dependency, so its semantics are
 * unit-testable without a harness.
 *
 * Timing model: playback advances one event when the accumulated virtual
 * playback time covers that event's real wall-clock gap (`next.time -
 * prev.time`), scaled by `speed`. Events with identical timestamps emit back
 * to back.
 *
 * Derived views (`folded`, tool-name resolution) are maintained incrementally
 * as the cursor moves, so per-event cost is O(1) forward; only a backward seek
 * re-scans, and even then just the region between the old and new positions.
 */
export class ReplayEngine {
  private readonly eventsArray: SessionEvent[]

  /** The ordered event log, in seq order. Read-only view of the internal buffer. */
  get events(): readonly SessionEvent[] {
    return this.eventsArray
  }

  private cursor = 0
  private playing = false
  private speed: Speed = 1
  private accumulated = 0
  private lastTickAt: number | null = null
  private ended = false
  private lastSeq = -1

  private readonly toolNames = new Map<string, string>()
  /** Events `[0, toolNamesUntil)` have contributed to `toolNames`. */
  private toolNamesUntil = 0
  private readonly turnIndex = new Map<number, number>()
  private readonly stepIndex = new Map<string, number>()

  /** Live folded state for `[0, foldUntil)`; `foldUntil` tracks the cursor. */
  private readonly foldState = newFoldAccumulator()
  private foldUntil = 0

  /** Called for every non-null rendered entry as playback advances. */
  onEmit: ((entry: TranscriptEntry) => void) | null = null
  /** Called once when playback reaches the final event. */
  onEnd: (() => void) | null = null

  /** One shared dependency set: the tool-name map only ever grows in log order. */
  private readonly renderDeps: RenderDeps = { toolName: callId => this.toolNames.get(callId) }

  constructor(events: readonly SessionEvent[]) {
    // Assign (never `push(...spread)`): spreading a huge log would exceed the
    // argument-count limit and throw for sessions with tens of thousands of events.
    this.eventsArray = [...events].sort((a, b) => a.seq - b.seq)
    this.lastSeq = this.eventsArray.at(-1)?.seq ?? -1
    this.buildIndexes(0)
  }

  /**
   * Append newly recorded events to the log, for live follow-along. Events
   * whose `seq` is not greater than the current tail are dropped (a cold start
   * re-feeds history the firehose then repeats). Indexes are extended only
   * over the appended region, so appending stays O(added).
   */
  append(newEvents: readonly SessionEvent[]): void {
    const startIndex = this.eventsArray.length
    let added = false
    for (const event of newEvents) {
      if (event.seq > this.lastSeq) {
        this.eventsArray.push(event)
        this.lastSeq = event.seq
        added = true
      }
    }
    if (added) {
      this.buildIndexes(startIndex)
      this.ended = false
    }
  }

  /** Index turn/step start positions for O(1) seek targets, over `[from, len)`. */
  private buildIndexes(from: number): void {
    for (let i = from; i < this.eventsArray.length; i += 1) {
      const event = this.eventsArray[i]
      if (event === undefined) break
      if (event.type === 'turn/start') this.turnIndex.set(event.data.turn, i)
      else if (event.type === 'step/start') this.stepIndex.set(`${event.data.turn}:${event.data.step}`, i)
    }
  }

  /**
   * Bring the tool-name map up to covering `[0, index)`. Backward targets
   * rebuild from scratch (names from after the cut must not resolve); forward
   * targets only scan the uncovered delta.
   */
  private syncToolNames(index: number): void {
    if (index < this.toolNamesUntil) {
      this.toolNames.clear()
      this.toolNamesUntil = 0
    }
    for (let i = this.toolNamesUntil; i < index; i += 1) {
      const event = this.eventsArray[i]
      if (event?.type === 'tool/call') this.toolNames.set(event.data.callId, event.data.name)
    }
    this.toolNamesUntil = index
  }

  /**
   * Bring the folded state up to covering `[0, index)`. Fold semantics are
   * order-dependent but prefix-consistent, so a forward move only needs the
   * delta; a backward move replays from the empty state.
   */
  private syncFold(index: number): void {
    if (index < this.foldUntil) {
      const fresh = newFoldAccumulator()
      this.foldState.turn = fresh.turn
      this.foldState.todos = fresh.todos
      this.foldState.lastRequestReason = fresh.lastRequestReason
      this.foldState.toolCallCount = fresh.toolCallCount
      this.foldState.errorCount = fresh.errorCount
      this.foldUntil = 0
    }
    for (let i = this.foldUntil; i < index; i += 1) {
      const event = this.eventsArray[i]
      if (event === undefined) break
      applyFoldEvent(this.foldState, event)
    }
    this.foldUntil = index
  }

  get snapshot(): PlaybackSnapshot {
    return {
      cursor: this.cursor,
      total: this.events.length,
      playing: this.playing,
      speed: this.speed,
      atEnd: this.ended,
    }
  }

  /** Folded state at the current cursor, maintained incrementally (O(1) here). */
  get folded(): FoldedState {
    return { ...this.foldState }
  }

  /** Start (or resume) automatic playback. No-op at the end of the log. */
  play(): void {
    if (this.ended) return
    this.playing = true
    this.lastTickAt = null
  }

  /** Pause playback. The accumulated partial interval is dropped. */
  pause(): void {
    this.playing = false
    this.accumulated = 0
    this.lastTickAt = null
  }

  /** Toggle between playing and paused. */
  togglePlay(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /**
   * Advance exactly one event, independent of the clock. Shared by `step()`
   * and the tick loop so "step while playing" and "step while paused" behave
   * identically.
   * @returns the emitted entry, or `null` when the end was reached.
   */
  step(): TranscriptEntry | null {
    if (this.ended) return null
    const entry = this.advance()
    this.accumulated = 0
    return entry
  }

  /** Move to the event with the given seq; returns false when absent. Binary search — the log is seq-sorted. */
  seekToSeq(seq: number): boolean {
    let lo = 0
    let hi = this.eventsArray.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const event = this.eventsArray[mid]
      if (event === undefined) return false
      if (event.seq === seq) {
        this.seekToIndex(mid)
        return true
      }
      if (event.seq < seq) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }

  /** Move to the first event of turn `n`; returns false when the turn is absent. */
  seekToTurn(turn: number): boolean {
    const index = this.turnIndex.get(turn)
    if (index === undefined) return false
    this.seekToIndex(index)
    return true
  }

  /** Move to the first event of `(turn, step)`; returns false when the turn is absent. */
  seekToStep(turn: number, step: number): boolean {
    const index = this.stepIndex.get(`${turn}:${step}`)
    if (index === undefined) return false
    this.seekToIndex(index)
    return true
  }

  setSpeed(speed: Speed): void {
    this.speed = speed
  }

  /**
   * Advance the playback clock. Call from a timer (CLI) or animation frame
   * (Web) with a monotonic `now` in epoch milliseconds. Does nothing while
   * paused or at the end.
   */
  tick(now: number): void {
    if (!this.playing || this.ended) return
    if (this.lastTickAt === null) {
      this.lastTickAt = now
      return
    }
    const elapsed = now - this.lastTickAt
    this.lastTickAt = now
    if (elapsed <= 0) return
    this.accumulated += elapsed * this.speed
    while (this.accumulated > 0 && !this.ended) {
      const next = this.events[this.cursor]
      if (next === undefined) {
        this.finish()
        break
      }
      const previousTime = this.cursor > 0 ? (this.events[this.cursor - 1]?.time ?? next.time) : next.time
      const delta = Math.max(0, next.time - previousTime)
      if (delta === 0) {
        this.advance()
        continue
      }
      if (this.accumulated >= delta) {
        this.accumulated -= delta
        this.advance()
      } else {
        break
      }
    }
  }

  private seekToIndex(index: number): void {
    this.cursor = index
    this.ended = false
    this.pause()
    this.syncToolNames(index)
    this.syncFold(index)
  }

  /** Emit the current event, advance the cursor, and detect the end. */
  private advance(): TranscriptEntry | null {
    const event = this.events[this.cursor]
    if (event === undefined) {
      this.finish()
      return null
    }
    this.syncToolNames(this.cursor + 1)
    this.syncFold(this.cursor + 1)
    const entry = renderEvent(event, this.renderDeps)
    this.cursor += 1
    if (entry !== null) this.onEmit?.(entry)
    if (this.cursor >= this.events.length) this.finish()
    return entry
  }

  private finish(): void {
    this.ended = true
    this.playing = false
    this.onEnd?.()
  }
}
