# Evidence-based age guidance implementation plan

> **Execution model:** subagent-driven development with one implementation owner and two review passes per task. Tests are written first. The root agent owns architecture, evidence decisions, integration, release, and final verification.

**Goal:** Replace unsupported or misleading embedded care advice with official-source, age-routed Korean/Japanese guidance while preserving records, sync, performance, and cross-platform behaviour.

**Architecture:** A typed, immutable evidence registry feeds age-stage guidance records. Pure selectors perform date/age/locale routing. Existing home/settings/post-record views consume selectors and reveal content progressively. Fever routing is a separate pure safety function. No persisted schema changes.

**Stack:** React 18, TypeScript, i18next, Vitest, Electron 31, Playwright packaged E2E.

**Design spec:** `docs/superpowers/specs/2026-07-13-evidence-based-age-guidance-design.md`

---

## Task 1: Official source registry and age-stage model

**Files:**

- Create: `src/lib/healthEvidence.ts`
- Create: `src/lib/ageGuidance.ts`
- Create: `tests/healthEvidence.test.ts`
- Create: `tests/ageGuidance.test.ts`
- Modify: `src/lib/guidance.ts`
- Modify: `tests/guidance.test.ts`
- Modify: `tests/guidanceConsistency.test.ts`

### Step 1: Write failing evidence-registry tests

Test that every source has a unique ID, HTTPS official URL, Korean/Japanese display metadata, review date, and an allowed authority domain. Explicitly reject former commercial domains and unlabeled claims.

Run: `npx vitest run tests/healthEvidence.test.ts`  
Expected: FAIL because the registry does not exist.

### Step 2: Implement the immutable source registry

Add official sources from KDCA, CFA/MHLW, WHO, CDC/NICHD, NICE, and AAP. Export typed `getEvidenceSources(ids, locale)` helpers. Do not put external prose or copied long quotations in the bundle.

Run: `npx vitest run tests/healthEvidence.test.ts`  
Expected: PASS.

### Step 3: Write failing age-routing tests

Cover exact boundaries 0/27/28/89/90/181/182/273/274/364/365/547/548/729/730/1094/1095/1825/1826, invalid/future/missing birthdates, 5+ fallback, current priority count, source-ID referential integrity, and Korean/Japanese completeness.

Run: `npx vitest run tests/ageGuidance.test.ts`  
Expected: FAIL.

### Step 4: Implement age stages and guidance records

Use structured records with:

- `id`, `stageId`, `category`, `priority`, `urgency`
- `titleKo/titleJa`, `summaryKo/summaryJa`, `actionsKo/actionsJa`
- `sourceIds`
- optional `country` and `linkPurpose`

Keep the first three priorities concise. Put safe sleep, feeding/readiness, food safety, activity/screen/sleep, oral health, check-up/vaccine links, and developmental act-early guidance in the correct stages. Add corrected-age and clinician-plan caveats.

Run: `npx vitest run tests/ageGuidance.test.ts tests/healthEvidence.test.ts`  
Expected: PASS.

### Step 5: Preserve compatibility while retiring bad markers

Refactor `guidance.ts` to re-export only safe compatibility helpers used by History/Home while removing commercial sources and formula-band extrapolation past 6 months. Update old guidance tests to assert the new contracts rather than old unsupported numeric prose.

Run: `npx vitest run tests/guidance.test.ts tests/guidanceConsistency.test.ts tests/ageGuidance.test.ts`  
Expected: PASS.

### Step 6: Review and commit

- Spec-compliance reviewer verifies age windows and source mapping.
- Code-quality reviewer verifies immutable data, pure functions, and no persisted-state impact.

Commit: `feat: add official age guidance registry`

## Task 2: Correct fever and feeding safety behaviour

**Files:**

- Modify: `src/lib/guidance.ts`
- Modify: `src/lib/breastfeeding.ts`
- Modify: `src/components/FeverModal.tsx`
- Modify: `src/components/FeedingTipPopup.tsx`
- Modify: `src/pages/HomePage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Modify: `tests/guidance.test.ts`
- Modify: `tests/breastfeeding.test.ts`
- Create: `tests/healthSafetyUi.test.tsx`

### Step 1: Write failing fever tests

Assert:

- `<90 days && >=38.0` routes urgent.
- `90–181 days && >=39.0` routes high risk.
- `>=182 days` is not marked dangerous from temperature height alone.
- unknown age receives a cautious assessment prompt without pretending the child is newborn.
- care steps include fluids and neutral clothing, exclude tepid sponging, exclude unsupported 24-hour/3-day rules, and use the 5-day assessment threshold plus earlier red-flag advice.
- red flags are structured bilingual arrays.

Run: `npx vitest run tests/guidance.test.ts tests/healthSafetyUi.test.tsx`  
Expected: FAIL.

### Step 2: Implement conservative fever routing and modal

Separate temperature routing from symptom red flags. Do not infer measurement site. Do not provide medicine doses. Show the urgent action first, then expandable red flags and sources. Keep keyboard focus, alert-dialog semantics, and reduced-motion behaviour.

Run the targeted fever tests and typecheck.  
Expected: PASS.

### Step 3: Write failing responsive-feeding tests

Assert that:

- no function returns a universal next-feed clock/window;
- breastfeeding feedback uses count/side/elapsed time plus cues;
- formula feedback confirms logged total/count but never calculates `remaining`, a quota, or a danger colour solely from volume;
- formula bands return `null` after their valid age window;
- fixed 12–24 month breast interval/count bands and commercial source notes are gone.

Run: `npx vitest run tests/breastfeeding.test.ts tests/healthSafetyUi.test.tsx`  
Expected: FAIL.

### Step 4: Implement responsive feeding feedback

Retain all record creation, timers, last-side support, and statistics. Replace predictions/targets with hunger and fullness cues. For young newborns, state that frequent feeding is common and that a sleepy baby, poor intake, dehydration signs, or growth concern needs individual professional advice.

Run targeted tests and typecheck.  
Expected: PASS.

### Step 5: Verify bilingual parity and commit

Run: `npm run check`  
Expected: PASS with the full suite.

- Spec-compliance reviewer checks NICE/WHO/CDC wording and prohibited claims.
- Code-quality reviewer checks component accessibility and stale imports.

Commit: `fix: make fever and feeding guidance conservative`

## Task 3: Progressive age guidance UI and official evidence centre

**Files:**

- Create: `src/components/AgeGuidancePanel.tsx`
- Create: `src/components/EvidenceSourceList.tsx`
- Modify: `src/pages/HomePage.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/styles.css`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Create: `tests/ageGuidanceUi.test.tsx`
- Create: `tests/evidenceExternalLink.test.ts`
- Modify: `tests/progressiveDisclosure.test.ts`
- Modify: `scripts/mac-e2e.mjs`

### Step 1: Write failing UI contract tests

Test that the home panel:

- shows at most three priorities before expansion;
- reveals remaining current-stage content only on request;
- handles missing birthdate with one setup prompt;
- uses current locale and country-specific official links;
- exposes sources via semantic anchors/buttons and has accessible expanded state.

Test that Settings no longer renders the fixed breastfeeding interval table or mixed 13-marker accordion and instead groups official evidence by current stage/category.

Test the external-link bridge independently: only `https:` URLs whose normalized hostname is in the evidence registry's authority allowlist can reach `shell.openExternal`; HTTP, credentials, lookalike suffixes, unknown hosts, and malformed URLs are rejected.

Run: `npx vitest run tests/ageGuidanceUi.test.tsx tests/progressiveDisclosure.test.ts`  
Expected: FAIL.

### Step 2: Implement reusable components

Build `AgeGuidancePanel` from the pure selectors. Reuse the existing premium card palette and spacing. Use a short staged reveal, no auto-advancing carousel, no layout-shifting animation, and a reduced-motion override.

`EvidenceSourceList` displays organisation/title/review date and opens HTTPS URLs through a new typed `openEvidenceSource` bridge. Validate the source URL in the renderer for UX and again in Electron main for security. Browser-mode fallback must use `noopener,noreferrer`. Source details remain collapsed until requested.

### Step 3: Integrate Home and Settings

Replace formula-only home advice and both old Settings guide cards. Keep sync, records, reports, tutorial, and settings disclosures untouched.

Run targeted UI tests and typecheck.  
Expected: PASS.

### Step 4: Extend packaged E2E

Add Korean and Japanese assertions for:

- current-stage heading and priority cap;
- expand/collapse;
- source disclosure;
- feeding feedback without quota/countdown language;
- fever modal rendering.

Do not require live internet access; verify link targets without navigating.

Run: `npm run build && npm run test:e2e` against the development build where applicable.  
Expected: PASS.

### Step 5: Review and commit

- Spec-compliance reviewer checks all required views and bilingual behaviour.
- Code-quality reviewer checks focus, reduced motion, responsive layout, and render cost.

Commit: `feat: show age-appropriate evidence guidance`

## Task 4: Whole-app content audit and regression hardening

**Files:**

- Modify as identified by the inventory: `src/i18n/ko.json`, `src/i18n/ja.json`, `src/lib/milestones.ts`, tests
- Create: `docs/health-content-audit.md`

### Step 1: Re-scan every embedded claim

Search TypeScript/TSX/JSON for medical, nutrition, development, sleep, safety, formula, breastfeeding, medicine, fever, vaccination, dental, and milestone terms. Classify each as record label, cultural description, or health claim.

Every health claim must be removed, made neutral, or mapped to an official source. Cultural event descriptions must be clearly labelled as traditions and must not imply a health benefit.

### Step 2: Add an auditable content ledger

Document each retained health topic, app location, source IDs, decision, and review date in `docs/health-content-audit.md`. This ledger contains short summaries and links, not copied source text.

### Step 3: Add guard tests

Tests reject known removed phrases/domains, missing bilingual text, broken source references, copied numeric risk marketing, and fixed feeding countdown/allowance wording.

Run: `npm run check`  
Expected: PASS.

### Step 4: Review and commit

Independent reviewer compares the inventory report to tracked files and confirms zero unaudited health claims.

Commit: `docs: complete embedded health content audit`

## Task 5: Cross-platform verification and release 0.3.9

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: release metadata/workflows only if required

### Step 1: Fresh verification

Run from a clean worktree:

```powershell
npm ci
npm run check
npm run build
npm run build:win
npm run test:e2e
git diff --check
```

Inspect the packaged Windows UI in Korean and Japanese. Confirm there is no schema migration and existing data paths are untouched.

### Step 2: Final code review

Run one whole-branch review for correctness, evidence fidelity, accessibility, cross-platform risks, and prohibited medical claims. Resolve all high/medium findings and re-run the affected checks.

### Step 3: Publish

- bump to 0.3.9;
- push `codex/evidence-guidance-v3`;
- open PR and wait for CI;
- merge only after all checks pass;
- tag/release 0.3.9 and wait for Windows/macOS packaged CI;
- verify published asset hashes;
- replace the Windows Desktop installer with `Baby-Diary-Setup-0.3.9.exe` and verify the installed app reports 0.3.9.

### Step 4: Completion report

Report:

- major unsafe/unsupported claims removed;
- the final age-stage coverage;
- primary source links;
- test counts and packaged E2E results;
- macOS/Windows release links and Windows installer hash.
