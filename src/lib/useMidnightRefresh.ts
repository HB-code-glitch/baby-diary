/**
 * src/lib/useMidnightRefresh.ts
 *
 * P25: Hook that schedules a Zustand store `loadEvents()` call at local midnight
 * so today-derived selectors (todayEvents, todayPeeCount, D+ counter, stat bars)
 * automatically re-evaluate when the calendar date rolls over — without any
 * manual reload by the user.
 *
 * Usage: call once at the App root (covers Sidebar + all pages).
 */

import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

function msUntilMidnight(): number {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return midnight.getTime() - now.getTime()
}

export function useMidnightRefresh(): void {
  const loadEvents = useAppStore(s => s.loadEvents)

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>

    function scheduleNext() {
      const ms = msUntilMidnight()
      timeoutId = setTimeout(() => {
        // Reload events so all today-* selectors derive from the new calendar day.
        loadEvents().catch(err => console.error('[useMidnightRefresh] loadEvents failed:', err))
        // Schedule again for the following midnight.
        scheduleNext()
      }, ms)
    }

    scheduleNext()
    return () => clearTimeout(timeoutId)
  }, [loadEvents])
}
