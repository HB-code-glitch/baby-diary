import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('mac packaged guidance contract', () => {
  it('fails on retired feeding countdown copy and uses a neutral screenshot name', () => {
    const script = readFileSync('scripts/mac-e2e.mjs', 'utf8')

    expect(script).toMatch(/assert\(\s*!\s*\/다음 수유까지\|지금이 수유하기\|次の授乳まで\|今が授乳/)
    expect(script).not.toContain("shot(page, 'breastfeed-countdown')")
    expect(script).toContain("shot(page, 'breastfeed-home-summary')")
  })
})
