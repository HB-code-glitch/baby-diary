import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODAL_LAYER_BASE } from '../src/lib/modalIsolation'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = Array.from(css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')))
  return blocks.reduce<Record<string, string>>((values, block) => {
    for (const match of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) values[match[1]] = match[2].trim()
    return values
  }, {})
}

const light = declarations(':root')
const dark = { ...light, ...declarations('[data-theme="dark"]') }

function rgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error(`Expected a six-digit hex color, received ${hex}`)
  return [0, 2, 4].map(index => Number.parseInt(normalized.slice(index, index + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const channels = rgb(hex).map(value => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('History %s theme contrast tokens', (_theme, tokens) => {
  it.each([
    '--text-secondary',
    '--text-muted',
    '--history-outside-month',
    '--history-weekend-sunday',
    '--history-weekend-saturday',
  ])('keeps 12–13px text token %s at 4.5:1 or better', token => {
    expect(contrast(tokens[token], tokens['--surface'])).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    '--history-selection-ring',
    '--history-icon-muted',
  ])('keeps non-text state token %s at 3:1 or better', token => {
    expect(contrast(tokens[token], tokens['--surface'])).toBeGreaterThanOrEqual(3)
  })

  it.each([
    ['--sage-600', '--sage-100'],
    ['--peach-600', '--peach-100'],
    ['--amber-600', '--amber-100'],
    ['--rose-500', '--rose-100'],
    ['--sky-text', '--sky'],
    ['--lavender-600', '--lavender-100'],
    ['--indigo-600', '--indigo-100'],
  ])('keeps semantic icon %s at 3:1 against %s', (foreground, background) => {
    expect(contrast(tokens[foreground], tokens[background])).toBeGreaterThanOrEqual(3)
  })
})

it('uses the tested semantic tokens in the visible selected, weekend, and icon rules', () => {
  expect(css).toMatch(/\.cal-day-cell\.cal-day-selected\s*\{[^}]*border[^}]*var\(--history-selection-ring\)/s)
  expect(css).toMatch(/\.cal-week-row\.cal-week-row-selected\s*\{[^}]*border-color:\s*var\(--history-selection-ring\)/s)
  expect(css).toMatch(/\.cal-day-cell\.cal-sunday \.cal-day-num\s*\{[^}]*var\(--history-weekend-sunday\)/s)
  expect(css).toMatch(/\.timeline-action-button\s*\{[^}]*var\(--history-icon-muted\)/s)
})

it('keeps every time-editor target at least 40px', () => {
  expect(css).toMatch(/\.time-edit-input\s*\{[^}]*min-height:\s*40px/s)
  expect(css).toMatch(/\.time-edit-control\s*\{[^}]*min-width:\s*40px[^}]*min-height:\s*40px/s)
})

it('keeps day timeline actions safely above the 40px packaged-app boundary', () => {
  expect(css).toMatch(/\.timeline-action-button\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s)
})

it('does not visually shrink time-editor targets during its entrance motion', () => {
  const keyframes = css.match(/@keyframes\s+timeEditAppear\s*\{([\s\S]*?)\n\}/)?.[1]
  expect(keyframes).toBeTruthy()
  expect(keyframes).not.toMatch(/scale\s*\(/)
  expect(css).toMatch(/\.popover\.time-edit-dialog\s*\{[^}]*animation-name:\s*timeEditAppear/s)
})

it('contains modal scroll and removes touch delay from History actions', () => {
  expect(css).toMatch(/\.time-edit-backdrop\s*\{[^}]*overscroll-behavior:\s*contain/s)
  expect(css).toMatch(/\.cal-day-cell,[^}]*\.timeline-action-button,[^}]*\.time-edit-control\s*\{[^}]*touch-action:\s*manipulation/s)
})

it('keeps the time editor fixed across the full viewport', () => {
  expect(css).toMatch(/\.time-edit-backdrop\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s)
})

it('keeps every modal portal above the visible toast', () => {
  const toastZ = Number(css.match(/\.toast-container\s*\{[^}]*z-index:\s*(\d+)/s)?.[1])
  expect(MODAL_LAYER_BASE).toBeGreaterThan(toastZ)
})

it('keeps the high-contrast today text override after weekend color rules', () => {
  const todayRule = css.lastIndexOf('.cal-day-cell.cal-day-today .cal-day-num')
  const sundayRule = css.lastIndexOf('.cal-day-cell.cal-sunday .cal-day-num')
  const saturdayRule = css.lastIndexOf('.cal-day-cell.cal-saturday .cal-day-num')
  expect(todayRule).toBeGreaterThan(Math.max(sundayRule, saturdayRule))
  expect(contrast(light['--surface'], light['--action-bg'])).toBeGreaterThanOrEqual(4.5)
  expect(contrast(dark['--surface'], dark['--action-bg'])).toBeGreaterThanOrEqual(4.5)
})
