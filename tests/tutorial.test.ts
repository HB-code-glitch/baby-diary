import React, { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import i18n from '../src/i18n'
import ko from '../src/i18n/ko.json'
import ja from '../src/i18n/ja.json'
import { TutorialCard } from '../src/components/TutorialCard'
import {
  TUTORIAL_STATE_KEY,
  TUTORIAL_STEPS,
  TUTORIAL_VERSION,
  markTutorialExit,
  readTutorialState,
  shouldAutoStartTutorial,
} from '../src/lib/tutorial'

function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

describe('tutorial v2 state', () => {
  it('offers v2 to a fresh install and to an old tutorialDone install', () => {
    expect(shouldAutoStartTutorial(storage())).toBe(true)
    expect(shouldAutoStartTutorial(storage({ 'babydiary.tutorialDone': '1' }))).toBe(true)
  })

  it.each(['completed', 'skipped'] as const)('does not relaunch after %s', status => {
    const target = storage()
    markTutorialExit(status, target)
    expect(readTutorialState(target)).toMatchObject({ version: TUTORIAL_VERSION, status })
    expect(shouldAutoStartTutorial(target)).toBe(false)
  })

  it('offers the tutorial again when persisted JSON is malformed', () => {
    expect(shouldAutoStartTutorial(storage({ [TUTORIAL_STATE_KEY]: '{bad' }))).toBe(true)
  })
})

describe('tutorial v2 content', () => {
  it('contains the six approved steps in order', () => {
    expect(TUTORIAL_STEPS.map(step => step.id)).toEqual([
      'welcome', 'quick-record', 'today-overview', 'navigation', 'settings-family', 'ready',
    ])
  })

  it('has matching Korean and Japanese keys for every visible step field', () => {
    for (const step of TUTORIAL_STEPS) {
      for (const key of [step.eyebrowKey, step.titleKey, step.bodyKey]) {
        const leaf = key.replace(/^tour\./, '') as keyof typeof ko.tour
        expect(ko.tour[leaf], `ko:${key}`).toBeTruthy()
        expect(ja.tour[leaf], `ja:${key}`).toBeTruthy()
      }
    }
    expect(Object.keys(ko.tour).sort()).toEqual(Object.keys(ja.tour).sort())
  })

  it('renders an always-skippable modal with progress and navigation', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(TutorialCard, {
          step: TUTORIAL_STEPS[1],
          stepIndex: 1,
          totalSteps: TUTORIAL_STEPS.length,
          position: {},
          compact: false,
          onBack: () => undefined,
          onNext: () => undefined,
          onSkip: () => undefined,
          cardRef: createRef<HTMLElement>(),
        }),
      ),
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('tour-skip-button')
    expect(html).toContain('tour-back-button')
    expect(html).toContain('tour-primary-button')
    expect((html.match(/tour-progress-segment/g) ?? [])).toHaveLength(6)
  })
})
