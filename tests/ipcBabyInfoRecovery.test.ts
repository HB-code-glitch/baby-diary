import { afterEach, describe, expect, it, vi } from 'vitest'
import { BabyInfoCommitClientError, ipc } from '../src/lib/ipc'

describe('baby-info recovery IPC contract', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('preserves the formal RECOVERY_REQUIRED code for renderer callers', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        babyDiary: {
          commitBabyInfo: vi.fn(async () => ({
            ok: false as const,
            error: {
              code: 'RECOVERY_REQUIRED' as const,
              message: 'Baby Diary must restart to revalidate local settings.',
            },
          })),
        } as Window['babyDiary'],
      },
    })

    const failure = await ipc.commitBabyInfo({
      kind: 'user-edit',
      familyId: 'family-A',
      babyName: 'Blocked',
      babyBirthdate: '2026-07-14',
      settings: {
        baby: { name: 'Blocked', birthdate: '2026-07-14' },
        profile: { uid: 'user-1', name: 'Parent', role: 'mom' },
        familyId: 'family-A',
        firebase: null,
      },
    }).catch(error => error)

    expect(failure).toBeInstanceOf(BabyInfoCommitClientError)
    expect(failure).toMatchObject({
      code: 'RECOVERY_REQUIRED',
      message: 'Baby Diary must restart to revalidate local settings.',
    })
  })
})
