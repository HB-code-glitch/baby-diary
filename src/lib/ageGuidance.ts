import type {
  HealthContentLocale,
  HealthEvidenceSourceId,
} from './healthEvidence'

export type AgeStageId =
  | 'newborn'
  | 'young-infant'
  | 'three-to-five-months'
  | 'six-to-eight-months'
  | 'nine-to-eleven-months'
  | 'twelve-to-seventeen-months'
  | 'eighteen-to-twenty-three-months'
  | 'two-years'
  | 'three-to-four-years'
  | 'five-years'
  | 'older-child-fallback'

export type AgeGuidanceCategory =
  | 'feeding'
  | 'safe-sleep'
  | 'urgent-care'
  | 'activity-sleep'
  | 'food-safety'
  | 'development'
  | 'oral-health'
  | 'checkup-vaccination'
  | 'general'

export type AgeGuidanceUrgency = 'routine' | 'important' | 'urgent'
export type AgeGuidanceCountry = 'KR' | 'JP'
export type AgeGuidanceLinkPurpose =
  | 'nutrition'
  | 'checkup'
  | 'vaccination'
  | 'checkup-vaccination'
  | 'emergency'
type DateInput = string | Date

export interface AgeStage {
  readonly id: AgeStageId
  readonly labelKo: string
  readonly labelJa: string
  readonly minCompletedMonths: number
  readonly maxCompletedMonths: number
  readonly minCompletedDays?: number
  readonly maxCompletedDays?: number
}

const stageDefinitions: readonly AgeStage[] = [
  { id: 'newborn', labelKo: '신생아 · 0~27일', labelJa: '新生児・0〜27日', minCompletedMonths: 0, maxCompletedMonths: 0, minCompletedDays: 0, maxCompletedDays: 27 },
  { id: 'young-infant', labelKo: '어린 영아 · 28일~2개월', labelJa: '低月齢児・28日〜2か月', minCompletedMonths: 0, maxCompletedMonths: 2, minCompletedDays: 28 },
  { id: 'three-to-five-months', labelKo: '3~5개월', labelJa: '3〜5か月', minCompletedMonths: 3, maxCompletedMonths: 5 },
  { id: 'six-to-eight-months', labelKo: '6~8개월', labelJa: '6〜8か月', minCompletedMonths: 6, maxCompletedMonths: 8 },
  { id: 'nine-to-eleven-months', labelKo: '9~11개월', labelJa: '9〜11か月', minCompletedMonths: 9, maxCompletedMonths: 11 },
  { id: 'twelve-to-seventeen-months', labelKo: '12~17개월', labelJa: '12〜17か月', minCompletedMonths: 12, maxCompletedMonths: 17 },
  { id: 'eighteen-to-twenty-three-months', labelKo: '18~23개월', labelJa: '18〜23か月', minCompletedMonths: 18, maxCompletedMonths: 23 },
  { id: 'two-years', labelKo: '2세 · 24~35개월', labelJa: '2歳・24〜35か月', minCompletedMonths: 24, maxCompletedMonths: 35 },
  { id: 'three-to-four-years', labelKo: '3~4세 · 36~59개월', labelJa: '3〜4歳・36〜59か月', minCompletedMonths: 36, maxCompletedMonths: 59 },
  { id: 'five-years', labelKo: '5세 · 60~71개월', labelJa: '5歳・60〜71か月', minCompletedMonths: 60, maxCompletedMonths: 71 },
  { id: 'older-child-fallback', labelKo: '6세 이상', labelJa: '6歳以上', minCompletedMonths: 72, maxCompletedMonths: Number.POSITIVE_INFINITY },
]

export const AGE_STAGES: readonly AgeStage[] = Object.freeze(
  stageDefinitions.map(stage => Object.freeze({ ...stage }))
)

interface LocalDateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function parseLocalDate(value: DateInput): LocalDateParts | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
    }
  }

  const match = ISO_DATE_ONLY.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function compareDateParts(left: LocalDateParts, right: LocalDateParts): number {
  return Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day)
}

function getValidAgeDates(
  birthdate: string | null | undefined,
  asOf: DateInput
): { birth: LocalDateParts; current: LocalDateParts } | null {
  if (!birthdate) return null
  const birth = parseLocalDate(birthdate)
  const current = parseLocalDate(asOf)
  if (!birth || !current || compareDateParts(current, birth) < 0) return null
  return { birth, current }
}

export function calculateAgeInCompletedDays(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date()
): number | null {
  const dates = getValidAgeDates(birthdate, asOf)
  if (!dates) return null
  return Math.floor(compareDateParts(dates.current, dates.birth) / MS_PER_DAY)
}

/**
 * Counts completed local-calendar months. A birth on the 29th–31st reaches a
 * new month on the last day of a shorter month, rather than after 30 days.
 */
export function calculateCompletedCalendarMonths(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date()
): number | null {
  const dates = getValidAgeDates(birthdate, asOf)
  if (!dates) return null

  const { birth, current } = dates
  let months = (current.year - birth.year) * 12 + current.month - birth.month
  const anniversaryDay = Math.min(birth.day, daysInMonth(current.year, current.month))
  if (current.day < anniversaryDay) months -= 1
  return months >= 0 ? months : null
}

export interface AgeSnapshot {
  readonly completedDays: number
  readonly completedCalendarMonths: number
  readonly stage: AgeStage
}

export function getAgeSnapshot(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date()
): AgeSnapshot | null {
  const completedDays = calculateAgeInCompletedDays(birthdate, asOf)
  const completedCalendarMonths = calculateCompletedCalendarMonths(birthdate, asOf)
  if (completedDays === null || completedCalendarMonths === null) return null

  let stage: AgeStage
  if (completedDays <= 27) {
    stage = AGE_STAGES[0]
  } else {
    stage = AGE_STAGES.find(candidate =>
      candidate.id !== 'newborn' &&
      completedCalendarMonths >= candidate.minCompletedMonths &&
      completedCalendarMonths <= candidate.maxCompletedMonths
    ) ?? AGE_STAGES[AGE_STAGES.length - 1]
  }

  return Object.freeze({ completedDays, completedCalendarMonths, stage })
}

export function getAgeStage(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date()
): AgeStage | null {
  return getAgeSnapshot(birthdate, asOf)?.stage ?? null
}

export interface DevelopmentCheckpoint {
  readonly completedMonth: number
  readonly titleKo: string
  readonly titleJa: string
  readonly actionsKo: readonly string[]
  readonly actionsJa: readonly string[]
  readonly screening: readonly ('developmental' | 'autism')[]
  readonly sourceIds: readonly HealthEvidenceSourceId[]
}

const checkpointDefinitions: readonly DevelopmentCheckpoint[] = [
  { completedMonth: 2, titleKo: '2개월 발달 관찰', titleJa: '2か月の発達観察', actionsKo: ['얼굴을 보고 반응하는지, 울음 외 소리를 내는지, 엎드렸을 때 머리를 드는지 편안한 놀이 중에 관찰해요.', '기술을 잃었거나 걱정되는 점이 있으면 다음 검진까지 기다리지 말고 의료진과 상의해요.'], actionsJa: ['顔を見て反応するか、泣き声以外の声を出すか、腹ばいで頭を上げるかを無理のない遊びの中で見守ります。', 'できていたことを失った、または心配がある場合は次の健診を待たず医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 4, titleKo: '4개월 발달 관찰', titleJa: '4か月の発達観察', actionsKo: ['관심을 끌기 위해 미소 짓는지, 소리로 주고받는지, 머리를 가누고 손을 입으로 가져가는지 관찰해요.', '이정표는 진단표가 아니에요. 기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['注意を引くためにほほ笑むか、声を返すか、頭を安定させ手を口へ運ぶかを見守ります。', '発達の目安は診断表ではありません。できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 6, titleKo: '6개월 발달 관찰', titleJa: '6か月の発達観察', actionsKo: ['익숙한 사람을 알아보고 웃거나 소리를 주고받는지, 몸을 뒤집거나 앉을 때 손으로 지지하는지 관찰해요.', '기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['親しい人を認識して笑う、声を交わす、寝返りをする、座る時に手で支える様子を見守ります。', 'できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 9, titleKo: '9개월 발달 관찰·선별검사', titleJa: '9か月の発達観察・スクリーニング', actionsKo: ['이름을 부르면 보고, 다양한 표정을 보이며, 혼자 앉거나 물건을 양손 사이로 옮기는지 관찰해요.', '9개월 무렵 권고되는 표준 발달 선별검사와 걱정되는 점을 의료진과 상의해요.'], actionsJa: ['名前を呼ぶと見る、表情が豊か、ひとり座りや物を左右の手に持ち替える様子を見守ります。', '9か月頃に推奨される標準化発達スクリーニングと気になる点を医療者に相談してください。'], screening: ['developmental'], sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'] },
  { completedMonth: 12, titleKo: '12개월 발달 관찰', titleJa: '12か月の発達観察', actionsKo: ['간단한 놀이를 함께하고, 손을 흔들거나 의미 있는 호칭을 쓰며, 붙잡고 일어서는지 관찰해요.', '기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['簡単な遊びを一緒にする、手を振る、意味のある呼び名を使う、つかまり立ちをする様子を見守ります。', 'できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 15, titleKo: '15개월 발달 관찰', titleJa: '15か月の発達観察', actionsKo: ['보호자에게 물건을 보여주거나 도움을 요청할 때 가리키는지, 몇 걸음 걷고 엄마·아빠 같은 보호자 호칭 외에 한두 낱말을 말해 보려 하는지 편안히 관찰해요.', '기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['保護者に物を見せる、助けを求めて指さす、数歩歩く、ママ・パパなどの保護者の呼び名以外に1〜2語を言おうとする様子を無理なく見守ります。', 'できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 18, titleKo: '18개월 발달 관찰·선별검사', titleJa: '18か月の発達観察・スクリーニング', actionsKo: ['흥미로운 것을 가리켜 함께 보고, 몸짓 없이 한 단계 지시를 따르며, 혼자 걷는지 관찰해요.', '18개월 무렵 권고되는 표준 발달·자폐 선별검사와 걱정되는 점을 의료진과 상의해요.'], actionsJa: ['興味のある物を指さして共有する、身振りなしで一段階の指示に従う、ひとり歩きする様子を見守ります。', '18か月頃に推奨される標準化発達・自閉症スクリーニングと気になる点を医療者に相談してください。'], screening: ['developmental', 'autism'], sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'] },
  { completedMonth: 24, titleKo: '24개월 발달 관찰·선별검사', titleJa: '24か月の発達観察・スクリーニング', actionsKo: ['두 낱말을 이어 말하고, 다른 사람의 감정을 알아차리며, 달리거나 도움을 받거나 받지 않고 계단 몇 칸을 걸어서 오르는지 관찰해요.', '24개월 무렵 권고되는 자폐 선별검사와 걱정되는 점을 의료진과 상의해요.'], actionsJa: ['2語をつなげる、他人の気持ちに気づく、走る、助けがあってもなくても数段の階段を歩いて上る様子を見守ります。', '24か月頃に推奨される自閉症スクリーニングと気になる点を医療者に相談してください。'], screening: ['autism'], sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'] },
  { completedMonth: 30, titleKo: '30개월 발달 관찰·선별검사', titleJa: '30か月の発達観察・スクリーニング', actionsKo: ['또래 옆에서 함께 놀고, 약 50개 낱말을 쓰며 동작 낱말을 포함해 두 낱말 이상을 조합하고, 두 발로 뛰는지 관찰해요.', '30개월 무렵 권고되는 표준 발달 선별검사와 걱정되는 점을 의료진과 상의해요.'], actionsJa: ['ほかの子のそばで一緒に遊ぶ、約50語を使い、動作を表す語を含む2語以上を組み合わせ、両足で跳ぶ様子を見守ります。', '30か月頃に推奨される標準化発達スクリーニングと気になる点を医療者に相談してください。'], screening: ['developmental'], sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'] },
  { completedMonth: 36, titleKo: '3세 발달 관찰', titleJa: '3歳の発達観察', actionsKo: ['다른 아이와 놀이에 참여하고, 적어도 두 차례 말을 주고받는 대화를 하며, 질문하거나 시범을 본 뒤 원을 그리는지 관찰해요.', '기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['ほかの子の遊びに加わる、少なくとも2回やり取りする会話をする、質問する、見本を見た後に円を描く様子を見守ります。', 'できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 48, titleKo: '4세 발달 관찰', titleJa: '4歳の発達観察', actionsKo: ['역할놀이를 하고, 네 낱말 이상 문장으로 경험을 말하며, 큰 공을 받거나 단추를 푸는지 관찰해요.', '기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['ごっこ遊びをする、4語以上の文で出来事を話す、大きなボールを受ける、ボタンを外す様子を見守ります。', 'できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
  { completedMonth: 60, titleKo: '5세 발달 관찰', titleJa: '5歳の発達観察', actionsKo: ['규칙을 따르거나 차례를 지키고, 사건이 두 가지 이상 이어지는 이야기를 하며, 한 발로 뛰는지 관찰해요.', '기술을 잃었거나 걱정되면 의료진과 상의해요.'], actionsJa: ['ルールや順番を守る、出来事が2つ以上ある話をし、片足で跳ぶ様子を見守ります。', 'できていたことを失った、または心配があれば医療者に相談してください。'], screening: [], sourceIds: ['cdc-developmental-milestones'] },
]

export const DEVELOPMENT_CHECKPOINTS: readonly DevelopmentCheckpoint[] = Object.freeze(
  checkpointDefinitions.map(checkpoint => Object.freeze({
    ...checkpoint,
    actionsKo: Object.freeze([
      ...checkpoint.actionsKo,
      '아직 못 하는 항목이 있거나 하던 기술을 잃었거나 보호자가 걱정되면 다음 검진을 기다리지 말고 의료진과 상의해요. 이 목록은 진단이 아니에요.',
    ]),
    actionsJa: Object.freeze([
      ...checkpoint.actionsJa,
      'まだできていない項目がある、できていたことを失った、または保護者が心配な場合は次の健診を待たず医療者に相談してください。この一覧は診断ではありません。',
    ]),
    screening: Object.freeze([...checkpoint.screening]),
    sourceIds: Object.freeze([...checkpoint.sourceIds]),
  }))
)

export function getDevelopmentCheckpointForDate(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date()
): DevelopmentCheckpoint | null {
  const completedMonths = calculateCompletedCalendarMonths(birthdate, asOf)
  if (completedMonths === null || completedMonths >= 72) return null
  for (let index = DEVELOPMENT_CHECKPOINTS.length - 1; index >= 0; index -= 1) {
    if (completedMonths >= DEVELOPMENT_CHECKPOINTS[index].completedMonth) {
      return DEVELOPMENT_CHECKPOINTS[index]
    }
  }
  return null
}

export interface AgeGuidanceItem {
  readonly id: string
  readonly stageId: AgeStageId
  readonly category: AgeGuidanceCategory
  readonly priority: number
  readonly urgency: AgeGuidanceUrgency
  readonly titleKo: string
  readonly titleJa: string
  readonly summaryKo: string
  readonly summaryJa: string
  readonly actionsKo: readonly string[]
  readonly actionsJa: readonly string[]
  readonly sourceIds: readonly HealthEvidenceSourceId[]
  readonly country?: AgeGuidanceCountry
  readonly linkPurpose?: AgeGuidanceLinkPurpose
}

const itemDefinitions: readonly AgeGuidanceItem[] = [
  {
    id: 'newborn-responsive-feeding', stageId: 'newborn', category: 'feeding', priority: 1, urgency: 'important',
    titleKo: '신호에 맞춰 자주 수유해요', titleJa: 'サインに合わせてこまめに授乳',
    summaryKo: '정해진 시계보다 배고픔·배부름 신호와 성장 상태를 우선해요.', summaryJa: '決まった時刻より空腹・満腹のサインと成長を優先します。',
    actionsKo: ['입을 찾거나 손을 빠는 초기 배고픔 신호에 반응하고, 고개를 돌리거나 빨기를 멈추면 억지로 먹이지 않아요.', '계속 깨우기 어렵거나 빠는 힘이 약하면 즉시 의료진과 상의해요. 먹는 양·소변·체중이 걱정될 때도 의료진에게 확인해요.'],
    actionsJa: ['口を探す、手を吸うなど早めの空腹サインに応じ、顔をそむける、吸うのをやめる時は無理に飲ませません。', '起こしにくい、吸う力が弱い時は直ちに医療者へ相談してください。飲み方・尿・体重が心配な時も医療者へ確認してください。'],
    sourceIds: ['who-infant-feeding', 'cdc-hunger-fullness-cues', 'nice-newborn-red-flags-ng194'],
  },
  {
    id: 'infant-safe-sleep', stageId: 'newborn', category: 'safe-sleep', priority: 2, urgency: 'important',
    titleKo: '등으로, 단단하고 비어 있는 침대에서', titleJa: 'あおむけで、硬く何もない寝床に',
    summaryKo: '모든 잠은 등을 대고, 단단하고 평평한 별도 수면 공간에서 재워요.', summaryJa: 'すべての睡眠はあおむけ、硬く平らな別の寝床にします。',
    actionsKo: ['단단하고 평평한 매트리스에 꼭 맞는 시트만 사용하고 베개·이불·범퍼·인형은 두지 않으며, 같은 방의 별도 침대를 사용해요.', '항상 등을 대고 눕혀요. 양방향으로 스스로 뒤집기 전에는 자세를 바로잡고, 양방향으로 스스로 뒤집으면 아기가 취한 자세는 그대로 둘 수 있어요.', '뒤집으려는 시도가 보이는 즉시 속싸개를 중단해요.'],
    actionsJa: ['硬く平らなマットレスにぴったりしたシーツだけを使い、枕・掛け布団・バンパー・ぬいぐるみを置かず、同室の別の寝床を使います。', '寝かせる時は常にあおむけにします。両方向に自分で寝返りできるまでは姿勢を戻し、両方向にできるようになれば自分でとった姿勢はそのままでかまいません。', '寝返りを試みたらすぐにおくるみをやめてください。'],
    sourceIds: ['aap-safe-sleep-2022', 'nichd-safe-sleep', 'cfa-safe-sleep'],
  },
  {
    id: 'newborn-urgent-signs', stageId: 'newborn', category: 'urgent-care', priority: 3, urgency: 'urgent',
    titleKo: '신생아 위험 신호는 바로 진료', titleJa: '新生児の危険サインはすぐ受診',
    summaryKo: '38°C 이상 발열, 심한 처짐·호흡곤란·경련은 기다리지 않아요.', summaryJa: '38°C以上の発熱、強いぐったり、呼吸困難、けいれんは待ちません。',
    actionsKo: ['생후 3개월 미만에서 38°C 이상이거나, 신생아 체온이 36°C 미만이거나, 먹지 못하고 깨우기 어렵거나, 끙끙거리며 숨쉬거나 가슴이 심하게 들어가면 즉시 의료기관에 연락해요.', '창백·청색 피부, 눌러도 사라지지 않는 발진, 경련, 초록색 담즙성 구토가 보이면 즉시 지역 응급 도움을 요청해요.'],
    actionsJa: ['生後3か月未満で38°C以上、新生児の体温が36°C未満、飲めない、起こしにくい、うなり呼吸、胸が強くへこむ時は直ちに医療機関へ連絡してください。', '青白い・青い皮膚、押しても消えない発疹、けいれん、緑色の胆汁性嘔吐があれば直ちに地域の救急へ連絡してください。'],
    sourceIds: ['nice-fever-ng143', 'nice-newborn-red-flags-ng194'],
  },
  {
    id: 'newborn-awake-floor-time', stageId: 'newborn', category: 'activity-sleep', priority: 4, urgency: 'routine',
    titleKo: '깨어 있을 때 짧게 엎드려 놀아요', titleJa: '起きている時に短い腹ばい遊び',
    summaryKo: '보호자가 바로 지켜보는 동안만 바닥 놀이를 시작해요.', summaryJa: '保護者がすぐそばで見守る時だけ床遊びを始めます。',
    actionsKo: ['깨어 있고 안정된 때 짧게 여러 번 시도하고, 힘들어하면 쉬어요.', '잠이 들면 즉시 등을 대고 안전한 수면 공간으로 옮겨요.'],
    actionsJa: ['起きて落ち着いている時に短く何度か試し、つらそうなら休みます。', '眠ったらすぐにあおむけで安全な寝床へ移します。'],
    sourceIds: ['aap-safe-sleep-2022', 'who-under-five-activity'],
  },
  {
    id: 'newborn-supplement-plan', stageId: 'newborn', category: 'feeding', priority: 5, urgency: 'routine',
    titleKo: '비타민 D·철분은 개인 계획을 확인해요', titleJa: 'ビタミンD・鉄は個別計画を確認',
    summaryKo: '수유 방식·미숙아 여부·제품 섭취량·지역 지침에 따라 달라요.', summaryJa: '授乳方法、早産、製品の摂取量、地域の方針で異なります。',
    actionsKo: ['출생 병원이나 1개월 검진에서 비타민 D와 철분 필요 여부를 확인하고, 임의 용량을 시작하지 않아요.'],
    actionsJa: ['出生施設や1か月健診でビタミンDと鉄の必要性を確認し、自己判断の量で始めないでください。'],
    sourceIds: ['cdc-vitamin-d', 'cdc-iron', 'cfa-one-month-checkup'],
  },
  {
    id: 'young-infant-responsive-feeding', stageId: 'young-infant', category: 'feeding', priority: 1, urgency: 'important',
    titleKo: '수유 신호와 성장 흐름을 함께 봐요', titleJa: '授乳サインと成長の流れを確認',
    summaryKo: '정해진 간격이나 양을 강요하지 않고 배고픔·배부름 신호에 반응해요.', summaryJa: '決まった間隔や量を強いず、空腹・満腹のサインに応じます。',
    actionsKo: ['모유와 분유 모두 아기의 신호에 따라 먹이고, 잘 먹지 못하거나 성장·수분 상태가 걱정되면 의료진과 상의해요.'],
    actionsJa: ['母乳もミルクも子どものサインに合わせ、飲めない、成長や水分状態が心配な時は医療者に相談してください。'],
    sourceIds: ['who-infant-feeding', 'cdc-breastfeeding-frequency', 'cdc-formula-feeding', 'cdc-hunger-fullness-cues'],
  },
  {
    id: 'young-infant-safe-sleep', stageId: 'young-infant', category: 'safe-sleep', priority: 2, urgency: 'important',
    titleKo: '안전 수면 원칙을 계속 지켜요', titleJa: '安全な睡眠を続ける',
    summaryKo: '등으로 눕히고, 단단하고 평평한 별도 침대를 비워 둬요.', summaryJa: 'あおむけ、硬く平らな別の寝床を何も置かず使います。',
    actionsKo: ['같은 방의 별도 침대를 사용하고 침대 공유는 피하며, 뒤집기 시도 즉시 속싸개를 중단해요.', '양방향으로 스스로 뒤집기 전에는 자세를 바로잡고, 가능해진 뒤에는 스스로 취한 자세를 둘 수 있어요.'],
    actionsJa: ['同室の別の寝床を使い、同じ寝床（ベッドシェア）を避け、寝返りを試みたらおくるみをやめます。', '両方向に自分で寝返りできるまでは姿勢を戻し、できるようになれば自分でとった姿勢はそのままでかまいません。'],
    sourceIds: ['aap-safe-sleep-2022', 'nichd-safe-sleep', 'cfa-safe-sleep'],
  },
  {
    id: 'young-infant-fever', stageId: 'young-infant', category: 'urgent-care', priority: 3, urgency: 'urgent',
    titleKo: '3개월 미만 38°C 이상은 즉시 연락', titleJa: '3か月未満で38°C以上は直ちに連絡',
    summaryKo: '겉보기에 괜찮아도 지금 의료기관에 연락해 진료받아요.', summaryJa: '元気そうに見えても、今すぐ医療機関へ連絡し診察を受けてください。',
    actionsKo: ['생후 3개월 미만에서 기록 체온이 38°C 이상이면 측정 부위를 단정하지 말고 즉시 의료기관에 연락해요.', '호흡곤란·청색 피부·심한 처짐·경련이 있으면 즉시 지역 응급 도움을 요청해요.'],
    actionsJa: ['生後3か月未満で記録した体温が38°C以上なら測定部位を決めつけず、直ちに医療機関へ連絡してください。', '呼吸困難・青い皮膚・強いぐったり・けいれんがあれば直ちに地域の救急へ連絡してください。'],
    sourceIds: ['nice-fever-ng143'],
  },
  {
    id: 'young-infant-floor-play', stageId: 'young-infant', category: 'activity-sleep', priority: 4, urgency: 'routine',
    titleKo: '매일 감독 아래 바닥 놀이', titleJa: '毎日、見守りながら床遊び',
    summaryKo: '깨어 있을 때 엎드려 놀기를 여러 번 나눠 하고 화면 노출은 피해요.', summaryJa: '起きている時の腹ばい遊びを分けて行い、画面視聴は避けます。',
    actionsKo: ['아기가 편안한 범위에서 엎드리기와 자유로운 움직임을 늘리고, 한 번에 1시간 넘게 유모차·의자에 묶어 두지 않아요.'],
    actionsJa: ['無理のない範囲で腹ばいと自由な動きを増やし、ベビーカーや椅子に1時間以上続けて固定しません。'],
    sourceIds: ['who-under-five-activity', 'aap-safe-sleep-2022'],
  },
  {
    id: 'young-infant-development', stageId: 'young-infant', category: 'development', priority: 5, urgency: 'routine',
    titleKo: '2개월 체크포인트를 편안히 관찰해요', titleJa: '2か月の目安を無理なく観察',
    summaryKo: '발달 이정표는 합격표나 지연을 진단하는 도구가 아니에요.', summaryJa: '発達の目安は合否表や遅れを診断する道具ではありません。',
    actionsKo: ['현재 개월의 체크포인트를 놀이 중 관찰하고, 기술을 잃었거나 걱정되면 바로 의료진과 상의해요.'],
    actionsJa: ['今の月齢の目安を遊びの中で見守り、できていたことを失った、または心配なら早めに医療者へ相談してください。'],
    sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'],
  },
  {
    id: 'three-five-safe-sleep', stageId: 'three-to-five-months', category: 'safe-sleep', priority: 1, urgency: 'important',
    titleKo: '돌 전까지 모든 잠은 등으로 시작해요', titleJa: '1歳までは毎回あおむけで寝かせる',
    summaryKo: '단단하고 평평한 별도 수면 공간을 비워 두고 침대 공유를 피해요.', summaryJa: '硬く平らな別の寝床を空にし、同じ寝床（ベッドシェア）を避けます。',
    actionsKo: ['뒤집으려는 시도 즉시 속싸개를 중단하고, 양방향으로 스스로 뒤집을 수 있을 때만 아기가 취한 자세를 그대로 둬요.'],
    actionsJa: ['寝返りを試みたらおくるみをやめ、両方向に自分で寝返りできる時だけ自分でとった姿勢をそのままにします。'],
    sourceIds: ['aap-safe-sleep-2022', 'nichd-safe-sleep', 'cfa-safe-sleep'],
  },
  {
    id: 'three-five-floor-play', stageId: 'three-to-five-months', category: 'activity-sleep', priority: 2, urgency: 'routine',
    titleKo: '움직임을 막지 않는 바닥 놀이', titleJa: '自由に動ける床遊び',
    summaryKo: '깨어 있을 때 감독 아래 엎드리기·뻗기·구르기를 충분히 경험하게 해요.', summaryJa: '起きている時に見守りながら腹ばい・手を伸ばす・転がる動きを促します。',
    actionsKo: ['화면 노출은 피하고, 유모차·의자처럼 움직임을 제한하는 장비는 한 번에 1시간 넘기지 않아요.'],
    actionsJa: ['画面視聴を避け、ベビーカーや椅子など動きを制限する器具は1回1時間を超えないようにします。'],
    sourceIds: ['who-under-five-activity'],
  },
  {
    id: 'three-five-solids-readiness', stageId: 'three-to-five-months', category: 'feeding', priority: 3, urgency: 'important',
    titleKo: '이유식은 6개월 무렵 준비 신호와 함께', titleJa: '離乳食は6か月頃、準備サインとともに',
    summaryKo: '4개월 전에는 시작하지 않고, 머리 조절·앉기 보조·삼키기 준비를 함께 봐요.', summaryJa: '4か月前には始めず、頭の安定・支え座り・飲み込みの準備を確認します。',
    actionsKo: ['나이만으로 서두르지 말고 6개월 무렵 준비 신호를 확인해 시작하며, 성장이나 의료 조건이 있으면 개인 계획을 따라요.'],
    actionsJa: ['月齢だけで急がず6か月頃に準備サインを確認し、成長や医療上の条件があれば個別計画に従います。'],
    sourceIds: ['who-complementary-feeding', 'cdc-complementary-foods', 'kdca-infant-nutrition', 'cfa-infant-nutrition'],
  },
  {
    id: 'three-five-development', stageId: 'three-to-five-months', category: 'development', priority: 4, urgency: 'routine',
    titleKo: '현재 달의 발달 체크포인트', titleJa: '現在の月齢の発達チェック',
    summaryKo: '4개월 체크포인트를 놀이 중 관찰하고 걱정은 일찍 상의해요.', summaryJa: '4か月の目安を遊びの中で見守り、心配は早めに相談します。',
    actionsKo: ['이정표는 진단표가 아니며, 기술을 잃었거나 보호자가 걱정하면 다음 검진을 기다리지 않아요.'],
    actionsJa: ['発達の目安は診断表ではありません。できていたことを失った、または心配なら次の健診を待ちません。'],
    sourceIds: ['cdc-developmental-milestones'],
  },
  {
    id: 'three-five-fever', stageId: 'three-to-five-months', category: 'urgent-care', priority: 5, urgency: 'urgent',
    titleKo: '3~5개월 발열은 일찍 의료진과 상의해요', titleJa: '3〜5か月の発熱は早めに医療者へ相談',
    summaryKo: '생후 3~6개월은 낮은 발열도 전신 상태와 함께 신중히 확인해요.', summaryJa: '生後3〜6か月は低めの発熱でも全身状態とともに慎重に確認します。',
    actionsKo: ['아직 생후 90일 미만이면 기록 체온 38.0°C 이상에서 즉시 의료기관에 연락해요. 생후 90일 이후에는 기록 체온이 38.3°C 이상이면 의료진에게 연락해 상담하고, 39.0°C 이상이면 더 신속히 진료받아요.', '호흡곤란·청색 피부·깨워도 반응이 없거나 경련이 있으면 체온과 관계없이 즉시 지역 응급 도움을 요청해요.'],
    actionsJa: ['生後90日未満なら記録した体温が38.0°C以上で直ちに医療機関へ連絡してください。生後90日以降は記録した体温が38.3°C以上なら医療者へ連絡して相談し、39.0°C以上ならより速やかに診察を受けてください。', '呼吸困難・青い皮膚・起こしても反応がない・けいれんがある時は体温にかかわらず直ちに地域の救急へ連絡してください。'],
    sourceIds: ['aap-fever-baby', 'nice-fever-ng143'],
  },
  {
    id: 'six-eight-responsive-meals', stageId: 'six-to-eight-months', category: 'feeding', priority: 1, urgency: 'important',
    titleKo: '모유·분유를 중심으로 보충식 2~3회', titleJa: '母乳・ミルクを中心に補完食を2〜3回',
    summaryKo: '철분이 풍부한 식품과 다양한 식감을 조금씩, 신호에 맞춰 제공해요.', summaryJa: '鉄を含む食品と多様な食感を少しずつ、サインに合わせて与えます。',
    actionsKo: ['모유 수유는 원하면 계속하고 12개월 전에는 모유나 영아용 분유가 중요한 영양원이에요.', '앉혀서 천천히 먹이고 고개를 돌리거나 입을 닫는 배부름 신호를 존중해요.'],
    actionsJa: ['母乳は希望に応じて続け、12か月までは母乳または乳児用ミルクが大切な栄養源です。', '座らせてゆっくり与え、顔をそむける、口を閉じる満腹サインを尊重します。'],
    sourceIds: ['who-infant-feeding', 'who-complementary-feeding', 'cdc-iron', 'cdc-hunger-fullness-cues'],
  },
  {
    id: 'six-eight-allergen-choking', stageId: 'six-to-eight-months', category: 'food-safety', priority: 2, urgency: 'important',
    titleKo: '알레르기 식품은 안전한 형태로, 질식은 예방', titleJa: 'アレルゲンは安全な形で、窒息を予防',
    summaryKo: '연령에 맞는 부드러운 형태로 소개하고 먹는 동안 바로 지켜봐요.', summaryJa: '月齢に合う柔らかい形で導入し、食事中はそばで見守ります。',
    actionsKo: ['중증 습진이나 달걀 알레르기가 있으면 땅콩 도입 전에 의료진과 상의하고, 통땅콩은 주지 않아요.', '딱딱하거나 둥글고 미끄러운 음식은 자르고 익혀 질감을 바꾸며, 앉은 자세에서 먹여요.'],
    actionsJa: ['重い湿疹や卵アレルギーがある場合はピーナッツ導入前に医療者へ相談し、丸ごとのピーナッツは与えません。', '硬い、丸い、滑りやすい食品は切る・加熱するなど形を変え、座った姿勢で食べさせます。'],
    sourceIds: ['cdc-complementary-foods', 'cdc-choking', 'niaid-peanut-allergy', 'kdca-infant-nutrition'],
  },
  {
    id: 'six-eight-foods-to-avoid', stageId: 'six-to-eight-months', category: 'food-safety', priority: 3, urgency: 'important',
    titleKo: '돌 전 금지 식품을 확인해요', titleJa: '1歳前に避ける食品を確認',
    summaryKo: '꿀, 주 음료로서의 우유, 주스는 12개월 전에 주지 않아요.', summaryJa: 'はちみつ、主な飲み物としての牛乳、ジュースは12か月前に与えません。',
    actionsKo: ['비살균 식품과 질식 위험 형태를 피하고, 만 2세 전에는 첨가당을 피해요.'],
    actionsJa: ['未殺菌食品と窒息しやすい形を避け、2歳未満は添加糖を避けます。'],
    sourceIds: ['cdc-foods-to-avoid', 'cdc-choking'],
  },
  {
    id: 'six-eight-activity-sleep', stageId: 'six-to-eight-months', category: 'activity-sleep', priority: 4, urgency: 'routine',
    titleKo: '활발한 바닥 놀이와 충분한 수면', titleJa: '活発な床遊びと十分な睡眠',
    summaryKo: '매일 여러 번 자유롭게 움직이고 화면 노출은 피해요.', summaryJa: '毎日何度も自由に動き、画面視聴は避けます。',
    actionsKo: ['4~11개월 수면 12~16시간은 낮잠을 포함한 일반 범위일 뿐 목표 점수가 아니에요. 아이 상태를 함께 봐요.'],
    actionsJa: ['4〜11か月の睡眠12〜16時間は昼寝を含む一般的な範囲で、達成目標ではありません。子どもの様子も見ます。'],
    sourceIds: ['who-under-five-activity'],
  },
  {
    id: 'six-eight-oral-care', stageId: 'six-to-eight-months', category: 'oral-health', priority: 5, urgency: 'routine',
    titleKo: '첫니가 나면 닦기 시작해요', titleJa: '最初の歯が生えたら歯みがき開始',
    summaryKo: '첫니부터 연령에 맞게 닦고 첫돌까지 치과 상담을 계획해요.', summaryJa: '最初の歯から月齢に合うケアを始め、1歳までの歯科相談を計画します。',
    actionsKo: ['불소 사용 방법은 거주 지역의 치과 지침과 의료진 조언을 확인해요.'],
    actionsJa: ['フッ化物の使い方は居住地域の歯科方針と医療者の助言を確認してください。'],
    sourceIds: ['cdc-child-oral-health'],
  },
  {
    id: 'nine-eleven-meals-texture', stageId: 'nine-to-eleven-months', category: 'feeding', priority: 1, urgency: 'important',
    titleKo: '3~4회 식사와 다양한 질감', titleJa: '3〜4回の食事と多様な食感',
    summaryKo: '필요하면 1~2회 간식을 더하고, 손으로 집어 먹는 경험을 안전하게 넓혀요.', summaryJa: '必要に応じ1〜2回の間食を加え、手づかみ食べを安全に広げます。',
    actionsKo: ['모유나 영아용 분유를 계속하면서 철분이 풍부한 식품과 가족 음식의 다양한 맛·질감을 연령에 맞게 제공해요.', '식사 횟수는 아이마다 다를 수 있으므로 배고픔·배부름 신호를 따라요.'],
    actionsJa: ['母乳または乳児用ミルクを続け、鉄を含む食品と家族の食事の味・食感を月齢に合わせて広げます。', '食事回数には個人差があるため、空腹・満腹のサインに合わせます。'],
    sourceIds: ['who-infant-feeding', 'who-complementary-feeding', 'cdc-iron'],
  },
  {
    id: 'nine-eleven-choking', stageId: 'nine-to-eleven-months', category: 'food-safety', priority: 2, urgency: 'important',
    titleKo: '식감은 넓히되 질식 형태는 피해요', titleJa: '食感を広げつつ窒息する形は避ける',
    summaryKo: '앉아서 먹이고 항상 곁에서 지켜보며 둥글고 단단한 음식은 바꿔 줘요.', summaryJa: '座って食べさせ、常に見守り、丸く硬い食品は形を変えます。',
    actionsKo: ['12개월 전에는 꿀·주스·주 음료로서의 우유를 주지 않고 비살균 식품을 피해요.'],
    actionsJa: ['12か月前は、はちみつ・ジュース・主な飲み物としての牛乳を与えず、未殺菌食品を避けます。'],
    sourceIds: ['cdc-choking', 'cdc-foods-to-avoid'],
  },
  {
    id: 'nine-eleven-development', stageId: 'nine-to-eleven-months', category: 'development', priority: 3, urgency: 'routine',
    titleKo: '9개월 발달 관찰과 선별검사', titleJa: '9か月の発達観察とスクリーニング',
    summaryKo: '현재 체크포인트를 보고 표준 발달 선별검사를 의료진과 상의해요.', summaryJa: '今の目安を見守り、標準化発達スクリーニングを医療者に相談します。',
    actionsKo: ['기술을 잃었거나 걱정되는 점이 있으면 선별검사는 진단이 아님을 기억하고 일찍 상의해요.'],
    actionsJa: ['できていたことを失った、または心配があれば、スクリーニングは診断ではないことを踏まえ早めに相談します。'],
    sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'],
  },
  {
    id: 'nine-eleven-safe-sleep', stageId: 'nine-to-eleven-months', category: 'safe-sleep', priority: 4, urgency: 'important',
    titleKo: '첫돌까지 안전 수면을 계속해요', titleJa: '1歳まで安全な睡眠を続ける',
    summaryKo: '항상 등으로 눕히고 단단하고 평평한 별도 침대를 비워 둬요.', summaryJa: '毎回あおむけで寝かせ、硬く平らな別の寝床を空にします。',
    actionsKo: ['양방향으로 스스로 뒤집을 수 있다면 아기가 취한 자세는 그대로 둘 수 있어요.'],
    actionsJa: ['両方向に自分で寝返りできる場合は、自分でとった姿勢はそのままでかまいません。'],
    sourceIds: ['aap-safe-sleep-2022', 'nichd-safe-sleep', 'cfa-safe-sleep'],
  },
  {
    id: 'twelve-seventeen-family-foods', stageId: 'twelve-to-seventeen-months', category: 'feeding', priority: 1, urgency: 'routine',
    titleKo: '가족 음식으로 넓히고 신호를 존중해요', titleJa: '家族の食事へ広げ、サインを尊重',
    summaryKo: '다양한 음식과 규칙적인 식사 기회를 주되 먹는 양은 강요하지 않아요.', summaryJa: '多様な食品と規則的な食事機会を用意し、食べる量は強要しません。',
    actionsKo: ['원하면 모유 수유를 계속하고, 물을 기본 음료로 삼으며 첨가당과 과한 소금을 피해요.'],
    actionsJa: ['希望に応じ母乳を続け、基本の飲み物は水とし、添加糖と過剰な塩分を避けます。'],
    sourceIds: ['who-infant-feeding', 'who-complementary-feeding', 'cdc-hunger-fullness-cues', 'cdc-foods-to-avoid'],
  },
  {
    id: 'twelve-seventeen-activity-sleep', stageId: 'twelve-to-seventeen-months', category: 'activity-sleep', priority: 2, urgency: 'routine',
    titleKo: '하루 동안 자주 움직이고 화면은 피해요', titleJa: '一日を通してよく動き、画面は避ける',
    summaryKo: '다양한 신체활동을 하루 합계 180분 이상 나누어 하고 11~14시간 수면을 참고해요.', summaryJa: '多様な身体活動を一日合計180分以上に分け、睡眠11〜14時間を参考にします。',
    actionsKo: ['활동·수면 시간은 아이를 평가하는 점수가 아니며, 오래 앉혀 두지 않고 함께 놀아요.'],
    actionsJa: ['活動・睡眠時間は子どもの評価点ではありません。長時間座らせず一緒に遊びます。'],
    sourceIds: ['who-under-five-activity'],
  },
  {
    id: 'twelve-seventeen-oral-care', stageId: 'twelve-to-seventeen-months', category: 'oral-health', priority: 3, urgency: 'routine',
    titleKo: '매일 양치하고 치과를 확인해요', titleJa: '毎日歯みがきし歯科を確認',
    summaryKo: '첫돌 무렵 치과 상담을 받고 연령에 맞게 보호자가 닦아 줘요.', summaryJa: '1歳頃に歯科へ相談し、年齢に合う方法で保護者がみがきます。',
    actionsKo: ['불소 사용은 지역 치과 지침에 맞추고, 단 음료를 습관적으로 주지 않아요.'],
    actionsJa: ['フッ化物は地域の歯科方針に合わせ、甘い飲み物を習慣にしません。'],
    sourceIds: ['cdc-child-oral-health'],
  },
  {
    id: 'twelve-seventeen-development', stageId: 'twelve-to-seventeen-months', category: 'development', priority: 4, urgency: 'routine',
    titleKo: '12·15개월 체크포인트 관찰', titleJa: '12・15か月の目安を観察',
    summaryKo: '현재 완료 개월의 체크포인트만 보여 주고 걱정은 일찍 상의해요.', summaryJa: '完了月齢に合う目安だけを示し、心配は早めに相談します。',
    actionsKo: ['12개월에는 간단한 놀이를 함께하고 손을 흔들거나 의미 있는 호칭을 쓰며 붙잡고 일어서는지 관찰해요.', '15개월에는 보호자에게 물건을 보여 주고 도움을 요청할 때 가리키며, 몇 걸음을 걷거나 엄마·아빠 같은 보호자 호칭 외에 한두 낱말을 말해 보려 하는지 편안히 관찰해요.'],
    actionsJa: ['12か月では簡単な遊びを一緒にし、手を振る、意味のある呼び名を使う、つかまり立ちをする様子を見守ります。', '15か月では保護者に物を見せる、助けを求めて指さす、数歩歩く、ママ・パパなどの保護者の呼び名以外に1〜2語を言おうとする様子を無理なく見守ります。'],
    sourceIds: ['cdc-developmental-milestones'],
  },
  {
    id: 'eighteen-twenty-three-development', stageId: 'eighteen-to-twenty-three-months', category: 'development', priority: 1, urgency: 'important',
    titleKo: '18개월 발달·자폐 선별검사를 상의해요', titleJa: '18か月の発達・自閉症スクリーニングを相談',
    summaryKo: '표준 선별검사는 진단이 아니며 관찰과 보호자 걱정을 함께 다뤄요.', summaryJa: '標準化スクリーニングは診断ではなく、観察と保護者の心配を一緒に扱います。',
    actionsKo: ['기술을 잃었거나 걱정되면 결과를 기다리지 말고 의료진과 상의해요.'],
    actionsJa: ['できていたことを失った、または心配なら結果を待たず医療者に相談してください。'],
    sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'],
  },
  {
    id: 'eighteen-twenty-three-activity', stageId: 'eighteen-to-twenty-three-months', category: 'activity-sleep', priority: 2, urgency: 'routine',
    titleKo: '180분 활동, 일상적 화면 노출은 피해요', titleJa: '180分の活動、日常的な画面視聴は避ける',
    summaryKo: '하루 전체에 다양한 활동을 나누고 11~14시간 수면을 참고해요.', summaryJa: '一日を通して多様な活動を分け、睡眠11〜14時間を参考にします。',
    actionsKo: ['한 번에 1시간 넘게 묶어 두거나 앉혀 두지 않고 보호자와 읽기·이야기·놀이를 해요.'],
    actionsJa: ['1回1時間を超えて固定したり座らせたりせず、保護者と読み聞かせ・会話・遊びをします。'],
    sourceIds: ['who-under-five-activity'],
  },
  {
    id: 'eighteen-twenty-three-family-care', stageId: 'eighteen-to-twenty-three-months', category: 'feeding', priority: 3, urgency: 'routine',
    titleKo: '가족 식사와 구강 관리를 이어가요', titleJa: '家族の食事と口腔ケアを続ける',
    summaryKo: '다양한 가족 음식을 신호에 맞춰 제공하고 첨가당을 피해요.', summaryJa: '多様な家族の食事をサインに合わせて出し、添加糖を避けます。',
    actionsKo: ['보호자가 매일 이를 닦아 주고 정기 치과 관리를 이어가요.'],
    actionsJa: ['保護者が毎日歯をみがき、定期的な歯科ケアを続けます。'],
    sourceIds: ['who-complementary-feeding', 'cdc-foods-to-avoid', 'cdc-child-oral-health'],
  },
  {
    id: 'two-years-development', stageId: 'two-years', category: 'development', priority: 1, urgency: 'routine',
    titleKo: '24·30개월 언어·사회성 체크포인트', titleJa: '24・30か月の言語・社会性の目安',
    summaryKo: '현재 체크포인트와 24개월 자폐·30개월 발달 선별검사를 구분해 상의해요.', summaryJa: '現在の目安と24か月の自閉症・30か月の発達スクリーニングを分けて相談します。',
    actionsKo: ['기술을 잃었거나 걱정되면 선별 시기까지 기다리지 말고 의료진과 상의해요.'],
    actionsJa: ['できていたことを失った、または心配ならスクリーニング時期まで待たず医療者に相談してください。'],
    sourceIds: ['cdc-developmental-milestones', 'cdc-developmental-screening'],
  },
  {
    id: 'two-years-activity-sleep', stageId: 'two-years', category: 'activity-sleep', priority: 2, urgency: 'routine',
    titleKo: '180분 활동, 화면은 1시간 이하', titleJa: '180分の活動、画面は1時間以下',
    summaryKo: '화면은 적을수록 좋고 11~14시간 수면을 참고해요.', summaryJa: '画面は少ないほどよく、睡眠11〜14時間を参考にします。',
    actionsKo: ['하루 전체에 활동을 나누고 화면 대신 함께 읽기·대화·움직임 놀이를 우선해요.'],
    actionsJa: ['一日を通して活動を分け、画面より読み聞かせ・会話・運動遊びを優先します。'],
    sourceIds: ['who-under-five-activity'],
  },
  {
    id: 'two-years-family-food-oral', stageId: 'two-years', category: 'oral-health', priority: 3, urgency: 'routine',
    titleKo: '균형 있는 가족 음식과 매일 양치', titleJa: 'バランスのよい家族食と毎日の歯みがき',
    summaryKo: '다양한 음식을 반복해 제공하고 준비한 음식 중 고르게 하며 치과 관리를 이어가요.', summaryJa: '多様な食品を繰り返し出し、用意した食品から選べるようにし、歯科ケアを続けます。',
    actionsKo: ['새 음식은 익숙한 음식과 함께 다시 제공하고 물을 기본 음료로 삼아요.'],
    actionsJa: ['新しい食品は慣れた食品と一緒に再び出し、水を基本の飲み物にします。'],
    sourceIds: ['who-healthy-diet', 'cdc-picky-eaters', 'cdc-child-oral-health'],
  },
  {
    id: 'three-four-development', stageId: 'three-to-four-years', category: 'development', priority: 1, urgency: 'routine',
    titleKo: '3·4세 발달 체크포인트', titleJa: '3・4歳の発達の目安',
    summaryKo: '언어·놀이·움직임을 일상에서 관찰하고 기술 손실이나 걱정은 일찍 상의해요.', summaryJa: '言語・遊び・動きを日常で見守り、できていたことの喪失や心配は早めに相談します。',
    actionsKo: ['현재 체크포인트는 발달을 판정하는 진단표가 아니라 의료진과 대화를 돕는 관찰 자료예요.'],
    actionsJa: ['現在の目安は発達を判定する診断表ではなく、医療者との対話を助ける観察資料です。'],
    sourceIds: ['cdc-developmental-milestones'],
  },
  {
    id: 'three-four-activity-sleep', stageId: 'three-to-four-years', category: 'activity-sleep', priority: 2, urgency: 'routine',
    titleKo: '180분 활동 중 60분은 활기차게', titleJa: '180分の活動のうち60分は活発に',
    summaryKo: '화면은 1시간 이하로 줄이고 10~13시간 수면을 참고해요.', summaryJa: '画面は1時間以下に抑え、睡眠10〜13時間を参考にします。',
    actionsKo: ['활동·수면 시간은 목표 점수가 아니며 하루 전체에 나누어 즐겁게 실천해요.'],
    actionsJa: ['活動・睡眠時間は合否を決める数値ではありません。一日を通して楽しく分けて行います。'],
    sourceIds: ['who-under-five-activity'],
  },
  {
    id: 'three-four-injury-prevention', stageId: 'three-to-four-years', category: 'general', priority: 3, urgency: 'important',
    titleKo: '움직임이 커질수록 사고 환경을 점검해요', titleJa: '動きが広がるほど事故環境を点検',
    summaryKo: '추락·화상·익수·질식 위험을 아이의 새 능력에 맞춰 다시 확인해요.', summaryJa: '転落・やけど・溺水・窒息リスクを新しい能力に合わせ再確認します。',
    actionsKo: ['창문·가구·욕실·주방·작은 물건을 정기적으로 점검하고 보호자가 가까이 감독해요.'],
    actionsJa: ['窓・家具・浴室・台所・小物を定期的に点検し、保護者が近くで見守ります。'],
    sourceIds: ['cfa-accident-prevention'],
  },
  {
    id: 'three-four-nutrition-oral', stageId: 'three-to-four-years', category: 'oral-health', priority: 4, urgency: 'routine',
    titleKo: '다양한 식사와 구강 관리를 이어가요', titleJa: '多様な食事と口腔ケアを続ける',
    summaryKo: '가족과 균형 있게 먹고 새 음식을 반복해 제공하며 선택할 기회를 줘요. 매일 이를 닦아요.', summaryJa: '家族とバランスよく食べ、新しい食品を繰り返し出し、選ぶ機会をつくります。毎日歯をみがきます。',
    actionsKo: ['여러 식품군을 편안히 제공하고 준비한 음식 중 아이가 고르게 하며 물을 기본 음료로 삼아요.', '보호자가 양치를 돕고 정기 치과 검진을 이어가요.'],
    actionsJa: ['さまざまな食品群を気楽に出し、用意した食品から子どもが選べるようにし、水を基本の飲み物にします。', '保護者が歯みがきを助け、定期的な歯科受診を続けます。'],
    sourceIds: ['who-healthy-diet', 'cdc-picky-eaters', 'cdc-child-oral-health'],
  },
  {
    id: 'five-years-development', stageId: 'five-years', category: 'development', priority: 1, urgency: 'routine',
    titleKo: '5세 발달 체크포인트를 관찰해요', titleJa: '5歳の発達の目安を見守る',
    summaryKo: '놀이·언어·움직임을 일상에서 보고 기술 손실이나 걱정은 일찍 상의해요.', summaryJa: '遊び・言語・動きを日常で見守り、できていたことの喪失や心配は早めに相談します。',
    actionsKo: ['60개월 체크포인트는 진단표가 아니에요. 아직 못 하는 항목이 있거나 하던 기술을 잃었거나 걱정되면 의료진과 상의해요.'],
    actionsJa: ['60か月の目安は診断表ではありません。まだできていない項目がある、できていたことを失った、または心配な場合は医療者に相談してください。'],
    sourceIds: ['cdc-developmental-milestones'],
  },
  {
    id: 'five-years-safety', stageId: 'five-years', category: 'general', priority: 2, urgency: 'important',
    titleKo: '활동 반경에 맞춰 사고를 예방해요', titleJa: '行動範囲に合わせて事故を予防',
    summaryKo: '도로·물·창문·가구·화상 위험을 새 활동과 생활 환경에 맞춰 점검해요.', summaryJa: '道路・水・窓・家具・やけどの危険を新しい活動と生活環境に合わせて点検します。',
    actionsKo: ['도로와 물가에서는 가까이 감독하고, 자전거·놀이기구의 보호 장비와 집 안 추락·화상 위험을 확인해요.'],
    actionsJa: ['道路や水辺では近くで見守り、自転車・遊具の保護具と家庭内の転落・やけどの危険を確認します。'],
    sourceIds: ['cfa-accident-prevention'],
  },
  {
    id: 'five-years-nutrition-oral', stageId: 'five-years', category: 'oral-health', priority: 3, urgency: 'routine',
    titleKo: '균형 있는 식사와 매일 양치', titleJa: 'バランスのよい食事と毎日の歯みがき',
    summaryKo: '다양한 가족 식사를 반복해 제공하고 준비한 음식 중 선택하게 하며 치과 관리를 이어가요.', summaryJa: '多様な家族の食事を繰り返し出し、用意した食品から選べるようにし、歯科ケアを続けます。',
    actionsKo: ['여러 식품군과 물을 기본으로 제공하고 새 음식도 다시 편안히 제안해요.', '보호자가 양치 상태를 확인하고 정기 치과 검진을 이어가요.'],
    actionsJa: ['さまざまな食品群と水を基本にし、新しい食品もまた気楽に勧めます。', '保護者が歯みがきの状態を確認し、定期的な歯科受診を続けます。'],
    sourceIds: ['who-healthy-diet', 'cdc-picky-eaters', 'cdc-child-oral-health'],
  },
  {
    id: 'older-child-general-care-kr', stageId: 'older-child-fallback', category: 'general', priority: 1, urgency: 'routine',
    titleKo: '한국의 현재 연령 건강 계획을 확인해요', titleJa: '韓国の現在の年齢に合う健康計画を確認',
    summaryKo: '영아 지침을 연장하지 않고 한국의 현재 연령·건강 상태에 맞는 검진과 의료진 안내를 우선해요.', summaryJa: '乳児向け情報を延長せず、韓国の現在の年齢・健康状態に合う健診と医療者の案内を優先します。',
    actionsKo: ['성장·발달·건강 걱정이나 하던 기술의 손실이 있으면 한국에서 현재 연령을 진료하는 의료진과 상의해요.'],
    actionsJa: ['成長・発達・健康の心配や、できていたことの喪失があれば、韓国で現在の年齢を診る医療者へ相談してください。'],
    sourceIds: ['kdca-infant-checkups', 'kdca-vaccination'], country: 'KR', linkPurpose: 'checkup-vaccination',
  },
  {
    id: 'older-child-emergency-kr', stageId: 'older-child-fallback', category: 'urgent-care', priority: 2, urgency: 'urgent',
    titleKo: '한국에서 생명을 위협하는 위험 신호는 즉시 119', titleJa: '韓国で命に関わる危険サインは直ちに119へ',
    summaryKo: '호흡곤란·청색 피부·반응 없음·경련·눌러도 사라지지 않는 발진은 기다리지 않아요.', summaryJa: '呼吸困難、青い皮膚、反応がない、けいれん、押しても消えない発疹は待ちません。',
    actionsKo: ['한국에서는 119로 즉시 신고하고 소방청 상담원의 안내를 따라요.'],
    actionsJa: ['韓国では119へ直ちに通報し、消防庁指令員の案内に従ってください。'],
    sourceIds: ['kr-nfa-119'], country: 'KR', linkPurpose: 'emergency',
  },
  {
    id: 'older-child-local-guidance-kr', stageId: 'older-child-fallback', category: 'checkup-vaccination', priority: 3, urgency: 'routine',
    titleKo: '한국의 공식 검진·예방접종을 확인해요', titleJa: '韓国の公式健診・予防接種を確認',
    summaryKo: '일정과 대상은 지역·이력에 따라 달라질 수 있어 질병관리청의 공식 안내를 확인해요.', summaryJa: '日程と対象は地域・接種歴で異なるため、韓国疾病管理庁の公式案内を確認します。',
    actionsKo: ['질병관리청의 최신 안내와 한국 의료진의 계획을 확인해요.'],
    actionsJa: ['韓国疾病管理庁の最新案内と医療者の計画を確認してください。'],
    sourceIds: ['kdca-infant-checkups', 'kdca-vaccination'], country: 'KR', linkPurpose: 'checkup-vaccination',
  },
  {
    id: 'older-child-general-care-jp', stageId: 'older-child-fallback', category: 'general', priority: 1, urgency: 'routine',
    titleKo: '일본의 현재 연령 건강 계획을 확인해요', titleJa: '日本の現在の年齢に合う健康計画を確認',
    summaryKo: '영아 지침을 연장하지 않고 일본의 현재 연령·건강 상태에 맞는 검진과 의료진 안내를 우선해요.', summaryJa: '乳児向け情報を延長せず、日本の現在の年齢・健康状態に合う健診と医療者の案内を優先します。',
    actionsKo: ['성장·발달·건강 걱정이나 하던 기술의 손실이 있으면 일본에서 현재 연령을 진료하는 의료진과 상의해요.'],
    actionsJa: ['成長・発達・健康の心配や、できていたことの喪失があれば、日本で現在の年齢を診る医療者へ相談してください。'],
    sourceIds: ['cfa-infant-checkups', 'mhlw-vaccination'], country: 'JP', linkPurpose: 'checkup-vaccination',
  },
  {
    id: 'older-child-emergency-jp', stageId: 'older-child-fallback', category: 'urgent-care', priority: 2, urgency: 'urgent',
    titleKo: '일본에서 생명을 위협하는 위험 신호는 즉시 119', titleJa: '日本で命に関わる危険サインは直ちに119へ',
    summaryKo: '호흡곤란·청색 피부·반응 없음·경련·눌러도 사라지지 않는 발진은 기다리지 않아요.', summaryJa: '呼吸困難、青い皮膚、反応がない、けいれん、押しても消えない発疹は待ちません。',
    actionsKo: ['일본에서는 119로 즉시 신고하고 총무성 소방청 상담원의 안내를 따라요.'],
    actionsJa: ['日本では119へ直ちに通報し、総務省消防庁指令員の案内に従ってください。'],
    sourceIds: ['jp-fdma-119'], country: 'JP', linkPurpose: 'emergency',
  },
  {
    id: 'older-child-local-guidance-jp', stageId: 'older-child-fallback', category: 'checkup-vaccination', priority: 3, urgency: 'routine',
    titleKo: '일본의 공식 검진·예방접종을 확인해요', titleJa: '日本の公式健診・予防接種を確認',
    summaryKo: '일정과 대상은 지자체·이력에 따라 달라질 수 있어 어린이가정청·후생노동성의 공식 안내를 확인해요.', summaryJa: '日程と対象は自治体・接種歴で異なるため、こども家庭庁・厚生労働省の公式案内を確認します。',
    actionsKo: ['어린이가정청·후생노동성의 최신 안내와 일본 의료진의 계획을 확인해요.'],
    actionsJa: ['こども家庭庁・厚生労働省の最新案内と日本の医療者の計画を確認してください。'],
    sourceIds: ['cfa-infant-checkups', 'mhlw-vaccination'], country: 'JP', linkPurpose: 'checkup-vaccination',
  },
  {
    id: 'six-eight-safe-sleep', stageId: 'six-to-eight-months', category: 'safe-sleep', priority: 6, urgency: 'important',
    titleKo: '돌 전까지 안전 수면을 계속해요', titleJa: '1歳まで安全な睡眠を続ける',
    summaryKo: '모든 잠은 등으로 시작하고 단단하고 평평한 별도 침대를 비워 둬요.', summaryJa: 'すべての睡眠はあおむけで始め、硬く平らな別の寝床を空にします。',
    actionsKo: ['양방향으로 스스로 뒤집을 수 있다면 아기가 취한 자세는 그대로 둘 수 있지만, 눕힐 때는 계속 등을 대요.'],
    actionsJa: ['両方向に自分で寝返りできる場合は自分でとった姿勢はそのままでかまいませんが、寝かせる時は毎回あおむけにします。'],
    sourceIds: ['aap-safe-sleep-2022', 'nichd-safe-sleep', 'cfa-safe-sleep'],
  },
  {
    id: 'three-to-five-months-accident-prevention', stageId: 'three-to-five-months', category: 'general', priority: 6, urgency: 'important',
    titleKo: '뒤집기 전 추락 환경을 먼저 바꿔요', titleJa: '寝返り前に転落環境を見直す',
    summaryKo: '갑자기 뒤집을 수 있으므로 높은 곳에 혼자 두지 않아요.', summaryJa: '急に寝返りすることがあるため、高い場所にひとりで置きません。',
    actionsKo: ['침대·소파·기저귀 교환대에서는 손을 떼지 않고, 바닥의 안전한 공간을 우선 사용해요.'],
    actionsJa: ['ベッド・ソファ・おむつ交換台では手を離さず、安全な床のスペースを優先します。'],
    sourceIds: ['cfa-accident-prevention'],
  },
  {
    id: 'six-to-eight-months-accident-prevention', stageId: 'six-to-eight-months', category: 'general', priority: 7, urgency: 'important',
    titleKo: '작은 물건과 추락 위험을 치워요', titleJa: '小物と転落リスクを片づける',
    summaryKo: '손에 잡힌 것을 입으로 가져가고 이동을 시작하는 시기에 맞춰 환경을 바꿔요.', summaryJa: 'つかんだ物を口へ運び、移動を始める時期に合わせ環境を変えます。',
    actionsKo: ['동전·단추·배터리·자석 등 작은 물건을 닿지 않게 하고, 침대·소파·계단 가장자리에서 혼자 두지 않아요.'],
    actionsJa: ['硬貨・ボタン・電池・磁石など小物を手の届かない所に置き、ベッド・ソファ・階段の端にひとりで置きません。'],
    sourceIds: ['cfa-accident-prevention'],
  },
  {
    id: 'nine-to-eleven-months-accident-prevention', stageId: 'nine-to-eleven-months', category: 'general', priority: 6, urgency: 'important',
    titleKo: '기어 다니고 붙잡고 설 환경을 점검해요', titleJa: 'はいはい・つかまり立ちの環境を点検',
    summaryKo: '작은 물건·계단·넘어지는 가구·뜨거운 물건을 손이 닿지 않게 해요.', summaryJa: '小物・階段・倒れる家具・熱い物を手の届かない所にします。',
    actionsKo: ['가구와 TV를 고정하고 계단·창문 접근을 막으며, 먹거나 목욕할 때 보호자가 바로 곁에 있어요.'],
    actionsJa: ['家具とテレビを固定し、階段・窓への接近を防ぎ、食事中や入浴中は保護者がすぐそばにいます。'],
    sourceIds: ['cfa-accident-prevention'],
  },
  {
    id: 'twelve-to-seventeen-months-accident-prevention', stageId: 'twelve-to-seventeen-months', category: 'general', priority: 6, urgency: 'important',
    titleKo: '걷기 시작에 맞춰 낙상·화상·익수를 막아요', titleJa: '歩き始めに転落・やけど・溺水を防ぐ',
    summaryKo: '창문·계단·가구·뜨거운 조리기구·물 주변을 다시 점검해요.', summaryJa: '窓・階段・家具・熱い調理器具・水まわりを再点検します。',
    actionsKo: ['가구를 고정하고 창문 가까이 딛고 설 물건을 두지 않으며, 욕조·물통 근처에서는 한순간도 혼자 두지 않아요.'],
    actionsJa: ['家具を固定し、窓の近くに足場になる物を置かず、浴槽・水容器のそばでは一瞬もひとりにしません。'],
    sourceIds: ['cfa-accident-prevention'],
  },
  {
    id: 'eighteen-to-twenty-three-months-accident-prevention', stageId: 'eighteen-to-twenty-three-months', category: 'general', priority: 5, urgency: 'important',
    titleKo: '오르기·달리기 전에 집 안 위험을 낮춰요', titleJa: '登る・走る前に家の危険を減らす',
    summaryKo: '가구 전도, 창문 추락, 화상, 익수 위험을 아이 키와 움직임에 맞춰 막아요.', summaryJa: '家具転倒、窓からの転落、やけど、溺水を身長と動きに合わせ防ぎます。',
    actionsKo: ['가구·TV를 고정하고 창문 잠금과 주방 차단을 확인하며, 물 근처에서는 손이 닿는 거리에서 감독해요.'],
    actionsJa: ['家具・テレビを固定し、窓の施錠と台所への立入り防止を確認し、水辺では手の届く距離で見守ります。'],
    sourceIds: ['cfa-accident-prevention'],
  },
]

const commonUrgentStageIds: readonly AgeStageId[] = [
  'young-infant',
  'three-to-five-months',
  'six-to-eight-months',
  'nine-to-eleven-months',
  'twelve-to-seventeen-months',
  'eighteen-to-twenty-three-months',
  'two-years',
  'three-to-four-years',
  'five-years',
]

const sharedUrgentDefinitions: readonly AgeGuidanceItem[] = commonUrgentStageIds.map(stageId => ({
  id: `${stageId}-urgent-care`,
  stageId,
  category: 'urgent-care',
  priority: 8,
  urgency: 'urgent',
  titleKo: '응급 위험 신호',
  titleJa: '救急の危険サイン',
  summaryKo: '호흡곤란·청색 피부·심한 처짐·경련·눌러도 안 사라지는 발진은 바로 도움을 요청해요.',
  summaryJa: '呼吸困難、青い皮膚、強いぐったり、けいれん、押しても消えない発疹はすぐ助けを求めます。',
  actionsKo: ['깨워도 반응이 없거나 초록색 담즙성 구토가 있으면 즉시 지역 응급 도움을 요청해요.'],
  actionsJa: ['起こしても反応がない、または緑色の胆汁性嘔吐がある時は直ちに地域の救急へ連絡してください。'],
  sourceIds: ['nice-fever-ng143'],
}))

const infantSpecificUrgentDefinitions: readonly AgeGuidanceItem[] = [
  {
    id: 'young-infant-specific-urgent-care', stageId: 'young-infant', category: 'urgent-care', priority: 9, urgency: 'urgent',
    titleKo: '어린 영아에게 특히 중요한 위험 신호', titleJa: '低月齢児で特に重要な危険サイン',
    summaryKo: '어린 영아의 대천문 팽창이나 반복되는 분출성 구토는 바로 확인해요.', summaryJa: '低月齢児の大泉門の膨らみや繰り返す噴水状の嘔吐はすぐ確認します。',
    actionsKo: ['대천문이 불룩하거나 목이 뻣뻣하고, 반복되는 분출성 구토가 있으면 즉시 의료기관에 연락해요.'],
    actionsJa: ['大泉門が膨らむ、首が硬い、繰り返す噴水状の嘔吐がある時は直ちに医療機関へ連絡してください。'],
    sourceIds: ['nice-newborn-red-flags-ng194'],
  },
]

const countrySpecificGeneratedStages = AGE_STAGES.filter(
  stage => stage.id !== 'older-child-fallback'
)

const localCareDefinitions: readonly AgeGuidanceItem[] = countrySpecificGeneratedStages.flatMap(stage => {
  const priority = 7
  return [
    {
      id: `${stage.id}-local-care-kr`, stageId: stage.id, category: 'checkup-vaccination' as const, priority, urgency: 'routine' as const,
      titleKo: '한국 공식 검진·예방접종', titleJa: '韓国の公式健診・予防接種',
      summaryKo: '질병관리청의 최신 일정과 대상 조건을 확인해요.', summaryJa: '韓国疾病管理庁の最新日程と対象条件を確認します。',
      actionsKo: ['일정은 변경되거나 지연 접종에 따라 달라질 수 있으므로 공식 페이지와 의료진을 확인해요.'],
      actionsJa: ['日程は変更や接種の遅れで異なるため、公式ページと医療者へ確認してください。'],
      sourceIds: ['kdca-infant-checkups', 'kdca-vaccination'] as readonly HealthEvidenceSourceId[], country: 'KR' as const, linkPurpose: 'checkup-vaccination' as const,
    },
    {
      id: `${stage.id}-local-care-jp`, stageId: stage.id, category: 'checkup-vaccination' as const, priority, urgency: 'routine' as const,
      titleKo: '일본 공식 검진·예방접종', titleJa: '日本の公式健診・予防接種',
      summaryKo: '어린이가정청·후생노동성의 최신 지역 일정을 확인해요.', summaryJa: 'こども家庭庁・厚生労働省の最新の地域日程を確認します。',
      actionsKo: ['지자체별 검진과 접종 조건이 다를 수 있으므로 거주 지역 안내와 의료진을 확인해요.'],
      actionsJa: ['自治体ごとに健診・接種条件が異なるため、居住地域の案内と医療者へ確認してください。'],
      sourceIds: ['cfa-infant-checkups', 'mhlw-vaccination'] as readonly HealthEvidenceSourceId[], country: 'JP' as const, linkPurpose: 'checkup-vaccination' as const,
    },
  ]
})

const countryEmergencyDefinitions: readonly AgeGuidanceItem[] = countrySpecificGeneratedStages.flatMap(stage => [
  {
    id: `${stage.id}-emergency-kr`, stageId: stage.id, category: 'urgent-care' as const, priority: 10, urgency: 'urgent' as const,
    titleKo: '한국 응급 신고 119', titleJa: '韓国の救急通報は119',
    summaryKo: '생명을 위협하는 위험 신호가 있으면 대한민국 소방청 119에 즉시 신고해요.', summaryJa: '命に関わる危険サインがあれば韓国消防庁の119へ直ちに通報します。',
    actionsKo: ['119에 전화해 위치와 증상을 알리고 상담원의 안내를 따라요.'],
    actionsJa: ['119へ電話し、場所と症状を伝えて指令員の案内に従ってください。'],
    sourceIds: ['kr-nfa-119'] as readonly HealthEvidenceSourceId[], country: 'KR' as const, linkPurpose: 'emergency' as const,
  },
  {
    id: `${stage.id}-emergency-jp`, stageId: stage.id, category: 'urgent-care' as const, priority: 10, urgency: 'urgent' as const,
    titleKo: '일본 응급 신고 119', titleJa: '日本の救急通報は119',
    summaryKo: '생명을 위협하는 위험 신호가 있으면 일본 총무성 소방청 안내에 따라 119에 즉시 신고해요.', summaryJa: '命に関わる危険サインがあれば総務省消防庁の案内に従い119へ直ちに通報します。',
    actionsKo: ['119에 전화해 구급 요청, 위치와 증상을 알리고 상담원의 안내를 따라요.'],
    actionsJa: ['119へ電話し、救急であること、場所と症状を伝えて指令員の案内に従ってください。'],
    sourceIds: ['jp-fdma-119'] as readonly HealthEvidenceSourceId[], country: 'JP' as const, linkPurpose: 'emergency' as const,
  },
])

export const AGE_GUIDANCE_ITEMS: readonly AgeGuidanceItem[] = Object.freeze(
  [
    ...itemDefinitions,
    ...sharedUrgentDefinitions,
    ...infantSpecificUrgentDefinitions,
    ...localCareDefinitions,
    ...countryEmergencyDefinitions,
  ].map(item => Object.freeze({
    ...item,
    actionsKo: Object.freeze([...item.actionsKo]),
    actionsJa: Object.freeze([...item.actionsJa]),
    sourceIds: Object.freeze([...item.sourceIds]),
  }))
)

export const AGE_GUIDANCE_DISCLAIMER = Object.freeze({
  ko: '이 안내는 일반적인 공중보건 지침이며 진단·처방이나 아이의 진료 계획을 대신하지 않아요. 미숙아는 의료진이 정한 교정 연령과 진료 계획을 우선하고, 질환이 있거나 성장·수유·발달이 걱정되면 담당 의료진과 상의하세요. 응급 위험 신호가 있으면 즉시 119 또는 지역 응급의료기관에 연락하세요.',
  ja: 'この案内は一般的な公衆衛生情報で、診断・処方やお子さんの診療計画に代わるものではありません。早産児は医療者が定めた修正月齢と診療計画を優先し、病気がある、または成長・授乳・発達が心配な時は担当医療者へ相談してください。救急の危険サインがあれば直ちに119または地域の救急医療へ連絡してください。',
})

export function getAgeGuidanceForDate(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date(),
  country?: AgeGuidanceCountry
): readonly AgeGuidanceItem[] {
  const stage = getAgeStage(birthdate, asOf)
  if (!stage) return Object.freeze([])

  return Object.freeze(AGE_GUIDANCE_ITEMS
    .filter(item => item.stageId === stage.id && (!item.country || !country || item.country === country))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)))
}

export function getPriorityAgeGuidanceForDate(
  birthdate: string | null | undefined,
  asOf: DateInput = new Date(),
  country?: AgeGuidanceCountry
): readonly AgeGuidanceItem[] {
  return Object.freeze(getAgeGuidanceForDate(birthdate, asOf, country).slice(0, 3))
}

export interface LocalizedAgeGuidance {
  readonly id: string
  readonly stageId: AgeStageId
  readonly category: AgeGuidanceCategory
  readonly priority: number
  readonly urgency: AgeGuidanceUrgency
  readonly title: string
  readonly summary: string
  readonly actions: readonly string[]
  readonly sourceIds: readonly HealthEvidenceSourceId[]
  readonly country?: AgeGuidanceCountry
  readonly linkPurpose?: AgeGuidanceLinkPurpose
}

export function localizeAgeGuidance(
  item: AgeGuidanceItem,
  locale: HealthContentLocale
): LocalizedAgeGuidance {
  return Object.freeze({
    id: item.id,
    stageId: item.stageId,
    category: item.category,
    priority: item.priority,
    urgency: item.urgency,
    title: locale === 'ko' ? item.titleKo : item.titleJa,
    summary: locale === 'ko' ? item.summaryKo : item.summaryJa,
    actions: Object.freeze([...(locale === 'ko' ? item.actionsKo : item.actionsJa)]),
    sourceIds: Object.freeze([...item.sourceIds]),
    country: item.country,
    linkPurpose: item.linkPurpose,
  })
}
