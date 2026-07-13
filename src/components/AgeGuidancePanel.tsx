import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HealthContentLocale, HealthEvidenceSourceId } from '../../shared/healthEvidence'
import {
  AGE_GUIDANCE_DISCLAIMER,
  calculateCompletedCalendarMonths,
  getAgeGuidanceForDate,
  getAgeStage,
  getDevelopmentCheckpointForDate,
  localizeAgeGuidance,
  type AgeGuidanceCategory,
  type AgeGuidanceCountry,
  type LocalizedAgeGuidance,
} from '../lib/ageGuidance'
import { EvidenceSourceList } from './EvidenceSourceList'

export interface AgeGuidancePanelProps {
  birthdate?: string | null
  asOf?: string | Date
  variant?: 'home' | 'settings'
  country?: AgeGuidanceCountry
  onRequestBirthdate?: () => void
}

const categoryOrder: readonly AgeGuidanceCategory[] = [
  'urgent-care',
  'feeding',
  'safe-sleep',
  'food-safety',
  'activity-sleep',
  'development',
  'oral-health',
  'checkup-vaccination',
  'general',
]

function ControlledDetails({
  className,
  summary,
  children,
  defaultOpen = false,
  dataAttributes,
}: {
  className: string
  summary: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  dataAttributes?: Record<string, string | number | boolean>
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details className={className} open={open} {...dataAttributes}>
      <summary
        aria-expanded={open}
        onClick={event => {
          event.preventDefault()
          setOpen(value => !value)
        }}
      >
        {summary}
        <span className="age-guidance-chevron" aria-hidden="true">⌄</span>
      </summary>
      {open && children}
    </details>
  )
}

function GuidanceItemCard({
  item,
  locale,
  priority,
}: {
  item: LocalizedAgeGuidance
  locale: HealthContentLocale
  priority?: boolean
}) {
  const urgencyLabel = locale === 'ja'
    ? { urgent: '緊急', important: '重要', routine: '日常' }[item.urgency]
    : { urgent: '긴급', important: '중요', routine: '일상' }[item.urgency]
  const actionTitle = locale === 'ja' ? '確認すること' : '확인할 것'

  return (
    <ControlledDetails
      className={`age-guidance-item urgency-${item.urgency}`}
      dataAttributes={priority ? { 'data-guidance-priority': true } : undefined}
      summary={(
        <>
          <span className="age-guidance-urgency">{urgencyLabel}</span>
          <span className="age-guidance-item-heading">
            <strong>{item.title}</strong>
            <small>{item.summary}</small>
          </span>
        </>
      )}
    >
      <div className="age-guidance-item-body">
        <div className="age-guidance-action-label">{actionTitle}</div>
        <ul>
          {item.actions.map(action => <li key={action}>{action}</li>)}
        </ul>
        <EvidenceSourceList sourceIds={item.sourceIds} locale={locale} compact />
      </div>
    </ControlledDetails>
  )
}

export function AgeGuidancePanel({
  birthdate,
  asOf = new Date(),
  variant = 'home',
  country,
  onRequestBirthdate,
}: AgeGuidancePanelProps) {
  const { t, i18n } = useTranslation()
  const locale: HealthContentLocale = i18n.language === 'ja' ? 'ja' : 'ko'
  const [showAll, setShowAll] = useState(false)
  const categories = Object.fromEntries(
    categoryOrder.map(category => [category, t(`ageGuidance.categories.${category}`)]),
  ) as Record<AgeGuidanceCategory, string>
  const copy = {
    eyebrow: t(variant === 'settings' ? 'ageGuidance.evidenceCenter' : 'ageGuidance.title'),
    title: t('ageGuidance.title'),
    description: t('ageGuidance.description'),
    more: (count: number) => t('ageGuidance.more', { count }),
    less: t('ageGuidance.less'),
    missingTitle: t('ageGuidance.missingTitle'),
    missingBody: t('ageGuidance.missingBody'),
    missingAction: t('ageGuidance.missingAction'),
    urgent: t('ageGuidance.urgent'),
    checkpoint: t('ageGuidance.checkpoint'),
    categories,
  }

  const stage = getAgeStage(birthdate, asOf)
  const completedMonths = calculateCompletedCalendarMonths(birthdate, asOf)
  const localizedItems = useMemo(
    () => getAgeGuidanceForDate(birthdate, asOf, country).map(item => localizeAgeGuidance(item, locale)),
    [birthdate, asOf, country, locale],
  )
  const checkpoint = getDevelopmentCheckpointForDate(birthdate, asOf)

  if (!birthdate || !stage || completedMonths === null) {
    return (
      <section className="age-guidance-panel is-missing" data-guidance-birthdate-prompt data-tour="age-guidance">
        <div className="age-guidance-eyebrow">{copy.title}</div>
        <h2>{copy.missingTitle}</h2>
        <p>{copy.missingBody}</p>
        {onRequestBirthdate && (
          <button type="button" className="age-guidance-prompt-button" onClick={onRequestBirthdate}>
            {copy.missingAction}
          </button>
        )}
      </section>
    )
  }

  const priorities = localizedItems.slice(0, 3)
  const secondary = localizedItems.slice(3)
  const urgentItems = localizedItems.filter(item => item.urgency === 'urgent')
  const urgentSourceIds = [...new Set(urgentItems.flatMap(item => item.sourceIds))] as HealthEvidenceSourceId[]
  const stageLabel = locale === 'ja' ? stage.labelJa : stage.labelKo
  const checkpointTitle = checkpoint ? (locale === 'ja' ? checkpoint.titleJa : checkpoint.titleKo) : null
  const checkpointActions = checkpoint ? (locale === 'ja' ? checkpoint.actionsJa : checkpoint.actionsKo) : []

  return (
    <section
      className={`age-guidance-panel is-${variant}`}
      data-tour="age-guidance"
      data-age-stage={stage.id}
    >
      <header className="age-guidance-header">
        <div>
          <div className="age-guidance-eyebrow">{copy.eyebrow}</div>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
        <span className="age-guidance-stage">{stageLabel}</span>
      </header>

      {variant === 'home' ? (
        <>
          <div className="age-guidance-priorities">
            {priorities.map(item => <GuidanceItemCard key={item.id} item={item} locale={locale} priority />)}
          </div>

          {secondary.length > 0 && (
            <button
              type="button"
              className="age-guidance-more"
              data-guidance-more
              aria-expanded={showAll}
              aria-controls="age-guidance-secondary"
              onClick={() => setShowAll(value => !value)}
            >
              {showAll ? copy.less : copy.more(secondary.length)}
            </button>
          )}
          {showAll && secondary.length > 0 && (
            <div id="age-guidance-secondary" data-guidance-secondary className="age-guidance-secondary">
              {secondary.map(item => <GuidanceItemCard key={item.id} item={item} locale={locale} />)}
            </div>
          )}
        </>
      ) : (
        <div className="age-guidance-category-list">
          {categoryOrder.map(category => {
            const categoryItems = localizedItems.filter(item => item.category === category)
            if (categoryItems.length === 0) return null
            return (
              <ControlledDetails
                key={category}
                className="age-guidance-category"
                summary={(
                  <>
                    <strong>{copy.categories[category]}</strong>
                    <span>{categoryItems.length}</span>
                  </>
                )}
              >
                <div className="age-guidance-category-body">
                  {categoryItems.map(item => <GuidanceItemCard key={item.id} item={item} locale={locale} />)}
                </div>
              </ControlledDetails>
            )
          })}

          {checkpoint && checkpointTitle && (
            <article
              className="age-guidance-checkpoint"
              data-development-checkpoint
              data-completed-months={completedMonths}
              data-checkpoint-month={checkpoint.completedMonth}
            >
              <div className="age-guidance-action-label">{copy.checkpoint}</div>
              <h3>{checkpointTitle}</h3>
              <ul>{checkpointActions.map(action => <li key={action}>{action}</li>)}</ul>
              <EvidenceSourceList sourceIds={checkpoint.sourceIds} locale={locale} />
            </article>
          )}
        </div>
      )}

      {urgentItems.length > 0 && (
        <ControlledDetails
          className="age-guidance-urgent-access"
          dataAttributes={{ 'data-guidance-urgent-access': true }}
          summary={<strong>{copy.urgent}</strong>}
        >
          <div className="age-guidance-urgent-body">
            {urgentItems.map(item => (
              <div key={item.id}>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
              </div>
            ))}
            <EvidenceSourceList sourceIds={urgentSourceIds} locale={locale} compact />
          </div>
        </ControlledDetails>
      )}

      <p className="age-guidance-disclaimer">
        {locale === 'ja' ? AGE_GUIDANCE_DISCLAIMER.ja : AGE_GUIDANCE_DISCLAIMER.ko}
      </p>
    </section>
  )
}
