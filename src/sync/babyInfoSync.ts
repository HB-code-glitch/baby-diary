import type {
  DocumentData,
  DocumentSnapshot,
  Firestore,
  QueryConstraint,
  QuerySnapshot,
} from 'firebase/firestore'
import type {
  AppSettings,
  BabyInfoJournalSummary,
  BabyInfoMutation,
} from '../../shared/types'
import {
  babyInfoProjectionShouldReplace,
  canonicalBabyInfoMutationJson,
  getBabyInfoMutationKey,
  isBabyInfoMutationCloudFresh,
  makeAuthBoundLegacyCloudBridgeBabyInfoMutation,
  makeLegacyCloudBabyInfoMutation,
} from '../../shared/babyInfoResolver'
import { assertFamilyId } from '../../shared/familyId'
import { isValidMutationId } from '../../shared/eventResolver'
import { ipc } from '../lib/ipc'

export type BabyInfoPersistenceStatus = 'unchanged' | 'local-only' | 'pending'

export interface BabyInfoPersistenceResult {
  settings: AppSettings
  babyInfo: BabyInfoPersistenceStatus
}

export interface FamilyBabyInfoDocument {
  babyName?: string
  babyBirthdate?: string
  babyInfoWinnerKey?: string
  babyInfoWinnerMutationId?: string
  babyInfoWinnerLogicalClock?: number
  babyInfoWinnerUpdatedAt?: string
  babyInfoWinnerAuthorId?: string
  babyInfoWinnerOrigin?: BabyInfoMutation['origin']
}

export interface BabyInfoFirestoreOps {
  collection: typeof import('firebase/firestore').collection
  doc: typeof import('firebase/firestore').doc
  query: typeof import('firebase/firestore').query
  orderBy: typeof import('firebase/firestore').orderBy
  documentId: typeof import('firebase/firestore').documentId
  startAfter: typeof import('firebase/firestore').startAfter
  limit: typeof import('firebase/firestore').limit
  getDoc: typeof import('firebase/firestore').getDoc
  setDoc: typeof import('firebase/firestore').setDoc
  updateDoc: typeof import('firebase/firestore').updateDoc
  getDocs: typeof import('firebase/firestore').getDocs
}

export interface ReconcileBabyInfoOptions {
  db: Firestore
  familyId: string
  familyRef: ReturnType<BabyInfoFirestoreOps['doc']>
  familyData: FamilyBabyInfoDocument
  ops: BabyInfoFirestoreOps
  /** Generation/lifecycle guard supplied by the sync engine. */
  assertCurrent?: () => void
}

export interface ReconcileBabyInfoResult {
  pendingCount: number
  activePendingCount: number
  needsRetry: boolean
  uploadFailures: number
  settings: AppSettings
  /**
   * True only when this cycle bridged an exact v0.3.8 pair-only cloud write
   * (no proof fields) into the mutation model, i.e. evidence that some
   * device wrote through the now-rejected legacy path. Never true for
   * local-only recording (no family/writer identity).
   */
  legacyClientUpdateRequired: boolean
}

const CLOUD_PAGE_SIZE = 250
const PENDING_PAGE_SIZE = 100

let persistenceObserver: ((pendingCount: number, needsRetry: boolean) => void) | undefined

export function setBabyInfoPersistenceObserver(
  observer: ((pendingCount: number, needsRetry: boolean) => void) | undefined,
): void {
  persistenceObserver = observer
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function persistSettingsOperation(nextSettings: AppSettings): Promise<BabyInfoPersistenceResult> {
  const current = await ipc.getSettings()
  if (current.familyId !== nextSettings.familyId) {
    throw new Error('baby info family changed; refresh settings before saving')
  }

  // The bounded baby-info commit intentionally owns only name/birthdate. Save
  // every other setting through the main process first; its managed-save
  // contract preserves the current pair and journal metadata while persisting
  // gender, profile, language, theme, and the remaining ordinary settings.
  const saved = await ipc.saveSettings(nextSettings)
  if (saved.familyId !== nextSettings.familyId) {
    throw new Error('baby info family changed; refresh settings before saving')
  }

  const result = await ipc.commitBabyInfo({
    kind: 'user-edit',
    familyId: saved.familyId,
    babyName: nextSettings.baby.name,
    babyBirthdate: nextSettings.baby.birthdate,
  })
  persistenceObserver?.(result.pendingCount, result.activePendingCount > 0)
  return { settings: result.settings, babyInfo: result.babyInfo }
}

/** Persists only the bounded baby-info edit delta; history stays main-process-owned. */
export function persistSettingsWithBabyInfoMutation(
  nextSettings: AppSettings,
): Promise<BabyInfoPersistenceResult> {
  return persistSettingsOperation(nextSettings)
}

/** Generic settings save that cannot overwrite the main-managed baby-info fields. */
export async function persistSettingsWithoutBabyInfoMutation(
  nextSettings: AppSettings,
): Promise<AppSettings> {
  const settings = await ipc.saveSettings(nextSettings)
  if (!settings.familyId) {
    persistenceObserver?.(0, false)
    return settings
  }
  const summary = await ipc.getBabyInfoSummary(settings.familyId)
  persistenceObserver?.(summary.totalPendingCount, summary.pendingCount > 0)
  return settings
}

/** Firestore-safe content-bound document identity. */
export function makeBabyInfoDocId(mutation: BabyInfoMutation): string {
  const key = getBabyInfoMutationKey(mutation)
  const parts = key.split(':')
  if (parts.length !== 3 || parts[0] !== 'baby-info') throw new Error('invalid baby info mutation key')
  return `b1|${parts[1]}|${parts[2]}`
}

/** Strict decoder: only the exact `{ mutation }` envelope is accepted. */
export function parseCloudBabyInfoDocument(
  docId: string,
  data: DocumentData,
  expectedFamilyId?: string,
  nowMs = Date.now(),
): BabyInfoMutation | null {
  if (typeof docId !== 'string' || docId.length > 256 || !isPlainRecord(data)) return null
  const envelopeKeys = Object.keys(data)
  if (envelopeKeys.length !== 1 || envelopeKeys[0] !== 'mutation') return null

  const parts = docId.split('|')
  if (parts.length !== 3 || parts[0] !== 'b1' || !isValidMutationId(parts[1]) || !isValidMutationId(parts[2])) {
    return null
  }
  const candidate = data.mutation as BabyInfoMutation
  try {
    if (candidate.mutationId !== parts[1]) return null
    if (expectedFamilyId !== undefined && candidate.familyId !== expectedFamilyId) return null
    if (makeBabyInfoDocId(candidate) !== docId) return null
    canonicalBabyInfoMutationJson(candidate)
    // A forged content-hash segment is unreachable from any content this
    // client would ever generate, but Firestore rules cannot recompute a
    // UUIDv5 hash; the docId round-trip above is this check's real guard.
    if (!isBabyInfoMutationCloudFresh(candidate, nowMs)) return null
    return candidate
  } catch {
    return null
  }
}

function snapshotExactMutation(
  snapshot: DocumentSnapshot,
  expected: BabyInfoMutation,
): boolean {
  if (!snapshot.exists()) return false
  const remote = parseCloudBabyInfoDocument(
    snapshot.id,
    snapshot.data() as DocumentData,
    expected.familyId,
  )
  return remote !== null
    && canonicalBabyInfoMutationJson(remote) === canonicalBabyInfoMutationJson(expected)
}

async function uploadAndReadBack(
  mutation: BabyInfoMutation,
  options: ReconcileBabyInfoOptions,
): Promise<boolean> {
  const { db, familyId, ops } = options
  const docId = makeBabyInfoDocId(mutation)
  const ref = ops.doc(db, 'families', familyId, 'babyInfoMutations', docId)

  try {
    options.assertCurrent?.()
    const existing = await ops.getDoc(ref)
    options.assertCurrent?.()
    if (existing.exists()) return snapshotExactMutation(existing, mutation)
    options.assertCurrent?.()
    await ops.setDoc(ref, { mutation })
    options.assertCurrent?.()
  } catch {
    options.assertCurrent?.()
    // A concurrent create or transient write is decided by the fresh read-back.
  }

  try {
    options.assertCurrent?.()
    const snapshot = await ops.getDoc(ref)
    options.assertCurrent?.()
    return snapshotExactMutation(snapshot, mutation)
  } catch {
    options.assertCurrent?.()
    return false
  }
}

function cloudDocuments(
  snapshot: Pick<QuerySnapshot, 'docs'>,
  expectedFamilyId: string,
): BabyInfoMutation[] {
  const mutations: BabyInfoMutation[] = []
  for (const document of snapshot.docs) {
    const mutation = parseCloudBabyInfoDocument(document.id, document.data(), expectedFamilyId)
    if (!mutation) {
      console.error(`[syncEngine] ignored invalid cloud baby info document: ${document.id}`)
      continue
    }
    mutations.push(mutation)
  }
  return mutations
}

function projectionPatch(winner: BabyInfoMutation): FamilyBabyInfoDocument {
  return {
    babyName: winner.babyName,
    babyBirthdate: winner.babyBirthdate,
    babyInfoWinnerKey: getBabyInfoMutationKey(winner),
    babyInfoWinnerMutationId: winner.mutationId,
    babyInfoWinnerLogicalClock: winner.logicalClock,
    babyInfoWinnerUpdatedAt: winner.updatedAt,
    babyInfoWinnerAuthorId: winner.authorId,
    babyInfoWinnerOrigin: winner.origin,
  }
}

function projectionDiffers(
  familyData: FamilyBabyInfoDocument,
  patch: FamilyBabyInfoDocument,
): boolean {
  return Object.entries(patch).some(([key, value]) => (
    familyData[key as keyof FamilyBabyInfoDocument] !== value
  ))
}

async function ingestCloudPages(
  options: ReconcileBabyInfoOptions,
): Promise<AppSettings | undefined> {
  const collectionRef = options.ops.collection(
    options.db,
    'families',
    options.familyId,
    'babyInfoMutations',
  )
  let cursor: string | undefined
  let settings: AppSettings | undefined

  for (;;) {
    const constraints: QueryConstraint[] = [options.ops.orderBy(options.ops.documentId())]
    if (cursor !== undefined) constraints.push(options.ops.startAfter(cursor))
    constraints.push(options.ops.limit(CLOUD_PAGE_SIZE))
    const pageQuery = options.ops.query(collectionRef, ...constraints)
    options.assertCurrent?.()
    const snapshot = await options.ops.getDocs(pageQuery)
    options.assertCurrent?.()
    const mutations = cloudDocuments(snapshot, options.familyId)
    if (mutations.length > 0) {
      const committed = await ipc.commitBabyInfo({
        kind: 'reconcile',
        familyId: options.familyId,
        discoveredMutations: mutations,
        exactAcknowledgedMutationKeys: mutations.map(getBabyInfoMutationKey),
      })
      options.assertCurrent?.()
      settings = committed.settings
    }

    if (snapshot.docs.length < CLOUD_PAGE_SIZE) return settings
    cursor = snapshot.docs[snapshot.docs.length - 1].id
  }
}

/**
 * Detects an exact v0.3.8-shaped pair-only family write (no proof fields)
 * and bridges it into the mutation model. Hardened rules reject *new* direct
 * pair writes going forward, so this only ever fires against production data
 * written before this rollout; it is durable read/migration compatibility,
 * not a write path. When a writer identity is available the bridge is
 * auth-bound (never the unauthenticated `legacy-cloud-bridge` sentinel), so
 * the one derivative this cycle uploads carries current proof.
 */
async function ingestLegacyProjection(
  options: ReconcileBabyInfoOptions,
  summary: BabyInfoJournalSummary,
  writerUid: string,
): Promise<{ summary: BabyInfoJournalSummary; settings?: AppSettings; legacyDetected: boolean }> {
  let candidate: BabyInfoMutation | undefined
  const projectedName = options.familyData.babyName ?? ''
  const projectedBirthdate = options.familyData.babyBirthdate ?? ''

  if (!options.familyData.babyInfoWinnerKey) {
    candidate = makeLegacyCloudBabyInfoMutation(
      options.familyId,
      projectedName,
      projectedBirthdate,
    )
  } else {
    const markerKey = options.familyData.babyInfoWinnerKey
    const marker = await ipc.getBabyInfoMutation(options.familyId, markerKey)
    options.assertCurrent?.()
    if (marker && writerUid.length > 0) {
      // The marker's own logical clock is the deterministic promotion basis
      // (not wall-clock time) so replaying this bridge across restarts and
      // opposite discovery orders always re-derives byte-identical content.
      candidate = makeAuthBoundLegacyCloudBridgeBabyInfoMutation(
        options.familyId,
        projectedName,
        projectedBirthdate,
        markerKey,
        marker,
        writerUid,
        marker.logicalClock,
      )
    }
  }

  if (!candidate) return { summary, legacyDetected: false }
  const committed = await ipc.commitBabyInfo({
    kind: 'reconcile',
    familyId: options.familyId,
    discoveredMutations: [candidate],
    exactAcknowledgedMutationKeys: [],
  })
  options.assertCurrent?.()
  const nextSummary = await ipc.getBabyInfoSummary(options.familyId)
  options.assertCurrent?.()
  return {
    summary: nextSummary,
    settings: committed.settings,
    legacyDetected: true,
  }
}

async function uploadPendingPages(
  options: ReconcileBabyInfoOptions,
  initialSummary: BabyInfoJournalSummary,
): Promise<{ summary: BabyInfoJournalSummary; settings?: AppSettings }> {
  // Bound this run to the pending set observed after cloud/legacy ingestion.
  // Concurrent edits stay durable and are picked up by the next retry.
  let remainingBudget = initialSummary.pendingCount
  let settings: AppSettings | undefined
  let afterKey: string | undefined

  while (remainingBudget > 0) {
    const page = await ipc.listPendingBabyInfo({
      familyId: options.familyId,
      limit: Math.min(PENDING_PAGE_SIZE, remainingBudget),
      afterKey,
    })
    options.assertCurrent?.()
    if (page.items.length === 0) break

    const acknowledgements: string[] = []
    for (const mutation of page.items) {
      if (await uploadAndReadBack(mutation, options)) {
        acknowledgements.push(getBabyInfoMutationKey(mutation))
      }
    }
    if (acknowledgements.length > 0) {
      const committed = await ipc.commitBabyInfo({
        kind: 'reconcile',
        familyId: options.familyId,
        discoveredMutations: [],
        exactAcknowledgedMutationKeys: acknowledgements,
      })
      options.assertCurrent?.()
      settings = committed.settings
    }
    remainingBudget -= page.items.length
    afterKey = getBabyInfoMutationKey(page.items[page.items.length - 1])
  }

  options.assertCurrent?.()
  const summary = await ipc.getBabyInfoSummary(options.familyId)
  options.assertCurrent?.()
  return {
    summary,
    settings,
  }
}

/**
 * Imports strict cloud originals page-by-page, uploads bounded journal deltas,
 * and updates the pair-only compatibility projection only after all active
 * originals have exact read-back acknowledgement.
 */
export async function reconcileFamilyBabyInfo(
  options: ReconcileBabyInfoOptions,
): Promise<ReconcileBabyInfoResult> {
  const familyId = assertFamilyId(options.familyId)
  options.assertCurrent?.()
  const initialSettings = await ipc.getSettings()
  options.assertCurrent?.()
  if (initialSettings.familyId && initialSettings.familyId !== familyId) {
    throw new Error('baby info family mismatch')
  }

  const writerUid = initialSettings.profile.uid ?? ''

  let latestSettings = initialSettings
  const cloudSettings = await ingestCloudPages(options)
  options.assertCurrent?.()
  if (cloudSettings) latestSettings = cloudSettings

  let summary = await ipc.getBabyInfoSummary(familyId)
  options.assertCurrent?.()
  const legacy = await ingestLegacyProjection(options, summary, writerUid)
  options.assertCurrent?.()
  summary = legacy.summary
  if (legacy.settings) latestSettings = legacy.settings

  const uploaded = await uploadPendingPages(options, summary)
  options.assertCurrent?.()
  summary = uploaded.summary
  if (uploaded.settings) latestSettings = uploaded.settings

  let projectionNeedsRetry = false
  if (summary.winner && summary.pendingCount === 0) {
    const candidateKey = getBabyInfoMutationKey(summary.winner)
    const shouldReplace = babyInfoProjectionShouldReplace(
      candidateKey,
      summary.winner.logicalClock,
      options.familyData.babyInfoWinnerKey,
      options.familyData.babyInfoWinnerLogicalClock,
    )
    if (shouldReplace) {
      const patch = projectionPatch(summary.winner)
      if (projectionDiffers(options.familyData, patch)) {
        try {
          options.assertCurrent?.()
          await options.ops.updateDoc(options.familyRef, patch as Record<string, unknown>)
          options.assertCurrent?.()
        } catch {
          options.assertCurrent?.()
          projectionNeedsRetry = true
        }
      }
    }
  }

  const pendingCount = summary.totalPendingCount + (projectionNeedsRetry ? 1 : 0)
  const activePendingCount = summary.pendingCount + (projectionNeedsRetry ? 1 : 0)
  const needsRetry = activePendingCount > 0
  persistenceObserver?.(pendingCount, needsRetry)

  return {
    pendingCount,
    activePendingCount,
    needsRetry,
    uploadFailures: summary.pendingCount,
    settings: latestSettings,
    legacyClientUpdateRequired: writerUid.length > 0 && legacy.legacyDetected,
  }
}
