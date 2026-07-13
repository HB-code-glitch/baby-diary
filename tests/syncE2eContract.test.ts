import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

describe('packaged sync E2E selector contract', () => {
  it('installs the test-only main-process guard before the first BrowserWindow load', () => {
    const main = source('electron/main.ts')
    expect(main).toContain("from './syncE2EGuard'")
    const ready = main.indexOf('app.whenReady().then(() => {')
    const install = main.indexOf('installSessionGuard(', ready)
    const create = main.indexOf('createWindow()', ready)
    expect(install).toBeGreaterThan(ready)
    expect(create).toBeGreaterThan(install)

    const createFunction = main.indexOf('function createWindow(): void')
    const browserWindow = main.indexOf('new BrowserWindow(', createFunction)
    const attach = main.indexOf('attachWindowDiagnostics(', browserWindow)
    const load = main.indexOf('mainWindow.loadFile(', browserWindow)
    expect(attach).toBeGreaterThan(browserWindow)
    expect(load).toBeGreaterThan(attach)
  })

  it('installs network and renderer diagnostics before obtaining the first window', () => {
    const runner = source('scripts/sync-e2e.mjs')
    const launchStart = runner.indexOf('async function launchDevice')
    const guard = runner.indexOf('await installNetworkGuards(', launchStart)
    const diagnostics = runner.indexOf('attachRendererDiagnostics(', launchStart)
    const firstWindow = runner.indexOf('await app.firstWindow(', launchStart)

    expect(launchStart).toBeGreaterThanOrEqual(0)
    expect(guard).toBeGreaterThan(launchStart)
    expect(diagnostics).toBeGreaterThan(guard)
    expect(firstWindow).toBeGreaterThan(diagnostics)
  })

  it('uses exact semantic event polling for every normal cross-device transfer', () => {
    const runner = source('scripts/sync-e2e.mjs')
    expect(runner).toContain('async function waitForSemanticEvent')
    expect(runner).not.toContain('async function waitForEvent')
    expect(runner).toContain('normalizeSemanticEvents(finalA.events)')
    expect(runner).toContain('normalizeSemanticEvents(finalB.events)')
  })

  it('uses independent full-payload edit and delete expectations on both devices', () => {
    const runner = source('scripts/sync-e2e.mjs')
    expect(runner).toContain('const expectedEdited = buildExpectedEditedEvent(event,')
    expect(runner).toContain('semanticEventsEqual(observedEdited, expectedEdited)')
    expect(runner).toContain('const expectedDeleted = buildExpectedDeletedEvent(event,')
    expect(runner).toContain('semanticEventsEqual(observedDeleted, expectedDeleted)')
    expect(runner).toContain('const expectedEdited = await editEventTime(b, firstA)')
    expect(runner).toContain('await waitForSemanticEvent(a, expectedEdited)')
    expect(runner).toContain('const expectedDeleted = await deleteEvent(a, firstB)')
    expect(runner).toContain('await waitForSemanticEvent(b, expectedDeleted)')
  })

  it('checks complete local and Firestore conflict mutations instead of document ids alone', () => {
    const runner = source('scripts/sync-e2e.mjs')
    expect(runner).toContain('readCloudEventDocuments(familyA)')
    expect(runner).toContain('semanticEventsEqual(localMutation, conflict)')
    expect(runner).toContain('semanticEventsEqual(cloudDocument.event, conflict)')
    expect(runner).not.toContain('async function readCloudEventDocIds')
    expect(runner).not.toContain('cloudDocIds.includes(')
  })

  it('passes a unique persistent early-guard file into every packaged launch', () => {
    const runner = source('scripts/sync-e2e.mjs')
    expect(runner).toContain("realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-sync-e2e-')))")
    expect(runner).toContain("BABYDIARY_SYNC_E2E_EARLY_GUARD: '1'")
    expect(runner).toContain('BABYDIARY_SYNC_E2E_GUARD_TOKEN: guardToken')
    expect(runner).toContain('BABYDIARY_SYNC_E2E_DIAGNOSTICS: diagnosticPath')
    expect(runner).toContain('diagnosticFiles.push({ name, path: diagnosticPath })')
    const finalize = runner.indexOf('export async function finalizeRun')
    const collect = runner.indexOf('collectPersistentGuardDiagnostics(', finalize)
    const clean = runner.indexOf('assertCleanDiagnostics(', finalize)
    const remove = runner.indexOf('await removeTemp(', finalize)
    expect(collect).toBeGreaterThan(finalize)
    expect(clean).toBeGreaterThan(collect)
    expect(remove).toBeGreaterThan(clean)
  })

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
