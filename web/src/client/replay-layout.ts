import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { renderEvent } from '@deepseek-ai/dsh-session-replay/src/engine/render.ts'
import type { TranscriptEntry } from '@deepseek-ai/dsh-session-replay/src/types.ts'

/** Row classes rendered by the replay timeline. */
export type ReplayRowKind =
  | 'band'
  | 'band-end'
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'step'
  | 'todo'
  | 'request'

/** One renderable timeline row, derived from one non-null TranscriptEntry. */
export interface ReplayRow {
  /** Stable React key (event seqs are unique within a session). */
  readonly key: string
  readonly seq: number
  /** Wall-clock time of the source event, epoch milliseconds. */
  readonly time: number
  readonly kind: ReplayRowKind
  /** Turn number of a band row. */
  readonly bandTurn: number | undefined
  /** Whether the band closes a turn (turn-end). */
  readonly bandEnd: boolean
  /** Turn-end detail: failure/cancel text when one was recorded, else the reason kind. */
  readonly bandReason: string | undefined
  /** Primary content text (message body, tool name, step coordinates). */
  readonly text: string
  /** Single-line preview for expandable rows (tool args/result). */
  readonly preview: string | null
  /** Full text revealed by expansion. */
  readonly expanded: string | null
  /** Tool-result success flag. */
  readonly ok: boolean | undefined
  /** Tool-result internal failure identity, when one was recorded. */
  readonly error: string | undefined
  /** Tool name for tool rows. */
  readonly toolName: string | undefined
  /** Tool names called by one assistant message. */
  readonly toolCalls: readonly string[]
  /** Whole-list todo snapshot of a todo row. */
  readonly todos: readonly { readonly content: string; readonly status: string }[] | undefined
  /** Whether a step row closes its step. */
  readonly stepDone: boolean
  /** Request header reason of a request row. */
  readonly requestReason: string | undefined
}

/** Collapse whitespace and cap a preview line. */
export function previewOf(text: string, max = 160): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max)}…`
}

/** Pretty-print a raw JSON string; falls back to the raw text when unparseable. */
export function prettyJson(text: string): string {
  try {
    const value: unknown = JSON.parse(text)
    return JSON.stringify(value, null, 2)
  } catch {
    return text
  }
}

/**
 * Build the tool-call-id → tool-name map for a log prefix, mirroring the
 * engine's own forward map so a seek rebuild renders result rows identically.
 * @param events - sorted event log.
 * @param untilIndex - prefix length (cursor).
 * @returns the resolved name for one call id, or undefined when out of prefix.
 */
export function toolNameOf(
  events: readonly SessionEvent[],
  untilIndex: number,
): (callId: string) => string | undefined {
  const names = new Map<string, string>()
  for (let index = 0; index < untilIndex; index += 1) {
    const event = events[index]
    if (event?.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  return callId => names.get(callId)
}

/**
 * Render the log prefix `[0, cursor)` into timeline rows. Null-rendered
 * events (chunks, seed markers, inbox mutations) are skipped, so rows are
 * exactly the visible transcript the engine would have emitted.
 * @param events - sorted event log.
 * @param cursor - exclusive prefix end.
 * @param toolName - resolved tool names for the same prefix.
 * @returns rows in emit order.
 */
export function renderWindow(
  events: readonly SessionEvent[],
  cursor: number,
  toolName: (callId: string) => string | undefined,
): readonly ReplayRow[] {
  const rows: ReplayRow[] = []
  const deps = { toolName }
  for (let index = 0; index < cursor; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    const entry = renderEvent(event, deps)
    if (entry === null) continue
    rows.push(rowFromEntry(entry, event.time))
  }
  return rows
}

/** Convert one emitted transcript entry into its row model. */
export function rowFromEntry(entry: TranscriptEntry, time: number): ReplayRow {
  switch (entry.kind) {
    case 'user':
      return base(entry, 'user', time, { text: entry.text })
    case 'assistant':
      return base(entry, 'assistant', time, {
        text: entry.text,
        toolCalls: entry.toolCalls.map(call => call.name),
      })
    case 'tool-call':
      return base(entry, 'tool-call', time, {
        text: entry.name,
        toolName: entry.name,
        preview: previewOf(entry.args),
        expanded: prettyJson(entry.args),
      })
    case 'tool-result':
      return base(entry, 'tool-result', time, {
        text: entry.name ?? entry.callId,
        toolName: entry.name,
        ok: entry.ok,
        error: entry.error,
        preview: previewOf(entry.content),
        expanded: entry.content,
      })
    case 'turn-start':
      return base(entry, 'band', time, { bandTurn: entry.turn })
    case 'turn-end':
      return base(entry, 'band-end', time, {
        bandTurn: entry.turn,
        bandEnd: true,
        bandReason: entry.detail ?? entry.reason,
      })
    case 'step-start':
      return base(entry, 'step', time, {
        text: `${entry.turn}.${entry.step}`,
        stepDone: false,
      })
    case 'step-end':
      return base(entry, 'step', time, {
        text: `${entry.turn}.${entry.step}`,
        stepDone: true,
      })
    case 'todo':
      return base(entry, 'todo', time, { todos: entry.todos })
    case 'request':
      return base(entry, 'request', time, { requestReason: entry.reason })
  }
}

interface RowOverrides {
  readonly bandTurn?: number | undefined
  readonly bandEnd?: boolean | undefined
  readonly bandReason?: string | undefined
  readonly text?: string | undefined
  readonly preview?: string | null | undefined
  readonly expanded?: string | null | undefined
  readonly ok?: boolean | undefined
  readonly error?: string | undefined
  readonly toolName?: string | undefined
  readonly toolCalls?: readonly string[] | undefined
  readonly todos?: readonly { readonly content: string; readonly status: string }[] | undefined
  readonly stepDone?: boolean | undefined
  readonly requestReason?: string | undefined
}

function base(
  entry: TranscriptEntry,
  kind: ReplayRowKind,
  time: number,
  overrides: RowOverrides = {},
): ReplayRow {
  return {
    key: String(entry.seq),
    seq: entry.seq,
    time,
    kind,
    bandTurn: overrides.bandTurn,
    bandEnd: overrides.bandEnd ?? false,
    bandReason: overrides.bandReason,
    text: overrides.text ?? '',
    preview: overrides.preview ?? null,
    expanded: overrides.expanded ?? null,
    ok: overrides.ok,
    error: overrides.error,
    toolName: overrides.toolName,
    toolCalls: overrides.toolCalls ?? EMPTY_NAMES,
    todos: overrides.todos,
    stepDone: overrides.stepDone ?? false,
    requestReason: overrides.requestReason,
  }
}

const EMPTY_NAMES: readonly string[] = []
