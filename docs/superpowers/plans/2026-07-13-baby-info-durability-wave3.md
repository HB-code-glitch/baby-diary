# Baby Info Durability Wave 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:systematic-debugging task-by-task. Every production change follows an observed RED.

**Goal:** Close the independent Wave 3 Critical 1 and Important 7 findings without touching platform-release or security-owner work.

**Architecture:** Keep familyless legacy data in an append-only unlinked archive that is never a cloud mutation. Verify backups through bounded one-handle buffers and drive restore through a staged transaction whose platform-specific cleanup state survives crashes. Decouple sync lifecycle leases from network promises and derive Firebase persistence identity deterministically from canonical configuration.

**Tech Stack:** TypeScript, Electron, React, Firebase Web SDK 12, synchronous durable filesystem primitives, Vitest/jsdom.

## Global Constraints

- Preserve HEAD `f1d4ab9` and never stage or commit `firestore.rules`, `shared/eventDataValidator.ts`, `shared/inviteCode.ts`, `tests/eventDataValidator.test.ts`, `tests/firestoreRulesEmulator.test.ts`, or `tests/inviteCodeSecurity.test.ts`.
- No production code for a finding before its production-path regression test has failed for the expected reason.
- Recovery is fail-closed: no primary overwrite before durable forensic preservation and no unverified path re-read.
- Windows must retain a verified committed staging copy across a later successful startup; POSIX must fsync parent directories.
- Full completion requires focused suites, full Vitest, renderer/node typechecks, production build, and diff-check.

---

### Task 1: Unlinked legacy archive and explicit apply/save

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/babyInfoSettingsCommit.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Modify: `electron/store/settings.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Test: `tests/babyInfoSettingsJournal.test.ts`
- Test: `tests/babyInfoJournal.test.ts`
- Test: `tests/settingsBabyInfoSave.test.tsx`

**Interfaces:**
- Produce `BabyInfoUnlinkedArchive`, `BabyInfoJournal.listUnlinkedArchives()`, and bounded IPC `babyInfo:listUnlinkedArchives`.
- Archive application only copies values into dirty renderer fields; existing `user-edit` Save is the sole cloud-pending transition.

- [ ] Add tests for upgrade/restart/create/join, blank pairs, dedup, archive backup replay, and apply-without-save followed by explicit Save; run them and record expected failures.
- [ ] Add a deterministic archive identity and strict append-only journal record parser/index.
- [ ] Archive a nonblank unscoped pair durably before blanking projection; remove all create/join adoption.
- [ ] Expose bounded archive read IPC and bilingual conditional review/apply UI.
- [ ] Run the three focused suites and keep all prior family-isolation tests green.

### Task 2: One-handle/one-buffer snapshot protocol

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Modify: `electron/store/babyInfoJournal.ts`
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/backupManager.test.ts`

**Interfaces:**
- Produce `readVerifiedRegularFileBuffer()` with traversal/type/identity/size checks and no-follow flags where supported.
- Produce `parseBabyInfoJournalBuffer()` so strict replay and projection validation consume the manifest-verified bytes.

- [ ] Add swap/rewrite/symlink and exact-published-buffer tests; run and record RED.
- [ ] Open each allowlisted file once, compare lstat/fstat identity, bound size, and read exactly once into an immutable Buffer.
- [ ] Use those buffers for hashes, JSON parse, journal replay, projection validation, and restore writes.
- [ ] Run focused backup and journal suites.

### Task 3: Forensic preservation precondition

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Modify: `electron/main.ts`
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/electronSecurity.test.ts`

**Interfaces:**
- Extend `SettingsRecoveryError` with truthful `originalsPreserved` evidence.
- A committed forensic manifest records timestamp, size, and SHA-256 for every existing primary.

- [ ] Add injected copy/write/fsync/rename failure tests for each original and a truthful main-process message test; record RED.
- [ ] Commit forensic buffers and manifest durably before preparing restore; abort on any failure with primaries byte-identical.
- [ ] Select startup copy based on structured preservation evidence.
- [ ] Run focused recovery and Electron startup suites.

### Task 4: Cross-platform crash recovery state machine

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Modify: `electron/store/durableFs.ts` only if a general durable unlink/rename primitive is required
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/durableFs.test.ts`

**Interfaces:**
- Staging contains its own verified transaction descriptor; outer intent is a discovery/commit marker.
- Transaction phases are prepared, primary-verified, and cleanup-eligible with platform-specific startup counters.

- [ ] Add every-boundary, lost-intent, missing-staging, mixed-primary, two-restart, Windows, and POSIX fsync tests; record RED.
- [ ] Scan intent and orphan staging before live-pair acceptance and resume from exact staged buffers.
- [ ] Revalidate both primaries before committing/removing intent; never remove staging first.
- [ ] POSIX fsyncs each parent metadata transition; Windows retains verified staging through the required later startup.
- [ ] Run focused recovery/durable filesystem suites.

### Task 5: Verified cross-root selection and retention

**Files:**
- Modify: `electron/store/backupSnapshot.ts`
- Modify: `electron/store/backup.ts`
- Modify: `electron/store/settings.ts`
- Modify: `electron/main.ts`
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/backupRetention.test.ts`
- Test: `tests/backupManager.test.ts`

**Interfaces:**
- Recovery consumes configured userData and Documents roots and sorts verified candidates by manifest timestamp then normalized destination/path.
- Retention consumes only verified snapshot descriptors; invalid entries cannot occupy a monthly keep slot.

- [ ] Add renamed-folder, invalid-newest, Documents-only, cross-root tie, forged future timestamp, and corrupt-retention tests; record RED.
- [ ] Enumerate and verify all roots before selecting one immutable candidate.
- [ ] Accept legacy timestamps only from strict canonical folder names and truly legacy settings.
- [ ] Apply verified retention independently to both successfully written roots while explicitly ignoring/reporting invalid entries.
- [ ] Run focused backup selection/manager/retention suites.

### Task 6: Near-linear journal mutation and partial-prefix recovery

**Files:**
- Modify: `electron/store/babyInfoJournal.ts`
- Test: `tests/babyInfoJournal.test.ts`

**Interfaces:**
- Existing immutable map is read-only during ingest; a page-local overlay tracks new records.
- Append failure reloads the exact durable complete-record prefix and repairs only a torn suffix.

- [ ] Instrument 10,025 mutations and 500-item ACK pages to expose whole-map iteration; add partial-append prefix test and record RED.
- [ ] Replace full map cloning with overlay lookup and direct indexed apply.
- [ ] On append failure reset/replay from disk so memory equals the durable prefix.
- [ ] Assert visit bounds, exact cursor behavior, no duplicates, and no misses.

### Task 7: Truthful nonblocking lifecycle leases

**Files:**
- Modify: `src/sync/syncEngine.ts`
- Test: `tests/restartSync.test.ts`
- Test: `tests/syncAuthPersistence.test.ts`

**Interfaces:**
- Local lifecycle state includes detached, signing-out, signed-out, superseded, and incomplete error outcomes.
- Sign-out returns success only after active-lease Firebase Auth success; generation replacement rejects with `SIGN_OUT_SUPERSEDED`.

- [ ] Add held init/auth/signOut/teardown tests with fake time and unhandled-rejection tracking; record RED.
- [ ] Remove network/auth promises from the serialized local lifecycle lane; generation-owned detached tasks publish only when current.
- [ ] Detach listeners/timers synchronously for stop/restart/sign-out and start the newest lease without waiting for old work.
- [ ] Race sign-out against injected deadline and generation supersession, reporting truthful state.
- [ ] Run lifecycle/auth focused suites.

### Task 8: Stable Firebase persistence identity

**Files:**
- Modify: `src/sync/firebase.ts`
- Test: `tests/firebaseAuthPersistence.test.ts`
- Test: `tests/firebaseEmulatorConnection.test.ts`
- Create or modify: `tests/firebaseStableIdentity.test.ts`

**Interfaces:**
- Produce canonical config JSON and deterministic `baby-diary-<hash>` app name with collision detection.
- Ownership tokens remain leases only; same-config services are reused and stop does not delete persistent services.

- [ ] Add module-reset, same-config restart, A→B→A, delayed teardown, installed-SDK Auth/Firestore key, and app-count tests; record RED.
- [ ] Replace random/session/generation names with deterministic config identity.
- [ ] Reuse existing Firebase app/Auth/Firestore services, connecting emulators only once per stable app.
- [ ] Separate active lease invalidation from service destruction and prevent stale initialization publication.
- [ ] Run auth persistence/emulator/stable identity suites.

### Task 9: Integrated verification and selective commit

**Files:**
- Modify only Wave 3 plan/production/test files listed above.

- [ ] Run all baby-info, backup, settings, lifecycle, and auth persistence Vitest suites.
- [ ] Run full `npm test -- --reporter=dot` and record exact files/tests/skips.
- [ ] Run `npm run typecheck`, `npm run typecheck:node`, and `npm run build` (or exact package-script equivalents).
- [ ] Run `git diff --check` on owned paths and inspect added lines for debug/focus/secret/path artifacts.
- [ ] Stage explicit owned files only; assert the six security-owner paths are absent from the index.
- [ ] Commit once, inspect commit contents, and report SHA plus exact RED→GREEN evidence and all eight contracts.
