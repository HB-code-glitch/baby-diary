import React, { useEffect, useState, useRef, useCallback } from 'react'
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconClock } from '../components/icons'
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
  const peeCount = useAppStore(s => s.todayPeeCount())
  const poopCount = useAppStore(s => s.todayPoopCount())
  const feedCount = useAppStore(s => s.todayFeedingCount())
  const formulaMl = useAppStore(s => s.todayFormulaTotalMl())
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
  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')

  let feedingBadgeContent: React.ReactNode
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
    feedingBadgeContent = (
      <div className="badge-feeding">
        <span className="breathing-dot" />
        {t('home.lastFeedingAgo', { type: feedingType, time: timeStr })}
      </div>
    )
  } else {
    feedingBadgeContent = (
      <div className="badge-feeding-empty">
        <IconClock size={12} color="var(--stone-400)" />
        {t('home.noFeedingYet')}
      </div>
    )
  }

  const statTiles = [
    { key: 'formula', num: formulaMl > 0 ? formulaMl : '-', unit: formulaMl > 0 ? 'ml' : '', label: t('stat.formulaLabel'), bg: 'var(--peach-100)', color: 'var(--peach-600)', featured: true },
    { key: 'pee', num: peeCount, unit: '', label: t('stat.peeLabel'), bg: 'var(--sage-100)', color: 'var(--sage-600)', featured: false },
    { key: 'poop', num: poopCount, unit: '', label: t('stat.poopLabel'), bg: 'var(--sage-100)', color: 'var(--sage-500)', featured: false },
    { key: 'feed', num: feedCount, unit: '', label: t('stat.feedLabel'), bg: 'var(--cream-200)', color: 'var(--stone-700)', featured: false },
  ]

  return (
    <div className="home-hero">
      <div className="home-hero-left">
        <div className="home-hero-date">{dateStr}</div>
        <div className="home-hero-baby-name">{babyName}</div>
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
        <div style={{ marginTop: 8 }}>
          {feedingBadgeContent}
        </div>
      </div>

      <div className="home-hero-right">
        <div className="stat-tile-grid">
          {statTiles.map(tile => (
            <div
              key={tile.key}
              className={`stat-tile${tile.featured ? ' stat-tile-featured' : ''}`}
              style={{ background: tile.bg }}
            >
              <div className="stat-tile-num" style={{ color: tile.color }}>
                {tile.num}
              </div>
              {tile.unit && <div className="stat-tile-unit">{tile.unit}</div>}
              <div className="stat-tile-label">{tile.label}</div>
            </div>
          ))}
        </div>
      </div>
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
  defaultValue: number
}

function TempPopover({ anchor, onConfirm, onClose, defaultValue }: TempPopoverProps) {
  const [value, setValue] = useState(defaultValue.toFixed(1))
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [])

  const handleSubmit = () => {
    const n = parseFloat(value)
    if (!isNaN(n)) onConfirm(n)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 80),
  }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <form
        className="popover"
        style={style}
        onSubmit={e => { e.preventDefault(); handleSubmit() }}
      >
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
            onKeyDown={handleKeyDown}
          />
          <span style={{ fontSize: 14, color: 'var(--stone-600)', fontWeight: 600 }}>℃</span>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>{t('popover.cancel')}</button>
          <button type="submit" className="btn-primary">{t('popover.record')}</button>
        </div>
      </form>
    </>
  )
}

// ---------------------------------------------------------------------------
// Nursing timer state (module-level so it survives popover open/close)
// V5: persisted to localStorage so app restart/reload resumes the timer.
// ---------------------------------------------------------------------------
interface NursingTimerState {
  running: boolean
  startedAt: number | null   // Date.now() when timer started
  elapsed: number            // seconds accumulated before pause (unused — always reset)
}

const NURSING_TIMER_KEY = 'babydiary.nursingTimer'

function loadNursingTimer(): NursingTimerState {
  try {
    const raw = localStorage.getItem(NURSING_TIMER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as NursingTimerState
      if (parsed.running && parsed.startedAt) {
        return parsed
      }
    }
  } catch { /* ignore */ }
  return { running: false, startedAt: null, elapsed: 0 }
}

function saveNursingTimer(state: NursingTimerState): void {
  try {
    if (state.running) {
      localStorage.setItem(NURSING_TIMER_KEY, JSON.stringify(state))
    } else {
      localStorage.removeItem(NURSING_TIMER_KEY)
    }
  } catch { /* ignore */ }
}

const nursingTimer: NursingTimerState = loadNursingTimer()

// ---------------------------------------------------------------------------
// Breast popover
// ---------------------------------------------------------------------------
interface BreastPopoverProps {
  anchor: DOMRect
  onConfirm: (side: 'L' | 'R' | 'both', minutes?: number, startedAt?: string) => void
  onClose: () => void
  lastBreastSide: 'L' | 'R' | 'both' | null
  onTimerChange: () => void  // notify parent to re-render floating pill
}

function BreastPopover({ anchor, onConfirm, onClose, lastBreastSide, onTimerChange }: BreastPopoverProps) {
  // Preselect opposite side of last feeding
  const suggestedSide: 'L' | 'R' | 'both' = lastBreastSide === 'L' ? 'R' : lastBreastSide === 'R' ? 'L' : 'both'
  const [side, setSide] = useState<'L' | 'R' | 'both'>(suggestedSide)
  const [minutes, setMinutes] = useState('')
  const [timerDisplay, setTimerDisplay] = useState<string | null>(null)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { t } = useTranslation()
  const minutesRef = useRef<HTMLInputElement>(null)

  // If timer was already running when popover opened, reflect that
  useEffect(() => {
    if (nursingTimer.running && nursingTimer.startedAt != null) {
      const sec = Math.floor((Date.now() - nursingTimer.startedAt) / 1000)
      setTimerDisplay(formatElapsed(sec))
      startDisplayInterval()
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const formatElapsed = (totalSec: number) => {
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
    const ss = String(totalSec % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const startDisplayInterval = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
    timerIntervalRef.current = setInterval(() => {
      if (nursingTimer.running && nursingTimer.startedAt != null) {
        const sec = Math.floor((Date.now() - nursingTimer.startedAt) / 1000)
        setTimerDisplay(formatElapsed(sec))
      }
    }, 1000)
  }

  const handleStartTimer = () => {
    if (!nursingTimer.running) {
      nursingTimer.running = true
      nursingTimer.startedAt = Date.now()
      saveNursingTimer(nursingTimer)
      setTimerDisplay('00:00')
      startDisplayInterval()
      onTimerChange()
    }
  }

  const handleStopAndRecord = () => {
    if (nursingTimer.running && nursingTimer.startedAt != null) {
      const elapsedSec = Math.floor((Date.now() - nursingTimer.startedAt) / 1000)
      const elapsedMin = Math.max(1, Math.ceil(elapsedSec / 60))
      const startedAtISO = new Date(nursingTimer.startedAt).toISOString()
      nursingTimer.running = false
      nursingTimer.startedAt = null
      saveNursingTimer(nursingTimer)
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
      onTimerChange()
      onConfirm(side, elapsedMin, startedAtISO)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'Enter' && document.activeElement !== minutesRef.current) {
      e.preventDefault()
      handleManualRecord()
    }
  }

  const handleManualRecord = () => {
    const m = minutes ? parseInt(minutes, 10) : undefined
    onConfirm(side, isNaN(m as number) ? undefined : m)
  }

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 60),
  }

  const SIDES: { value: 'L' | 'R' | 'both'; label: string }[] = [
    { value: 'L', label: t('breast.left') },
    { value: 'R', label: t('breast.right') },
    { value: 'both', label: t('breast.both') },
  ]

  const lastSideLabel = lastBreastSide === 'L' ? t('breast.left') : lastBreastSide === 'R' ? t('breast.right') : null

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <form
        className="popover"
        style={style}
        onSubmit={e => { e.preventDefault(); handleManualRecord() }}
        onKeyDown={handleKeyDown}
      >
        <div className="label" style={{ marginBottom: 4 }}>{t('popover.breastFeeding')}</div>

        {/* Suggestion pill */}
        {lastSideLabel && (
          <div className="breast-suggestion-pill" style={{ marginBottom: 8 }}>
            {t('popover.breastSuggestion', { side: lastSideLabel })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {SIDES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`role-btn${side === value ? ' selected' : ''}`}
              onClick={() => setSide(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Nursing timer section */}
        <div style={{ marginBottom: 10 }}>
          {!nursingTimer.running ? (
            <button
              type="button"
              className="btn-secondary"
              style={{ width: '100%', marginBottom: 8 }}
              onClick={handleStartTimer}
            >
              {t('popover.timerStart')}
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ flex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 18, color: 'var(--peach-500)', letterSpacing: '0.02em' }}>
                {timerDisplay ?? '00:00'}
              </span>
              <button
                type="button"
                className="btn-primary"
                style={{ background: 'var(--peach-500)' }}
                onClick={handleStopAndRecord}
              >
                {t('popover.timerStop')}
              </button>
            </div>
          )}
        </div>

        <div className="label">{t('popover.feedingDuration')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <input
            ref={minutesRef}
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
          <button type="button" className="btn-secondary" onClick={onClose}>{t('popover.cancel')}</button>
          <button type="submit" className="btn-primary">{t('popover.record')}</button>
        </div>
      </form>
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
  defaultMl: number
}

function FormulaPopover({ anchor, onConfirm, onClose, defaultMl }: FormulaPopoverProps) {
  const [ml, setMl] = useState(defaultMl)
  const SHORTCUTS = [60, 80, 100, 120, 150, 180]
  const { t } = useTranslation()

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirm(ml) }
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const style: React.CSSProperties = {
    top: anchor.bottom + 8,
    left: Math.max(8, anchor.left - 80),
  }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <form
        className="popover"
        style={style}
        onSubmit={e => { e.preventDefault(); onConfirm(ml) }}
        onKeyDown={handleKeyDown}
      >
        <div className="label" style={{ marginBottom: 8 }}>{t('popover.formulaAmount')}</div>
        <div className="stepper" style={{ marginBottom: 10 }}>
          <button type="button" className="stepper-btn" onClick={() => setMl(v => Math.max(0, v - 10))}>−</button>
          <div className="stepper-value">{ml}</div>
          <span style={{ fontSize: 12, color: 'var(--stone-500)', paddingRight: 6 }}>ml</span>
          <button type="button" className="stepper-btn" onClick={() => setMl(v => v + 10)}>+</button>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
          {SHORTCUTS.map(v => (
            <button
              type="button"
              key={v}
              className={`filter-chip${ml === v ? ' active' : ''}`}
              onClick={() => setMl(v)}
            >
              {v}ml
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>{t('popover.cancel')}</button>
          <button type="submit" className="btn-primary">{t('popover.record')}</button>
        </div>
      </form>
    </>
  )
}

// ---------------------------------------------------------------------------
// Floating nursing timer pill
// ---------------------------------------------------------------------------
interface FloatingTimerPillProps {
  onStop: () => void
}

function FloatingTimerPill({ onStop }: FloatingTimerPillProps) {
  const [display, setDisplay] = useState('00:00')
  const { t } = useTranslation()

  useEffect(() => {
    const id = setInterval(() => {
      if (nursingTimer.running && nursingTimer.startedAt != null) {
        const sec = Math.floor((Date.now() - nursingTimer.startedAt) / 1000)
        const mm = String(Math.floor(sec / 60)).padStart(2, '0')
        const ss = String(sec % 60).padStart(2, '0')
        setDisplay(`${mm}:${ss}`)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const [mm, ss] = display.split(':')

  return (
    <div className="floating-timer-pill">
      <span className="floating-timer-time">{t('popover.timerFloating', { mm, ss })}</span>
      <button
        className="floating-timer-stop"
        onClick={onStop}
        aria-label={t('popover.timerStopFloating')}
      >
        {t('popover.timerStopFloating')}
      </button>
    </div>
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
  const { addPee, addPoop, addTemp, addBreast, addFormula, editEvent, softDeleteEvent, todayEvents, events } = useAppStore()
  const { showToast } = useToast()
  const { t } = useTranslation()
  const [popover, setPopover] = useState<{ type: ActivePopover; anchor: DOMRect } | null>(null)
  const [timeEditEvent, setTimeEditEvent] = useState<DiaryEvent | null>(null)
  const [timerTick, setTimerTick] = useState(0)  // force re-render when timer changes

  const today = todayEvents()

  // Derive last formula ml and last temp from all events
  const lastFormulaMl = React.useMemo(() => {
    const formulas = events.filter(e => !e.deleted && e.type === 'formula')
    if (formulas.length === 0) return 120
    const last = formulas.sort((a, b) => b.at.localeCompare(a.at))[0]
    return (last.data as FormulaData).ml ?? 120
  }, [events])

  const lastTemp = React.useMemo(() => {
    const temps = events.filter(e => !e.deleted && e.type === 'temp')
    if (temps.length === 0) return 36.5
    const last = temps.sort((a, b) => b.at.localeCompare(a.at))[0]
    return (last.data as { celsius: number }).celsius ?? 36.5
  }, [events])

  const lastBreastSide = React.useMemo((): 'L' | 'R' | 'both' | null => {
    const breasts = events.filter(e => !e.deleted && e.type === 'breast')
    if (breasts.length === 0) return null
    const last = breasts.sort((a, b) => b.at.localeCompare(a.at))[0]
    return (last.data as BreastData).side ?? null
  }, [events])

  const onTimerChange = useCallback(() => {
    setTimerTick(t => t + 1)
  }, [])

  // Quick record with undo + time-edit toast
  const quickRecord = useCallback(async (
    recordFn: () => Promise<DiaryEvent>,
    label: string
  ) => {
    try {
      const event = await recordFn()
      showToast({
        message: t('toast.recorded', { label, time: formatTime(event.at) }),
        undoLabel: t('toast.undo'),
        onUndo: async () => {
          try {
            await softDeleteEvent(event)
          } catch {
            showToast({ message: t('toast.deleteFailed') })
          }
        },
        onTimeEdit: () => setTimeEditEvent(event),
      })
    } catch {
      showToast({ message: t('toast.saveFailed') })
    }
  }, [showToast, softDeleteEvent, t])

  const handlePee = useCallback(() => quickRecord(() => addPee(), t('quickBtn.pee')), [quickRecord, addPee, t])
  const handlePoop = useCallback(() => quickRecord(() => addPoop(), t('quickBtn.poop')), [quickRecord, addPoop, t])

  const openPopover = (type: ActivePopover, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPopover({ type, anchor: rect })
  }

  const handleTempConfirm = async (celsius: number) => {
    setPopover(null)
    await quickRecord(() => addTemp(celsius), `${t('quickBtn.temp')} ${celsius.toFixed(1)}℃`)
  }

  const handleBreastConfirm = async (side: 'L' | 'R' | 'both', minutes?: number, startedAt?: string) => {
    setPopover(null)
    const sideLabel = side === 'L'
      ? t('breast.left')
      : side === 'R'
        ? t('breast.right')
        : t('breast.both')
    const label = `${t('quickBtn.breast')}(${sideLabel})`
    await quickRecord(() => addBreast(side, minutes, startedAt), label)
  }

  const handleFormulaConfirm = async (ml: number) => {
    setPopover(null)
    await quickRecord(() => addFormula(ml), `${t('quickBtn.formula')} ${ml}ml`)
  }

  const handleTimeEditConfirm = async (newAt: string) => {
    if (!timeEditEvent) return
    try {
      await editEvent(timeEditEvent, { at: newAt })
      setTimeEditEvent(null)
      showToast({ message: t('toast.timeEdited') })
    } catch {
      setTimeEditEvent(null)
      showToast({ message: t('toast.editFailed') })
    }
  }

  // Floating timer stop handler
  const handleFloatingTimerStop = useCallback(() => {
    if (nursingTimer.running && nursingTimer.startedAt != null) {
      const elapsedSec = Math.floor((Date.now() - nursingTimer.startedAt) / 1000)
      const elapsedMin = Math.max(1, Math.ceil(elapsedSec / 60))
      const startedAtISO = new Date(nursingTimer.startedAt).toISOString()
      const side: 'L' | 'R' | 'both' = lastBreastSide === 'L' ? 'R' : lastBreastSide === 'R' ? 'L' : 'both'
      nursingTimer.running = false
      nursingTimer.startedAt = null
      saveNursingTimer(nursingTimer)
      setTimerTick(t => t + 1)
      handleBreastConfirm(side, elapsedMin, startedAtISO)
    }
  }, [lastBreastSide]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts (1-5) on home page only
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if focus is in an input or textarea
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // Ignore if modifier keys held
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Ignore if a popover is open
      if (popover) return

      switch (e.key) {
        case '1': e.preventDefault(); handlePee(); break
        case '2': e.preventDefault(); handlePoop(); break
        case '3': {
          e.preventDefault()
          // find temp button and fake click
          const btn = document.querySelector('.quick-btn-temp') as HTMLElement
          if (btn) btn.click()
          break
        }
        case '4': {
          e.preventDefault()
          const btn = document.querySelector('.quick-btn-breast') as HTMLElement
          if (btn) btn.click()
          break
        }
        case '5': {
          e.preventDefault()
          const btn = document.querySelector('.quick-btn-formula') as HTMLElement
          if (btn) btn.click()
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [popover, handlePee, handlePoop])

  return (
    <div className="page-container">
      {/* Hero header strip */}
      <HomeHero onNavigateSettings={() => onNavigate?.('settings')} />

      {/* Quick record buttons — circular icon design */}
      <div className="quick-record-row">
        {[
          {
            cls: 'quick-btn-circle quick-btn-circle-pee',
            Icon: IconDrop,
            label: t('quickBtn.pee'),
            badge: '1',
            onClick: handlePee,
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-poop',
            Icon: IconPoop,
            label: t('quickBtn.poop'),
            badge: '2',
            onClick: handlePoop,
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-temp',
            Icon: IconThermometer,
            label: t('quickBtn.temp'),
            badge: '3',
            onClick: (e: React.MouseEvent) => openPopover('temp', e),
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-breast',
            Icon: IconHeart,
            label: t('quickBtn.breast'),
            badge: '4',
            onClick: (e: React.MouseEvent) => openPopover('breast', e),
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-formula',
            Icon: IconBottle,
            label: t('quickBtn.formula'),
            badge: '5',
            onClick: (e: React.MouseEvent) => openPopover('formula', e),
          },
        ].map(({ cls, Icon, label, badge, onClick }, i) => (
          <div
            key={badge}
            className="quick-record-slot stagger-mount"
            style={{ '--i': i } as React.CSSProperties}
          >
            <button
              className={cls}
              onClick={onClick as React.MouseEventHandler}
              style={{ position: 'relative' }}
            >
              <span className="quick-btn-badge">{badge}</span>
              <Icon size={24} />
            </button>
            <span className="quick-btn-circle-label">{label}</span>
          </div>
        ))}
      </div>

      {/* Keyboard shortcut hint */}
      <div className="quick-btn-hint">{t('quickBtnHint')}</div>

      <hr className="divider" style={{ marginBottom: 16, marginTop: 16 }} />

      {/* Today's timeline */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--stone-500)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {t('home.todayRecords')}
      </div>
      <div className="card">
        <EventTimeline events={today} showAuthor editable />
      </div>

      {/* Floating nursing timer pill */}
      {nursingTimer.running && (
        <FloatingTimerPill key={timerTick} onStop={handleFloatingTimerStop} />
      )}

      {/* Popovers */}
      {popover?.type === 'temp' && (
        <TempPopover
          anchor={popover.anchor}
          onConfirm={handleTempConfirm}
          onClose={() => setPopover(null)}
          defaultValue={lastTemp}
        />
      )}
      {popover?.type === 'breast' && (
        <BreastPopover
          anchor={popover.anchor}
          onConfirm={handleBreastConfirm}
          onClose={() => setPopover(null)}
          lastBreastSide={lastBreastSide}
          onTimerChange={onTimerChange}
        />
      )}
      {popover?.type === 'formula' && (
        <FormulaPopover
          anchor={popover.anchor}
          onConfirm={handleFormulaConfirm}
          onClose={() => setPopover(null)}
          defaultMl={lastFormulaMl}
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
