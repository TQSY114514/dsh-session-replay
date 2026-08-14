import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { noopRenderDeps, renderEvent } from '../src/engine/render.ts'
import type { RenderDeps } from '../src/engine/render.ts'

const deps: RenderDeps = { toolName: callId => (callId === 'c1' ? 'read_file' : undefined) }

function user(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      id: MessageId(`u-${seq}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

function assistant(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId(`a-${seq}`),
        role: 'assistant',
        content: [
          { type: 'text', text },
          { type: 'tool-call', id: CallId('c1'), name: 'read_file', arguments: '{"path":"a.ts"}' },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
  }
}

function toolCall(seq: number, time: number): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time,
    data: { turn: 1, step: 1, callId: CallId('c1'), name: 'read_file', arguments: '{"path":"a.ts"}' },
  }
}

function toolResult(seq: number, time: number, error: boolean): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId(`r-${seq}`),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: CallId('c1'),
          content: [{ type: 'text', text: error ? 'boom' : 'file content' }],
          ...(error ? { isError: true } : {}),
        }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
      ...(error ? { error: { name: 'ToolError', code: 'E_FAIL' } } : {}),
    },
  }
}

describe('renderEvent', () => {
  it('renders user messages with visible text only', () => {
    expect(renderEvent(user(0, 1000, 'hello'), deps)).toEqual({
      kind: 'user', seq: 0, text: 'hello',
    })
  })

  it('skips empty user messages', () => {
    expect(renderEvent(user(0, 1000, ''), deps)).toBeNull()
  })

  it('renders assistant messages with extracted tool calls', () => {
    expect(renderEvent(assistant(1, 2000, 'reading'), deps)).toEqual({
      kind: 'assistant',
      seq: 1,
      text: 'reading',
      toolCalls: [{ callId: 'c1', name: 'read_file', args: '{"path":"a.ts"}' }],
    })
  })

  it('renders tool calls with raw arguments', () => {
    expect(renderEvent(toolCall(2, 3000), deps)).toEqual({
      kind: 'tool-call', seq: 2, name: 'read_file', args: '{"path":"a.ts"}',
    })
  })

  it('renders successful tool results with the resolved tool name', () => {
    expect(renderEvent(toolResult(3, 4000, false), deps)).toEqual({
      kind: 'tool-result',
      seq: 3,
      callId: 'c1',
      name: 'read_file',
      ok: true,
      content: 'file content',
      error: undefined,
    })
  })

  it('marks failed tool results as not ok and carries the failure identity', () => {
    expect(renderEvent(toolResult(3, 4000, true), deps)).toEqual({
      kind: 'tool-result',
      seq: 3,
      callId: 'c1',
      name: 'read_file',
      ok: false,
      content: 'boom',
      error: 'ToolError: E_FAIL',
    })
  })

  it('leaves the tool name unresolved when deps do not know the call', () => {
    expect(renderEvent(toolResult(3, 4000, false), noopRenderDeps)).toMatchObject({ name: undefined })
  })

  it('renders turn boundaries', () => {
    expect(renderEvent({ type: 'turn/start', seq: 4, time: 5000, data: { turn: 1 } }, deps))
      .toEqual({ kind: 'turn-start', seq: 4, turn: 1 })
    expect(renderEvent({ type: 'turn/end', seq: 5, time: 6000, data: { turn: 1, reason: { kind: 'completed' } } }, deps))
      .toEqual({ kind: 'turn-end', seq: 5, turn: 1, reason: 'completed', detail: undefined })
  })

  it('renders aborted turn endings with their cancel cause', () => {
    expect(renderEvent({
      type: 'turn/end',
      seq: 6,
      time: 7000,
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy denied' } } },
    }, deps)).toEqual({
      kind: 'turn-end', seq: 6, turn: 1, reason: 'aborted', detail: 'aborted by hook: policy denied',
    })
  })

  it('renders error turn endings with the failure message', () => {
    expect(renderEvent({
      type: 'turn/end',
      seq: 7,
      time: 8000,
      data: {
        turn: 1,
        reason: { kind: 'error', error: { message: 'provider timeout', code: 'E_TIMEOUT' } },
      },
    }, deps)).toEqual({
      kind: 'turn-end', seq: 7, turn: 1, reason: 'error', detail: 'error: provider timeout (E_TIMEOUT)',
    })
  })

  it('renders step boundaries', () => {
    expect(renderEvent({ type: 'step/start', seq: 6, time: 7000, data: { turn: 2, step: 1 } }, deps))
      .toEqual({ kind: 'step-start', seq: 6, turn: 2, step: 1 })
  })

  it('renders todo snapshots', () => {
    expect(renderEvent({
      type: 'todo/write',
      seq: 7,
      time: 8000,
      data: { todos: [{ content: 'fix bug', status: 'in_progress' }] },
    }, deps)).toEqual({ kind: 'todo', seq: 7, todos: [{ content: 'fix bug', status: 'in_progress' }] })
  })

  it('renders request headers by reason', () => {
    expect(renderEvent({
      type: 'request/header',
      seq: 8,
      time: 9000,
      // header is an EpochHeader; the renderer only reads `reason`.
      data: { header: {} as never, reason: 'initial' },
    }, deps)).toEqual({ kind: 'request', seq: 8, reason: 'initial' })
  })

  it('folds assistant chunks into their owning message (returns null)', () => {
    expect(renderEvent({
      type: 'assistant/chunk',
      seq: 9,
      time: 9500,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    }, deps)).toBeNull()
  })

  it('skips unknown merge-extensible event types', () => {
    const unknown = { type: 'plugin/owned', seq: 10, time: 10000, data: {} } as unknown as SessionEvent
    expect(renderEvent(unknown, deps)).toBeNull()
  })
})
