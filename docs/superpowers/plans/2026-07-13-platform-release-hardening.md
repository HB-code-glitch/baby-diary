# Platform Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signed tag releases and explicit signed dry-runs fail closed until trusted Mac and Windows installer bytes pass platform verification and installed-artifact smoke tests, without breaking unsigned branch/PR E2E.

**Architecture:** A dependency-injected Node verifier owns credential, signature, notarization, entitlement, architecture, publisher, and updater-metadata gates. Signed packaging uploads run/attempt-scoped internal artifacts once; architecture-specific smoke jobs consume those bytes; post-smoke manifest jobs hash the same bytes; tag-only upload jobs perform immutable-ID upload and the existing publisher remains the sole public transition.

**Tech Stack:** GitHub Actions YAML, Node.js ESM, Vitest, electron-builder 26, Bash/macOS security tools, PowerShell/Authenticode.

## Global Constraints

- Preserve the exact 14 public asset names and provenance/TOCTOU contracts from `5de4717` and `f239f02`.
- Never run real signing, notarization, tag, push, upload, or release publication locally.
- Normal branch/PR `--dir` E2E remains unsigned-capable.
- Only v-tags and `workflow_dispatch.inputs.signed_package_dry_run == true` may enter signed packaging.
- No ad-hoc/self-signed fallback, `get-task-allow`, unproven `disable-library-validation`, `continue-on-error`, or conditional bypass on mandatory signed steps.
- Preserve unrelated baby/security dirty files and stage only platform-owned files.

---

### Task 1: Injectable platform verifier

**Files:**
- Create: `scripts/platform-release-verification.mjs`
- Create: `scripts/verify-platform-release.mjs`
- Test: `tests/platformReleaseVerification.test.ts`

**Interfaces:**
- Produces: `requiredCredentialErrors(platform, env)`, `verifyMacRelease(options, dependencies)`, `verifyWindowsRelease(options, dependencies)`, and `readPeMachine(bytes)`.
- Consumes: injected `run(command, args)` results and fixture filesystem paths; the default CLI adapter uses real platform tools only in Actions.

- [ ] **Step 1: Write failing credential and normalized-report tests** for missing/empty secrets, invalid Developer ID authority/runtime/timestamp/team, forbidden entitlements, missing universal arch, failed Gatekeeper/stapler, invalid/wrong-subject/untimestamped Authenticode, non-x64 installed app, and missing/mismatched publisher metadata.
- [ ] **Step 2: Run `npm exec vitest -- run tests/platformReleaseVerification.test.ts`** and record failures caused by missing exported APIs.
- [ ] **Step 3: Implement the minimal verifier** with these exact required names: Mac `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `MAC_CSC_NAME`, `MAC_EXPECTED_TEAM_ID`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; Windows `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WIN_EXPECTED_PUBLISHER`.
- [ ] **Step 4: Re-run the focused test** and require zero failures.

### Task 2: Release-only builder configuration and metadata

**Files:**
- Create: `electron-builder.release.cjs`
- Create: `build/entitlements.mac.plist`
- Create: `build/entitlements.mac.inherit.plist`
- Modify: `package.json`
- Test: `tests/platformReleaseConfig.test.ts`

**Interfaces:**
- Produces: release-only `forceCodeSigning: true`, Mac hardened runtime/notarization/entitlements/explicit identity, and Windows expected publisher configuration.
- Preserves: the normal `package.json` build path without forced signing or mandatory notarization.

- [ ] **Step 1: Write failing config tests** requiring author/company `HB-code-glitch`, product/app/version metadata, stable `Baby Diary` NSIS shortcut, allowlisted entitlements only, and release-only signing configuration.
- [ ] **Step 2: Run `npm exec vitest -- run tests/platformReleaseConfig.test.ts`** and record the expected metadata/config failures.
- [ ] **Step 3: Add the minimal metadata, plist files, and config merge**; the Windows publisher comes only from `WIN_EXPECTED_PUBLISHER` and the Mac identity from `MAC_CSC_NAME`.
- [ ] **Step 4: Re-run the config test** and require zero failures.

### Task 3: Installed-artifact smoke scripts

**Files:**
- Create: `scripts/smoke-signed-mac.sh`
- Create: `scripts/smoke-signed-windows.ps1`
- Test: `tests/platformReleaseSmokeScripts.test.ts`

**Interfaces:**
- Mac inputs: universal DMG path and expected host `arm64` or `x86_64`; installs to a temporary Applications-style directory, preserves quarantine, runs both packaged E2E commands, and cleans up.
- Windows inputs: Setup path, expected publisher, deterministic install directory; silently installs, validates installed x64 app and `app-update.yml.publisherName`, runs both packaged E2E commands, silently uninstalls, and verifies cleanup.

- [ ] **Step 1: Write failing source-contract tests** for host arch, read-only mount, quarantine, normal+sync E2E, Java-dependent sync path, deterministic install/uninstall, publisher validation, and cleanup traps.
- [ ] **Step 2: Run the smoke-script focused test** and record missing-file failures.
- [ ] **Step 3: Implement scripts without bypasses or real local execution.**
- [ ] **Step 4: Re-run the focused test** and require zero failures.

### Task 4: Signed workflow graph and immutable bytes

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `tests/releaseWorkflow.test.ts`
- Create: `tests/platformReleaseWorkflow.test.ts`

**Interfaces:**
- Produces jobs: signed context, tag-only release preflight, Mac/Windows package, Mac ARM/Intel and Windows installed smoke, post-smoke Mac/Windows manifest, tag-only immutable upload, dry-run completion, and single publish.
- Internal artifact names include `${{ github.run_id }}-${{ github.run_attempt }}` with one-day retention.

- [ ] **Step 1: Write/update workflow mutation tests first** for typed dry-run input, signed condition, credential wiring, forced signing, run-scoped artifacts, no rebuild after package, required smoke dependencies, post-smoke manifest order, dry-run no external mutation, immutable-ID uploads, exact 14 contract, and all fail-open mutations named in the brief.
- [ ] **Step 2: Run workflow/release tests** and record RED failures against the old build-upload-in-one-job graph.
- [ ] **Step 3: Rewrite the workflow minimally** so package bytes are uploaded internally once, all three installed smoke jobs consume them, manifests are built only afterward, tag uploads consume staged bytes, and dry-run stops before all GitHub release mutations.
- [ ] **Step 4: Re-run workflow and existing release suites** and require zero failures.

### Task 5: Full verification and selective commit

**Files:**
- Verify all files above only.

- [ ] **Step 1: Run focused platform/release tests** and capture counts.
- [ ] **Step 2: Run renderer and node typechecks, `npm run build`, and the full test suite.**
- [ ] **Step 3: Run `git diff --check`, parse YAML, inspect the final job graph, and self-review every brief requirement.**
- [ ] **Step 4: Confirm no real signing/release call occurred and dirty baby/security files are unchanged.**
- [ ] **Step 5: Stage only owned platform files, commit once, report SHA/RED→GREEN counts/secret names/job graph/external blockers, and ask for a fresh read-only review.**
