#!/usr/bin/env bash
set -Eeuo pipefail

# This wrapper is executed independently by signed CI on macos-15 and
# macos-15-intel. It never rebuilds or re-signs the historical input.
baseline_release_id=352876543
baseline_asset_id=474869787
baseline_asset_name='Baby-Diary-0.3.8-universal.dmg'
baseline_asset_size=351533375
baseline_asset_sha256='2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974'
baseline_source_sha='4ad44829c0de56da33d9123c16f92e6090f0df4a'

baseline_dmg=''
candidate_dmg=''
expected_host_arch=''
expected_team_id=''
candidate_source_sha=''
expected_baseline_version='0.3.8'
expected_candidate_version='0.3.9'
failure_point='none'

usage() {
  echo 'usage: mac-in-place-upgrade-smoke.sh --baseline-dmg PATH --candidate-dmg PATH --expected-host-arch arm64|x86_64 --expected-team-id TEAMID --candidate-source-sha SHA [--failure-point POINT]' >&2
}

while (($# > 0)); do
  case "$1" in
    --baseline-dmg) baseline_dmg=${2-}; shift 2 ;;
    --candidate-dmg) candidate_dmg=${2-}; shift 2 ;;
    --expected-host-arch) expected_host_arch=${2-}; shift 2 ;;
    --expected-team-id) expected_team_id=${2-}; shift 2 ;;
    --candidate-source-sha) candidate_source_sha=${2-}; shift 2 ;;
    --expected-baseline-version) expected_baseline_version=${2-}; shift 2 ;;
    --expected-candidate-version) expected_candidate_version=${2-}; shift 2 ;;
    --failure-point) failure_point=${2-}; shift 2 ;;
    *) usage; echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$baseline_dmg" && -n "$candidate_dmg" && -n "$expected_host_arch" \
  && -n "$expected_team_id" && -n "$candidate_source_sha" ]] || { usage; exit 2; }
[[ "$expected_baseline_version" == '0.3.8' ]] || { echo 'only the pinned v0.3.8 baseline is accepted' >&2; exit 2; }
[[ "$expected_candidate_version" == '0.3.9' ]] || { echo 'only a v0.3.9 candidate is accepted' >&2; exit 2; }
[[ "$candidate_source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'candidate source SHA must be 40 lowercase hexadecimal characters' >&2; exit 2; }
[[ "$expected_team_id" =~ ^[A-Z0-9]{10}$ ]] || { echo 'candidate Team ID must be exactly ten uppercase alphanumeric characters' >&2; exit 2; }
case "$expected_host_arch" in
  arm64|x86_64) ;;
  *) echo 'expected host architecture must be arm64 or x86_64' >&2; exit 2 ;;
esac
case "$failure_point" in
  'none'|'after-baseline-close'|'after-manifest-creation'|'after-candidate-replacement'|'before-candidate-first-launch') ;;
  *) echo 'invalid deterministic failure point' >&2; exit 2 ;;
esac

for command_name in node npm hdiutil shasum stat uuidgen codesign spctl xcrun lipo; do
  command -v "$command_name" >/dev/null || { echo "required command is unavailable: $command_name" >&2; exit 2; }
done

canonical_regular_file() {
  local supplied=$1
  [[ -f "$supplied" && ! -L "$supplied" ]] || { echo "expected a non-linked regular file: $supplied" >&2; return 1; }
  local directory base
  directory=$(cd "$(dirname "$supplied")" && pwd -P)
  base=$(basename "$supplied")
  printf '%s/%s\n' "$directory" "$base"
}

baseline_dmg=$(canonical_regular_file "$baseline_dmg")
candidate_dmg=$(canonical_regular_file "$candidate_dmg")
[[ "$(basename "$baseline_dmg")" == "$baseline_asset_name" ]] || { echo 'baseline DMG filename does not match the pinned release asset' >&2; exit 2; }
[[ "$(basename "$candidate_dmg")" == "Baby-Diary-${expected_candidate_version}-universal.dmg" ]] || { echo 'candidate DMG filename is not the exact universal release name' >&2; exit 2; }
[[ "$(uname -m)" == "$expected_host_arch" ]] || { echo 'native runner architecture does not match --expected-host-arch' >&2; exit 2; }

original_home=${HOME:?runner HOME is required}
original_canonical_profile="$original_home/Library/Application Support/baby-diary"
[[ ! -e "$original_canonical_profile" && ! -L "$original_canonical_profile" ]] || {
  echo 'refusing to run with a pre-existing canonical Baby Diary data directory' >&2
  exit 2
}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
upgrade_driver="$repo_root/scripts/upgrade-e2e.mjs"
data_contract="$repo_root/scripts/upgrade-data-contract.mjs"
run_id=$(uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]')
[[ "$run_id" =~ ^[0-9a-f]{32}$ ]] || { echo 'uuidgen did not produce a lowercase 32-hex nonce' >&2; exit 2; }
temp_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
run_root=$(mktemp -d "$temp_parent/baby-diary-upgrade-${run_id}.XXXXXX")
run_root=$(cd "$run_root" && pwd -P)

temporary_home="$run_root/home"
applications_root="$run_root/Applications"
installed_app="$run_root/Applications/Baby Diary.app"
candidate_ready_app="$run_root/candidate-ready.app"
retired_baseline_app="$run_root/retired-baseline.app"
interrupted_staging_app="$run_root/interrupted-staging.app"
baseline_mount="$run_root/baseline-mount"
candidate_mount="$run_root/candidate-mount"
canonical_profile="$temporary_home/Library/Application Support/baby-diary"
baseline_projection="$run_root/baseline-projection.json"
first_projection="$run_root/candidate-first-projection.json"
second_projection="$run_root/candidate-second-projection.json"
baseline_manifest="$run_root/baseline-raw-manifest.json"
baseline_executable_sha256=''
candidate_executable=''
baseline_mounted=false
candidate_mounted=false
failure_injected=false
failure_assertion_running=false
success=false

mkdir -p "$temporary_home" "$applications_root" "$baseline_mount" "$candidate_mount"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"
}

assert_universal_app() {
  local app_path=$1 expected_version=$2 executable archs normalized_archs
  [[ -d "$app_path" && ! -L "$app_path" && "$(basename "$app_path")" == 'Baby Diary.app' ]] || {
    echo "invalid Baby Diary app bundle: $app_path" >&2
    return 1
  }
  [[ "$(plist_value "$app_path" CFBundleIdentifier)" == 'com.family.babydiary' ]] || {
    echo 'Baby Diary bundle identifier changed' >&2
    return 1
  }
  [[ "$(plist_value "$app_path" CFBundleShortVersionString)" == "$expected_version" ]] || {
    echo "Baby Diary CFBundleShortVersionString is not $expected_version" >&2
    return 1
  }
  [[ "$(plist_value "$app_path" CFBundleExecutable)" == 'Baby Diary' ]] || {
    echo 'Baby Diary executable identity changed' >&2
    return 1
  }
  executable="$app_path/Contents/MacOS/Baby Diary"
  [[ -f "$executable" && ! -L "$executable" ]] || { echo 'app executable is not a non-linked regular file' >&2; return 1; }
  archs=$(lipo -archs "$executable")
  normalized_archs=$(printf '%s\n' $archs | LC_ALL=C sort | paste -sd ' ' -)
  [[ "$normalized_archs" == 'arm64 x86_64' ]] || {
    echo "Baby Diary executable is not universal arm64 x86_64: $normalized_archs" >&2
    return 1
  }
}

record_baseline_legacy_trust() {
  local app_path=$1 output_path=$2 codesign_exit spctl_exit stapler_exit
  set +e
  codesign --verify --deep --strict --verbose=4 "$app_path" >/dev/null 2>&1
  codesign_exit=$?
  spctl --assess --type execute --verbose=4 "$app_path" >/dev/null 2>&1
  spctl_exit=$?
  xcrun stapler validate "$app_path" >/dev/null 2>&1
  stapler_exit=$?
  set -e
  printf '{"version":1,"releaseId":%d,"assetId":%d,"assetName":"%s","sourceSha":"%s","sha256":"%s","trustPolicy":"legacy-input-evidence-only","codesignVerifyExit":%d,"gatekeeperAssessExit":%d,"staplerValidateExit":%d}\n' \
    "$baseline_release_id" "$baseline_asset_id" "$baseline_asset_name" "$baseline_source_sha" \
    "$baseline_asset_sha256" "$codesign_exit" "$spctl_exit" "$stapler_exit" >"$output_path"
  chmod 600 "$output_path"
}

verify_candidate_trust() {
  local app_path=$1 actual_team_id
  codesign --verify --deep --strict --verbose=4 "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
  xcrun stapler validate "$app_path"
  actual_team_id=$(codesign -dv --verbose=4 "$app_path" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [[ "$actual_team_id" == "$expected_team_id" ]] || {
    echo "candidate Team ID mismatch: expected $expected_team_id" >&2
    return 1
  }
}

invoke_upgrade_phase() {
  local mode=$1 executable=$2 expected_version=$3 source_sha=$4 diagnostic=$5 projection=$6 comparison=${7-}
  local expected_driver_arch='x64'
  [[ "$expected_host_arch" == 'arm64' ]] && expected_driver_arch='arm64'
  local arguments=(
    "$upgrade_driver"
    '--mode' "$mode"
    '--executable' "$executable"
    '--profile-root' "$canonical_profile"
    '--temp-root' "$run_root"
    '--run-id' "$run_id"
    '--diagnostic' "$diagnostic"
    '--projection-output' "$projection"
    '--source-sha' "$source_sha"
    '--expected-version' "$expected_version"
    '--expected-arch' "$expected_driver_arch"
    '--forbidden-root' "$original_canonical_profile"
  )
  [[ -z "$comparison" ]] || arguments+=( '--comparison-projection' "$comparison" )
  node "${arguments[@]}"
}

new_baseline_manifest() {
  node "$data_contract" 'manifest' '--root' "$canonical_profile" '--output' "$baseline_manifest"
}

assert_profile_matches_baseline() {
  [[ -f "$baseline_manifest" ]] || { echo 'baseline raw manifest is unavailable' >&2; return 1; }
  node "$data_contract" 'compare-manifest' '--root' "$canonical_profile" '--before' "$baseline_manifest"
}

invoke_failure_point() {
  local point=$1
  if [[ "$failure_point" == "$point" ]]; then
    failure_injected=true
    echo "injected deterministic wrapper failure at $point" >&2
    return 97
  fi
}

assert_failure_invariant() {
  [[ "$failure_injected" == true ]] || return 0
  assert_profile_matches_baseline
}

remove_run_owned_path() {
  local target=$1
  case "$target" in
    "$run_root"/*) ;;
    *) echo "refusing to remove a path outside the run-owned root: $target" >&2; return 1 ;;
  esac
  [[ ! -e "$target" && ! -L "$target" ]] || rm -rf -- "$target"
}

simulate_interrupted_staging_copy() {
  remove_run_owned_path "$interrupted_staging_app"
  mkdir -p "$interrupted_staging_app/Contents/MacOS"
  /usr/bin/ditto "$candidate_source_app/Contents/Info.plist" "$interrupted_staging_app/Contents/Info.plist"
  dd if="$candidate_source_executable" of="$interrupted_staging_app/Contents/MacOS/Baby Diary" bs=4096 count=1 2>/dev/null
  [[ "$(sha256_file "$installed_app/Contents/MacOS/Baby Diary")" == "$baseline_executable_sha256" ]] || {
    echo 'interrupted staging copy changed the installed baseline executable' >&2
    return 1
  }
  [[ "$(plist_value "$installed_app" CFBundleShortVersionString)" == "$expected_baseline_version" ]] || {
    echo 'interrupted staging copy replaced the installed baseline bundle' >&2
    return 1
  }
  assert_profile_matches_baseline
  remove_run_owned_path "$interrupted_staging_app"
}

scrub_diagnostic_secrets() {
  local settings_path="$canonical_profile/settings.json"
  if [[ -f "$settings_path" && ! -L "$settings_path" ]]; then
    if ! node -e 'const fs=require("fs");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p,"utf8"));if(Object.prototype.hasOwnProperty.call(v,"firebase"))v.firebase=null;fs.writeFileSync(p,JSON.stringify(v,null,2)+"\n",{mode:0o600});' "$settings_path"; then
      rm -f -- "$settings_path"
    fi
  fi
  local relative
  for relative in 'Local Storage' 'Session Storage' 'IndexedDB' 'Network' 'WebStorage' 'Cookies'; do
    remove_run_owned_path "$canonical_profile/$relative"
  done
  printf '{"version":1,"scrubbed":true,"removedAuthStores":true,"firebaseConfigRedacted":true}\n' >"$run_root/secrets-scrubbed.json"
  chmod 600 "$run_root/secrets-scrubbed.json"
}

remove_run_owned_root() {
  local resolved_parent resolved_name
  resolved_parent=$(cd "$(dirname "$run_root")" && pwd -P)
  resolved_name=$(basename "$run_root")
  [[ "$resolved_parent" == "$temp_parent" && "$resolved_name" == baby-diary-upgrade-"$run_id".* ]] || {
    echo 'refusing to remove a root not bound to this run nonce' >&2
    return 1
  }
  rm -rf -- "$run_root"
}

on_error() {
  local status=$?
  if [[ "$failure_injected" == true && "$failure_assertion_running" == false ]]; then
    failure_assertion_running=true
    assert_failure_invariant || status=$?
  fi
  return "$status"
}

cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT ERR
  set +e
  if [[ "$candidate_mounted" == true ]]; then
    if hdiutil detach "$candidate_mount" >/dev/null 2>&1; then candidate_mounted=false; else cleanup_status=1; fi
  fi
  if [[ "$baseline_mounted" == true ]]; then
    if hdiutil detach "$baseline_mount" >/dev/null 2>&1; then baseline_mounted=false; else cleanup_status=1; fi
  fi
  export HOME="$original_home"
  if [[ "$success" == true && $cleanup_status -eq 0 ]]; then
    remove_run_owned_root || cleanup_status=$?
  else
    remove_run_owned_path "$installed_app" || cleanup_status=$?
    remove_run_owned_path "$candidate_ready_app" || cleanup_status=$?
    remove_run_owned_path "$retired_baseline_app" || cleanup_status=$?
    remove_run_owned_path "$interrupted_staging_app" || cleanup_status=$?
    [[ "$candidate_mounted" == true ]] || rmdir "$candidate_mount" >/dev/null 2>&1
    [[ "$baseline_mounted" == true ]] || rmdir "$baseline_mount" >/dev/null 2>&1
    scrub_diagnostic_secrets || cleanup_status=$?
    echo "upgrade diagnostics preserved at: $run_root" >&2
  fi
  if ((status == 0 && cleanup_status != 0)); then status=$cleanup_status; fi
  exit "$status"
}

trap on_error ERR
trap cleanup EXIT

[[ "$(stat -f%z "$baseline_dmg")" == "$baseline_asset_size" ]] || { echo 'baseline DMG size mismatch' >&2; exit 1; }
[[ "$(sha256_file "$baseline_dmg")" == "$baseline_asset_sha256" ]] || { echo 'baseline DMG SHA-256 mismatch' >&2; exit 1; }
hdiutil verify "$baseline_dmg"
hdiutil verify "$candidate_dmg"
hdiutil attach -readonly -nobrowse -mountpoint "$baseline_mount" "$baseline_dmg" >/dev/null
baseline_mounted=true
hdiutil attach -readonly -nobrowse -mountpoint "$candidate_mount" "$candidate_dmg" >/dev/null
candidate_mounted=true

baseline_source_app="$baseline_mount/Baby Diary.app"
candidate_source_app="$candidate_mount/Baby Diary.app"
baseline_source_executable="$baseline_source_app/Contents/MacOS/Baby Diary"
candidate_source_executable="$candidate_source_app/Contents/MacOS/Baby Diary"
assert_universal_app "$baseline_source_app" "$expected_baseline_version"
assert_universal_app "$candidate_source_app" "$expected_candidate_version"
record_baseline_legacy_trust "$baseline_source_app" "$run_root/baseline-legacy-trust.json"

# Candidate trust is mandatory before any v0.3.9 byte can replace v0.3.8.
verify_candidate_trust "$candidate_source_app"

# copy_baseline_into_place: one stable application identity is used for both versions.
/usr/bin/ditto "$baseline_source_app" "$installed_app"
assert_universal_app "$installed_app" "$expected_baseline_version"
baseline_executable_sha256=$(sha256_file "$installed_app/Contents/MacOS/Baby Diary")
[[ "$baseline_executable_sha256" == "$(sha256_file "$baseline_source_executable")" ]] || {
  echo 'baseline executable changed while copying into place' >&2
  exit 1
}

export HOME="$temporary_home"
invoke_upgrade_phase 'baseline-initialize' "$installed_app/Contents/MacOS/Baby Diary" \
  "$expected_baseline_version" "$baseline_source_sha" "$run_root/baseline-diagnostic.json" "$baseline_projection"
new_baseline_manifest
invoke_failure_point 'after-baseline-close'
invoke_failure_point 'after-manifest-creation'
assert_profile_matches_baseline

simulate_interrupted_staging_copy
/usr/bin/ditto "$candidate_source_app" "$candidate_ready_app"
assert_universal_app "$candidate_ready_app" "$expected_candidate_version"
verify_candidate_trust "$candidate_ready_app"
candidate_source_executable_sha256=$(sha256_file "$candidate_source_executable")
[[ "$(sha256_file "$candidate_ready_app/Contents/MacOS/Baby Diary")" == "$candidate_source_executable_sha256" ]] || {
  echo 'candidate executable changed while staging' >&2
  exit 1
}

mv "$installed_app" "$retired_baseline_app"
if ! mv "$candidate_ready_app" "$installed_app"; then
  mv "$retired_baseline_app" "$installed_app"
  echo 'candidate replacement failed and baseline was restored' >&2
  exit 1
fi
remove_run_owned_path "$retired_baseline_app"
candidate_executable="$installed_app/Contents/MacOS/Baby Diary"
assert_universal_app "$installed_app" "$expected_candidate_version"
verify_candidate_trust "$installed_app"
[[ "$(sha256_file "$candidate_executable")" == "$candidate_source_executable_sha256" ]] || {
  echo 'installed candidate executable does not match the verified DMG' >&2
  exit 1
}

invoke_failure_point 'after-candidate-replacement'
assert_profile_matches_baseline
invoke_failure_point 'before-candidate-first-launch'
invoke_upgrade_phase 'candidate-first-run' "$candidate_executable" \
  "$expected_candidate_version" "$candidate_source_sha" "$run_root/candidate-first-diagnostic.json" \
  "$first_projection" "$baseline_projection"
invoke_upgrade_phase 'candidate-second-run' "$candidate_executable" \
  "$expected_candidate_version" "$candidate_source_sha" "$run_root/candidate-second-diagnostic.json" \
  "$second_projection" "$first_projection"

expected_driver_arch='x64'
[[ "$expected_host_arch" == 'arm64' ]] && expected_driver_arch='arm64'
(
  cd "$repo_root"
  BABYDIARY_E2E_EXECUTABLE="$candidate_executable" BABYDIARY_EXPECTED_E2E_ARCH="$expected_driver_arch" npm run test:e2e
  BABYDIARY_SYNC_E2E_EXECUTABLE="$candidate_executable" npm run test:e2e:sync
)

success=true
