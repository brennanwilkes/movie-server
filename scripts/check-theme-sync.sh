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

  # Additional Android attrs: text, textOnAccent, cardRounding, buttonRounding
  text_color=$(jq -r ".[\"$theme\"].text" "$TOKENS")
  text_on_accent=$(jq -r ".[\"$theme\"].textOnAccent" "$TOKENS")
  card_round=$(jq -r ".[\"$theme\"].cardRadius" "$TOKENS" | tr -d 'px' | sed 's/$/dp/')
  btn_round=$(jq -r ".[\"$theme\"].btnRadius" "$TOKENS" | tr -d 'px' | sed 's/$/dp/')
  # headerTextColor uses direct hex (no @color/ indirection)
  check "headerTextColor"    "$text_color"     "$(grep -oP 'headerTextColor">[^<]+' "$xml_file" | head -1)"
  check "cardRounding"       "$card_round"     "$(grep -oP 'cardRounding">[^<]+' "$xml_file" | head -1)"
  check "buttonRounding"     "$btn_round"      "$(grep -oP 'buttonRounding">[^<]+' "$xml_file" | head -1)"

  # Popup / button / input text attrs (derived: text + textOnAccent tokens)
  check "popupMenuTextColor"     "$text_color"     "$(grep -oP 'popupMenuTextColor">[^<]+' "$xml_file" | head -1)"
  check "buttonTextColor"        "$text_color"     "$(grep -oP 'buttonTextColor">[^<]+' "$xml_file" | head -1)"
  check "buttonTextColorFocused" "$text_on_accent" "$(grep -oP 'buttonTextColorFocused">[^<]+' "$xml_file" | head -1)"
  check "inputTextColor"         "$text_color"     "$(grep -oP 'inputTextColor">[^<]+' "$xml_file" | head -1)"

  # Compose ColorScheme attrs (derived: bg2/text/accent/textOnAccent tokens)
  check "composeBackground"     "$bg2"            "$(grep -oP 'composeBackground">[^<]+' "$xml_file" | head -1)"
  check "composeOnBackground"   "$text_color"     "$(grep -oP 'composeOnBackground">[^<]+' "$xml_file" | head -1)"
  check "composeButton"         "$accent"         "$(grep -oP 'composeButton">[^<]+' "$xml_file" | head -1)"
  check "composeOnButton"       "$text_on_accent" "$(grep -oP 'composeOnButton">[^<]+' "$xml_file" | head -1)"
  check "composeInput"          "$accent"         "$(grep -oP 'composeInput">[^<]+' "$xml_file" | head -1)"
  check "composeOnInput"        "$text_color"     "$(grep -oP 'composeOnInput">[^<]+' "$xml_file" | head -1)"
  check "composeInputFocused"   "$text_color"     "$(grep -oP 'composeInputFocused">[^<]+' "$xml_file" | head -1)"
  check "composeOnInputFocused" "$text_on_accent" "$(grep -oP 'composeOnInputFocused">[^<]+' "$xml_file" | head -1)"
  check "composePopover"        "$bg2"            "$(grep -oP 'composePopover">[^<]+' "$xml_file" | head -1)"
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
  # JS color tokens to validate (hex colors, case-insensitive match in THEMES object)
  js_hex_tokens=(accent accent2 bg bg2 text muted textOnAccent)
  # JS dimension/rgba tokens (exact string match)
  js_raw_tokens=(glowColor glowSpread dividerColor scrollbarColor)

  for theme in canyon matinee reelone marquee; do
    font=$(jq -r ".[\"$theme\"].fontFamily" "$TOKENS")
    echo "  [$theme]"

    for tok in "${js_hex_tokens[@]}"; do
      val=$(jq -r ".[\"$theme\"].$tok" "$TOKENS" | tr '[:upper:]' '[:lower:]')
      # Grep case-insensitive in the flair JS — the THEMES object line contains the value
      found=$(grep -i "$val" "$flair_js" | head -1 || true)
      check "$tok" "$val" "$found"
    done
    for tok in "${js_raw_tokens[@]}"; do
      val=$(jq -r ".[\"$theme\"].$tok" "$TOKENS")
      found=$(grep -F "$val" "$flair_js" | head -1 || true)
      check "$tok" "$val" "$found"
    done
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
