#!/usr/bin/env bash
# theme-sweep.sh — render every major web page in every branding theme and flag layout/contrast
# faults automatically.
#
# WHY THIS EXISTS. The branding picks one of four themes AT RANDOM per browser session
# (sessionStorage.mnTheme, set by jellyfin-web-flair.js), and each theme brings its own CSS block
# keyed on an `mn-*` attribute on <html>. That makes single-theme testing worthless for catching
# theme-scoped bugs: a rule that collapsed every settings row to 1px shipped in Marquee and
# survived five consecutive clean probe loads, because those loads happened to draw other themes.
# 2026-09-11: found exactly that way, after it was reported as "the settings page is completely
# broken, everything crunched into one spot".
#
# What it flags, per page per theme:
#   squashed   an element with text but <=2px of height        (the Marquee settings bug)
#   invisible  text whose colour matches its own background    (icons left on text-on-accent)
#   overflow   the document scrolling sideways
#   errors     anything the page threw
#
# Usage:  scripts/theme-sweep.sh [page ...]        (defaults to the full page list)
# Needs:  JF_TOKEN + JF_USER_ID in the environment (see scripts/jf-shot.js header).
set -uo pipefail
cd "$(dirname "$0")/.."

THEMES=(canyon matinee reelone marquee)
PAGES=("$@")
if [[ ${#PAGES[@]} -eq 0 ]]; then
  PAGES=(home movies tv boxsets search mypreferencesmenu)
fi

: "${JF_URL:=http://127.0.0.1:8096}"
export JF_URL
if [[ -z "${JF_TOKEN:-}" || -z "${JF_USER_ID:-}" ]]; then
  echo "theme-sweep: JF_TOKEN and JF_USER_ID must be set" >&2
  exit 2
fi

OUT="${OUT:-/tmp/claude-1000/theme-sweep}"
mkdir -p "$OUT"

# One expression, evaluated in the page. Kept deliberately conservative: only report an element
# that has its OWN text (so a squashed wrapper of squashed children is reported once), and only
# report colour clashes where both colours are actually opaque.
read -r -d '' PROBE <<'JS'
(()=>{
  const vis = e => { const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05; };
  const ownText = e => [...e.childNodes]
    .filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
  const rgb = s => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s || '');
    return m ? { r:+m[1], g:+m[2], b:+m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const bgOf = e => { let n = e; while (n && n !== document.documentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; n = n.parentElement; }
    return rgb(getComputedStyle(document.documentElement).backgroundColor) || { r:0, g:0, b:0, a:1 }; };

  const squashed = [], invisible = [];
  for (const e of document.querySelectorAll('body *')) {
    const t = ownText(e); if (!t || !vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 20 && r.height <= 2) {
      squashed.push({ cls: (e.className.toString() || e.tagName).slice(0, 40), txt: t.slice(0, 20), h: Math.round(r.height) });
      continue;
    }
    if (r.height < 6) continue;                       // too small to judge contrast meaningfully
    const fg = rgb(getComputedStyle(e).color); if (!fg || fg.a < 0.5) continue;
    const bg = bgOf(e);
    // Manhattan distance in 0-255 space; under ~24 total is indistinguishable on a TV or phone.
    if (Math.abs(fg.r - bg.r) + Math.abs(fg.g - bg.g) + Math.abs(fg.b - bg.b) < 24) {
      invisible.push({ cls: (e.className.toString() || e.tagName).slice(0, 40), txt: t.slice(0, 20),
        fg: `${fg.r},${fg.g},${fg.b}`, bg: `${bg.r},${bg.g},${bg.b}` });
    }
  }
  return JSON.stringify({
    theme: sessionStorage.getItem('mnTheme'),
    squashed: squashed.slice(0, 8),
    invisible: invisible.slice(0, 8),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    errors: (window.__mnErrors || []).slice(0, 3),
  });
})()
JS

fails=0
for page in "${PAGES[@]}"; do
  for theme in "${THEMES[@]}"; do
    line=$(MN_THEME="$theme" JS_PROBE="$PROBE" WAIT="${WAIT:-20000}" MAXH="${MAXH:-1200}" \
      node scripts/jf-shot.js "$page" "${WIDTH:-1413}" "$OUT/$page-$theme.png" 2>&1 \
      | sed -n 's/^  probe: //p')
    verdict=$(python3 - "$line" <<'PY'
import json, sys
raw = sys.argv[1].strip()
if not raw:
    print("NO PROBE OUTPUT"); sys.exit(1)
d = json.loads(json.loads(raw))
bad = []
for s in d["squashed"]:
    bad.append(f"squashed {s['cls']} ({s['txt']!r} h={s['h']})")
for s in d["invisible"]:
    bad.append(f"invisible {s['cls']} ({s['txt']!r} fg={s['fg']} bg={s['bg']})")
if d["overflow"] > 4:
    bad.append(f"overflow {d['overflow']}px")
for e in d["errors"]:
    bad.append(f"error {e}")
print("OK" if not bad else "FAIL: " + "; ".join(bad[:6]))
sys.exit(0 if not bad else 1)
PY
)
    rc=$?
    printf '%-20s %-8s %s\n' "$page" "$theme" "$verdict"
    [[ $rc -ne 0 ]] && fails=$((fails + 1))
  done
done

echo
echo "screenshots: $OUT"
[[ $fails -eq 0 ]] && echo "all clean" || echo "$fails page/theme combination(s) flagged"
exit 0
