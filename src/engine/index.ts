import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldedState, PlaybackSnapshot, Speed, TranscriptEntry } from '../types.ts'
import { foldAt } from './fold.ts'
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
 */
export class ReplayEngine {
  readonly events: readonly SessionEvent[]

  private cursor = 0
  private playing = false
  private speed: Speed = 1
  private accumulated = 0
  private lastTickAt: number | null = null
  private ended = false

  private readonly toolNames = new Map<string, string>()
  private readonly turnIndex = new Map<number, number>()
  private readonly stepIndex = new Map<string, number>()

  /** Called for every non-null rendered entry as playback advances. */
  onEmit: ((entry: TranscriptEntry) => void) | null = null
  /** Called once when playback reaches the final event. */
  onEnd: (() => void) | null = null

  constructor(events: readonly SessionEvent[]) {
    this.events = [...events].sort((a, b) => a.seq - b.seq)
    this.buildIndexes()
  }

  /** Index turn/step start positions for O(1) seek targets. */
  private buildIndexes(): void {
    for (let i = 0; i < this.events.length; i += 1) {
      const event = this.events[i]
      if (event === undefined) break
      if (event.type === 'turn/start') this.turnIndex.set(event.data.turn, i)
      else if (event.type === 'step/start') this.stepIndex.set(`${event.data.turn}:${event.data.step}`, i)
    }
  }

  /** Rebuild the tool-name map from the prefix, after a backward seek. */
  private rebuildToolNames(until: number): void {
    this.toolNames.clear()
    for (let i = 0; i < until; i += 1) {
      const event = this.events[i]
      if (event?.type === 'tool/call') this.toolNames.set(event.data.callId, event.data.name)
    }
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

  /** Folded state at the current cursor. */
  get folded(): FoldedState {
    return foldAt(this.events, this.cursor)
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

  /** Move to the event with the given seq; returns false when absent. */
  seekToSeq(seq: number): boolean {
    const index = this.events.findIndex(event => event.seq === seq)
    if (index === -1) return false
    this.seekToIndex(index)
    return true
  }

  /** Move to the first event of turn `n`; returns false when the turn is absent. */
  seekToTurn(turn: number): boolean {
    const index = this.turnIndex.get(turn)
    if (index === undefined) return false
    this.seekToIndex(index)
    return true
  }

  /** Move to the first event of `(turn, step)`; returns false when absent. */
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
    this.rebuildToolNames(index)
  }

  /** Emit the current event, advance the cursor, and detect the end. */
  private advance(): TranscriptEntry | null {
    const event = this.events[this.cursor]
    if (event === undefined) {
      this.finish()
      return null
    }
    if (event.type === 'tool/call') this.toolNames.set(event.data.callId, event.data.name)
    const deps: RenderDeps = { toolName: callId => this.toolNames.get(callId) }
    const entry = renderEvent(event, deps)
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
