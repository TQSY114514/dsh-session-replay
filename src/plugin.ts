import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReplayEngine } from './engine/index.ts'
import { loadRun } from './store/reader.ts'
import { renderEntryLine } from './cli/player.ts'
import { LiveReplay } from './live.ts'

/** Cap the command's text payload so a giant session cannot flood the UI. */
const MAX_OUTPUT_CHARS = 6000

/**
 * Render one recorded run to the command's text payload. Pure of the
 * invocation plumbing so tests can drive it with a real context and backend.
 */
export async function runReplayCommand(
  ctx: Context,
  targetId: SessionId,
  follow: boolean,
): Promise<CommandResult> {
  try {
    const run = await loadRun(ctx.sessionPersistence, targetId)
    const engine = new ReplayEngine(run.events)
    const lines: string[] = []
    engine.onEmit = entry => { lines.push(renderEntryLine(entry)) }
    while (engine.step() !== null) { /* drain */ }
    let text = lines.join('\n')
    if (text.length > MAX_OUTPUT_CHARS) {
      text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated at ${MAX_OUTPUT_CHARS} chars)`
    }
    if (follow) {
      const live = new LiveReplay(ctx, targetId, run.events)
      ctx.effect(() => () => live.dispose(), 'session-replay: live follow')
      text += '\n(following live events for this session)'
    }
    return { kind: 'success', text }
  } catch (error) {
    return {
      kind: 'error',
      text: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Function plugin: `ctx.commands.register` on the documented extension point. */
export const name = 'session-replay'
export const inject = ['commands', 'sessions', 'sessionPersistence']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'replay',
    description: 'Replay a recorded agent run as a text timeline; append --follow to keep streaming live events',
    input: { hint: '[session-id] [--follow]' },
    handler: async ({ agent, rawInput }: CommandInvocation): Promise<CommandResult> => {
      const parts = rawInput.trim().split(/\s+/).filter(part => part.length > 0)
      const follow = parts.includes('--follow')
      const idText = parts.find(part => part !== '--follow')
      const targetId = idText === undefined ? agent.session.id : SessionId(idText)
      return runReplayCommand(ctx, targetId, follow)
    },
  })
}
