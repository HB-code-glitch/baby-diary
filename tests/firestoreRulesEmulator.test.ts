import { afterAll, describe, expect, it } from 'vitest'
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  inMemoryPersistence,
  initializeAuth,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  serverTimestamp,
  setDoc,
  terminate,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore'
import { INVITE_CODE_ALPHABET } from '../shared/inviteCode'
import type { BabyInfoMutation } from '../shared/types'

const PROJECT_ID = 'demo-baby-diary'
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST
const emulatorAvailable = Boolean(firestoreHost && authHost)
const CLOUD_FUTURE_SKEW_MS = 5 * 60 * 1000

interface TestClient {
  app: FirebaseApp
  auth: Auth
  db: Firestore
  user: User
}

interface TestFamily {
  id: string
  code: string
  owner: TestClient
}

const clients: TestClient[] = []
let sequence = 0

function parseHost(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(':')
  if (separator < 1) throw new Error(`invalid emulator host: ${value}`)
  const port = Number(value.slice(separator + 1))
  if (!Number.isSafeInteger(port) || port < 1) throw new Error(`invalid emulator port: ${value}`)
  return { host: value.slice(0, separator), port }
}

function nextInviteCode(): string {
  let value = sequence + 1
  let code = ''
  for (let index = 0; index < 6; index += 1) {
    code += INVITE_CODE_ALPHABET[value % INVITE_CODE_ALPHABET.length]
    value = Math.floor(value / INVITE_CODE_ALPHABET.length)
  }
  return code
}

function uuidFor(index: number, version: 4 | 5 = 4): string {
  return `00000000-0000-${version}000-8000-${index.toString(16).padStart(12, '0')}`
}

async function createClient(label: string): Promise<TestClient> {
  sequence += 1
  const app = initializeApp({
    apiKey: 'fake-api-key',
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  }, `rules-${label}-${sequence}`)
  const auth = initializeAuth(app, { persistence: inMemoryPersistence })
  connectAuthEmulator(auth, `http://${authHost!}`, { disableWarnings: true })
  const firestore = initializeFirestore(app, { experimentalForceLongPolling: true })
  const parsedFirestoreHost = parseHost(firestoreHost!)
  connectFirestoreEmulator(firestore, parsedFirestoreHost.host, parsedFirestoreHost.port)
  const credential = await createUserWithEmailAndPassword(
    auth,
    `rules-${label}-${sequence}@example.test`,
    'rules-test-password',
  )
  const client = { app, auth, db: firestore, user: credential.user }
  clients.push(client)
  return client
}

async function expectAllowed(operation: () => Promise<unknown>): Promise<void> {
  await operation()
}

async function expectDenied(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe('permission-denied')
    return
  }
  throw new Error('expected Firestore rules to deny the operation')
}

function familyData(owner: TestClient, code: string) {
  return {
    name: 'Family',
    babyName: 'Baby',
    babyBirthdate: '2026-01-02',
    members: {
      [owner.user.uid]: { name: 'Owner', role: 'mom' },
    },
    inviteCode: code,
    createdAt: serverTimestamp(),
  }
}

async function createFamily(label: string, idValue?: string): Promise<TestFamily> {
  const owner = await createClient(`${label}-owner`)
  const id = idValue ?? `family-${label}-${sequence}`
  const code = nextInviteCode()
  const batch = writeBatch(owner.db)
  batch.set(doc(owner.db, 'families', id), familyData(owner, code))
  batch.set(doc(owner.db, 'invites', code), {
    familyId: id,
    code_check: code,
    createdAt: serverTimestamp(),
  })
  batch.set(doc(owner.db, 'users', owner.user.uid), { familyId: id })
  await batch.commit()
  return { id, code, owner }
}

function proofRef(client: TestClient, code: string) {
  return doc(client.db, 'joinProofs', client.user.uid, 'capabilities', code)
}

async function joinFamily(client: TestClient, family: TestFamily): Promise<void> {
  const batch = writeBatch(client.db)
  batch.set(proofRef(client, family.code), {
    uid: client.user.uid,
    familyId: family.id,
    inviteCode: family.code,
  })
  batch.update(doc(client.db, 'families', family.id), {
    [`members.${client.user.uid}`]: { name: 'Joining parent', role: 'dad' },
  })
  batch.set(doc(client.db, 'users', client.user.uid), { familyId: family.id })
  await batch.commit()
}

function eventSync(id: string, at: string, createdAt = at, updatedAt = at) {
  return {
    version: 1,
    encodedEventId: encodeURIComponent(id),
    eventAtMs: Date.parse(at),
    createdAtMs: Date.parse(createdAt),
    updatedAtMs: Date.parse(updatedAt),
  }
}

function validEvent(client: TestClient, index = sequence) {
  const now = new Date(Date.now() - 60_000).toISOString()
  const clock = Date.parse(now)
  const id = `event-${index}`
  const mutationId = uuidFor(index + 100, 4)
  const contentId = uuidFor(index + 200, 5)
  const event = {
    id,
    mutationId,
    type: 'temp',
    at: now,
    data: { celsius: 38.5 },
    author: { uid: client.user.uid, name: 'Parent', role: 'mom' },
    createdAt: now,
    updatedAt: now,
    rev: clock,
    deleted: false,
    sync: eventSync(id, now),
  }
  return { event, docId: `m3|${id}|${clock}|${mutationId}|${contentId}` }
}

function validBabyMutation(
  client: TestClient,
  familyId: string,
  index = sequence,
): { docId: string; contentId: string; mutation: BabyInfoMutation } {
  const updatedAtMs = Date.now() - 60_000
  const mutationId = uuidFor(index + 300, 4)
  const contentId = uuidFor(index + 400, 5)
  return {
    docId: `b1|${mutationId}|${contentId}`,
    contentId,
    mutation: {
      mutationId,
      familyId,
      babyName: 'Updated baby',
      babyBirthdate: '2026-02-03',
      logicalClock: updatedAtMs,
      updatedAt: new Date(updatedAtMs).toISOString(),
      updatedAtMs,
      authorId: client.user.uid,
      origin: 'user',
    },
  }
}

function babyProjectionPatch(entry: { docId: string; contentId: string; mutation: BabyInfoMutation }) {
  return {
    babyName: entry.mutation.babyName,
    babyBirthdate: entry.mutation.babyBirthdate,
    babyInfoWinnerKey: `baby-info:${entry.mutation.mutationId}:${entry.contentId}`,
    babyInfoWinnerMutationId: entry.mutation.mutationId,
    babyInfoWinnerLogicalClock: entry.mutation.logicalClock,
    babyInfoWinnerUpdatedAt: entry.mutation.updatedAt,
    babyInfoWinnerAuthorId: entry.mutation.authorId,
    babyInfoWinnerOrigin: entry.mutation.origin,
  }
}

describe.skipIf(!emulatorAvailable)('Firestore security rules in the real emulator', () => {
  afterAll(async () => {
    await Promise.all(clients.map(async client => {
      await terminate(client.db).catch(() => undefined)
      await deleteApp(client.app).catch(() => undefined)
    }))
  })

  it('requires atomic family + invite + exact own user identity and supports legacy Unicode ids', async () => {
    const unicodeId = `가족 기록 ${sequence}`
    const family = await createFamily('unicode', unicodeId)
    expect((await getDoc(doc(family.owner.db, 'users', family.owner.user.uid))).data()).toEqual({ familyId: unicodeId })

    const outsider = await createClient('atomic-negative')
    const code = nextInviteCode()
    const missingUserBatch = writeBatch(outsider.db)
    missingUserBatch.set(doc(outsider.db, 'families', 'missing-user-family'), familyData(outsider, code))
    missingUserBatch.set(doc(outsider.db, 'invites', code), {
      familyId: 'missing-user-family', code_check: code, createdAt: serverTimestamp(),
    })
    await expectDenied(() => missingUserBatch.commit())

    await expectDenied(() => setDoc(doc(outsider.db, 'users', outsider.user.uid), {
      familyId: family.id,
      admin: true,
    }))
    await expectDenied(() => setDoc(doc(outsider.db, 'users', family.owner.user.uid), {
      familyId: family.id,
    }))
  })

  it('uses a private deterministic per-code proof and permits response-loss retry and a second family', async () => {
    const first = await createFamily('join-a')
    const second = await createFamily('join-b')
    const member = await createClient('join-member')

    await expectAllowed(() => joinFamily(member, first))
    await expectAllowed(() => joinFamily(member, first))
    await expectAllowed(() => joinFamily(member, second))
    expect((await getDoc(doc(member.db, 'users', member.user.uid))).data()).toEqual({ familyId: second.id })

    await expectDenied(() => getDoc(proofRef(member, first.code)))
    await expectDenied(() => getDocs(collection(member.db, 'joinProofs', member.user.uid, 'capabilities')))
    await expectDenied(() => deleteDoc(proofRef(member, first.code)))
    await expectDenied(() => updateDoc(proofRef(member, first.code), { familyId: second.id }))

    const attacker = await createClient('join-attacker')
    const forged = writeBatch(attacker.db)
    forged.set(proofRef(attacker, first.code), {
      uid: attacker.user.uid,
      familyId: first.id,
      inviteCode: second.code,
    })
    forged.update(doc(attacker.db, 'families', first.id), {
      [`members.${attacker.user.uid}`]: { name: 'Attacker', role: 'dad' },
    })
    forged.set(doc(attacker.db, 'users', attacker.user.uid), { familyId: first.id })
    await expectDenied(() => forged.commit())
  })

  it('denies family/invite discovery and protects every field except own profile and approved baby paths', async () => {
    const family = await createFamily('family-update')
    const outsider = await createClient('family-outsider')
    await expectAllowed(() => getDoc(doc(outsider.db, 'invites', family.code)))
    await expectDenied(() => getDocs(collection(outsider.db, 'invites')))
    await expectDenied(() => getDoc(doc(outsider.db, 'families', family.id)))
    await expectDenied(() => getDocs(collection(outsider.db, 'families')))

    const ref = doc(family.owner.db, 'families', family.id)
    await expectAllowed(() => updateDoc(ref, {
      [`members.${family.owner.user.uid}`]: { name: 'Renamed', role: 'dad' },
    }))
    await expectDenied(() => updateDoc(ref, { inviteCode: nextInviteCode() }))
    await expectDenied(() => updateDoc(ref, { name: 'Replaced family' }))
    await expectDenied(() => updateDoc(ref, {
      [`members.${family.owner.user.uid}`]: deleteField(),
    }))
  })

  it('denies a member overwriting a co-member\'s entry, adding an unproven member, or replacing the whole map', async () => {
    const family = await createFamily('member-overwrite')
    const secondMember = await createClient('member-overwrite-second')
    await joinFamily(secondMember, family)
    const ref = doc(family.owner.db, 'families', family.id)

    // The owner may still rename only their own entry ...
    await expectAllowed(() => updateDoc(ref, {
      [`members.${family.owner.user.uid}`]: { name: 'Owner renamed', role: 'mom' },
    }))
    // ... but may never overwrite the co-member's entry, ...
    await expectDenied(() => updateDoc(ref, {
      [`members.${secondMember.user.uid}`]: { name: 'Hijacked', role: 'dad' },
    }))
    // ... rewrite the whole members map in one update, ...
    await expectDenied(() => updateDoc(ref, {
      members: {
        [family.owner.user.uid]: { name: 'Owner', role: 'mom' },
        [secondMember.user.uid]: { name: 'Hijacked', role: 'dad' },
      },
    }))
    // ... or add a third uid without a matching joinProof, even alongside their own field.
    const outsider = await createClient('member-overwrite-outsider')
    await expectDenied(() => updateDoc(ref, {
      [`members.${family.owner.user.uid}`]: { name: 'Owner', role: 'mom' },
      [`members.${outsider.user.uid}`]: { name: 'Unproven', role: 'dad' },
    }))
  })

  it('rejects the exact v0.3.8 baby pair-only direct write now that hardened rules require proof fields', async () => {
    // Chosen rollout policy: a bare pair-only write (no babyInfoMutations
    // proof) is rejected outright. A v0.3.9 client bridges any pre-existing
    // production data of this shape through an auth-bound babyInfoMutations
    // derivative instead (see the "enforces immutable bounded baby
    // mutations..." test below), never through this direct family-doc path.
    const family = await createFamily('pair-only')
    const ref = doc(family.owner.db, 'families', family.id)
    await expectDenied(() => updateDoc(ref, {
      babyName: 'Old client baby',
      babyBirthdate: '2026-03-04',
    }))
    await expectDenied(() => updateDoc(ref, { babyName: 'One field only' }))
    await expectDenied(() => updateDoc(ref, {
      babyName: 'Pair plus extra',
      babyBirthdate: '2026-03-05',
      name: 'Injected',
    }))

    const outsider = await createClient('pair-outsider')
    await expectDenied(() => updateDoc(doc(outsider.db, 'families', family.id), {
      babyName: 'Not a member',
      babyBirthdate: '2026-03-06',
    }))
  })

  it('enforces immutable bounded baby mutations, auth writer binding, and exact projection', async () => {
    const family = await createFamily('baby-info')
    const value = validBabyMutation(family.owner, family.id)
    const mutationRef = doc(family.owner.db, 'families', family.id, 'babyInfoMutations', value.docId)
    await expectAllowed(() => setDoc(mutationRef, { mutation: value.mutation }))
    const derivative = validBabyMutation(family.owner, family.id, sequence + 50)
    derivative.mutation.migration = {
      version: 1,
      kind: 'legacy-cloud-boundary-v1',
      sourceMutationKey: `baby-info:${value.mutation.mutationId}:${value.contentId}`,
    }
    await expectAllowed(() => setDoc(doc(
      family.owner.db, 'families', family.id, 'babyInfoMutations', derivative.docId,
    ), { mutation: derivative.mutation }))
    await expectAllowed(() => updateDoc(doc(family.owner.db, 'families', family.id), {
      babyName: value.mutation.babyName,
      babyBirthdate: value.mutation.babyBirthdate,
      babyInfoWinnerKey: `baby-info:${value.mutation.mutationId}:${value.contentId}`,
      babyInfoWinnerMutationId: value.mutation.mutationId,
      babyInfoWinnerLogicalClock: value.mutation.logicalClock,
      babyInfoWinnerUpdatedAt: value.mutation.updatedAt,
      babyInfoWinnerAuthorId: value.mutation.authorId,
      babyInfoWinnerOrigin: value.mutation.origin,
    }))
    await expectDenied(() => updateDoc(mutationRef, { 'mutation.babyName': 'Overwrite' }))
    await expectDenied(() => deleteDoc(mutationRef))

    const forged = validBabyMutation(family.owner, family.id, sequence + 1)
    forged.mutation.authorId = 'another-real-uid'
    await expectDenied(() => setDoc(doc(
      family.owner.db, 'families', family.id, 'babyInfoMutations', forged.docId,
    ), { mutation: forged.mutation }))

    const malformedMigration = validBabyMutation(family.owner, family.id, sequence + 51)
    malformedMigration.mutation.migration = {
      version: 1,
      kind: 'legacy-cloud-boundary-v1',
      sourceMutationKey: 'not-a-mutation-key',
    }
    await expectDenied(() => setDoc(doc(
      family.owner.db, 'families', family.id, 'babyInfoMutations', malformedMigration.docId,
    ), { mutation: malformedMigration.mutation }))

    const poisoned = validBabyMutation(family.owner, family.id, sequence + 2)
    poisoned.mutation.logicalClock = Date.now() + CLOUD_FUTURE_SKEW_MS + 60_000
    await expectDenied(() => setDoc(doc(
      family.owner.db, 'families', family.id, 'babyInfoMutations', poisoned.docId,
    ), { mutation: poisoned.mutation }))

    const future = validBabyMutation(family.owner, family.id, sequence + 3)
    future.mutation.updatedAtMs = Date.now() + CLOUD_FUTURE_SKEW_MS + 60_000
    future.mutation.updatedAt = new Date(future.mutation.updatedAtMs).toISOString()
    await expectDenied(() => setDoc(doc(
      family.owner.db, 'families', family.id, 'babyInfoMutations', future.docId,
    ), { mutation: future.mutation }))
  })

  it('denies a baby mutation whose docId mutationId segment does not match its content mutationId field', async () => {
    const family = await createFamily('baby-forged-id')
    const value = validBabyMutation(family.owner, family.id, sequence + 4)
    const forgedDocId = `b1|${uuidFor(sequence + 5, 4)}|${value.contentId}`
    await expectDenied(() => setDoc(
      doc(family.owner.db, 'families', family.id, 'babyInfoMutations', forgedDocId),
      { mutation: value.mutation },
    ))
  })

  it('never lets a stale lower-clock projection replace an already-committed winner', async () => {
    const family = await createFamily('baby-projection-monotonic')
    const ref = doc(family.owner.db, 'families', family.id)

    const high = validBabyMutation(family.owner, family.id, sequence + 60)
    high.mutation.logicalClock = Date.now() - 60_000
    await expectAllowed(() => setDoc(
      doc(family.owner.db, 'families', family.id, 'babyInfoMutations', high.docId),
      { mutation: high.mutation },
    ))
    await expectAllowed(() => updateDoc(ref, babyProjectionPatch(high)))

    const low = validBabyMutation(family.owner, family.id, sequence + 61)
    low.mutation.logicalClock = high.mutation.logicalClock - 1_000
    await expectAllowed(() => setDoc(
      doc(family.owner.db, 'families', family.id, 'babyInfoMutations', low.docId),
      { mutation: low.mutation },
    ))
    await expectDenied(() => updateDoc(ref, babyProjectionPatch(low)))

    const higher = validBabyMutation(family.owner, family.id, sequence + 62)
    higher.mutation.logicalClock = high.mutation.logicalClock + 1_000
    await expectAllowed(() => setDoc(
      doc(family.owner.db, 'families', family.id, 'babyInfoMutations', higher.docId),
      { mutation: higher.mutation },
    ))
    await expectAllowed(() => updateDoc(ref, babyProjectionPatch(higher)))
  })

  it('resolves an equal-clock projection race to the same deterministic key winner regardless of commit order', async () => {
    const family = await createFamily('baby-projection-tie')
    const ref = doc(family.owner.db, 'families', family.id)
    const clock = Date.now() - 60_000

    const a = validBabyMutation(family.owner, family.id, sequence + 70)
    a.mutation.logicalClock = clock
    const b = validBabyMutation(family.owner, family.id, sequence + 71)
    b.mutation.logicalClock = clock
    const keyA = `baby-info:${a.mutation.mutationId}:${a.contentId}`
    const keyB = `baby-info:${b.mutation.mutationId}:${b.contentId}`
    const [loser, winner] = keyA < keyB ? [a, b] : [b, a]

    for (const entry of [loser, winner]) {
      await expectAllowed(() => setDoc(
        doc(family.owner.db, 'families', family.id, 'babyInfoMutations', entry.docId),
        { mutation: entry.mutation },
      ))
    }

    // Whichever order the winner and its equal-clock rival are committed in,
    // only the deterministically larger key may end up projected.
    await expectAllowed(() => updateDoc(ref, babyProjectionPatch(loser)))
    await expectAllowed(() => updateDoc(ref, babyProjectionPatch(winner)))
    await expectDenied(() => updateDoc(ref, babyProjectionPatch(loser)))
  })

  it('accepts all nine exact event schemas and safely evaluates modern and missing-mutation legacy ids', async () => {
    const family = await createFamily('events')
    const eventsPath = ['families', family.id, 'events'] as const
    const payloads = [
      ['pee', {}],
      ['poop', { note: 'normal' }],
      ['temp', { celsius: 38.5 }],
      ['breast', { side: 'both', minutes: 240 }],
      ['formula', { ml: 120 }],
      ['sleep', { minutes: 960 }],
      ['growth', { weightKg: 7.2, heightCm: 68.5 }],
      ['diary', { title: '', text: 'A diary record' }],
      ['message', { text: 'A message' }],
    ] as const

    const batch = writeBatch(family.owner.db)
    for (let index = 0; index < payloads.length; index += 1) {
      const value = validEvent(family.owner, sequence + index + 1)
      value.event.type = payloads[index][0]
      value.event.data = payloads[index][1]
      batch.set(doc(family.owner.db, ...eventsPath, value.docId), { event: value.event })
    }
    await expectAllowed(() => batch.commit())

    const legacyValue = validEvent(family.owner, sequence + 20)
    const legacyEvent = { ...legacyValue.event } as Record<string, unknown>
    delete legacyEvent.mutationId
    await expectAllowed(() => setDoc(doc(
      family.owner.db, ...eventsPath, `${legacyValue.event.id}_${legacyValue.event.rev}`,
    ), { event: legacyEvent }))

    const modern = validEvent(family.owner, sequence + 21)
    await expectDenied(() => setDoc(doc(family.owner.db, ...eventsPath, modern.docId), {
      event: { ...modern.event, author: { ...modern.event.author, uid: 'another-real-uid' } },
    }))
    await expectDenied(() => setDoc(doc(family.owner.db, ...eventsPath, modern.docId), {
      event: modern.event,
      writerUid: family.owner.user.uid,
    }))
  })

  it('rejects malformed event data, timestamp/revision poison, mutation-id mismatch and outsiders', async () => {
    const family = await createFamily('event-negative')
    const outsider = await createClient('event-negative-outsider')
    const eventsPath = ['families', family.id, 'events'] as const
    const value = validEvent(family.owner, sequence + 30)

    await expectDenied(() => setDoc(doc(family.owner.db, ...eventsPath, value.docId), {
      event: { ...value.event, data: { celsius: Number.POSITIVE_INFINITY } },
    }))
    await expectDenied(() => setDoc(doc(family.owner.db, ...eventsPath, value.docId), {
      event: { ...value.event, data: { celsius: 38, unit: 'C' } },
    }))

    const futureMs = Date.now() + CLOUD_FUTURE_SKEW_MS + 60_000
    const futureIso = new Date(futureMs).toISOString()
    const future = {
      ...value.event,
      at: futureIso,
      createdAt: futureIso,
      updatedAt: futureIso,
      sync: eventSync(value.event.id, futureIso),
    }
    await expectDenied(() => setDoc(doc(family.owner.db, ...eventsPath, value.docId), { event: future }))

    const poison = {
      ...value.event,
      rev: Date.now() + CLOUD_FUTURE_SKEW_MS + 60_000,
    }
    const poisonId = `m3|${poison.id}|${poison.rev}|${poison.mutationId}|${uuidFor(sequence + 900, 5)}`
    await expectDenied(() => setDoc(doc(family.owner.db, ...eventsPath, poisonId), { event: poison }))
    await expectDenied(() => setDoc(doc(
      family.owner.db, ...eventsPath,
      `m3|other-id|1|${value.event.mutationId}|${uuidFor(sequence + 901, 5)}`,
    ), { event: value.event }))
    await expectDenied(() => getDoc(doc(outsider.db, ...eventsPath, value.docId)))
  })
})
