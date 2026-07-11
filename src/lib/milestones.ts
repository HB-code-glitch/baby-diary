/**
 * src/lib/milestones.ts
 * KR/JP baby cultural milestones — computed from birthdate.
 * offsetFromBirth: day 1 = birth date (same as D+1 convention).
 */

import { addDays, addMonths, format, parseISO, isBefore, getMonth, getDate, getYear, setYear, setMonth, setDate, differenceInDays } from 'date-fns'

export type MilestoneCulture = 'ko' | 'ja' | 'both'

export interface Milestone {
  id: string
  date: string           // 'yyyy-MM-dd'
  nameKo: string
  nameJa: string
  descKo: string
  descJa: string
  culture: MilestoneCulture
}

/** Alias for Milestone — used by markers.ts and external consumers */
export type ComputedMilestone = Milestone

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** birth+N days where birth counts as day 1, so offset = N-1 actual days. */
function birthPlusDays(birth: Date, dayNumber: number): Date {
  return addDays(birth, dayNumber - 1)
}

/** Add calendar months to birthdate. */
function birthPlusMonths(birth: Date, months: number): Date {
  return addMonths(birth, months)
}

// ---------------------------------------------------------------------------
// getMilestones
// ---------------------------------------------------------------------------

export function getMilestones(birthdate: string, gender?: 'girl' | 'boy'): Milestone[] {
  if (!birthdate) return []

  const birth = parseISO(birthdate)
  const milestones: Milestone[] = []

  // ── 삼칠일 (day 21, Korean tradition) ──────────────────────────────────
  milestones.push({
    id: 'samchil-il',
    date: fmt(birthPlusDays(birth, 21)),
    nameKo: '삼칠일',
    nameJa: '三七日（セイレ）',
    descKo: '출생 21일째, 아기를 처음 외부에 공개하고 건강을 기원하는 날이에요',
    descJa: '生後21日目、赤ちゃんを初めてお披露目し健康を祈る韓国の伝統です',
    culture: 'ko',
  })

  // ── お七夜 (day 7, Japanese naming ceremony) ───────────────────────────
  milestones.push({
    id: 'oshichiya',
    date: fmt(birthPlusDays(birth, 7)),
    nameKo: '오시치야(명명식)',
    nameJa: 'お七夜（命名式）',
    descKo: '출생 7일째 밤, 아기 이름을 명명서에 써서 발표하는 일본 전통이에요',
    descJa: '生後7日目の夜、命名書に名前を書いてお披露目する行事です',
    culture: 'ja',
  })

  // ── お宮参り (first shrine visit, ~1 month) ────────────────────────────
  // boy birth+30d, girl birth+31d, gender unset → +30d
  // day-1 convention: boy=31st day (offset 30), girl=32nd day (offset 31)
  const omiyamairOffset = gender === 'girl' ? 32 : 31  // day number (day1=birth)
  milestones.push({
    id: 'omiyamairi',
    date: fmt(birthPlusDays(birth, omiyamairOffset)),
    nameKo: '오미야마이리(첫 신사 참배)',
    nameJa: 'お宮参り',
    descKo: '생후 한 달께 신사에서 탄생을 감사하고 성장을 기원하는 첫 외출 의례예요',
    descJa: '生後約1ヶ月、神社に参拝して誕生を報告し健やかな成長を祈る行事です',
    culture: 'ja',
  })

  // ── 백일 / お食い初め (day 100) ──────────────────────────────────────
  milestones.push({
    id: 'baekil',
    date: fmt(birthPlusDays(birth, 100)),
    nameKo: '백일',
    nameJa: '百日（ペギル）',
    descKo: '무사히 100일을 맞은 것을 감사하는 날 — 백일상과 기념사진으로 축하해요. 일본의 오쿠이조메(お食い初め)와 같은 날이에요',
    descJa: '無事に100日を迎えたことに感謝する日。お食い初めの祝い膳で、一生食べ物に困らないよう願います',
    culture: 'both',
  })

  // ── ハーフバースデー (6 calendar months) ───────────────────────────────
  milestones.push({
    id: 'half-birthday',
    date: fmt(birthPlusMonths(birth, 6)),
    nameKo: '하프 버스데이',
    nameJa: 'ハーフバースデー',
    descKo: '생후 6개월 기념 — 표정이 풍부해진 아기의 성장을 기록해요',
    descJa: '生後6ヶ月のお祝い。成長の記録にぴったりの日です',
    culture: 'both',
  })

  // ── 初節句 (first seasonal festival after birth) ───────────────────────
  // girl → 3/3, boy → 5/5, gender unset → skip
  // if that date is within 30 days of birth, postpone to next year
  if (gender === 'girl' || gender === 'boy') {
    const festivalMonth = gender === 'girl' ? 2 : 4  // 0-indexed: March=2, May=4
    const festivalDay = gender === 'girl' ? 3 : 5

    // Find first occurrence of festival date in same or next year
    let candidate = setDate(setMonth(setYear(birth, getYear(birth)), festivalMonth), festivalDay)
    if (isBefore(candidate, birth)) {
      candidate = setDate(setMonth(setYear(birth, getYear(birth) + 1), festivalMonth), festivalDay)
    }
    // if candidate is within 30 days of birth (i.e. days difference < 30), push to next year
    const diffDays = Math.floor((candidate.getTime() - birth.getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays < 30) {
      candidate = setDate(setMonth(setYear(candidate, getYear(candidate) + 1), festivalMonth), festivalDay)
    }

    milestones.push({
      id: 'hatsu-sekku',
      date: fmt(candidate),
      nameKo: '하츠젯쿠(첫 절구)',
      nameJa: '初節句',
      descKo: '태어나 처음 맞는 절구예요 — 여아는 3월 3일 히나마츠리, 남아는 5월 5일 단오',
      descJa: '生まれて初めて迎える節句。女の子は桃の節句、男の子は端午の節句です',
      culture: 'ja',
    })
  }

  // ── 첫돌 / 初誕生日 (1st birthday) ────────────────────────────────────
  const firstBirthday = addMonths(birth, 12)
  milestones.push({
    id: 'cheosdol',
    date: fmt(firstBirthday),
    nameKo: '첫돌',
    nameJa: '初誕生日（トルジャンチ）',
    descKo: '만 1세 생일 — 돌상과 돌잡이로 축하하는 가장 큰 잔치예요. 일본에선 잇쇼모치(一升餅)를 지는 날',
    descJa: '満1歳のお誕生日。韓国ではトルジャビ、日本では一升餅・選び取りでお祝いします',
    culture: 'both',
  })

  // ── 七五三 (Shichi-Go-San, Nov 15 of qualifying years) ────────────────
  // ages 3 (both genders), 5 (boy), 7 (girl). gender unset → age 3 only
  const birthYear = getYear(birth)
  for (let year = birthYear; year <= birthYear + 10; year++) {
    const nov15 = setDate(setMonth(setYear(birth, year), 10), 15)  // month 10 = November (0-indexed)
    const fullAge = year - birthYear - (
      (getMonth(birth) > 10 || (getMonth(birth) === 10 && getDate(birth) > 15)) ? 1 : 0
    )
    if (fullAge < 2 || fullAge > 8) continue

    const qualifies =
      (fullAge === 3) ||
      (fullAge === 5 && gender === 'boy') ||
      (fullAge === 7 && gender === 'girl')

    if (qualifies) {
      milestones.push({
        id: `shichigosan-${year}`,
        date: fmt(nov15),
        nameKo: '시치고산',
        nameJa: '七五三',
        descKo: '만 3·5·7세 되는 해 11월 15일께 신사에서 성장을 감사하는 행사예요',
        descJa: '3歳・5歳・7歳の11月15日頃、神社で成長を感謝する行事です',
        culture: 'ja',
      })
    }
  }

  // ── 생일 / 誕生日 (yearly, years 2..10) ───────────────────────────────
  for (let yr = 2; yr <= 10; yr++) {
    const bday = addMonths(birth, yr * 12)
    milestones.push({
      id: `yearly-birthday-${yr}`,
      date: fmt(bday),
      nameKo: `${yr}번째 생일`,
      nameJa: `${yr}歳のお誕生日`,
      descKo: '우리 아기의 생일이에요',
      descJa: '赤ちゃんのお誕生日です',
      culture: 'both',
    })
  }

  return milestones.sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// getUpcoming
// ---------------------------------------------------------------------------

/**
 * Returns milestones within [today, today + withinDays] inclusive (D-0 included).
 * today: 'yyyy-MM-dd' string or Date
 */
export function getUpcoming(
  milestones: Milestone[],
  today: string | Date,
  withinDays: number
): Array<Milestone & { daysUntil: number }> {
  const todayStr = typeof today === 'string' ? today : format(today, 'yyyy-MM-dd')
  const todayDate = typeof today === 'string' ? parseISO(today) : today

  return milestones
    .map(m => {
      const mDate = parseISO(m.date)
      const daysUntil = differenceInDays(mDate, todayDate)
      return { ...m, daysUntil }
    })
    .filter(m => m.daysUntil >= 0 && m.daysUntil <= withinDays)
    .sort((a, b) => a.daysUntil - b.daysUntil)
}
