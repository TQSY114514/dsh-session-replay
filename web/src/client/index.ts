/**
 * Browser replay plugin contributing one entry to the conversation view
 * slot without defining a service. The raw event log reaches the view
 * through the conversation target registry: every window event is captured
 * as its own Context and assembled into the `replay` view snapshot.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locales.ts'
import {
  registerReplayConversationView, registerReplayEventDefinition,
} from './replay-definitions.ts'
import { ReplayView, type ReplayViewInjected } from './ReplayView.tsx'

/** Required services: the conversation slot, registries, Session paging, and the locale service. */
export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']

/**
 * Client plugin body: register the replay view tab. The registration rides
 * the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-replay: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  registerReplayEventDefinition(ctx)
  registerReplayConversationView(ctx)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'replay',
    order: 20,
    locale: NS,
    label: () => t('view.replay'),
    inject: (sessionId: SessionId): ReplayViewInjected => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) {
        throw new Error(`ui-replay: session "${sessionId}" is unavailable`)
      }
      return {
        loadOlder: () => session.loadOlder(),
      }
    },
  }, ReplayView))
}
