# Platform Release Publisher Cardinality Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows updater metadata trustworthy only when electron-builder 26 emits exactly one `publisherName`, and that sole value is raw-equal to `WIN_EXPECTED_PUBLISHER`.

**Architecture:** Use the installed electron-builder 26.15.3 signing manager and YAML serializer as the format reference: a configured publisher string becomes a canonical one-element array in `app-update.yml`. Export one predicate from the release verifier and reuse it from the installed Windows smoke so both paths reject alternate, duplicate, mixed, non-string, empty, scalar, or merely equivalent values.

**Tech Stack:** Vitest/TypeScript, Node.js ESM, PowerShell, js-yaml, electron-builder/app-builder-lib 26.15.3.

## Global Constraints

- The only accepted `publisherName` shape is an array containing exactly one string.
- That sole string must equal `WIN_EXPECTED_PUBLISHER` with raw strict equality.
- A scalar string is rejected because electron-builder 26.15.3 generates a one-element array for this configuration.
- Empty, duplicate, alternate, equivalent-but-different, non-string, and mixed arrays fail closed.
- Do not change, stage, or commit security-integration or other owners' dirty files.

---

### Task 1: Prove the generated format and reproduce the bypass

**Files:**
- Modify: `tests/platformReleaseConfig.test.ts`
- Modify: `tests/platformReleaseVerification.test.ts`
- Modify: `tests/installedReleaseSmoke.test.ts`

**Interfaces:**
- Consumes: `electron-builder.release.cjs`, `WindowsSignToolManager.computedPublisherName`, `builder-util.serializeToYaml`.
- Produces: a tested canonical metadata shape of `[WIN_EXPECTED_PUBLISHER]`.

- [x] **Step 1: Add the electron-builder 26 generated-format characterization**

  Load the release config with fixture credentials, pass its Windows options through the installed `WindowsSignToolManager`, serialize the resulting publish configuration with `serializeToYaml`, and assert the parsed `publisherName` is exactly `[expectedPublisher]`.

- [x] **Step 2: Add updater cardinality bypass regressions**

  Require `verifyWindowsRelease` to reject a scalar string, empty array/string, duplicate expected value, exact expected plus attacker alternate, equivalent-but-different DN, non-string array, and mixed expected/non-string array. The current duplicate/alternate/string/mixed cases must fail RED because `.some` accepts them.

- [x] **Step 3: Lock installed smoke to the shared predicate**

  Assert the smoke script invokes the verifier's canonical publisher predicate and contains no `.some`/any-match publisher validation.

- [x] **Step 4: Run the three focused tests and record RED**

  Run: `npx vitest run tests/platformReleaseVerification.test.ts tests/platformReleaseConfig.test.ts tests/installedReleaseSmoke.test.ts`

### Task 2: Enforce one canonical publisher in both verification paths

**Files:**
- Modify: `scripts/platform-release-verification.mjs`
- Modify: `scripts/windows-installed-release-smoke.ps1`

**Interfaces:**
- Produces: `isCanonicalPublisherName(value, expectedPublisher): boolean`.

- [x] **Step 1: Replace allow-list matching with exact cardinality**

  Return true only for `Array.isArray(value)`, `value.length === 1`, `typeof value[0] === 'string'`, and `value[0] === expectedPublisher`. Use this predicate in updater metadata verification.

- [x] **Step 2: Reuse the predicate from installed smoke**

  Parse installed `app-update.yml` and call the exported predicate; fail the smoke when it returns false.

- [x] **Step 3: Run the focused tests to GREEN**

  Run the three tests from Task 1 and confirm every valid/invalid shape behaves fail closed.

### Task 3: Document, verify, and selectively commit

**Files:**
- Modify: `docs/platform-release-signing.md`
- Verify: all platform/release files.

- [x] **Step 1: Document the canonical metadata shape**

  State that electron-builder 26 writes a one-element array and that scalar, empty, duplicate, or alternate entries are rejected.

- [x] **Step 2: Run full focused verification**

  Run the 13-file platform/release suite, renderer and Node typechecks, production build, electron-builder schema validation, Node/PowerShell/YAML/plist checks, PowerShell 5.1 hash-overload check, and `git diff --check`.

- [x] **Step 3: Selectively commit**

  Stage only the platform-owned files in this plan, verify all security-integration paths remain index 0, commit, and report the SHA for independent review.
