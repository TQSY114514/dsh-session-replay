#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ReplayEngine } from '../engine/index.ts'
import { renderEntryLine } from './player.ts'
import { loadRun } from '../store/reader.ts'
import type { LoadedRun } from '../store/reader.ts'
import { diffRuns, fingerprintEvents, renderDiff } from '../diff.ts'
import type { Fingerprint, RunStats } from '../diff.ts'
import { forkRun } from '../fork.ts'
import type { Speed } from '../types.ts'
import { noopRenderDeps, renderEvent } from '../engine/render.ts'
import { runPlayer } from './player.ts'

/**
 * Default session store root, mirroring the base bundle's `dshHomePath('sessions')`:
 * `$DSH_HOME/sessions` when set, otherwise `~/.dsh/sessions`.
 */
function defaultStoreRoot(): string {
  const override = process.env.DSH_HOME
  return join(override !== undefined && override.trim().length > 0 ? override : join(homedir(), '.dsh'), 'sessions')
}

const USAGE = `dsh-replay — Agent Run Replay for DeepSeek Harness

Usage:
  dsh-replay list [--store <dir>] [--compression zstd|none]
                                                  list recorded sessions
  dsh-replay <session-id> [--store <dir>] [--compression zstd|none]
                  [--speed 1|2|4|8] [--headless]  replay one session
  dsh-replay diff <id-a> <id-b> [--store <dir>] [--compression zstd|none]
                                                  align and compare two runs
  dsh-replay fork <source-id> [--at <seq>] [--turn <n>] [--child <id>]
                  [--store <dir>] [--compression zstd|none]
                                                  fork the run at a boundary

The store defaults to ~/.dsh/sessions (overridable with --store); the
physical encoding defaults to zstd (--compression none for plain .jsonl).
Keys while replaying: space play/pause, s step, [ ] prev/next turn,
up/down select tool, enter expand, 1/2/4/8 speed, q quit.
--headless dumps the whole timeline and exits.`

interface CliOptions {
  readonly store: string
  readonly speed: Speed | undefined
  readonly compression: 'zstd' | 'none'
  readonly headless: boolean
  readonly at: number | undefined
  readonly turn: number | undefined
  readonly child: string | undefined
}

function parseOptions(argv: readonly string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = []
  let store = defaultStoreRoot()
  let speed: Speed | undefined
  let compression: 'zstd' | 'none' = 'zstd'
  let headless = false
  let at: number | undefined
  let turn: number | undefined
  let child: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--store') {
      i += 1
      const value = argv[i]
      if (value === undefined) {
        process.stderr.write('--store requires a directory\n')
        process.exit(2)
      }
      store = value
    } else if (arg === '--at') {
      i += 1
      const value = Number(argv[i])
      if (!Number.isSafeInteger(value) || value < 0) {
        process.stderr.write('--at requires a non-negative integer seq\n')
        process.exit(2)
      }
      at = value
    } else if (arg === '--turn') {
      i += 1
      const value = Number(argv[i])
      if (!Number.isInteger(value) || value < 1) {
        process.stderr.write('--turn requires a positive integer turn number\n')
        process.exit(2)
      }
      turn = value
    } else if (arg === '--child') {
      i += 1
      const value = argv[i]
      if (value === undefined) {
        process.stderr.write('--child requires an id\n')
        process.exit(2)
      }
      child = value
    } else if (arg === '--compression') {
      i += 1
      const value = argv[i]
      if (value !== 'zstd' && value !== 'none') {
        process.stderr.write('--compression must be zstd or none\n')
        process.exit(2)
      }
      compression = value
    } else if (arg === '--speed') {
      i += 1
      const raw = argv[i]
      if (raw === undefined) {
        process.stderr.write('--speed requires a value\n')
        process.exit(2)
      }
      const value = Number(raw)
      if (value !== 1 && value !== 2 && value !== 4 && value !== 8) {
        process.stderr.write('--speed must be 1, 2, 4, or 8\n')
        process.exit(2)
      }
      speed = value
    } else if (arg === '--headless') {
      headless = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else {
      positional.push(arg)
    }
  }
  return { positional, options: { store, speed, compression, headless, at, turn, child } }
}

function openPersistence(store: string, compression: 'zstd' | 'none'): JsonlSessionPersistence {
  const ctx = new Context()
  // The JSONL coordinator requires the sessions service for its write path.
  new SessionStore(ctx)
  return new JsonlSessionPersistence(ctx, { root: store, compression })
}

async function listSessions(store: string, compression: 'zstd' | 'none'): Promise<void> {
  const persistence = openPersistence(store, compression)
  const headers = await persistence.list()
  if (headers.length === 0) {
    process.stdout.write(`no sessions recorded under ${store}\n`)
    return
  }
  process.stdout.write(`${headers.length} session(s) under ${store}:\n`)
  for (const header of headers) {
    const cwd = header.cwd ?? '-'
    const created = new Date(header.createdAt).toISOString()
    process.stdout.write(`  ${header.id}  created: ${created}  cwd: ${cwd}\n`)
  }
}

async function replay(idText: string, store: string, compression: 'zstd' | 'none', speed: Speed | undefined): Promise<void> {
  const persistence = openPersistence(store, compression)
  const id = SessionId(idText)
  const run = await loadRun(persistence, id)
  const engine = new ReplayEngine(run.events)
  if (speed !== undefined) engine.setSpeed(speed)
  process.stdout.write(`replaying ${id} (${run.events.length} events, ${run.meta.cwd ?? '-'})\n`)
  await runPlayer(engine)
}

/** Non-interactive dump: step through the whole run and print every rendered row. */
async function replayHeadless(idText: string, store: string, compression: 'zstd' | 'none'): Promise<void> {
  const persistence = openPersistence(store, compression)
  const id = SessionId(idText)
  const run = await loadRun(persistence, id)
  const engine = new ReplayEngine(run.events)
  process.stdout.write(`# replay ${id} — ${run.events.length} events, ${run.meta.cwd ?? '-'}\n`)
  engine.onEmit = entry => { process.stdout.write(`${renderEntryLine(entry)}\n`) }
  while (engine.step() !== null) { /* drain */ }
  process.stdout.write(`# done — ${run.events.length} events\n`)
}

function statsLine(id: string, stats: RunStats): string {
  return `${id}: ${stats.turnCount} turns, ${stats.toolCallCount} tools, ${stats.failureCount} failures, ${stats.durationMs}ms`
}

/** Fork a recorded run at a boundary and print the child session identity. */
async function forkSession(
  sourceIdText: string,
  at: number | undefined,
  turn: number | undefined,
  childIdText: string | undefined,
  store: string,
  compression: 'zstd' | 'none',
): Promise<void> {
  const ctx = new Context()
  new SessionStore(ctx)
  new JsonlSessionPersistence(ctx, { root: store, compression })
  // Forking needs a live source; forkRun rebuilds it from persistence.
  const result = await forkRun(ctx, SessionId(sourceIdText), {
    ...(at !== undefined ? { boundary: at } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(childIdText !== undefined ? { childId: SessionId(childIdText) } : {}),
  })
  process.stdout.write(`forked ${sourceIdText} @ seq ${result.boundary} -> ${result.child.id}\n`)
  process.stdout.write(`  child cwd: ${result.child.header.cwd ?? '-'}\n`)
  process.stdout.write(`  seed length: ${result.child.header.seedLength ?? 0} events (cut ${result.cut.length})\n`)
  process.stdout.write('  continue it in the harness (resume the child session) to re-run from this point\n')
}

/** Align two recorded runs and print the side-by-side diff plus metrics. */
async function diffSessions(
  idAText: string,
  idBText: string,
  store: string,
  compression: 'zstd' | 'none',
): Promise<void> {
  const persistence = openPersistence(store, compression)
  const runA = await loadRun(persistence, SessionId(idAText))
  const runB = await loadRun(persistence, SessionId(idBText))
  const diff = diffRuns(runA.events, runB.events)

  process.stdout.write(`# diff ${runA.id} vs ${runB.id}\n`)
  process.stdout.write(`  ${statsLine(String(runA.id), diff.a)}\n`)
  process.stdout.write(`  ${statsLine(String(runB.id), diff.b)}\n\n`)

  const textFor = (run: LoadedRun) => (fingerprint: Fingerprint): string => {
    const event = run.events[fingerprint.seq]
    if (event === undefined) return fingerprint.label
    const entry = renderEvent(event, noopRenderDeps)
    return entry === null ? fingerprint.label : renderEntryLine(entry)
  }
  const a = fingerprintEvents(runA.events)
  const b = fingerprintEvents(runB.events)
  // Each side must render from its own log: seq numbers coincide only by accident.
  for (const line of renderDiff(diff.ops, a, b, textFor(runA), textFor(runB))) {
    process.stdout.write(`${line}\n`)
  }
}

async function main(): Promise<void> {
  const { positional, options } = parseOptions(process.argv.slice(2))
  if (positional.length === 0) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  try {
    const command = positional[0]
    if (command === 'list') {
      await listSessions(options.store, options.compression)
    } else if (command === 'fork') {
      const sourceId = positional[1]
      if (sourceId === undefined) {
        process.stdout.write(`${USAGE}\n`)
        return
      }
      await forkSession(sourceId, options.at, options.turn, options.child, options.store, options.compression)
    } else if (command === 'diff') {
      const idA = positional[1]
      const idB = positional[2]
      if (idA === undefined || idB === undefined) {
        process.stdout.write(`${USAGE}\n`)
        return
      }
      await diffSessions(idA, idB, options.store, options.compression)
    } else {
      const id = positional[0]
      if (id === undefined) {
        process.stdout.write(`${USAGE}\n`)
        return
      }
      if (options.headless) await replayHeadless(id, options.store, options.compression)
      else await replay(id, options.store, options.compression, options.speed)
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

await main()
