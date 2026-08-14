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

Engine, renderer, store reader, and CLI are implemented and green (28 vitest tests, `tsc -b` clean), including a real end-to-end round trip through the JSONL persistence backend.

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

## Roadmap

| Milestone | Scope |
|---|---|
| M1 ✅ | StoreReader + ReplayEngine + render + CLI list/headless |
| M2 ✅ | interactive polish: tool-call select/expand (up/down + enter), error/interrupt rendering, `--compression` |
| M3 | `/replay` harness command + live follow-along (`session/event`) |
| M4 | Web ReplayPanel |
| M5 ✅ | two-run diff (LCS alignment + side-by-side view + metrics) |
| M6 | fork-and-rerun from a step (needs live harness + API key) |

## License

MIT
