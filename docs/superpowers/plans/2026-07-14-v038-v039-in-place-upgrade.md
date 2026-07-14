# v0.3.8 -> v0.3.9 In-Place Upgrade and Data-Preservation Gate

## Goal

Prove on the actual packaged applications that upgrading Baby Diary from the immutable
`v0.3.8` source commit (`4ad44829c0de56da33d9123c16f92e6090f0df4a`) to the
candidate `v0.3.9` bytes does not delete, replace, or semantically lose user data. The
same release gate must exercise Windows x64, macOS Apple Silicon, and macOS Intel.

This is a release-blocking test. A unit test, unpacked Electron directory, fresh
`BABYDIARY_TEST_USERDATA`, or source-code assertion cannot substitute for it.

## Non-negotiable invariants

1. The baseline is the exact immutable package that users actually received from the
   published `baby-diary-releases/v0.3.8` release, pinned by release ID, asset ID, byte
   length, and SHA-256. Rebuilding or newly signing v0.3.8 would test different bytes
   and is therefore not an acceptable substitute. The v0.3.9 candidate is built in the
   protected signing workflow and signed by the expected platform identity.
2. `appId`, NSIS uninstall GUID/key, install location, and the canonical user-data
   leaf `baby-diary` stay stable. Record the released display metadata truthfully:
   v0.3.8 uses `Baby Diary 0.3.8` and the Korean shortcut `베이비 다이어리`, while
   v0.3.9 intentionally converges to publisher `HB-code-glitch`, display name
   `Baby Diary`, and shortcut `Baby Diary`. After the in-place upgrade there must be
   exactly one candidate shortcut and no surviving legacy Korean shortcut.
3. A clean CI user/profile is mandatory. The scripts fail closed if another Baby Diary
   install or an unexpected canonical data directory exists.
4. The baseline application is installed/copied and launched only under a disposable
   OS account/VM/ephemeral CI runner. It must receive a nonce-owned canonical
   `BABYDIARY_TEST_USERDATA`, and main-process attestation must prove
   `app.getPath('userData')` equals that directory before any UI action. `APPDATA` or
   `HOME` redirection alone is explicitly insufficient and must never be used as the
   ownership boundary.
5. The fixture includes Korean and Japanese text, profile/account identity, Unicode
   family code, baby identity, all event kinds, binary-like/photo data if supported by
   v0.3.8, multiple revisions, a tombstone, an acknowledged mutation, a pending
   mutation, and a legacy record missing the newer mutation fields.
6. After the baseline process is closed and the fixture is durable, record a complete
   recursive manifest of the canonical user-data directory: relative path, entry type,
   byte length, and SHA-256. Reject symlinks/reparse points, path traversal, duplicate
   normalized paths, unexpected sockets/devices, and files above the test cap.
7. Install/copy the v0.3.9 application in place but do not launch it. The full raw
   user-data manifest must be byte-for-byte identical. This catches installer-side
   deletion before any migration can obscure it.
8. Launch v0.3.9 against the same canonical directory. After a clean exit, compare a
   deterministic semantic projection: every original event/revision/tombstone,
   pending/ack state, account/family/baby value, and opaque supported payload survives.
   New migration metadata is allowed; disappearance or value substitution is not.
9. A second v0.3.9 launch must be idempotent: no duplicate migration derivatives,
   resurrected tombstones, lost pending work, or changed winner.
10. The existing packaged normal E2E and real two-device Firebase Emulator E2E still
    run against the exact candidate executable that passed the upgrade check.
11. Windows must have exactly one applicable `Baby Diary.lnk`. Resolve it through the
    Shell COM API and require exact candidate `TargetPath`, empty arguments, and the
    candidate install directory as `WorkingDirectory`. A text/filename check is not
    sufficient.
12. Any failure preserves the temp profile as a diagnostic artifact but scrubs auth
    secrets. Cleanup removes only paths created beneath the run-owned temp root and the
    clean-runner installation discovered by exact uninstall identity.
13. Authentication continuity is proven by Firebase itself, not by a synthetic JSON
    sentinel. The exact v0.3.8 application signs up against loopback Auth/Firestore
    emulators, creates or joins a family, writes one online event and one offline
    pending event, and exits. v0.3.9 must resume the same Auth user and Firebase app
    persistence namespace without showing signed-out UI, clearing `familyId`, or
    creating a replacement account/family. The pending event drains exactly once and
    a second v0.3.9 launch stays signed in.

## Artifact and source binding

- Source tag `v0.3.8` must still peel to
  `4ad44829c0de56da33d9123c16f92e6090f0df4a`; fail on a moved/replaced tag.
- Fetch the public historical release by exact release ID `352876543`, not by "latest".
  Require tag `v0.3.8`, published timestamp `2026-07-13T00:17:33Z`, and only download
  the following exact asset IDs through the GitHub release-asset API:
  - Windows asset ID `474870034`, `Baby-Diary-Setup-0.3.8.exe`, 233249330 bytes,
    SHA-256 `edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de`.
  - Mac asset ID `474869787`, `Baby-Diary-0.3.8-universal.dmg`, 351533375 bytes,
    SHA-256 `2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974`.
- v0.3.8 was historically published without the new production signing gate. Its
  missing/old signature state is recorded truthfully and accepted only for this
  compatibility input; it must never be republished or presented as newly trusted.
- Verify the candidate signature, timestamp/certificate identity, package architecture,
  version, and notarization before the upgrade begins. Verify baseline architecture and
  version plus the immutable digest/size contract above.
- Store downloads under an explicit `upgrade-baseline-v0.3.8/` directory so no glob
  used by manifest/upload jobs can consume them. Retain them for at most one day.

## Implementation tasks

### Task 1: Pure fixture and manifest contract (TDD)

Create `scripts/upgrade-data-contract.mjs` and
`tests/upgradeDataContract.test.ts`.

- Build/validate the v0.3.8-compatible fixture from explicit constants.
- Recursively stream hashes instead of retaining all file bytes.
- Canonically sort paths using byte-stable POSIX separators.
- Export raw-manifest comparison and post-migration semantic projection helpers.
- RED cases: one missing byte, extra file, case collision, symlink/reparse point,
  traversal, oversized file/tree, duplicate mutation derivative, tombstone
  resurrection, pending->missing, account/family substitution, and reordered JSON keys.
- Reordered object keys may change the raw manifest but must compare equal only in the
  post-first-launch semantic projection.

### Task 2: Packaged upgrade driver

Create `scripts/upgrade-e2e.mjs` as the shared Playwright/Electron driver.

- Modes: `baseline-initialize`, `candidate-first-run`, `candidate-second-run`.
- Receive an exact executable and canonical profile root from the platform wrapper.
- Never accept the real home/profile or a path outside the wrapper's nonce-bound temp
  root. Resolve and reject links before launch.
- Do not log passwords, Firebase API material, auth tokens, or fixture secrets.
- Capture a small JSON diagnostic containing source SHA, executable SHA, app version,
  host architecture, canonical user-data path, fixture projection hash, and phase.
- A child exit code of zero is never phase evidence by itself. Each invocation must
  publish a nonce/run-id-bound diagnostic, profile manifest, network-guard counters,
  and phase projection; the wrapper validates all four before continuing. Missing,
  empty, stale, or mismatched evidence fails even when the child returned zero. Cover
  Windows junction/realpath entry-point resolution so an `import.meta.url` direct-run
  check cannot silently skip the driver body.
- Use bounded timeouts and always close Electron/browser processes.
- Before baseline launch, persist an emulator Firebase configuration through the same
  canonical profile that the published app reads. From process start, reject every
  non-loopback network request. At CDP request stage, rewrite only Identity Toolkit,
  Secure Token, and Firestore/WebChannel traffic to the loopback emulators while
  preserving protocol paths and streaming behavior. If exact published bits cannot be
  driven this way, fail the release gate and retain a redacted diagnostic; a rebuilt or
  source-patched v0.3.8 package is not equivalent evidence.
- Capture the baseline Firebase `uid`, email, family identity, invite/member state,
  server event identity, and durable offline pending identity. Candidate first and
  second runs compare those values exactly and also verify convergence from a separate
  emulator client/device. A fallback flow that signs up again is an unconditional
  failure even if later UI state looks healthy.

### Task 3: Windows in-place wrapper (TDD where pure seams exist)

Create `scripts/windows-in-place-upgrade-smoke.ps1` and extend
`tests/installedReleaseSmoke.test.ts` (or a focused new contract test).

- Inputs: digest-pinned historical baseline Setup, signed candidate Setup, expected publisher Subject,
  expected certificate SHA-256, expected baseline/candidate versions.
- Refuse an existing uninstall entry or canonical data directory. `APPDATA`, `HOME`, or
  `user-data-dir` redirection alone is not isolation evidence: the published v0.3.8
  process may still resolve Electron `app.getPath('userData')` to the interactive user's
  real profile. The wrapper must set the released app's supported
  `BABYDIARY_TEST_USERDATA` override to a nonce-owned canonical directory and verify the
  process-reported path before any UI action. If that override cannot be proven, run only
  under a disposable OS account/VM/ephemeral CI runner and fail locally.
- Resolve the interactive user's real Baby Diary profile independently and reject any
  equality, containment, junction, reparse-point, or same-file relationship with the
  run root. Snapshot its metadata before launch and require byte/metadata non-interference
  afterward; the harness never repairs or cleans a non-run-owned profile.
- Install baseline silently, locate the executable through the exact uninstall entry,
  run baseline initialization using the verified test user-data override, and close it.
- Capture the raw manifest, run candidate Setup silently, require one unchanged install
  identity/location, and compare the pre-first-run manifest.
- Resolve Desktop and Common Desktop shortcut candidates via `WScript.Shell`; require
  exactly one effective shortcut with the exact fields in invariant 11.
- Run candidate first/second launch checks, then the existing normal and sync E2E.
- In `finally`, uninstall and verify both registry identity and install directory are
  gone. Preserve user-data diagnostics only on failure; delete the run-owned temp root
  on success.

### Task 4: macOS in-place wrapper

Create `scripts/mac-in-place-upgrade-smoke.sh` and a focused contract test.

- Inputs: digest-pinned historical baseline universal DMG, signed/notarized candidate
  universal DMG, native host architecture, expected versions/team identity.
- Verify both DMGs and mount read-only. For the historical baseline, require its pinned
  digest/size, version, and universal `arm64 x86_64` slices and record its actual legacy
  trust state. For the candidate, additionally require app bundle signature, Gatekeeper
  assessment, notarization staple, and exact Team ID.
- Copy baseline to one temp `Applications/Baby Diary.app`; a temp `HOME` is defense in
  depth, not the ownership boundary. Set and verify `BABYDIARY_TEST_USERDATA` (or use a
  disposable macOS user/VM if the released binary does not honor it), then seed/capture
  the canonical
  `Library/Application Support/baby-diary` manifest.
- Replace the app at the same path with the candidate while the app is closed. Before
  first launch, require an identical full user-data manifest.
- Run first/second launch semantic checks plus existing normal and sync E2E on the exact
  installed candidate executable.
- Execute independently on `macos-15` and `macos-15-intel`.

### Task 5: Interruption and recovery evidence

- At pure wrapper seams, inject failures after baseline close, after manifest creation,
  after candidate replacement, and before candidate first launch. Every case must leave
  the raw user-data manifest unchanged and permit a clean retry.
- On macOS, additionally simulate an interrupted bundle copy into a separate staging
  path; it must never replace the installed bundle or touch user data.
- On Windows, do not add a timing-flaky process-kill test. Instead require NSIS success
  before accepting the candidate executable and prove every wrapper failure path leaves
  the canonical data directory untouched. The application-level backup/recovery tests
  cover power-loss boundaries inside data migrations.

### Task 6: Protected CI graph

Modify `.github/workflows/build.yml` and its workflow contract tests only after the
Firestore/security workflow changes have landed.

- A small baseline-fetch job runs only for a tag release or explicit signed dry-run,
  verifies the exact historical release/asset constants, and uploads isolated one-day
  test artifacts. It needs no write token or signing secret.
- Upgrade jobs depend on the verified baseline inputs and signed candidate artifacts.
- `manifest-mac`, `manifest-win`, upload, and publish transitively require all three
  platform upgrade jobs.
- Ordinary PR CI keeps its unsigned fresh-install E2E and must not request signing
  secrets.
- Baseline artifacts never appear in release staging, manifests, alias generation, or
  upload inputs.

### Task 7: Verification and independent review

Run locally available pure tests and typechecks, then push the branch and require:

- security/check job green;
- Windows signed upgrade green;
- Apple Silicon signed upgrade green;
- Intel Mac signed upgrade green;
- packaged normal and two-device sync E2E green on the candidate bytes;
- release asset/provenance workflow tests green;
- independent Critical/Important/Minor review `0/0/0`.

The signed jobs will remain intentionally blocked until the real Apple and Windows
credentials are present in `platform-release-signing`. Never weaken the gate or publish
unsigned artifacts to work around missing credentials.

## Final Desktop handoff

Only after the official `v0.3.9` release is published and its immutable manifest is
re-fetched:

1. Download the official Windows Setup asset to a nonce staging file on the user's
   Desktop volume.
2. Verify exact size/SHA-256 from the published manifest and the full expected
   Authenticode Subject plus certificate SHA-256.
3. Atomically rename it to `Baby-Diary-Setup-0.3.9.exe`.
4. Re-read and verify the final path.
5. Remove only the specifically verified old
   `Baby-Diary-Setup-0.3.8.exe`; do not glob or delete unrelated Desktop files.
