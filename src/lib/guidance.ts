/**
 * Temporary compatibility surface for views that have not yet migrated to
 * ageGuidance.ts. Fixed-day feeding/calendar claims are deliberately retired.
 */
import { HEALTH_EVIDENCE_SOURCES } from './healthEvidence'

export interface GuidanceMarker {
  id: string
  startDay: number
  titleKo: string
  titleJa: string
  bodyKo: string
  bodyJa: string
  quoteKo?: string
  quoteJa?: string
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
  id: string
  org: string
  title: string
  reviewedOn: string
  url: string
}

/**
 * FeverModal still consumes these three IDs. Task 2 replaces the prose parser
 * with structured red-flag arrays; no other legacy marker remains visible.
 */
export const GUIDANCE_MARKERS: GuidanceMarker[] = [
  {
    id: 'fever_under_3mo_emergency',
    startDay: 0,
    titleKo: '3개월 미만 발열은 즉시 의료기관에 연락',
    titleJa: '生後3か月未満の発熱は直ちに医療機関へ連絡',
    bodyKo: '생후 3개월 미만에서 기록 체온이 38.0°C 이상이면 겉보기에 괜찮아도 지금 의료기관에 연락해 평가받아요. 앱은 체온 측정 부위를 저장하지 않으므로 측정 방법을 의료진에게 함께 알려 주세요.',
    bodyJa: '生後3か月未満で記録した体温が38.0°C以上なら、元気そうに見えても今すぐ医療機関へ連絡し評価を受けてください。アプリは測定部位を保存しないため、測定方法も医療者へ伝えてください。',
    quoteKo: '생후 3개월 미만에서 기록 체온이 38.0°C 이상이면 지금 의료기관에 연락해요.',
    quoteJa: '生後3か月未満で記録した体温が38.0°C以上なら、今すぐ医療機関へ連絡してください。',
    sourceLabel: 'NICE NG143',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'fever_red_flags',
    startDay: 0,
    titleKo: '즉시 도움을 요청할 위험 신호',
    titleJa: '直ちに助けを求める危険サイン',
    bodyKo: '체온과 무관하게 즉시 응급 도움을 요청해요: 피부가 창백·얼룩·청색, 숨쉬기 힘듦 또는 끙끙거림, 깨우기 어렵거나 반응이 매우 떨어짐, 눌러도 사라지지 않는 발진, 경련, 목 경직 또는 대천문 팽창, 심한 탈수, 초록색 담즙성 또는 분출성 구토.',
    bodyJa: '体温に関係なく直ちに救急へ連絡してください: 青白い・まだら・青い皮膚, 呼吸困難またはうなり呼吸, 起こしにくい・反応が非常に弱い, 押しても消えない発疹, けいれん, 首のこわばりまたは大泉門の膨らみ, 重い脱水, 緑色の胆汁性または噴水状の嘔吐。',
    sourceLabel: 'NICE NG143 · NICE NG194',
    evidenceLevel: 'guideline-consensus',
  },
  {
    id: 'antipyretic_age_limits',
    startDay: 0,
    titleKo: '해열제는 불편함을 줄이기 위해 사용',
    titleJa: '解熱薬はつらさを和らげるために使用',
    bodyKo: '해열제는 체온 숫자만 낮추기 위해 쓰지 않고 아이가 힘들어할 때 제품 표시와 의료진·약사의 조언에 따라 사용해요. 앱은 용량을 안내하지 않아요. 3개월 미만 아기는 먼저 즉시 평가받고, 두 종류를 동시에 사용하지 않아요.',
    bodyJa: '解熱薬は体温の数字だけを下げる目的ではなく、子どもがつらい時に製品表示と医療者・薬剤師の助言に従って使います。アプリは用量を案内しません。3か月未満はまず直ちに評価を受け、2種類を同時に使いません。',
    quoteKo: '해열제는 체온 숫자만 낮추기 위해 쓰지 않아요.',
    quoteJa: '解熱薬は体温の数字だけを下げる目的では使いません。',
    sourceLabel: 'NICE NG143',
    evidenceLevel: 'guideline-consensus',
  },
]

export const GUIDANCE_DISCLAIMER: GuidanceDisclaimer = {
  ko: '이 안내는 일반적인 공중보건 지침이며 진단·처방이나 아이의 진료 계획을 대신하지 않아요. 미숙아는 의료진이 정한 교정 연령과 진료 계획을 우선하고, 건강·수유·성장·발달이 걱정되면 담당 의료진과 상의하세요.',
  ja: 'この案内は一般的な公衆衛生情報で、診断・処方やお子さんの診療計画に代わるものではありません。早産児は医療者が定めた修正月齢と診療計画を優先し、健康・授乳・成長・発達が心配な時は担当医療者へ相談してください。',
}

export const GUIDANCE_SOURCES: GuidanceSource[] = HEALTH_EVIDENCE_SOURCES.map(source => ({
  id: source.id,
  org: source.organization.ko,
  title: source.title.ko,
  reviewedOn: source.reviewedOn,
  url: source.url,
}))

/** History/calendar guidance now comes only from the calendar-month model. */
export const GUIDANCE_ITEMS: GuidanceItem[] = []

export const GUIDANCE_DISCLAIMER_KO = GUIDANCE_DISCLAIMER.ko
export const GUIDANCE_DISCLAIMER_JA = GUIDANCE_DISCLAIMER.ja

export function getGuidanceForAge(
  _birthdate: string,
  _today: string | Date = new Date()
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

/**
 * Kept only so the current popup compiles. Numeric quota bands are retired;
 * Task 2 replaces the popup with responsive feeding cues.
 */
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

export const FEVER_CARE: { steps: FeverCareStep[]; sourceLabel: string } = {
  sourceLabel: 'NICE NG143',
  steps: [
    {
      ko: '모유·분유 등 연령에 맞는 수분을 자주 제공해요.',
      ja: '母乳・ミルクなど年齢に合う水分をこまめに与えます。',
    },
    {
      ko: '너무 벗기거나 두껍게 감싸지 말고 편안하게 입혀요.',
      ja: '脱がせすぎたり厚く包んだりせず、楽な服装にします。',
    },
    {
      ko: '호흡·반응·피부색·발진·탈수 신호를 밤에도 확인해요.',
      ja: '呼吸・反応・皮膚の色・発疹・脱水サインを夜間も確認します。',
    },
    {
      ko: '상태가 나빠지거나 보호자가 걱정되면 더 일찍 의료진과 상의하고, 발열이 5일 이상이면 평가받아요.',
      ja: '悪化する、または保護者が心配なら早めに医療者へ相談し、発熱が5日以上続く場合は評価を受けます。',
    },
  ],
}

export type FeverLevel = 'emergency' | 'danger' | 'warning' | 'caution' | null

/** Legacy fever routing retained until the structured Task 2 safety function. */
export function evaluateFever(celsius: number, ageDays: number | null): FeverLevel {
  if (celsius < 37.5) return null
  if (celsius < 38.0) return 'caution'
  if (ageDays === null) return 'emergency'
  if (ageDays < 90) return 'emergency'
  if (celsius >= 39.0) return 'danger'
  return 'warning'
}
