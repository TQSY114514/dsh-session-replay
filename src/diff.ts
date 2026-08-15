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
 * DP cell ceiling for the middle (post-trim) alignment: beyond this the two
 * runs are so divergent that a full table is not worth allocating — alignment
 * falls back to the trimmed anchors only. 16M cells ≈ a 64 MiB Int32Array.
 */
const MAX_DP_CELLS = 16_000_000

/**
 * Longest common subsequence alignment of two fingerprint sequences. Returns
 * the matched (aIndex, bIndex) pairs in ascending order.
 *
 * Scaling: the common prefix and suffix are trimmed first (the same-task runs
 * this tool compares share their head and tail, often tens of thousands of
 * events), and the DP runs only over the divergent middle, in a flat
 * Int32Array. A middle larger than `MAX_DP_CELLS` means the runs are almost
 * entirely different — those keep the trimmed anchors and report the middles
 * as unmatched instead of allocating a giant table.
 */
export function lcsPairs(
  a: readonly Fingerprint[],
  b: readonly Fingerprint[],
): Array<{ readonly aIndex: number; readonly bIndex: number }> {
  const n = a.length
  const m = b.length
  const pairs: Array<{ readonly aIndex: number; readonly bIndex: number }> = []

  // Trim the common prefix (always part of a maximal LCS).
  let prefix = 0
  while (prefix < n && prefix < m && a[prefix]?.label === b[prefix]?.label) prefix += 1
  for (let k = 0; k < prefix; k += 1) pairs.push({ aIndex: k, bIndex: k })

  // Trim the common suffix without overlapping the prefix.
  let suffix = 0
  while (
    suffix < n - prefix && suffix < m - prefix
    && a[n - 1 - suffix]?.label === b[m - 1 - suffix]?.label
  ) suffix += 1

  const midN = n - prefix - suffix
  const midM = m - prefix - suffix
  if (midN > 0 && midM > 0 && (midN + 1) * (midM + 1) <= MAX_DP_CELLS) {
    // Classic O(midN·midM) DP over a flat Int32Array, backtracked greedily.
    const width = midM + 1
    const dp = new Int32Array((midN + 1) * width)
    for (let i = midN - 1; i >= 0; i -= 1) {
      const aLabel = a[prefix + i]?.label
      const row = i * width
      const below = (i + 1) * width
      for (let j = midM - 1; j >= 0; j -= 1) {
        const above = dp[below + j]
        const left = dp[row + j + 1]
        dp[row + j] = aLabel !== undefined && aLabel === b[prefix + j]?.label
          ? dp[below + j + 1] + 1
          : above >= left ? above : left
      }
    }
    let i = 0
    let j = 0
    while (i < midN && j < midM) {
      const aLabel = a[prefix + i]?.label
      if (aLabel !== undefined && aLabel === b[prefix + j]?.label) {
        pairs.push({ aIndex: prefix + i, bIndex: prefix + j })
        i += 1
        j += 1
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        i += 1
      } else {
        j += 1
      }
    }
  }

  for (let k = 0; k < suffix; k += 1) pairs.push({ aIndex: n - suffix + k, bIndex: m - suffix + k })
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
