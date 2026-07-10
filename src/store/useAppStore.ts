import { create } from 'zustand'
import { DiaryEvent, AppSettings } from '../../shared/types'
import { ipc } from '../lib/ipc'
import { v4 as uuidv4 } from 'uuid'

interface AppState {
  events: DiaryEvent[]
  settings: AppSettings | null
  isLoading: boolean
  error: string | null

  loadEvents: () => Promise<void>
  loadSettings: () => Promise<void>
  appendPeeEvent: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  events: [],
  settings: null,
  isLoading: false,
  error: null,

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

  appendPeeEvent: async () => {
    const { settings } = get()
    const now = new Date().toISOString()
    const event: DiaryEvent = {
      id: uuidv4(),
      type: 'pee',
      at: now,
      data: {},
      author: {
        uid: settings?.profile?.uid || 'test-uid',
        name: settings?.profile?.name || '테스터',
        role: settings?.profile?.role || 'dad',
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
    await ipc.appendEvent(event)
    const events = await ipc.listEvents()
    set({ events })
  },
}))
