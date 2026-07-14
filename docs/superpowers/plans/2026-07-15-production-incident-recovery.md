# Production Incident Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Every production-code change follows RED → GREEN. The user requested one integrated review only, so do not run per-task reviews; run one whole-branch review after all tasks.

**Goal:** Restore current Mac production sync, make Windows v0.3.8→v0.3.10 startup preserve the live profile instead of misclassifying opaque legacy settings as corruption, and gate future releases on the paths that failed here.

**Architecture:** Keep strict validation for every managed setting while treating unknown v0.3.8 fields as bounded opaque data that must survive unchanged. Before resuming a pre-publication recovery transaction, prefer a currently readable live settings/journal pair and durably retire only the stale control artifacts; never cancel a `primary-verified` transaction. Keep cloud data untouched and deploy only the already reviewed Firestore rules with a recorded rollback ruleset.

**Tech Stack:** Electron, TypeScript, Vitest, Playwright Electron, Firebase/Firestore Rules, electron-builder, GitHub Actions.

## Global Constraints

- Never read, write, launch, or restore `C:\Users\배한주\AppData\Roaming\baby-diary` without the exact token `RESTORE_BABY_DIARY_2026-07-14`.
- Do not execute an installer or DMG against a real user profile; all runtime tests use nonce-owned temporary profiles.
- Never mount a DMG on Windows.
- Existing live settings/journal bytes win whenever they form a valid pair; no fallback backup may overwrite a valid live pair.
- Unknown legacy settings are preserved but are never interpreted as Firebase configuration, family identity, journal metadata, or another managed field.
- `parseAppSettings` remains the strict untrusted-input boundary; persisted-data compatibility uses a separate stored-settings parser.
- A pre-publication recovery may be retired only when the live pair validates and neither intent nor staging metadata is `primary-verified`.
- `primary-verified`, unreadable, divergent, or malformed recovery evidence continues through the existing fail-closed recovery path.
- Production Firestore rollback authority is `projects/baby-diary-jaei-2026/rulesets/72fa2a07-4109-449e-b0cf-713a1a92ea07`.
- Active production rules after remediation must be SHA-256 `cbd10fb1c0d8ce1a46f64d912d8bcf1d9f606521273ffb8d63760cabe241d770` and ruleset `projects/baby-diary-jaei-2026/rulesets/d884dc4c-e702-4451-aa42-76d961012d75`.
- Mac and Windows builds remain unsigned personal-use builds; do not introduce paid signing requirements.
- Run exactly one independent whole-branch code review after implementation, per user request.

---

### Task 1: Backward-Compatible Stored Settings

**Files:**
- Modify: `shared/babyInfoSettingsCommit.ts`
- Modify: `electron/store/settings.ts`
- Test: `tests/settings.test.ts`
- Test: `tests/babyInfoSettingsJournal.test.ts`
- Test: `tests/upgradeDataContract.test.ts`

**Interfaces:**
- Produces: `parseStoredAppSettings(value: unknown): AppSettings` for trusted bytes read from disk or verified snapshots.
- Preserves: `parseAppSettings(value: unknown): AppSettings` as the strict renderer/IPC validator.
- Consumes: the exact v0.3.8 fixture from `scripts/upgrade-data-contract.mjs`.

- [ ] **Step 1: Add RED tests for the exact v0.3.8 opaque fixture**

  Prove strict `parseAppSettings` still rejects new unknown input, while `parseStoredAppSettings` accepts and retains `profile.legacyContact`, `upgradeOpaque`, and `babyInfoSync` without changing any managed value.

- [ ] **Step 2: Run the focused tests and capture the expected failure**

  Run `node_modules/.bin/vitest run tests/settings.test.ts tests/babyInfoSettingsJournal.test.ts tests/upgradeDataContract.test.ts` and require failure specifically because the stored parser is absent or the fixture is rejected.

- [ ] **Step 3: Implement the minimal stored parser and route persisted reads through it**

  Validate all known fields with the existing rules; recursively require opaque values to be JSON-safe and bounded by the existing settings-file size ceiling. Preserve opaque fields by spreading the original plain records only after validation. All `SettingsStore` reads and internal current-state reparses use the stored parser. IPC operations must not create or mutate opaque fields; managed saves merge only validated managed fields onto the authoritative current stored object.

- [ ] **Step 4: Verify GREEN and preservation across save, merge, and baby-info commit**

  Assert that managed edits work, opaque values remain byte-equivalent after JSON round-trip, and attempted renderer injection cannot replace them.

---

### Task 2: Retire False-Positive Pre-Publication Recovery

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `parseStoredAppSettings` from Task 1 through `livePairIsReadable`.
- Produces: a crash-safe reconciliation path that retires stale `allocated`, `awaiting-windows-confirmation`, or `prepared` artifacts when the current live pair is valid.

- [ ] **Step 1: Add RED recovery tests**

  Seed exact intent/staging evidence equivalent to the screenshot, then place a valid opaque v0.3.8 live settings file in front of it. Assert one `SettingsStore` construction opens normally, preserves exact live bytes/semantics, never publishes staged backup bytes, retains the forensic archive, and leaves no active intent/staging artifact. Add negative tests for unreadable live data and `primary-verified` evidence.

- [ ] **Step 2: Verify RED for the existing resume-first ordering**

  Run `node_modules/.bin/vitest run tests/backupPairRecovery.test.ts tests/settings.test.ts`; require the existing code to attempt/continue restore instead of accepting the readable live pair.

- [ ] **Step 3: Implement crash-safe readable-live reconciliation**

  After tombstone reconciliation and before `resumeRestoreIntent`, validate the live pair. Parse both outer intent and stage metadata; retire only mutually consistent pre-publication controls. Use the existing durable tombstone/remove primitives so a crash between removals cannot reconstruct and publish the staged backup. Never delete forensic archives.

- [ ] **Step 4: Verify GREEN and all recovery invariants**

  Re-run the focused suite and retain the existing four-start test for genuinely unreadable data unchanged.

---

### Task 3: Honest Sync Error UI and Production Rules Parity Gate

**Files:**
- Modify: `src/components/SyncSettingsSlot.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Create: `scripts/verify-production-rules.mjs`
- Test: `tests/familyIdentityReconciliation.test.ts`
- Test: `tests/syncKeepLoggedInUi.test.tsx`
- Create: `tests/productionRulesParity.test.ts`

**Interfaces:**
- Consumes: `DETAIL_FAMILY_ACCESS_UNCERTAIN` without exposing the sentinel to users.
- Produces: a read-only command that authenticates through installed `firebase-tools`, reads the active `cloud.firestore` ruleset, compares the exact content SHA-256, and prints only project/ruleset/hash metadata—never tokens or document data.

- [ ] **Step 1: Add RED UI and parity tests**

  Assert Korean/Japanese friendly copy, retry availability, preserved `familyId`, no raw sentinel, and parity-command failure on a mismatched rules hash.

- [ ] **Step 2: Verify RED**

  Run `node_modules/.bin/vitest run tests/familyIdentityReconciliation.test.ts tests/syncKeepLoggedInUi.test.tsx tests/productionRulesParity.test.ts`.

- [ ] **Step 3: Implement minimal UI mapping and read-only parity command**

  Map only known detail constants to localized copy and retain a safe generic fallback. The command must not read Firestore documents or Auth users.

- [ ] **Step 4: Verify GREEN against active production metadata**

  Require ruleset `d884dc4c-e702-4451-aa42-76d961012d75` and SHA-256 `cbd10fb1c0d8ce1a46f64d912d8bcf1d9f606521273ffb8d63760cabe241d770`.

---

### Task 4: Packaged Regression Gate and v0.3.10 Delivery

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/build.yml`
- Modify or create: `scripts/windows-installed-release-smoke.ps1`
- Modify or create: `scripts/mac-e2e.mjs`
- Test: `tests/installedReleaseSmoke.test.ts`
- Test: `tests/releaseWorkflow.test.ts`

**Interfaces:**
- Consumes: exact Windows Setup and Mac universal DMG produced from one reviewed SHA.
- Produces: isolated-profile smoke evidence and release assets for v0.3.10.

- [ ] **Step 1: Add RED contract tests proving upgrade/smoke jobs cannot silently skip for an unsigned personal release**

  The gate must seed the exact v0.3.8 opaque fixture, create false-positive pre-publication evidence, launch the packaged candidate with a nonce user profile, and require UI readiness with unchanged semantic projection.

- [ ] **Step 2: Implement and run the isolated packaged smoke**

  Never use the real AppData profile. Capture executable path, package SHA-256, profile root, before/after manifests, renderer readiness, and zero recovery dialog evidence.

- [ ] **Step 3: Bump to 0.3.10, run typecheck/full tests/rules tests/build, and perform one final review**

  Any failure blocks release. Review the complete incident diff once, fix all Critical/Important findings, and rerun affected plus full gates.

- [ ] **Step 4: Build both platforms and publish only verified artifacts**

  Replace the Windows Desktop installer only after isolated installed smoke passes. Publish the universal Mac DMG as `INSTALL-ME-BabyDiary-Mac.dmg`, mark v0.3.10 latest, and verify the stable URL redirect, size, and SHA-256. Preserve v0.3.9 for rollback.
