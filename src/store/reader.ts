import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** A fully materialized, replay-ready agent run. */
export interface LoadedRun {
  readonly id: SessionId
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

/**
 * Load one persisted session into a replay-ready event list through the
 * persistence service API — storage-backend agnostic (JSONL and SQLite both
 * satisfy the seam). `inspect` is the non-mutating read: it validates and
 * freezes the view without committing crash repair or publishing a live
 * Session.
 */
export async function loadRun(persistence: SessionPersistence, id: SessionId): Promise<LoadedRun> {
  const { meta, events } = await persistence.inspect(id)
  return { id, meta, events }
}

/**
 * Rebuild a detached `Session` from a loaded run. Runs the same seed
 * validation `ctx.sessions.create(id, { seed })` enforces (contiguous seq,
 * JSON-serializable payloads, surface transitions), so a replay that starts
 * from `rebuildSession(run)` is guaranteed to be reconstructable — but the
 * engine renders the raw log (append order) rather than the projected surface,
 * because surface replacements (compaction) shadow history a human already saw.
 */
export function rebuildSession(run: LoadedRun): Session {
  return Session.create(run.id, run.events, run.meta)
}
