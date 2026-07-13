/**
 * Pure data and filesystem contracts shared by the packaged v0.3.8 -> v0.3.9
 * in-place upgrade smoke tests. This module deliberately has no application
 * imports so the historical fixture stays bound to explicit released shapes.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v5 as uuidv5 } from 'uuid'

const EVENT_CONTENT_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const LEGACY_EVENT_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const DERIVED_EVENT_NAMESPACE = '6ba7b817-9dad-11d1-80b4-00c04fd430c8'
const BABY_INFO_CONTENT_NAMESPACE = '6ba7b814-9dad-11d1-80b4-00c04fd430c8'

const DEFAULT_MANIFEST_LIMITS = Object.freeze({
  maxEntries: 4_096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTreeBytes: 64 * 1024 * 1024,
})

export const V038_SOURCE = Object.freeze({
  tag: 'v0.3.8',
  commit: '4ad44829c0de56da33d9123c16f92e6090f0df4a',
  releaseId: 352876543,
  publishedAt: '2026-07-13T00:17:33Z',
})

export const V038_RELEASE_ASSETS = Object.freeze({
  windows: Object.freeze({
    id: 474870034,
    name: 'Baby-Diary-Setup-0.3.8.exe',
    size: 233249330,
    sha256: 'edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de',
  }),
  mac: Object.freeze({
    id: 474869787,
    name: 'Baby-Diary-0.3.8-universal.dmg',
    size: 351533375,
    sha256: '2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974',
  }),
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function normalizeFsPath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalize(value, ancestors) {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('semantic JSON contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('semantic JSON contains a cycle')
    ancestors.add(value)
    try {
      return `[${value.map(item => item === undefined ? 'null' : canonicalize(item, ancestors)).join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) throw new Error('semantic JSON contains a cycle')
    ancestors.add(value)
    try {
      const entries = Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`)
      return `{${entries.join(',')}}`
    } finally {
      ancestors.delete(value)
    }
  }
  throw new Error('semantic JSON contains an unsupported value')
}

/** Stable JSON independent of object insertion order. */
export function canonicalJson(value) {
  return canonicalize(value, new Set())
}

function canonicalBabyInfoMutationJson(mutation) {
  if (!isPlainObject(mutation)
    || typeof mutation.mutationId !== 'string'
    || typeof mutation.familyId !== 'string'
    || typeof mutation.babyName !== 'string'
    || typeof mutation.babyBirthdate !== 'string'
    || !Number.isSafeInteger(mutation.logicalClock)
    || typeof mutation.updatedAt !== 'string'
    || typeof mutation.authorId !== 'string'
    || !['user', 'legacy-local', 'legacy-cloud'].includes(mutation.origin)) {
    throw new Error('invalid baby-info mutation')
  }
  return JSON.stringify({
    mutationId: mutation.mutationId,
    familyId: mutation.familyId,
    babyName: mutation.babyName,
    babyBirthdate: mutation.babyBirthdate,
    logicalClock: mutation.logicalClock,
    updatedAt: mutation.updatedAt,
    ...(mutation.updatedAtMs === undefined ? {} : { updatedAtMs: mutation.updatedAtMs }),
    authorId: mutation.authorId,
    origin: mutation.origin,
    ...(mutation.migration === undefined ? {} : { migration: mutation.migration }),
  })
}

export function getBabyInfoMutationKey(mutation) {
  const canonical = canonicalBabyInfoMutationJson(mutation)
  const contentId = uuidv5(`baby-diary:baby-info-content:${canonical}`, BABY_INFO_CONTENT_NAMESPACE)
  return `baby-info:${mutation.mutationId}:${contentId}`
}

const FAMILY_ID = '가족-家族-v038'
const ACKNOWLEDGED_BABY_MUTATION = Object.freeze({
  mutationId: '11111111-1111-4111-8111-111111111111',
  familyId: FAMILY_ID,
  babyName: '하루',
  babyBirthdate: '2026-01-15',
  logicalClock: 10,
  updatedAt: '2026-07-11T10:00:00.000Z',
  updatedAtMs: 1783764000000,
  authorId: 'account-dad-v038',
  origin: 'user',
})
const PENDING_BABY_MUTATION = Object.freeze({
  mutationId: '22222222-2222-4222-8222-222222222222',
  familyId: FAMILY_ID,
  babyName: '하루・ハル',
  babyBirthdate: '2026-01-15',
  logicalClock: 11,
  updatedAt: '2026-07-12T10:00:00.000Z',
  updatedAtMs: 1783850400000,
  authorId: 'account-mom-v038',
  origin: 'user',
})
const ACKNOWLEDGED_BABY_KEY = getBabyInfoMutationKey(ACKNOWLEDGED_BABY_MUTATION)
const PENDING_BABY_KEY = getBabyInfoMutationKey(PENDING_BABY_MUTATION)

function event({ id, type, at, data, author, rev = 1, deleted = false, createdAt = at, updatedAt = at }) {
  return { id, type, at, data, author, createdAt, updatedAt, rev, deleted }
}

const DAD = Object.freeze({ uid: 'account-dad-v038', name: '아빠・パパ', role: 'dad' })
const MOM = Object.freeze({ uid: 'account-mom-v038', name: '엄마・ママ', role: 'mom' })

function fixtureEvents() {
  return [
    event({ id: 'legacy-pee', type: 'pee', at: '2026-06-30T12:00:00.000Z', data: { note: '기저귀 확인' }, author: DAD }),
    event({ id: 'legacy-poop', type: 'poop', at: '2026-07-01T01:00:00.000Z', data: { note: 'うんち・보통' }, author: MOM }),
    event({ id: 'legacy-temp', type: 'temp', at: '2026-07-01T02:00:00.000Z', data: { celsius: 37.2, note: '체온 안정' }, author: DAD }),
    event({ id: 'legacy-breast', type: 'breast', at: '2026-07-01T03:00:00.000Z', data: { side: 'both', minutes: 18, note: '授乳' }, author: MOM }),
    event({ id: 'legacy-formula', type: 'formula', at: '2026-07-01T04:00:00.000Z', data: { ml: 80, note: 'ミルク' }, author: DAD }),
    event({
      id: 'legacy-formula',
      type: 'formula',
      at: '2026-07-01T04:00:00.000Z',
      data: { ml: 100, note: 'ミルク・수정' },
      author: DAD,
      rev: 2,
      createdAt: '2026-07-01T04:00:00.000Z',
      updatedAt: '2026-07-01T04:05:00.000Z',
    }),
    event({
      id: 'legacy-diary-tombstone',
      type: 'diary',
      at: '2026-07-01T05:00:00.000Z',
      data: { title: '첫 일기', text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
      author: MOM,
    }),
    event({
      id: 'legacy-diary-tombstone',
      type: 'diary',
      at: '2026-07-01T05:00:00.000Z',
      data: { title: '첫 일기', text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
      author: MOM,
      rev: 2,
      deleted: true,
      createdAt: '2026-07-01T05:00:00.000Z',
      updatedAt: '2026-07-01T05:10:00.000Z',
    }),
    event({ id: 'legacy-message', type: 'message', at: '2026-07-01T06:00:00.000Z', data: { text: '하루에게・ハルへ' }, author: DAD }),
    event({ id: 'legacy-sleep', type: 'sleep', at: '2026-07-01T07:00:00.000Z', data: { minutes: 95, note: '낮잠' }, author: MOM }),
    event({ id: 'legacy-growth', type: 'growth', at: '2026-07-01T08:00:00.000Z', data: { weightKg: 7.4, heightCm: 66.2, note: '成長' }, author: DAD }),
  ]
}

/** Exact data accepted and preserved by the published v0.3.8 stores. */
export function buildV038Fixture() {
  const fixture = {
    settings: {
      baby: { name: '하루・ハル', birthdate: '2026-01-15', gender: 'girl' },
      profile: cloneJson(DAD),
      familyId: FAMILY_ID,
      firebase: {
        apiKey: 'fixture-api-key-never-log',
        authDomain: '127.0.0.1.invalid',
        projectId: 'upgrade-fixture-offline',
        storageBucket: 'upgrade-fixture-offline.invalid',
        messagingSenderId: '38039',
        appId: '1:38039:web:upgrade-fixture',
      },
      language: 'ko',
      theme: 'dark',
      // v0.3.8 preserves unknown top-level settings fields byte-for-byte when
      // saveSettings receives them. This forward-compatible state supplies one
      // acknowledged and one pending baby-info mutation to the v0.3.9 importer.
      babyInfoSync: {
        version: 1,
        mutations: [cloneJson(ACKNOWLEDGED_BABY_MUTATION), cloneJson(PENDING_BABY_MUTATION)],
        pendingMutationKeys: [PENDING_BABY_KEY],
      },
    },
    events: fixtureEvents(),
  }
  return cloneJson(fixture)
}

function fixtureMonthFile(at) {
  const date = new Date(at)
  return `events-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

export function listFixtureEventFiles() {
  return Array.from(new Set(fixtureEvents().map(item => fixtureMonthFile(item.at)))).sort(compareUtf8)
}

/** Test-only filesystem materializer; the packaged driver seeds through v0.3.8 IPC. */
export async function writeV038Fixture(profileRoot) {
  const root = path.resolve(profileRoot)
  const fixture = buildV038Fixture()
  await mkdir(path.join(root, 'data'), { recursive: true })
  await writeFile(path.join(root, 'settings.json'), JSON.stringify(fixture.settings, null, 2), 'utf8')
  const grouped = new Map()
  for (const item of fixture.events) {
    const name = fixtureMonthFile(item.at)
    const group = grouped.get(name) ?? []
    group.push(item)
    grouped.set(name, group)
  }
  for (const [name, events] of grouped) {
    await writeFile(
      path.join(root, 'data', name),
      `${events.map(item => JSON.stringify(item)).join('\n')}\n`,
      'utf8',
    )
  }
  return fixture
}

function normalizeRelativePath(relativePath) {
  const posixPath = relativePath.split(path.sep).join('/').normalize('NFC')
  if (posixPath.length === 0
    || posixPath.startsWith('/')
    || posixPath.includes('\\')
    || posixPath.split('/').some(part => part === '' || part === '.' || part === '..')
    || path.posix.normalize(posixPath) !== posixPath) {
    throw new Error(`raw manifest path traversal is not allowed: ${relativePath}`)
  }
  return posixPath
}

export function validateRawManifestEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('raw manifest entries must be an array')
  const exact = new Set()
  const folded = new Map()
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string') {
      throw new Error('raw manifest entry is invalid')
    }
    const normalizedPath = normalizeRelativePath(entry.path)
    if (normalizedPath !== entry.path) throw new Error(`raw manifest path is not canonical: ${entry.path}`)
    if (exact.has(normalizedPath)) throw new Error(`duplicate normalized path: ${normalizedPath}`)
    exact.add(normalizedPath)
    const caseFolded = normalizedPath.toLocaleLowerCase('en-US')
    const prior = folded.get(caseFolded)
    if (prior !== undefined && prior !== normalizedPath) {
      throw new Error(`case collision in raw manifest: ${prior} / ${normalizedPath}`)
    }
    folded.set(caseFolded, normalizedPath)
    if (entry.type === 'directory') {
      if (Object.keys(entry).some(key => !['path', 'type'].includes(key))) {
        throw new Error(`raw manifest directory entry has unexpected fields: ${normalizedPath}`)
      }
      continue
    }
    if (entry.type !== 'file'
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || typeof entry.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || Object.keys(entry).some(key => !['path', 'type', 'size', 'sha256'].includes(key))) {
      throw new Error(`raw manifest file entry is invalid: ${normalizedPath}`)
    }
  }
  const sorted = [...entries].sort((left, right) => compareUtf8(left.path, right.path))
  if (entries.some((entry, index) => entry.path !== sorted[index].path)) {
    throw new Error('raw manifest entries are not canonically sorted')
  }
  return entries
}

async function streamFileSha256(filePath, expectedSize) {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => {
      bytes += chunk.byteLength
      hash.update(chunk)
    })
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  if (bytes !== expectedSize) throw new Error(`raw manifest file changed while hashing: ${filePath}`)
  return hash.digest('hex')
}

/** Recursively hashes regular files without retaining their bytes. */
export async function createRawManifest(profileRoot, options = {}) {
  const limits = { ...DEFAULT_MANIFEST_LIMITS, ...options }
  for (const key of ['maxEntries', 'maxFileBytes', 'maxTreeBytes']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new Error(`invalid ${key}`)
  }
  const root = path.resolve(profileRoot)
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('raw manifest root must be a regular directory, not a link/reparse point')
  }
  const resolvedRoot = await realpath(root)
  if (normalizeFsPath(resolvedRoot) !== normalizeFsPath(root)) {
    throw new Error('raw manifest root resolves through a link/reparse point')
  }

  const entries = []
  let treeBytes = 0
  async function visit(directory, relativeDirectory) {
    const children = await readdir(directory)
    children.sort(compareUtf8)
    for (const name of children) {
      const absolute = path.join(directory, name)
      const relative = normalizeRelativePath(relativeDirectory ? `${relativeDirectory}/${name}` : name)
      const stats = await lstat(absolute)
      if (stats.isSymbolicLink()) {
        throw new Error(`raw manifest rejects link/reparse point: ${relative}`)
      }
      if (stats.isDirectory()) {
        entries.push({ path: relative, type: 'directory' })
        if (entries.length > limits.maxEntries) throw new Error('raw manifest entry cap exceeded')
        await visit(absolute, relative)
        continue
      }
      if (!stats.isFile()) throw new Error(`raw manifest rejects non-regular entry: ${relative}`)
      if (stats.size > limits.maxFileBytes) throw new Error(`raw manifest file cap exceeded: ${relative}`)
      treeBytes += stats.size
      if (treeBytes > limits.maxTreeBytes) throw new Error('raw manifest tree cap exceeded')
      const digest = await streamFileSha256(absolute, stats.size)
      const after = await lstat(absolute)
      if (!after.isFile() || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
        throw new Error(`raw manifest file changed while hashing: ${relative}`)
      }
      entries.push({ path: relative, type: 'file', size: stats.size, sha256: digest })
      if (entries.length > limits.maxEntries) throw new Error('raw manifest entry cap exceeded')
    }
  }
  await visit(root, '')
  entries.sort((left, right) => compareUtf8(left.path, right.path))
  validateRawManifestEntries(entries)
  return { version: 1, entries }
}

export function compareRawManifests(before, after) {
  validateRawManifestEntries(before?.entries)
  validateRawManifestEntries(after?.entries)
  if (before.version !== 1 || after.version !== 1) throw new Error('unsupported raw manifest version')
  const beforeByPath = new Map(before.entries.map(entry => [entry.path, canonicalJson(entry)]))
  const afterByPath = new Map(after.entries.map(entry => [entry.path, canonicalJson(entry)]))
  const removed = [...beforeByPath.keys()].filter(name => !afterByPath.has(name)).sort(compareUtf8)
  const added = [...afterByPath.keys()].filter(name => !beforeByPath.has(name)).sort(compareUtf8)
  const changed = [...beforeByPath.keys()]
    .filter(name => afterByPath.has(name) && beforeByPath.get(name) !== afterByPath.get(name))
    .sort(compareUtf8)
  return { equal: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed }
}

export function assertRawManifestsEqual(before, after) {
  const result = compareRawManifests(before, after)
  if (!result.equal) {
    throw new Error(
      `raw manifest mismatch: added=[${result.added.join(',')}] removed=[${result.removed.join(',')}] changed=[${result.changed.join(',')}]`,
    )
  }
}

function eventContentId(item) {
  return uuidv5(`baby-diary:event-content:${canonicalJson(item)}`, EVENT_CONTENT_NAMESPACE)
}

function compareEventSources(left, right) {
  if (left.rev !== right.rev) return left.rev - right.rev
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1
  const timeOrder = Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
  if (timeOrder !== 0) return timeOrder
  return compareUtf8(canonicalJson(left), canonicalJson(right))
}

function projectIdentity(settings) {
  if (!isPlainObject(settings)
    || !isPlainObject(settings.baby)
    || !isPlainObject(settings.profile)
    || typeof settings.familyId !== 'string') {
    throw new Error('settings identity shape is invalid')
  }
  return {
    baby: {
      name: settings.baby.name,
      birthdate: settings.baby.birthdate,
      ...(settings.baby.gender === undefined ? {} : { gender: settings.baby.gender }),
    },
    account: {
      uid: settings.profile.uid,
      name: settings.profile.name,
      role: settings.profile.role,
    },
    familyId: settings.familyId,
    preferences: {
      language: settings.language ?? null,
      theme: settings.theme ?? null,
    },
  }
}

function readLegacyBabyInfoState(rawState) {
  if (!isPlainObject(rawState)
    || rawState.version !== 1
    || !Array.isArray(rawState.mutations)
    || !Array.isArray(rawState.pendingMutationKeys)) {
    throw new Error('legacy baby-info sync state is invalid')
  }
  const mutations = new Map()
  for (const mutation of rawState.mutations) {
    const key = getBabyInfoMutationKey(mutation)
    const canonical = canonicalBabyInfoMutationJson(mutation)
    const prior = mutations.get(key)
    if (prior !== undefined && prior !== canonical) throw new Error('baby-info mutation collision')
    mutations.set(key, canonical)
  }
  const pending = new Set()
  for (const key of rawState.pendingMutationKeys) {
    if (typeof key !== 'string' || !mutations.has(key)) throw new Error('legacy pending key is missing its mutation')
    pending.add(key)
  }
  return { mutations, pending }
}

async function readJournalBabyInfoState(journalPath) {
  const mutations = new Map()
  const pending = new Set()
  const acknowledged = new Set()
  const content = await readFile(journalPath, 'utf8')
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    const record = JSON.parse(line)
    if (record?.version !== 1 || typeof record.type !== 'string') throw new Error('baby-info journal record is invalid')
    if (record.type === 'mutation') {
      const expectedKey = getBabyInfoMutationKey(record.mutation)
      if (record.key !== expectedKey) throw new Error('baby-info journal mutation key mismatch')
      if (mutations.has(record.key)) throw new Error('duplicate mutation derivative in baby-info journal')
      mutations.set(record.key, canonicalBabyInfoMutationJson(record.mutation))
      pending.add(record.key)
      continue
    }
    if (record.type === 'ack') {
      if (!mutations.has(record.key)) throw new Error('baby-info acknowledgement references a missing mutation')
      pending.delete(record.key)
      acknowledged.add(record.key)
      continue
    }
    if (record.type !== 'import' && record.type !== 'unlinked-archive') {
      throw new Error(`unknown baby-info journal record: ${record.type}`)
    }
  }
  return { mutations, pending, acknowledged }
}

function finishBabyInfoProjection(state) {
  const keys = [...state.mutations.keys()].sort(compareUtf8)
  const pendingKeys = [...state.pending].sort(compareUtf8)
  const acknowledgedKeys = keys.filter(key => !state.pending.has(key)).sort(compareUtf8)
  return {
    mutations: keys.map(key => ({ key, canonical: state.mutations.get(key) })),
    pendingKeys,
    acknowledgedKeys,
  }
}

/** Deterministic, secret-redacted semantic view of the user-data directory. */
export async function projectUpgradeSemantics(profileRoot) {
  const root = path.resolve(profileRoot)
  const settings = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'))
  const identity = projectIdentity(settings)
  const firebaseHash = settings.firebase === null || settings.firebase === undefined
    ? null
    : sha256(canonicalJson(settings.firebase))

  const dataRoot = path.join(root, 'data')
  const names = (await readdir(dataRoot)).filter(name => /^events-\d{1,4}-\d{2}\.jsonl$/.test(name)).sort(compareUtf8)
  const eventSources = []
  const eventDerivatives = []
  const sourceCanonicalSeen = new Set()
  const derivativeIds = new Set()
  const winnerById = new Map()
  for (const name of names) {
    const content = await readFile(path.join(dataRoot, name), 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue
      const item = JSON.parse(line)
      if (!isPlainObject(item)
        || typeof item.id !== 'string'
        || !Number.isSafeInteger(item.rev)
        || typeof item.deleted !== 'boolean'
        || typeof item.updatedAt !== 'string') {
        throw new Error(`event record is invalid in ${name}`)
      }
      const canonical = canonicalJson(item)
      if (item.migration?.kind === 'legacy-author-v1') {
        if (typeof item.mutationId !== 'string' || typeof item.migration.sourceContentId !== 'string') {
          throw new Error('event migration derivative is invalid')
        }
        if (derivativeIds.has(item.mutationId)) throw new Error('duplicate mutation derivative in event log')
        derivativeIds.add(item.mutationId)
        eventDerivatives.push({
          mutationId: item.mutationId,
          sourceContentId: item.migration.sourceContentId,
          canonicalHash: sha256(canonical),
        })
        continue
      }
      if (sourceCanonicalSeen.has(canonical)) throw new Error('duplicate source event mutation in event log')
      sourceCanonicalSeen.add(canonical)
      const source = {
        id: item.id,
        rev: item.rev,
        deleted: item.deleted,
        contentId: eventContentId(item),
        canonical,
      }
      eventSources.push(source)
      const winner = winnerById.get(item.id)
      if (!winner || compareEventSources(item, winner.raw) > 0) winnerById.set(item.id, { raw: item, source })
    }
  }
  eventSources.sort((left, right) => compareUtf8(left.canonical, right.canonical))
  eventDerivatives.sort((left, right) => compareUtf8(left.mutationId, right.mutationId))
  const sourceContentIds = new Set(eventSources.map(item => item.contentId))
  for (const derivative of eventDerivatives) {
    if (!sourceContentIds.has(derivative.sourceContentId)) {
      throw new Error('event migration derivative references a missing source mutation')
    }
  }
  const eventWinners = [...winnerById.entries()]
    .map(([id, value]) => ({ id, rev: value.source.rev, deleted: value.source.deleted, contentId: value.source.contentId }))
    .sort((left, right) => compareUtf8(left.id, right.id))

  let babyInfoState
  const journalPath = path.join(root, 'baby-info-journal-v1.jsonl')
  try {
    const journalStats = await lstat(journalPath)
    if (journalStats.isSymbolicLink() || !journalStats.isFile()) throw new Error('baby-info journal is a link/reparse point')
    babyInfoState = await readJournalBabyInfoState(journalPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    babyInfoState = readLegacyBabyInfoState(settings.babyInfoSync)
  }

  return {
    version: 1,
    identity,
    firebaseHash,
    eventSources,
    eventDerivatives,
    eventWinners,
    babyInfo: finishBabyInfoProjection(babyInfoState),
  }
}

function sameSemantic(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

export function assertSemanticPreservation(before, after) {
  if (!sameSemantic(before.identity, after.identity)) {
    throw new Error('account/family/baby identity substitution detected')
  }
  if (before.firebaseHash !== after.firebaseHash) throw new Error('Firebase configuration substitution detected')
  if (!sameSemantic(before.eventSources, after.eventSources)) {
    const baselineTombstones = new Map(before.eventWinners.filter(item => item.deleted).map(item => [item.id, item]))
    const resurrected = after.eventWinners.some(item => baselineTombstones.has(item.id) && !item.deleted)
    throw new Error(resurrected ? 'tombstone resurrection detected' : 'event mutation history changed')
  }
  if (!sameSemantic(before.babyInfo.mutations, after.babyInfo.mutations)) {
    throw new Error('baby-info mutation history changed')
  }
  if (!sameSemantic(before.babyInfo.pendingKeys, after.babyInfo.pendingKeys)) {
    throw new Error('pending baby-info work is missing or substituted')
  }
  if (!sameSemantic(before.babyInfo.acknowledgedKeys, after.babyInfo.acknowledgedKeys)) {
    throw new Error('acknowledged baby-info work changed')
  }
}

export function assertSemanticIdempotence(firstRun, secondRun) {
  if (!sameSemantic(firstRun.eventDerivatives, secondRun.eventDerivatives)) {
    throw new Error('second launch is not idempotent: event derivative set changed')
  }
  if (!sameSemantic(firstRun, secondRun)) throw new Error('second launch is not semantically idempotent')
}

export function semanticProjectionHash(projection) {
  return sha256(canonicalJson(projection))
}

export async function validateV038Fixture(profileRoot) {
  const fixture = buildV038Fixture()
  const projection = await projectUpgradeSemantics(profileRoot)
  const expectedEvents = fixture.events
    .map(item => canonicalJson(item))
    .sort(compareUtf8)
  if (!sameSemantic(expectedEvents, projection.eventSources.map(item => item.canonical))) {
    throw new Error('v0.3.8 fixture event set does not match the explicit contract')
  }
  if (!sameSemantic(projectIdentity(fixture.settings), projection.identity)) {
    throw new Error('v0.3.8 fixture identity does not match the explicit contract')
  }
  const expectedBabyInfo = finishBabyInfoProjection(readLegacyBabyInfoState(fixture.settings.babyInfoSync))
  if (!sameSemantic(expectedBabyInfo, projection.babyInfo)) {
    throw new Error('v0.3.8 fixture baby-info state does not match the explicit contract')
  }
  return projection
}

/** Test seam that mirrors the candidate's legacy settings -> journal migration. */
export async function materializeMigratedBabyInfoJournal(profileRoot) {
  const root = path.resolve(profileRoot)
  const settingsPath = path.join(root, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  const state = readLegacyBabyInfoState(settings.babyInfoSync)
  const records = []
  for (const mutation of settings.babyInfoSync.mutations) {
    const key = getBabyInfoMutationKey(mutation)
    records.push({ version: 1, type: 'mutation', key, mutation })
    if (!state.pending.has(key)) records.push({ version: 1, type: 'ack', familyId: mutation.familyId, key })
  }
  records.push({ version: 1, type: 'import', sourceId: 'upgrade-contract-v038' })
  await writeFile(
    path.join(root, 'baby-info-journal-v1.jsonl'),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  )
  delete settings.babyInfoSync
  settings.babyInfoJournal = { version: 1, projectedFamilyId: settings.familyId, projectedWinnerKey: PENDING_BABY_KEY }
  settings.babyInfoRevision = 1
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
}

export function buildFixtureEventDerivative(overrides = {}) {
  const source = fixtureEvents().find(item => item.id === 'legacy-pee')
  const sourceContentId = eventContentId(source)
  const identifiedMutationId = uuidv5(`baby-diary:legacy-event:${canonicalJson(source)}`, LEGACY_EVENT_NAMESPACE)
  const mutationId = overrides.mutationId ?? uuidv5(
    `baby-diary:auth-bound-event:${sourceContentId}:candidate-auth-account`,
    DERIVED_EVENT_NAMESPACE,
  )
  return {
    ...cloneJson(source),
    mutationId: mutationId ?? identifiedMutationId,
    author: { ...cloneJson(source.author), uid: 'candidate-auth-account' },
    sync: {
      version: 1,
      encodedEventId: encodeURIComponent(source.id),
      eventAtMs: Date.parse(source.at),
      createdAtMs: Date.parse(source.createdAt),
      updatedAtMs: Date.parse(source.updatedAt),
    },
    migration: { version: 1, kind: 'legacy-author-v1', sourceContentId },
  }
}

export function buildFixtureTombstoneResurrection() {
  const tombstone = fixtureEvents().find(item => item.id === 'legacy-diary-tombstone' && item.deleted)
  return {
    ...cloneJson(tombstone),
    rev: tombstone.rev + 1,
    deleted: false,
    updatedAt: '2026-07-01T05:20:00.000Z',
  }
}

function parseDataContractCli(args) {
  const [command, ...rest] = args
  if (command !== 'manifest' && command !== 'compare-manifest') {
    throw new Error('data contract command must be manifest or compare-manifest')
  }
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!['--root', '--output', '--before'].includes(flag)) throw new Error(`unknown data contract argument: ${flag}`)
    if (Object.prototype.hasOwnProperty.call(values, flag)) throw new Error(`duplicate data contract argument: ${flag}`)
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`data contract argument value is required: ${flag}`)
    }
    values[flag] = value
  }
  if (!values['--root']) throw new Error('--root is required')
  if (command === 'manifest' && !values['--output']) throw new Error('--output is required')
  if (command === 'compare-manifest' && !values['--before']) throw new Error('--before is required')
  return { command, root: values['--root'], output: values['--output'], before: values['--before'] }
}

/** Narrow command seam used by shell wrappers; no application data is mutated. */
export async function runDataContractCli(args) {
  const options = parseDataContractCli(args)
  const current = await createRawManifest(options.root)
  if (options.command === 'manifest') {
    const output = path.resolve(options.output)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return current
  }
  const before = JSON.parse(await readFile(path.resolve(options.before), 'utf8'))
  assertRawManifestsEqual(before, current)
  return compareRawManifests(before, current)
}

const DATA_CONTRACT_SCRIPT = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === DATA_CONTRACT_SCRIPT
if (isDirectRun) {
  try {
    const result = await runDataContractCli(process.argv.slice(2))
    console.log(JSON.stringify({ command: process.argv[2], equal: result.equal ?? true }))
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownFailure'
    console.error(`[upgrade-data-contract] FAIL ${name}`)
    process.exitCode = 1
  }
}
