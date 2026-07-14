# Baby Info Durability Wave 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: Use superpowers:test-driven-development and superpowers:systematic-debugging task-by-task. Every production change follows an observed production-path RED. Use superpowers:verification-before-completion before claiming success.

**Goal:** Close Wave 4 Important 1–7 and Minor 1 with truthful crash recovery, bounded backup/archive behavior, and exact Firebase lifecycle ownership while preserving all security-owner work.

**Architecture:** Upgrade restore to an allocation-first, crash-resumable transaction and separate Windows forensic confirmation from POSIX durability. Make journal append failure transactional or explicitly uncertain. Bound and stream snapshot discovery/data. Page archives through a deterministic ordered index. Track pending Firebase initialization as a lifecycle lease and retain services in an epoch-checked registry that performs real termination/deletion.

**Tech Stack:** TypeScript, Electron, React, Firebase Web SDK 12, synchronous durable filesystem primitives, Vitest/jsdom.

## Global Constraints

- Preserve base `cee694dc7e831f0a2972a8306df52cc4c7732b7e` and all concurrent security/release changes.
- Never modify, stage, or commit security-owned `.github/workflows/build.yml`, `package.json`, `package-lock.json`, `firestore.rules`, `shared/types.ts`, `shared/babyInfoResolver.ts`, `shared/eventResolver.ts`, security payload/invite files, or their tests/scripts.
- Define archive paging in new `shared/babyInfoArchivePaging.ts`; do not extend `shared/types.ts`.
- Record an expected RED for each finding before editing its production path.
- Recovery never overwrites a primary until its platform-specific preconditions are independently verified.
- Completion requires focused and full Vitest, renderer/node typechecks, production build, owned diff inspection, and an explicit-path commit.

---

### Task 1: Allocation-first restore transaction and orphan convergence

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Test: `tests/backupPairRecovery.test.ts`

**Contract:** Allocation metadata precedes staged pair writes. An exact surviving intent may reconstruct missing staging metadata; a metadata-free no-intent directory is never truth and converges through safe quarantine/GC.

- [ ] Add crash injection tests after mkdir and after every pair/metadata/intent boundary, including Windows entry reordering; run and record RED.
- [ ] Add missing-metadata tests with and without exact intent, repeated startups, readable live pair, and verified-backup fallback; run and record RED.
- [ ] Persist allocation marker before pair writes, verify exact immutable buffers, then publish prepared metadata and intent in order.
- [ ] Resume only exact descriptor matches and safely discard/quarantine uncommitted orphans without startup loops.
- [ ] Run focused recovery tests.

### Task 2: Truthful platform-specific forensic preservation

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Modify: `electron/main.ts`
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/electronSecurity.test.ts`

**Contract:** POSIX proceeds only after file and every parent-directory fsync. Windows first commits a forensic archive/prepared transaction, writes no primary, and requires two later independent successful verifications before restore.

- [ ] Add first-Windows-start, two later confirmations, crash, missing/corrupt forensic, and zero-primary-write tests; record RED.
- [ ] Add POSIX immediate-restore and startup-copy evidence tests; record RED.
- [ ] Persist explicit phase/counter and return structured `restartRequired`/`originalsPreserved` evidence without equating reread with durability.
- [ ] Verify both staged and forensic bytes on every confirming startup and fail closed on divergence.
- [ ] Render truthful bilingual startup copy, including local archive evidence when local mutation already occurred.

### Task 3: Transactional journal append or storage-uncertain state

**Files:**
- Modify: `electron/store/durableFs.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Test: `tests/durableFs.test.ts`
- Test: `tests/babyInfoJournal.test.ts`

**Contract:** Capture pre-append length on the same handle. A failed append rolls back and fsyncs that prefix before normal failure; an unconfirmed rollback makes the current journal read-only/uncertain and never ingests the suffix.

- [ ] Add short-write boundary, full-write-plus-fsync-failure, rollback-fsync-failure, ACK-page, archive-append, restart, pending/summary/cloud-drain tests; record RED.
- [ ] Implement one-handle prelength/write/fsync/rollback and a structured uncertain error.
- [ ] Keep memory on the last confirmed prefix; reject later mutations/cloud work in the uncertain process.
- [ ] Allow a fresh process to validate/repair a physically complete suffix during normal replay.
- [ ] Run focused durable filesystem and journal tests.

### Task 4: Bounded streaming backup aggregation

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Modify: `electron/store/backup.ts` if option plumbing is required
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/backupManager.test.ts`
- Test: `tests/backupRetention.test.ts`

**Contract:** Enforce file/candidate/aggregate-byte limits with overflow-safe accounting. Retain immutable settings/journal buffers only; stream each event file once from a verified no-follow handle into its staged handle and verify/discard sequentially.

- [ ] Add maximum-file, excessive-entry/candidate, aggregate-overflow, peak-retained-buffer, ordering/tie, and cleanup-rejection tests; record RED.
- [ ] Add production limits with injectable lower test bounds and safe integer addition.
- [ ] Replace event-data maps with chunked one-source/one-destination streaming plus hash/fsync/identity checks.
- [ ] Select only the current best verified pair and keep descriptor-only retention state.
- [ ] Run focused backup/recovery/retention tests.

### Task 5: Strict cursor-paged archive IPC and UI

**Files:**
- Create: `shared/babyInfoArchivePaging.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Modify: `electron/store/settings.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Test: `tests/babyInfoArchivePaging.test.ts`
- Test: `tests/babyInfoJournal.test.ts`
- Test: `tests/babyInfoSettingsJournal.test.ts`
- Test: `tests/settingsBabyInfoSave.test.tsx`

**Contract:** Require a non-empty bounded limit (hard max 50) and opaque deterministic cursor. Journal pages an ordered index without full clone/sort. Renderer loads a small first page and progressive pages without creating cloud mutations.

- [ ] Add 10,025-entry no-gap/no-duplicate paging, invalid request/cursor, replay/restart, and zero-pending tests; record RED.
- [ ] Add strict shared request/response validators without touching `shared/types.ts`.
- [ ] Maintain a composite ordered archive index and implement bounded `limit + 1` page reads.
- [ ] Validate at main/preload/renderer boundaries and remove the full-list path.
- [ ] Add initial DOM bound, load-more/loading/error/focus, identity-reset, KO/JA, apply-without-save, and explicit-save tests; record RED then implement.

### Task 6: Pending-init-aware exactly-once sign-out

**Files:**
- Modify: `src/sync/syncEngine.ts`
- Test: `tests/restartSync.test.ts`
- Test: `tests/syncAuthPersistence.test.ts`

**Contract:** A held configure initialization is a real local lease. Sign-out awaits its resulting Auth and invokes Firebase sign-out exactly once, or returns truthful timeout/rejection/supersession; only genuinely unconfigured state is a no-op.

- [ ] Add held-init resolve/reject/never, no-config no-op, supersession, persisted-user non-resurrection, listener-count, and unhandled-rejection tests; record RED.
- [ ] Track pending initialization independently of the serialized lifecycle lane and generation publication.
- [ ] Make sign-out claim that pending lease, await it under existing timeout/supersession rules, and call remote sign-out once.
- [ ] Preserve configured/signed-out state and ensure only the newest restart owns listeners.
- [ ] Run focused restart/auth tests.

### Task 7: Lease-aware Firebase service retirement

**Files:**
- Modify: `src/sync/firebase.ts`
- Test: `tests/firebaseAuthPersistence.test.ts`
- Test: `tests/firebaseEmulatorConnection.test.ts`
- Test: `tests/firebaseStableIdentity.test.ts`

**Contract:** Stable config keys reuse active services. Config release eventually terminates Firestore and deletes its inactive Firebase app, guarded by an epoch check immediately before each destructive SDK call; cleanup failure is visible and retryable.

- [ ] Add installed-SDK getApps/module-reset, A→B→A, many-config, delayed-delete/reactivation, cleanup-failure/retry, emulator-once, and stable-key tests; record RED.
- [ ] Replace singleton ownership with a config-keyed registry and explicit active leases/inflight initialization.
- [ ] Schedule real `terminate` then `deleteApp`, checking lease/epoch immediately before each; cancel stale cleanup on reactivation.
- [ ] Surface failed cleanup and retain bounded retryable state without returning terminated services.
- [ ] Run focused Firebase identity/emulator/persistence tests.

### Task 8: Truthful startup copy after partial local mutation

**Files:**
- Modify: `electron/store/settings.ts` or structured error producer as required
- Modify: `electron/main.ts`
- Test: `tests/babyInfoSettingsJournal.test.ts`
- Test: `tests/electronSecurity.test.ts`

**Contract:** If an archive append succeeded before settings projection failed, the outcome reports `localDataModified` and durable archive evidence. Startup copy never claims no local change; next startup deduplicates/reconciles it.

- [ ] Add archive-success/projection-failure ordering, copy, and next-start dedup/recovery tests; record RED.
- [ ] Attach structured archive identity and local-modification evidence to the failure path.
- [ ] Select truthful KO/JA copy from that evidence.
- [ ] Run focused settings/startup suites.

### Task 9: Integrated verification and selective commit

**Files:**
- Modify only Wave 4 owned files listed above plus this plan.

- [ ] Record the RED command/reason and GREEN command for all eight findings.
- [ ] Run all baby-info, recovery, backup, settings, lifecycle, and Firebase focused suites.
- [ ] Run full `npm test -- --reporter=dot` and record exact files/tests/skips.
- [ ] Run `npm run typecheck`, `npm run typecheck:node`, and `npm run build`.
- [ ] Run `git diff --check` on owned paths and inspect added lines for debug/focus/secret/path artifacts.
- [ ] Confirm every security/release dirty path is absent from the index, stage explicit owned files only, and commit once.
- [ ] Inspect commit contents and report SHA, Windows/POSIX state transitions, caps/complexity, rollback semantics, sign-out ownership, cleanup semantics, and exact verification evidence.
