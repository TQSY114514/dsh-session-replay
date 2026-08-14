# dsh-session-replay — Agent Run Replay 插件设计方案

> 状态:设计方案(v1)· 尚未开始写代码
> 目标框架:[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(Cordis 插件架构)
> 调研结论:**该领域无成熟方案**(详见 §2),本插件有明确差异化空间,且框架数据层已把录制做完了(§3),我们只做"回放播放器"。

---

## 1. 一句话定位

把一次 Agent 执行(一个 Session 的完整事件日志)变成**可交互回放的调试器**:时间轴播放、暂停、单步、倍速、从某一步重播/续播、展开每次 Tool Call、对比两次 Run。

它**不是监控**(不采集、不转发、不重跑 LLM),而是**记录 → 回放**。记录本身由 dsh 已内建的 event-sourced session log 完成,本插件只消费它。

---

## 2. 为什么值得做(调研证据)

- `topic:dsh-plugin` 下**没有任何** replay 类插件;最接近的 `dsh-record-replay`(3★)是 macOS 桌面工作流录制,`dsh-trace`(2★)只做遥测导出,`dsh-session-timeline`(2★)只做可视化,`dsh-turn-rewind`(25★)是 rewind 不是 replay。
- 全 GitHub 的 agent session replay 项目均为 0-3★ 实验品(noematrace、agentlens、AgentLedger 等);生产级平台(LangSmith/Langfuse/Phoenix)只做**只读 trace 查看**或"重跑单个 span",不是"暂停在某一步、检查、继续"的 debugger 语义。
- Claude Code 的 `/resume` 是会话恢复,不是回放调试。
- 结论:**「Debugger 语义的 Agent Run Replay」是空白**,且 dsh 66k★ 活跃用户群 + 数据层现成 = 低风险切入。

---

## 3. 数据基础:录制已经做完了

dsh 的 Session 是 **append-only 事件溯源日志**(`packages/core/session`),每条事件自带:

```ts
// 事件信封(packages/core/session/src/types.ts,已验证)
type SessionEvent = {
  type: SessionEventType      // 判别字段,switch 可收窄
  seq: number                 // 单调递增 → 单步/跳转的索引
  time: number                // Unix 毫秒 → 时间轴/倍速
  data: SessionEventMap[K]    // 各类型载荷
  surfaceOp?: SurfaceOp       // surface 事件才有(append | replace)
  sourceEventSeqs?: number[]  // 来源事件(如 chunk → message)
}
```

关键事件类型(见 `docs/persistence-catalog.md`,插件可 `declare module` 扩展):

| 事件 | 回放用途 |
|---|---|
| `user/message` | 用户输入(展开显示) |
| `turn/start` / `turn/end` | 回合边界 → "从某一步重播"的定位点 |
| `step/start` / `step/end` | 步边界 |
| `assistant/message` + `assistant/chunk` | 模型输出(流式文本) |
| `tool/call` | Tool 调用(含 name + arguments)→ 展开卡片 |
| `tool/result` | Tool 结果(含 meta)→ 展开卡片 |
| `todo/write` | 任务清单快照(whole-value,需按 seq 折叠) |
| `request/header` | 每次请求的完整信封(系统提示/工具 schema) |

### 已内建、可直接复用的能力

| 能力 | 证据 |
|---|---|
| 从事件日志重建 Session | `Session.create(id, seed?)` 分离式工厂,`packages/core/session/README.md` 明确写 "Replay/fork" 语义(测试见 `packages/llm/token-meter/tests/token-meter.spec.ts:400`) |
| 读取持久化日志 | `ctx.sessionPersistence.load(id)` / `.inspect(id)` / `.list()`(`packages/session/session-persistence`) |
| 从 seed 启动活 Session | `ctx.sessions.create(id, { seed })` |
| 在任意完成回合处 fork | `ctx.sessions.fork(source, boundary?, childId?)`(boundary = 事件 seq) |
| 单事件 → 消息投影 | `session.deriveEventMessage(event)` |
| 实时监听 | `ctx.on('session/event', (session, event) => …)` |
| 命令注册(CLI 入口) | `ctx.commands.register({ name, description, handler })`(`packages/interaction/commands`) |
| Web Client 自定义节点 | `ConversationNodeDefinition`(`docs/cookbook/adding-a-conversation-node.md`) |

**推论:本插件不写任何记录代码。核心工作是回放引擎 + 播放器 UI。**

---

## 4. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                      dsh-session-replay                  │
│                                                          │
│  ┌──────────────┐   ┌──────────────────────────────┐     │
│  │ Store Reader │──▶│       Replay Engine          │     │
│  │ (read log)   │   │  (纯 TS,CLI/Web 共用)          │     │
│  │              │   │  cursor · play/pause/step    │     │
│  │ ctx.session- │   │  seek · speed · fold-state   │     │
│  │ Persistence  │   │  render(seq) → TranscriptEntry│    │
│  └──────────────┘   └──────────┬───────────────────┘     │
│                                │                          │
│              ┌─────────────────┼──────────────────┐       │
│              ▼                 ▼                  ▼       │
│     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│     │ CLI 播放器    │  │ Web 播放器    │  │ Diff 视图     │  │
│     │ (MVP,Phase1) │  │ (Phase 2)    │  │ (Phase 2.5)  │  │
│     │ terminal TUI │  │ Conversation │  │ 双 Run 对齐   │  │
│     │ + /replay cmd│  │ Node + 面板   │  │ 渲染          │  │
│     └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

设计原则:
- **Replay Engine 是纯函数模块**(输入 `SessionEvent[]` + 控制指令,输出渲染条目),不依赖 cordis / react / terminal,便于单测。
- 所有 UI 只是 engine 的视图;播放状态(光标位置/速度/是否暂停)由 engine 持有,UI 订阅。

---

## 5. 包结构与文件树

建议作为**独立插件仓库**(`user/dsh-session-replay`,消费已发布的 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/cordis` 类型,遵循 `docs/cookbook/extension-cookbook.md` 的插件形态)。后续可随时被官方并入 `packages/session/session-replay`。

```
dsh-session-replay/
├── package.json            # "type": "module", ESM
├── tsconfig.json           # extends dsh 的 tsconfig.base.json(strict)
├── README.md               # 插件契约 + Model Experience(若并入官方)
├── src/
│   ├── types.ts            # 仅类型:TranscriptEntry、PlaybackState、DiffResult
│   ├── engine/
│   │   ├── index.ts        # ReplayEngine 类(核心,纯 TS)
│   │   ├── cursor.ts       # 光标/步进/seek 控制
│   │   ├── fold.ts         # 状态折叠(todo 快照、surface 重建)
│   │   └── render.ts       # event → TranscriptEntry(人类可读渲染)
│   ├── store/
│   │   └── reader.ts       # StoreReader:封装 sessionPersistence 读取 + Session.create 重建
│   ├── cli/
│   │   ├── index.ts        # bin 入口:dsh-replay <session-id>
│   │   └── player.ts       # 终端播放器(渲染 + 按键控制)
│   ├── plugin.ts           # Cordis 插件入口(apply / name / inject / Config)
│   ├── command.ts          # /replay 命令注册
│   ├── web/                # (Phase 2)ConversationNodeDefinition + React 组件
│   │   ├── replay-node.ts
│   │   └── ReplayPlayer.tsx
│   └── diff.ts             # (Phase 2.5)双 Run 对齐与 diff
└── tests/
    ├── engine.spec.ts      # 播放/暂停/单步/seek/倍速语义
    ├── render.spec.ts      # 各事件类型渲染快照
    ├── fold.spec.ts        # todo/表面重建折叠
    └── diff.spec.ts        # 对齐与 diff
```

---

## 6. 核心模块设计

### 6.1 Store Reader(`src/store/reader.ts`)

职责:把"任意一个已持久化 session"读成 `SessionEvent[]`。

```ts
export class StoreReader {
  // 方式 A:分离式只读重建(推荐,不发布 lifecycle、不绑定 fiber)
  static async loadFromPersistence(
    persistence: SessionPersistence,  // ctx.sessionPersistence
    id: SessionId,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return persistence.load(id)       // 返回 { meta, events },已验证
  }

  // 方式 B:作为已加载的 live session 读取
  static fromLiveSession(session: Session): SessionEvent[] {
    return session.events             // 冻结快照,已验证
  }
}
```

要点:
- `persistence.inspect(id)` 比 `load(id)` 更纯(不 commit 修复、不发布 Session),只读场景优先用它。
- 读取不感知存储后端(JSONL/SQLite 都走同一个 service API)。

### 6.2 Replay Engine(`src/engine/`)— 核心

纯 TS,无框架依赖。状态机:

```ts
interface PlaybackState {
  cursor: number            // 已播放到第几个事件(按 seq 序)
  playing: boolean
  speed: 1 | 2 | 4 | 8      // 倍速
  lastEmittedTime: number   // 用于倍速的虚拟时钟
}

export class ReplayEngine {
  constructor(events: SessionEvent[] /* 已按 seq 升序 */)

  // 控制面 —— 全部同步、可测
  play(): void
  pause(): void
  step(): void              // 单步:只前进一步
  seek(seq: number): void   // 跳到指定事件 seq
  seekToTurn(n: number): void      // 跳到第 n 回合开头
  seekToStep(turn: number, step: number): void
  setSpeed(x: 1|2|4|8): void

  // 输出面 —— UI 轮询或订阅
  onEvent: ((entry: TranscriptEntry, index: number) => void) | null
  fold(): ReplayFoldedState   // 当前 cursor 处的折叠状态(todo/表面摘要)

  // 驱动:CLI 用 setTimeout 循环,Web 用 rAF;delta = (now - last) * speed
  tick(now: number): void
}
```

语义约定(写进测试):
- `step()` 与 `play()` 共用同一条 `advance()` 路径,保证"播放中单步"与"暂停中单步"一致。
- `seek` 不重新渲染整条时间轴,而是从光标处增量 emit(大 session 的虚拟化基础)。
- `seekToTurn/seekToStep` 基于 `turn/start`、`step/start` 事件的 seq 建索引表(构造函数里一次性建)。

### 6.3 渲染层(`src/engine/render.ts`)

`event → TranscriptEntry`,是时间轴上一行的唯一来源:

```ts
type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; toolCalls: ToolCallRef[] }
  | { kind: 'tool-call'; name: string; args: string }          // 默认折叠
  | { kind: 'tool-result'; name: string; ok: boolean; meta?: string }
  | { kind: 'subagent'; turn: number; title: string }           // 子代理边界
  | { kind: 'turn'; n: number; reason?: TurnEndReason }         // 回合分隔
  | { kind: 'todo'; items: string[] }
  | { kind: 'error'; message: string }
```

- 每个 Tool Call 默认**折叠**(一行),展开才显示 args/result 全文——对应需求里的"展开每次 Tool Call"。
- 渲染为纯函数:相同 event → 相同 entry(可快照测试)。

### 6.4 CLI 播放器(MVP,Phase 1)

两个入口,共享 engine:

1. **独立 bin**:`npx dsh-replay <session-id> [--store <dir>]`
   - 读 JSONL 存储目录,`Session.create` 重建,终端渲染时间轴。
   - 按键:`space` 播放/暂停,`s`/`n` 单步,`[`/`]` seek 到上一/下一回合,`1/2/4/8` 倍速,`q` 退出,`Enter` 展开当前 tool call。
   - 零 harness 依赖,可直接回放别处录的 session 文件。

2. **插件命令**:`/replay [session-id]`(注册到 `ctx.commands`)
   - 在运行中的 harness 里回放当前或指定 session。

### 6.5 Web 播放器(Phase 2)

按 `docs/cookbook/adding-a-conversation-node.md` 的范式做两块:

1. **业务节点(ConversationNodeDefinition)**:把回放状态作为一条 chat 节点渲染。
   - 但注意:回放播放器的交互密度(进度条/倍速/展开)远超普通 chat 节点,更适合**独立面板**。
2. **推荐:注册 Web Client 侧边面板/独立路由**(`dsh-web-ui` 生态的做法),组件树:

```
ReplayPanel
├── Timeline(事件列表,增量渲染,长列表虚拟化)
│   ├── TurnMarker(n)
│   ├── MessageRow(user/assistant)
│   └── ToolCallRow(折叠 → 展开 args/result)
├── PlayerControls(播放/暂停/单步/倍速/seek)
└── StateInspector(当前 cursor 处的 todo 快照、request/header 摘要)
```

- 实时 session 复用 `ctx.on('session/event')` 流做"边跑边看";历史 session 走 StoreReader。

### 6.6 对比两次 Run(Phase 2.5,`src/diff.ts`)

对齐策略(按事件**类型序列**而非绝对 seq,容忍两次 run 步数不同):

1. 把每个 run 压成指纹序列:`['user', 'tool:read_file', 'tool:grep', 'assistant', …]`。
2. 用 LCS(最长公共子序列)对齐指纹 → 得到匹配对与插入/删除。
3. 渲染并排 diff:匹配行并列、分歧行高亮,`tool/call` 的 args 相同时折叠,不同时显示 side-by-side。
4. 附加指标:总 turn 数、tool 调用数、失败 tool 数、每 turn 耗时。

### 6.7 从某一步重播(Fork,Phase 3 — 重放之外的能力)

- **纯回放跳转**(易):`seekToTurn(n)` 后从头播 → 满足"重新看"。
- **真正重跑**(进阶,需要活 harness + API key):
  ```ts
  const child = ctx.sessions.fork(source, boundarySeq, childId)
  // 在 child 上挂新 agent,继续 followup() → 从断点续跑
  ```
  这是"调试 Agent Bug"的杀手锏:改系统提示或换模型后从失败点重跑。列为 Phase 3,因为它牵涉 agent 生命周期、凭证、成本,先不做进 MVP。

---

## 7. 功能拆解与优先级

| 优先级 | 功能 | 工作量 | 依赖 |
|---|---|---|---|
| **P0(MVP)** | StoreReader 读历史 session | 0.5 天 | — |
| **P0** | ReplayEngine:play/pause/step/seek/speed | 2 天 | engine |
| **P0** | render:user/assistant/tool-call/tool-result/turn | 1 天 | engine |
| **P0** | CLI bin:`dsh-replay <id>` + 按键控制 | 1 天 | store + engine |
| P1 | tool call 展开/折叠 + todo 折叠状态 | 1 天 | render |
| P1 | `/replay` 命令 + 当前 session 回放 | 0.5 天 | plugin.ts |
| P1 | seekToTurn/seekToStep 索引 | 0.5 天 | engine |
| P2 | Web ReplayPanel(时间轴 + 控件 + 虚拟化) | 3-4 天 | engine + web |
| P2 | 实时 session 边跑边看(`session/event`) | 1 天 | web |
| P2.5 | 双 Run diff(LCS 对齐 + 并排) | 2-3 天 | diff |
| P3 | fork 断点重跑 | 3-5 天 | agent 生命周期 |

**MVP 验收标准**:`dsh-replay <id>` 能对任意历史 session 做到 播放/暂停/单步/倍速/seek 到某回合/展开 tool call,渲染与真实对话一致。

---

## 8. 关键 API 调用点(全部已在本仓库验证)

| 调用点 | 签名 | 出处 |
|---|---|---|
| 读日志 | `persistence.inspect(id) / .load(id) / .list()` | `packages/session/session-persistence/README.md` |
| 分离重建 | `Session.create(id, seed?)` | `packages/core/session/README.md`;测试 `token-meter.spec.ts:400` |
| 实时事件 | `ctx.on('session/event', (session, event) => …)` | `docs/cookbook/extension-cookbook.md`(UI 插件示例) |
| 命令 | `ctx.commands.register({ name, description, handler })` | `packages/interaction/commands/tests/commands.spec.ts:176` |
| 活 fork | `ctx.sessions.fork(source, boundary?, childId?)` | `packages/core/session/README.md` |
| 单事件投影 | `session.deriveEventMessage(event)` | `packages/core/session/README.md` |
| Web 节点 | `ConversationNodeDefinition`(match/start/update/buildViewNode) | `docs/cookbook/adding-a-conversation-node.md` |
| 事件类型合并 | `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` | `adding-a-conversation-node.md` + `AGENTS.md` |

---

## 9. 技术风险与对策

| 风险 | 对策 |
|---|---|
| 长 session 数万事件(assistant/chunk 尤其多) | 增量 emit + 时间轴虚拟化;`assistant/chunk` 折叠进所属 `assistant/message`,不逐 chunk 渲染 |
| `tool/result` 的 `meta` 是 opaque JSON | render 层按工具名注册可选渲染器,缺省 JSON.stringify |
| `surfaceOp: replace`(压缩产生)会遮蔽历史 | 人类回放视图读**原始 log**(append 顺序),不读 `session.surface`(README 明确:human transcript 必须投影 append-origin 事件) |
| 事件类型未知/格式版本不兼容 | 依赖 `Session.create` 的校验,错误带 `SessionFormatUnsupportedError` 上抛并提示升级 harness |
| 存储后端差异(JSONL vs SQLite) | 只走 `ctx.sessionPersistence` service API,不碰物理格式 |
| 独立 bin 需要解析 JSONL | 复用 `@deepseek-ai/dsh-session` 的 chunk-rows codec,不自己解析 |

---

## 10. 测试策略

遵循仓库纪律(`docs/testing.md` + `packages/AGENTS.md`):

- **engine 语义单测**(vitest):播放/暂停/单步/seek/倍速的确定性行为;`step()` 与 `play()` 共用 `advance()` 路径的等价性。
- **render 快照测试**:每个事件类型 → 精确的 TranscriptEntry 输出。
- **fold 测试**:todo 快照按 seq 折叠、replace 遮蔽行为。
- **真实 composition 测试**(若并入官方):boot 一个 test-only cordis.yml(JSONL persistence + 本插件),录一段 fixture 日志,断言 CLI 输出 —— 满足"产品可见插件必须有 REAL-composition 测试"的要求。
- fixture 保证 macOS/Linux 可回放。

---

## 11. 落地路线

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M1(本周) | 仓库脚手架 + StoreReader + ReplayEngine + render | engine/render 单测绿,CLI 能列出 session |
| M2 | CLI 播放器完整交互 + tool 展开 + 回合 seek | **MVP 验收**(§7) |
| M3 | `/replay` 命令 + 实时边跑边看 | 在 harness 内可用 |
| M4 | Web ReplayPanel | 浏览器截图通过 visual-qa |
| M5 | 双 Run diff | diff 单测 + 手工对比 |
| M6(可选) | fork 断点重跑 | 需要真实 API key 的 e2e |

---

## 12. 待你确认的三个决策

1. **仓库形态**:独立插件仓库(推荐,零官方依赖,随时可发 npm)→ 还是直接做官方 PR 并入 `packages/session/session-replay`?
2. **MVP 平台**:先 CLI(推荐,快、无 UI 复杂度)→ 还是直接上 Web?
3. **Phase 3 fork 重跑**是否纳入规划(它需要 agent 生命周期 + API key,成本和价值都高)?

---

## 13. M1 执行记录(2026-08-14)

### 决策修正:仓库形态被迫改为"官方 repo 内包"

独立插件仓库的假设(消费已发布的 npm 包)**被证伪**:`@deepseek-ai/dsh-*` 处于 pre-release,依赖图未完整发布——`dsh-session`/`dsh-llm` 的 peer 依赖(`dsh-type-meta`、`dsh-timeout`、`dsh-brand`、`dsh-attachment`、`dsh-invariants`)在 npm 上 404。独立安装后运行时缺 peer 包直接炸。**结论:MVP 阶段在官方 repo 内开发**(`packages/session/session-replay`,走 pnpm workspace 源码依赖),待官方发版完整后再评估独立发布。

### 已实现(全部通过 `tsc -b` + 28 个 vitest 测试)

```
packages/session/session-replay/
├── src/
│   ├── index.ts            # 包入口(公开 API)
│   ├── types.ts            # TranscriptEntry / FoldedState / PlaybackSnapshot / Speed
│   ├── invariant.ts        # repo 要求的 ./invariant companion(空安装器)
│   ├── engine/
│   │   ├── index.ts        # ReplayEngine:play/pause/step/seek/speed/tick(纯 TS)
│   │   ├── render.ts       # event → TranscriptEntry(纯函数,chunk 折叠)
│   │   └── fold.ts         # foldAt():todo/回合/计数折叠
│   ├── store/
│   │   └── reader.ts       # loadRun(persistence, id) / rebuildSession()
│   └── cli/
│       ├── index.ts        # dsh-replay list | <id> [--store] [--speed] [--headless]
│       └── player.ts       # 交互播放器(space/s/[ ]/1/2/4/8/q)
└── tests/                  # engine/render/fold 单测 + JSONL 端到端集成测试
```

### 真实运行验证(非模拟)

用 `JsonlSessionPersistence` 真实落盘 zstd 压缩 session → `dsh-replay <id> --headless` 输出:

```
[0] == Turn 1 ==
[1] user: 帮我数一下项目里有多少个 ts 文件
[2] assistant: 好的,我来查找一下项目结构。
[3] -> grep({"pattern":"*.ts","path":"src"})
[4] grep ok: src/a.ts src/b.ts src/c.ts
[5] assistant: 找到了 3 个 TypeScript 文件:...
[6] == Turn 1 end (completed) ==
```

`list` 子命令正常列出 session。

### 实现中发现的真实格式要求(写代码前未预料到)

1. **surface 事件必须带 `surfaceOp`**:`user/message`/`assistant/message`/`tool/result` 无 `surfaceOp: 'append'` 会被持久化后端拒绝(`SessionPersistenceCorruptionError`)。engine 直接吃事件数组不受影响,但任何从后端读回的事件必带此字段。
2. **`TurnEndReasonMap` 的键是 `completed` 不是 `stop`**(另有 aborted/blocked/error/max-tokens/interrupted)。
3. **`StreamChunk.text-delta` 需要 `index` 字段**。
4. `JsonlSessionPersistence` 构造需要先注册 `SessionStore`(`new SessionStore(ctx)`,Service 构造即注册),否则 coordinator 读 `ctx.sessions` 报 undefined。

### M2 待办(CLI 播放器完整交互)

- [x] 交互播放器真人验证(需要真实 session:跑一次 `pnpm dsh` 任务后回放)
- [x] tool call 展开/折叠(当前 headless 已截断,交互模式加展开)
- [x] 错误/中断状态渲染(tool-result error、turn-end aborted/error)
- [x] `--compression none|zstd` 参数(当前默认 zstd,与 dsh 默认一致)
- [x] README(遵循官方包 README 规范)

## 14. M2 执行记录(2026-08-14)

### 已实现(30 个测试全绿 + `tsc -b` 干净)

- **错误态渲染**(render.ts):`tool-result` 带 `error: "Name: Code"`;`turn-end` 带 `detail`——aborted 显示取消原因(`user`/`parent`/`hook: reason`/`disposed`/`legacy`),error 显示 `message (code)`。CLI 红色高亮。
- **tool 行选中/展开**(player.ts):`up`/`down` 在 tool-call/tool-result 行间移动选中,`enter`/`e` 展开完整 args/result(状态行显示选中行)。
- **`--compression zstd|none`**(cli):默认 zstd,与 dsh 存储默认一致;none 支持明文 `.jsonl` store。
- **官方包 README**:遵循 repo 规范(Model Experience / Known Limitations),含 CLI 与 API 文档。

### 真实运行验证(含错误场景)

构造失败部署 + 用户中断的 session,`--headless` 输出:

```
[3] -> bash({"command":"pnpm run deploy --env production …","timeout":30000…)
[4] bash ERROR (BashError: E_EXEC): Error: ENOENT: no such file …, ./deploy/config.prod.json
[5] == Turn 1 end (error) == error: deployment failed (E_DEPLOY)
[9] == Turn 2 end (aborted) == aborted: user
```

### 新增类型约束(写代码时确认)

- `LlmFailure`: `{ message, code, status?, providerRetryAfterMs?, requestId? }` — turn-end error 取 `message (code)`。
- `AgentCancelCause`: `user | parent | hook(reason) | disposed`,加 `legacy` 导入值。

## 15. M5 执行记录(2026-08-14):双 Run diff

### 已实现(41 个测试全绿 + `tsc -b` 干净)

- **`src/diff.ts`(纯 TS)**:
  - `fingerprintEvents()`:日志 → 对齐指纹序列(`user` / `assistant` / `tool:<name>` / `result:<name>`),tool-result 从前面 tool/call 解析名字;turn/step/todo 等边界不进指纹(LCS 噪音)
  - `lcsPairs()` + `alignRuns()`:经典 O(n·m) LCS,输出 `equal` / `only-a` / `only-b` op 流
  - `computeStats()`:turn 数 / tool 数 / 失败数 / 时长
  - `renderDiff(ops, a, b, aText, bText)`:并排文本(匹配行同文本只打一行,不同打两列;`<` 只在 A,`>` 只在 B)
- **CLI**:`dsh-replay diff <id-a> <id-b>` — 指标头 + 并排 diff
- **测试**:指纹/LCS/渲染/指标 4 组 + 专项回归测试(见下)

### 真实运行验证(同任务、不同过程的两个 session)

run-a:grep → read_file → bash(一次成功);run-b:grep → bash(失败)→ read_file → bash(重试成功)

```
# diff run-a vs run-b
  run-a: 1 turns, 3 tools, 0 failures, 14500ms
  run-b: 1 turns, 4 tools, 1 failures, 18600ms

  [1] user: 修复这个 bug
  [2] assistant: 先定位问题。
  [3] -> grep(...)
  [4] call:c1 ok: ...
> [5] -> bash(...)                         ← 只在 B:失败的第一次尝试
> [6] call:c2 ERROR (BashError: E_EXEC)    ← 只在 B
> [7] assistant: patch 没匹配...           ← 只在 B
  [5] -> read_file  |  [8] -> read_file    ← 匹配,两侧各自渲染
  [6] call:c2 ok  |  [9] call:c3 ok        ← 匹配
< [7] assistant: 找到了,加空值保护。        ← 只在 A
  [8] -> bash  |  [10] -> bash             ← 匹配
  [9] call:c3 ok  |  [11] call:c4 ok       ← 匹配
  [10] assistant: 修复完成。 |  [12] ...    ← 匹配
```

### 真实运行中抓到的 bug

**`renderDiff` 只有一个 `textFor`**:CLI 把 runA 的渲染器同时用于 B 侧,导致 B 的指纹按 runA 的 seq 查事件——出现 `[5] read_file | [8] bash` 这种两边 label 都不一致的假 equal 行。修复:签名改为 `(ops, a, b, aText, bText)`,每侧用自己的日志渲染,并补了专项回归测试("renders each side from its own text function")。教训:单测里两边共用同一个 label 函数掩盖了这个问题,真实 fixture 才是唯一可靠的验证。

### 剩余事项

- [ ] M3:`/replay` 命令 + 实时边跑边看(`session/event`)
- [ ] M4:Web ReplayPanel
- [ ] M6:fork 断点重跑

## 16. M3 执行记录(2026-08-14):harness 命令 + 实时跟进

### 已实现(51 个测试全绿 + `tsc -b` 干净)

- **`ReplayEngine.append(events)`**:增量合并新事件(seq 去重,冷启动重喂历史无害)+ 增量 index 更新(O(added));append 后重置 atEnd。toolNames 跨 append 边界解析正常。
- **`src/live.ts` LiveReplay**:冷启动喂初始事件 + `ctx.on('session/event')` firehose 增量 append,按 session.id 过滤,listener 内 contain 异常(防饿死其他订阅者——firehose 是 stop-on-throw)。
- **`src/plugin.ts` 函数插件**:`inject = ['commands', 'sessions', 'sessionPersistence']`;注册 `/replay [session-id] [--follow]`;handler 返回 headless 渲染文本(6k 字符截断),`--follow` 额外启动 LiveReplay(ctx.effect 管理生命周期)。纯核心 `runReplayCommand(ctx, id, follow)` 已提取,用真实 JSONL 后端单测。

### 调研确认的关键事实

- **CommandDefinition**:`{ name, description, input?, recordInput?, handler(invocation) }`;handler 返回 `CommandResult`(`{kind:'success', text?}` | `{kind:'error', text}`),text 由 UI adapter 直接渲染、**永不进入模型历史**;命令只在 UI 命令平面执行,agent 不能调用。
- **`ctx.commands` 类型**:声明在 `@deepseek-ai/dsh-commands`(interaction/commands);`ctx.sessionPersistence` 在 `@deepseek-ai/dsh-session-persistence`。函数插件 `inject` 数组 + 类型 import 激活。
- **`session/event` 监听器**:`(session: Session, event: SessionEvent)`,session 是完整对象;scope 过滤按 agent 而非 session id,过滤特定 session 用 `if (session.id !== target) return`。
- **增量模式参考**:telemetry coordinator(adopt 历史 + firehose 追实时 + handoffCursor)、projection registry(drive() 逐事件 apply)。
- **测试教训**:命令输出带 ANSI 颜色码,断言要分段匹配;folded 反映播放光标而非日志尾部,断言前先 drain。

### 剩余事项

- [x] M3 完成
- [ ] M4:Web ReplayPanel(已委托 visual-engineering,后台进行中)
- [ ] M6:fork 断点重跑
