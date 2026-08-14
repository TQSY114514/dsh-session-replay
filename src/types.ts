/**
 * Public types for dsh-session-replay: the renderable transcript model, the
 * folded state snapshot, and playback control state. Type-only module.
 */

/** Supported playback speed multipliers. */
export type Speed = 1 | 2 | 4 | 8

/** One tool invocation referenced from an assistant message or timeline. */
export interface ToolCallRef {
  /** Provider-issued call id; pairs with the matching tool/result. */
  readonly callId: string
  /** Tool name as the model produced it. */
  readonly name: string
  /** Raw arguments JSON string exactly as the model produced it. */
  readonly args: string
}

/** A todo item's renderable form. */
export interface TodoSummary {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/**
 * One human-readable timeline row. `renderEvent` produces these from raw
 * session events; the renderer and the CLI/Web players consume them.
 */
export type TranscriptEntry =
  | { readonly kind: 'user'; readonly seq: number; readonly text: string }
  | {
    readonly kind: 'assistant'
    readonly seq: number
    readonly text: string
    readonly toolCalls: readonly ToolCallRef[]
  }
  | { readonly kind: 'tool-call'; readonly seq: number; readonly name: string; readonly args: string }
  | {
    readonly kind: 'tool-result'
    readonly seq: number
    readonly callId: string
    /** Resolved from the preceding tool/call event; undefined when out of window. */
    readonly name: string | undefined
    readonly ok: boolean
    readonly content: string
  }
  | { readonly kind: 'turn-start'; readonly seq: number; readonly turn: number }
  | { readonly kind: 'turn-end'; readonly seq: number; readonly turn: number; readonly reason: string }
  | { readonly kind: 'step-start'; readonly seq: number; readonly turn: number; readonly step: number }
  | { readonly kind: 'step-end'; readonly seq: number; readonly turn: number; readonly step: number }
  | { readonly kind: 'todo'; readonly seq: number; readonly todos: readonly TodoSummary[] }
  | { readonly kind: 'request'; readonly seq: number; readonly reason: string }

/**
 * Folded state at a playback position: the accumulated durable facts a UI can
 * show without replaying the whole prefix (current turn, latest todo list,
 * request reasons, counts).
 */
export interface FoldedState {
  /** Current turn number, when the prefix opened one. */
  readonly turn: number | undefined
  /** Latest whole-list todo snapshot (whole-value; last write wins). */
  readonly todos: readonly TodoSummary[]
  /** Reason of the latest request/header event. */
  readonly lastRequestReason: string | undefined
  readonly toolCallCount: number
  readonly errorCount: number
}

/** Read-only playback position and transport state, for UI status lines. */
export interface PlaybackSnapshot {
  /** Number of events already emitted. */
  readonly cursor: number
  readonly total: number
  readonly playing: boolean
  readonly speed: Speed
  readonly atEnd: boolean
}
