import React, { useEffect, useState, useRef, useCallback } from 'react'
import { Droplets, Wind, Thermometer, Heart, Baby, Clock } from 'lucide-react'
import { useAppStore, formatTime } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { EventTimeline } from '../components/EventTimeline'
import { TimeEditModal } from '../components/TimeEditModal'
import { DiaryEvent, BreastData, FormulaData } from '../../shared/types'
import { formatDistanceStrict, parseISO, differenceInMinutes } from 'date-fns'
import { ko } from 'date-fns/locale'

// ---------------------------------------------------------------------------
// Last feeding badge
// ---------------------------------------------------------------------------
function LastFeedingBadge() {
  const lastFeeding = useAppStore(s => s.lastFeeding())
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  if (!lastFeeding) return null

  const minutes = differenceInMinutes(new Date(), parseISO(lastFeeding.at))
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60

  const label =
    hours > 0
      ? `${hours}시간 ${mins}분 전`
      : `${mins}분 전`

  const type = lastFeeding.type === 'breast' ? '모유' : '분유'

  return (
    <div className="badge-feeding">
      <Clock size={13} />
      마지막 {type} 후 {label}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Summary pills
// ---------------------------------------------------------------------------
function TodaySummary() {
  const peeCount     = useAppStore(s => s.todayPeeCount())
  const poopCount    = useAppStore(s => s.todayPoopCount())
  const feedCount    = useAppStore(s => s.todayFeedingCount())
  const formulaMl    = useAppStore(s => s.todayFormulaTotalMl())

  return (
    <div className="summary-pills">
      <div className="summary-pill">소변 {peeCount}회</div>
      <div className="summary-pill">대변 {poopCount}회</div>
      <div className="summary-pill">수유 {feedCount}회</div>
      {formulaMl > 0 && (
        <div className="summary-pill">분유 총 {formulaMl}ml</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Temperature popover
// ---------------------------------------------------------------------------
interface TempPopoverProps {
  anchor: DOMRect
  onConfirm: (celsius: number) => void
  onClose: () => void
}

function TempPopover({ anchor, onConfirm, onClose }: TempPopoverProps) {
  const [value, setValue] = useState('37.0')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 80),
  }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="label">체온 입력</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <input
            ref={inputRef}
            type="number"
            step="0.1"
            min="35"
            max="42"
            className="input-field"
            style={{ width: 100 }}
            value={value}
            onChange={e => setValue(e.target.value)}
          />
          <span style={{ fontSize: 14, color: 'var(--stone-600)', fontWeight: 600 }}>℃</span>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>취소</button>
          <button
            className="btn-primary"
            onClick={() => {
              const n = parseFloat(value)
              if (!isNaN(n)) onConfirm(n)
            }}
          >
            기록
          </button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Breast popover
// ---------------------------------------------------------------------------
interface BreastPopoverProps {
  anchor: DOMRect
  onConfirm: (side: 'L' | 'R' | 'both', minutes?: number) => void
  onClose: () => void
}

function BreastPopover({ anchor, onConfirm, onClose }: BreastPopoverProps) {
  const [side, setSide] = useState<'L' | 'R' | 'both'>('both')
  const [minutes, setMinutes] = useState('')

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 60),
  }

  const SIDES: { value: 'L' | 'R' | 'both'; label: string }[] = [
    { value: 'L', label: '왼쪽' },
    { value: 'R', label: '오른쪽' },
    { value: 'both', label: '양쪽' },
  ]

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="label" style={{ marginBottom: 8 }}>모유 수유</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {SIDES.map(({ value, label }) => (
            <button
              key={value}
              className={`role-btn${side === value ? ' selected' : ''}`}
              onClick={() => setSide(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="label">수유 시간 (선택)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <input
            type="number"
            min="1"
            max="120"
            className="input-field"
            style={{ width: 80 }}
            value={minutes}
            onChange={e => setMinutes(e.target.value)}
            placeholder="분"
          />
          <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>분</span>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>취소</button>
          <button
            className="btn-primary"
            onClick={() => {
              const m = minutes ? parseInt(minutes, 10) : undefined
              onConfirm(side, isNaN(m as number) ? undefined : m)
            }}
          >
            기록
          </button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Formula popover
// ---------------------------------------------------------------------------
interface FormulaPopoverProps {
  anchor: DOMRect
  onConfirm: (ml: number) => void
  onClose: () => void
}

function FormulaPopover({ anchor, onConfirm, onClose }: FormulaPopoverProps) {
  const [ml, setMl] = useState(120)
  const SHORTCUTS = [60, 80, 100, 120, 150, 180]

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 80),
  }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="label" style={{ marginBottom: 8 }}>분유량</div>
        <div className="stepper" style={{ marginBottom: 10 }}>
          <button className="stepper-btn" onClick={() => setMl(v => Math.max(0, v - 10))}>−</button>
          <div className="stepper-value">{ml}</div>
          <span style={{ fontSize: 12, color: 'var(--stone-500)', paddingRight: 6 }}>ml</span>
          <button className="stepper-btn" onClick={() => setMl(v => v + 10)}>+</button>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
          {SHORTCUTS.map(v => (
            <button
              key={v}
              className={`filter-chip${ml === v ? ' active' : ''}`}
              onClick={() => setMl(v)}
            >
              {v}ml
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>취소</button>
          <button className="btn-primary" onClick={() => onConfirm(ml)}>기록</button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main HomePage
// ---------------------------------------------------------------------------

type ActivePopover = 'temp' | 'breast' | 'formula' | null

export function HomePage() {
  const { addPee, addPoop, addTemp, addBreast, addFormula, editEvent, softDeleteEvent, todayEvents } = useAppStore()
  const { showToast } = useToast()
  const [popover, setPopover] = useState<{ type: ActivePopover; anchor: DOMRect } | null>(null)
  const [timeEditEvent, setTimeEditEvent] = useState<DiaryEvent | null>(null)

  const today = todayEvents()

  // Quick record with undo + time-edit toast
  const quickRecord = useCallback(async (
    recordFn: () => Promise<DiaryEvent>,
    label: string
  ) => {
    const event = await recordFn()
    showToast({
      message: `${label} 기록 완료 (${formatTime(event.at)})`,
      undoLabel: '실행취소',
      onUndo: async () => { await softDeleteEvent(event) },
      onTimeEdit: () => setTimeEditEvent(event),
    })
  }, [showToast, softDeleteEvent])

  const handlePee = () => quickRecord(() => addPee(), '소변')
  const handlePoop = () => quickRecord(() => addPoop(), '대변')

  const openPopover = (type: ActivePopover, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPopover({ type, anchor: rect })
  }

  const handleTempConfirm = async (celsius: number) => {
    setPopover(null)
    await quickRecord(() => addTemp(celsius), `체온 ${celsius.toFixed(1)}℃`)
  }

  const handleBreastConfirm = async (side: 'L' | 'R' | 'both', minutes?: number) => {
    setPopover(null)
    const label = side === 'L' ? '모유(왼쪽)' : side === 'R' ? '모유(오른쪽)' : '모유(양쪽)'
    await quickRecord(() => addBreast(side, minutes), label)
  }

  const handleFormulaConfirm = async (ml: number) => {
    setPopover(null)
    await quickRecord(() => addFormula(ml), `분유 ${ml}ml`)
  }

  const handleTimeEditConfirm = async (newAt: string) => {
    if (!timeEditEvent) return
    await editEvent(timeEditEvent, { at: newAt })
    setTimeEditEvent(null)
    showToast({ message: '시간이 수정되었습니다.' })
  }

  return (
    <div className="page-container">
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div className="page-title">오늘</div>
          <div style={{ fontSize: 12, color: 'var(--stone-500)', marginTop: 2 }}>
            {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}
          </div>
        </div>
        <LastFeedingBadge />
      </div>

      {/* Quick record buttons */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 10,
        marginBottom: 16,
      }}>
        <button className="quick-btn quick-btn-pee" onClick={handlePee}>
          <Droplets size={24} />
          <span>소변</span>
        </button>
        <button className="quick-btn quick-btn-poop" onClick={handlePoop}>
          <Wind size={24} />
          <span>대변</span>
        </button>
        <button
          className="quick-btn quick-btn-temp"
          onClick={e => openPopover('temp', e)}
        >
          <Thermometer size={24} />
          <span>체온</span>
        </button>
        <button
          className="quick-btn quick-btn-breast"
          onClick={e => openPopover('breast', e)}
        >
          <Heart size={24} />
          <span>모유</span>
        </button>
        <button
          className="quick-btn quick-btn-formula"
          onClick={e => openPopover('formula', e)}
        >
          <Baby size={24} />
          <span>분유</span>
        </button>
      </div>

      {/* Today summary */}
      <div style={{ marginBottom: 20 }}>
        <TodaySummary />
      </div>

      <hr className="divider" style={{ marginBottom: 16 }} />

      {/* Today's timeline */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--stone-500)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        오늘 기록
      </div>
      <div className="card">
        <EventTimeline events={today} showAuthor editable />
      </div>

      {/* Popovers */}
      {popover?.type === 'temp' && (
        <TempPopover
          anchor={popover.anchor}
          onConfirm={handleTempConfirm}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.type === 'breast' && (
        <BreastPopover
          anchor={popover.anchor}
          onConfirm={handleBreastConfirm}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.type === 'formula' && (
        <FormulaPopover
          anchor={popover.anchor}
          onConfirm={handleFormulaConfirm}
          onClose={() => setPopover(null)}
        />
      )}

      {/* Time edit modal */}
      {timeEditEvent && (
        <TimeEditModal
          currentAt={timeEditEvent.at}
          onConfirm={handleTimeEditConfirm}
          onClose={() => setTimeEditEvent(null)}
        />
      )}
    </div>
  )
}
