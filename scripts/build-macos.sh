#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Privacy grants are tied to the designated signing requirement. Ad-hoc
# signing uses the executable hash, invalidating capture access on every edit.
SIGN_IDENTITY="${SEREIN_SIGN_IDENTITY:-}"
if [[ -z "$SIGN_IDENTITY" ]]; then
    SIGN_IDENTITY="$(security find-identity -v -p codesigning | awk '/"Apple Development:/{print $2; exit}')"
fi
if [[ -z "$SIGN_IDENTITY" ]]; then
    SIGN_IDENTITY="$(security find-identity -v -p codesigning | awk '/"Developer ID Application:/{print $2; exit}')"
fi
if [[ -z "$SIGN_IDENTITY" || "$SIGN_IDENTITY" == "-" ]]; then
    echo "A signing certificate is required to preserve macOS audio permissions."
    echo "Add an Apple Development certificate in Xcode, or set SEREIN_SIGN_IDENTITY."
    exit 1
fi
swift build -c release
BIN_DIR="$(swift build -c release --show-bin-path)"
APP="dist/Serein.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Serein" "$APP/Contents/MacOS/Serein"
cp native/Info.plist "$APP/Contents/Info.plist"
# App bundles use their own resources; SwiftPM's bundle is only for swift run/test.
rm -rf "$APP/Contents/MacOS/Serein_Serein.bundle"
# The source stays in the bundle as a fallback for the precompiled library.
cp native/Sources/Serein/Resources/Effects.metal "$APP/Contents/Resources/Effects.metal"
xcrun -sdk macosx metal -mmacosx-version-min=14.0 -o "$APP/Contents/Resources/Effects.metallib" \
    native/Sources/Serein/Resources/Effects.metal
cp -R native/Sources/Serein/Resources/Fonts "$APP/Contents/Resources/"
codesign --force --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --strict "$APP"
echo "Built $PWD/$APP"
if [[ "${1:-}" == "--open" ]]; then open "$APP"; fi
