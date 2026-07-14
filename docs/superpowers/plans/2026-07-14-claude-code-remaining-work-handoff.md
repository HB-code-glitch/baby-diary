# Baby Diary Claude Code Remaining Work Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미 완료된 UI·튜토리얼·다국어·건강 안내·기록 UX를 유지하면서, 남은 실데이터 복구, 계정/가족 무손실 동기화, 실제 v0.3.8→v0.3.9 업그레이드 증명, 서명 릴리즈, Windows 바탕화면 설치 파일 갱신을 안전하게 완료한다.

**Architecture:** 로컬 append-only 원본을 항상 권위 데이터로 두고, 클라우드에는 인증 사용자에 결속된 불변 파생본만 원자적으로 쓴다. 실제 설치 업그레이드는 폐기 가능한 OS 사용자/VM/CI에서만 수행하며, 사용자 프로필과 서명되지 않은 산출물은 릴리즈 그래프에 들어갈 수 없다. 각 작업은 RED→GREEN→독립 리뷰→작은 커밋 순으로 완료한다.

**Tech Stack:** Electron 43, React 18, TypeScript 5.5, Firebase 12.16, Firestore Rules/Emulator, Vitest, Playwright, electron-builder 26, GitHub Actions, PowerShell/Bash.

## Global Constraints

- 작업 위치는 `D:\BABY DIARY MAC.health-worktrees\evidence-guidance-v3`, 브랜치는 `codex/evidence-guidance-v3`다. 원본 `D:\BABY DIARY MAC` 작업 트리는 수정·reset·checkout하지 않는다.
- 시작 HEAD는 `51d5da3bcb41559b69bc0d9786ebc6b366c1a062`다. 이 브랜치는 `origin/master`보다 78개 커밋 앞서 있고 아직 push되지 않았다.
- Node는 `C:\Users\배한주\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` v24.14.0을 사용한다. npm CLI는 `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`를 이 Node로 실행하고, bundled Node bin을 `PATH` 선두에 둔다.
- 각 독립 PowerShell 작업은 먼저 `$node = 'C:\Users\배한주\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'`를 설정한다. 이전 shell의 변수가 남아 있다고 가정하지 않는다.
- Firestore Emulator 검증은 Java 21에서 실행한다. 로컬 Java 21이 없으면 GitHub Actions의 `actions/setup-java` Temurin 21 job을 권위 결과로 사용한다.
- 앱 버전은 `0.3.9`다. `appId=com.family.babydiary`, canonical user-data leaf `baby-diary`, NSIS 설치 identity를 바꾸지 않는다.
- 설치된 Baby Diary는 Task 1/2가 끝나기 전 실행하지 않는다. 실제 `C:\Users\배한주\AppData\Roaming\baby-diary`에는 승인 전 어떤 쓰기·복원·삭제도 하지 않는다.
- 실제 앱 smoke는 `APPDATA`/`HOME` 변경만으로 격리하지 않는다. `BABYDIARY_TEST_USERDATA` main-process attestation과 폐기 가능한 OS 사용자/VM/CI가 둘 다 필요하다.
- 실제 Auth token, email, uid, family id, Firebase request body를 로그·fixture·artifact에 저장하지 않는다. 비교 증거에는 run-bound SHA-256과 길이만 저장한다.
- 기존 로컬 EventLog/설정/저널 원본을 삭제하거나 새 strict schema로 다시 쓰지 않는다. 파싱 가능한 v0.3.8 원본은 계속 조회·내보내기·백업 가능해야 한다.
- Firestore production rules는 v0.3.9 서명 릴리즈와 실제 업그레이드 gate가 모두 green이 되기 전에 배포하지 않는다.
- unsigned Windows/Mac 산출물을 공식 릴리즈나 Desktop 최종 파일로 사용하지 않는다.
- 각 코드 작업은 TDD, 관련 전체 테스트, `git diff --check`, 독립 리뷰 Critical/Important/Minor `0/0/0`, 선택적 파일 stage를 요구한다.
- 완료된 디자인·가독성·애니메이션·keep logged in·한/일 튜토리얼/skip·건강 근거·History UX는 재설계하지 않는다. 회귀 테스트만 실행한다.

## Current Evidence and Completed Baseline

- Firebase persistence/recovery 최종 커밋: `51d5da3`.
  - registry 110/110, backup+IPC 265/265, Auth/security 50/50, TypeScript 2종, production build green.
  - 독립 리뷰 Critical 0 / Important 0 / Ready Yes.
- Backup recovery 최종 커밋: `1d87421`.
  - backup recovery 130/130, typecheck, production build, renderer evidence boundary green.
  - 마지막 Critical 수정 후 별도의 새 독립 리뷰는 아직 필요하다.
- Safe upgrade harness 커밋: `6fe95fe`.
  - Node 24 focused 82 pass, platform 4 skip, Node/PowerShell/Bash syntax green.
  - 안전 패치 후 실제 packaged Windows/macOS smoke는 미실증이다.
- 상세 하위 설계:
  - `docs/superpowers/plans/2026-07-14-security-sync-integration-wave2.md`
  - `docs/superpowers/plans/2026-07-14-v038-v039-in-place-upgrade.md`
- 현재 작업 트리에는 위 두 계획서와 이 인수인계 문서만 untracked 상태여야 한다.

## Original Request Coverage

| Original request | State | Remaining gate |
|---|---|---|
| Mac/Windows 오류·성능·호환성 | 구현 다수 완료 | Task 3, 7, 8의 독립 리뷰와 실제 signed platform smoke |
| 릴리즈와 Windows Desktop 설치 파일 | 미완료 | Task 10-11 |
| 언어별 keep logged in | 완료 | Task 8 회귀만 |
| 프리미엄 디자인·애니메이션 | 완료 | Task 8 회귀만 |
| 조건부 정보 표시·가독성 | 완료 | Task 8 회귀만 |
| 계정/가족코드 동기화·무손실 | 기반 완료, production integration 미완료 | Task 4-6 |
| 한/일 튜토리얼·skip | 완료 | Task 8 회귀만 |
| 공신력/과학 근거·시기별 안내 | 완료 | Task 8 회귀만 |
| 기록 메뉴 직관성 | 완료 | Task 8 회귀만 |
| 실제 사용자 프로필 사고 복구 | 미완료, 승인 대기 | Task 1-2 |

## File Responsibility Map

| Subsystem | Files | Responsibility |
|---|---|---|
| Incident recovery | `scripts/incident-profile-recovery.mjs`, `tests/incidentProfileRecovery.test.ts` | 실제 프로필 read-only 분석, quarantine/clone 준비, 승인된 원자 복원 |
| Family lifecycle | `src/sync/syncEngine.ts`, `shared/familyLifecycle.ts`, `tests/syncFamilyLifecycle.test.ts` | atomic create/join, collision/retry/read-back |
| Durable cloud events | `shared/cloudEventPayload.ts`, `src/sync/syncEngine.ts`, `electron/store/eventLog.ts`, `tests/cloudEventPayload.test.ts`, `tests/syncEngineUpload.test.ts` | 원본 보존, auth-bound derivative, exact ACK |
| Baby info projection | `src/sync/babyInfoSync.ts`, `shared/babyInfoResolver.ts`, `tests/babyInfoSync.test.ts` | bounded journal paging, immutable mutation, monotonic projection |
| Rules | `firestore.rules`, `tests/firestoreRulesEmulator.test.ts` | atomic lifecycle, immutable payload, rollout compatibility |
| Upgrade gate | `scripts/upgrade-*.mjs`, `scripts/*-in-place-upgrade-smoke.*`, matching tests | exact v0.3.8/candidate continuity and real-profile non-interference |
| CI/release | `.github/workflows/build.yml`, `tests/platformReleaseWorkflow.test.ts`, `tests/releaseWorkflow.test.ts` | baseline fetch, signed upgrade jobs, transitive release gates |
| Desktop handoff | `scripts/platform-release-verification.mjs` plus one run-owned PowerShell command | official signed v0.3.9 Setup verification and atomic Desktop placement |

---

### Task 0: Freeze the Correct Baseline and Commit the Plans

**Files:**
- Add: `docs/superpowers/plans/2026-07-14-claude-code-remaining-work-handoff.md`
- Add: `docs/superpowers/plans/2026-07-14-security-sync-integration-wave2.md`
- Add: `docs/superpowers/plans/2026-07-14-v038-v039-in-place-upgrade.md`

**Interfaces:**
- Consumes: HEAD `51d5da3`.
- Produces: a documentation-only commit that Claude Code can use as the execution checkpoint.

- [ ] **Step 1: Verify the exact worktree and HEAD**

```powershell
Set-Location 'D:\BABY DIARY MAC.health-worktrees\evidence-guidance-v3'
git branch --show-current
git rev-parse HEAD
git status --short
```

Expected: branch `codex/evidence-guidance-v3`, HEAD `51d5da3bcb41559b69bc0d9786ebc6b366c1a062`, only the three plan files untracked.

- [ ] **Step 2: Verify no installed app process is running**

```powershell
Get-Process | Where-Object { $_.ProcessName -eq 'Baby Diary' }
```

Expected: no output. If a process exists, stop here and ask the user to close it; do not terminate it implicitly.

- [ ] **Step 3: Commit only the plans**

```powershell
git add -- `
  docs/superpowers/plans/2026-07-14-claude-code-remaining-work-handoff.md `
  docs/superpowers/plans/2026-07-14-security-sync-integration-wave2.md `
  docs/superpowers/plans/2026-07-14-v038-v039-in-place-upgrade.md
git diff --cached --check
git commit -m "docs: hand off remaining v0.3.9 release work"
```

Expected: exactly three Markdown files in the commit.

---

### Task 1: Preserve the Local Incident and Obtain Explicit Restore Approval

**Files:**
- Read only: `C:\Users\배한주\AppData\Roaming\baby-diary`
- Read only: `C:\Users\배한주\AppData\Local\Temp\baby-diary-upgrade-7a10c985f130485c87a4a839b5eb6cca\actual-profile-impact-readonly.json`

**Interfaces:**
- Consumes: incident evidence SHA-256 `030076aead9f6a7537d4671dd7989df60ce0b1a660efe538f1dc690cf4c40fa7`.
- Produces: explicit user authorization string `RESTORE_BABY_DIARY_2026-07-14` or a recorded blocked state. No profile mutation occurs in this task.

- [ ] **Step 1: Re-verify the read-only incident evidence**

```powershell
$evidence = 'C:\Users\배한주\AppData\Local\Temp\baby-diary-upgrade-7a10c985f130485c87a4a839b5eb6cca\actual-profile-impact-readonly.json'
Get-FileHash -LiteralPath $evidence -Algorithm SHA256
```

Expected SHA-256: `030076AEAD9F6A7537D4671DD7989DF60CE0B1A660EFE538F1DC690CF4C40FA7`.
증거 파일이 없거나 해시가 다르면 복구 경로를 중단하고 새 읽기 전용 감사를 수행한다. 기억에 의존해 승인 증거를 재구성하지 않는다.

- [ ] **Step 2: Present the exact repair facts without exposing values**

Record these facts in the Claude Code task output:

- Production Firebase completed requests/writes: 0; Auth 2 and Firestore 21 were rewritten to loopback emulators.
- Pre snapshot: `backups/2026-07-13_21-42-13/settings.json`, 301 bytes, SHA-256 `567a5b05c5b31ebbf4ef105bfdb9866215f2f35ca34b76b6616a0183b9cde434`.
- Pre July events: 26,934 bytes, SHA-256 `a3057b9d245d6b59eb3204e36c354d4bd5991d59e4f07d963d2def2d3e4e3592`.
- Live July is the exact pre file plus 3,307 bytes/11 records; new June file is 276 bytes/1 record.
- Pre IndexedDB logical state is recoverable from `000005.ldb` + `000060.ldb` with sequence cutoff 635; incident state begins at 636 in `000062.ldb`/`000061.log`.
- Physical byte-for-byte IndexedDB rollback is impossible; logical rollback is possible.

- [ ] **Step 3: Ask for the restore authorization**

Ask exactly: `사고 전 로컬 상태 복원을 진행하려면 RESTORE_BABY_DIARY_2026-07-14 라고 답해 주세요.`

Expected: without the exact authorization, do not execute Task 2 and do not launch the installed app. Other code-only tasks may continue, but release/Desktop completion remains blocked.

---

### Task 2: Build and Execute the Incident Recovery Tool (Authorization Required)

**Files:**
- Create: `scripts/incident-profile-recovery.mjs`
- Create: `tests/incidentProfileRecovery.test.ts`

**Interfaces:**

```ts
export interface IncidentRecoverySpec {
  profileRoot: string
  preSnapshotRoot: string
  evidencePath: string
  quarantineRoot: string
  expectedEvidenceSha256: string
  expectedPreSettingsSha256: string
  expectedPreJulySha256: string
  expectedPreLiveKeySetSha256: string
  cutoffSequence: number
}

export interface IncidentAnalysis {
  profileManifestSha256: string
  preSettingsSha256: string
  preJulySha256: string
  appendedJulyBytes: number
  appendedJulyRecords: number
  preLiveKeySetSha256: string
  cutoffSequence: number
  writesPerformed: 0
}

export interface PreparedRecovery {
  runRoot: string
  originalCopyRoot: string
  preparedProfileRoot: string
  originalManifestSha256: string
  preparedManifestSha256: string
  preLiveKeySetSha256: string
}

export interface AppliedRecovery {
  activeProfileRoot: string
  rollbackProfileRoot: string
  finalManifestSha256: string
}

export function snapshotTree(root: string): Promise<Array<{ path: string; size: number; sha256: string }>>
export function analyzeIncident(spec: IncidentRecoverySpec): Promise<IncidentAnalysis>
export function prepareRecoveryClone(spec: IncidentRecoverySpec): Promise<PreparedRecovery>
export function applyPreparedRecovery(prepared: PreparedRecovery, approval: string): Promise<AppliedRecovery>
```

`applyPreparedRecovery` must accept only `RESTORE_BABY_DIARY_2026-07-14` and must reject every path outside the canonical profile/quarantine roots.

- [ ] **Step 1: Write RED tests for path ownership and evidence binding**

In `tests/incidentProfileRecovery.test.ts`, create temp fixtures and assert:

```ts
await expect(analyzeIncident(specWithWrongEvidenceHash)).rejects.toThrow(/evidence.*sha/i)
await expect(prepareRecoveryClone(specWithLinkedProfile)).rejects.toThrow(/link|reparse|identity/i)
await expect(applyPreparedRecovery(prepared, 'wrong')).rejects.toThrow(/approval/i)
expect(await snapshotTree(profileRoot)).toEqual(before)
```

Also cover a changed live file, a non-prefix July file, missing `000005.ldb`, missing `000060.ldb`, any sequence above 635 leaking into the prepared pre-state, and quarantine containment failure.

- [ ] **Step 2: Run the RED tests**

```powershell
$node = 'C:\Users\배한주\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node node_modules/vitest/vitest.mjs run tests/incidentProfileRecovery.test.ts
```

Expected: failures because the module does not yet exist.

- [ ] **Step 3: Implement read-only analysis and clone preparation**

The implementation must:

1. Open every source with `lstat`/`realpath`/same-file verification and reject links/reparse points.
2. Hash the evidence and exact pre/live files before any destination is created.
3. Copy the full current profile to `C:\Users\배한주\AppData\Local\BabyDiaryIncidentRecovery\<random-128-bit>\original` using temp files, fsync, rename, and a complete manifest.
4. Build `prepared` only inside the same quarantine run root.
5. Restore JSON in the clone from the exact pre snapshot; move the incident June file into clone-local `incident-extra`, never delete it.
6. Reconstruct the IndexedDB clone from the verified pre logical state only. Read the complete 64-hex pre-state live-key-set SHA-256 from the verified incident evidence and require the clone to match it before acceptance. Never print key values.
7. Keep the original live profile untouched during `analyze` and `prepare`.

- [ ] **Step 4: Run tests and a read-only real analysis**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/incidentProfileRecovery.test.ts
& $node scripts/incident-profile-recovery.mjs analyze `
  --profile 'C:\Users\배한주\AppData\Roaming\baby-diary' `
  --pre-snapshot 'C:\Users\배한주\AppData\Roaming\baby-diary\backups\2026-07-13_21-42-13' `
  --evidence 'C:\Users\배한주\AppData\Local\Temp\baby-diary-upgrade-7a10c985f130485c87a4a839b5eb6cca\actual-profile-impact-readonly.json'
```

Expected: tests pass; analyze reports the known hashes and performs zero writes under the real profile.

- [ ] **Step 5: Prepare and validate the clone with outbound network denied**

Run `prepare`, then validate only the clone under `BABYDIARY_TEST_USERDATA` with the deny proxy/network guard from `scripts/upgrade-e2e.mjs`. Require main-process userData attestation, pre logical key-set equality, and no external completed request. Do not launch the installed app against the real profile.

- [ ] **Step 6: Apply only after a second explicit confirmation**

Before `apply`, re-hash the real profile and require it to match the `analyze` snapshot. Atomically rename the real profile to the quarantine rollback path, atomically rename the validated clone into the canonical path, then re-read every final hash. Never delete the rollback copy.

- [ ] **Step 7: Commit the tested recovery tool**

```powershell
git add -- scripts/incident-profile-recovery.mjs tests/incidentProfileRecovery.test.ts
git diff --cached --check
git commit -m "fix: add verified incident profile recovery"
```

---

### Task 3: Independently Re-review the Final Storage and Firebase Commits

**Files:**
- Review: `electron/store/backupSnapshot.ts`
- Review: `electron/store/firebasePersistenceRegistry.ts`
- Review: `electron/main.ts`
- Test: `tests/backupPairRecovery.test.ts`
- Test: `tests/firebasePersistenceRegistry.test.ts`

**Interfaces:**
- Consumes: `1d87421` and `51d5da3`.
- Produces: two independent review reports with Critical/Important/Minor `0/0/0` on current HEAD.

- [ ] **Step 1: Create detached clean review worktrees**

Use `superpowers:using-git-worktrees`; do not review a dirty shared tree.

- [ ] **Step 2: Run the exact focused suites with Node 24**

```powershell
$nodeBin = 'C:\Users\배한주\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$env:PATH = "$nodeBin;$env:PATH"
& "$nodeBin\node.exe" node_modules/vitest/vitest.mjs run tests/backupPairRecovery.test.ts
& "$nodeBin\node.exe" node_modules/vitest/vitest.mjs run tests/firebasePersistenceRegistry.test.ts tests/firebasePersistenceIPC.test.ts
```

Expected: backup recovery 130/130 or higher; Firebase registry/IPC current counts green.

- [ ] **Step 3: Review the exact remaining boundaries**

Storage: forensic FD authority through first/second primary publication, truthful `originalsPreserved`, 4096-file/peak-FD bounds, intent tombstone, no-follow cleanup, Windows/POSIX response loss.

Firebase: SettingsStore-before-registry ordering, bootstrap witness crash restart, recovery evidence case-folding, complete WAL replay, same-key/same-sequence conflict, bounds, main/preload claim strictness.

- [ ] **Step 4: Fix any Critical/Important finding with a new RED test**

Do not accept a previous report as proof. A fix is complete only when the new RED is green and both full focused suites remain green.

- [ ] **Step 5: Commit only if the review required code changes**

Use an explicit message such as `fix(storage): close forensic lease review gap` or `fix(firebase): close ownership review gap`, and keep the two domains in separate commits.

---

### Task 4: Make Family Create/Join Atomic and Idempotent

**Files:**
- Create: `shared/familyLifecycle.ts`
- Create: `tests/syncFamilyLifecycle.test.ts`
- Modify: `src/sync/syncEngine.ts:816-960`
- Modify: `firestore.rules`
- Modify: `tests/firestoreRulesEmulator.test.ts`

**Interfaces:**

```ts
export interface FamilyLifecycleResult {
  familyId: string
  inviteCode: string
}

export interface FamilyJoinResult {
  familyId: string
  babyName: string
  babyBirthdate: string
}

export function exactOwnUserData(familyId: string): { familyId: string }
export function exactInviteData(familyId: string, code: string, createdAt: unknown): Record<string, unknown>
export function joinProofPath(uid: string, code: string): string
```

- [ ] **Step 1: Write RED tests for createFamily**

Assert one `writeBatch` contains exactly `families/{familyId}`, `invites/{code}`, and `users/{uid}`; no best-effort second write is allowed. Add collision retry with the same family id, bounded attempts, exact read-back after response loss, and restart recovery through `users/{uid}.familyId`.

- [ ] **Step 2: Write RED tests for joinFamily**

Assert one batch contains deterministic `joinProofs/{uid}/capabilities/{code}`, `families/{familyId}.members.{uid}`, and `users/{uid}`. Retry must be idempotent; joining a later second family must not mutate the first family.

- [ ] **Step 3: Run RED tests**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/syncFamilyLifecycle.test.ts
```

- [ ] **Step 4: Implement the minimal atomic operations**

Remove the separate `setDoc(users/{uid})` blocks at current lines 854-860 and 946-952. Keep one generated `familyId` for all invite collision attempts. After an ambiguous commit failure, read all expected documents and accept success only if every exact field matches.

- [ ] **Step 5: Harden rules and emulator tests**

Rules must require atomic family/invite/user creation and atomic joinProof/member/user join. Deny invite listing, joinProof listing/mutation, cross-user user writes, member overwrite, orphan family, and wrong code/family pairing.

```powershell
& $node scripts/run-firestore-rules.mjs
```

Expected: all allow/deny branches green under Java 21.

- [ ] **Step 6: Commit**

```powershell
git add -- shared/familyLifecycle.ts src/sync/syncEngine.ts firestore.rules tests/syncFamilyLifecycle.test.ts tests/firestoreRulesEmulator.test.ts
git commit -m "fix(sync): make family lifecycle atomic"
```

---

### Task 5: Persist Auth-bound Event Derivatives Before Upload and ACK Exactly

**Files:**
- Modify: `shared/cloudEventPayload.ts`
- Modify: `src/sync/syncEngine.ts`
- Modify: `electron/store/eventLog.ts`
- Modify: `tests/cloudEventPayload.test.ts`
- Create: `tests/syncEngineUpload.test.ts`

**Interfaces:**
- Use existing `deriveUploadReadyEvent`, `makeCloudEventDocId`, `parseCloudEventPayload`, and `cloudEventPayloadEquals`.
- Add `ensureDurableUploadDerivative(source, writerUid): Promise<DiaryEvent>` in `syncEngine.ts`.

- [ ] **Step 1: Write RED tests for durable ordering**

Assert the sequence is: derive → IPC append/fsync → read local EventLog back → Firestore write → server read-back → remove pending. Inject a crash/error at every boundary and prove the original plus derivative remains discoverable.

- [ ] **Step 2: Write RED tests for account changes and conflicts**

Cover A→B, same id/rev with different content, already-exists different bytes, malformed cloud sibling, restart, and duplicate retry. A's derivative must never be rebound or removed by B.

- [ ] **Step 3: Implement derivative integration**

Before upload, call `deriveUploadReadyEvent`; when it differs from the source, append it through the existing main-process EventLog IPC and re-read it. Upload only `{ event: derivative }` to `makeCloudEventDocId(derivative)`. ACK only when `parseCloudEventPayload` and `cloudEventPayloadEquals` both succeed.

- [ ] **Step 4: Reconstruct pending work after restart**

Treat localStorage pending as a cache, not authority. Use the existing main-owned `events:listMutations`/EventLog index to find upload-ready derivatives whose exact cloud read-back is absent; re-enqueue them without rewriting originals.

- [ ] **Step 5: Run tests and commit**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/cloudEventPayload.test.ts tests/syncEngineUpload.test.ts tests/eventLog.test.ts
git add -- shared/cloudEventPayload.ts src/sync/syncEngine.ts electron/store/eventLog.ts tests/cloudEventPayload.test.ts tests/syncEngineUpload.test.ts
git commit -m "fix(sync): persist exact event upload derivatives"
```

---

### Task 6: Complete Baby-info Projection and Exact v0.3.8 Rollout Policy

**Files:**
- Modify: `src/sync/babyInfoSync.ts`
- Modify: `shared/babyInfoResolver.ts`
- Modify: `firestore.rules`
- Modify: `tests/babyInfoSync.test.ts`
- Modify: `tests/firestoreRulesEmulator.test.ts`
- Modify: `src/i18n/ko.json`
- Modify: `src/i18n/ja.json`

**Interfaces:**
- Continue using bounded pending/archive paging and current HLC mutation keys.
- Chosen rollout policy: exact v0.3.8 cloud writes that lack current proof fields are rejected by hardened rules; v0.3.9 preserves the local source and uploads one durable auth-bound derivative.

- [ ] **Step 1: Write RED projection tests**

Cover stale lower clock, equal-clock opposite write order, invalid calendar date, ISO/numeric-shadow mismatch, forged encoded id, future shadow, same UUID/different payload, and poison sibling isolation.

- [ ] **Step 2: Implement monotonic atomic projection**

Upload immutable mutation first, then use a Firestore transaction/batch whose family projection references that exact mutation. A lower logical clock can never replace the winner; equal clocks use the existing deterministic resolver key.

- [ ] **Step 3: Preserve legacy local data**

Exact v0.3.8 fixtures must remain visible/exportable/backed up. Rejected legacy cloud upload stays local with bounded attention state; it is never ACKed or deleted.

- [ ] **Step 4: Add bilingual update-required copy**

Add exact Korean/Japanese strings explaining that an older client must update before family/cloud writes resume. Do not show the warning for local-only recording.

- [ ] **Step 5: Run unit and real emulator suites**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/babyInfoSync.test.ts tests/babyInfoResolver.test.ts
& $node scripts/run-firestore-rules.mjs
```

- [ ] **Step 6: Commit**

```powershell
git add -- src/sync/babyInfoSync.ts shared/babyInfoResolver.ts firestore.rules tests/babyInfoSync.test.ts tests/firestoreRulesEmulator.test.ts src/i18n/ko.json src/i18n/ja.json
git commit -m "fix(sync): bind baby info projection and rollout"
```

Do not deploy the rules in this task.

---

### Task 7: Integrate the Safe In-place Upgrade Gate into CI

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `tests/platformReleaseWorkflow.test.ts`
- Modify: `tests/releaseWorkflow.test.ts`
- Verify: all files in commit `6fe95fe`

**Interfaces:**
- Baseline constants: release ID `352876543`; Windows asset ID `474870034`, size `233249330`, SHA-256 `edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de`; Mac asset ID `474869787`, size `351533375`, SHA-256 `2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974`.
- Exact source commit: `4ad44829c0de56da33d9123c16f92e6090f0df4a`.

- [ ] **Step 1: Write workflow RED tests**

Require `fetch-depth: 0` for every job that calls the upgrade/rules tag loaders. Require jobs `baseline-v038`, `upgrade-win`, `upgrade-mac-arm64`, `upgrade-mac-intel`. Require manifests and release jobs to transitively need all three upgrade jobs.

- [ ] **Step 2: Add the isolated baseline-fetch job**

Download by exact release/asset ID, verify metadata/size/SHA, upload one-day artifacts under a name that cannot match release upload globs. The job must not receive signing or release-write secrets.

- [ ] **Step 3: Add protected upgrade jobs**

Use signed candidate artifacts from `package-win`/`package-mac`. Prepare exact baseline rules, run the same Auth/Firestore emulator process, transition to current rules, and execute the safe wrapper with `BABYDIARY_TEST_USERDATA` attestation. Run macOS independently on `macos-15` and `macos-15-intel`.

- [ ] **Step 4: Make release dependencies fail closed**

`manifest-mac`, `manifest-win`, `release-mac`, `release-win`, and `publish-release` must not run after any upgrade failure or skip. Ordinary PR CI must remain unsigned and secret-free.

- [ ] **Step 5: Run workflow contract tests**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/platformReleaseWorkflow.test.ts tests/releaseWorkflow.test.ts tests/upgradeFirebaseContinuity.test.ts tests/upgradeFirestoreRulesTransition.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add -- .github/workflows/build.yml tests/platformReleaseWorkflow.test.ts tests/releaseWorkflow.test.ts
git commit -m "ci: gate v0.3.9 on exact in-place upgrades"
```

---

### Task 8: Run Clean Verification and Independent Final Review

**Files:**
- No intended source changes; fixes discovered here receive separate commits.

**Interfaces:**
- Consumes: Tasks 3-7.
- Produces: clean Node 24/Java 21/package evidence and C/I/M `0/0/0` reviews.

- [ ] **Step 1: Install from lockfile with Node 24**

```powershell
$node = 'C:\Users\배한주\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$env:PATH = "$(Split-Path $node);$env:PATH"
& $node $npm ci
& $node -v
```

Expected: `v24.14.0`, clean lockfile install.

- [ ] **Step 2: Run the full local suite**

```powershell
& $node $npm run typecheck
& $node $npm test
& $node $npm run build
& $node $npm run test:firestore-rules
```

Expected: all commands exit 0. If Java 21 is unavailable locally, run the final Firestore command in CI and record the job URL/commit SHA.

- [ ] **Step 3: Run UI regression gates only**

Run the existing tutorial, i18n, keep-login, History, progressive readability, age guidance, and packaged normal/two-device tests. Do not redesign completed screens.

- [ ] **Step 4: Run three independent reviews**

Review domains separately: local durability; Firebase/rules/sync; upgrade/release workflow. Each report must state Critical/Important/Minor and Ready. Any Critical/Important returns to a RED test and a separate fix commit.

- [ ] **Step 5: Verify repository cleanliness**

```powershell
git status --short
git diff --check
git log --oneline --decorate -20
```

Expected: no unstaged/untracked files and intentional commit order.

---

### Task 9: Push the Branch and Open a Reviewable PR

**Files:**
- No new files.

**Interfaces:**
- Consumes: clean Task 8 commit set.
- Produces: remote branch and PR; no release yet.

- [ ] **Step 1: Read the finishing skill**

Use `superpowers:finishing-a-development-branch` before any push/merge decision.

- [ ] **Step 2: Push without rewriting history**

```powershell
git push -u origin codex/evidence-guidance-v3
```

- [ ] **Step 3: Open a PR**

The PR body must list completed user requests, incident status, exact test commands, C/I/M reports, missing signing credentials, and the fact that production Firestore rules are not yet deployed.

- [ ] **Step 4: Require CI green**

Do not merge on skipped upgrade jobs in a signed dry-run or release context.

---

### Task 10: Provision Signing, Run Signed Dry-run, Publish v0.3.9, Then Deploy Rules

**Files:**
- GitHub environment secrets; no secret values in the repository.

**Interfaces:**
- Required Mac secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `MAC_CSC_NAME`, `MAC_EXPECTED_TEAM_ID`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Required Windows secrets: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WIN_EXPECTED_PUBLISHER`, `WIN_EXPECTED_CERT_SHA256`.

- [ ] **Step 1: Provision the exact secrets in `platform-release-signing`**

If any secret is absent, stop here. Do not add fallback identities or unsigned aliases.

- [ ] **Step 2: Run the manual signed dry-run**

Expected: signed Windows package, signed/notarized/stapled universal Mac package, Windows upgrade, Mac ARM64 upgrade, Mac Intel upgrade, packaged normal E2E, packaged two-device sync E2E, manifests, and provenance all green; no external release mutation.

- [ ] **Step 3: Create/push the v0.3.9 tag only from the reviewed commit**

Verify `package.json` is `0.3.9`, tag points to the reviewed SHA, and release preflight creates/resumes only a private draft.

- [ ] **Step 4: Publish only through the immutable manifest workflow**

Re-fetch the release and verify every asset id/name/size/SHA/signature before publication.

- [ ] **Step 5: Deploy Firestore rules as a separate operation**

Record the previous production ruleset for rollback, deploy the exact reviewed `firestore.rules`, record the new ruleset/version, then run a production-safe smoke that performs no destructive migration. Roll back immediately on permission or convergence regression.

---

### Task 11: Update the Windows Desktop Installer

**Files:**
- Final target: `C:\Users\배한주\Desktop\Baby-Diary-Setup-0.3.9.exe`
- Verified old target: `C:\Users\배한주\Desktop\Baby-Diary-Setup-0.3.8.exe`

**Interfaces:**
- Consumes: published v0.3.9 Windows manifest and expected Authenticode publisher/certificate SHA.
- Produces: one verified official v0.3.9 Setup on Desktop.

- [ ] **Step 1: Download to a nonce staging file on the Desktop volume**

Do not overwrite the old file and do not use a glob.

- [ ] **Step 2: Verify the staging file**

Require exact published byte length/SHA-256, version `0.3.9`, Authenticode status Valid, exact publisher Subject, and exact certificate SHA-256.

- [ ] **Step 3: Atomically rename to the final name and re-read**

After rename, repeat size/SHA/signature/version verification on `Baby-Diary-Setup-0.3.9.exe`.

- [ ] **Step 4: Remove only the specifically verified old installer**

The current old file must still be exactly 233,249,330 bytes with SHA-256 `EDB3A3E2D036F0D16DC8D75948C3F160C35ADC9D1277A3DEDC41D8671BD6A6DE`. If either value differs, preserve it and stop. Never delete any other Desktop file.

- [ ] **Step 5: Final user handoff**

Report the v0.3.9 Desktop path, final SHA-256, signer Subject/certificate SHA, release URL, CI run URLs, production ruleset id, and the retained incident rollback path.

## Final Completion Gate

The work is complete only when all of the following are true:

- User-approved local incident restoration is verified, or the user explicitly elects to preserve the incident state.
- Storage and Firebase post-fix independent reviews are C/I/M `0/0/0`.
- Atomic family lifecycle, event derivative, baby-info projection, and real emulator tests are green.
- Exact signed Windows/macOS in-place upgrade jobs are green on the candidate bytes.
- Signed v0.3.9 is published through immutable manifests.
- Hardened Firestore rules are deployed separately with rollback evidence.
- The Desktop contains the verified official `Baby-Diary-Setup-0.3.9.exe` and the specifically verified old installer has been removed.
