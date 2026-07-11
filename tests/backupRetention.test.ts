import { describe, it, expect } from 'vitest'
import { selectBackupsToPrune } from '../electron/store/backup'

// Helper: create a timestamp name for a given date + hour
function ts(year: number, month: number, day: number, hour = 0): string {
  const d = new Date(Date.UTC(year, month - 1, day, hour, 0, 0))
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

const NOW = new Date('2026-07-12T12:00:00Z')

describe('selectBackupsToPrune', () => {
  it('returns empty array when no backups exist', () => {
    expect(selectBackupsToPrune([], NOW)).toEqual([])
  })

  it('keeps all backups within last 90 days untouched', () => {
    const names = [
      ts(2026, 7, 12),  // today
      ts(2026, 7, 1),   // 11 days ago
      ts(2026, 4, 13),  // exactly 90 days ago (should keep)
    ]
    expect(selectBackupsToPrune(names, NOW)).toEqual([])
  })

  it('prunes old backups keeping only 1 per calendar month', () => {
    // 2026-01 has 3 backups (all older than 90 days from 2026-07-12 cutoff = 2026-04-13)
    const jan = [
      ts(2026, 1, 1),
      ts(2026, 1, 15),
      ts(2026, 1, 31),  // newest in Jan -- keep this one
    ]
    const toPrune = selectBackupsToPrune(jan, NOW)
    // Should prune the 2 older ones, keep the newest
    expect(toPrune).toHaveLength(2)
    expect(toPrune).toContain(ts(2026, 1, 1))
    expect(toPrune).toContain(ts(2026, 1, 15))
    expect(toPrune).not.toContain(ts(2026, 1, 31))
  })

  it('keeps exactly 1 per month even with many old backups', () => {
    const names = [
      // Dec 2025 -- 5 backups (all > 90 days old from 2026-07-12)
      ts(2025, 12, 1),
      ts(2025, 12, 8),
      ts(2025, 12, 15),
      ts(2025, 12, 22),
      ts(2025, 12, 31),  // newest Dec -> keep
      // Nov 2025 -- 2 backups
      ts(2025, 11, 10),
      ts(2025, 11, 28),  // newest Nov -> keep
    ]
    const toPrune = selectBackupsToPrune(names, NOW)
    // 4 Dec + 1 Nov = 5 pruned; 2 kept
    expect(toPrune).toHaveLength(5)
    expect(toPrune).not.toContain(ts(2025, 12, 31))
    expect(toPrune).not.toContain(ts(2025, 11, 28))
  })

  it('never prunes backups within 90-day window even if multiple per day', () => {
    const names = [
      ts(2026, 7, 12, 6),   // today 06:00
      ts(2026, 7, 12, 12),  // today 12:00
      ts(2026, 7, 11, 6),   // yesterday
    ]
    expect(selectBackupsToPrune(names, NOW)).toEqual([])
  })

  it('90-day boundary: backup on cutoff day is kept', () => {
    // cutoff = 2026-07-12 - 90 days = 2026-04-13
    const cutoffDay = ts(2026, 4, 13)
    const toPrune = selectBackupsToPrune([cutoffDay], NOW)
    expect(toPrune).not.toContain(cutoffDay)
  })

  it('backup 91 days old is candidate for monthly pruning', () => {
    // 91 days before 2026-07-12 = 2026-04-12
    const oldBackup = ts(2026, 4, 12)
    const anotherSameMonth = ts(2026, 4, 1)  // older
    // Apr has 2 backups, both > 90 days old; keep newest (Apr 12), prune Apr 1
    const toPrune = selectBackupsToPrune([oldBackup, anotherSameMonth], NOW)
    expect(toPrune).toHaveLength(1)
    expect(toPrune).toContain(anotherSameMonth)
    expect(toPrune).not.toContain(oldBackup)
  })

  it('ignores names that do not match timestamp pattern (non-timestamp dirs)', () => {
    const names = ['not-a-timestamp', ts(2025, 12, 31), 'README']
    // Only ts(2025, 12, 31) is old and single in its month -- nothing to prune there
    const toPrune = selectBackupsToPrune(names, NOW)
    expect(toPrune).not.toContain('not-a-timestamp')
    expect(toPrune).not.toContain('README')
  })
})
