import React, { useState } from 'react'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import { format, addDays, subDays, isToday } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { EventTimeline } from '../components/EventTimeline'
import { EventType } from '../../shared/types'
import { useTranslation } from 'react-i18next'

export function HistoryPage() {
  const eventsForDay = useAppStore(s => s.eventsForDay)
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [filterType, setFilterType] = useState<EventType | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  const TYPES: { type: EventType; labelKey: string }[] = [
    { type: 'pee',     labelKey: 'event.pee' },
    { type: 'poop',    labelKey: 'event.poop' },
    { type: 'temp',    labelKey: 'event.temp' },
    { type: 'breast',  labelKey: 'event.breast' },
    { type: 'formula', labelKey: 'event.formula' },
    { type: 'diary',   labelKey: 'event.diary' },
    { type: 'message', labelKey: 'event.message' },
  ]

  const allEvents = eventsForDay(selectedDate)
  const filtered = filterType ? allEvents.filter(e => e.type === filterType) : allEvents

  const goToday = () => setSelectedDate(new Date())
  const goPrev  = () => setSelectedDate(d => subDays(d, 1))
  const goNext  = () => setSelectedDate(d => addDays(d, 1))

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-title">{t('history.title')}</div>
      </div>

      {/* Date navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn-secondary" style={{ padding: '6px 10px' }} onClick={goPrev}>
          <ChevronLeft size={16} />
        </button>

        <div style={{ position: 'relative' }}>
          <button
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140 }}
            onClick={() => setShowDatePicker(p => !p)}
          >
            <CalendarDays size={14} />
            {format(selectedDate, t('date.formatShort'), { locale: dateFnsLocale })}
          </button>
          {showDatePicker && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 50 }}
                onClick={() => setShowDatePicker(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  zIndex: 100,
                  marginTop: 4,
                  background: 'var(--stone-50)',
                  border: '1px solid var(--stone-200)',
                  borderRadius: 10,
                  padding: 10,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                }}
              >
                <input
                  type="date"
                  className="input-field"
                  style={{ width: 160 }}
                  value={format(selectedDate, 'yyyy-MM-dd')}
                  onChange={e => {
                    const d = new Date(e.target.value)
                    if (!isNaN(d.getTime())) {
                      setSelectedDate(d)
                      setShowDatePicker(false)
                    }
                  }}
                />
              </div>
            </>
          )}
        </div>

        <button className="btn-secondary" style={{ padding: '6px 10px' }} onClick={goNext}>
          <ChevronRight size={16} />
        </button>

        {!isToday(selectedDate) && (
          <button className="btn-secondary" onClick={goToday}>{t('history.today')}</button>
        )}
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          className={`filter-chip${filterType === null ? ' active' : ''}`}
          onClick={() => setFilterType(null)}
        >
          {t('history.filterAll')}
        </button>
        {TYPES.map(({ type, labelKey }) => (
          <button
            key={type}
            className={`filter-chip${filterType === type ? ' active' : ''}`}
            onClick={() => setFilterType(tp => tp === type ? null : type)}
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
