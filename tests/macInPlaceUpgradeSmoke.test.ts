import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const scriptPath = resolve(root, 'scripts/mac-in-place-upgrade-smoke.sh')
const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : ''

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
    expect(script).toContain('npm run test:e2e')
    expect(script).toContain('npm run test:e2e:sync')
  })

  it('uses deterministic interruption seams and a separate partial staging copy without process kills', () => {
    for (const point of [
      'after-baseline-close',
      'after-manifest-creation',
      'after-candidate-replacement',
      'before-candidate-first-launch',
    ]) expect(script).toContain(`'${point}'`)
    expect(script).toContain('simulate_interrupted_staging_copy')
    expect(script).toContain('interrupted-staging.app')
    expect(script).toContain('baseline_executable_sha256')
    expect(script).toContain('assert_failure_invariant')
    expect(script).toContain('scrub_diagnostic_secrets')
    expect(script).toContain('trap cleanup EXIT')
    expect(script).not.toMatch(/kill\s|pkill|killall|process\.kill/i)
  })

  it.runIf(process.platform !== 'win32')('parses as valid bash', () => {
    const result = spawnSync('bash', ['-n', scriptPath], { cwd: root, encoding: 'utf8' })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })
})
