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
// TODO: guidance markers — add import and spread here when guidance.ts
// exposes a getGuidanceMarkers() function.
// const guidanceMarkers: CalendarMarker[] = []
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getMarkers — main entry point
// ---------------------------------------------------------------------------

/**
 * Returns all CalendarMarkers for a given birthdate and optional gender.
 * Sorted by date ascending.
 */
export function getMarkers(
  birthdate: string,
  gender?: 'girl' | 'boy'
): CalendarMarker[] {
  if (!birthdate) return []

  const milestoneMarkers = getMilestones(birthdate, gender).map(milestoneToMarker)

  // TODO: spread guidanceMarkers here when guidance calendar support is added
  const allMarkers = [...milestoneMarkers]

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
