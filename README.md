# dsh-session-replay

Agent Run Replay for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): record → replay. Load any recorded session event log and play it back with **play / pause / single-step / speed control / seek-to-turn / tool-call expansion**, and (planned) side-by-side diff of two runs.

It is **not** a monitor and does not re-run LLMs. The recording is already done by the harness's event-sourced session log (`SessionEvent` stream, `seq` + `time` per event); this package is the replay player.

```
[0] == Turn 1 ==
[1] user: 帮我数一下项目里有多少个 ts 文件
[2] assistant: 好的,我来查找一下项目结构。
[3] -> grep({"pattern":"*.ts","path":"src"})
[4] grep ok: src/a.ts src/b.ts src/c.ts
[5] assistant: 找到了 3 个 TypeScript 文件:src/a.ts、src/b.ts、src/c.ts。
[6] == Turn 1 end (completed) ==
```

## Status: work in progress (M1 core)

Engine, renderer, store reader, and CLI are implemented and green (63 vitest tests, `tsc -b` clean), including a real end-to-end round trip through the JSONL persistence backend. Large-session scalability pass done: diff alignment trims common head/tail before a flat-`Int32Array` DP (with a documented fallback for pathologically divergent runs), and the engine maintains folded state incrementally (O(1) per event) — see [PLAN.md](PLAN.md) §19.

**Installation note**: the `@deepseek-ai/dsh-*` packages are pre-release and their dependency graph is not yet fully published to npm (several peer packages 404). Until the official release is complete, this code is developed inside the harness monorepo workspace (`packages/session/session-replay`); this repository is the standalone home. See [PLAN.md](PLAN.md) for the full design and M1 execution notes.

## CLI

```
dsh-replay list [--store <dir>] [--compression zstd|none]
dsh-replay <session-id> [--store <dir>] [--compression zstd|none] [--speed 1|2|4|8] [--headless]
dsh-replay diff <id-a> <id-b> [--store <dir>] [--compression zstd|none]
```

- Store defaults to `~/.dsh/sessions` (`$DSH_HOME` overrides it); physical encoding defaults to `zstd` (`--compression none` for plain `.jsonl`).
- Interactive keys: `space` play/pause, `s` step, `[`/`]` prev/next turn, `up`/`down` select a tool row, `enter` expand the full args/result, `1/2/4/8` speed, `q` quit.
- `--headless` dumps the whole timeline and exits (useful for diffing/debugging).
- Error states render in red: failed tool results carry the failure identity (`ERROR (Name: CODE)`), and aborted/error turn endings show the cancel cause or failure message.
- `diff` aligns two runs with an LCS over fingerprint labels and prints a side-by-side view: `<` appears only in run A, `>` only in run B, matching rows show both columns when their text differs. A metrics header compares turns, tool calls, failures, and duration.

## Layout

```
src/
  engine/    ReplayEngine (pure TS state machine) + render + fold
  store/     loadRun() via the persistence service seam; rebuildSession()
  cli/       dsh-replay bin (interactive player + list + headless dump)
tests/       engine/render/fold unit tests + JSONL end-to-end integration test
```

## Web 播放器(`web/`)

`web/` 目录是独立的 client 包 `@deepseek-ai/dsh-client-ui-replay` 的存档(官方 repo 中位于 `packages/client/ui-replay/`):在 Web Client 的 `conversation.view` 加一个 **Replay** tab,渲染可交互回放面板。

- **数据通路**:浏览器端零新 RPC——注册的 `ConversationNodeDefinition` 捕获会话窗口的每个原始事件 → `ReplaySnapshotBuilder` 聚合为按 seq 排序的 `SessionEvent[]` → 视图 selector 读取 → `ReplayEngine` 驱动
- **UI**:播放/暂停/单步/倍速(1/2/4/8)/上一·下一回合/进度条(seek),tool call 行可展开,长会话虚拟化,loading/error/empty 三态,zh+en i18n
- **实时跟进**:新事件自动 append 进引擎,播放状态持续
- 注意:`web/` 依赖官方 monorepo 的 client 包(`dsh-client-runtime` 等)与 workspace 链接,独立于本仓库构建——正式消费需等待官方发版或并入官方 repo

## Roadmap

| Milestone | Scope |
|---|---|
| M1 ✅ | StoreReader + ReplayEngine + render + CLI list/headless |
| M2 ✅ | interactive polish: tool-call select/expand (up/down + enter), error/interrupt rendering, `--compression` |
| M3 ✅ | `/replay` harness command + live follow-along (`session/event`) |
| M4 ✅ | Web ReplayPanel (`conversation.view` tab, `web/`) |
| M5 ✅ | two-run diff (LCS alignment + side-by-side view + metrics) |
| M6 | fork-and-rerun from a step (needs live harness + API key) |

## License

MIT
