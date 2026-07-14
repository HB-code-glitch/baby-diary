#!/usr/bin/env bash
set -euo pipefail

dmg_path="${1:?usage: mac-installed-release-smoke.sh <universal-dmg> <arm64|x86_64>}"
expected_host_arch="${2:?usage: mac-installed-release-smoke.sh <universal-dmg> <arm64|x86_64>}"

if [[ ! -f "$dmg_path" ]]; then
  echo "Universal DMG not found: $dmg_path" >&2
  exit 1
fi
if [[ "$expected_host_arch" != "arm64" && "$expected_host_arch" != "x86_64" ]]; then
  echo "Expected host architecture must be arm64 or x86_64" >&2
  exit 1
fi

actual_host_arch="$(uname -m)"
if [[ "$actual_host_arch" != "$expected_host_arch" ]]; then
  echo "Installed Mac smoke expected host $expected_host_arch but found $actual_host_arch" >&2
  exit 1
fi

working_dir="$(mktemp -d "${TMPDIR:-/tmp}/baby-diary-installed-smoke.XXXXXX")"
mount_point="$working_dir/mount"
install_root="$working_dir/Applications"
installed_app="$install_root/Baby Diary.app"
installed_executable="$installed_app/Contents/MacOS/Baby Diary"
mounted=0

mkdir -p "$mount_point" "$install_root"

cleanup() {
  status=$?
  if [[ "$mounted" -eq 1 ]]; then
    if ! hdiutil detach "$mount_point"; then
      echo "Failed to detach installed-smoke DMG" >&2
      status=1
    fi
  fi
  rm -rf "$working_dir"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT

hdiutil verify "$dmg_path"
hdiutil attach -readonly -nobrowse -mountpoint "$mount_point" "$dmg_path"
mounted=1

source_app="$mount_point/Baby Diary.app"
if [[ ! -d "$source_app" ]]; then
  echo "Mounted DMG does not contain Baby Diary.app" >&2
  exit 1
fi

/usr/bin/ditto "$source_app" "$installed_app"
xattr -w com.apple.quarantine '0083;00000000;GitHub_Actions;' "$installed_app"
if [[ -z "$(xattr -p com.apple.quarantine "$installed_app")" ]]; then
  echo "Installed app did not retain quarantine metadata" >&2
  exit 1
fi

archs="$(lipo -archs "$installed_executable" | tr ' ' '\n' | sed '/^$/d' | sort | xargs)"
if [[ "$archs" != "arm64 x86_64" ]]; then
  echo "Installed universal executable must contain exactly arm64 and x86_64; found: $archs" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=4 "$installed_app"
spctl --assess --type execute --verbose=4 "$installed_app"
xcrun stapler validate "$installed_app"

if [[ "$expected_host_arch" == "arm64" ]]; then
  expected_electron_arch="arm64"
else
  expected_electron_arch="x64"
fi

BABYDIARY_E2E_EXECUTABLE="$installed_executable" \
BABYDIARY_EXPECTED_E2E_ARCH="$expected_electron_arch" \
npm run test:e2e

BABYDIARY_SYNC_E2E_EXECUTABLE="$installed_executable" \
BABYDIARY_EXPECTED_E2E_ARCH="$expected_electron_arch" \
npm run test:e2e:sync
