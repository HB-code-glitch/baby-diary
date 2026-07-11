/**
 * src/lib/markers.ts
 * Generic CalendarMarker abstraction — single provider consumed by
 * HistoryPage and HomePage.
 *
 * Milestones feed it now.
 * TODO: import getGuidanceMarkers from './guidance' and spread into providers
 * when guidance calendar-marker support is added.
 */

import { getMilestones, Milestone } from './milestones'
import { getCalendarGuidance } from './guidance'

// ---------------------------------------------------------------------------
// CalendarMarker interface
// ---------------------------------------------------------------------------

export type MarkerKind = 'milestone' | 'guidance'

export interface CalendarMarker {
  /** Source id (milestone id, guidance id, etc.) */
  id: string
  /** ISO date string 'yyyy-MM-dd' */
  date: string
  kind: MarkerKind
  /** Display title in current UI language — caller selects ko/ja */
  titleKo: string
  titleJa: string
  /** Full description */
  descKo: string
  descJa: string
  /** Tailwind/CSS tint class hint: 'festive' | 'sky' */
  tint: 'festive' | 'sky'
  /** Icon name: 'star' | 'gift' | 'info' */
  icon: 'star' | 'gift' | 'info'
}

// ---------------------------------------------------------------------------
// Milestone → CalendarMarker conversion
// ---------------------------------------------------------------------------

function milestoneToMarker(m: Milestone): CalendarMarker {
  return {
    id: m.id,
    date: m.date,
    kind: 'milestone',
    titleKo: m.nameKo,
    titleJa: m.nameJa,
    descKo: m.descKo,
    descJa: m.descJa,
    tint: 'festive',
    icon: m.id === 'cheosdol' || m.id.startsWith('yearly-birthday') ? 'gift' : 'star',
  }
}

// ---------------------------------------------------------------------------
// Guidance → CalendarMarker conversion (startDay > 0 only)
// ---------------------------------------------------------------------------

function guidanceToMarker(date: string, id: string, titleKo: string, titleJa: string, bodyKo: string, bodyJa: string): CalendarMarker {
  return {
    id: `guidance-${id}`,
    date,
    kind: 'guidance',
    titleKo,
    titleJa,
    descKo: bodyKo,
    descJa: bodyJa,
    tint: 'sky',
    icon: 'info',
  }
}

// ---------------------------------------------------------------------------
// getMarkers — main entry point
// ---------------------------------------------------------------------------

/**
 * Returns all CalendarMarkers for a given birthdate and optional gender.
 * Sorted by date ascending.
 * Includes milestone markers (festive) + guidance calendar markers (sky, startDay > 0 only).
 */
export function getMarkers(
  birthdate: string,
  gender?: 'girl' | 'boy'
): CalendarMarker[] {
  if (!birthdate) return []

  const milestoneMarkers = getMilestones(birthdate, gender).map(milestoneToMarker)

  // Guidance calendar markers — only startDay > 0 (day-0 items would clutter birth date)
  const calGuidance = getCalendarGuidance(birthdate)
  const guidanceMarkers: CalendarMarker[] = calGuidance.map(({ marker, date }) =>
    guidanceToMarker(date, marker.id, marker.titleKo, marker.titleJa, marker.bodyKo, marker.bodyJa)
  )

  const allMarkers = [...milestoneMarkers, ...guidanceMarkers]

  return allMarkers.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Returns markers for a specific date string 'yyyy-MM-dd'.
 */
export function getMarkersForDate(
  markers: CalendarMarker[],
  dateStr: string
): CalendarMarker[] {
  return markers.filter(m => m.date === dateStr)
}
