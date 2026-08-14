# @deepseek-ai/dsh-client-ui-replay

English | [中文](README.zh.md)

Replay renders the raw session event log as a playable timeline — the Agent Run
Replay view tab beside Chat and Trajectory. A transport strip drives a
cursor-based player: play/pause, single step, 1/2/4/8× speed, previous/next
turn jumps, and a seek strip over the whole log. The timeline virtualizes the
row window (tens of thousands of events render smoothly), paints turn
boundaries as amber bands, colors user/tool/error rows by kind, and expands
tool calls in place to reveal the full raw arguments or result content. While
the host session is still running, newly recorded events append to the log and
the player keeps following; older history pages in through the same
`loadOlder` seat the other views use, rebuilding the engine at the same
position.

The raw event log reaches the browser through the conversation target
registry: every window event is captured as its own business Context and
assembled into the `replay` view snapshot, so the player is a pure consumer
with no host RPC of its own. Playback itself rides the shared
`@deepseek-ai/dsh-session-replay` engine — the same tested core the CLI player
uses.

## Model Experience

None, as the replay views render session data in the browser; nothing here
reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Older-history paging rebuilds the engine** — the replay engine has no
  prepend, so loading an older page replaces the engine over the expanded
  window and restores the position by seq; the transport resets to paused.
- **Live follow stays at the observed end** — events appended while the
  player idles at the end extend the log but do not auto-advance the cursor;
  pressing play resumes through them.
- **One Context per raw event** — the capture Definition materializes one
  engine Context per event; a very long window costs linear Context bookkeeping
  in the session assembler.
