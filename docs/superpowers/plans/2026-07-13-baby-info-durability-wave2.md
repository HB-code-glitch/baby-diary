# Baby Info Durability Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all five wave-2 review findings without losing a baby-info mutation, projecting one family's pair into another, restoring mixed snapshots, or blocking lifecycle control on network work.

**Architecture:** Keep the main process authoritative. Family changes become explicit projection transitions over the sidecar journal; backups become verified settings/journal/event snapshot sets; bridge creation resolves the exact marker mutation; the journal owns an ordered pending index and constant-time summaries; renderer sync network work runs detached behind generation guards. Restore uses a durable intent and idempotent pair replacement before `SettingsStore` exposes any state.

**Tech Stack:** TypeScript, Electron main/renderer IPC, Node `fs`/`crypto`, Firebase, Vitest.

## Global Constraints

- Follow strict RED -> GREEN -> REFACTOR for every finding.
- Preserve all existing 1,036 passing tests and the seven emulator-only skips.
- Do not modify or stage `firestore.rules`, `shared/eventDataValidator.ts`, `shared/inviteCode.ts`, `tests/eventDataValidator.test.ts`, `tests/firestoreRulesEmulator.test.ts`, or `tests/inviteCodeSecurity.test.ts`.
- A backup is publishable only after every staged file and the manifest are fsynced and the whole set validates.
- Lifecycle continuations must check the captured generation after every await.

---

### Task 1: Family projection transitions

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/babyInfoSettingsCommit.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Modify: `electron/store/settings.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `src/sync/syncEngine.ts`
- Test: `tests/babyInfoSettingsJournal.test.ts`

**Interfaces:**
- Produces: a dedicated `family-transition` baby-info commit for `create` and `join`.
- Produces: generic `save`/`merge` family changes that project only the destination journal winner, or a blank pair if none exists.
- Invariant: legacy bootstrap is allowed only when settings have no journal metadata and the physical journal has no records/import marker.

- [ ] Add failing A -> B -> restart, A -> B -> A, A -> empty/B, winner-present/absent, legacy-first-migration, create-adopts/join-does-not-adopt, and journal-before-settings-failure tests.
- [ ] Run `npx vitest run tests/babyInfoSettingsJournal.test.ts` and confirm failures are caused by cross-family bootstrap/absent transition API.
- [ ] Add strict transition parsing, journal-state detection, and a single settings projection write; append the create-adopt mutation before the projection write.
- [ ] Route create/join through the dedicated commit and keep generic reconcile transitions non-adopting.
- [ ] Re-run the focused test until green.

### Task 2: Verified backups and crash-resumable pair restore

**Files:**
- Create: `electron/store/backupSnapshot.ts`
- Modify: `electron/store/backup.ts`
- Modify: `electron/store/settings.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Test: `tests/backupManager.test.ts`
- Test: `tests/backupOutcomeIntegrity.test.ts`
- Create: `tests/backupPairRecovery.test.ts`

**Interfaces:**
- Produces: deterministic manifest version 1 containing snapshot timestamp/source plus sorted relative path, byte size, and SHA-256 entries.
- Produces: `verifyBackupSnapshot(snapshotDir)` with an allowlisted path schema and strict settings/journal replay/projection validation.
- Produces: `recoverSettingsAndJournalPair(userDataPath)` which resumes an existing durable intent before validating live state, and restores the newest fully verified pair.

- [ ] Add failing tests for both destinations, missing/tampered manifest/files, middle/final journal damage, family/winner mismatch, legacy snapshots, invalid-newest/valid-older fallback, exact history/pending/ack recovery, and each settings/journal replacement crash boundary.
- [ ] Run the three focused backup test files and confirm the expected manifest/recovery failures.
- [ ] Implement staged copy order `settings.json`, `baby-info-journal-v1.jsonl`, sorted `data/*.jsonl`, then manifest; fsync files/directories and verify before rename.
- [ ] Implement durable corrupt copies, transaction staging plus intent, idempotent settings/journal replacement, post-restore validation, and structured fail-closed recovery errors.
- [ ] Re-run focused backup and settings tests until green.

### Task 3: Marker-key bridge and scalable pending cursor

**Files:**
- Modify: `shared/babyInfoResolver.ts`
- Modify: `shared/types.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Modify: `electron/store/settings.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/sync/babyInfoSync.ts`
- Test: `tests/babyInfoResolver.test.ts`
- Test: `tests/babyInfoJournal.test.ts`
- Test: `tests/babyInfoSync.test.ts`

**Interfaces:**
- Produces: bounded exact mutation lookup by `(familyId, mutationKey)`.
- Produces: bridge identity derived from the family marker key/payload and legacy pair, never from the overall winner.
- Produces: per-family mutation/pending counts, winner, and ordered pending tree with successor cursor.

- [ ] Add failing W1 marker / L pair / concurrent W2 tests for both orders, restart/retry idempotence, and missing-marker behavior.
- [ ] Add a failing 10,025-mutation ordered drain test that detects whole-family `Set` iteration, verifies bounded pages, restart parity, no duplicates, and no misses.
- [ ] Run the resolver/journal/sync focused tests and confirm current winner-only bridge plus filter/sort implementation fail.
- [ ] Implement exact marker lookup, deterministic bridge creation, constant-time summary counters, and logarithmic ordered-set insert/delete/successor traversal.
- [ ] Advance the uploader cursor after every processed page while bounding the run to its initial pending count; leave failed and newly smaller keys for the next cycle.
- [ ] Re-run the three focused files until green.

### Task 4: Lifecycle liveness

**Files:**
- Modify: `src/sync/syncEngine.ts`
- Test: `tests/restartSync.test.ts`
- Test: `tests/syncEngine.test.ts`

**Interfaces:**
- Produces: synchronous generation invalidation and listener/timer detachment for stop/logout/restart.
- Produces: detached, rejection-observed network tasks whose continuations retain existing generation/context assertions.

- [ ] Add failing tests that keep `getDoc`, `setDoc`, initial reconcile/snapshot, sign-out, and teardown promises unresolved while asserting stop/logout/restart settle by deterministic microtask turns.
- [ ] Run focused lifecycle tests and confirm they time out because network work owns `_lifecycleTail`.
- [ ] Remove unbounded network awaits from the serialized control tail; publish stop/logout state synchronously and launch teardown/sign-out/reconcile as guarded background work.
- [ ] Verify stale callbacks cannot write, only the latest listener survives, and detached rejections are observed.
- [ ] Re-run focused lifecycle tests until green.

### Task 5: Verification and selective commit

**Files:**
- Review every changed file and the six protected security-owner paths.

- [ ] Run all focused wave-2 and wave-1 baby-info/backup/lifecycle tests.
- [ ] Run `npm test` and confirm all non-emulator tests pass with only the seven expected skips.
- [ ] Run `npm run typecheck`, `npx tsc -p tsconfig.node.json --noEmit`, and `npm run build`.
- [ ] Run `git diff --check`, inspect `git diff --stat`, and audit every review requirement against the final diff.
- [ ] Stage only wave-2-owned files, verify the protected paths remain unstaged, and create one selective commit.
