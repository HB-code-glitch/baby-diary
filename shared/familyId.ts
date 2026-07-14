const MAX_FIRESTORE_SEGMENT_BYTES = 1_500
const FORBIDDEN_CONTROL = /[\u0000-\u001f\u007f]/

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Shared production validator for a Firestore document-path segment used as a
 * family id. Legacy non-auto-id segments remain accepted when they are safe.
 */
export function isValidFamilyId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !FORBIDDEN_CONTROL.test(value)
    && utf8Length(value) <= MAX_FIRESTORE_SEGMENT_BYTES
}

export function assertFamilyId(value: unknown): string {
  if (!isValidFamilyId(value)) throw new Error('familyId is not a Firestore-safe document segment')
  return value
}
