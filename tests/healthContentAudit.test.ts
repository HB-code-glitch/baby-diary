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
    expect(koStats.tempContextNote).toMatch(/기록|평균/)
    expect(koStats.tempContextNote).toMatch(/나이/)
    expect(koStats.tempContextNote).toMatch(/측정 부위/)
    expect(jaStats.tempContextNote).toMatch(/記録|平均/)
    expect(jaStats.tempContextNote).toMatch(/年齢/)
    expect(jaStats.tempContextNote).toMatch(/測定部位/)
  })

  it('labels report temperature counts as recorded values with age and site context', () => {
    const reportSource = read('src/report/ReportView.tsx')
    const koReport = ko.report as Record<string, string>
    const jaReport = ja.report as Record<string, string>
    expect(koReport.feverCount).toBe('38°C 이상 기록값')
    expect(jaReport.feverCount).toBe('38°C以上の記録値')
    expect(koReport.temperatureContext).toMatch(/나이.*측정 부위|측정 부위.*나이/)
    expect(jaReport.temperatureContext).toMatch(/年齢.*測定部位|測定部位.*年齢/)
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
    expect(koStats.growthDisclaimer).toMatch(/0~24개월/)
    expect(koStats.growthDisclaimer).toMatch(/추세/)
    expect(koStats.growthDisclaimer).toMatch(/측정/)
    expect(jaStats.growthDisclaimer).toMatch(/0〜24か月/)
    expect(jaStats.growthDisclaimer).toMatch(/推移/)
    expect(jaStats.growthDisclaimer).toMatch(/測定/)
    expect(koReport.growthPctValue).toContain('약')
    expect(jaReport.growthPctValue).toContain('約')
    expect(koReport.footerDisclaimer).toMatch(/0~24개월.*추세.*측정/)
    expect(jaReport.footerDisclaimer).toMatch(/0〜24か月.*推移.*測定/)
  })

  it('registers the exact official WHO child growth standards source', () => {
    const source = getEvidenceSourceById('who-child-growth-standards')
    expect(source?.url).toBe('https://www.who.int/tools/child-growth-standards')
    expect(source?.reviewedOn).toBe('2026-07-13')
  })

  it('explains that only an unfinished 16-hour sleep timer is discarded', () => {
    const koSleep = ko.sleep as Record<string, string>
    const jaSleep = ja.sleep as Record<string, string>
    expect(koSleep.discardTitle).toContain('미완료')
    expect(koSleep.discardBody).toMatch(/저장하지 않고 종료/)
    expect(koSleep.discardBody).toMatch(/저장된 수면 기록.*삭제되지/)
    expect(jaSleep.discardTitle).toContain('未完了')
    expect(jaSleep.discardBody).toMatch(/保存せず終了/)
    expect(jaSleep.discardBody).toMatch(/保存済みの睡眠記録.*削除/)
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
  })

  it('ships a dated audit ledger mapping retained topics to exact source IDs and URLs', () => {
    const ledgerPath = join(ROOT, 'docs/health-content-audit.md')
    expect(existsSync(ledgerPath)).toBe(true)
    const ledger = readFileSync(ledgerPath, 'utf8')
    expect(ledger).toContain('검토일: 2026-07-13')
    for (const topic of ['체온 기록', 'WHO 성장', '반응적 수유', '안전 수면', '발달 관찰', '문화 기념일']) {
      expect(ledger, topic).toContain(topic)
    }
    for (const [id, url] of [
      ['who-child-growth-standards', 'https://www.who.int/tools/child-growth-standards'],
      ['aap-fever-baby', 'https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/Fever-and-Your-Baby.aspx'],
      ['nice-fever-ng143', 'https://www.nice.org.uk/guidance/ng143'],
      ['cdc-developmental-milestones', 'https://www.cdc.gov/act-early/milestones/index.html'],
    ]) {
      expect(ledger, id).toContain(id)
      expect(ledger, url).toContain(url)
    }
  })
})
