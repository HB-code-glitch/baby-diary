import React from 'react'
import { Droplets, Wind, Thermometer, Heart, Baby, BookOpen, Mail } from 'lucide-react'
import { EventType } from '../../shared/types'
import i18n from '../i18n'

interface EventIconProps {
  type: EventType
  size?: number
}

const COLOR_MAP: Record<EventType, { bg: string; color: string }> = {
  pee:     { bg: 'var(--sage-100)',  color: 'var(--sage-500)' },
  poop:    { bg: 'var(--sage-100)',  color: 'var(--sage-400)' },
  temp:    { bg: 'var(--amber-100)', color: 'var(--amber-500)' },
  breast:  { bg: 'var(--peach-100)', color: 'var(--peach-500)' },
  formula: { bg: 'var(--peach-100)', color: 'var(--peach-400)' },
  diary:   { bg: 'var(--rose-100)',  color: 'var(--rose-400)' },
  message: { bg: 'var(--rose-100)',  color: 'var(--rose-400)' },
}

const ICON_MAP: Record<EventType, React.ElementType> = {
  pee:     Droplets,
  poop:    Wind,
  temp:    Thermometer,
  breast:  Heart,
  formula: Baby,
  diary:   BookOpen,
  message: Mail,
}

export function EventIcon({ type, size = 15 }: EventIconProps) {
  const { bg, color } = COLOR_MAP[type] ?? { bg: 'var(--stone-100)', color: 'var(--stone-500)' }
  const Icon = ICON_MAP[type] ?? Droplets

  return (
    <div
      className="timeline-icon"
      style={{ background: bg }}
    >
      <Icon size={size} style={{ color }} />
    </div>
  )
}

export function eventLabel(type: EventType): string {
  const t = i18n.t.bind(i18n)
  const KEY_MAP: Record<EventType, string> = {
    pee:     'event.pee',
    poop:    'event.poop',
    temp:    'event.temp',
    breast:  'event.breast',
    formula: 'event.formula',
    diary:   'event.diary',
    message: 'event.message',
  }
  return t(KEY_MAP[type] ?? type)
}
