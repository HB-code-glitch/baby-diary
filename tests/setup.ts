import { beforeEach } from 'vitest'

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(String(key))
  }

  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value))
  }
}

const storage = new MemoryStorage()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
})

beforeEach(() => {
  storage.clear()
})
