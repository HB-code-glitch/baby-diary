/**
 * Temporary health-safety compatibility surface.
 *
 * Fixed-day feeding/calendar claims and legacy marker cards are retired.
 */
import {
  calculateAgeInCompletedDays,
  calculateCompletedCalendarMonths,
} from './ageGuidance'
import {
  HEALTH_EVIDENCE_SOURCES,
  getEvidenceSources,
  type HealthContentLocale,
  type HealthEvidenceSourceId,
} from './healthEvidence'

export interface GuidanceMarker {
  id: string
  startDay: number
  titleKo: string
  titleJa: string
  bodyKo: string
  bodyJa: string
  quoteKo?: string
  quoteJa?: string
  readonly sourceIds: readonly HealthEvidenceSourceId[]
  sourceLabel: string
  evidenceLevel: 'guideline-consensus' | 'RCT'
}

export interface GuidanceItem {
  id: string
  startDay: number
  titleKo: string
  titleJa: string
  bodyKo: string
  bodyJa: string
  source: string
  pinToSettings: boolean
}

export interface GuidanceDisclaimer {
  ko: string
  ja: string
}

export interface GuidanceSource {
  id: HealthEvidenceSourceId
  org: string
  title: string
  reviewedOn: string
}

export function getGuidanceSourceLabel(
  content: { readonly sourceIds: readonly HealthEvidenceSourceId[] },
  locale: HealthContentLocale,
): string {
  return getEvidenceSources(content.sourceIds, locale)
    .map(source => source.organization)
    .join(' · ')
}

/** Task 3 replaces the empty legacy Settings surface with ageGuidance. */
export const GUIDANCE_MARKERS: GuidanceMarker[] = []

export const GUIDANCE_DISCLAIMER: GuidanceDisclaimer = {
  ko: '일반 참고 정보이며 진단·처방이나 아이의 진료 계획을 대신하지 않아요. 걱정되면 의료진과 상의하세요.',
  ja: '一般的な参考情報であり、診断・処方やお子さんの診療計画に代わるものではありません。心配な場合は医療者へ相談してください。',
}

export const GUIDANCE_SOURCES: GuidanceSource[] = HEALTH_EVIDENCE_SOURCES.map(source => ({
  id: source.id,
  org: source.organization.ko,
  title: source.title.ko,
  reviewedOn: source.reviewedOn,
}))

/** Fixed-day History/calendar guidance is retired. */
export const GUIDANCE_ITEMS: GuidanceItem[] = []
export const GUIDANCE_DISCLAIMER_KO = GUIDANCE_DISCLAIMER.ko
export const GUIDANCE_DISCLAIMER_JA = GUIDANCE_DISCLAIMER.ja

export function getGuidanceForAge(
  _birthdate: string,
  _today: string | Date = new Date(),
): GuidanceMarker[] {
  return []
}

export interface CalendarGuidanceItem {
  marker: GuidanceMarker
  date: string
}

export function getCalendarGuidance(_birthdate: string): CalendarGuidanceItem[] {
  return []
}

export function getCurrentFormulaGuidance(_ageInDays: number): GuidanceItem | null {
  return null
}

export function getGuidanceForDay(_ageInDays: number): GuidanceItem[] {
  return []
}

/** Compatibility shape retained until Task 1 is integrated; no data is exposed. */
export interface FeedingBand {
  id: 'formula_0_1mo' | 'formula_1_2mo' | 'formula_2_3mo' | 'formula_3_6mo'
  perFeedMlMin: number
  perFeedMlMax: number
  feedsPerDayMin: number
  feedsPerDayMax: number
  dailyMaxMl: number | null
  perKgMlPerDayMin?: number
  perKgMlPerDayMax?: number
}

export const FEEDING_BANDS: FeedingBand[] = []
export function getFeedingBand(_ageDays: number): FeedingBand | null {
  return null
}

export interface FeverCareStep {
  ko: string
  ja: string
}

export type FeverRedFlagId =
  | 'pale_blue_or_mottled'
  | 'breathing_difficulty'
  | 'hard_to_wake'
  | 'non_blanching_rash'
  | 'seizure'
  | 'stiff_neck_or_bulging_fontanelle'
  | 'severe_dehydration'
  | 'bilious_or_projectile_vomiting'
  | 'poor_feeding'

export interface FeverRedFlag {
  id: FeverRedFlagId
  ko: string
  ja: string
  newbornOnly?: boolean
}

export const FEVER_RED_FLAGS: readonly FeverRedFlag[] = [
  { id: 'pale_blue_or_mottled', ko: '피부나 입술이 창백하거나 파랗고 얼룩덜룩해 보여요.', ja: '皮膚や唇が青白い、またはまだらに見えます。' },
  { id: 'breathing_difficulty', ko: '숨쉬기 힘들어하거나 끙끙거리고, 가슴이 심하게 들어가요.', ja: '呼吸が苦しそう、うなり声がある、胸が強くへこみます。' },
  { id: 'hard_to_wake', ko: '깨우기 어렵거나 평소와 달리 축 늘어져 반응이 적어요.', ja: '起こしにくい、ぐったりして普段より反応が乏しい状態です。' },
  { id: 'non_blanching_rash', ko: '투명한 컵으로 눌러도 옅어지지 않는 발진이 있어요.', ja: '透明なコップで押しても消えない発疹があります。' },
  { id: 'seizure', ko: '경련을 해요.', ja: 'けいれんがあります。' },
  { id: 'stiff_neck_or_bulging_fontanelle', ko: '목이 뻣뻣하거나 숨구멍이 불룩해 보여요.', ja: '首が硬い、または大泉門がふくらんで見えます。' },
  { id: 'severe_dehydration', ko: '소변이 뚜렷하게 줄고 입이 마르거나 눈물이 나지 않아요.', ja: '尿が明らかに減り、口が乾く、または涙が出ません。' },
  { id: 'bilious_or_projectile_vomiting', ko: '초록색 구토를 하거나 세게 뿜는 구토가 반복돼요.', ja: '緑色の嘔吐、または勢いよく噴き出す嘔吐を繰り返します。' },
  { id: 'poor_feeding', newbornOnly: true, ko: '신생아가 잘 먹지 못하거나 수유를 계속 거부해요.', ja: '新生児がうまく飲めない、または授乳を繰り返し拒みます。' },
] as const

export const FEVER_CARE: {
  readonly sourceIds: readonly HealthEvidenceSourceId[]
  steps: FeverCareStep[]
} = {
  sourceIds: Object.freeze(['nice-fever-ng143']),
  steps: [
    { ko: '모유·분유 등 연령에 맞는 수분을 자주 제공해요.', ja: '母乳・ミルクなど年齢に合う水分をこまめに与えます。' },
    { ko: '너무 벗기거나 두껍게 감싸지 말고 편안하게 입혀요.', ja: '脱がせすぎたり厚く包んだりせず、楽な服装にします。' },
    { ko: '호흡·반응·피부색·발진·탈수 신호를 살피고 상태가 나빠지면 바로 도움을 받아요.', ja: '呼吸・反応・皮膚の色・発疹・脱水サインを見守り、悪化したらすぐに助けを求めます。' },
  ],
}

export const FEVER_DURATION_GUIDANCE = {
  ko: '열이 5일 이상 계속되면 의료진의 평가를 받아요. 그 전이라도 걱정되는 증상이 있거나 상태가 나빠지면 바로 상담하세요.',
  ja: '発熱が5日以上続く場合は医療機関で評価を受けてください。それより前でも心配な症状や悪化があれば、すぐに相談してください。',
} as const

export type FeverLevel = 'emergency' | 'danger' | 'warning' | 'caution' | null

export interface FeverEvaluationInput {
  celsius: number
  birthdate: string | null
  measuredAt?: string | Date
  symptomIds?: readonly FeverRedFlagId[]
}

export interface FeverAgeContext {
  ageDays: number
  completedMonths: number
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function getFeverAgeContext(
  birthdate: string | null,
  measuredAt: string | Date = new Date(),
): FeverAgeContext | null {
  if (!birthdate) return null
  const measuredDate = typeof measuredAt === 'string' && !ISO_DATE_ONLY.test(measuredAt)
    ? new Date(measuredAt)
    : measuredAt
  const ageDays = calculateAgeInCompletedDays(birthdate, measuredDate)
  const completedMonths = calculateCompletedCalendarMonths(birthdate, measuredDate)
  if (ageDays === null || completedMonths === null) return null
  return { ageDays, completedMonths }
}

export function evaluateFever({
  celsius,
  birthdate,
  measuredAt,
  symptomIds = [],
}: FeverEvaluationInput): FeverLevel {
  const age = getFeverAgeContext(birthdate, measuredAt)
  const isNewborn = age != null && age.ageDays < 28
  const hasUrgentRedFlag = symptomIds.some(id => {
    const flag = FEVER_RED_FLAGS.find(item => item.id === id)
    return flag != null && (!flag.newbornOnly || isNewborn || age == null)
  })
  if (hasUrgentRedFlag) return 'emergency'
  if (!Number.isFinite(celsius)) return null

  if ((isNewborn || age == null) && celsius < 36) return 'emergency'
  if (celsius < 38) return null
  if (age == null) return 'emergency'
  if (age.ageDays < 90 || age.completedMonths < 3) return 'emergency'

  if (age.completedMonths >= 3 && age.completedMonths < 6) {
    if (celsius >= 39) return 'danger'
    if (celsius >= 38.3) return 'warning'
  }

  // For older babies, the UI asks for clinician contact at 39.4°C without
  // implying a serious diagnosis. Symptoms remain the primary urgency signal.
  if (age.completedMonths >= 6 && celsius >= 39.4) return 'warning'
  return 'caution'
}
