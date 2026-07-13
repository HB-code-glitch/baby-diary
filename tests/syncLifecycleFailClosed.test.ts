import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  getSettings: vi.fn(),
  configure: vi.fn(),
  start: vi.fn(),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: { getSettings: bridge.getSettings },
}))

vi.mock('../src/sync/syncEngine', () => ({
  configure: bridge.configure,
  start: bridge.start,
}))

const customConfig = {
  apiKey: 'custom-key',
  authDomain: 'custom.example.test',
  projectId: 'custom-project',
  storageBucket: 'custom-bucket',
  messagingSenderId: '123456',
  appId: 'custom-app',
}

describe('sync lifecycle fail-closed startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.configure.mockResolvedValue(undefined)
    bridge.start.mockResolvedValue(undefined)
  })

  it('does not invent a default config/family when settings cannot be read', async () => {
    bridge.getSettings.mockRejectedValueOnce(new Error('settings unavailable'))
    const { startSyncFromAuthoritativeSettings } = await import('../src/sync/syncLifecycle')

    await expect(startSyncFromAuthoritativeSettings()).rejects.toThrow('settings unavailable')
    expect(bridge.configure).not.toHaveBeenCalled()
    expect(bridge.start).not.toHaveBeenCalled()
  })

  it('does not retry a failed custom claim under default config or empty family', async () => {
    bridge.getSettings.mockResolvedValueOnce({
      firebase: customConfig,
      familyId: 'ABCDEFGHJKLM',
    })
    bridge.configure.mockRejectedValueOnce(new Error('claim unavailable'))
    const { startSyncFromAuthoritativeSettings } = await import('../src/sync/syncLifecycle')

    await expect(startSyncFromAuthoritativeSettings()).rejects.toThrow('claim unavailable')
    expect(bridge.configure).toHaveBeenCalledOnce()
    expect(bridge.configure).toHaveBeenCalledWith(customConfig, 'ABCDEFGHJKLM')
    expect(bridge.start).not.toHaveBeenCalled()
  })
})
