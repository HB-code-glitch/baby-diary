import React, { useState, useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend
} from 'recharts'
import { subDays, format, parseISO, isSameDay } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { DiaryEvent, FormulaData, TempData } from '../../shared/types'
import { useTranslation } from 'react-i18next'

type Range = 7 | 30

interface DayStats {
  date: string
  label: string
  formulaMl: number
  feedingCount: number
  peeCount: number
  poopCount: number
  avgTemp: number | null
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

    const tempEvents    = dayEvents.filter(e => e.type === 'temp')
    const avgTemp       = tempEvents.length > 0
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
    })
  }
  return result
}

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  fontSize: 12,
  fontFamily: "'Plus Jakarta Sans', 'Pretendard', sans-serif",
  boxShadow: '0 4px 12px rgba(22,21,19,0.08)',
}

export function StatsPage() {
  const events = useAppStore(s => s.events)
  const [range, setRange] = useState<Range>(7)
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  const data = useMemo(() => buildDayStats(events, range, dateFnsLocale), [events, range, dateFnsLocale])

  const hasTempData = data.some(d => d.avgTemp != null)
  const tempData    = data.filter(d => d.avgTemp != null)

  return (
    <div className="page-container" data-tour="stats">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="page-title">{t('stats.title')}</div>
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
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
      </div>
    </div>
  )
}
