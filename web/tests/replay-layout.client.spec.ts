/** Pure layout specs: window rendering, row derivation, preview, and pretty-printing. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import {
  previewOf, prettyJson, renderWindow, toolNameOf,
} from '../src/client/replay-layout.ts'

function userEvent(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq, time, surfaceOp: 'append',
    data: {
      id: MessageId(`u-${seq}`), role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

function assistantEvent(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'assistant/message', seq, time, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: MessageId(`a-${seq}`), role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
  }
}

function toolCallEvent(seq: number, time: number, callId: string, name: string, args: string): SessionEvent {
  return {
    type: 'tool/call', seq, time,
    data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: args },
  }
}

function toolResultEvent(seq: number, time: number, callId: string, text: string): SessionEvent {
  return {
    type: 'tool/result', seq, time, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: MessageId(`r-${seq}`), role: 'user',
        content: [{
          type: 'tool-result', toolCallId: CallId(callId),
          content: [{ type: 'text', text }],
        }],
        source: { kind: 'tool', callId: CallId(callId) },
      },
    },
  }
}

/** One representative turn: boundaries, messages, one tool round trip. */
function sampleLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } },
    userEvent(2, 1_100, 'count the files'),
    assistantEvent(3, 2_100, 'let me look'),
    toolCallEvent(4, 2_200, 'c1', 'bash', '{"command":"ls"}'),
    toolResultEvent(5, 5_200, 'c1', 'a.ts b.ts'),
    { type: 'turn/end', seq: 6, time: 5_300, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('renderWindow', () => {
  it('renders every visible event of the prefix into rows in emit order', () => {
    const log = sampleLog()
    const rows = renderWindow(log, log.length, toolNameOf(log, log.length))
    expect(rows.map(row => row.kind)).toEqual([
      'band', 'user', 'assistant', 'tool-call', 'tool-result', 'band-end',
    ])
    expect(rows.map(row => row.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rows[0]?.time).toBe(1_000)
  })

  it('skips null-rendered events (seed markers) without breaking order', () => {
    const log: SessionEvent[] = [
      { type: 'session/end-seed', seq: 0, time: 500, data: {} },
      userEvent(1, 1_000, 'hi'),
      { type: 'session/end-seed', seq: 2, time: 1_050, data: {} },
    ]
    const rows = renderWindow(log, log.length, toolNameOf(log, log.length))
    expect(rows.map(row => row.kind)).toEqual(['user'])
    expect(rows[0]?.seq).toBe(1)
  })

  it('honors the cursor: rows cover only the emitted prefix', () => {
    const log = sampleLog()
    const rows = renderWindow(log, 4, toolNameOf(log, 4))
    expect(rows.map(row => row.kind)).toEqual(['band', 'user', 'assistant', 'tool-call'])
  })
})

describe('toolNameOf', () => {
  it('resolves tool names from tool/call events inside the prefix only', () => {
    const log = sampleLog()
    const within = toolNameOf(log, 6)
    expect(within('c1')).toBe('bash')
    // The call sits at index 3; a prefix ending before it cannot resolve it.
    const beforeCall = toolNameOf(log, 3)
    expect(beforeCall('c1')).toBeUndefined()
  })
})

describe('rowFromEntry', () => {
  it('derives an expandable tool-call row with pretty-printed args', () => {
    const log = sampleLog()
    const toolCall = log[3]
    expect(toolCall).toBeDefined()
    if (toolCall?.type !== 'tool/call') throw new Error('fixture order changed')
    const rows = renderWindow(log, 5, toolNameOf(log, 5))
    const row = rows[3]
    expect(row?.kind).toBe('tool-call')
    expect(row?.preview).toBe('{"command":"ls"}')
    expect(row?.expanded).toBe('{\n  "command": "ls"\n}')
    expect(row?.toolName).toBe('bash')
  })

  it('marks failed tool results with the recorded failure identity', () => {
    const log: SessionEvent[] = [
      toolCallEvent(1, 1_000, 'c1', 'bash', '{}'),
      {
        type: 'tool/result', seq: 2, time: 2_000, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: MessageId('r2'), role: 'user',
            content: [{
              type: 'tool-result', toolCallId: CallId('c1'),
              content: [{ type: 'text', text: '' }],
            }],
            source: { kind: 'tool', callId: CallId('c1') },
          },
          error: { name: 'E2BIG', code: 'E2BIG' },
        },
      },
    ]
    const rows = renderWindow(log, log.length, toolNameOf(log, log.length))
    const result = rows[1]
    expect(result?.kind).toBe('tool-result')
    expect(result?.ok).toBe(false)
    expect(result?.error).toBe('E2BIG: E2BIG')
    expect(result?.preview).toBe('')
  })
})

describe('previewOf', () => {
  it('collapses whitespace and caps the preview line', () => {
    expect(previewOf('a\n  b\tc')).toBe('a b c')
    expect(previewOf('x'.repeat(200)).endsWith('…')).toBe(true)
    expect(previewOf('x'.repeat(200)).length).toBe(161)
    expect(previewOf('short')).toBe('short')
  })
})

describe('prettyJson', () => {
  it('pretty-prints parseable JSON and falls back to the raw text', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('not json')).toBe('not json')
  })
})
