/**
 * Agent Run Replay for the DeepSeek Harness: a cursor-driven playback state
 * machine over any recorded session event log, with render and fold helpers.
 * The engine is pure TypeScript — no cordis or UI dependency — so the CLI and
 * future Web players share one tested core.
 *
 * @module @deepseek-ai/dsh-session-replay
 */

export type {
  FoldedState, PlaybackSnapshot, Speed, TodoSummary, ToolCallRef, TranscriptEntry,
} from './types.ts'
export { ReplayEngine } from './engine/index.ts'
export { foldAt } from './engine/fold.ts'
export { noopRenderDeps, renderEvent, textOf } from './engine/render.ts'
export type { RenderDeps } from './engine/render.ts'
export { loadRun, rebuildSession } from './store/reader.ts'
export type { LoadedRun } from './store/reader.ts'
