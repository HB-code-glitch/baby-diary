import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../src/i18n'
import { FeedingTipPopup } from '../src/components/FeedingTipPopup'
import {
  FeverModal,
  focusDialogAndCreateRestore,
  resolveFeverDialogKeyAction,
} from '../src/components/FeverModal'

afterEach(async () => {
  await i18n.changeLanguage('ko')
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
    expect(html).not.toMatch(/다음 수유|반대쪽 추천|~\s*\d{2}:\d{2}/)
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
    expect(html).not.toMatch(/24時間|3日|ぬるま湯/)
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
