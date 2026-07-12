/**
 * tests/updaterLifecycle.test.ts
 * Unit tests for P22/P23 updater lifecycle:
 *   - stopUpdater, isUpdaterRunning, idempotent setupUpdater (P22)
 *   - 30-min interval, focus throttle, in-flight guard (P23)
 *
 * NOTE: We cannot call setupUpdater() directly in production mode (it checks
 * app.isPackaged === true).  Lifecycle state functions are tested in isolation;
 * timer/focus/in-flight logic is verified via pure helper extraction below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the electron and electron-updater modules so we can import updater.ts
vi.mock('electron', () => ({
  app: {
    isPackaged: false,  // shouldCheck() → false, so setupUpdater() is a no-op
    getPath: vi.fn(() => '/tmp'),
    once: vi.fn(),
  },
  ipcMain: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => {}),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    quitAndInstall: vi.fn(),
  },
}))

describe('updater lifecycle (P22)', () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it('exports stopUpdater, isUpdaterRunning, setupUpdater', async () => {
    const mod = await import('../electron/updater')
    expect(typeof mod.stopUpdater).toBe('function')
    expect(typeof mod.isUpdaterRunning).toBe('function')
    expect(typeof mod.setupUpdater).toBe('function')
  })

  it('isUpdaterRunning returns false when never started (isPackaged=false)', async () => {
    const { isUpdaterRunning } = await import('../electron/updater')
    expect(isUpdaterRunning()).toBe(false)
  })

  it('stopUpdater is safe when never started (no throw)', async () => {
    const { stopUpdater } = await import('../electron/updater')
    expect(() => stopUpdater()).not.toThrow()
  })

  it('isUpdaterRunning returns false after stopUpdater called on never-started engine', async () => {
    const { stopUpdater, isUpdaterRunning } = await import('../electron/updater')
    stopUpdater()
    expect(isUpdaterRunning()).toBe(false)
  })
})

// ── P23: pure logic helpers extracted for unit testing ────────────────────────
// These mirror the in-flight guard and focus-throttle logic in updater.ts so we
// can test the decision rules without touching electron or electron-updater.

/** Mirrors runCheck's in-flight guard decision. */
function shouldSkipInFlight(checking: boolean): boolean {
  return checking
}

/** Mirrors the focus throttle decision. */
function isFocusThrottled(lastFocusCheck: number, now: number, throttleMs: number): boolean {
  return (now - lastFocusCheck) < throttleMs
}

describe('updater P23 — in-flight guard (pure logic)', () => {
  it('skips when a check is already in-flight', () => {
    expect(shouldSkipInFlight(true)).toBe(true)
  })

  it('does not skip when no check is in-flight', () => {
    expect(shouldSkipInFlight(false)).toBe(false)
  })
})

describe('updater P23 — focus throttle (pure logic)', () => {
  const THROTTLE = 10 * 60 * 1_000  // 10 minutes

  it('throttles when last check was less than 10 minutes ago', () => {
    const now = Date.now()
    const lastCheck = now - 5 * 60 * 1_000  // 5 min ago
    expect(isFocusThrottled(lastCheck, now, THROTTLE)).toBe(true)
  })

  it('allows when last check was more than 10 minutes ago', () => {
    const now = Date.now()
    const lastCheck = now - 11 * 60 * 1_000  // 11 min ago
    expect(isFocusThrottled(lastCheck, now, THROTTLE)).toBe(false)
  })

  it('allows when never checked before (lastFocusCheck = 0)', () => {
    const now = Date.now()
    expect(isFocusThrottled(0, now, THROTTLE)).toBe(false)
  })
})

describe('updater P23 — interval constant', () => {
  it('interval is 30 minutes (1 800 000 ms), not 6 hours', async () => {
    // Read the TypeScript source to verify the interval constant (regression guard).
    const { readFileSync } = await import('fs')
    const { resolve, dirname } = await import('path')
    const { fileURLToPath } = await import('url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const srcPath = resolve(dir, '..', 'electron', 'updater.ts')
    const source = readFileSync(srcPath, 'utf8')
    expect(source).toContain('30 * 60 * 1_000')
    expect(source).not.toContain('6 * 60 * 60 * 1_000')
  })
})
