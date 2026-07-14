/**
 * One-time, append-only repair for the exact v0.3.8 upgrade-test fixture.
 *
 * Safety properties:
 * - audit-only unless --apply is paired with the exact incident token;
 * - only canonical raw fixture records and exact auth-bound derivatives match;
 * - an immutable forensic copy is durably published before the first append;
 * - original JSONL bytes are never rewritten or deleted;
 * - deterministic higher-revision tombstones make interrupted reruns idempotent;
 * - reports contain aggregate counts and hashes, never event/profile values.
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v5 as uuidv5 } from 'uuid'
import { buildV038Fixture, canonicalJson } from './upgrade-data-contract.mjs'

export const INCIDENT_V038_FIXTURE_REPAIR_TOKEN = 'RESTORE_BABY_DIARY_2026-07-14'

const LEGACY_EVENT_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const EVENT_CONTENT_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const INCIDENT_TOMBSTONE_NAMESPACE = '6ba7b81a-9dad-11d1-80b4-00c04fd430c8'
const EVENT_FILE = /^events-\d{1,4}-\d{2}\.jsonl$/
const MUTATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_EVENT_FILE_BYTES = 256 * 1024 * 1024
const MAX_EVENT_TREE_BYTES = 1024 * 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function normalizeFsPath(value) {
  const normalized = path.resolve(value).normalize('NFC')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function pathsOverlap(left, right) {
  const normalizedLeft = normalizeFsPath(left)
  const normalizedRight = normalizeFsPath(right)
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${path.sep}`)
    || normalizedRight.startsWith(`${normalizedLeft}${path.sep}`)
}

function requireAbsoluteSafePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an explicit absolute path`)
  }
  const resolved = path.resolve(value).normalize('NFC')
  if (normalizeFsPath(resolved) === normalizeFsPath(path.parse(resolved).root)) {
    throw new Error(`${label} is an unsafe filesystem root`)
  }
  return resolved
}

function sameIdentity(left, right) {
  return left.isFile() === right.isFile()
    && left.isDirectory() === right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  }

async function requireCanonicalDirectory(directory, label) {
  let stats
  let canonical
  try {
    stats = await lstat(directory)
    canonical = await realpath(directory)
  } catch {
    throw new Error(`${label} must already be a real directory`)
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || normalizeFsPath(canonical) !== normalizeFsPath(directory)) {
    throw new Error(`${label} must be a canonical real directory`)
  }
  return stats
}

async function pathKind(candidate) {
  try {
    return await lstat(candidate)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function validateProfilePath(profilePath) {
  const profile = requireAbsoluteSafePath(profilePath, 'profile path')
  await requireCanonicalDirectory(profile, 'profile path')
  await requireCanonicalDirectory(path.join(profile, 'data'), 'profile data path')
  return profile
}

async function validateQuarantinePath(profile, quarantinePath) {
  const quarantine = requireAbsoluteSafePath(quarantinePath, 'quarantine path')
  if (pathsOverlap(profile, quarantine)) {
    throw new Error('profile and quarantine paths overlap')
  }
  const existing = await pathKind(quarantine)
  if (existing) {
    await requireCanonicalDirectory(quarantine, 'quarantine path')
  } else {
    await requireCanonicalDirectory(path.dirname(quarantine), 'quarantine parent path')
  }
  return quarantine
}

function contentId(event) {
  return uuidv5(`baby-diary:event-content:${canonicalJson(event)}`, EVENT_CONTENT_NAMESPACE)
}

function legacyMutationId(event) {
  return uuidv5(`baby-diary:legacy-event:${canonicalJson(event)}`, LEGACY_EVENT_NAMESPACE)
}

function deriveExactAuthBoundFixture(source, writerUid) {
  if (typeof writerUid !== 'string' || writerUid.length === 0) return undefined
  return {
    ...cloneJson(source),
    mutationId: legacyMutationId(source),
    rev: Math.max(source.rev + 1, Date.parse(source.updatedAt)),
    author: { ...cloneJson(source.author), uid: writerUid },
    sync: {
      version: 1,
      encodedEventId: encodeURIComponent(source.id),
      eventAtMs: Date.parse(source.at),
      createdAtMs: Date.parse(source.createdAt),
      updatedAtMs: Date.parse(source.updatedAt),
    },
    migration: {
      version: 1,
      kind: 'legacy-author-v1',
      sourceContentId: contentId(source),
    },
  }
}

const FIXTURE_SOURCES = Object.freeze(
  (buildV038Fixture().events ?? []).map(event => Object.freeze(cloneJson(event))),
)
const RAW_FIXTURE_BY_CANONICAL = new Map(
  FIXTURE_SOURCES.map(source => [canonicalJson(source), source]),
)
const FIXTURE_BY_CONTENT_ID = new Map(
  FIXTURE_SOURCES.map(source => [contentId(source), source]),
)
const FIXTURE_BY_LOGICAL_ID = new Map()
for (const source of FIXTURE_SOURCES) {
  const group = FIXTURE_BY_LOGICAL_ID.get(source.id) ?? []
  group.push(source)
  FIXTURE_BY_LOGICAL_ID.set(source.id, group)
}

function classifyExactFixture(event) {
  const raw = RAW_FIXTURE_BY_CANONICAL.get(canonicalJson(event))
  if (raw) return { kind: 'raw', source: raw }
  if (event?.migration?.kind !== 'legacy-author-v1'
    || typeof event.migration.sourceContentId !== 'string'
    || typeof event?.author?.uid !== 'string') return undefined
  const source = FIXTURE_BY_CONTENT_ID.get(event.migration.sourceContentId)
  if (!source) return undefined
  const expected = deriveExactAuthBoundFixture(source, event.author.uid)
  if (!expected || canonicalJson(expected) !== canonicalJson(event)) return undefined
  return { kind: 'auth-bound', source }
}

function incidentMutationId(logicalId) {
  return uuidv5(`baby-diary:incident-v038-fixture-repair:${logicalId}`, INCIDENT_TOMBSTONE_NAMESPACE)
}

function buildTombstone(source, winner) {
  if (!Number.isSafeInteger(winner.rev) || winner.rev >= Number.MAX_SAFE_INTEGER) {
    throw new Error('fixture revision cannot be advanced safely')
  }
  return {
    id: source.id,
    mutationId: incidentMutationId(source.id),
    type: source.type,
    at: source.at,
    data: cloneJson(source.data),
    author: cloneJson(winner.author),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    rev: winner.rev + 1,
    deleted: true,
  }
}

function isIncidentTombstone(event) {
  if (!event || typeof event.id !== 'string'
    || event.mutationId !== incidentMutationId(event.id)
    || event.deleted !== true
    || event.sync !== undefined
    || event.migration !== undefined) return false
  const sources = FIXTURE_BY_LOGICAL_ID.get(event.id)
  if (!sources || typeof event?.author?.uid !== 'string') return false
  return sources.some(source => {
    const rawExpected = buildTombstone(source, source)
    if (canonicalJson(rawExpected) === canonicalJson(event)) return true
    const derivative = deriveExactAuthBoundFixture(source, event.author.uid)
    return derivative && canonicalJson(buildTombstone(source, derivative)) === canonicalJson(event)
  })
}

function mutationKey(event) {
  if (typeof event.mutationId === 'string' && MUTATION_ID.test(event.mutationId)) {
    return `mutation:${encodeURIComponent(event.id)}:${event.rev}:${event.mutationId}`
  }
  return `legacy:${encodeURIComponent(event.id)}:${event.rev}:${canonicalJson(event)}`
}

function compareEventMutations(left, right) {
  if (left.rev !== right.rev) return left.rev < right.rev ? -1 : 1
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1
  const leftUpdatedAt = Date.parse(left.updatedAt)
  const rightUpdatedAt = Date.parse(right.updatedAt)
  const leftValid = Number.isFinite(leftUpdatedAt)
  const rightValid = Number.isFinite(rightUpdatedAt)
  if (leftValid !== rightValid) return leftValid ? 1 : -1
  if (leftValid && leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt < rightUpdatedAt ? -1 : 1
  const leftKey = mutationKey(left)
  const rightKey = mutationKey(right)
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
  const leftCanonical = canonicalJson(left)
  const rightCanonical = canonicalJson(right)
  return leftCanonical === rightCanonical ? 0 : leftCanonical < rightCanonical ? -1 : 1
}

function assertProjectableEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || typeof event.id !== 'string' || event.id.length === 0
    || !Number.isSafeInteger(event.rev) || event.rev < 1
    || typeof event.deleted !== 'boolean'
    || typeof event.updatedAt !== 'string' || !Number.isFinite(Date.parse(event.updatedAt))
    || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) {
    throw new Error('event log contains a non-projectable record')
  }
}

async function readStableRegularFile(filePath) {
  const before = await lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_EVENT_FILE_BYTES) {
    throw new Error('event log contains an unsafe or oversized file')
  }
  const canonical = await realpath(filePath)
  if (normalizeFsPath(canonical) !== normalizeFsPath(filePath)) {
    throw new Error('event log path traverses a link or reparse point')
  }
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0
  const descriptor = await open(filePath, constants.O_RDONLY | noFollow)
  try {
    const opened = await descriptor.stat()
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error('event log identity changed while opening')
    }
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat()
    if (bytes.length !== opened.size || !sameIdentity(opened, after)) {
      throw new Error('event log changed while reading')
    }
    const finalPathStats = await lstat(filePath)
    if (!sameIdentity(opened, finalPathStats)) {
      throw new Error('event log path changed while reading')
    }
    return { bytes, size: bytes.length, sha256: sha256(bytes) }
  } finally {
    await descriptor.close()
  }
}

function parseEventFileBytes(name, bytes) {
  const records = []
  const lines = bytes.toString('utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length === 0) continue
    let event
    try {
      event = JSON.parse(lines[index])
    } catch {
      throw new Error('event log contains malformed or truncated JSON')
    }
    assertProjectableEvent(event)
    records.push({ event, name, line: index + 1 })
  }
  return records
}

async function scanProfile(profile) {
  const dataRoot = path.join(profile, 'data')
  const settings = await readStableRegularFile(path.join(profile, 'settings.json'))
  const names = (await readdir(dataRoot)).filter(name => EVENT_FILE.test(name)).sort(compareUtf8)
  const files = []
  const records = []
  let totalBytes = 0
  for (const name of names) {
    const snapshot = await readStableRegularFile(path.join(dataRoot, name))
    totalBytes += snapshot.size
    if (totalBytes > MAX_EVENT_TREE_BYTES) throw new Error('event log tree exceeds the repair safety cap')
    files.push({ name, ...snapshot })
    records.push(...parseEventFileBytes(name, snapshot.bytes))
  }
  const projectionSha256 = profileProjectionSha256(settings.sha256, records)
  const rawTreeSha256 = sha256(canonicalJson({
    settings: { size: settings.size, sha256: settings.sha256 },
    eventFiles: files.map(file => ({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
    })),
  }))
  return { settings, files, records, projectionSha256, rawTreeSha256 }
}

function profileProjectionSha256(settingsSha256, records) {
  return sha256(canonicalJson({
    settingsSha256,
    events: records.map(record => canonicalJson(record.event)).sort(compareUtf8),
  }))
}

function analyzeScan(scan) {
  const winners = new Map()
  const classifications = new Map()
  let matchedMutationCount = 0
  let repairMutationCount = 0
  for (const record of scan.records) {
    const classification = classifyExactFixture(record.event)
    if (classification) {
      classifications.set(record, classification)
      matchedMutationCount += 1
    } else if (isIncidentTombstone(record.event)) {
      repairMutationCount += 1
    }
    const prior = winners.get(record.event.id)
    if (!prior || compareEventMutations(record.event, prior.event) > 0) winners.set(record.event.id, record)
  }

  const targets = []
  let alreadyDeletedFixtureCount = 0
  let alreadyRepairedFixtureCount = 0
  for (const [logicalId, winner] of winners) {
    if (!FIXTURE_BY_LOGICAL_ID.has(logicalId)) continue
    if (isIncidentTombstone(winner.event)) {
      alreadyRepairedFixtureCount += 1
      continue
    }
    const classification = classifications.get(winner)
    if (!classification) continue
    if (winner.event.deleted) {
      alreadyDeletedFixtureCount += 1
      continue
    }
    targets.push(buildTombstone(classification.source, winner.event))
  }
  targets.sort((left, right) => compareUtf8(left.id, right.id))
  return {
    targets,
    matchedMutationCount,
    alreadyDeletedFixtureCount,
    alreadyRepairedFixtureCount,
    unaffectedMutationCount: scan.records.length - matchedMutationCount - repairMutationCount,
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const descriptor = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

async function writeDurableExclusive(filePath, bytes) {
  const descriptor = await open(filePath, 'wx', 0o600)
  try {
    await descriptor.writeFile(bytes)
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

function evidenceManifest(profile, scan) {
  const files = scan.files.map(file => ({
    path: `data/${file.name}`,
    size: file.size,
    sha256: file.sha256,
  }))
  return {
    schemaVersion: 1,
    incidentCode: 'v038-upgrade-fixture-contamination',
    profileBindingSha256: sha256(normalizeFsPath(profile)),
    beforeProjectionSha256: scan.projectionSha256,
    settingsSize: scan.settings.size,
    settingsSha256: scan.settings.sha256,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    fileSetSha256: sha256(canonicalJson(files)),
    files,
  }
}

function validateManifestShape(manifest, profile) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || manifest.incidentCode !== 'v038-upgrade-fixture-contamination'
    || manifest.profileBindingSha256 !== sha256(normalizeFsPath(profile))
    || typeof manifest.beforeProjectionSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(manifest.beforeProjectionSha256)
    || !Number.isSafeInteger(manifest.settingsSize) || manifest.settingsSize < 0
    || typeof manifest.settingsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.settingsSha256)
    || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0
    || !Array.isArray(manifest.files)) {
    throw new Error('forensic manifest is invalid or bound to another profile')
  }
  const allowedKeys = [
    'beforeProjectionSha256', 'fileCount', 'fileSetSha256', 'files', 'incidentCode',
    'profileBindingSha256', 'schemaVersion', 'settingsSha256', 'settingsSize', 'totalBytes',
  ].sort()
  if (Object.keys(manifest).sort().join(',') !== allowedKeys.join(',')) {
    throw new Error('forensic manifest field shape is invalid')
  }
  const seen = new Set()
  for (const entry of manifest.files) {
    const entryKeys = entry && typeof entry === 'object' ? Object.keys(entry).sort().join(',') : ''
    if (entryKeys !== 'path,sha256,size'
      || typeof entry.path !== 'string'
      || !/^data\/events-\d{1,4}-\d{2}\.jsonl$/.test(entry.path)
      || seen.has(entry.path)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error('forensic manifest file entry is invalid')
    }
    seen.add(entry.path)
  }
  const sorted = [...manifest.files].sort((left, right) => compareUtf8(left.path, right.path))
  if (manifest.files.some((entry, index) => entry.path !== sorted[index].path)
    || manifest.fileCount !== manifest.files.length
    || manifest.totalBytes !== manifest.files.reduce((total, file) => total + file.size, 0)
    || manifest.fileSetSha256 !== sha256(canonicalJson(manifest.files))) {
    throw new Error('forensic manifest aggregate hashes are invalid')
  }
}

async function verifyExistingEvidence(profile, quarantine) {
  await requireCanonicalDirectory(quarantine, 'quarantine path')
  const manifestBytes = await readFile(path.join(quarantine, 'manifest.json'))
  const sidecar = (await readFile(path.join(quarantine, 'manifest.sha256'), 'utf8')).trim()
  const manifestSha256 = sha256(manifestBytes)
  if (sidecar !== manifestSha256) throw new Error('forensic manifest hash verification failed')
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('forensic manifest JSON is invalid')
  }
  validateManifestShape(manifest, profile)
  const settingsCopy = await readStableRegularFile(path.join(quarantine, 'files', 'settings.json'))
  if (settingsCopy.size !== manifest.settingsSize || settingsCopy.sha256 !== manifest.settingsSha256) {
    throw new Error('forensic settings copy hash verification failed')
  }
  const eventCopies = new Map()
  const baselineRecords = []
  for (const entry of manifest.files) {
    const absolute = path.join(quarantine, 'files', ...entry.path.split('/'))
    const verified = await readStableRegularFile(absolute)
    if (verified.size !== entry.size || verified.sha256 !== entry.sha256) {
      throw new Error('forensic copy hash verification failed')
    }
    const name = path.basename(entry.path)
    eventCopies.set(name, verified.bytes)
    baselineRecords.push(...parseEventFileBytes(name, verified.bytes))
  }
  const baselineProjectionSha256 = profileProjectionSha256(settingsCopy.sha256, baselineRecords)
  if (baselineProjectionSha256 !== manifest.beforeProjectionSha256) {
    throw new Error('forensic baseline projection hash verification failed')
  }
  return {
    manifest,
    manifestSha256,
    settingsCopy,
    eventCopies,
    baselineProjectionSha256,
  }
}

function bytesStartWith(value, prefix) {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix)
}

function assertExistingEvidenceCompatible(scan, evidence) {
  const fail = () => {
    throw new Error('current profile does not match the durable forensic evidence')
  }
  if (scan.settings.size !== evidence.manifest.settingsSize
    || scan.settings.sha256 !== evidence.manifest.settingsSha256) fail()

  const expectedNames = evidence.manifest.files.map(entry => path.basename(entry.path))
  const currentNames = scan.files.map(file => file.name)
  if (canonicalJson(currentNames) !== canonicalJson(expectedNames)) fail()

  let exactRawFileSet = true
  for (let index = 0; index < scan.files.length; index += 1) {
    const current = scan.files[index]
    const entry = evidence.manifest.files[index]
    const baseline = evidence.eventCopies.get(current.name)
    if (!baseline) fail()
    if (current.size === entry.size && current.sha256 === entry.sha256) continue
    exactRawFileSet = false
    if (!bytesStartWith(current.bytes, baseline)) fail()
    const suffix = current.bytes.subarray(baseline.length)
    const suffixRecords = parseEventFileBytes(current.name, suffix)
    if (suffixRecords.length === 0 || suffixRecords.some(record => !isIncidentTombstone(record.event))) fail()
  }

  if (exactRawFileSet && scan.projectionSha256 !== evidence.manifest.beforeProjectionSha256) fail()
}

async function publishForensicEvidence(profile, quarantine, scan) {
  const existing = await pathKind(quarantine)
  if (existing) return verifyExistingEvidence(profile, quarantine)

  const staging = `${quarantine}.staging-${process.pid}-${randomUUID()}`
  const manifest = evidenceManifest(profile, scan)
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const manifestSha256 = sha256(manifestBytes)
  let published = false
  try {
    await mkdir(path.join(staging, 'files', 'data'), { recursive: true, mode: 0o700 })
    await writeDurableExclusive(path.join(staging, 'files', 'settings.json'), scan.settings.bytes)
    for (const file of scan.files) {
      await writeDurableExclusive(path.join(staging, 'files', 'data', file.name), file.bytes)
    }
    await syncDirectory(path.join(staging, 'files', 'data'))
    await syncDirectory(path.join(staging, 'files'))
    await writeDurableExclusive(path.join(staging, 'manifest.json'), manifestBytes)
    await writeDurableExclusive(
      path.join(staging, 'manifest.sha256'),
      Buffer.from(`${manifestSha256}\n`, 'utf8'),
    )
    await syncDirectory(staging)
    await rename(staging, quarantine)
    published = true
    await syncDirectory(path.dirname(quarantine))
    return verifyExistingEvidence(profile, quarantine)
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

function monthFile(event) {
  const date = new Date(event.at)
  return `events-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

async function appendDurableTombstone(profile, tombstone) {
  const filePath = path.join(profile, 'data', monthFile(tombstone))
  const existing = await pathKind(filePath)
  if (existing) {
    const snapshot = await readStableRegularFile(filePath)
    if (snapshot.size > 0 && snapshot.bytes[snapshot.size - 1] !== 0x0a) {
      throw new Error('event log has a torn final record; append refused')
    }
  }
  const descriptor = await open(filePath, 'a', 0o600)
  try {
    await descriptor.writeFile(Buffer.from(`${JSON.stringify(tombstone)}\n`, 'utf8'))
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
  if (!existing) await syncDirectory(path.dirname(filePath))
}

function makeResult({ mode, before, after, analysis, appended, evidenceManifestSha256 }) {
  return {
    mode,
    fixtureLogicalIdCount: FIXTURE_BY_LOGICAL_ID.size,
    matchedMutationCount: analysis.matchedMutationCount,
    unaffectedMutationCount: analysis.unaffectedMutationCount,
    alreadyDeletedFixtureCount: analysis.alreadyDeletedFixtureCount,
    alreadyRepairedFixtureCount: analysis.alreadyRepairedFixtureCount,
    appendedTombstoneCount: appended,
    beforeProjectionSha256: before,
    afterProjectionSha256: after,
    evidenceManifestSha256,
  }
}

/**
 * Runs a read-only audit by default. The optional lifecycle callback exists so
 * callers can coordinate process shutdown after evidence is durable; it runs
 * before the first profile append and receives no profile data.
 */
export async function runIncidentV038FixtureRepair(options, lifecycle = {}) {
  const apply = options?.apply === true
  if (apply && options?.authorizationToken !== INCIDENT_V038_FIXTURE_REPAIR_TOKEN) {
    throw new Error('exact incident authorization token is required')
  }
  const profile = await validateProfilePath(options?.profilePath)
  let quarantine
  if (apply) {
    if (typeof options?.quarantinePath !== 'string' || options.quarantinePath.length === 0) {
      throw new Error('explicit quarantine path is required for apply')
    }
    quarantine = await validateQuarantinePath(profile, options.quarantinePath)
  }

  const beforeScan = await scanProfile(profile)
  const analysis = analyzeScan(beforeScan)
  if (!apply) {
    return makeResult({
      mode: 'audit',
      before: beforeScan.projectionSha256,
      after: beforeScan.projectionSha256,
      analysis,
      appended: 0,
      evidenceManifestSha256: null,
    })
  }

  let evidenceManifestSha256 = null
  const existingEvidence = Boolean(await pathKind(quarantine))
  if (analysis.targets.length > 0 || existingEvidence) {
    const evidence = await publishForensicEvidence(profile, quarantine, beforeScan)
    if (existingEvidence) assertExistingEvidenceCompatible(beforeScan, evidence)
    evidenceManifestSha256 = evidence.manifestSha256
    if (!await pathKind(quarantine)) throw new Error('durable forensic evidence is unavailable')
    if (typeof lifecycle.afterForensicEvidenceDurable === 'function') {
      await lifecycle.afterForensicEvidenceDurable()
    }
  }

  if (analysis.targets.length > 0) {
    const stableScan = await scanProfile(profile)
    if (stableScan.rawTreeSha256 !== beforeScan.rawTreeSha256) {
      throw new Error('profile changed after forensic capture; append refused')
    }
    for (const tombstone of analysis.targets) await appendDurableTombstone(profile, tombstone)
  }

  const afterScan = await scanProfile(profile)
  const afterAnalysis = analyzeScan(afterScan)
  if (afterAnalysis.targets.length > 0) {
    throw new Error('one or more exact fixture winners remain live after apply')
  }
  return makeResult({
    mode: 'apply',
    before: beforeScan.projectionSha256,
    after: afterScan.projectionSha256,
    analysis,
    appended: analysis.targets.length,
    evidenceManifestSha256,
  })
}

function parseCli(args) {
  let apply = false
  const values = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--apply') {
      if (apply) throw new Error('duplicate apply flag')
      apply = true
      continue
    }
    if (!['--profile', '--quarantine', '--authorization-token'].includes(argument)) {
      throw new Error('unknown repair argument')
    }
    if (values.has(argument)) throw new Error('duplicate repair argument')
    const value = args[index + 1]
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error('repair argument value is required')
    }
    values.set(argument, value)
    index += 1
  }
  if (!values.has('--profile')) throw new Error('explicit profile path is required')
  return {
    profilePath: values.get('--profile'),
    quarantinePath: values.get('--quarantine'),
    authorizationToken: values.get('--authorization-token'),
    apply,
  }
}

const SCRIPT_PATH = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = await runIncidentV038FixtureRepair(parseCli(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write('[incident-v038-fixture-repair] FAIL\n')
    process.exitCode = 1
  }
}
