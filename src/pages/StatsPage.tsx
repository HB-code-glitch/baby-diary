import React, { useState, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, LineChart, Line,
  ComposedChart, Scatter,
} from 'recharts'
import { subDays, format, parseISO, isSameDay, differenceInMonths } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { DiaryEvent, FormulaData, TempData, SleepData, GrowthData } from '../../shared/types'
import { useTranslation } from 'react-i18next'
import { computeZ, zToPercentile, percentileBandValue } from '../lib/whoGrowth'
import { ipc } from '../lib/ipc'
import { useToast } from '../components/Toast'

type Range = 7 | 30

// ---------------------------------------------------------------------------
// Day-level stat builders
// ---------------------------------------------------------------------------

interface DayStats {
  date: string
  label: string
  formulaMl: number
  feedingCount: number
  peeCount: number
  poopCount: number
  avgTemp: number | null
  sleepMinutes: number
}

function buildDayStats(events: DiaryEvent[], days: number, dateFnsLocale: typeof ko): DayStats[] {
  const result: DayStats[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = subDays(new Date(), i)
    const dayEvents = events.filter(e => !e.deleted && isSameDay(parseISO(e.at), day))

    const formulaEvents = dayEvents.filter(e => e.type === 'formula')
    const feedingCount  = dayEvents.filter(e => e.type === 'breast' || e.type === 'formula').length
    const peeCount      = dayEvents.filter(e => e.type === 'pee').length
    const poopCount     = dayEvents.filter(e => e.type === 'poop').length
    const formulaMl     = formulaEvents.reduce((s, e) => s + ((e.data as FormulaData).ml ?? 0), 0)
    const sleepMinutes  = dayEvents
      .filter(e => e.type === 'sleep')
      .reduce((s, e) => s + ((e.data as SleepData).minutes ?? 0), 0)

    const tempEvents = dayEvents.filter(e => e.type === 'temp')
    const avgTemp    = tempEvents.length > 0
      ? tempEvents.reduce((s, e) => s + ((e.data as TempData).celsius ?? 0), 0) / tempEvents.length
      : null

    result.push({
      date:   format(day, 'yyyy-MM-dd'),
      label:  days <= 7 ? format(day, 'M/d (EEEEE)', { locale: dateFnsLocale }) : format(day, 'M/d'),
      formulaMl,
      feedingCount,
      peeCount,
      poopCount,
      avgTemp: avgTemp != null ? Math.round(avgTemp * 10) / 10 : null,
      sleepMinutes,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// WHO growth chart helpers
// ---------------------------------------------------------------------------

type GrowthMetric = 'weight' | 'height'
type WhoSex = 'boy' | 'girl'

/** z-scores used for band lines: P3(z≈-1.88), P15(z≈-1.04), P50(z=0), P85(z≈1.04), P97(z≈1.88) */
const BAND_Z = [-1.88, -1.04, 0, 1.04, 1.88] as const
const BAND_COLORS = [
  'var(--indigo-300)',  // P3
  'var(--indigo-200)',  // P15
  'var(--indigo-500)',  // P50 (median)
  'var(--indigo-200)',  // P85
  'var(--indigo-300)',  // P97
]
const BAND_DASHES = ['4 4', '3 3', '', '3 3', '4 4'] as const

interface BandPoint {
  month: number
  p3: number
  p15: number
  p50: number
  p85: number
  p97: number
}

interface ScatterPoint {
  month: number
  value: number
  label: string
}

function buildBandData(metric: GrowthMetric, sex: WhoSex): BandPoint[] {
  const points: BandPoint[] = []
  for (let m = 0; m <= 24; m++) {
    points.push({
      month: m,
      p3:   percentileBandValue(metric, sex, m, BAND_Z[0]),
      p15:  percentileBandValue(metric, sex, m, BAND_Z[1]),
      p50:  percentileBandValue(metric, sex, m, BAND_Z[2]),
      p85:  percentileBandValue(metric, sex, m, BAND_Z[3]),
      p97:  percentileBandValue(metric, sex, m, BAND_Z[4]),
    })
  }
  return points
}

function buildScatterData(
  events: DiaryEvent[],
  metric: GrowthMetric,
  birthdate: Date,
  dateFnsLocale: typeof ko,
): ScatterPoint[] {
  return events
    .filter(e => !e.deleted && e.type === 'growth')
    .map(e => {
      const d = e.data as GrowthData
      const val = metric === 'weight' ? d.weightKg : d.heightCm
      if (val == null) return null
      const ageDate = parseISO(e.at)
      const months = Math.max(0, differenceInMonths(ageDate, birthdate))
      return {
        month: months,
        value: val,
        label: format(ageDate, 'M/d', { locale: dateFnsLocale }),
      } satisfies ScatterPoint
    })
    .filter((x): x is ScatterPoint => x !== null)
}

// ---------------------------------------------------------------------------
// Tooltip styles
// ---------------------------------------------------------------------------

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  fontSize: 12,
  fontFamily: "'Plus Jakarta Sans', 'Pretendard', sans-serif",
  boxShadow: '0 4px 12px rgba(22,21,19,0.08)',
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface GrowthChartSectionProps {
  metric: GrowthMetric
  sex: WhoSex
  birthdate: Date
  events: DiaryEvent[]
  dateFnsLocale: typeof ko
}

function GrowthChartSection({ metric, sex, birthdate, events, dateFnsLocale }: GrowthChartSectionProps) {
  const { t, i18n: inst } = useTranslation()

  const bandData = useMemo(() => buildBandData(metric, sex), [metric, sex])
  const scatterData = useMemo(
    () => buildScatterData(events, metric, birthdate, dateFnsLocale),
    [events, metric, birthdate, dateFnsLocale],
  )

  // Most recent measurement for percentile callout
  const latestScatter = scatterData.length > 0
    ? scatterData.reduce((a, b) => a.month >= b.month ? a : b)
    : null

  const percentileLabel = useMemo(() => {
    if (!latestScatter) return null
    const ageMonths = latestScatter.month
    const z = computeZ(metric, sex, ageMonths, latestScatter.value)
    const pct = Math.round(zToPercentile(z))
    const metricLabel = metric === 'weight'
      ? (latestScatter.value.toFixed(1) + 'kg')
      : (latestScatter.value.toFixed(1) + 'cm')
    const metricName = metric === 'weight'
      ? t('growth.weightLabel')
      : t('growth.heightLabel')
    return t('stats.growthPercentile', {
      metric: metricName,
      value: metricLabel,
      pct,
    })
  }, [latestScatter, metric, sex, t])

  const title = metric === 'weight' ? t('stats.growthWeightTitle') : t('stats.growthHeightTitle')
  const unit  = metric === 'weight' ? 'kg' : 'cm'

  const yDomain = metric === 'weight'
    ? ([2, 18] as [number, number])
    : ([44, 95] as [number, number])
  const yTicks = metric === 'weight'
    ? [2, 6, 10, 14, 18]
    : [44, 54, 64, 74, 84, 95]

  const lang = inst.language

  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="section-header-accent">{title}</div>

      {percentileLabel && (
        <div style={{
          fontSize: 12,
          color: 'var(--indigo-600)',
          marginBottom: 8,
          padding: '6px 10px',
          background: 'var(--indigo-100)',
          borderRadius: 8,
        }}>
          {percentileLabel}
        </div>
      )}

      {scatterData.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          {t('stats.noGrowthData')}
        </div>
      )}

      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
          <XAxis
            dataKey="month"
            type="number"
            domain={[0, 24]}
            tickCount={7}
            tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickFormatter={(m: number) => t('stats.growthMonthUnit', { m })}
          />
          <YAxis
            domain={yDomain}
            ticks={yTicks}
            tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickFormatter={(v: number) => `${Math.round(v)}${unit}`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v: number, name: string) => {
              if (name === 'scatter') return [`${v}${unit}`, title]
              return [`${v.toFixed(1)}${unit}`, name]
            }}
            labelFormatter={(m: number) => t('stats.growthMonthUnit', { m })}
          />

          {/* Band lines: P3, P15, P50, P85, P97 */}
          <Line data={bandData} type="monotone" dataKey="p3"  stroke={BAND_COLORS[0]} strokeWidth={1} strokeDasharray={BAND_DASHES[0]} dot={false} name={t('stats.growthP3')}  legendType="none" />
          <Line data={bandData} type="monotone" dataKey="p15" stroke={BAND_COLORS[1]} strokeWidth={1} strokeDasharray={BAND_DASHES[1]} dot={false} name={t('stats.growthP15')} legendType="none" />
          <Line data={bandData} type="monotone" dataKey="p50" stroke={BAND_COLORS[2]} strokeWidth={1.5} dot={false} name={t('stats.growthP50')} legendType="none" />
          <Line data={bandData} type="monotone" dataKey="p85" stroke={BAND_COLORS[3]} strokeWidth={1} strokeDasharray={BAND_DASHES[3]} dot={false} name={t('stats.growthP85')} legendType="none" />
          <Line data={bandData} type="monotone" dataKey="p97" stroke={BAND_COLORS[4]} strokeWidth={1} strokeDasharray={BAND_DASHES[4]} dot={false} name={t('stats.growthP97')} legendType="none" />

          {/* Baby scatter points */}
          {scatterData.length > 0 && (
            <Scatter
              data={scatterData}
              dataKey="value"
              name="scatter"
              fill="var(--indigo-500)"
              r={5}
              shape={(props: { cx?: number; cy?: number }) => (
                <circle
                  cx={props.cx ?? 0}
                  cy={props.cy ?? 0}
                  r={5}
                  fill="var(--indigo-500)"
                  stroke="var(--surface)"
                  strokeWidth={1.5}
                />
              )}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
        {t('stats.growthDisclaimer')}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main StatsPage
// ---------------------------------------------------------------------------

export function StatsPage() {
  const events   = useAppStore(s => s.events)
  const settings = useAppStore(s => s.settings)
  const [range, setRange] = useState<Range>(7)
  const { t, i18n: i18nInstance } = useTranslation()
  const { showToast } = useToast()
  const [pdfSaving, setPdfSaving] = useState(false)

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  async function handleSavePdf() {
    setPdfSaving(true)
    try {
      const result = await ipc.savePdf()
      if (result.saved) {
        showToast({ message: t('report.toastSuccess', { path: result.path }) })
      } else {
        showToast({ message: t('report.toastCanceled') })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'ELECTRON_ONLY') {
        showToast({ message: t('report.electronOnly') })
      } else {
        showToast({ message: t('report.toastError') })
      }
    } finally {
      setPdfSaving(false)
    }
  }

  const data = useMemo(() => buildDayStats(events, range, dateFnsLocale), [events, range, dateFnsLocale])

  const hasTempData  = data.some(d => d.avgTemp != null)
  const tempData     = data.filter(d => d.avgTemp != null)
  const hasSleepData = data.some(d => d.sleepMinutes > 0)

  // Growth chart gating: need birthdate + gender
  const birthdate = settings?.baby?.birthdate
  const gender    = settings?.baby?.gender
  const canShowGrowth = !!(birthdate && gender)
  const birthdateObj  = canShowGrowth ? parseISO(birthdate!) : null
  const whoSex: WhoSex = gender === 'girl' ? 'girl' : 'boy'

  return (
    <div className="page-container" data-tour="stats">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="page-title">{t('stats.title')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="toggle-group">
              <button
                className={`toggle-btn${range === 7 ? ' active' : ''}`}
                onClick={() => setRange(7)}
              >
                {t('stats.days7')}
              </button>
              <button
                className={`toggle-btn${range === 30 ? ' active' : ''}`}
                onClick={() => setRange(30)}
              >
                {t('stats.days30')}
              </button>
            </div>
            <button
              className="btn-secondary"
              style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={handleSavePdf}
              disabled={pdfSaving}
            >
              {pdfSaving ? t('report.saving') : t('report.btnLabel')}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Sleep total minutes per day */}
        <div className="card">
          <div className="section-header-accent">
            {t('stats.sleepTitle')}
          </div>
          {hasSleepData ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [t('stats.sleepUnit', { value: v }), t('stats.sleepTooltip')]}
                />
                <Bar
                  dataKey="sleepMinutes"
                  fill="var(--indigo-300)"
                  radius={[8, 8, 0, 0]}
                  maxBarSize={44}
                  name={t('stats.sleepTooltip')}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--stone-400)', fontSize: 13, padding: '24px 0' }}>
              {t('stats.noGrowthData')}
            </div>
          )}
        </div>

        {/* Formula total */}
        <div className="card">
          <div className="section-header-accent">
            {t('stats.formulaTitle')}
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: number) => [t('stats.mlUnit', { value: v }), t('stats.formulaTooltip')]}
              />
              <Bar dataKey="formulaMl" fill="var(--amber-300)" radius={[8,8,0,0]} maxBarSize={44} name={t('stats.formulaTooltip')} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Feeding count */}
        <div className="card">
          <div className="section-header-accent">
            {t('stats.feedingTitle')}
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: number) => [t('stats.countUnit', { count: v }), t('stats.feedingTooltip')]}
              />
              <Bar dataKey="feedingCount" fill="var(--amber-200)" radius={[8,8,0,0]} maxBarSize={44} name={t('stats.feedingTooltip')} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Diaper counts */}
        <div className="card">
          <div className="section-header-accent">
            {t('stats.diaperTitle')}
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="peeCount"  stackId="a" fill="var(--mint)"      radius={[0,0,0,0]} maxBarSize={44} name={t('stats.peeLabel')} />
              <Bar dataKey="poopCount" stackId="a" fill="var(--sage-400)"  radius={[8,8,0,0]} maxBarSize={44} name={t('stats.poopLabel')} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Temperature */}
        {hasTempData && (
          <div className="card">
            <div className="section-header-accent">
              {t('stats.tempTitle')}
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={tempData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" strokeOpacity={0.8} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis domain={[36, 40]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [`${v}℃`, t('stats.tempTooltip')]}
                />
                <ReferenceLine
                  y={37.5}
                  stroke="var(--peach-400)"
                  strokeDasharray="4 4"
                  label={{ value: '37.5℃', position: 'right', fontSize: 11, fill: 'var(--peach-400)' }}
                />
                <Line
                  type="monotone"
                  dataKey="avgTemp"
                  stroke="var(--amber-500)"
                  strokeWidth={2}
                  dot={{ fill: 'var(--amber-500)', r: 4 }}
                  name={t('stats.tempLineLabel')}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {!hasTempData && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--stone-400)', fontSize: 13, padding: '24px' }}>
            {t('stats.noTempData')}
          </div>
        )}

        {/* WHO Growth Curves */}
        <div className="section-header-accent" style={{ marginTop: 4 }}>
          {t('stats.growthTitle')}
        </div>

        {!canShowGrowth ? (
          <div className="card" style={{ textAlign: 'center', color: 'var(--stone-400)', fontSize: 13, padding: '24px' }}>
            {t('stats.growthNoBirthdate')}
          </div>
        ) : (
          <>
            <GrowthChartSection
              metric="weight"
              sex={whoSex}
              birthdate={birthdateObj!}
              events={events}
              dateFnsLocale={dateFnsLocale}
            />
            <GrowthChartSection
              metric="height"
              sex={whoSex}
              birthdate={birthdateObj!}
              events={events}
              dateFnsLocale={dateFnsLocale}
            />
          </>
        )}

      </div>
    </div>
  )
}
