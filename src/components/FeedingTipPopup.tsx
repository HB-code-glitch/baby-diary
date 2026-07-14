import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  BF_DISCLAIMER,
  BF_NEWBORN_GUIDANCE,
  BF_RESPONSIVE_GUIDANCE,
} from '../lib/breastfeeding'
import { IconX } from './icons'

export interface FeedingTipPopupProps {
  type: 'formula' | 'breast'
  /** Baby age in days. null = birthdate not set — render nothing. */
  ageDays: number | null
  lastBreastSide: 'L' | 'R' | 'both' | null
  todayFormulaTotalMl: number
  todayFeedingCount: number
  /** ISO timestamp used only to show elapsed recording context. */
  lastBreastAtISO?: string
  onNavigate?: (page: 'settings') => void
  onDismiss: () => void
}

function elapsedParts(lastAtISO: string | undefined): { hours: number; minutes: number } | null {
  if (!lastAtISO) return null
  const lastAt = new Date(lastAtISO)
  if (Number.isNaN(lastAt.getTime())) return null

  const totalMinutes = Math.max(0, Math.floor((Date.now() - lastAt.getTime()) / 60_000))
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  }
}

export function FeedingTipPopup({
  type,
  ageDays,
  lastBreastSide,
  todayFormulaTotalMl,
  todayFeedingCount,
  lastBreastAtISO,
  onNavigate,
  onDismiss,
}: FeedingTipPopupProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation()

  if (ageDays === null) return null

  const lang = i18n.resolvedLanguage === 'ja' ? 'ja' : 'ko'
  const elapsed = type === 'breast' ? elapsedParts(lastBreastAtISO) : null
  const lastSideLabel = lastBreastSide === 'L'
    ? t('breast.left')
    : lastBreastSide === 'R'
      ? t('breast.right')
      : lastBreastSide === 'both'
        ? t('breast.both')
        : null

  return (
    <div className="feeding-tip-popup" role="status" aria-live="polite">
      <button
        className="feeding-tip-dismiss"
        onClick={onDismiss}
        aria-label={t('feedingTip.dismiss')}
      >
        <IconX size={14} />
      </button>

      <div className="feeding-tip-main">
        {type === 'formula'
          ? t('feedingTip.formulaRecorded', {
              total: todayFormulaTotalMl,
              count: todayFeedingCount,
            })
          : t('feedingTip.breastCount', { count: todayFeedingCount })}
      </div>

      {type === 'breast' && lastSideLabel && (
        <div className="feeding-tip-sub">
          {t('feedingTip.breastRecordedSide', { side: lastSideLabel })}
        </div>
      )}

      {type === 'breast' && elapsed && (
        <div className="feeding-tip-sub">
          {t('feedingTip.breastElapsed', elapsed)}
        </div>
      )}

      <div className="feeding-tip-sub" style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
        {BF_RESPONSIVE_GUIDANCE[lang]}
      </div>

      {type === 'breast' && ageDays >= 0 && ageDays < 28 && (
        <div className="feeding-tip-sub" style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
          {BF_NEWBORN_GUIDANCE[lang]}
        </div>
      )}

      <button
        className="feeding-tip-footer"
        onClick={() => onNavigate?.('settings')}
        aria-label={t('feedingTip.footerAriaLabel')}
      >
        {BF_DISCLAIMER[lang]}
      </button>
    </div>
  )
}
