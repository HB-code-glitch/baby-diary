import type { HealthEvidenceSourceId } from '../shared/healthEvidence'

export const OFFICIAL_EVIDENCE_HOSTS = Object.freeze([
  'www.who.int',
  'www.cdc.gov',
  'safetosleep.nichd.nih.gov',
  'www.niaid.nih.gov',
  'publications.aap.org',
  'www.healthychildren.org',
  'www.nice.org.uk',
  'health.kdca.go.kr',
  'nip.kdca.go.kr',
  'www.cfa.go.jp',
  'www.mhlw.go.jp',
  'nfa.go.kr',
  'www.fdma.go.jp',
] as const)

const evidenceUrlDefinitions = {
  'who-infant-feeding': 'https://www.who.int/news-room/fact-sheets/detail/infant-and-young-child-feeding',
  'who-complementary-feeding': 'https://www.who.int/publications/i/item/9789240081864',
  'who-under-five-activity': 'https://www.who.int/publications/i/item/9789241550536',
  'cdc-breastfeeding-frequency': 'https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html',
  'cdc-formula-feeding': 'https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html',
  'cdc-hunger-fullness-cues': 'https://www.cdc.gov/infant-toddler-nutrition/mealtime/signs-your-child-is-hungry-or-full.html',
  'cdc-complementary-foods': 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html',
  'cdc-iron': 'https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/iron.html',
  'cdc-vitamin-d': 'https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/vitamin-d.html',
  'cdc-choking': 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/choking-hazards.html',
  'cdc-foods-to-avoid': 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/foods-and-drinks-to-avoid-or-limit.html',
  'cdc-developmental-milestones': 'https://www.cdc.gov/act-early/milestones/index.html',
  'cdc-developmental-screening': 'https://www.cdc.gov/act-early/about/developmental-monitoring-and-screening.html',
  'cdc-child-oral-health': 'https://www.cdc.gov/oral-health/prevention/oral-health-tips-for-children.html',
  'cdc-picky-eaters': 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/picky-eaters.html',
  'nichd-safe-sleep': 'https://safetosleep.nichd.nih.gov/reduce-risk/FAQ',
  'niaid-peanut-allergy': 'https://www.niaid.nih.gov/sites/default/files/peanut-allergy-prevention-guidelines-parent-summary.pdf',
  'aap-safe-sleep-2022': 'https://publications.aap.org/pediatrics/article/150/1/e2022057990/188304/Sleep-Related-Infant-Deaths-Updated-2022',
  'aap-fever-baby': 'https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx',
  'nice-fever-ng143': 'https://www.nice.org.uk/guidance/ng143/chapter/recommendations',
  'nice-newborn-red-flags-ng194': 'https://www.nice.org.uk/guidance/ng194/chapter/recommendations',
  'kdca-infant-nutrition': 'https://health.kdca.go.kr/healthinfo/biz/health/gnrlzHealthInfo/gnrlzHealthInfo/gnrlzHealthInfoView.do?cntnts_sn=5212',
  'kdca-infant-checkups': 'https://health.kdca.go.kr/healthinfo/biz/health/ntcnInfo/healthSourc/thtimtCntnts/thtimtCntntsView.do?thtimt_cntnts_sn=131',
  'kdca-vaccination': 'https://nip.kdca.go.kr/irhp/infm/goVcntInfo.do?menuCd=131&menuLv=1',
  'cfa-safe-sleep': 'https://www.cfa.go.jp/policies/boshihoken/kenkou/sids',
  'cfa-infant-nutrition': 'https://www.cfa.go.jp/policies/boshihoken/eiyou/',
  'cfa-accident-prevention': 'https://www.cfa.go.jp/policies/child-safety-actions/handbook',
  'cfa-infant-checkups': 'https://www.cfa.go.jp/policies/boshihoken/nyuyojikenshin',
  'cfa-one-month-checkup': 'https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/d4a9b67b-acbd-4e2a-a27a-7e8f2d6106dd/d1e17788/20250107_policies_boshihoken_tsuuchi_2024_113.pdf',
  'mhlw-feeding-weaning': 'https://www.mhlw.go.jp/stf/newpage_04250.html',
  'mhlw-vaccination': 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/kenkou/kekkaku-kansenshou/yobou-sesshu/index.html',
  'who-healthy-diet': 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet',
  'kr-nfa-119': 'https://nfa.go.kr/nfa/safetyinfo/emergencyservice/119emergencydeclaration',
  'jp-fdma-119': 'https://www.fdma.go.jp/mission/enrichment/kyukyumusen_kinkyutuhou/119.html',
} as const satisfies Readonly<Record<HealthEvidenceSourceId, string>>

export const HEALTH_EVIDENCE_URLS: Readonly<Record<HealthEvidenceSourceId, string>> = Object.freeze({
  ...evidenceUrlDefinitions,
})

export function getEvidenceUrlById(sourceId: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(HEALTH_EVIDENCE_URLS, sourceId)) return null
  return HEALTH_EVIDENCE_URLS[sourceId as HealthEvidenceSourceId]
}
