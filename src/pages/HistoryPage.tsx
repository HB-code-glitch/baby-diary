import React, { useState, useMemo } from 'react'
import { IconChevronLeft, IconChevronRight, IconStar, IconInfo } from '../components/icons'
import {
  format, addDays, subDays, addWeeks, subWeeks, addMonths, subMonths,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  isToday, isSameDay, isSameMonth, getDay, parseISO, differenceInDays,
} from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore, getDDay } from '../store/useAppStore'
import { EventTimeline } from '../components/EventTimeline'
import { EventType, DiaryEvent, FormulaData } from '../../shared/types'
import { useTranslation } from 'react-i18next'
import { getMilestones, Milestone } from '../lib/milestones'
import { GUIDANCE_ITEMS, GuidanceItem, GUIDANCE_DISCLAIMER_KO, GUIDANCE_DISCLAIMER_JA } from '../lib/guidance'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type CalendarView = 'month' | 'week' | 'day'

// ---------------------------------------------------------------------------
// Day cell indicators for month view
// ---------------------------------------------------------------------------
interface DayIndicators {
  diaperCount: number
  feedingCount: number
  formulaMl: number
  hasHighTemp: boolean
  hasDiaryOrMessage: boolean
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
    return { diaperCount, feedingCount, formulaMl, hasHighTemp, hasDiaryOrMessage }
  }, [events, date])
}

// ---------------------------------------------------------------------------
// Month View
// ---------------------------------------------------------------------------
interface MonthViewProps {
  selectedDate: Date
  displayMonth: Date
  allEvents: DiaryEvent[]
  onSelectDay: (date: Date) => void
  onPrevMonth: () => void
  onNextMonth: () => void
  milestones: Milestone[]
  guidanceItems: GuidanceItem[]
  birthdate?: string
}

function MonthView({ selectedDate, displayMonth, allEvents, onSelectDay, onPrevMonth, onNextMonth, milestones, guidanceItems, birthdate }: MonthViewProps) {
  const { t } = useTranslation()

  const year = displayMonth.getFullYear()
  const month = displayMonth.getMonth() + 1

  const monthStart = startOfMonth(displayMonth)
  const monthEnd = endOfMonth(displayMonth)
  // Week starts on Sunday (0)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd })

  const WEEKDAY_KEYS = ['weekdaySun', 'weekdayMon', 'weekdayTue', 'weekdayWed', 'weekdayThu', 'weekdayFri', 'weekdaySat'] as const

  return (
    <div className="card cal-month">
      {/* Month navigation */}
      <div className="cal-nav">
        <button className="btn-secondary cal-nav-arrow" onClick={onPrevMonth} aria-label="prev month">
          <IconChevronLeft size={16} color="var(--stone-600)" />
        </button>
        <div className="cal-nav-title">
          {t('history.monthTitle', { year, month })}
        </div>
        <button className="btn-secondary cal-nav-arrow" onClick={onNextMonth} aria-label="next month">
          <IconChevronRight size={16} color="var(--stone-600)" />
        </button>
      </div>

      {/* Weekday headers */}
      <div className="cal-grid-7">
        {WEEKDAY_KEYS.map((key, i) => (
          <div
            key={key}
            className={`cal-weekday-header${i === 0 ? ' cal-sunday' : i === 6 ? ' cal-saturday' : ''}`}
          >
            {t(`history.${key}`)}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="cal-grid-7">
        {days.map(day => (
          <MonthDayCell
            key={day.toISOString()}
            day={day}
            displayMonth={displayMonth}
            selectedDate={selectedDate}
            allEvents={allEvents}
            onSelect={onSelectDay}
            milestones={milestones}
            guidanceItems={guidanceItems}
            birthdate={birthdate}
          />
        ))}
      </div>
    </div>
  )
}

interface MonthDayCellProps {
  day: Date
  displayMonth: Date
  selectedDate: Date
  allEvents: DiaryEvent[]
  onSelect: (date: Date) => void
  milestones: Milestone[]
  guidanceItems: GuidanceItem[]
  birthdate?: string
}

function MonthDayCell({ day, displayMonth, selectedDate, allEvents, onSelect, milestones, guidanceItems, birthdate }: MonthDayCellProps) {
  const indicators = useDayIndicators(allEvents, day)
  const { i18n: i18nInstance } = useTranslation()
  const isCurrentMonth = isSameMonth(day, displayMonth)
  const isTodayDay = isToday(day)
  const isSelected = isSameDay(day, selectedDate)
  const dayNum = getDay(day) // 0=Sun, 6=Sat
  const lang = i18nInstance.language

  const hasContent = indicators.diaperCount > 0 || indicators.feedingCount > 0 || indicators.hasHighTemp || indicators.hasDiaryOrMessage

  const dayStr = format(day, 'yyyy-MM-dd')
  const dayMilestones = milestones.filter(m => m.date === dayStr)

  // Guidance items relevant for this day (calendar items only — exclude pinToSettings)
  const dayGuidance = birthdate ? guidanceItems.filter(g => {
    if (g.pinToSettings) return false
    const birth = parseISO(birthdate)
    const ageInDays = differenceInDays(day, birth)
    return ageInDays >= 0 && g.startDay === ageInDays
  }) : []

  return (
    <button
      className={[
        'cal-day-cell',
        !isCurrentMonth ? 'cal-day-other-month' : '',
        isTodayDay ? 'cal-day-today' : '',
        isSelected ? 'cal-day-selected' : '',
        dayNum === 0 ? 'cal-sunday' : dayNum === 6 ? 'cal-saturday' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onSelect(day)}
      aria-label={format(day, 'yyyy-MM-dd')}
    >
      <span className="cal-day-num">{day.getDate()}</span>
      {isCurrentMonth && (
        <div className="cal-day-indicators">
          {hasContent && (
            <>
              {indicators.diaperCount > 0 && (
                <span className="cal-indicator cal-indicator-sage">
                  {indicators.diaperCount}
                </span>
              )}
              {indicators.feedingCount > 0 && (
                <span className="cal-indicator cal-indicator-peach">
                  {indicators.formulaMl > 0 ? `${indicators.formulaMl}ml` : indicators.feedingCount}
                </span>
              )}
              {indicators.hasHighTemp && (
                <span className="cal-indicator cal-indicator-red">↑</span>
              )}
              {indicators.hasDiaryOrMessage && (
                <span className="cal-indicator cal-indicator-rose">●</span>
              )}
            </>
          )}
          {dayMilestones.length > 0 && (
            <span className="cal-indicator cal-indicator-festive" title={lang === 'ja' ? dayMilestones[0].nameJa : dayMilestones[0].nameKo}>
              <IconStar size={8} color="currentColor" />
            </span>
          )}
          {dayGuidance.length > 0 && (
            <span className="cal-indicator cal-indicator-sky" title={lang === 'ja' ? dayGuidance[0].titleJa : dayGuidance[0].titleKo}>
              <IconInfo size={8} color="currentColor" />
            </span>
          )}
        </div>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Week View
// ---------------------------------------------------------------------------
interface WeekViewProps {
  selectedDate: Date
  displayWeek: Date
  allEvents: DiaryEvent[]
  settings: ReturnType<typeof useAppStore.getState>['settings']
  onSelectDay: (date: Date) => void
  onPrevWeek: () => void
  onNextWeek: () => void
}

function WeekView({ selectedDate, displayWeek, allEvents, settings, onSelectDay, onPrevWeek, onNextWeek }: WeekViewProps) {
  const { t } = useTranslation()

  const weekStart = startOfWeek(displayWeek, { weekStartsOn: 0 })
  const weekEnd = endOfWeek(displayWeek, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd })

  const m1 = weekStart.getMonth() + 1
  const d1 = weekStart.getDate()
  const m2 = weekEnd.getMonth() + 1
  const d2 = weekEnd.getDate()

  const titleKey = m1 === m2 ? 'history.weekTitleSameMonth' : 'history.weekTitle'
  const titleParams = m1 === m2
    ? { month: m1, d1, d2 }
    : { m1, d1, m2, d2 }

  const birthdate = settings?.baby?.birthdate

  return (
    <div className="card cal-week">
      {/* Week navigation */}
      <div className="cal-nav">
        <button className="btn-secondary cal-nav-arrow" onClick={onPrevWeek} aria-label="prev week">
          <IconChevronLeft size={16} color="var(--stone-600)" />
        </button>
        <div className="cal-nav-title">
          {t(titleKey, titleParams)}
        </div>
        <button className="btn-secondary cal-nav-arrow" onClick={onNextWeek} aria-label="next week">
          <IconChevronRight size={16} color="var(--stone-600)" />
        </button>
      </div>

      {/* Day rows */}
      <div className="cal-week-rows">
        {days.map(day => {
          const indicators = allEvents.filter(e => !e.deleted && isSameDay(parseISO(e.at), day))
          // P36: Removed dead `dday` variable (added getDDay twice, was never rendered)
          // compute D+N for this specific day
          let ddayForDay: number | null = null
          if (birthdate) {
            const birth = parseISO(birthdate)
            const diffMs = day.getTime() - birth.getTime()
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
            if (diffDays >= 0) ddayForDay = diffDays + 1
          }
          const isSelected = isSameDay(day, selectedDate)
          const isTodayDay = isToday(day)
          const dayNum = getDay(day)

          // Build per-type summary
          const peeCount = indicators.filter(e => e.type === 'pee').length
          const poopCount = indicators.filter(e => e.type === 'poop').length
          const breastCount = indicators.filter(e => e.type === 'breast').length
          const formulaCount = indicators.filter(e => e.type === 'formula').length
          const formulaMl = indicators.filter(e => e.type === 'formula').reduce((s, e) => s + ((e.data as FormulaData).ml ?? 0), 0)
          const hasHighTemp = indicators.some(e => e.type === 'temp' && (e.data as { celsius: number }).celsius >= 37.5)

          // First few event times
          const timePreview = indicators
            .sort((a, b) => a.at.localeCompare(b.at))
            .slice(0, 3)
            .map(e => format(parseISO(e.at), 'HH:mm'))

          return (
            <button
              key={day.toISOString()}
              className={[
                'cal-week-row',
                isSelected ? 'cal-week-row-selected' : '',
                isTodayDay ? 'cal-week-row-today' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelectDay(day)}
            >
              {/* Date header */}
              <div className="cal-week-row-date">
                <span className={[
                  'cal-week-day-num',
                  dayNum === 0 ? 'cal-sunday' : dayNum === 6 ? 'cal-saturday' : '',
                ].filter(Boolean).join(' ')}>
                  {format(day, 'M/d')}
                </span>
                {ddayForDay != null && (
                  <span className="cal-week-dday">D+{ddayForDay}</span>
                )}
                {isTodayDay && <span className="cal-week-today-badge">{t('history.today')}</span>}
              </div>

              {/* Summary chips */}
              <div className="cal-week-chips">
                {(peeCount > 0 || poopCount > 0) && (
                  <span className="cal-chip cal-chip-sage">
                    {peeCount > 0 && `${t('event.pee')} ${peeCount}`}
                    {peeCount > 0 && poopCount > 0 && ' · '}
                    {poopCount > 0 && `${t('event.poop')} ${poopCount}`}
                  </span>
                )}
                {(breastCount > 0 || formulaCount > 0) && (
                  <span className="cal-chip cal-chip-peach">
                    {breastCount > 0 && `${t('event.breast')} ${breastCount}`}
                    {breastCount > 0 && formulaCount > 0 && ' · '}
                    {formulaCount > 0 && (formulaMl > 0 ? `${t('event.formula')} ${formulaMl}ml` : `${t('event.formula')} ${formulaCount}`)}
                  </span>
                )}
                {hasHighTemp && (
                  <span className="cal-chip cal-chip-red">{t('history.tempHighIndicator')}</span>
                )}
              </div>

              {/* Time preview */}
              {timePreview.length > 0 && (
                <div className="cal-week-times">
                  {timePreview.join(' · ')}
                  {indicators.length > 3 && ` +${indicators.length - 3}`}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Day View (existing timeline wrapped)
// ---------------------------------------------------------------------------
interface DayViewProps {
  selectedDate: Date
  allEvents: DiaryEvent[]
  filterType: EventType | null
  onFilterChange: (t: EventType | null) => void
  onPrevDay: () => void
  onNextDay: () => void
  onGoToday: () => void
  milestones: Milestone[]
  guidanceItems: GuidanceItem[]
  birthdate?: string
}

function DayView({ selectedDate, allEvents, filterType, onFilterChange, onPrevDay, onNextDay, onGoToday, milestones, guidanceItems, birthdate }: DayViewProps) {
  const { t, i18n: i18nInstance } = useTranslation()
  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const lang = i18nInstance.language

  const TYPES: { type: EventType; labelKey: string }[] = [
    { type: 'pee',     labelKey: 'event.pee' },
    { type: 'poop',    labelKey: 'event.poop' },
    { type: 'temp',    labelKey: 'event.temp' },
    { type: 'breast',  labelKey: 'event.breast' },
    { type: 'formula', labelKey: 'event.formula' },
    { type: 'diary',   labelKey: 'event.diary' },
    { type: 'message', labelKey: 'event.message' },
  ]

  const dayEvents = allEvents.filter(e => !e.deleted && isSameDay(parseISO(e.at), selectedDate))
    .sort((a, b) => b.at.localeCompare(a.at))
  const filtered = filterType ? dayEvents.filter(e => e.type === filterType) : dayEvents

  const dayNum = getDay(selectedDate)
  const dayStr = format(selectedDate, 'yyyy-MM-dd')
  const dayMilestones = milestones.filter(m => m.date === dayStr)

  // Age-specific guidance items for this day
  const dayGuidance = useMemo(() => {
    if (!birthdate) return [] as GuidanceItem[]
    const birth = parseISO(birthdate)
    const ageInDays = differenceInDays(selectedDate, birth)
    if (ageInDays < 0) return [] as GuidanceItem[]
    // On birth day (day 0) include safety pinToSettings items
    return guidanceItems.filter(g => {
      if (ageInDays === 0) return g.startDay === 0
      return !g.pinToSettings && g.startDay === ageInDays
    })
  }, [selectedDate, birthdate, guidanceItems])

  const disclaimer = lang === 'ja' ? GUIDANCE_DISCLAIMER_JA : GUIDANCE_DISCLAIMER_KO

  return (
    <div className="cal-day">
      {/* Day navigation */}
      <div className="cal-nav">
        <button className="btn-secondary cal-nav-arrow" onClick={onPrevDay} aria-label="prev day">
          <IconChevronLeft size={16} color="var(--stone-600)" />
        </button>
        <div className={[
          'cal-nav-title',
          dayNum === 0 ? 'cal-sunday' : dayNum === 6 ? 'cal-saturday' : '',
        ].filter(Boolean).join(' ')}>
          {format(selectedDate, t('date.formatLong'), { locale: dateFnsLocale })}
        </div>
        <button className="btn-secondary cal-nav-arrow" onClick={onNextDay} aria-label="next day">
          <IconChevronRight size={16} color="var(--stone-600)" />
        </button>
        {!isToday(selectedDate) && (
          <button className="btn-secondary" style={{ marginLeft: 4 }} onClick={onGoToday}>
            {t('history.today')}
          </button>
        )}
      </div>

      {/* Milestone banner cards */}
      {dayMilestones.map(m => (
        <div key={m.id} className="day-banner-festive" style={{ marginBottom: 10 }}>
          <div className="day-banner-festive-header">
            <IconStar size={14} color="var(--rose-500)" />
            <span className="day-banner-festive-name">
              {lang === 'ja' ? m.nameJa : m.nameKo}
            </span>
          </div>
          <div className="day-banner-festive-desc">
            {lang === 'ja' ? m.descJa : m.descKo}
          </div>
        </div>
      ))}

      {/* Guidance info cards */}
      {dayGuidance.map(g => (
        <div key={g.id} className="day-banner-info" style={{ marginBottom: 10 }}>
          <div className="day-banner-info-header">
            <IconInfo size={14} color="var(--sky-text)" />
            <span className="day-banner-info-title">
              {lang === 'ja' ? g.titleJa : g.titleKo}
            </span>
          </div>
          <div className="day-banner-info-body">
            {lang === 'ja' ? g.bodyJa : g.bodyKo}
          </div>
          <div className="day-banner-info-meta">
            <span>{g.source}</span>
            <span className="day-banner-info-disclaimer">{disclaimer}</span>
          </div>
        </div>
      ))}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          className={`filter-chip${filterType === null ? ' active' : ''}`}
          onClick={() => onFilterChange(null)}
        >
          {t('history.filterAll')}
        </button>
        {TYPES.map(({ type, labelKey }) => (
          <button
            key={type}
            className={`filter-chip${filterType === type ? ' active' : ''}`}
            onClick={() => onFilterChange(filterType === type ? null : type)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="card">
        <EventTimeline events={filtered} showAuthor editable />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HistoryPage (top-level with mode switcher + breadcrumb)
// ---------------------------------------------------------------------------
export function HistoryPage() {
  const events = useAppStore(s => s.events)
  const settings = useAppStore(s => s.settings)
  const [view, setView] = useState<CalendarView>('month')
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [displayMonth, setDisplayMonth] = useState(new Date())
  const [displayWeek, setDisplayWeek] = useState(new Date())
  const [filterType, setFilterType] = useState<EventType | null>(null)
  const { t } = useTranslation()

  const allEvents = useMemo(() =>
    events.filter(e => !e.deleted),
    [events]
  )

  const birthdate = settings?.baby?.birthdate
  const gender = settings?.baby?.gender

  const milestones = useMemo(
    () => birthdate ? getMilestones(birthdate, gender) : [],
    [birthdate, gender]
  )

  const guidanceItems = useMemo(() => GUIDANCE_ITEMS, [])

  // Navigate to month view keeping selected month
  const goToView = (v: CalendarView, date?: Date) => {
    const d = date ?? selectedDate
    setSelectedDate(d)
    setDisplayMonth(d)
    setDisplayWeek(d)
    setView(v)
  }

  // Month view handlers
  const handleMonthDaySelect = (date: Date) => {
    setSelectedDate(date)
    setDisplayWeek(date)
    setView('week')
  }

  // Week view handlers
  const handleWeekDaySelect = (date: Date) => {
    setSelectedDate(date)
    setView('day')
  }

  // Day view handlers
  const handleDayPrev = () => {
    const d = subDays(selectedDate, 1)
    setSelectedDate(d)
    setDisplayWeek(d)
  }
  const handleDayNext = () => {
    const d = addDays(selectedDate, 1)
    setSelectedDate(d)
    setDisplayWeek(d)
  }
  const handleDayGoToday = () => {
    const d = new Date()
    setSelectedDate(d)
    setDisplayMonth(d)
    setDisplayWeek(d)
  }

  const VIEW_OPTIONS: { v: CalendarView; label: string }[] = [
    { v: 'month', label: t('history.viewMonth') },
    { v: 'week',  label: t('history.viewWeek') },
    { v: 'day',   label: t('history.viewDay') },
  ]

  return (
    <div className="page-container" data-tour="calendar">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div className="page-title">{t('history.title')}</div>
      </div>

      {/* View switcher pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="cal-view-switcher">
          {VIEW_OPTIONS.map(({ v, label }) => (
            <button
              key={v}
              className={`cal-view-btn${view === v ? ' active' : ''}`}
              onClick={() => goToView(v)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Breadcrumb back buttons */}
        {view === 'week' && (
          <button
            className="btn-secondary cal-breadcrumb"
            onClick={() => setView('month')}
          >
            <IconChevronLeft size={13} color="var(--stone-600)" />
            {t('history.viewMonth')}
          </button>
        )}
        {view === 'day' && (
          <>
            <button
              className="btn-secondary cal-breadcrumb"
              onClick={() => setView('month')}
            >
              <IconChevronLeft size={13} color="var(--stone-600)" />
              {t('history.viewMonth')}
            </button>
            <button
              className="btn-secondary cal-breadcrumb"
              onClick={() => setView('week')}
            >
              <IconChevronLeft size={13} color="var(--stone-600)" />
              {t('history.viewWeek')}
            </button>
          </>
        )}
      </div>

      {/* View content */}
      {view === 'month' && (
        <MonthView
          selectedDate={selectedDate}
          displayMonth={displayMonth}
          allEvents={allEvents}
          onSelectDay={handleMonthDaySelect}
          onPrevMonth={() => setDisplayMonth(m => subMonths(m, 1))}
          onNextMonth={() => setDisplayMonth(m => addMonths(m, 1))}
          milestones={milestones}
          guidanceItems={guidanceItems}
          birthdate={birthdate}
        />
      )}
      {view === 'week' && (
        <WeekView
          selectedDate={selectedDate}
          displayWeek={displayWeek}
          allEvents={allEvents}
          settings={settings}
          onSelectDay={handleWeekDaySelect}
          onPrevWeek={() => setDisplayWeek(w => subWeeks(w, 1))}
          onNextWeek={() => setDisplayWeek(w => addWeeks(w, 1))}
        />
      )}
      {view === 'day' && (
        <DayView
          selectedDate={selectedDate}
          allEvents={allEvents}
          filterType={filterType}
          onFilterChange={setFilterType}
          onPrevDay={handleDayPrev}
          onNextDay={handleDayNext}
          onGoToday={handleDayGoToday}
          milestones={milestones}
          guidanceItems={guidanceItems}
          birthdate={birthdate}
        />
      )}
    </div>
  )
}
