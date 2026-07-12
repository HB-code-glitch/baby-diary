export const HOME_PRIMARY_INSIGHT_LIMIT = 3
export const STATS_PRIMARY_SECTION_LIMIT = 2

export type HomeMetricKey = 'formula' | 'pee' | 'poop' | 'feeding' | 'temperature'
export type HomeInsightKey = 'lastFeeding' | 'diaper' | 'temperature' | 'sleep' | 'nextSide'
export type StatsSectionKey = 'sleep' | 'formula' | 'feeding' | 'diaper' | 'temperature'
export type StatsPageSectionKey = StatsSectionKey | 'growthWeight' | 'growthHeight'
export type SyncDisclosureStatus = 'off' | 'no-config' | 'signed-out' | 'connecting' | 'online' | 'error'
export type SyncDisclosureSummary = 'ready' | 'connecting' | 'attention'

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

export function partitionStatsPageSections(
  visibility: StatsVisibility,
  growth: { weight: boolean; height: boolean },
): { primary: StatsPageSectionKey[]; secondary: StatsPageSectionKey[] } {
  const daily = partitionStatsSections(visibility)
  const ordered: StatsPageSectionKey[] = [
    ...daily.primary,
    ...daily.secondary,
    ...(growth.weight ? ['growthWeight'] as const : []),
    ...(growth.height ? ['growthHeight'] as const : []),
  ]

  return {
    primary: ordered.slice(0, STATS_PRIMARY_SECTION_LIMIT),
    secondary: ordered.slice(STATS_PRIMARY_SECTION_LIMIT),
  }
}

export function shouldOpenSyncDisclosure(
  status: SyncDisclosureStatus,
): boolean {
  return status === 'no-config' || status === 'signed-out' || status === 'error'
}

export function getSyncDisclosurePresentation(
  status: SyncDisclosureStatus,
  hasFamily: boolean,
): { summary: SyncDisclosureSummary; defaultOpen: boolean } {
  const isReady = status === 'online' && hasFamily
  return {
    summary: isReady ? 'ready' : status === 'connecting' ? 'connecting' : 'attention',
    defaultOpen: shouldOpenSyncDisclosure(status) || (status === 'online' && !hasFamily),
  }
}
