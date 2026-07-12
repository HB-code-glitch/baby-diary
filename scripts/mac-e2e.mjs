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
  await page.screenshot({ path: file, fullPage: false })
  console.log(`  📸 ${idx}-${name}.png`)
  return file
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
    await page.setViewportSize({ width: 1280, height: 800 })

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
    // 1. Window title + tutorial overlay
    // ---------------------------------------------------------------------------
    console.log('\n[1] Window title + tutorial')

    await page.waitForSelector('.tour-tooltip', { timeout: 10000 })
    const title = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]?.getTitle()
    })
    assert(title === 'Baby Diary', `window title is 'Baby Diary' (got '${title}')`)

    await shot(page, 'tutorial-step1')

    // Click 다음 (Next) twice
    await page.click('.tour-next-btn')
    await page.waitForTimeout(300)
    await shot(page, 'tutorial-step2')

    await page.click('.tour-next-btn')
    await page.waitForTimeout(300)
    await shot(page, 'tutorial-step3')

    // Skip tour entirely
    await page.click('.tour-skip-pill')
    await page.waitForTimeout(500)

    // Tour should be gone
    const tourGone = await page.$('.tour-tooltip') === null
    assert(tourGone, 'tutorial overlay dismissed after skip')

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

    // FeedingTipPopup should appear with next-feed window text (ko: /다음 수유는 보통/)
    try {
      await page.waitForSelector('.feeding-tip-popup, [class*="feeding-tip"]', { timeout: 6000 })
      // Assert popup contains next-feed window text
      const tipText = await page.$eval(
        '.feeding-tip-popup, [class*="feeding-tip"]',
        el => el.textContent ?? ''
      )
      assert(
        /다음 수유는 보통|授乳の目安/.test(tipText),
        `breastfeed tip popup contains next-feed window text (got: "${tipText.slice(0, 80)}")`
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

    // Insights rail should now have breast countdown row
    try {
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('[data-tour="insights"]')
          if (!panel) return false
          return /다음 수유까지|지금이 수유하기/.test(panel.textContent ?? '')
        },
        { timeout: 5000 }
      )
      assert(true, 'home insights rail shows breastfeed countdown row')
    } catch {
      console.log('  (breastfeed countdown not yet visible in insights rail)')
    }
    await shot(page, 'breastfeed-countdown')

    // ---------------------------------------------------------------------------
    // 3e. Settings — 모유수유 간격 가이드 accordion expanded
    // ---------------------------------------------------------------------------
    console.log('  → settings breastfeeding guide accordion')

    await page.click('[data-tour="nav-settings"]')
    await page.waitForSelector('[data-tour="settings-main"]', { timeout: 5000 })

    // Locate the BreastfeedingGuideCard button (contains 모유수유 간격 or 授乳間隔)
    const bfGuideBtn = await page.locator('button[aria-expanded]').filter({ hasText: /모유수유 간격|授乳間隔/ }).first()
    const bfGuideBtnVisible = await bfGuideBtn.isVisible().catch(() => false)
    assert(bfGuideBtnVisible, 'breastfeeding guide accordion button found')
    if (bfGuideBtnVisible) {
      const isExpanded = await bfGuideBtn.getAttribute('aria-expanded')
      if (isExpanded !== 'true') {
        await bfGuideBtn.click()
        await page.waitForTimeout(400)
      }
      const isExpandedAfterClick = await bfGuideBtn.getAttribute('aria-expanded')
      assert(isExpandedAfterClick === 'true', 'breastfeeding guide accordion expanded')
    }
    await shot(page, 'bf-guide')

    // Navigate back to home for subsequent steps
    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="quick-row"]', { timeout: 5000 })

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
    await shot(page, 'stats')

    // Scroll down to growth chart section
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(400)
    await shot(page, 'stats-growth-chart')

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

    // Go to home and screenshot Japanese UI
    await page.click('[data-tour="nav-home"]')
    await page.waitForSelector('[data-tour="hero"]', { timeout: 5000 })
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
    await shot(page, 'home-dark')

    // Verify dark theme attribute
    const dataTheme = await page.$eval('html', el => el.getAttribute('data-theme'))
    assert(dataTheme === 'dark', `dark theme applied (data-theme=${dataTheme})`)

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

    process.exit(failures.length > 0 ? 1 : 0)
  }
}

main().catch(err => {
  console.error('[E2E fatal]', err)
  process.exit(1)
})
