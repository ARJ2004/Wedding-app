#!/usr/bin/env bash
# Builds the release JS bundle and fails if development-only code survived minification
# (APP-05 / 25-app §8: dev sign-in, URL picker and the dev seed's emails must never ship).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
npx react-native bundle --platform "${1:-android}" --dev false --minify true \
  --entry-file index.js --bundle-output "$out/index.bundle" --assets-dest "$out/assets" >/dev/null
bad=0
for marker in 'mehfil.local' 'dev-sign-in' 'dev-email' 'Dev sign-in' '10.0.2.2' 'localhost:4000'; do
  if grep -q -- "$marker" "$out/index.bundle"; then echo "release bundle contains dev-only marker: $marker"; bad=1; fi
done
size=$(wc -c < "$out/index.bundle")
echo "release bundle: $((size / 1024)) KB"
rm -rf "$out"
exit $bad
