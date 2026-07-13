import { describe, expect, it } from 'vitest'
import {
  HEALTH_EVIDENCE_REVIEW_DATE,
  HEALTH_EVIDENCE_SOURCES,
  OFFICIAL_EVIDENCE_HOSTS,
  getEvidenceSourceById,
  getEvidenceSources,
} from '../shared/healthEvidence'

const requiredSourceIds = [
  'who-infant-feeding',
  'who-complementary-feeding',
  'who-under-five-activity',
  'cdc-breastfeeding-frequency',
  'cdc-formula-feeding',
  'cdc-hunger-fullness-cues',
  'cdc-complementary-foods',
  'cdc-iron',
  'cdc-vitamin-d',
  'cdc-choking',
  'cdc-foods-to-avoid',
  'cdc-developmental-milestones',
  'cdc-developmental-screening',
  'cdc-child-oral-health',
  'cdc-picky-eaters',
  'nichd-safe-sleep',
  'niaid-peanut-allergy',
  'aap-safe-sleep-2022',
  'nice-fever-ng143',
  'nice-newborn-red-flags-ng194',
  'kdca-infant-nutrition',
  'kdca-infant-checkups',
  'kdca-vaccination',
  'cfa-safe-sleep',
  'cfa-infant-nutrition',
  'cfa-accident-prevention',
  'cfa-infant-checkups',
  'cfa-one-month-checkup',
  'mhlw-feeding-weaning',
  'mhlw-vaccination',
  'who-healthy-diet',
  'kr-nfa-119',
  'jp-fdma-119',
] as const

const retiredCommercialHosts = [
  'kellymom.com',
  'kidshealth.org',
  'mamanoko.jp',
  'seattlechildrens.org',
  'healthychildren.org',
  'nemours.org',
]

describe('HEALTH_EVIDENCE_SOURCES', () => {
  it('contains every authority source required by the design', () => {
    const ids = new Set(HEALTH_EVIDENCE_SOURCES.map(source => source.id))
    for (const id of requiredSourceIds) {
      expect(ids.has(id), `missing ${id}`).toBe(true)
    }
  })

  it('uses unique IDs and the shared review date', () => {
    const ids = HEALTH_EVIDENCE_SOURCES.map(source => source.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(HEALTH_EVIDENCE_REVIEW_DATE).toBe('2026-07-13')
    for (const source of HEALTH_EVIDENCE_SOURCES) {
      expect(source.reviewedOn).toBe(HEALTH_EVIDENCE_REVIEW_DATE)
    }
  })

  it('uses only HTTPS URLs on approved authority hosts', () => {
    for (const source of HEALTH_EVIDENCE_SOURCES) {
      const url = new URL(source.url)
      expect(url.protocol, source.id).toBe('https:')
      expect(OFFICIAL_EVIDENCE_HOSTS, source.id).toContain(url.hostname)
      expect(retiredCommercialHosts, source.id).not.toContain(url.hostname)
    }
  })

  it('has complete Korean and Japanese display metadata', () => {
    for (const source of HEALTH_EVIDENCE_SOURCES) {
      expect(source.organization.ko.trim(), `${source.id} ko org`).not.toBe('')
      expect(source.organization.ja.trim(), `${source.id} ja org`).not.toBe('')
      expect(source.title.ko.trim(), `${source.id} ko title`).not.toBe('')
      expect(source.title.ja.trim(), `${source.id} ja title`).not.toBe('')
      expect('published' in source, `${source.id} must not carry a guessed date`).toBe(false)
    }
  })

  it('uses the verified current CDC child oral-health path', () => {
    const source = HEALTH_EVIDENCE_SOURCES.find(item => item.id === 'cdc-child-oral-health')
    expect(source?.url).toBe(
      'https://www.cdc.gov/oral-health/prevention/oral-health-tips-for-children.html'
    )
  })

  it('uses exact official emergency-service URLs for Korean and Japanese 119', () => {
    expect(getEvidenceSourceById('kr-nfa-119')?.url).toBe(
      'https://nfa.go.kr/nfa/safetyinfo/emergencyservice/119emergencydeclaration'
    )
    expect(getEvidenceSourceById('jp-fdma-119')?.url).toBe(
      'https://www.fdma.go.jp/mission/enrichment/kyukyumusen_kinkyutuhou/119.html'
    )
  })

  it('returns localized immutable display records in caller order', () => {
    const ids = ['who-infant-feeding', 'cfa-safe-sleep'] as const
    const ko = getEvidenceSources(ids, 'ko')
    const ja = getEvidenceSources(ids, 'ja')

    expect(ko.map(source => source.id)).toEqual(ids)
    expect(ja.map(source => source.id)).toEqual(ids)
    expect(ko[0].organization).toContain('세계보건기구')
    expect(ja[1].organization).toContain('こども家庭庁')
    expect(Object.isFrozen(ko)).toBe(true)
    expect(Object.isFrozen(ko[0])).toBe(true)
  })

  it('fails closed when an unknown source ID reaches the runtime helper', () => {
    expect(() => getEvidenceSources(['missing-source'] as never, 'ko')).toThrow(
      /Unknown health evidence source/
    )
  })

  it('resolves only a known source ID to the exact registry record', () => {
    const known = getEvidenceSourceById('who-infant-feeding')
    expect(known).toBe(HEALTH_EVIDENCE_SOURCES[0])
    expect(getEvidenceSourceById('https://www.who.int/')).toBeNull()
    expect(getEvidenceSourceById('missing-source')).toBeNull()
  })
})
