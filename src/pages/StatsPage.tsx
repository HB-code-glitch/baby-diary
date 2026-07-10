import React, { useState, useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend
} from 'recharts'
import { subDays, format, parseISO, startOfDay, isSameDay } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { DiaryEvent, FormulaData, TempData } from '../../shared/types'

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

function buildDayStats(events: DiaryEvent[], days: number): DayStats[] {
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
      label:  days <= 7 ? format(day, 'M/d (EEEEE)', { locale: ko }) : format(day, 'M/d'),
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
  background: 'var(--stone-50)',
  border: '1px solid var(--stone-200)',
  borderRadius: 8,
  fontSize: 12,
  fontFamily: 'Pretendard, sans-serif',
}

export function StatsPage() {
  const events = useAppStore(s => s.events)
  const [range, setRange] = useState<Range>(7)

  const data = useMemo(() => buildDayStats(events, range), [events, range])

  const hasTempData = data.some(d => d.avgTemp != null)
  const tempData    = data.filter(d => d.avgTemp != null)

  return (
    <div className="page-container">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="page-title">통계</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={`filter-chip${range === 7 ? ' active' : ''}`}
              onClick={() => setRange(7)}
            >
              7일
            </button>
            <button
              className={`filter-chip${range === 30 ? ' active' : ''}`}
              onClick={() => setRange(30)}
            >
              30일
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Formula total */}
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)', marginBottom: 12 }}>
            분유량 (ml/일)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}ml`, '분유']} />
              <Bar dataKey="formulaMl" fill="var(--peach-300)" radius={[3,3,0,0]} name="분유" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Feeding count */}
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)', marginBottom: 12 }}>
            수유 횟수
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}회`, '수유']} />
              <Bar dataKey="feedingCount" fill="var(--peach-200)" radius={[3,3,0,0]} name="수유" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Diaper counts */}
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)', marginBottom: 12 }}>
            기저귀 횟수
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="peeCount"  stackId="a" fill="var(--sage-200)"  radius={[0,0,0,0]} name="소변" />
              <Bar dataKey="poopCount" stackId="a" fill="var(--sage-400)"  radius={[3,3,0,0]} name="대변" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Temperature */}
        {hasTempData && (
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)', marginBottom: 12 }}>
              체온 (℃)
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={tempData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
                <YAxis domain={[36, 40]} tick={{ fontSize: 11, fill: 'var(--stone-500)' }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [`${v}℃`, '평균 체온']}
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
                  name="체온"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {!hasTempData && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--stone-400)', fontSize: 13, padding: '24px' }}>
            이 기간에 체온 기록이 없습니다
          </div>
        )}
      </div>
    </div>
  )
}
