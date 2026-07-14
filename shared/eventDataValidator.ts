import type { EventType } from './types'

export const EVENT_DATA_LIMITS = Object.freeze({
  noteCharacters: 2_000,
  titleCharacters: 200,
  longTextCharacters: 20_000,
  maxPayloadBytes: 32_768,
})

const MAX_JSON_DEPTH = 16
const MAX_JSON_NODES = 2_048

interface ValidationOptions {
  /** Tombstones retain and validate the exact original typed data payload. */
  deleted?: boolean
}

interface JsonWalkState {
  ancestors: Set<object>
  nodes: number
}

function isPlainJsonValue(value: unknown, depth: number, state: JsonWalkState): boolean {
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (state.ancestors.has(value)) return false

  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false
        if (!isPlainJsonValue(value[index], depth + 1, state)) return false
      }
      return Reflect.ownKeys(value).every(key => (
        key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key))
      ))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false
      if (!isPlainJsonValue(descriptor.value, depth + 1, state)) return false
    }
    return true
  } finally {
    state.ancestors.delete(value)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record)
  if (required.some(key => !hasOwn(record, key))) return false
  const allowed = new Set([...required, ...optional])
  return keys.every(key => allowed.has(key))
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function hasValidOptionalNote(record: Record<string, unknown>): boolean {
  return !hasOwn(record, 'note')
    || isBoundedString(record.note, EVENT_DATA_LIMITS.noteCharacters)
}

function isFiniteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
}

function isIntegerRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum
}

function validateTypedData(type: EventType, data: Record<string, unknown>): boolean {
  switch (type) {
    case 'pee':
    case 'poop':
      return hasExactKeys(data, [], ['note']) && hasValidOptionalNote(data)
    case 'temp':
      return hasExactKeys(data, ['celsius'], ['note'])
        && isFiniteRange(data.celsius, 35, 42)
        && hasValidOptionalNote(data)
    case 'breast':
      return hasExactKeys(data, ['side'], ['minutes', 'note'])
        && (data.side === 'L' || data.side === 'R' || data.side === 'both')
        && (!hasOwn(data, 'minutes') || isIntegerRange(data.minutes, 1, 240))
        && hasValidOptionalNote(data)
    case 'formula':
      return hasExactKeys(data, ['ml'], ['note'])
        && isIntegerRange(data.ml, 10, 2_000)
        && hasValidOptionalNote(data)
    case 'sleep':
      return hasExactKeys(data, ['minutes'], ['note'])
        && isIntegerRange(data.minutes, 1, 960)
        && hasValidOptionalNote(data)
    case 'growth': {
      const hasWeight = hasOwn(data, 'weightKg')
      const hasHeight = hasOwn(data, 'heightCm')
      return hasExactKeys(data, [], ['weightKg', 'heightCm', 'note'])
        && (hasWeight || hasHeight)
        && (!hasWeight || isFiniteRange(data.weightKg, 0.5, 30))
        && (!hasHeight || isFiniteRange(data.heightCm, 30, 120))
        && hasValidOptionalNote(data)
    }
    case 'diary':
      return hasExactKeys(data, ['text'], ['title'])
        && (!hasOwn(data, 'title') || isBoundedString(data.title, EVENT_DATA_LIMITS.titleCharacters))
        && isBoundedString(data.text, EVENT_DATA_LIMITS.longTextCharacters)
        && data.text.trim().length > 0
    case 'message':
      return hasExactKeys(data, ['text'])
        && isBoundedString(data.text, EVENT_DATA_LIMITS.longTextCharacters)
        && data.text.trim().length > 0
    default:
      return false
  }
}

/**
 * Strict renderer/disk/cloud boundary for a DiaryEvent's type-specific data.
 * A deleted mutation is still an immutable tombstone of the original payload;
 * deletion never relaxes the schema or permits attacker-controlled junk data.
 */
export function validateDiaryEventData(
  type: EventType,
  data: unknown,
  options: ValidationOptions = {},
): string | null {
  if (options.deleted !== undefined && typeof options.deleted !== 'boolean') {
    return 'deleted must be a boolean when provided'
  }
  if (!isPlainRecord(data)) return 'data must be a plain object'
  if (!isPlainJsonValue(data, 0, { ancestors: new Set(), nodes: 0 })) {
    return 'data must be finite, acyclic, dense plain JSON'
  }

  const serialized = JSON.stringify(data)
  if (new TextEncoder().encode(serialized).byteLength > EVENT_DATA_LIMITS.maxPayloadBytes) {
    return 'data exceeds the encoded payload limit'
  }
  if (!validateTypedData(type, data)) return `invalid ${type} data payload`
  return null
}
