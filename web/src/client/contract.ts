import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationLocation, ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One raw session event captured by the replay target. */
export interface ReplayViewNode extends ConversationViewNode {
  readonly target: 'replay'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: {
    readonly event: SessionEvent
  }
}

/** The replay view target snapshot: the full raw event log in seq order. */
export interface ReplaySnapshot {
  readonly events: readonly SessionEvent[]
}
