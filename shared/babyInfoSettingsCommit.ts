import type {
  AppSettings,
  BabyInfoCommitErrorCode,
  BabyInfoJournalMetadata,
  BabyInfoMutation,
  BabyInfoSettingsCommitOperation,
  BabyInfoSyncState,
} from './types'
import {
  canonicalBabyInfoMutationJson,
  normalizeBabyInfoSyncState,
} from './babyInfoResolver'
import { isValidMutationId } from './eventResolver'
import { assertFamilyId, isValidFamilyId } from './familyId'

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T

const MAX_OPERATION_BYTES = 512_000
const MAX_DELTA_ITEMS = 500

export class BabyInfoSettingsCommitError extends Error {
  readonly code: BabyInfoCommitErrorCode

  constructor(code: BabyInfoCommitErrorCode, message: string) {
    super(message)
    this.name = 'BabyInfoSettingsCommitError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new BabyInfoSettingsCommitError('INVALID_OPERATION', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

function isText(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseManagedRevision(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${field} is invalid`)
  return value as number
}

function parseMutationKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160) invalid('acknowledgement key is invalid')
  const parts = value.split(':')
  if (parts.length !== 3
    || parts[0] !== 'baby-info'
    || !isValidMutationId(parts[1])
    || !isValidMutationId(parts[2])) {
    invalid('acknowledgement key is invalid')
  }
  return value
}

function parseJournalMetadata(value: unknown): BabyInfoJournalMetadata | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)
    || !hasAllowedKeys(value, ['version', 'projectedFamilyId', 'projectedWinnerKey'])
    || value.version !== 1
    || typeof value.projectedFamilyId !== 'string'
    || (value.projectedFamilyId !== '' && !isValidFamilyId(value.projectedFamilyId))) {
    invalid('baby info journal metadata is invalid')
  }
  const projectedWinnerKey = value.projectedWinnerKey === undefined
    ? undefined
    : parseMutationKey(value.projectedWinnerKey)
  return {
    version: 1,
    projectedFamilyId: value.projectedFamilyId,
    projectedWinnerKey,
  }
}

export function parseAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || !hasAllowedKeys(value, [
    'baby',
    'profile',
    'familyId',
    'firebase',
    'language',
    'theme',
    'babyInfoSync',
    'babyInfoJournal',
    'babyInfoRevision',
  ])) invalid('settings shape is invalid')

  if (!isRecord(value.baby) || !hasAllowedKeys(value.baby, ['name', 'birthdate', 'gender'])) {
    invalid('settings baby shape is invalid')
  }
  if (!isText(value.baby.name, 2_048) || !isText(value.baby.birthdate, 128)) {
    invalid('settings baby value is invalid')
  }
  if (value.baby.gender !== undefined && value.baby.gender !== 'girl' && value.baby.gender !== 'boy') {
    invalid('settings baby gender is invalid')
  }

  if (!isRecord(value.profile) || !hasAllowedKeys(value.profile, ['uid', 'name', 'role'])) {
    invalid('settings profile shape is invalid')
  }
  if (!isText(value.profile.uid, 1_024)
    || !isText(value.profile.name, 2_048)
    || (value.profile.role !== 'mom' && value.profile.role !== 'dad')) {
    invalid('settings profile value is invalid')
  }

  if (typeof value.familyId !== 'string'
    || (value.familyId !== '' && !isValidFamilyId(value.familyId))) {
    invalid('settings familyId is invalid')
  }
  if (value.language !== undefined && value.language !== 'ko' && value.language !== 'ja') {
    invalid('settings language is invalid')
  }
  if (value.theme !== undefined && value.theme !== 'light'
    && value.theme !== 'dark' && value.theme !== 'system') {
    invalid('settings theme is invalid')
  }

  if (value.firebase !== null) {
    if (!isRecord(value.firebase) || !hasOnlyKeys(value.firebase, [
      'apiKey',
      'authDomain',
      'projectId',
      'storageBucket',
      'messagingSenderId',
      'appId',
    ])) invalid('settings firebase shape is invalid')
    for (const field of Object.values(value.firebase)) {
      if (!isText(field, 4_096)) invalid('settings firebase value is invalid')
    }
  }

  parseManagedRevision(value.babyInfoRevision, 'baby info revision')
  let legacyState = value.babyInfoSync
  if (legacyState !== undefined) {
    try {
      legacyState = normalizeBabyInfoSyncState(legacyState)
    } catch {
      invalid('settings baby info sync state is invalid')
    }
  }
  const metadata = parseJournalMetadata(value.babyInfoJournal)

  return {
    ...(value as unknown as AppSettings),
    babyInfoSync: legacyState as BabyInfoSyncState | undefined,
    babyInfoJournal: metadata,
  }
}

/** Generic settings writes can never modify main-owned baby-info fields. */
export function applyManagedSettingsSave(currentValue: AppSettings, incomingValue: AppSettings): AppSettings {
  const current = parseAppSettings(currentValue)
  const incoming = parseAppSettings(incomingValue)
  return {
    ...current,
    ...incoming,
    baby: {
      ...current.baby,
      ...incoming.baby,
      name: current.baby.name,
      birthdate: current.baby.birthdate,
    },
    profile: { ...current.profile, ...incoming.profile },
    babyInfoSync: current.babyInfoSync,
    babyInfoJournal: current.babyInfoJournal,
    babyInfoRevision: current.babyInfoRevision,
  }
}

export function applyManagedSettingsMerge(
  current: AppSettings,
  partial: DeepPartial<AppSettings>,
): AppSettings {
  const incoming: AppSettings = {
    ...current,
    ...(partial as Partial<AppSettings>),
    baby: partial.baby != null
      ? { ...current.baby, ...(partial.baby as Partial<AppSettings['baby']>) }
      : current.baby,
    profile: partial.profile != null
      ? { ...current.profile, ...(partial.profile as Partial<AppSettings['profile']>) }
      : current.profile,
    firebase: 'firebase' in partial
      ? (partial.firebase as AppSettings['firebase'] ?? current.firebase)
      : current.firebase,
  }
  return applyManagedSettingsSave(current, incoming)
}

export function parseBabyInfoSettingsCommitOperation(
  value: unknown,
): BabyInfoSettingsCommitOperation {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return invalid('baby info commit is not serializable')
  }
  if (typeof serialized !== 'string') invalid('baby info commit shape is invalid')
  if (new TextEncoder().encode(serialized).byteLength > MAX_OPERATION_BYTES) {
    invalid('baby info commit delta is too large')
  }
  if (!isRecord(value) || typeof value.kind !== 'string') invalid('baby info commit shape is invalid')

  if (value.kind === 'user-edit') {
    if (!hasOnlyKeys(value, ['kind', 'familyId', 'babyName', 'babyBirthdate'])) {
      invalid('user edit shape is invalid')
    }
    if (typeof value.familyId !== 'string'
      || (value.familyId !== '' && !isValidFamilyId(value.familyId))) {
      invalid('user edit familyId is invalid')
    }
    if (!isText(value.babyName, 2_048) || !isText(value.babyBirthdate, 128)) {
      invalid('user edit pair is invalid')
    }
    return {
      kind: 'user-edit',
      familyId: value.familyId,
      babyName: value.babyName,
      babyBirthdate: value.babyBirthdate,
    }
  }

  if (value.kind === 'reconcile') {
    if (!hasOnlyKeys(value, [
      'kind',
      'familyId',
      'discoveredMutations',
      'exactAcknowledgedMutationKeys',
    ])) invalid('reconcile shape is invalid')
    let familyId: string
    try { familyId = assertFamilyId(value.familyId) } catch { return invalid('familyId is invalid') }
    if (!Array.isArray(value.discoveredMutations)
      || value.discoveredMutations.length > MAX_DELTA_ITEMS) {
      invalid('discovered mutation delta is invalid')
    }
    const discoveredMutations: BabyInfoMutation[] = []
    for (const candidate of value.discoveredMutations) {
      try { canonicalBabyInfoMutationJson(candidate as BabyInfoMutation) } catch {
        return invalid('discovered mutation is invalid')
      }
      const mutation = candidate as BabyInfoMutation
      if (mutation.familyId !== familyId) {
        throw new BabyInfoSettingsCommitError('FAMILY_MISMATCH', 'discovered mutation family mismatch')
      }
      discoveredMutations.push(mutation)
    }
    if (!Array.isArray(value.exactAcknowledgedMutationKeys)
      || value.exactAcknowledgedMutationKeys.length > MAX_DELTA_ITEMS) {
      invalid('acknowledgement delta is invalid')
    }
    const exactAcknowledgedMutationKeys = value.exactAcknowledgedMutationKeys.map(parseMutationKey)
    if (new Set(exactAcknowledgedMutationKeys).size !== exactAcknowledgedMutationKeys.length) {
      invalid('duplicate acknowledgement key')
    }
    return {
      kind: 'reconcile',
      familyId,
      discoveredMutations,
      exactAcknowledgedMutationKeys,
    }
  }

  return invalid('baby info commit kind is invalid')
}

export function incrementBabyInfoRevision(settings: AppSettings): number {
  const revision = parseManagedRevision(settings.babyInfoRevision, 'baby info revision') ?? 0
  if (revision >= Number.MAX_SAFE_INTEGER) invalid('baby info revision exhausted')
  return revision + 1
}
