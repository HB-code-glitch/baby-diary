/**
 * src/lib/breastfeeding.ts
 * Breastfeeding interval recommendation data and helpers.
 * Sources: 대한소아청소년과학회, 아이사랑(보건복지부), AAP, KellyMom, 厚生労働省, etc.
 *
 * All typed constants below are VERBATIM from the research synthesis.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreastBand {
  id: string
  startDay: number
  ageLabelKo: string
  ageLabelJa: string
  intervalMinHours: number
  intervalMaxHours: number | null
  feedsPerDayMin: number
  feedsPerDayMax: number
  maxStretchHours: number | null
  noteKo: string
  noteJa: string
  sourceLabel: string
}

export interface NextFeedResult {
  windowStart: Date          // last + intervalMinHours
  windowEnd: Date | null     // last + intervalMaxHours; null if intervalMaxHours null
  maxStretchAt: Date | null  // last + maxStretchHours if band has it; else null
  band: BreastBand
}

// ---------------------------------------------------------------------------
// VERBATIM dataset — 8 bands
// ---------------------------------------------------------------------------

export const BREASTFEEDING_BANDS: BreastBand[] = [
  {
    id: 'newborn-0-2w',
    startDay: 0,
    ageLabelKo: '신생아 (0~2주)',
    ageLabelJa: '新生児 (0〜2週)',
    intervalMinHours: 1.5,
    intervalMaxHours: 3,
    feedsPerDayMin: 8,
    feedsPerDayMax: 12,
    maxStretchHours: 4,
    noteKo: '하루 8~12회 이상 자주 먹이고, 잠든 아기라도 낮 3시간·밤 4시간을 넘기지 않게 깨워서 수유해요.',
    noteJa: '1日8〜12回以上こまめに授乳し、眠っている赤ちゃんでも昼3時間・夜4時間以上あけないよう起こして授乳します。',
    sourceLabel: '대한소아청소년과학회 Q&A, 아이사랑(보건복지부), AAP HealthyChildren, KidsHealth',
  },
  {
    id: 'newborn-2-4w',
    startDay: 14,
    ageLabelKo: '신생아 (2~4주)',
    ageLabelJa: '新生児 (2〜4週)',
    intervalMinHours: 2,
    intervalMaxHours: 3,
    feedsPerDayMin: 8,
    feedsPerDayMax: 9,
    maxStretchHours: 4,
    noteKo: '출생 체중을 회복해도 체중 증가가 충분히 확인될 때까지는 밤 4시간을 넘기지 않게 깨워서 먹여요.',
    noteJa: '出生体重に戻っても、体重増加が十分に確認できるまでは夜間4時間以上あけないよう起こして授乳します。',
    sourceLabel: '아이사랑(보건복지부), KellyMom, 대한소아청소년과학회 Q&A',
  },
  {
    id: 'm1-2',
    startDay: 30,
    ageLabelKo: '1~2개월',
    ageLabelJa: '生後1〜2か月',
    intervalMinHours: 2,
    intervalMaxHours: 4,
    feedsPerDayMin: 6,
    feedsPerDayMax: 12,
    maxStretchHours: 4,
    noteKo: '일본 기준으로 생후 2개월까지는 4시간 이상 간격을 두지 않는 것을 권장하며, 2개월이 지나면 수유 횟수가 점차 5~8회로 줄어요.',
    noteJa: '生後2か月までは4時間以上あけないことが勧められ、2か月を過ぎると授乳回数はしだいに5〜8回へ落ち着いてきます。',
    sourceLabel: '아이사랑(보건복지부), 札幌みらいクリニック, たまひよ(조산사 감수)',
  },
  {
    id: 'm3-4',
    startDay: 90,
    ageLabelKo: '3~4개월',
    ageLabelJa: '生後3〜4か月',
    intervalMinHours: 3,
    intervalMaxHours: 4,
    feedsPerDayMin: 5,
    feedsPerDayMax: 8,
    maxStretchHours: null,
    noteKo: '수유가 효율적으로 변해 1회 시간이 짧아지고, 밤에 4~6시간 길게 자는 구간이 자연스럽게 생기기 시작해요.',
    noteJa: '授乳が効率的になり1回の時間が短くなり、夜に4〜6時間まとまって眠る時間が自然に出てきます。',
    sourceLabel: '아이사랑(보건복지부), KellyMom, ままのて(소아과의사 감수)',
  },
  {
    id: 'm4-6',
    startDay: 120,
    ageLabelKo: '4~6개월',
    ageLabelJa: '生後4〜6か月',
    intervalMinHours: 4,
    intervalMaxHours: 6,
    feedsPerDayMin: 4,
    feedsPerDayMax: 6,
    maxStretchHours: null,
    noteKo: '생후 5~6개월부터 이유식을 하루 1회 시작하되, 모유는 아기가 원하는 만큼 이어서 먹여요.',
    noteJa: '生後5〜6か月から離乳食を1日1回始めますが、母乳は赤ちゃんが欲しがるだけ続けて与えます。',
    sourceLabel: '아이사랑(보건복지부), 厚生労働省 授乳・離乳の支援ガイド(2019)',
  },
  {
    id: 'm7-9',
    startDay: 210,
    ageLabelKo: '7~9개월',
    ageLabelJa: '生後7〜9か月',
    intervalMinHours: 5,
    intervalMaxHours: 6,
    feedsPerDayMin: 3,
    feedsPerDayMax: 5,
    maxStretchHours: null,
    noteKo: '중기 이유식(하루 2회)과 병행하며, 이유식은 모유를 대체하지 않고 보완하는 단계예요.',
    noteJa: '中期の離乳食(1日2回)と併用し、離乳食は母乳を置き換えるのではなく補う段階です。',
    sourceLabel: '아이사랑(보건복지부), 厚生労働省 授乳・離乳の支援ガイド(2019)',
  },
  {
    id: 'm10-12',
    startDay: 300,
    ageLabelKo: '10~12개월',
    ageLabelJa: '生後10〜12か月',
    intervalMinHours: 5,
    intervalMaxHours: 6,
    feedsPerDayMin: 2,
    feedsPerDayMax: 5,
    maxStretchHours: null,
    noteKo: '후기 이유식(하루 3회)이 자리 잡으면서 모유는 보완적으로 하루 2~3회 정도로 줄어들어요.',
    noteJa: '後期の離乳食(1日3回)が定着し、母乳は補助的に1日2〜3回ほどへ減っていきます。',
    sourceLabel: '아이사랑(보건복지부), mamanoko(소아과의사 감수), 札幌みらいクリニック',
  },
  {
    id: 'm12-24',
    startDay: 365,
    ageLabelKo: '12~24개월',
    ageLabelJa: '生後12〜24か月',
    intervalMinHours: 6,
    intervalMaxHours: null,
    feedsPerDayMin: 2,
    feedsPerDayMax: 3,
    maxStretchHours: null,
    noteKo: 'WHO는 만 2세까지 모유 수유를 권장하며, 이 시기 수유는 아기와 엄마가 원하는 동안 이어가면 돼요.',
    noteJa: 'WHOは2歳までの母乳育児を勧めており、この時期の授乳は赤ちゃんとお母さんが望む間は続けて大丈夫です。',
    sourceLabel: 'WHO, 厚生労働省 授乳・離乳の支援ガイド(2019), 아이사랑(보건복지부)',
  },
]

export const BF_DISCLAIMER = {
  ko: '여기 나온 간격과 횟수는 참고용이에요. 정해진 시간표가 아니라 아기가 배고픔 신호(입 오물거리기, 손 빨기, 고개 돌려 찾기 — 우는 것은 늦은 신호예요)를 보이면 언제든 원하는 만큼 먹이는 것이 기본이에요.',
  ja: 'ここに示した間隔や回数はあくまで目安です。決まった時間割ではなく、赤ちゃんが空腹サイン(口をもぐもぐする、手を吸う、顔を向けて探すなど。泣くのは遅めのサインです)を見せたら、いつでも欲しがるだけ授乳するのが基本です。',
}

export const BF_CLUSTER_NOTE = {
  ko: '저녁 시간대(대개 6~10시)에 아기가 짧은 간격으로 연달아 먹으려 하는 \'몰아 수유(클러스터 피딩)\'는 생후 첫 몇 주~3개월에 흔하고, 성장 급등기에 더 두드러져요. 모유가 부족하다는 신호가 아니라 정상적인 발달 반응이에요.',
  ja: '夕方(だいたい18〜22時)に赤ちゃんが短い間隔で続けて飲みたがる「クラスター授乳」は、生後数週間〜3か月ごろによく見られ、成長期(急成長)にはより目立ちます。母乳不足のサインではなく、正常な発達の反応です。',
}

export const BF_NEWBORN_RULE = {
  ko: '신생아는 잠들어 있어도 낮에는 3시간, 밤에는 4시간을 넘겨 굶기지 않도록 깨워서 수유해야 해요(대한소아청소년과학회 기준: 낮 최대 3시간·밤 최대 4시간). 이 규칙은 체중 증가가 충분히 확인될 때까지(보통 생후 수 주, 길게는 6주경까지) 적용하며, 황달·저혈당 예방과 젖 공급 확립을 위한 안전 규칙이에요. 일본 자료(札幌みらいクリニック)는 \'생후 2개월까지 4시간 이상 금지\'로 표현하되 개인차가 있어 참고 정도로 삼으라고 안내해요.',
  ja: '新生児は眠っていても、昼は3時間・夜は4時間以上あけて空腹にさせないよう起こして授乳します(大韓小児青少年科学会の基準:昼は最長3時間・夜は最長4時間)。このルールは体重増加が十分に確認できるまで(通常は生後数週間、長くて生後6週ごろまで)適用し、黄疸・低血糖の予防と母乳分泌の確立のための安全ルールです。日本の資料(札幌みらいクリニック)では「生後2か月までは4時間以上あけない」と表現されますが、個人差があるため目安程度にとの注意書きがあります。',
}

export const BF_SOURCE_NOTES: string[] = [
  '요구 수유(자율수유) 원칙: 厚生労働省 2019 授乳・離乳の支援ガイ드, JALC, 대한소아청소년과학회 Q&A, 질병관리청, AAP, WHO, LLL 모두 고정 시간표가 아닌 아기의 배고픔 신호에 반응하는 수유를 표준으로 명시. 간격 수치는 최대 허용 참고 기준이지 목표 스케줄이 아님.',
  '신생아 최대 공복 규칙은 출처마다 수치가 다름 — 이를 명확히 구분함: 대한소아청소년과학회 Q&A = 낮 최대 3시간·밤 최대 4시간; KellyMom = 낮 2시간·밤 4시간을 \'충분한 체중 증가가 확인될 때까지(보통 생후 수 주, 최대 6주경)\' 적용; Nemours KidsHealth = 밤낮 구분 없이 \'약 4시간 초과 금지(even overnight)\'; AAP HealthyChildren = 낮 3시간 이상이면 깨우기(2시간 아님), 생후 1개월 이후 체중 증가 양호 시 깨울 필요 없음; La Leche League GB = 낮/밤 구분 없는 단일 \'4~5시간 초과 금지\'. \'낮 2시간\'은 KellyMom 고유 수치이며 AAP·대한소아청소년과학회와 혼용 금지.',
  'LLLI(영문)는 초기 수일간 야간에도 \'3시간마다(no less than every three hours at night)\'를 권장하므로 \'밤 4시간 규칙\' 지지 출처가 아님. NHS는 최대 공복 규칙을 명시하지 않고 \'It\'s not possible to overfeed a breastfed baby\'라며 on-demand feeding만 강조 — 4시간 규칙 지지 출처에서 제외함.',
  '일본 \'생후 2개월까지 4시간 이상 금지\'는 札幌みらいクリニック에서 확인되며 \'個人差があるので参考程度に(개인차가 있으니 참고 정도로)\' 단서 동반. \'체중 양호+배뇨 6회 이상이면 예외\'는 이 단독 출처가 아닌 복수 일본 조산사 자료를 종합한 것이라 band에는 반영하지 않고 원칙 수준으로만 기술.',
  'JALC 페이지는 월령별 수치를 제공하지 않고 \'시계가 아닌 아기를 보라\'는 원칙과 \'생후 1개월 미만 24시간 8회 미만이면 깨워 수유\'라는 단일 지침만 제시 — 월령별 횟수 수치의 근거 출처에서 제외함. 일본 월령별 수치는 厚労省 가이드, たまひよ(조산사 감수), ままのて/mamanoko(소아과의사 감수), 札幌みら이クリニック에서 취함.',
  '한국 아이사랑 신생아 페이지는 \'8~12회·2~3시간 간격\'만 명시하고 \'야간 4시간 초과 금지\' 문구는 직접 확인되지 않음. 야간 4시간 규칙의 1차 근거는 대한소아청소년과학회 Q&A(\'주간 2~3시간 이상, 야간 4시간 이상 수유하지 않으면 안 됩니다\')에서만 확인됨.',
  '미확인 출처(band 수치의 1차 근거로 사용하지 않음): CDC how-much-how-often 페이지는 HTTP 403으로 독립 검증 실패(8~12회 등은 AAP·KidsHealth로 간접 확인); ABM Clinical Protocol #37은 PubMed 초록만 접근 가능해 구체적 간격·weight-regain caveat 직접 확인 불가.',
  'KR/JP/intl 수렴 처리: 신생아 8~12회는 3개 권역 모두 일치. 최대 공복 상한은 KR(낮3/밤4)·JP(2개월까지 4h)·KidsHealth(4h even overnight)가 대체로 \'밤 약 4시간\'으로 수렴하므로 안전 규칙에서 밤 4시간을 채택하고 낮 상한은 KR 기준 3시간 채택(KellyMom 2시간은 divergence로 명기). 1~2개월 감소 시점은 KR 아이사랑(\'2개월 지나면 5~8회\')과 JP 자료가 일치.',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the BreastBand active for a baby of `ageDays` days old.
 * Picks the band with the highest startDay that does not exceed ageDays.
 */
export function getBreastBand(ageDays: number): BreastBand {
  // Walk bands in reverse order (highest startDay first)
  for (let i = BREASTFEEDING_BANDS.length - 1; i >= 0; i--) {
    if (ageDays >= BREASTFEEDING_BANDS[i].startDay) {
      return BREASTFEEDING_BANDS[i]
    }
  }
  // ageDays < 0 or exactly 0 — return first band
  return BREASTFEEDING_BANDS[0]
}

/**
 * Computes next feed recommendation window from a breast feed event.
 *
 * @param lastBreastAtISO  ISO timestamp of the last breast feed (e.g. "2026-07-12T14:30:00.000Z")
 * @param ageDays          Baby age in days at the time of the feed
 */
export function computeNextFeed(lastBreastAtISO: string, ageDays: number): NextFeedResult {
  const band = getBreastBand(ageDays)
  const last = new Date(lastBreastAtISO)

  const windowStart = new Date(last.getTime() + band.intervalMinHours * 60 * 60 * 1000)

  const windowEnd = band.intervalMaxHours != null
    ? new Date(last.getTime() + band.intervalMaxHours * 60 * 60 * 1000)
    : null

  const maxStretchAt = band.maxStretchHours != null
    ? new Date(last.getTime() + band.maxStretchHours * 60 * 60 * 1000)
    : null

  return { windowStart, windowEnd, maxStretchAt, band }
}

/**
 * Formats a countdown duration in milliseconds to a human-readable string.
 * Examples: "2시간 30분", "45분" (ko); matches the language passed.
 */
export function formatCountdown(msRemaining: number, lang: 'ko' | 'ja' = 'ko'): string {
  const totalMinutes = Math.max(0, Math.floor(msRemaining / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60

  if (lang === 'ja') {
    if (hours > 0 && mins > 0) return `${hours}時間${mins}分`
    if (hours > 0) return `${hours}時間`
    return `${mins}分`
  }

  // ko
  if (hours > 0 && mins > 0) return `${hours}시간 ${mins}분`
  if (hours > 0) return `${hours}시간`
  return `${mins}분`
}
