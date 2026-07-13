# Premium Tutorial V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense ten-step tour with a premium, skippable, versioned six-step Korean/Japanese tutorial that works in packaged macOS and Windows builds.

**Architecture:** Move tutorial state and step metadata into a pure model, render the dialog controls in a focused presentational component, and keep navigation/geometry/focus orchestration in `TutorialTour`. App-level exit handling remembers the replay origin while packaged E2E verifies both languages and persistence.

**Tech Stack:** React 18, TypeScript 5.5, i18next, vanilla CSS, Vitest, Playwright Electron, existing icon components.

## Global Constraints

- Preserve the current Baby Diary warm cream/pastel visual system and both light/dark themes.
- The tutorial contains exactly six steps: welcome, quick record, today overview, navigation, settings/family, ready.
- “Skip” is visible on every step and `Escape` always skips.
- Korean and Japanese must have exact key parity and natural, concise copy.
- No new runtime dependency, image asset, analytics, medical claim, or absolute data-safety claim.
- All motion uses transform/opacity and becomes instant under `prefers-reduced-motion: reduce`.
- Background features cannot be activated through the spotlight.
- Supported verification sizes: 720×560, 960×640, and 1200×800.

---

## File structure

- Create `src/lib/tutorial.ts`: versioned state, storage helpers, step metadata, and launch/exit decisions.
- Create `src/components/TutorialCard.tsx`: semantic dialog card and all controls.
- Modify `src/components/TutorialTour.tsx`: orchestration, target geometry, focus, keyboard, inert background, and responsive behavior.
- Modify `src/App.tsx`: auto-launch V2 once and restore the replay origin on skip.
- Modify `src/components/Sidebar.tsx`: add one navigation-group tutorial target.
- Modify `src/pages/SettingsPage.tsx`: add one settings/sync tutorial target and replay button ref support if needed.
- Modify `src/i18n/ko.json`, `src/i18n/ja.json`: replace the V1 copy with complete V2 strings.
- Modify `src/index.css`: premium card, integrated progress/actions, compact layout, dark mode, and reduced motion.
- Create `tests/tutorial.test.ts`: pure state, step, and localization contracts.
- Modify `scripts/mac-e2e.mjs`: packaged Korean/Japanese tutorial behavior and screenshots.

---

### Task 1: Versioned tutorial model and bilingual contract

**Files:**
- Create: `src/lib/tutorial.ts`
- Create: `tests/tutorial.test.ts`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`

**Interfaces:**
- Produces `TUTORIAL_VERSION`, `TUTORIAL_STATE_KEY`, `TUTORIAL_STEPS`, `readTutorialState`, `shouldAutoStartTutorial`, `markTutorialExit`, and `clearTutorialState`.
- `TutorialTour` in Task 2 consumes `TUTORIAL_STEPS` and `markTutorialExit`.
- `App` in Task 2 consumes `shouldAutoStartTutorial`.

- [ ] **Step 1: Write failing state and localization tests**

Create `tests/tutorial.test.ts` with a map-backed `StorageLike` fake and these exact assertions:

```ts
import { describe, expect, it } from 'vitest'
import ko from '../src/i18n/ko.json'
import ja from '../src/i18n/ja.json'
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
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run tests/tutorial.test.ts`

Expected: FAIL because `src/lib/tutorial.ts` does not exist.

- [ ] **Step 3: Implement the pure tutorial model**

Create `src/lib/tutorial.ts` with this public shape and the six metadata records:

```ts
import type { Page } from '../components/Sidebar'

export const TUTORIAL_VERSION = 2
export const TUTORIAL_STATE_KEY = 'babydiary.tutorial.v2'

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
```

- [ ] **Step 4: Replace bilingual tour copy with exact V2 labels**

Keep the `tour` objects key-identical. Use the following Korean/Japanese content:

```json
{
  "skip": "건너뛰기",
  "skipFull": "튜토리얼 건너뛰기",
  "back": "이전",
  "next": "다음",
  "begin": "둘러보기 시작",
  "finish": "기록 시작하기",
  "replayBtn": "튜토리얼 다시 보기",
  "progress": "{{current}} / {{total}} 단계",
  "welcomeEyebrow": "빠른 둘러보기",
  "welcomeTitle": "필요한 것부터, 천천히",
  "welcomeBody": "자주 쓰는 기능만 1분 동안 보여드릴게요. 지금 건너뛰어도 설정에서 언제든 다시 볼 수 있어요.",
  "quickEyebrow": "01 · 바로 기록",
  "quickTitle": "한 번 눌러 오늘을 남겨요",
  "quickBody": "소변·대변은 바로 기록되고, 수유·체온·수면은 필요한 값만 입력하면 돼요.",
  "overviewEyebrow": "02 · 오늘 보기",
  "overviewTitle": "오늘의 흐름을 한눈에 봐요",
  "overviewBody": "기록이 쌓이면 마지막 수유와 오늘의 요약이 필요한 때에 맞춰 나타나요.",
  "navigationEyebrow": "03 · 돌아보기",
  "navigationTitle": "나중에 천천히 꺼내볼 수 있어요",
  "navigationBody": "기록·통계·일기·메시지는 왼쪽 메뉴에 있어요. 처음부터 모두 사용할 필요는 없어요.",
  "settingsEyebrow": "04 · 우리 가족에 맞추기",
  "settingsTitle": "설정에서 필요한 것만 연결해요",
  "settingsBody": "아기 정보, 화면 표시, 백업 위치와 가족 연결을 여기에서 확인할 수 있어요.",
  "readyEyebrow": "준비 완료",
  "readyTitle": "이제 첫 기록을 남겨볼까요?",
  "readyBody": "가장 쉬운 기록 하나부터 시작해보세요. 튜토리얼은 설정에서 언제든 다시 볼 수 있어요."
}
```

```json
{
  "skip": "スキップ",
  "skipFull": "チュートリアルをスキップ",
  "back": "戻る",
  "next": "次へ",
  "begin": "ツアーを始める",
  "finish": "記録を始める",
  "replayBtn": "チュートリアルをもう一度見る",
  "progress": "{{current}} / {{total}} ステップ",
  "welcomeEyebrow": "クイックツアー",
  "welcomeTitle": "必要なところから、ゆっくり",
  "welcomeBody": "よく使う機能だけを1分でご案内します。今はスキップしても、設定からいつでも見直せます。",
  "quickEyebrow": "01 · すぐに記録",
  "quickTitle": "ワンタップで今日を残せます",
  "quickBody": "おしっこ・うんちはすぐに記録。授乳・体温・睡眠は、必要な項目だけ入力できます。",
  "overviewEyebrow": "02 · 今日を見る",
  "overviewTitle": "今日の流れをひと目で",
  "overviewBody": "記録が増えると、最後の授乳や今日のまとめが必要なときに表示されます。",
  "navigationEyebrow": "03 · 振り返る",
  "navigationTitle": "あとから、ゆっくり振り返れます",
  "navigationBody": "履歴・統計・日記・メッセージは左のメニューから。最初から全部使う必要はありません。",
  "settingsEyebrow": "04 · 家族に合わせる",
  "settingsTitle": "設定で必要なものだけつなげます",
  "settingsBody": "赤ちゃん情報、表示、バックアップ先、家族との連携をここで確認できます。",
  "readyEyebrow": "準備完了",
  "readyTitle": "最初の記録を残してみましょう",
  "readyBody": "まずは一件だけ記録してみてください。ツアーは設定からいつでも見直せます。"
}
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/tutorial.test.ts`

Expected: PASS, 6-step order and Korean/Japanese parity confirmed.

Commit:

```bash
git add src/lib/tutorial.ts src/i18n/ko.json src/i18n/ja.json tests/tutorial.test.ts
git commit -m "feat: add versioned bilingual tutorial model"
```

---

### Task 2: Premium skippable tutorial UI and app lifecycle

**Files:**
- Create: `src/components/TutorialCard.tsx`
- Modify: `src/components/TutorialTour.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/index.css`
- Test: `tests/tutorial.test.ts`

**Interfaces:**
- Consumes Task 1's `TutorialStep`, `TutorialExitReason`, `TUTORIAL_STEPS`, `markTutorialExit`, and `shouldAutoStartTutorial`.
- `TutorialTour` produces `onExit(reason: TutorialExitReason): void`.
- `TutorialCard` consumes current step, translated strings, index/total, and `onBack`, `onNext`, `onSkip` callbacks.

- [ ] **Step 1: Add failing real-component render assertions**

Append tests that render the real `TutorialCard` with `react-dom/server` and verify user-visible semantics rather than source text:

```tsx
import React from 'react'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import i18n from '../src/i18n'
import { TutorialCard } from '../src/components/TutorialCard'

it('renders an always-skippable modal with progress and navigation', () => {
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TutorialCard
        step={TUTORIAL_STEPS[1]}
        stepIndex={1}
        totalSteps={TUTORIAL_STEPS.length}
        position={{}}
        compact={false}
        onBack={() => undefined}
        onNext={() => undefined}
        onSkip={() => undefined}
        cardRef={createRef<HTMLElement>()}
      />
    </I18nextProvider>,
  )

  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  expect(html).toContain('tour-skip-button')
  expect(html).toContain('tour-back-button')
  expect(html).toContain('tour-primary-button')
  expect((html.match(/tour-progress-segment/g) ?? [])).toHaveLength(6)
})
```

Run: `npx vitest run tests/tutorial.test.ts`

Expected: FAIL because the new card and contracts are absent.

- [ ] **Step 2: Build `TutorialCard` as a semantic, integrated control surface**

Implement a modal `<section role="dialog" aria-modal="true">` with:

- icon tile and eyebrow;
- header skip button on contextual/final steps, while Welcome exposes the same action as its secondary footer button;
- localized title and description IDs;
- integrated six-segment progress rail and localized progress text;
- Back on steps 2–6, a text skip action on Welcome, and one primary Next/Start/Finish action;
- refs for initial focus and actual card-height measurement;
- no inline visual styles other than the outer geometry supplied by `TutorialTour`.

The exported props must be:

```ts
export interface TutorialCardProps {
  step: TutorialStep
  stepIndex: number
  totalSteps: number
  position: React.CSSProperties
  compact: boolean
  onBack: () => void
  onNext: () => void
  onSkip: () => void
  cardRef: React.RefObject<HTMLElement>
}
```

- [ ] **Step 3: Refactor `TutorialTour` around the V2 model**

Preserve the proven target measurement logic but replace the embedded card/body/step array. Required behavior:

```ts
interface TutorialTourProps {
  onNavigate: (page: Page) => void
  onExit: (reason: TutorialExitReason) => void
}

const handleSkip = () => {
  markTutorialExit('skipped')
  onExit('skipped')
}

const handleNext = () => {
  if (stepIndex === TUTORIAL_STEPS.length - 1) {
    markTutorialExit('completed')
    onExit('completed')
    return
  }
  setStepIndex(index => index + 1)
}

const handleBack = () => setStepIndex(index => Math.max(0, index - 1))
```

After every awaited/render boundary, measure the real card height before final viewport clamping. Add one transparent interaction shield over the spotlight opening. While mounted, set `inert` on `.sidebar` and `.main-content`, restore their previous state on cleanup, lock body overflow, focus the card's primary action, and restore the previously focused element on exit.

Keyboard rules:

```ts
if (event.key === 'Escape') handleSkip()
if (event.key === 'ArrowLeft' && stepIndex > 0) handleBack()
if (event.key === 'ArrowRight' || event.key === 'Enter') handleNext()
```

Ignore navigation shortcuts when `event.target` is an input, textarea, select, button other than the focused primary action, or contenteditable element.

- [ ] **Step 4: Wire versioned launch and exit restoration in `App.tsx`**

Replace the old component helper import with the Task 1 model. Keep a `tourOriginPage` ref. Auto-launch V2 when `shouldAutoStartTutorial()` is true. Replay stores the current page. Exit behavior:

```ts
const startTour = useCallback(() => {
  tourOriginPage.current = currentPage
  setCurrentPage('home')
  setTourActive(true)
}, [currentPage])

const endTour = useCallback((reason: TutorialExitReason) => {
  setTourActive(false)
  setCurrentPage(reason === 'completed' ? 'home' : tourOriginPage.current)
}, [])
```

The first-launch language picker still precedes the tutorial. Do not clear V2 state for replay; an explicit replay bypasses the auto-launch predicate.

- [ ] **Step 5: Add stable spotlight targets**

- Add `data-tour="navigation"` to the root `<nav className="sidebar">` in `Sidebar.tsx`.
- Wrap the Sync `DisclosureSection` in Settings with `<div data-tour="settings-sync">` without changing layout.
- Leave existing per-page `data-tour` attributes intact for E2E compatibility.

- [ ] **Step 6: Replace tutorial CSS with the premium V2 system**

Implement classes for `tour-stage`, `tour-backdrop`, `tour-spotlight-ring`, `tour-target-shield`, `tour-card`, `tour-card-header`, `tour-icon-tile`, `tour-eyebrow`, `tour-title`, `tour-body`, `tour-progress`, `tour-progress-segment`, `tour-actions`, `tour-skip-button`, `tour-back-button`, and `tour-primary-button`.

Use existing tokens and these motion constraints:

```css
@keyframes tour-card-enter {
  from { opacity: 0; transform: translate3d(0, 8px, 0) scale(.985); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}

.tour-card { animation: tour-card-enter 240ms var(--ease-out-smooth) both; }
.tour-progress-segment { transition: background-color 180ms ease-out, transform 180ms ease-out; }
.tour-primary-button:active { transform: translateY(1px); }

@media (max-width: 720px), (max-height: 600px) {
  .tour-card {
    position: fixed !important;
    inset: auto 12px 12px !important;
    width: auto !important;
    max-height: calc(100dvh - 24px);
    overflow: auto;
    transform: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tour-card, .tour-spotlight-ring, .tour-progress-segment { animation: none !important; transition: none !important; }
}
```

Keep Japanese line-height at least `1.7`, use `text-wrap: pretty` for body copy, and include dark-theme tokens. Remove obsolete detached dot and lower-left skip-pill rules.

- [ ] **Step 7: Run focused and full checks, then commit**

Run:

```bash
npx vitest run tests/tutorial.test.ts
npm run typecheck
npm run check
```

Expected: focused tests PASS; full suite has at least the baseline 24 files/484 tests plus the new tutorial tests, with 0 failures.

Commit:

```bash
git add src/components/TutorialCard.tsx src/components/TutorialTour.tsx src/App.tsx src/components/Sidebar.tsx src/pages/SettingsPage.tsx src/index.css tests/tutorial.test.ts
git commit -m "feat: redesign tutorial with always-visible skip"
```

---

### Task 3: Packaged Korean/Japanese and cross-platform E2E

**Files:**
- Modify: `scripts/mac-e2e.mjs`
- Modify: `.github/workflows/build.yml` only if a separate tutorial invocation is required; prefer the existing packaged E2E command.

**Interfaces:**
- Consumes stable V2 classes: `.tour-card`, `.tour-skip-button`, `.tour-back-button`, `.tour-primary-button`, `.tour-progress-segment`.
- Verifies persisted key `babydiary.tutorial.v2` and existing settings replay button.

- [ ] **Step 1: Update packaged E2E to fail against V1**

Replace the old three-step/detached-pill checks with these scenarios in the existing isolated userData run:

1. Pick Korean and assert the welcome title and both start/skip actions.
2. Capture `tutorial-ko-welcome`.
3. Click skip and assert the card is gone and parsed V2 state has `{ version: 2, status: 'skipped' }`.
4. Reload and assert no automatic tutorial.
5. Open Settings, click replay, advance to step 2, click Back, and verify the welcome step returns.
6. Change language to Japanese using the real Settings UI, replay, traverse all six steps, and assert Japanese title/button text.
7. Capture `tutorial-ja-context` and `tutorial-ja-ready`.
8. Replay at 720×560 and assert card/actions are within the viewport with no horizontal overflow.
9. Emulate reduced motion, replay, and assert the card/ring computed `animationName` is `none`.
10. Replay and press Escape; assert it closes and returns to Settings.

Required assertion shape:

```js
const state = await page.evaluate(() => JSON.parse(localStorage.getItem('babydiary.tutorial.v2')))
assert(state.version === 2 && state.status === 'skipped', 'skip persists tutorial v2 state')

const bounds = await page.locator('.tour-card').boundingBox()
assert(bounds && bounds.x >= 0 && bounds.y >= 0, 'compact tutorial starts inside viewport')
assert(bounds.x + bounds.width <= 720 && bounds.y + bounds.height <= 560, 'compact tutorial actions stay visible')
```

- [ ] **Step 2: Run source E2E prerequisites and production build**

Run:

```bash
npm run check
npm run build
```

Expected: all tests and type checks PASS; Vite/Electron production build completes.

- [ ] **Step 3: Run packaged Windows E2E locally**

Build or point the existing E2E harness at the packaged Windows app, then run:

```powershell
$env:BABYDIARY_E2E_EXECUTABLE='C:\path\to\Baby Diary.exe'
npm run test:e2e
```

Expected: Korean skip, replay/back, Japanese completion, compact layout, Escape, and reduced-motion assertions all PASS with zero console errors.

- [ ] **Step 4: Commit the E2E contract**

```bash
git add scripts/mac-e2e.mjs .github/workflows/build.yml
git commit -m "test: cover bilingual tutorial lifecycle in packages"
```

- [ ] **Step 5: Final verification**

Run:

```bash
git diff --check origin/master...HEAD
npm run check
npm run build
git status --short
```

Expected: no whitespace errors; all checks/builds pass; worktree is clean after commits.

Review the captured Korean/Japanese screenshots at 960×640, 1200×800, compact 720×560, dark mode, and reduced motion before declaring completion. CI must run the same packaged E2E on macOS and Windows.
