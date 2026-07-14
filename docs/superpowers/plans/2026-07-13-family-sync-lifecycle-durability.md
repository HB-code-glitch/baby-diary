# Family Sync Lifecycle Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아기 이름·생일의 오프라인 변경 의도를 영속 보존하고 양 기기에서 결정적으로 수렴시키며, 동기화 재시작·권한 오류·초기 이벤트 수신 경쟁에서 데이터나 가족 정체성이 유실되지 않게 한다.

**Architecture:** 이름과 생일을 하나의 immutable `BabyInfoMutation`으로 저장하고, 기존 `settings.json`의 optional 동기화 상태에 전체 로컬 mutation 로그와 exact pending key를 원자적으로 보존한다. 클라우드는 `families/{familyId}/babyInfoMutations/{contentBoundMutationId}` create-only 문서로 동시 변경을 제한 없이 물리 보존하고, 공용 resolver가 projection만 결정한다. 동기화 수명주기는 단일 async transition queue와 generation token으로 직렬화하고, Zustand 초기화는 broadcast 선구독 버퍼를 initial snapshot과 resolver-merge한다.

**Tech Stack:** TypeScript, React, Zustand, Electron IPC, Firebase Auth/Firestore, Vitest.

## Global Constraints

- 작업 위치는 `D:\BABY DIARY MAC.health-worktrees\evidence-guidance-v3`이다.
- `.github/workflows/build.yml`, `package.json`, runner 소유 `electron/main.ts`·`electron/syncE2EGuard.ts`, `scripts/sync-e2e.mjs`, `tests/releaseWorkflow.test.ts`, 모든 runner 소유 `tests/syncE2E*.test.ts`, `firestore.rules`는 읽기만 허용하며 수정·stage하지 않는다.
- 모든 production 변경은 실제 함수 기반 failing test를 먼저 실행해 요구된 이유로 RED를 확인한 뒤 구현한다. 복제 helper 테스트는 금지한다.
- babyName과 babyBirthdate는 한 mutation으로 저장하며 빈 문자열도 의도된 값이다.
- 오프라인·초기화 중 저장은 로컬 durable mutation 저장 성공 후에만 성공으로 표시한다.
- mutation 원본은 동일 시각·동일 logical clock 충돌을 포함해 모두 물리 보존하고, 모든 장치가 동일 total order로 projection을 선택한다.
- exact cloud mutation과 canonical payload가 확인되기 전 pending을 제거하지 않는다.
- `babyInfoSync`가 없는 legacy 상태만 정상 마이그레이션한다. 명시적으로 존재하지만 malformed인 mutation/pending 상태는 fail-closed하며 원본을 덮거나 성공으로 표시하지 않는다.
- legacy family doc과 `babyInfoSync`가 없는 기존 `AppSettings`를 마이그레이션하며 기존 로컬 non-empty 값을 cloud로 무조건 덮지 않는다.
- 일시적인 auth/rules/network `permission-denied`에서는 local familyId와 `users/{uid}.familyId`를 지우지 않는다. `users` 문서를 자동으로 비우는 쓰기는 금지한다.
- 명시적 family document not-found 또는 읽기 성공 후 membership 누락만 confirmed gone으로 분류한다.
- stop/restart는 teardown 완료를 await하고, 중복 호출은 idempotent하며 모든 늦은 auth/snapshot/retry callback은 generation mismatch 시 무시한다.
- initial event broadcast는 subscribe와 list 사이 어느 interleaving에서도 손실·중복 없이 수렴하고 재-init/HMR 시 listener가 누적되지 않는다.

---

### Task 1: Durable Baby Info Mutation Log and Settings UX

**Files:**
- Create: `shared/babyInfoResolver.ts`
- Create: `src/sync/babyInfoSync.ts` when needed to keep persistence/cloud reconciliation separate from lifecycle orchestration
- Modify: `shared/types.ts`
- Modify: `src/sync/syncEngine.ts`
- Modify: `src/sync/useSync.ts`
- Modify: `src/store/useAppStore.ts`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`
- Test: `tests/babyInfoResolver.test.ts`
- Test: `tests/babyInfoSync.test.ts`
- Test: `tests/settingsBabyInfoSave.test.tsx`
- Test: `tests/settings.test.ts`

**Interfaces:**
- `BabyInfoMutation`: `{ mutationId, familyId, babyName, babyBirthdate, logicalClock, updatedAt, authorId, origin }`, where `origin` is `user | legacy-local | legacy-cloud`.
- `BabyInfoSyncState`: `{ version: 1, mutations: BabyInfoMutation[], pendingMutationKeys: string[] }` and optional `AppSettings.babyInfoSync`.
- `getBabyInfoMutationKey(mutation)` returns a content-bound immutable key; same UUID with different payload must remain distinct.
- `compareBabyInfoMutations` is a total order: safe logical clock, explicit-zone timestamp, legacy origin rank, immutable key, canonical payload.
- `normalizeBabyInfoSyncState`, `resolveLatestBabyInfoMutation`, and deterministic legacy-local/legacy-cloud projectors are the only resolution primitives.
- `persistSettingsWithBabyInfoMutation(nextSettings)` performs one `ipc.saveSettings` containing both the exact baby pair and queued mutation, returns `{ settings, babyInfo: 'local-only' | 'pending' }`, and never reports success when persistence throws. SettingsPage's explicit baby dirty-save path alone calls it; generic `saveSettings` used by theme/language/create/join remains mutation-free so cloud adoption is never mistaken for a user edit.
- `updateFamilyBabyInfo(name, birthdate)` remains exported for compatibility but routes through the same durable persistence path and never silently returns because Firebase is unready.
- Firestore `families/{familyId}/babyInfoMutations/{docId}` is immutable and create-only; `docId` binds mutation UUID and canonical content. Pending removal requires a fresh/read snapshot containing the exact document identity and canonical payload.
- `SyncState.pendingCount` includes event and baby-info pending counts.

- [ ] **Step 1: Write resolver RED tests** for invalid shapes, exact duplicate dedup, reused UUID with distinct payload preservation, older/newer logical clock, same timestamp deterministic tie, blank values, and deterministic legacy projection.
- [ ] **Step 2: Run** `npx vitest run tests/babyInfoResolver.test.ts` and confirm failures are missing imports/functions.
- [ ] **Step 3: Implement shared types and resolver**, then rerun the same command to GREEN.
- [ ] **Step 4: Write actual sync RED tests** using the real exported engine functions for offline save→restart/reconnect, cloud older/newer, same timestamp tie, write failure/retry, exact ack, crash persistence by module reload, two-device order independence, and legacy family/settings migration.
- [ ] **Step 5: Run** `npx vitest run tests/babyInfoSync.test.ts` and confirm each case fails on the current silent-return/sole-authority behavior.
- [ ] **Step 6: Implement atomic settings queuing and family mutation reconcile** with create-only immutable docs, exact read-back acknowledgement, local mutation log merge, family projection update, snapshot ingestion, and backoff retry. Do not edit `firestore.rules`; report the exact new collection contract for the separately owned rules patch.
- [ ] **Step 7: Write Settings UI RED tests** proving intentional empty fields queue one atomic mutation, local durable success shows pending copy while offline, and storage failure shows failure without a success toast.
- [ ] **Step 8: Run** `npx vitest run tests/settingsBabyInfoSave.test.tsx tests/settings.test.ts`, implement dirty-field handling and bilingual pending copy, then rerun to GREEN.
- [ ] **Step 9: Run task target suite** `npx vitest run tests/babyInfoResolver.test.ts tests/babyInfoSync.test.ts tests/settingsBabyInfoSave.test.tsx tests/settings.test.ts tests/mergeSettingsSafely.test.ts`.
- [ ] **Step 10: Selectively commit only Task 1 files** after self-review.

### Task 2: Serialized Lifecycle and Non-destructive Family Error Classification

**Files:**
- Modify: `src/sync/syncEngine.ts`
- Modify: `src/sync/useSync.ts`
- Modify: `src/components/SyncSettingsSlot.tsx` only if Promise API call sites require it
- Test: `tests/restartSync.test.ts`
- Test: `tests/familyIdentityReconciliation.test.ts`

**Interfaces:**
- `configure`, `start`, `stop`, and `restartSync` return `Promise<void>`; ignored Promises remain safe for old call sites, while awaited calls guarantee transition completion.
- A single lifecycle tail serializes internal teardown/configure/start operations.
- Every public stop/restart increments generation immediately; async auth, signed-in reconcile, both snapshots, retry timers, drains, and configure completion capture and validate it before mutating global state.
- Duplicate queued stop/restart calls collapse to the newest desired generation and do not install duplicate listeners.
- `DETAIL_FAMILY_ACCESS_UNCERTAIN` represents transient/unverifiable access and preserves local/cloud identity while scheduling retry.
- `_handleFamilyGone` is used only for explicit missing family or readable membership absence and never clears `users/{uid}.familyId`.

- [ ] **Step 1: Replace weak restart tests with delayed real-engine RED tests** that hold teardown/init/auth/snapshot promises, interleave stop and two restarts, and assert no overlap, latest-config ownership, stale callback suppression, and one listener.
- [ ] **Step 2: Run** `npx vitest run tests/restartSync.test.ts` and confirm current fire-and-forget teardown/generation behavior fails.
- [ ] **Step 3: Implement the serialized lifecycle and generation guards**, migrate callers to `void stop()` or `await` where appropriate, then rerun to GREEN.
- [ ] **Step 4: Write family error RED tests** for transient permission-denied, network/auth errors, explicit not-found, and readable member absence. Assert no `mergeSettings({ familyId: '' })` or `setDoc(users, { familyId: '' })` on uncertain access.
- [ ] **Step 5: Run** `npx vitest run tests/familyIdentityReconciliation.test.ts`, implement classification/status/retry, and rerun to GREEN.
- [ ] **Step 6: Run task target suite** `npx vitest run tests/restartSync.test.ts tests/familyIdentityReconciliation.test.ts tests/syncMutationIntegration.test.ts tests/syncAuthPersistence.test.ts`.
- [ ] **Step 7: Selectively commit only Task 2 files** after self-review.

### Task 3: Lossless Initial Event Subscription

**Files:**
- Modify: `src/store/useAppStore.ts`
- Test: `tests/storeEventInitialization.test.ts`

**Interfaces:**
- `init()` installs `ipc.onEventAppended` before beginning `listEvents`.
- Broadcasts received while the initial calls are pending are buffered and merged with the initial list through `mergeResolvedEvent` after all settled results are available.
- An init generation prevents an older init completion from overwriting a newer init.
- `disposeAppStoreEventBridge()` unsubscribes and invalidates callbacks; `import.meta.hot.dispose` calls it for HMR.
- Re-init first unsubscribes the previous listener; there is exactly one active listener.

- [ ] **Step 1: Write RED interleaving tests** with deferred `listEvents` for event-before-result, event-after-result-before-commit, duplicate in list+broadcast, concurrent init, and dispose/late callback.
- [ ] **Step 2: Run** `npx vitest run tests/storeEventInitialization.test.ts` and confirm the current post-load subscription loses broadcasts and accumulates listeners.
- [ ] **Step 3: Implement pre-subscription buffering, generation commit, and teardown**, then rerun the test to GREEN.
- [ ] **Step 4: Run task target suite** `npx vitest run tests/storeEventInitialization.test.ts tests/softDeleteAllEvents.test.ts tests/eventTime.test.ts`.
- [ ] **Step 5: Selectively commit only Task 3 files** after self-review.

### Task 4: Integration Verification and Read-only Review

**Files:**
- Test fixture additions only in the Task 1–3 test files above; forbidden runner/workflow/rules files remain untouched.

- [ ] **Step 1: Verify legacy userData fixture** by loading a settings JSON without `babyInfoSync`, saving/restarting, and confirming all existing fields plus migrated mutations survive.
- [ ] **Step 2: Run all targeted tests from Tasks 1–3 together** and record exact file/test counts.
- [ ] **Step 3: Wait until the externally owned runner RED is gone, then run** `npm run check`.
- [ ] **Step 4: Run** `npm run build` and confirm typecheck, node build, renderer bundle, and evidence-boundary checks all exit 0.
- [ ] **Step 5: Run** `git diff --check`, inspect `git status --short`, and verify forbidden files are neither staged nor included in this task's commits.
- [ ] **Step 6: Dispatch a fresh read-only reviewer** with the full task diff and requirements. Fix and re-review every Critical/Important finding until zero remain.
- [ ] **Step 7: Report commit SHA(s), RED→GREEN evidence, verification counts, migration format, exact pending-ack invariant, lifecycle contract, and stable APIs/hooks available to the packaged runner agent.
