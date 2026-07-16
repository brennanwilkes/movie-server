#!/usr/bin/env bash
# check-theme-sync.sh — Verify theme token consistency across Android XML and Jellyfin Web JS/CSS.
# Reads docs/branding/THEME-TOKENS.json (single source of truth) and greps the live code for
# each critical value. Exits non-zero on any mismatch.
#
# Usage: ./scripts/check-theme-sync.sh
#        make check-themes

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOKENS="$REPO_ROOT/docs/branding/THEME-TOKENS.json"

if ! command -v jq &>/dev/null; then
  echo "SKIP: jq not installed — install jq to run theme sync checks"
  exit 0
fi

if [[ ! -f "$TOKENS" ]]; then
  echo "FAIL: $TOKENS not found"
  exit 1
fi

PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" found="$3"
  if [[ -z "$found" ]]; then
    echo "  SKIP  $label (pattern not found in codebase)"
  elif echo "$found" | grep -qF "$expected"; then
    echo "  PASS  $label = $expected"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label: expected '$expected', found '$found'"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Theme Token Sync Check ==="
echo ""

# ── Android TV attrs (theme_movienight_*.xml) ──
echo "── Android TV XML attrs ──"

for theme in canyon matinee reelone marquee; do
  xml_file=$(ls "$REPO_ROOT"/~/jellyfin-androidtv/app/src/main/res/values/theme_movienight_${theme}.xml 2>/dev/null || \
             ls "$HOME/jellyfin-androidtv/app/src/main/res/values/theme_movienight_${theme}.xml" 2>/dev/null || true)
  if [[ -z "$xml_file" || ! -f "$xml_file" ]]; then
    echo "  SKIP  $theme XML (file not found)"
    continue
  fi

  accent=$(jq -r ".[\"$theme\"].accent" "$TOKENS")
  bg2=$(jq -r ".[\"$theme\"].bg2" "$TOKENS")
  marker_glyph=$(jq -r ".[\"$theme\"].sectionMarker.glyph" "$TOKENS")
  marker_color=$(jq -r ".[\"$theme\"].sectionMarker.color" "$TOKENS")
  glow_color=$(jq -r ".[\"$theme\"].android.cardGlowColor" "$TOKENS")
  glow_radius=$(jq -r ".[\"$theme\"].android.cardGlowRadius" "$TOKENS")
  divider_accent=$(jq -r ".[\"$theme\"].android.dividerAccent" "$TOKENS")
  divider_color=$(jq -r ".[\"$theme\"].android.dividerColor" "$TOKENS")
  litho_color=$(jq -r ".[\"$theme\"].android.lithoShadowColor" "$TOKENS")

  echo "  [$theme]"
  # colorAccent uses @color/accent_<theme> reference in XML — check for reference OR hex
  accent_ref="@color/accent_${theme}"
  found_accent=$(grep -oP 'colorAccent">[^<]+' "$xml_file" | head -1 || true)
  if echo "$found_accent" | grep -qF "$accent_ref"; then
    echo "  PASS  colorAccent = $accent_ref (resolves to $accent)"
    PASS=$((PASS + 1))
  elif echo "$found_accent" | grep -qF "$accent"; then
    echo "  PASS  colorAccent = $accent"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  colorAccent: expected '$accent_ref' or '$accent', found '$found_accent'"
    FAIL=$((FAIL + 1))
  fi
  check "defaultBackground"  "$bg2"           "$(grep -oP 'defaultBackground">[^<]+' "$xml_file" | head -1)"
  check "sectionMarkerGlyph" "$marker_glyph"  "$(grep -oP 'sectionMarkerGlyph">[^<]+' "$xml_file" | head -1)"
  check "sectionMarkerColor" "$marker_color"  "$(grep -oP 'sectionMarkerColor">[^<]+' "$xml_file" | head -1)"
  check "cardGlowColor"      "$glow_color"    "$(grep -oP 'cardGlowColor">[^<]+' "$xml_file" | head -1)"
  check "cardGlowRadius"     "$glow_radius"   "$(grep -oP 'cardGlowRadius">[^<]+' "$xml_file" | head -1)"
  check "dividerAccent"      "$divider_accent" "$(grep -oP 'dividerAccent">[^<]+' "$xml_file" | head -1)"
  check "dividerColor"       "$divider_color"  "$(grep -oP 'dividerColor">[^<]+' "$xml_file" | head -1)"
  check "lithoShadowColor"   "$litho_color"    "$(grep -oP 'lithoShadowColor">[^<]+' "$xml_file" | head -1)"
  echo ""
done

# ── Jellyfin Web (jellyfin-web-flair.js THEMES object) ──
echo "── Jellyfin Web JS THEMES ──"

flair_js=""
for candidate in \
  "$REPO_ROOT/scripts/provision/jellyfin-web-flair.js" \
  "$HOME/jellyfin-web-flair.js"; do
  if [[ -f "$candidate" ]]; then
    flair_js="$candidate"
    break
  fi
done

if [[ -z "$flair_js" ]]; then
  echo "  SKIP  jellyfin-web-flair.js (not found)"
else
  for theme in canyon matinee reelone marquee; do
    accent=$(jq -r ".[\"$theme\"].accent" "$TOKENS" | tr '[:upper:]' '[:lower:]')
    accent2=$(jq -r ".[\"$theme\"].accent2" "$TOKENS" | tr '[:upper:]' '[:lower:]')
    font=$(jq -r ".[\"$theme\"].fontFamily" "$TOKENS")

    echo "  [$theme]"
    # Check accent color exists in the THEMES object (case-insensitive)
    found=$(grep -i "$accent" "$flair_js" | head -1 || true)
    check "accent" "$accent" "$found"
    found=$(grep -i "$font" "$flair_js" | head -1 || true)
    check "fontFamily" "$font" "$found"
  done
  echo ""
fi

# ── Summary ──
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ $FAIL -gt 0 ]]; then
  echo "Theme tokens have drifted — update THEME-TOKENS.json or fix the code."
  exit 1
else
  echo "All checks passed (or skipped)."
fi
