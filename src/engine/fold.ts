import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldedState, TodoSummary } from '../types.ts'

/**
 * Mutable fold accumulator: the same fields as `FoldedState`, held across
 * events so callers that advance one event at a time (the engine) can keep a
 * live folded view in O(1) per event instead of re-scanning the prefix.
 * All mutations replace values; nothing is edited in place after publication.
 */
export interface FoldAccumulator {
  turn: number | undefined
  todos: readonly TodoSummary[]
  lastRequestReason: string | undefined
  toolCallCount: number
  errorCount: number
}

/** A fresh, empty accumulator covering the empty prefix. */
export function newFoldAccumulator(): FoldAccumulator {
  return { turn: undefined, todos: [], lastRequestReason: undefined, toolCallCount: 0, errorCount: 0 }
}

/**
 * Fold one event into an accumulator. Applying the events of a prefix in log
 * order yields exactly the state `foldAt` computes for that prefix — the two
 * share this single source of fold semantics.
 */
export function applyFoldEvent(state: FoldAccumulator, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/start':
      state.turn = event.data.turn
      break
    case 'todo/write':
      // Whole-value snapshot: the latest write wins, earlier writes are shadowed.
      state.todos = event.data.todos.map(item => ({ content: item.content, status: item.status }))
      break
    case 'request/header':
      state.lastRequestReason = event.data.reason
      break
    case 'tool/call':
      state.toolCallCount += 1
      break
    case 'tool/result':
      if (event.data.error !== undefined) state.errorCount += 1
      break
    default:
      break
  }
}

/**
 * Fold the event prefix `[0, cursor)` into a state snapshot the UI can render
 * at a playback position without re-scanning on every paint. Pure and O(cursor)
 * per call; players that advance incrementally should hold a `FoldAccumulator`
 * and apply `applyFoldEvent` instead.
 */
export function foldAt(events: readonly SessionEvent[], cursor: number): FoldedState {
  const state = newFoldAccumulator()
  const end = Math.min(cursor, events.length)
  for (let i = 0; i < end; i += 1) {
    const event = events[i]
    if (event === undefined) break
    applyFoldEvent(state, event)
  }
  return { ...state }
}
