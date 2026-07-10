import React, { useEffect, useState, useRef, useCallback } from 'react'
import { Droplets, Wind, Thermometer, Heart, Baby, Clock } from 'lucide-react'
import { useAppStore, formatTime, getDDay } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { EventTimeline } from '../components/EventTimeline'
import { TimeEditModal } from '../components/TimeEditModal'
import { DiaryEvent, BreastData, FormulaData } from '../../shared/types'
import { differenceInMinutes, format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// Hero header strip (date + D+N + last feeding badge)
// ---------------------------------------------------------------------------
interface HomeHeroProps {
  onNavigateSettings: () => void
}

function HomeHero({ onNavigateSettings }: HomeHeroProps) {
  const lastFeeding = useAppStore(s => s.lastFeeding())
  const settings = useAppStore(s => s.settings)
  const [, setTick] = useState(0)
  const { t, i18n: i18nInstance } = useTranslation()

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const dateStr = format(new Date(), t('date.formatLong'), { locale: dateFnsLocale })

  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null

  let feedingBadge: React.ReactNode
  if (lastFeeding) {
    const minutes = differenceInMinutes(new Date(), parseISO(lastFeeding.at))
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    const timeStr = hours > 0
      ? t('home.durationHoursMins', { hours, mins })
      : t('home.durationMins', { mins })
    const feedingType = lastFeeding.type === 'breast'
      ? t('home.breastMilk')
      : t('home.formula')
    feedingBadge = (
      <div className="badge-feeding">
        <Clock size={12} />
        {t('home.lastFeedingAgo', { type: feedingType, time: timeStr })}
      </div>
    )
  } else {
    feedingBadge = (
      <div className="badge-feeding-empty">
        <Clock size={12} />
        {t('home.noFeedingYet')}
      </div>
    )
  }

  return (
    <div className="home-hero">
      <div className="home-hero-left">
        <div className="home-hero-date">{dateStr}</div>
        {dday != null ? (
          <div className="home-hero-dday">{t('dday', { days: dday })}</div>
        ) : (
          <button
            className="home-hero-dday-btn"
            onClick={onNavigateSettings}
          >
            {t('home.setBirthday')}
          </button>
        )}
      </div>
      {feedingBadge}
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
  const { t } = useTranslation()

  return (
    <div className="summary-pills">
      <div className="summary-pill">
        <span className="summary-pill-dot" style={{ background: 'var(--sage-400)' }} />
        {t('summary.pee', { count: peeCount })}
      </div>
      <div className="summary-pill">
        <span className="summary-pill-dot" style={{ background: 'var(--sage-500)' }} />
        {t('summary.poop', { count: poopCount })}
      </div>
      <div className="summary-pill">
        <span className="summary-pill-dot" style={{ background: 'var(--peach-400)' }} />
        {t('summary.feeding', { count: feedCount })}
      </div>
      {formulaMl > 0 && (
        <div className="summary-pill">
          <span className="summary-pill-dot" style={{ background: 'var(--peach-300)' }} />
          {t('summary.formulaTotal', { ml: formulaMl })}
        </div>
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
  const { t } = useTranslation()

  useEffect(() => { inputRef.current?.focus() }, [])

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 80),
  }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="label">{t('popover.tempInput')}</div>
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
          <button className="btn-secondary" onClick={onClose}>{t('popover.cancel')}</button>
          <button
            className="btn-primary"
            onClick={() => {
              const n = parseFloat(value)
              if (!isNaN(n)) onConfirm(n)
            }}
          >
            {t('popover.record')}
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
  const { t } = useTranslation()

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 60),
  }

  const SIDES: { value: 'L' | 'R' | 'both'; label: string }[] = [
    { value: 'L', label: t('breast.left') },
    { value: 'R', label: t('breast.right') },
    { value: 'both', label: t('breast.both') },
  ]

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="label" style={{ marginBottom: 8 }}>{t('popover.breastFeeding')}</div>
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
        <div className="label">{t('popover.feedingDuration')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <input
            type="number"
            min="1"
            max="120"
            className="input-field"
            style={{ width: 80 }}
            value={minutes}
            onChange={e => setMinutes(e.target.value)}
            placeholder={t('popover.minutesPlaceholder')}
          />
          <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>{t('popover.minutesPlaceholder')}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>{t('popover.cancel')}</button>
          <button
            className="btn-primary"
            onClick={() => {
              const m = minutes ? parseInt(minutes, 10) : undefined
              onConfirm(side, isNaN(m as number) ? undefined : m)
            }}
          >
            {t('popover.record')}
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
  const { t } = useTranslation()

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 80),
  }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style}>
        <div className="label" style={{ marginBottom: 8 }}>{t('popover.formulaAmount')}</div>
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
          <button className="btn-secondary" onClick={onClose}>{t('popover.cancel')}</button>
          <button className="btn-primary" onClick={() => onConfirm(ml)}>{t('popover.record')}</button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main HomePage
// ---------------------------------------------------------------------------

type ActivePopover = 'temp' | 'breast' | 'formula' | null

interface HomePageProps {
  onNavigate?: (page: 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings') => void
}

export function HomePage({ onNavigate }: HomePageProps) {
  const { addPee, addPoop, addTemp, addBreast, addFormula, editEvent, softDeleteEvent, todayEvents } = useAppStore()
  const { showToast } = useToast()
  const { t } = useTranslation()
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
      message: t('toast.recorded', { label, time: formatTime(event.at) }),
      undoLabel: t('toast.undo'),
      onUndo: async () => { await softDeleteEvent(event) },
      onTimeEdit: () => setTimeEditEvent(event),
    })
  }, [showToast, softDeleteEvent, t])

  const handlePee = () => quickRecord(() => addPee(), t('quickBtn.pee'))
  const handlePoop = () => quickRecord(() => addPoop(), t('quickBtn.poop'))

  const openPopover = (type: ActivePopover, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPopover({ type, anchor: rect })
  }

  const handleTempConfirm = async (celsius: number) => {
    setPopover(null)
    await quickRecord(() => addTemp(celsius), `${t('quickBtn.temp')} ${celsius.toFixed(1)}℃`)
  }

  const handleBreastConfirm = async (side: 'L' | 'R' | 'both', minutes?: number) => {
    setPopover(null)
    const sideLabel = side === 'L'
      ? t('breast.left')
      : side === 'R'
        ? t('breast.right')
        : t('breast.both')
    const label = `${t('quickBtn.breast')}(${sideLabel})`
    await quickRecord(() => addBreast(side, minutes), label)
  }

  const handleFormulaConfirm = async (ml: number) => {
    setPopover(null)
    await quickRecord(() => addFormula(ml), `${t('quickBtn.formula')} ${ml}ml`)
  }

  const handleTimeEditConfirm = async (newAt: string) => {
    if (!timeEditEvent) return
    await editEvent(timeEditEvent, { at: newAt })
    setTimeEditEvent(null)
    showToast({ message: t('toast.timeEdited') })
  }

  return (
    <div className="page-container">
      {/* Hero header strip */}
      <HomeHero onNavigateSettings={() => onNavigate?.('settings')} />

      {/* Quick record buttons */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 10,
        marginBottom: 16,
      }}>
        <button className="quick-btn quick-btn-pee" onClick={handlePee}>
          <Droplets size={26} />
          <span>{t('quickBtn.pee')}</span>
        </button>
        <button className="quick-btn quick-btn-poop" onClick={handlePoop}>
          <Wind size={26} />
          <span>{t('quickBtn.poop')}</span>
        </button>
        <button
          className="quick-btn quick-btn-temp"
          onClick={e => openPopover('temp', e)}
        >
          <Thermometer size={26} />
          <span>{t('quickBtn.temp')}</span>
        </button>
        <button
          className="quick-btn quick-btn-breast"
          onClick={e => openPopover('breast', e)}
        >
          <Heart size={26} />
          <span>{t('quickBtn.breast')}</span>
        </button>
        <button
          className="quick-btn quick-btn-formula"
          onClick={e => openPopover('formula', e)}
        >
          <Baby size={26} />
          <span>{t('quickBtn.formula')}</span>
        </button>
      </div>

      {/* Today summary */}
      <div style={{ marginBottom: 20 }}>
        <TodaySummary />
      </div>

      <hr className="divider" style={{ marginBottom: 16 }} />

      {/* Today's timeline */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--stone-500)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {t('home.todayRecords')}
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
