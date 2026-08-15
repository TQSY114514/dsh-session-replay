import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import {
  alignRuns, computeStats, diffRuns, fingerprintEvents, lcsPairs, renderDiff,
} from '../src/diff.ts'
import type { Fingerprint } from '../src/diff.ts'

function user(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq, time, surfaceOp: 'append',
    data: { id: MessageId(`u-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function assistant(seq: number, time: number, text: string): SessionEvent {
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

function toolCall(seq: number, time: number, callId: string, name: string): SessionEvent {
  return { type: 'tool/call', seq, time, data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: '{}' } }
}

function toolResult(seq: number, time: number, callId: string, ok: boolean): SessionEvent {
  return {
    type: 'tool/result', seq, time, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: MessageId(`r-${seq}`), role: 'user',
        content: [{
          type: 'tool-result', toolCallId: CallId(callId),
          content: [{ type: 'text', text: ok ? 'done' : 'boom' }],
          ...(ok ? {} : { isError: true }),
        }],
        source: { kind: 'tool', callId: CallId(callId) },
      },
      ...(ok ? {} : { error: { name: 'ToolError', code: 'E_FAIL' } }),
    },
  }
}

function turnStart(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq, time, data: { turn } }
}

describe('fingerprintEvents', () => {
  it('reduces a log to user/assistant/tool alignment labels', () => {
    const events = [
      turnStart(0, 1000, 1),
      user(1, 1100, 'hi'),
      assistant(2, 2100, 'ok'),
      toolCall(3, 2200, 'c1', 'grep'),
      toolResult(4, 5200, 'c1', true),
    ]
    expect(fingerprintEvents(events)).toEqual([
      { seq: 1, label: 'user' },
      { seq: 2, label: 'assistant' },
      { seq: 3, label: 'tool:grep' },
      { seq: 4, label: 'result:grep' },
    ])
  })

  it('resolves tool-result names from their preceding tool call', () => {
    const events = [toolCall(0, 1000, 'c1', 'read_file'), toolResult(1, 2000, 'c1', true)]
    expect(fingerprintEvents(events)[1]?.label).toBe('result:read_file')
  })
})

describe('lcsPairs and alignRuns', () => {
  it('aligns identical sequences fully', () => {
    const a = fingerprintEvents([user(0, 0, 'a'), assistant(1, 1, 'b')])
    const ops = alignRuns(a, a)
    expect(ops.every(op => op.kind === 'equal')).toBe(true)
    expect(ops).toHaveLength(2)
  })

  it('marks insertions and deletions around a common core', () => {
    const a = fingerprintEvents([user(0, 0, 'a'), toolCall(1, 1, 'c1', 'grep'), assistant(2, 2, 'b')])
    const b = fingerprintEvents([user(0, 0, 'a'), toolCall(1, 1, 'c1', 'read_file'), assistant(2, 2, 'b')])
    const ops = alignRuns(a, b)
    // Common user/assistant match; the divergent tool call becomes only-a + only-b.
    expect(ops).toEqual([
      { kind: 'equal', aIndex: 0, bIndex: 0 },
      { kind: 'only-a', aIndex: 1 },
      { kind: 'only-b', bIndex: 1 },
      { kind: 'equal', aIndex: 2, bIndex: 2 },
    ])
  })

  it('recovers alignment across an extra step in one run', () => {
    const a = fingerprintEvents([user(0, 0, 'a'), assistant(1, 1, 'b')])
    const b = fingerprintEvents([user(0, 0, 'a'), assistant(1, 1, 'x'), assistant(2, 2, 'b')])
    const ops = alignRuns(a, b)
    // Greedy backtracking matches the first common assistant; the extra one
    // surfaces as an insertion on the B side.
    expect(ops).toEqual([
      { kind: 'equal', aIndex: 0, bIndex: 0 },
      { kind: 'equal', aIndex: 1, bIndex: 1 },
      { kind: 'only-b', bIndex: 2 },
    ])
  })

  it('aligns long same-task runs through the divergent middle only', () => {
    // Two runs sharing a 20k-row prefix and suffix with a small divergent
    // middle: the DP never sees the shared regions, so this stays fast and
    // produces prefix pairs + middle alignment + suffix pairs.
    const fp = (seq: number, label: string): Fingerprint => ({ seq, label })
    const prefix = Array.from({ length: 20_000 }, (_, i) => fp(i, 'assistant'))
    const suffix = Array.from({ length: 20_000 }, (_, i) => fp(30_000 + i, 'user'))
    const a = [...prefix, fp(20_000, 'tool:grep'), fp(20_001, 'result:grep'), ...suffix]
    const b = [...prefix, fp(20_000, 'tool:grep'), fp(20_001, 'result:grep'), fp(20_002, 'assistant'), ...suffix]
    const pairs = lcsPairs(a, b)
    // All of the prefix and suffix match; only B's extra assistant is unmatched.
    expect(pairs).toHaveLength(a.length)
    expect(pairs.at(-1)).toEqual({ aIndex: a.length - 1, bIndex: b.length - 1 })
    expect(alignRuns(a, b).filter(op => op.kind === 'only-b')).toEqual([{ kind: 'only-b', bIndex: 20_002 }])
  })

  it('keeps only the trimmed anchors when the middle is too divergent for a table', () => {
    // 5k × 5k distinct labels exceed the DP cell ceiling: the matcher must
    // keep the shared head/tail and report the middles as unmatched rather
    // than allocating a giant table.
    const fp = (seq: number, label: string): Fingerprint => ({ seq, label })
    const head = Array.from({ length: 10 }, (_, i) => fp(i, `head:${i}`))
    const tailA = Array.from({ length: 10 }, (_, i) => fp(6000 + i, `tail:${i}`))
    const midA = Array.from({ length: 5000 }, (_, i) => fp(10 + i, `a:${i}`))
    const midB = Array.from({ length: 5000 }, (_, i) => fp(10 + i, `b:${i}`))
    const a = [...head, ...midA, ...tailA]
    const b = [...head, ...midB, ...tailA.map((_, i) => fp(6000 + i, `tail:${i}`))]
    const pairs = lcsPairs(a, b)
    expect(pairs).toHaveLength(20) // 10 head + 10 tail anchors, middles unmatched
    expect(pairs[0]).toEqual({ aIndex: 0, bIndex: 0 })
    expect(pairs.at(-1)).toEqual({ aIndex: a.length - 1, bIndex: b.length - 1 })
  })

  it('aligns two identical giant sequences fully through trimming alone', () => {
    const a = Array.from({ length: 30_000 }, (_, i): Fingerprint => ({ seq: i, label: `row:${i % 50}` }))
    const pairs = lcsPairs(a, a)
    expect(pairs).toHaveLength(30_000)
    expect(pairs.every((pair, i) => pair.aIndex === i && pair.bIndex === i)).toBe(true)
  })
})

describe('computeStats', () => {
  it('counts turns, tools, failures, and duration', () => {
    const events = [
      turnStart(0, 1000, 1),
      turnStart(1, 2000, 2),
      toolCall(2, 3000, 'c1', 'bash'),
      toolResult(3, 4000, 'c1', false),
      toolCall(4, 5000, 'c2', 'bash'),
      toolResult(5, 6000, 'c2', true),
    ]
    expect(computeStats(events)).toEqual({
      turnCount: 2,
      toolCallCount: 2,
      failureCount: 1,
      durationMs: 5000,
    })
  })

  it('reports zero duration for an empty log', () => {
    expect(computeStats([])).toEqual({
      turnCount: 0, toolCallCount: 0, failureCount: 0, durationMs: 0,
    })
  })
})

describe('renderDiff', () => {
  it('renders matching rows once and divergent rows on both sides', () => {
    const a = fingerprintEvents([user(0, 0, 'hello'), toolCall(1, 1, 'c1', 'grep')])
    const b = fingerprintEvents([user(0, 0, 'hello'), toolCall(1, 1, 'c1', 'grep')])
    const ops = alignRuns(a, b)
    const textFor = (f: { seq: number; label: string }): string => f.label
    const lines = renderDiff(ops, a, b, textFor, textFor)
    expect(lines).toEqual(['  user', '  tool:grep'])
  })

  it('marks only-a and only-b rows with < and >', () => {
    const a = fingerprintEvents([user(0, 0, 'a'), toolCall(1, 1, 'c1', 'grep')])
    const b = fingerprintEvents([user(0, 0, 'a'), toolCall(1, 1, 'c1', 'read_file')])
    const ops = alignRuns(a, b)
    const textFor = (f: { seq: number; label: string }): string => f.label
    const lines = renderDiff(ops, a, b, textFor, textFor)
    expect(lines).toEqual(['  user', '< tool:grep', '> tool:read_file'])
  })

  it('renders each side from its own text function', () => {
    // Same label, different content: equal rows show both columns.
    const a = fingerprintEvents([user(0, 0, 'hello')])
    const b = fingerprintEvents([user(0, 0, 'world')])
    const ops = alignRuns(a, b)
    const lines = renderDiff(ops, a, b, () => 'A text', () => 'B text')
    expect(lines).toEqual(['  A text  |  B text'])
  })
})

describe('diffRuns', () => {
  it('compares two logs and reports both stats', () => {
    const runA = [user(0, 1000, 'hi'), toolCall(1, 2000, 'c1', 'bash'), toolResult(2, 3000, 'c1', true)]
    const runB = [user(0, 1000, 'hi'), toolCall(1, 2000, 'c1', 'bash'), toolResult(2, 3000, 'c1', false)]
    const diff = diffRuns(runA, runB)
    expect(diff.a.toolCallCount).toBe(1)
    expect(diff.b.failureCount).toBe(1)
    expect(diff.ops.length).toBeGreaterThan(0)
  })
})
