import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconClock, IconStar, IconGift, IconInfo, IconX, IconMoon, IconRuler } from '../components/icons'
import { computeNextFeed, formatCountdown } from '../lib/breastfeeding'
import { useAppStore, formatTime, getDDay } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { EventTimeline } from '../components/EventTimeline'
import { TimeEditModal } from '../components/TimeEditModal'
import { DiaryEvent, BreastData, FormulaData, TempData, DataInfo } from '../../shared/types'
import { differenceInMinutes, differenceInDays, format, parseISO, isSameDay, subDays, isToday } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useTranslation } from 'react-i18next'
import { getMilestones, getUpcoming, Milestone } from '../lib/milestones'
import { getCurrentFormulaGuidance, getGuidanceForAge, GUIDANCE_MARKERS, evaluateFever, getFeedingBand, FeverLevel } from '../lib/guidance'
import { FeedingTipPopup } from '../components/FeedingTipPopup'
import { FeverModal } from '../components/FeverModal'
import { useSyncStatus } from '../sync/useSync'

// ---------------------------------------------------------------------------
// Milestone dismiss persistence
// ---------------------------------------------------------------------------
const MILESTONE_DISMISS_KEY = 'babydiary.milestoneDismiss'

function getDismissed(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MILESTONE_DISMISS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function setDismissed(id: string, untilDate: string): void {
  try {
    const current = getDismissed()
    // Purge expired entries (past dates)
    const today = format(new Date(), 'yyyy-MM-dd')
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(current)) {
      if (v >= today) cleaned[k] = v
    }
    cleaned[id] = untilDate
    localStorage.setItem(MILESTONE_DISMISS_KEY, JSON.stringify(cleaned))
  } catch { /* ignore */ }
}

function isDismissed(id: string, milestoneDate: string): boolean {
  const dismissed = getDismissed()
  const today = format(new Date(), 'yyyy-MM-dd')
  // Dismissed until the milestone date passes (dismiss entry expires day after)
  const dismissedUntil = dismissed[id]
  if (!dismissedUntil) return false
  // If milestone date has passed, auto-clear (no longer relevant)
  if (milestoneDate < today) return false
  return true
}

// ---------------------------------------------------------------------------
// MilestoneAlertBanners — home page upcoming milestone notifications
// ---------------------------------------------------------------------------
interface MilestoneAlertBannersProps {
  birthdate: string
  gender?: 'girl' | 'boy'
  lang: string
}

function MilestoneAlertBanners({ birthdate, gender, lang }: MilestoneAlertBannersProps) {
  const { t, i18n: i18nInstance } = useTranslation()
  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const [dismissed, setDismissedState] = useState<Record<string, string>>(getDismissed)
  const today = format(new Date(), 'yyyy-MM-dd')

  const milestones = useMemo(
    () => getMilestones(birthdate, gender),
    [birthdate, gender]
  )

  const upcoming = useMemo(
    () => getUpcoming(milestones, today, 7).slice(0, 2),
    [milestones, today]
  )

  // Filter out dismissed
  const visible = upcoming.filter(m => !isDismissed(m.id, m.date))

  if (visible.length === 0) return null

  const handleDismiss = (id: string, milestoneDate: string) => {
    setDismissed(id, milestoneDate)
    setDismissedState(getDismissed())
  }

  return (
    <>
      {visible.map(m => {
        const name = lang === 'ja' ? m.nameJa : m.nameKo
        const isToday_ = m.daysUntil === 0
        const dateFormatted = format(parseISO(m.date), t('date.formatLong'), { locale: dateFnsLocale })

        // P30: both ja and ko use the same i18n key for isToday_ (no dead branch)
        // P29: ko upcoming banner now uses t() so editing ko.json changes the UI
        let text: string
        if (isToday_) {
          text = t('milestone.upcomingBannerToday', { name })
        } else {
          text = t('milestone.upcomingBanner', { days: m.daysUntil, date: dateFormatted, name })
        }

        return (
          <div
            key={m.id}
            className={`milestone-alert-banner${isToday_ ? ' milestone-today' : ''}`}
          >
            <div className="milestone-alert-icon" aria-hidden="true">
              <IconStar size={16} color="currentColor" />
            </div>
            <div className="milestone-alert-body">
              <div className="milestone-alert-text">{text}</div>
            </div>
            <button
              className="milestone-alert-dismiss"
              onClick={() => handleDismiss(m.id, m.date)}
              aria-label={t('milestone.dismiss')}
            >
              <IconX size={14} color="currentColor" />
            </button>
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Insight / right-rail panel
// ---------------------------------------------------------------------------

interface InsightsPanelProps {
  lastFeeding: DiaryEvent | null
  lastBreastSide: 'L' | 'R' | 'both' | null
  lastBreastEvent: DiaryEvent | null
  todayPeeCount: number
  todayPoopCount: number
  dataInfo: DataInfo | null
  birthdate?: string
  ageDays: number | null
  onNavigate?: (page: 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings') => void
  todaySleepMinutes: number
}

function InsightsPanel({
  lastFeeding,
  lastBreastSide,
  lastBreastEvent,
  todayPeeCount,
  todayPoopCount,
  dataInfo,
  birthdate,
  ageDays,
  onNavigate,
  todaySleepMinutes,
}: InsightsPanelProps) {
  const { t, i18n: i18nInstance } = useTranslation()
  const [, setTick] = useState(0)
  const syncState = useSyncStatus()
  const syncDotClass = syncState.status === 'online' ? 'on' : syncState.status === 'error' ? 'err' : 'off'

  useEffect(() => {
    const id = setInterval(() => setTick(c => c + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // Last feeding: clock time as main value, elapsed as muted suffix
  let lastFeedingTime: string | null = null
  let lastFeedingAgo: string | null = null
  let lastFeedingLabel = t('home.noFeedingYet')
  if (lastFeeding) {
    lastFeedingTime = format(parseISO(lastFeeding.at), 'HH:mm')
    const mins = Math.max(0, differenceInMinutes(new Date(), parseISO(lastFeeding.at)))
    const hours = Math.floor(mins / 60)
    const m = mins % 60
    lastFeedingAgo = hours > 0
      ? t('home.hoursMinutesAgo', { hours, mins: m })
      : t('home.minutesAgo', { mins: m })
    lastFeedingLabel = lastFeedingTime
  }

  // Next recommended side
  const nextSideLabel = lastBreastSide === 'L'
    ? t('breast.right')
    : lastBreastSide === 'R'
      ? t('breast.left')
      : '–'

  // Last temp (recent)
  const recentTemp: DiaryEvent | null = useAppStore(s => {
    const temps = s.events.filter(e => !e.deleted && e.type === 'temp')
    if (temps.length === 0) return null
    return temps.sort((a, b) => b.at.localeCompare(a.at))[0]
  })

  const tempLabel = recentTemp
    ? `${(recentTemp.data as TempData).celsius.toFixed(1)}℃`
    : '–'

  // Backup info
  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const backupStr = dataInfo?.lastBackupTime
    ? format(parseISO(dataInfo.lastBackupTime), t('date.formatBackup'), { locale: dateFnsLocale })
    : t('settings.noBackup')

  // Current formula guidance (using new getGuidanceForAge — picks best formula band)
  const formulaGuidance = useMemo(() => {
    if (!birthdate) return null
    const markers = getGuidanceForAge(birthdate, new Date())
    // Pick the first formula marker (most relevant age band)
    const formula = markers.find(m => m.id.startsWith('formula_'))
    return formula ?? null
  }, [birthdate])

  const lang = i18nInstance.language

  const sleepLabel = (() => {
    if (todaySleepMinutes === 0) return '–'
    const h = Math.floor(todaySleepMinutes / 60)
    const m = todaySleepMinutes % 60
    if (lang === 'ja') {
      return h > 0 ? (m > 0 ? `${h}時間${m}分` : `${h}時間`) : `${m}分`
    }
    return h > 0 ? (m > 0 ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`
  })()

  // Breast countdown — computed from last breast event
  const bfCountdown = useMemo(() => {
    if (!lastBreastEvent || ageDays === null || !birthdate) return null
    const now = new Date()
    const bfLang = lang === 'ja' ? 'ja' : 'ko'
    const { windowStart, windowEnd, maxStretchAt, band } = computeNextFeed(lastBreastEvent.at, ageDays)
    const fmt = (d: Date) => d.toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

    const msToStart = windowStart.getTime() - now.getTime()
    const msToEnd = windowEnd ? windowEnd.getTime() - now.getTime() : null
    const msElapsed = now.getTime() - new Date(lastBreastEvent.at).getTime()
    const elapsedStr = formatCountdown(msElapsed, bfLang)

    // maxStretchAt exceeded — newborn warning (amber)
    if (maxStretchAt && now >= maxStretchAt) {
      return {
        type: 'newborn' as const,
        value: t('home.bfCountdownNewborn', { elapsed: elapsedStr }),
        sub: null,
        isAmber: true,
      }
    }

    // Before windowStart
    if (msToStart > 0) {
      const countdown = formatCountdown(msToStart, bfLang)
      const sub = windowEnd
        ? t('home.bfCountdownBeforeSub', { from: fmt(windowStart), to: fmt(windowEnd) })
        : t('home.bfCountdownBeforeSubNoEnd', { from: fmt(windowStart) })
      return {
        type: 'before' as const,
        value: t('home.bfCountdownBefore', { countdown }),
        sub,
        isAmber: false,
      }
    }

    // Inside window
    const pastWindowEnd = msToEnd !== null && msToEnd < 0
    const pastWindowStartPlus1h = msToEnd === null && msToStart < -60 * 60 * 1000
    if (!pastWindowEnd && !pastWindowStartPlus1h) {
      return {
        type: 'window' as const,
        value: t('home.bfCountdownWindow'),
        sub: windowEnd ? `~ ${fmt(windowEnd)}` : null,
        isAmber: false,
      }
    }

    // Past window
    return {
      type: 'past' as const,
      value: t('home.bfCountdownPast', { elapsed: elapsedStr }),
      sub: null,
      isAmber: false,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastBreastEvent, ageDays, birthdate, lang, t])

  const rows = [
    {
      Icon: IconBottle,
      bg: 'var(--blush)',
      iconColor: 'var(--blush-text)',
      label: t('home.lastFeedingLabel'),
      value: lastFeedingLabel,
      ago: lastFeedingAgo,
    },
    {
      Icon: IconHeart,
      bg: 'var(--sky)',
      iconColor: 'var(--sky-text)',
      label: t('home.nextBreastLabel'),
      value: nextSideLabel,
      ago: null,
    },
    {
      Icon: IconDrop,
      bg: 'var(--mint)',
      iconColor: 'var(--mint-text)',
      label: t('home.todayDiaperLabel'),
      value: `${t('quickBtn.pee')} ${todayPeeCount} / ${t('quickBtn.poop')} ${todayPoopCount}`,
      ago: null,
    },
    {
      Icon: IconThermometer,
      bg: 'var(--butter)',
      iconColor: 'var(--butter-text)',
      label: t('home.recentTempLabel'),
      value: tempLabel,
      ago: null,
    },
    {
      Icon: IconMoon,
      bg: 'var(--lavender-100)',
      iconColor: 'var(--lavender-600)',
      label: t('home.todaySleepLabel'),
      value: sleepLabel,
      ago: null,
    },
  ]

  return (
    <div className="insights-panel" data-tour="insights">
      <div className="insights-title">{t('home.insightsTitle')}</div>

      {/* Breast countdown row — shown only when last feed was breast and birthdate set */}
      {bfCountdown && (
        <div
          className="insight-row"
          style={bfCountdown.isAmber ? { background: 'var(--amber, #fffbea)', borderRadius: 8, padding: '4px 0' } : undefined}
        >
          <div
            className="insight-icon"
            style={{ background: bfCountdown.isAmber ? 'var(--butter)' : 'var(--sky)' }}
            aria-hidden="true"
          >
            <IconClock size={16} color={bfCountdown.isAmber ? 'var(--butter-text)' : 'var(--sky-text)'} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="insight-label">{t('home.bfCountdownLabel')}</div>
            <div
              className="insight-value"
              style={bfCountdown.type === 'window' ? { color: 'var(--mint-text)', fontWeight: 600 } : bfCountdown.isAmber ? { color: 'var(--butter-text)', fontWeight: 600 } : undefined}
            >
              {bfCountdown.value}
            </div>
            {bfCountdown.sub && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                {bfCountdown.sub}
              </div>
            )}
          </div>
        </div>
      )}

      {rows.map((row, i) => {
        const RowIcon = row.Icon
        return (
        <div key={i} className="insight-row">
          <div
            className="insight-icon"
            style={{ background: row.bg }}
            aria-hidden="true"
          >
            <RowIcon size={16} color={row.iconColor} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="insight-label">{row.label}</div>
            <div className="insight-value">
              {row.value}
              {row.ago && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 5 }}>
                  ({row.ago})
                </span>
              )}
            </div>
          </div>
        </div>
        )
      })}

      {/* Current formula / age guidance row */}
      {formulaGuidance && (
        <div
          className="insight-row"
          role="button"
          tabIndex={0}
          aria-label={t('home.guidanceRowAriaLabel')}
          style={{ cursor: 'pointer' }}
          onClick={() => onNavigate?.('settings')}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate?.('settings') } }}
        >
          <div
            className="insight-icon"
            aria-hidden="true"
            style={{ background: 'var(--sky)' }}
          >
            <IconInfo size={16} color="var(--sky-text)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="insight-label">
              {lang === 'ja' ? formulaGuidance.titleJa : formulaGuidance.titleKo}
            </div>
            <div className="insight-value" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {/* First sentence only */}
              {(lang === 'ja' ? formulaGuidance.bodyJa : formulaGuidance.bodyKo).split(/[。.]\s*/)[0]}
            </div>
          </div>
        </div>
      )}

      {/* Backup card */}
      <div className="backup-card">
        <div className="backup-card-title">{t('home.backupLabel')}</div>
        <div className="backup-card-row">
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{backupStr}</span>
          <span className={`sync-dot ${syncDotClass}`} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat cards (left main column)
// ---------------------------------------------------------------------------
function StatCards() {
  const peeCount = useAppStore(s => s.todayPeeCount())
  const poopCount = useAppStore(s => s.todayPoopCount())
  const feedCount = useAppStore(s => s.todayFeedingCount())
  const formulaMl = useAppStore(s => s.todayFormulaTotalMl())
  const events = useAppStore(s => s.events)
  const { t } = useTranslation()

  // Compute yesterday values for deltas
  const { yFormulaMl, yPeeCount, yPoopCount, yFeedCount } = React.useMemo(() => {
    const yesterday = subDays(new Date(), 1)
    const yev = events.filter(e => !e.deleted && isSameDay(parseISO(e.at), yesterday))
    return {
      yFormulaMl: yev.filter(e => e.type === 'formula').reduce((s, e) => s + ((e.data as FormulaData).ml ?? 0), 0),
      yPeeCount: yev.filter(e => e.type === 'pee').length,
      yPoopCount: yev.filter(e => e.type === 'poop').length,
      yFeedCount: yev.filter(e => e.type === 'breast' || e.type === 'formula').length,
    }
  }, [events])

  // Most recent temp
  const lastTemp = React.useMemo(() => {
    const todayTemps = events.filter(e => !e.deleted && e.type === 'temp' && isToday(parseISO(e.at)))
    if (todayTemps.length === 0) return null
    const last = todayTemps.sort((a, b) => b.at.localeCompare(a.at))[0]
    return (last.data as TempData).celsius
  }, [events])

  function DeltaTag({ current, prev }: { current: number; prev: number }) {
    if (prev === 0) return null
    const diff = current - prev
    if (diff === 0) return null
    const up = diff > 0
    return (
      <span className={`stat-card-delta ${up ? 'up' : 'down'}`}>
        {up ? '↑' : '↓'} {Math.abs(diff)}
      </span>
    )
  }

  return (
    <div className="stat-card-grid">
      {/* Featured: formula total */}
      <div className="stat-card stat-card-featured">
        <div className="stat-card-label">{t('stat.formulaLabel')}</div>
        <div className="stat-card-num">
          {formulaMl > 0 ? formulaMl : '–'}
          {formulaMl > 0 && <span className="stat-card-unit" style={{ fontSize: 16, marginLeft: 3 }}>ml</span>}
        </div>
        {formulaMl > 0 && yFormulaMl > 0 && (
          <DeltaTag current={formulaMl} prev={yFormulaMl} />
        )}
      </div>

      {/* Pee */}
      <div className="stat-card">
        <div className="stat-card-label">{t('stat.peeLabel')}</div>
        <div className="stat-card-num">{peeCount}</div>
        <DeltaTag current={peeCount} prev={yPeeCount} />
      </div>

      {/* Poop */}
      <div className="stat-card">
        <div className="stat-card-label">{t('stat.poopLabel')}</div>
        <div className="stat-card-num">{poopCount}</div>
        <DeltaTag current={poopCount} prev={yPoopCount} />
      </div>

      {/* Feed count */}
      <div className="stat-card">
        <div className="stat-card-label">{t('stat.feedLabel')}</div>
        <div className="stat-card-num">{feedCount}</div>
        <DeltaTag current={feedCount} prev={yFeedCount} />
      </div>

      {/* Temp */}
      <div className="stat-card">
        <div className="stat-card-label">{t('stat.tempLabel')}</div>
        <div className="stat-card-num" style={{ fontSize: 24 }}>
          {lastTemp != null ? `${lastTemp.toFixed(1)}℃` : '–'}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick-record glass dropdown menu
// ---------------------------------------------------------------------------
interface QuickMenuProps {
  anchor: DOMRect
  onPee: () => void
  onPoop: () => void
  onOpenTemp: (e: React.MouseEvent) => void
  onOpenBreast: (e: React.MouseEvent) => void
  onOpenFormula: (e: React.MouseEvent) => void
  onSleep: (e: React.MouseEvent) => void
  onOpenGrowth: (e: React.MouseEvent) => void
  onClose: () => void
}

function QuickMenu({ anchor, onPee, onPoop, onOpenTemp, onOpenBreast, onOpenFormula, onSleep, onOpenGrowth, onClose }: QuickMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  // Close on outside click
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay one frame so the triggering click doesn't immediately close the menu
    const id = requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onPointerDown)
    })
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose])

  // Focus first item on open
  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === '1') { e.preventDefault(); onPee(); onClose() }
    if (e.key === '2') { e.preventDefault(); onPoop(); onClose() }
    if (e.key === '6') { e.preventDefault(); onSleep(e as unknown as React.MouseEvent); onClose() }
  }

  // QuickMenu has 7 items at ~44px each + 12px padding ~ 320px
  const QUICK_MENU_H = 330
  const quickMenuTop = anchor.bottom + 8
  const quickMenuBottom = quickMenuTop + QUICK_MENU_H
  const quickMenuStyle: React.CSSProperties = quickMenuBottom > window.innerHeight - 8
    ? { bottom: window.innerHeight - anchor.top + 8, right: Math.max(8, window.innerWidth - anchor.right) }
    : { top: quickMenuTop, right: Math.max(8, window.innerWidth - anchor.right) }
  const menuStyle = quickMenuStyle

  const ITEMS: {
    tintBg: string
    tintColor: string
    Icon: React.FC<{ size: number; color?: string }>
    labelKey: string
    badge: string
    action: (e: React.MouseEvent<HTMLButtonElement>) => void
  }[] = [
    {
      tintBg: 'var(--mint)', tintColor: 'var(--mint-text)',
      Icon: IconDrop, labelKey: 'quickBtn.pee', badge: '1',
      action: () => { onPee(); onClose() },
    },
    {
      tintBg: 'var(--butter)', tintColor: 'var(--butter-text)',
      Icon: IconPoop, labelKey: 'quickBtn.poop', badge: '2',
      action: () => { onPoop(); onClose() },
    },
    {
      tintBg: 'var(--blush)', tintColor: 'var(--blush-text)',
      Icon: IconThermometer, labelKey: 'quickBtn.temp', badge: '3',
      action: (e) => { onClose(); onOpenTemp(e) },
    },
    {
      tintBg: 'var(--sky)', tintColor: 'var(--sky-text)',
      Icon: IconHeart, labelKey: 'quickBtn.breast', badge: '4',
      action: (e) => { onClose(); onOpenBreast(e) },
    },
    {
      tintBg: 'var(--sage-p)', tintColor: 'var(--sage-p-text)',
      Icon: IconBottle, labelKey: 'quickBtn.formula', badge: '5',
      action: (e) => { onClose(); onOpenFormula(e) },
    },
    {
      tintBg: 'var(--lavender-100)', tintColor: 'var(--lavender-600)',
      Icon: IconMoon, labelKey: 'quickBtn.sleep', badge: '6',
      action: (e) => { onClose(); onSleep(e) },
    },
    {
      tintBg: 'var(--indigo-100)', tintColor: 'var(--indigo-600)',
      Icon: IconRuler, labelKey: 'quickBtn.growth', badge: '7',
      action: (e) => { onClose(); onOpenGrowth(e) },
    },
  ]

  return (
    <div
      ref={menuRef}
      className="quick-menu"
      role="menu"
      aria-label={t('home.addRecord')}
      style={menuStyle}
      onKeyDown={handleKeyDown}
    >
      {ITEMS.map(({ tintBg, tintColor, Icon, labelKey, badge, action }, idx) => (
        <button
          key={badge}
          ref={idx === 0 ? firstItemRef : undefined}
          className="quick-menu-item"
          role="menuitem"
          onClick={action as React.MouseEventHandler<HTMLButtonElement>}
        >
          <span
            className="quick-menu-icon"
            style={{ background: tintBg, color: tintColor }}
            aria-hidden="true"
          >
            <Icon size={14} color={tintColor} />
          </span>
          <span className="quick-menu-label">{t(labelKey)}</span>
          <span className="quick-menu-badge" aria-hidden="true">{badge}</span>
        </button>
      ))}
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
    // P17: Clamp to physiologically valid range [35.0, 42.0].
    // HTML min/max attributes are bypassed by direct input — enforce in JS too.
    const n = parseFloat(value)
    if (!isNaN(n) && isFinite(n)) {
      onConfirm(Math.min(Math.max(n, 35.0), 42.0))
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  // Clamp left so popover doesn't overflow right edge (popover min-width ~240px)
  const POPOVER_W = 260
  const rawLeft = anchor.left - 80
  const clampedLeft = Math.min(Math.max(8, rawLeft), window.innerWidth - POPOVER_W - 8)
  // If popover would overflow bottom, open upward (approx height 140px)
  const POPOVER_H = 160
  const openUpward = anchor.bottom + 8 + POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = openUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: clampedLeft }
    : { top: anchor.bottom + 8, left: clampedLeft }

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
          <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>℃</span>
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
// ---------------------------------------------------------------------------
interface NursingTimerState {
  running: boolean
  startedAt: number | null
  elapsed: number
}

const NURSING_TIMER_KEY = 'babydiary.nursingTimer'

/** P15: Maximum elapsed duration (4h). Abandoned overnight timers are discarded. */
const MAX_ELAPSED_MS = 4 * 60 * 60 * 1000
const MAX_ELAPSED_MIN = 240

function loadNursingTimer(): NursingTimerState {
  try {
    const raw = localStorage.getItem(NURSING_TIMER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as NursingTimerState
      if (parsed.running && parsed.startedAt) {
        // P15: Discard timers older than 4 hours — an abandoned overnight timer
        // would otherwise record a 720+ min entry.
        if (Date.now() - parsed.startedAt > MAX_ELAPSED_MS) {
          localStorage.removeItem(NURSING_TIMER_KEY)
          return { running: false, startedAt: null, elapsed: 0 }
        }
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
// Sleep timer state (module-level like nursingTimer — survives popover close)
// ---------------------------------------------------------------------------
interface SleepTimerState {
  running: boolean
  startedAt: number | null
}

const SLEEP_TIMER_KEY = 'babydiary.sleepStart'
const MAX_SLEEP_MS = 16 * 60 * 60 * 1000

function loadSleepTimer(): SleepTimerState {
  try {
    const raw = localStorage.getItem(SLEEP_TIMER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SleepTimerState
      if (parsed.running && parsed.startedAt) {
        if (Date.now() - parsed.startedAt > MAX_SLEEP_MS) {
          localStorage.removeItem(SLEEP_TIMER_KEY)
          return { running: false, startedAt: null }
        }
        return parsed
      }
    }
  } catch { /* ignore */ }
  return { running: false, startedAt: null }
}

function saveSleepTimer(state: SleepTimerState): void {
  try {
    if (state.running) {
      localStorage.setItem(SLEEP_TIMER_KEY, JSON.stringify(state))
    } else {
      localStorage.removeItem(SLEEP_TIMER_KEY)
    }
  } catch { /* ignore */ }
}

const sleepTimer: SleepTimerState = loadSleepTimer()

// ---------------------------------------------------------------------------
// Breast popover
// ---------------------------------------------------------------------------
interface BreastPopoverProps {
  anchor: DOMRect
  onConfirm: (side: 'L' | 'R' | 'both', minutes?: number, startedAt?: string) => void
  onClose: () => void
  lastBreastSide: 'L' | 'R' | 'both' | null
  onTimerChange: () => void
}

function BreastPopover({ anchor, onConfirm, onClose, lastBreastSide, onTimerChange }: BreastPopoverProps) {
  const suggestedSide: 'L' | 'R' | 'both' = lastBreastSide === 'L' ? 'R' : lastBreastSide === 'R' ? 'L' : 'both'
  const [side, setSide] = useState<'L' | 'R' | 'both'>(suggestedSide)
  const [minutes, setMinutes] = useState('')
  const [timerDisplay, setTimerDisplay] = useState<string | null>(null)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { t } = useTranslation()
  const minutesRef = useRef<HTMLInputElement>(null)

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
      const now = Date.now()
      const elapsedSec = Math.floor((now - nursingTimer.startedAt) / 1000)
      // P15: cap at MAX_ELAPSED_MIN (240 min) in case timer ran very long
      const elapsedMin = Math.min(MAX_ELAPSED_MIN, Math.max(1, Math.ceil(elapsedSec / 60)))
      // P14: use stop time as canonical `at` so a session crossing midnight lands
      // in today's bucket (not yesterday's when startedAt was yesterday).
      const stopAtISO = new Date(now).toISOString()
      nursingTimer.running = false
      nursingTimer.startedAt = null
      saveNursingTimer(nursingTimer)
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
      onTimerChange()
      onConfirm(side, elapsedMin, stopAtISO)
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
    // P19: clamp breast duration to [1, 120] minutes; treat 0/"" as undefined (no duration)
    const raw = minutes ? parseInt(minutes, 10) : undefined
    const m = raw != null && !isNaN(raw) && raw > 0
      ? Math.min(Math.max(1, raw), 120)
      : undefined
    onConfirm(side, m)
  }

  // Clamp left so popover doesn't overflow right edge (breast popover ~280px)
  const BREAST_POPOVER_W = 300
  const breastRawLeft = anchor.left - 60
  const breastClampedLeft = Math.min(Math.max(8, breastRawLeft), window.innerWidth - BREAST_POPOVER_W - 8)
  // If popover would overflow bottom, open upward (approx height 260px)
  const BREAST_POPOVER_H = 280
  const breastOpenUpward = anchor.bottom + 8 + BREAST_POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = breastOpenUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: breastClampedLeft }
    : { top: anchor.bottom + 8, left: breastClampedLeft }

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
              <span style={{ flex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 18, color: 'var(--sky-text)', letterSpacing: '0.02em' }}>
                {timerDisplay ?? '00:00'}
              </span>
              <button
                type="button"
                className="btn-primary"
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
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('popover.minutesPlaceholder')}</span>
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

  // Clamp left so popover doesn't overflow right edge (formula popover ~280px)
  const FORMULA_POPOVER_W = 300
  const formulaRawLeft = anchor.left - 80
  const formulaClampedLeft = Math.min(Math.max(8, formulaRawLeft), window.innerWidth - FORMULA_POPOVER_W - 8)
  // If popover would overflow bottom, open upward (approx height 220px)
  const FORMULA_POPOVER_H = 240
  const formulaOpenUpward = anchor.bottom + 8 + FORMULA_POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = formulaOpenUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: formulaClampedLeft }
    : { top: anchor.bottom + 8, left: formulaClampedLeft }

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
          {/* P18: Floor at 10 so stepper never produces 0-ml formula entry */}
          <button type="button" className="stepper-btn" onClick={() => setMl(v => Math.max(10, v - 10))}>−</button>
          <div className="stepper-value">{ml}</div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', paddingRight: 6 }}>ml</span>
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
// Floating sleep timer pill
// ---------------------------------------------------------------------------
interface FloatingSleepPillProps {
  onStop: () => void
}

function FloatingSleepPill({ onStop }: FloatingSleepPillProps) {
  const [display, setDisplay] = useState('00:00')
  const { t } = useTranslation()

  useEffect(() => {
    const id = setInterval(() => {
      if (sleepTimer.running && sleepTimer.startedAt != null) {
        const sec = Math.floor((Date.now() - sleepTimer.startedAt) / 1000)
        const mm = String(Math.floor(sec / 60)).padStart(2, '0')
        const ss = String(sec % 60).padStart(2, '0')
        setDisplay(`${mm}:${ss}`)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const [mm, ss] = display.split(':')

  return (
    <div className="floating-sleep-pill">
      <span className="floating-sleep-time">{t('sleep.floatingLabel', { mm, ss })}</span>
      <button
        className="floating-sleep-stop"
        onClick={onStop}
        aria-label={t('sleep.floatingStop')}
      >
        {t('sleep.floatingStop')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sleep confirm popover (shown after tap-to-stop)
// ---------------------------------------------------------------------------
interface SleepConfirmPopoverProps {
  startedAt: number
  anchor: DOMRect
  onConfirm: (minutes: number, startAtISO: string) => void
  onCancel: () => void
}

function SleepConfirmPopover({ startedAt, anchor, onConfirm, onCancel }: SleepConfirmPopoverProps) {
  const { t } = useTranslation()
  const elapsedMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000))
  const [startValue, setStartValue] = useState(
    new Date(startedAt).toTimeString().slice(0, 5) // "HH:MM"
  )
  const [durationMin, setDurationMin] = useState(elapsedMin)

  const handleConfirm = () => {
    const [hh, mm] = startValue.split(':').map(Number)
    // MF-03: anchor the HH:MM edit to the sleep-start date so a stop
    // tapped after midnight writes to the correct (yesterday) calendar date.
    const d = new Date(startedAt)
    d.setHours(hh, mm, 0, 0)
    onConfirm(durationMin, d.toISOString())
  }

  const POPOVER_W = 280
  const rawLeft = anchor.left - 80
  const clampedLeft = Math.min(Math.max(8, rawLeft), window.innerWidth - POPOVER_W - 8)
  const POPOVER_H = 220
  const openUpward = anchor.bottom + 8 + POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = openUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: clampedLeft }
    : { top: anchor.bottom + 8, left: clampedLeft }

  return (
    <>
      <div className="popover-overlay" onClick={onCancel} />
      <div className="popover" style={style}>
        <div className="label" style={{ marginBottom: 8 }}>{t('sleep.confirmTitle')}</div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('sleep.startTime')}</div>
            <input
              type="time"
              className="input-field"
              value={startValue}
              onChange={e => setStartValue(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('sleep.duration')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                className="input-field"
                value={durationMin}
                min={1}
                max={960}
                onChange={e => setDurationMin(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ width: 70 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('popover.minutesPlaceholder')}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onCancel}>{t('sleep.cancel')}</button>
          <button type="button" className="btn-primary" onClick={handleConfirm}>{t('sleep.record')}</button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Growth entry popover (via QuickMenu only — rare event)
// ---------------------------------------------------------------------------
interface GrowthPopoverProps {
  anchor: DOMRect
  onConfirm: (weightKg: number | undefined, heightCm: number | undefined) => void
  onClose: () => void
}

function GrowthPopover({ anchor, onConfirm, onClose }: GrowthPopoverProps) {
  const { t } = useTranslation()
  const [weight, setWeight] = useState('')
  const [height, setHeight] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = () => {
    const wRaw = parseFloat(weight)
    const hRaw = parseFloat(height)
    const w = isNaN(wRaw) ? undefined : Math.min(30, Math.max(0.5, wRaw))
    const h = isNaN(hRaw) ? undefined : Math.min(120, Math.max(30, hRaw))
    if (w == null && h == null) {
      setError(t('growth.atLeastOne'))
      return
    }
    onConfirm(w, h)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
  }

  const POPOVER_W = 280
  const rawLeft = anchor.left - 80
  const clampedLeft = Math.min(Math.max(8, rawLeft), window.innerWidth - POPOVER_W - 8)
  const POPOVER_H = 240
  const openUpward = anchor.bottom + 8 + POPOVER_H > window.innerHeight - 8
  const style: React.CSSProperties = openUpward
    ? { bottom: window.innerHeight - anchor.top + 8, left: clampedLeft }
    : { top: anchor.bottom + 8, left: clampedLeft }

  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover" style={style} onKeyDown={handleKeyDown}>
        <div className="label" style={{ marginBottom: 8 }}>{t('growth.title')}</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('growth.weightLabel')} ({t('growth.weightUnit')})</div>
            <input
              type="number"
              className="input-field"
              value={weight}
              step="0.01"
              min="0.5"
              max="30"
              onChange={e => { setWeight(e.target.value); setError('') }}
              placeholder="7.20"
              style={{ width: '100%' }}
              autoFocus
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="label" style={{ fontSize: 11, marginBottom: 4 }}>{t('growth.heightLabel')} ({t('growth.heightUnit')})</div>
            <input
              type="number"
              className="input-field"
              value={height}
              step="0.1"
              min="30"
              max="120"
              onChange={e => { setHeight(e.target.value); setError('') }}
              placeholder="68.5"
              style={{ width: '100%' }}
            />
          </div>
        </div>
        {error && (
          <div style={{ fontSize: 11, color: 'var(--delta-down)', marginBottom: 8 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>{t('growth.cancel')}</button>
          <button type="button" className="btn-primary" onClick={handleSubmit}>{t('growth.record')}</button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main HomePage
// ---------------------------------------------------------------------------

type ActivePopover = 'temp' | 'breast' | 'formula' | 'growth' | null

interface HomePageProps {
  onNavigate?: (page: 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings') => void
}

export function HomePage({ onNavigate }: HomePageProps) {
  const { addPee, addPoop, addTemp, addBreast, addFormula, addSleep, addGrowth, editEvent, softDeleteEvent, todayEvents, events } = useAppStore()
  const settings = useAppStore(s => s.settings)
  const dataInfo = useAppStore(s => s.dataInfo)
  const lastFeeding = useAppStore(s => s.lastFeeding())
  const peeCount = useAppStore(s => s.todayPeeCount())
  const poopCount = useAppStore(s => s.todayPoopCount())
  const todaySleepMin = useAppStore(s => s.todaySleepMinutes())
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()
  const [popover, setPopover] = useState<{ type: ActivePopover; anchor: DOMRect } | null>(null)
  const [quickMenuAnchor, setQuickMenuAnchor] = useState<DOMRect | null>(null)
  const [timeEditEvent, setTimeEditEvent] = useState<DiaryEvent | null>(null)
  const [timerTick, setTimerTick] = useState(0)
  const [sleepTick, setSleepTick] = useState(0)
  const [sleepConfirmAnchor, setSleepConfirmAnchor] = useState<{ anchor: DOMRect; startedAt: number } | null>(null)
  const [feedingTip, setFeedingTip] = useState<{
    type: 'formula' | 'breast'
    sourceLabel: string
    lastBreastAtISO?: string
  } | null>(null)
  const [feverModal, setFeverModal] = useState<{
    celsius: number
    level: Exclude<FeverLevel, null | 'caution'>
  } | null>(null)
  const quickRecordRef = useRef<HTMLDivElement>(null)
  const todayFormulaMlNow = useAppStore(s => s.todayFormulaTotalMl())
  const todayFeedingCountNow = useAppStore(s => s.todayFeedingCount())

  const today = todayEvents()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const dateStr = format(new Date(), t('date.formatLong'), { locale: dateFnsLocale })

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')
  const birthdate = settings?.baby?.birthdate
  const gender = settings?.baby?.gender
  const dday = birthdate ? getDDay(birthdate) : null
  const lang = i18nInstance.language

  const ageDays = React.useMemo<number | null>(() => {
    if (!birthdate) return null
    return differenceInDays(new Date(), parseISO(birthdate))
  }, [birthdate])

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

  const lastBreastEvent = React.useMemo((): DiaryEvent | null => {
    const breasts = events.filter(e => !e.deleted && e.type === 'breast')
    if (breasts.length === 0) return null
    return breasts.sort((a, b) => b.at.localeCompare(a.at))[0]
  }, [events])

  const onTimerChange = useCallback(() => setTimerTick(t => t + 1), [])

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

  const handlePee  = useCallback(() => quickRecord(() => addPee(), t('quickBtn.pee')), [quickRecord, addPee, t])
  const handlePoop = useCallback(() => quickRecord(() => addPoop(), t('quickBtn.poop')), [quickRecord, addPoop, t])

  const openPopover = (type: ActivePopover, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPopover({ type, anchor: rect })
  }

  const handleTempConfirm = async (celsius: number) => {
    setPopover(null)
    const label = `${t('quickBtn.temp')} ${celsius.toFixed(1)}℃`
    const level = evaluateFever(celsius, ageDays)
    if (level === 'emergency' || level === 'danger' || level === 'warning') {
      // Blocking modal — save directly (no undo available while modal is open)
      try {
        await addTemp(celsius)
        setFeverModal({ celsius, level })
      } catch {
        showToast({ message: t('toast.saveFailed') })
      }
    } else if (level === 'caution') {
      // Save with undo available + amber hint toast
      await quickRecord(() => addTemp(celsius), label)
      showToast({ message: t('feverModal.cautionToast'), className: 'toast-amber' })
    } else {
      // Normal
      await quickRecord(() => addTemp(celsius), label)
    }
  }

  // MF-10: wrap in useCallback so handleFloatingTimerStop captures a stable
  // reference that includes the live ageDays value — prevents stale closure
  // where ageDays===null makes the floating-pill stop bypass the FeedingTip.
  const handleBreastConfirm = useCallback(async (side: 'L' | 'R' | 'both', minutes?: number, startedAt?: string) => {
    setPopover(null)
    const sideLabel = side === 'L' ? t('breast.left') : side === 'R' ? t('breast.right') : t('breast.both')
    const label = `${t('quickBtn.breast')}(${sideLabel})`
    if (ageDays === null) {
      // No birthdate — normal toast
      await quickRecord(() => addBreast(side, minutes, startedAt), label)
      return
    }
    // With birthdate — show feeding tip popup (replaces success toast)
    try {
      const event = await addBreast(side, minutes, startedAt)
      const band = getFeedingBand(ageDays)
      const marker = band
        ? GUIDANCE_MARKERS.find(m => m.id === band.id)
        : GUIDANCE_MARKERS.find(m => m.id === 'formula_0_1mo')
      setFeedingTip({ type: 'breast', sourceLabel: marker?.sourceLabel ?? 'AAP', lastBreastAtISO: event.at })
    } catch {
      showToast({ message: t('toast.saveFailed') })
    }
  }, [ageDays, addBreast, showToast, t, setFeedingTip, setPopover, quickRecord])

  const handleFormulaConfirm = async (ml: number) => {
    setPopover(null)
    const label = `${t('quickBtn.formula')} ${ml}ml`
    if (ageDays === null) {
      await quickRecord(() => addFormula(ml), label)
      return
    }
    try {
      await addFormula(ml)
      const band = getFeedingBand(ageDays)
      const marker = band
        ? GUIDANCE_MARKERS.find(m => m.id === band.id)
        : GUIDANCE_MARKERS.find(m => m.id === 'formula_0_1mo')
      setFeedingTip({ type: 'formula', sourceLabel: marker?.sourceLabel ?? 'AAP' })
    } catch {
      showToast({ message: t('toast.saveFailed') })
    }
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

  // MF-10: handleBreastConfirm is now stable (useCallback above), so include it here.
  const handleFloatingTimerStop = useCallback(() => {
    if (nursingTimer.running && nursingTimer.startedAt != null) {
      const now = Date.now()
      const elapsedSec = Math.floor((now - nursingTimer.startedAt) / 1000)
      // P14+P15: stop time is canonical `at`; cap at MAX_ELAPSED_MIN
      const elapsedMin = Math.min(MAX_ELAPSED_MIN, Math.max(1, Math.ceil(elapsedSec / 60)))
      const stopAtISO = new Date(now).toISOString()
      const side: 'L' | 'R' | 'both' = lastBreastSide === 'L' ? 'R' : lastBreastSide === 'R' ? 'L' : 'both'
      nursingTimer.running = false
      nursingTimer.startedAt = null
      saveNursingTimer(nursingTimer)
      setTimerTick(t => t + 1)
      handleBreastConfirm(side, elapsedMin, stopAtISO)
    }
  }, [lastBreastSide, handleBreastConfirm])

  const handleSleepButtonClick = useCallback((e: React.MouseEvent) => {
    if (sleepTimer.running && sleepTimer.startedAt != null) {
      if (Date.now() - sleepTimer.startedAt > MAX_SLEEP_MS) {
        sleepTimer.running = false
        sleepTimer.startedAt = null
        saveSleepTimer(sleepTimer)
        setSleepTick(c => c + 1)
        showToast({ message: t('sleep.discardBody') })
        return
      }
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setSleepConfirmAnchor({ anchor: rect, startedAt: sleepTimer.startedAt })
    } else {
      sleepTimer.running = true
      sleepTimer.startedAt = Date.now()
      saveSleepTimer(sleepTimer)
      setSleepTick(c => c + 1)
    }
  }, [showToast, t])

  const handleSleepStop = useCallback(() => {
    if (sleepTimer.running && sleepTimer.startedAt != null) {
      const rect = document.querySelector('.quick-btn-circle-sleep')?.getBoundingClientRect()
        ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)
      setSleepConfirmAnchor({ anchor: rect, startedAt: sleepTimer.startedAt })
    }
  }, [])

  const handleSleepConfirm = useCallback(async (minutes: number, startAtISO: string) => {
    if (!sleepTimer.running) return
    sleepTimer.running = false
    sleepTimer.startedAt = null
    saveSleepTimer(sleepTimer)
    setSleepTick(c => c + 1)
    setSleepConfirmAnchor(null)
    await quickRecord(() => addSleep(minutes, startAtISO), t('event.sleep'))
  }, [addSleep, quickRecord, t])

  const handleSleepCancel = useCallback(() => {
    setSleepConfirmAnchor(null)
  }, [])

  const handleGrowthConfirm = useCallback(async (weightKg: number | undefined, heightCm: number | undefined) => {
    setPopover(null)
    if (weightKg == null && heightCm == null) return
    const parts: string[] = []
    if (weightKg != null) parts.push(`${weightKg.toFixed(1)}kg`)
    if (heightCm != null) parts.push(`${heightCm.toFixed(1)}cm`)
    const label = `${t('event.growth')} ${parts.join('·')}`
    await quickRecord(() => addGrowth(weightKg, heightCm), label)
  }, [addGrowth, quickRecord, t])

  // Keyboard shortcuts (1–6) — work both when quick menu is open and from the main view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape' && quickMenuAnchor) { setQuickMenuAnchor(null); return }
      // MF-09: suppress digit shortcuts while any modal/popover/tutorial is open
      if (popover || sleepConfirmAnchor || feverModal || timeEditEvent || feedingTip) return
      // P24: Suppress digit shortcuts while the tutorial overlay is active.
      // Pressing '1' during tour would silently record a pee event under the overlay.
      if (document.querySelector('.tour-overlay, .tour-overlay-strip')) return

      // Digits work from main view (quick-record row always visible) or from the menu
      switch (e.key) {
        case '1': e.preventDefault(); handlePee(); setQuickMenuAnchor(null); break
        case '2': e.preventDefault(); handlePoop(); setQuickMenuAnchor(null); break
        case '3': { e.preventDefault(); const btn = document.querySelector('.quick-btn-circle-temp') as HTMLElement; if (btn) btn.click(); setQuickMenuAnchor(null); break }
        case '4': { e.preventDefault(); const btn = document.querySelector('.quick-btn-circle-breast') as HTMLElement; if (btn) btn.click(); setQuickMenuAnchor(null); break }
        case '5': { e.preventDefault(); const btn = document.querySelector('.quick-btn-circle-formula') as HTMLElement; if (btn) btn.click(); setQuickMenuAnchor(null); break }
        case '6': { e.preventDefault(); const btn = document.querySelector('.quick-btn-circle-sleep') as HTMLElement; if (btn) btn.click(); setQuickMenuAnchor(null); break }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // MF-09: include all modal/popover states that suppress digit shortcuts
  }, [popover, sleepConfirmAnchor, feverModal, timeEditEvent, feedingTip, quickMenuAnchor, handlePee, handlePoop])

  // Quick-record buttons config
  const sleepRunning = sleepTimer.running
  const sleepBtnLabel = sleepRunning ? t('quickBtn.sleepRunning') : t('quickBtn.sleep')

  const quickBtns = [
    { cls: 'quick-btn-circle quick-btn-circle-pee',     Icon: IconDrop,        label: t('quickBtn.pee'),     badge: '1', onClick: handlePee },
    { cls: 'quick-btn-circle quick-btn-circle-poop',    Icon: IconPoop,        label: t('quickBtn.poop'),    badge: '2', onClick: handlePoop },
    { cls: 'quick-btn-circle quick-btn-circle-temp',    Icon: IconThermometer, label: t('quickBtn.temp'),    badge: '3', onClick: (e: React.MouseEvent) => openPopover('temp', e) },
    { cls: 'quick-btn-circle quick-btn-circle-breast',  Icon: IconHeart,       label: t('quickBtn.breast'),  badge: '4', onClick: (e: React.MouseEvent) => openPopover('breast', e) },
    { cls: 'quick-btn-circle quick-btn-circle-formula', Icon: IconBottle,      label: t('quickBtn.formula'), badge: '5', onClick: (e: React.MouseEvent) => openPopover('formula', e) },
    { cls: `quick-btn-circle quick-btn-circle-sleep${sleepRunning ? ' quick-btn-running' : ''}`,
      Icon: IconMoon, label: sleepBtnLabel, badge: '6', onClick: handleSleepButtonClick },
  ]

  return (
    <div className="page-container">

      {/* ── Header row ── */}
      <div className="home-header-row" data-tour="hero">
        <div className="home-header-left">
          <div className="home-hero-date">{dateStr}</div>
          <div className="home-hero-title">{t('nav.home')}</div>
          <div className="home-hero-subtitle">{t('home.subtitle')}</div>
          {dday != null ? (
            <div className="home-hero-dday">{t('dday', { days: dday })}</div>
          ) : (
            <button className="home-hero-dday-btn" onClick={() => onNavigate?.('settings')}>
              {t('home.setBirthday')}
            </button>
          )}
        </div>

        {/* + Record button — opens glass quick-menu dropdown */}
        <button
          className="btn-add-record"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setQuickMenuAnchor(prev => prev ? null : rect)
          }}
          aria-label={t('home.addRecord')}
          aria-haspopup="menu"
          aria-expanded={quickMenuAnchor !== null}
        >
          <span style={{ fontSize: 15, fontWeight: 700, marginRight: 1 }}>+</span>
          {t('home.addRecord')}
        </button>
      </div>

      {/* ── Milestone alert banners (within next 7 days, only when birthdate set) ── */}
      {birthdate && (
        <MilestoneAlertBanners
          birthdate={birthdate}
          gender={gender}
          lang={lang}
        />
      )}

      {/* ── Quick record banners ── */}
      <div className="quick-record-row" ref={quickRecordRef} id="quick-record-row" data-tour="quick-row">
        {quickBtns.map(({ cls, Icon, label, badge, onClick }, i) => (
          <div
            key={badge}
            className="quick-record-slot stagger-mount"
            style={{ '--i': i } as React.CSSProperties}
          >
            <button
              className={cls}
              onClick={onClick as React.MouseEventHandler}
            >
              <span className="quick-btn-badge">{badge}</span>
              <div className="quick-btn-icon-circle">
                <Icon size={22} />
              </div>
              <span className="quick-btn-circle-label">{label}</span>
            </button>
          </div>
        ))}
      </div>

      {/* Keyboard shortcut hint */}
      <div className="quick-btn-hint">{t('quickBtnHint')}</div>

      {/* ── Main 2-column grid ── */}
      <div className="home-main-grid">

        {/* LEFT: stat cards + timeline */}
        <div>
          <StatCards />

          <div className="card">
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 14 }}>
              {t('home.todayRecords')}
            </div>
            <EventTimeline events={today} showAuthor editable />
          </div>
        </div>

        {/* RIGHT: insights rail */}
        <InsightsPanel
          lastFeeding={lastFeeding}
          lastBreastSide={lastBreastSide}
          lastBreastEvent={lastBreastEvent}
          todayPeeCount={peeCount}
          todayPoopCount={poopCount}
          dataInfo={dataInfo}
          birthdate={birthdate ?? undefined}
          ageDays={ageDays}
          onNavigate={onNavigate}
          todaySleepMinutes={todaySleepMin}
        />
      </div>

      {/* Floating nursing timer pill */}
      {nursingTimer.running && (
        <FloatingTimerPill key={timerTick} onStop={handleFloatingTimerStop} />
      )}

      {/* Floating sleep timer pill */}
      {sleepTimer.running && (
        <FloatingSleepPill key={sleepTick} onStop={handleSleepStop} />
      )}

      {/* Sleep confirm popover */}
      {sleepConfirmAnchor && (
        <SleepConfirmPopover
          startedAt={sleepConfirmAnchor.startedAt}
          anchor={sleepConfirmAnchor.anchor}
          onConfirm={handleSleepConfirm}
          onCancel={handleSleepCancel}
        />
      )}

      {/* Quick record glass dropdown menu */}
      {quickMenuAnchor && (
        <QuickMenu
          anchor={quickMenuAnchor}
          onPee={handlePee}
          onPoop={handlePoop}
          onOpenTemp={() => {
            const rect = quickMenuAnchor
            setPopover({ type: 'temp', anchor: rect })
          }}
          onOpenBreast={() => {
            const rect = quickMenuAnchor
            setPopover({ type: 'breast', anchor: rect })
          }}
          onOpenFormula={() => {
            const rect = quickMenuAnchor
            setPopover({ type: 'formula', anchor: rect })
          }}
          onSleep={handleSleepButtonClick}
          onOpenGrowth={() => {
            const rect = quickMenuAnchor
            setPopover({ type: 'growth', anchor: rect })
          }}
          onClose={() => setQuickMenuAnchor(null)}
        />
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
      {popover?.type === 'growth' && (
        <GrowthPopover
          anchor={popover.anchor}
          onConfirm={handleGrowthConfirm}
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

      {/* Feeding tip popup */}
      {feedingTip && ageDays !== null && (
        <FeedingTipPopup
          type={feedingTip.type}
          ageDays={ageDays}
          lastBreastSide={lastBreastSide}
          todayFormulaTotalMl={todayFormulaMlNow}
          todayFeedingCount={todayFeedingCountNow}
          sourceLabel={feedingTip.sourceLabel}
          lastBreastAtISO={feedingTip.lastBreastAtISO}
          onNavigate={onNavigate}
          onDismiss={() => setFeedingTip(null)}
        />
      )}

      {/* Fever modal */}
      {feverModal && (
        <FeverModal
          celsius={feverModal.celsius}
          level={feverModal.level}
          ageDays={ageDays}
          lang={lang}
          onConfirm={() => setFeverModal(null)}
        />
      )}
    </div>
  )
}
