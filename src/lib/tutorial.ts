import type { Page } from '../components/Sidebar'

export const TUTORIAL_VERSION = 2
export const TUTORIAL_STATE_KEY = 'babydiary.tutorial.v2'
export const TUTORIAL_SHORTCUT_BLOCKING_SELECTOR = '[data-tutorial-active="true"], .tour-stage, .tour-overlay, .tour-overlay-strip'

export type TutorialExitReason = 'completed' | 'skipped'
export type TutorialPlacement = 'right' | 'left' | 'bottom' | 'top' | 'center'
export type TutorialIcon = 'heart' | 'spark' | 'clock' | 'book' | 'settings' | 'check'

export interface TutorialStep {
  id: string
  page: Page
  targetSelector?: string
  placement: TutorialPlacement
  icon: TutorialIcon
  eyebrowKey: `tour.${string}`
  titleKey: `tour.${string}`
  bodyKey: `tour.${string}`
}

export interface TutorialState {
  version: number
  status: TutorialExitReason
  updatedAt: string
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: 'welcome', page: 'home', placement: 'center', icon: 'heart', eyebrowKey: 'tour.welcomeEyebrow', titleKey: 'tour.welcomeTitle', bodyKey: 'tour.welcomeBody' },
  { id: 'quick-record', page: 'home', targetSelector: '[data-tour="quick-row"]', placement: 'bottom', icon: 'spark', eyebrowKey: 'tour.quickEyebrow', titleKey: 'tour.quickTitle', bodyKey: 'tour.quickBody' },
  { id: 'today-overview', page: 'home', targetSelector: '[data-tour="hero"]', placement: 'bottom', icon: 'clock', eyebrowKey: 'tour.overviewEyebrow', titleKey: 'tour.overviewTitle', bodyKey: 'tour.overviewBody' },
  { id: 'navigation', page: 'home', targetSelector: '[data-tour="navigation"]', placement: 'right', icon: 'book', eyebrowKey: 'tour.navigationEyebrow', titleKey: 'tour.navigationTitle', bodyKey: 'tour.navigationBody' },
  { id: 'settings-family', page: 'settings', targetSelector: '[data-tour="settings-sync"]', placement: 'left', icon: 'settings', eyebrowKey: 'tour.settingsEyebrow', titleKey: 'tour.settingsTitle', bodyKey: 'tour.settingsBody' },
  { id: 'ready', page: 'home', placement: 'center', icon: 'check', eyebrowKey: 'tour.readyEyebrow', titleKey: 'tour.readyTitle', bodyKey: 'tour.readyBody' },
]

export function isTutorialShortcutBlocked(
  root: Pick<ParentNode, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
): boolean {
  return root ? root.querySelector(TUTORIAL_SHORTCUT_BLOCKING_SELECTOR) !== null : false
}

function defaultStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function readTutorialState(target: Storage | null = defaultStorage()): TutorialState | null {
  if (!target) return null
  try {
    const parsed = JSON.parse(target.getItem(TUTORIAL_STATE_KEY) ?? 'null') as Partial<TutorialState> | null
    if (!parsed || parsed.version !== TUTORIAL_VERSION) return null
    if (parsed.status !== 'completed' && parsed.status !== 'skipped') return null
    if (typeof parsed.updatedAt !== 'string') return null
    return parsed as TutorialState
  } catch { return null }
}

export function shouldAutoStartTutorial(target: Storage | null = defaultStorage()): boolean {
  return readTutorialState(target) === null
}

export function markTutorialExit(reason: TutorialExitReason, target: Storage | null = defaultStorage()): void {
  if (!target) return
  try {
    target.setItem(TUTORIAL_STATE_KEY, JSON.stringify({ version: TUTORIAL_VERSION, status: reason, updatedAt: new Date().toISOString() }))
  } catch { /* app use must never depend on optional onboarding persistence */ }
}

export function clearTutorialState(target: Storage | null = defaultStorage()): void {
  try { target?.removeItem(TUTORIAL_STATE_KEY) } catch { /* no-op */ }
}
