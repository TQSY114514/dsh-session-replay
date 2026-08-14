/**
 * Ambient-only declaration of the `replay` view target on the shared
 * ConversationViewSnapshotMap. Deliberately NOT part of contract.ts (which
 * the package's emitted declarations chain back to): the aggregate Client
 * program loads every module in that chain, and a third map member changes
 * how TypeScript resolves unconstrained `get(target)` implementations in
 * existing package tests (generic indexed access collapses to an
 * intersection). Keeping the merge in a file only this package's own
 * program compiles gives `views.get('replay')` its type here without
 * perturbing the shared map elsewhere.
 */
import type { ReplaySnapshot } from './contract.ts'

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Raw event log assembled by the replay target. */
    replay: ReplaySnapshot
  }
}
