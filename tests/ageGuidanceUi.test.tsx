/** @vitest-environment jsdom */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../src/i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type GuidanceUiModule = typeof import('../src/components/AgeGuidancePanel')

async function loadGuidanceUi(): Promise<GuidanceUiModule> {
  const loaded = await import('../src/components/AgeGuidancePanel').catch(() => ({}))
  expect(loaded).toHaveProperty('AgeGuidancePanel')
  return loaded as GuidanceUiModule
}

describe('age guidance progressive UI', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('shows only three priorities initially and reveals the rest in place', async () => {
    const { AgeGuidancePanel } = await loadGuidanceUi()
    await i18n.changeLanguage('ko')

    await act(async () => {
      root.render(<AgeGuidancePanel birthdate="2026-04-09" asOf="2026-07-13" variant="home" />)
    })

    expect(container.querySelectorAll('[data-guidance-priority]').length).toBe(3)
    const more = container.querySelector<HTMLButtonElement>('[data-guidance-more]')
    expect(more).not.toBeNull()
    expect(more?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-guidance-secondary]')).toBeNull()

    more?.focus()
    await act(async () => more?.click())

    expect(more?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-guidance-secondary]')).not.toBeNull()
    expect(document.activeElement).toBe(more)
    expect(container.querySelector('[data-guidance-urgent-access]')).not.toBeNull()
  })

  it('shows one calm birthdate prompt instead of generic age advice', async () => {
    const { AgeGuidancePanel } = await loadGuidanceUi()
    await i18n.changeLanguage('ko')

    await act(async () => {
      root.render(<AgeGuidancePanel birthdate="" asOf="2026-07-13" variant="home" />)
    })

    expect(container.querySelectorAll('[data-guidance-birthdate-prompt]').length).toBe(1)
    expect(container.querySelectorAll('[data-guidance-priority]').length).toBe(0)
    expect(container.textContent).toContain('생일')
  })

  it('renders parallel Korean and Japanese labels with semantic disclosures', async () => {
    const { AgeGuidancePanel } = await loadGuidanceUi()

    await i18n.changeLanguage('ko')
    await act(async () => {
      root.render(<AgeGuidancePanel birthdate="2025-04-13" asOf="2026-07-13" variant="settings" />)
    })
    expect(container.textContent).toContain('지금 필요한 것')
    expect(container.querySelector('details > summary[aria-expanded]')).not.toBeNull()
    expect(container.querySelector('.age-guidance-category[open]')).toBeNull()

    await act(async () => {
      await i18n.changeLanguage('ja')
    })
    await act(async () => {
      root.render(<AgeGuidancePanel birthdate="2025-04-13" asOf="2026-07-13" variant="settings" />)
    })
    expect(container.textContent).toContain('今必要なこと')
    expect(container.querySelector('[data-evidence-country]')).toBeNull()
    const urgentSummary = container.querySelector<HTMLElement>('[data-guidance-urgent-access] > summary')
    await act(async () => urgentSummary?.click())
    const urgentSources = container.querySelector<HTMLElement>('[data-guidance-urgent-access] .evidence-source-list > summary')
    await act(async () => urgentSources?.click())
    expect(container.querySelector('[data-evidence-country="KR"]')).not.toBeNull()
    expect(container.querySelector('[data-evidence-country="JP"]')).not.toBeNull()
  })

  it.each([
    ['2025-05-13', 14, 12],
    ['2025-04-13', 15, 15],
    ['2025-01-13', 18, 18],
  ])('selects the current development checkpoint at %i completed months', async (birthdate, completedMonths, checkpointMonth) => {
    const { AgeGuidancePanel } = await loadGuidanceUi()
    await i18n.changeLanguage('ko')

    await act(async () => {
      root.render(<AgeGuidancePanel birthdate={birthdate} asOf="2026-07-13" variant="settings" />)
    })

    const checkpoint = container.querySelector<HTMLElement>('[data-development-checkpoint]')
    expect(checkpoint?.dataset.completedMonths).toBe(String(completedMonths))
    expect(checkpoint?.dataset.checkpointMonth).toBe(String(checkpointMonth))
  })

  it('renders official sources as exact-ID buttons without placing URLs in the DOM', async () => {
    const loaded = await import('../src/components/EvidenceSourceList').catch(() => ({}))
    expect(loaded).toHaveProperty('EvidenceSourceList')
    const EvidenceSourceList = (loaded as typeof import('../src/components/EvidenceSourceList')).EvidenceSourceList

    await act(async () => {
      root.render(
        <EvidenceSourceList
          locale="ko"
          sourceIds={['kdca-infant-checkups', 'cfa-infant-checkups']}
        />,
      )
    })

    expect(container.querySelector('button[data-source-id]')).toBeNull()
    const summary = container.querySelector<HTMLElement>('.evidence-source-list > summary')
    await act(async () => summary?.click())
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button[data-source-id]')]
    expect(buttons.map(button => button.dataset.sourceId)).toEqual([
      'kdca-infant-checkups',
      'cfa-infant-checkups',
    ])
    expect(container.querySelector('a[href]')).toBeNull()
    expect(container.innerHTML).not.toContain('https://')
    expect(container.textContent).toContain('검토일')
  })

  it('keeps the guidance translation contract aligned in both locales', async () => {
    const ko = await import('../src/i18n/ko.json')
    const ja = await import('../src/i18n/ja.json')
    const expectedKeys = [
      'title', 'evidenceCenter', 'description', 'more', 'less',
      'missingTitle', 'missingBody', 'missingAction', 'urgent',
      'checkpoint', 'officialEvidence', 'reviewedOn', 'openOfficial',
    ]

    expect(expectedKeys.filter(key => key in (ko as any).ageGuidance)).toEqual(expectedKeys)
    expect(expectedKeys.filter(key => key in (ja as any).ageGuidance)).toEqual(expectedKeys)
  })

  it('uses restrained staged motion and disables it for reduced-motion users', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    expect(css).toContain('@keyframes age-guidance-rise')
    expect(css).toMatch(/\.age-guidance-item[^}]*animation:/s)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.age-guidance-item[\s\S]*animation:\s*none/)
  })
})
