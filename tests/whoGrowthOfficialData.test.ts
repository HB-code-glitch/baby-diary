import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LHFA_BOYS,
  LHFA_GIRLS,
  WFA_BOYS,
  WFA_GIRLS,
  type LmsPoint,
} from '../src/lib/whoGrowthData'

const MANIFEST_PATH = join(
  process.cwd(),
  'tests',
  'fixtures',
  'who-growth-standards.manifest.json',
)

type SeriesId = 'WFA_BOYS' | 'WFA_GIRLS' | 'LHFA_BOYS' | 'LHFA_GIRLS'

interface OfficialSeries {
  readonly rows: readonly LmsPoint[]
}

interface WhoGrowthManifest {
  readonly sources: Readonly<Record<SeriesId, OfficialSeries>>
}

const APP_SERIES = {
  WFA_BOYS,
  WFA_GIRLS,
  LHFA_BOYS,
  LHFA_GIRLS,
} as const satisfies Readonly<Record<SeriesId, readonly LmsPoint[]>>

function readManifest(): WhoGrowthManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as WhoGrowthManifest
}

describe('official WHO growth standards manifest', () => {
  it('is committed for offline verification', () => {
    expect(existsSync(MANIFEST_PATH), MANIFEST_PATH).toBe(true)
  })

  it('pins the four official workbook URLs and SHA-256 digests reviewed on 2026-07-13', () => {
    const manifest = readManifest()

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      reviewedOn: '2026-07-13',
      authority: 'World Health Organization',
      extraction: {
        sheetIndex: 0,
        columns: ['Month', 'L', 'M', 'S'],
        completedMonths: { min: 0, max: 24, inclusive: true },
        expectedSeries: 4,
        expectedRowsPerSeries: 25,
        expectedTotalRows: 100,
      },
      sources: {
        WFA_BOYS: {
          indicator: 'weight-for-age',
          sex: 'boys',
          pageUrl: 'https://www.who.int/tools/child-growth-standards/standards/weight-for-age',
          downloadUrl: 'https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/wfa_boys_0-to-5-years_zscores.xlsx?sfvrsn=97a05331_9',
          sha256: 'f8f5a77b944ff7a8c1524e76f9d33f8a93cc423d23c2e7f2b10ba6b96a428e69',
          worksheet: 'wfa_boys_0 to 5 years_zscores',
        },
        WFA_GIRLS: {
          indicator: 'weight-for-age',
          sex: 'girls',
          pageUrl: 'https://www.who.int/tools/child-growth-standards/standards/weight-for-age',
          downloadUrl: 'https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/wfa_girls_0-to-5-years_zscores.xlsx?sfvrsn=4c03b8db_7',
          sha256: '01e9a6fda2f3723dbc74d3c86bfbfcb9f6d474367d1d7b4a804501a2debd2ef1',
          worksheet: 'wfa_girls_0 to 5 years_zscores',
        },
        LHFA_BOYS: {
          indicator: 'length-for-age',
          sex: 'boys',
          pageUrl: 'https://www.who.int/tools/child-growth-standards/standards/length-height-for-age',
          downloadUrl: 'https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/lhfa_boys_0-to-2-years_zscores.xlsx?sfvrsn=30e044c_9',
          sha256: 'ccfd8e455141c9a39dd728d99b7d7e080a925b06ea4a4d7592229665713dba54',
          worksheet: 'lhfa_boys_0 to 2 years_zscores',
        },
        LHFA_GIRLS: {
          indicator: 'length-for-age',
          sex: 'girls',
          pageUrl: 'https://www.who.int/tools/child-growth-standards/standards/length-height-for-age',
          downloadUrl: 'https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/lhfa_girls_0-to-2-years_zscores.xlsx?sfvrsn=e9e66a95_11',
          sha256: '6757f5eb96b51ab5cdb4828105929c78b1fb3d73b0fd8fa65682ad9f60f8c083',
          worksheet: 'lhfa_girls_0 to 2 years_zscores',
        },
      },
    })
  })

  it('matches all 100 official 0-24 month LMS rows exactly, without rounding tolerance', () => {
    const manifest = readManifest()
    const seriesIds = Object.keys(APP_SERIES) as SeriesId[]

    expect(Object.keys(manifest.sources)).toEqual(seriesIds)

    let totalRows = 0
    for (const seriesId of seriesIds) {
      const officialRows = manifest.sources[seriesId].rows
      totalRows += officialRows.length

      expect(officialRows, seriesId).toHaveLength(25)
      expect(officialRows.map(row => row.month), `${seriesId} months`).toEqual(
        Array.from({ length: 25 }, (_, month) => month),
      )
      expect(APP_SERIES[seriesId], `${seriesId} L/M/S`).toEqual(officialRows)
    }

    expect(totalRows).toBe(100)
  })
})
