# Festival Award Badges — Implementation Plan

Add Cannes + Sundance winner rows to the Oscar plaque on both clients, matching
`docs/branding/award-badges-mockup.html` (approved 2026-07-31). One row per festival, never
combined; a single win shows the award name, multiple wins show "N [FESTIVAL] WINS" (web plaque).
The Fire Stick compact form is always glyph + count. The 4-line stack never occurs (0 of 2,213
films), so it is omitted — verified: exactly one film (*sex, lies, and videotape*) won at both
festivals, and it has **no** Oscar wins or noms in `film-awards.json` (it is not even keyed there),
so OscarW + OscarN + Cannes + Sundance can never co-occur.

## Data model (controller)

Festival data is **TMDb-keyed** (`controller/oscar-winners.json`), while `oscar-tags.js` matches
movies by **IMDb id** against `film-awards.json`. The sweep needs a parallel TMDb match.

`oscar-winners.json` entry shape (every collection key → array of rows):

```json
"Cannes: Palme d'Or (Winners)": [
  { "tmdb_id": 1401459, "title": "Fjord", "year": 2026 }
]
```

**`tmdb_id` is a NUMBER in the JSON but Jellyfin reports `ProviderIds.Tmdb` as a STRING** — the
match map must be keyed by `String(tmdb_id)` and looked up with `String(m.ProviderIds.Tmdb)`, or
every film misses.

### `controller/lib/oscar-tags.js`

- Import `oscarWinners` — it is already exported from `config.js:25`/`:57`. Extend line 23:

  ```js
  const { cfg, HOST, filmAwards, personAwards, oscarWinners } = require('./config');
  ```

- Build a module-level `festivalByTmdb` map. The **exact collection keys** in
  `oscar-winners.json` (verified live, 529 unique films total: 324 Cannes + 206 Sundance − 1 in both):

  | Key | Web display (`{DISPLAY}`) |
  |---|---|
  | `Cannes: Palme d'Or (Winners)` | `PALME D'OR` |
  | `Cannes: Grand Prix (Winners)` | `GRAND PRIX` |
  | `Cannes: Jury Prize (Winners)` | `JURY PRIZE` |
  | `Cannes: Best Director (Winners)` | `BEST DIRECTOR` |
  | `Sundance: Grand Jury Prize (Dramatic) (Winners)` | `GRAND JURY` |
  | `Sundance: Grand Jury Prize (Documentary) (Winners)` | `GRAND JURY` |
  | `Sundance: Audience Award (Dramatic) (Winners)` | `AUDIENCE` |
  | `Sundance: Audience Award (Documentary) (Winners)` | `AUDIENCE` |
  | `Sundance: Directing Award (Dramatic) (Winners)` | `DIRECTING AWARD` |
  | `Sundance: Directing Award (Documentary) (Winners)` | `DIRECTING AWARD` |

  Note the Sundance Dramatic/Documentary split collapses to one display label each. **Do not
  guess a label from the key** — the mockup's "PALME D'OR"/"GRAND PRIX"/"JURY PRIZE"/"BEST
  DIRECTOR"/"GRAND JURY"/"AUDIENCE"/"DIRECTING AWARD" set is canonical (`award-badges-mockup.html:26-27,194`).

  ```js
  const FESTIVAL_DISPLAY = {
    "Cannes: Palme d'Or (Winners)": "PALME D'OR",
    "Cannes: Grand Prix (Winners)": "GRAND PRIX",
    "Cannes: Jury Prize (Winners)": "JURY PRIZE",
    "Cannes: Best Director (Winners)": "BEST DIRECTOR",
    "Sundance: Grand Jury Prize (Dramatic) (Winners)": "GRAND JURY",
    "Sundance: Grand Jury Prize (Documentary) (Winners)": "GRAND JURY",
    "Sundance: Audience Award (Dramatic) (Winners)": "AUDIENCE",
    "Sundance: Audience Award (Documentary) (Winners)": "AUDIENCE",
    "Sundance: Directing Award (Dramatic) (Winners)": "DIRECTING AWARD",
    "Sundance: Directing Award (Documentary) (Winners)": "DIRECTING AWARD",
  };
  // tmdb_id in the JSON is a NUMBER; Jellyfin ProviderIds.Tmdb is a STRING — key by String().
  // Value: { cannes: [displayNames], sundance: [displayNames] } (names in collection order).
  const festivalByTmdb = (() => {
    const m = new Map();
    for (const [key, rows] of Object.entries(oscarWinners)) {
      const label = FESTIVAL_DISPLAY[key];
      if (!label) continue;
      const fest = key.startsWith('Cannes: ') ? 'cannes'
        : key.startsWith('Sundance: ') ? 'sundance' : null;
      if (!fest) continue;
      for (const r of rows || []) {
        if (r && r.tmdb_id != null) {
          const k = String(r.tmdb_id);
          if (!m.has(k)) m.set(k, { cannes: [], sundance: [] });
          m.get(k)[fest].push(label);
        }
      }
    }
    return m;
  })();
  ```

- Add a festival strip-regex next to `OSCAR_TAG_RE` (line 28). The web's `festival-cannes-name-PALME D'OR` tag contains a space and an apostrophe, so the name branch must be `.+`, and the bare `festival` presence marker must also strip:

  ```js
  const OSCAR_TAG_RE = /^oscar(s|-wins-\d+|-noms-\d+)$/;               // line 28, unchanged
  const FESTIVAL_TAG_RE = /^festival(?:-(cannes|sundance)(?:-(?:\d+|name-.+))?)?$/;
  ```

- Extend `desiredTags()` (lines 40-50) to take a `festival` argument and push the festival set. The `base` filter must now drop BOTH oscar and festival tags, so stale festival tags get stripped on the same full-DTO reconcile:

  ```js
  function desiredTags(current, award, festival) {
    const base = (current || []).filter((t) => !OSCAR_TAG_RE.test(t) && !FESTIVAL_TAG_RE.test(t));
    const wins = (award && award.wins) || 0;
    const losses = Math.max(0, ((award && award.noms) || 0) - wins);
    const cannes = (festival && festival.cannes) || [];
    const sundance = (festival && festival.sundance) || [];
    const hasOscar = wins > 0 || losses > 0;
    const hasFestival = cannes.length > 0 || sundance.length > 0;
    if (!hasOscar && !hasFestival) return base;
    if (hasOscar) {
      base.push('oscars');
      if (wins > 0) base.push(`oscar-wins-${wins}`);
      if (losses > 0) base.push(`oscar-noms-${losses}`);
    }
    if (hasFestival) {
      base.push('festival');                       // presence marker (web bulk-query filter)
      if (cannes.length > 0) {
        base.push(`festival-cannes-${cannes.length}`);
        if (cannes.length === 1) base.push(`festival-cannes-name-${cannes[0]}`);
      }
      if (sundance.length > 0) {
        base.push(`festival-sundance-${sundance.length}`);
        if (sundance.length === 1) base.push(`festival-sundance-name-${sundance[0]}`);
      }
    }
    return base;
  }
  ```

- `reconcileTags(uid, h, item, award)` (lines 61-77) gains a `festival` param threaded into
  `desiredTags` — one POST carries oscar + festival tags together, no extra writes:

  ```js
  async function reconcileTags(uid, h, item, award, festival) {
    const current = item.Tags || [];
    const want = desiredTags(current, award, festival);
    // …body unchanged (lines 64-77)…
  }
  ```

- **Movies pass** (lines 158-174): the loop already fetches `ProviderIds` (`Fields: 'ProviderIds,Tags'`, line 160), so read `ProviderIds.Tmdb` alongside `ProviderIds.Imdb`:

  ```js
   for (const m of movies) {
   	const imdb = m.ProviderIds && m.ProviderIds.Imdb;
   	if (!imdb) noImdb++;
   	const award = imdb ? filmAwards[imdb] : null;
   	if (award) matched++;
   	const tmdb = m.ProviderIds && m.ProviderIds.Tmdb;
   	const festival = tmdb ? festivalByTmdb.get(String(tmdb)) : null;
   	if (festival) festivalMatched++;   // separate counter — a film in BOTH oscar+festival
   	                                   // would otherwise double-count `matched` (NIT fix)
   	const res = await reconcileTags(uid, h, m, award, festival);
   	if (res === 'written') { written++; if (!award && !festival) removed++; }
   	else if (res === 'failed') failed++;
   }
   console.log(`oscarTagsSweep[movies]: ${matched} oscar-tagged, ${festivalMatched} festival-tagged, `
     + `${written} written, ${removed} removed`
     + (noImdb ? `, ${noImdb} without Imdb id` : '') + (failed ? `, ${failed} failed` : ''));
  ```

  (`removed` must count a film as removed only when it now has NEITHER oscar nor festival tags.)
  The people pass (lines 176-195) and the `person-oscars` route (`routes-system.js:108-120`)
  are **unchanged** — festivals are film awards; people never carry festival tags, and the
  person pass's own `hasOscarTag` guard (line 187) tests `OSCAR_TAG_RE` only, which is correct.

- **Presence marker:** festival-only films (e.g. *sex, lies, and videotape*, tmdb 1412) carry
  `festival` but not `oscars`, so the web's bulk query must filter on BOTH markers (see Web §2).

### Tag grammar

```
festival-cannes-N / festival-sundance-N                 # always when N > 0
festival-cannes-name-{DISPLAY} / festival-sundance-name-{DISPLAY}  # ONLY when N == 1
festival                                                   # presence marker, any festival winner
```

`{DISPLAY}` is the literal label from the table above ("PALME D'OR", "GRAND PRIX", "JURY PRIZE",
"BEST DIRECTOR", "GRAND JURY", "AUDIENCE", "DIRECTING AWARD") — derived in the controller,
so neither client needs a slug map. Fire Stick ignores name tags (it always renders glyph + count).

**Verification (dataset count):**

```bash
node -e 'const d=require("./controller/oscar-winners.json");
const c=Object.keys(d).filter(k=>k.startsWith("Cannes:"));const s=Object.keys(d).filter(k=>k.startsWith("Sundance:"));
const f=new Set([...c.flatMap(k=>d[k]),...s.flatMap(k=>d[k])].map(r=>r.tmdb_id));
console.log("unique festival films:",f.size)'   # expect 529
```

## Web (`scripts/provision/jellyfin-web-flair.js` + `jellyfin-custom.css`)

All line numbers below verified against the current file. The flair JS is pushed by
`scripts/provision/jellyfin.sh` to the **JavaScript Injector plugin** (`FLAIR_JS` at
`jellyfin.sh:755`, served as `/JavaScriptInjector/public.js`), so deploy must be
`make provision s=jellyfin` — a bare `make deploy` does not re-push flair.

1. **Regex/parse** (`jellyfin-web-flair.js:756-767`). Add a festival regex and widen the parse to
   return `{ w, l, c, s, cName, sName }`. Gotcha: the current `OSCAR_TAG_RE`
   (`/^oscar-(wins|noms)-(\d+)$/`) deliberately does NOT match the `oscars` marker — keep that
   (only counts are needed). The festival regex must match BOTH the count tag
   (`festival-cannes-3`) and the name tag (`festival-cannes-name-PALME D'OR` — note the space +
   apostrophe, so use `(.+)`):

   ```js
   var OSCAR_TAG_RE = /^oscar-(wins|noms)-(\d+)$/;
   var FESTIVAL_TAG_RE = /^festival-(cannes|sundance)(?:-(\d+)|-name-(.+))?$/;
   function parseOscarTags(tags) {
   	if (!tags || !tags.length) return null;
   	var w = 0, l = 0, c = 0, s = 0, cName = '', sName = '', hit = false;
   	for (var i = 0; i < tags.length; i++) {
   		var m = OSCAR_TAG_RE.exec(tags[i]);
   		if (m) { hit = true; if (m[1] === 'wins') w = parseInt(m[2], 10); else l = parseInt(m[2], 10); continue; }
   		var f = FESTIVAL_TAG_RE.exec(tags[i]);
   		if (f) {
   			hit = true;
   			if (f[1] === 'cannes') {
   				// BLOCKER-fix: the -name- tag matches with f[2] undefined — only assign from the
   				// capture group that actually matched, or the name tag clobbers the count to 0
   				// (parseInt(undefined) → NaN → 0) and the festival row vanishes for every
   				// single-win film (~506 of 529). Count and name are INDEPENDENT tags.
   				if (f[2] !== undefined) c = parseInt(f[2], 10) || 0;
   				if (f[3] !== undefined) cName = f[3];
   			} else {
   				if (f[2] !== undefined) s = parseInt(f[2], 10) || 0;
   				if (f[3] !== undefined) sName = f[3];
   			}
   		}
   	}
   	return hit ? { w: w, l: l, c: c, s: s, cName: cName, sName: sName } : null;
   }
   ```

   A festival-only film now returns a truthy `{w:0,l:0,c:1,…}` — that is what lets it enter
   `oscarById` and get a plaque. Keep the function name `parseOscarTags` so the person
   on-demand path (`jellyfin-web-flair.js:650`, `flushOscarFetch`) needs no edit.

2. **Bulk load** (`jellyfin-web-flair.js:768-795`): `loadOscars()` currently issues ONE query with
   `Tags: 'oscars'`. Add a parallel `Tags: 'festival'` query and merge by item Id. **Jellyfin /Items
   `Tags` quirk:** the `Tags` filter is AND-ed when you pass multiple values — two separate
   single-value queries avoids that entirely and each returns its own marker set. The old fallback
   (older server ignores/rejects `Tags` → full scan) must fire only when **both** queries return
   empty:

   ```js
   function loadOscars() {
   	if (!ready()) return Promise.resolve();
   	var a = api();
   	var userId = a.getCurrentUserId();
   	function ingest(items) {
   		var next = new Map();
   		(items || []).forEach(function (it) {
   			var aw = parseOscarTags(it.Tags);
   			if (aw && it.Id) { next.set(it.Id, aw); next.set(normalize(it.Id), aw); }
   		});
   		var changed = diffMapKeys(oscarById, next);
   		oscarById = next;
   		lsSet(cacheKey('mn_oscars'), Array.from(next.entries()));
   		// Diffed re-decoration (mirrors loadLists()) — untouched cards keep their MARK.
   		if (redecorateChanged(changed)) scan();
   	}
   	// Primary: two parallel Tags filters — `oscars` AND `festival` (festival-only films carry
   	// only the latter). Merge by item Id so an Oscar+festival film is ingested once. Fallback:
   	// if BOTH come back empty (older server that ignores/rejects Tags), full-scan and filter here.
   	var merged = new Map();
   	function collect(res) {
   		((res && res.Items) || []).forEach(function (it) { if (it.Id) merged.set(it.Id, it); });
   	}
   	// Promise.allSettled (not all): a server that ignores/rejects the Tags filter would make
   	// Promise.all reject and swallow BOTH results — allSettled keeps the healthy query's rows
   	// and lets the fallback fire only when both genuinely come back empty.
   	return Promise.allSettled([
   		a.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Tags: 'oscars', Fields: 'Tags', Limit: 2000 }),
   		a.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Tags: 'festival', Fields: 'Tags', Limit: 2000 }),
   	]).then(function (rs) {
   		rs.forEach(function (r) { if (r && r.status === 'fulfilled') collect(r.value); });
   		if (merged.size) { ingest(Array.from(merged.values())); return; }
   		return a.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Fields: 'Tags', Limit: 5000 })
   			.then(function (r2) { ingest((r2 && r2.Items) || []); });
   	}).catch(function () { /* ignore — retry on the next refresh tick */ });
   }
   ```

   **Gotchas here:**
   - **`normalize()` id fallback** (`jellyfin-web-flair.js:634`): `ingest` stores BOTH `it.Id` and
     `normalize(it.Id)` (`normalize = id.replace(/-/g,'').toLowerCase()`), and `oscarFor(id)`
     (line 638) checks both. The festival rows ride the same dual-key pattern via the unchanged
     `ingest` — no new lookup code.
   - **localStorage caching** (`cacheKey('mn_oscars')`, lines 780/520-521): the persisted value
     shape changes from `{w,l}` to `{w,l,c,s,cName,sName}`. **DECISION (locked): bump the cache key
     to `mn_oscars_v2`.** Without it, a hydrated stale cache renders Oscar-only (festival fields
     degrade to 0) until the next network rebuild overwrites it — a visible regression window of
     up to `REFRESH_MS = 5 min` on every deploy for every user. The v2 bump costs one string change
     in `cacheKey('mn_oscars_v2')` and gives a clean first paint. (Missed keys degrade to 0, so
     v2 also self-heals: the old v1 payload is simply never read again.)
   - **Diffed re-decoration**: `ingest` → `diffMapKeys` (line 533, JSON-compares values) →
     `redecorateChanged` (line 554) → `scan()`. Because values are JSON-compared, adding festival
     tags changes only the affected items' JSON and only those cards re-decorate. Preserve this —
     do not reintroduce a wholesale marker nuke.

3. **Plaque render** (`oscarPlaqueHtml()`, `jellyfin-web-flair.js:823-834`). Add the two festival
   params plus the inline glyphs. **`large` gotcha:** the third param (`large`) is a boolean —
   truthy → `.oscar-plaque` (full), falsy → `.oscar-plaque oscar-plaque-sm`. The festival rows go
   in the same `.opl-f` class either way; the `-sm` CSS rules (9×9 icons) handle the compact form.
   The `!lines.length` guard must move AFTER the festival pushes so a festival-only film still gets
   a plaque (mockup `sex, lies, and videotape` case, line 342).

   Copy the glyph markup EXACTLY from the mockup's **plaque renderings** (`award-badges-mockup.html:257`
   for the reel, `:332` for the sun). They are composed SVG elements (circles/lines), not a single
   pathData. **Sun gotcha:** the plaque sun (`r=5`, `stroke-width=2`, rays `1.5→4`/`20→22.5`)
   differs from the mockup's candidate tile (`r=4`, `stroke-width=1.8`, line 220) — use the
   PLAQUE version. Colors: reel `#9fb87f` + detail `#0e2a30`, sun `#f26d3d`.

   ```js
   // Festival glyphs — EXACT markup from the approved mockup (plaque versions, lines 257/332).
   var FESTIVAL_REEL_SVG = '<svg class="reel" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
   	'<circle cx="12" cy="12" r="9" fill="#9fb87f"/>' +
   	'<circle cx="12" cy="12" r="5" fill="none" stroke="#0e2a30" stroke-width="1.6"/>' +
   	'<g fill="#0e2a30"><circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="19" r="1.3"/>' +
   	'<circle cx="5" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>' +
   	'<circle cx="7.1" cy="7.1" r="1.3"/><circle cx="16.9" cy="16.9" r="1.3"/>' +
   	'<circle cx="7.1" cy="16.9" r="1.3"/><circle cx="16.9" cy="7.1" r="1.3"/></g></svg>';
   var FESTIVAL_SUN_SVG = '<svg class="sun" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
   	'<circle cx="12" cy="12" r="5" fill="#f26d3d"/>' +
   	'<g stroke="#f26d3d" stroke-width="2" stroke-linecap="round">' +
   	'<line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/>' +
   	'<line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/>' +
   	'<line x1="4.6" y1="4.6" x2="6.4" y2="6.4"/><line x1="17.6" y1="17.6" x2="19.4" y2="19.4"/>' +
   	'<line x1="4.6" y1="19.4" x2="6.4" y2="17.6"/><line x1="17.6" y1="6.4" x2="19.4" y2="4.6"/></g></svg>';

   function oscarPlaqueHtml(wins, losses, cannes, sundance, cannesName, sundanceName, large) {
   	function mini(color) {
   		return '<svg viewBox="0 0 24 48" xmlns="http://www.w3.org/2000/svg">' +
   			'<path fill="' + color + '" d="' + STATUETTE_PATH + '"/></svg>';
   	}
   	var lines = [];
   	if (wins > 0) lines.push('<div class="opl-w">' + mini('#E6B94C') + wins + ' OSCAR WIN' + (wins > 1 ? 'S' : '') + '</div>');
   	if (losses > 0) { var totalNoms = wins + losses; lines.push('<div class="opl-n">' + mini('#C9CDD3') + totalNoms +
   		(wins > 0 ? ' NOMINATION' : ' OSCAR NOMINATION') + (totalNoms > 1 ? 'S' : '') + '</div>'); }
   	// One festival ROW per festival, always after the Oscar rows. Single win → the controller
   	// wrote a -name-{DISPLAY} tag; count-form fallback covers older controllers.
   	if (cannes > 0) lines.push('<div class="opl-f f-cannes">' + FESTIVAL_REEL_SVG +
   		(cannesName || cannes + ' CANNES WIN' + (cannes > 1 ? 'S' : '')) + '</div>');
   	if (sundance > 0) lines.push('<div class="opl-f f-sundance">' + FESTIVAL_SUN_SVG +
   		(sundanceName || sundance + ' SUNDANCE WIN' + (sundance > 1 ? 'S' : '')) + '</div>');
   	if (!lines.length) return '';
   	return '<div class="oscar-plaque' + (large ? '' : ' oscar-plaque-sm') + '">' + lines.join('') + '</div>';
   }
   ```

4. **CSS** (`injectStyles`, `jellyfin-web-flair.js:451-460`). Insert AFTER the existing plaque rules
   (i.e. after `.oscar-plaque-sm svg{…}` at line 460), porting the mockup rules verbatim
   (`award-badges-mockup.html:115-124`). Colors `#9fb87f` (laurel) / `#f26d3d` (amber); square
   11×11 svg (9×9 in `-sm`); the `> div + div` rule gives ALL rows (Oscar + festival) the same 2px
   gap — that is the approved uniform-margins look:

   ```js
   // ---- Festival rows (Cannes reel / Sundance sun) — ported EXACTLY from award-badges-mockup.html:115-124
   '.oscar-plaque .opl-f{white-space:nowrap;}' +
   '.oscar-plaque > div + div{margin-top:2px;}' +
   '.oscar-plaque .opl-f .f-cannes{color:#9fb87f;}' +
   '.oscar-plaque .opl-f .f-sundance{color:#f26d3d;}' +
   '.oscar-plaque .opl-f svg{vertical-align:-4px;}' +
   '.oscar-plaque .opl-f svg.sun,.oscar-plaque .opl-f svg.reel{width:11px;height:11px;vertical-align:-2px;margin-right:4px;}' +
   '.oscar-plaque-sm .opl-f svg{vertical-align:-3px;}' +
   '.oscar-plaque-sm .opl-f svg.sun,.oscar-plaque-sm .opl-f svg.reel{width:9px;height:9px;vertical-align:-1px;margin-right:2px;}' +
   ```

   Specificity note: `.oscar-plaque .opl-f svg.sun` (3 classes + element) beats the existing
   `.oscar-plaque svg{width:9px;height:18px}` (line 457) for the festival icons, so no rule edit
   is needed — the tall-statuette sizing stays for the Oscar mini-icons.

5. **Mobile pill** — implements the mockup's pill panels (`award-badges-mockup.html:370-404`):
   festival content appears in the pill too. Three shapes, matching the approved reference:
   - **Mixed (Oscar + festival)** wide: `🏆 2 wins · 3 noms <span style="color:#9fb87f">· 🌴1</span>`
     (or `· ☀1` amber for Sundance) — festival glyph + count appended in its own colour.
   - **Mixed tight**: `🏆 1W · 0N <span style="color:#9fb87f">· 🌴1</span>` — one short segment.
   - **Festival-only**: whole pill becomes the festival accent (`☀ 3` amber, border tinted
     `rgba(242,109,61,.4)`; laurel `#9fb87f` for Cannes) — no Oscar text at all.
   The `applyFlair` oscar branch (`jellyfin-web-flair.js:1109-1132`) changes to:
   - Existing `hostW >= 180` plaque path unchanged (now passes festival ints).
   - Pill path: build the Oscar segment as today (guarded by `osc.w > 0 || osc.l > 0`), then
     append festival segments for `c>0` (🌴 + c) and `s>0` (☀ + s) inside colour spans; if the
     film is festival-only (`w===0 && l===0 && (c>0 || s>0)`), render just the festival glyph(s)
     with the pill's whole colour/border set to the festival accent (laurel wins over amber if
     both — rare, only sex lies videotape).
   - **Gotcha:** the old pill code would render `🏆 0N` for a festival-only film (truthy `osc`
     with `w===0 && l===0`). The `osc.w > 0 || osc.l > 0` gate on the Oscar segment is REQUIRED.
   - `mn-oscar-silver` (noms-only) logic stays: it applies to the Oscar segment only.
   - New CSS in `jellyfin-custom.css` (next to `.mn-oscar-text`, `:1752-1771`): `.mn-oscar-fest`
     span colours + the festival-only pill variant (`.mn-oscar-text.mn-oscar-festival` sets
     `color` + `border-color` to the active festival accent). The 🌴/☀ emoji are literal text
     glyphs, no SVG needed in the pill.

6. **Cleanup selector** (`applyFlair`, `jellyfin-web-flair.js:1093`): the existing
   `:scope > .oscar-plaque` wholesale clear already removes `.opl-f` children (they are inside the
   plaque). `STALE_FLAIR_SEL` (line 552) also already covers `.oscar-plaque` for the diffed
   re-decoration. **No change.**

7. **Deploy:** `make provision s=jellyfin` (flair is pushed via the JavaScript Injector, verified
   `jellyfin.sh:783`; deploy alone won't do it).

   **Verification (web):**
   ```bash
   make provision s=jellyfin
   curl -s http://localhost:8096/JavaScriptInjector/public.js | grep -c 'FESTIVAL_REEL_SVG'   # ≥1
   ```
   Hard-refresh the dashboard and eyeball: **Parasite** (4 OSCAR WINS + PALME D'OR),
   **CODA** (3 OSCAR WINS + 3 SUNDANCE WINS — no nomination line: real data is noms=3,wins=3),
   **sex, lies, and videotape** (festival-only: PALME D'OR + AUDIENCE).
   (The mockup's "Dune: Part Two → Jury Prize", "EEAAO → 1 SUNDANCE WIN" and "Triangle of
   Sadness → 3 NOMINATIONS + PALME D'OR" panels are **illustrative** — verified absent from both
   the library and `oscar-winners.json`'s festival collections. The mockup's CODA "2W/3N" panel is
   also illustrative; the live plaque will show 3W with no noms row. Do not expect those live.)

## Fire Stick (`~/jellyfin-androidtv`)

1. **`util/OscarAwards.kt`**: extend the data class and widen the regex. The new fields get
   **default values (`= 0`)** so `PersonOscarIndex.kt`'s two-arg constructors (lines 73 and 96)
   keep compiling unchanged — people have no festivals, so they need no `, 0, 0` edits (the plan's
   "no change" for PersonOscarIndex is only true because of the defaults):

   ```kotlin
   data class OscarAwards(val wins: Int, val losses: Int, val cannes: Int = 0, val sundance: Int = 0)

   private val OSCAR_TAG = Regex("^oscar-(wins|noms)-(\\d+)$")
   private val FESTIVAL_TAG = Regex("^festival-(cannes|sundance)-(\\d+)$")

   fun parseOscarTags(tags: List<String>?): OscarAwards? {
   	if (tags.isNullOrEmpty()) return null
   	var wins = 0
   	var losses = 0
   	var cannes = 0
   	var sundance = 0
   	var hit = false
   	for (tag in tags) {
   		OSCAR_TAG.matchEntire(tag)?.let { m ->
   			hit = true
   			val n = m.groupValues[2].toIntOrNull() ?: 0
   			if (m.groupValues[1] == "wins") wins = n else losses = n
   		}
   		FESTIVAL_TAG.matchEntire(tag)?.let { m ->
   			hit = true
   			val n = m.groupValues[2].toIntOrNull() ?: 0
   			if (m.groupValues[1] == "cannes") cannes = n else sundance = n
   		}
   	}
   	return if (hit) OscarAwards(wins, losses, cannes, sundance) else null
   }
   ```

   Name tags (`festival-cannes-name-…`) are intentionally NOT matched here — the Fire Stick always
   renders glyph + count (mockup lines 440/451), so `matchEntire` simply skips them.

2. **`util/OscarBadges.kt`** (`applyOscarPlaque`, lines 53-122). Add `cannes`/`sundance` params
   (defaults keep existing callers compiling), widen the GONE gate (line 55), add an icon-size
   param to `addLine`, and add the two festival rows:
   - **`addLine` icon-sizing gotcha** (lines 79-83): the statuette is hard-sized 6×12dp (compact) /
     8×16dp (large) via `LinearLayout.LayoutParams(dp(6f), dp(12f))`; festival glyphs are square
     7×7dp per the mockup (`award-badges-mockup.html:152`), so `addLine` needs `iconW`/`iconH`
     params. Existing win/nom calls stay 3-arg via defaults.
   - **Row spacing is already uniform** (line 100: `if (plaque.childCount > 0) rowLp.topMargin =
     dp(if (compact) 1f else 3f)`) — matches the mockup's `.row + .row { margin-top:1px }`
     (`:146`), so festival rows slot into the same 1dp stack with no extra spacing code.
   - **AppCompatResources gotcha** (line 78): `icon.setImageDrawable(AppCompatResources.getDrawable(context, iconRes))`
     — keep using AppCompatResources for the new vectors (API 22 compat). Do NOT switch to plain
     `ContextCompat`.

   ```kotlin
   fun applyOscarPlaque(
   	plaque: LinearLayout,
   	wins: Int,
   	losses: Int,
   	compact: Boolean = false,
   	cannes: Int = 0,
   	sundance: Int = 0,
   ) {
   	plaque.removeAllViews()
   	if (wins <= 0 && losses <= 0 && cannes <= 0 && sundance <= 0) {
   		plaque.visibility = View.GONE
   		return
   	}
   	// …lines 59-69 unchanged (density/dp/orientation/padding/background)…
   	fun addLine(
   		iconRes: Int,
   		text: String,
   		colorRes: Int,
   		iconW: Float = if (compact) 6f else 8f,
   		iconH: Float = if (compact) 12f else 16f,
   	) {
   		// …lines 72-78 unchanged…
   		val iconLp = LinearLayout.LayoutParams(dp(iconW), dp(iconH))
   		iconLp.marginEnd = dp(if (compact) 3f else 4f)
   		// …lines 84-101 unchanged…
   	}
   	// …wins/losses addLine calls unchanged (lines 104-120)…
   	if (cannes > 0) addLine(
   		R.drawable.ic_festival_cannes,
   		cannes.toString(),          // compact always: bare count ("1", "3" — mockup lines 440/451)
   		R.color.festival_cannes,
   		7f, 7f,                     // square 7×7dp glyph (mockup :152)
   	)
   	if (sundance > 0) addLine(
   		R.drawable.ic_festival_sundance,
   		sundance.toString(),
   		R.color.festival_sundance,
   		7f, 7f,
   	)
   	plaque.visibility = View.VISIBLE
   }
   ```

   **Param-order note (MINOR 1 fix):** `compact` is placed THIRD, before the festival ints, so the
   existing positional call `OscarBadgesKt.applyOscarPlaque(binding.oscarPlaque, wins, losses, true)`
   (`LegacyImageCardView.java:387`) keeps compiling untouched — a positional `true` would otherwise
   bind to `cannes: Int` and fail to build. All NEW call sites must use `compact = true` named
   argument (or pass `true` positionally — both correct with this ordering).

3. **New drawables** (solid fills only — GPU-crash rule: `ic_oscar_win.xml:2-3` removed its gradient
   2026-07-23 for a Fire Stick shader crash; strokes are fine, gradients are not). Android vectors
   have no `<circle>`/`<line>` elements, so the mockup's composed glyphs become pathData arcs:
   a full circle at center (cx,cy) radius r is `M{cx} {cy-r} a{r} {r} 0 1 1 -0.01 0 Z`.

   `res/drawable/ic_festival_cannes.xml` (reel; fill `@color/festival_cannes`, detail/stroke
   `@color/festival_cannes_stroke`):

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <!-- Cannes WIN badge — film reel (approved mockup glyph, award-badges-mockup.html:216/257).
        Laurel disc #9fb87f with dark #0e2a30 ring + 8 sprockets. Solid fills only (Fire Stick
        GPU crash rule — see ic_oscar_win.xml). viewBox 0 0 24 24, drawn square 7x7dp. -->
   <vector xmlns:android="http://schemas.android.com/apk/res/android"
       android:width="24dp"
       android:height="24dp"
       android:viewportWidth="24"
       android:viewportHeight="24">
       <path
           android:fillColor="@color/festival_cannes"
           android:pathData="M12 3 a9 9 0 1 1 -0.01 0 Z" />
       <path
           android:strokeColor="@color/festival_cannes_stroke"
           android:strokeWidth="1.6"
           android:pathData="M12 7 a5 5 0 1 1 -0.01 0 Z" />
       <path
           android:fillColor="@color/festival_cannes_stroke"
           android:pathData="M12 5 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M12 19 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M5 12 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M19 12 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M7.1 7.1 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M16.9 16.9 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M7.1 16.9 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0
               M16.9 7.1 m-1.3 0 a1.3 1.3 0 1 0 2.6 0 a1.3 1.3 0 1 0 -2.6 0" />
   </vector>
   ```

   `res/drawable/ic_festival_sundance.xml` (sun; fill + ray stroke `@color/festival_sundance`):

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <!-- Sundance WIN badge — sun (approved mockup glyph, award-badges-mockup.html:220/332).
        Amber disc #f26d3d + 8 round-cap rays. Solid fills only (Fire Stick GPU crash rule).
        viewBox 0 0 24 24, drawn square 7x7dp. -->
   <vector xmlns:android="http://schemas.android.com/apk/res/android"
       android:width="24dp"
       android:height="24dp"
       android:viewportWidth="24"
       android:viewportHeight="24">
       <path
           android:fillColor="@color/festival_sundance"
           android:pathData="M12 7 a5 5 0 1 1 -0.01 0 Z" />
       <path
           android:strokeColor="@color/festival_sundance"
           android:strokeWidth="2"
           android:strokeLineCap="round"
           android:pathData="M12 1.5 L12 4 M12 20 L12 22.5
               M1.5 12 L4 12 M20 12 L22.5 12
               M4.6 4.6 L6.4 6.4 M17.6 17.6 L19.4 19.4
               M4.6 19.4 L6.4 17.6 M17.6 6.4 L19.4 4.6" />
   </vector>
   ```

4. **`res/values/colors.xml`** — add next to the oscar block (`:6-9`):

   ```xml
   <!-- Festival badge glyphs (Cannes reel / Sundance sun) — see DESIGN-FESTIVAL-BADGES.md.
        Laurel #9fb87f + amber #f26d3d locked with the mockup; reel detail = mockup bg2. -->
   <color name="festival_cannes">#9fb87f</color>
   <color name="festival_cannes_stroke">#0e2a30</color>
   <color name="festival_sundance">#f26d3d</color>
   ```

5. **Call sites** (all currently `compact = true`):

   - **`ui/card/LegacyImageCardView.java:383-388`** — add the two params and extend the
     change-detection (currently `wins == lastOscarWins && losses == lastOscarLosses`, line 385):

     ```java
     private int lastOscarWins = -1, lastOscarLosses = -1, lastFestivalCannes = -1, lastFestivalSundance = -1;

     public void setOscarAwards(int wins, int losses, int cannes, int sundance) {
         if (binding.oscarPlaque == null) return;
         if (wins == lastOscarWins && losses == lastOscarLosses
                 && cannes == lastFestivalCannes && sundance == lastFestivalSundance) return;
         lastOscarWins = wins; lastOscarLosses = losses;
         lastFestivalCannes = cannes; lastFestivalSundance = sundance;
         OscarBadgesKt.applyOscarPlaque(binding.oscarPlaque, wins, losses, true, cannes, sundance);
     }
     ```
     And `CardPresenter.java:331` (`resetCardView`) becomes `mCardView.setOscarAwards(0, 0, 0, 0);`.

   - **`ui/presentation/CardPresenter.java:425-439`** — thread the new ints. The person fallback
     (lines 433-438, `PersonOscarIndex.INSTANCE.get(...)`) passes `0, 0` — people never carry
     festivals. Note the fallback's trigger (`oscarWins == 0 && oscarLosses == 0 && cardItem == null`)
     is unchanged: a festival-only MOVIE has `cardItem != null`, so it never falls into the person
     branch.

     ```java
     int oscarWins = 0, oscarLosses = 0, festivalCannes = 0, festivalSundance = 0;
     if (cardItem != null && cardItem.getTags() != null
             && (cardItem.getType() == BaseItemKind.MOVIE || cardItem.getType() == BaseItemKind.PERSON)) {
         OscarAwards oa = OscarAwardsKt.parseOscarTags(cardItem.getTags());
         if (oa != null) {
             oscarWins = oa.getWins(); oscarLosses = oa.getLosses();
             festivalCannes = oa.getCannes(); festivalSundance = oa.getSundance();
         }
     }
     if (oscarWins == 0 && oscarLosses == 0 && cardItem == null
             && rowItem instanceof BaseItemPersonBaseRowItem) {
         OscarAwards oa = PersonOscarIndex.INSTANCE.get(
                 ((BaseItemPersonBaseRowItem) rowItem).getPerson().getId());
         if (oa != null) { oscarWins = oa.getWins(); oscarLosses = oa.getLosses(); }
     }
     holder.mCardView.setOscarAwards(oscarWins, oscarLosses, festivalCannes, festivalSundance);
     ```

   - **`ui/presentation/MyDetailsOverviewRowPresenter.kt:58-59`**:

     ```kotlin
      val oscar = parseOscarTags(row.item.tags)
      applyOscarPlaque(binding.fdOscarPlaque, oscar?.wins ?: 0, oscar?.losses ?: 0,
          true, oscar?.cannes ?: 0, oscar?.sundance ?: 0)
     ```

   - **`ui/genres/GenreGridFragment.kt:333,402-410`** — the render guard must be widened too.
     **Gotcha:** today it is `oscar.wins > 0 || oscar.losses > 0` (line 402), which would EXCLUDE
     a festival-only film; add the festival counts:

     ```kotlin
      if (oscar != null && (oscar.wins > 0 || oscar.losses > 0 || oscar.cannes > 0 || oscar.sundance > 0)) {
          AndroidView<LinearLayout>(
              factory = { ctx -> LinearLayout(ctx) },
              update = { plaque -> applyOscarPlaque(plaque, oscar.wins, oscar.losses, true, oscar.cannes, oscar.sundance) },
              modifier = Modifier
                  .align(Alignment.BottomEnd)
                  .padding(end = 6.dp, bottom = 6.dp),
          )
      }
     ```

6. **`util/PersonOscarIndex.kt` / `routes-system.js:108-120`**: **no code change.** Festivals are
   film awards; people don't carry them. This holds because the `OscarAwards` new fields have
   default `= 0`, so the two-arg constructions at `PersonOscarIndex.kt:73` and `:96` still compile.

7. **Build:** `cd ~/jellyfin-androidtv && ./gradlew :app:compileDebugKotlin
   -Dorg.gradle.java.home=/home/brennan/jdk-21` (JDK 21 — system `java` is 17).

   **Verification (Fire Stick):**
   ```bash
   grep -n "festival" app/src/main/java/org/jellyfin/androidtv/util/OscarBadges.kt   # 2 addLine calls
   grep -n "festival" app/src/main/java/org/jellyfin/androidtv/util/OscarAwards.kt   # FESTIVAL_TAG + fields
   ```
   Build + sideload, then check a poster card and the detail poster for: **Parasite** (reel + `1`),
   **CODA** (sun + `3`), **sex, lies, and videotape** (reel + `1` AND sun + `1` on two rows).

## Deployment & verification

- Restart the controller to trigger the sweep → writes oscar + festival tags together, one
  `reconcileTags` POST per film (no extra writes): `make deploy s=controller` (boot runs the sweep;
  otherwise it's the 24h timer). The dataset holds **529 unique festival films** (324 Cannes + 206
  Sundance − 1 in both) — but **only ~51 of those exist in the 860-movie live library** (verified
  2026-08-01: 51 of 529 tmdb ids match library movies; ProviderIds coverage is 860/860 for both
  Imdb and Tmdb). So expect the sweep to tag roughly **51 films**, not 529 — that is correct, not
  a miss. Verify:
  ```bash
   docker logs controller | grep oscarTagsSweep
   # then eyeball an item — resolve the user id (jellyfinUserId is async) and query
   # Jellyfin for festival-tagged movies (Key from /opt/appdata/controller/keys.env):
   UID=$(docker exec controller node -e 'const {jellyfinUserId}=require("./lib/jellyfin");jellyfinUserId().then(console.log)')
   curl -s -H "X-Emby-Token: $JELLYFIN_KEY" \
     "http://localhost:8096/Users/$UID/Items?Recursive=true&IncludeItemTypes=Movie&Tags=festival&Fields=Tags&Limit=3" |
     jq '.Items[] | {Name, Tags}'
   ```
   (If the id dance is fiddly, just confirm a tagged movie's Tags contain `festival` +
   `festival-cannes-*` / `festival-sundance-*` via the Jellyfin UI.)
- Web: `make provision s=jellyfin`, hard-refresh; eyeball Parasite (4W + Palme), CODA (3W + 3
  Sundance), sex, lies, and videotape (2-festival, Oscar-free). Do NOT expect the mockup's
  Dune/EEAAO/Triangle-of-Sadness panels live — they are illustrative.
- Fire Stick: build + sideload, check poster card + detail poster.
- `make test` before and after.

## Decisions (resolved 2026-08-01)

1. **Name tag grammar: KEEP the `-name-{DISPLAY}` tag for the N === 1 case.**
   - **Why:** the approved mockup renders award *names* on the web plaque ("PALME D'OR", "JURY
     PRIZE" — `award-badges-mockup.html:257,283,525`). Count-only tags (`festival-cannes-N`) can't
     produce those, and the whole point of the feature is the prestige read. Skipping names would
     deviate from the approved reference to save a few bytes of tag text.
   - **Cost it imposes:** the web parser must treat count and name tags as independent (the review's
     BLOCKER — `parseInt(undefined)` clobbering `c` to 0). That is a 4-line guard, applied above.
   - **Rejected alternative:** count-only ("1 CANNES WIN") — loses the award-name fidelity the
     mockup was built around, and the dataset makes names cheap (only 3 cannes N≥2 and 20 sundance
     N≥2 films ever show a count form).

2. **Mobile pill: IMPLEMENT the mockup — festival content IS in the pill.**
   - **Why:** the mockup shows it in all three proposal pill panels, including the festival-only
     pill (`☀ 3` amber, `award-badges-mockup.html:370-404`). My original "keep pill Oscar-only"
     draft contradicted the approved reference; the adversarial review (MAJOR 1) caught that a
     festival-only film would render *nothing* on narrow mobile (<180px) cards — the majority of
     phone browsing. The pill must show `· 🌴1` / `· ☀1` appended, or the whole pill in the festival
     accent when there are no Oscars.
   - **Cost it imposes:** more CSS (`.mn-oscar-fest` span + festival-only pill variant) and a
     slightly busier pill. Bounded — the tight pill caps at one short segment and ellipsises.
   - **Rejected alternative:** Oscar-only pill — leaves 51 festival films badge-less on phones.

3. **Sundance multi-category naming: collapse Dramatic/Documentary to one label each.**
   - **Why:** `oscar-winners.json` splits Sundance into 6 collections (Grand Jury / Audience /
     Directing × Dramatic / Documentary). A film can only be in one of the two splits per award
     (it's either a dramatic or a documentary — never both), and the dataset has **0 films with a
     duplicate display label within one festival** (verified 2026-08-01), so collapsing
      `Grand Jury Prize (Dramatic)` + `(Documentary)` → `GRAND JURY` (etc.) is lossless.
      The labels match the mockup's canonical set (`award-badges-mockup.html:26-27,194`).
   - **Cost it imposes:** a 10-row `FESTIVAL_DISPLAY` table in the controller (the only place the
      mapping lives; neither client needs it).
   - **Rejected alternative:** separate per-split labels ("GRAND JURY (DRAMATIC)") — verbose,
     and the mockup shows the plain short form ("AUDIENCE" on sex lies videotape).
