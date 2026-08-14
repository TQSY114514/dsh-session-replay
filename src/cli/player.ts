import readline from 'node:readline'
import { ReplayEngine } from '../engine/index.ts'
import type { TranscriptEntry } from '../types.ts'

const TICK_MS = 100

function color(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ')
  return single.length <= max ? single : `${single.slice(0, max)}…`
}

/** Render one timeline entry as a terminal line. */
export function renderEntryLine(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return color(32, `[${entry.seq}] user:`) + ` ${entry.text}`
    case 'assistant': {
      const tools = entry.toolCalls.length > 0
        ? ` [tools: ${entry.toolCalls.map(call => call.name).join(', ')}]`
        : ''
      return `[${entry.seq}] assistant: ${entry.text}${tools}`
    }
    case 'tool-call':
      return color(36, `[${entry.seq}] -> ${entry.name}(${truncate(entry.args, 80)})`)
    case 'tool-result': {
      const name = entry.name ?? `call:${entry.callId.slice(0, 8)}`
      const mark = entry.ok ? 'ok' : color(31, 'ERROR')
      const detail = entry.content.length > 0 ? `: ${truncate(entry.content, 80)}` : ''
      return `[${entry.seq}] ${name} ${mark}${detail}`
    }
    case 'turn-start':
      return color(33, `[${entry.seq}] == Turn ${entry.turn} ==`)
    case 'turn-end':
      return color(33, `[${entry.seq}] == Turn ${entry.turn} end (${entry.reason}) ==`)
    case 'step-start':
      return color(90, `[${entry.seq}] step ${entry.turn}.${entry.step}`)
    case 'step-end':
      return color(90, `[${entry.seq}] step ${entry.turn}.${entry.step} done`)
    case 'todo':
      return color(90, `[${entry.seq}] todo: ${entry.todos.map(item => `${item.content} [${item.status}]`).join('; ')}`)
    case 'request':
      return color(90, `[${entry.seq}] request: ${entry.reason}`)
  }
}

function statusLine(engine: ReplayEngine): string {
  const state = engine.snapshot
  const marker = state.atEnd ? 'END' : state.playing ? '>' : '||'
  const folded = engine.folded
  const turn = folded.turn === undefined ? '-' : String(folded.turn)
  const todos = folded.todos.filter(item => item.status === 'in_progress').map(item => item.content).join('; ')
  const todoHint = todos.length > 0 ? ` in-progress: ${todos}` : ''
  return `${marker} ${state.speed}x turn:${turn} ${state.cursor}/${state.total} tools:${folded.toolCallCount}${todoHint}`
}

const HELP_LINE = 'space play/pause | s step | [ ] prev/next turn | 1/2/4/8 speed | q quit'

/**
 * Run the interactive terminal player over an engine. Resolves when the user
 * quits or playback reaches the end.
 */
export function runPlayer(engine: ReplayEngine): Promise<void> {
  return new Promise(resolve => {
    process.stdout.write(`${HELP_LINE}\n`)

    engine.onEmit = entry => {
      process.stdout.write(`\n${renderEntryLine(entry)}`)
    }
    engine.onEnd = () => {
      process.stdout.write('\n\n== replay finished ==\n')
      shutdown()
    }

    let statusVisible = false
    const paintStatus = (): void => {
      process.stdout.write(`\r\x1b[2K${statusLine(engine)}`)
      statusVisible = true
    }

    const stepOnce = (): void => {
      const entry = engine.step()
      if (entry !== null) process.stdout.write(`\n${renderEntryLine(entry)}`)
      paintStatus()
    }

    const seekAdjacentTurn = (direction: -1 | 1): void => {
      const current = engine.folded.turn ?? 1
      const target = Math.max(1, current + direction)
      if (engine.seekToTurn(target)) {
        process.stdout.write(`\n-- seeked to turn ${target} --`)
        paintStatus()
      }
    }

    const shutdown = (): void => {
      if (finished) return
      finished = true
      clearInterval(timer)
      process.stdin.setRawMode(false)
      process.stdin.removeAllListeners('keypress')
      process.stdin.pause()
      resolve()
    }

    let finished = false
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.on('keypress', (_str, key) => {
      if (finished) return
      if (key.ctrl && key.name === 'c') {
        shutdown()
        return
      }
      switch (key.name) {
        case 'q':
          shutdown()
          return
        case 'space':
          engine.togglePlay()
          paintStatus()
          return
        case 's':
        case 'n':
          stepOnce()
          return
        case 'left':
        case '[':
          seekAdjacentTurn(-1)
          return
        case 'right':
        case ']':
          seekAdjacentTurn(1)
          return
        case '1':
          engine.setSpeed(1)
          paintStatus()
          return
        case '2':
          engine.setSpeed(2)
          paintStatus()
          return
        case '4':
          engine.setSpeed(4)
          paintStatus()
          return
        case '8':
          engine.setSpeed(8)
          paintStatus()
          return
        default:
          return
      }
    })

    const timer = setInterval(() => {
      engine.tick(Date.now())
      if (statusVisible || engine.snapshot.playing) paintStatus()
    }, TICK_MS)

    paintStatus()
  })
}
