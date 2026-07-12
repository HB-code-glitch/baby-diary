import { subDays, differenceInMonths, differenceInCalendarDays, parseISO, isSameDay, format } from 'date-fns'
import type { DiaryEvent, AppSettings } from '../../shared/types'
import type { FormulaData, TempData, SleepData, GrowthData } from '../../shared/types'
import { computeZ, zToPercentile } from './whoGrowth'

export interface ReportPeriodStats {
  avgFeedingPerDay: number    // (formula + breast) count / period days
  avgFormulaMlPerDay: number  // total formula ml / period days
  avgDiaperPerDay: number     // (pee + poop) count / period days
  avgSleepHoursPerDay: number // total sleep minutes / 60 / period days
  recentTemp: number | null   // latest temp reading celsius in period
  maxTemp: number | null      // highest temp in period
  feverCount: number          // readings >= 38.0 in period
}

export interface ReportGrowthRow {
  date: string         // 'yyyy-MM-dd'
  ageMonths: number    // floor months at measurement
  weightKg: number | null
  heightCm: number | null
  weightPct: number | null   // WHO percentile, null if no gender/birthdate
  heightPct: number | null
}

export interface ReportDayRow {
  date: string         // 'yyyy-MM-dd'
  feedingCount: number
  formulaMl: number
  diaperCount: number
}

export interface ReportModel {
  babyName: string
  birthdate: string   // 'yyyy-MM-dd' or ''
  reportDate: string  // 'yyyy-MM-dd'
  ageMonths: number   // age at reportDate
  gender: 'girl' | 'boy' | undefined
  language: string    // 'ko' | 'ja'
  last7: ReportPeriodStats
  last30: ReportPeriodStats
  growthRows: ReportGrowthRow[]   // all growth events, newest first
  last7DayRows: ReportDayRow[]    // 7 rows newest-first
}

// ────────────────────────────────────────────────────────────────────────────

function periodStats(
  events: DiaryEvent[],
  days: number,
  now: Date,
  birthdate?: string,
): ReportPeriodStats {
  const cutoff = subDays(now, days)
  const inPeriod = events.filter(e => {
    if (e.deleted) return false
    const d = parseISO(e.at)
    return d > cutoff && d <= now
  })

  // MF-04: clamp denominator to days since birth so a 2-day-old's rates
  // are not diluted by dividing over the full 7- or 30-day window.
  let effDays = days
  if (birthdate) {
    const daysSinceBirth = differenceInCalendarDays(now, parseISO(birthdate)) + 1
    effDays = Math.max(1, Math.min(days, daysSinceBirth))
  }

  const feedingCount  = inPeriod.filter(e => e.type === 'formula' || e.type === 'breast').length
  const formulaMl     = inPeriod.filter(e => e.type === 'formula')
    .reduce((s, e) => s + ((e.data as FormulaData).ml ?? 0), 0)
  const diaperCount   = inPeriod.filter(e => e.type === 'pee' || e.type === 'poop').length
  const sleepMinutes  = inPeriod.filter(e => e.type === 'sleep')
    .reduce((s, e) => s + ((e.data as SleepData).minutes ?? 0), 0)

  const tempReadings  = inPeriod
    .filter(e => e.type === 'temp')
    .map(e => (e.data as TempData).celsius ?? 0)
    .filter(c => c > 0)
  const sortedByAt    = inPeriod
    .filter(e => e.type === 'temp')
    .sort((a, b) => parseISO(b.at).getTime() - parseISO(a.at).getTime())
  const recentTemp    = sortedByAt.length > 0 ? (sortedByAt[0].data as TempData).celsius ?? null : null
  const maxTemp       = tempReadings.length > 0 ? Math.max(...tempReadings) : null
  const feverCount    = tempReadings.filter(c => c >= 38.0).length

  return {
    avgFeedingPerDay:     feedingCount  / effDays,
    avgFormulaMlPerDay:   formulaMl     / effDays,
    avgDiaperPerDay:      diaperCount   / effDays,
    avgSleepHoursPerDay:  sleepMinutes  / 60 / effDays,
    recentTemp,
    maxTemp,
    feverCount,
  }
}

export function buildReportModel(
  events: DiaryEvent[],
  settings: AppSettings | null,
  now: Date
): ReportModel {
  const babyName  = settings?.baby?.name      ?? ''
  const birthdate = settings?.baby?.birthdate ?? ''
  const gender    = settings?.baby?.gender
  const language  = settings?.language        ?? 'ko'
  const reportDate = format(now, 'yyyy-MM-dd')

  const ageMonths = birthdate
    ? differenceInMonths(now, parseISO(birthdate))
    : 0

  const live = events.filter(e => !e.deleted)

  // Growth rows (newest-first)
  const growthEvents = live
    .filter(e => e.type === 'growth')
    .sort((a, b) => parseISO(b.at).getTime() - parseISO(a.at).getTime())

  const growthRows: ReportGrowthRow[] = growthEvents.map(e => {
    const gd    = e.data as GrowthData
    const evAge = birthdate ? differenceInMonths(parseISO(e.at), parseISO(birthdate)) : 0
    const sex   = gender === 'girl' ? 'girl' : 'boy'

    let weightPct: number | null = null
    let heightPct: number | null = null
    // MF-05: only compute WHO percentiles within the 0-24 month table range;
    // outside that range return null (no silent clamp to a wrong value).
    if (birthdate && gender && gd.weightKg && evAge >= 0 && evAge <= 24) {
      const z = computeZ('weight', sex, evAge, gd.weightKg)
      weightPct = Math.round(zToPercentile(z) * 10) / 10
    }
    if (birthdate && gender && gd.heightCm && evAge >= 0 && evAge <= 24) {
      const z = computeZ('height', sex, evAge, gd.heightCm)
      heightPct = Math.round(zToPercentile(z) * 10) / 10
    }

    return {
      date:      format(parseISO(e.at), 'yyyy-MM-dd'),
      ageMonths: evAge,
      weightKg:  gd.weightKg  ?? null,
      heightCm:  gd.heightCm  ?? null,
      weightPct,
      heightPct,
    }
  })

  // Last 7 day rows (newest-first)
  const last7DayRows: ReportDayRow[] = []
  for (let i = 0; i < 7; i++) {
    const day = subDays(now, i)
    const dayStr = format(day, 'yyyy-MM-dd')
    const dayEvents = live.filter(e => isSameDay(parseISO(e.at), day))
    last7DayRows.push({
      date:         dayStr,
      feedingCount: dayEvents.filter(e => e.type === 'formula' || e.type === 'breast').length,
      formulaMl:    dayEvents.filter(e => e.type === 'formula')
        .reduce((s, e) => s + ((e.data as FormulaData).ml ?? 0), 0),
      diaperCount:  dayEvents.filter(e => e.type === 'pee' || e.type === 'poop').length,
    })
  }

  return {
    babyName,
    birthdate,
    reportDate,
    ageMonths,
    gender,
    language,
    last7:  periodStats(live, 7,  now, birthdate || undefined),
    last30: periodStats(live, 30, now, birthdate || undefined),
    growthRows,
    last7DayRows,
  }
}
