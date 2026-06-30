#!/usr/bin/env bash
# =============================================================================
# optimize-demo-video.sh — Re-encode the LP demo screencasts smaller (in place)
# =============================================================================
# The cockpit walkthrough ships as landing/assets/usage.mp4 (EN) + usage.ja.mp4
# (JA). The originals were ~232-246 kbps H.264 (~2.5-2.7 MB / ~88 s, silent). For
# this mostly-static screen content, x264 CRF 30 (preset slow) halves the size
# (~106 kbps) with text still crisp — verified frame-by-frame. The page uses
# preload="metadata", so this is a play-time / bandwidth win, not an initial-load
# CWV win. Filenames are unchanged (no <source>/allowlist change).
#
# Safe to re-run: each video is replaced ONLY if the re-encode is smaller, so
# running again on already-optimized files is a near no-op (avoids compounding
# transcode loss). To refresh from scratch, re-record via record-cockpit-cast.mjs
# then run this once.
set -euo pipefail
cd "$(dirname "$0")/.."

for v in landing/assets/usage.mp4 landing/assets/usage.ja.mp4; do
  [ -f "$v" ] || { echo "skip (missing): $v"; continue; }
  tmp="${v%.mp4}.opt.mp4"
  ffmpeg -y -i "$v" -c:v libx264 -crf 30 -preset slow -an -movflags +faststart "$tmp" >/dev/null 2>&1
  before=$(stat -c%s "$v")
  after=$(stat -c%s "$tmp")
  if [ "$after" -lt "$before" ]; then
    mv "$tmp" "$v"
    printf "  %-30s %d KB -> %d KB (-%d%%)\n" "$(basename "$v")" \
      "$((before / 1024))" "$((after / 1024))" "$(((before - after) * 100 / before))"
  else
    rm -f "$tmp"
    printf "  %-30s already optimal (%d KB), kept\n" "$(basename "$v")" "$((before / 1024))"
  fi
done
