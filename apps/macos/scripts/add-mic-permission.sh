#!/bin/bash
# Add NSMicrophoneUsageDescription to a built Muse Code GUI .app so the
# WebView mic (live transcription) can prompt for permission. Tauri has no
# config hook for this key, so it runs post-build:
#   npm run tauri:build -- --debug && npm run tauri:mic -- <.app path>
set -euo pipefail
APP="${1:?usage: add-mic-permission.sh <Muse Code GUI.app>}"
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || { echo "no Info.plist at $PLIST" >&2; exit 1; }
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string 'Microphone access for live voice transcription.'" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription 'Microphone access for live voice transcription.'" "$PLIST"
# Editing the plist breaks the ad-hoc signature; re-sign so Gatekeeper stays quiet.
/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PLIST"
