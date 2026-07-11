import { create } from 'zustand'
import { DiaryEvent, AppSettings, DataInfo, EventType, BreastData, FormulaData, SleepData, GrowthData } from '../../shared/types'
import { ipc } from '../lib/ipc'
import { enqueue } from '../sync/syncEngine'
import { v4 as uuidv4 } from 'uuid'
import { format, isToday, parseISO, startOfDay, isSameDay } from 'date-fns'
import i18n from '../i18n'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() { return new Date().toISOString() }

function makeBase(settings: AppSettings | null, type: DiaryEvent['type']): DiaryEvent {
  const t = now()
  return {
    id: uuidv4(),
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
    rev: 1,
    deleted: false,
  }
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
  softDeleteAllEvents: () => Promise<number>

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
  saveSettings: (s: AppSettings) => Promise<void>

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
    try {
      set({ isLoading: true, error: null })
      const events = await ipc.listEvents()
      set({ events, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  loadSettings: async () => {
    try {
      const settings = await ipc.getSettings()
      set({ settings })
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
    const { loadEvents, loadSettings, loadDataInfo } = get()
    // P13: Wait for ALL three loaders before setting isReady so birthdate-derived
    // render sites (D+, milestone banners, InsightsPanel) never see stale/null
    // settings while events have already resolved.
    await Promise.all([loadEvents(), loadSettings(), loadDataInfo()])
    set({ isReady: true })

    // Subscribe to external events appended by main/sync
    if (typeof window !== 'undefined' && window.babyDiary) {
      ipc.onEventAppended((event) => {
        get().mergeExternalEvent(event)
      })
    }
  },

  // -----------------------------------------------------------------------
  // Derived selectors
  // -----------------------------------------------------------------------

  todayEvents: () => {
    return get().events
      .filter(e => !e.deleted && isToday(parseISO(e.at)))
      .sort((a, b) => b.at.localeCompare(a.at))
  },

  eventsForDay: (date: Date) => {
    const day = startOfDay(date)
    return get().events
      .filter(e => !e.deleted && isSameDay(parseISO(e.at), day))
      .sort((a, b) => b.at.localeCompare(a.at))
  },

  lastFeeding: () => {
    const nowIso = new Date().toISOString()
    const feedings = get().events
      .filter(e => !e.deleted && (e.type === 'breast' || e.type === 'formula') && e.at <= nowIso)
      .sort((a, b) => b.at.localeCompare(a.at))
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
    const result = await ipc.appendEvent(event)
    if (result === 'error') {
      throw new Error('append_failed')
    }
    // Enqueue for cloud sync. Remote-received events are filtered inside enqueue
    // via _seenFromRemote — no re-upload loop.
    // 'duplicate' means the event is already on disk; still merge into UI state
    // and enqueue so a previous sync gap can be filled.
    enqueue(event)
    set(state => ({
      events: mergeEventIntoList(state.events, event),
    }))
    return event
  },

  editEvent: async (original: DiaryEvent, patch) => {
    const t = now()
    const updated: DiaryEvent = {
      ...original,
      ...patch,
      updatedAt: t,
      rev: original.rev + 1,
    }
    const result = await ipc.appendEvent(updated)
    if (result === 'error') {
      throw new Error('append_failed')
    }
    enqueue(updated)
    set(state => ({
      events: mergeEventIntoList(state.events, updated),
    }))
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
    for (const event of targets) {
      const result = await ipc.appendEvent({
        ...event,
        deleted: true,
        updatedAt: now(),
        rev: event.rev + 1,
      })
      if (result === 'error') {
        // P12(a): abort on first error; record partial state flag
        partial = true
        break
      }
      const tombstone: DiaryEvent = {
        ...event,
        deleted: true,
        updatedAt: new Date().toISOString(),
        rev: event.rev + 1,
      }
      enqueue(tombstone)
      set(state => ({
        events: mergeEventIntoList(state.events, tombstone),
      }))
      count++
    }
    if (partial) {
      // P12(b): resync UI to true disk state after partial failure so store
      // matches what's actually on disk (avoids ghost-deleted entries in memory).
      await get().loadEvents()
    }
    return count
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
    await ipc.saveSettings(s)
    set({ settings: s })
  },

  // -----------------------------------------------------------------------
  // External merge
  // -----------------------------------------------------------------------

  mergeExternalEvent: (event: DiaryEvent) => {
    set(state => ({
      events: mergeEventIntoList(state.events, event),
    }))
  },
}))

// ---------------------------------------------------------------------------
// Merge helper (id+rev conflict resolution: higher rev wins)
// ---------------------------------------------------------------------------
function mergeEventIntoList(list: DiaryEvent[], incoming: DiaryEvent): DiaryEvent[] {
  const idx = list.findIndex(e => e.id === incoming.id)
  if (idx === -1) {
    return [...list, incoming]
  }
  const existing = list[idx]
  if (incoming.rev > existing.rev) {
    const next = [...list]
    next[idx] = incoming
    return next
  }
  // P3 defense-in-depth: at equal rev, prefer deleted:true (tombstone wins)
  if (incoming.rev === existing.rev && incoming.deleted && !existing.deleted) {
    const next = [...list]
    next[idx] = incoming
    return next
  }
  return list
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
      return `${d.ml}ml`
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
