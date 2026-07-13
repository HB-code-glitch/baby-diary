export type HealthContentLocale = 'ko' | 'ja'

export interface LocalizedHealthText {
  readonly ko: string
  readonly ja: string
}

interface HealthEvidenceSourceDefinition {
  readonly id: string
  readonly organization: LocalizedHealthText
  readonly title: LocalizedHealthText
  readonly url: string
  readonly reviewedOn: string
}

export const HEALTH_EVIDENCE_REVIEW_DATE = '2026-07-13' as const

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

const sourceDefinitions = [
  {
    id: 'who-infant-feeding',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '영아·유아 수유', ja: '乳幼児の栄養' },
    url: 'https://www.who.int/news-room/fact-sheets/detail/infant-and-young-child-feeding',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'who-complementary-feeding',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '생후 6~23개월 영유아 보충식 지침', ja: '生後6〜23か月児の補完食ガイドライン' },
    url: 'https://www.who.int/publications/i/item/9789240081864',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'who-under-five-activity',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '5세 미만 신체활동·좌식행동·수면 지침', ja: '5歳未満の身体活動・座位行動・睡眠ガイドライン' },
    url: 'https://www.who.int/publications/i/item/9789241550536',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-breastfeeding-frequency',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '모유 수유량과 수유 빈도', ja: '母乳を与える量と頻度' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-formula-feeding',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '분유 수유량과 수유 빈도', ja: '育児用ミルクを与える量と頻度' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-hunger-fullness-cues',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '배고픔과 배부름 신호', ja: '空腹と満腹のサイン' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/mealtime/signs-your-child-is-hungry-or-full.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-complementary-foods',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '고형식 시작 시기·종류·방법', ja: '離乳食を始める時期・内容・方法' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-iron',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '영유아 철분', ja: '乳幼児の鉄' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/iron.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-vitamin-d',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '영유아 비타민 D', ja: '乳幼児のビタミンD' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/vitamins-minerals/vitamin-d.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-choking',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '영유아 질식 위험 식품', ja: '乳幼児の窒息リスクがある食品' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/choking-hazards.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-foods-to-avoid',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '피하거나 제한할 식품과 음료', ja: '避ける・控える食品と飲み物' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/foods-and-drinks-to-avoid-or-limit.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-developmental-milestones',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '발달 이정표: 징후를 배우고 일찍 행동하기', ja: '発達の目安：兆候を知って早めに行動' },
    url: 'https://www.cdc.gov/act-early/milestones/index.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-developmental-screening',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '발달 관찰과 선별검사', ja: '発達の観察とスクリーニング' },
    url: 'https://www.cdc.gov/act-early/about/developmental-monitoring-and-screening.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-child-oral-health',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '어린이 구강 건강', ja: '子どもの口腔保健' },
    url: 'https://www.cdc.gov/oral-health/prevention/oral-health-tips-for-children.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-picky-eaters',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '편식하는 아이 돕기', ja: '好き嫌いのある子どもへの対応' },
    url: 'https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/picky-eaters.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'nichd-safe-sleep',
    organization: { ko: '미국 국립아동보건·인간발달연구소(NICHD)', ja: '米国国立小児保健・人間発達研究所（NICHD）' },
    title: { ko: 'Safe to Sleep 안전 수면 안내', ja: 'Safe to Sleep 安全な睡眠の案内' },
    url: 'https://safetosleep.nichd.nih.gov/reduce-risk/FAQ',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'niaid-peanut-allergy',
    organization: { ko: '미국 국립알레르기·감염병연구소(NIAID)', ja: '米国国立アレルギー・感染症研究所（NIAID）' },
    title: { ko: '땅콩 알레르기 예방 지침: 보호자용 요약', ja: 'ピーナッツアレルギー予防ガイドライン：保護者向け要約' },
    url: 'https://www.niaid.nih.gov/sites/default/files/peanut-allergy-prevention-guidelines-parent-summary.pdf',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'aap-safe-sleep-2022',
    organization: { ko: '미국소아과학회(AAP)', ja: '米国小児科学会（AAP）' },
    title: { ko: '수면 관련 영아 사망 예방 권고(2022)', ja: '睡眠関連乳児死亡の予防勧告（2022）' },
    url: 'https://publications.aap.org/pediatrics/article/150/1/e2022057990/188304/Sleep-Related-Infant-Deaths-Updated-2022',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'aap-fever-baby',
    organization: { ko: '미국소아과학회(AAP)', ja: '米国小児科学会（AAP）' },
    title: { ko: '아기의 발열: 소아청소년과에 연락할 때', ja: '赤ちゃんの発熱：小児科へ連絡する目安' },
    url: 'https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'nice-fever-ng143',
    organization: { ko: '영국 국립보건임상연구원(NICE)', ja: '英国国立医療技術評価機構（NICE）' },
    title: { ko: '5세 미만 발열 평가와 초기 관리(NG143)', ja: '5歳未満の発熱：評価と初期対応（NG143）' },
    url: 'https://www.nice.org.uk/guidance/ng143/chapter/recommendations',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'nice-newborn-red-flags-ng194',
    organization: { ko: '영국 국립보건임상연구원(NICE)', ja: '英国国立医療技術評価機構（NICE）' },
    title: { ko: '산후 관리: 신생아 위험 신호(NG194)', ja: '産後ケア：新生児の危険サイン（NG194）' },
    url: 'https://www.nice.org.uk/guidance/ng194/chapter/recommendations',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kdca-infant-nutrition',
    organization: { ko: '질병관리청 국가건강정보포털', ja: '韓国疾病管理庁 国家健康情報ポータル' },
    title: { ko: '영유아 영양', ja: '乳幼児の栄養' },
    url: 'https://health.kdca.go.kr/healthinfo/biz/health/gnrlzHealthInfo/gnrlzHealthInfo/gnrlzHealthInfoView.do?cntnts_sn=5212',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kdca-infant-checkups',
    organization: { ko: '질병관리청 국가건강정보포털', ja: '韓国疾病管理庁 国家健康情報ポータル' },
    title: { ko: '영유아 건강검진 로드맵', ja: '乳幼児健康診査ロードマップ' },
    url: 'https://health.kdca.go.kr/healthinfo/biz/health/ntcnInfo/healthSourc/thtimtCntnts/thtimtCntntsView.do?thtimt_cntnts_sn=131',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kdca-vaccination',
    organization: { ko: '질병관리청 예방접종도우미', ja: '韓国疾病管理庁 予防接種ヘルパー' },
    title: { ko: '국가예방접종 일정 안내', ja: '国家予防接種スケジュール案内' },
    url: 'https://nip.kdca.go.kr/irhp/infm/goVcntInfo.do?menuCd=131&menuLv=1',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-safe-sleep',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '영아돌연사증후군 예방과 안전 수면', ja: '乳幼児突然死症候群の予防と安全な睡眠' },
    url: 'https://www.cfa.go.jp/policies/boshihoken/kenkou/sids',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-infant-nutrition',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '영유아기 영양과 식생활 교육', ja: '乳幼児期の栄養と食育' },
    url: 'https://www.cfa.go.jp/policies/boshihoken/eiyou/',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-accident-prevention',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '어린이 사고 예방 안내서', ja: '子どもの事故防止ハンドブック' },
    url: 'https://www.cfa.go.jp/policies/child-safety-actions/handbook',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-infant-checkups',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '영유아 건강검진', ja: '乳幼児健康診査' },
    url: 'https://www.cfa.go.jp/policies/boshihoken/nyuyojikenshin',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-one-month-checkup',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '1개월 영아 건강검진 매뉴얼', ja: '1か月児健康診査マニュアル' },
    url: 'https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/d4a9b67b-acbd-4e2a-a27a-7e8f2d6106dd/d1e17788/20250107_policies_boshihoken_tsuuchi_2024_113.pdf',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'mhlw-feeding-weaning',
    organization: { ko: '일본 후생노동성', ja: '厚生労働省' },
    title: { ko: '수유·이유 지원 가이드(2019 개정)', ja: '授乳・離乳の支援ガイド（2019年改定版）' },
    url: 'https://www.mhlw.go.jp/stf/newpage_04250.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'mhlw-vaccination',
    organization: { ko: '일본 후생노동성', ja: '厚生労働省' },
    title: { ko: '예방접종 정보', ja: '予防接種情報' },
    url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/kenkou/kekkaku-kansenshou/yobou-sesshu/index.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'who-healthy-diet',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '건강한 식생활', ja: '健康的な食事' },
    url: 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kr-nfa-119',
    organization: { ko: '대한민국 소방청', ja: '韓国消防庁' },
    title: { ko: '119 신고 안내', ja: '韓国の119番通報案内' },
    url: 'https://nfa.go.kr/nfa/safetyinfo/emergencyservice/119emergencydeclaration',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'jp-fdma-119',
    organization: { ko: '일본 총무성 소방청', ja: '総務省消防庁' },
    title: { ko: '일본 119 신고 안내', ja: '119番緊急通報' },
    url: 'https://www.fdma.go.jp/mission/enrichment/kyukyumusen_kinkyutuhou/119.html',
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
] as const satisfies readonly HealthEvidenceSourceDefinition[]

export type HealthEvidenceSourceId = (typeof sourceDefinitions)[number]['id']

export interface HealthEvidenceSource extends HealthEvidenceSourceDefinition {
  readonly id: HealthEvidenceSourceId
}

export const HEALTH_EVIDENCE_SOURCES: readonly HealthEvidenceSource[] = Object.freeze(
  sourceDefinitions.map(source => Object.freeze({
    ...source,
    organization: Object.freeze({ ...source.organization }),
    title: Object.freeze({ ...source.title }),
  }))
)

const sourcesById = new Map<string, HealthEvidenceSource>(
  HEALTH_EVIDENCE_SOURCES.map(source => [source.id, source])
)

/**
 * Shared fail-closed resolver used by both the renderer and Electron main.
 * URL-shaped input is intentionally not accepted: callers send only a known ID.
 */
export function getEvidenceSourceById(sourceId: string): HealthEvidenceSource | null {
  return sourcesById.get(sourceId) ?? null
}

export interface LocalizedEvidenceSource {
  readonly id: HealthEvidenceSourceId
  readonly organization: string
  readonly title: string
  readonly url: string
  readonly reviewedOn: string
}

export function getEvidenceSources(
  ids: readonly HealthEvidenceSourceId[],
  locale: HealthContentLocale
): readonly LocalizedEvidenceSource[] {
  return Object.freeze(ids.map(id => {
    const source = getEvidenceSourceById(id)
    if (!source) {
      throw new Error(`Unknown health evidence source: ${id}`)
    }

    return Object.freeze({
      id: source.id,
      organization: source.organization[locale],
      title: source.title[locale],
      url: source.url,
      reviewedOn: source.reviewedOn,
    })
  }))
}
