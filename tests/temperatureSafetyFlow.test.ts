import { describe, expect, it, vi } from 'vitest'
import * as homeModule from '../src/pages/HomePage'

describe('urgent temperature presentation and persistence', () => {
  it('shows safety UI before persistence and reports persistence failure separately', async () => {
    expect(homeModule).toHaveProperty('presentTemperatureSafetyThenPersist')
    const presentTemperatureSafetyThenPersist = (homeModule as {
      presentTemperatureSafetyThenPersist: (actions: {
        presentSafety: () => void
        persist: () => Promise<void>
        onPersistError: () => void
      }) => Promise<void>
    }).presentTemperatureSafetyThenPersist

    const order: string[] = []
    await presentTemperatureSafetyThenPersist({
      presentSafety: () => order.push('safety'),
      persist: async () => {
        order.push('persist')
        throw new Error('disk unavailable')
      },
      onPersistError: () => order.push('error-toast'),
    })

    expect(order).toEqual(['safety', 'persist', 'error-toast'])
  })

  it('does not call the persistence-error callback after a successful write', async () => {
    expect(homeModule).toHaveProperty('presentTemperatureSafetyThenPersist')
    const fn = (homeModule as any).presentTemperatureSafetyThenPersist as (actions: any) => Promise<void>
    const onPersistError = vi.fn()
    await fn({
      presentSafety: vi.fn(),
      persist: async () => undefined,
      onPersistError,
    })
    expect(onPersistError).not.toHaveBeenCalled()
  })
})
