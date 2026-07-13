export type HealthContentLocale = 'ko' | 'ja'

export interface LocalizedHealthText {
  readonly ko: string
  readonly ja: string
}

interface HealthEvidenceSourceDefinition {
  readonly id: string
  readonly organization: LocalizedHealthText
  readonly title: LocalizedHealthText
  readonly reviewedOn: string
}

export const HEALTH_EVIDENCE_REVIEW_DATE = '2026-07-13' as const

const sourceDefinitions = [
  {
    id: 'who-infant-feeding',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '영아·유아 수유', ja: '乳幼児の栄養' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'who-complementary-feeding',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '생후 6~23개월 영유아 보충식 지침', ja: '生後6〜23か月児の補完食ガイドライン' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'who-under-five-activity',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '5세 미만 신체활동·좌식행동·수면 지침', ja: '5歳未満の身体活動・座位行動・睡眠ガイドライン' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-breastfeeding-frequency',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '모유 수유량과 수유 빈도', ja: '母乳を与える量と頻度' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-formula-feeding',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '분유 수유량과 수유 빈도', ja: '育児用ミルクを与える量と頻度' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-hunger-fullness-cues',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '배고픔과 배부름 신호', ja: '空腹と満腹のサイン' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-complementary-foods',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '고형식 시작 시기·종류·방법', ja: '離乳食を始める時期・内容・方法' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-iron',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '영유아 철분', ja: '乳幼児の鉄' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-vitamin-d',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '영유아 비타민 D', ja: '乳幼児のビタミンD' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-choking',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '영유아 질식 위험 식품', ja: '乳幼児の窒息リスクがある食品' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-foods-to-avoid',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '피하거나 제한할 식품과 음료', ja: '避ける・控える食品と飲み物' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-developmental-milestones',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '발달 이정표: 징후를 배우고 일찍 행동하기', ja: '発達の目安：兆候を知って早めに行動' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-developmental-screening',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '발달 관찰과 선별검사', ja: '発達の観察とスクリーニング' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-child-oral-health',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '어린이 구강 건강', ja: '子どもの口腔保健' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cdc-picky-eaters',
    organization: { ko: '미국 질병통제예방센터(CDC)', ja: '米国疾病予防管理センター（CDC）' },
    title: { ko: '편식하는 아이 돕기', ja: '好き嫌いのある子どもへの対応' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'nichd-safe-sleep',
    organization: { ko: '미국 국립아동보건·인간발달연구소(NICHD)', ja: '米国国立小児保健・人間発達研究所（NICHD）' },
    title: { ko: 'Safe to Sleep 안전 수면 안내', ja: 'Safe to Sleep 安全な睡眠の案内' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'niaid-peanut-allergy',
    organization: { ko: '미국 국립알레르기·감염병연구소(NIAID)', ja: '米国国立アレルギー・感染症研究所（NIAID）' },
    title: { ko: '땅콩 알레르기 예방 지침: 보호자용 요약', ja: 'ピーナッツアレルギー予防ガイドライン：保護者向け要約' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'aap-safe-sleep-2022',
    organization: { ko: '미국소아과학회(AAP)', ja: '米国小児科学会（AAP）' },
    title: { ko: '수면 관련 영아 사망 예방 권고(2022)', ja: '睡眠関連乳児死亡の予防勧告（2022）' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'aap-fever-baby',
    organization: { ko: '미국소아과학회(AAP)', ja: '米国小児科学会（AAP）' },
    title: { ko: '아기의 발열: 소아청소년과에 연락할 때', ja: '赤ちゃんの発熱：小児科へ連絡する目安' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'nice-fever-ng143',
    organization: { ko: '영국 국립보건임상연구원(NICE)', ja: '英国国立医療技術評価機構（NICE）' },
    title: { ko: '5세 미만 발열 평가와 초기 관리(NG143)', ja: '5歳未満の発熱：評価と初期対応（NG143）' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'nice-newborn-red-flags-ng194',
    organization: { ko: '영국 국립보건임상연구원(NICE)', ja: '英国国立医療技術評価機構（NICE）' },
    title: { ko: '산후 관리: 신생아 위험 신호(NG194)', ja: '産後ケア：新生児の危険サイン（NG194）' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kdca-infant-nutrition',
    organization: { ko: '질병관리청 국가건강정보포털', ja: '韓国疾病管理庁 国家健康情報ポータル' },
    title: { ko: '영유아 영양', ja: '乳幼児の栄養' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kdca-infant-checkups',
    organization: { ko: '질병관리청 국가건강정보포털', ja: '韓国疾病管理庁 国家健康情報ポータル' },
    title: { ko: '영유아 건강검진 로드맵', ja: '乳幼児健康診査ロードマップ' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kdca-vaccination',
    organization: { ko: '질병관리청 예방접종도우미', ja: '韓国疾病管理庁 予防接種ヘルパー' },
    title: { ko: '국가예방접종 일정 안내', ja: '国家予防接種スケジュール案内' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-safe-sleep',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '영아돌연사증후군 예방과 안전 수면', ja: '乳幼児突然死症候群の予防と安全な睡眠' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-infant-nutrition',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '영유아기 영양과 식생활 교육', ja: '乳幼児期の栄養と食育' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-accident-prevention',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '어린이 사고 예방 안내서', ja: '子どもの事故防止ハンドブック' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-infant-checkups',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '영유아 건강검진', ja: '乳幼児健康診査' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'cfa-one-month-checkup',
    organization: { ko: '일본 어린이가정청', ja: 'こども家庭庁' },
    title: { ko: '1개월 영아 건강검진 매뉴얼', ja: '1か月児健康診査マニュアル' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'mhlw-feeding-weaning',
    organization: { ko: '일본 후생노동성', ja: '厚生労働省' },
    title: { ko: '수유·이유 지원 가이드(2019 개정)', ja: '授乳・離乳の支援ガイド（2019年改定版）' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'mhlw-vaccination',
    organization: { ko: '일본 후생노동성', ja: '厚生労働省' },
    title: { ko: '예방접종 정보', ja: '予防接種情報' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'who-healthy-diet',
    organization: { ko: '세계보건기구(WHO)', ja: '世界保健機関（WHO）' },
    title: { ko: '건강한 식생활', ja: '健康的な食事' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'kr-nfa-119',
    organization: { ko: '대한민국 소방청', ja: '韓国消防庁' },
    title: { ko: '119 신고 안내', ja: '韓国の119番通報案内' },
    reviewedOn: HEALTH_EVIDENCE_REVIEW_DATE,
  },
  {
    id: 'jp-fdma-119',
    organization: { ko: '일본 총무성 소방청', ja: '総務省消防庁' },
    title: { ko: '일본 119 신고 안내', ja: '119番緊急通報' },
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
 * Renderer-safe display metadata resolver. URL-shaped input is intentionally
 * not accepted, and this module never contains or returns an external URL.
 */
export function getEvidenceSourceById(sourceId: string): HealthEvidenceSource | null {
  return sourcesById.get(sourceId) ?? null
}

export interface LocalizedEvidenceSource {
  readonly id: HealthEvidenceSourceId
  readonly organization: string
  readonly title: string
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
      reviewedOn: source.reviewedOn,
    })
  }))
}
