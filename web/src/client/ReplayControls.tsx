/** Transport control bar: play/pause, step, speed, turn jumps, and the seek strip. */

import type { ChangeEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Speed } from '@deepseek-ai/dsh-session-replay/src/types.ts'
import css from './replay.module.css'

const SPEEDS: readonly Speed[] = [1, 2, 4, 8]
const STRIP_STEPS = 1000

export interface ReplayControlsProps {
  readonly playing: boolean
  readonly finished: boolean
  readonly speed: Speed
  /** Playback progress as a fraction of the log (0..1). */
  readonly progress: number
  /** Live scrub fraction while the user drags the strip; null when idle. */
  readonly scrub: number | null
  readonly cursor: number
  readonly total: number
  readonly live: boolean
  readonly onPlayPause: () => void
  readonly onStep: () => void
  readonly onSpeedChange: (speed: Speed) => void
  readonly onPrevTurn: () => void
  readonly onNextTurn: () => void
  readonly onScrub: (fraction: number | null) => void
  readonly onSeek: (fraction: number) => void
  readonly t: TranslateNS<'replay'>
}

function speedLabel(speed: Speed): string {
  return `${speed}x`
}

/**
 * Render the transport strip. The native range input is the seek strip:
 * dragging scrubs the playhead without committing; releasing seeks.
 */
export function ReplayControls({
  playing, finished, speed, progress, scrub, cursor, total, live,
  onPlayPause, onStep, onSpeedChange, onPrevTurn, onNextTurn, onScrub, onSeek, t,
}: ReplayControlsProps) {
  const disabled = total === 0 || finished
  const display = scrub ?? progress
  const position = t('controls.position', {
    cursor: String(cursor),
    total: String(total),
  })
  const percent = t('controls.percent', { percent: String(Math.round(display * 100)) })

  const handleSeekChange = (event: ChangeEvent<HTMLInputElement>) => {
    const fraction = Number(event.currentTarget.value) / STRIP_STEPS
    onScrub(null)
    onSeek(fraction)
  }

  const handleSeekInput = (event: ChangeEvent<HTMLInputElement>) => {
    onScrub(Number(event.currentTarget.value) / STRIP_STEPS)
  }

  return (
    <div className={css.controls} role="toolbar" aria-label={t('controls.aria')}>
      <button
        type="button"
        className={css.button}
        onClick={onPlayPause}
        disabled={disabled}
        title={playing ? t('controls.pause') : t('controls.play')}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        type="button"
        className={css.button}
        onClick={onStep}
        disabled={disabled}
        title={t('controls.step')}
      >
        →
      </button>
      <div className={css.speedGroup} role="group" aria-label={t('controls.speed')}>
        {SPEEDS.map(value => (
          <button
            key={value}
            type="button"
            className={value === speed ? `${css.button} ${css.buttonActive}` : css.button}
            onClick={() => { onSpeedChange(value) }}
            disabled={total === 0}
            aria-pressed={value === speed}
          >
            {speedLabel(value)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={css.button}
        onClick={onPrevTurn}
        disabled={disabled}
        title={t('controls.prevTurn')}
      >
        ◂◂
      </button>
      <button
        type="button"
        className={css.button}
        onClick={onNextTurn}
        disabled={disabled}
        title={t('controls.nextTurn')}
      >
        ▸▸
      </button>
      <input
        type="range"
        className={css.progress}
        min={0}
        max={STRIP_STEPS}
        value={Math.round(display * STRIP_STEPS)}
        disabled={disabled}
        aria-label={t('controls.aria')}
        onChange={handleSeekChange}
        onInput={handleSeekInput}
      />
      <span className={css.position}>{position}</span>
      <span className={css.percent}>{percent}</span>
      {live && <span className={css.live}>{t('live.badge')}</span>}
    </div>
  )
}
