import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const scriptPath = resolve(root, 'scripts/mac-in-place-upgrade-smoke.sh')
const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : ''

function shellFunction(name: string) {
  const lines = script.split('\n')
  const start = lines.findIndex(line => line === `${name}() {`)
  if (start < 0) return ''
  let depth = 0
  for (let index = start; index < lines.length; index += 1) {
    const structural = lines[index].replace(/\$\{[^}]*\}/g, '')
    depth += (structural.match(/{/g) ?? []).length
    depth -= (structural.match(/}/g) ?? []).length
    if (depth === 0) return lines.slice(start, index + 1).join('\n')
  }
  return ''
}

describe('macOS v0.3.8 -> v0.3.9 in-place upgrade wrapper', () => {
  it('pins the exact public universal baseline and records legacy trust without requiring it', () => {
    expect(script).toContain('baseline_release_id=352876543')
    expect(script).toContain('baseline_asset_id=474869787')
    expect(script).toContain("baseline_asset_name='Baby-Diary-0.3.8-universal.dmg'")
    expect(script).toContain('baseline_asset_size=351533375')
    expect(script).toContain("baseline_asset_sha256='2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974'")
    expect(script).toContain("baseline_source_sha='4ad44829c0de56da33d9123c16f92e6090f0df4a'")
    expect(script).toContain('record_baseline_legacy_trust')
    expect(script).toContain('baseline-legacy-trust.json')
  })

  it('verifies and mounts both DMGs read-only, requiring exact version and universal slices', () => {
    expect(script).toMatch(/hdiutil verify "\$baseline_dmg"/)
    expect(script).toMatch(/hdiutil verify "\$candidate_dmg"/)
    expect(script.match(/hdiutil attach -readonly -nobrowse/g)?.length).toBe(2)
    expect(script).toContain('CFBundleShortVersionString')
    expect(script).toContain('lipo -archs')
    expect(script).toContain('arm64 x86_64')
    expect(script).toContain('uname -m')
    expect(script).toContain('macos-15')
    expect(script).toContain('macos-15-intel')
  })

  it('requires candidate codesign, Gatekeeper, notarization staple, and exact Team ID before replacement', () => {
    const trustIndex = script.indexOf('verify_candidate_trust "$candidate_source_app"')
    const baselineCopyIndex = script.indexOf('copy_baseline_into_place')
    expect(trustIndex).toBeGreaterThan(-1)
    expect(baselineCopyIndex).toBeGreaterThan(trustIndex)
    expect(script).toContain('codesign --verify --deep --strict --verbose=4')
    expect(script).toContain('spctl --assess --type execute --verbose=4')
    expect(script).toContain('xcrun stapler validate')
    expect(script).toContain('TeamIdentifier=')
    expect(script).toMatch(/candidate Team ID mismatch/i)
  })

  it('requires and prints an exact CI provenance binding before mounting candidate bytes', () => {
    expect(script).toContain('--candidate-package-sha256')
    expect(script).toContain('--candidate-provenance')
    expect(script).toContain('--expected-repository')
    expect(script).toContain('--expected-workflow-run-id')
    expect(script).toContain("'verify-provenance'")
    expect(script).toContain("'--expected-release-tag' 'v0.3.9'")
    expect(script).toContain("'--expected-platform' 'mac-universal'")
    expect(script).toMatch(/candidate package SHA-256 must be 64 lowercase hexadecimal/i)
    expect(script).toMatch(/verified candidate provenance binding/i)
    const provenanceIndex = script.indexOf('verify_candidate_provenance')
    const mountIndex = script.indexOf('hdiutil attach -readonly')
    expect(provenanceIndex).toBeGreaterThan(-1)
    expect(mountIndex).toBeGreaterThan(provenanceIndex)
  })

  it('uses the canonical temp HOME profile, same app path, and byte-identical pre-first-run manifest', () => {
    expect(script).toContain('export HOME="$temporary_home"')
    expect(script).toContain("Library/Application Support/baby-diary")
    expect(script).toContain("Applications/Baby Diary.app")
    expect(script).not.toContain('BABYDIARY_TEST_USERDATA')
    expect(script).toContain("'manifest'")
    expect(script).toContain("'compare-manifest'")
    const compareIndex = script.indexOf('assert_profile_matches_baseline')
    const firstRunIndex = script.indexOf("'candidate-first-run'")
    expect(compareIndex).toBeGreaterThan(-1)
    expect(firstRunIndex).toBeGreaterThan(compareIndex)
  })

  it('runs baseline/first/second and existing normal/sync E2E against the exact candidate executable', () => {
    expect(script).toContain("'baseline-initialize'")
    expect(script).toContain("'candidate-first-run'")
    expect(script).toContain("'candidate-second-run'")
    expect(script).toContain('BABYDIARY_E2E_EXECUTABLE="$candidate_executable"')
    expect(script).toContain('BABYDIARY_SYNC_E2E_EXECUTABLE="$candidate_executable"')
    expect(script).toContain('BABYDIARY_SYNC_E2E_UPGRADE_PROFILE="$canonical_profile"')
    expect(script).toContain('npm run test:e2e')
    expect(script).toContain('npm run test:e2e:sync')
  })

  it('uses distinct interruption seams, ordinary/injected invariants, and a clean staging retry', () => {
    for (const point of [
      'after-baseline-close',
      'after-manifest-creation',
      'before-candidate-replacement',
      'during-candidate-replacement',
      'after-candidate-replacement',
      'before-candidate-first-launch',
    ]) expect(script).toContain(`'${point}'`)
    expect(script).toContain('simulate_interrupted_staging_copy')
    expect(script).toContain('interrupted-staging.app')
    expect(script).toContain('baseline_executable_sha256')
    expect(script).toContain('baseline_manifest_created')
    expect(script).toContain('candidate_first_launch_started')
    expect(script).toContain('retry_candidate_staging')
    expect(script).toContain('assert_failure_invariant')
    expect(script).toContain('scrub_diagnostic_secrets')
    expect(script).toContain('trap cleanup EXIT')
  })

  it('bounds driver/npm/mount cleanup and distinguishes timeout cleanup from interruption cleanup', () => {
    expect(script).toContain('run_bounded')
    expect(script).toContain('phase_timeout_seconds=')
    expect(script).toContain('npm_timeout_seconds=')
    expect(script).toContain('cleanup_timeout_seconds=')
    expect(script).toContain('active_process_group')
    expect(script).toContain('termination_kind=timeout')
    expect(script).toContain('termination_kind=interruption')
    expect(script).toContain("kill -TERM -- \"-$active_process_group\"")
    expect(script).toContain("kill -KILL -- \"-$active_process_group\"")
    expect(script).toContain("trap 'on_interrupt 130' INT")
    expect(script).toContain("trap 'on_interrupt 143' TERM")
    expect(script).toMatch(/exceeded its bounded timeout/i)
  })

  it.runIf(process.platform !== 'win32')('parses as valid bash', () => {
    const result = spawnSync('bash', ['-n', scriptPath], { cwd: root, encoding: 'utf8' })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('terminates and reaps a real process group after timeout', () => {
    const harness = [
      'set -Eeuo pipefail',
      'cleanup_timeout_seconds=2',
      "active_process_group=''",
      "termination_kind='none'",
      shellFunction('terminate_active_process_group'),
      shellFunction('run_bounded'),
      'set +e',
      "run_bounded 1 'synthetic sleep' sleep 30",
      'status=$?',
      'set -e',
      '[[ $status -eq 124 ]]',
      '[[ $termination_kind == timeout ]]',
      '[[ -z $active_process_group ]]',
    ].filter(Boolean).join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('retries one ordinary staging failure and checks ordinary and injected invariants', () => {
    const harness = [
      'set -Eeuo pipefail',
      shellFunction('retry_candidate_staging'),
      shellFunction('assert_failure_invariant'),
      'attempts=0',
      'invariants=0',
      'failure_injected=false',
      'simulate_interrupted_staging_copy() { return 0; }',
      'stage_candidate_once() { attempts=$((attempts + 1)); ((attempts > 1)); }',
      'assert_profile_matches_baseline() { invariants=$((invariants + 1)); }',
      'retry_candidate_staging',
      '[[ $attempts -eq 2 && $invariants -eq 1 ]]',
      'baseline_manifest_created=true',
      'candidate_first_launch_started=false',
      'failure_injected=false',
      'assert_failure_invariant',
      'failure_injected=true',
      'assert_failure_invariant',
      'candidate_first_launch_started=true',
      'assert_failure_invariant',
      '[[ $invariants -eq 3 ]]',
    ].filter(Boolean).join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('never deletes through an intermediate symlink into an external sentinel', () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'baby-diary-mac-cleanup-root-'))
    const external = mkdtempSync(join(tmpdir(), 'baby-diary-mac-cleanup-external-'))
    const victim = join(external, 'victim')
    const sentinel = join(victim, 'external-sentinel.txt')
    const linkedParent = join(runRoot, 'linked-parent')
    try {
      mkdirSync(victim)
      writeFileSync(sentinel, 'outside-run-root')
      symlinkSync(external, linkedParent, 'dir')
      const harness = [
        'set -Eeuo pipefail',
        'run_root=$1',
        shellFunction('assert_run_owned_mutation_path'),
        shellFunction('remove_run_owned_path'),
        'remove_run_owned_path "$2" || true',
      ].filter(Boolean).join('\n')
      const result = spawnSync('bash', ['-c', harness, 'cleanup-contract', runRoot, join(linkedParent, 'victim')], {
        encoding: 'utf8',
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(readFileSync(sentinel, 'utf8')).toBe('outside-run-root')
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })
})
