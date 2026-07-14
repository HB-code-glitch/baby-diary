# Platform Release Certificate Pin Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the lossy Windows Subject DN normalizer and make every Windows release trust decision require both an exact canonical X.509 Subject string and the expected SHA-256 certificate thumbprint.

**Architecture:** Treat PowerShell/X509 `SignerCertificate.Subject` as an opaque canonical identity string; do not parse, trim, reorder, unescape, or otherwise normalize it. Pin the certificate independently with `WIN_EXPECTED_CERT_SHA256`, and require both values to match for every signed executable. Keep electron-builder and `app-update.yml` on the same exact Subject contract while the executable verifier and installed smoke additionally enforce the thumbprint.

**Tech Stack:** GitHub Actions YAML, Vitest/TypeScript, Node.js ESM, PowerShell Authenticode/X509 APIs, electron-builder 26.

## Global Constraints

- `WIN_EXPECTED_PUBLISHER` must be the exact full string emitted by `SignerCertificate.Subject` and comparisons are ordinal/exact.
- `WIN_EXPECTED_CERT_SHA256` is mandatory and must be exactly 64 hexadecimal characters.
- Signed Windows artifacts pass only when the full Subject and SHA-256 thumbprint both match.
- A bare common name, a lossy-equivalent DN, or a matching Subject with a different certificate hash fails closed.
- Do not touch, stage, or commit unrelated baby-info/security files already dirty in the shared worktree.

---

### Task 1: Lock the non-lossy trust contract with RED tests

**Files:**
- Modify: `tests/platformReleaseVerification.test.ts`
- Modify: `tests/platformReleaseCli.test.ts`
- Modify: `tests/platformReleaseConfig.test.ts`
- Modify: `tests/platformReleaseWorkflow.test.ts`
- Modify: `tests/installedReleaseSmoke.test.ts`

- [x] **Step 1: Add Subject bypass regressions**

  Assert rejection for each non-identical pair: escaped leading space, escaped trailing space, multi-valued RDN versus separate RDN, and arbitrary embedded quotes. Assert `app-update.yml` also rejects a lossy-equivalent Subject.

- [x] **Step 2: Add certificate hash regressions**

  Require the new credential, reject malformed values, reject a wrong signer SHA-256 value even when Subject matches, and assert native inspection returns SHA-256.

- [x] **Step 3: Add workflow/config/smoke contract tests**

  Require the new environment secret in credential gates, verification, and installed smoke. Require exact/ordinal Subject comparison and SHA-256 pinning in the installed smoke script and operator guide.

- [x] **Step 4: Run the focused tests and record RED failures**

  Run the five affected test files and confirm failures are caused by the current normalizer and missing thumbprint contract.

### Task 2: Implement exact Subject plus SHA-256 verification

**Files:**
- Modify: `scripts/platform-release-verification.mjs`
- Modify: `scripts/windows-installed-release-smoke.ps1`
- Modify: `electron-builder.release.cjs`

- [x] **Step 1: Remove DN parsing and normalization**

  Compare the raw expected Subject to PowerShell's full `SignerCertificate.Subject` with exact equality. Pass the expected value without trimming or canonicalizing it. Keep a fail-closed full-Subject credential shape check without reconstructing the DN.

- [x] **Step 2: Inspect and pin SHA-256**

  Return `SignerCertificate.GetCertHashString(HashAlgorithmName.SHA256)` from PowerShell, validate the expected pin, and require Subject plus thumbprint for Setup, portable, unpacked main, and elevate executables.

- [x] **Step 3: Align installed smoke and updater metadata**

  Use PowerShell ordinal equality for Subject, ordinal-ignore-case equality for the hex thumbprint, and raw exact Subject equality for `app-update.yml.publisherName`.

### Task 3: Wire the secret boundary and operator contract

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `docs/platform-release-signing.md`

- [x] **Step 1: Add `WIN_EXPECTED_CERT_SHA256` to signed Windows gates**

  Expose it only to the package credential gate, post-package verifier, and installed smoke job. Pass it to both verifier entry points.

- [x] **Step 2: Document exact source values**

  Document how operators obtain the exact Subject and SHA-256 from the signing certificate, that both are environment-scoped secrets, and that no Subject normalization/reordering is allowed.

### Task 4: Verify and selectively commit

- [x] **Step 1: Run focused verification**

  Run the 13-file platform/release suite, renderer and Node typechecks, production build, electron-builder 26 schema validation, Node/PowerShell/plist/YAML structural checks, and `git diff --check`.

- [x] **Step 2: Inspect scope**

  Confirm the diff from `2b66d64` contains only platform-owned files in this plan, and unrelated shared-worktree changes remain unstaged.

- [x] **Step 3: Selectively commit**

  Stage only the platform files, commit the fix, and report the SHA and verification evidence for independent review.
