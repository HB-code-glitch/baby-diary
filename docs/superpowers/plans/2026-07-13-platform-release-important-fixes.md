# Platform Release Important Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three Important release-path findings: event-safe production gating, protected signing/publish environments, and full Windows certificate Subject DN pinning.

**Architecture:** Keep the existing 15-job release DAG and exact-byte artifact flow. Tighten only the workflow predicates and secret boundaries, then make the artifact verifier compare a canonical full X.500 Subject rather than a certificate common name. Each behavior change starts with a focused failing regression test.

**Tech Stack:** GitHub Actions YAML, Vitest/TypeScript, Node.js ESM, PowerShell Authenticode inspection, electron-builder 26.

## Global Constraints

- Production release mutation runs only for a `push` event whose ref starts with `refs/tags/v`.
- Signed packaging runs only for that production event or `workflow_dispatch` with `signed_package_dry_run == true`.
- `workflow_dispatch` on a tag with the input omitted/false performs zero release mutation.
- `platform-release-signing` owns Apple/Windows signing secrets and allows reviewed `master`-branch dry-runs plus `v*` tags.
- `platform-release-publish` owns `RELEASE_TOKEN`, requires review, and allows only `v*` tags.
- `WIN_EXPECTED_PUBLISHER` is the full certificate Subject DN and is also electron-builder's `publisherName` contract.
- Do not touch, stage, or commit baby Wave3 or security-owner files already dirty in the shared worktree.

---

### Task 1: Event/ref/input release truth table

**Files:**
- Modify: `tests/platformReleaseWorkflow.test.ts`
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: `github.event_name`, `github.ref`, and typed `inputs.signed_package_dry_run`.
- Produces: exact `PRODUCTION_TAG_PUSH` and `SIGNED_RUN` job predicates shared by the release-job groups.

- [x] **Step 1: Write the failing test**

  Change the expected conditions to:

  ```ts
  const PRODUCTION_TAG_PUSH = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
  const SIGNED_RUN = "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || (github.event_name == 'workflow_dispatch' && inputs.signed_package_dry_run == true)"
  ```

  Add a table that evaluates every signed and mutation job for push/tag, push/branch, dispatch/branch true/false, and dispatch/tag true/false. The dispatch/tag/false row must expect every release job to be false.

- [x] **Step 2: Run test to verify it fails**

  Run: `npx vitest run tests/platformReleaseWorkflow.test.ts`

  Expected: FAIL because the workflow still treats any tag ref as production, independent of event/input.

- [x] **Step 3: Write minimal implementation**

  Replace every signed-capable job condition with `SIGNED_RUN` and every release mutation job condition with `PRODUCTION_TAG_PUSH`; do not change dependencies or steps.

- [x] **Step 4: Run test to verify it passes**

  Run: `npx vitest run tests/platformReleaseWorkflow.test.ts`

  Expected: PASS.

### Task 2: Protected signing and publish environments

**Files:**
- Modify: `tests/platformReleaseWorkflow.test.ts`
- Modify: `tests/platformReleaseConfig.test.ts`
- Modify: `.github/workflows/build.yml`
- Modify: `docs/platform-release-signing.md`

**Interfaces:**
- Consumes: environment-scoped GitHub secrets.
- Produces: `platform-release-signing` on signing-secret jobs and `platform-release-publish` on release-token jobs.

- [x] **Step 1: Write the failing test**

  Assert the exact environment mapping:

  ```ts
  const protectedJobs = {
    'package-mac': 'platform-release-signing',
    'package-win': 'platform-release-signing',
    'smoke-win': 'platform-release-signing',
    'release-preflight': 'platform-release-publish',
    'release-mac': 'platform-release-publish',
    'release-win': 'platform-release-publish',
    'publish-release': 'platform-release-publish',
  }
  ```

  Assert that every job containing a `secrets.*` reference is in this mapping. Assert the operator guide names both environments, their secret ownership, required review, the signing `master`/`v*` policy, and the publish `v*`-only policy.

- [x] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run tests/platformReleaseWorkflow.test.ts tests/platformReleaseConfig.test.ts`

  Expected: FAIL because all secret-consuming jobs currently omit `environment` and the guide does not name the split policies.

- [x] **Step 3: Write minimal implementation**

  Add the exact environment name to each mapped job. Update the guide so signing secrets live only in `platform-release-signing`, `RELEASE_TOKEN` lives only in `platform-release-publish`, and repository owners configure required reviewers/no self-review plus the documented branch/tag restrictions.

- [x] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run tests/platformReleaseWorkflow.test.ts tests/platformReleaseConfig.test.ts`

  Expected: PASS.

### Task 3: Full Windows Subject DN verification

**Files:**
- Modify: `tests/platformReleaseVerification.test.ts`
- Modify: `tests/platformReleaseCli.test.ts`
- Modify: `tests/platformReleaseConfig.test.ts`
- Modify: `tests/installedReleaseSmoke.test.ts`
- Modify: `scripts/platform-release-verification.mjs`
- Modify: `scripts/windows-installed-release-smoke.ps1`
- Modify: `docs/platform-release-signing.md`

**Interfaces:**
- Consumes: PowerShell `SignerCertificate.Subject` and `WIN_EXPECTED_PUBLISHER` full DN.
- Produces: `normalizePublisherSubject(value)` and exact canonical DN comparison for executables and updater metadata.

- [x] **Step 1: Write the failing tests**

  Use a fixture such as `CN=HB-code-glitch, O=Expected Publisher, C=KR`. Require the credential gate to reject bare `HB-code-glitch`; require equivalent attribute ordering to match; require `CN=HB-code-glitch, O=Different Publisher, C=KR` to fail. Assert the native PowerShell adapter returns the full Subject and the release config passes the same full DN to `signtoolOptions.publisherName`.

- [x] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run tests/platformReleaseVerification.test.ts tests/platformReleaseCli.test.ts tests/platformReleaseConfig.test.ts`

  Expected: FAIL because the inspector returns `SimpleName`, bare CN credentials pass, and comparisons are raw-string based.

- [x] **Step 3: Write minimal implementation**

  Return `$signature.SignerCertificate.Subject` from both PowerShell inspection paths. Parse DN attributes with quote/backslash handling, canonicalize attribute keys and order while preserving every attribute, and compare canonical full DNs for all four executables, installed smoke, and `app-update.yml`. Fail the credential-only gate when the expected publisher is not a parseable DN containing `CN`.

- [x] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run tests/platformReleaseVerification.test.ts tests/platformReleaseCli.test.ts tests/platformReleaseConfig.test.ts`

  Expected: PASS.

### Task 4: Release verification and selective commit

**Files:**
- Verify: all platform-owned files above plus release workflow/config/scripts/tests.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: a single selective platform hardening commit after `f1d4ab9`.

- [x] **Step 1: Run focused and structural verification**

  Run the 13-file platform/release suite, both TypeScript typechecks, `npm run build`, electron-builder 26 schema validation, Node/PowerShell/plist syntax checks, and `git diff --check`.

- [x] **Step 2: Inspect scope**

  Confirm `git diff --name-only f1d4ab9 --` contains only platform-owned files from this plan; leave all unrelated dirty files unstaged.

- [x] **Step 3: Selectively commit**

  Stage only the platform-owned files and commit with a release-hardening message. Record the SHA and verification counts for independent re-review.
