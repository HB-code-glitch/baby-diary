# Cross-Platform Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows NSIS/portable와 macOS arm64/universal 앱의 공통 빌드 검증을 강화하고, 확인된 업데이트 생명주기 및 E2E 거짓 성공 결함을 수정한다.

**Architecture:** 플랫폼 정책은 순수 함수로 분리하고 Electron updater가 그 정책을 사용한다. 메인 창은 생성될 때마다 updater에 명시적으로 연결하며, 창이 없는 동안 발견한 수동 업데이트는 다음 메인 창 로드 후 한 번 전달한다. Vitest는 현재 작업 트리의 테스트만 수집하고, CI E2E는 node_modules Electron이 아니라 실제 unpacked 패키지를 실행한다.

**Tech Stack:** Electron 31, React 18, TypeScript 5.5, Vite 5, Vitest 1.6, Playwright Electron, electron-builder 24

## Global Constraints

- 기존 `userData` 경로 `%APPDATA%/baby-diary` 또는 macOS Application Support의 동일 폴더를 변경하지 않는다.
- Windows NSIS는 자동 업데이트를 유지하고 Windows portable 및 macOS는 수동 다운로드만 제공한다.
- macOS arm64와 universal, Windows x64 NSIS와 portable 타깃을 유지한다.
- 모든 production 변경은 실패하는 회귀 테스트 또는 실패하는 검증 게이트를 먼저 확인한다.
- 기존 미추적 문서 `docs/superpowers/plans/2026-07-12-pdf-report-backup-retention.md`는 수정하지 않는다.
- 코드 서명·Apple 공증은 인증서와 계정 비밀이 없으므로 이번 코드 패치 범위에 포함하지 않는다.

---

### Task 1: 신뢰 가능한 테스트·타입검사·경고 없는 빌드

**Files:**
- Create: `tests/setup.ts`
- Replace: `vite.config.ts` with `vite.config.mts`
- Replace: `vitest.config.ts` with `vitest.config.mts`
- Modify: `src/tests/reconcile-contract.test.ts`
- Modify: `src/index.css`
- Modify: `postcss.config.js`
- Modify: `src/sync/useSync.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run typecheck`, deterministic `localStorage`, root-only Vitest discovery.
- Consumes: existing `configure(null, familyId)` fallback in `src/sync/syncEngine.ts`.

- [ ] **Step 1: Verify the existing RED gates**

Run:

```powershell
npx tsc -p tsconfig.json --noEmit --pretty false
$out = npm test -- --reporter=dot 2>&1 | Out-String
if ($out -match '\.claude[\\/]+worktrees') { throw 'worktree tests collected' }
$build = npm run build 2>&1 | Out-String
if ($build -match 'css-syntax-error|MODULE_TYPELESS_PACKAGE_JSON|dynamically imported by') { throw 'known build warning remains' }
```

Expected: TypeScript reports TS2367 twice; the test gate reports worktree collection; the build warning gate reports all three known warning classes.

- [ ] **Step 2: Install deterministic test storage before module imports**

Create `tests/setup.ts` with an in-memory `Storage` implementation installed through `Object.defineProperty(globalThis, 'localStorage', ...)`, and clear it in `beforeEach`.

- [ ] **Step 3: Restrict test discovery and use ESM config files**

Create `vitest.config.mts` with:

```ts
test: {
  environment: 'node',
  globals: false,
  include: ['tests/**/*.test.ts', 'src/tests/**/*.test.ts'],
  setupFiles: [fileURLToPath(new URL('./tests/setup.ts', import.meta.url))],
}
```

Use `fileURLToPath(new URL(..., import.meta.url))` for aliases in both `.mts` configs, then delete the old `.ts` config files.

- [ ] **Step 4: Fix the two test type errors**

Annotate the comparison operands in `src/tests/reconcile-contract.test.ts` as `string` so TypeScript checks runtime string behavior instead of rejecting disjoint literal types.

- [ ] **Step 5: Remove confirmed build warnings**

Change the CSS comment text to `--peach-*, --sage-*, --amber-*, --rose-*, --cream-*`; convert `postcss.config.js` to `module.exports`; remove the static `DEFAULT_FIREBASE_CONFIG` import from `useSync.ts` and pass nullable settings through to `configure`, whose production fallback already handles `null`.

- [ ] **Step 6: Make renderer type checking part of every build**

Add:

```json
"typecheck": "tsc -p tsconfig.json --noEmit",
"check": "npm run typecheck && npm test",
"build": "npm run typecheck && tsc -p tsconfig.node.json && vite build"
```

- [ ] **Step 7: Verify GREEN**

Run `npm run check`, `npm run build`, and the three log gates from Step 1. Expected: 22 test files / 458 tests, no worktree paths, no localStorage setup errors, no known build warnings.

---

### Task 2: macOS 재활성화와 Windows portable 업데이트 정책

**Files:**
- Create: `electron/updatePolicy.ts`
- Test: `tests/updaterLifecycle.test.ts`
- Modify: `electron/updater.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/components/UpdateBanner.tsx`

**Interfaces:**
- Produces: `getUpdateMode(isPackaged, isE2E, platform, portableExecutableFile): 'off' | 'auto' | 'manual'`.
- Produces: `attachUpdaterWindow(window: BrowserWindow): void`, called for every newly-created main window.
- Consumes: `PORTABLE_EXECUTABLE_FILE` set by electron-builder portable wrapper.

- [ ] **Step 1: Write failing production-policy tests**

Add tests importing `getUpdateMode` from production and assert: dev/E2E → `off`; packaged Windows NSIS → `auto`; packaged Windows with `PORTABLE_EXECUTABLE_FILE` → `manual`; packaged macOS → `manual`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/updaterLifecycle.test.ts --reporter=verbose`.

Expected: FAIL because `electron/updatePolicy.ts` and `getUpdateMode` do not exist.

- [ ] **Step 3: Implement the minimal policy**

Create the pure policy module and make `updater.ts` derive one mode once per setup. Only `auto` may set `autoDownload=true`, emit `update:ready`, or call `quitAndInstall`; `manual` emits `update:available` and opens the releases page.

- [ ] **Step 4: Write failing window reattachment and pending-delivery tests**

Using Electron mocks backed by `EventEmitter`, assert that replacing the attached main window removes the old focus listener, installs one on the new window, and delivers a manual update discovered with no window after the new renderer emits `did-finish-load`.

- [ ] **Step 5: Run focused tests and confirm RED**

Run `npx vitest run tests/updaterLifecycle.test.ts --reporter=verbose`.

Expected: policy tests pass; reattachment/pending tests fail against the current one-shot listener behavior.

- [ ] **Step 6: Implement window attachment and pending delivery**

Export `attachUpdaterWindow`; keep one active main-window focus listener; retain one pending manual payload only while no usable main window exists; send and clear it after the attached renderer is ready. Call `attachUpdaterWindow(mainWindow)` from `createWindow()` and use `mainWindow === null` rather than `BrowserWindow.getAllWindows()` for macOS Dock activation so hidden PDF windows do not suppress main-window recreation.

- [ ] **Step 7: Verify updater GREEN and regression suite**

Run `npx vitest run tests/updaterLifecycle.test.ts --reporter=verbose`, `npm run check`, and `npm run build`.

---

### Task 3: 실제 패키지 기반 macOS/Windows E2E와 거짓 PASS 제거

**Files:**
- Modify: `scripts/mac-e2e.mjs`
- Modify: `.github/workflows/build.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: optional `BABYDIARY_E2E_EXECUTABLE` absolute path.
- Produces: `npm run test:e2e` and platform CI jobs that launch unpacked packaged executables.

- [ ] **Step 1: Capture the existing RED evidence**

Run `node scripts/mac-e2e.mjs` and confirm the log contains `QuickMenu more button not found — skipping growth flow` while the process exits 0.

- [ ] **Step 2: Correct executable selection and strict assertions**

When `BABYDIARY_E2E_EXECUTABLE` is set, pass it as Playwright `executablePath` and omit `args: ['.']`. Use `.btn-add-record` for the actual quick menu trigger. Convert missing growth, sleep, breastfeeding guide, diary, and message controls from silent skips to recorded failures where the test setup guarantees their presence.

- [ ] **Step 3: Add package script and CI coverage**

Add `"test:e2e": "node scripts/mac-e2e.mjs"`. In macOS E2E build an unpacked universal app and launch its app executable. Add a Windows E2E job that builds `win-unpacked` x64 and launches `Baby Diary.exe`. Both jobs upload screenshots and `e2e-result.json` on every result.

- [ ] **Step 4: Verify Windows packaged GREEN locally**

Run:

```powershell
npm run build
npx electron-builder --win --dir --x64 --publish never
$env:BABYDIARY_E2E_EXECUTABLE = (Resolve-Path 'release/win-unpacked/Baby Diary.exe').Path
npm run test:e2e
Remove-Item Env:BABYDIARY_E2E_EXECUTABLE
```

Expected: growth recording is executed, no guaranteed flow is skipped, console error count is 0, exit code 0.

- [ ] **Step 5: Run final local verification**

Run `npm run check`, `npm run build`, unpacked Windows E2E, `git diff --check`, and inspect `git status --short` to ensure the pre-existing untracked plan remains untouched.
