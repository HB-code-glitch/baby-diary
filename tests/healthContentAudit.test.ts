import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getEvidenceSourceById } from '../shared/healthEvidence'
import { getMilestones } from '../src/lib/milestones'

const ROOT = process.cwd()
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const ko = JSON.parse(read('src/i18n/ko.json')) as Record<string, unknown>
const ja = JSON.parse(read('src/i18n/ja.json')) as Record<string, unknown>

function collectFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory)).flatMap(name => {
    const absolute = join(ROOT, directory, name)
    const workspacePath = relative(ROOT, absolute).replaceAll('\\', '/')
    return statSync(absolute).isDirectory()
      ? collectFiles(workspacePath)
      : [workspacePath]
  })
}

const auditedFiles = ['src', 'electron', 'shared']
  .flatMap(collectFiles)
  .filter(path => /\.(?:ts|tsx|json)$/.test(path))

const auditedSource = auditedFiles.map(path => read(path)).join('\n')

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, '')
}

function flattenStrings(value: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  if (typeof value === 'string') {
    result.set(prefix, value)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key
      for (const [childKey, childValue] of flattenStrings(child, childPrefix)) {
        result.set(childKey, childValue)
      }
    }
  }
  return result
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([\w.-]+)\s*}}/g)]
    .map(match => match[1])
    .sort()
}

function expectMeaningPair(
  koValue: string,
  jaValue: string,
  concepts: ReadonlyArray<{ label: string; ko: RegExp; ja: RegExp }>,
): void {
  for (const concept of concepts) {
    expect(koValue, `ko: ${concept.label}`).toMatch(concept.ko)
    expect(jaValue, `ja: ${concept.label}`).toMatch(concept.ja)
  }
}

describe('whole-app health content audit guards', () => {
  it('keeps Korean and Japanese key and placeholder parity', () => {
    const koStrings = flattenStrings(ko)
    const jaStrings = flattenStrings(ja)
    expect([...jaStrings.keys()].sort()).toEqual([...koStrings.keys()].sort())

    for (const [key, koValue] of koStrings) {
      expect(placeholders(jaStrings.get(key) ?? ''), key).toEqual(placeholders(koValue))
    }
  })

  it('removes retired guidance keys that have no consumer', () => {
    const retiredKeys = ['calendarChip', 'dayBannerTitle', 'disclaimer', 'currentFormulaLabel']
    const koGuidance = ko.guidance as Record<string, unknown>
    const jaGuidance = ja.guidance as Record<string, unknown>
    for (const key of retiredKeys) {
      expect(koGuidance, `ko guidance.${key}`).not.toHaveProperty(key)
      expect(jaGuidance, `ja guidance.${key}`).not.toHaveProperty(key)
    }
  })

  it('has no retired commercial sources or normalized high-risk marketing and schedule phrases', () => {
    const normalized = normalize(auditedSource)
    const forbiddenDomains = [
      'kellymom.com',
      'kidshealth.org',
      'mamanoko.jp',
      'mamano.jp',
      'tamahiyo.jp',
      'seattlechildrens.org',
      'nemours.org',
    ]
    for (const domain of forbiddenDomains) {
      expect(auditedSource.toLowerCase(), domain).not.toContain(domain)
    }

    const forbiddenPhrases = [
      '미온수로닦',
      'ぬるま湯で体を拭',
      'tepid sponging',
      '2세미만은24시간',
      '2歳未満は24時間',
      '그이상은3일',
      'それ以上は3日',
      '400iu로수렴',
      '400iuへ収束',
      '하루상한960ml',
      '1日の上限960ml',
      '오늘남은허용량',
      '今日の残り許容量',
      '다음수유예정시각',
      '次の授乳予定時刻',
      '땅콩알레르기약80%감소',
      'ピーナッツアレルギー約80%減',
      '달걀약79%감소',
      '卵約79%減',
      '2.3~13.1배',
      '2.3〜13.1倍',
      '평균약58iu/l',
      '平均約58iu/l',
    ]
    for (const phrase of forbiddenPhrases) {
      expect(normalized, phrase).not.toContain(normalize(phrase))
    }
  })

  it('removes the unexplained temperature reference line and explains recorded-value context', () => {
    const statsSource = read('src/pages/StatsPage.tsx')
    const koStats = ko.stats as Record<string, string>
    const jaStats = ja.stats as Record<string, string>
    expect(statsSource).not.toMatch(/<ReferenceLine|y=\{37\.5\}|37\.5℃/)
    expect(statsSource).toContain("t('stats.tempContextNote')")
    expectMeaningPair(koStats.tempContextNote, jaStats.tempContextNote, [
      { label: 'daily average is only a record summary', ko: /일별 평균.*기록 요약/, ja: /日ごとの平均.*記録の要約/ },
      { label: 'not a fever threshold', ko: /발열 기준선이 아니/, ja: /発熱の基準線ではありません/ },
      { label: 'age context', ko: /나이/, ja: /年齢/ },
      { label: 'measurement-site context', ko: /측정 부위/, ja: /測定部位/ },
    ])
  })

  it('shows neutral temperature-record presence in month and week history views', () => {
    const historySource = read('src/pages/HistoryPage.tsx')
    const koHistory = ko.history as Record<string, string>
    const jaHistory = ja.history as Record<string, string>
    expect(historySource).not.toMatch(/37\.5|hasHighTemp|tempHighIndicator/)
    expect(historySource.match(/\.some\(e => e\.type === 'temp'\)/g)).toHaveLength(2)
    expect(koHistory).not.toHaveProperty('tempHighIndicator')
    expect(jaHistory).not.toHaveProperty('tempHighIndicator')
    expect(koHistory.tempIndicator).toBe('체온 기록')
    expect(jaHistory.tempIndicator).toBe('体温記録')
  })

  it('labels report temperature counts as recorded values with age and site context', () => {
    const reportSource = read('src/report/ReportView.tsx')
    const koReport = ko.report as Record<string, string>
    const jaReport = ja.report as Record<string, string>
    expect(koReport.feverCount).toBe('38°C 이상 기록 수')
    expect(jaReport.feverCount).toBe('38°C以上の記録数')
    expectMeaningPair(koReport.temperatureContext, jaReport.temperatureContext, [
      { label: 'recorded values rather than fever events', ko: /입력된 기록 수.*발열 횟수.*뜻하지 않/, ja: /入力された記録数.*発熱回数.*意味せず/ },
      { label: 'not a diagnosis', ko: /진단을 뜻하지 않/, ja: /診断を意味せず/ },
      { label: 'age context', ko: /나이/, ja: /年齢/ },
      { label: 'measurement-site context', ko: /측정 부위/, ja: /測定部位/ },
    ])
    expect(reportSource).toContain("t('report.temperatureContext')")
    expect(reportSource).not.toContain('footerDisclaimerJa')
    expect(koReport).not.toHaveProperty('footerDisclaimerJa')
    expect(jaReport).not.toHaveProperty('footerDisclaimerJa')
  })

  it('describes WHO percentiles as approximate 0-24 month chart references', () => {
    const koStats = ko.stats as Record<string, string>
    const jaStats = ja.stats as Record<string, string>
    const koReport = ko.report as Record<string, string>
    const jaReport = ja.report as Record<string, string>

    expect(koStats.growthPercentile).toMatch(/WHO.*약 P{{pct}}/)
    expect(jaStats.growthPercentile).toMatch(/WHO.*約P{{pct}}/)
    expect(koStats.growthPercentile).not.toContain('100명 중')
    expect(jaStats.growthPercentile).not.toContain('100人中')
    expect(koStats.growthDisclaimer).toMatch(/WHO 성장 기준\(2006\) 중 앱 표시 범위는 0~24개월/)
    expect(koStats.growthDisclaimer).toMatch(/추세/)
    expect(koStats.growthDisclaimer).toMatch(/측정/)
    expect(jaStats.growthDisclaimer).toMatch(/WHO成長基準（2006年）のうち、アプリの表示範囲は0〜24か月/)
    expect(jaStats.growthDisclaimer).toMatch(/推移/)
    expect(jaStats.growthDisclaimer).toMatch(/測定/)
    expect(koReport.growthPctValue).toContain('약')
    expect(jaReport.growthPctValue).toContain('約')
    expect(koReport.footerDisclaimer).toMatch(/WHO 성장 기준\(2006\) 중 앱 표시 범위는 0~24개월.*추세.*측정/)
    expect(jaReport.footerDisclaimer).toMatch(/WHO成長基準（2006年）のうち、アプリの表示範囲は0〜24か月.*推移.*測定/)
  })

  it('registers the exact official WHO child growth standards source', () => {
    const source = getEvidenceSourceById('who-child-growth-standards')
    expect(source?.url).toBe('https://www.who.int/tools/child-growth-standards')
    expect(source?.reviewedOn).toBe('2026-07-13')
  })

  it('explains that only an unfinished 16-hour sleep timer is discarded', () => {
    const koSleep = ko.sleep as Record<string, string>
    const jaSleep = ja.sleep as Record<string, string>
    expectMeaningPair(koSleep.discardTitle, jaSleep.discardTitle, [
      { label: 'unfinished timer', ko: /미완료.*타이머/, ja: /未完了.*タイマー/ },
      { label: 'timer ends', ko: /종료/, ja: /終了/ },
    ])
    expectMeaningPair(koSleep.discardBody, jaSleep.discardBody, [
      { label: '16-hour boundary', ko: /16시간/, ja: /16時間/ },
      { label: 'unfinished timer is not saved', ko: /미완료.*저장하지 않고 종료/, ja: /未完了.*保存せず終了/ },
      { label: 'saved records remain', ko: /저장된 수면 기록.*삭제되지 않/, ja: /保存済みの睡眠記録.*削除されません/ },
    ])
  })

  it('frames health and growth wishes only as cultural traditions or celebrations', () => {
    const milestones = getMilestones('2026-01-01', 'boy')
    const culturalIds = ['samchil-il', 'omiyamairi', 'half-birthday']
    const selected = milestones.filter(item => culturalIds.includes(item.id) || item.id.startsWith('shichigosan-'))
    expect(selected.length).toBeGreaterThanOrEqual(4)
    for (const milestone of selected) {
      expect(milestone.descKo, milestone.id).toMatch(/전통|행사|기념|축하/)
      expect(milestone.descJa, milestone.id).toMatch(/伝統|行事|記念|お祝い/)
      expect(milestone.descKo, milestone.id).not.toMatch(/예방|효과|도움이|건강해|발달에 좋/)
      expect(milestone.descJa, milestone.id).not.toMatch(/予防|効果|役立|健康になる|発達に良/)
    }

    const halfBirthday = selected.find(item => item.id === 'half-birthday')!
    expectMeaningPair(halfBirthday.descKo, halfBirthday.descJa, [
      { label: 'six-month celebration', ko: /생후 6개월.*축하/, ja: /生後6か月.*祝い/ },
      { label: 'photo or memo commemoration', ko: /사진.*메모.*기념/, ja: /写真.*メモ.*記念/ },
    ])
    expect(halfBirthday.descKo).not.toMatch(/표정|발달|성장/)
    expect(halfBirthday.descJa).not.toMatch(/表情|発達|成長/)
  })

  it('uses °C and mL consistently in user-facing health record copy', () => {
    const koSummary = ko.summary as Record<string, string>
    const jaSummary = ja.summary as Record<string, string>
    const koStats = ko.stats as Record<string, string>
    const jaStats = ja.stats as Record<string, string>
    const koFeedingTip = ko.feedingTip as Record<string, string>
    const jaFeedingTip = ja.feedingTip as Record<string, string>
    const koReport = ko.report as Record<string, string>
    const jaReport = ja.report as Record<string, string>

    for (const [koValue, jaValue] of [
      [koSummary.formulaTotal, jaSummary.formulaTotal],
      [koStats.formulaTitle, jaStats.formulaTitle],
      [koStats.mlUnit, jaStats.mlUnit],
      [koFeedingTip.formulaRecorded, jaFeedingTip.formulaRecorded],
      [koReport.avgFormulaMlUnit, jaReport.avgFormulaMlUnit],
      [koReport.dailyFormulaMl, jaReport.dailyFormulaMl],
    ]) {
      expect(koValue).toContain('mL')
      expect(jaValue).toContain('mL')
    }
    expect(koReport.tempUnit).toBe('{{value}}°C')
    expect(jaReport.tempUnit).toBe('{{value}}°C')

    for (const path of ['src/pages/HomePage.tsx', 'src/pages/HistoryPage.tsx', 'src/store/useAppStore.ts']) {
      expect(read(path), path).not.toMatch(/(?:\}|\d)ml\b/)
    }
  })

  it('ships a dated audit ledger mapping retained topics to exact source IDs and URLs', () => {
    const ledgerPath = join(ROOT, 'docs/health-content-audit.md')
    expect(existsSync(ledgerPath)).toBe(true)
    const ledger = readFileSync(ledgerPath, 'utf8')
    expect(ledger).toContain('검토일: 2026-07-13')
    for (const topic of ['체온 기록', 'WHO 성장', '반응적 수유', '안전 수면', '발달 관찰', '문화 기념일']) {
      expect(ledger, topic).toContain(topic)
    }
    const retainedTable = ledger
      .split('## 유지한 주제와 결정')[1]
      ?.split('## 제거·중립화한 항목')[0] ?? ''
    const sourceColumns = retainedTable
      .split(/\r?\n/)
      .filter(line => /^\|.*\|$/.test(line) && !/^\|[-:| ]+\|$/.test(line))
      .slice(1)
      .map(line => line.split('|')[4]?.trim() ?? '')

    const referencedIds = new Set<string>()
    for (const sourceColumn of sourceColumns) {
      const codeIds = [...sourceColumn.matchAll(/`([a-z0-9-]+)`/g)].map(match => match[1])
      const links = [...sourceColumn.matchAll(/\[`([a-z0-9-]+)`\]\((https:\/\/[^)]+)\)/g)]
      expect(links.map(match => match[1]), sourceColumn).toEqual(codeIds)
      for (const [, id, url] of links) {
        const registrySource = getEvidenceSourceById(id)
        expect(registrySource, `unknown audit source ID: ${id}`).not.toBeNull()
        expect(url, `audit URL drift for ${id}`).toBe(registrySource?.url)
        referencedIds.add(id)
      }
    }
    expect(referencedIds.size).toBeGreaterThan(20)
  })
})
