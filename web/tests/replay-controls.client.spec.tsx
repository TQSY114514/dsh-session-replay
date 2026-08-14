// @vitest-environment jsdom
/** Transport control specs: every button and the seek strip route to its callback. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Speed } from '@deepseek-ai/dsh-session-replay/src/types.ts'
import { ReplayControls } from '../src/client/ReplayControls.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: (key: string, params?: Record<string, unknown>) => string = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

function renderControls(overrides: Partial<Parameters<typeof ReplayControls>[0]> = {}) {
  const props = {
    playing: false,
    atEnd: false,
    finished: false,
    speed: 1 as Speed,
    progress: 0.25,
    scrub: null,
    cursor: 250,
    total: 1000,
    live: false,
    onPlayPause: vi.fn(),
    onStep: vi.fn(),
    onSpeedChange: vi.fn(),
    onPrevTurn: vi.fn(),
    onNextTurn: vi.fn(),
    onScrub: vi.fn(),
    onSeek: vi.fn(),
    t,
    ...overrides,
  }
  const view = render(<ReplayControls {...props} />)
  return { props, view }
}

describe('ReplayControls', () => {
  it('routes play/pause, step, and turn navigation to their callbacks', () => {
    const { props } = renderControls()
    fireEvent.click(screen.getByTitle('播放'))
    expect(props.onPlayPause).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('单步'))
    expect(props.onStep).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('上一回合'))
    expect(props.onPrevTurn).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('下一回合'))
    expect(props.onNextTurn).toHaveBeenCalledTimes(1)
  })

  it('switches speed through the 1/2/4/8 group', () => {
    const { props } = renderControls()
    fireEvent.click(screen.getByRole('button', { name: '2x' }))
    expect(props.onSpeedChange).toHaveBeenCalledWith(2)
    fireEvent.click(screen.getByRole('button', { name: '8x' }))
    expect(props.onSpeedChange).toHaveBeenCalledWith(8)
  })

  it('commits a seek on release and scrubs live while dragging', () => {
    const { props } = renderControls()
    const slider = screen.getByRole('slider')
    fireEvent.input(slider, { target: { value: '500' } })
    expect(props.onScrub).toHaveBeenCalledWith(0.5)
    fireEvent.change(slider, { target: { value: '500' } })
    expect(props.onScrub).toHaveBeenCalledWith(null)
    expect(props.onSeek).toHaveBeenCalledWith(0.5)
  })

  it('shows the position readout and the live badge while following a running session', () => {
    renderControls({ live: true })
    expect(screen.getByText('250/1000')).toBeTruthy()
    expect(screen.getByText('实时')).toBeTruthy()
  })

  it('disables transport when the log is empty', () => {
    renderControls({ total: 0, cursor: 0, progress: 0 })
    expect(screen.getByTitle('播放').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(true)
  })
})
