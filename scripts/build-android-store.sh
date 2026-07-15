#!/usr/bin/env bash
#
# Build a signed, store-ready .aab for the Play Store. Release-signs with the upload
# keystore (android/app/build.gradle reads ../credentials/keystore.properties) and
# bundles all ABIs. Ship it with `npm run submit:android`.
#
# Unlike the auction/cadence pipeline this does NOT run `expo prebuild` — this app has
# a committed, customized android/ project (signing config, native modules), so we
# build it directly.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f credentials/keystore.properties ] || {
  echo "credentials/keystore.properties not found — needed to release-sign the bundle." >&2
  exit 1
}

(cd android && ./gradlew bundleRelease)
cp android/app/build/outputs/bundle/release/app-release.aab ./app-release.aab
echo "==> Built ./app-release.aab"
