import { parseISO } from 'date-fns'

export interface TimestampedEvent {
  readonly id: string
  readonly at: string
}

function timestampMs(value: string | number | Date): number | null {
  const epoch = typeof value === 'number'
    ? value
    : value instanceof Date
      ? value.getTime()
      : parseISO(value).getTime()
  return Number.isFinite(epoch) ? epoch : null
}

export function eventTimestampMs(at: string): number | null {
  return timestampMs(at)
}

function deterministicTieBreak(left: TimestampedEvent, right: TimestampedEvent): number {
  return left.id.localeCompare(right.id)
}

/** Valid events first, newest epoch first, then a stable content tie-break. */
export function compareEventsNewestFirst(left: TimestampedEvent, right: TimestampedEvent): number {
  const leftEpoch = eventTimestampMs(left.at)
  const rightEpoch = eventTimestampMs(right.at)

  if (leftEpoch === null && rightEpoch === null) return deterministicTieBreak(left, right)
  if (leftEpoch === null) return 1
  if (rightEpoch === null) return -1

  const epochOrder = rightEpoch - leftEpoch
  return epochOrder !== 0 ? epochOrder : deterministicTieBreak(left, right)
}

export function sortEventsNewestFirst<T extends TimestampedEvent>(events: readonly T[]): T[] {
  return [...events].sort(compareEventsNewestFirst)
}

export function sortValidEventsNewestFirst<T extends TimestampedEvent>(events: readonly T[]): T[] {
  return events
    .filter(event => eventTimestampMs(event.at) !== null)
    .sort(compareEventsNewestFirst)
}

export function latestValidEvent<T extends TimestampedEvent>(events: readonly T[]): T | null {
  return sortValidEventsNewestFirst(events)[0] ?? null
}

export function isEventAtOrBefore(eventAt: string, cutoff: string | number | Date): boolean {
  const eventEpoch = eventTimestampMs(eventAt)
  const cutoffEpoch = timestampMs(cutoff)
  return eventEpoch !== null && cutoffEpoch !== null && eventEpoch <= cutoffEpoch
}
