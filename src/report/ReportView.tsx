import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { buildReportModel } from '../lib/reportModel'
import type { ReportModel } from '../lib/reportModel'

// Print-safe CSS embedded inline so the component is self-contained in the hidden window.
const PRINT_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Hiragino Sans', 'Yu Gothic', 'Noto Sans CJK JP', 'Malgun Gothic',
                 'Apple SD Gothic Neo', sans-serif;
    font-size: 11pt;
    color: #111;
    background: #fff;
    padding: 20mm 18mm;
  }
  h1 { font-size: 18pt; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 13pt; font-weight: 600; margin: 16px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  h3 { font-size: 11pt; font-weight: 600; margin: 10px 0 4px; }
  .header-meta { font-size: 10pt; color: #444; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 10pt; }
  th { background: #f0f0f0; border: 1px solid #bbb; padding: 4px 6px; text-align: left; font-weight: 600; }
  td { border: 1px solid #bbb; padding: 4px 6px; }
  .stat-label { color: #555; font-size: 10pt; }
  .stat-value { font-weight: 600; }
  .report-context-note { margin: 2px 0 8px; font-size: 8.5pt; line-height: 1.45; color: #555; }
  .footer { margin-top: 20px; font-size: 8pt; color: #666; border-top: 1px solid #ccc; padding-top: 6px; }
  @media print {
    body { padding: 0; }
    @page { margin: 18mm; }
  }
`

function fmt1(n: number | null | undefined): string {
  if (n == null) return '-'
  return n.toFixed(1)
}

function fmt0(n: number | null | undefined): string {
  if (n == null) return '-'
  return n.toFixed(0)
}

interface StatRowProps {
  label: string
  value7: string
  value30: string
}

function StatRow({ label, value7, value30 }: StatRowProps) {
  return (
    <tr>
      <td className="stat-label">{label}</td>
      <td className="stat-value">{value7}</td>
      <td className="stat-value">{value30}</td>
    </tr>
  )
}

export function ReportView() {
  const { t, i18n } = useTranslation()
  const events   = useAppStore(s => s.events)
  const settings = useAppStore(s => s.settings)

  const dateFnsLocale = i18n.language === 'ja' ? ja : ko
  const now = new Date()
  const model: ReportModel = useMemo(() => buildReportModel(events, settings, now), [events, settings])

  const formatDate = (dateStr: string) => {
    try { return format(parseISO(dateStr), 'yyyy-MM-dd') } catch { return dateStr }
  }

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <style>{PRINT_STYLES}</style>

      {/* Header */}
      <h1>{t('report.title')}</h1>
      <p className="header-meta">{t('report.generatedAt', { date: format(now, 'yyyy-MM-dd HH:mm') })}</p>

      {/* Baby info */}
      <h2>{t('report.babyInfo')}</h2>
      <table>
        <tbody>
          <tr>
            <th style={{ width: '30%' }}>{t('report.babyName')}</th>
            <td>{model.babyName || t('report.noData')}</td>
            <th style={{ width: '20%' }}>{t('report.birthdate')}</th>
            <td>{model.birthdate ? formatDate(model.birthdate) : t('report.noData')}</td>
          </tr>
          <tr>
            <th>{t('report.ageMonths')}</th>
            <td>{model.ageMonths > 0 ? t('report.ageMonthsValue', { months: model.ageMonths }) : t('report.noData')}</td>
            <td colSpan={2}></td>
          </tr>
        </tbody>
      </table>

      {/* Period summary */}
      <h2>{t('report.summaryTitle')}</h2>
      <table>
        <thead>
          <tr>
            <th style={{ width: '40%' }}></th>
            <th>{t('report.last7Days')}</th>
            <th>{t('report.last30Days')}</th>
          </tr>
        </thead>
        <tbody>
          <StatRow
            label={t('report.avgFeedingPerDay')}
            value7={t('report.avgFeedingUnit', { value: fmt1(model.last7.avgFeedingPerDay) })}
            value30={t('report.avgFeedingUnit', { value: fmt1(model.last30.avgFeedingPerDay) })}
          />
          <StatRow
            label={t('report.avgFormulaMlPerDay')}
            value7={t('report.avgFormulaMlUnit', { value: fmt0(model.last7.avgFormulaMlPerDay) })}
            value30={t('report.avgFormulaMlUnit', { value: fmt0(model.last30.avgFormulaMlPerDay) })}
          />
          <StatRow
            label={t('report.avgDiaperPerDay')}
            value7={t('report.avgDiaperUnit', { value: fmt1(model.last7.avgDiaperPerDay) })}
            value30={t('report.avgDiaperUnit', { value: fmt1(model.last30.avgDiaperPerDay) })}
          />
          <StatRow
            label={t('report.avgSleepHoursPerDay')}
            value7={t('report.avgSleepUnit', { value: fmt1(model.last7.avgSleepHoursPerDay) })}
            value30={t('report.avgSleepUnit', { value: fmt1(model.last30.avgSleepHoursPerDay) })}
          />
          <tr>
            <td className="stat-label">{t('report.recentTemp')}</td>
            <td className="stat-value">
              {model.last7.recentTemp != null ? t('report.tempUnit', { value: fmt1(model.last7.recentTemp) }) : t('report.noData')}
            </td>
            <td className="stat-value">
              {model.last30.recentTemp != null ? t('report.tempUnit', { value: fmt1(model.last30.recentTemp) }) : t('report.noData')}
            </td>
          </tr>
          <tr>
            <td className="stat-label">{t('report.maxTemp')}</td>
            <td className="stat-value">
              {model.last7.maxTemp != null ? t('report.tempUnit', { value: fmt1(model.last7.maxTemp) }) : t('report.noData')}
            </td>
            <td className="stat-value">
              {model.last30.maxTemp != null ? t('report.tempUnit', { value: fmt1(model.last30.maxTemp) }) : t('report.noData')}
            </td>
          </tr>
          <tr>
            <td className="stat-label">{t('report.feverCount')}</td>
            <td className="stat-value">{t('report.feverCountUnit', { count: model.last7.feverCount })}</td>
            <td className="stat-value">{t('report.feverCountUnit', { count: model.last30.feverCount })}</td>
          </tr>
        </tbody>
      </table>
      <p className="report-context-note">{t('report.temperatureContext')}</p>

      {/* Growth records */}
      {model.growthRows.length > 0 && (
        <>
          <h2>{t('report.growthTitle')}</h2>
          <table>
            <thead>
              <tr>
                <th>{t('report.growthDate')}</th>
                <th>{t('report.growthAge')}</th>
                <th>{t('report.growthWeight')}</th>
                <th>{t('report.growthWeightPct')}</th>
                <th>{t('report.growthHeight')}</th>
                <th>{t('report.growthHeightPct')}</th>
              </tr>
            </thead>
            <tbody>
              {model.growthRows.map((row, i) => (
                <tr key={i}>
                  <td>{formatDate(row.date)}</td>
                  <td>{t('report.ageMonthsValue', { months: row.ageMonths })}</td>
                  <td>{row.weightKg != null ? row.weightKg.toFixed(2) : t('report.noData')}</td>
                  <td>{row.weightPct != null ? t('report.growthPctValue', { pct: fmt1(row.weightPct) }) : t('report.noData')}</td>
                  <td>{row.heightCm != null ? row.heightCm.toFixed(1) : t('report.noData')}</td>
                  <td>{row.heightPct != null ? t('report.growthPctValue', { pct: fmt1(row.heightPct) }) : t('report.noData')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Daily table last 7 days */}
      <h2>{t('report.dailyTitle')}</h2>
      <table>
        <thead>
          <tr>
            <th>{t('report.dailyDate')}</th>
            <th>{t('report.dailyFeeding')}</th>
            <th>{t('report.dailyFormulaMl')}</th>
            <th>{t('report.dailyDiaper')}</th>
          </tr>
        </thead>
        <tbody>
          {model.last7DayRows.map((row, i) => (
            <tr key={i}>
              <td>{formatDate(row.date)}</td>
              <td>{row.feedingCount}</td>
              <td>{row.formulaMl > 0 ? row.formulaMl : t('report.noData')}</td>
              <td>{row.diaperCount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Footer */}
      <div className="footer">
        <p>{t('report.footerDisclaimer')}</p>
        <p>{t('report.footerApp')} &mdash; {format(now, 'yyyy-MM-dd HH:mm', { locale: dateFnsLocale })}</p>
      </div>
    </div>
  )
}
