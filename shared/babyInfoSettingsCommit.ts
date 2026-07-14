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
  isValidBabyInfoMutationKey,
  normalizeBabyInfoSyncState,
} from './babyInfoResolver'
import { assertFamilyId, isValidFamilyId } from './familyId'

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T

const MAX_OPERATION_BYTES = 512_000
const MAX_DELTA_ITEMS = 500
const MAX_STORED_SETTINGS_BYTES = 4 * 1024 * 1024

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

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertStoredJsonValue(value: unknown): void {
  const pending: unknown[] = [value]
  const visited = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid('stored settings contain a non-JSON number')
      continue
    }
    if (typeof current !== 'object') invalid('stored settings contain a non-JSON value')
    if (visited.has(current)) continue
    visited.add(current)

    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current)
      if (keys.length !== current.length + 1
        || Object.keys(current).length !== current.length
        || !keys.includes('length')) {
        invalid('stored settings contain a non-JSON array')
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!hasOwn(current, index)) invalid('stored settings contain a sparse array')
        pending.push(current[index])
      }
      continue
    }

    if (!isRecord(current)) invalid('stored settings contain a non-plain JSON object')
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') invalid('stored settings contain a symbol key')
      const property = Object.getOwnPropertyDescriptor(current, key)
      if (!property || !property.enumerable || !hasOwn(property, 'value')) {
        invalid('stored settings contain a non-JSON property')
      }
      pending.push(property.value)
    }
  }

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    invalid('stored settings are not JSON serializable')
  }
  if (typeof serialized !== 'string') invalid('stored settings are not JSON serializable')
  if (new TextEncoder().encode(serialized).byteLength > MAX_STORED_SETTINGS_BYTES) {
    invalid('stored settings exceed the settings size limit')
  }
}

function managedSettingsCandidate(value: Record<string, unknown>): Record<string, unknown> {
  const baby = isRecord(value.baby)
    ? {
        name: value.baby.name,
        birthdate: value.baby.birthdate,
        ...(hasOwn(value.baby, 'gender') ? { gender: value.baby.gender } : {}),
      }
    : value.baby
  const profile = isRecord(value.profile)
    ? {
        uid: value.profile.uid,
        name: value.profile.name,
        role: value.profile.role,
      }
    : value.profile
  return {
    baby,
    profile,
    familyId: value.familyId,
    firebase: value.firebase,
    ...(hasOwn(value, 'language') ? { language: value.language } : {}),
    ...(hasOwn(value, 'theme') ? { theme: value.theme } : {}),
    ...(hasOwn(value, 'babyInfoSync') ? { babyInfoSync: value.babyInfoSync } : {}),
    ...(hasOwn(value, 'babyInfoJournal') ? { babyInfoJournal: value.babyInfoJournal } : {}),
    ...(hasOwn(value, 'babyInfoRevision') ? { babyInfoRevision: value.babyInfoRevision } : {}),
  }
}

function omitUndefinedManagedFields(value: unknown): unknown {
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = { ...value }
  if (isRecord(value.baby)) {
    result.baby = { ...value.baby }
    if (value.baby.gender === undefined) delete (result.baby as Record<string, unknown>).gender
  }
  if (isRecord(value.profile)) result.profile = { ...value.profile }
  for (const key of [
    'language',
    'theme',
    'babyInfoSync',
    'babyInfoJournal',
    'babyInfoRevision',
  ]) {
    if (result[key] === undefined) delete result[key]
  }
  if (isRecord(result.babyInfoJournal)
    && result.babyInfoJournal.projectedWinnerKey === undefined) {
    result.babyInfoJournal = { ...result.babyInfoJournal }
    delete (result.babyInfoJournal as Record<string, unknown>).projectedWinnerKey
  }
  return result
}

function parseStoredSettingsShape(value: unknown): AppSettings {
  assertStoredJsonValue(value)
  if (!isRecord(value)) invalid('settings shape is invalid')
  const managed = parseAppSettings(managedSettingsCandidate(value))
  const result: Record<string, unknown> = {
    ...value,
    ...managed,
    baby: {
      ...(value.baby as Record<string, unknown>),
      ...managed.baby,
    },
    profile: {
      ...(value.profile as Record<string, unknown>),
      ...managed.profile,
    },
    firebase: managed.firebase ? { ...managed.firebase } : null,
    ...(hasOwn(value, 'babyInfoSync') ? { babyInfoSync: managed.babyInfoSync } : {}),
    ...(hasOwn(value, 'babyInfoJournal') ? { babyInfoJournal: managed.babyInfoJournal } : {}),
    ...(hasOwn(value, 'babyInfoRevision') ? { babyInfoRevision: managed.babyInfoRevision } : {}),
  }
  for (const key of [
    'language',
    'theme',
    'babyInfoSync',
    'babyInfoJournal',
    'babyInfoRevision',
  ]) {
    if (!hasOwn(value, key)) delete result[key]
  }
  return omitUndefinedManagedFields(result) as AppSettings
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
  if (!isValidBabyInfoMutationKey(value)) invalid('acknowledgement key is invalid')
  return value as string
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

/**
 * Parses trusted settings bytes while retaining bounded, uninterpreted legacy
 * fields. Known fields still pass through the same strict validation used by
 * the renderer/IPC boundary.
 */
export function parseStoredAppSettings(value: unknown): AppSettings {
  const storedValue = omitUndefinedManagedFields(value)
  assertStoredJsonValue(storedValue)
  if (!isRecord(storedValue)
    || storedValue.babyInfoJournal !== undefined
    || storedValue.babyInfoRevision !== undefined) {
    return parseStoredSettingsShape(storedValue)
  }
  if (storedValue.baby !== undefined && !isRecord(storedValue.baby)) {
    return parseStoredSettingsShape(storedValue)
  }
  if (storedValue.profile !== undefined && !isRecord(storedValue.profile)) {
    return parseStoredSettingsShape(storedValue)
  }

  return parseStoredSettingsShape({
    ...storedValue,
    baby: {
      name: '',
      birthdate: '',
      ...(storedValue.baby as Record<string, unknown> | undefined),
    },
    profile: {
      uid: '',
      name: '',
      role: 'dad',
      ...(storedValue.profile as Record<string, unknown> | undefined),
    },
    familyId: storedValue.familyId === undefined ? '' : storedValue.familyId,
    firebase: storedValue.firebase === undefined ? null : storedValue.firebase,
  })
}

/**
 * Pre-journal settings were historically partial and deep-merged with these
 * defaults. Journal-aware files stay strict because their pair metadata is an
 * integrity boundary, not a migration hint.
 */
export function parseAppSettingsWithLegacyDefaults(value: unknown): AppSettings {
  if (!isRecord(value)
    || value.babyInfoJournal !== undefined
    || value.babyInfoRevision !== undefined) {
    return parseAppSettings(value)
  }
  if (value.baby !== undefined && !isRecord(value.baby)) return parseAppSettings(value)
  if (value.profile !== undefined && !isRecord(value.profile)) return parseAppSettings(value)

  return parseAppSettings({
    ...value,
    baby: {
      name: '',
      birthdate: '',
      ...(value.baby as Record<string, unknown> | undefined),
    },
    profile: {
      uid: '',
      name: '',
      role: 'dad',
      ...(value.profile as Record<string, unknown> | undefined),
    },
    familyId: value.familyId === undefined ? '' : value.familyId,
    firebase: value.firebase === undefined ? null : value.firebase,
  })
}

/** Generic settings writes can never modify main-owned baby-info fields. */
export function applyManagedSettingsSave(currentValue: AppSettings, incomingValue: AppSettings): AppSettings {
  const current = parseStoredAppSettings(currentValue)
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
  const stored = parseStoredAppSettings(current)
  const managedCurrent = parseAppSettings(managedSettingsCandidate(stored as unknown as Record<string, unknown>))
  const incoming: AppSettings = {
    ...managedCurrent,
    ...(partial as Partial<AppSettings>),
    baby: partial.baby != null
      ? { ...managedCurrent.baby, ...(partial.baby as Partial<AppSettings['baby']>) }
      : managedCurrent.baby,
    profile: partial.profile != null
      ? { ...managedCurrent.profile, ...(partial.profile as Partial<AppSettings['profile']>) }
      : managedCurrent.profile,
    firebase: 'firebase' in partial
      ? (partial.firebase as AppSettings['firebase'] ?? managedCurrent.firebase)
      : managedCurrent.firebase,
  }
  return applyManagedSettingsSave(stored, incoming)
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
    if (!hasOnlyKeys(value, ['kind', 'familyId', 'babyName', 'babyBirthdate', 'settings'])) {
      invalid('user edit shape is invalid')
    }
    if (typeof value.familyId !== 'string'
      || (value.familyId !== '' && !isValidFamilyId(value.familyId))) {
      invalid('user edit familyId is invalid')
    }
    if (!isText(value.babyName, 2_048) || !isText(value.babyBirthdate, 128)) {
      invalid('user edit pair is invalid')
    }
    let settings: AppSettings
    try {
      settings = parseAppSettings(value.settings)
    } catch {
      return invalid('user edit settings are invalid')
    }
    if (settings.familyId !== value.familyId) {
      invalid('user edit settings family mismatch')
    }
    if (settings.baby.name !== value.babyName
      || settings.baby.birthdate !== value.babyBirthdate) {
      invalid('user edit settings pair mismatch')
    }
    return {
      kind: 'user-edit',
      familyId: value.familyId,
      babyName: value.babyName,
      babyBirthdate: value.babyBirthdate,
      settings,
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

  if (value.kind === 'family-transition') {
    if (!hasOnlyKeys(value, ['kind', 'familyId', 'mode'])) {
      invalid('family transition shape is invalid')
    }
    let familyId: string
    try { familyId = assertFamilyId(value.familyId) } catch { return invalid('familyId is invalid') }
    if (value.mode !== 'create' && value.mode !== 'join') {
      invalid('family transition mode is invalid')
    }
    return {
      kind: 'family-transition',
      familyId,
      mode: value.mode,
    }
  }

  return invalid('baby info commit kind is invalid')
}

export function incrementBabyInfoRevision(settings: AppSettings): number {
  const revision = parseManagedRevision(settings.babyInfoRevision, 'baby info revision') ?? 0
  if (revision >= Number.MAX_SAFE_INTEGER) invalid('baby info revision exhausted')
  return revision + 1
}
