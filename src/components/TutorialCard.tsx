import React from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { IconBook, IconClock, IconGear, IconHeart, IconStar } from './icons'
import type { TutorialIcon, TutorialStep } from '../lib/tutorial'

function IconCheck({ size = 20, color = 'currentColor' }: { size?: number; color?: string }) {
  return <Check size={size} color={color} aria-hidden="true" />
}

const ICONS: Record<TutorialIcon, React.ComponentType<{ size?: number; color?: string }>> = {
  heart: IconHeart,
  spark: IconStar,
  clock: IconClock,
  book: IconBook,
  settings: IconGear,
  check: IconCheck,
}

export interface TutorialCardProps {
  step: TutorialStep
  stepIndex: number
  totalSteps: number
  position: React.CSSProperties
  compact: boolean
  onBack: () => void
  onNext: () => void
  onSkip: () => void
  cardRef: React.RefObject<HTMLElement>
}

export function TutorialCard({
  step,
  stepIndex,
  totalSteps,
  position,
  compact,
  onBack,
  onNext,
  onSkip,
  cardRef,
}: TutorialCardProps) {
  const { t } = useTranslation()
  const Icon = ICONS[step.icon]
  const isWelcome = stepIndex === 0
  const isLast = stepIndex === totalSteps - 1
  const titleId = `tour-title-${step.id}`
  const bodyId = `tour-body-${step.id}`

  return (
    <section
      ref={cardRef}
      className={`tour-card${compact ? ' tour-card-compact' : ''}`}
      style={position}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <header className="tour-card-header">
        <div className={`tour-icon-tile tour-icon-${step.icon}`} aria-hidden="true">
          <Icon size={20} color="currentColor" />
        </div>
        <div className="tour-heading">
          <div className="tour-eyebrow">{t(step.eyebrowKey)}</div>
          <h2 className="tour-title" id={titleId}>{t(step.titleKey)}</h2>
        </div>
        {!isWelcome && (
          <button type="button" className="tour-skip-button" onClick={onSkip}>
            {t('tour.skipFull')}
          </button>
        )}
      </header>

      <p className="tour-body" id={bodyId}>{t(step.bodyKey)}</p>

      <div className="tour-progress">
        <span className="tour-progress-text">
          {t('tour.progress', { current: stepIndex + 1, total: totalSteps })}
        </span>
        <div className="tour-progress-rail" aria-hidden="true">
          {Array.from({ length: totalSteps }, (_, index) => (
            <span
              key={index}
              className={`tour-progress-segment${index < stepIndex ? ' is-complete' : ''}${index === stepIndex ? ' is-current' : ''}`}
            />
          ))}
        </div>
      </div>

      <footer className="tour-actions">
        {isWelcome ? (
          <button type="button" className="tour-skip-button" onClick={onSkip}>
            {t('tour.skipFull')}
          </button>
        ) : (
          <button type="button" className="tour-back-button" onClick={onBack}>
            {t('tour.back')}
          </button>
        )}
        <button type="button" className="tour-primary-button" onClick={onNext} autoFocus>
          {isWelcome ? t('tour.begin') : isLast ? t('tour.finish') : t('tour.next')}
        </button>
      </footer>
    </section>
  )
}
