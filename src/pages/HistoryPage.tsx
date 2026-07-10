import React, { useState } from 'react'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import { format, addDays, subDays, isToday, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { EventTimeline } from '../components/EventTimeline'
import { EventType } from '../../shared/types'
import { eventLabel } from '../components/EventIcon'

const TYPES: { type: EventType; label: string }[] = [
  { type: 'pee',     label: '소변' },
  { type: 'poop',    label: '대변' },
  { type: 'temp',    label: '체온' },
  { type: 'breast',  label: '모유' },
  { type: 'formula', label: '분유' },
  { type: 'diary',   label: '일기' },
  { type: 'message', label: '아기에게' },
]

export function HistoryPage() {
  const eventsForDay = useAppStore(s => s.eventsForDay)
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [filterType, setFilterType] = useState<EventType | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)

  const allEvents = eventsForDay(selectedDate)
  const filtered = filterType ? allEvents.filter(e => e.type === filterType) : allEvents

  const goToday = () => setSelectedDate(new Date())
  const goPrev  = () => setSelectedDate(d => subDays(d, 1))
  const goNext  = () => setSelectedDate(d => addDays(d, 1))

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-title">기록</div>
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
            {format(selectedDate, 'M월 d일 (EEEEE)', { locale: ko })}
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
          <button className="btn-secondary" onClick={goToday}>오늘</button>
        )}
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          className={`filter-chip${filterType === null ? ' active' : ''}`}
          onClick={() => setFilterType(null)}
        >
          전체
        </button>
        {TYPES.map(({ type, label }) => (
          <button
            key={type}
            className={`filter-chip${filterType === type ? ' active' : ''}`}
            onClick={() => setFilterType(t => t === type ? null : type)}
          >
            {label}
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
