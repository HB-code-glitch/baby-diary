import { describe, expect, it, vi } from 'vitest'
import type { DiaryEvent } from '../shared/types'
import * as upgradeContract from '../scripts/upgrade-data-contract.mjs'
import {
  deriveAuthBoundEvent,
  ensureEventMutationIdentity,
} from '../shared/eventResolver'

interface KnownFixtureClassifierModule {
  isKnownV038UpgradeFixtureEvent?: (event: unknown) => boolean
}

async function loadClassifier(): Promise<KnownFixtureClassifierModule> {
  return vi.importActual<KnownFixtureClassifierModule>('../shared/knownV038UpgradeFixtureEvent')
    .catch(() => ({}))
}

function fixtureEvents(): DiaryEvent[] {
  return upgradeContract.buildV038Fixture().events as DiaryEvent[]
}

describe('v0.3.8 upgrade fixture event quarantine classifier', () => {
  it('recognizes every exact raw fixture mutation and its exact auth-bound derivative', async () => {
    const { isKnownV038UpgradeFixtureEvent } = await loadClassifier()
    expect(isKnownV038UpgradeFixtureEvent).toBeTypeOf('function')
    if (!isKnownV038UpgradeFixtureEvent) return

    const events = fixtureEvents()
    expect(events).toHaveLength(11)
    for (const event of events) {
      expect(isKnownV038UpgradeFixtureEvent(event)).toBe(true)
      expect(isKnownV038UpgradeFixtureEvent(deriveAuthBoundEvent(event, 'current-auth-user'))).toBe(true)
      expect(isKnownV038UpgradeFixtureEvent(deriveAuthBoundEvent(event, 'other-auth-user'))).toBe(true)
    }
  })

  it('rejects identified-only projections, payload near-misses, forged derivatives, and malformed values', async () => {
    const { isKnownV038UpgradeFixtureEvent } = await loadClassifier()
    expect(isKnownV038UpgradeFixtureEvent).toBeTypeOf('function')
    if (!isKnownV038UpgradeFixtureEvent) return

    const raw = fixtureEvents().find(event => event.id === 'legacy-temp')!
    const derivative = deriveAuthBoundEvent(raw, 'current-auth-user')
    const changedRaw: DiaryEvent = {
      ...raw,
      data: { ...raw.data, note: '실제 사용자 기록' },
    }
    const forgedDerivative: DiaryEvent = {
      ...derivative,
      data: { ...derivative.data, celsius: 37.3 },
    }

    expect(isKnownV038UpgradeFixtureEvent(ensureEventMutationIdentity(raw))).toBe(false)
    expect(isKnownV038UpgradeFixtureEvent(changedRaw)).toBe(false)
    expect(isKnownV038UpgradeFixtureEvent(forgedDerivative)).toBe(false)
    expect(isKnownV038UpgradeFixtureEvent({ id: 'legacy-temp' })).toBe(false)
    expect(isKnownV038UpgradeFixtureEvent(null)).toBe(false)
  })
})
