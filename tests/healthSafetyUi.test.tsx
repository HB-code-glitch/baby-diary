import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../src/i18n'
import { FeedingTipPopup } from '../src/components/FeedingTipPopup'
import { getEvidenceSources } from '../src/lib/healthEvidence'
import { FEVER_CARE } from '../src/lib/guidance'
import {
  FeverModal,
  focusDialogAndCreateRestore,
  resolveFeverDialogKeyAction,
} from '../src/components/FeverModal'

afterEach(async () => {
  await i18n.changeLanguage('ko')
})

describe('Korean/Japanese health copy parity', () => {
  it('keeps equivalent red-flag and responsive-feeding keys without retired recommendations', () => {
    const ko = JSON.parse(readFileSync('src/i18n/ko.json', 'utf8'))
    const ja = JSON.parse(readFileSync('src/i18n/ja.json', 'utf8'))
    const keys = [
      'riskCheck',
      'riskIntro',
      'riskSelectedCount',
    ]
    for (const key of keys) {
      expect(ko.popover[key]).toBeTruthy()
      expect(ja.popover[key]).toBeTruthy()
    }
    expect(ko.popover.riskIntro).toContain('하나라도')
    expect(ja.popover.riskIntro).toContain('いずれか一つでも')
    expect(ko.feverModal.unknownAgeNote).toMatch(/36(?:\.0)?°C.*38(?:\.0)?°C|38(?:\.0)?°C.*36(?:\.0)?°C/)
    expect(ja.feverModal.unknownAgeNote).toMatch(/36(?:\.0)?°C.*38(?:\.0)?°C|38(?:\.0)?°C.*36(?:\.0)?°C/)
    expect(ko.feverModal.emergencyBody).toMatch(/3개월 미만.*90일 미만|90일 미만.*3개월 미만/)
    expect(ja.feverModal.emergencyBody).toMatch(/3か月未満.*90日未満|90日未満.*3か月未満/)

    const exposedCopy = JSON.stringify({
      ko: { home: ko.home, popover: ko.popover, feedingTip: ko.feedingTip, feverModal: ko.feverModal },
      ja: { home: ja.home, popover: ja.popover, feedingTip: ja.feedingTip, feverModal: ja.feverModal },
    })
    expect(exposedCopy).not.toMatch(/반대쪽 추천|反対側がおすすめ|다음 수유|次の授乳|960|24시간|24時間|3일|3日/)
  })
})

describe('FeedingTipPopup safety copy', () => {
  it('shows the recorded formula total and cues without quota or remaining calculations', async () => {
    await i18n.changeLanguage('ko')
    const html = renderToStaticMarkup(
      <FeedingTipPopup
        type="formula"
        ageDays={42}
        lastBreastSide={null}
        todayFormulaTotalMl={700}
        todayFeedingCount={6}
        lastBreastAtISO={undefined}
        onDismiss={() => undefined}
      />,
    )

    expect(html).toContain('700')
    expect(html).toContain('배고픔')
    expect(html).toContain('포만')
    expect(html).not.toMatch(/960|상한|남았|다음 수유/)
  })

  it('shows elapsed breastfeeding context and the recorded side without predicting the next feed', async () => {
    await i18n.changeLanguage('ko')
    const html = renderToStaticMarkup(
      <FeedingTipPopup
        type="breast"
        ageDays={12}
        lastBreastSide="L"
        todayFormulaTotalMl={0}
        todayFeedingCount={8}
        lastBreastAtISO="2026-07-13T10:00:00+09:00"
        onDismiss={() => undefined}
      />,
    )

    expect(html).toContain('마지막 수유 후')
    expect(html).toContain('기록한 쪽')
    expect(html).toContain('신생아')
    expect(html).toContain('모유 수유 8회')
    expect(html).not.toMatch(/다음 수유|반대쪽 추천|~\s*\d{2}:\d{2}/)
  })

  it('stays visible until the caregiver dismisses it manually', () => {
    const source = readFileSync('src/components/FeedingTipPopup.tsx', 'utf8')
    expect(source).not.toMatch(/AUTO_DISMISS|setTimeout\s*\(/)
  })

  it('keeps the same safety meaning in Japanese', async () => {
    await i18n.changeLanguage('ja')
    const html = renderToStaticMarkup(
      <FeedingTipPopup
        type="formula"
        ageDays={42}
        lastBreastSide={null}
        todayFormulaTotalMl={700}
        todayFeedingCount={6}
        onDismiss={() => undefined}
      />,
    )

    expect(html).toContain('空腹')
    expect(html).toContain('満腹')
    expect(html).not.toMatch(/960|上限|残り|次の授乳/)
  })
})

describe('FeverModal safety and accessibility', () => {
  it('derives its footer label from registry source ids for the active locale', async () => {
    await i18n.changeLanguage('ko')
    const koHtml = renderToStaticMarkup(
      <FeverModal celsius={38} level="emergency" ageDays={20} lang="ko" onConfirm={() => undefined} />,
    )
    expect(koHtml).toContain(getEvidenceSources(FEVER_CARE.sourceIds, 'ko')[0].organization)
    expect(koHtml).not.toContain('NICE NG143')

    await i18n.changeLanguage('ja')
    const jaHtml = renderToStaticMarkup(
      <FeverModal celsius={38} level="emergency" ageDays={20} lang="ja" onConfirm={() => undefined} />,
    )
    expect(jaHtml).toContain(getEvidenceSources(FEVER_CARE.sourceIds, 'ja')[0].organization)
  })

  it('forwards selected risk ids from Home state into the modal without persisting them', () => {
    const source = readFileSync('src/pages/HomePage.tsx', 'utf8')

    expect(source).toMatch(/symptomIds:\s*\[\.\.\.symptomIds\]/)
    expect(source).toMatch(/symptomIds=\{feverModal\.symptomIds\}/)
    expect(source).toContain('persist: async () => { await addTemp(celsius) }')
  })

  it('shows urgent action, 119, measurement-site caution, and structured red flags', async () => {
    await i18n.changeLanguage('ko')
    const html = renderToStaticMarkup(
      <FeverModal
        celsius={38}
        level="emergency"
        ageDays={20}
        lang="ko"
        onConfirm={() => undefined}
      />,
    )

    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('119')
    expect(html).toContain('측정 부위')
    expect(html).toContain('호흡')
    expect(html).not.toMatch(/직장|미온|24시간|3일/)
  })

  it('uses the five-day review boundary in the clinician-contact state', async () => {
    await i18n.changeLanguage('ja')
    const html = renderToStaticMarkup(
      <FeverModal
        celsius={38.3}
        level="warning"
        ageDays={120}
        lang="ja"
        onConfirm={() => undefined}
      />,
    )

    expect(html).toContain('5日')
    expect(html).toContain('測定部位')
    expect(html).toContain('いずれか一つでも')
    expect(html).not.toMatch(/24時間|3日|ぬるま湯/)
  })

  it('keeps the six-month 39.4°C state as neutral clinician-contact guidance', async () => {
    await i18n.changeLanguage('ko')
    const html = renderToStaticMarkup(
      <FeverModal
        celsius={39.4}
        level="warning"
        ageDays={194}
        completedMonths={6}
        lang="ko"
        onConfirm={() => undefined}
      />,
    )

    expect(html).toContain('그 숫자만으로 중증을 뜻하지는 않지만')
    expect(html).toContain('오늘 의료진에게 연락')
    expect(html).not.toContain('지금 바로 병원에 가야 해요')
    expect(html).not.toContain('고열이에요 — 지금 의료진에게 연락하세요')
  })

  it('moves initial focus, restores previous focus, and resolves keyboard trapping', () => {
    const dialogFocus = vi.fn()
    const previousFocus = vi.fn()
    const restore = focusDialogAndCreateRestore(
      { focus: dialogFocus },
      { focus: previousFocus },
    )

    expect(dialogFocus).toHaveBeenCalledOnce()
    restore()
    expect(previousFocus).toHaveBeenCalledOnce()

    expect(resolveFeverDialogKeyAction({
      key: 'Escape', shiftKey: false, activeIndex: 0, focusableCount: 2,
    })).toBe('close')
    expect(resolveFeverDialogKeyAction({
      key: 'Tab', shiftKey: false, activeIndex: 1, focusableCount: 2,
    })).toBe('first')
    expect(resolveFeverDialogKeyAction({
      key: 'Tab', shiftKey: true, activeIndex: 0, focusableCount: 2,
    })).toBe('last')
  })

  it('disables fever modal animation for reduced-motion users', () => {
    const css = readFileSync('src/index.css', 'utf8')
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.fever-modal\s*\{[\s\S]*?animation:\s*none\s*!important/)
  })
})
