# PR Draft: v0.3.9 남은 작업 (evidence-guidance-v3)

> 이 파일은 실제 `gh pr create` 실행 없이 준비한 PR 본문 초안이다. 브랜치는 아직 push되지 않았다.

- 브랜치: `codex/evidence-guidance-v3`
- 시작 HEAD(baseline): `51d5da3bcb41559b69bc0d9786ebc6b366c1a062`
- 현재 HEAD: `0e38086e5aaa2f07c7adba71cbb7969e4d4515a5`
- 이 브랜치는 `origin/master` 대비 84개 커밋 앞서 있고 아직 push되지 않았다 (`git status` 기준).

---

## PR 제목 (제안)

```
fix: harden family sync, event durability, and storage/firebase review gaps for v0.3.9
```

## PR 본문

### 1. 완료된 사용자 요청 커버리지

| 원 요청 | 상태 | 남은 게이트 |
|---|---|---|
| Mac/Windows 오류·성능·호환성 | 구현 다수 완료, Task 3 리뷰 격차 수정 반영(커밋 `4aaa855`, `aaa8a9e`) | Task 3 재검토 확정 보고, Task 8 종합 검증, 실제 signed platform smoke |
| 릴리즈와 Windows Desktop 설치 파일 | 미완료 | Task 10-11 (서명 자격증명 필요) |
| 언어별 keep logged in | 완료 | Task 8 회귀만 |
| 프리미엄 디자인·애니메이션 | 완료 | Task 8 회귀만 |
| 조건부 정보 표시·가독성 | 완료 | Task 8 회귀만 |
| 계정/가족코드 동기화·무손실 (family lifecycle) | **이번 브랜치에서 완료** (커밋 `0fc0887`) | Task 8 회귀, 실 emulator 확정(CI) |
| 계정/가족코드 동기화·무손실 (event 업로드 파생본) | **이번 브랜치에서 완료** (커밋 `0e38086`) | Task 8 회귀 |
| 계정/가족코드 동기화·무손실 (baby-info projection + rollout 정책) | 미완료 | Task 6 |
| 한/일 튜토리얼·skip | 완료 | Task 8 회귀만 |
| 공신력/과학 근거·시기별 안내 | 완료 | Task 8 회귀만 |
| 기록 메뉴 직관성 | 완료 | Task 8 회귀만 |
| CI 안전 업그레이드 게이트 통합 | **이번 브랜치에서 완료** (커밋 `3150900`) | 실제 서명된 CI 실행으로 최종 확인 |
| 실제 사용자 프로필 사고 복구 | **미완료, 승인 대기** | Task 1 승인 획득 후 Task 2 |

이 PR은 계획서 `docs/superpowers/plans/2026-07-14-claude-code-remaining-work-handoff.md`의 Task 3(부분), 4, 5, 7을 반영한다. Task 1/2(사고 복구), 6(baby-info projection), 8(종합 검증), 10-11(서명 릴리즈/Desktop 설치)은 이 PR 범위 밖이며 후속 작업으로 남는다.

---

### 2. 실제 사용자 프로필 사고(incident) 상태

- **상태: 승인 대기 (RESTORE_BABY_DIARY_2026-07-14 승인 미획득)**
- **실프로필 무변경**: `C:\Users\배한주\AppData\Roaming\baby-diary`에 대해 어떠한 쓰기/복원/삭제도 수행하지 않았다. `scripts/incident-profile-recovery.mjs`와 `tests/incidentProfileRecovery.test.ts`는 아직 생성되지 않았으며(Task 2 미착수), 실 프로필 디렉터리의 최종 수정 시각은 이 브랜치의 작업 시작 이전 상태를 유지한다.
- **증거 해시 검증됨**: 읽기 전용 재검증 완료.
  ```powershell
  Get-FileHash -LiteralPath 'C:\Users\배한주\AppData\Local\Temp\baby-diary-upgrade-7a10c985f130485c87a4a839b5eb6cca\actual-profile-impact-readonly.json' -Algorithm SHA256
  ```
  결과: `030076AEAD9F6A7537D4671DD7989DF60CE0B1A660EFE538F1DC690CF4C40FA7` — 계획서 기대값과 정확히 일치.
- Production Firebase에 대한 완료된 요청/쓰기는 0건이며, Auth 2건과 Firestore 21건은 loopback emulator로 재기록되어 있었음(계획서 Task 1 Step 2 기재 사실, 재확인되지 않았으므로 계획서 값을 그대로 인용).
- 복원을 진행하려면 사용자가 정확히 `RESTORE_BABY_DIARY_2026-07-14`라고 답해야 하며, 승인 전에는 Task 2(복구 도구 작성/실행)를 시작하지 않는다.

---

### 3. 정확한 테스트 실행 명령 (Node 24, 계획서 경로 포함)

모든 명령은 먼저 다음 변수를 설정한 뒤 실행한다:

```powershell
$node = 'C:\Users\배한주\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$env:PATH = "$(Split-Path $node);$env:PATH"
```

전체 검증 (Task 8 Step 1-2, `npm ci` 후):

```powershell
& $node $npm ci
& $node -v                              # 기대값: v24.14.0
& $node $npm run typecheck
& $node $npm test                       # vitest run --exclude tests/firestoreRulesEmulator.test.ts
& $node $npm run build
& $node $npm run test:firestore-rules   # node scripts/run-firestore-rules.mjs (Java 21 필요)
```

이번 브랜치 작업에 해당하는 포커스 테스트 (Task 3/4/5/7):

```powershell
& $node node_modules/vitest/vitest.mjs run tests/backupPairRecovery.test.ts
& $node node_modules/vitest/vitest.mjs run tests/firebasePersistenceRegistry.test.ts tests/firebasePersistenceIPC.test.ts
& $node node_modules/vitest/vitest.mjs run tests/syncFamilyLifecycle.test.ts
& $node node_modules/vitest/vitest.mjs run tests/cloudEventPayload.test.ts tests/syncEngineUpload.test.ts tests/eventLog.test.ts
& $node node_modules/vitest/vitest.mjs run tests/platformReleaseWorkflow.test.ts tests/releaseWorkflow.test.ts tests/upgradeFirebaseContinuity.test.ts tests/upgradeFirestoreRulesTransition.test.ts
```

Firestore rules emulator (Java 21 필요, 로컬 미보유 시 CI 권위 결과 사용):

```powershell
& $node scripts/run-firestore-rules.mjs
```

이 초안 작성 세션에서는 문서 준비만 수행했고 위 명령들을 재실행하지 않았다. 각 커밋 시점의 통과 근거는 해당 커밋 메시지(§4)와 계획서 Task 3/4/5/7 본문에 기술된 RED→GREEN 절차를 따른다. 병합 전 Task 8에서 전체 스위트를 한 번에 재확인해야 한다.

---

### 4. 이번 브랜치 커밋 요약 (`51d5da3` 이후 전체, 시간순)

| 커밋 | 제목 |
|---|---|
| `25ed2558789cfcdeee86738c432da0fa0fa9d711` | docs: hand off remaining v0.3.9 release work |
| `3150900eac2de5e7ba5819ec2257034f41f9542b` | ci: gate v0.3.9 on exact in-place upgrades |
| `4aaa855e812b553dbdcdd83dfdf249e0c1449a90` | fix(storage): close forensic lease review gap |
| `aaa8a9e6e90f55861fbd0b972c3b043cdd62eefa` | fix(firebase): close ownership review gap |
| `0fc0887add2fea9d242a496000129d21a6e2e29c` | fix(sync): make family lifecycle atomic |
| `0e38086e5aaa2f07c7adba71cbb7969e4d4515a5` | fix(sync): persist exact event upload derivatives |

요약:
- `docs`: 세 개 인수인계 계획서 커밋(문서 전용).
- `ci`: `.github/workflows/build.yml`에 baseline-fetch + 서명된 upgrade 잡(`upgrade-win`, `upgrade-mac-arm64`, `upgrade-mac-intel`)과 release 잡 fail-closed 의존성 추가.
- `fix(storage)`: `backupSnapshot.ts`의 orphan-staging catch 경로가 forensic 증거가 실제로 재확인됐음에도 `originalsPreserved: false`를 하드코딩하던 리뷰 격차를 수정, RED 회귀 테스트 추가.
- `fix(firebase)`: `firebasePersistenceRegistry.ts`가 정상적인 비정상 종료로 인한 LevelDB WAL 말단의 불완전 레코드를 하드 손상으로 오판해 이후 모든 실행에서 스타트업을 막던 리뷰 격차를 수정, RED 회귀 테스트 추가.
- `fix(sync)` x2: `familyLifecycle.ts` 신설로 family create/join을 단일 원자적 배치로 통합, `cloudEventPayload`/`syncEngine`/`eventLog` 경로에 업로드 전 auth-bound 파생본 영속화와 정확한 ACK 절차 추가.

---

### 5. 미보유 서명 자격증명 (Task 10 게이트, `platform-release-signing` 환경)

**Mac (7종, 전부 미보유):**
- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `MAC_CSC_NAME`
- `MAC_EXPECTED_TEAM_ID`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

**Windows (4종, 전부 미보유):**
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`
- `WIN_EXPECTED_PUBLISHER`
- `WIN_EXPECTED_CERT_SHA256`

11종 시크릿이 모두 제공되기 전에는 서명된 dry-run(Task 10 Step 2), v0.3.9 태그 게시(Step 3-4), Desktop 설치 파일 교체(Task 11)를 진행하지 않는다. Fallback 서명 아이덴티티나 unsigned 산출물을 공식 릴리즈로 사용하지 않는다.

---

### 6. Firestore production rules 배포 상태

**Production Firestore rules는 이 PR에 포함되지 않으며 아직 배포하지 않았다.**

- Task 6(baby-info projection + rollout 정책)이 아직 완료되지 않았고, Task 6 자체도 "이 작업에서 rules를 배포하지 않는다"고 명시한다.
- 전역 제약: "Firestore production rules는 v0.3.9 서명 릴리즈와 실제 업그레이드 gate가 모두 green이 되기 전에 배포하지 않는다."
- rules 배포는 계획서 Task 10 Step 5에서 서명 릴리즈 게시 이후 별도 조작으로만 수행하며, 이전 production ruleset 기록/롤백 증거, 신규 ruleset id/버전 기록, 비파괴적 production smoke를 요구한다.
- 현재 `firestore.rules`에 대한 변경(Task 4 Step 5, family lifecycle 관련)은 로컬 emulator 테스트 대상일 뿐 production에는 아직 반영되지 않았다.

---

### 7. 알려진 CI-deferred 항목

- **Firestore Emulator 로컬 미실행**: 이 초안 작성 환경에는 Java가 설치되어 있지 않다 (`java -version` → `command not found`). 계획서 전역 제약에 따라 "Firestore Emulator 검증은 Java 21에서 실행한다. 로컬 Java 21이 없으면 GitHub Actions의 `actions/setup-java` Temurin 21 job을 권위 결과로 사용한다." 따라서 `npm run test:firestore-rules`(`scripts/run-firestore-rules.mjs`)와 `firestoreRulesEmulator.test.ts`는 로컬에서 실행하지 않았고, 브랜치 push 후 아래 워크플로 잡들의 CI 실행 결과를 권위 증거로 사용해야 한다:
  - `security-check`, `e2e-mac`, `e2e-win`, `baseline-v038`, `upgrade-win`, `upgrade-mac-arm64`, `upgrade-mac-intel` 등 `.github/workflows/build.yml` 내 `actions/setup-java@v4` (`distribution: temurin`, `java-version: 21`)를 사용하는 모든 잡.
- **서명된 upgrade/release 잡**: `package-mac`, `package-win`, `upgrade-*`, `smoke-*`, `manifest-*`, `release-*`, `publish-release` 잡은 서명 시크릿(§5)이 없으면 CI에서 실행/통과할 수 없다. 이 PR은 아직 push되지 않았으므로 실제 CI 실행 URL이 없다 — 병합 전 push 후 CI 실행 결과를 별도로 첨부해야 한다.
- **실 signed platform smoke**: Task 8(종합 검증)과 Task 10(서명 dry-run)이 완료되기 전까지 실제 패키징된 Windows/macOS 업그레이드 스모크는 미실증 상태로 남는다.

---

## 병합 전 체크리스트 (이 PR 자체)

- [ ] Task 8: `npm ci` → typecheck → test → build → test:firestore-rules 전체 재실행, 결과를 이 PR에 첨부
- [ ] push 후 CI에서 `security-check`, `e2e-mac`, `e2e-win`, `baseline-v038`, `upgrade-win`, `upgrade-mac-arm64`, `upgrade-mac-intel` 등 Java 21 필요 잡 green 확인
- [ ] Task 3 재검토(스토리지/Firebase) 확정 보고서 첨부 (Critical/Important/Minor 0/0/0, Ready Yes)
- [ ] 서명 시크릿 미보유 상태이므로 release 계열 잡(`package-*`, `upgrade-*`, `manifest-*`, `release-*`, `publish-release`)은 이 PR에서 통과를 요구하지 않음 — 스킵/미실행 사유 명시
- [ ] production Firestore rules 미배포 유지 확인
