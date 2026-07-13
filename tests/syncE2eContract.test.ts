import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

describe('packaged sync E2E selector contract', () => {
  it('exposes the lossless physical mutation list through the sandboxed bridge', () => {
    expect(source('electron/main.ts')).toContain("ipcMain.handle('events:listMutations'")
    expect(source('electron/preload.ts')).toContain("ipcRenderer.invoke('events:listMutations')")
    expect(source('src/lib/ipc.ts')).toContain('listEventMutations')
    expect(source('scripts/sync-e2e.mjs')).toContain('window.babyDiary.listEventMutations()')
  })

  it('exposes stable auth and sync-state selectors', () => {
    const sync = source('src/components/SyncSettingsSlot.tsx')
    for (const selector of [
      'data-sync-state',
      'data-sync-auth-form',
      'data-sync-email',
      'data-sync-password',
      'data-sync-keep-logged-in',
      'data-sync-submit',
      'data-sync-switch-mode',
    ]) {
      expect(sync, selector).toContain(selector)
    }
  })

  it('exposes stable family create/join and invite-code selectors', () => {
    const sync = source('src/components/SyncSettingsSlot.tsx')
    for (const selector of [
      'data-sync-family-choice',
      'data-sync-family-submit',
      'data-sync-invite-code-input',
      'data-sync-invite-code-value',
    ]) {
      expect(sync, selector).toContain(selector)
    }
    expect(source('src/pages/SettingsPage.tsx')).toContain('data-sync-settings')
  })

  it('exposes quick-record types without relying on localized labels', () => {
    const home = source('src/pages/HomePage.tsx')
    expect(home).toContain("type: 'pee'")
    expect(home).toContain("type: 'poop'")
    expect(home).toContain('data-quick-record={type}')
  })

  it('exposes event identity, revision, edit, and tombstone controls', () => {
    const timeline = source('src/components/EventTimeline.tsx')
    expect(timeline).toContain('data-event-id={event.id}')
    expect(timeline).toContain('data-event-rev={event.rev}')
    expect(timeline).toContain('data-event-action="edit"')
    expect(timeline).toContain('data-event-action="delete"')
    expect(timeline).toContain('data-event-action="confirm-delete"')

    const timeEdit = source('src/components/TimeEditModal.tsx')
    expect(timeEdit).toContain('data-time-edit-modal')
    expect(timeEdit).toContain('data-time-edit-input')
    expect(timeEdit).toContain('data-time-edit-action="confirm"')
  })
})
