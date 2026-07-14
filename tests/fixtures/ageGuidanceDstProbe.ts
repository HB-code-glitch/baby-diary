import { calculateAgeInCompletedDays } from '../../src/lib/ageGuidance'

const springStart = new Date(2026, 2, 8, 0, 0, 0)
const springEnd = new Date(2026, 2, 9, 0, 0, 0)
const fallStart = new Date(2026, 10, 1, 0, 0, 0)
const fallEnd = new Date(2026, 10, 2, 0, 0, 0)

process.stdout.write(JSON.stringify({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  springHours: (springEnd.getTime() - springStart.getTime()) / 3_600_000,
  fallHours: (fallEnd.getTime() - fallStart.getTime()) / 3_600_000,
  springDays: calculateAgeInCompletedDays('2026-03-08', springEnd),
  fallDays: calculateAgeInCompletedDays('2026-11-01', fallEnd),
}))
