import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TranscriptEntry, ToolCallRef } from '../types.ts'

/** Dependencies the pure event renderer needs beyond the event itself. */
export interface RenderDeps {
  /**
   * Resolve a tool call id to its tool name. The engine maintains this map
   * from preceding `tool/call` events; a bare renderer may pass a stub.
   */
  toolName(callId: string): string | undefined
}

/** The no-op dependency set: tool-result rows carry no resolved name. */
export const noopRenderDeps: RenderDeps = { toolName: () => undefined }

/** Concatenate the visible `text` blocks of a message's content. */
export function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function toolCallRefs(content: readonly ContentBlock[]): ToolCallRef[] {
  const refs: ToolCallRef[] = []
  for (const block of content) {
    if (block.type === 'tool-call') {
      refs.push({ callId: block.id, name: block.name, args: block.arguments })
    }
  }
  return refs
}

/** Human-readable context for non-trivial turn endings (merge-extensible reasons fall through). */
function turnEndDetail(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'aborted':
      return reason.reason.kind === 'hook'
        ? `aborted by hook: ${reason.reason.reason}`
        : `aborted: ${reason.reason.kind}`
    case 'error':
      return `error: ${reason.error.message} (${reason.error.code})`
    default:
      return undefined
  }
}

/**
 * Render one raw session event into a human-readable timeline row. Events that
 * carry no visible timeline meaning (`assistant/chunk`, seed markers, inbox
 * mutations, …) return `null` and are skipped by the players — chunk runs are
 * folded into their owning `assistant/message` instead of rendering per token.
 *
 * The function is pure: identical events plus identical `deps` produce
 * identical entries, which keeps the renderer snapshot-testable.
 */
export function renderEvent(event: SessionEvent, deps: RenderDeps): TranscriptEntry | null {
  switch (event.type) {
    case 'user/message': {
      const text = textOf(event.data.content)
      return text.length === 0 ? null : { kind: 'user', seq: event.seq, text }
    }
    case 'assistant/message': {
      const toolCalls = toolCallRefs(event.data.message.content)
      const text = textOf(event.data.message.content)
      if (text.length === 0 && toolCalls.length === 0) return null
      return { kind: 'assistant', seq: event.seq, text, toolCalls }
    }
    case 'tool/call':
      return { kind: 'tool-call', seq: event.seq, name: event.data.name, args: event.data.arguments }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const callId = block?.toolCallId ?? ''
      const failure = event.data.error
      return {
        kind: 'tool-result',
        seq: event.seq,
        callId,
        name: deps.toolName(callId),
        ok: failure === undefined && !(block?.isError ?? false),
        content: block === undefined ? '' : textOf(block.content),
        error: failure === undefined ? undefined : `${failure.name}: ${failure.code}`,
      }
    }
    case 'turn/start':
      return { kind: 'turn-start', seq: event.seq, turn: event.data.turn }
    case 'turn/end':
      return {
        kind: 'turn-end',
        seq: event.seq,
        turn: event.data.turn,
        reason: String(event.data.reason.kind),
        detail: turnEndDetail(event.data.reason),
      }
    case 'step/start':
      return { kind: 'step-start', seq: event.seq, turn: event.data.turn, step: event.data.step }
    case 'step/end':
      return { kind: 'step-end', seq: event.seq, turn: event.data.turn, step: event.data.step }
    case 'todo/write':
      return {
        kind: 'todo',
        seq: event.seq,
        todos: event.data.todos.map(item => ({ content: item.content, status: item.status })),
      }
    case 'request/header':
      return { kind: 'request', seq: event.seq, reason: event.data.reason }
    default:
      // Merge-extensible event map: log-only and plugin-owned types fall
      // through and produce no timeline row by default.
      return null
  }
}
