import React, { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import i18n from '../src/i18n'
import ko from '../src/i18n/ko.json'
import ja from '../src/i18n/ja.json'
import { TutorialCard } from '../src/components/TutorialCard'
import { TutorialTour } from '../src/components/TutorialTour'
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

function selectorRoot(activeSelector: string | null): Pick<ParentNode, 'querySelector'> {
  return {
    querySelector: (selector: string) => selector
      .split(',')
      .map(candidate => candidate.trim())
      .includes(activeSelector ?? '')
        ? ({} as Element)
        : null,
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

  it('exposes a stable active marker while the v2 tutorial blocks the app', () => {
    const html = renderToStaticMarkup(
      React.createElement(TutorialTour, {
        onNavigate: () => undefined,
        onExit: () => undefined,
      }),
    )

    expect(html).toContain('data-tutorial-active="true"')
  })

  it('blocks quick-record shortcuts for v2 and legacy tutorial overlays', async () => {
    const tutorial = await import('../src/lib/tutorial')

    expect(tutorial.isTutorialShortcutBlocked(selectorRoot('[data-tutorial-active="true"]'))).toBe(true)
    expect(tutorial.isTutorialShortcutBlocked(selectorRoot('.tour-stage'))).toBe(true)
    expect(tutorial.isTutorialShortcutBlocked(selectorRoot('.tour-overlay'))).toBe(true)
    expect(tutorial.isTutorialShortcutBlocked(selectorRoot('.tour-overlay-strip'))).toBe(true)
    expect(tutorial.isTutorialShortcutBlocked(selectorRoot(null))).toBe(false)
  })

  it('scrolls an offscreen target once, remeasures it, and leaves oversized targets alone', async () => {
    const tour = await import('../src/components/TutorialTour')
    const offscreenRects = [
      { top: 760, left: 24, width: 320, height: 120 },
      { top: 210, left: 24, width: 320, height: 120 },
    ]
    const scrollCalls: ScrollIntoViewOptions[] = []
    let offscreenReads = 0
    const offscreenTarget = {
      getBoundingClientRect: () => offscreenRects[Math.min(offscreenReads++, offscreenRects.length - 1)],
      scrollIntoView: (options: ScrollIntoViewOptions) => scrollCalls.push(options),
    }

    expect(tour.measureTutorialTarget(offscreenTarget, { width: 960, height: 640 })).toEqual(offscreenRects[1])
    expect(offscreenReads).toBe(2)
    expect(scrollCalls).toEqual([{ block: 'center', inline: 'nearest', behavior: 'auto' }])

    let oversizedReads = 0
    let oversizedScrolls = 0
    const oversizedRect = { top: -80, left: 0, width: 216, height: 800 }
    const oversizedTarget = {
      getBoundingClientRect: () => { oversizedReads += 1; return oversizedRect },
      scrollIntoView: () => { oversizedScrolls += 1 },
    }

    expect(tour.measureTutorialTarget(oversizedTarget, { width: 960, height: 640 })).toEqual(oversizedRect)
    expect(oversizedReads).toBe(1)
    expect(oversizedScrolls).toBe(0)
  })

  it('does not reuse a previous step presentation while the next target is unresolved', async () => {
    const tour = await import('../src/components/TutorialTour')
    type PresentationForTutorialStep = <Presentation extends { stepIndex: number }>(
      presentation: Presentation | null,
      stepIndex: number,
    ) => Presentation | null
    const presentationForTutorialStep = (tour as typeof tour & {
      presentationForTutorialStep?: PresentationForTutorialStep
    }).presentationForTutorialStep
    expect(presentationForTutorialStep).toBeTypeOf('function')

    const previousStep = {
      stepIndex: 3,
      targetRect: { top: 20, left: 20, width: 180, height: 320 },
    }
    const currentStep = {
      stepIndex: 4,
      targetRect: { top: 40, left: 520, width: 320, height: 160 },
    }

    expect(presentationForTutorialStep!(previousStep, 4)).toBeNull()
    expect(presentationForTutorialStep!(currentStep, 4)).toBe(currentStep)
    expect(presentationForTutorialStep!(null, 4)).toBeNull()
  })

  it('waits for a contextual target that appears after the first lookup', async () => {
    const tour = await import('../src/components/TutorialTour')
    type WaitForTutorialTarget = <Target>(options: {
      findTarget: () => Target | null
      observe: (onMutation: () => void) => () => void
      scheduleFallback: (onTimeout: () => void) => () => void
      onResolve: (target: Target | null) => void
    }) => () => void
    const waitForTutorialTarget = (tour as typeof tour & {
      waitForTutorialTarget?: WaitForTutorialTarget
    }).waitForTutorialTarget
    expect(waitForTutorialTarget).toBeTypeOf('function')

    const lateTarget = { id: 'settings-sync' }
    let currentTarget: typeof lateTarget | null = null
    let notifyMutation: (() => void) | null = null
    let notifyTimeout: (() => void) | null = null
    let observerDisconnects = 0
    let timeoutCancels = 0
    const resolutions: Array<typeof lateTarget | null> = []

    const cancel = waitForTutorialTarget!({
      findTarget: () => currentTarget,
      observe: onMutation => {
        notifyMutation = onMutation
        return () => { observerDisconnects += 1 }
      },
      scheduleFallback: onTimeout => {
        notifyTimeout = onTimeout
        return () => { timeoutCancels += 1 }
      },
      onResolve: target => resolutions.push(target),
    })

    expect(resolutions).toEqual([])
    currentTarget = lateTarget
    ;(notifyMutation as (() => void) | null)?.()

    expect(resolutions).toEqual([lateTarget])
    expect(observerDisconnects).toBe(1)
    expect(timeoutCancels).toBe(1)

    ;(notifyTimeout as (() => void) | null)?.()
    cancel()
    expect(resolutions).toEqual([lateTarget])
    expect(observerDisconnects).toBe(1)
    expect(timeoutCancels).toBe(1)
  })

  it('ignores observer and timeout callbacks after target waiting is cancelled', async () => {
    const tour = await import('../src/components/TutorialTour')
    type WaitForTutorialTarget = <Target>(options: {
      findTarget: () => Target | null
      observe: (onMutation: () => void) => () => void
      scheduleFallback: (onTimeout: () => void) => () => void
      onResolve: (target: Target | null) => void
    }) => () => void
    const waitForTutorialTarget = (tour as typeof tour & {
      waitForTutorialTarget?: WaitForTutorialTarget
    }).waitForTutorialTarget
    expect(waitForTutorialTarget).toBeTypeOf('function')

    let notifyMutation: (() => void) | null = null
    let notifyTimeout: (() => void) | null = null
    let observerDisconnects = 0
    let timeoutCancels = 0
    const resolutions: Array<{ id: string } | null> = []

    const cancel = waitForTutorialTarget!({
      findTarget: () => null,
      observe: onMutation => {
        notifyMutation = onMutation
        return () => { observerDisconnects += 1 }
      },
      scheduleFallback: onTimeout => {
        notifyTimeout = onTimeout
        return () => { timeoutCancels += 1 }
      },
      onResolve: target => resolutions.push(target),
    })

    cancel()
    ;(notifyMutation as (() => void) | null)?.()
    ;(notifyTimeout as (() => void) | null)?.()

    expect(resolutions).toEqual([])
    expect(observerDisconnects).toBe(1)
    expect(timeoutCancels).toBe(1)
  })

  it('resolves a missing target to the centered fallback when the timeout wins', async () => {
    const tour = await import('../src/components/TutorialTour')
    type WaitForTutorialTarget = <Target>(options: {
      findTarget: () => Target | null
      observe: (onMutation: () => void) => () => void
      scheduleFallback: (onTimeout: () => void) => () => void
      onResolve: (target: Target | null) => void
    }) => () => void
    const waitForTutorialTarget = (tour as typeof tour & {
      waitForTutorialTarget?: WaitForTutorialTarget
    }).waitForTutorialTarget
    expect(waitForTutorialTarget).toBeTypeOf('function')

    let notifyMutation: (() => void) | null = null
    let notifyTimeout: (() => void) | null = null
    let observerDisconnects = 0
    let timeoutCancels = 0
    const resolutions: Array<{ id: string } | null> = []

    waitForTutorialTarget!({
      findTarget: () => null,
      observe: onMutation => {
        notifyMutation = onMutation
        return () => { observerDisconnects += 1 }
      },
      scheduleFallback: onTimeout => {
        notifyTimeout = onTimeout
        return () => { timeoutCancels += 1 }
      },
      onResolve: target => resolutions.push(target),
    })

    ;(notifyTimeout as (() => void) | null)?.()
    ;(notifyMutation as (() => void) | null)?.()

    expect(resolutions).toEqual([null])
    expect(observerDisconnects).toBe(1)
    expect(timeoutCancels).toBe(1)
  })
})
