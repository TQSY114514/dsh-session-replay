/** `replay` namespace dictionaries (view tab label, transport controls, states). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'replay'

/** The replay dictionary key set (the source of truth for both locales). */
export type ReplayKey =
  | 'view.replay'
  | 'controls.aria'
  | 'controls.play'
  | 'controls.pause'
  | 'controls.step'
  | 'controls.speed'
  | 'controls.prevTurn'
  | 'controls.nextTurn'
  | 'controls.position'
  | 'controls.percent'
  | 'state.loading'
  | 'state.loadingOlder'
  | 'state.loadOlder'
  | 'state.error'
  | 'state.empty'
  | 'state.finished'
  | 'live.badge'
  | 'row.user'
  | 'row.assistant'
  | 'row.tool'
  | 'row.turn'
  | 'row.turnEnd'
  | 'row.step'
  | 'row.stepDone'
  | 'row.todo'
  | 'row.request'
  | 'row.ok'
  | 'row.error'
  | 'row.expandAria'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The replay view tab label and player strings. */
    'replay': ReplayKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<ReplayKey, string> = {
  'view.replay': '回放',
  'controls.aria': '回放控制条',
  'controls.play': '播放',
  'controls.pause': '暂停',
  'controls.step': '单步',
  'controls.speed': '倍速',
  'controls.prevTurn': '上一回合',
  'controls.nextTurn': '下一回合',
  'controls.position': '{cursor}/{total}',
  'controls.percent': '{percent}%',
  'state.loading': '正在加载会话事件…',
  'state.loadingOlder': '正在加载更早记录…',
  'state.loadOlder': '加载更早记录',
  'state.error': '回放数据加载失败',
  'state.empty': '该会话还没有可回放的事件',
  'state.finished': '回放结束',
  'live.badge': '实时',
  'row.user': '用户',
  'row.assistant': '助手',
  'row.tool': '工具',
  'row.turn': '回合 {turn}',
  'row.turnEnd': '回合 {turn} 结束 · {reason}',
  'row.step': '步骤 {step}',
  'row.stepDone': '步骤 {step} 完成',
  'row.todo': '待办: {items}',
  'row.request': '请求: {reason}',
  'row.ok': '成功',
  'row.error': '失败',
  'row.expandAria': '展开或收起工具详情',
}

/** English dictionary. */
export const en: Record<ReplayKey, string> = {
  'view.replay': 'Replay',
  'controls.aria': 'Replay controls',
  'controls.play': 'Play',
  'controls.pause': 'Pause',
  'controls.step': 'Step',
  'controls.speed': 'Speed',
  'controls.prevTurn': 'Previous turn',
  'controls.nextTurn': 'Next turn',
  'controls.position': '{cursor}/{total}',
  'controls.percent': '{percent}%',
  'state.loading': 'Loading session events…',
  'state.loadingOlder': 'Loading earlier records…',
  'state.loadOlder': 'Load earlier records',
  'state.error': 'Failed to load replay data',
  'state.empty': 'This session has no replayable events yet',
  'state.finished': 'Replay finished',
  'live.badge': 'Live',
  'row.user': 'user',
  'row.assistant': 'assistant',
  'row.tool': 'tool',
  'row.turn': 'Turn {turn}',
  'row.turnEnd': 'Turn {turn} ended · {reason}',
  'row.step': 'Step {step}',
  'row.stepDone': 'Step {step} done',
  'row.todo': 'Todos: {items}',
  'row.request': 'Request: {reason}',
  'row.ok': 'ok',
  'row.error': 'ERROR',
  'row.expandAria': 'Expand or collapse tool details',
}
