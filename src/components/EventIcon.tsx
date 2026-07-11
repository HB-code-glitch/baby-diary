import React from 'react'
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconBook, IconEnvelopeHeart, IconMoon, IconRuler } from './icons'
import { EventType } from '../../shared/types'
import i18n from '../i18n'

interface EventIconProps {
  type: EventType
  size?: number
}

const COLOR_MAP: Record<EventType, { bg: string; color: string; ring: string }> = {
  pee:     { bg: 'var(--sage-100)',      color: 'var(--sage-600)',      ring: 'var(--sage-200)' },
  poop:    { bg: 'var(--sage-100)',      color: 'var(--sage-500)',      ring: 'var(--sage-200)' },
  temp:    { bg: 'var(--amber-100)',     color: 'var(--amber-600)',     ring: 'var(--amber-200)' },
  breast:  { bg: 'var(--peach-100)',    color: 'var(--peach-600)',     ring: 'var(--peach-200)' },
  formula: { bg: 'var(--peach-100)',    color: 'var(--peach-500)',     ring: 'var(--peach-200)' },
  diary:   { bg: 'var(--rose-100)',     color: 'var(--rose-500)',      ring: 'var(--rose-200)' },
  message: { bg: 'var(--rose-100)',     color: 'var(--rose-500)',      ring: 'var(--rose-200)' },
  sleep:   { bg: 'var(--lavender-100)', color: 'var(--lavender-600)',  ring: 'var(--lavender-200)' },
  growth:  { bg: 'var(--indigo-100)',   color: 'var(--indigo-600)',    ring: 'var(--indigo-200)' },
}

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

const ICON_MAP: Record<EventType, IconComponent> = {
  pee:     IconDrop,
  poop:    IconPoop,
  temp:    IconThermometer,
  breast:  IconHeart,
  formula: IconBottle,
  diary:   IconBook,
  message: IconEnvelopeHeart,
  sleep:   IconMoon,
  growth:  IconRuler,
}

export function EventIcon({ type, size = 15 }: EventIconProps) {
  const { bg, color, ring } = COLOR_MAP[type] ?? { bg: 'var(--stone-100)', color: 'var(--stone-500)', ring: 'var(--stone-200)' }
  const Icon = ICON_MAP[type] ?? IconDrop

  return (
    <div
      className="timeline-icon"
      style={{
        background: bg,
        boxShadow: `0 0 0 2px ${ring}`,
      }}
    >
      <Icon size={size} color={color} />
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
    sleep:   'event.sleep',
    growth:  'event.growth',
  }
  return t(KEY_MAP[type] ?? type)
}
