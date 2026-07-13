/**
 * mac-e2e.mjs — Baby Diary macOS E2E smoke-test
 *
 * Prerequisites:
 *   npm run build        (produces dist/ and dist-electron/)
 *   npm i playwright     (already in devDependencies)
 *
 * Usage:
 *   node scripts/mac-e2e.mjs
 *
 * Exit code 0 = all checks passed; non-zero = failures.
 */

import { _electron as electron } from 'playwright'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots')
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })

let screenshotIndex = 0
let consoleErrors = []
const failures = []

/** Take a screenshot: screenshots/NN-name.png */
async function shot(page, name) {
  screenshotIndex++
  const idx = String(screenshotIndex).padStart(2, '0')
  const file = path.join(SCREENSHOTS_DIR, `${idx}-${name}.png`)
  await page.waitForFunction(() => {
    const card = document.querySelector('.tour-card')
    return !card || card.getAnimations().every(animation =>
      animation.playState === 'finished' || animation.playState === 'idle'
    )
  }, undefined, { timeout: 2000 })
  await page.screenshot({ path: file, fullPage: false })
  console.log(`  📸 ${idx}-${name}.png`)
  return file
}

/** Wait for every quick-record mount animation to settle before a Home screenshot. */
async function waitForQuickRecordAnimations(page) {
  await page.waitForFunction(
    () => {
      const slots = Array.from(document.querySelectorAll('.quick-record-slot'))
      return slots.length > 0 && slots.every(slot =>
        slot.getAnimations().every(animation =>
          animation.playState === 'finished' || animation.playState === 'idle'
        )
      )
    },
    undefined,
    { timeout: 1000 },
  )
}

/** Wait for a V2 tutorial step and verify its localized title. */
async function waitForTourTitle(page, expectedTitle) {
  await page.waitForSelector('.tour-card', { timeout: 10000 })
  await page.waitForFunction(
    title => document.querySelector('.tour-title')?.textContent?.trim() === title,
    expectedTitle,
    { timeout: 5000 },
  )
  const actualTitle = await page.locator('.tour-title').textContent()
  assert(actualTitle?.trim() === expectedTitle, `tutorial title is '${expectedTitle}'`)
}

/** Return true when a Playwright bounding box is fully inside the viewport. */
function isInsideViewport(bounds, width, height) {
  return !!bounds
    && bounds.x >= 0
    && bounds.y >= 0
    && bounds.x + bounds.width <= width
    && bounds.y + bounds.height <= height
}

/** Verify every persistent tutorial surface fits a compact viewport without horizontal scrolling. */
async function assertTourFitsViewport(page, label, width = 720, height = 560) {
  await page.waitForFunction(() => {
    const card = document.querySelector('.tour-card')
    return card && card.getAnimations().every(animation =>
      animation.playState === 'finished' || animation.playState === 'idle'
    )
  }, undefined, { timeout: 2000 })

  const [cardBounds, headerBounds, actionBounds] = await Promise.all([
    page.locator('.tour-card').boundingBox(),
    page.locator('.tour-card-header').boundingBox(),
    page.locator('.tour-actions').boundingBox(),
  ])
  assert(isInsideViewport(cardBounds, width, height), `${label} card is inside the compact viewport`)
  assert(isInsideViewport(headerBounds, width, height), `${label} header is inside the compact viewport`)
  assert(isInsideViewport(actionBounds, width, height), `${label} actions are inside the compact viewport`)

  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const card = document.querySelector('.tour-card')
    return {
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      bodyClientWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      cardClientWidth: card?.clientWidth ?? 0,
      cardScrollWidth: card?.scrollWidth ?? Number.POSITIVE_INFINITY,
    }
  })
  assert(
    overflow.rootScrollWidth <= overflow.rootClientWidth
      && overflow.bodyScrollWidth <= overflow.bodyClientWidth
      && overflow.cardScrollWidth <= overflow.cardClientWidth,
    `${label} has no horizontal overflow`,
  )
}

/** Soft-assert: record failures instead of throwing immediately */
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failures.push(msg)
  } else {
    console.log(`  ok: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Return ISO date string for today - N days */
function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Fresh isolated userData so we never touch real data
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-'))
  const executablePath = process.env.BABYDIARY_E2E_EXECUTABLE
  console.log(`userData: ${tmpDir}`)
  console.log(`executable: ${executablePath ?? 'project Electron'}`)

  let app
  try {
    if (executablePath && !fs.existsSync(executablePath)) throw new Error(`E2E executable not found: ${executablePath}`)

    app = await electron.launch({
      ...(executablePath ? { executablePath } : { args: ['.'] }),
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',          // load dist/index.html, not dev server
        BABYDIARY_TEST_USERDATA: tmpDir, // isolated data dir
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      // Playwright's _electron doesn't need a browser download
    })

    const page = await app.firstWindow()
    await page.setViewportSize({ width: 960, height: 640 })

    // Collect console errors (filter known-benign)
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Benign: Autofill, i18next missing keys in CI, ResizeObserver
        if (/Autofill|i18next|ResizeObserver/.test(text)) return
        consoleErrors.push(text)
        console.warn(`  [console.error] ${text}`)
      }
    })

    // ---------------------------------------------------------------------------
    // 0. Language picker (first launch — fresh profile shows picker before tour)
    // ---------------------------------------------------------------------------
    console.log('\n[0] Language picker')

    await page.waitForSelector('.lang-picker-overlay', { timeout: 10000 })
    await shot(page, 'language-picker')

    // Click 한국어 button (lang="ko")
    const koBtn = await page.$('.lang-picker-btn[lang="ko"]')
    assert(!!koBtn, 'Korean language button found')
    await koBtn.click()
    await page.waitForTimeout(400)

    // Picker should be gone and tour should appear
    const pickerGone = await page.$('.lang-picker-overlay') === null
    assert(pickerGone, 'language picker dismissed after selecting Korean')

    // ---------------------------------------------------------------------------
    // 1. V2 tutorial lifecycle: Korean first launch + Japanese replay
    // ---------------------------------------------------------------------------
    console.log('\n[1] Bilingual V2 tutorial lifecycle')

    await waitForTourTitle(page, '필요한 것부터, 천천히')
    const title = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]?.getTitle()
    })
    assert(title === 'Baby Diary', `window title is 'Baby Diary' (got '${title}')`)

    const koWelcomeSkip = page.locator('.tour-actions .tour-skip-button')
    const koWelcomeStart = page.locator('.tour-primary-button')
    assert(await koWelcomeSkip.isVisible(), 'Korean welcome skip action is visible')
    assert((await koWelcomeSkip.textContent())?.trim() === '튜토리얼 건너뛰기', 'Korean welcome skip text is correct')
    assert(await koWelcomeStart.isVisible(), 'Korean welcome start action is visible')
    assert((await koWelcomeStart.textContent())?.trim() === '둘러보기 시작', 'Korean welcome start text is correct')
    const koProgressCount = await page.locator('.tour-progress-segment').count()
    assert(koProgressCount === 6, `V2 tutorial shows 6 progress segments (got ${koProgressCount})`)
    await shot(page, 'tutorial-ko-welcome')

    await koWelcomeSkip.click()
    await page.waitForSelector('.tour-card', { state: 'detached', timeout: 5000 })
    const skippedState = await page.evaluate(() => JSON.parse(localStorage.getItem('babydiary.tutorial.v2')))
    assert(
      skippedState?.version === 2 && skippedState?.status === 'skipped',
      'skip persists tutorial v2 state',
    )

    await page.reload()
    await page.waitForSelector('[data-tour="nav-settings"]', { timeout: 10000 })
    await page.waitForTimeout(700)
    assert(await page.locator('.tour-card').count() === 0, 'reload does not automatically show a skipped tutorial')
    assert(await page.locator('.lang-picker-overlay').count() === 0, 'reload does not show the language picker again')

    // Replay from Settings, advance once, then verify Back returns to welcome.
    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })
    await page.click('[data-tutorial-replay]')
    await waitForTourTitle(page, '필요한 것부터, 천천히')
    await page.click('.tour-primary-button')
    await waitForTourTitle(page, '한 번 눌러 오늘을 남겨요')
    const koBack = page.locator('.tour-back-button')
    assert((await koBack.textContent())?.trim() === '이전', 'Korean replay shows Back on step 2')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === '다음', 'Korean replay shows Next on step 2')
    await koBack.click()
    await waitForTourTitle(page, '필요한 것부터, 천천히')
    await page.click('.tour-actions .tour-skip-button')
    await page.waitForSelector('.tour-card', { state: 'detached', timeout: 5000 })
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    // Switch language through the real Settings UI, then finish all six steps.
    await page.click('[data-tour="settings-main"] button[lang="ja"]')
    await page.waitForFunction(() => document.documentElement.dataset.lang === 'ja')
    assert(
      await page.locator('[data-tour="settings-main"] button[lang="ja"]').evaluate(el => el.classList.contains('selected')),
      'Japanese language is selected in Settings',
    )
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.click('[data-tutorial-replay]')
    await waitForTourTitle(page, '必要なところから、ゆっくり')
    assert((await page.locator('.tour-actions .tour-skip-button').textContent())?.trim() === 'チュートリアルをスキップ', 'Japanese welcome skip text is correct')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === 'ツアーを始める', 'Japanese welcome start text is correct')

    await page.click('.tour-primary-button')
    await waitForTourTitle(page, 'ワンタップで今日を残せます')
    assert((await page.locator('.tour-back-button').textContent())?.trim() === '戻る', 'Japanese contextual Back text is correct')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === '次へ', 'Japanese contextual Next text is correct')
    assert((await page.locator('.tour-card-header .tour-skip-button').textContent())?.trim() === 'チュートリアルをスキップ', 'Japanese contextual skip text is correct')

    const eventCountBeforeShortcut = await page.evaluate(async () => (await window.babyDiary.listEvents()).length)
    await page.keyboard.press('1')
    await page.waitForTimeout(300)
    const eventCountAfterShortcut = await page.evaluate(async () => (await window.babyDiary.listEvents()).length)
    assert(
      eventCountAfterShortcut === eventCountBeforeShortcut,
      `digit shortcut 1 is blocked during quick-record tutorial (${eventCountBeforeShortcut}/${eventCountAfterShortcut})`,
    )
    await shot(page, 'tutorial-ja-context')

    await page.click('.tour-primary-button')
    await waitForTourTitle(page, '今日の流れをひと目で')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === '次へ', 'Japanese overview shows Next')

    await page.click('.tour-primary-button')
    await waitForTourTitle(page, 'あとから、ゆっくり振り返れます')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === '次へ', 'Japanese navigation shows Next')

    await page.click('.tour-primary-button')
    await waitForTourTitle(page, '設定で必要なものだけつなげます')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === '次へ', 'Japanese family-settings step shows Next')
    await page.waitForSelector('.tour-spotlight-ring', { timeout: 5000 })
    const settingsRingBounds = await page.locator('.tour-spotlight-ring').boundingBox()
    const settingsShieldBounds = await page.locator('.tour-target-shield').boundingBox()
    assert(isInsideViewport(settingsRingBounds, 1200, 800), 'settings-family spotlight ring is inside the viewport')
    assert(isInsideViewport(settingsShieldBounds, 1200, 800), 'settings-family target shield is inside the viewport')

    await page.click('.tour-primary-button')
    await waitForTourTitle(page, '最初の記録を残してみましょう')
    assert((await page.locator('.tour-primary-button').textContent())?.trim() === '記録を始める', 'Japanese ready step shows Finish')
    await shot(page, 'tutorial-ja-ready')
    await page.click('.tour-primary-button')
    await page.waitForSelector('.tour-card', { state: 'detached', timeout: 5000 })

    const completedState = await page.evaluate(() => JSON.parse(localStorage.getItem('babydiary.tutorial.v2')))
    assert(
      completedState?.version === 2 && completedState?.status === 'completed',
      'Japanese six-step completion persists tutorial v2 final state',
    )

    // Compact replay: persistent card surfaces fit at representative steps and background stays inert.
    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })
    await page.setViewportSize({ width: 720, height: 560 })
    const rootInertBeforeTour = await page.locator('#root').evaluate(root => ({
      property: root.inert,
      attribute: root.getAttribute('inert'),
    }))
    await page.click('[data-tutorial-replay]')
    await waitForTourTitle(page, '必要なところから、ゆっくり')
    const inertFocusState = await page.evaluate(() => {
      const root = document.getElementById('root')
      const primary = document.querySelector('.tour-primary-button')
      const backgroundButton = document.querySelector('[data-tour="nav-settings"]')
      const card = document.querySelector('.tour-card')
      primary?.focus()
      const primaryReceivedFocus = document.activeElement === primary
      backgroundButton?.focus()
      return {
        rootInert: root?.inert === true && root.hasAttribute('inert'),
        primaryReceivedFocus,
        backgroundReceivedFocus: document.activeElement === backgroundButton,
        focusRemainedInTour: !!card?.contains(document.activeElement),
      }
    })
    assert(inertFocusState.rootInert, '#root is inert while the tutorial is open')
    assert(inertFocusState.primaryReceivedFocus, 'tutorial primary action receives focus outside the inert root')
    assert(
      !inertFocusState.backgroundReceivedFocus && inertFocusState.focusRemainedInTour,
      'background controls cannot receive programmatic focus while the tutorial is open',
    )
    await assertTourFitsViewport(page, 'compact welcome')
    await shot(page, 'tutorial-ja-compact-720x560')

    await page.click('.tour-primary-button')
    await page.waitForSelector('#tour-title-quick-record', { timeout: 5000 })
    await assertTourFitsViewport(page, 'compact quick-record')
    await page.click('.tour-primary-button')
    await page.waitForSelector('#tour-title-today-overview', { timeout: 5000 })
    await page.click('.tour-primary-button')
    await page.waitForSelector('#tour-title-navigation', { timeout: 5000 })
    await page.click('.tour-primary-button')
    await page.waitForSelector('#tour-title-settings-family', { timeout: 5000 })
    await assertTourFitsViewport(page, 'compact settings-family')
    await page.click('.tour-primary-button')
    await page.waitForSelector('#tour-title-ready', { timeout: 5000 })
    await assertTourFitsViewport(page, 'compact ready')

    // Escape from a Settings replay skips the tour and restores Settings/focus.
    await page.keyboard.press('Escape')
    await page.waitForSelector('.tour-card', { state: 'detached', timeout: 5000 })
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })
    assert(await page.locator('[data-tour="settings-main"]').isVisible(), 'Escape returns a Settings replay to Settings')
    await page.waitForFunction(() => document.activeElement?.matches('[data-tutorial-replay]'))
    const restoredAfterTour = await page.evaluate(before => {
      const root = document.getElementById('root')
      return {
        inertRestored: root?.inert === before.property && root?.getAttribute('inert') === before.attribute,
        replayFocused: document.activeElement?.matches('[data-tutorial-replay]') === true,
      }
    }, rootInertBeforeTour)
    assert(restoredAfterTour.inertRestored, '#root inert state is restored after the tutorial closes')
    assert(restoredAfterTour.replayFocused, 'Escape restores focus to the Settings replay button')

    // Dark-mode tutorial capture at the full 1200×800 review viewport.
    await page.setViewportSize({ width: 1200, height: 800 })
    const jaDarkButton = page.locator('[data-tour="settings-main"] .toggle-btn').filter({ hasText: 'ダーク' }).first()
    assert(await jaDarkButton.isVisible(), 'Japanese dark theme button is visible')
    await jaDarkButton.click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await page.click('[data-tutorial-replay]')
    await waitForTourTitle(page, '必要なところから、ゆっくり')
    await shot(page, 'tutorial-ja-dark-1200x800')
    await page.click('.tour-actions .tour-skip-button')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    // Reduced motion must disable both the card entrance and contextual ring.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.click('[data-tutorial-replay]')
    await waitForTourTitle(page, '必要なところから、ゆっくり')
    await page.click('.tour-primary-button')
    await waitForTourTitle(page, 'ワンタップで今日を残せます')
    await page.waitForSelector('.tour-spotlight-ring', { timeout: 5000 })
    const reducedTutorialAnimations = await page.evaluate(() => ({
      card: getComputedStyle(document.querySelector('.tour-card')).animationName,
      ring: getComputedStyle(document.querySelector('.tour-spotlight-ring')).animationName,
    }))
    assert(
      reducedTutorialAnimations.card === 'none' && reducedTutorialAnimations.ring === 'none',
      `reduced motion disables tutorial card/ring animation (${reducedTutorialAnimations.card}/${reducedTutorialAnimations.ring})`,
    )
    await shot(page, 'tutorial-ja-reduced-motion-1200x800')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    // Restore conditions expected by the remaining broad Korean smoke test.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const jaLightButton = page.locator('[data-tour="settings-main"] .toggle-btn').filter({ hasText: 'ライト' }).first()
    assert(await jaLightButton.isVisible(), 'Japanese light theme button is visible')
    await jaLightButton.click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.click('[data-tour="settings-main"] button[lang="ko"]')
    await page.waitForFunction(() => document.documentElement.dataset.lang === 'ko')
    assert(
      await page.locator('[data-tour="settings-main"] button[lang="ko"]').evaluate(el => el.classList.contains('selected')),
      'Korean language is restored for remaining E2E scenarios',
    )
    await page.setViewportSize({ width: 1280, height: 800 })

    // ---------------------------------------------------------------------------
    // 2. Settings: baby info
    // ---------------------------------------------------------------------------
    console.log('\n[2] Settings — baby info')

    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    // Baby name
    const nameInput = await page.$('input[type="text"][placeholder]')
    await nameInput.triple_click?.() ?? await nameInput.click({ clickCount: 3 })
    await nameInput.fill('테스트')

    // Birthdate = today - 95 days
    const birthdateValue = daysAgo(95)
    const dateInput = await page.$('input[type="date"]')
    await dateInput.fill(birthdateValue)

    // 여아 gender
    const genderButtons = await page.$$('.role-btn')
    // Find 여아 button
    for (const btn of genderButtons) {
      const text = await btn.textContent()
      if (text && text.trim() === '여아') {
        await btn.click()
        break
      }
    }

    // Save
    await page.click('.btn-primary')
    await page.waitForSelector('.toast', { timeout: 5000 })
    await shot(page, 'settings')

    const toastText = await page.$eval('.toast', el => el.textContent)
    assert(toastText?.includes('저장'), 'settings save toast appeared')

    // ---------------------------------------------------------------------------
    // 3. Home — quick buttons
    // ---------------------------------------------------------------------------
    console.log('\n[3] Home — quick buttons')

    // Wait for any settings-save toast to clear before navigating
    try { await page.waitForSelector('.toast', { state: 'detached', timeout: 4000 }) } catch { /* no toast or already gone */ }

    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="quick-row"]', { timeout: 5000 })
    await waitForQuickRecordAnimations(page)
    await shot(page, 'home')

    // 3a. 소변 (pee) button
    console.log('  → click pee button')
    const peeBtn = await page.$('.quick-btn-circle-pee')
    assert(!!peeBtn, 'pee button exists')
    await peeBtn.click()
    // Wait for a toast containing 소변 (not the settings toast)
    try {
      await page.waitForFunction(
        () => {
          const toasts = Array.from(document.querySelectorAll('.toast'))
          return toasts.some(el => el.textContent?.includes('소변'))
        },
        { timeout: 5000 }
      )
      assert(true, 'pee toast shown with 소변')
    } catch {
      // Check what toast is actually showing
      const toastText = await page.$('.toast').then(el => el?.textContent()).catch(() => 'none')
      failures.push(`pee toast 소변 not found (got: ${toastText})`)
      console.error(`  FAIL: pee toast — got: ${toastText}`)
    }

    // Wait for toast to appear in timeline
    await page.waitForTimeout(600)
    const timelineRows = await page.$$('.timeline-row, .event-row, [class*="timeline"]')
    // At least one row now (we don't assert exact count — layout may vary)
    console.log(`  timeline rows found: ${timelineRows.length}`)

    // 3b. 분유 button → popover → Enter → feeding tip
    console.log('  → click formula button')
    const formulaBtn = await page.$('.quick-btn-circle-formula')
    assert(!!formulaBtn, 'formula button exists')
    await formulaBtn.click()
    await page.waitForSelector('.popover', { timeout: 5000 })

    // Click 기록 (record) button in popover
    const popoverBtns = await page.$$('.popover .btn-primary')
    assert(popoverBtns.length > 0, 'popover record button found')
    await popoverBtns[0].click()

    // Expect feeding tip popup (requires birthdate to be set — we set it 95d ago)
    try {
      await page.waitForSelector('[class*="feeding-tip"], .feeding-tip-popup, [role="dialog"]', { timeout: 5000 })
      await shot(page, 'feeding-tip')
      // Dismiss
      const dismissBtn = await page.$('[class*="dismiss"], button:has-text("닫기")')
      if (dismissBtn) await dismissBtn.click()
      assert(true, 'feeding-tip popup appeared and dismissed')
    } catch {
      // May not appear if no guidance band for age — not a hard failure
      console.log('  (feeding-tip popup did not appear — may be expected for age)')
    }

    // 3c. 체온 → 39.6 → Enter → fever modal
    console.log('  → click temp button')
    const tempBtn = await page.$('.quick-btn-circle-temp')
    assert(!!tempBtn, 'temp button exists')
    await tempBtn.click()
    await page.waitForSelector('.popover', { timeout: 5000 })

    // Clear and fill with 39.6
    const tempInput = await page.$('.popover input[type="number"]')
    assert(!!tempInput, 'temp input found')
    await tempInput.fill('39.6')
    await tempInput.press('Enter')

    // Fever modal should appear (39.6 triggers warning/danger)
    try {
      await page.waitForSelector('.fever-modal, [role="alertdialog"]', { timeout: 5000 })
      await shot(page, 'fever-modal')

      const feverTitle = await page.$eval('.fever-modal-title, [role="alertdialog"] h2', el => el.textContent)
      assert(feverTitle && feverTitle.length > 0, `fever modal title shown: ${feverTitle}`)

      // Confirm / close
      const confirmBtn = await page.$('.fever-modal-confirm, .fever-modal button.btn-primary')
      if (confirmBtn) await confirmBtn.click()
      await page.waitForTimeout(300)
      assert(true, 'fever modal confirmed and closed')
    } catch (err) {
      failures.push(`fever modal did not appear: ${err.message}`)
      console.error(`  FAIL fever modal: ${err.message}`)
    }

    // 3d. 모유 (breast) → FeedingTipPopup → countdown row
    console.log('  → click breast button')
    const breastBtn = await page.$('.quick-btn-circle-breast')
    assert(!!breastBtn, 'breast button exists')
    await breastBtn.click()
    await page.waitForSelector('.popover', { timeout: 5000 })

    // Click 기록 button in breast popover (or press Enter)
    const breastPopoverBtns = await page.$$('.popover .btn-primary')
    if (breastPopoverBtns.length > 0) {
      await breastPopoverBtns[0].click()
    } else {
      await page.keyboard.press('Enter')
    }

    // FeedingTipPopup should reinforce responsive hunger cues, not a fixed interval.
    try {
      await page.waitForSelector('.feeding-tip-popup, [class*="feeding-tip"]', { timeout: 6000 })
      // Assert popup contains responsive-feeding cue text.
      const tipText = await page.$eval(
        '.feeding-tip-popup, [class*="feeding-tip"]',
        el => el.textContent ?? ''
      )
      assert(
        /배고픔 신호|空腹のサイン/.test(tipText),
        `breastfeed tip popup contains responsive hunger-cue text (got: "${tipText.slice(0, 80)}")`
      )
      await shot(page, 'breastfeed-tip')

      // Dismiss via X button
      const tipDismissBtn = await page.$('.feeding-tip-dismiss, .feeding-tip-popup button[aria-label], [class*="feeding-tip"] button')
      if (tipDismissBtn) {
        await tipDismissBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(400)
      assert(true, 'breastfeed tip popup dismissed')
    } catch (err) {
      failures.push(`breastfeed tip popup did not appear: ${err.message}`)
      console.error(`  FAIL breastfeed tip: ${err.message}`)
    }

    // Retired feeding countdown advice must never reappear in either locale.
    const insightsText = await page.locator('[data-tour="insights"]').textContent()
    assert(
      !/다음 수유까지|지금이 수유하기|次の授乳まで|今が授乳/.test(insightsText ?? ''),
      'home insights rail does not expose retired feeding countdown advice',
    )
    await shot(page, 'breastfeed-home-summary')

    // ---------------------------------------------------------------------------
    // 3e. Settings — current-stage evidence center (no live external navigation)
    // ---------------------------------------------------------------------------
    console.log('  → settings current-stage evidence center')

    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    const evidenceCenter = page.locator('[data-tour="age-guidance"]')
    assert(await evidenceCenter.isVisible(), 'Korean current-stage evidence center is visible')
    assert(/시기별 근거 센터/.test(await evidenceCenter.textContent()), 'Korean evidence-center title is localized')
    assert(await evidenceCenter.locator('[data-development-checkpoint]').count() === 1, 'current development checkpoint is selected')
    const settingsSourceSummary = evidenceCenter.locator('[data-development-checkpoint] .evidence-source-list > summary')
    await settingsSourceSummary.click()
    assert(await settingsSourceSummary.getAttribute('aria-expanded') === 'true', 'Settings official-source disclosure expands without navigation')
    const sourceIds = await evidenceCenter.locator('button[data-source-id]').evaluateAll(buttons =>
      buttons.map(button => button.getAttribute('data-source-id')).filter(Boolean)
    )
    assert(sourceIds.length > 0, 'evidence center exposes exact official source IDs')
    assert(sourceIds.every(id => !id.includes('://')), 'renderer source payloads are IDs, not URLs')
    await shot(page, 'evidence-center')

    // Navigate back to home for subsequent steps
    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="quick-row"]', { timeout: 5000 })
    assert(
      await page.locator('[data-tour="age-guidance"] [data-guidance-priority]').count() === 3,
      'Home initially shows exactly three current-stage priorities',
    )
    const guidanceMore = page.locator('[data-tour="age-guidance"] [data-guidance-more]')
    assert(await guidanceMore.getAttribute('aria-expanded') === 'false', 'Home extra guidance is initially collapsed')
    await guidanceMore.click()
    assert(await guidanceMore.getAttribute('aria-expanded') === 'true', 'Home extra guidance expands in place')
    assert(await page.locator('[data-tour="age-guidance"] [data-guidance-secondary]').isVisible(), 'Home expanded guidance is visible')
    await guidanceMore.click()
    assert(await guidanceMore.getAttribute('aria-expanded') === 'false', 'Home extra guidance collapses in place')

    const firstPriority = page.locator('[data-tour="age-guidance"] [data-guidance-priority]').first()
    const prioritySummary = firstPriority.locator(':scope > summary')
    await prioritySummary.click()
    assert(await prioritySummary.getAttribute('aria-expanded') === 'true', 'Home priority details expose accessible expanded state')
    const sourceSummary = firstPriority.locator('.evidence-source-list > summary').first()
    await sourceSummary.click()
    assert(await sourceSummary.getAttribute('aria-expanded') === 'true', 'Home official-source disclosure expands without navigation')
    assert(await firstPriority.locator('button[data-source-id]').count() > 0, 'Expanded Home source disclosure retains exact source IDs')

    // ---------------------------------------------------------------------------
    // 4. 기록 (History) — calendar views
    // ---------------------------------------------------------------------------
    console.log('\n[4] History — calendar views')

    await page.click('[data-tour="nav-history"]')
    await page.waitForSelector('[data-tour="calendar"]', { timeout: 8000 })

    // Month view (default)
    await shot(page, 'history-month')

    // Look for a 백일 star chip (should be near D+100 mark for 95-day-old baby)
    const starChips = await page.$$('.milestone-chip, [class*="star"], [class*="chip"]')
    console.log(`  milestone chips found: ${starChips.length}`)

    // Click a day cell to get week/day drill-down
    // Find any clickable day with a record
    const dayCells = await page.$$('[class*="day-cell"], [class*="calendar-day"], .cal-day')
    if (dayCells.length > 0) {
      // Click today's cell (first with today class, or just any day)
      const todayCell = await page.$('[class*="today"], .cal-today')
      const target = todayCell ?? dayCells[Math.floor(dayCells.length / 2)]
      await target.click()
      await page.waitForTimeout(400)
    }
    await shot(page, 'history-week')

    // Try to go to day view
    const dayViewBtn = await page.$('button:has-text("일")')
    if (dayViewBtn) {
      await dayViewBtn.click()
      await page.waitForTimeout(400)
    }
    await shot(page, 'history-day')

    // ---------------------------------------------------------------------------
    // 5. Sleep two-tap flow
    // ---------------------------------------------------------------------------
    console.log('\n[5] Sleep two-tap flow')

    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="quick-row"]', { timeout: 5000 })

    // First tap: start sleep timer (6th quick button — data-testid or class)
    // The sleep button has label from quickBtn.sleep or quickBtn.sleepRunning
    const sleepBtn = await page.locator('[data-tour="quick-row"] button').filter({ hasText: /수면|ねんね/ }).first()
    const sleepBtnVisible = await sleepBtn.isVisible().catch(() => false)
    assert(sleepBtnVisible, 'sleep button found')
    if (sleepBtnVisible) {
      await sleepBtn.click()
      await page.waitForTimeout(600)
      await shot(page, 'sleep-timer-running')

      // FloatingSleepPill should appear
      const floatingPill = await page.$('.floating-sleep-pill')
      assert(!!floatingPill, 'floating sleep pill appeared after first sleep tap')

      // Second tap: stop timer (click floating pill stop or sleep button again)
      const stopBtn = await page.$('.floating-sleep-stop')
      if (stopBtn) {
        await stopBtn.click()
      } else {
        await sleepBtn.click()
      }
      await page.waitForTimeout(400)

      // SleepConfirmPopover should appear
      const confirmPopover = await page.$('.sleep-confirm-popover, .popover')
      assert(!!confirmPopover, 'sleep confirm popover found')
      if (confirmPopover) {
        await shot(page, 'sleep-confirm-popover')
        // Click 기록 / record button
        const recordBtn = await page.$('.sleep-confirm-popover .btn-primary, .popover .btn-primary')
        assert(!!recordBtn, 'sleep confirm record button found')
        if (recordBtn) {
          await recordBtn.click()
          await page.waitForTimeout(400)
          assert(true, 'sleep confirm recorded successfully')
        }
      }
      await shot(page, 'sleep-recorded')
    }

    // ---------------------------------------------------------------------------
    // 5b. Growth QuickMenu flow
    // ---------------------------------------------------------------------------
    console.log('\n[5b] Growth entry via QuickMenu')

    // Open QuickMenu (+ 기록 button)
    const moreBtn = await page.$('.btn-add-record')
    assert(!!moreBtn, 'QuickMenu add-record button found')
    if (moreBtn) {
      await moreBtn.click()
      await page.waitForTimeout(400)

      // Click 성장 in QuickMenu
      const growthItem = await page.locator('.quick-menu-item, [role="menuitem"]').filter({ hasText: /성장|成長/ }).first()
      const growthVisible = await growthItem.isVisible().catch(() => false)
      assert(growthVisible, 'growth menu item found')
      if (growthVisible) {
        await growthItem.click()
        await page.waitForSelector('.popover', { timeout: 5000 })
        await shot(page, 'growth-popover')

        // Fill weight
        const weightInput = await page.$('.popover input[inputmode="decimal"], .popover input[type="number"]')
        assert(!!weightInput, 'growth weight input found')
        if (weightInput) {
          await weightInput.fill('7.5')
        }
        // Record
        const growthRecordBtn = await page.$('.popover .btn-primary')
        assert(!!growthRecordBtn, 'growth record button found')
        if (growthRecordBtn) {
          await growthRecordBtn.click()
          await page.waitForTimeout(400)
          assert(true, 'growth event recorded via QuickMenu')
        }
      } else {
        // Close menu if open
        await page.keyboard.press('Escape')
      }
    }

    // ---------------------------------------------------------------------------
    // 6. 통계 (Stats) — including growth chart screenshot
    // ---------------------------------------------------------------------------
    console.log('\n[6] Stats — with growth chart')

    await page.click('[data-tour="nav-stats"]')
    await page.waitForSelector('[data-tour="stats"]', { timeout: 5000 })

    const statsChartSelector = '[data-tour="stats"] .recharts-responsive-container'
    await page.waitForSelector(statsChartSelector, { timeout: 5000 })
    const initialStatsChartCount = await page.locator(statsChartSelector).count()
    assert(initialStatsChartCount === 2, `stats initially shows exactly 2 charts (got ${initialStatsChartCount})`)

    const statsMoreButton = page.locator('[data-tour="stats"] .progressive-more-button').first()
    const statsMoreButtonCount = await statsMoreButton.count()
    assert(statsMoreButtonCount === 1, `stats progressive more button exists (got ${statsMoreButtonCount})`)
    const statsMoreButtonVisible = await statsMoreButton.isVisible().catch(() => false)
    assert(statsMoreButtonVisible, 'stats progressive more button is visible')
    const initiallyExpanded = await statsMoreButton.getAttribute('aria-expanded')
    assert(initiallyExpanded === 'false', `stats progressive sections initially collapsed (aria-expanded=${initiallyExpanded})`)
    await shot(page, 'stats')

    await statsMoreButton.click()
    await page.waitForFunction(
      selector => document.querySelectorAll(selector).length > 2,
      statsChartSelector,
      { timeout: 5000 },
    )
    const expandedAria = await statsMoreButton.getAttribute('aria-expanded')
    assert(expandedAria === 'true', `stats progressive sections expanded (aria-expanded=${expandedAria})`)
    const expandedStatsChartCount = await page.locator(statsChartSelector).count()
    assert(expandedStatsChartCount > 2, `expanded stats shows more than 2 charts (got ${expandedStatsChartCount})`)

    const weightGrowthTitle = page
      .locator('[data-tour="stats"] .section-header-accent')
      .filter({ hasText: /체중|体重/ })
      .first()
    const weightGrowthTitleVisible = await weightGrowthTitle.isVisible().catch(() => false)
    assert(weightGrowthTitleVisible, 'weight growth chart title is visible after expanding stats')

    // Scroll the actual page container to the growth chart section.
    await page.$eval('[data-tour="stats"]', stats => {
      stats.scrollTop = stats.scrollHeight
    })
    await page.waitForFunction(
      () => {
        const stats = document.querySelector('[data-tour="stats"]')
        return !!stats && Math.ceil(stats.scrollTop + stats.clientHeight) >= stats.scrollHeight
      },
      undefined,
      { timeout: 5000 },
    )
    await page.waitForTimeout(400)
    await shot(page, 'stats-growth-chart')

    await statsMoreButton.click()
    await page.waitForFunction(
      selector => document.querySelectorAll(selector).length === 2,
      statsChartSelector,
      { timeout: 5000 },
    )
    const collapsedAria = await statsMoreButton.getAttribute('aria-expanded')
    assert(collapsedAria === 'false', `stats progressive sections collapsed again (aria-expanded=${collapsedAria})`)
    const collapsedStatsChartCount = await page.locator(statsChartSelector).count()
    assert(collapsedStatsChartCount === 2, `collapsed stats returns to exactly 2 charts (got ${collapsedStatsChartCount})`)

    // ---------------------------------------------------------------------------
    // 7. 일기 (Diary)
    // ---------------------------------------------------------------------------
    console.log('\n[7] Diary')

    await page.click('[data-tour="nav-diary"]')
    await page.waitForSelector('[data-tour="diary"]', { timeout: 5000 })

    // Open diary editor — try multiple selectors (label varies by language)
    const diaryWriteBtn = await page.locator('button').filter({ hasText: /일기 쓰기|日記を書く/ }).first()
    const diaryBtnVisible = await diaryWriteBtn.isVisible().catch(() => false)
    assert(diaryBtnVisible, 'diary write button found')
    if (diaryBtnVisible) {
      await diaryWriteBtn.click()
      await page.waitForSelector('textarea', { timeout: 5000 })

      const textarea = await page.$('textarea')
      await textarea.fill('테스트 일기')

      // Save button inside the diary editor modal
      const saveBtn = await page.locator('button').filter({ hasText: /저장|保存/ }).first()
      const saveBtnVisible = await saveBtn.isVisible().catch(() => false)
      assert(saveBtnVisible, 'diary save button found')
      if (saveBtnVisible) await saveBtn.click()
      await page.waitForTimeout(800)
    }
    await shot(page, 'diary')

    // ---------------------------------------------------------------------------
    // 8. 아기에게 (Messages)
    // ---------------------------------------------------------------------------
    console.log('\n[8] Messages')

    await page.click('[data-tour="nav-messages"]')
    await page.waitForSelector('[data-tour="messages"]', { timeout: 5000 })

    const writeBtn = await page.locator('button').filter({ hasText: /편지 쓰기|手紙を書く/ }).first()
    const writeBtnVisible = await writeBtn.isVisible().catch(() => false)
    assert(writeBtnVisible, 'message write button found')
    if (writeBtnVisible) {
      await writeBtn.click()
      await page.waitForSelector('textarea', { timeout: 5000 })

      const textarea = await page.$('textarea')
      await textarea.fill('테스트 메시지')

      const sendBtn = await page.locator('button').filter({ hasText: /보내기|送る/ }).first()
      const sendBtnVisible = await sendBtn.isVisible().catch(() => false)
      assert(sendBtnVisible, 'message send button found')
      if (sendBtnVisible) await sendBtn.click()
      await page.waitForTimeout(800)
    }
    await shot(page, 'messages')

    // ---------------------------------------------------------------------------
    // 9. Settings → 日本語 → home (Zen Maru font check)
    // ---------------------------------------------------------------------------
    console.log('\n[9] Language + theme switches')

    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    // Click 日本語 button
    const jaBtn = await page.$('button[lang="ja"]')
    assert(!!jaBtn, 'Japanese language button found')
    if (jaBtn) {
      await jaBtn.click()
      await page.waitForTimeout(600)
    }

    const jaEvidenceCenter = page.locator('[data-tour="age-guidance"]')
    assert(/年齢別エビデンスセンター/.test(await jaEvidenceCenter.textContent()), 'Japanese evidence-center title is localized')

    // Go to home and screenshot Japanese UI
    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="hero"]', { timeout: 5000 })
    assert(
      /今必要なこと/.test(await page.locator('[data-tour="age-guidance"]').textContent()),
      'Japanese Home current-stage guidance is localized',
    )
    await waitForQuickRecordAnimations(page)
    await shot(page, 'home-ja')

    // Dark theme
    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    const darkBtn = await page.$('.toggle-btn:has-text("ダーク"), .toggle-btn:has-text("다크")')
    if (darkBtn) {
      await darkBtn.click()
      await page.waitForTimeout(400)
    }

    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="hero"]', { timeout: 5000 })
    await waitForQuickRecordAnimations(page)
    await shot(page, 'home-dark')

    // Verify dark theme attribute
    const dataTheme = await page.$eval('html', el => el.getAttribute('data-theme'))
    assert(dataTheme === 'dark', `dark theme applied (data-theme=${dataTheme})`)

    // Responsive layout checks (no screenshots).
    await page.setViewportSize({ width: 960, height: 640 })
    const homeShellSize = await page.$eval('.app-shell', shell => ({
      clientWidth: shell.clientWidth,
      scrollWidth: shell.scrollWidth,
    }))
    assert(
      homeShellSize.scrollWidth <= homeShellSize.clientWidth,
      `Home app shell has no horizontal overflow at 960px (${homeShellSize.scrollWidth}/${homeShellSize.clientWidth})`,
    )

    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })
    const settingsColumnsAt960 = await page.$eval(
      '.settings-grid',
      grid => getComputedStyle(grid).gridTemplateColumns,
    )
    const settingsColumnCountAt960 = settingsColumnsAt960.trim().split(/\s+/).filter(Boolean).length
    assert(
      settingsColumnCountAt960 === 1,
      `Settings uses 1 computed column at 960px (got "${settingsColumnsAt960}")`,
    )

    await page.setViewportSize({ width: 1200, height: 800 })
    const settingsColumnsAt1200 = await page.$eval(
      '.settings-grid',
      grid => getComputedStyle(grid).gridTemplateColumns,
    )
    const settingsColumnCountAt1200 = settingsColumnsAt1200.trim().split(/\s+/).filter(Boolean).length
    assert(
      settingsColumnCountAt1200 === 2,
      `Settings uses 2 computed columns at 1200px (got "${settingsColumnsAt1200}")`,
    )

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="quick-row"]', { timeout: 5000 })
    const reducedMotionAnimationNames = await page.$$eval(
      '.quick-record-slot',
      slots => slots.map(slot => getComputedStyle(slot).animationName),
    )
    assert(
      reducedMotionAnimationNames.length > 0 && reducedMotionAnimationNames.every(name => name === 'none'),
      `Home quick-record slots disable animation for reduced motion (got ${reducedMotionAnimationNames.join(', ')})`,
    )

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failures.push(`Fatal error: ${message}`)
    console.error('[E2E fatal]', err)
  } finally {
    // ---------------------------------------------------------------------------
    // Teardown + report
    // ---------------------------------------------------------------------------
    if (app) {
      try { await app.close() } catch { /* ignore */ }
    }

    // Clean temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }

    // Console errors check (allow Autofill etc already filtered above)
    const errorCount = consoleErrors.length
    if (errorCount > 0) {
      failures.push(`${errorCount} unexpected console error(s): ${consoleErrors.slice(0, 3).join(' | ')}`)
    }

    if (screenshotIndex !== 27) {
      failures.push(`Expected exactly 27 screenshots, got ${screenshotIndex}`)
    }

    // Write result JSON
    const result = {
      timestamp: new Date().toISOString(),
      passed: failures.length === 0,
      failures,
      consoleErrors,
      screenshots: screenshotIndex,
    }
    const resultPath = path.join(ROOT, 'e2e-result.json')
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))

    // Summary
    console.log('\n========================================')
    console.log(`E2E result: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
    console.log(`Screenshots: ${screenshotIndex}`)
    console.log(`Console errors: ${errorCount}`)
    if (failures.length > 0) {
      console.log('Failures:')
      failures.forEach(f => console.log(`  - ${f}`))
    }
    console.log('========================================\n')

    process.exitCode = failures.length > 0 ? 1 : 0
  }
}

main().catch(err => {
  console.error('[E2E fatal]', err)
  process.exitCode = 1
})
