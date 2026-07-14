# Renderer Evidence Security Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every official evidence URL out of renderer assets while preserving exact-ID Electron opening, and close the reviewed accessibility and UI-regression gaps.

**Architecture:** `shared/healthEvidence.ts` becomes renderer-safe display metadata only. A new `electron/healthEvidenceUrlRegistry.ts` owns the immutable ID→URL map and is imported only by Electron main code and Node verification. Browser fallback rejects evidence-link requests. Production build runs a scanner that compares compiled main-only registry URLs against every renderer JavaScript asset.

**Tech Stack:** React 18, TypeScript, Electron IPC, Vitest, Vite, Playwright packaged E2E, CSS.

## Global Constraints

- Keep the existing `HealthEvidenceSourceId` union and exact-ID rejection behavior.
- Do not change event, account, family, login, or sync schemas.
- Preserve Task2 fever and quick-record flows.
- Renderer code must not import the URL registry or open arbitrary URLs.
- Keep Korean/Japanese behavior parallel and macOS/Windows on the same renderer path.
- Make source summary and action targets at least 40px high and respect reduced motion.

---

### Task 1: Main-only URL registry and renderer leak gate

**Files:**
- Create: `electron/healthEvidenceUrlRegistry.ts`
- Create: `scripts/verify-renderer-evidence-boundary.mjs`
- Modify: `shared/healthEvidence.ts`
- Modify: `electron/evidenceExternalLink.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/lib/guidance.ts`
- Modify: `package.json`
- Test: `tests/healthEvidence.test.ts`
- Test: `tests/evidenceExternalLink.test.ts`
- Test: `tests/rendererEvidenceBoundary.test.ts`

**Interfaces:**
- Produces: `getEvidenceUrlById(sourceId: string): string | null` for Electron main only.
- Preserves: `getEvidenceSourceById` and `getEvidenceSources` as URL-free metadata helpers.

- [ ] Write tests that require URL-free shared records, browser fallback rejection, exact main lookup, and a build scanner that fails on an injected registry URL.
- [ ] Run the targeted tests and the scanner against the current build; expect failures showing shared/browser/dist URL leakage.
- [ ] Move the immutable exact URL map and approved hosts to `electron/healthEvidenceUrlRegistry.ts`; remove every URL property from shared and renderer compatibility types.
- [ ] Make browser fallback reject with `EVIDENCE_LINK_UNAVAILABLE`; keep preload sending only `HealthEvidenceSourceId`.
- [ ] Append `node scripts/verify-renderer-evidence-boundary.mjs` to the production build command.
- [ ] Run targeted tests and `npm run build`; expect the scanner to report zero leaked registry URLs.

### Task 2: Evidence source accessibility and touch targets

**Files:**
- Modify: `src/components/EvidenceSourceList.tsx`
- Modify: `src/index.css`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Test: `tests/ageGuidanceUi.test.tsx`

**Interfaces:**
- Each source button exposes an accessible name containing both `organization` and `title`.
- `.evidence-source-list > summary` and `.evidence-source-button` have `min-height: 40px`.

- [ ] Write failing DOM/CSS/i18n tests for unique accessible names, 40px targets, hover/active/focus styling, and reduced-motion transitions.
- [ ] Run `tests/ageGuidanceUi.test.tsx`; expect accessibility and CSS assertions to fail.
- [ ] Use `ageGuidance` translation keys for source/action/urgency/country copy and implement the target states without changing the visual theme.
- [ ] Re-run the UI tests; expect PASS.

### Task 3: Stable day input and boundary UI regressions

**Files:**
- Modify: `src/components/AgeGuidancePanel.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Test: `tests/ageGuidanceUi.test.tsx`

**Interfaces:**
- Selectors consume a stable local `YYYY-MM-DD` day key.
- `aria-controls="age-guidance-secondary"` always references an existing container.

- [ ] Write failing tests for stable same-day selector input, always-present controlled content, missing/future birthdate navigation, and 60–71/72+ labels in both locales.
- [ ] Change “현재 월령” copy to “현재 나이” and the Japanese equivalent.
- [ ] Normalize `asOf` to a local day key and keep the controlled secondary container mounted with `hidden` while collapsed.
- [ ] Run UI and age-boundary tests; expect PASS.

### Task 4: Packaged regression and final verification

**Files:**
- Modify: `scripts/mac-e2e.mjs`

**Interfaces:**
- Packaged E2E fails if responsive-feeding feedback contains a legacy next-feed countdown.

- [ ] Add a negative assertion for Korean/Japanese countdown phrases and rename the screenshot to `breastfeed-home-summary`.
- [ ] Run `node --check scripts/mac-e2e.mjs` and targeted tests.
- [ ] Run `npm run check`, `npm run build`, and `npm run test:e2e`.
- [ ] Scan renderer assets, diff, forbidden health strings, and schema scope; expect no findings.
- [ ] Commit once with `fix: keep evidence URLs out of renderer`.
