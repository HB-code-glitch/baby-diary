import type { DiaryEvent } from './types'
import {
  getEventContentId,
  isExactAuthBoundDerivative,
  validateDiaryEvent,
} from './eventResolver'

interface RawFixtureIdentity {
  readonly authorUid: string
  readonly rev: number
}

/**
 * Content-derived identities of the exact synthetic records used by the
 * published v0.3.8 in-place-upgrade gate. The gate itself lives in scripts/;
 * production code deliberately carries only these immutable fingerprints.
 */
const RAW_FIXTURE_IDENTITIES = new Map<string, RawFixtureIdentity>([
  ['8c4014b0-dd99-5c84-8266-c40720898674', { authorUid: 'account-dad-v038', rev: 1 }],
  ['500975a6-c256-5320-84b9-b1ce44c1e086', { authorUid: 'account-mom-v038', rev: 1 }],
  ['6891f32e-b601-5e47-981f-c8d503ed510f', { authorUid: 'account-dad-v038', rev: 1 }],
  ['eda52b47-7321-5cea-aa16-c3d8d0268438', { authorUid: 'account-mom-v038', rev: 1 }],
  ['aaa337dd-fe38-5721-a5f3-5fb3c1d9843c', { authorUid: 'account-dad-v038', rev: 1 }],
  ['1e6e3fe0-4460-5bda-bf53-6e1eae8017e2', { authorUid: 'account-dad-v038', rev: 2 }],
  ['bf07a5e9-f5f0-5a6f-b919-55d9754588b7', { authorUid: 'account-mom-v038', rev: 1 }],
  ['01f65e49-7d76-580f-a222-c3f05cd42c49', { authorUid: 'account-mom-v038', rev: 2 }],
  ['5e886a47-93e8-54fc-814c-b65db0d72899', { authorUid: 'account-dad-v038', rev: 1 }],
  ['b44dde9f-cb88-509b-b4f7-ae70245b3edc', { authorUid: 'account-mom-v038', rev: 1 }],
  ['18e10478-adfc-5ddb-a5fb-0dc7582cad54', { authorUid: 'account-dad-v038', rev: 1 }],
])

function reconstructRawFixtureSource(
  event: DiaryEvent,
  identity: RawFixtureIdentity,
): DiaryEvent {
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    data: event.data,
    author: {
      ...event.author,
      uid: identity.authorUid,
    },
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    rev: identity.rev,
    deleted: event.deleted,
  }
}

/**
 * Matches only the exact raw upgrade fixture mutations or the exact immutable
 * auth-bound derivatives produced from those raw bytes. Near-matches remain
 * ordinary user data. This function never deletes or mutates the candidate.
 */
export function isKnownV038UpgradeFixtureEvent(value: unknown): boolean {
  if (validateDiaryEvent(value) !== null) return false
  const event = value as DiaryEvent

  if (event.migration === undefined) {
    if (event.mutationId !== undefined || event.sync !== undefined) return false
    try {
      return RAW_FIXTURE_IDENTITIES.has(getEventContentId(event))
    } catch {
      return false
    }
  }

  if (event.migration.kind !== 'legacy-author-v1') return false
  const identity = RAW_FIXTURE_IDENTITIES.get(event.migration.sourceContentId)
  if (!identity) return false

  try {
    const rawSource = reconstructRawFixtureSource(event, identity)
    return getEventContentId(rawSource) === event.migration.sourceContentId
      && isExactAuthBoundDerivative(event, rawSource)
  } catch {
    return false
  }
}
