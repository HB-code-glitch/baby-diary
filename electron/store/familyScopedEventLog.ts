import type { DiaryEvent } from '../../shared/types'
import { resolveLatestEvent } from '../../shared/eventResolver'
import { isKnownV038UpgradeFixtureEvent } from '../../shared/knownV038UpgradeFixtureEvent'
import type { EventLog } from './eventLog'
import type {
  EventFamilyAdoptionResult,
  EventFamilyOwnership,
} from './eventFamilyOwnership'

export class FamilyScopedEventLog {
  constructor(
    private readonly eventLog: EventLog,
    private readonly ownership: EventFamilyOwnership,
  ) {}

  append(event: DiaryEvent, currentFamilyId: string, expectedFamilyId?: string): 'ok' | 'duplicate' | 'error' {
    if (expectedFamilyId !== undefined && expectedFamilyId !== currentFamilyId) return 'error'
    if (isKnownV038UpgradeFixtureEvent(event)) return 'error'

    if (currentFamilyId) {
      // Ownership is fsynced first. A process stop can leave a harmless dangling
      // binding, but can never leave a new family-linked event unbound and thus
      // eligible for adoption by a different family on restart.
      const binding = this.ownership.bind(event, currentFamilyId)
      if (binding !== 'ok' && binding !== 'duplicate') return 'error'
    } else if (this.ownership.familyOf(event) !== undefined) {
      return 'error'
    }

    return this.eventLog.append(event)
  }

  listMutations(familyId: string): DiaryEvent[] {
    const mutations = this.eventLog.getAllMutations()
    return familyId
      ? this.ownership.filterMutations(mutations, familyId)
      : this.ownership.filterUnboundMutations(mutations)
  }

  listVisible(familyId: string): DiaryEvent[] {
    const groups = new Map<string, DiaryEvent[]>()
    for (const event of this.listMutations(familyId)) {
      const group = groups.get(event.id)
      if (group) group.push(event)
      else groups.set(event.id, [event])
    }
    return Array.from(groups.values())
      .map(events => resolveLatestEvent(events))
      .filter((event): event is DiaryEvent => event !== undefined)
  }

  allPhysicalMutations(): DiaryEvent[] {
    return this.eventLog.getAllMutations()
  }

  confirmFamily(
    familyId: string,
    currentFamilyId: string,
    allowLegacyAdoption = true,
  ): EventFamilyAdoptionResult {
    if (!familyId || familyId !== currentFamilyId) return { status: 'error', adoptedCount: 0 }
    if (!allowLegacyAdoption) return { status: 'ok', adoptedCount: 0 }
    return this.ownership.confirmAndAdopt(familyId, this.eventLog.getAllMutations())
  }
}
