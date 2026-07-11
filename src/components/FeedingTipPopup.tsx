import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getFeedingBand } from '../lib/guidance'
import { IconX } from './icons'

export interface FeedingTipPopupProps {
  type: 'formula' | 'breast'
  /** Baby age in days. null = birthdate not set — render nothing */
  ageDays: number | null
  lastBreastSide: 'L' | 'R' | 'both' | null
  todayFormulaTotalMl: number
  todayFeedingCount: number
  /** sourceLabel from the matched marker (e.g. 'AAP·CDC·厚生労働省') */
  sourceLabel: string
  onNavigate?: (page: 'settings') => void
  onDismiss: () => void
}

const AUTO_DISMISS_MS = 8000

export function FeedingTipPopup({
  type,
  ageDays,
  lastBreastSide,
  todayFormulaTotalMl,
  todayFeedingCount,
  sourceLabel,
  onNavigate,
  onDismiss,
}: FeedingTipPopupProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [onDismiss])

  // No birthdate → skip popup (caller shows normal toast)
  if (ageDays === null) return null

  const band = getFeedingBand(ageDays)

  let mainLine: string
  let isAmber = false

  if (type === 'formula') {
    if (band?.dailyMaxMl != null) {
      const remaining = band.dailyMaxMl - todayFormulaTotalMl
      if (remaining > 0) {
        mainLine = t('feedingTip.formulaWithMax', {
          total: todayFormulaTotalMl,
          max: band.dailyMaxMl,
          remaining,
        })
      } else {
        mainLine = t('feedingTip.formulaReachedMax', {
          total: todayFormulaTotalMl,
          max: band.dailyMaxMl,
        })
        isAmber = true
      }
    } else if (band != null) {
      mainLine = t('feedingTip.formulaNoMax', {
        total: todayFormulaTotalMl,
        count: todayFeedingCount,
        perMin: band.perFeedMlMin,
        perMax: band.perFeedMlMax,
        dayMin: band.feedsPerDayMin,
        dayMax: band.feedsPerDayMax,
      })
    } else {
      mainLine = t('feedingTip.formulaNoMaxNoBand', {
        total: todayFormulaTotalMl,
        count: todayFeedingCount,
      })
    }
  } else {
    // breast
    mainLine = t('feedingTip.breastCount', { count: todayFeedingCount })
  }

  const lastSideLabel =
    type === 'breast' && lastBreastSide != null
      ? lastBreastSide === 'L'
        ? t('breast.left')
        : lastBreastSide === 'R'
          ? t('breast.right')
          : null
      : null

  return (
    <div
      className={`feeding-tip-popup${isAmber ? ' feeding-tip-popup-amber' : ''}`}
      role="status"
      aria-live="polite"
    >
      <button
        className="feeding-tip-dismiss"
        onClick={onDismiss}
        aria-label={t('feedingTip.dismiss')}
      >
        <IconX size={14} />
      </button>

      <div className="feeding-tip-main">{mainLine}</div>

      {lastSideLabel && (
        <div className="feeding-tip-sub">
          {t('feedingTip.breastLastSide', { side: lastSideLabel })}
        </div>
      )}

      {/* P31: aria-label from i18n key instead of hardcoded bilingual string */}
      <button
        className="feeding-tip-footer"
        onClick={() => onNavigate?.('settings')}
        aria-label={t('feedingTip.footerAriaLabel')}
      >
        {t('feedingTip.footerSource', { sourceLabel })}
        <span className="feeding-tip-footer-note"> · {t('feedingTip.footerDisclaimer')}</span>
      </button>
    </div>
  )
}
