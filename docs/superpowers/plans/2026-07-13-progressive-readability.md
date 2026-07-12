# Progressive Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every existing recording, editing, export, sync, and navigation capability while showing only contextually useful information first and progressively revealing secondary detail.

**Architecture:** Put visibility decisions in a small pure module so Home, Stats, and Settings render from deterministic rules instead of scattered JSX conditions. Keep the existing React/Electron structure, add one native-details disclosure primitive, and use CSS-only responsive/motion polish without a new animation dependency.

**Tech Stack:** Electron 31, React 18, TypeScript, Vite, Vitest, vanilla CSS, Recharts, react-i18next.

## Global Constraints

- Do not change event persistence, sync, backup, PDF/export, timer, keyboard shortcut, or navigation behavior.
- Do not remove any action; secondary content must remain reachable with one explicit disclosure action.
- Home initially shows at most 3 relevant insight rows; Stats initially shows at most 2 available chart sections.
- A metric or chart appears only after its corresponding data exists in the selected period.
- Korean and Japanese keys must stay structurally identical.
- Use only existing dependencies; do not add a motion or component library.
- Animate only `transform` and `opacity` for entrance motion and preserve `prefers-reduced-motion` behavior.
- Shared renderer behavior must be identical on macOS and Windows; CSS must include solid fallbacks for translucent surfaces.
- Preserve the user-owned untracked plan `docs/superpowers/plans/2026-07-12-pdf-report-backup-retention.md` outside this worktree.

---

### Task 1: Deterministic progressive-visibility rules

**Files:**
- Create: `src/lib/progressiveDisclosure.ts`
- Create: `tests/progressiveDisclosure.test.ts`

**Interfaces:**
- Produces: `getVisibleHomeMetrics(input): HomeMetricKey[]`
- Produces: `partitionHomeInsights(input): { primary: HomeInsightKey[]; secondary: HomeInsightKey[] }`
- Produces: `getStatsVisibility(days): StatsVisibility`
- Produces: `partitionStatsSections(visibility): { primary: StatsSectionKey[]; secondary: StatsSectionKey[] }`
- Produces: `shouldOpenSyncDisclosure(status): boolean`

- [ ] **Step 1: Write failing tests for empty and partial Home data**

```ts
import { describe, expect, it } from 'vitest'
import {
  getVisibleHomeMetrics,
  partitionHomeInsights,
} from '../src/lib/progressiveDisclosure'

describe('progressive Home disclosure', () => {
  it('shows no metric placeholders when every current value is empty', () => {
    expect(getVisibleHomeMetrics({ formulaMl: 0, peeCount: 0, poopCount: 0, feedingCount: 0, hasTemperature: false })).toEqual([])
  })

  it('shows only metrics backed by current data', () => {
    expect(getVisibleHomeMetrics({ formulaMl: 120, peeCount: 2, poopCount: 0, feedingCount: 1, hasTemperature: false }))
      .toEqual(['formula', 'pee', 'feeding'])
  })

  it('keeps three priority insights and moves the rest behind disclosure', () => {
    expect(partitionHomeInsights({ hasLastFeeding: true, hasNextSide: true, hasDiaper: true, hasTemperature: true, hasSleep: true }))
      .toEqual({ primary: ['lastFeeding', 'diaper', 'temperature'], secondary: ['sleep', 'nextSide'] })
  })
})
```

- [ ] **Step 2: Run the Home tests and verify RED**

Run: `npx vitest run tests/progressiveDisclosure.test.ts`

Expected: FAIL because `src/lib/progressiveDisclosure.ts` does not exist.

- [ ] **Step 3: Add failing tests for Stats and sync disclosure**

```ts
it('enables only chart sections with data', () => {
  const visibility = getStatsVisibility([
    { sleepMinutes: 0, formulaMl: 0, feedingCount: 0, peeCount: 1, poopCount: 0, avgTemp: null },
    { sleepMinutes: 30, formulaMl: 0, feedingCount: 1, peeCount: 0, poopCount: 0, avgTemp: 37.2 },
  ])
  expect(visibility).toEqual({ sleep: true, formula: false, feeding: true, diaper: true, temperature: true })
  expect(partitionStatsSections(visibility)).toEqual({ primary: ['sleep', 'feeding'], secondary: ['diaper', 'temperature'] })
})

it('opens sync details only when attention is required', () => {
  expect(shouldOpenSyncDisclosure('online')).toBe(false)
  expect(shouldOpenSyncDisclosure('connecting')).toBe(false)
  expect(shouldOpenSyncDisclosure('signed-out')).toBe(true)
  expect(shouldOpenSyncDisclosure('error')).toBe(true)
})
```

- [ ] **Step 4: Run the expanded tests and verify RED**

Run: `npx vitest run tests/progressiveDisclosure.test.ts`

Expected: FAIL because the requested exports are missing.

- [ ] **Step 5: Implement the minimal pure rule module**

```ts
export const HOME_PRIMARY_INSIGHT_LIMIT = 3
export const STATS_PRIMARY_SECTION_LIMIT = 2

export type HomeMetricKey = 'formula' | 'pee' | 'poop' | 'feeding' | 'temperature'
export type HomeInsightKey = 'lastFeeding' | 'diaper' | 'temperature' | 'sleep' | 'nextSide'
export type StatsSectionKey = 'sleep' | 'formula' | 'feeding' | 'diaper' | 'temperature'

export interface StatsVisibility {
  sleep: boolean
  formula: boolean
  feeding: boolean
  diaper: boolean
  temperature: boolean
}

export function getVisibleHomeMetrics(input: {
  formulaMl: number
  peeCount: number
  poopCount: number
  feedingCount: number
  hasTemperature: boolean
}): HomeMetricKey[] {
  return [
    input.formulaMl > 0 && 'formula',
    input.peeCount > 0 && 'pee',
    input.poopCount > 0 && 'poop',
    input.feedingCount > 0 && 'feeding',
    input.hasTemperature && 'temperature',
  ].filter((key): key is HomeMetricKey => Boolean(key))
}

export function partitionHomeInsights(input: {
  hasLastFeeding: boolean
  hasNextSide: boolean
  hasDiaper: boolean
  hasTemperature: boolean
  hasSleep: boolean
}): { primary: HomeInsightKey[]; secondary: HomeInsightKey[] } {
  const ordered: HomeInsightKey[] = [
    input.hasLastFeeding && 'lastFeeding',
    input.hasDiaper && 'diaper',
    input.hasTemperature && 'temperature',
    input.hasSleep && 'sleep',
    input.hasNextSide && 'nextSide',
  ].filter((key): key is HomeInsightKey => Boolean(key))
  return {
    primary: ordered.slice(0, HOME_PRIMARY_INSIGHT_LIMIT),
    secondary: ordered.slice(HOME_PRIMARY_INSIGHT_LIMIT),
  }
}

export function getStatsVisibility(days: Array<{
  sleepMinutes: number
  formulaMl: number
  feedingCount: number
  peeCount: number
  poopCount: number
  avgTemp: number | null
}>): StatsVisibility {
  return {
    sleep: days.some(day => day.sleepMinutes > 0),
    formula: days.some(day => day.formulaMl > 0),
    feeding: days.some(day => day.feedingCount > 0),
    diaper: days.some(day => day.peeCount > 0 || day.poopCount > 0),
    temperature: days.some(day => day.avgTemp != null),
  }
}

export function partitionStatsSections(visibility: StatsVisibility): {
  primary: StatsSectionKey[]
  secondary: StatsSectionKey[]
} {
  const ordered: StatsSectionKey[] = (['sleep', 'formula', 'feeding', 'diaper', 'temperature'] as const)
    .filter(key => visibility[key])
  return {
    primary: ordered.slice(0, STATS_PRIMARY_SECTION_LIMIT),
    secondary: ordered.slice(STATS_PRIMARY_SECTION_LIMIT),
  }
}

export function shouldOpenSyncDisclosure(
  status: 'off' | 'no-config' | 'signed-out' | 'connecting' | 'online' | 'error',
): boolean {
  return status === 'no-config' || status === 'signed-out' || status === 'error'
}
```

- [ ] **Step 6: Verify GREEN and the full suite**

Run: `npx vitest run tests/progressiveDisclosure.test.ts && npm run check`

Expected: focused tests pass; all existing tests and typecheck pass.

- [ ] **Step 7: Commit Task 1**

```powershell
git add src/lib/progressiveDisclosure.ts tests/progressiveDisclosure.test.ts
git commit -m "feat: add progressive display rules"
```

---

### Task 2: Context-aware Home dashboard

**Files:**
- Modify: `src/pages/HomePage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Modify: `src/index.css`
- Test: `tests/progressiveDisclosure.test.ts`

**Interfaces:**
- Consumes Task 1 Home selectors.
- Preserves all six inline quick actions, the seven-item `+ 기록` menu, keyboard shortcuts, popovers, timers, and timeline editing.

- [ ] **Step 1: Add failing translation and priority-regression tests**

Add assertions that both locale files contain identical `home.summaryEmptyTitle`, `home.summaryEmptyBody`, `home.moreSummary`, `home.lessSummary`, and `home.dailyTip` keys. Add a test proving `nextSide` never enters the first three when last-feeding, diaper, and temperature are available.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/progressiveDisclosure.test.ts`

Expected: FAIL because the new translation keys are absent.

- [ ] **Step 3: Make StatCards data-backed**

Use `getVisibleHomeMetrics()` to build cards from a keyed descriptor map. Render no `0` or dash placeholder cards. When the selector returns an empty array, render one compact `.progressive-empty` block with `summaryEmptyTitle` and `summaryEmptyBody`. Keep yesterday delta logic unchanged for visible cards.

```tsx
const visibleMetrics = getVisibleHomeMetrics({
  formulaMl,
  peeCount,
  poopCount,
  feedingCount: feedCount,
  hasTemperature: lastTemp != null,
})

if (visibleMetrics.length === 0) {
  return (
    <div className="progressive-empty" data-testid="home-summary-empty">
      <div className="progressive-empty-title">{t('home.summaryEmptyTitle')}</div>
      <div className="progressive-empty-body">{t('home.summaryEmptyBody')}</div>
    </div>
  )
}

return (
  <div className={`stat-card-grid stat-card-grid-count-${Math.min(visibleMetrics.length, 5)}`}>
    {visibleMetrics.map(key => metricCards[key])}
  </div>
)
```

- [ ] **Step 4: Make InsightsPanel progressively disclosed**

Use `partitionHomeInsights()` and local `showAllInsights` state. Render the breastfeeding countdown first when present, then the three primary relevant rows. Render secondary rows only after a button using `moreSummary` is activated; the same button changes to `lessSummary`. Show `dailyTip` as a collapsed native `<details>` only when formula guidance exists. Render the backup card only when no backup exists or sync status is `error`.

```tsx
const [showAllInsights, setShowAllInsights] = useState(false)
const insightPartition = partitionHomeInsights({
  hasLastFeeding: lastFeeding != null,
  hasNextSide: lastBreastSide === 'L' || lastBreastSide === 'R',
  hasDiaper: todayPeeCount > 0 || todayPoopCount > 0,
  hasTemperature: recentTemp != null,
  hasSleep: todaySleepMinutes > 0,
})
const visibleInsightKeys = showAllInsights
  ? [...insightPartition.primary, ...insightPartition.secondary]
  : insightPartition.primary

{visibleInsightKeys.map(key => renderInsightRow(key))}
{insightPartition.secondary.length > 0 && (
  <button className="progressive-more-button" type="button" onClick={() => setShowAllInsights(value => !value)}>
    {showAllInsights
      ? t('home.lessSummary')
      : t('home.moreSummary', { count: insightPartition.secondary.length })}
  </button>
)}
{formulaGuidance && (
  <details className="insight-guidance">
    <summary>{t('home.dailyTip')}</summary>
    {renderFormulaGuidance()}
  </details>
)}
{(!dataInfo?.lastBackupTime || syncState.status === 'error') && renderBackupCard()}
```

- [ ] **Step 5: Add bilingual copy**

Use these exact values:

```json
// ko
"summaryEmptyTitle": "필요한 정보만 여기에 모아드려요",
"summaryEmptyBody": "기록을 시작하면 오늘의 변화가 자동으로 표시됩니다.",
"moreSummary": "추가 요약 {{count}}개 보기",
"lessSummary": "요약 접기",
"dailyTip": "오늘 도움말"

// ja
"summaryEmptyTitle": "必要な情報だけをここにまとめます",
"summaryEmptyBody": "記録を始めると、今日の変化が自動的に表示されます。",
"moreSummary": "追加のまとめ{{count}}件を表示",
"lessSummary": "まとめを閉じる",
"dailyTip": "今日のヒント"
```

- [ ] **Step 6: Add Home readability styles**

Add `.progressive-empty`, `.progressive-more-button`, `.insight-guidance`, and data-count variants for `.stat-card-grid`. At `max-width: 1180px`, change `.home-main-grid` to one column; at `max-width: 1040px`, reduce quick-tile padding but keep every action reachable. Shorten quick-row mount choreography to 220ms with 24ms stagger so screenshots never capture half-invisible controls.

- [ ] **Step 7: Verify Home behavior**

Run: `npx vitest run tests/progressiveDisclosure.test.ts && npm run check && npm run build`

Expected: all checks pass; no Home action or handler is removed.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/pages/HomePage.tsx src/i18n/ko.json src/i18n/ja.json src/index.css tests/progressiveDisclosure.test.ts
git commit -m "feat: progressively reveal home insights"
```

---

### Task 3: Data-gated and progressive Stats page

**Files:**
- Modify: `src/pages/StatsPage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Modify: `src/index.css`
- Test: `tests/progressiveDisclosure.test.ts`

**Interfaces:**
- Consumes Task 1 Stats selectors.
- Preserves the 7/30-day toggle, PDF report, all chart calculations, tooltips, and WHO percentile calculations.

- [ ] **Step 1: Add failing visibility and locale tests**

Add tests proving all-zero day data produces no Stats sections, formula-only data produces only `formula`, and both locales contain `stats.emptyTitle`, `stats.emptyBody`, `stats.moreSections`, and `stats.lessSections`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/progressiveDisclosure.test.ts`

Expected: FAIL on missing locale keys or incorrect selectors.

- [ ] **Step 3: Gate every daily chart by data**

Replace unconditional Sleep, Formula, Feeding, Diaper, and empty Temperature cards with a descriptor-based renderer driven by `getStatsVisibility()`. Do not mount a `ResponsiveContainer` for an unavailable section. Keep the first two available sections visible; show secondary sections only after an explicit `moreSections` button.

```tsx
const [showAllSections, setShowAllSections] = useState(false)
const visibility = getStatsVisibility(data)
const partition = partitionStatsSections(visibility)
const visibleDailyKeys = showAllSections
  ? [...partition.primary, ...partition.secondary]
  : partition.primary

const renderDailySection = (key: StatsSectionKey) => {
  switch (key) {
    case 'sleep': return renderSleepChart()
    case 'formula': return renderFormulaChart()
    case 'feeding': return renderFeedingChart()
    case 'diaper': return renderDiaperChart()
    case 'temperature': return renderTemperatureChart()
  }
}

{visibleDailyKeys.map(key => <React.Fragment key={key}>{renderDailySection(key)}</React.Fragment>)}
{partition.secondary.length > 0 && (
  <button className="progressive-more-button" type="button" onClick={() => setShowAllSections(value => !value)}>
    {showAllSections
      ? t('stats.lessSections')
      : t('stats.moreSections', { count: partition.secondary.length })}
  </button>
)}
```

Each `render*Chart()` returns the existing chart JSX for that metric without changing its data, axes, tooltip, color, or calculation.

- [ ] **Step 4: Gate growth charts by completed prerequisites**

Show weight growth only when birthdate, gender, and at least one non-deleted growth event with `weightKg` exist. Apply the same rule to height and `heightCm`. Do not render a blank WHO chart or separate missing-profile card. When no daily or growth section is available, render one `.stats-empty-state` using the new empty copy.

```tsx
const growthEvents = events.filter(event => !event.deleted && event.type === 'growth')
const hasWeightGrowth = canShowGrowth && growthEvents.some(event => (event.data as GrowthData).weightKg != null)
const hasHeightGrowth = canShowGrowth && growthEvents.some(event => (event.data as GrowthData).heightCm != null)
const hasAnySection = visibleDailyKeys.length > 0 || hasWeightGrowth || hasHeightGrowth

{!hasAnySection && (
  <div className="stats-empty-state">
    <div className="progressive-empty-title">{t('stats.emptyTitle')}</div>
    <div className="progressive-empty-body">{t('stats.emptyBody')}</div>
  </div>
)}
{hasWeightGrowth && <GrowthChartSection metric="weight" {...growthProps} />}
{hasHeightGrowth && <GrowthChartSection metric="height" {...growthProps} />}
```

- [ ] **Step 5: Add bilingual copy**

```json
// ko
"emptyTitle": "표시할 통계가 아직 없어요",
"emptyBody": "수유·수면·기저귀·체온 또는 성장 기록이 쌓이면 관련 그래프만 나타납니다.",
"moreSections": "추가 통계 {{count}}개 보기",
"lessSections": "통계 간단히 보기"

// ja
"emptyTitle": "表示できるグラフはまだありません",
"emptyBody": "授乳・睡眠・おむつ・体温・成長の記録が増えると、関連するグラフだけが表示されます。",
"moreSections": "追加のグラフ{{count}}件を表示",
"lessSections": "グラフを少なく表示"
```

- [ ] **Step 6: Add Stats readability styles**

Add `.stats-section-stack`, `.stats-empty-state`, and a stable `.progressive-more-button` placement. Raise Recharts axis label font size from 11px to 12px and preserve a minimum chart height of 180px. No chart entrance animation may animate width or height.

- [ ] **Step 7: Verify Stats behavior**

Run: `npx vitest run tests/progressiveDisclosure.test.ts && npm run check && npm run build`

Expected: focused and full checks pass; absent data no longer mounts empty charts.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/pages/StatsPage.tsx src/i18n/ko.json src/i18n/ja.json src/index.css tests/progressiveDisclosure.test.ts
git commit -m "feat: show stats when data is ready"
```

---

### Task 4: Low-frequency Settings disclosure and cross-platform polish

**Files:**
- Create: `src/components/DisclosureSection.tsx`
- Create: `tests/disclosureSection.test.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Modify: `src/i18n/index.ts`
- Modify: `src/index.css`

**Interfaces:**
- Consumes `shouldOpenSyncDisclosure()` from Task 1.
- Produces an accessible native-details `DisclosureSection` with `title`, `summary`, `defaultOpen`, and `children` props.

- [ ] **Step 1: Write the failing disclosure component test**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DisclosureSection } from '../src/components/DisclosureSection'

describe('DisclosureSection', () => {
  it('uses native details and exposes a readable summary', () => {
    const html = renderToStaticMarkup(
      <DisclosureSection title="Data" summary="12 records" defaultOpen={false}>
        <button>Export</button>
      </DisclosureSection>,
    )
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('Data')
    expect(html).toContain('12 records')
    expect(html).not.toContain(' open=""')
  })
})
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `npx vitest run tests/disclosureSection.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement DisclosureSection minimally**

Use semantic `<section><details><summary>` markup. Keep the summary text visible in both open and closed states, set no custom ARIA role on native elements, and render children inside `.disclosure-content`.

```tsx
import type { ReactNode } from 'react'

interface DisclosureSectionProps {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

export function DisclosureSection({
  title,
  summary,
  defaultOpen = false,
  children,
  className = '',
}: DisclosureSectionProps) {
  return (
    <section className={`settings-section disclosure-section ${className}`.trim()}>
      <details open={defaultOpen}>
        <summary className="disclosure-summary">
          <span className="disclosure-heading">{title}</span>
          {summary && <span className="disclosure-meta">{summary}</span>}
          <span className="disclosure-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="disclosure-content">{children}</div>
      </details>
    </section>
  )
}
```

- [ ] **Step 4: Apply disclosure to low-frequency Settings content**

Wrap Data in a closed disclosure whose summary includes record count and last-backup state. Wrap Family Sync in a disclosure whose default state uses `shouldOpenSyncDisclosure(syncStatus.status)` and whose summary uses localized online/attention/connecting copy. Keep language, theme, baby information, profile, and Save visible. Keep guidance cards and every export/delete/tutorial action reachable.

```tsx
const syncStatus = useSyncStatus()
const syncSummary = syncStatus.status === 'online'
  ? t('settings.syncReady')
  : syncStatus.status === 'connecting'
    ? t('sync.connecting')
    : t('settings.syncNeedsAttention')
const dataSummary = t('settings.dataSummary', {
  count: dataInfo?.eventCount ?? 0,
  backup: dataInfo?.lastBackupTime
    ? format(parseISO(dataInfo.lastBackupTime), t('date.formatBackup'), { locale: dateFnsLocale })
    : t('settings.noBackup'),
})

<DisclosureSection title={t('settings.dataSection')} summary={dataSummary}>
  {renderExistingDataCard()}
</DisclosureSection>

<DisclosureSection
  title={t('settings.syncSection')}
  summary={syncSummary}
  defaultOpen={shouldOpenSyncDisclosure(syncStatus.status)}
>
  <SyncSettingsSlot />
</DisclosureSection>
```

- [ ] **Step 5: Add locale parity and dynamic document language**

Add exact Settings keys:

```json
// ko
"dataSummary": "{{count}}개 기록 · 백업 {{backup}}",
"syncReady": "연결됨",
"syncNeedsAttention": "설정이 필요합니다"

// ja
"dataSummary": "記録{{count}}件 · バックアップ {{backup}}",
"syncReady": "接続済み",
"syncNeedsAttention": "設定が必要です"
```

Update `setLanguage()` and `initLangAttr()` so `<html lang>` is `ko` or `ja` together with `data-lang`.

- [ ] **Step 6: Add responsive, readable, and efficient CSS**

Add disclosure styles with a 44px minimum summary target and transform-only chevron rotation. Set light/dark `color-scheme`, increase page titles to 28px and common metadata to at least 12px, add visible `:focus-visible` rings, use an 8px scrollbar with `scrollbar-gutter: stable`, remove `.app-shell` fixed `min-width`, switch Settings to one column below 1180px, and provide opaque `@supports not (backdrop-filter: blur(1px))` fallbacks.

Change `deleteModalAppear`, `tourTooltipIn`, and `langPickerCardIn` from `margin-top` animation to `translateY`. Preserve the existing reduced-motion overrides.

- [ ] **Step 7: Verify component and full behavior**

Run: `npx vitest run tests/disclosureSection.test.tsx tests/progressiveDisclosure.test.ts && npm run check && npm run build && git diff --check`

Expected: all commands succeed and locale structures match.

- [ ] **Step 8: Commit Task 4**

```powershell
git add src/components/DisclosureSection.tsx tests/disclosureSection.test.tsx src/pages/SettingsPage.tsx src/i18n/ko.json src/i18n/ja.json src/i18n/index.ts src/index.css
git commit -m "feat: simplify settings with disclosures"
```

---

## Final verification

- Run `npm run check` and confirm the complete test count with zero failures.
- Run `npm run build` and confirm no Vite/CSS warnings introduced by this branch.
- Run packaged Windows E2E against `win-unpacked/Baby Diary.exe` and require 24 screenshots, zero failures, zero console errors.
- Push the feature branch and manually dispatch `build.yml` for macOS build/E2E and Windows E2E before integration.
- Compare Home empty/partial/full states, Stats empty/partial/full states, Settings closed/open states, light/dark, Korean/Japanese, 960x640 and 1200x800, and reduced motion.
