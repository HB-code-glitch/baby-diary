/**
 * shared/familyLifecycle.ts
 *
 * Pure, framework-agnostic helpers for the atomic family create/join
 * lifecycle. These functions build the exact payload shapes the Firestore
 * rules require and are reused by both the production sync engine
 * (src/sync/syncEngine.ts) and tests, so "what we intended to write" and
 * "what we accept as a durable read-back" definitions can never drift apart.
 *
 * Firestore trust boundary (see firestore.rules):
 *   families/{familyId}                   - one batch-created family doc
 *   invites/{code}                        - one batch-created invite doc
 *   users/{uid}                           - exact-shape identity pointer
 *   joinProofs/{uid}/capabilities/{code}  - write-only per-user/per-code proof
 */
import { isValidFamilyId } from './familyId'
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from './inviteCode'

/** Result of a completed atomic family creation. */
export interface FamilyLifecycleResult {
  familyId: string
  inviteCode: string
}

/** Result of a completed atomic family join. */
export interface FamilyJoinResult {
  familyId: string
  babyName: string
  babyBirthdate: string
}

const INVITE_CODE_PATTERN = new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`)

/** Reuses the generic Firestore-safe path-segment rule for both familyId and uid. */
function assertPathSegment(value: string, label: string): string {
  if (!isValidFamilyId(value)) {
    throw new Error(`${label} is not a Firestore-safe path segment`)
  }
  return value
}

/** Every invite code accepted here must have come from `generateInviteCode()`. */
function assertInviteCode(value: string): string {
  if (typeof value !== 'string' || !INVITE_CODE_PATTERN.test(value)) {
    throw new Error('code is not a well-formed invite code')
  }
  return value
}

/**
 * Exact users/{uid} identity payload written atomically alongside family
 * create/join. Firestore rules require this shape exactly: one key,
 * `familyId`, and the family document (in the same batch) must already
 * list the writer as a member.
 */
export function exactOwnUserData(familyId: string): { familyId: string } {
  return { familyId: assertPathSegment(familyId, 'familyId') }
}

/**
 * Exact invites/{code} payload written atomically with families/{familyId}.
 * `createdAt` is passed through unchanged: callers pass a `serverTimestamp()`
 * sentinel when building a write, and the exact same read-back value when
 * reconstructing an "expected" shape to compare against a read document —
 * this function never inspects or validates that value's identity.
 */
export function exactInviteData(
  familyId: string,
  code: string,
  createdAt: unknown,
): Record<string, unknown> {
  return {
    familyId: assertPathSegment(familyId, 'familyId'),
    code_check: assertInviteCode(code),
    createdAt,
  }
}

/**
 * Exact joinProofs/{uid}/capabilities/{code} payload. This is the
 * deterministic per-user/per-code capability written in the same batch as
 * the family membership and user identity writes; Firestore rules deny
 * every read (get/list) of this document, so it can only ever be verified
 * by inspecting the sibling documents it unlocked.
 */
export function exactJoinProofData(
  uid: string,
  familyId: string,
  code: string,
): Record<string, unknown> {
  return {
    uid: assertPathSegment(uid, 'uid'),
    familyId: assertPathSegment(familyId, 'familyId'),
    inviteCode: assertInviteCode(code),
  }
}

/** Deterministic per-user/per-code join capability document path. */
export function joinProofPath(uid: string, code: string): string {
  return `joinProofs/${assertPathSegment(uid, 'uid')}/capabilities/${assertInviteCode(code)}`
}

/** Bounded retry budget for invite-code collisions and ambiguous commit responses. */
export const MAX_FAMILY_LIFECYCLE_ATTEMPTS = 5

const AMBIGUOUS_COMMIT_ERROR_CODES = new Set([
  'unavailable',
  'deadline-exceeded',
  'cancelled',
  'unknown',
  'internal',
  'aborted',
])

/**
 * True when a Firestore write error means "the client cannot tell whether
 * the server applied the commit" (dropped response, timeout, transient
 * backend fault) — as opposed to a definite `permission-denied` rejection,
 * which the server guarantees never applied. Only ambiguous errors may be
 * resolved by an exact read-back instead of surfacing to the caller.
 */
export function isAmbiguousCommitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && AMBIGUOUS_COMMIT_ERROR_CODES.has(code)
}

/** True for the one error code Firestore rules use to reject a write outright. */
export function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === 'permission-denied'
}

/**
 * Structural deep-equality for plain read-back comparison. Two references to
 * the exact same value (e.g. a Firestore Timestamp instance read back and
 * then echoed into an "expected" shape) always compare equal without this
 * function needing to know anything about that value's internal shape.
 */
export function exactShapeEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as Record<string, unknown>).sort()
  const bKeys = Object.keys(b as Record<string, unknown>).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false
  }
  return aKeys.every(key => exactShapeEquals(
    (a as Record<string, unknown>)[key],
    (b as Record<string, unknown>)[key],
  ))
}
