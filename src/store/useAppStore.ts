import { create } from 'zustand'
import { DiaryEvent, AppSettings, DataInfo, EventType, BreastData, FormulaData, SleepData, GrowthData } from '../../shared/types'
import { ipc } from '../lib/ipc'
import { enqueue, persistSettingsWithBabyInfoMutation } from '../sync/syncEngine'
import type { BabyInfoPersistenceResult } from '../sync/babyInfoSync'
import { v4 as uuidv4 } from 'uuid'
import { format, isToday, parseISO, startOfDay, isSameDay } from 'date-fns'
import i18n from '../i18n'
import { isEventAtOrBefore, sortEventsNewestFirst } from '../lib/eventTime'
import { mergeResolvedEvent } from '../../shared/eventResolver'
import { createEventSyncMetadata } from '../../shared/cloudEventPayload'
import { nextHybridLogicalClock } from '../../shared/hybridLogicalClock'
import { isKnownV038UpgradeFixtureEvent } from '../../shared/knownV038UpgradeFixtureEvent'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() { return new Date().toISOString() }

let settingsBridgeUnsubscribe: (() => void) | undefined
let settingsBridgeGeneration = 0
let lastSettingsSequence = 0
let settingsBroadcastEpoch = 0
let eventBridgeUnsubscribe: (() => void) | undefined
let eventScopeBridgeUnsubscribe: (() => void) | undefined
let eventBridgeGeneration = 0
let eventViewReloadEpoch = 0
let activeEventViewReload: Promise<void> | undefined
let familyEventViewEpoch = 0
const eventViewOwnership = new WeakMap<DiaryEvent, { familyId: string; epoch: number }>()

function markEventsForFamilyView(
  events: DiaryEvent[],
  familyId: string,
  epoch: number,
): DiaryEvent[] {
  for (const event of events) eventViewOwnership.set(event, { familyId, epoch })
  return events
}

export function disposeAppStoreSettingsBridge(): void {
  settingsBridgeGeneration += 1
  settingsBridgeUnsubscribe?.()
  settingsBridgeUnsubscribe = undefined
  lastSettingsSequence = 0
}

export function disposeAppStoreEventBridge(): void {
  eventBridgeGeneration += 1
  eventViewReloadEpoch += 1
  familyEventViewEpoch += 1
  eventBridgeUnsubscribe?.()
  eventBridgeUnsubscribe = undefined
  eventScopeBridgeUnsubscribe?.()
  eventScopeBridgeUnsubscribe = undefined
}

async function reloadCurrentFamilyEvents(expectedFamilyId: string, clearFirst: boolean): Promise<void> {
  const epoch = ++eventViewReloadEpoch
  const familyEpoch = familyEventViewEpoch
  if (clearFirst) useAppStore.setState({ events: [] })
  try {
    const listed = await ipc.listEvents(expectedFamilyId)
    const state = useAppStore.getState()
    if (epoch !== eventViewReloadEpoch
      || familyEpoch !== familyEventViewEpoch
      || state.settings?.familyId !== expectedFamilyId) return
    useAppStore.setState(current => {
      const events = [...listed, ...current.events].reduce<DiaryEvent[]>(mergeEventIntoList, [])
      return { events: markEventsForFamilyView(events, expectedFamilyId, familyEpoch) }
    })
  } catch (error) {
    if (epoch === eventViewReloadEpoch
      && useAppStore.getState().settings?.familyId === expectedFamilyId) {
      useAppStore.setState({ error: String(error) })
    }
  }
}

function requestCurrentFamilyEventReload(expectedFamilyId: string, clearFirst: boolean): void {
  const operation = reloadCurrentFamilyEvents(expectedFamilyId, clearFirst)
  activeEventViewReload = operation
  void operation.finally(() => {
    if (activeEventViewReload === operation) activeEventViewReload = undefined
  })
}

function installAppStoreSettingsBridge(): void {
  disposeAppStoreSettingsBridge()
  const generation = settingsBridgeGeneration
  settingsBridgeUnsubscribe = ipc.onSettingsChanged(payload => {
    if (generation !== settingsBridgeGeneration) return
    if (!Number.isSafeInteger(payload.sequence) || payload.sequence <= lastSettingsSequence) return
    lastSettingsSequence = payload.sequence
    settingsBroadcastEpoch += 1
    const previousFamilyId = useAppStore.getState().settings?.familyId
    const familyChanged = previousFamilyId !== payload.settings.familyId
    if (familyChanged) familyEventViewEpoch += 1
    useAppStore.setState({
      settings: payload.settings,
      ...(familyChanged ? { events: [] } : {}),
    })
    if (familyChanged) requestCurrentFamilyEventReload(payload.settings.familyId, false)
  })
}

function makeBase(settings: AppSettings | null, type: DiaryEvent['type']): DiaryEvent {
  const t = now()
  const event: DiaryEvent = {
    id: uuidv4(),
    mutationId: uuidv4(),
    type,
    at: t,
    data: {} as DiaryEvent['data'],
    author: {
      uid:  settings?.profile?.uid  ?? 'local',
      name: settings?.profile?.name ?? '',
      role: settings?.profile?.role ?? 'mom',
    },
    createdAt: t,
    updatedAt: t,
    rev: nextHybridLogicalClock(0, Date.parse(t)),
    deleted: false,
  }
  return { ...event, sync: createEventSyncMetadata(event) }
}

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

interface AppState {
  events:    DiaryEvent[]
  settings:  AppSettings | null
  isLoading: boolean
  /** P13: true once Promise.all([loadEvents, loadSettings, loadDataInfo]) resolves.
   * Gates birthdate-derived render sites (D+, milestone banners, InsightsPanel)
   * so they never render with stale/null settings while events have already loaded. */
  isReady:   boolean
  error:     string | null
  dataInfo:  DataInfo | null

  // Loaders
  loadEvents:   () => Promise<void>
  loadSettings: () => Promise<void>
  loadDataInfo: () => Promise<void>
  init:         () => Promise<void>

  // Derived selectors
  todayEvents:    () => DiaryEvent[]
  eventsForDay:   (date: Date) => DiaryEvent[]
  lastFeeding:    () => DiaryEvent | null
  todayPeeCount:  () => number
  todayPoopCount: () => number
  todayFeedingCount: () => number
  todayFormulaTotalMl: () => number

  // Mutations
  addEvent:            (event: DiaryEvent) => Promise<DiaryEvent>
  editEvent:           (original: DiaryEvent, patch: Partial<Pick<DiaryEvent, 'at' | 'data' | 'deleted'>>) => Promise<DiaryEvent>
  softDeleteEvent:     (event: DiaryEvent) => Promise<DiaryEvent>
  softDeleteAllEvents: () => Promise<{ count: number; partial: boolean }>

  // Quick-add helpers
  addPee:     (atOverride?: string) => Promise<DiaryEvent>
  addPoop:    (atOverride?: string) => Promise<DiaryEvent>
  addTemp:    (celsius: number, atOverride?: string) => Promise<DiaryEvent>
  addBreast:  (side: 'L' | 'R' | 'both', minutes?: number, atOverride?: string) => Promise<DiaryEvent>
  addFormula: (ml: number, atOverride?: string) => Promise<DiaryEvent>
  addSleep:   (minutes: number, atOverride?: string) => Promise<DiaryEvent>
  addGrowth:  (weightKg: number | undefined, heightCm: number | undefined, atOverride?: string) => Promise<DiaryEvent>
  todaySleepMinutes: () => number

  // Settings
  saveSettings: (s: AppSettings) => Promise<AppSettings>
  saveSettingsWithBabyInfoMutation: (s: AppSettings) => Promise<BabyInfoPersistenceResult>

  // External event merge (from sync)
  mergeExternalEvent: (event: DiaryEvent) => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppState>((set, get) => ({
  events:    [],
  settings:  null,
  isLoading: false,
  isReady:   false,
  error:     null,
  dataInfo:  null,

  // -----------------------------------------------------------------------
  // Loaders
  // -----------------------------------------------------------------------

  loadEvents: async () => {
    const expectedFamilyId = get().settings?.familyId ?? ''
    set({ isLoading: true, error: null })
    await reloadCurrentFamilyEvents(expectedFamilyId, false)
    if (get().settings?.familyId === expectedFamilyId) set({ isLoading: false })
  },

  loadSettings: async () => {
    const startingEpoch = settingsBroadcastEpoch
    try {
      const settings = await ipc.getSettings()
      if (startingEpoch === settingsBroadcastEpoch) set({ settings })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  loadDataInfo: async () => {
    try {
      const dataInfo = await ipc.getDataInfo()
      set({ dataInfo })
    } catch (err) {
      // not fatal
    }
  },

  init: async () => {
    installAppStoreSettingsBridge()
    disposeAppStoreEventBridge()
    const generation = eventBridgeGeneration
    const bufferedEvents: Array<{ event: DiaryEvent; familyId: string }> = []
    let initializationCommitted = false
    let scopeReloadRequested = false

    // Subscribe first. Every append that races the initial disk read is held
    // until the list result and the other startup state can commit atomically.
    eventBridgeUnsubscribe = ipc.onEventAppended((event, familyId) => {
      if (generation !== eventBridgeGeneration) return
      if (!initializationCommitted) {
        bufferedEvents.push({ event, familyId })
        return
      }
      if (familyId !== (get().settings?.familyId ?? '')) return
      get().mergeExternalEvent(event)
    })
    eventScopeBridgeUnsubscribe = ipc.onEventScopeChanged(() => {
      if (generation !== eventBridgeGeneration) return
      if (!initializationCommitted) {
        scopeReloadRequested = true
        return
      }
      requestCurrentFamilyEventReload(get().settings?.familyId ?? '', false)
    })

    const startingSettingsEpoch = settingsBroadcastEpoch
    set({ isLoading: true, isReady: false, error: null })
    const settingsOperation = ipc.getSettings().then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    )
    const dataInfoOperation = ipc.getDataInfo().then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    )
    const settingsResult = await settingsOperation
    if (generation !== eventBridgeGeneration) return

    let initialFamilyId = get().settings?.familyId ?? ''
    let initialListSettingsEpoch = settingsBroadcastEpoch
    let initialListReloadEpoch = eventViewReloadEpoch
    let initialListStarted = false
    let eventsResult: PromiseSettledResult<DiaryEvent[]>
    if (settingsResult.status === 'fulfilled' && startingSettingsEpoch === settingsBroadcastEpoch) {
      initialFamilyId = settingsResult.value.familyId
      initialListSettingsEpoch = settingsBroadcastEpoch
      initialListReloadEpoch = eventViewReloadEpoch
      initialListStarted = true
      eventsResult = await ipc.listEvents(initialFamilyId).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      )
    } else if (startingSettingsEpoch !== settingsBroadcastEpoch) {
      if (activeEventViewReload) await activeEventViewReload
      eventsResult = { status: 'fulfilled', value: get().events }
    } else {
      const reason = settingsResult.status === 'rejected'
        ? settingsResult.reason
        : new Error('settings initialization state is inconsistent')
      eventsResult = { status: 'rejected', reason }
    }
    const dataInfoResult = await dataInfoOperation
    if (generation !== eventBridgeGeneration) return

    const initialEventViewIsStale = !initialListStarted
      || initialListSettingsEpoch !== settingsBroadcastEpoch
      || initialListReloadEpoch !== eventViewReloadEpoch
    if (initialEventViewIsStale && activeEventViewReload) await activeEventViewReload
    if (generation !== eventBridgeGeneration) return

    let events = initialEventViewIsStale
      ? get().events
      : eventsResult.status === 'fulfilled'
        ? eventsResult.value.reduce<DiaryEvent[]>(mergeEventIntoList, [])
        : get().events
    const committedFamilyId = settingsResult.status === 'fulfilled'
      && startingSettingsEpoch === settingsBroadcastEpoch
      ? settingsResult.value.familyId
      : get().settings?.familyId ?? initialFamilyId
    for (const buffered of bufferedEvents) {
      if (buffered.familyId === committedFamilyId) {
        events = mergeEventIntoList(events, buffered.event)
      }
    }
    events = markEventsForFamilyView(events, committedFamilyId, familyEventViewEpoch)
    bufferedEvents.length = 0
    initializationCommitted = true

    const error = eventsResult.status === 'rejected'
      ? String(eventsResult.reason)
      : settingsResult.status === 'rejected'
        ? String(settingsResult.reason)
        : null
    const nextState: Partial<AppState> = {
      events,
      isLoading: false,
      isReady: true,
      error,
    }
    if (settingsResult.status === 'fulfilled' && startingSettingsEpoch === settingsBroadcastEpoch) {
      nextState.settings = settingsResult.value
    }
    if (dataInfoResult.status === 'fulfilled') nextState.dataInfo = dataInfoResult.value
    set(nextState)
    if (scopeReloadRequested) requestCurrentFamilyEventReload(get().settings?.familyId ?? '', false)
  },

  // -----------------------------------------------------------------------
  // Derived selectors
  // -----------------------------------------------------------------------

  // ── Timezone note (P23) ──────────────────────────────────────────────────
  // All date grouping uses device-local time via date-fns (isToday, isSameDay,
  // startOfDay, parseISO).  Both parents use UTC+9 (KST = dad/Windows, JST =
  // mom/Mac) with no DST offset, so grouping by device-local date is provably
  // consistent for this family.  If the family ever relocates to a different
  // timezone, introduce a `localDate` field on DiaryEvent (YYYY-MM-DD, stored
  // at write time in the user's local timezone) and group by that field instead.
  // ─────────────────────────────────────────────────────────────────────────
  todayEvents: () => {
    return sortEventsNewestFirst(
      get().events.filter(e => !e.deleted && isToday(parseISO(e.at))),
    )
  },

  eventsForDay: (date: Date) => {
    const day = startOfDay(date)
    return sortEventsNewestFirst(
      get().events.filter(e => !e.deleted && isSameDay(parseISO(e.at), day)),
    )
  },

  lastFeeding: () => {
    const feedings = sortEventsNewestFirst(get().events.filter(e =>
      !e.deleted
      && (e.type === 'breast' || e.type === 'formula')
      && isEventAtOrBefore(e.at, Date.now()),
    ))
    return feedings[0] ?? null
  },

  todayPeeCount: () => {
    return get().events.filter(e => !e.deleted && e.type === 'pee' && isToday(parseISO(e.at))).length
  },

  todayPoopCount: () => {
    return get().events.filter(e => !e.deleted && e.type === 'poop' && isToday(parseISO(e.at))).length
  },

  todayFeedingCount: () => {
    return get().events.filter(
      e => !e.deleted && (e.type === 'breast' || e.type === 'formula') && isToday(parseISO(e.at))
    ).length
  },

  todayFormulaTotalMl: () => {
    return get().events
      .filter(e => !e.deleted && e.type === 'formula' && isToday(parseISO(e.at)))
      .reduce((sum, e) => sum + ((e.data as FormulaData).ml ?? 0), 0)
  },

  // -----------------------------------------------------------------------
  // Core mutations
  // -----------------------------------------------------------------------

  addEvent: async (event: DiaryEvent) => {
    const identified = event.mutationId ? event : { ...event, mutationId: uuidv4() }
    const updatedAtMs = Date.parse(identified.updatedAt)
    const baseMutation: DiaryEvent = {
      ...identified,
      rev: Math.max(identified.rev, nextHybridLogicalClock(0, updatedAtMs)),
    }
    const mutation: DiaryEvent = {
      ...baseMutation,
      sync: createEventSyncMetadata(baseMutation),
    }
    const familyId = get().settings?.familyId ?? ''
    const familyEpoch = familyEventViewEpoch
    const result = await ipc.appendEvent(mutation, familyId)
    if (result === 'error') {
      throw new Error('append_failed')
    }
    // Enqueue for cloud sync. Remote-received events are filtered inside enqueue
    // via _seenFromRemote — no re-upload loop.
    // 'duplicate' means the event is already on disk; still merge into UI state
    // and enqueue so a previous sync gap can be filled.
    enqueue(mutation, familyId)
    if ((get().settings?.familyId ?? '') === familyId
      && familyEventViewEpoch === familyEpoch) {
      eventViewOwnership.set(mutation, { familyId, epoch: familyEpoch })
      set(state => ({
        events: markEventsForFamilyView(
          mergeEventIntoList(state.events, mutation),
          familyId,
          familyEpoch,
        ),
      }))
    }
    return mutation
  },

  editEvent: async (original: DiaryEvent, patch) => {
    const familyId = get().settings?.familyId ?? ''
    const familyEpoch = familyEventViewEpoch
    const liveEvent = get().events.find(event => event.id === original.id)
    const sourceView = eventViewOwnership.get(original)
    const liveView = liveEvent ? eventViewOwnership.get(liveEvent) : undefined
    const sourceIsCurrent = sourceView
      ? sourceView.familyId === familyId
        && sourceView.epoch === familyEpoch
        && liveView?.familyId === familyId
        && liveView.epoch === familyEpoch
      : liveEvent === original
    if (!liveEvent || liveEvent.deleted || !sourceIsCurrent) {
      throw new Error('stale_family_view')
    }
    const t = now()
    // MF-11: re-read the live rev from the store in case a remote sync raised it
    // while the modal was open — prevents the edit being silently dropped by
    // mergeEventIntoList (incoming.rev not > existing.rev).
    const liveRev = liveEvent.rev
    const { migration: _priorMigration, ...freshSource } = original
    const baseUpdated: DiaryEvent = {
      ...freshSource,
      ...patch,
      updatedAt: t,
      rev: nextHybridLogicalClock(Math.max(original.rev, liveRev), Date.parse(t)),
      mutationId: uuidv4(),
    }
    const updated: DiaryEvent = {
      ...baseUpdated,
      sync: createEventSyncMetadata(baseUpdated),
    }
    const result = await ipc.appendEvent(updated, familyId)
    if (result === 'error') {
      throw new Error('append_failed')
    }
    enqueue(updated, familyId)
    if ((get().settings?.familyId ?? '') === familyId
      && familyEventViewEpoch === familyEpoch) {
      eventViewOwnership.set(updated, { familyId, epoch: familyEpoch })
      set(state => ({
        events: markEventsForFamilyView(
          mergeEventIntoList(state.events, updated),
          familyId,
          familyEpoch,
        ),
      }))
    }
    return updated
  },

  softDeleteEvent: async (event: DiaryEvent) => {
    return get().editEvent(event, { deleted: true })
  },

  softDeleteAllEvents: async () => {
    // Collect latest-rev non-deleted events (store already holds resolved view)
    const targets = get().events.filter(e => !e.deleted)
    let count = 0
    let partial = false
    const familyId = get().settings?.familyId ?? ''
    const familyEpoch = familyEventViewEpoch
    for (const event of targets) {
      if ((get().settings?.familyId ?? '') !== familyId
        || familyEventViewEpoch !== familyEpoch) {
        partial = true
        break
      }
      const updatedAt = now()
      const { migration: _priorMigration, ...freshSource } = event
      const baseTombstone: DiaryEvent = {
        ...freshSource,
        deleted: true,
        updatedAt,
        rev: nextHybridLogicalClock(event.rev, Date.parse(updatedAt)),
        mutationId: uuidv4(),
      }
      const tombstone: DiaryEvent = {
        ...baseTombstone,
        sync: createEventSyncMetadata(baseTombstone),
      }
      let result: 'ok' | 'duplicate' | 'error'
      try {
        result = await ipc.appendEvent(tombstone, familyId)
      } catch {
        result = 'error'
      }
      if (result === 'error') {
        // P12(a): abort on first error; record partial state flag
        partial = true
        break
      }
      enqueue(tombstone, familyId)
      count++
      if ((get().settings?.familyId ?? '') !== familyId
        || familyEventViewEpoch !== familyEpoch) {
        partial = true
        break
      }
      eventViewOwnership.set(tombstone, { familyId, epoch: familyEpoch })
      set(state => ({
        events: markEventsForFamilyView(
          mergeEventIntoList(state.events, tombstone),
          familyId,
          familyEpoch,
        ),
      }))
    }
    if (partial) {
      // P12(b): resync UI to true disk state after partial failure so store
      // matches what's actually on disk (avoids ghost-deleted entries in memory).
      const currentFamilyId = get().settings?.familyId ?? ''
      await reloadCurrentFamilyEvents(currentFamilyId, true)
    }
    // MF-12: return both count and partial flag so caller can show the correct toast
    return { count, partial }
  },

  // -----------------------------------------------------------------------
  // Quick-add helpers
  // -----------------------------------------------------------------------

  addPee: async (atOverride?: string) => {
    const e = makeBase(get().settings, 'pee')
    if (atOverride) e.at = atOverride
    return get().addEvent(e)
  },

  addPoop: async (atOverride?: string) => {
    const e = makeBase(get().settings, 'poop')
    if (atOverride) e.at = atOverride
    return get().addEvent(e)
  },

  addTemp: async (celsius: number, atOverride?: string) => {
    const e = makeBase(get().settings, 'temp')
    if (atOverride) e.at = atOverride
    e.data = { celsius }
    return get().addEvent(e)
  },

  addBreast: async (side: 'L' | 'R' | 'both', minutes?: number, atOverride?: string) => {
    const e = makeBase(get().settings, 'breast')
    if (atOverride) e.at = atOverride
    e.data = { side, ...(minutes != null ? { minutes } : {}) } as BreastData
    return get().addEvent(e)
  },

  addFormula: async (ml: number, atOverride?: string) => {
    const e = makeBase(get().settings, 'formula')
    if (atOverride) e.at = atOverride
    e.data = { ml }
    return get().addEvent(e)
  },

  addSleep: async (minutes: number, atOverride?: string) => {
    const e = makeBase(get().settings, 'sleep')
    if (atOverride) e.at = atOverride
    e.data = { minutes } as SleepData
    return get().addEvent(e)
  },

  addGrowth: async (weightKg: number | undefined, heightCm: number | undefined, atOverride?: string) => {
    if (weightKg == null && heightCm == null) throw new Error('growth_requires_at_least_one')
    const e = makeBase(get().settings, 'growth')
    if (atOverride) e.at = atOverride
    const data: GrowthData = {}
    if (weightKg != null) data.weightKg = weightKg
    if (heightCm != null) data.heightCm = heightCm
    e.data = data
    return get().addEvent(e)
  },

  todaySleepMinutes: () => {
    return get().events
      .filter(e => !e.deleted && e.type === 'sleep' && isToday(parseISO(e.at)))
      .reduce((sum, e) => sum + ((e.data as SleepData).minutes ?? 0), 0)
  },

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------

  saveSettings: async (s: AppSettings) => {
    const saved = await ipc.saveSettings(s)
    set({ settings: saved })
    return saved
  },

  saveSettingsWithBabyInfoMutation: async (s: AppSettings) => {
    const result = await persistSettingsWithBabyInfoMutation(s)
    set({ settings: result.settings })
    return result
  },

  // -----------------------------------------------------------------------
  // External merge
  // -----------------------------------------------------------------------

  mergeExternalEvent: (event: DiaryEvent) => {
    const familyId = get().settings?.familyId ?? ''
    const familyEpoch = familyEventViewEpoch
    eventViewOwnership.set(event, { familyId, epoch: familyEpoch })
    set(state => ({
      events: markEventsForFamilyView(
        mergeEventIntoList(state.events, event),
        familyId,
        familyEpoch,
      ),
    }))
  },
}))

// ---------------------------------------------------------------------------
// Merge helper (shared deterministic mutation conflict resolution)
// ---------------------------------------------------------------------------
function mergeEventIntoList(list: DiaryEvent[], incoming: DiaryEvent): DiaryEvent[] {
  if (isKnownV038UpgradeFixtureEvent(incoming)) return list
  return mergeResolvedEvent(list, incoming)
}

const appStoreHot = (import.meta as ImportMeta & {
  hot?: { dispose: (callback: () => void) => void }
}).hot
if (appStoreHot) {
  appStoreHot.dispose(() => {
    disposeAppStoreEventBridge()
    disposeAppStoreSettingsBridge()
  })
}

// ---------------------------------------------------------------------------
// D+N helper (exported for use in Sidebar)
// ---------------------------------------------------------------------------
export function getDDay(birthdate: string): number {
  if (!birthdate) return 0
  const birth = parseISO(birthdate)
  const today = startOfDay(new Date())
  const diff = Math.floor((today.getTime() - startOfDay(birth).getTime()) / (1000 * 60 * 60 * 24))
  return diff + 1 // D+1 on birthday
}

// Format event value for timeline display
export function formatEventValue(e: DiaryEvent): string {
  const t = i18n.t.bind(i18n)
  switch (e.type) {
    case 'pee':
      return ''
    case 'poop':
      return ''
    case 'temp': {
      const d = e.data as { celsius: number }
      return `${d.celsius.toFixed(1)}℃`
    }
    case 'breast': {
      const d = e.data as { side: string; minutes?: number }
      const side = d.side === 'L'
        ? t('breast.left')
        : d.side === 'R'
          ? t('breast.right')
          : t('breast.both')
      if (d.minutes != null) {
        return t('eventValue.breastSideMinutes', { side, minutes: d.minutes })
      }
      return t('eventValue.breastSide', { side })
    }
    case 'formula': {
      const d = e.data as { ml: number }
      return `${d.ml}mL`
    }
    case 'diary': {
      const d = e.data as { title?: string; text: string }
      return d.title ? d.title : (d.text.length > 30 ? d.text.slice(0, 30) + '…' : d.text)
    }
    case 'message': {
      const d = e.data as { text: string }
      return d.text.length > 30 ? d.text.slice(0, 30) + '…' : d.text
    }
    case 'sleep': {
      const d = e.data as SleepData
      const totalMin = d.minutes
      const lang = i18n.language
      if (totalMin >= 60) {
        const h = Math.floor(totalMin / 60)
        const m = totalMin % 60
        if (lang === 'ja') {
          return m > 0 ? `${h}時間${m}分` : `${h}時間`
        }
        return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
      }
      return lang === 'ja' ? `${totalMin}分` : `${totalMin}분`
    }
    case 'growth': {
      const d = e.data as GrowthData
      const parts: string[] = []
      if (d.weightKg != null) parts.push(`${d.weightKg.toFixed(1)}kg`)
      if (d.heightCm != null) parts.push(`${d.heightCm.toFixed(1)}cm`)
      return parts.join(' · ')
    }
    default:
      return ''
  }
}

// Format time from ISO string
export function formatTime(iso: string): string {
  return format(parseISO(iso), 'HH:mm')
}
