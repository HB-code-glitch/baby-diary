import { describe, expect, it } from 'vitest'
import * as breastfeeding from '../src/lib/breastfeeding'

describe('responsive breastfeeding guidance', () => {
  it('does not export a fixed age-band schedule or next-feed calculator', () => {
    expect(breastfeeding).not.toHaveProperty('BREASTFEEDING_BANDS')
    expect(breastfeeding).not.toHaveProperty('getBreastBand')
    expect(breastfeeding).not.toHaveProperty('computeNextFeed')
    expect(breastfeeding).not.toHaveProperty('formatCountdown')
    expect(breastfeeding).not.toHaveProperty('BF_SOURCE_NOTES')
  })

  it('keeps bilingual cue-based guidance without universal clock rules', () => {
    expect(breastfeeding.BF_RESPONSIVE_GUIDANCE.ko).toMatch(/배고픔 신호/)
    expect(breastfeeding.BF_RESPONSIVE_GUIDANCE.ja).toMatch(/空腹サイン/)

    const serialized = JSON.stringify(breastfeeding)
    expect(serialized).not.toMatch(/12~24개월|12〜24か月|낮.{0,10}3시간|밤.{0,10}4시간|昼.{0,10}3時間|夜.{0,10}4時間/)
    expect(serialized).not.toMatch(/KellyMom|たまひよ|mamanoko|ままのて/)
  })

  it('gives newborn-specific concern guidance without inventing a universal interval', () => {
    expect(breastfeeding.BF_NEWBORN_GUIDANCE.ko).toMatch(/신생아/)
    expect(breastfeeding.BF_NEWBORN_GUIDANCE.ja).toMatch(/新生児/)
    expect(breastfeeding.BF_NEWBORN_GUIDANCE.ko).toMatch(/깨우기 어렵|소변|체중/)
    expect(breastfeeding.BF_NEWBORN_GUIDANCE.ja).toMatch(/起こしにく|尿|体重/)

    const serialized = JSON.stringify(breastfeeding.BF_NEWBORN_GUIDANCE)
    expect(serialized).not.toMatch(/\d+(?:\.\d+)?\s*(?:시간|時間)/)
  })

  it('keeps a short scope disclaimer', () => {
    expect(breastfeeding.BF_DISCLAIMER.ko).toMatch(/기록|진료/)
    expect(breastfeeding.BF_DISCLAIMER.ja).toMatch(/記録|診療/)
  })
})
