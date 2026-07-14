import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFirebaseEmulatorBridge } from '../electron/firebaseEmulatorConfig'

const validEnv = {
  BABYDIARY_TEST_USERDATA: 'D:\\isolated\\profile-a',
  BABYDIARY_FIREBASE_EMULATOR: '1',
  BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: 'demo-baby-diary',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
}

describe('Firebase emulator preload bridge', () => {
  it('never exposes emulator endpoints without isolated userData', () => {
    const { BABYDIARY_TEST_USERDATA: _ignored, ...notIsolated } = validEnv
    expect(readFirebaseEmulatorBridge(notIsolated)).toBeNull()
  })

  it('fails closed instead of exposing production Firebase to an isolated UI E2E run', () => {
    const bridge = readFirebaseEmulatorBridge({
      BABYDIARY_TEST_USERDATA: validEnv.BABYDIARY_TEST_USERDATA,
    })
    expect(bridge).toMatchObject({ enabled: false })
    expect(bridge && !bridge.enabled ? bridge.reason : '').toMatch(/emulator/i)
  })

  it('exposes only the exact local demo emulator endpoints', () => {
    expect(readFirebaseEmulatorBridge(validEnv)).toEqual({
      enabled: true,
      projectId: 'demo-baby-diary',
      firebaseConfig: {
        apiKey: 'demo-api-key',
        authDomain: 'demo-baby-diary.firebaseapp.com',
        projectId: 'demo-baby-diary',
        storageBucket: 'demo-baby-diary.appspot.com',
        messagingSenderId: '123456789',
        appId: '1:123456789:web:sync-e2e',
      },
      authHost: '127.0.0.1',
      authPort: 9099,
      firestoreHost: '127.0.0.1',
      firestorePort: 8080,
    })
  })

  it.each([
    ['wrong project', { BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: 'baby-diary-jaei-2026' }],
    ['remote auth host', { FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:9099' }],
    ['remote firestore host', { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:8080' }],
    ['wrong auth port', { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9100' }],
    ['wrong firestore port', { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081' }],
    ['auth URL instead of host:port', { FIREBASE_AUTH_EMULATOR_HOST: 'http://127.0.0.1:9099' }],
    ['missing firestore address', { FIRESTORE_EMULATOR_HOST: undefined }],
  ])('fails closed for %s', (_name, override) => {
    const bridge = readFirebaseEmulatorBridge({ ...validEnv, ...override })
    expect(bridge).toMatchObject({ enabled: false })
    expect(bridge && !bridge.enabled ? bridge.reason : '').toBeTruthy()
  })

  it('wires the pure parser through main and the context-isolated preload API', () => {
    const main = readFileSync(resolve('electron/main.ts'), 'utf8')
    const preload = readFileSync(resolve('electron/preload.ts'), 'utf8')
    expect(main).toContain("from './firebaseEmulatorConfig'")
    expect(main).toContain('readFirebaseEmulatorBridge(process.env)')
    expect(main).toContain("ipcMain.handle('test:firebaseEmulator'")
    expect(preload).not.toContain("from './firebaseEmulatorConfig'")
    expect(preload).toContain("ipcRenderer.invoke('test:firebaseEmulator')")
    expect(preload).toContain("contextBridge.exposeInMainWorld('babyDiary', babyDiaryAPI)")
  })

  it('binds every local-only packaged UI harness to the exact demo emulators', () => {
    for (const file of ['scripts/mac-e2e.mjs', 'scripts/windows-installed-release-smoke.ps1']) {
      const harness = readFileSync(resolve(file), 'utf8')
      expect(harness, file).toContain("BABYDIARY_FIREBASE_EMULATOR: '1'")
      expect(harness, file).toContain("BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: 'demo-baby-diary'")
      expect(harness, file).toContain("FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'")
      expect(harness, file).toContain("FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'")
    }
  })
})
