import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldedState, TodoSummary } from '../types.ts'

/**
 * Fold the event prefix `[0, cursor)` into a state snapshot the UI can render
 * at a playback position without re-scanning on every paint. Pure and O(cursor)
 * per call; players call it once per seek, not per tick.
 */
export function foldAt(events: readonly SessionEvent[], cursor: number): FoldedState {
  let turn: number | undefined
  let todos: readonly TodoSummary[] = []
  let lastRequestReason: string | undefined
  let toolCallCount = 0
  let errorCount = 0
  const end = Math.min(cursor, events.length)
  for (let i = 0; i < end; i += 1) {
    const event = events[i]
    if (event === undefined) break
    switch (event.type) {
      case 'turn/start':
        turn = event.data.turn
        break
      case 'todo/write':
        // Whole-value snapshot: the latest write wins, earlier writes are shadowed.
        todos = event.data.todos.map(item => ({ content: item.content, status: item.status }))
        break
      case 'request/header':
        lastRequestReason = event.data.reason
        break
      case 'tool/call':
        toolCallCount += 1
        break
      case 'tool/result':
        if (event.data.error !== undefined) errorCount += 1
        break
      default:
        break
    }
  }
  return { turn, todos, lastRequestReason, toolCallCount, errorCount }
}
