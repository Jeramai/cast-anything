#!/usr/bin/env bash
#
# Upload ./app-release.aab to the Play Store internal track via fastlane (see
# fastlane/Fastfile). Needs GOOGLE_PLAY_JSON_KEY pointing at the Play Developer API
# service-account JSON and fastlane installed (bundle install). Build the bundle
# first with `npm run build:android:store`.
#
# NOTE: ai.jeram.castanything lives under the *personal* (gameout-501508) Play
# developer account, NOT the BAS World / auction (auction-52472) one. The only key
# with access is gameout's:
#   GOOGLE_PLAY_JSON_KEY=/Users/jeramai.faber/PhpstormProjects/gameout/revenuecat-key.json
# The auction/cadence key (auction-52472) returns "caller does not have permission".
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GOOGLE_PLAY_JSON_KEY:?GOOGLE_PLAY_JSON_KEY not set (path to the Play service-account JSON)}"
[ -f ./app-release.aab ] || {
  echo "./app-release.aab not found — run 'npm run build:android:store' first." >&2
  exit 1
}

bundle exec fastlane android submit
