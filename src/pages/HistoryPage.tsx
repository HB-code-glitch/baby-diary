import React, { useMemo, useRef, useState } from 'react'
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDay,
  isSameDay,
  isSameMonth,
  isToday,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'
import { ja, ko } from 'date-fns/locale'
import { useTranslation } from 'react-i18next'
import { IconChevronLeft, IconChevronRight, IconInfo, IconStar } from '../components/icons'
import { EventTimeline } from '../components/EventTimeline'
import { GUIDANCE_DISCLAIMER_JA, GUIDANCE_DISCLAIMER_KO, GUIDANCE_ITEMS, type GuidanceItem } from '../lib/guidance'
import { getMilestones, type Milestone } from '../lib/milestones'
import { useAppStore } from '../store/useAppStore'
import type { DiaryEvent, EventType } from '../../shared/types'

type CalendarView = 'month' | 'week' | 'day'
type Translate = ReturnType<typeof useTranslation>['t']

const EVENT_TYPE_OPTIONS: { type: EventType; labelKey: string; summaryLabelKey?: string }[] = [
  { type: 'pee', labelKey: 'event.pee' },
  { type: 'poop', labelKey: 'event.poop' },
  { type: 'temp', labelKey: 'event.temp', summaryLabelKey: 'history.tempIndicator' },
  { type: 'breast', labelKey: 'event.breast' },
  { type: 'formula', labelKey: 'event.formula' },
  { type: 'diary', labelKey: 'event.diary' },
  { type: 'message', labelKey: 'event.message' },
  { type: 'sleep', labelKey: 'event.sleep' },
  { type: 'growth', labelKey: 'event.growth' },
]

const WEEKDAY_KEYS = [
  'weekdaySun',
  'weekdayMon',
  'weekdayTue',
  'weekdayWed',
  'weekdayThu',
  'weekdayFri',
  'weekdaySat',
] as const

type EventsByLocalDay = ReadonlyMap<string, readonly DiaryEvent[]>

const EMPTY_DAY_EVENTS: readonly DiaryEvent[] = []

// History follows the device-local day boundary used throughout the app. Build
// one immutable lookup per store snapshot so month/week/day consumers never
// rescan and reparse the full event list for every rendered calendar cell.
export function groupEventsByLocalDay(events: readonly DiaryEvent[]): EventsByLocalDay {
  const grouped = new Map<string, DiaryEvent[]>()

  events.forEach(event => {
    if (event.deleted) return
    const parsedAt = parseISO(event.at)
    if (!isValid(parsedAt)) return
    const dayKey = format(parsedAt, 'yyyy-MM-dd')
    const bucket = grouped.get(dayKey)
    if (bucket) bucket.push(event)
    else grouped.set(dayKey, [event])
  })

  grouped.forEach(bucket => bucket.sort((a, b) => b.at.localeCompare(a.at)))
  return grouped
}

function eventsForDay(eventsByDay: EventsByLocalDay, date: Date): readonly DiaryEvent[] {
  return eventsByDay.get(format(date, 'yyyy-MM-dd')) ?? EMPTY_DAY_EVENTS
}

function eventCounts(events: readonly DiaryEvent[]): Record<EventType, number> {
  const counts: Record<EventType, number> = {
    pee: 0,
    poop: 0,
    temp: 0,
    breast: 0,
    formula: 0,
    diary: 0,
    message: 0,
    sleep: 0,
    growth: 0,
  }
  events.forEach(event => { counts[event.type] += 1 })
  return counts
}

function categorySummaryParts(events: readonly DiaryEvent[], t: Translate): string[] {
  const counts = eventCounts(events)
  return EVENT_TYPE_OPTIONS
    .filter(({ type }) => counts[type] > 0)
    .map(({ type, labelKey, summaryLabelKey }) => `${t(summaryLabelKey ?? labelKey)} ${counts[type]}`)
}

function categorySummary(events: readonly DiaryEvent[], t: Translate): string {
  return categorySummaryParts(events, t).join(' · ')
}

function conciseCategorySummary(events: readonly DiaryEvent[], t: Translate): string {
  const parts = categorySummaryParts(events, t)
  if (parts.length <= 3) return parts.join(' · ')
  return `${parts.slice(0, 3).join(' · ')} · ${t('history.moreCategories', { count: parts.length - 3 })}`
}

interface MonthViewProps {
  selectedDate: Date
  displayMonth: Date
  eventsByDay: EventsByLocalDay
  onSelectDay: (date: Date) => void
  milestones: Milestone[]
  guidanceItems: GuidanceItem[]
  birthdate?: string
}

function MonthView({
  selectedDate,
  displayMonth,
  eventsByDay,
  onSelectDay,
  milestones,
  guidanceItems,
  birthdate,
}: MonthViewProps) {
  const { t } = useTranslation()
  const monthStart = startOfMonth(displayMonth)
  const monthEnd = endOfMonth(displayMonth)
  const days = eachDayOfInterval({
    start: startOfWeek(monthStart, { weekStartsOn: 0 }),
    end: endOfWeek(monthEnd, { weekStartsOn: 0 }),
  })

  return (
    <div className="card cal-month">
      <div className="cal-grid-7" aria-hidden="true">
        {WEEKDAY_KEYS.map((key, index) => (
          <div
            key={key}
            className={`cal-weekday-header${index === 0 ? ' cal-sunday' : index === 6 ? ' cal-saturday' : ''}`}
          >
            {t(`history.${key}`)}
          </div>
        ))}
      </div>

      <div className="cal-grid-7">
        {days.map(day => (
          <MonthDayCell
            key={day.toISOString()}
            day={day}
            displayMonth={displayMonth}
            selectedDate={selectedDate}
            eventsByDay={eventsByDay}
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
  eventsByDay: EventsByLocalDay
  onSelect: (date: Date) => void
  milestones: Milestone[]
  guidanceItems: GuidanceItem[]
  birthdate?: string
}

function MonthDayCell({
  day,
  displayMonth,
  selectedDate,
  eventsByDay,
  onSelect,
  milestones,
  guidanceItems,
  birthdate,
}: MonthDayCellProps) {
  const { t, i18n } = useTranslation()
  const dayEvents = eventsForDay(eventsByDay, day)
  const summary = categorySummary(dayEvents, t)
  const dayString = format(day, 'yyyy-MM-dd')
  const dayMilestones = milestones.filter(milestone => milestone.date === dayString)
  const dayGuidance = birthdate
    ? guidanceItems.filter(item => {
        if (item.pinToSettings) return false
        return item.startDay === differenceInDays(day, parseISO(birthdate))
      })
    : []
  const milestoneName = dayMilestones[0]
    ? (i18n.language === 'ja' ? dayMilestones[0].nameJa : dayMilestones[0].nameKo)
    : ''
  const guidanceTitle = dayGuidance[0]
    ? (i18n.language === 'ja' ? dayGuidance[0].titleJa : dayGuidance[0].titleKo)
    : ''
  const accessibleSummary = dayEvents.length > 0
    ? `${t('history.eventCount', { count: dayEvents.length })}, ${summary}`
    : t('history.noRecords')
  const ariaLabel = [dayString, accessibleSummary, milestoneName, guidanceTitle].filter(Boolean).join(', ')
  const dayNumber = getDay(day)

  return (
    <button
      type="button"
      className={[
        'cal-day-cell',
        !isSameMonth(day, displayMonth) ? 'cal-day-other-month' : '',
        isToday(day) ? 'cal-day-today' : '',
        isSameDay(day, selectedDate) ? 'cal-day-selected' : '',
        dayNumber === 0 ? 'cal-sunday' : dayNumber === 6 ? 'cal-saturday' : '',
      ].filter(Boolean).join(' ')}
      data-history-date={dayString}
      onClick={() => onSelect(day)}
      aria-label={ariaLabel}
      aria-pressed={isSameDay(day, selectedDate)}
    >
      <span className="cal-day-num">{day.getDate()}</span>
      {dayEvents.length > 0 && (
        <span className="cal-day-event-count">{t('history.eventCount', { count: dayEvents.length })}</span>
      )}
      {(dayMilestones.length > 0 || dayGuidance.length > 0) && (
        <span className="cal-day-markers" aria-hidden="true">
          {dayMilestones.length > 0 && (
            <span className="cal-indicator cal-indicator-festive" title={milestoneName}>
              <IconStar size={9} color="currentColor" />
            </span>
          )}
          {dayGuidance.length > 0 && (
            <span className="cal-indicator cal-indicator-sky" title={guidanceTitle}>
              <IconInfo size={9} color="currentColor" />
            </span>
          )}
        </span>
      )}
    </button>
  )
}

interface WeekViewProps {
  selectedDate: Date
  displayWeek: Date
  eventsByDay: EventsByLocalDay
  birthdate?: string
  onSelectDay: (date: Date) => void
}

function WeekView({ selectedDate, displayWeek, eventsByDay, birthdate, onSelectDay }: WeekViewProps) {
  const { t, i18n } = useTranslation()
  const dateFnsLocale = i18n.language === 'ja' ? ja : ko
  const weekStart = startOfWeek(displayWeek, { weekStartsOn: 0 })
  const days = eachDayOfInterval({
    start: weekStart,
    end: endOfWeek(displayWeek, { weekStartsOn: 0 }),
  })

  return (
    <div className="card cal-week">
      <div className="cal-week-rows">
        {days.map(day => {
          const dayEvents = eventsForDay(eventsByDay, day)
          const summary = categorySummary(dayEvents, t)
          const conciseSummary = conciseCategorySummary(dayEvents, t)
          const selected = isSameDay(day, selectedDate)
          const dayNumber = getDay(day)
          const dateLabel = format(day, t('date.formatShort'), { locale: dateFnsLocale })
          const dateString = format(day, 'yyyy-MM-dd')
          const dday = birthdate ? differenceInDays(day, parseISO(birthdate)) + 1 : null
          const hasDday = dday != null && dday > 0
          const recordLabel = dayEvents.length > 0
            ? `${summary}, ${t('history.eventCount', { count: dayEvents.length })}`
            : t('history.noRecords')

          return (
            <button
              type="button"
              key={day.toISOString()}
              className={[
                'cal-week-row',
                selected ? 'cal-week-row-selected' : '',
                isToday(day) ? 'cal-week-row-today' : '',
              ].filter(Boolean).join(' ')}
              data-history-date={dateString}
              onClick={() => onSelectDay(day)}
              aria-label={`${dateLabel}, ${recordLabel}`}
              aria-pressed={selected}
            >
              <span className="cal-week-row-date">
                <span className={[
                  'cal-week-day-num',
                  dayNumber === 0 ? 'cal-sunday' : dayNumber === 6 ? 'cal-saturday' : '',
                ].filter(Boolean).join(' ')}>
                  {dateLabel}
                </span>
                <span className="cal-week-date-meta">
                  {hasDday && <span className="cal-week-dday">D+{dday}</span>}
                  {isToday(day) && <span className="cal-week-today-badge">{t('history.today')}</span>}
                </span>
              </span>
              <span className={`cal-week-summary${dayEvents.length === 0 ? ' cal-week-summary-empty' : ''}`}>
                {dayEvents.length > 0 ? conciseSummary : t('history.noRecords')}
              </span>
              {dayEvents.length > 0 && (
                <span className="cal-week-total">{t('history.eventCount', { count: dayEvents.length })}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface SelectedDayPreviewProps {
  selectedDate: Date
  eventsByDay: EventsByLocalDay
  onOpenDay: () => void
}

function SelectedDayPreview({ selectedDate, eventsByDay, onOpenDay }: SelectedDayPreviewProps) {
  const { t, i18n } = useTranslation()
  const dateFnsLocale = i18n.language === 'ja' ? ja : ko
  const selectedEvents = eventsForDay(eventsByDay, selectedDate)
  const latestEvents = selectedEvents.slice(0, 3)

  return (
    <aside className="card history-day-preview" data-history-preview aria-labelledby="history-preview-title">
      <div className="history-preview-heading">
        <div>
          <h2 id="history-preview-title">{t('history.selectedDayRecords')}</h2>
          <div className="history-preview-date">
            {format(selectedDate, t('date.formatFull'), { locale: dateFnsLocale })}
          </div>
        </div>
        <span className="history-preview-total">
          {t('history.totalCount', { count: selectedEvents.length })}
        </span>
      </div>

      <div className="history-preview-timeline">
        <EventTimeline
          events={latestEvents}
          showAuthor={false}
          editable={false}
          compact
          emptyTitle={t('history.previewEmptyTitle')}
          emptySub={t('history.previewEmptySub')}
        />
      </div>

      <button type="button" className="btn-secondary history-preview-action" onClick={onOpenDay}>
        {t('history.viewAllRecords')}
        <IconChevronRight size={15} color="currentColor" />
      </button>
    </aside>
  )
}

interface DayViewProps {
  selectedDate: Date
  eventsByDay: EventsByLocalDay
  filterType: EventType | null
  onFilterChange: (type: EventType | null) => void
  milestones: Milestone[]
  guidanceItems: GuidanceItem[]
  birthdate?: string
}

function DayView({
  selectedDate,
  eventsByDay,
  filterType,
  onFilterChange,
  milestones,
  guidanceItems,
  birthdate,
}: DayViewProps) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const dayEvents = eventsForDay(eventsByDay, selectedDate)
  const counts = eventCounts(dayEvents)
  const availableTypes = EVENT_TYPE_OPTIONS.filter(({ type }) => counts[type] > 0)
  const activeFilter = filterType && counts[filterType] > 0 ? filterType : null
  const filteredEvents = activeFilter
    ? dayEvents.filter(event => event.type === activeFilter)
    : dayEvents
  const dayString = format(selectedDate, 'yyyy-MM-dd')
  const dayMilestones = milestones.filter(milestone => milestone.date === dayString)
  const dayGuidance = useMemo(() => {
    if (!birthdate) return []
    const ageInDays = differenceInDays(selectedDate, parseISO(birthdate))
    if (ageInDays < 0) return []
    return guidanceItems.filter(item => {
      if (ageInDays === 0) return item.startDay === 0
      return !item.pinToSettings && item.startDay === ageInDays
    })
  }, [birthdate, guidanceItems, selectedDate])
  const disclaimer = language === 'ja' ? GUIDANCE_DISCLAIMER_JA : GUIDANCE_DISCLAIMER_KO

  return (
    <div className="cal-day">
      {dayMilestones.map(milestone => (
        <div key={milestone.id} className="day-banner-festive">
          <div className="day-banner-festive-header">
            <IconStar size={14} color="var(--rose-500)" />
            <span className="day-banner-festive-name">
              {language === 'ja' ? milestone.nameJa : milestone.nameKo}
            </span>
          </div>
          <div className="day-banner-festive-desc">
            {language === 'ja' ? milestone.descJa : milestone.descKo}
          </div>
        </div>
      ))}

      {dayGuidance.map(item => (
        <div key={item.id} className="day-banner-info">
          <div className="day-banner-info-header">
            <IconInfo size={14} color="var(--sky-text)" />
            <span className="day-banner-info-title">
              {language === 'ja' ? item.titleJa : item.titleKo}
            </span>
          </div>
          <div className="day-banner-info-body">
            {language === 'ja' ? item.bodyJa : item.bodyKo}
          </div>
          <div className="day-banner-info-meta">
            <span>{item.source}</span>
            <span className="day-banner-info-disclaimer">{disclaimer}</span>
          </div>
        </div>
      ))}

      <div className="history-filter-row" role="group" aria-label={t('history.filterLabel')}>
        <button
          type="button"
          className={`filter-chip${activeFilter === null ? ' active' : ''}`}
          data-history-filter="all"
          aria-pressed={activeFilter === null}
          onClick={() => onFilterChange(null)}
        >
          {t('history.filterAll')} {dayEvents.length}
        </button>
        {availableTypes.map(({ type, labelKey }) => (
          <button
            type="button"
            key={type}
            className={`filter-chip${activeFilter === type ? ' active' : ''}`}
            data-history-filter={type}
            aria-pressed={activeFilter === type}
            onClick={() => onFilterChange(activeFilter === type ? null : type)}
          >
            {t(labelKey)} {counts[type]}
          </button>
        ))}
      </div>

      <div className="card history-day-timeline-card">
        <EventTimeline
          events={filteredEvents}
          showAuthor
          editable
          emptyTitle={t('history.dayEmptyTitle')}
          emptySub={t('history.dayEmptySub')}
        />
      </div>
    </div>
  )
}

export function HistoryPage() {
  const events = useAppStore(state => state.events)
  const settings = useAppStore(state => state.settings)
  const [view, setView] = useState<CalendarView>('month')
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [displayMonth, setDisplayMonth] = useState(() => new Date())
  const [displayWeek, setDisplayWeek] = useState(() => new Date())
  const [filterType, setFilterType] = useState<EventType | null>(null)
  const tabRefs = useRef<Record<CalendarView, HTMLButtonElement | null>>({ month: null, week: null, day: null })
  const { t, i18n } = useTranslation()
  const dateFnsLocale = i18n.language === 'ja' ? ja : ko

  const eventsByDay = useMemo(() => groupEventsByLocalDay(events), [events])
  const birthdate = settings?.baby?.birthdate
  const milestones = useMemo(
    () => birthdate ? getMilestones(birthdate, settings?.baby?.gender) : [],
    [birthdate, settings?.baby?.gender],
  )
  const guidanceItems = useMemo(() => GUIDANCE_ITEMS, [])

  const setHistoryView = (nextView: CalendarView) => {
    setView(nextView)
    setDisplayMonth(selectedDate)
    setDisplayWeek(selectedDate)
    setFilterType(null)
  }

  const openSelectedDay = () => {
    setView('day')
    setDisplayMonth(selectedDate)
    setDisplayWeek(selectedDate)
    setFilterType(null)
  }

  const goToday = () => {
    const today = new Date()
    setSelectedDate(today)
    setDisplayMonth(today)
    setDisplayWeek(today)
    setFilterType(null)
  }

  const navigatePeriod = (direction: -1 | 1) => {
    if (view === 'month') {
      const nextDate = direction < 0 ? subMonths(selectedDate, 1) : addMonths(selectedDate, 1)
      setSelectedDate(nextDate)
      setDisplayMonth(nextDate)
      setDisplayWeek(nextDate)
      setFilterType(null)
      return
    }
    if (view === 'week') {
      const nextDate = direction < 0 ? subWeeks(selectedDate, 1) : addWeeks(selectedDate, 1)
      setSelectedDate(nextDate)
      setDisplayMonth(nextDate)
      setDisplayWeek(nextDate)
      setFilterType(null)
      return
    }
    const nextDate = direction < 0 ? subDays(selectedDate, 1) : addDays(selectedDate, 1)
    setSelectedDate(nextDate)
    setDisplayMonth(nextDate)
    setDisplayWeek(nextDate)
    setFilterType(null)
  }

  const selectMonthDate = (date: Date) => {
    setSelectedDate(date)
    setDisplayMonth(date)
    setDisplayWeek(date)
    setFilterType(null)
  }

  const selectWeekDate = (date: Date) => {
    setSelectedDate(date)
    setDisplayMonth(date)
    setDisplayWeek(date)
    setFilterType(null)
  }

  const periodTitle = useMemo(() => {
    if (view === 'month') {
      return t('history.monthTitle', {
        year: displayMonth.getFullYear(),
        month: displayMonth.getMonth() + 1,
      })
    }
    if (view === 'week') {
      const weekStart = startOfWeek(displayWeek, { weekStartsOn: 0 })
      const weekEnd = endOfWeek(displayWeek, { weekStartsOn: 0 })
      const firstMonth = weekStart.getMonth() + 1
      const secondMonth = weekEnd.getMonth() + 1
      return firstMonth === secondMonth
        ? t('history.weekTitleSameMonth', { month: firstMonth, d1: weekStart.getDate(), d2: weekEnd.getDate() })
        : t('history.weekTitle', {
            m1: firstMonth,
            d1: weekStart.getDate(),
            m2: secondMonth,
            d2: weekEnd.getDate(),
          })
    }
    return format(selectedDate, t('date.formatFull'), { locale: dateFnsLocale })
  }, [dateFnsLocale, displayMonth, displayWeek, selectedDate, t, view])

  const previousLabel = t(`history.previous${view[0].toUpperCase()}${view.slice(1)}`)
  const nextLabel = t(`history.next${view[0].toUpperCase()}${view.slice(1)}`)
  const viewOptions: { view: CalendarView; label: string }[] = [
    { view: 'month', label: t('history.viewMonth') },
    { view: 'week', label: t('history.viewWeek') },
    { view: 'day', label: t('history.viewDay') },
  ]

  return (
    <div className="page-container" data-tour="calendar">
      <div className="page-header history-page-header">
        <div className="page-title">{t('history.title')}</div>
      </div>

      <div className="history-toolbar" aria-label={t('history.toolbarLabel')}>
        <div
          className="cal-view-switcher"
          role="tablist"
          aria-label={t('history.viewSelectorLabel')}
          aria-orientation="horizontal"
        >
          {viewOptions.map(({ view: option, label }, index) => (
            <button
              key={option}
              ref={button => { tabRefs.current[option] = button }}
              id={`history-tab-${option}`}
              type="button"
              role="tab"
              className={`cal-view-btn${view === option ? ' active' : ''}`}
              data-history-view={option}
              aria-selected={view === option}
              aria-controls="history-view-panel"
              tabIndex={view === option ? 0 : -1}
              onClick={() => setHistoryView(option)}
              onKeyDown={keyboardEvent => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyboardEvent.key)) return
                keyboardEvent.preventDefault()
                const nextIndex = keyboardEvent.key === 'Home'
                  ? 0
                  : keyboardEvent.key === 'End'
                    ? viewOptions.length - 1
                    : (index + (keyboardEvent.key === 'ArrowRight' ? 1 : -1) + viewOptions.length) % viewOptions.length
                const nextView = viewOptions[nextIndex].view
                setHistoryView(nextView)
                tabRefs.current[nextView]?.focus()
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="history-period-nav">
          <button
            type="button"
            className="btn-secondary cal-nav-arrow"
            onClick={() => navigatePeriod(-1)}
            aria-label={previousLabel}
          >
            <IconChevronLeft size={17} color="currentColor" />
          </button>
          <h2 className="cal-nav-title" aria-live="polite">{periodTitle}</h2>
          <button
            type="button"
            className="btn-secondary history-today-button"
            onClick={goToday}
            aria-label={t('history.goToday')}
          >
            {t('history.today')}
          </button>
          <button
            type="button"
            className="btn-secondary cal-nav-arrow"
            onClick={() => navigatePeriod(1)}
            aria-label={nextLabel}
          >
            <IconChevronRight size={17} color="currentColor" />
          </button>
        </div>
      </div>

      <div
        id="history-view-panel"
        role="tabpanel"
        aria-labelledby={`history-tab-${view}`}
        className="history-view-panel"
      >
        {view === 'month' && (
          <div className="history-overview-grid">
            <MonthView
              selectedDate={selectedDate}
              displayMonth={displayMonth}
              eventsByDay={eventsByDay}
              onSelectDay={selectMonthDate}
              milestones={milestones}
              guidanceItems={guidanceItems}
              birthdate={birthdate}
            />
            <SelectedDayPreview selectedDate={selectedDate} eventsByDay={eventsByDay} onOpenDay={openSelectedDay} />
          </div>
        )}
        {view === 'week' && (
          <div className="history-overview-grid">
            <WeekView
              selectedDate={selectedDate}
              displayWeek={displayWeek}
              eventsByDay={eventsByDay}
              birthdate={birthdate}
              onSelectDay={selectWeekDate}
            />
            <SelectedDayPreview selectedDate={selectedDate} eventsByDay={eventsByDay} onOpenDay={openSelectedDay} />
          </div>
        )}
        {view === 'day' && (
          <DayView
            selectedDate={selectedDate}
            eventsByDay={eventsByDay}
            filterType={filterType}
            onFilterChange={setFilterType}
            milestones={milestones}
            guidanceItems={guidanceItems}
            birthdate={birthdate}
          />
        )}
      </div>
    </div>
  )
}
