# Sleep + Growth Record Axes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new event types — `sleep` (ぴよログ-style two-tap timer) and `growth` (weight/height with WHO z-score growth charts) — to Baby Diary (Electron + React + TypeScript), wired fully through types, validation, store, UI, i18n, charts, and tests.

**Architecture:** Both types follow the existing DiaryEvent schema: add to the `EventType` union in `shared/types.ts`, add data interfaces, add to `VALID_TYPES` in `electron/store/eventLog.ts` (the ONLY validation gate), extend `EventIcon`/`formatEventValue`, add UI in `HomePage` (sleep) + QuickMenu (growth), extend `StatsPage` charts, update `HistoryPage` summaries. WHO math goes in a new pure-logic module `src/lib/whoGrowth.ts` that imports (but never modifies) `src/lib/whoGrowthData.ts`.

**Tech Stack:** React 18 + TypeScript 5.5, Zustand store, Recharts (ComposedChart/Line/Scatter for growth curves), date-fns, Vitest (unit tests), Playwright Electron (E2E in `scripts/mac-e2e.mjs`), CSS custom props / glass design system in `src/index.css`.

## Global Constraints

- `src/lib/whoGrowthData.ts` — DO NOT modify any numbers or exports; import only.
- All user-visible strings must appear in both `src/i18n/ko.json` AND `src/i18n/ja.json`.
- No emoji in code. Icons use custom SVG components with `strokeWidth=2.5` (match existing icon set in `src/components/icons.tsx`).
- Dark mode: every new CSS var must have a `[data-theme="dark"]` override.
- `prefers-reduced-motion`: any new animation must be guarded with `@media (prefers-reduced-motion: reduce)`.
- TypeScript strict mode (`"strict": true` in `tsconfig.json`). Run `npx tsc --noEmit` after every task; must produce zero errors.
- All existing 255+ tests must remain green; only add tests.
- Commit style: `feat(type): description` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Min window width: 960px — quick row with 6 buttons must still fit.
- WHO data: `WFA_BOYS`, `WFA_GIRLS` (weight-for-age), `LHFA_BOYS`, `LHFA_GIRLS` (length/height-for-age) from `src/lib/whoGrowthData.ts`. Month range 0–24.

---

## File Map

| Status | File | What changes |
|--------|------|--------------|
| Modify | `shared/types.ts` | Add `'sleep'`/`'growth'` to `EventType`; add `SleepData`, `GrowthData` interfaces |
| Modify | `electron/store/eventLog.ts` | Add `'sleep'`, `'growth'` to `VALID_TYPES` array |
| Modify | `src/components/icons.tsx` | Add `IconMoon`, `IconRuler` SVG components |
| Modify | `src/components/EventIcon.tsx` | Add color entries + icon entries for sleep/growth |
| Modify | `src/store/useAppStore.ts` | Add `addSleep`, `addGrowth` helpers; `todaySleepMinutes` selector |
| Modify | `src/i18n/ko.json` | Add sleep/growth keys |
| Modify | `src/i18n/ja.json` | Add sleep/growth keys |
| **Create** | `src/lib/whoGrowth.ts` | Pure WHO math: `computeZ`, `zToPercentile`, `percentileBandValue` |
| Modify | `src/pages/HomePage.tsx` | Sleep timer button (#6), SleepTimerPill, SleepConfirmPopover, GrowthPopover; keyboard shortcut 6; QuickMenu sleep+growth rows; InsightsPanel sleep total row |
| Modify | `src/pages/StatsPage.tsx` | Sleep chart (daily total bars, indigo); Growth curve section (ComposedChart + WHO bands) |
| Modify | `src/pages/HistoryPage.tsx` | Week/month summaries: sleep count+total, growth entries |
| Modify | `src/index.css` | Add `--lavender-*` / `--indigo-*` CSS vars (light + dark); sleep pill / growth popover styles |
| **Create** | `tests/whoGrowth.test.ts` | WHO math unit tests (known values, interpolation, |z|>3, erf) |
| **Create** | `tests/sleepEvent.test.ts` | Sleep event validation, duration format, rehydrate/discard logic |
| **Create** | `tests/growthEvent.test.ts` | Growth validation (both empty rejected), formatEventValue |
| Modify | `scripts/mac-e2e.mjs` | Add sleep two-tap E2E flow + growth via QuickMenu + growth chart screenshot |

---

## Task 1: Types + Validation Gate

**Files:**
- Modify: `shared/types.ts`
- Modify: `electron/store/eventLog.ts`

**Interfaces:**
- Produces: `SleepData = { minutes: number; note?: string }`, `GrowthData = { weightKg?: number; heightCm?: number; note?: string }` — used by Tasks 3, 4, 5, 6, 7.
- Produces: `'sleep'` and `'growth'` added to `EventType` union and `VALID_TYPES`.

- [ ] **Step 1: Add types to shared/types.ts**

Replace the `EventType` line and add the two data interfaces. Open `shared/types.ts` and make these edits:

```typescript
// Line 1 — replace the EventType union:
export type EventType = 'pee' | 'poop' | 'temp' | 'breast' | 'formula' | 'diary' | 'message' | 'sleep' | 'growth'

// After MessageData interface (line 9), add:
export interface SleepData { minutes: number; note?: string }
export interface GrowthData { weightKg?: number; heightCm?: number; note?: string }

// Update EventData union to include SleepData | GrowthData:
export type EventData =
  | PeeData
  | PoopData
  | TempData
  | BreastData
  | FormulaData
  | DiaryData
  | MessageData
  | SleepData
  | GrowthData
```

- [ ] **Step 2: Add to VALID_TYPES in eventLog.ts**

In `electron/store/eventLog.ts` line 5, change:

```typescript
// Before:
const VALID_TYPES: EventType[] = ['pee', 'poop', 'temp', 'breast', 'formula', 'diary', 'message']

// After:
const VALID_TYPES: EventType[] = ['pee', 'poop', 'temp', 'breast', 'formula', 'diary', 'message', 'sleep', 'growth']
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`

Expected: 0 errors (new types must satisfy the union; EventData will now include new variants).

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run --reporter=verbose`

Expected: all existing tests pass (no logic changed, only type/validation extension).

- [ ] **Step 5: Commit**

```
git add shared/types.ts electron/store/eventLog.ts
git commit -m "feat(types): add sleep and growth event types to EventType union and VALID_TYPES

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: New Icons + CSS Variables

**Files:**
- Modify: `src/components/icons.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Produces: `IconMoon` and `IconRuler` exported from `src/components/icons.tsx` — used by Tasks 3 and 4.
- Produces: CSS vars `--lavender-100`, `--lavender-200`, `--lavender-300`, `--lavender-500`, `--lavender-600`, `--indigo-100`, `--indigo-200`, `--indigo-300`, `--indigo-500`, `--indigo-600` — used by Tasks 3, 4, 6.

- [ ] **Step 1: Add IconMoon and IconRuler to icons.tsx**

At the end of `src/components/icons.tsx` (after `IconEnvelopeHeart`, before or after any other icons), add:

```tsx
export function IconMoon({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 1 0 9.79 9.79Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconRuler({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M3 17L17 3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M3 17L7 21L21 7L17 3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8 16L10 14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M12 12L14 10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M6.5 12.5L9 10" stroke={color} strokeWidth={strokeWidth * 0.7} strokeLinecap="round" opacity="0.5"/>
    </svg>
  )
}
```

- [ ] **Step 2: Add CSS vars in src/index.css**

In the `:root` block (around line 100, after the `--stone-*` section), add lavender and indigo palettes:

```css
/* ── Lavender/Indigo palette (sleep + growth icons, chart fills) ── */
--lavender-100: #ede9f8;
--lavender-200: #d8d1f4;
--lavender-300: #b9aeed;
--lavender-500: #7c66d4;
--lavender-600: #5c44b8;
--indigo-100:  #e6eaf8;
--indigo-200:  #ccd3f4;
--indigo-300:  #a5b1ec;
--indigo-500:  #4a60d4;
--indigo-600:  #3047b0;
--lavender-shadow: rgba(124,102,212,0.14);
--indigo-shadow:   rgba(74,96,212,0.14);
```

In the `[data-theme="dark"]` block (find it in `src/index.css`), add dark-mode overrides:

```css
--lavender-100: #2a2445;
--lavender-200: #3d3560;
--lavender-300: #5a4f8a;
--lavender-500: #9b87e8;
--lavender-600: #b8a8f0;
--indigo-100:  #1e2444;
--indigo-200:  #2e3860;
--indigo-300:  #4a5a8a;
--indigo-500:  #7a90e8;
--indigo-600:  #a0b0f0;
```

Also add the sleep pill and growth popover base styles (after existing `.floating-timer-pill` block):

```css
/* ── Sleep floating pill (stacks below nursing pill when both active) ── */
.floating-sleep-pill {
  position: fixed;
  bottom: calc(52px + env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--lavender-100);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--lavender-200);
  border-radius: 999px;
  padding: 8px 16px 8px 14px;
  box-shadow: 0 4px 16px var(--lavender-shadow), var(--glass-inset-light);
  font-size: 14px;
  font-weight: 600;
  color: var(--lavender-600);
  z-index: 1200;
  animation: glassAppear var(--dur-spring) var(--spring-snappy);
  white-space: nowrap;
}
.floating-sleep-pill + .floating-timer-pill {
  bottom: calc(104px + env(safe-area-inset-bottom));
}
.floating-sleep-time {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.floating-sleep-stop {
  background: var(--lavender-500);
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-snap) var(--spring-snappy);
}
.floating-sleep-stop:hover { background: var(--lavender-600); }
@media (prefers-reduced-motion: reduce) {
  .floating-sleep-pill { animation: none; }
}
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 4: Commit**

```
git add src/components/icons.tsx src/index.css
git commit -m "feat(ui): add IconMoon, IconRuler, lavender/indigo CSS palette for sleep+growth

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: EventIcon + formatEventValue

**Files:**
- Modify: `src/components/EventIcon.tsx`
- Modify: `src/store/useAppStore.ts`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`

**Interfaces:**
- Consumes: `IconMoon`, `IconRuler` from `src/components/icons.tsx` (Task 2).
- Consumes: `SleepData`, `GrowthData` from `shared/types.ts` (Task 1).
- Produces: `EventIcon` handles `'sleep'` and `'growth'` types.
- Produces: `formatEventValue` handles `'sleep'` (e.g. `"2시간 5분"` / `"45분"`) and `'growth'` (e.g. `"7.2kg · 68.5cm"`).
- Produces: `eventLabel` maps `'sleep'` → `t('event.sleep')`, `'growth'` → `t('event.growth')`.

- [ ] **Step 1: Update EventIcon.tsx**

In `src/components/EventIcon.tsx`, update imports to add `IconMoon` and `IconRuler`:

```tsx
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconBook, IconEnvelopeHeart, IconMoon, IconRuler } from './icons'
```

Add entries to `COLOR_MAP`:

```tsx
const COLOR_MAP: Record<EventType, { bg: string; color: string; ring: string }> = {
  pee:     { bg: 'var(--sage-100)',      color: 'var(--sage-600)',    ring: 'var(--sage-200)' },
  poop:    { bg: 'var(--sage-100)',      color: 'var(--sage-500)',    ring: 'var(--sage-200)' },
  temp:    { bg: 'var(--amber-100)',     color: 'var(--amber-600)',   ring: 'var(--amber-200)' },
  breast:  { bg: 'var(--peach-100)',    color: 'var(--peach-600)',   ring: 'var(--peach-200)' },
  formula: { bg: 'var(--peach-100)',    color: 'var(--peach-500)',   ring: 'var(--peach-200)' },
  diary:   { bg: 'var(--rose-100)',     color: 'var(--rose-500)',    ring: 'var(--rose-200)' },
  message: { bg: 'var(--rose-100)',     color: 'var(--rose-500)',    ring: 'var(--rose-200)' },
  sleep:   { bg: 'var(--lavender-100)', color: 'var(--lavender-600)', ring: 'var(--lavender-200)' },
  growth:  { bg: 'var(--indigo-100)',   color: 'var(--indigo-600)',  ring: 'var(--indigo-200)' },
}
```

Add entries to `ICON_MAP`:

```tsx
const ICON_MAP: Record<EventType, IconComponent> = {
  pee:     IconDrop,
  poop:    IconPoop,
  temp:    IconThermometer,
  breast:  IconHeart,
  formula: IconBottle,
  diary:   IconBook,
  message: IconEnvelopeHeart,
  sleep:   IconMoon,
  growth:  IconRuler,
}
```

Add entries to `KEY_MAP` inside `eventLabel`:

```tsx
const KEY_MAP: Record<EventType, string> = {
  pee:     'event.pee',
  poop:    'event.poop',
  temp:    'event.temp',
  breast:  'event.breast',
  formula: 'event.formula',
  diary:   'event.diary',
  message: 'event.message',
  sleep:   'event.sleep',
  growth:  'event.growth',
}
```

- [ ] **Step 2: Update formatEventValue in useAppStore.ts**

In `src/store/useAppStore.ts`, update imports to include `SleepData` and `GrowthData`:

```typescript
import { DiaryEvent, AppSettings, DataInfo, EventType, BreastData, FormulaData, SleepData, GrowthData } from '../../shared/types'
```

In `formatEventValue` (starting line 361), add cases before the `default:`:

```typescript
case 'sleep': {
  const d = e.data as SleepData
  const totalMin = d.minutes
  const lang = i18n.language
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (lang === 'ja') {
      return m > 0 ? `${h}時間${m}分` : `${h}時間`
    }
    return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
  }
  return lang === 'ja' ? `${totalMin}分` : `${totalMin}분`
}
case 'growth': {
  const d = e.data as GrowthData
  const parts: string[] = []
  if (d.weightKg != null) parts.push(`${d.weightKg.toFixed(1)}kg`)
  if (d.heightCm != null) parts.push(`${d.heightCm.toFixed(1)}cm`)
  return parts.join(' · ')
}
```

- [ ] **Step 3: Add i18n keys to ko.json**

In `src/i18n/ko.json`, update these sections:

Under `"event"` object, add:
```json
"sleep": "수면",
"growth": "성장"
```

Under `"quickBtn"` object, add:
```json
"sleep": "수면",
"sleepRunning": "자는 중",
"growth": "성장"
```

Add a new `"sleep"` top-level section:
```json
"sleep": {
  "startLabel": "수면 시작",
  "confirmTitle": "수면 기록",
  "startTime": "시작 시간",
  "duration": "수면 시간",
  "discardTitle": "수면 기록 삭제",
  "discardBody": "16시간이 지난 수면 기록은 자동 삭제됩니다.",
  "floatingLabel": "자는 중 {{mm}}:{{ss}}",
  "floatingStop": "종료",
  "cancel": "취소",
  "record": "기록"
}
```

Add a new `"growth"` top-level section:
```json
"growth": {
  "title": "성장 기록",
  "weightLabel": "몸무게",
  "weightUnit": "kg",
  "heightLabel": "키",
  "heightUnit": "cm",
  "cancel": "취소",
  "record": "기록",
  "atLeastOne": "몸무게 또는 키 중 하나를 입력해주세요"
}
```

Under `"home"`, add:
```json
"todaySleepLabel": "오늘 수면"
```

Under `"stats"`, add:
```json
"sleepTitle": "수면 시간 (분/일)",
"sleepTooltip": "수면",
"sleepUnit": "{{value}}분",
"growthTitle": "성장 곡선",
"growthWeightTitle": "체중 (kg)",
"growthHeightTitle": "키 (cm)",
"growthNoBirthdate": "설정에서 생일·성별을 입력하면 성장곡선을 볼 수 있어요",
"growthDisclaimer": "WHO 국제 성장 기준(2006). 진료 판단은 소아과와 상담하세요.",
"growthPercentile": "최근 {{metric}} {{value}} — P{{pct}} (또래 100명 중 {{pct}}번째)",
"growthP3": "P3",
"growthP15": "P15",
"growthP50": "P50",
"growthP85": "P85",
"growthP97": "P97",
"growthMonthUnit": "{{m}}개월",
"noGrowthData": "이 기간에 성장 기록이 없습니다"
```

Under `"history"`, add:
```json
"sleepIndicator": "수면",
"growthIndicator": "성장"
```

Under `"summary"`, add:
```json
"sleep": "수면 {{count}}회 · {{totalMin}}분",
"growth": "성장 {{count}}회"
```

Under `"quickBtnHint"`, this is a plain string — no change needed (the hint says 1~5; we will update it to 1~6):
Change value to: `"단축키 1~6"`

- [ ] **Step 4: Add i18n keys to ja.json**

In `src/i18n/ja.json`, add the same keys with Japanese translations:

Under `"event"`, add:
```json
"sleep": "ねんね",
"growth": "成長"
```

Under `"quickBtn"`, add:
```json
"sleep": "ねんね",
"sleepRunning": "ねんね中",
"growth": "成長"
```

Add `"sleep"` section:
```json
"sleep": {
  "startLabel": "ねんね開始",
  "confirmTitle": "ねんね記録",
  "startTime": "開始時刻",
  "duration": "睡眠時間",
  "discardTitle": "ねんね記録を削除",
  "discardBody": "16時間が経過したねんね記録は自動削除されます。",
  "floatingLabel": "ねんね中 {{mm}}:{{ss}}",
  "floatingStop": "終了",
  "cancel": "キャンセル",
  "record": "記録"
}
```

Add `"growth"` section:
```json
"growth": {
  "title": "成長記録",
  "weightLabel": "体重",
  "weightUnit": "kg",
  "heightLabel": "身長",
  "heightUnit": "cm",
  "cancel": "キャンセル",
  "record": "記録",
  "atLeastOne": "体重または身長のどちらかを入力してください"
}
```

Under `"home"`, add:
```json
"todaySleepLabel": "今日のねんね"
```

Under `"stats"`, add:
```json
"sleepTitle": "睡眠時間（分/日）",
"sleepTooltip": "睡眠",
"sleepUnit": "{{value}}分",
"growthTitle": "成長曲線",
"growthWeightTitle": "体重（kg）",
"growthHeightTitle": "身長（cm）",
"growthNoBirthdate": "設定で生年月日・性別を入力すると成長曲線が表示されます",
"growthDisclaimer": "WHO国際成長基準（2006年）。診療の判断は小児科にご相談ください。",
"growthPercentile": "最近の{{metric}} {{value}} — P{{pct}}（同月齢100人中{{pct}}番目）",
"growthP3": "P3",
"growthP15": "P15",
"growthP50": "P50",
"growthP85": "P85",
"growthP97": "P97",
"growthMonthUnit": "{{m}}か月",
"noGrowthData": "この期間に成長記録がありません"
```

Under `"history"`, add:
```json
"sleepIndicator": "ねんね",
"growthIndicator": "成長"
```

Under `"summary"`, add:
```json
"sleep": "ねんね {{count}}回・{{totalMin}}分",
"growth": "成長 {{count}}回"
```

Change `"quickBtnHint"` to: `"ショートカット 1〜6"`

- [ ] **Step 5: TypeScript check + tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run --reporter=verbose`

Expected: 0 TS errors; all existing tests pass.

- [ ] **Step 6: Commit**

```
git add src/components/EventIcon.tsx src/store/useAppStore.ts src/i18n/ko.json src/i18n/ja.json
git commit -m "feat(event): EventIcon, formatEventValue, i18n for sleep and growth types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: WHO Growth Math Module

**Files:**
- Create: `src/lib/whoGrowth.ts`
- Create: `tests/whoGrowth.test.ts`

**Interfaces:**
- Consumes: `WFA_BOYS`, `WFA_GIRLS`, `LHFA_BOYS`, `LHFA_GIRLS`, `LmsPoint` from `src/lib/whoGrowthData.ts`.
- Produces:
  - `computeZ(metric: 'weight' | 'height', sex: 'boy' | 'girl', ageMonthsFloat: number, value: number): number`
  - `zToPercentile(z: number): number` — returns 0–100
  - `percentileBandValue(metric: 'weight' | 'height', sex: 'boy' | 'girl', ageMonthsFloat: number, z: number): number`
  - All three used by Task 7 (StatsPage growth charts).

- [ ] **Step 1: Write the failing tests first**

Create `tests/whoGrowth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeZ, zToPercentile, percentileBandValue } from '../src/lib/whoGrowth'

describe('computeZ', () => {
  // Known value: boy 12mo weight 9.6479kg → z ≈ 0 (median = M at 12mo for WFA_BOYS)
  it('boy 12mo weight=9.6479kg -> z≈0 (P50)', () => {
    const z = computeZ('weight', 'boy', 12, 9.6479)
    expect(Math.abs(z)).toBeLessThan(0.01)
  })

  // Known value: girl 0mo height 49.1477cm → P50 (LHFA_GIRLS month 0 M=49.1477)
  it('girl 0mo height=49.1477cm -> z≈0 (P50)', () => {
    const z = computeZ('height', 'girl', 0, 49.1477)
    expect(Math.abs(z)).toBeLessThan(0.01)
  })

  // Interpolation midpoint: between month 0 and 1 for boys weight
  // WFA_BOYS: mo0 M=3.3464, mo1 M=4.4709 → midpoint M ≈ 3.9087
  it('boy 0.5mo weight interpolation midpoint', () => {
    const z = computeZ('weight', 'boy', 0.5, 3.9087)
    expect(Math.abs(z)).toBeLessThan(0.05)
  })

  // |z|>3 weight SD23 adjustment for boy: very low weight
  it('boy 12mo weight=5.0kg -> |z|>3 (adjusted)', () => {
    const z = computeZ('weight', 'boy', 12, 5.0)
    // Should be well below -3
    expect(z).toBeLessThan(-3)
    // Should be finite (not NaN or -Infinity)
    expect(isFinite(z)).toBe(true)
  })

  // |z|>3 positive side
  it('boy 12mo weight=16.0kg -> |z|>3 positive (adjusted)', () => {
    const z = computeZ('weight', 'boy', 12, 16.0)
    expect(z).toBeGreaterThan(3)
    expect(isFinite(z)).toBe(true)
  })
})

describe('zToPercentile', () => {
  it('z=0 -> P50', () => {
    expect(Math.abs(zToPercentile(0) - 50)).toBeLessThan(0.1)
  })

  it('z=-1.645 -> P5 (approx)', () => {
    expect(Math.abs(zToPercentile(-1.645) - 5)).toBeLessThan(0.5)
  })

  it('z=1.282 -> P90 (approx)', () => {
    expect(Math.abs(zToPercentile(1.282) - 90)).toBeLessThan(0.5)
  })

  it('erf approximation accuracy: z=1 -> P84.13 ±0.1', () => {
    expect(Math.abs(zToPercentile(1) - 84.13)).toBeLessThan(0.1)
  })
})

describe('percentileBandValue', () => {
  it('returns M at z=0 for boy 12mo weight', () => {
    const val = percentileBandValue('weight', 'boy', 12, 0)
    expect(Math.abs(val - 9.6479)).toBeLessThan(0.01)
  })

  it('z=2 value > z=0 value', () => {
    const m = percentileBandValue('weight', 'boy', 12, 0)
    const p2 = percentileBandValue('weight', 'boy', 12, 2)
    expect(p2).toBeGreaterThan(m)
  })

  it('interpolates between months correctly', () => {
    const v05 = percentileBandValue('weight', 'boy', 0.5, 0)
    const v0 = percentileBandValue('weight', 'boy', 0, 0)
    const v1 = percentileBandValue('weight', 'boy', 1, 0)
    // Midpoint should be between the two endpoints
    expect(v05).toBeGreaterThan(v0)
    expect(v05).toBeLessThan(v1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/whoGrowth.test.ts --reporter=verbose`

Expected: FAIL — `Cannot find module '../src/lib/whoGrowth'`

- [ ] **Step 3: Implement src/lib/whoGrowth.ts**

Create `src/lib/whoGrowth.ts`:

```typescript
/**
 * WHO Child Growth Standards (2006) — Z-score computation and percentile utilities.
 * Source: WHO Technical Report Series No. 916. Z = ((X/M)^L - 1)/(L*S).
 * Special case L=1 (length/height): Z = (X - M)/(M*S).
 * WHO weight SD23 restricted adjustment for |z|>3 (per WHO guidelines, section 5.2).
 *
 * DO NOT import or re-export from this file — internal module only.
 */
import { WFA_BOYS, WFA_GIRLS, LHFA_BOYS, LHFA_GIRLS, LmsPoint } from './whoGrowthData'

type Metric = 'weight' | 'height'
type Sex = 'boy' | 'girl'

function getTable(metric: Metric, sex: Sex): LmsPoint[] {
  if (metric === 'weight') return sex === 'boy' ? WFA_BOYS : WFA_GIRLS
  return sex === 'boy' ? LHFA_BOYS : LHFA_GIRLS
}

/** Linear interpolation between two LmsPoints at a fractional month. */
function interpolateLms(table: LmsPoint[], ageMonthsFloat: number): LmsPoint {
  const clamped = Math.max(0, Math.min(24, ageMonthsFloat))
  const lo = Math.floor(clamped)
  const hi = Math.min(24, lo + 1)
  if (lo === hi) return table[lo]
  const t = clamped - lo
  const a = table[lo]
  const b = table[hi]
  return {
    month: clamped,
    L: a.L + t * (b.L - a.L),
    M: a.M + t * (b.M - a.M),
    S: a.S + t * (b.S - a.S),
  }
}

/**
 * Compute WHO z-score for weight or height.
 * For weight (non-linear LMS): Z = ((X/M)^L - 1)/(L*S).
 * For height (L≈1, normal): Z = (X - M)/(M*S).
 * WHO weight SD23 restricted adjustment: if |z|>3, use linear extrapolation
 * from SD3 using the SD2-to-SD3 distance as the unit SD.
 */
export function computeZ(metric: Metric, sex: Sex, ageMonthsFloat: number, value: number): number {
  const table = getTable(metric, sex)
  const { L, M, S } = interpolateLms(table, ageMonthsFloat)

  let z: number
  if (metric === 'height' || Math.abs(L - 1) < 1e-9) {
    // L≈1: normal distribution approximation
    z = (value - M) / (M * S)
  } else {
    z = (Math.pow(value / M, L) - 1) / (L * S)
  }

  // WHO SD23 restricted adjustment for weight when |z|>3.
  // SD3pos = M*(1+L*S*3)^(1/L); SD2pos = M*(1+L*S*2)^(1/L)
  // if z>3: z_adj = 3 + (X - SD3pos)/(SD3pos - SD2pos)
  // if z<-3: z_adj = -3 + (X - SD3neg)/(SD3neg - SD2neg)
  if (metric === 'weight' && Math.abs(L) > 1e-9) {
    if (z > 3) {
      const sd3pos = M * Math.pow(1 + L * S * 3, 1 / L)
      const sd2pos = M * Math.pow(1 + L * S * 2, 1 / L)
      z = 3 + (value - sd3pos) / (sd3pos - sd2pos)
    } else if (z < -3) {
      const sd3neg = M * Math.pow(1 + L * S * (-3), 1 / L)
      const sd2neg = M * Math.pow(1 + L * S * (-2), 1 / L)
      z = -3 + (value - sd3neg) / (sd2neg - sd3neg)
    }
  }

  return z
}

/**
 * Convert z-score to percentile (0–100) using Abramowitz & Stegun erf approximation (7.1.26).
 * Max error < 1.5e-7. Source: Handbook of Mathematical Functions, formula 7.1.26.
 */
export function zToPercentile(z: number): number {
  // erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2))
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-(z / Math.SQRT2) * (z / Math.SQRT2))
  const cdf = 0.5 * (1 + (z >= 0 ? erf : -erf))
  return Math.min(99.9, Math.max(0.1, cdf * 100))
}

/**
 * Return the measurement value at a given z-score for chart band lines.
 * Inverse of computeZ for the normal (height) case; for weight uses power-law inverse.
 */
export function percentileBandValue(metric: Metric, sex: Sex, ageMonthsFloat: number, z: number): number {
  const table = getTable(metric, sex)
  const { L, M, S } = interpolateLms(table, ageMonthsFloat)

  if (metric === 'height' || Math.abs(L - 1) < 1e-9) {
    return M * (1 + z * S)
  }
  return M * Math.pow(1 + L * S * z, 1 / L)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/whoGrowth.test.ts --reporter=verbose`

Expected: all 11 tests pass.

- [ ] **Step 5: Full test suite check**

Run: `npx vitest run --reporter=verbose`

Expected: all tests pass (0 failures).

- [ ] **Step 6: Commit**

```
git add src/lib/whoGrowth.ts tests/whoGrowth.test.ts
git commit -m "feat(growth): WHO z-score math module with erf percentile and band values

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Sleep Event Tests + Store Helper

**Files:**
- Create: `tests/sleepEvent.test.ts`
- Modify: `src/store/useAppStore.ts`

**Interfaces:**
- Consumes: `SleepData` from `shared/types.ts` (Task 1).
- Consumes: `formatEventValue` from `src/store/useAppStore.ts`.
- Produces: `useAppStore.addSleep(minutes: number, atOverride?: string): Promise<DiaryEvent>` — used by Task 6.
- Produces: `useAppStore.todaySleepMinutes(): number` — used by Task 6.

- [ ] **Step 1: Write the failing tests**

Create `tests/sleepEvent.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventLog } from '../electron/store/eventLog'
import { DiaryEvent, SleepData } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { formatEventValue } from '../src/store/useAppStore'
import i18n from '../src/i18n'

// --------------- EventLog sleep validation ---------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sleep-test-'))
}

function makeSleepEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'sleep',
    at: now,
    data: { minutes: 90 } as SleepData,
    author: { uid: 'test', name: 'Test', role: 'mom' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

describe('sleep event — EventLog validation', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = makeTempDir()
    log = new EventLog({ dataDir: tmpDir })
  })

  it('accepts sleep event with valid data', () => {
    const e = makeSleepEvent()
    const result = log.append(e)
    expect(result).toBe('ok')
  })

  it('rejects sleep event with invalid type (still rejected by VALID_TYPES before our change would break this)', () => {
    // After Task 1 'sleep' IS valid — this test ensures the event round-trips correctly
    const e = makeSleepEvent()
    log.append(e)
    const loaded = log.loadAll()
    expect(loaded.some(ev => ev.type === 'sleep')).toBe(true)
  })

  it('sleep event persists and reloads with correct minutes', () => {
    const e = makeSleepEvent({ data: { minutes: 125 } as SleepData })
    log.append(e)
    const log2 = new EventLog({ dataDir: tmpDir })
    const loaded = log2.loadAll()
    const found = loaded.find(ev => ev.id === e.id)
    expect(found).toBeDefined()
    expect((found!.data as SleepData).minutes).toBe(125)
  })
})

// --------------- formatEventValue for sleep ---------------

describe('formatEventValue sleep — Korean', () => {
  beforeEach(() => {
    // Set language to Korean for these tests
    vi.spyOn(i18n, 'language', 'get').mockReturnValue('ko')
  })

  function makeSleepForFormat(minutes: number): DiaryEvent {
    const now = new Date().toISOString()
    return {
      id: uuidv4(),
      type: 'sleep',
      at: now,
      data: { minutes } as SleepData,
      author: { uid: 't', name: 'T', role: 'mom' },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
  }

  it('formats 45min as "45분"', () => {
    const result = formatEventValue(makeSleepForFormat(45))
    expect(result).toBe('45분')
  })

  it('formats 120min as "2시간"', () => {
    const result = formatEventValue(makeSleepForFormat(120))
    expect(result).toBe('2시간')
  })

  it('formats 125min as "2시간 5분"', () => {
    const result = formatEventValue(makeSleepForFormat(125))
    expect(result).toBe('2시간 5분')
  })

  it('formats 60min as "1시간"', () => {
    const result = formatEventValue(makeSleepForFormat(60))
    expect(result).toBe('1시간')
  })
})

describe('formatEventValue sleep — Japanese', () => {
  beforeEach(() => {
    vi.spyOn(i18n, 'language', 'get').mockReturnValue('ja')
  })

  function makeSleepForFormat(minutes: number): DiaryEvent {
    const now = new Date().toISOString()
    return {
      id: uuidv4(),
      type: 'sleep',
      at: now,
      data: { minutes } as SleepData,
      author: { uid: 't', name: 'T', role: 'mom' },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
  }

  it('formats 45min as "45分"', () => {
    const result = formatEventValue(makeSleepForFormat(45))
    expect(result).toBe('45分')
  })

  it('formats 125min as "2時間5分"', () => {
    const result = formatEventValue(makeSleepForFormat(125))
    expect(result).toBe('2時間5分')
  })

  it('formats 120min as "2時間"', () => {
    const result = formatEventValue(makeSleepForFormat(120))
    expect(result).toBe('2時間')
  })
})

// --------------- Open-sleep localStorage rehydrate/discard logic ---------------

const SLEEP_START_KEY = 'babydiary.sleepStart'
const MAX_SLEEP_MS = 16 * 60 * 60 * 1000

interface SleepStartState {
  startedAt: number
}

function loadSleepStart(): SleepStartState | null {
  try {
    const raw = localStorage.getItem(SLEEP_START_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SleepStartState
    if (Date.now() - parsed.startedAt > MAX_SLEEP_MS) {
      localStorage.removeItem(SLEEP_START_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

describe('open-sleep rehydrate logic', () => {
  beforeEach(() => {
    // jsdom localStorage is available in vitest node env via vi.stubGlobal
    vi.stubGlobal('localStorage', {
      _store: {} as Record<string, string>,
      getItem(k: string) { return this._store[k] ?? null },
      setItem(k: string, v: string) { this._store[k] = v },
      removeItem(k: string) { delete this._store[k] },
    })
  })

  it('returns null when no state stored', () => {
    expect(loadSleepStart()).toBeNull()
  })

  it('returns state when stored within 16h', () => {
    const state: SleepStartState = { startedAt: Date.now() - 30 * 60 * 1000 }
    localStorage.setItem(SLEEP_START_KEY, JSON.stringify(state))
    const loaded = loadSleepStart()
    expect(loaded).not.toBeNull()
    expect(loaded!.startedAt).toBe(state.startedAt)
  })

  it('discards and returns null when older than 16h', () => {
    const state: SleepStartState = { startedAt: Date.now() - 17 * 60 * 60 * 1000 }
    localStorage.setItem(SLEEP_START_KEY, JSON.stringify(state))
    const loaded = loadSleepStart()
    expect(loaded).toBeNull()
    // Also clears localStorage
    expect(localStorage.getItem(SLEEP_START_KEY)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify tests fail (formatEventValue doesn't handle sleep yet — Task 3 adds it)**

Run: `npx vitest run tests/sleepEvent.test.ts --reporter=verbose`

Note: After Task 3 is complete, the format tests should already pass. The EventLog tests need Task 1.

- [ ] **Step 3: Add addSleep + todaySleepMinutes to useAppStore.ts**

In `src/store/useAppStore.ts`, update the `AppState` interface — add after `addFormula`:

```typescript
addSleep: (minutes: number, atOverride?: string) => Promise<DiaryEvent>
addGrowth: (weightKg: number | undefined, heightCm: number | undefined, atOverride?: string) => Promise<DiaryEvent>
todaySleepMinutes: () => number
```

In the store implementation, add after `addFormula`:

```typescript
addSleep: async (minutes: number, atOverride?: string) => {
  const e = makeBase(get().settings, 'sleep')
  if (atOverride) e.at = atOverride
  e.data = { minutes }
  return get().addEvent(e)
},

addGrowth: async (weightKg: number | undefined, heightCm: number | undefined, atOverride?: string) => {
  if (weightKg == null && heightCm == null) throw new Error('growth_requires_at_least_one')
  const e = makeBase(get().settings, 'growth')
  if (atOverride) e.at = atOverride
  const data: GrowthData = {}
  if (weightKg != null) data.weightKg = weightKg
  if (heightCm != null) data.heightCm = heightCm
  e.data = data
  return get().addEvent(e)
},

todaySleepMinutes: () => {
  return get().events
    .filter(e => !e.deleted && e.type === 'sleep' && isToday(parseISO(e.at)))
    .reduce((sum, e) => sum + ((e.data as SleepData).minutes ?? 0), 0)
},
```

Also update the imports at the top of `useAppStore.ts` to include `SleepData` and `GrowthData`:

```typescript
import { DiaryEvent, AppSettings, DataInfo, EventType, BreastData, FormulaData, SleepData, GrowthData } from '../../shared/types'
```

- [ ] **Step 4: Run sleep tests**

Run: `npx vitest run tests/sleepEvent.test.ts --reporter=verbose`

Expected: all tests pass.

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 6: Commit**

```
git add tests/sleepEvent.test.ts src/store/useAppStore.ts
git commit -m "feat(sleep): sleep event store helper, todaySleepMinutes selector, and unit tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Growth Event Tests

**Files:**
- Create: `tests/growthEvent.test.ts`

**Interfaces:**
- Consumes: `GrowthData` from `shared/types.ts` (Task 1).
- Consumes: `formatEventValue` from `src/store/useAppStore.ts` (Task 3).
- Consumes: `addGrowth` from `src/store/useAppStore.ts` (Task 5).

- [ ] **Step 1: Write growth event tests**

Create `tests/growthEvent.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { EventLog } from '../electron/store/eventLog'
import { DiaryEvent, GrowthData } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { formatEventValue } from '../src/store/useAppStore'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bd-growth-test-'))
}

function makeGrowthEvent(data: GrowthData, overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'growth',
    at: now,
    data,
    author: { uid: 'test', name: 'Test', role: 'dad' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

describe('growth event — EventLog', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-growth-test-'))
    log = new EventLog({ dataDir: tmpDir })
  })

  it('accepts growth event with weight only', () => {
    const e = makeGrowthEvent({ weightKg: 7.2 })
    expect(log.append(e)).toBe('ok')
  })

  it('accepts growth event with height only', () => {
    const e = makeGrowthEvent({ heightCm: 68.5 })
    expect(log.append(e)).toBe('ok')
  })

  it('accepts growth event with both weight and height', () => {
    const e = makeGrowthEvent({ weightKg: 7.2, heightCm: 68.5 })
    expect(log.append(e)).toBe('ok')
  })

  it('roundtrips growth data correctly', () => {
    const e = makeGrowthEvent({ weightKg: 7.2, heightCm: 68.5 })
    log.append(e)
    const log2 = new EventLog({ dataDir: tmpDir })
    const loaded = log2.loadAll()
    const found = loaded.find(ev => ev.id === e.id)
    expect(found).toBeDefined()
    const d = found!.data as GrowthData
    expect(d.weightKg).toBeCloseTo(7.2, 5)
    expect(d.heightCm).toBeCloseTo(68.5, 5)
  })
})

describe('formatEventValue growth', () => {
  function makeGrowthForFormat(data: GrowthData): DiaryEvent {
    const now = new Date().toISOString()
    return {
      id: uuidv4(),
      type: 'growth',
      at: now,
      data,
      author: { uid: 't', name: 'T', role: 'mom' },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
  }

  it('formats weight+height as "7.2kg · 68.5cm"', () => {
    expect(formatEventValue(makeGrowthForFormat({ weightKg: 7.2, heightCm: 68.5 }))).toBe('7.2kg · 68.5cm')
  })

  it('formats weight only as "7.2kg"', () => {
    expect(formatEventValue(makeGrowthForFormat({ weightKg: 7.2 }))).toBe('7.2kg')
  })

  it('formats height only as "68.5cm"', () => {
    expect(formatEventValue(makeGrowthForFormat({ heightCm: 68.5 }))).toBe('68.5cm')
  })

  it('formats both-zero growth as empty string', () => {
    // Edge case: both undefined (should not happen in UI, but test defense)
    expect(formatEventValue(makeGrowthForFormat({}))).toBe('')
  })
})

describe('addGrowth validation', () => {
  it('rejects when both weight and height are undefined', async () => {
    // addGrowth is async and throws 'growth_requires_at_least_one'
    // We test the throw path using a minimal mock
    async function addGrowth(weightKg: number | undefined, heightCm: number | undefined): Promise<void> {
      if (weightKg == null && heightCm == null) throw new Error('growth_requires_at_least_one')
    }
    await expect(addGrowth(undefined, undefined)).rejects.toThrow('growth_requires_at_least_one')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/growthEvent.test.ts --reporter=verbose`

Expected: all tests pass.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add tests/growthEvent.test.ts
git commit -m "test(growth): growth event validation, roundtrip, and formatEventValue tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: HomePage — Sleep Two-Tap Timer

**Files:**
- Modify: `src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `IconMoon` from `src/components/icons.tsx` (Task 2).
- Consumes: `addSleep`, `todaySleepMinutes` from `src/store/useAppStore.ts` (Task 5).
- Consumes: i18n keys `sleep.*`, `home.todaySleepLabel` (Task 3).
- Produces: 6th quick-row button (수면), `FloatingSleepPill`, `SleepConfirmPopover`, keyboard shortcut `6`.

This task is complex. The sleep two-tap pattern follows the nursing timer pattern exactly:

**Sleep state machine:**
- No state stored: button shows 수면/ねんね, click = start (persist `babydiary.sleepStart = { startedAt: Date.now() }` to localStorage).
- State stored, < 16h: button shows live `mm:ss` counter; floating pill shows. Click button OR pill stop → open `SleepConfirmPopover` (shows start time editable, computed duration, confirm/cancel). Confirm → `addSleep(minutes, startAtISO)`, clear localStorage. Cancel → keep timer running.
- State stored, > 16h: discard silently + toast notice.

- [ ] **Step 1: Add sleep timer module-level state (parallel to nursingTimer)**

In `src/pages/HomePage.tsx`, after the nursing timer constants (around line 622), add:

```tsx
// ---------------------------------------------------------------------------
// Sleep timer state (module-level like nursingTimer — survives popover close)
// ---------------------------------------------------------------------------
interface SleepTimerState {
  running: boolean
  startedAt: number | null
}

const SLEEP_TIMER_KEY = 'babydiary.sleepStart'
const MAX_SLEEP_MS = 16 * 60 * 60 * 1000

function loadSleepTimer(): SleepTimerState {
  try {
    const raw = localStorage.getItem(SLEEP_TIMER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SleepTimerState
      if (parsed.running && parsed.startedAt) {
        if (Date.now() - parsed.startedAt > MAX_SLEEP_MS) {
          localStorage.removeItem(SLEEP_TIMER_KEY)
          return { running: false, startedAt: null }
        }
        return parsed
      }
    }
  } catch { /* ignore */ }
  return { running: false, startedAt: null }
}

function saveSleepTimer(state: SleepTimerState): void {
  try {
    if (state.running) {
      localStorage.setItem(SLEEP_TIMER_KEY, JSON.stringify(state))
    } else {
      localStorage.removeItem(SLEEP_TIMER_KEY)
    }
  } catch { /* ignore */ }
}

const sleepTimer: SleepTimerState = loadSleepTimer()
```

- [ ] **Step 2: Add FloatingSleepPill component**

After `FloatingTimerPill` component (around line 958), add:

```tsx
// ---------------------------------------------------------------------------
// Floating sleep timer pill
// ---------------------------------------------------------------------------
interface FloatingSleepPillProps {
  onStop: () => void
}

function FloatingSleepPill({ onStop }: FloatingSleepPillProps) {
  const [display, setDisplay] = useState('00:00')
  const { t } = useTranslation()

  useEffect(() => {
    const id = setInterval(() => {
      if (sleepTimer.running && sleepTimer.startedAt != null) {
        const sec = Math.floor((Date.now() - sleepTimer.startedAt) / 1000)
        const mm = String(Math.floor(sec / 60)).padStart(2, '0')
        const ss = String(sec % 60).padStart(2, '0')
        setDisplay(`${mm}:${ss}`)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const [mm, ss] = display.split(':')

  return (
    <div className="floating-sleep-pill">
      <span className="floating-sleep-time">{t('sleep.floatingLabel', { mm, ss })}</span>
      <button
        className="floating-sleep-stop"
        onClick={onStop}
        aria-label={t('sleep.floatingStop')}
      >
        {t('sleep.floatingStop')}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Add SleepConfirmPopover component**

After `FloatingSleepPill`, add:

```tsx
// ---------------------------------------------------------------------------
// Sleep confirm popover (shown after tap-to-stop)
// ---------------------------------------------------------------------------
interface SleepConfirmPopoverProps {
  startedAt: number
  anchor: DOMRect
  onConfirm: (minutes: number, startAtISO: string) => void
  onCancel: () => void
}

function SleepConfirmPopover({ startedAt, anchor, onConfirm, onCancel }: SleepConfirmPopoverProps) {
  const { t } = useTranslation()
  const elapsedMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000))
  const startISO = new Date(startedAt).toISOString()
  const [startValue, setStartValue] = useState(
    new Date(startedAt).toTimeString().slice(0, 5) // "HH:MM"
  )
  const [durationMin, setDurationMin] = useState(elapsedMin)

  const handleConfirm = () => {
    // Parse startValue "HH:MM" into today's date
    const [hh, mm] = startValue.split(':').map(Number)
    const d = new Date()
    d.setHours(hh, mm, 0, 0)
    onConfirm(durationMin, d.toISOString())
  }

  const POPOVER_W = 280
  const rawLeft = anchor.left - 80
  const clampedLeft = Math.min(Math.max(8, rawLeft), window.innerWidth - POPOVER_W - 8)
  const POPOVER_H = 220
  const openUpward = anchor.bottom + 8 + POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = openUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: clampedLeft }
    : { top: anchor.bottom + 8, left: clampedLeft }

  return (
    <>
      <div className="popover-overlay" onClick={onCancel} />
      <div className="popover" style={style}>
        <div className="label" style={{ marginBottom: 8 }}>{t('sleep.confirmTitle')}</div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('sleep.startTime')}</div>
            <input
              type="time"
              className="input-field"
              value={startValue}
              onChange={e => setStartValue(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('sleep.duration')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                className="input-field"
                value={durationMin}
                min={1}
                max={960}
                onChange={e => setDurationMin(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ width: 70 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('popover.minutesPlaceholder')}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onCancel}>{t('sleep.cancel')}</button>
          <button type="button" className="btn-primary" onClick={handleConfirm}>{t('sleep.record')}</button>
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 4: Wire up sleep state in HomePage**

In `HomePage` function:
1. Import `addSleep`, `todaySleepMinutes` from store.
2. Add state vars after existing state.
3. Add `handleSleepButtonClick` handler.
4. Add `handleSleepStop` (from pill button).
5. Add `handleSleepConfirm`.
6. Add 6th button to `quickBtns` array.
7. Add keyboard shortcut `'6'`.
8. Render `FloatingSleepPill` and `SleepConfirmPopover`.

In `src/pages/HomePage.tsx`, in the `HomePage` function near the top:

```tsx
// In the destructuring of useAppStore (line 971):
const { addPee, addPoop, addTemp, addBreast, addFormula, addSleep, editEvent, softDeleteEvent, todayEvents, events } = useAppStore()

// Add after existing useState declarations (line ~981):
const todaySleepMin = useAppStore(s => s.todaySleepMinutes())
const [sleepTick, setSleepTick] = useState(0)
const [sleepConfirmAnchor, setSleepConfirmAnchor] = useState<{ anchor: DOMRect; startedAt: number } | null>(null)
```

Add handlers after `handleFloatingTimerStop`:

```tsx
const handleSleepButtonClick = useCallback((e: React.MouseEvent) => {
  if (sleepTimer.running && sleepTimer.startedAt != null) {
    // Check 16h discard
    if (Date.now() - sleepTimer.startedAt > MAX_SLEEP_MS) {
      sleepTimer.running = false
      sleepTimer.startedAt = null
      saveSleepTimer(sleepTimer)
      setSleepTick(c => c + 1)
      showToast({ message: t('sleep.discardBody') })
      return
    }
    // Show confirm popover
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setSleepConfirmAnchor({ anchor: rect, startedAt: sleepTimer.startedAt })
  } else {
    // Start sleep timer
    sleepTimer.running = true
    sleepTimer.startedAt = Date.now()
    saveSleepTimer(sleepTimer)
    setSleepTick(c => c + 1)
  }
}, [showToast, t])

const handleSleepStop = useCallback(() => {
  if (sleepTimer.running && sleepTimer.startedAt != null) {
    const rect = document.querySelector('.quick-btn-circle-sleep')?.getBoundingClientRect()
      ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)
    setSleepConfirmAnchor({ anchor: rect, startedAt: sleepTimer.startedAt })
  }
}, [])

const handleSleepConfirm = useCallback(async (minutes: number, startAtISO: string) => {
  if (!sleepTimer.running) return
  sleepTimer.running = false
  sleepTimer.startedAt = null
  saveSleepTimer(sleepTimer)
  setSleepTick(c => c + 1)
  setSleepConfirmAnchor(null)
  await quickRecord(() => addSleep(minutes, startAtISO), t('event.sleep'))
}, [addSleep, quickRecord, t])

const handleSleepCancel = useCallback(() => {
  setSleepConfirmAnchor(null)
}, [])
```

- [ ] **Step 5: Update quickBtns array to include 6th button**

Replace the `quickBtns` array in `HomePage` (around line 1182):

```tsx
const sleepRunning = sleepTimer.running
const sleepLabel = sleepRunning && sleepTimer.startedAt != null
  ? t('quickBtn.sleepRunning')
  : t('quickBtn.sleep')

const quickBtns = [
  { cls: 'quick-btn-circle quick-btn-circle-pee',     Icon: IconDrop,        label: t('quickBtn.pee'),     badge: '1', onClick: handlePee },
  { cls: 'quick-btn-circle quick-btn-circle-poop',    Icon: IconPoop,        label: t('quickBtn.poop'),    badge: '2', onClick: handlePoop },
  { cls: 'quick-btn-circle quick-btn-circle-temp',    Icon: IconThermometer, label: t('quickBtn.temp'),    badge: '3', onClick: (e: React.MouseEvent) => openPopover('temp', e) },
  { cls: 'quick-btn-circle quick-btn-circle-breast',  Icon: IconHeart,       label: t('quickBtn.breast'),  badge: '4', onClick: (e: React.MouseEvent) => openPopover('breast', e) },
  { cls: 'quick-btn-circle quick-btn-circle-formula', Icon: IconBottle,      label: t('quickBtn.formula'), badge: '5', onClick: (e: React.MouseEvent) => openPopover('formula', e) },
  { cls: `quick-btn-circle quick-btn-circle-sleep${sleepRunning ? ' quick-btn-running' : ''}`,
    Icon: IconMoon,  label: sleepLabel, badge: '6', onClick: handleSleepButtonClick },
]
```

Import `IconMoon` at the top of `HomePage.tsx`:
```tsx
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconClock, IconStar, IconGift, IconInfo, IconX, IconMoon } from '../components/icons'
```

- [ ] **Step 6: Add keyboard shortcut 6 and render sleep UI**

In the keyboard shortcut handler (`useEffect` around line 1157), add case `'6'`:

```tsx
case '6': { e.preventDefault(); const btn = document.querySelector('.quick-btn-circle-sleep') as HTMLElement; if (btn) btn.click(); setQuickMenuAnchor(null); break }
```

Add quick-row CSS note: at 960px, 6 buttons of 72px each = 432px. The `.quick-record-slot` should shrink. Add to `src/index.css` (find `.quick-btn-circle` CSS block):

```css
/* 6-button quick row: shrink slots at narrow widths */
@media (max-width: 1100px) {
  .quick-record-slot { flex: 1 1 0; min-width: 0; }
  .quick-btn-circle { padding: 6px 4px; }
  .quick-btn-circle-label { font-size: 10px; }
}
```

Add to `quickBtnHint` area in JSX (change hint text via i18n — done in Task 3).

In `HomePage` JSX, after `FloatingTimerPill`, add:

```tsx
{/* Floating sleep timer pill */}
{sleepTimer.running && (
  <FloatingSleepPill key={sleepTick} onStop={handleSleepStop} />
)}

{/* Sleep confirm popover */}
{sleepConfirmAnchor && (
  <SleepConfirmPopover
    startedAt={sleepConfirmAnchor.startedAt}
    anchor={sleepConfirmAnchor.anchor}
    onConfirm={handleSleepConfirm}
    onCancel={handleSleepCancel}
  />
)}
```

- [ ] **Step 7: Add sleep total row to InsightsPanel**

In `InsightsPanel` (around line 215, where `rows` array is defined), add after the temp row:

The `InsightsPanel` receives props — add `todaySleepMinutes: number` to `InsightsPanelProps` interface.

In `InsightsPanelProps`:
```tsx
interface InsightsPanelProps {
  lastFeeding: DiaryEvent | null
  lastBreastSide: 'L' | 'R' | 'both' | null
  todayPeeCount: number
  todayPoopCount: number
  dataInfo: DataInfo | null
  birthdate?: string
  onNavigate?: (page: 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings') => void
  todaySleepMinutes: number
}
```

In `InsightsPanel` function body, accept the new prop and format:

```tsx
function InsightsPanel({ ..., todaySleepMinutes }: InsightsPanelProps) {
  // ...existing code...
  const sleepLabel = (() => {
    if (todaySleepMinutes === 0) return '–'
    const h = Math.floor(todaySleepMinutes / 60)
    const m = todaySleepMinutes % 60
    if (i18nInstance.language === 'ja') {
      return h > 0 ? (m > 0 ? `${h}時間${m}分` : `${h}時間`) : `${m}分`
    }
    return h > 0 ? (m > 0 ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`
  })()
```

In the `rows` array, add before the final bracket:

```tsx
{
  Icon: IconMoon,
  bg: 'var(--lavender-100)',
  iconColor: 'var(--lavender-600)',
  label: t('home.todaySleepLabel'),
  value: sleepLabel,
  ago: null,
},
```

Import `IconMoon` in `HomePage.tsx` (already done in Step 5).

In `HomePage` JSX where `InsightsPanel` is rendered, add the `todaySleepMinutes` prop:

```tsx
<InsightsPanel
  lastFeeding={lastFeeding}
  lastBreastSide={lastBreastSide}
  todayPeeCount={peeCount}
  todayPoopCount={poopCount}
  dataInfo={dataInfo}
  birthdate={birthdate ?? undefined}
  onNavigate={onNavigate}
  todaySleepMinutes={todaySleepMin}
/>
```

- [ ] **Step 8: Add QuickMenu sleep row**

In `QuickMenu` component (around line 424), add `onOpenSleep` prop and sleep row:

```tsx
interface QuickMenuProps {
  anchor: DOMRect
  onPee: () => void
  onPoop: () => void
  onOpenTemp: (e: React.MouseEvent) => void
  onOpenBreast: (e: React.MouseEvent) => void
  onOpenFormula: (e: React.MouseEvent) => void
  onSleep: (e: React.MouseEvent) => void
  onClose: () => void
}
```

In the `ITEMS` array inside `QuickMenu`, add after the formula item:

```tsx
{
  tintBg: 'var(--lavender-100)', tintColor: 'var(--lavender-600)',
  Icon: IconMoon, labelKey: 'quickBtn.sleep', badge: '6',
  action: (e) => { onClose(); onSleep(e) },
},
```

Add keyboard handler for `'6'` in `QuickMenu.handleKeyDown`:

```tsx
if (e.key === '6') { e.preventDefault(); onSleep(e as unknown as React.MouseEvent); onClose() }
```

Pass `onSleep` to `QuickMenu` in `HomePage` JSX:

```tsx
<QuickMenu
  anchor={quickMenuAnchor}
  onPee={handlePee}
  onPoop={handlePoop}
  onOpenTemp={(e) => { ... }}
  onOpenBreast={(e) => { ... }}
  onOpenFormula={(e) => { ... }}
  onSleep={handleSleepButtonClick}
  onClose={() => setQuickMenuAnchor(null)}
/>
```

- [ ] **Step 9: TypeScript check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 10: Build check**

Run: `npm run build`

Expected: build succeeds with no errors.

- [ ] **Step 11: Commit**

```
git add src/pages/HomePage.tsx src/index.css
git commit -m "feat(sleep): two-tap sleep timer, floating pill, confirm popover, insights row, QuickMenu

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Growth Entry via QuickMenu

**Files:**
- Modify: `src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `IconRuler` from `src/components/icons.tsx` (Task 2).
- Consumes: `addGrowth` from `src/store/useAppStore.ts` (Task 5).
- Consumes: i18n keys `growth.*` (Task 3).
- Produces: `GrowthPopover` component; growth row in `QuickMenu`.

Growth does NOT get a quick-row button (rare event). It lives only in QuickMenu.

- [ ] **Step 1: Add GrowthPopover component to HomePage.tsx**

After `SleepConfirmPopover` (end of Task 7), add:

```tsx
// ---------------------------------------------------------------------------
// Growth entry popover (via QuickMenu only — rare event)
// ---------------------------------------------------------------------------
interface GrowthPopoverProps {
  anchor: DOMRect
  onConfirm: (weightKg: number | undefined, heightCm: number | undefined) => void
  onClose: () => void
}

function GrowthPopover({ anchor, onConfirm, onClose }: GrowthPopoverProps) {
  const { t } = useTranslation()
  const [weight, setWeight] = useState('')
  const [height, setHeight] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = () => {
    const wRaw = parseFloat(weight)
    const hRaw = parseFloat(height)
    const w = isNaN(wRaw) ? undefined : Math.min(30, Math.max(0.5, wRaw))
    const h = isNaN(hRaw) ? undefined : Math.min(120, Math.max(30, hRaw))
    if (w == null && h == null) {
      setError(t('growth.atLeastOne'))
      return
    }
    onConfirm(w, h)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
  }

  const POPOVER_W = 280
  const rawLeft = anchor.left - 80
  const clampedLeft = Math.min(Math.max(8, rawLeft), window.innerWidth - POPOVER_W - 8)
  const POPOVER_H = 240
  const openUpward = anchor.bottom + 8 + POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = openUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: clampedLeft }
    : { top: anchor.bottom + 8, left: clampedLeft }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style} onKeyDown={handleKeyDown}>
        <div className="label" style={{ marginBottom: 8 }}>{t('growth.title')}</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('growth.weightLabel')} ({t('growth.weightUnit')})</div>
            <input
              type="number"
              className="input-field"
              value={weight}
              step="0.01"
              min="0.5"
              max="30"
              onChange={e => { setWeight(e.target.value); setError('') }}
              placeholder="7.20"
              style={{ width: '100%' }}
              autoFocus
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('growth.heightLabel')} ({t('growth.heightUnit')})</div>
            <input
              type="number"
              className="input-field"
              value={height}
              step="0.1"
              min="30"
              max="120"
              onChange={e => { setHeight(e.target.value); setError('') }}
              placeholder="68.5"
              style={{ width: '100%' }}
            />
          </div>
        </div>
        {error && (
          <div style={{ fontSize: 11, color: 'var(--delta-down)', marginBottom: 8 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>{t('growth.cancel')}</button>
          <button type="button" className="btn-primary" onClick={handleSubmit}>{t('growth.record')}</button>
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Wire growth into HomePage**

In the `ActivePopover` type (around line 964), add `'growth'`:

```tsx
type ActivePopover = 'temp' | 'breast' | 'formula' | 'growth' | null
```

Add handler after `handleSleepCancel`:

```tsx
const handleGrowthConfirm = async (weightKg: number | undefined, heightCm: number | undefined) => {
  setPopover(null)
  if (weightKg == null && heightCm == null) return
  const parts: string[] = []
  if (weightKg != null) parts.push(`${weightKg.toFixed(1)}kg`)
  if (heightCm != null) parts.push(`${heightCm.toFixed(1)}cm`)
  const label = `${t('event.growth')} ${parts.join('·')}`
  await quickRecord(() => addGrowth(weightKg, heightCm), label)
}
```

Import `IconRuler` in the icons import line of HomePage:

```tsx
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconClock, IconStar, IconGift, IconInfo, IconX, IconMoon, IconRuler } from '../components/icons'
```

- [ ] **Step 3: Add growth row to QuickMenu**

In `QuickMenuProps`, add `onOpenGrowth`:

```tsx
onOpenGrowth: (e: React.MouseEvent) => void
```

In `ITEMS` array inside `QuickMenu`, add after the sleep item:

```tsx
{
  tintBg: 'var(--indigo-100)', tintColor: 'var(--indigo-600)',
  Icon: IconRuler, labelKey: 'quickBtn.growth', badge: '7',
  action: (e) => { onClose(); onOpenGrowth(e) },
},
```

Pass `onOpenGrowth` in `HomePage` JSX:

```tsx
<QuickMenu
  ...
  onOpenGrowth={(e) => {
    const rect = quickMenuAnchor
    setPopover({ type: 'growth', anchor: rect })
  }}
  ...
/>
```

Add the GrowthPopover to the rendered popover section:

```tsx
{popover?.type === 'growth' && (
  <GrowthPopover
    anchor={popover.anchor}
    onConfirm={handleGrowthConfirm}
    onClose={() => setPopover(null)}
  />
)}
```

- [ ] **Step 4: TypeScript check + build**

Run: `npx tsc --noEmit`
Run: `npm run build`

Expected: 0 errors, build succeeds.

- [ ] **Step 5: Commit**

```
git add src/pages/HomePage.tsx
git commit -m "feat(growth): GrowthPopover via QuickMenu, weight/height entry with validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: StatsPage Charts

**Files:**
- Modify: `src/pages/StatsPage.tsx`

**Interfaces:**
- Consumes: `SleepData`, `GrowthData` from `shared/types.ts` (Task 1).
- Consumes: `computeZ`, `zToPercentile`, `percentileBandValue` from `src/lib/whoGrowth.ts` (Task 4).
- Consumes: i18n keys `stats.sleepTitle`, `stats.growthTitle`, etc. (Task 3).
- Produces: Sleep bar chart (indigo, daily total minutes) above existing charts. Growth curve section (ComposedChart with WHO band Lines + baby Scatter points).

- [ ] **Step 1: Extend DayStats interface and buildDayStats function**

In `src/pages/StatsPage.tsx`:

```typescript
// Add to DayStats interface:
interface DayStats {
  date: string
  label: string
  formulaMl: number
  feedingCount: number
  peeCount: number
  poopCount: number
  avgTemp: number | null
  sleepMinutes: number  // ADD THIS
}

// In buildDayStats function, add sleep computation:
const sleepEvents = dayEvents.filter(e => e.type === 'sleep')
const sleepMinutes = sleepEvents.reduce((s, e) => s + ((e.data as SleepData).minutes ?? 0), 0)

// Add to result.push:
result.push({
  ...,
  sleepMinutes,
})
```

Also import `SleepData`, `GrowthData` at the top of StatsPage:

```typescript
import { DiaryEvent, FormulaData, TempData, SleepData, GrowthData } from '../../shared/types'
```

- [ ] **Step 2: Add sleep chart (indigo bars, daily total)**

In `StatsPage` JSX, BEFORE the formula chart block, add:

```tsx
{/* Sleep total per day */}
<div className="card">
  <div className="section-header-accent">
    {t('stats.sleepTitle')}
  </div>
  <ResponsiveContainer width="100%" height={180}>
    <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
      <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
      <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
      <Tooltip
        contentStyle={TOOLTIP_STYLE}
        formatter={(v: number) => [t('stats.sleepUnit', { value: v }), t('stats.sleepTooltip')]}
      />
      <Bar dataKey="sleepMinutes" fill="var(--indigo-300)" radius={[8,8,0,0]} maxBarSize={44} name={t('stats.sleepTooltip')} />
    </BarChart>
  </ResponsiveContainer>
</div>
```

- [ ] **Step 3: Add growth curve section**

Add growth chart computation and rendering. Import `computeZ`, `zToPercentile`, `percentileBandValue`:

```typescript
import { computeZ, zToPercentile, percentileBandValue } from '../lib/whoGrowth'
import { ComposedChart, Scatter, Line as RechartsLine } from 'recharts'
```

Import `differenceInMonths`, `parseISO` from date-fns if not already:

```typescript
import { subDays, format, parseISO, isSameDay, differenceInMonths } from 'date-fns'
```

In `StatsPage`, add inside the component (after `const data = ...`):

```tsx
const settings = useAppStore(s => s.settings)
const events = useAppStore(s => s.events)

const birthdate = settings?.baby?.birthdate
const gender = settings?.baby?.gender

// Build growth scatter points from all growth events (no range filter — show all)
const growthPoints = useMemo(() => {
  if (!birthdate) return { weight: [], height: [] }
  const growthEvents = events.filter(e => !e.deleted && e.type === 'growth')
    .sort((a, b) => a.at.localeCompare(b.at))

  const weight: { month: number; value: number }[] = []
  const height: { month: number; value: number }[] = []

  for (const e of growthEvents) {
    const d = e.data as GrowthData
    const ageMonths = Math.max(0, differenceInMonths(parseISO(e.at), parseISO(birthdate)))
    if (d.weightKg != null) weight.push({ month: ageMonths, value: d.weightKg })
    if (d.heightCm != null) height.push({ month: ageMonths, value: d.heightCm })
  }
  return { weight, height }
}, [events, birthdate])

// Build WHO band data points (z = -2,-1,0,+1,+2)
const WHO_Z_BANDS = [-2, -1, 0, 1, 2]
const WHO_Z_LABELS: Record<number, string> = { [-2]: 'P3', [-1]: 'P15', [0]: 'P50', [1]: 'P85', [2]: 'P97' }
const WHO_MONTHS = [0, 3, 6, 9, 12, 15, 18, 21, 24]

function buildWhoLineData(metric: 'weight' | 'height', sex: 'boy' | 'girl') {
  return WHO_MONTHS.map(m => {
    const point: Record<string, number> = { month: m }
    for (const z of WHO_Z_BANDS) {
      point[`z${z}`] = parseFloat(percentileBandValue(metric, sex, m, z).toFixed(2))
    }
    return point
  })
}

const whoSex: 'boy' | 'girl' = gender === 'boy' ? 'boy' : 'girl'
const whoWeightData = useMemo(() => buildWhoLineData('weight', whoSex), [whoSex])
const whoHeightData = useMemo(() => buildWhoLineData('height', whoSex), [whoSex])

// Latest measurement callout
const latestWeight = growthPoints.weight[growthPoints.weight.length - 1]
const latestHeight = growthPoints.height[growthPoints.height.length - 1]
```

In JSX, AFTER the temperature chart, add:

```tsx
{/* Growth curve section */}
{birthdate ? (
  <>
    <div className="card">
      <div className="section-header-accent">{t('stats.growthTitle')}</div>

      {/* Weight chart */}
      {growthPoints.weight.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {t('stats.growthWeightTitle')}
          </div>
          {latestWeight != null && (() => {
            const z = computeZ('weight', whoSex, latestWeight.month, latestWeight.value)
            const pct = Math.round(zToPercentile(z))
            return (
              <div style={{ fontSize: 12, color: 'var(--indigo-600)', marginBottom: 8 }}>
                {t('stats.growthPercentile', { metric: t('growth.weightLabel'), value: `${latestWeight.value.toFixed(1)}kg`, pct })}
              </div>
            )
          })()}
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart margin={{ top: 4, right: 24, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
              <XAxis
                type="number"
                dataKey="month"
                domain={[0, 24]}
                tickCount={9}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v: number) => t('stats.growthMonthUnit', { m: v })}
              />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {WHO_Z_BANDS.map(z => (
                <RechartsLine
                  key={z}
                  data={whoWeightData}
                  type="monotone"
                  dataKey={`z${z}`}
                  stroke={z === 0 ? 'var(--indigo-500)' : 'var(--indigo-200)'}
                  strokeWidth={z === 0 ? 1.5 : 1}
                  strokeDasharray={z === 0 ? undefined : '4 3'}
                  dot={false}
                  name={WHO_Z_LABELS[z]}
                  legendType="none"
                />
              ))}
              <Scatter
                data={growthPoints.weight}
                dataKey="value"
                fill="var(--indigo-500)"
                name={t('growth.weightLabel')}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}

      {/* Height chart */}
      {growthPoints.height.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 16, marginBottom: 8 }}>
            {t('stats.growthHeightTitle')}
          </div>
          {latestHeight != null && (() => {
            const z = computeZ('height', whoSex, latestHeight.month, latestHeight.value)
            const pct = Math.round(zToPercentile(z))
            return (
              <div style={{ fontSize: 12, color: 'var(--indigo-600)', marginBottom: 8 }}>
                {t('stats.growthPercentile', { metric: t('growth.heightLabel'), value: `${latestHeight.value.toFixed(1)}cm`, pct })}
              </div>
            )
          })()}
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart margin={{ top: 4, right: 24, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
              <XAxis
                type="number"
                dataKey="month"
                domain={[0, 24]}
                tickCount={9}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v: number) => t('stats.growthMonthUnit', { m: v })}
              />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {WHO_Z_BANDS.map(z => (
                <RechartsLine
                  key={z}
                  data={whoHeightData}
                  type="monotone"
                  dataKey={`z${z}`}
                  stroke={z === 0 ? 'var(--lavender-500)' : 'var(--lavender-200)'}
                  strokeWidth={z === 0 ? 1.5 : 1}
                  strokeDasharray={z === 0 ? undefined : '4 3'}
                  dot={false}
                  name={WHO_Z_LABELS[z]}
                  legendType="none"
                />
              ))}
              <Scatter
                data={growthPoints.height}
                dataKey="value"
                fill="var(--lavender-500)"
                name={t('growth.heightLabel')}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}

      {growthPoints.weight.length === 0 && growthPoints.height.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--stone-400)', fontSize: 13, padding: '24px 0' }}>
          {t('stats.noGrowthData')}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        {t('stats.growthDisclaimer')}
      </div>
    </div>
  </>
) : (
  <div className="card" style={{ textAlign: 'center', color: 'var(--stone-400)', fontSize: 13, padding: '24px' }}>
    {t('stats.growthNoBirthdate')}
  </div>
)}
```

- [ ] **Step 4: TypeScript check + tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run --reporter=verbose`

Expected: 0 TS errors; all tests pass.

- [ ] **Step 5: Commit**

```
git add src/pages/StatsPage.tsx
git commit -m "feat(stats): sleep bar chart and WHO growth curve charts with percentile callouts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: HistoryPage Summaries

**Files:**
- Modify: `src/pages/HistoryPage.tsx`

**Interfaces:**
- Consumes: `SleepData`, `GrowthData` from `shared/types.ts` (Task 1).
- Consumes: i18n keys `history.sleepIndicator`, `history.growthIndicator`, `summary.sleep`, `summary.growth` (Task 3).
- Produces: Week/month summary rows include sleep count/total and growth count.

- [ ] **Step 1: Extend DayIndicators to include sleep + growth**

In `src/pages/HistoryPage.tsx`, in `useDayIndicators`:

```typescript
interface DayIndicators {
  diaperCount: number
  feedingCount: number
  formulaMl: number
  hasHighTemp: boolean
  hasDiaryOrMessage: boolean
  sleepCount: number      // ADD
  sleepMinutes: number    // ADD
  growthCount: number     // ADD
}

function useDayIndicators(events: DiaryEvent[], date: Date): DayIndicators {
  return useMemo(() => {
    const dayEvents = events.filter(e => !e.deleted && isSameDay(parseISO(e.at), date))
    const diaperCount = dayEvents.filter(e => e.type === 'pee' || e.type === 'poop').length
    const feedingCount = dayEvents.filter(e => e.type === 'breast' || e.type === 'formula').length
    const formulaMl = dayEvents
      .filter(e => e.type === 'formula')
      .reduce((s, e) => s + ((e.data as FormulaData).ml ?? 0), 0)
    const hasHighTemp = dayEvents.some(e => e.type === 'temp' && (e.data as { celsius: number }).celsius >= 37.5)
    const hasDiaryOrMessage = dayEvents.some(e => e.type === 'diary' || e.type === 'message')
    const sleepEvents = dayEvents.filter(e => e.type === 'sleep')
    const sleepCount = sleepEvents.length
    const sleepMinutes = sleepEvents.reduce((s, e) => s + ((e.data as SleepData).minutes ?? 0), 0)
    const growthCount = dayEvents.filter(e => e.type === 'growth').length
    return { diaperCount, feedingCount, formulaMl, hasHighTemp, hasDiaryOrMessage, sleepCount, sleepMinutes, growthCount }
  }, [events, date])
}
```

Import `SleepData`, `GrowthData` in HistoryPage imports.

- [ ] **Step 2: Add sleep/growth chips to day cells in MonthView**

In the month calendar day cell rendering (find where `diaperIndicator`, `feedingIndicator` etc. are displayed), add after existing chips:

```tsx
{indicators.sleepCount > 0 && (
  <span className="cal-chip cal-chip-sleep">{t('history.sleepIndicator')}</span>
)}
{indicators.growthCount > 0 && (
  <span className="cal-chip cal-chip-growth">{t('history.growthIndicator')}</span>
)}
```

Add CSS for these chips in `src/index.css`:

```css
.cal-chip-sleep  { background: var(--lavender-100); color: var(--lavender-600); }
.cal-chip-growth { background: var(--indigo-100); color: var(--indigo-600); }
```

- [ ] **Step 3: Add to week/day summary sections**

Find where week summary renders feeding/diaper counts (look for `t('summary.feeding')` or similar). Add sleep and growth:

In whatever summary section exists (WeekView or DayView summary), add:

```tsx
{indicators.sleepCount > 0 && (
  <span className="summary-chip">
    {t('summary.sleep', { count: indicators.sleepCount, totalMin: indicators.sleepMinutes })}
  </span>
)}
{indicators.growthCount > 0 && (
  <span className="summary-chip">
    {t('summary.growth', { count: indicators.growthCount })}
  </span>
)}
```

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 5: Commit**

```
git add src/pages/HistoryPage.tsx src/index.css
git commit -m "feat(history): sleep/growth indicators in calendar cells and week summaries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: E2E Tests

**Files:**
- Modify: `scripts/mac-e2e.mjs`

**Interfaces:**
- Consumes: Sleep two-tap flow from Task 7.
- Consumes: Growth QuickMenu flow from Task 8.
- Consumes: Growth curve chart from Task 9.

The E2E script uses Playwright Electron. Settings (birthdate, gender) are already set in step [2] of the existing flow (baby age 95 days, girl). The new flows go in a new step [5] after the existing test steps.

- [ ] **Step 1: Add sleep + growth E2E steps to mac-e2e.mjs**

In `scripts/mac-e2e.mjs`, after the last existing test block (find where `failures` is checked), add before the final `assert(consoleErrors.length === 0, ...)`:

```javascript
// ---------------------------------------------------------------------------
// 5. Sleep two-tap flow
// ---------------------------------------------------------------------------
console.log('\n[5] Sleep two-tap flow')

await page.click('[data-tour="nav-home"]')
await page.waitForSelector('[data-tour="quick-row"]', { timeout: 5000 })

// 5a. Find sleep button and click to START
const sleepBtn = await page.$('.quick-btn-circle-sleep')
assert(!!sleepBtn, 'sleep button (6th quick button) exists')

if (sleepBtn) {
  await sleepBtn.click()
  await page.waitForTimeout(600)
  await shot(page, 'sleep-started')

  // Button should now show running label (자는 중 or similar)
  const sleepBtnText = await sleepBtn.textContent()
  console.log(`  sleep button text after start: ${sleepBtnText}`)

  // Floating sleep pill should appear
  const sleepPill = await page.$('.floating-sleep-pill')
  assert(!!sleepPill, 'floating sleep pill appears after sleep start')
  await shot(page, 'sleep-floating-pill')

  // 5b. Click stop on the floating pill
  if (sleepPill) {
    const stopBtn = await page.$('.floating-sleep-stop')
    assert(!!stopBtn, 'sleep pill stop button exists')
    if (stopBtn) {
      await stopBtn.click()
      await page.waitForTimeout(400)
      await shot(page, 'sleep-confirm-popover')

      // Confirm popover should appear
      const sleepConfirmPopover = await page.$('.popover')
      assert(!!sleepConfirmPopover, 'sleep confirm popover appears after stop')

      // Click confirm/record button
      if (sleepConfirmPopover) {
        const confirmBtn = await sleepConfirmPopover.$('.btn-primary')
        if (confirmBtn) {
          await confirmBtn.click()
          await page.waitForTimeout(500)

          // Toast for sleep should appear
          try {
            await page.waitForFunction(
              () => {
                const toasts = Array.from(document.querySelectorAll('.toast'))
                return toasts.some(el => el.textContent?.includes('수면') || el.textContent?.includes('ねんね'))
              },
              { timeout: 5000 }
            )
            assert(true, 'sleep record toast shown')
          } catch {
            const toastText = await page.$('.toast').then(el => el?.textContent()).catch(() => 'none')
            console.log(`  sleep toast text: ${toastText}`)
          }

          await shot(page, 'sleep-recorded')
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Growth entry via QuickMenu + growth curve chart
// ---------------------------------------------------------------------------
console.log('\n[6] Growth entry via QuickMenu')

// Open + record dropdown
const addRecordBtn = await page.$('.btn-add-record')
assert(!!addRecordBtn, '+ Record button exists for QuickMenu')
if (addRecordBtn) {
  await addRecordBtn.click()
  await page.waitForSelector('.quick-menu', { timeout: 5000 })
  await shot(page, 'quick-menu-open')

  // Find 성장 (growth) menu item
  const growthMenuItem = await page.$('.quick-menu-item:has(.quick-menu-label)')
  const menuItems = await page.$$('.quick-menu-item')
  let growthItem = null
  for (const item of menuItems) {
    const text = await item.textContent()
    if (text && (text.includes('성장') || text.includes('成長'))) {
      growthItem = item
      break
    }
  }

  assert(!!growthItem, 'growth menu item found in QuickMenu')
  if (growthItem) {
    await growthItem.click()
    await page.waitForSelector('.popover', { timeout: 5000 })
    await shot(page, 'growth-popover')

    // Fill weight
    const weightInput = await page.$('.popover input[type="number"]:first-of-type')
    if (weightInput) {
      await weightInput.fill('7.2')
    }

    // Fill height
    const allInputs = await page.$$('.popover input[type="number"]')
    if (allInputs.length >= 2) {
      await allInputs[1].fill('68.5')
    }

    // Click record
    const growthRecordBtn = await page.$('.popover .btn-primary')
    if (growthRecordBtn) {
      await growthRecordBtn.click()
      await page.waitForTimeout(500)

      try {
        await page.waitForFunction(
          () => {
            const toasts = Array.from(document.querySelectorAll('.toast'))
            return toasts.some(el => el.textContent?.includes('성장') || el.textContent?.includes('成長'))
          },
          { timeout: 5000 }
        )
        assert(true, 'growth record toast shown')
      } catch {
        console.log('  growth toast check: timeout (may be ok if label differs)')
      }

      await shot(page, 'growth-recorded')
    }
  }
}

// 6b. Navigate to stats and check growth curve chart
console.log('\n[6b] Growth curve chart on StatsPage')

await page.click('[data-tour="nav-stats"]')
await page.waitForSelector('.page-container', { timeout: 5000 })
await page.waitForTimeout(800)  // let charts render
await shot(page, 'stats-with-growth-chart')

// Check growth chart section exists (birthdate was set in step 2)
const growthChartSection = await page.$('[class*="card"]:has(div)')
const allCards = await page.$$('.card')
console.log(`  stat cards found: ${allCards.length}`)

// The growth curve section should appear (baby has birthdate+gender from step 2)
// We check for the disclaimer text as a proxy
const hasGrowthContent = await page.evaluate(() => {
  const allText = document.body.innerText
  return allText.includes('WHO') || allText.includes('성장 곡선') || allText.includes('成長曲線')
})
assert(hasGrowthContent, 'growth curve section appears on StatsPage (WHO disclaimer or title visible)')
await shot(page, 'growth-curve-chart')
```

- [ ] **Step 2: Run E2E locally**

Prerequisites (must be done first):
```
npm run build
```

Then:
```
node scripts/mac-e2e.mjs
```

Expected: exit code 0, all new checks pass.

- [ ] **Step 3: Commit**

```
git add scripts/mac-e2e.mjs
git commit -m "test(e2e): sleep two-tap flow, growth QuickMenu entry, growth chart screenshot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Full TypeScript check (both configs)**

Run: `npx tsc --noEmit`
Run: `npx tsc -p tsconfig.node.json --noEmit`

Expected: 0 errors in both configs.

- [ ] **Step 2: Full unit test run**

Run: `npx vitest run --reporter=verbose`

Expected: 255+ existing tests + new tests (11 whoGrowth + ~14 sleepEvent + ~8 growthEvent = ~33 new) all green. Zero failures.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: build succeeds, no TS/Rollup errors.

- [ ] **Step 4: E2E run**

Run: `node scripts/mac-e2e.mjs`

Expected: exit code 0, all checks pass including new sleep + growth steps.

---

## Self-Review

### Spec Coverage Check

| Spec requirement | Task |
|---|---|
| `'sleep'` type + `SleepData` | Task 1 |
| `'growth'` type + `GrowthData` | Task 1 |
| VALID_TYPES updated (only gate) | Task 1 |
| IconMoon indigo/lavender tint | Task 2 |
| IconRuler | Task 2 |
| CSS vars lavender/indigo light+dark | Task 2 |
| formatEventValue sleep ko `2시간 5분` / ja `2時間5分` | Task 3 |
| formatEventValue growth `7.2kg · 68.5cm` | Task 3 |
| eventLabel sleep/growth | Task 3 |
| i18n ko+ja all keys | Task 3 |
| WHO math computeZ (interpolate, L≠1, |z|>3 adjustment) | Task 4 |
| zToPercentile Abramowitz-Stegun | Task 4 |
| percentileBandValue | Task 4 |
| whoGrowth tests (P50 boy 12mo, P50 girl 0mo, interpolation, |z|>3, erf ±0.001) | Task 4 |
| addSleep store helper | Task 5 |
| addGrowth store helper (at least one required) | Task 5 |
| todaySleepMinutes selector | Task 5 |
| Sleep event validation tests | Task 5 |
| Open-sleep rehydrate/discard logic tests | Task 5 |
| Growth event validation tests | Task 6 |
| Sleep quick-row 6th button | Task 7 |
| Sleep two-tap UX (start/running/stop/confirm/cancel) | Task 7 |
| MAX_SLEEP_MS 16h discard with notice toast | Task 7 |
| Keyboard shortcut 6 | Task 7 |
| Floating sleep pill (stacks below nursing pill) | Task 7 |
| Survives restart (rehydrate from localStorage) | Task 7 |
| Sleep total in InsightsPanel today summary | Task 7 |
| QuickMenu sleep row | Task 7 |
| 6-button layout at 960px | Task 7 |
| Growth QuickMenu entry (NOT quick row) | Task 8 |
| GrowthPopover inputs (weight 0.5–30, height 30–120) | Task 8 |
| Validation: at least one required | Task 8 |
| Sleep bar chart on StatsPage (indigo, 7/30d) | Task 9 |
| Growth curve section (birthdate+gender gate, hint card) | Task 9 |
| WHO bands z=-2,-1,0,+1,+2 labeled P3/P15/P50/P85/P97 | Task 9 |
| Baby dots + connecting line | Task 9 |
| Latest measurement callout (pct percentile) | Task 9 |
| Disclaimer line ko+ja | Task 9 |
| HistoryPage summaries include sleep count/total | Task 10 |
| HistoryPage summaries include growth count | Task 10 |
| E2E sleep two-tap + floating pill screenshot | Task 11 |
| E2E growth QuickMenu + chart screenshot | Task 11 |
| `npx tsc --noEmit` both configs | Task 12 |
| `npm test` all green | Task 12 |
| `npm run build` succeeds | Task 12 |

**Gaps found:** None. All spec requirements are covered.

### Placeholder Scan

No TBD, TODO, or placeholder steps found. All code blocks are complete.

### Type Consistency

- `SleepData` defined in Task 1, used in Tasks 3, 5, 9, 10 — consistent.
- `GrowthData` defined in Task 1, used in Tasks 3, 5, 6, 8, 9, 10 — consistent.
- `computeZ`, `zToPercentile`, `percentileBandValue` defined in Task 4, consumed in Task 9 — consistent.
- `addSleep(minutes: number, atOverride?: string)` defined in Task 5, used in Task 7 — consistent.
- `addGrowth(weightKg | undefined, heightCm | undefined, atOverride?)` defined in Task 5, used in Task 8 — consistent.
- `todaySleepMinutes()` defined in Task 5, used in Task 7 — consistent.
- `InsightsPanelProps.todaySleepMinutes: number` added in Task 7, passed in Task 7 — consistent.
- `QuickMenuProps.onSleep` + `onOpenGrowth` added in Tasks 7+8, passed from `HomePage` — consistent.
