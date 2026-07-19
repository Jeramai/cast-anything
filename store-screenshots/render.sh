#!/usr/bin/env bash
# Render every slide in index.html to a Google-Play phone screenshot.
# Output: ./out/*.png (2160×3840 = 2× of 1080×1920, 9:16 — a valid Play size)
# and a copy into fastlane's phoneScreenshots dir (so `fastlane supply` picks them up).
#
# Regenerate after editing index.html (copy/layout) or dropping new shots in ./shots.
set -euo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
FL="../fastlane/metadata/android/en-US/images/phoneScreenshots"
mkdir -p out "$FL"

# slide index → output basename (order = Play display order)
slides=(1:1_hero 2:2_control 3:3_convert 4:4_subtitles 5:5_queue 6:6_themes)

for pair in "${slides[@]}"; do
  i="${pair%%:*}"; name="${pair##*:}"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
    --allow-file-access-from-files --force-device-scale-factor=2 \
    --window-size=1080,1920 --virtual-time-budget=2500 \
    --screenshot="out/${name}.png" "file://$PWD/index.html#shot-${i}" >/dev/null 2>&1
  cp "out/${name}.png" "$FL/${name}.png"
  echo "rendered ${name}.png"
done

echo "Done → ./out and $FL"
