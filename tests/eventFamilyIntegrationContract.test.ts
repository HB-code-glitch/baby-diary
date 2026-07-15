import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const source = (relative: string) => readFileSync(join(root, relative), 'utf8')

describe('event family ownership integration contract', () => {
  it('routes every main-process event IPC through the family-scoped boundary', () => {
    const main = source('electron/main.ts')
    expect(main).toContain("import { FamilyScopedEventLog } from './store/familyScopedEventLog'")
    expect(main).toContain('let familyScopedEventLog: FamilyScopedEventLog')
    expect(main).toContain("ipcMain.handle('events:confirmFamily'")
    expect(main).toContain("ipcMain.handle('events:list', async (_, expectedFamilyId?: string)")
    expect(main).toContain("throw new Error('EVENT_FAMILY_MISMATCH')")
    expect(main).toContain('familyScopedEventLog.listVisible(currentFamilyId)')
    expect(main).toContain('familyScopedEventLog.listMutations(currentFamilyId)')
    expect(main).toContain('familyScopedEventLog.append(event, currentFamilyId, expectedFamilyId)')
  })

  it('carries the expected family across the sandboxed preload boundary', () => {
    const preload = source('electron/preload.ts')
    const client = source('src/lib/ipc.ts')
    expect(preload).toContain("ipcRenderer.invoke('events:list', expectedFamilyId)")
    expect(preload).toContain("ipcRenderer.invoke('events:listMutations', expectedFamilyId)")
    expect(preload).toContain("ipcRenderer.invoke('events:append', event, expectedFamilyId)")
    expect(preload).toContain("ipcRenderer.invoke('events:confirmFamily', familyId, allowLegacyAdoption)")
    expect(client).toContain('confirmEventFamily: (familyId: string, allowLegacyAdoption?: boolean)')
    expect(client).toContain('appendEvent: (event: DiaryEvent, expectedFamilyId?: string)')
    expect(client).toContain('listEvents: (expectedFamilyId?: string)')
    expect(client).toContain('onEventAppended: (callback: (event: DiaryEvent, familyId: string) => void)')
    expect(preload).toContain('callback(event, familyId)')
  })

  it('confirms membership before reconciliation and scopes queue records to one family', () => {
    const sync = source('src/sync/syncEngine.ts')
    expect(sync).toContain('familyId: string')
    expect(sync).toContain('const allowLegacyAdoption = !storedLocalFamilyId || storedLocalFamilyId === context.familyId')
    expect(sync).toContain('await ipc.confirmEventFamily(context.familyId, allowLegacyAdoption)')
    expect(sync).toContain('ipc.listEventMutations(context.familyId)')
    expect(sync).toContain('ipc.appendEvent(event, context.familyId)')
    expect(sync).toContain('pending.familyId === context.familyId')
  })

  it('binds local writes to the authoritative settings family before enqueue', () => {
    const store = source('src/store/useAppStore.ts')
    expect(store).toContain('const familyId = get().settings?.familyId ?? \'\'')
    expect(store).toContain('ipc.appendEvent(mutation, familyId)')
    expect(store).toContain('enqueue(mutation, familyId)')
    expect(store).toContain('ipc.listEvents(expectedFamilyId)')
  })
})
