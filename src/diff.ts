import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One event's alignment token: a coarse kind label plus its log seq for lookup. */
export interface Fingerprint {
  /** Log seq of the source event, for resolving rendered text later. */
  readonly seq: number
  /** Coarse alignment label: `user`, `assistant`, `tool:<name>`, `result:<name>`. */
  readonly label: string
}

/** Aggregated per-run metrics for the diff header. */
export interface RunStats {
  readonly turnCount: number
  readonly toolCallCount: number
  readonly failureCount: number
  /** Wall-clock span between the first and last event, in ms. */
  readonly durationMs: number
}

/** One aligned position in a two-run comparison. */
export type DiffOp =
  | { readonly kind: 'equal'; readonly aIndex: number; readonly bIndex: number }
  | { readonly kind: 'only-a'; readonly aIndex: number }
  | { readonly kind: 'only-b'; readonly bIndex: number }

/** The complete comparison of two runs. */
export interface RunDiff {
  readonly ops: readonly DiffOp[]
  readonly a: RunStats
  readonly b: RunStats
}

/**
 * Reduce a session event log to an alignment fingerprint sequence. Only
 * message and tool events participate in alignment — turn/step boundaries,
 * todos, and request headers are noise for the LCS. Tool results resolve
 * their name from the preceding `tool/call`, so `tool:grep` / `result:grep`
 * stay paired even when the surrounding turns differ.
 */
export function fingerprintEvents(events: readonly SessionEvent[]): Fingerprint[] {
  const toolNames = new Map<string, string>()
  const out: Fingerprint[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        out.push({ seq: event.seq, label: 'user' })
        break
      case 'assistant/message':
        out.push({ seq: event.seq, label: 'assistant' })
        break
      case 'tool/call':
        toolNames.set(event.data.callId, event.data.name)
        out.push({ seq: event.seq, label: `tool:${event.data.name}` })
        break
      case 'tool/result': {
        const callId = event.data.message.content[0]?.toolCallId ?? ''
        out.push({ seq: event.seq, label: `result:${toolNames.get(callId) ?? '?'}` })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Aggregate per-run metrics from the raw event log: turn count, tool call
 * count, tool failure count, and wall-clock duration.
 */
export function computeStats(events: readonly SessionEvent[]): RunStats {
  let turnCount = 0
  let toolCallCount = 0
  let failureCount = 0
  let firstTime = Number.POSITIVE_INFINITY
  let lastTime = Number.NEGATIVE_INFINITY
  for (const event of events) {
    if (event.time < firstTime) firstTime = event.time
    if (event.time > lastTime) lastTime = event.time
    switch (event.type) {
      case 'turn/start':
        turnCount += 1
        break
      case 'tool/call':
        toolCallCount += 1
        break
      case 'tool/result': {
        const block = event.data.message.content[0]
        if (event.data.error !== undefined || block?.isError === true) failureCount += 1
        break
      }
      default:
        break
    }
  }
  return {
    turnCount,
    toolCallCount,
    failureCount,
    durationMs: events.length === 0 ? 0 : Math.max(0, lastTime - firstTime),
  }
}

/**
 * Longest common subsequence alignment of two fingerprint sequences. Returns
 * the matched (aIndex, bIndex) pairs in ascending order.
 *
 * Classic O(n·m) DP with a full table for backtracking; fine for typical
 * session logs (thousands of events) and documented as a ceiling for
 * pathological multi-tens-of-thousands logs.
 */
export function lcsPairs(
  a: readonly Fingerprint[],
  b: readonly Fingerprint[],
): Array<{ readonly aIndex: number; readonly bIndex: number }> {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    const aLabel = a[i]?.label
    for (let j = m - 1; j >= 0; j -= 1) {
      const above = dp[i + 1]?.[j] ?? 0
      const left = dp[i]?.[j + 1] ?? 0
      if (aLabel !== undefined && aLabel === b[j]?.label) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1
      } else {
        dp[i]![j] = above >= left ? above : left
      }
    }
  }
  const pairs: Array<{ readonly aIndex: number; readonly bIndex: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const aLabel = a[i]?.label
    if (aLabel !== undefined && aLabel === b[j]?.label) {
      pairs.push({ aIndex: i, bIndex: j })
      i += 1
      j += 1
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

/** Walk the LCS pairs to a flat op stream: equal pairs, then only-a / only-b gaps. */
export function alignRuns(a: readonly Fingerprint[], b: readonly Fingerprint[]): DiffOp[] {
  const ops: DiffOp[] = []
  let ai = 0
  let bi = 0
  for (const pair of lcsPairs(a, b)) {
    while (ai < pair.aIndex) {
      ops.push({ kind: 'only-a', aIndex: ai })
      ai += 1
    }
    while (bi < pair.bIndex) {
      ops.push({ kind: 'only-b', bIndex: bi })
      bi += 1
    }
    ops.push({ kind: 'equal', aIndex: ai, bIndex: bi })
    ai += 1
    bi += 1
  }
  while (ai < a.length) {
    ops.push({ kind: 'only-a', aIndex: ai })
    ai += 1
  }
  while (bi < b.length) {
    ops.push({ kind: 'only-b', bIndex: bi })
    bi += 1
  }
  return ops
}

/** Compare two runs end to end. */
export function diffRuns(
  aEvents: readonly SessionEvent[],
  bEvents: readonly SessionEvent[],
): RunDiff {
  const a = fingerprintEvents(aEvents)
  const b = fingerprintEvents(bEvents)
  return {
    ops: alignRuns(a, b),
    a: computeStats(aEvents),
    b: computeStats(bEvents),
  }
}

/**
 * Render an aligned diff as side-by-side text lines. `aText` resolves run A's
 * fingerprints and `bText` run B's — each side must render from its own log,
 * because the two runs share seq numbers only by coincidence. Equal labels
 * with identical text print once, divergent equals print both columns, and
 * unmatched rows are prefixed `<` (run A only) or `>` (run B only).
 */
export function renderDiff(
  ops: readonly DiffOp[],
  a: readonly Fingerprint[],
  b: readonly Fingerprint[],
  aText: (fingerprint: Fingerprint) => string,
  bText: (fingerprint: Fingerprint) => string,
): string[] {
  const lines: string[] = []
  for (const op of ops) {
    if (op.kind === 'equal') {
      const ta = aText(a[op.aIndex] ?? { seq: -1, label: '?' })
      const tb = bText(b[op.bIndex] ?? { seq: -1, label: '?' })
      lines.push(ta === tb ? `  ${ta}` : `  ${ta}  |  ${tb}`)
    } else if (op.kind === 'only-a') {
      lines.push(`< ${aText(a[op.aIndex] ?? { seq: -1, label: '?' })}`)
    } else {
      lines.push(`> ${bText(b[op.bIndex] ?? { seq: -1, label: '?' })}`)
    }
  }
  return lines
}
