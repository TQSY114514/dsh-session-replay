#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ReplayEngine } from '../engine/index.ts'
import { renderEntryLine } from './player.ts'
import { loadRun } from '../store/reader.ts'
import type { Speed } from '../types.ts'
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
}

function parseOptions(argv: readonly string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = []
  let store = defaultStoreRoot()
  let speed: Speed | undefined
  let compression: 'zstd' | 'none' = 'zstd'
  let headless = false
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
  return { positional, options: { store, speed, compression, headless } }
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

async function main(): Promise<void> {
  const { positional, options } = parseOptions(process.argv.slice(2))
  if (positional.length === 0) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  try {
    if (positional[0] === 'list') {
      await listSessions(options.store, options.compression)
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
