/** Virtualized replay timeline: turn bands plus one row per visible event. */

import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReplayRow } from './replay-layout.ts'
import css from './replay.module.css'

export interface ReplayTimelineProps {
  readonly rows: readonly ReplayRow[]
  readonly expanded: ReadonlySet<number>
  readonly onToggleExpanded: (seq: number) => void
  readonly t: TranslateNS<'replay'>
}

function rowClass(row: ReplayRow): string {
  switch (row.kind) {
    case 'band': return `${css.row} ${css.rowBand}`
    case 'band-end': return `${css.row} ${css.rowBandEnd}`
    case 'user': return `${css.row} ${css.rowUser}`
    case 'assistant': return `${css.row} ${css.rowAssistant}`
    case 'tool-call': return `${css.row} ${css.rowToolCall}`
    case 'tool-result': return row.ok === true
      ? `${css.row} ${css.rowToolResult}`
      : `${css.row} ${css.rowToolError}`
    case 'step': return `${css.row} ${css.rowStep}`
    case 'todo': return `${css.row} ${css.rowTodo}`
    case 'request': return `${css.row} ${css.rowRequest}`
  }
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour12: false })
}

function roleLabel(row: ReplayRow, t: TranslateNS<'replay'>): string | null {
  switch (row.kind) {
    case 'user': return t('row.user')
    case 'assistant': return t('row.assistant')
    case 'tool-call':
    case 'tool-result': return t('row.tool')
    default: return null
  }
}

function assistantChips(row: ReplayRow): string {
  return row.toolCalls.map(name => `[${name}]`).join(' ')
}

function todoLine(row: ReplayRow): string {
  return (row.todos ?? []).map(item => `${item.content} [${item.status}]`).join('; ')
}

function toolResultMark(row: ReplayRow, t: TranslateNS<'replay'>): string {
  if (row.error !== undefined) return `${t('row.error')} (${row.error})`
  return row.ok === true ? t('row.ok') : t('row.error')
}

/**
 * Render one row. Tool rows are buttons that toggle the inline expanded
 * detail; band rows paint a full-width turn boundary strip.
 */
function ReplayRowView({
  row, expanded, onToggleExpanded, t,
}: {
  readonly row: ReplayRow
  readonly expanded: boolean
  readonly onToggleExpanded: (seq: number) => void
  readonly t: TranslateNS<'replay'>
}) {
  if (row.kind === 'band' || row.kind === 'band-end') {
    const title = row.kind === 'band-end'
      ? t('row.turnEnd', { turn: String(row.bandTurn), reason: row.bandReason ?? '' })
      : t('row.turn', { turn: String(row.bandTurn) })
    return (
      <div className={rowClass(row)}>
        <div className={css.gutter}>
          <span className={css.seq}>{row.seq}</span>
          <span className={css.time}>{formatTime(row.time)}</span>
        </div>
        <div className={css.body}>
          <span className={css.bandTitle}>{title}</span>
          {row.kind === 'band-end' && row.bandReason !== undefined && (
            <span className={css.bandDetail}>{row.bandReason}</span>
          )}
        </div>
      </div>
    )
  }

  const label = roleLabel(row, t)
  const expandable = row.expanded !== null
  const content = expandable
    ? (
      <button
        type="button"
        className={css.expandButton}
        onClick={() => { onToggleExpanded(row.seq) }}
        aria-expanded={expanded}
        aria-label={t('row.expandAria')}
      >
        <span className={css.expandMark}>{expanded ? '▾' : '▸'}</span>
        <RowText row={row} t={t} label={label} />
      </button>
    )
    : <RowText row={row} t={t} label={label} />

  return (
    <div className={rowClass(row)}>
      <div className={css.gutter}>
        <span className={css.seq}>{row.seq}</span>
        <span className={css.time}>{formatTime(row.time)}</span>
      </div>
      <div className={css.body}>
        {content}
        {expanded && row.expanded !== null && (
          <pre className={css.expanded}>{row.expanded}</pre>
        )}
      </div>
    </div>
  )
}

function RowText({
  row, t, label,
}: {
  readonly row: ReplayRow
  readonly t: TranslateNS<'replay'>
  readonly label: string | null
}) {
  if (row.kind === 'tool-call') {
    return (
      <span className={css.rowText}>
        {label !== null && <span className={css.role}>{label}</span>}
        <span className={css.toolArrow}>→</span>
        <span className={css.toolName}>{row.text}</span>
        <span className={css.toolArgs}>({row.preview})</span>
      </span>
    )
  }
  if (row.kind === 'tool-result') {
    return (
      <span className={css.rowText}>
        {label !== null && <span className={css.role}>{label}</span>}
        <span className={css.toolName}>{row.text}</span>
        <span className={row.ok === true ? css.resultOk : css.resultError}>
          {toolResultMark(row, t)}
        </span>
        {row.preview !== null && row.preview.length > 0 && (
          <span className={css.resultPreview}>{row.preview}</span>
        )}
      </span>
    )
  }
  if (row.kind === 'step') {
    return (
      <span className={css.rowText}>
        <span className={css.role}>
          {row.stepDone ? t('row.stepDone', { step: row.text }) : t('row.step', { step: row.text })}
        </span>
      </span>
    )
  }
  if (row.kind === 'todo') {
    return (
      <span className={css.rowText}>
        <span className={css.role}>{t('row.todo', { items: todoLine(row) })}</span>
      </span>
    )
  }
  if (row.kind === 'request') {
    return (
      <span className={css.rowText}>
        <span className={css.role}>{t('row.request', { reason: row.requestReason ?? '' })}</span>
      </span>
    )
  }
  return (
    <span className={css.rowText}>
      {label !== null && <span className={css.role}>{label}</span>}
      {row.text}
      {row.toolCalls.length > 0 && <span className={css.chips}>{assistantChips(row)}</span>}
    </span>
  )
}

/**
 * Render the virtualized row window. Row heights are measured live, so
 * expanded tool details grow their row without breaking scroll math.
 */
export function ReplayTimeline({ rows, expanded, onToggleExpanded, t }: ReplayTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 10,
  })

  return (
    <div ref={scrollRef} className={css.timeline}>
      <div
        className={css.virtualSpace}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => {
          const row = rows[virtualRow.index]
          if (row === undefined) return null
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={css.virtualRow}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <ReplayRowView
                row={row}
                expanded={expanded.has(row.seq)}
                onToggleExpanded={onToggleExpanded}
                t={t}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
