import { evaluateFever, getFeverAgeContext } from '../../src/lib/guidance'

const timestamp = '2026-07-14T00:00:00.000Z'

process.stdout.write(JSON.stringify({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateOnly: {
    day89: getFeverAgeContext('2026-03-01', '2026-05-29'),
    day90BeforeThreeMonths: getFeverAgeContext('2026-03-01', '2026-05-30'),
    threeMonthsBefore90Days: getFeverAgeContext('2026-01-31', '2026-04-30'),
    pastBoth: getFeverAgeContext('2026-01-31', '2026-05-01'),
    beforeSixMonths: getFeverAgeContext('2024-02-29', '2024-08-28'),
    sixMonths: getFeverAgeContext('2024-02-29', '2024-08-29'),
  },
  levels: {
    day89: evaluateFever({ celsius: 39, birthdate: '2026-03-01', measuredAt: '2026-05-29' }),
    day90BeforeThreeMonths: evaluateFever({ celsius: 39, birthdate: '2026-03-01', measuredAt: '2026-05-30' }),
    threeMonthsBefore90Days: evaluateFever({ celsius: 39, birthdate: '2026-01-31', measuredAt: '2026-04-30' }),
    pastBoth: evaluateFever({ celsius: 39, birthdate: '2026-01-31', measuredAt: '2026-05-01' }),
    beforeSixMonths: evaluateFever({ celsius: 39.4, birthdate: '2024-02-29', measuredAt: '2024-08-28' }),
    sixMonths: evaluateFever({ celsius: 39.4, birthdate: '2024-02-29', measuredAt: '2024-08-29' }),
  },
  timestamp: getFeverAgeContext('2026-04-15', timestamp),
  dateObject: getFeverAgeContext('2026-04-15', new Date(timestamp)),
}))
