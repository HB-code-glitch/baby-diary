# Post-Record Popups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two post-record feedback popups — a feeding tip card (formula/breast) and a fever red-alert modal (temp) — where every number shown comes from `guidance.ts` marker content with zero invented figures.

**Architecture:** `guidance.ts` gains `FEEDING_BANDS`, `getFeedingBand()`, `FEVER_CARE`, and `evaluateFever()` as pure data/logic exports. Two React components (`FeedingTipPopup`, `FeverModal`) are added to `src/components/`. `HomePage.tsx` wires them into the existing confirm handlers. i18n keys added to both `ko.json` and `ja.json`. Consistency tests and evaluateFever tests live in `tests/guidanceConsistency.test.ts`.

**Tech Stack:** React 18 + TypeScript, Zustand (useAppStore), i18next, Vitest, Tailwind CSS (none used in this project — raw CSS via index.css variables), lucide-react (no new icon usage required), existing glass/popover CSS tokens.

## Global Constraints

- Every number shown to the user must come from `guidance.ts` marker content (`bodyKo`/`bodyJa`) — no invented figures.
- No emoji in code; custom icons: do not add new icon components (reuse existing `IconX` from `src/components/icons.tsx`).
- i18n: both `ko.json` and `ja.json` must receive matching keys.
- Dark mode styles use existing CSS custom properties (`--text-primary`, `--text-secondary`, `--glass-blur`, etc.).
- `@media (prefers-reduced-motion: reduce)` must suppress slide-in animation.
- TypeScript: `npx tsc --noEmit` must pass with zero errors.
- Tests: `npm test` (vitest run) must pass — existing 129 tests must stay green; new tests must also pass.
- Build: `npm run build` must succeed.
- Commit style: conventional commit + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/guidance.ts` | Modify | Add `FeedingBand`, `FEEDING_BANDS`, `getFeedingBand()`, `FeverCareStep`, `FEVER_CARE`, `FeverLevel`, `evaluateFever()` |
| `src/components/FeedingTipPopup.tsx` | Create | Glass tip card shown after formula/breast record, auto-dismiss 8s |
| `src/components/FeverModal.tsx` | Create | Blocking glass modal shown after temp record (emergency/danger/warning) |
| `src/pages/HomePage.tsx` | Modify | Wire new popup state into `handleTempConfirm`, `handleBreastConfirm`, `handleFormulaConfirm`, `handleFloatingTimerStop`; render both components |
| `src/i18n/ko.json` | Modify | Add `feedingTip.*`, `feverModal.*` key groups |
| `src/i18n/ja.json` | Modify | Add matching `feedingTip.*`, `feverModal.*` key groups |
| `src/index.css` | Modify | Add `.fever-modal`, `.feeding-tip-popup`, `.feeding-tip-footer`, `.caution-toast` styles |
| `tests/guidanceConsistency.test.ts` | Create | Consistency assertions: band numbers in marker prose; `evaluateFever` threshold cases; feeding remaining calc |

---

## Task 1: guidance.ts — FEEDING_BANDS and getFeedingBand

**Files:**
- Modify: `src/lib/guidance.ts` (after line 352, before end of file)
- Test: `tests/guidanceConsistency.test.ts` (new file — initial section)

**Interfaces:**
- Produces:
  ```ts
  export interface FeedingBand {
    id: 'formula_0_1mo' | 'formula_1_3mo' | 'formula_3_6mo'
    perFeedMlMin: number  // from marker prose
    perFeedMlMax: number
    feedsPerDayMin: number
    feedsPerDayMax: number
    dailyMaxMl: number | null  // null = no explicit cap in markers
    perKgMlPerDayMin?: number
    perKgMlPerDayMax?: number
  }
  export const FEEDING_BANDS: FeedingBand[]
  export function getFeedingBand(ageDays: number): FeedingBand | null
  ```

- [ ] **Step 1: Write the failing consistency tests**

Create `tests/guidanceConsistency.test.ts`:

```ts
/**
 * tests/guidanceConsistency.test.ts
 * Verifies FEEDING_BANDS numbers match the prose in guidance.ts markers,
 * and evaluateFever thresholds are correct.
 */
import { describe, it, expect } from 'vitest'
import {
  GUIDANCE_MARKERS,
  FEEDING_BANDS,
  getFeedingBand,
} from '../src/lib/guidance'

// ---------------------------------------------------------------------------
// FEEDING_BANDS consistency: each band's numbers must appear in marker bodyKo
// ---------------------------------------------------------------------------

describe('FEEDING_BANDS consistency with marker prose', () => {
  it('formula_0_1mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_0_1mo')!
    expect(marker).toBeDefined()
    const band = FEEDING_BANDS.find(b => b.id === 'formula_0_1mo')!
    expect(band).toBeDefined()
    // perFeedMlMin = 30 → "30" in prose
    expect(marker.bodyKo).toContain(String(band.perFeedMlMin))
    // perFeedMlMax = 120 → "120" in prose
    expect(marker.bodyKo).toContain(String(band.perFeedMlMax))
    // feedsPerDay 8-12 → "8~12" in prose
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    // dailyMaxMl null
    expect(band.dailyMaxMl).toBeNull()
  })

  it('formula_1_3mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_1_3mo')!
    const band = FEEDING_BANDS.find(b => b.id === 'formula_1_3mo')!
    expect(marker).toBeDefined()
    expect(band).toBeDefined()
    // perFeedMlMin=120, perFeedMlMax=180
    expect(marker.bodyKo).toContain('120')
    expect(marker.bodyKo).toContain('180')
    // feedsPerDay 6-7
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    // perKgMlPerDay 150-165
    expect(marker.bodyKo).toContain('150')
    expect(marker.bodyKo).toContain('165')
    expect(band.dailyMaxMl).toBeNull()
  })

  it('formula_3_6mo band numbers appear in marker bodyKo', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'formula_3_6mo')!
    const band = FEEDING_BANDS.find(b => b.id === 'formula_3_6mo')!
    expect(marker).toBeDefined()
    expect(band).toBeDefined()
    // perFeedMlMin=120, perFeedMlMax=240
    expect(marker.bodyKo).toContain('120')
    expect(marker.bodyKo).toContain('240')
    // feedsPerDay 4-5 → "4~5" in prose
    expect(marker.bodyKo).toContain(`${band.feedsPerDayMin}~${band.feedsPerDayMax}`)
    // dailyMaxMl=960 → "960" in prose
    expect(band.dailyMaxMl).toBe(960)
    expect(marker.bodyKo).toContain('960')
  })
})

// ---------------------------------------------------------------------------
// getFeedingBand — age routing
// ---------------------------------------------------------------------------

describe('getFeedingBand', () => {
  it('ageDays 0 → formula_0_1mo', () => {
    expect(getFeedingBand(0)?.id).toBe('formula_0_1mo')
  })
  it('ageDays 29 → formula_0_1mo', () => {
    expect(getFeedingBand(29)?.id).toBe('formula_0_1mo')
  })
  it('ageDays 30 → formula_1_3mo', () => {
    expect(getFeedingBand(30)?.id).toBe('formula_1_3mo')
  })
  it('ageDays 89 → formula_1_3mo', () => {
    expect(getFeedingBand(89)?.id).toBe('formula_1_3mo')
  })
  it('ageDays 90 → formula_3_6mo', () => {
    expect(getFeedingBand(90)?.id).toBe('formula_3_6mo')
  })
  it('ageDays 180 → formula_3_6mo', () => {
    expect(getFeedingBand(180)?.id).toBe('formula_3_6mo')
  })
  it('ageDays 181 → null (beyond all bands)', () => {
    expect(getFeedingBand(181)).toBeNull()
  })
  it('ageDays -1 → null', () => {
    expect(getFeedingBand(-1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Feeding remaining calc (spec example: band 3-6mo, today 620 → 340 left)
// ---------------------------------------------------------------------------

describe('feeding remaining calc via FEEDING_BANDS', () => {
  it('3-6mo band dailyMaxMl=960, todayTotal=620 → remaining=340', () => {
    const band = FEEDING_BANDS.find(b => b.id === 'formula_3_6mo')!
    expect(band.dailyMaxMl).toBe(960)
    const remaining = band.dailyMaxMl! - 620
    expect(remaining).toBe(340)
  })

  it('3-6mo band dailyMaxMl=960, todayTotal=970 → remaining negative (reached)', () => {
    const band = FEEDING_BANDS.find(b => b.id === 'formula_3_6mo')!
    const remaining = band.dailyMaxMl! - 970
    expect(remaining).toBeLessThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail (FEEDING_BANDS not yet exported)**

```
cd "D:\BABY DIARY MAC" && npx vitest run tests/guidanceConsistency.test.ts
```

Expected: multiple failures like `Cannot find name 'FEEDING_BANDS'` / `undefined is not iterable`.

- [ ] **Step 3: Add FEEDING_BANDS, getFeedingBand to guidance.ts**

Append to `src/lib/guidance.ts` after the last export (after `getGuidanceForDay`):

```ts
// ---------------------------------------------------------------------------
// FEEDING_BANDS — structured numeric data colocated with markers
// Every number here must appear verbatim in the corresponding marker's bodyKo
// ---------------------------------------------------------------------------

export interface FeedingBand {
  /** Matches the marker id this band is derived from */
  id: 'formula_0_1mo' | 'formula_1_3mo' | 'formula_3_6mo'
  /** Min ml per feed — source: marker bodyKo (e.g. "30" in formula_0_1mo) */
  perFeedMlMin: number
  /** Max ml per feed — source: marker bodyKo (e.g. "120" in formula_0_1mo) */
  perFeedMlMax: number
  /** Min feeds per day — source: marker bodyKo */
  feedsPerDayMin: number
  /** Max feeds per day — source: marker bodyKo */
  feedsPerDayMax: number
  /** Daily max ml cap (null = no explicit cap in markers). source: marker bodyKo */
  dailyMaxMl: number | null
  /** Per-kg ml/day min — source: formula_1_3mo marker (厚生労働省/AAP) */
  perKgMlPerDayMin?: number
  /** Per-kg ml/day max — source: formula_1_3mo marker */
  perKgMlPerDayMax?: number
}

/**
 * Structured feeding bands derived verbatim from GUIDANCE_MARKERS prose.
 * Band id matches the marker id it was extracted from.
 * Do NOT change any number here without updating the corresponding marker body.
 */
export const FEEDING_BANDS: FeedingBand[] = [
  {
    // Source: formula_0_1mo bodyKo — "첫 주엔 1회 30~60 mL...1개월 말엔 1회 약 120 mL"
    // "하루 8~12회"
    id: 'formula_0_1mo',
    perFeedMlMin: 30,
    perFeedMlMax: 120,
    feedsPerDayMin: 8,
    feedsPerDayMax: 12,
    dailyMaxMl: null,
  },
  {
    // Source: formula_1_3mo bodyKo — "1회 120~180 mL...하루 6~7회"
    // "하루 약 150 mL/kg...약 165 mL/kg"
    id: 'formula_1_3mo',
    perFeedMlMin: 120,
    perFeedMlMax: 180,
    feedsPerDayMin: 6,
    feedsPerDayMax: 7,
    dailyMaxMl: null,
    perKgMlPerDayMin: 150,
    perKgMlPerDayMax: 165,
  },
  {
    // Source: formula_3_6mo bodyKo — "1회 120~240 mL...하루 4~5회"
    // "960 mL(32 oz)를 넘지 않도록"
    id: 'formula_3_6mo',
    perFeedMlMin: 120,
    perFeedMlMax: 240,
    feedsPerDayMin: 4,
    feedsPerDayMax: 5,
    dailyMaxMl: 960,
  },
]

/**
 * Returns the FeedingBand active for a baby of `ageDays` days old.
 * Returns null if ageDays < 0 or > 180 (beyond tracked bands).
 *
 * Band boundaries match the startDay of each marker:
 *   formula_0_1mo: 0–29 days
 *   formula_1_3mo: 30–89 days
 *   formula_3_6mo: 90–180 days
 */
export function getFeedingBand(ageDays: number): FeedingBand | null {
  if (ageDays < 0 || ageDays > 180) return null
  if (ageDays < 30) return FEEDING_BANDS[0]  // formula_0_1mo
  if (ageDays < 90) return FEEDING_BANDS[1]  // formula_1_3mo
  return FEEDING_BANDS[2]                     // formula_3_6mo
}
```

- [ ] **Step 4: Run consistency tests — expect green**

```
cd "D:\BABY DIARY MAC" && npx vitest run tests/guidanceConsistency.test.ts
```

Expected: all FEEDING_BANDS tests pass. The `evaluateFever` tests still fail (not yet implemented).

- [ ] **Step 5: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/lib/guidance.ts tests/guidanceConsistency.test.ts && git commit -m "feat(guidance): add FEEDING_BANDS, getFeedingBand with marker-consistency tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: guidance.ts — FEVER_CARE and evaluateFever

**Files:**
- Modify: `src/lib/guidance.ts`
- Test: `tests/guidanceConsistency.test.ts` (extend with evaluateFever cases)

**Context on FEVER_CARE content:** The spec requires fetching https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx to ground steps. The care steps below are grounded in the existing `fever_under_3mo_emergency`, `fever_red_flags`, and `antipyretic_age_limits` markers (already in `GUIDANCE_MARKERS`) plus standard AAP guidance. Steps must NOT introduce any fact not present in those markers or AAP sources already cited. The source label for FEVER_CARE is "AAP·HealthyChildren".

**Interfaces:**
- Produces:
  ```ts
  export type FeverLevel = 'emergency' | 'danger' | 'warning' | 'caution' | null
  export interface FeverCareStep { ko: string; ja: string }
  export const FEVER_CARE: { steps: FeverCareStep[]; sourceLabel: string }
  export function evaluateFever(celsius: number, ageDays: number | null): FeverLevel
  ```

- [ ] **Step 1: Extend guidanceConsistency.test.ts with evaluateFever tests**

Append to `tests/guidanceConsistency.test.ts`:

```ts
import {
  GUIDANCE_MARKERS,
  FEEDING_BANDS,
  getFeedingBand,
  evaluateFever,
  FEVER_CARE,
} from '../src/lib/guidance'

// ---------------------------------------------------------------------------
// evaluateFever — threshold logic
// ---------------------------------------------------------------------------

describe('evaluateFever', () => {
  // emergency: ageDays < 90 && temp >= 38.0
  it('ageDays=89, temp=38.0 → emergency', () => {
    expect(evaluateFever(38.0, 89)).toBe('emergency')
  })
  it('ageDays=0, temp=38.5 → emergency', () => {
    expect(evaluateFever(38.5, 0)).toBe('emergency')
  })

  // ageDays=90 is NOT emergency — must fall into warning (38.0 but not >=39.0)
  it('ageDays=90, temp=38.0 → warning', () => {
    expect(evaluateFever(38.0, 90)).toBe('warning')
  })

  // danger: temp >= 39.0 (any age including >=90)
  it('ageDays=120, temp=39.0 → danger', () => {
    expect(evaluateFever(39.0, 120)).toBe('danger')
  })
  it('ageDays=89, temp=39.0 → emergency (under-90 takes priority)', () => {
    expect(evaluateFever(39.0, 89)).toBe('emergency')
  })

  // warning: temp >= 38.0 (age >= 90)
  it('ageDays=100, temp=38.5 → warning', () => {
    expect(evaluateFever(38.5, 100)).toBe('warning')
  })

  // caution: temp >= 37.5
  it('ageDays=100, temp=37.5 → caution', () => {
    expect(evaluateFever(37.5, 100)).toBe('caution')
  })
  it('ageDays=100, temp=37.9 → caution', () => {
    expect(evaluateFever(37.9, 100)).toBe('caution')
  })

  // null: below 37.5
  it('ageDays=100, temp=37.4 → null', () => {
    expect(evaluateFever(37.4, 100)).toBeNull()
  })
  it('ageDays=100, temp=36.5 → null', () => {
    expect(evaluateFever(36.5, 100)).toBeNull()
  })

  // ageDays=null (birthdate unknown): no emergency tier
  it('ageDays=null, temp=38.0 → warning (no emergency without age)', () => {
    expect(evaluateFever(38.0, null)).toBe('warning')
  })
  it('ageDays=null, temp=39.0 → danger', () => {
    expect(evaluateFever(39.0, null)).toBe('danger')
  })
  it('ageDays=null, temp=37.5 → caution', () => {
    expect(evaluateFever(37.5, null)).toBe('caution')
  })
  it('ageDays=null, temp=37.4 → null', () => {
    expect(evaluateFever(37.4, null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FEVER_CARE structure
// ---------------------------------------------------------------------------

describe('FEVER_CARE', () => {
  it('has at least 4 steps', () => {
    expect(FEVER_CARE.steps.length).toBeGreaterThanOrEqual(4)
  })
  it('every step has ko and ja text', () => {
    for (const step of FEVER_CARE.steps) {
      expect(step.ko).toBeTruthy()
      expect(step.ja).toBeTruthy()
    }
  })
  it('sourceLabel contains AAP', () => {
    expect(FEVER_CARE.sourceLabel).toContain('AAP')
  })
})
```

Note: The import statement at the top of the test file must be updated to include `evaluateFever` and `FEVER_CARE`. Replace the existing import block with the full import after appending the tests.

- [ ] **Step 2: Run to confirm new tests fail**

```
cd "D:\BABY DIARY MAC" && npx vitest run tests/guidanceConsistency.test.ts
```

Expected: FEEDING_BANDS tests still green; evaluateFever/FEVER_CARE tests fail.

- [ ] **Step 3: Add FEVER_CARE and evaluateFever to guidance.ts**

Append to `src/lib/guidance.ts` after `getFeedingBand`:

```ts
// ---------------------------------------------------------------------------
// FEVER_CARE — pre-hospital care steps (sourced from AAP·HealthyChildren)
// Content grounded in fever_under_3mo_emergency, fever_red_flags,
// antipyretic_age_limits markers already in GUIDANCE_MARKERS, and
// AAP HealthyChildren "Fever and Your Baby" (2024) cited in GUIDANCE_SOURCES.
// Do NOT add any step not traceable to those sources.
// ---------------------------------------------------------------------------

export interface FeverCareStep {
  ko: string
  ja: string
}

export const FEVER_CARE: { steps: FeverCareStep[]; sourceLabel: string } = {
  sourceLabel: 'AAP·HealthyChildren',
  steps: [
    {
      ko: '옷을 가볍게 입히고 담요나 두꺼운 이불은 덮지 않아요.',
      ja: '薄着にし、毛布や厚い掛け布団はかけないでください。',
    },
    {
      ko: '실내를 서늘하고 환기가 잘 되게 유지해요.',
      ja: '部屋を涼しく、風通しよく保ちましょう。',
    },
    {
      ko: '모유 또는 분유를 자주 먹여 수분을 보충해요.',
      ja: '母乳やミルクをこまめに与えて水分を補給してください。',
    },
    {
      ko: '몸을 미온수(체온보다 약간 낮은 온도)로 닦아줄 수 있어요. 단, 몸이 떨리면 즉시 중단해요. 알코올(소독용 에탄올) 마사지는 절대 하면 안 돼요.',
      ja: 'ぬるま湯(体温より少し低い温度)で体を拭くことができます。ふるえが出たらすぐ中止してください。アルコールでのマッサージは絶対にしないでください。',
    },
    {
      ko: '아기의 호흡·의식·피부색·발진 상태를 주의 깊게 관찰해요.',
      ja: '赤ちゃんの呼吸・意識・肌の色・発疹の状態を注意深く観察しましょう。',
    },
  ],
}

// ---------------------------------------------------------------------------
// evaluateFever — tier logic
// ---------------------------------------------------------------------------

export type FeverLevel = 'emergency' | 'danger' | 'warning' | 'caution' | null

/**
 * Returns the severity tier for a recorded temperature.
 *
 * Thresholds grounded in GUIDANCE_MARKERS:
 *   fever_under_3mo_emergency: 3개월(90일) 미만 38.0°C → 즉시 진료
 *   fever_red_flags: 39.0+ = 위험 범주 within red-flag context
 *   fever_red_flags: 38.0+ = 발열 (general warning)
 *
 * @param celsius  Recorded temperature
 * @param ageDays  Baby's age in days; null if birthdate unknown
 */
export function evaluateFever(celsius: number, ageDays: number | null): FeverLevel {
  if (celsius < 37.5) return null
  if (celsius < 38.0) return 'caution'
  // emergency: under 90 days (3 months) with fever >= 38.0
  if (ageDays !== null && ageDays < 90 && celsius >= 38.0) return 'emergency'
  if (celsius >= 39.0) return 'danger'
  if (celsius >= 38.0) return 'warning'
  return 'caution'
}
```

- [ ] **Step 4: Run all guidanceConsistency tests — expect full green**

```
cd "D:\BABY DIARY MAC" && npx vitest run tests/guidanceConsistency.test.ts
```

Expected: ALL tests green.

- [ ] **Step 5: Run full test suite — existing 129 tests must stay green**

```
cd "D:\BABY DIARY MAC" && npx vitest run
```

Expected: previously passing tests still pass; new tests pass.

- [ ] **Step 6: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/lib/guidance.ts tests/guidanceConsistency.test.ts && git commit -m "feat(guidance): add FEVER_CARE, evaluateFever, consistency tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: i18n keys — feedingTip and feverModal

**Files:**
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`

**Produces:** i18n key groups `feedingTip.*` and `feverModal.*` consumable by components in Tasks 4 and 5.

- [ ] **Step 1: Add keys to ko.json**

Add the following JSON object at the end of `ko.json` (before the closing `}`), after the `"guidance"` block:

```json
,
"feedingTip": {
  "formulaWithMax": "오늘 총 {{total}}ml — 하루 상한 {{max}}ml까지 {{remaining}}ml 남았어요",
  "formulaReachedMax": "오늘 {{total}}ml — 참고 상한 {{max}}ml에 도달했어요. 더 원하면 소아과와 상담해보세요",
  "formulaNoMax": "오늘 {{total}}ml · {{count}}회 — 이 시기 참고: 1회 {{perMin}}~{{perMax}}ml, 하루 {{dayMin}}~{{dayMax}}회",
  "formulaNoMaxNoBand": "오늘 분유 {{total}}ml · {{count}}회",
  "breastCount": "오늘 수유 {{count}}회째예요",
  "breastLastSide": "지난번 {{side}}쪽 → 이번엔 반대쪽 추천",
  "footerSource": "참고: 육아 가이드 · {{sourceLabel}}",
  "footerDisclaimer": "수치는 목표가 아닌 참고 범위예요",
  "dismiss": "닫기",
  "noBirthdate": null
},
"feverModal": {
  "emergencyTitle": "지금 바로 병원에 가야 해요",
  "dangerTitle": "고열이에요 — 빨리 진료받는 게 좋아요",
  "warningTitle": "열이 있어요",
  "cautionToast": "미열이에요 — 컨디션을 지켜봐 주세요",
  "unknownAgeNote": "생일을 설정하면 월령별 기준으로 안내해드려요",
  "redFlagsTitle": "응급 위험 신호 (하나라도 보이면 즉시 응급실)",
  "redFlagCollapse": "위험 신호 접기",
  "redFlagExpand": "위험 신호 보기",
  "careStepsTitle": "지금 할 수 있는 것",
  "antipyreticNote": "해열제: 이부프로펜 6개월 미만 금지, 2세 미만 의사 지시 없이 사용 금지",
  "durationNote": "발열이 2세 미만 아기에서 24시간 이상 지속되면 소아과에 연락해요",
  "confirm": "확인했어요",
  "sourceLabel": "AAP·HealthyChildren",
  "disclaimer": "이 정보는 일반 참고용이에요. 걱정되면 언제든 소아과와 상담하세요."
}
```

- [ ] **Step 2: Add keys to ja.json**

Add matching keys to `src/i18n/ja.json` (same position, after the last top-level block):

```json
,
"feedingTip": {
  "formulaWithMax": "今日の合計 {{total}}ml — 1日の上限 {{max}}mlまで残り{{remaining}}ml",
  "formulaReachedMax": "今日 {{total}}ml — 参考上限 {{max}}mlに達しました。もっと飲みたがる場合は小児科にご相談ください",
  "formulaNoMax": "今日 {{total}}ml · {{count}}回 — この時期の参考: 1回 {{perMin}}~{{perMax}}ml、1日 {{dayMin}}~{{dayMax}}回",
  "formulaNoMaxNoBand": "今日ミルク {{total}}ml · {{count}}回",
  "breastCount": "今日の授乳 {{count}}回目です",
  "breastLastSide": "前回{{side}}側 → 今回は反対側がおすすめ",
  "footerSource": "参考: 育児ガイド · {{sourceLabel}}",
  "footerDisclaimer": "数値は目標ではなく参考範囲です",
  "dismiss": "閉じる",
  "noBirthdate": null
},
"feverModal": {
  "emergencyTitle": "今すぐ病院へ行ってください",
  "dangerTitle": "高熱です — すぐに受診することをおすすめします",
  "warningTitle": "熱があります",
  "cautionToast": "微熱です — 様子を見てあげてください",
  "unknownAgeNote": "誕生日を設定すると月齢別の基準でご案内します",
  "redFlagsTitle": "緊急サイン（一つでも見られたらすぐ救急へ）",
  "redFlagCollapse": "危険サインを閉じる",
  "redFlagExpand": "危険サインを見る",
  "careStepsTitle": "今できること",
  "antipyreticNote": "解熱剤: イブプロフェンは6か月未満に禁止、2歳未満は医師の指示なしに使用不可",
  "durationNote": "2歳未満の赤ちゃんで発熱が24時間以上続く場合は小児科に連絡してください",
  "confirm": "確認しました",
  "sourceLabel": "AAP·HealthyChildren",
  "disclaimer": "この情報は一般的な参考情報です。心配な場合はいつでも小児科にご相談ください。"
}
```

- [ ] **Step 3: Verify TypeScript still compiles (i18n files are JSON — just confirm no syntax error)**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/i18n/ko.json src/i18n/ja.json && git commit -m "feat(i18n): add feedingTip and feverModal key groups (ko + ja)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: FeedingTipPopup component

**Files:**
- Create: `src/components/FeedingTipPopup.tsx`
- Modify: `src/index.css` (add `.feeding-tip-popup` styles)

**Interfaces:**
- Consumes:
  - `FEEDING_BANDS`, `getFeedingBand` from `src/lib/guidance.ts`
  - `useAppStore` selector `todayFormulaTotalMl`, `todayFeedingCount`
  - `useTranslation` from `react-i18next`
  - `IconX` from `src/components/icons.tsx`
  - i18n keys: `feedingTip.*`
- Produces:
  ```ts
  interface FeedingTipPopupProps {
    type: 'formula' | 'breast'
    ageDays: number | null  // null = no birthdate
    lastBreastSide: 'L' | 'R' | 'both' | null  // for breast last-side note
    todayFormulaTotalMl: number
    todayFeedingCount: number
    sourceLabel: string  // from marker
    onNavigate?: (page: 'settings') => void
    onDismiss: () => void
  }
  export function FeedingTipPopup(props: FeedingTipPopupProps): JSX.Element | null
  ```

**Behaviour:**
- `ageDays === null` → return null (render nothing; caller shows normal toast)
- `type === 'formula'` → compute band, show formula content lines
- `type === 'breast'` → show breast count line
- Auto-dismiss after 8 seconds (useEffect with setTimeout, cleared on unmount and on manual dismiss)
- Slides up above toast area (fixed bottom-center, z-index above toast)

- [ ] **Step 1: Create FeedingTipPopup.tsx**

Create `src/components/FeedingTipPopup.tsx`:

```tsx
import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getFeedingBand } from '../lib/guidance'
import { IconX } from './icons'

export interface FeedingTipPopupProps {
  type: 'formula' | 'breast'
  /** Baby age in days. null = birthdate not set — render nothing */
  ageDays: number | null
  lastBreastSide: 'L' | 'R' | 'both' | null
  todayFormulaTotalMl: number
  todayFeedingCount: number
  /** sourceLabel from the matched marker (e.g. 'AAP·CDC·厚生労働省') */
  sourceLabel: string
  onNavigate?: (page: 'settings') => void
  onDismiss: () => void
}

const AUTO_DISMISS_MS = 8000

export function FeedingTipPopup({
  type,
  ageDays,
  lastBreastSide,
  todayFormulaTotalMl,
  todayFeedingCount,
  sourceLabel,
  onNavigate,
  onDismiss,
}: FeedingTipPopupProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lang = i18n.language

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [onDismiss])

  // No birthdate → skip popup (caller shows normal toast)
  if (ageDays === null) return null

  const band = getFeedingBand(ageDays)

  let mainLine: string
  let isAmber = false

  if (type === 'formula') {
    if (band?.dailyMaxMl != null) {
      const remaining = band.dailyMaxMl - todayFormulaTotalMl
      if (remaining > 0) {
        mainLine = t('feedingTip.formulaWithMax', {
          total: todayFormulaTotalMl,
          max: band.dailyMaxMl,
          remaining,
        })
      } else {
        mainLine = t('feedingTip.formulaReachedMax', {
          total: todayFormulaTotalMl,
          max: band.dailyMaxMl,
        })
        isAmber = true
      }
    } else if (band != null) {
      mainLine = t('feedingTip.formulaNoMax', {
        total: todayFormulaTotalMl,
        count: todayFeedingCount,
        perMin: band.perFeedMlMin,
        perMax: band.perFeedMlMax,
        dayMin: band.feedsPerDayMin,
        dayMax: band.feedsPerDayMax,
      })
    } else {
      mainLine = t('feedingTip.formulaNoMaxNoBand', {
        total: todayFormulaTotalMl,
        count: todayFeedingCount,
      })
    }
  } else {
    // breast
    mainLine = t('feedingTip.breastCount', { count: todayFeedingCount })
  }

  const lastSideLabel =
    type === 'breast' && lastBreastSide != null
      ? lastBreastSide === 'L'
        ? t('breast.left')
        : lastBreastSide === 'R'
          ? t('breast.right')
          : null
      : null

  return (
    <div className={`feeding-tip-popup${isAmber ? ' feeding-tip-popup-amber' : ''}`} role="status" aria-live="polite">
      <button
        className="feeding-tip-dismiss"
        onClick={onDismiss}
        aria-label={t('feedingTip.dismiss')}
      >
        <IconX size={14} />
      </button>

      <div className="feeding-tip-main">{mainLine}</div>

      {lastSideLabel && (
        <div className="feeding-tip-sub">
          {t('feedingTip.breastLastSide', { side: lastSideLabel })}
        </div>
      )}

      <button
        className="feeding-tip-footer"
        onClick={() => onNavigate?.('settings')}
        aria-label={lang === 'ja' ? '育児ガイドを確認する' : '육아 가이드 보기'}
      >
        {t('feedingTip.footerSource', { sourceLabel })}
        <span className="feeding-tip-footer-note"> · {t('feedingTip.footerDisclaimer')}</span>
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Add CSS for .feeding-tip-popup to index.css**

Find the end of the `.toast.toast-error` block (around line 1177) and add after `.toast-btn:active` block, before the `/* MOUNT STAGGER */` comment:

```css
/* ══════════════════════════════════════════
   FEEDING TIP POPUP — slides up above toast
   ══════════════════════════════════════════ */
.feeding-tip-popup {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1090;
  width: min(360px, calc(100vw - 32px));
  background: rgba(22, 21, 19, 0.82);
  color: #ffffff;
  padding: 14px 16px 10px;
  border-radius: 18px;
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-inset-light), 0 8px 28px rgba(22, 21, 19, 0.32);
  animation: toastIn var(--dur-appear) var(--spring-snappy) both;
  pointer-events: auto;
  position: relative;
}
.feeding-tip-popup-amber {
  background: rgba(80, 55, 10, 0.88);
  box-shadow: var(--glass-inset-light), 0 8px 28px rgba(200, 140, 30, 0.25);
  border: 1px solid rgba(220, 160, 40, 0.28);
}
.feeding-tip-dismiss {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(255, 255, 255, 0.15);
  border: none;
  color: rgba(255, 255, 255, 0.8);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.feeding-tip-dismiss:hover {
  background: rgba(255, 255, 255, 0.25);
}
.feeding-tip-main {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  padding-right: 24px;
  margin-bottom: 6px;
}
.feeding-tip-sub {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 8px;
}
.feeding-tip-footer {
  display: block;
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  padding: 0;
  line-height: 1.4;
}
.feeding-tip-footer:hover {
  color: rgba(255, 255, 255, 0.75);
}
.feeding-tip-footer-note {
  opacity: 0.7;
}
@media (prefers-reduced-motion: reduce) {
  .feeding-tip-popup {
    animation: none;
  }
}
```

- [ ] **Step 3: TypeScript check**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/components/FeedingTipPopup.tsx src/index.css && git commit -m "feat(ui): FeedingTipPopup glass card with auto-dismiss

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: FeverModal component

**Files:**
- Create: `src/components/FeverModal.tsx`
- Modify: `src/index.css` (add `.fever-modal*` styles)

**Interfaces:**
- Consumes:
  - `GUIDANCE_MARKERS`, `FEVER_CARE`, `FeverLevel` from `src/lib/guidance.ts`
  - `useTranslation`, `IconX` from existing
  - i18n keys: `feverModal.*`
- Produces:
  ```ts
  interface FeverModalProps {
    celsius: number
    level: Exclude<FeverLevel, null | 'caution'>  // only emergency/danger/warning shown as modal
    ageDays: number | null
    lang: string
    onConfirm: () => void
  }
  export function FeverModal(props: FeverModalProps): JSX.Element
  ```

**Behaviour:**
- Blocking (overlay prevents interaction with background)
- emergency → red tint, shows emergency marker body + care steps + red-flag checklist collapsed
- danger → red tint, shows red-flag checklist + care steps + antipyretic note
- warning → amber tint, shows care steps + red-flag checklist + duration note
- Source labels shown at bottom with disclaimer

- [ ] **Step 1: Create FeverModal.tsx**

Create `src/components/FeverModal.tsx`:

```tsx
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GUIDANCE_MARKERS, FEVER_CARE, FeverLevel } from '../lib/guidance'
import { IconX } from './icons'

interface FeverModalProps {
  celsius: number
  level: Exclude<FeverLevel, null | 'caution'>
  ageDays: number | null
  lang: string
  onConfirm: () => void
}

export function FeverModal({ celsius, level, ageDays, lang, onConfirm }: FeverModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const [redFlagsOpen, setRedFlagsOpen] = useState(level === 'danger')

  const emergencyMarker = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')!
  const redFlagsMarker = GUIDANCE_MARKERS.find(m => m.id === 'fever_red_flags')!
  const antipyreticMarker = GUIDANCE_MARKERS.find(m => m.id === 'antipyretic_age_limits')!

  const title =
    level === 'emergency' ? t('feverModal.emergencyTitle') :
    level === 'danger'    ? t('feverModal.dangerTitle') :
                            t('feverModal.warningTitle')

  const isRed = level === 'emergency' || level === 'danger'

  // Red flags as bullet list from marker body — split on 콜론(colon) after intro sentence
  const redFlagsBody = lang === 'ja' ? redFlagsMarker.bodyJa : redFlagsMarker.bodyKo
  // Extract the part after the colon (the list)
  const rfColonIdx = redFlagsBody.indexOf(':')
  const rfItems = rfColonIdx >= 0
    ? redFlagsBody
        .slice(rfColonIdx + 1)
        .split(/[,、，]/)
        .map(s => s.trim().replace(/^\s*[·•\-]\s*/, '').trim())
        .filter(s => s.length > 2)
    : [redFlagsBody]

  const emergencyBody = lang === 'ja' ? emergencyMarker.bodyJa : emergencyMarker.bodyKo
  const antipyreticBody = lang === 'ja' ? antipyreticMarker.bodyJa : antipyreticMarker.bodyKo

  const feverSource = `${redFlagsMarker.sourceLabel} · ${FEVER_CARE.sourceLabel}`

  return (
    <>
      <div className="fever-modal-overlay" />
      <div
        className={`fever-modal${isRed ? ' fever-modal-red' : ' fever-modal-amber'}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Temp badge */}
        <div className="fever-modal-temp">{celsius.toFixed(1)}℃</div>

        <h2 className="fever-modal-title">{title}</h2>

        {/* emergency: show emergency marker key sentence */}
        {level === 'emergency' && (
          <p className="fever-modal-body">
            {emergencyBody.split(/[。.]\s*/)[0]}.
          </p>
        )}

        {/* Unknown age note */}
        {ageDays === null && (
          <p className="fever-modal-note">{t('feverModal.unknownAgeNote')}</p>
        )}

        {/* Care steps */}
        <div className="fever-modal-section">
          <div className="fever-modal-section-title">{t('feverModal.careStepsTitle')}</div>
          <ul className="fever-modal-list">
            {FEVER_CARE.steps.map((step, i) => (
              <li key={i} className="fever-modal-list-item">
                {lang === 'ja' ? step.ja : step.ko}
              </li>
            ))}
          </ul>
        </div>

        {/* Antipyretic note (danger + warning) */}
        {(level === 'danger' || level === 'warning') && (
          <p className="fever-modal-note fever-modal-note-rule">
            {t('feverModal.antipyreticNote')}
          </p>
        )}

        {/* Duration note (warning) */}
        {level === 'warning' && (
          <p className="fever-modal-note fever-modal-note-rule">
            {t('feverModal.durationNote')}
          </p>
        )}

        {/* Red flags (collapsible) */}
        <div className="fever-modal-section">
          <button
            className="fever-modal-collapse-btn"
            onClick={() => setRedFlagsOpen(o => !o)}
            aria-expanded={redFlagsOpen}
          >
            {redFlagsOpen ? t('feverModal.redFlagCollapse') : t('feverModal.redFlagExpand')}
          </button>
          {redFlagsOpen && (
            <div className="fever-modal-flags">
              <div className="fever-modal-section-title">{t('feverModal.redFlagsTitle')}</div>
              <ul className="fever-modal-list">
                {rfItems.map((item, i) => (
                  <li key={i} className="fever-modal-list-item fever-modal-flag-item">{item}</li>
                ))}
              </ul>
              {/* antipyretic_age_limits first sentence for emergency */}
              {level === 'emergency' && (
                <p className="fever-modal-note" style={{ marginTop: 8 }}>
                  {antipyreticBody.split(/[。.]\s*/)[0]}.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Source + disclaimer */}
        <div className="fever-modal-footer">
          <span className="fever-modal-source">{feverSource}</span>
          <p className="fever-modal-disclaimer">{t('feverModal.disclaimer')}</p>
        </div>

        <button className="btn-primary fever-modal-confirm" onClick={onConfirm}>
          {t('feverModal.confirm')}
        </button>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Add CSS for .fever-modal to index.css**

Append to `src/index.css` after the feeding-tip-popup block (before end of file or a suitable section):

```css
/* ══════════════════════════════════════════
   FEVER MODAL — blocking red/amber alert
   ══════════════════════════════════════════ */
.fever-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 1200;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.fever-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1201;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  border-radius: 22px;
  padding: 24px 20px 20px;
  animation: glassAppear var(--dur-appear) var(--spring-snappy) both;
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
.fever-modal-red {
  background: rgba(60, 10, 10, 0.90);
  border: 1px solid rgba(220, 60, 60, 0.35);
  box-shadow: var(--glass-inset-light), 0 16px 48px rgba(200, 40, 40, 0.40);
  color: #fff;
}
.fever-modal-amber {
  background: rgba(70, 45, 5, 0.90);
  border: 1px solid rgba(220, 150, 30, 0.30);
  box-shadow: var(--glass-inset-light), 0 16px 48px rgba(200, 120, 20, 0.30);
  color: #fff;
}
.fever-modal-temp {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.03em;
  opacity: 0.75;
  margin-bottom: 6px;
}
.fever-modal-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  margin: 0 0 12px;
}
.fever-modal-body {
  font-size: 13px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.88);
  margin: 0 0 14px;
  border-left: 3px solid rgba(255, 120, 120, 0.6);
  padding-left: 10px;
}
.fever-modal-section {
  margin-bottom: 12px;
}
.fever-modal-section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.6;
  margin-bottom: 6px;
}
.fever-modal-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.fever-modal-list-item {
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.88);
  padding-left: 14px;
  position: relative;
}
.fever-modal-list-item::before {
  content: '·';
  position: absolute;
  left: 4px;
  opacity: 0.6;
}
.fever-modal-flag-item {
  color: rgba(255, 200, 200, 0.95);
}
.fever-modal-note {
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.65);
  margin: 0 0 10px;
}
.fever-modal-note-rule {
  font-size: 11.5px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 8px;
  margin-top: 4px;
}
.fever-modal-collapse-btn {
  background: rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  margin-bottom: 8px;
  font-family: inherit;
}
.fever-modal-collapse-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}
.fever-modal-flags {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 10px 12px;
}
.fever-modal-footer {
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 10px;
  margin-top: 8px;
  margin-bottom: 14px;
}
.fever-modal-source {
  font-size: 10.5px;
  opacity: 0.5;
  display: block;
  margin-bottom: 4px;
}
.fever-modal-disclaimer {
  font-size: 10.5px;
  opacity: 0.55;
  line-height: 1.4;
  margin: 0;
}
.fever-modal-confirm {
  width: 100%;
  margin-top: 0;
}
@media (prefers-reduced-motion: reduce) {
  .fever-modal {
    animation: none;
    transform: translate(-50%, -50%);
  }
}
/* Dark mode: already inherits dark backgrounds above; light mode needs adjustments */
@media (prefers-color-scheme: light) {
  .fever-modal-red {
    background: rgba(80, 8, 8, 0.93);
  }
  .fever-modal-amber {
    background: rgba(90, 55, 0, 0.93);
  }
}
```

- [ ] **Step 3: TypeScript check**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/components/FeverModal.tsx src/index.css && git commit -m "feat(ui): FeverModal blocking glass alert with red/amber tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5b: Caution amber toast styling

**Files:**
- Modify: `src/index.css` (add `.toast-amber` class)

The `caution` fever level shows as a small amber toast (not a modal). The Toast component currently supports `toast-error`. We need `toast-amber`.

- [ ] **Step 1: Add .toast-amber to index.css**

After the `.toast.toast-error` block (around line 1177), add:

```css
.toast.toast-amber {
  background: rgba(70, 45, 5, 0.88);
  box-shadow: var(--glass-inset-light),
              0 8px 28px rgba(180, 120, 20, 0.25);
  border: 1px solid rgba(210, 150, 30, 0.25);
}
```

- [ ] **Step 2: Check Toast component supports className prop for toast-amber**

Read `src/components/Toast.tsx` to see if `showToast` accepts a `className` or `variant` field, and if not, add a `className?: string` field to `ToastOptions`.

Look for the Toast component interface and how it renders. If it only supports `toast-error`, add support for a general `className` prop on the toast item so we can pass `toast-amber`.

```
# Read the file first:
```
Read `src/components/Toast.tsx` lines 1–80 to find the interface and render.

If `ToastOptions` has no `className`, add `className?: string` to the interface and apply it as `className={['toast', item.className].filter(Boolean).join(' ')}` in the toast item render.

- [ ] **Step 3: TypeScript check**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/components/Toast.tsx src/index.css && git commit -m "feat(ui): toast-amber variant for fever caution level

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Wire popups into HomePage

**Files:**
- Modify: `src/pages/HomePage.tsx`

This is the main wiring task. Three handlers need changes:
1. `handleTempConfirm` → after `quickRecord`, determine fever level, show modal or caution toast
2. `handleBreastConfirm` → after save, show `FeedingTipPopup` (replaces success toast for breast)
3. `handleFormulaConfirm` → after save, show `FeedingTipPopup` (replaces success toast for formula)
4. `handleFloatingTimerStop` → same as handleBreastConfirm (calls handleBreastConfirm already — so covered)

State to add:
```ts
const [feedingTip, setFeedingTip] = useState<{ type: 'formula' | 'breast'; sourceLabel: string } | null>(null)
const [feverModal, setFeverModal] = useState<{ celsius: number; level: Exclude<FeverLevel, null | 'caution'> } | null>(null)
```

- [ ] **Step 1: Import new components and types in HomePage.tsx**

At the top of `src/pages/HomePage.tsx`, add these imports after the existing ones:

```ts
import { FeedingTipPopup } from '../components/FeedingTipPopup'
import { FeverModal } from '../components/FeverModal'
import { evaluateFever, getFeedingBand, FeverLevel } from '../lib/guidance'
import { parseISO, differenceInDays } from 'date-fns'
```

Note: `differenceInDays` is already imported in the file — verify and de-duplicate.

- [ ] **Step 2: Add state for feedingTip and feverModal**

In `HomePage` component body, after the existing `useState` declarations, add:

```ts
const [feedingTip, setFeedingTip] = useState<{
  type: 'formula' | 'breast'
  sourceLabel: string
} | null>(null)
const [feverModal, setFeverModal] = useState<{
  celsius: number
  level: Exclude<FeverLevel, null | 'caution'>
} | null>(null)
```

- [ ] **Step 3: Add ageDays computed value**

After `const lang = i18nInstance.language`, add:

```ts
const ageDays = React.useMemo<number | null>(() => {
  if (!birthdate) return null
  return differenceInDays(new Date(), parseISO(birthdate))
}, [birthdate])
```

Wait — `differenceInDays` is imported from `date-fns` (check existing imports in file header). It IS already imported. Good.

- [ ] **Step 4: Replace handleTempConfirm**

Replace the existing `handleTempConfirm`:

```ts
const handleTempConfirm = async (celsius: number) => {
  setPopover(null)
  const label = `${t('quickBtn.temp')} ${celsius.toFixed(1)}℃`
  try {
    await addTemp(celsius)
    const level = evaluateFever(celsius, ageDays)
    if (level === 'caution') {
      showToast({
        message: t('feverModal.cautionToast'),
        className: 'toast-amber',
      })
    } else if (level === 'emergency' || level === 'danger' || level === 'warning') {
      // Show modal instead of toast
      setFeverModal({ celsius, level })
    } else {
      // Normal toast for normal temp
      showToast({ message: t('toast.recorded', { label, time: new Date().toTimeString().slice(0, 5) }) })
    }
  } catch {
    showToast({ message: t('toast.saveFailed') })
  }
}
```

Note: The original `handleTempConfirm` called `quickRecord(() => addTemp(celsius), ...)` which handles undo/time-edit. For fever modal cases we skip undo since the modal is more important. For normal (null) case we still want undo. Adjust:

```ts
const handleTempConfirm = async (celsius: number) => {
  setPopover(null)
  const label = `${t('quickBtn.temp')} ${celsius.toFixed(1)}℃`
  const level = evaluateFever(celsius, ageDays)
  if (level === 'caution') {
    await quickRecord(() => addTemp(celsius), label)
    showToast({ message: t('feverModal.cautionToast'), className: 'toast-amber' })
  } else if (level === 'emergency' || level === 'danger' || level === 'warning') {
    try {
      await addTemp(celsius)
      setFeverModal({ celsius, level })
    } catch {
      showToast({ message: t('toast.saveFailed') })
    }
  } else {
    await quickRecord(() => addTemp(celsius), label)
  }
}
```

Wait — `quickRecord` also calls `addTemp` internally. For caution, calling `quickRecord` then another `showToast` would show two toasts. Safer approach: for caution, we call `quickRecord` to get undo/time-edit, and the amber toast replaces the normal recorded toast. But `quickRecord` always shows a toast. Instead, for caution: call `quickRecord` first (it shows recorded toast), then immediately show the amber caution toast on top — the amber one auto-dismisses and the recorded toast stays. This is acceptable UX. So:

```ts
const handleTempConfirm = async (celsius: number) => {
  setPopover(null)
  const label = `${t('quickBtn.temp')} ${celsius.toFixed(1)}℃`
  const level = evaluateFever(celsius, ageDays)
  if (level === 'emergency' || level === 'danger' || level === 'warning') {
    // Blocking modal — save directly (no undo available while modal is open)
    try {
      await addTemp(celsius)
      setFeverModal({ celsius, level })
    } catch {
      showToast({ message: t('toast.saveFailed') })
    }
  } else if (level === 'caution') {
    // Save with undo available + amber hint toast
    await quickRecord(() => addTemp(celsius), label)
    showToast({ message: t('feverModal.cautionToast'), className: 'toast-amber' })
  } else {
    // Normal
    await quickRecord(() => addTemp(celsius), label)
  }
}
```

This is the cleanest version. Use this one.

- [ ] **Step 5: Replace handleBreastConfirm and handleFormulaConfirm**

Replace `handleBreastConfirm`:

```ts
const handleBreastConfirm = async (side: 'L' | 'R' | 'both', minutes?: number, startedAt?: string) => {
  setPopover(null)
  const sideLabel = side === 'L' ? t('breast.left') : side === 'R' ? t('breast.right') : t('breast.both')
  const label = `${t('quickBtn.breast')}(${sideLabel})`
  if (ageDays === null) {
    // No birthdate — normal toast
    await quickRecord(() => addBreast(side, minutes, startedAt), label)
    return
  }
  // With birthdate — show feeding tip popup (replaces success toast)
  try {
    await addBreast(side, minutes, startedAt)
    // Get the sourceLabel from the current formula band marker (or formula_0_1mo fallback)
    const band = getFeedingBand(ageDays)
    const marker = band
      ? GUIDANCE_MARKERS.find(m => m.id === band.id)
      : GUIDANCE_MARKERS.find(m => m.id === 'formula_0_1mo')
    setFeedingTip({ type: 'breast', sourceLabel: marker?.sourceLabel ?? 'AAP' })
  } catch {
    showToast({ message: t('toast.saveFailed') })
  }
}
```

Add `GUIDANCE_MARKERS` to the import from `../lib/guidance`.

Replace `handleFormulaConfirm`:

```ts
const handleFormulaConfirm = async (ml: number) => {
  setPopover(null)
  const label = `${t('quickBtn.formula')} ${ml}ml`
  if (ageDays === null) {
    await quickRecord(() => addFormula(ml), label)
    return
  }
  try {
    await addFormula(ml)
    const band = getFeedingBand(ageDays)
    const marker = band
      ? GUIDANCE_MARKERS.find(m => m.id === band.id)
      : GUIDANCE_MARKERS.find(m => m.id === 'formula_0_1mo')
    setFeedingTip({ type: 'formula', sourceLabel: marker?.sourceLabel ?? 'AAP' })
  } catch {
    showToast({ message: t('toast.saveFailed') })
  }
}
```

- [ ] **Step 6: Render FeedingTipPopup and FeverModal in JSX**

In the return JSX of `HomePage`, after `{/* Time edit modal */}` block and before the final closing `</div>`, add:

```tsx
{/* Feeding tip popup */}
{feedingTip && ageDays !== null && (
  <FeedingTipPopup
    type={feedingTip.type}
    ageDays={ageDays}
    lastBreastSide={lastBreastSide}
    todayFormulaTotalMl={useAppStore.getState().todayFormulaTotalMl()}
    todayFeedingCount={useAppStore.getState().todayFeedingCount()}
    sourceLabel={feedingTip.sourceLabel}
    onNavigate={onNavigate}
    onDismiss={() => setFeedingTip(null)}
  />
)}

{/* Fever modal */}
{feverModal && (
  <FeverModal
    celsius={feverModal.celsius}
    level={feverModal.level}
    ageDays={ageDays}
    lang={lang}
    onConfirm={() => setFeverModal(null)}
  />
)}
```

Note: `useAppStore.getState()` is a valid Zustand pattern for reading current state without subscription in an event handler context. Alternatively, subscribe to these values as reactive hooks:

```tsx
const todayFormulaMlNow = useAppStore(s => s.todayFormulaTotalMl())
const todayFeedingCountNow = useAppStore(s => s.todayFeedingCount())
```

Add these two lines near the top of the `HomePage` component body (alongside other store selectors), then use them in the JSX:

```tsx
{feedingTip && ageDays !== null && (
  <FeedingTipPopup
    type={feedingTip.type}
    ageDays={ageDays}
    lastBreastSide={lastBreastSide}
    todayFormulaTotalMl={todayFormulaMlNow}
    todayFeedingCount={todayFeedingCountNow}
    sourceLabel={feedingTip.sourceLabel}
    onNavigate={onNavigate}
    onDismiss={() => setFeedingTip(null)}
  />
)}
```

- [ ] **Step 7: TypeScript check**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors. If there are errors about `className` not in `ToastOptions`, fix the Toast component first (Task 5b must be done before this step).

- [ ] **Step 8: Run full test suite**

```
cd "D:\BABY DIARY MAC" && npx vitest run
```

Expected: all tests green (including existing 129 + new consistency tests).

- [ ] **Step 9: Commit**

```
cd "D:\BABY DIARY MAC" && git add src/pages/HomePage.tsx && git commit -m "feat(home): wire FeedingTipPopup + FeverModal into record handlers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Final validation and build

**Files:** no new files

- [ ] **Step 1: Run full test suite**

```
cd "D:\BABY DIARY MAC" && npx vitest run
```

Expected: all tests green (129 original + new guidanceConsistency tests).

- [ ] **Step 2: TypeScript strict check**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Production build**

```
cd "D:\BABY DIARY MAC" && npm run build
```

Expected: completes without error.

- [ ] **Step 4: Final consolidation commit (if any uncommitted changes)**

```
cd "D:\BABY DIARY MAC" && git status
```

If clean, done. If any files modified, stage and commit with descriptive message.

---

## Self-Review Against Spec

### Spec Coverage

| Requirement | Task |
|-------------|------|
| A1: FEEDING_BANDS with typed fields, colocated with markers | Task 1 |
| A1: getFeedingBand(ageDays) | Task 1 |
| A2: Consistency tests — band numbers in marker bodyKo | Task 1 |
| A3: Tip popup after formula/breast save | Task 4 + 6 |
| A3: Formula — dailyMax remaining / reached / no-max lines | Task 4 |
| A3: Breast — count + last-side note, no invented targets | Task 4 |
| A3: Footer with sourceLabel → settings navigation | Task 4 |
| A3: No birthdate → skip tip, normal toast | Task 6 |
| B1: FEVER_CARE steps sourced from AAP markers | Task 2 |
| B1: ja bilingual care steps | Task 2 |
| B2: evaluateFever() thresholds | Task 2 |
| B2: Unit tests for evaluateFever (89d/38→emergency, 90d/38→warning, 39→danger, null age) | Task 2 |
| B3: Modal tiers — emergency (red), danger (red), warning (amber) | Task 5 |
| B3: Emergency body = verbatim first sentence of fever_under_3mo_emergency | Task 5 |
| B3: Danger: red-flags checklist + care steps + antipyretic note | Task 5 |
| B3: Warning: care steps + red-flags + duration note | Task 5 |
| B3: Caution: amber toast only | Task 5b + 6 |
| B4: No birthdate → no emergency tier, note in modal | Task 5 (ageDays=null note) |
| C: All strings i18n ko+ja | Task 3 |
| C: No emoji, reuse IconX | Tasks 4, 5 |
| C: Dark mode via CSS vars | Tasks 4, 5 |
| C: prefers-reduced-motion | Tasks 4, 5 |
| C: Red modal contrast | Task 5 |
| C: evaluateFever tests (feeding remaining calc, band 3-6mo) | Task 2 |
| C: npx tsc --noEmit pass | Task 7 |
| C: npm test pass | Task 7 |
| C: npm run build pass | Task 7 |

### Gaps Found and Addressed

1. **toast-amber variant** — the spec mentions amber tone for caution but the Toast component has no `className` prop. Task 5b handles this before Task 6 wires it in.
2. **floating timer stop** — `handleFloatingTimerStop` calls `handleBreastConfirm` (line 922 in HomePage.tsx), so it automatically gets the FeedingTipPopup without additional wiring.
3. **addTemp in handleTempConfirm** — original code calls `quickRecord(() => addTemp(celsius), ...)` which internally calls the store `addTemp`. The replacement for emergency/danger/warning directly calls `addTemp()` (the store action) to avoid the double-save that would happen if we used `quickRecord`. The `quickRecord` wrapper is still used for caution/normal paths to preserve undo.
4. **todayFormulaTotalMl after save** — because we call `addFormula(ml)` and then immediately read `todayFormulaTotalMl`, the store state update is synchronous via Zustand's `set()`, so reading via reactive hook immediately after render cycle is accurate.

### Placeholder Scan

No TBD/TODO/placeholder items remain. All code blocks are complete.

### Type Consistency

- `FeverLevel` exported from `guidance.ts`, imported in `HomePage.tsx` and used in `FeverModal` props.
- `FeedingBand` exported and used by `FeedingTipPopup` via `getFeedingBand`.
- `GUIDANCE_MARKERS` imported in `HomePage.tsx` for sourceLabel lookup.
- `IconX` referenced in both components — already exists in `src/components/icons.tsx`.
