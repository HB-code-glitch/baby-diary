import { create } from 'zustand'
import { DiaryEvent, AppSettings, DataInfo, EventType, BreastData, FormulaData } from '../../shared/types'
import { ipc } from '../lib/ipc'
import { enqueue } from '../sync/syncEngine'
import { v4 as uuidv4 } from 'uuid'
import { format, isToday, parseISO, startOfDay, isSameDay } from 'date-fns'

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
      name: settings?.profile?.name ?? '나',
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
  addEvent:        (event: DiaryEvent) => Promise<DiaryEvent>
  editEvent:       (original: DiaryEvent, patch: Partial<Pick<DiaryEvent, 'at' | 'data' | 'deleted'>>) => Promise<DiaryEvent>
  softDeleteEvent: (event: DiaryEvent) => Promise<DiaryEvent>

  // Quick-add helpers
  addPee:     (atOverride?: string) => Promise<DiaryEvent>
  addPoop:    (atOverride?: string) => Promise<DiaryEvent>
  addTemp:    (celsius: number, atOverride?: string) => Promise<DiaryEvent>
  addBreast:  (side: 'L' | 'R' | 'both', minutes?: number, atOverride?: string) => Promise<DiaryEvent>
  addFormula: (ml: number, atOverride?: string) => Promise<DiaryEvent>

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
    await Promise.all([loadEvents(), loadSettings(), loadDataInfo()])

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
    const feedings = get().events
      .filter(e => !e.deleted && (e.type === 'breast' || e.type === 'formula'))
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
    const ok = await ipc.appendEvent(event)
    if (ok) {
      // Enqueue for cloud sync. Remote-received events are filtered inside enqueue
      // via _seenFromRemote — no re-upload loop.
      enqueue(event)
    }
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
    const ok = await ipc.appendEvent(updated)
    if (ok) {
      enqueue(updated)
    }
    set(state => ({
      events: mergeEventIntoList(state.events, updated),
    }))
    return updated
  },

  softDeleteEvent: async (event: DiaryEvent) => {
    return get().editEvent(event, { deleted: true })
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
      const side = d.side === 'L' ? '왼쪽' : d.side === 'R' ? '오른쪽' : '양쪽'
      return `${side}${d.minutes != null ? ` ${d.minutes}분` : ''}`
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
    default:
      return ''
  }
}

// Format time from ISO string
export function formatTime(iso: string): string {
  return format(parseISO(iso), 'HH:mm')
}
