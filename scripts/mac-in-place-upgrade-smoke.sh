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
candidate_package_sha256=''
candidate_provenance=''
expected_repository=''
expected_workflow_run_id=''
expected_baseline_version='0.3.8'
expected_candidate_version='0.3.9'
failure_point='none'
phase_timeout_seconds=180
npm_timeout_seconds=600
cleanup_timeout_seconds=15
mount_timeout_seconds=120

usage() {
  echo 'usage: mac-in-place-upgrade-smoke.sh --baseline-dmg PATH --candidate-dmg PATH --expected-host-arch arm64|x86_64 --expected-team-id TEAMID --candidate-source-sha SHA --candidate-package-sha256 SHA256 --candidate-provenance PATH --expected-repository OWNER/REPO --expected-workflow-run-id ID [--failure-point POINT]' >&2
}

while (($# > 0)); do
  case "$1" in
    --baseline-dmg) baseline_dmg=${2-}; shift 2 ;;
    --candidate-dmg) candidate_dmg=${2-}; shift 2 ;;
    --expected-host-arch) expected_host_arch=${2-}; shift 2 ;;
    --expected-team-id) expected_team_id=${2-}; shift 2 ;;
    --candidate-source-sha) candidate_source_sha=${2-}; shift 2 ;;
    --candidate-package-sha256) candidate_package_sha256=${2-}; shift 2 ;;
    --candidate-provenance) candidate_provenance=${2-}; shift 2 ;;
    --expected-repository) expected_repository=${2-}; shift 2 ;;
    --expected-workflow-run-id) expected_workflow_run_id=${2-}; shift 2 ;;
    --expected-baseline-version) expected_baseline_version=${2-}; shift 2 ;;
    --expected-candidate-version) expected_candidate_version=${2-}; shift 2 ;;
    --failure-point) failure_point=${2-}; shift 2 ;;
    *) usage; echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$baseline_dmg" && -n "$candidate_dmg" && -n "$expected_host_arch" \
  && -n "$expected_team_id" && -n "$candidate_source_sha" && -n "$candidate_package_sha256" \
  && -n "$candidate_provenance" && -n "$expected_repository" && -n "$expected_workflow_run_id" ]] || { usage; exit 2; }
[[ "$expected_baseline_version" == '0.3.8' ]] || { echo 'only the pinned v0.3.8 baseline is accepted' >&2; exit 2; }
[[ "$expected_candidate_version" == '0.3.9' ]] || { echo 'only a v0.3.9 candidate is accepted' >&2; exit 2; }
[[ "$candidate_source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'candidate source SHA must be 40 lowercase hexadecimal characters' >&2; exit 2; }
[[ "$candidate_package_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo 'candidate package SHA-256 must be 64 lowercase hexadecimal characters' >&2; exit 2; }
[[ "$expected_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'expected repository must be an exact owner/repository identity' >&2; exit 2; }
[[ "$expected_workflow_run_id" =~ ^[1-9][0-9]*$ ]] || { echo 'expected workflow run ID must be a positive decimal identity' >&2; exit 2; }
[[ "$expected_team_id" =~ ^[A-Z0-9]{10}$ ]] || { echo 'candidate Team ID must be exactly ten uppercase alphanumeric characters' >&2; exit 2; }
case "$expected_host_arch" in
  arm64|x86_64) ;;
  *) echo 'expected host architecture must be arm64 or x86_64' >&2; exit 2 ;;
esac
case "$failure_point" in
  'none'|'after-baseline-close'|'after-manifest-creation'|'before-candidate-replacement'|'during-candidate-replacement'|'after-candidate-replacement'|'before-candidate-first-launch') ;;
  *) echo 'invalid deterministic failure point' >&2; exit 2 ;;
esac

# The outer release job owns one Firebase Emulator Suite process for this
# entire wrapper. Refuse to install either exact artifact unless every phase
# is pinned to that same demo-only endpoint set.
required_emulator_environment=(
  'BABYDIARY_UPGRADE_FIREBASE_EMULATOR=1'
  'BABYDIARY_UPGRADE_FIREBASE_PROJECT_ID=demo-baby-diary'
  'FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099'
  'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080'
)
for binding in "${required_emulator_environment[@]}"; do
  variable_name=${binding%%=*}
  expected_value=${binding#*=}
  [[ "${!variable_name-}" == "$expected_value" ]] || {
    echo "required exact upgrade emulator binding is missing: $variable_name=$expected_value" >&2
    exit 2
  }
done

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
candidate_provenance=$(canonical_regular_file "$candidate_provenance")
[[ "$(basename "$baseline_dmg")" == "$baseline_asset_name" ]] || { echo 'baseline DMG filename does not match the pinned release asset' >&2; exit 2; }
[[ "$(basename "$candidate_dmg")" == "Baby-Diary-${expected_candidate_version}-universal.dmg" ]] || { echo 'candidate DMG filename is not the exact universal release name' >&2; exit 2; }
[[ "$(uname -m)" == "$expected_host_arch" ]] || { echo 'native runner architecture does not match --expected-host-arch' >&2; exit 2; }

original_home=${HOME:?runner HOME is required}
original_canonical_profile="$original_home/Library/Application Support/baby-diary"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
upgrade_driver="$repo_root/scripts/upgrade-e2e.mjs"
data_contract="$repo_root/scripts/upgrade-data-contract.mjs"
rules_driver="$repo_root/scripts/upgrade-firestore-rules.mjs"
upgrade_rules_root=${BABYDIARY_UPGRADE_RULES_ROOT-}
upgrade_rules_run_id=${BABYDIARY_UPGRADE_RULES_RUN_ID-}
[[ "$upgrade_rules_run_id" =~ ^[0-9a-f]{32}$ ]] || {
  echo 'BABYDIARY_UPGRADE_RULES_RUN_ID must be a lowercase 32-hex nonce' >&2
  exit 2
}
[[ -n "$upgrade_rules_root" && -d "$upgrade_rules_root" && ! -L "$upgrade_rules_root" ]] || {
  echo 'BABYDIARY_UPGRADE_RULES_ROOT must be a prepared non-linked directory' >&2
  exit 2
}
resolved_upgrade_rules_root=$(cd "$upgrade_rules_root" && pwd -P)
[[ "${upgrade_rules_root%/}" == "$resolved_upgrade_rules_root" ]] || {
  echo 'BABYDIARY_UPGRADE_RULES_ROOT must be an absolute canonical path' >&2
  exit 2
}
[[ "$(basename "$resolved_upgrade_rules_root")" == "baby-diary-upgrade-rules-$upgrade_rules_run_id" ]] || {
  echo 'BABYDIARY_UPGRADE_RULES_ROOT is not bound to its run nonce' >&2
  exit 2
}
upgrade_rules_root=$resolved_upgrade_rules_root
run_id=$(uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]')
[[ "$run_id" =~ ^[0-9a-f]{32}$ ]] || { echo 'uuidgen did not produce a lowercase 32-hex nonce' >&2; exit 2; }
temp_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
run_root="$temp_parent/baby-diary-upgrade-$run_id"
[[ ! -e "$run_root" && ! -L "$run_root" ]] || {
  echo 'refusing to reuse a nonce-owned upgrade root' >&2
  exit 2
}

applications_root="$run_root/Applications"
installed_app="$run_root/Applications/Baby Diary.app"
candidate_ready_app="$run_root/candidate-ready.app"
retired_baseline_app="$run_root/retired-baseline.app"
interrupted_staging_app="$run_root/interrupted-staging.app"
baseline_mount="$run_root/baseline-mount"
candidate_mount="$run_root/candidate-mount"
canonical_profile="$run_root/user-data/baby-diary"
baseline_projection="$run_root/baseline-projection.json"
first_projection="$run_root/candidate-first-projection.json"
second_projection="$run_root/candidate-second-projection.json"
baseline_manifest="$run_root/baseline-raw-manifest.json"
candidate_provenance_verified="$run_root/candidate-provenance-verified.json"
interactive_profile_before="$run_root/interactive-profile-before.json"
interactive_profile_after="$run_root/interactive-profile-after.json"
baseline_executable_sha256=''
candidate_executable=''
baseline_mounted=false
candidate_mounted=false
failure_injected=false
failure_assertion_running=false
baseline_manifest_created=false
candidate_first_launch_started=false
candidate_first_launch_completed=false
active_process_group=''
termination_kind='none'
success=false
profile_fingerprint_captured=false

terminate_active_process_group() {
  local deadline
  [[ -n "$active_process_group" ]] || return 0
  kill -TERM -- "-$active_process_group" 2>/dev/null || true
  deadline=$((SECONDS + cleanup_timeout_seconds))
  while kill -0 -- "-$active_process_group" 2>/dev/null && ((SECONDS < deadline)); do
    sleep 0.1
  done
  if kill -0 -- "-$active_process_group" 2>/dev/null; then
    kill -KILL -- "-$active_process_group" 2>/dev/null || true
  fi
  wait "$active_process_group" 2>/dev/null || true
  active_process_group=''
}

run_bounded() {
  local timeout_seconds=$1 label=$2 status=0 deadline had_errexit=false
  shift 2
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || { echo 'bounded timeout must be positive' >&2; return 2; }
  [[ $- == *e* ]] && had_errexit=true
  set -m
  "$@" &
  active_process_group=$!
  set +m
  deadline=$((SECONDS + timeout_seconds))
  while kill -0 -- "-$active_process_group" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      termination_kind=timeout
      terminate_active_process_group
      echo "$label exceeded its bounded timeout" >&2
      return 124
    fi
    sleep 0.1
  done
  set +e
  wait "$active_process_group"
  status=$?
  active_process_group=''
  [[ "$had_errexit" == true ]] && set -e
  return "$status"
}

on_interrupt() {
  local status=$1
  termination_kind=interruption
  terminate_active_process_group
  exit "$status"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_candidate_provenance() {
  run_bounded "$phase_timeout_seconds" 'candidate provenance verification' node "$data_contract" 'verify-provenance' \
    '--package' "$candidate_dmg" \
    '--provenance' "$candidate_provenance" \
    '--output' "$candidate_provenance_verified" \
    '--expected-repository' "$expected_repository" \
    '--expected-workflow-run-id' "$expected_workflow_run_id" \
    '--expected-source-sha' "$candidate_source_sha" \
    '--expected-release-tag' 'v0.3.9' \
    '--expected-app-version' "$expected_candidate_version" \
    '--expected-platform' 'mac-universal' \
    '--expected-artifact-name' "$(basename "$candidate_dmg")" \
    '--expected-artifact-sha256' "$candidate_package_sha256"
  run_bounded "$phase_timeout_seconds" 'candidate provenance reporting' node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(`Verified candidate provenance binding: repository=${p.repository} run=${p.workflowRunId} source=${p.sourceSha} artifact=${p.artifactName} sha256=${p.artifactSha256}`)' \
    "$candidate_provenance_verified"
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
  run_bounded "$phase_timeout_seconds" "upgrade driver $mode" node "${arguments[@]}"
  [[ -s "$diagnostic" && -s "$projection" ]] || {
    echo 'upgrade phase diagnostic or projection artifact is missing or empty after child exit' >&2
    return 1
  }
  [[ -f "$canonical_profile/settings.json" ]] || {
    echo 'upgrade phase canonical settings artifact is missing after child exit' >&2
    return 1
  }
  [[ -d "$canonical_profile/data" ]] || {
    echo 'upgrade phase canonical event directory is missing after child exit' >&2
    return 1
  }
  run_bounded "$phase_timeout_seconds" "upgrade artifact verification $mode" node \
    "$upgrade_driver" 'verify-artifacts' \
    '--run-id' "$run_id" \
    '--mode' "$mode" \
    '--expected-version' "$expected_version" \
    '--expected-arch' "$expected_driver_arch" \
    '--source-sha' "$source_sha" \
    '--diagnostic' "$diagnostic" \
    '--projection' "$projection" \
    '--profile-root' "$canonical_profile"
}

invoke_firestore_rules_transition() {
  run_bounded "$phase_timeout_seconds" 'Firestore rules baseline-to-candidate transition' node \
    "$rules_driver" 'transition' \
    '--root' "$upgrade_rules_root" \
    '--run-id' "$upgrade_rules_run_id" \
    '--candidate-source-sha' "$candidate_source_sha"
}

new_baseline_manifest() {
  run_bounded "$phase_timeout_seconds" 'baseline manifest creation' \
    node "$data_contract" 'manifest' '--root' "$canonical_profile" '--output' "$baseline_manifest"
  [[ -s "$baseline_manifest" ]] || {
    echo 'baseline raw manifest is missing or empty after child exit' >&2
    return 1
  }
  run_bounded "$phase_timeout_seconds" 'baseline raw manifest artifact verification' \
    node "$upgrade_driver" 'verify-baseline-manifest' '--manifest' "$baseline_manifest"
  baseline_manifest_created=true
}

assert_profile_matches_baseline() {
  [[ -f "$baseline_manifest" ]] || { echo 'baseline raw manifest is unavailable' >&2; return 1; }
  run_bounded "$phase_timeout_seconds" 'raw profile comparison' \
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
  if [[ "$baseline_manifest_created" == true && "$candidate_first_launch_started" == false ]]; then
    assert_profile_matches_baseline
  fi
}

assert_run_owned_mutation_path() {
  local target=$1 root_physical relative current component physical parent_physical
  [[ -d "$run_root" && ! -L "$run_root" ]] || return 1
  root_physical=$(cd "$run_root" && pwd -P) || return 1
  [[ "$root_physical" == "$run_root" ]] || return 1
  case "$target" in
    "$run_root"/*) ;;
    *) return 1 ;;
  esac
  relative=${target#"$run_root"/}
  [[ -n "$relative" ]] || return 1
  local old_ifs=$IFS
  IFS='/'
  read -r -a components <<< "$relative"
  IFS=$old_ifs
  current=$run_root
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] || return 1
    current="$current/$component"
    [[ ! -L "$current" ]] || return 1
    if [[ -e "$current" ]]; then
      if [[ -d "$current" ]]; then
        physical=$(cd "$current" && pwd -P) || return 1
      else
        parent_physical=$(cd "$(dirname "$current")" && pwd -P) || return 1
        physical="$parent_physical/$(basename "$current")"
      fi
      case "$physical" in
        "$root_physical"|"$root_physical"/*) ;;
        *) return 1 ;;
      esac
    fi
  done
}

remove_run_owned_path() {
  local target=$1
  assert_run_owned_mutation_path "$target" || {
    echo "refusing to mutate a linked, unresolved, or external run path: $target" >&2
    return 1
  }
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
  invoke_failure_point 'during-candidate-replacement'
  remove_run_owned_path "$interrupted_staging_app"
}

stage_candidate_once() {
  remove_run_owned_path "$candidate_ready_app" || return
  run_bounded "$phase_timeout_seconds" 'candidate staging copy' \
    /usr/bin/ditto "$candidate_source_app" "$candidate_ready_app" || return
  assert_universal_app "$candidate_ready_app" "$expected_candidate_version" || return
  verify_candidate_trust "$candidate_ready_app" || return
  [[ "$(sha256_file "$candidate_ready_app/Contents/MacOS/Baby Diary")" == "$candidate_source_executable_sha256" ]] || {
    echo 'candidate executable changed while staging' >&2
    return 1
  }
}

retry_candidate_staging() {
  local attempt
  simulate_interrupted_staging_copy
  for attempt in 1 2; do
    if stage_candidate_once; then return 0; fi
    assert_profile_matches_baseline
    ((attempt < 2)) || { echo 'candidate staging retry bound was exhausted' >&2; return 1; }
    echo 'retrying after an ordinary candidate staging failure with the raw profile unchanged' >&2
  done
}

replace_candidate_with_retry() {
  local attempt
  for attempt in 1 2; do
    if mv "$installed_app" "$retired_baseline_app"; then
      if mv "$candidate_ready_app" "$installed_app"; then
        remove_run_owned_path "$retired_baseline_app"
        return 0
      fi
      mv "$retired_baseline_app" "$installed_app" || {
        echo 'candidate replacement failed and baseline rollback failed' >&2
        return 1
      }
    fi
    assert_profile_matches_baseline
    ((attempt < 2)) || { echo 'candidate replacement retry bound was exhausted' >&2; return 1; }
    echo 'retrying after an ordinary candidate replacement failure with the raw profile unchanged' >&2
  done
}

scrub_diagnostic_secrets() {
  local settings_path="$canonical_profile/settings.json"
  assert_run_owned_mutation_path "$canonical_profile" || return 1
  assert_run_owned_mutation_path "$settings_path" || return 1
  if [[ -f "$settings_path" && ! -L "$settings_path" ]]; then
    if ! node -e 'const fs=require("fs");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p,"utf8"));if(Object.prototype.hasOwnProperty.call(v,"firebase"))v.firebase=null;fs.writeFileSync(p,JSON.stringify(v,null,2)+"\n",{mode:0o600});' "$settings_path"; then
      remove_run_owned_path "$settings_path"
    fi
  fi
  local relative
  for relative in 'Local Storage' 'Session Storage' 'IndexedDB' 'Network' 'WebStorage' 'Cookies'; do
    remove_run_owned_path "$canonical_profile/$relative"
  done
  local marker_path="$run_root/secrets-scrubbed.json"
  assert_run_owned_mutation_path "$marker_path" || return 1
  printf '{"version":1,"scrubbed":true,"removedAuthStores":true,"firebaseConfigRedacted":true}\n' >"$marker_path"
  chmod 600 "$marker_path"
}

remove_run_owned_root() {
  local resolved_parent resolved_name
  resolved_parent=$(cd "$(dirname "$run_root")" && pwd -P)
  resolved_name=$(basename "$run_root")
  [[ "$resolved_parent" == "$temp_parent" && "$resolved_name" == "baby-diary-upgrade-$run_id" ]] || {
    echo 'refusing to remove a root not bound to this run nonce' >&2
    return 1
  }
  [[ -d "$run_root" && ! -L "$run_root" && "$(cd "$run_root" && pwd -P)" == "$run_root" ]] || {
    echo 'refusing to remove an unresolved or linked run-owned root' >&2
    return 1
  }
  rm -rf -- "$run_root"
}

on_error() {
  local status=$?
  if [[ "$baseline_manifest_created" == true && "$candidate_first_launch_started" == false \
    && "$failure_assertion_running" == false ]]; then
    failure_assertion_running=true
    assert_failure_invariant || status=$?
  fi
  return "$status"
}

cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT ERR INT TERM
  set +e
  if [[ "$candidate_mounted" == true ]]; then
    if run_bounded "$mount_timeout_seconds" 'candidate DMG detach' hdiutil detach "$candidate_mount" >/dev/null 2>&1; then candidate_mounted=false; else cleanup_status=1; fi
  fi
  if [[ "$baseline_mounted" == true ]]; then
    if run_bounded "$mount_timeout_seconds" 'baseline DMG detach' hdiutil detach "$baseline_mount" >/dev/null 2>&1; then baseline_mounted=false; else cleanup_status=1; fi
  fi
  if [[ "$profile_fingerprint_captured" == true ]]; then
    run_bounded "$phase_timeout_seconds" 'interactive profile non-interference verification' node \
      "$upgrade_driver" 'verify-profile-noninterference' \
      '--interactive-profile' "$original_canonical_profile" \
      '--temp-root' "$run_root" \
      '--run-id' "$run_id" \
      '--before' "$interactive_profile_before" \
      '--output' "$interactive_profile_after" || cleanup_status=$?
  fi
  if [[ "$success" == true && $cleanup_status -eq 0 ]]; then
    remove_run_owned_root || cleanup_status=$?
  else
    remove_run_owned_path "$installed_app" || cleanup_status=$?
    remove_run_owned_path "$candidate_ready_app" || cleanup_status=$?
    remove_run_owned_path "$retired_baseline_app" || cleanup_status=$?
    remove_run_owned_path "$interrupted_staging_app" || cleanup_status=$?
    [[ "$candidate_mounted" == true ]] || remove_run_owned_path "$candidate_mount" || cleanup_status=$?
    [[ "$baseline_mounted" == true ]] || remove_run_owned_path "$baseline_mount" || cleanup_status=$?
    scrub_diagnostic_secrets || cleanup_status=$?
    echo "upgrade diagnostics preserved at: $run_root" >&2
  fi
  if ((status == 0 && cleanup_status != 0)); then status=$cleanup_status; fi
  exit "$status"
}

trap on_error ERR
trap cleanup EXIT
trap 'on_interrupt 130' INT
trap 'on_interrupt 143' TERM

run_bounded "$phase_timeout_seconds" 'interactive profile fingerprint before any run-owned write' node \
  "$upgrade_driver" 'capture-profile-fingerprint' \
  '--interactive-profile' "$original_canonical_profile" \
  '--temp-root' "$run_root" \
  '--run-id' "$run_id" \
  '--output' "$interactive_profile_before"
profile_fingerprint_captured=true
mkdir -p "$applications_root" "$baseline_mount" "$candidate_mount" "$(dirname "$canonical_profile")"

verify_candidate_provenance
[[ "$(stat -f%z "$baseline_dmg")" == "$baseline_asset_size" ]] || { echo 'baseline DMG size mismatch' >&2; exit 1; }
[[ "$(sha256_file "$baseline_dmg")" == "$baseline_asset_sha256" ]] || { echo 'baseline DMG SHA-256 mismatch' >&2; exit 1; }
run_bounded "$mount_timeout_seconds" 'baseline DMG verification' hdiutil verify "$baseline_dmg"
run_bounded "$mount_timeout_seconds" 'candidate DMG verification' hdiutil verify "$candidate_dmg"
run_bounded "$mount_timeout_seconds" 'baseline DMG attach' \
  hdiutil attach -readonly -nobrowse -mountpoint "$baseline_mount" "$baseline_dmg" >/dev/null
baseline_mounted=true
run_bounded "$mount_timeout_seconds" 'candidate DMG attach' \
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
run_bounded "$phase_timeout_seconds" 'baseline application copy' \
  /usr/bin/ditto "$baseline_source_app" "$installed_app"
assert_universal_app "$installed_app" "$expected_baseline_version"
baseline_executable_sha256=$(sha256_file "$installed_app/Contents/MacOS/Baby Diary")
[[ "$baseline_executable_sha256" == "$(sha256_file "$baseline_source_executable")" ]] || {
  echo 'baseline executable changed while copying into place' >&2
  exit 1
}

invoke_upgrade_phase 'baseline-initialize' "$installed_app/Contents/MacOS/Baby Diary" \
  "$expected_baseline_version" "$baseline_source_sha" "$run_root/baseline-diagnostic.json" "$baseline_projection"
new_baseline_manifest
invoke_failure_point 'after-baseline-close'
invoke_failure_point 'after-manifest-creation'
assert_profile_matches_baseline
invoke_firestore_rules_transition

candidate_source_executable_sha256=$(sha256_file "$candidate_source_executable")
invoke_failure_point 'before-candidate-replacement'
retry_candidate_staging
replace_candidate_with_retry
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
candidate_first_launch_started=true
invoke_upgrade_phase 'candidate-first-run' "$candidate_executable" \
  "$expected_candidate_version" "$candidate_source_sha" "$run_root/candidate-first-diagnostic.json" \
  "$first_projection" "$baseline_projection"
candidate_first_launch_completed=true
invoke_upgrade_phase 'candidate-second-run' "$candidate_executable" \
  "$expected_candidate_version" "$candidate_source_sha" "$run_root/candidate-second-diagnostic.json" \
  "$second_projection" "$first_projection"

expected_driver_arch='x64'
[[ "$expected_host_arch" == 'arm64' ]] && expected_driver_arch='arm64'
cd "$repo_root"
run_bounded "$npm_timeout_seconds" 'npm run test:e2e' env \
  BABYDIARY_E2E_EXECUTABLE="$candidate_executable" \
  BABYDIARY_EXPECTED_E2E_ARCH="$expected_driver_arch" \
  BABYDIARY_TEST_USERDATA="$canonical_profile" \
  BABYDIARY_UPGRADE_ATTEST_RUN_ID="$run_id" npm run test:e2e
run_bounded "$npm_timeout_seconds" 'sync E2E inside existing emulators' env \
  BABYDIARY_SYNC_E2E_EXECUTABLE="$candidate_executable" \
  BABYDIARY_FIREBASE_EMULATOR=1 \
  BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID=demo-baby-diary \
  BABYDIARY_TEST_USERDATA="$canonical_profile" \
  BABYDIARY_UPGRADE_ATTEST_RUN_ID="$run_id" \
  node "$repo_root/scripts/sync-e2e.mjs" --inside-emulators

success=true
