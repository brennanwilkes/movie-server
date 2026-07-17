/*
 * Curated-list flair for the Jellyfin WEB client (movies.local:8096/web/).
 *
 * Mirrors the Firestick fork. Two features, both driven by the native "Top 100" / "Watchlist"
 * playlists (in-app editing of those playlists is the source of truth):
 *   1. On every movie poster/thumbnail — a "#rank" pill (Top 100) and a bookmark (Watchlist).
 *      Covers card grids, list rows, AND the item details page.
 *   2. Two navigation-drawer entries — "Top 100" and "Watchlist" — that open each playlist,
 *      replacing the generic "Playlists" entry.
 *
 * (Hiding clutter auto-collections is NOT done here — it's server-side via a tag + the user's
 * BlockedTags policy, reconciled by sort-collections.sh. Client-side hiding flashed the card and
 * left orphaned section headers, and didn't stop home-screen rows.)
 *
 * Delivered by the JavaScript Injector plugin (served at /JavaScriptInjector/public.js and loaded
 * from index.html). Wired up idempotently from scripts/provision/jellyfin.sh §6d3+§9.
 * See DESIGN-PLAYLISTS.md. Pure vanilla JS, no build step; everything is best-effort and swallows
 * its own errors so a jellyfin-web change can never break the app.
 *
 * Also pins all locale-formatted clock times (e.g. the playback "Ends at" readout) to Pacific —
 * see the immediately-following IIFE. Family members watch remotely from other timezones over the
 * Tailscale mesh, but the household reference clock is always Pacific, so this ignores whatever
 * timezone the viewing browser itself is set to.
 *
 * ── TABLE OF CONTENTS (search the "// ----" banner text; line numbers drift) ──────────────────
 *   IIFE 1  Pacific timezone patch (Date.prototype.toLocale*String)
 *   IIFE 2  main flair app:
 *     · config/state             — playlist names, ACCENT, REFRESH_MS, rank/watch caches
 *     · helpers (Top 100 enrichment) — rtText / eraColor / dirName / topCast
 *     · styles (injected once)   — refreshBrandingCss() cache-buster + injectStyles()
 *     · data                     — ApiClient reads, loadLists() playlist membership
 *     · flair overlay            — rank pill + watchlist bookmark on posters/details
 *     · sidebar (navigation drawer) entries — Top 100 / Watchlist replace "Playlists"
 *     · scan / observe           — MutationObserver + hashchange lifecycle
 *     · Top 100 web showcase     — Pantheon/Gallery/Ledger tiered playlist page
 *     · web theme roulette       — nested IIFE; per-tab palette from THEMES (see below)
 *     · sidebar drawer inline theming — beats scyfin's !important CSS
 *
 * ── DEPLOY CONSTRAINTS (why this stays ONE file) ───────────────────────────────────────────────
 *   • jellyfin.sh §9 pushes this whole file as a single string (jq --rawfile) into the
 *     JavaScript Injector plugin's CustomJavaScripts config; the plugin has no module/import
 *     support and dedupes our entry by Name ("Curated List Flair") — keep it self-contained.
 *   • The THEMES object in the roulette section hand-mirrors docs/branding/THEME-TOKENS.json
 *     (the declared source of truth, also mirrored in the Android TV fork's theme XMLs).
 *     `make check-themes` (scripts/check-theme-sync.sh) greps this file for each theme's
 *     accent + font values — run it after ANY edit to THEMES.
 */
(function () {
	'use strict';
	// Date.prototype.toLocale*String resolve to the *browser's* system timezone unless an explicit
	// timeZone is passed. jellyfin-web never passes one (see getDisplayTime in datetime.js), so on a
	// non-Pacific device "Ends at" silently shows that device's local time instead of ours. Force it.
	var PACIFIC = 'America/Vancouver';
	['toLocaleTimeString', 'toLocaleString', 'toLocaleDateString'].forEach(function (fn) {
		var orig = Date.prototype[fn];
		Date.prototype[fn] = function (locales, options) {
			if (!options || !options.timeZone) options = Object.assign({}, options, { timeZone: PACIFIC });
			return orig.call(this, locales, options);
		};
	});
})();

(function () {
	'use strict';

	var TOP_100 = 'Top 100';
	var WATCHLIST = 'Watchlist';
	var ACCENT = '#00a4dc'; // jellyfin_blue, matches the app theme + the Firestick badges
	var REFRESH_MS = 5 * 60 * 1000; // re-pull playlist membership every 5 min
	var MARK = 'curatedFlairId'; // dataset key: which item id an element was last decorated for

	var rankById = new Map(); // itemId -> 1-based rank in Top 100
	var watchSet = new Set(); // itemIds in Watchlist
	var oscarById = new Map(); // MOVIE id -> {w:wins, l:losses} from oscar-* Tags (bulk-loaded)
	var oscarByIdOnDemand = new Map(); // any id -> {w,l} or null — on-demand cache for PEOPLE (the
	// /Persons endpoint ignores the Tags filter and has 22k rows, so people can't be bulk-loaded;
	// we batch-fetch tags for exactly the person ids on screen instead). null = fetched, no awards.
	var oscarFetchPending = new Set(); // raw ids awaiting a batch fetch
	var oscarFetchTimer = null;
	var nationById = new Map(); // MOVIE id -> iso2 country code from nation-* Tags (bulk-loaded)
	var idByName = {}; // playlist name -> playlist id (for the sidebar entries)
	var playlistsViewId = null; // the "Playlists" library-view id, to locate its drawer entry
	var loaded = false;
	var top100Items = new Map(); // id -> enriched item (People, ImageTags, ProductionYear, RunTimeTicks)
	var _drawerCssCache = null;  // cached scyfin CSS-var reads for themeDrawer (theme is fixed per tab)
	var _currentNavCurId = '';   // live page ID for nav hover guards (updated each themeDrawer call)

	// ---- helpers (Top 100 enrichment) -------------------------------------------------------
	function rtText(ticks) {
		if (!ticks) return null;
		var m = Math.round(ticks / 600000000);
		return m >= 60 ? (Math.floor(m / 60) + 'h ' + (m % 60) + 'm') : (m + 'm');
	}
	function eraColor(y) {
		if (!y) return 'rgba(245,238,220,0.4)';
		if (y <= 1954) return 'rgba(201,204,210,0.67)';
		if (y <= 1975) return 'rgba(242,109,61,0.6)';
		if (y <= 1999) return 'rgba(217,142,50,0.6)';
		return 'rgba(245,238,220,0.4)';
	}
	function dirName(item) {
		var p = item && item.People; if (!p) return null;
		for (var i = 0; i < p.length; i++) if (p[i].Type === 'Director') return p[i].Name;
		return null;
	}
	function topCast(item, n) {
		var p = item && item.People; if (!p) return [];
		var r = [];
		for (var i = 0; i < p.length && r.length < (n || 3); i++) if (p[i].Type === 'Actor') r.push(p[i].Name);
		return r;
	}

	// ---- styles (injected once) --------------------------------------------------------------
	// Branding CSS cache buster: Jellyfin's Branding API returns CustomCss which the client
	// injects as a <style> tag, but the response is cached by the browser HTTP cache and
	// React Query across reloads — so CSS changes from `make provision` are invisible until
	// the user manually clears site data. Fix: re-fetch /Branding/Css with a unique query
	// param on every page load (bypasses all caching layers) and inject as a late <style>
	// that overrides the cached version via !important and cascade position.
	// The JS itself is always fresh (plugin rewrites URL on content change), so this runs
	// the latest code. One extra local HTTP request per page load (~70KB, <1ms on LAN).
	function refreshBrandingCss() {
		var id = 'mn-branding-cache-bust';
		if (document.getElementById(id)) return;
		fetch('/Branding/Css?v=' + Date.now())
			.then(function (r) { return r.ok ? r.text() : ''; })
			.then(function (css) {
				if (!css) return;
				var el = document.getElementById(id);
				if (!el) {
					el = document.createElement('style');
					el.id = id;
					document.head.appendChild(el);
				}
				el.textContent = css;
			})
			.catch(function () {});
	}

	function injectStyles() {
		ensureOscarDefs();   // idempotent; gradients must exist before any stack renders
		if (document.getElementById('curated-flair-styles')) return;
		// @font-face for Poppins — standalone CSS file in /web/fonts/ (not in CustomCss which may
		// strip @font-face, not inline <style> which may not trigger font loading after paint).
		// A <link> tag loads like a normal stylesheet, so the browser processes @font-face early.
		if (!document.getElementById('mn-poppins-link')) {
			var link = document.createElement('link');
			link.id = 'mn-poppins-link';
			link.rel = 'stylesheet';
			link.href = '/web/fonts/poppins-face.css';
			document.head.appendChild(link);
			// Also force-load so elements already painted pick up the new font.
			document.fonts.load('14.88px Poppins').catch(function() {});
		}
		// Bust the Branding CSS cache — must run every page load.
		refreshBrandingCss();
		var css =
			'.curated-rank,.curated-bookmark{position:absolute;z-index:3;pointer-events:none;}' +
			'.curated-rank{top:4px;right:4px;padding:0 5px;border-radius:4px;' +
			'font:700 12px/1.5 "Noto Sans",sans-serif;color:#fff;background:rgba(0,0,0,.62);' +
			'border:1px solid var(--primary-accent-color, ' + ACCENT + ');white-space:nowrap;}' +
			'.curated-bookmark{top:2px;left:4px;width:20px;height:20px;' +
			'filter:drop-shadow(0 0 1px rgba(0,0,0,.7));}' +
			// larger pill on the details page's big poster
			'.curated-host-detail .curated-rank{top:8px;right:8px;padding:1px 8px;font-size:15px;}' +
			'.curated-host-detail .curated-bookmark{top:6px;left:8px;width:28px;height:28px;}' +
			// ---- Oscar plaque (LARGE-format surfaces: detail posters) ----
			// The statuette cascade reads well at card size but looks busy on a big poster (Brennan
			// 2026-07-17). Details get a themed corner plaque instead — same visual family as the
			// .curated-rank pill (dark glass + accent border), bottom-right, stacked count lines.
			// Box anchors bottom-right, but content is LEFT-justified so the gold/silver statuettes
			// stack in a clean column ("NOMINATIONS" being longer otherwise pushes the wins row right).
			'.oscar-plaque{position:absolute;bottom:8px;right:8px;z-index:3;pointer-events:none;' +
			'padding:5px 10px;border-radius:4px;background:rgba(0,0,0,.62);' +
			'border:1px solid var(--primary-accent-color, ' + ACCENT + ');text-align:left;' +
			'font:700 13px/1.45 "Noto Sans",sans-serif;white-space:nowrap;}' +
			'.oscar-plaque .opl-w{color:#E6B94C;}' +
			'.oscar-plaque .opl-n{color:#C9CDD3;}' +
			'.oscar-plaque svg{width:9px;height:18px;vertical-align:-4px;margin-right:5px;}' +
			// compact variant for wide-but-not-huge artwork (list-row thumbnails)
			'.oscar-plaque-sm{bottom:4px;right:4px;padding:2px 7px;font-size:10px;line-height:1.4;}' +
			'.oscar-plaque-sm svg{width:7px;height:14px;vertical-align:-3px;margin-right:3px;}' +
			// ---- Oscar statuette badges (gold = wins, silver = losing noms) ----
			// Fanned cascade hanging off the poster's right edge, starting 22% down. 50% of each
			// icon spills past the edge (translateX(50%)). aspect-ratio:1 makes the container's
			// height equal its own width, so per-icon top/right % (set inline by oscarStackHtml)
			// resolve against a single unit W. z-index:2 keeps the whole stack UNDER the #53
			// corner motifs (.curated-rank / .curated-bookmark are z-index:3).
			'.oscar-stack{position:absolute;top:11%;right:0;transform:translateX(55%);width:17%;' +
			'min-width:14px;max-width:26px;aspect-ratio:1;z-index:2;pointer-events:none;' +
			'filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));}' +
			'.oscar-stack svg{position:absolute;width:100%;height:auto;display:block;overflow:visible;}' +
			// fill comes from the inline metallic gradient (see oscarStackHtml) — CSS only strokes.
			'.oscar-win path{stroke:#8A6B1F;stroke-width:1;}' +
			'.oscar-nom path{stroke:#6D7278;stroke-width:1;}' +
			'.curated-host-detail .oscar-stack{max-width:40px;}' +
			// ---- Nation flags (retro "luggage sticker" — see nation-tags.js sweep) ----
			// Bottom-left corner (watchlist owns top-left, rank+oscars own the right side).
			// z-index:2 like the oscar stack: under the #53 corner motifs. The tiny tilt is
			// deliberate — sells the vintage-sticker look.
			'.nation-flag{position:absolute;left:4px;bottom:4px;width:24%;min-width:20px;max-width:34px;' +
			'z-index:2;pointer-events:none;transform:rotate(-2deg);transform-origin:bottom left;' +
			'filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));}' +
			'.nation-flag svg{display:block;width:100%;height:auto;}' +
			'.curated-host-detail .nation-flag{max-width:52px;left:8px;bottom:8px;}' +
			// Mobile: cards are small and often landscape (short) — the half-off-the-edge fan
			// clips at the viewport/card edge and can outgrow the card. Tuck the stack fully
			// inside the poster and shrink it (oscarStackHtml also caps it to one column ≤600px).
			'@media (max-width:600px){' +
			'.oscar-stack{transform:none;right:3px;top:10%;width:13%;min-width:12px;max-width:20px;}' +
			'.curated-host-detail .oscar-stack{max-width:28px;}' +
			// theme-token corner geometry on the rank pill (reelone=square, canyon=pill);
			// desktop keeps the stock 4px look
			'.curated-rank{border-radius:var(--mn-pill-radius,4px);}' +
			'}';
		// Sidebar drawer hover: handled entirely by CSS (jellyfin-custom.css:287)
		// with correct :not(.navMenuOption-selected) guard — no JS-injected rule needed.
		var style = document.createElement('style');
		style.id = 'curated-flair-styles';
		style.textContent = css;
		document.head.appendChild(style);
	}

	function bookmarkSvg() {
		return '<svg class="curated-bookmark" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
			'<path fill="' + ACCENT + '" stroke="rgba(0,0,0,.5)" stroke-width="1" ' +
			'd="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/></svg>';
	}

	// ---- data --------------------------------------------------------------------------------
	function api() { return window.ApiClient; }

	function ready() {
		var a = api();
		return a && typeof a.getCurrentUserId === 'function' && a.getCurrentUserId() &&
			typeof a.accessToken === 'function' && a.accessToken();
	}

	function loadLists() {
		if (!ready()) return Promise.resolve();
		var a = api();
		var userId = a.getCurrentUserId();
		return a.getItems(userId, { IncludeItemTypes: 'Playlist', Recursive: true })
			.then(function (res) {
				var playlists = (res && res.Items) || [];
				var nextIds = {};
				playlists.forEach(function (p) { if (p.Name && p.Id) nextIds[p.Name] = p.Id; });
				idByName = nextIds;
				var jobs = [];
				var nextRank = new Map();
				var nextWatch = new Set();
				var nextTop100Items = new Map();
				var top100Id = nextIds[TOP_100];
				var watchId = nextIds[WATCHLIST];
				// Resolve the "Playlists" library view id so we can locate its drawer entry
				// language-independently (its href has no collectionType marker in this build).
				if (typeof a.getUserViews === 'function') {
					jobs.push(a.getUserViews({}, userId).then(function (r) {
						var views = (r && r.Items) || [];
						var pv = views.filter(function (v) { return v.CollectionType === 'playlists'; })[0];
						playlistsViewId = pv && pv.Id;
					}).catch(function () {}));
				}
				// Playlist order matters for rank -> use /Playlists/{id}/Items, NOT getItems(ParentId).
			if (top100Id) {
				jobs.push(a.getJSON(a.getUrl('Playlists/' + top100Id + '/Items', {
					UserId: userId, Fields: 'People,Studios', Limit: 100
				})).then(function (r) {
					((r && r.Items) || []).forEach(function (it, i) {
						if (it.Id && !nextRank.has(it.Id)) {
							nextRank.set(it.Id, i + 1);
							nextTop100Items.set(it.Id, it);
						}
					});
				}));
			}
			if (watchId) {
				jobs.push(a.getJSON(a.getUrl('Playlists/' + watchId + '/Items', { UserId: userId }))
					.then(function (r) {
						((r && r.Items) || []).forEach(function (it) { if (it.Id) nextWatch.add(it.Id); });
					}));
			}
			return Promise.all(jobs).then(function () {
				rankById = nextRank;
				top100Items = nextTop100Items;
				watchSet = nextWatch;
				loaded = true;
				// Clear markers so everything on screen re-decorates with the fresh data.
				document.querySelectorAll('[data-curated-flair-id]').forEach(function (c) { delete c.dataset[MARK]; });
				// Clear showcase markers too — top100Items may now be populated, so rows need
				// re-enrichment with clearlogos/fact lines that weren't available on first paint.
				document.querySelectorAll('[data-mn-showcase]').forEach(function (el) { delete el.dataset.mnShowcase; });
				scan();
			});
		})
		.catch(function () { /* ignore — retry on the next refresh tick */ });
	}

	function normalize(id) { return id ? id.replace(/-/g, '').toLowerCase() : id; }
	function rankFor(id) { return rankById.get(id) || rankById.get(normalize(id)); }
	function isWatch(id) { return watchSet.has(id) || watchSet.has(normalize(id)); }
	// Oscar counts for any id: bulk movie map first, then the on-demand (people) cache. Returns a
	// {w,l} object, or a falsy value when there are no awards / nothing is known yet.
	function oscarFor(id) { return oscarById.get(id) || oscarById.get(normalize(id)) || oscarByIdOnDemand.get(normalize(id)); }
	// True once we've fetched this id's tags (even if it had none) — so callers know not to re-request.
	function oscarFetched(id) { return oscarByIdOnDemand.has(normalize(id)); }

	// Queue an id (a person, or a non-preloaded detail item) for a batched tag fetch. Debounced so a
	// screenful of person cards resolves in one or two /Items?Ids= calls rather than N.
	function requestOscar(rawId) {
		if (!rawId || oscarByIdOnDemand.has(normalize(rawId))) return;
		oscarFetchPending.add(rawId);
		if (oscarFetchTimer) return;
		oscarFetchTimer = setTimeout(flushOscarFetch, 250);
	}
	function flushOscarFetch() {
		oscarFetchTimer = null;
		if (!ready() || !oscarFetchPending.size) return;
		var a = api();
		var userId = a.getCurrentUserId();
		var ids = Array.prototype.slice.call(oscarFetchPending);
		oscarFetchPending.clear();
		var jobs = [];
		for (var s = 0; s < ids.length; s += 60) {  // chunk to keep the query string sane
			var chunk = ids.slice(s, s + 60);
			jobs.push(a.getItems(userId, { Ids: chunk.join(','), Fields: 'Tags' })
				.then(function (res) {
					((res && res.Items) || []).forEach(function (it) {
						if (it.Id) oscarByIdOnDemand.set(normalize(it.Id), parseOscarTags(it.Tags));
					});
				}).catch(function () { /* ignore chunk */ }));
			// Mark every requested id as fetched even if Jellyfin omits some from the response,
			// so we never spin re-requesting the same id forever.
			chunk.forEach(function (rid) { if (!oscarByIdOnDemand.has(normalize(rid))) oscarByIdOnDemand.set(normalize(rid), null); });
		}
		Promise.all(jobs).then(function () {
			// Re-key any that DID come back with data (overwrites the provisional null above).
			document.querySelectorAll('[data-curated-flair-id]').forEach(function (c) { delete c.dataset[MARK]; });
			scan();
		});
	}

	// ---- Oscar badges (see DESIGN-OSCAR-BADGES.md) --------------------------------------------
	// The controller's oscarTagsSweep writes oscar-wins-N / oscar-noms-N Tags onto every Academy
	// Award movie (noms here = LOSING nominations; wins are separate). We pull those items and
	// parse the counts into oscarById, keyed by both GUID forms like rankById/watchSet.
	var OSCAR_TAG_RE = /^oscar-(wins|noms)-(\d+)$/;
	function parseOscarTags(tags) {
		if (!tags || !tags.length) return null;
		var w = 0, l = 0, hit = false;
		for (var i = 0; i < tags.length; i++) {
			var m = OSCAR_TAG_RE.exec(tags[i]);
			if (!m) continue;
			hit = true;
			if (m[1] === 'wins') w = parseInt(m[2], 10); else l = parseInt(m[2], 10);
		}
		return hit ? { w: w, l: l } : null;
	}
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
			oscarById = next;
			// Re-decorate on-screen cards with the fresh data (mirrors loadLists()).
			document.querySelectorAll('[data-curated-flair-id]').forEach(function (c) { delete c.dataset[MARK]; });
			scan();
		}
		// Primary: server-side Tags filter (verified filtering on this build). Fallback: if it comes
		// back empty (older server that ignores/rejects Tags), scan the whole library and filter here
		// — parseOscarTags ignores non-Oscar movies, so the wider result set is still correct.
		return a.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Tags: 'oscars', Fields: 'Tags', Limit: 2000 })
			.then(function (res) {
				var items = (res && res.Items) || [];
				if (items.length) { ingest(items); return; }
				return a.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Fields: 'Tags', Limit: 5000 })
					.then(function (r2) { ingest((r2 && r2.Items) || []); });
			})
			.catch(function () { /* ignore — retry on the next refresh tick */ });
	}

	// Single closed statuette path, viewBox 0 0 24 48 (head + tapered body + stepped pedestal).
	// IDENTICAL geometry to the Fire Stick fork's ic_oscar_win/nom vector pathData so both
	// platforms read the same. Rendered + eyeballed at 16px during implementation.
	var STATUETTE_PATH = 'M12 1.6 a3.5 3.5 0 1 1 -0.01 0 Z ' +
		'M9.4 8.9 c0.9 0.8 4.3 0.8 5.2 0 c0.5 1.1 0.2 2.1 0.7 3.2 c0.5 1.1 1 1.9 1 3.3 ' +
		'c0 1.5 -0.6 2.4 -1 3.6 c-0.4 1.2 -0.5 2.3 -0.5 3.9 V33.5 h-5.8 V22.9 ' +
		'c0 -1.6 -0.1 -2.7 -0.5 -3.9 c-0.4 -1.2 -1 -2.1 -1 -3.6 c0 -1.4 0.5 -2.2 1 -3.3 ' +
		'c0.5 -1.1 0.2 -2.1 0.7 -3.2 Z ' +
		'M8 34 h8 v3.6 h-8 Z M6 38.1 h12 v3.4 h-12 Z M4.2 42 h15.6 v3.4 H4.2 Z';
	// Fanned-columns cascade (NO cap — a super-acclaimed film shows ALL its trophies): gold
	// (wins) first, then silver (losses). Icons overlap TIGHTLY within a column and every row
	// also slides slightly LEFT (OSCAR_ROWDX) so no two icons are ever vertically aligned —
	// the column reads as a slanted fan, not a picket fence. Once a column fills (OSCAR_PERCOL)
	// a new column fans out further LEFT and slightly DOWN. Front column draws on top.
	// Geometry MUST match the Fire Stick fork's OscarBadges.applyOscarStack().
	var OSCAR_PERCOL = 5;      // icons per column
	var OSCAR_ROWSTEP = 0.30;  // vertical step within a column, as a fraction of icon HEIGHT
	var OSCAR_ROWDX = 0.16;    // per-ROW leftward slide, as a fraction of icon WIDTH (the jitter)
	var OSCAR_COLDX = 0.55;    // per-column leftward shift, as a fraction of icon WIDTH
	var OSCAR_COLDY = 0.20;    // per-column downward shift, as a fraction of icon HEIGHT
	// Metallic depth: horizontal gradients (lit left edge → deep shadow right) referenced by
	// url(#…). The defs live in ONE persistent hidden svg on <body> (ensureOscarDefs): url()
	// resolves document-wide to the FIRST matching id, so if the defs rode inside a stack that
	// happened to be hidden or recycled, every other stack lost its fill and rendered as
	// transparent outlines (the "outline-only statuettes" bug).
	function ensureOscarDefs() {
		if (document.getElementById('mn-oscar-defs')) return;
		var holder = document.createElement('div');
		holder.id = 'mn-oscar-defs';
		// NOT display:none — some engines skip resource resolution inside display:none subtrees.
		holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
		holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
			'<linearGradient id="mnOscGold" x1="0" y1="0" x2="1" y2="0">' +
			'<stop offset="0" stop-color="#f9e6a0"/><stop offset=".45" stop-color="#e2b54e"/>' +
			'<stop offset=".8" stop-color="#b3822a"/><stop offset="1" stop-color="#8a6b1f"/></linearGradient>' +
			'<linearGradient id="mnOscSilver" x1="0" y1="0" x2="1" y2="0">' +
			'<stop offset="0" stop-color="#f4f6f8"/><stop offset=".45" stop-color="#c3c8cf"/>' +
			'<stop offset=".8" stop-color="#9aa0a8"/><stop offset="1" stop-color="#6d7278"/></linearGradient>' +
			'</defs></svg>';
		document.body.appendChild(holder);
	}
	// The container has aspect-ratio:1 (height == its own width W), so `top`/`right` percentages
	// both resolve against W. Icon height = 2W, hence the ×2 on the vertical (height-based) terms.
	function oscarStackHtml(wins, losses) {
		var kinds = [];
		var i;
		for (i = 0; i < wins; i++) kinds.push('oscar-win');
		for (i = 0; i < losses; i++) kinds.push('oscar-nom');
		if (!kinds.length) return '';
		// Mobile (≤600px, matches the flair CSS breakpoint): cap to a single column so the
		// stack never outgrows the short landscape cards. Wins are pushed first, so the gold
		// stays. Deliberate deviation from the TV/desktop full cascade — space, not style.
		if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches && kinds.length > OSCAR_PERCOL) {
			kinds = kinds.slice(0, OSCAR_PERCOL);
		}
		var ncol = Math.ceil(kinds.length / OSCAR_PERCOL);
		// The right-edge spill transform is inlined with !important: theme hover rules (scyfin
		// applies transforms on card hover) otherwise override the class transform and the whole
		// stack visibly jumps left on mouseover. Mobile tucks the stack inside instead (matches
		// the ≤600px CSS block).
		var isMobile = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
		var stackStyle = isMobile ? 'transform:none !important;' : 'transform:translateX(55%) !important;';
		var svgs = kinds.map(function (cls, idx) {
			var col = Math.floor(idx / OSCAR_PERCOL);
			var row = idx % OSCAR_PERCOL;
			var top = (col * OSCAR_COLDY + row * OSCAR_ROWSTEP) * 2 * 100;   // % of W
			var right = (col * OSCAR_COLDX + row * OSCAR_ROWDX) * 100;       // % of W
			var z = (ncol - col) * 100 + row;   // front column + lower rows on top
			var grad = cls === 'oscar-win' ? 'mnOscGold' : 'mnOscSilver';
			// fill lives in the inline style (not CSS) so the gradient can't be overridden.
			return '<svg class="' + cls + '" viewBox="0 0 24 48" xmlns="http://www.w3.org/2000/svg" ' +
				'style="top:' + top.toFixed(1) + '%;right:' + right.toFixed(1) + '%;z-index:' + z + ';">' +
				'<path style="fill:url(#' + grad + ')" d="' + STATUETTE_PATH + '"/></svg>';
		});
		return '<div class="oscar-stack" style="' + stackStyle + '">' + svgs.join('') + '</div>';
	}

	// Large-format alternative to the cascade: themed corner plaque with count lines —
	// "5 OSCAR WINS" / "8 NOMINATIONS" — each led by a tiny solid statuette. `large` picks the
	// full-size variant (detail posters / big cards); otherwise a compact one (wide list thumbs).
	function oscarPlaqueHtml(wins, losses, large) {
		function mini(color) {
			return '<svg viewBox="0 0 24 48" xmlns="http://www.w3.org/2000/svg">' +
				'<path fill="' + color + '" d="' + STATUETTE_PATH + '"/></svg>';
		}
		var lines = [];
		if (wins > 0) lines.push('<div class="opl-w">' + mini('#E6B94C') + wins + ' OSCAR WIN' + (wins > 1 ? 'S' : '') + '</div>');
		if (losses > 0) lines.push('<div class="opl-n">' + mini('#C9CDD3') + losses +
			(wins > 0 ? ' NOMINATION' : ' OSCAR NOMINATION') + (losses > 1 ? 'S' : '') + '</div>');
		if (!lines.length) return '';
		return '<div class="oscar-plaque' + (large ? '' : ' oscar-plaque-sm') + '">' + lines.join('') + '</div>';
	}

	// ---- Nation flags (retro luggage-sticker vibe) ---------------------------------------------
	// The controller's nationTagsSweep tags every "reasonably non-USA" movie with `nation` +
	// `nation-{iso2}`. We bulk-load those and draw a small desaturated retro flag bottom-left.
	// Flags are built from a tiny spec DSL (stripes / nordic cross / disc / star / canton /
	// specials) in a muted vintage palette — NOT emoji, NOT true flag colors. The palette and
	// per-country specs MUST stay in sync with the Fire Stick fork's NationFlags.kt.
	var FLAG_C = {
		R: '#b5433a',  // worn red
		B: '#3b5a78',  // faded blue
		N: '#2e4058',  // deep navy
		W: '#f3ead7',  // aged cream (stands in for white)
		G: '#4c7a52',  // muted green
		Y: '#dcaf4e',  // mustard gold
		O: '#d3803c',  // burnt orange
		K: '#33302c',  // soft black
		C: '#7ca6bf',  // dusty light blue
		M: '#7d4046',  // maroon
	};
	// spec keys: h=[colors] horizontal stripes (hw=weights), v=[colors] vertical (vw=weights),
	// nordic={bg,cross,inner?}, disc={c,r,cx?,cy?}, ring={c,r}, star={c,cx,cy,r}, plus='W' (swiss),
	// crescent (turkey), wedge='B' (czech), canton:'gb' (+stars:'au'|'nz'), special:'gb|br|kr|ca|il|cl|tw|gr|pt'
	var FLAG_SPECS = {
		gb: { special: 'gb' },
		au: { h: ['N'], canton: 'gb', stars: 'au' }, nz: { h: ['N'], canton: 'gb', stars: 'nz' },
		ca: { special: 'ca' }, ie: { v: ['G', 'W', 'O'] },
		fr: { v: ['B', 'W', 'R'] }, it: { v: ['G', 'W', 'R'] }, be: { v: ['K', 'Y', 'R'] },
		ro: { v: ['B', 'Y', 'R'] }, mx: { v: ['G', 'W', 'R'], disc: { c: 'M', r: 2.6 } },
		de: { h: ['K', 'R', 'Y'] }, nl: { h: ['R', 'W', 'B'] }, ru: { h: ['W', 'B', 'R'] },
		hu: { h: ['R', 'W', 'G'] }, bg: { h: ['W', 'G', 'R'] }, at: { h: ['R', 'W', 'R'] },
		pl: { h: ['W', 'R'] }, id: { h: ['R', 'W'] }, ua: { h: ['B', 'Y'] },
		ee: { h: ['B', 'K', 'W'] }, lt: { h: ['Y', 'G', 'R'] }, lv: { h: ['M', 'W', 'M'], hw: [2, 1, 2] },
		es: { h: ['R', 'Y', 'R'], hw: [1, 2, 1] }, ir: { h: ['G', 'W', 'R'] },
		eg: { h: ['R', 'W', 'K'], disc: { c: 'Y', r: 2.4 } },
		th: { h: ['R', 'W', 'B', 'W', 'R'], hw: [1, 1, 2, 1, 1] },
		cu: { special: 'cu' }, cl: { special: 'cl' }, cz: { h: ['W', 'R'], wedge: 'B' },
		jp: { h: ['W'], disc: { c: 'R', r: 5.6 } }, bd: { h: ['G'], disc: { c: 'R', r: 5.2 } },
		kr: { special: 'kr' }, cn: { h: ['R'], star: { c: 'Y', cx: 7, cy: 7.5, r: 4.2 } },
		vn: { h: ['R'], star: { c: 'Y', cx: 18, cy: 12, r: 5.5 } },
		tr: { h: ['R'], crescent: true }, in: { h: ['O', 'W', 'G'], ring: { c: 'N', r: 3 } },
		br: { special: 'br' }, ar: { h: ['C', 'W', 'C'], disc: { c: 'Y', r: 2.4 } },
		uy: { h: ['W', 'C', 'W', 'C', 'W'], disc: { c: 'Y', r: 2.6, cx: 6, cy: 6 } },
		dk: { nordic: { bg: 'R', cross: 'W' } }, se: { nordic: { bg: 'B', cross: 'Y' } },
		no: { nordic: { bg: 'R', cross: 'W', inner: 'N' } }, fi: { nordic: { bg: 'W', cross: 'B' } },
		is: { nordic: { bg: 'B', cross: 'W', inner: 'R' } },
		ch: { h: ['R'], plus: 'W' }, gr: { special: 'gr' }, pt: { special: 'pt' },
		il: { special: 'il' }, tw: { special: 'tw' },
		hk: { h: ['R'], disc: { c: 'W', r: 4.8 } }, pe: { v: ['R', 'W', 'R'] },
	};
	function flagStar(cx, cy, r, color) {
		var pts = [];
		for (var i = 0; i < 10; i++) {
			var rad = (i % 2 === 0) ? r : r * 0.42;
			var a = -Math.PI / 2 + i * Math.PI / 5;
			pts.push((cx + rad * Math.cos(a)).toFixed(2) + ',' + (cy + rad * Math.sin(a)).toFixed(2));
		}
		return '<polygon points="' + pts.join(' ') + '" fill="' + color + '"/>';
	}
	// Union Jack within (x,y,w,h) — simplified: field, diagonals, St George cross. Retro-close.
	function unionJack(x, y, w, h) {
		var cx = x + w / 2, cy = y + h / 2;
		var s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + FLAG_C.N + '"/>';
		s += '<path d="M' + x + ' ' + y + ' L' + (x + w) + ' ' + (y + h) + ' M' + (x + w) + ' ' + y + ' L' + x + ' ' + (y + h) + '" stroke="' + FLAG_C.W + '" stroke-width="' + (h / 5) + '"/>';
		s += '<path d="M' + x + ' ' + y + ' L' + (x + w) + ' ' + (y + h) + ' M' + (x + w) + ' ' + y + ' L' + x + ' ' + (y + h) + '" stroke="' + FLAG_C.R + '" stroke-width="' + (h / 12) + '"/>';
		s += '<rect x="' + (cx - w / 9) + '" y="' + y + '" width="' + (2 * w / 9) + '" height="' + h + '" fill="' + FLAG_C.W + '"/>';
		s += '<rect x="' + x + '" y="' + (cy - h / 9) + '" width="' + w + '" height="' + (2 * h / 9) + '" fill="' + FLAG_C.W + '"/>';
		s += '<rect x="' + (cx - w / 15) + '" y="' + y + '" width="' + (2 * w / 15) + '" height="' + h + '" fill="' + FLAG_C.R + '"/>';
		s += '<rect x="' + x + '" y="' + (cy - h / 15) + '" width="' + w + '" height="' + (2 * h / 15) + '" fill="' + FLAG_C.R + '"/>';
		return s;
	}
	// Flag content for iso2 inside a 36x24 box (already clipped). Falls back to a navy pennant
	// with the country code — every tagged movie gets SOMETHING.
	function flagContent(iso) {
		var sp = FLAG_SPECS[iso];
		var W = 36, H = 24, s = '', i, xx, yy;
		function C(k) { return FLAG_C[k]; }
		if (!sp) {
			return '<rect width="36" height="24" fill="' + FLAG_C.N + '"/>' +
				'<text x="18" y="16.5" text-anchor="middle" font-family="Oswald,Archivo,sans-serif" ' +
				'font-size="11" font-weight="700" letter-spacing="1.5" fill="' + FLAG_C.W + '">' +
				iso.toUpperCase() + '</text>';
		}
		if (sp.special === 'gb') return unionJack(0, 0, W, H);
		if (sp.special === 'br') {
			return '<rect width="36" height="24" fill="' + C('G') + '"/>' +
				'<polygon points="18,3 33,12 18,21 3,12" fill="' + C('Y') + '"/>' +
				'<circle cx="18" cy="12" r="4.6" fill="' + C('B') + '"/>';
		}
		if (sp.special === 'kr') {
			return '<rect width="36" height="24" fill="' + C('W') + '"/>' +
				'<path d="M12.5 12 a5.5 5.5 0 0 1 11 0 Z" fill="' + C('R') + '"/>' +
				'<path d="M23.5 12 a5.5 5.5 0 0 1 -11 0 Z" fill="' + C('B') + '"/>' +
				'<g stroke="' + C('K') + '" stroke-width="1.3">' +
				'<path d="M3.5 4.5 l4 0 M3.5 6.5 l4 0 M3.5 8.5 l4 0" transform="rotate(-34 5.5 6.5)"/>' +
				'<path d="M28.5 15.5 l4 0 M28.5 17.5 l4 0 M28.5 19.5 l4 0" transform="rotate(-34 30.5 17.5)"/>' +
				'</g>';
		}
		if (sp.special === 'ca') {
			return '<rect width="36" height="24" fill="' + C('R') + '"/>' +
				'<rect x="9" width="18" height="24" fill="' + C('W') + '"/>' +
				'<path fill="' + C('R') + '" d="M18 5.5 l1.1 2.4 2-.8 -.5 2.3 2.4 1.7 -2.2.8 .8 2.2 -2.5-.5 -.2 2.4 h-1.8 l-.2-2.4 -2.5.5 .8-2.2 -2.2-.8 2.4-1.7 -.5-2.3 2 .8 z"/>' +
				'<rect x="17.6" y="15.5" width=".8" height="3" fill="' + C('R') + '"/>';
		}
		if (sp.special === 'il') {
			return '<rect width="36" height="24" fill="' + C('W') + '"/>' +
				'<rect y="2.5" width="36" height="2.6" fill="' + C('B') + '"/>' +
				'<rect y="18.9" width="36" height="2.6" fill="' + C('B') + '"/>' +
				'<g stroke="' + C('B') + '" stroke-width="1.1" fill="none">' +
				'<polygon points="18,7.6 21.8,14.2 14.2,14.2"/>' +
				'<polygon points="18,16.4 14.2,9.8 21.8,9.8"/></g>';
		}
		if (sp.special === 'cl') {
			return '<rect width="36" height="12" fill="' + C('W') + '"/>' +
				'<rect y="12" width="36" height="12" fill="' + C('R') + '"/>' +
				'<rect width="12" height="12" fill="' + C('B') + '"/>' + flagStar(6, 6, 3.4, C('W'));
		}
		if (sp.special === 'cu') {
			s = '<rect width="36" height="24" fill="' + C('W') + '"/>';
			for (i = 0; i < 5; i += 2) s += '<rect y="' + (i * 4.8) + '" width="36" height="4.8" fill="' + C('B') + '"/>';
			return s + '<polygon points="0,0 13,12 0,24" fill="' + C('R') + '"/>' + flagStar(4.5, 12, 3, C('W'));
		}
		if (sp.special === 'tw') {
			return '<rect width="36" height="24" fill="' + C('R') + '"/>' +
				'<rect width="18" height="12" fill="' + C('N') + '"/>' +
				'<circle cx="9" cy="6" r="3.4" fill="' + C('W') + '"/>';
		}
		if (sp.special === 'gr') {
			s = '';
			for (i = 0; i < 9; i++) s += '<rect y="' + (i * 24 / 9).toFixed(2) + '" width="36" height="' + (24 / 9).toFixed(2) + '" fill="' + C(i % 2 ? 'W' : 'B') + '"/>';
			s += '<rect width="13.3" height="13.3" fill="' + C('B') + '"/>';
			s += '<rect x="5.3" width="2.7" height="13.3" fill="' + C('W') + '"/>';
			s += '<rect y="5.3" width="13.3" height="2.7" fill="' + C('W') + '"/>';
			return s;
		}
		if (sp.special === 'pt') {
			return '<rect width="14.4" height="24" fill="' + C('G') + '"/>' +
				'<rect x="14.4" width="21.6" height="24" fill="' + C('R') + '"/>' +
				'<circle cx="14.4" cy="12" r="3.6" fill="' + C('Y') + '"/>';
		}
		// generic builders
		if (sp.h) {
			var hw = sp.hw || sp.h.map(function () { return 1; });
			var tot = hw.reduce(function (a, b) { return a + b; }, 0);
			for (i = 0, yy = 0; i < sp.h.length; i++) {
				var hh = 24 * hw[i] / tot;
				s += '<rect y="' + yy.toFixed(2) + '" width="36" height="' + (hh + 0.05).toFixed(2) + '" fill="' + C(sp.h[i]) + '"/>';
				yy += hh;
			}
		}
		if (sp.v) {
			var vw = sp.vw || sp.v.map(function () { return 1; });
			var vtot = vw.reduce(function (a, b) { return a + b; }, 0);
			for (i = 0, xx = 0; i < sp.v.length; i++) {
				var ww = 36 * vw[i] / vtot;
				s += '<rect x="' + xx.toFixed(2) + '" width="' + (ww + 0.05).toFixed(2) + '" height="24" fill="' + C(sp.v[i]) + '"/>';
				xx += ww;
			}
		}
		if (sp.nordic) {
			s += '<rect width="36" height="24" fill="' + C(sp.nordic.bg) + '"/>';
			s += '<rect x="9.5" width="6" height="24" fill="' + C(sp.nordic.cross) + '"/>';
			s += '<rect y="9" width="36" height="6" fill="' + C(sp.nordic.cross) + '"/>';
			if (sp.nordic.inner) {
				s += '<rect x="11" width="3" height="24" fill="' + C(sp.nordic.inner) + '"/>';
				s += '<rect y="10.5" width="36" height="3" fill="' + C(sp.nordic.inner) + '"/>';
			}
		}
		if (sp.wedge) s += '<polygon points="0,0 16,12 0,24" fill="' + C(sp.wedge) + '"/>';
		if (sp.canton === 'gb') s += unionJack(0, 0, 18, 12);
		if (sp.stars === 'au') {
			s += flagStar(9, 18, 3.2, C('W')) + flagStar(27, 6, 1.7, C('W')) + flagStar(31, 11, 1.7, C('W')) +
				flagStar(27, 17, 1.7, C('W')) + flagStar(23, 11, 1.4, C('W'));
		}
		if (sp.stars === 'nz') {
			s += flagStar(27, 5.5, 1.9, C('R')) + flagStar(31, 11, 1.9, C('R')) + flagStar(27, 17.5, 1.9, C('R')) + flagStar(23.5, 11, 1.6, C('R'));
		}
		if (sp.plus) {
			s += '<rect x="15.7" y="5" width="4.6" height="14" fill="' + C(sp.plus) + '"/>' +
				'<rect x="11" y="9.7" width="14" height="4.6" fill="' + C(sp.plus) + '"/>';
		}
		if (sp.crescent) {
			s += '<circle cx="14" cy="12" r="5.4" fill="' + C('W') + '"/>' +
				'<circle cx="15.6" cy="12" r="4.4" fill="' + C('R') + '"/>' + flagStar(21.5, 12, 2.2, C('W'));
		}
		if (sp.disc) s += '<circle cx="' + (sp.disc.cx || 18) + '" cy="' + (sp.disc.cy || 12) + '" r="' + sp.disc.r + '" fill="' + C(sp.disc.c) + '"/>';
		if (sp.ring) {
			s += '<circle cx="18" cy="12" r="' + sp.ring.r + '" fill="none" stroke="' + C(sp.ring.c) + '" stroke-width="1"/>';
			for (i = 0; i < 8; i++) {
				var a = i * Math.PI / 4;
				s += '<line x1="18" y1="12" x2="' + (18 + sp.ring.r * Math.cos(a)).toFixed(2) + '" y2="' + (12 + sp.ring.r * Math.sin(a)).toFixed(2) + '" stroke="' + C(sp.ring.c) + '" stroke-width=".7"/>';
			}
		}
		if (sp.star) s += flagStar(sp.star.cx, sp.star.cy, sp.star.r, C(sp.star.c));
		return s;
	}
	var _flagCache = {};
	function flagSvgHtml(iso) {
		if (_flagCache[iso]) return _flagCache[iso];
		// Rounded-rect clip + aged-cream sticker border + faint wear vignette on top.
		// Tilt inlined with !important: theme hover transforms otherwise flatten the sticker on
		// mouseover (same override mechanism as the oscar stack's spill transform).
		var html = '<div class="nation-flag" style="transform:rotate(-2deg) !important;">' +
			'<svg viewBox="0 0 36 24" xmlns="http://www.w3.org/2000/svg">' +
			'<defs><clipPath id="mn-flag-clip"><rect width="36" height="24" rx="3"/></clipPath></defs>' +
			'<g clip-path="url(#mn-flag-clip)">' + flagContent(iso) +
			'<rect width="36" height="24" rx="3" fill="rgba(51,48,44,.07)"/></g>' +
			'<rect x=".75" y=".75" width="34.5" height="22.5" rx="2.4" fill="none" stroke="' + FLAG_C.W + '" stroke-width="1.5"/>' +
			'<rect x=".2" y=".2" width="35.6" height="23.6" rx="2.8" fill="none" stroke="rgba(51,48,44,.5)" stroke-width=".4"/>' +
			'</svg></div>';
		_flagCache[iso] = html;
		return html;
	}
	var NATION_TAG_RE = /^nation-([a-z]{2})$/;
	function parseNationTag(tags) {
		if (!tags || !tags.length) return null;
		for (var i = 0; i < tags.length; i++) {
			var m = NATION_TAG_RE.exec(tags[i]);
			if (m) return m[1];
		}
		return null;
	}
	function nationFor(id) { return nationById.get(id) || nationById.get(normalize(id)); }
	function loadNations() {
		if (!ready()) return Promise.resolve();
		var a = api();
		var userId = a.getCurrentUserId();
		// One bulk query on the `nation` marker tag (same recipe as loadOscars).
		return a.getItems(userId, { IncludeItemTypes: 'Movie', Recursive: true, Tags: 'nation', Fields: 'Tags', Limit: 2000 })
			.then(function (res) {
				var next = new Map();
				(((res && res.Items) || [])).forEach(function (it) {
					var iso = parseNationTag(it.Tags);
					if (iso && it.Id) { next.set(it.Id, iso); next.set(normalize(it.Id), iso); }
				});
				nationById = next;
				document.querySelectorAll('[data-curated-flair-id]').forEach(function (c) { delete c.dataset[MARK]; });
				scan();
			})
			.catch(function () { /* ignore — retry on the next refresh tick */ });
	}

	// ---- flair overlay -----------------------------------------------------------------------
	// host = the positioned element that bounds the poster image; id = the movie's item id.
	function applyFlair(host, id, isDetail) {
		if (!host) return;
		if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
		if (isDetail) host.classList.add('curated-host-detail');
		// The Oscar fan spills past the right edge, so it must live on an ancestor that doesn't
		// clip. Grid cards clip on .cardImageContainer (border-radius + overflow:hidden) but their
		// .cardScalable parent doesn't and has the exact same box — escape to it when present.
		// List rows (.listItemImage) have no such wrapper; the stack stays inside there.
		var spillHost = host;
		var scal = host.classList && host.classList.contains('cardImageContainer') && host.parentElement &&
			host.parentElement.classList.contains('cardScalable') ? host.parentElement : null;
		if (scal) {
			if (getComputedStyle(scal).position === 'static') scal.style.position = 'relative';
			spillHost = scal;
		}
		// Clear any prior flair on this host (recycled nodes / data refresh).
		host.querySelectorAll(':scope > .curated-rank, :scope > .curated-bookmark, :scope > .oscar-stack, :scope > .oscar-plaque, :scope > .nation-flag').forEach(function (n) { n.remove(); });
		if (spillHost !== host) spillHost.querySelectorAll(':scope > .oscar-stack').forEach(function (n) { n.remove(); });
		var rank = rankFor(id);
		if (rank) {
			var pill = document.createElement('div');
			pill.className = 'curated-rank';
			pill.textContent = '#' + rank;
			host.appendChild(pill);
		}
		if (isWatch(id)) host.insertAdjacentHTML('beforeend', bookmarkSvg());
		// Oscars: textual corner plaque anywhere the artwork is LARGE-format (detail posters, wide
		// list thumbnails, big grid cards); the statuette cascade only on small posters, where it
		// reads well (Brennan 2026-07-17: "anywhere that's not small format" gets the plaque).
		// 180px rendered width is the cutover; a 0 width (not laid out yet) falls to the cascade
		// and self-corrects on the next scan tick once layout exists.
		var osc = oscarFor(id);
		if (osc) {
			var hostW = host.getBoundingClientRect ? host.getBoundingClientRect().width : 0;
			if (isDetail || hostW >= 180) {
				host.insertAdjacentHTML('beforeend', oscarPlaqueHtml(osc.w, osc.l, isDetail || hostW >= 300));
			} else {
				spillHost.insertAdjacentHTML('beforeend', oscarStackHtml(osc.w, osc.l));
			}
		}
		// Nation flag — bottom-left retro sticker (fully inside the poster, no spill).
		var iso = nationFor(id);
		if (iso) host.insertAdjacentHTML('beforeend', flagSvgHtml(iso));
	}

	// A grid card or a list row: id + type live on the element; poster is a known child.
	function decorateItem(el) {
		var id = el.getAttribute('data-id');
		if (!id) return;
		if (el.dataset[MARK] === id) return;
		var type = el.getAttribute('data-type');
		// People get Oscar badges too (directors/actors — e.g. Scorsese). Their counts aren't
		// bulk-loaded, so request a batched tag fetch the first time we see one; don't set MARK
		// yet, so the card re-decorates once the fetch lands.
		if (type === 'Person') {
			if (!oscarFetched(id)) { requestOscar(id); return; }
			el.dataset[MARK] = id;
			if (!oscarFor(id)) return;
			applyFlair(el.querySelector('.cardImageContainer') || el.querySelector('.cardScalable') ||
				el.querySelector('.listItemImage') || el.querySelector('.cardImage') || el, id, false);
			return;
		}
		el.dataset[MARK] = id;
		// Movies only otherwise (rank is a movie concept). Still mark, so we don't re-scan it.
		if (type !== 'Movie') return;
		if (!rankFor(id) && !isWatch(id) && !oscarFor(id) && !nationFor(id)) return;
		var host = el.querySelector('.cardImageContainer') || el.querySelector('.cardScalable') ||
			el.querySelector('.listItemImage') || el.querySelector('.cardImage') || el;
		applyFlair(host, id, false);
	}

	// The item details page: the poster is a `.card` WITHOUT data-id inside `.detailImageContainer`
	// (there are two — mobile + desktop, one hidden). The id lives only in the URL hash. We always
	// run applyFlair (it clears stale flair) so navigating between movies updates/removes correctly.
	function decorateDetails() {
		var hash = location.hash || '';
		if (hash.indexOf('/details') === -1) return;
		var q = hash.split('?')[1];
		if (!q) return;
		var id;
		try { id = new URLSearchParams(q).get('id'); } catch (e) { id = null; }
		if (!id) return;
		// Person detail pages (and any non-preloaded item) aren't in the bulk movie map — fetch
		// this id's tags on demand so a person's page gets badges too.
		if (!oscarFor(id) && !oscarFetched(id)) requestOscar(id);
		document.querySelectorAll('.detailImageContainer').forEach(function (dc) {
			var host = dc.querySelector('.cardScalable') || dc.querySelector('.cardImageContainer') || dc;
			if (host.dataset[MARK] === id) return;
			host.dataset[MARK] = id;
			applyFlair(host, id, true);
		});
	}

	// ---- sidebar (navigation drawer) entries -------------------------------------------------
	// Clone the native "Playlists" drawer link into "Top 100" and "Watchlist", then hide it.
	function findPlaylistsLink(container) {
		// Prefer matching by the Playlists library-view id (language-independent).
		if (playlistsViewId) {
			var byId = container.querySelector('a.lnkMediaFolder[data-itemid="' + playlistsViewId + '"]');
			if (byId) return byId;
		}
		// Fallback: match the visible label text.
		var links = container.querySelectorAll('a.lnkMediaFolder');
		for (var i = 0; i < links.length; i++) {
			var t = links[i].querySelector('.sectionName, .navMenuOptionText');
			if (t && t.textContent.trim().toLowerCase() === 'playlists') return links[i];
		}
		return null;
	}

	function addSidebarEntries() {
		var container = document.querySelector('.libraryMenuOptions');
		if (!container) return;
		var playlistsLink = findPlaylistsLink(container);
		if (!playlistsLink) return;
		var serverId = (api() && api().serverId && api().serverId()) || '';

		function ensureEntry(marker, name, playlistId) {
			if (!playlistId) return;
			if (container.querySelector('a[data-curated="' + marker + '"]')) return; // already present
			var link = playlistsLink.cloneNode(true);
			link.setAttribute('data-curated', marker);
			link.removeAttribute('data-itemid');
			link.setAttribute('href', '#/details?id=' + playlistId + (serverId ? '&serverId=' + serverId : ''));
			var text = link.querySelector('.navMenuOptionText, .sectionName');
			if (text) text.textContent = name;
			playlistsLink.after(link);
		}
		// Insert in reverse so both land immediately after the original, in order.
		ensureEntry('watchlist', WATCHLIST, idByName[WATCHLIST]);
		ensureEntry('top100', TOP_100, idByName[TOP_100]);
		// Hide the generic Playlists entry (re-applied every pass, since the drawer rebuilds).
		// Use an !important inline style — the .hide class alone doesn't stick on the
		// emby-linkbutton custom element in this build.
		if (idByName[TOP_100] || idByName[WATCHLIST]) {
			playlistsLink.classList.add('hide');
			playlistsLink.style.setProperty('display', 'none', 'important');
		}
	}

	// ---- header-right controls → side nav (#18) ---------------------------------------------
	// Jellyfin's header-right cluster is hidden via CSS (.headerRight); we surface the two we
	// want as themed drawer entries. Cast / SyncPlay / audio-player are intentionally NOT
	// surfaced — they open device pickers anchored to their (now display:none) header button,
	// which renders at 0,0, and they're phone/player concerns anyway.
	//   · Search  — forwards a click to the real .headerSearchButton (opens the native search).
	//   · Settings — a plain nav link straight to #/mypreferencesmenu (what Jellyfin's own
	//                onSettingsClick navigates to); no click-forward, so no stray popup.
	// Availability mirrors Jellyfin's own `.hide` class on the source button (Settings only
	// appears while logged in). Re-created every scan (idempotent) so it survives the drawer
	// rebuild-on-open; final ordering is enforced separately by orderDrawer().
	var HEADER_CONTROLS = [
		{ marker: 'ctrl-search', label: 'Search', availSel: '.headerSearchButton', forwardSel: '.headerSearchButton' },
		{ marker: 'ctrl-user', label: 'Settings', availSel: '.headerUserButton', href: '#/mypreferencesmenu' },
	];
	// Control markers we USED to inject but no longer want — removed on sight (drops stale
	// entries left in a rebuilt-but-not-yet-reset drawer after this script updates).
	var DROPPED_CONTROLS = ['ctrl-cast', 'ctrl-sync', 'ctrl-audio'];

	function addControlEntries() {
		var container = document.querySelector('.libraryMenuOptions');
		if (!container) return;
		var header = document.querySelector('.skinHeader');
		if (!header) return;
		// A real library nav link gives us a correctly-structured, themeable template.
		var template = container.querySelector('a.navMenuOption');
		if (!template) return;

		HEADER_CONTROLS.forEach(function (ctrl) {
			var src = header.querySelector(ctrl.availSel);
			var available = src && !src.classList.contains('hide');
			var existing = container.querySelector('a[data-curated="' + ctrl.marker + '"]');
			if (!available) { if (existing) existing.remove(); return; } // mirror the header's availability
			if (existing) return; // already present

			var link = template.cloneNode(true);
			link.removeAttribute('style');          // let themeDrawer() re-theme it fresh
			delete link.dataset.mnStyled;
			delete link.dataset.mnSelected;
			link.classList.remove('navMenuOption-selected');
			link.removeAttribute('data-itemid');
			link.removeAttribute('data-id');
			link.setAttribute('data-curated', ctrl.marker);
			var text = link.querySelector('.navMenuOptionText, .sectionName');
			if (text) text.textContent = ctrl.label;
			if (ctrl.href) {
				link.setAttribute('href', ctrl.href); // native SPA hash routing
			} else {
				link.setAttribute('href', '#');
				link.addEventListener('click', function (e) {
					e.preventDefault();
					e.stopPropagation();
					var b = header.querySelector(ctrl.forwardSel);
					if (b) b.click();
				});
			}
			container.appendChild(link);
		});
	}

	// ---- drawer ordering (#18) ---------------------------------------------------------------
	// Desired visible order (Home lives OUTSIDE .libraryMenuOptions, always first, untouched):
	//   Top 100 · All Movies · All TV Shows — divider — Search · Collections · Watchlist · Settings
	// A thin divider separates the primary browse links from the low-priority Settings tail.
	function navText(a) {
		var t = a.querySelector('.navMenuOptionText, .sectionName');
		return ((t || a).textContent || '').trim();
	}
	function orderPriority(el) {
		var cur = el.getAttribute('data-curated');
		if (cur === 'top100') return 20;
		if (cur === 'watchlist') return 87; // below Search in the tail
		if (cur === 'ctrl-search') return 85; // Search — tail, above Settings
		if (cur === 'ctrl-user') return 90;   // Settings — bottom of the tail
		var txt = navText(el).toLowerCase();
		if (txt === 'all movies') return 30;
		if (txt === 'all tv shows') return 40;
		if (txt === 'collections') return 86; // below Search in the tail
		return 70; // other/unknown library views: kept, grouped before the divider
	}
	function makeDivider() {
		var d = document.createElement('div');
		d.setAttribute('data-curated', 'ctrl-divider');
		d.className = 'mn-nav-divider';
		d.style.cssText = 'height:1px;margin:12px 18px 6px;background:rgba(255,255,255,0.14);border-radius:1px;';
		return d;
	}
	function orderDrawer() {
		var container = document.querySelector('.libraryMenuOptions');
		if (!container) return;
		// Rename native library labels for clarity (idempotent).
		container.querySelectorAll('a.navMenuOption').forEach(function (a) {
			var t = a.querySelector('.navMenuOptionText, .sectionName');
			if (!t) return;
			var v = t.textContent.trim();
			if (v === 'Movies') t.textContent = 'All Movies';
			else if (v === 'TV' || v === 'TV Shows') t.textContent = 'All TV Shows';
		});
		// Drop control clones we no longer surface.
		DROPPED_CONTROLS.forEach(function (m) {
			var e = container.querySelector('a[data-curated="' + m + '"]');
			if (e) e.remove();
		});
		// Build the desired sequence, inserting the divider before the first tail item (>=90).
		var items = Array.prototype.slice.call(container.querySelectorAll('a.navMenuOption'));
		items.sort(function (a, b) { return orderPriority(a) - orderPriority(b); });
		var divider = container.querySelector('[data-curated="ctrl-divider"]');
		var seq = [], placedDivider = false;
		items.forEach(function (el) {
			if (!placedDivider && orderPriority(el) >= 80) {
				if (!divider) divider = makeDivider();
				seq.push(divider);
				placedDivider = true;
			}
			seq.push(el);
		});
		if (!placedDivider && divider) { divider.remove(); divider = null; } // no tail → no divider
		// Churn guard: only touch the DOM when the order actually differs, else the reorder
		// would fire the MutationObserver → scan → reorder in a loop every 500ms.
		var current = Array.prototype.slice.call(
			container.querySelectorAll('a.navMenuOption, [data-curated="ctrl-divider"]'));
		var same = current.length === seq.length && current.every(function (el, i) { return el === seq[i]; });
		if (same) return;
		seq.forEach(function (el) { container.appendChild(el); }); // appendChild moves existing nodes
	}

	// ---- scan / observe ----------------------------------------------------------------------
	// On a playlist detail page, jellyfin gives each item row data-action="playallfromhere",
	// so clicking a movie starts playback immediately instead of opening its details page.
	// Rewrite that primary action to "link" — jellyfin's own click handler then navigates to
	// the movie (using the row's data-id/data-serverid). Scoped to rows carrying a
	// data-playlistitemid, so only playlist views are touched; the drag handle and the
	// per-row menu/played/favourite buttons keep their own actions. Idempotent: once a row is
	// "link" it no longer matches, so our own DOM change doesn't re-trigger.
	function playlistClicksToDetails() {
		document.querySelectorAll('[data-playlistitemid][data-action="playallfromhere"]').forEach(function (row) {
			// The row carries the item's data-id/serverid/type, so it's the correct link target.
			row.setAttribute('data-action', 'link');
			// The poster child has its own playallfromhere action but NO data-id, so retargeting
			// it to "link" would misresolve. Drop its action instead → clicks defer up to the row.
			row.querySelectorAll('[data-action="playallfromhere"]').forEach(function (el) {
				el.removeAttribute('data-action');
			});
		});
	}

	// Shuffle the Watchlist detail page's rows on each visit, so it feels fresh — mirroring how
	// the curated collection rows randomize (ItemSortBy.RANDOM) elsewhere. Scoped to the Watchlist
	// playlist id ONLY: Top 100 keeps its hand-ranked order (Brennan's source of truth). Display
	// only — we reorder DOM nodes, never the stored playlist. Shuffles once per rendered list
	// (a dataset marker on the container), so a fresh visit (new container) reshuffles but scroll/
	// mutations don't; our own reorder doesn't re-trigger since the marker is already set.
	function shuffleWatchlist() {
		var watchId = idByName[WATCHLIST];
		if (!watchId) return;
		var hash = location.hash || '';
		if (hash.indexOf('/details') === -1) return;
		var q = hash.split('?')[1];
		if (!q) return;
		var id;
		try { id = new URLSearchParams(q).get('id'); } catch (e) { return; }
		if (!id || normalize(id) !== normalize(watchId)) return; // only the Watchlist page
		var container = document.querySelector('#childrenContent .itemsContainer');
		if (!container || container.dataset.curatedShuffled) return;
		var rows = Array.prototype.slice.call(container.querySelectorAll(':scope > .listItem'));
		if (rows.length < 2) return; // nothing to shuffle (or not rendered yet — retry next tick)
		container.dataset.curatedShuffled = '1';
		for (var i = rows.length - 1; i > 0; i--) { // Fisher-Yates
			var j = Math.floor(Math.random() * (i + 1));
			var tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
		}
		rows.forEach(function (r) { container.appendChild(r); }); // re-append in shuffled order
	}


	// ---- Top 100 web showcase (NEXT-STEPS §6) --------------------------------------------------
	// Decorates the Top 100 playlist page IN PLACE — the stock rows (and their drag handles for
	// re-ranking, which web keeps unlike the TV app) stay intact; we add tier classes, rank
	// numerals and backdrop row-backgrounds, and hide the genre/runtime header junk. Ranks 1-10
	// get tall hero rows, 11-50 medium, 51+ stay compact. Idempotent per row via a dataset marker.
	// ---- Web theme roulette (parity with the Fire Stick launch roulette) ----------------------
	// Each page load draws one of the four Movie Night palettes (never repeating the previous
	// draw — sessionStorage remembers it) and overrides scyfin's CSS variables inline.
	// Persisted in sessionStorage so the theme stays consistent within a tab session (matching
	// the Firestick app's one-theme-per-launch behavior). Only re-randomizes on new tab/window.
	(function themeRoulette() {
		try {
		// SOURCE OF TRUTH: docs/branding/THEME-TOKENS.json — this object hand-mirrors it (the
		// Android TV fork's theme_movienight_*.xml files are the third copy). If you change a
		// value here, change the JSON (and the XMLs) too, then run `make check-themes`
		// (scripts/check-theme-sync.sh greps this file for each theme's accent + fontFamily).
		// One block per theme: canyon / matinee / reelone / marquee.
		var THEMES = {
			canyon:  { accent: '#47c4b8', accent2: '#f26d3d', bg: '#091d22', bg2: '#0e2a30', muted: '#C9B99A', text: '#F5EEDC', textOnAccent: '#0c2429', r: 71,  g: 196, b: 184, btnRound: '999px', navFont: 'Poppins, "Segoe UI", sans-serif', navCase: 'uppercase', navTrack: '.02em',
				cardRadius: '8px', btnRadius: '999px', inputRadius: '6px', pillRadius: '99px', sheetRadius: '8px',
				glowColor: 'rgba(71,196,184,0.6)', glowSpread: '24px',
				lithoX: '0px', lithoY: '0px', lithoColor: 'transparent',
				glowText: 1, gildedText: 0, cutGeometry: 0, lithoOffsetX: 0, textureGrain: 0, textureCrosshatch: 0,
				dividerColor: 'rgba(255,255,255,0.06)', dividerAccent: '#47C4B8',
				scrollbarColor: 'rgba(71,196,184,0.35)' },
			matinee: { accent: '#d98e32', accent2: '#a62b1f', bg: '#160d06', bg2: '#191009', muted: '#7A6B5A', text: '#e8d5b0', textOnAccent: '#1c120a', r: 217, g: 142, b: 50, btnRound: '2px', navFont: '"Oswald", "Segoe UI", sans-serif', navCase: 'uppercase', navTrack: '.09em',
				cardRadius: '3px', btnRadius: '2px', inputRadius: '0px', pillRadius: '2px', sheetRadius: '3px',
				glowColor: 'transparent', glowSpread: '0px',
				lithoX: '3px', lithoY: '3px', lithoColor: '#B52A1A',
				glowText: 0, gildedText: 0, cutGeometry: 0, lithoOffsetX: 3, textureGrain: 1, textureCrosshatch: 1,
				dividerColor: 'rgba(181,42,26,0.2)', dividerAccent: '#B52A1A',
				scrollbarColor: 'rgba(217,142,50,0.35)' },
			reelone: { accent: '#e8442e', accent2: '#E34234', bg: '#0b0b0b', bg2: '#101010', muted: '#8d8a80', text: '#f2efe6', textOnAccent: '#ffffff', r: 232, g: 68,  b: 46, btnRound: '0px', navFont: '"Archivo", "Segoe UI", sans-serif', navCase: 'uppercase', navTrack: '.06em',
				cardRadius: '0px', btnRadius: '0px', inputRadius: '0px', pillRadius: '0px', sheetRadius: '0px',
				glowColor: 'transparent', glowSpread: '0px',
				lithoX: '0px', lithoY: '0px', lithoColor: 'transparent',
				glowText: 0, gildedText: 0, cutGeometry: 1, lithoOffsetX: 0, textureGrain: 0, textureCrosshatch: 0,
				dividerColor: '#333333', dividerAccent: '#E8442E',
				scrollbarColor: 'rgba(232,68,46,0.35)' },
			marquee: { accent: '#c9a227', accent2: '#7a1e1e', bg: '#0d0a05', bg2: '#0e0b06', muted: '#9a8c6e', text: '#f2e6cb', textOnAccent: '#1a1406', r: 201, g: 162, b: 39, btnRound: '2px', navFont: '"Jost", "Segoe UI", sans-serif', navCase: 'uppercase', navTrack: '.2em',
				cardRadius: '3px', btnRadius: '2px', inputRadius: '2px', pillRadius: '3px', sheetRadius: '3px',
				glowColor: 'rgba(201,162,39,0.3)', glowSpread: '16px',
				lithoX: '0px', lithoY: '0px', lithoColor: 'transparent',
				glowText: 0, gildedText: 1, cutGeometry: 0, lithoOffsetX: 0, textureGrain: 0, textureCrosshatch: 1,
				dividerColor: 'rgba(143,107,46,0.25)', dividerAccent: '#D4AF37',
				scrollbarColor: 'rgba(201,162,39,0.35)' },
		};
			var names = Object.keys(THEMES);
			var stored = sessionStorage.getItem('mnTheme');
			var pick = stored && THEMES[stored] ? stored : names[Math.floor(Math.random() * names.length)];
			sessionStorage.setItem('mnTheme', pick);
			var t = THEMES[pick];
			var r = document.documentElement.style;
			r.setProperty('--primary-accent-color', t.accent);
			r.setProperty('--secondary-accent-color', t.accent2);
			r.setProperty('--primary-background-color', t.bg);
			r.setProperty('--secondary-background-color', t.bg2);
			r.setProperty('--mn-muted', t.muted);
			r.setProperty('--mn-text', t.text);
			r.setProperty('--mn-text-on-accent', t.textOnAccent);
			r.setProperty('--mn-btn-round', t.btnRound);
			r.setProperty('--mn-nav-font', t.navFont);
			r.setProperty('--mn-nav-case', t.navCase);
			r.setProperty('--mn-nav-track', t.navTrack);
			r.setProperty('--primary-r', t.r); r.setProperty('--primary-g', t.g); r.setProperty('--primary-b', t.b);
			r.setProperty('--mn-card-radius', t.cardRadius);
			r.setProperty('--mn-btn-radius', t.btnRadius);
			r.setProperty('--mn-input-radius', t.inputRadius);
			r.setProperty('--mn-pill-radius', t.pillRadius);
			r.setProperty('--mn-sheet-radius', t.sheetRadius);
			r.setProperty('--mn-glow-color', t.glowColor);
			r.setProperty('--mn-glow-spread', t.glowSpread);
			r.setProperty('--mn-litho-offset-x', t.lithoX);
			r.setProperty('--mn-litho-offset-y', t.lithoY);
			r.setProperty('--mn-litho-color', t.lithoColor);
			r.setProperty('--mn-divider-color', t.dividerColor);
			r.setProperty('--mn-divider-accent', t.dividerAccent);
			r.setProperty('--mn-scrollbar-color', t.scrollbarColor);
			document.documentElement.setAttribute('mn-glow-text', t.glowText);
			document.documentElement.setAttribute('mn-gilded-text', t.gildedText);
			document.documentElement.setAttribute('mn-cut-geometry', t.cutGeometry);
			// mn-litho-offset-x identifies the matinee theme (=3); it was previously never set as an
			// attribute (only the CSS var was), so EVERY `[mn-litho-offset-x="3"]` rule silently
			// missed and matinee rendered almost unthemed. See docs/branding/TROUBLESHOOTING.md.
			document.documentElement.setAttribute('mn-litho-offset-x', t.lithoOffsetX);
			document.documentElement.setAttribute('mn-texture-grain', t.textureGrain);
			document.documentElement.setAttribute('mn-texture-crosshatch', t.textureCrosshatch);
			// Per-theme wordmark in top-left corner (matches brand-studies.html treatments)
			var THEMES_WM = {
			canyon: function(el) {
					el.textContent = 'Movie Night';
					el.style.cssText = 'font-family:"Palm Canyon Drive",cursive !important;font-weight:400;font-size:28px;letter-spacing:.02em;color:#F5EEDC;text-shadow:0 0 12px rgba(71,196,184,.85),0 0 30px rgba(71,196,184,.4);';
				},
				matinee: function(el) {
					el.textContent = 'MOVIE NIGHT';
					el.style.cssText = 'font-family:Oswald,"Segoe UI",sans-serif !important;font-weight:800;font-size:18px;letter-spacing:.04em;text-transform:uppercase;color:#D98E32;text-shadow:3px 3px 0 #a62b1f;';
				},
				reelone: function(el) {
					el.innerHTML = '';
					el.style.cssText = 'position:fixed;top:10px;left:14px;z-index:9999;pointer-events:none;display:flex;align-items:center;gap:0;';
					var disc = document.createElement('span');
					// Mobile: the -8px overlap collides with the M's first stroke at small
					// wordmark sizes — give it clear air. Desktop keeps the overlap lockup.
					var discGap = document.documentElement.classList.contains('layout-mobile') ? '4px' : '-8px';
					disc.style.cssText = 'display:inline-block;width:38px;height:38px;border-radius:50%;background:#E8442E;margin-right:' + discGap + ';flex-shrink:0;';
					var txt = document.createElement('span');
					txt.textContent = 'Movie Night';
					// brand-studies.html .wm-reelone .word uses var(--script) = Palm Canyon Drive (not Poppins)
					txt.style.cssText = 'font-family:"Palm Canyon Drive",cursive !important;font-weight:400;font-size:30px;color:#F2EFE6;position:relative;text-shadow:none;';
					el.appendChild(disc);
					el.appendChild(txt);
				},
				marquee: function(el) {
					el.textContent = 'Movie Night';
					// brand-studies.html .wm-marquee .word uses var(--script) = Palm Canyon Drive with a gold gradient fill
					el.style.cssText = 'font-family:"Palm Canyon Drive",cursive !important;font-weight:400;font-size:28px;background:linear-gradient(180deg,#E8C96A,#C9A227 55%,#8F6F14);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent;';
				},
			};
			var applyWm = THEMES_WM[pick];
			if (applyWm) {
				if (!document.getElementById('mn-wordmark-style')) {
					var wmSt = document.createElement('style');
					wmSt.id = 'mn-wordmark-style';
					wmSt.textContent =
						'@font-face{font-family:"Palm Canyon Drive";src:url("/web/fonts/palm-canyon-drive.otf") format("opentype");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Poppins";src:url("/web/fonts/poppins.ttf") format("truetype");font-weight:100 900;font-display:swap;}' +
						'@font-face{font-family:"Oswald";src:url("/web/fonts/oswald-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Oswald";src:url("/web/fonts/oswald-latin-600-normal.woff2") format("woff2");font-weight:600;font-display:swap;}' +
						'@font-face{font-family:"Oswald";src:url("/web/fonts/oswald-latin-700-normal.woff2") format("woff2");font-weight:700;font-display:swap;}' +
						'@font-face{font-family:"Archivo";src:url("/web/fonts/archivo-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Archivo";src:url("/web/fonts/archivo-latin-700-normal.woff2") format("woff2");font-weight:700;font-display:swap;}' +
						'@font-face{font-family:"Jost";src:url("/web/fonts/jost-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Jost";src:url("/web/fonts/jost-latin-500-normal.woff2") format("woff2");font-weight:500;font-display:swap;}' +
						'#mn-wordmark{position:fixed;top:10px;left:14px;z-index:9999;pointer-events:none;opacity:.9;transition:opacity .3s;}#mn-wordmark:hover{opacity:1;}';
					document.head.appendChild(wmSt);
				}
				// Force-load ALL theme fonts via FontFace API, then create wordmark AFTER
				// fonts are in document.fonts. This avoids the swap race where the element
				// paints in fallback font and never re-renders.
				var FONT_URLS = {
					Poppins: '/web/fonts/poppins.ttf',
					'Palm Canyon Drive': '/web/fonts/palm-canyon-drive.otf',
					Oswald:  '/web/fonts/oswald-latin-700-normal.woff2',
					Archivo: '/web/fonts/archivo-latin-700-normal.woff2',
					Jost:    '/web/fonts/jost-latin-500-normal.woff2'
				};
				// Scale the wordmark text to fill the drawer width (226px = 250px drawer − 12px×2
				// gutters). IDEMPOTENT: applyWm() re-sets the base font-size via cssText on every
				// call, so we always measure/scale from base and never compound. Range measures the
				// real rendered text width regardless of the fixed-width box.
				function fitWm(el) {
					try {
						el.style.setProperty('text-align', 'center', 'important');
						el.style.setProperty('white-space', 'nowrap', 'important');
						el.style.setProperty('overflow', 'visible', 'important');
						var nodes = function () { return [el].concat(Array.prototype.slice.call(el.querySelectorAll('*'))); };
						// ITERATIVE fit: em-based letter-spacing (marquee .2em, etc.) scales with the
						// font-size, so a single-pass scale overshoots and the wordmark overflows the nav.
						// Re-measure and correct until the text width converges on the target (222px,
						// leaving a hair of margin inside the 226px box). Converges in ~2-3 passes.
						// Mobile (≤600px, matches the CSS breakpoint): the wordmark docks inside the
						// fixed header bar next to the hamburger, so fit to ~140px instead.
						// layout-mobile (Jellyfin's UA/touch signal) = drawer is an overlay
						// (phones AND tablets) → wordmark docks in the header bar at ~140px.
						// Desktop (docked 250px drawer) keeps the 222px fit. Width queries are
						// wrong here: an iPad at 1180px is layout-mobile, a desktop window at
						// 601px is layout-desktop.
						var TARGET = document.documentElement.classList.contains('layout-mobile') ? 140 : 222;
						for (var pass = 0; pass < 4; pass++) {
							var range = document.createRange();
							range.selectNodeContents(el);
							var w = range.getBoundingClientRect().width;
							if (w <= 0) break;
							var scale = TARGET / w;
							if (Math.abs(scale - 1) < 0.02) break; // close enough
							nodes().forEach(function (n) {
								var fs = parseFloat(getComputedStyle(n).fontSize) || 0;
								if (fs) n.style.setProperty('font-size', (fs * scale) + 'px', 'important');
							});
						}
					} catch (e) { /* best-effort */ }
				}
				function createWmEl() {
					var wmEl = document.getElementById('mn-wordmark');
					if (!wmEl) {
						wmEl = document.createElement('div');
						wmEl.id = 'mn-wordmark';
						document.body.appendChild(wmEl);
					}
					applyWm(wmEl);
					fitWm(wmEl);
				}
				var fontPromises = Object.keys(FONT_URLS).map(function (name) {
					if (document.fonts.check('400 14px ' + name)) return Promise.resolve();
					try {
						var ff = new FontFace(name, 'url(' + FONT_URLS[name] + ')', { weight: '100 900' });
						return ff.load().then(function (face) { document.fonts.add(face); }).catch(function () {});
					} catch (e) { return Promise.resolve(); }
				});
				// Create wordmark immediately (shows fallback), then re-apply after fonts load
				createWmEl();
				Promise.all(fontPromises).then(function () { createWmEl(); });
			}
		} catch (e) { /* best-effort */ }
	})();

	function apiBase() { return (window.ApiClient && ApiClient.serverAddress && ApiClient.serverAddress()) || ''; }
	function showcaseTop100() {
		var topId = idByName[TOP_100];
		if (!topId) return;
		var hash = location.hash || '';
		if (hash.indexOf('/details') === -1) return;
		var q = hash.split('?')[1];
		if (!q) return;
		var id;
		try { id = new URLSearchParams(q).get('id'); } catch (e) { return; }
		if (!id || normalize(id) !== normalize(topId)) return;

		// ---- inject stylesheet (once) --------------------------------------------------------
		if (!document.getElementById('mn-top100-style')) {
			var st = document.createElement('style');
			st.id = 'mn-top100-style';
			st.textContent = [
				// ---- common ----
				'.mn-rank { flex: none; text-align: center; font-weight: 800;',
				'  color: var(--primary-accent-color, #47c4b8); z-index: 3; }',
			'.mn-top100 .listViewDragHandle { order: 99; margin-left: auto; margin-right: 10px;',
			'  z-index: 3; position: relative; align-self: center; opacity: 0.4; }',
				// ---- header ----
				'.mn-header { text-align: center; padding: 32px 0 8px; margin-bottom: 4px;',
				'  border-bottom: 1px solid rgba(255,255,255,0.06); }',
				'.mn-header-inner { display: flex; align-items: center; justify-content: center; }',
				'.mn-header-line { width: 60px; height: 1px; background: rgba(255,255,255,0.15); }',
				'.mn-header h2 { font-family: Poppins, "Segoe UI", sans-serif; font-weight: 800;',
				'  font-size: 42px; letter-spacing: 4px; margin: 0; text-transform: uppercase;',
				'  background: linear-gradient(135deg, var(--primary-accent-color, #47c4b8),',
				'    var(--secondary-accent-color, #f26d3d)); -webkit-background-clip: text;',
				'  -webkit-text-fill-color: transparent; background-clip: text;',
				'  padding: 0 22px; }',
				// ---- tier 1: Pantheon (1-10) ----
			'.mn-t1 { min-height: 450px !important; position: relative;',
			'  overflow: hidden; margin-bottom: 8px; display: flex !important; flex-direction: row;',
			'  align-items: stretch !important;',
			'  background: linear-gradient(135deg, #091d22, #0e2a30); }',
				'.mn-t1::before { content: ""; position: absolute; inset: 0;',
				'  background-image: var(--mn-bg); background-size: cover; background-position: center 25%;',
				'  z-index: 0; pointer-events: none; }',
				'.mn-t1::after { content: ""; position: absolute; inset: 6px;',
				'  border: 2px solid var(--mn-era, rgba(245,238,220,0.3)); pointer-events: none; z-index: 2; }',
				'.mn-t1 > * { z-index: 1; }',
			'.mn-t1 .mn-rank { font-size: 64px; width: 90px; align-self: center; }',
			'.mn-t1 .listItemImage { height: 320px !important; width: 213px !important;',
				'  align-self: center; background-size: cover !important; background-position: center !important;',
				'  border-radius: 4px; box-shadow: 0 2px 12px rgba(0,0,0,.6); }',
				'.mn-t1 .listItemBody { text-shadow: 0 1px 8px rgba(0,0,0,.85);',
			'  padding: 20px 16px !important; display: flex !important; flex-direction: column;',
			'  justify-content: flex-end !important; align-self: stretch !important;',
			'  flex: 1 !important; padding-bottom: 40px !important; }',
				'.mn-t1 .listItemBodyText:first-child { font-size: 1.4em; font-weight: 700; }',
				'.mn-t1 .mn-logo { max-height: 64px; max-width: 380px; object-fit: contain;',
				'  object-position: left bottom; margin-bottom: 6px; }',
				'.mn-t1 .mn-fact { font-size: 12px; letter-spacing: 3px;',
				'  color: rgba(255,255,255,0.8); text-transform: uppercase; margin-top: 4px; }',
				'.mn-t1 .mn-fact.mn-first { font-size: 13px; }',
				'.mn-t1 .mn-meta-line { margin-top: 8px; display: flex; align-items: baseline; }',
				'.mn-t1 .mn-year { font-weight: 700; font-size: 22px; letter-spacing: 2px;',
				'  color: var(--primary-accent-color, #47c4b8); }',
				'.mn-t1 .mn-runtime { font-size: 14px; letter-spacing: 1.5px;',
				'  color: rgba(255,255,255,0.67); margin-left: 8px; }',
				// blinds motif
				'.mn-t1[data-mn-motif="blinds"] .mn-blinds { position: absolute; inset: 0;',
				'  z-index: 1; pointer-events: none; }',
				'.mn-t1[data-mn-motif="blinds"] .mn-blinds i { display: block; width: 100%;',
				'  background: rgba(0,0,0,0.18); }',
				// deco motif — ADD overlay, DON'T remove backdrop
				'.mn-t1[data-mn-motif="deco"] .mn-deco1 { position: absolute;',
				'  inset: 18px; border: 2px solid rgba(242,206,107,0.3);',
				'  pointer-events: none; z-index: 2; }',
				'.mn-t1[data-mn-motif="deco"] .mn-deco2 { position: absolute;',
				'  inset: 26px; border: 1.5px solid rgba(242,206,107,0.15);',
				'  pointer-events: none; z-index: 2; }',
			// ---- tier 2: Gallery (11-50) — two-column grid ----
			'.mn-t2 { min-height: 160px !important; border-radius: 6px; position: relative;',
			'  overflow: hidden; margin-bottom: 4px;',
			'  background: linear-gradient(135deg, #091d22, #0e2a30); }',
			'.mn-t2::before { content: ""; position: absolute; inset: 0;',
			'  background-image: var(--mn-bg); background-size: cover; background-position: center 25%;',
			'  z-index: 0; pointer-events: none; }',
			'.mn-t2 > * { z-index: 1; }',
			'.mn-t2 .mn-rank { font-size: 36px; width: 70px; }',
			'.mn-t2 .listItemImage { display: none !important; }',
			'.mn-t2 .listItemBody { text-shadow: 0 1px 6px rgba(0,0,0,.8);',
			'  padding: 12px; display: flex; flex-direction: column; justify-content: center; }',
			'.mn-t2 .listItemBodyText:first-child { font-size: 1.2em; font-weight: 700; }',
			'.mn-t2 .mn-logo { max-height: 34px; max-width: 200px; object-fit: contain;',
			'  object-position: left center; margin-bottom: 4px; }',
			'.mn-t2 .mn-fact { font-size: 10px; letter-spacing: 2px;',
			'  color: rgba(255,255,255,0.6); text-transform: uppercase; margin-top: 2px; }',
			'.mn-t2 .mn-meta-line { margin-top: 4px; display: flex; align-items: baseline; }',
			'.mn-t2 .mn-year { font-weight: 700; font-size: 15px; letter-spacing: 2px;',
			'  color: var(--primary-accent-color, #47c4b8); }',
			'.mn-t2 .mn-runtime { font-size: 11px; letter-spacing: 1.5px;',
			'  color: rgba(255,255,255,0.6); margin-left: 6px; }',
			// Tier 2 two-column layout — handled by flex-wrap in jellyfin-custom.css
				// ---- tier 3: Ledger (51+) ----
				'.mn-t3 .mn-rank { font-size: 22px; width: 56px; text-shadow: 0 1px 4px rgba(0,0,0,.7); }',
				'.mn-t3 .listItemBody { padding: 0 8px !important; }',
				'.mn-t3 .mn-meta-line { display: inline; margin-left: 8px; }',
				'.mn-t3 .mn-year { font-size: 13px; color: rgba(255,255,255,0.5); }',
				'.mn-t3 .mn-runtime { font-size: 13px; color: rgba(255,255,255,0.35); margin-left: 6px; }',
			].join('\n');
			document.head.appendChild(st);
		}
	var container = document.querySelector('#childrenContent .itemsContainer');
	if (!container) return;

	var page = document.querySelector('.itemDetailPage:not(.hide)') || document.body;
	page.classList.add('mn-top100');

	// ---- hide clutter via JS (beats scyfin's !important CSS) ----------------------------
	var clutter =
		'.itemDetailsGroup, .detailSectionContent, .cardImageContainer.coveredImage,' +
		'.detailImageContainer, .itemBackdrop, .itemName, .infoWrapper .nameContainer,' +
		'.infoWrapper .itemMiscInfo-primary';
	page.querySelectorAll(clutter).forEach(function (el) { el.style.display = 'none'; });

	// Hide secondary nav tabs (Home / Favourites bar)
	page.querySelectorAll('.headerTabs, .headerTabsSecondary, .tab').forEach(function (el) {
		el.style.display = 'none';
	});

		// ---- hide stray play/shuffle/action bar (especially on mobile) -----------------------
		var playlistBar = page.querySelector('.playlistActions, .playlistSelectionToolbar, .selectionCommandsPanel');
		if (playlistBar) playlistBar.style.display = 'none';

		// ---- loading spinner (shows while showcase builds) -----------------------------------
		if (!container.querySelector('.mn-t1') && !container.querySelector('.mn-t2')) {
			if (!document.getElementById('mn-top100-spinner')) {
				var sp = document.createElement('div');
				sp.id = 'mn-top100-spinner';
				sp.className = 'mn-top100-spinner';
				sp.textContent = 'Loading showcase\u2026';
				container.parentNode.insertBefore(sp, container);
			}
		}

		// ---- inject styled header (once) -----------------------------------------------------
		if (!document.getElementById('mn-top100-header')) {
			var hdr = document.createElement('div');
			hdr.id = 'mn-top100-header';
			hdr.className = 'mn-header';
			hdr.innerHTML =
				'<div class="mn-header-inner">' +
				'<div class="mn-header-line"></div>' +
				'<h2>Top 100</h2>' +
				'<div class="mn-header-line"></div>' +
				'</div>';
			container.parentNode.insertBefore(hdr, container);
		}

		// ---- decorate rows -------------------------------------------------------------------
		var rows = container.querySelectorAll(':scope > .listItem');
		rows.forEach(function (row, i) {
			if (row.dataset.mnShowcase) return;
			row.dataset.mnShowcase = '1';
			var rank = i + 1;
			var tier = rank <= 10 ? 'mn-t1' : rank <= 50 ? 'mn-t2' : 'mn-t3';
			row.classList.add(tier);

			// rank badge (remove any prior one from an earlier pass)
			row.querySelectorAll(':scope > .mn-rank').forEach(function (old) { old.remove(); });
			var badge = document.createElement('div');
			badge.className = 'mn-rank';
			badge.textContent = rank;
			row.insertBefore(badge, row.firstChild);

			var mid = row.getAttribute('data-id');
			var item = mid ? top100Items.get(mid) : null;

			// backdrop gradient — the 90deg left-heavy scrim suits the desktop row layout
			// (text on the left); layout-mobile tier-1 anchors text at the BOTTOM with its
			// own CSS scrim, so a light even wash keeps the art visible there instead of
			// stacking two dark gradients.
			if (tier !== 'mn-t3' && mid) {
				var w = rank <= 10 ? 780 : 480;
				var scrim = document.documentElement.classList.contains('layout-mobile')
					? 'linear-gradient(rgba(9,29,34,.30), rgba(9,29,34,.30)),'
					: 'linear-gradient(90deg, rgba(9,29,34,.92), rgba(9,29,34,.45) 55%, rgba(9,29,34,.2)),';
				row.style.setProperty('--mn-bg',
					scrim +
					'url("' + apiBase() + '/Items/' + mid + '/Images/Backdrop?maxWidth=' + w + '")');
			}

			// era border (tier 1 only)
			if (tier === 'mn-t1' && item) {
				row.style.setProperty('--mn-era', eraColor(item.ProductionYear));
			}

			// motif overlay (tier 1 — blinds or deco, assigned randomly per title)
			if (tier === 'mn-t1') {
				// Clear prior motif elements
				row.querySelectorAll('.mn-blinds,.mn-deco1,.mn-deco2').forEach(function (n) { n.remove(); });
				if (!row.dataset.mnMotif) {
					var motifs = ['blinds', 'deco', 'none'];
					var motif = motifs[rank % motifs.length];
				if (motif === 'blinds') {
					row.dataset.mnMotif = 'blinds';
					var blindEl = document.createElement('div');
					blindEl.className = 'mn-blinds';
					for (var b = 0; b < 8; b++) {
						var strip = document.createElement('i');
						strip.style.cssText = 'height:' + (3 + (b % 3) * 2) + 'px;margin:' + (18 + (b % 2) * 6) + 'px 0;display:block;opacity:' + (0.12 + (b % 3) * 0.05);
						blindEl.appendChild(strip);
					}
					row.appendChild(blindEl);
				} else if (motif === 'deco') {
					row.dataset.mnMotif = 'deco';
					var d1 = document.createElement('div');
					d1.className = 'mn-deco1';
					row.appendChild(d1);
					var d2 = document.createElement('div');
					d2.className = 'mn-deco2';
					row.appendChild(d2);
			}
			}
		}

		// ---- body enrichment (tier 1 & 2) ------------------------------------------------
		if (tier !== 'mn-t3') {
			var body = row.querySelector('.listItemBody');
			if (!body) return;
			var titleEl = body.querySelector('.listItemBodyText');

			// Clear prior enrichment (prevents duplication on re-scan after loadLists refresh)
			body.querySelectorAll('.mn-logo, .mn-fact, .mn-meta-line').forEach(function (n) { n.remove(); });
			if (titleEl) titleEl.style.display = '';

			// hide stock elements via JS (beats scyfin !important)
			row.querySelectorAll('.listItemMediaInfo, .listViewUserDataButtons').forEach(function (el) {
				el.style.display = 'none';
			});

				// clearlogo: if the item has a Logo image, insert an <img> and hide the text title
				if (item && item.ImageTags && item.ImageTags.Logo && titleEl) {
					var logoUrl = apiBase() + '/Items/' + mid + '/Images/Logo?maxWidth=' +
						(rank <= 10 ? 380 : 200);
					var logo = document.createElement('img');
					logo.className = 'mn-logo';
					logo.src = logoUrl;
					logo.alt = item.Name || '';
					titleEl.parentNode.insertBefore(logo, titleEl);
					titleEl.style.display = 'none';
				}

				// fact/flair lines (multi-line, each on its own div)
				if (item && rank <= 10) {
					// Tier 1 (Pantheon): director + cast
					var dir = dirName(item);
					if (dir) {
						var fDir = document.createElement('div');
						fDir.className = 'mn-fact mn-first';
						fDir.textContent = 'DIRECTED BY ' + dir.toUpperCase();
						body.appendChild(fDir);
					}
					var cast = topCast(item, 3);
					if (cast.length) {
						var fCast = document.createElement('div');
						fCast.className = 'mn-fact';
						fCast.textContent = cast.map(function (n) { return n.toUpperCase(); }).join('  ·  ');
						body.appendChild(fCast);
					}
				} else if (item && rank <= 50) {
					// Tier 2 (Gallery): one flair line
					var dir2 = dirName(item);
					var cast2 = topCast(item, 1);
					var flair = dir2 ? dir2.toUpperCase() : (cast2.length ? cast2[0].toUpperCase() : null);
					if (flair) {
						var fFlair = document.createElement('div');
						fFlair.className = 'mn-fact mn-first';
						fFlair.textContent = flair;
						body.appendChild(fFlair);
					}
				}

				// year + runtime
				if (item && (item.ProductionYear || item.RunTimeTicks)) {
					var meta = document.createElement('div');
					meta.className = 'mn-meta-line';
					if (item.ProductionYear) {
						meta.innerHTML = '<span class="mn-year">' + item.ProductionYear + '</span>';
					}
					var rt = rtText(item.RunTimeTicks);
					if (rt) {
						meta.innerHTML += '<span class="mn-runtime">  ·  ' + rt + '</span>';
					}
					body.appendChild(meta);
				}
			}

			// ---- body enrichment (tier 3: ledger) --------------------------------------------
			if (tier === 'mn-t3' && item) {
				var body3 = row.querySelector('.listItemBody');
				if (!body3) return;
				// Clear prior enrichment
				body3.querySelectorAll('.mn-meta-line').forEach(function (n) { n.remove(); });
				// hide stock elements via JS
				row.querySelectorAll('.listItemMediaInfo, .listViewUserDataButtons').forEach(function (el) {
					el.style.display = 'none';
				});
				// append year + runtime inline after the title
				var meta3 = document.createElement('span');
				meta3.className = 'mn-meta-line';
				var y3 = item.ProductionYear ? '<span class="mn-year">' + item.ProductionYear + '</span>' : '';
				var r3 = rtText(item.RunTimeTicks);
				meta3.innerHTML = y3 + (r3 ? '<span class="mn-runtime">  ·  ' + r3 + '</span>' : '');
				body3.appendChild(meta3);
			}
		});

		// ---- poster size upgrade (every scan — lazy loader may reset backgrounds) -------------
		container.querySelectorAll('.mn-t1 .listItemImage, .mn-t2 .listItemImage').forEach(function (img) {
			var bg = img.style.backgroundImage || '';
			if (!bg || bg.indexOf('fillWidth=200') !== -1) return;
			var m = bg.match(/url\("?([^")]+)"?\)/);
			if (!m || m[1].indexOf('fillWidth=') === -1) return;
			img.style.backgroundImage = 'url("' + m[1]
				.replace(/fillWidth=\d+/, 'fillWidth=200')
				.replace(/fillHeight=\d+/, 'fillHeight=300') + '")';
		});

		// ---- mark container ready (removes opacity:0 from CSS, removes spinner) --------------
		container.classList.add('mn-ready');
		var spinner = document.getElementById('mn-top100-spinner');
		if (spinner) spinner.remove();
	}

	// ---- sidebar drawer: apply inline styles directly (beats all imported CSS) ----------------
	// Cache CSS variable reads — theme roulette picks once per tab session, so these values
	// don't change. The 7 getComputedStyle() calls were the most expensive part of each scan.
	function themeDrawer() {
		if (!_drawerCssCache) {
			var s = getComputedStyle(document.documentElement);
			_drawerCssCache = {
				accent: s.getPropertyValue('--primary-accent-color').trim() || '#47c4b8',
				accent2: s.getPropertyValue('--secondary-accent-color').trim() || '#f26d3d',
				bg2: s.getPropertyValue('--secondary-background-color').trim() || '#0e2a30',
				muted: s.getPropertyValue('--mn-muted').trim() || '#7fa8a4',
				text: s.getPropertyValue('--mn-text').trim() || '#eef1f6',
				textOnAccent: s.getPropertyValue('--mn-text-on-accent').trim() || '#0c2429',
				btnRound: s.getPropertyValue('--mn-btn-round').trim() || '999px',
				navFont: s.getPropertyValue('--mn-nav-font').trim() || 'Poppins, "Segoe UI", sans-serif',
				navCase: s.getPropertyValue('--mn-nav-case').trim() || 'none',
				navTrack: s.getPropertyValue('--mn-nav-track').trim() || 'normal',
			};
		}
		var c = _drawerCssCache;
		var menuOpts = document.querySelector('.libraryMenuOptions');
		if (!menuOpts) return;
		var drawer = menuOpts.closest('.mainDrawer') || menuOpts.closest('.sidebarMenu') || menuOpts.parentElement;
		if (!drawer) return;
		// Drawer background
		if (drawer.style.background !== c.bg2) drawer.style.background = c.bg2;
		var scroll = drawer.querySelector('.mainDrawer-scrollContainer');
		if (scroll && scroll.style.background !== c.bg2) scroll.style.background = c.bg2;
		// Even nav margins: scyfin gives the scroll container a 10px left margin (and 240px
		// width) that a CSS `!important` can't beat, so the left nav gutter was 18px vs 8px
		// right. Inline !important set here beats scyfin's !important. Now items sit symmetric.
		if (scroll) {
			scroll.style.setProperty('margin', '0', 'important');
			scroll.style.setProperty('width', '100%', 'important');
			// Clear the fixed wordmark overlay: push the first nav row below the (scaled) wordmark
			// so it isn't crunched under it. Idempotent — reset padding, then recompute from the
			// live wordmark bottom; once applied, scTop moves down and `need` resolves to ≤0.
			var wm = document.getElementById('mn-wordmark');
			if (wm) {
				scroll.style.removeProperty('padding-top');
				var need = (wm.getBoundingClientRect().bottom + 18) - scroll.getBoundingClientRect().top;
				if (need > 0) scroll.style.setProperty('padding-top', need + 'px', 'important');
			}
		}
		// Current page ID (exact match only — prevents multi-highlight)
		// Written to module-level _currentNavCurId so mouseenter/mouseleave closures
		// always read the live page ID instead of a stale captured value.
	_currentNavCurId = (location.hash.match(/[?&]id=([^&]*)/) || [])[1] || '';
	var isHome = !location.hash || location.hash === '#/' || location.hash.indexOf('#/home') === 0;
	// Theme EVERY nav option
		drawer.querySelectorAll('.navMenuOption').forEach(function (opt) {
			if (opt.dataset.mnStyled) return;
			opt.dataset.mnStyled = '1';
			// Hide stock icons (Material Icons inside nav items)
			opt.querySelectorAll('.navMenuOptionIcon').forEach(function (ic) {
				ic.style.setProperty('display', 'none', 'important');
			});
			opt.style.setProperty('color', c.muted, 'important');
			opt.style.setProperty('border-radius', c.btnRound, 'important');
		// Mobile: matinee's litho borders made 3px-apart items read as one striped
		// block — a touch more breathing room. Desktop keeps the tight 3px rhythm.
		opt.style.setProperty('margin', (document.documentElement.classList.contains('layout-mobile') ? '6px' : '3px') + ' 8px', 'important');
		opt.style.setProperty('padding-left', '20px', 'important');
		opt.style.setProperty('padding', '10px 16px', 'important');
			opt.style.setProperty('height', 'auto', 'important');
			opt.style.setProperty('width', 'auto', 'important');
			opt.style.setProperty('text-align', 'left', 'important');
			opt.style.setProperty('border-left', 'none', 'important');
			opt.style.setProperty('transition', 'background .15s, color .15s', 'important');
			opt.style.setProperty('font-family', c.navFont, 'important');
			opt.style.setProperty('font-size', '14px', 'important');
			opt.style.setProperty('font-weight', '500', 'important');
			opt.style.setProperty('text-transform', c.navCase, 'important');
			opt.style.setProperty('letter-spacing', c.navTrack, 'important');
			// hover
			opt.addEventListener('mouseenter', function () {
				if (opt.dataset.mnSelected || opt.classList.contains('navMenuOption-selected') || isExactMatch(opt, _currentNavCurId)) return;
				opt.style.setProperty('background', 'rgba(255,255,255,0.06)', 'important');
				opt.style.setProperty('color', 'rgba(255,255,255,.95)', 'important');
			});
			opt.addEventListener('mouseleave', function () {
				if (opt.dataset.mnSelected || opt.classList.contains('navMenuOption-selected') || isExactMatch(opt, _currentNavCurId)) return;
				opt.style.setProperty('background', 'transparent', 'important');
				opt.style.setProperty('color', c.muted, 'important');
			});
		});
		// Clear ALL selected states first (prevents stale highlights)
		drawer.querySelectorAll('.navMenuOption').forEach(function (opt) {
			// Reset the "this is the current page" marker every pass; applySelected() below
			// re-sets it on whichever item is genuinely current (class, id-match, or isHome).
			// The hover handlers guard on this flag, so the current item's highlight survives
			// hover/leave even when it has no .navMenuOption-selected class (e.g. Home).
			opt.removeAttribute('data-mn-selected');
			if (!opt.classList.contains('navMenuOption-selected') && !isExactMatch(opt, _currentNavCurId)) {
				opt.style.removeProperty('background');
				opt.style.setProperty('color', c.muted, 'important');
				opt.style.setProperty('font-weight', '500', 'important');
			}
		});
		// Selected: FILLED pill with accent bg + dark text (solid, no glow)
		drawer.querySelectorAll('.navMenuOption-selected').forEach(function (sel) {
			applySelected(sel, c.accent, c.textOnAccent, c.btnRound);
		});
		// Also highlight by exact ID match (curated links don't get navMenuOption-selected)
		if (_currentNavCurId) {
			drawer.querySelectorAll('a.navMenuOption').forEach(function (a) {
				if (isExactMatch(a, _currentNavCurId) && !a.classList.contains('navMenuOption-selected')) {
					applySelected(a, c.accent, c.textOnAccent, c.btnRound);
				}
			});
		}
		// Home page: highlight the Home nav item (hash is #/, empty, or #/home.html)
		if (isHome) {
			drawer.querySelectorAll('a.navMenuOption').forEach(function (a) {
				if (a.classList.contains('navMenuOption-selected')) return;
				var href = a.getAttribute('href') || '';
				if (href === '#/' || href === '#/home.html' || href.match(/^#\/home\b/)) {
					applySelected(a, c.accent, c.textOnAccent, c.btnRound);
				}
			});
		}
		function isExactMatch(el, cid) {
			if (!cid) return false;
			var href = el.getAttribute('href') || '';
			// Extract id param from this link's href and compare exactly
			var m = href.match(/[?&]id=([^&]*)/);
			if (m && m[1] === cid) return true;
			// Also check data-itemid (library nav items use this attribute)
			var itemId = el.getAttribute('data-itemid') || '';
			return itemId === cid;
		}
		function applySelected(el, acc, txtColor, round) {
			el.dataset.mnSelected = '1';
			el.style.setProperty('background', acc, 'important');
			el.style.setProperty('color', txtColor, 'important');
			el.style.setProperty('font-weight', '700', 'important');
			el.style.setProperty('border-radius', round, 'important');
		}
	}

	function scan() {
		if (loaded) {
			// Scope card/listItem queries to the active content area instead of the entire DOM.
			// On the home page this limits scanning to the visible browse row (~20-30 elements
			// vs 200+ when scanning everything). On Top 100, all 100 items are in scope either way.
			var scope = document.querySelector('.mainContent, #content, .detailContentContainer') || document;
			scope.querySelectorAll('.card[data-id]').forEach(decorateItem);
			scope.querySelectorAll('.listItem[data-id]').forEach(decorateItem);
			decorateDetails();
		}
		playlistClicksToDetails();
		shuffleWatchlist();
		showcaseTop100();
		// MUST run every scan: Jellyfin destroys & rebuilds the drawer nav on open/close, wiping
		// our injected entries and inline styles. Both are cheap+idempotent — addSidebarEntries()
		// no-ops when the entries already exist, and themeDrawer() now reads its CSS vars from
		// _drawerCssCache (the one genuinely expensive part, cached once). A boolean/hash guard
		// here makes Top 100/Watchlist vanish after the first drawer rebuild (regression fixed).
		addSidebarEntries();
		addControlEntries(); // mirror header-right controls into the drawer (#18)
		orderDrawer(); // enforce nav order + divider; rename TV → TV Shows (#18)
		themeDrawer(); // apply inline styles to sidebar drawer (beats all imported CSS)
	}

	function start() {
		injectStyles();
		var t;
		var obs = new MutationObserver(function () { clearTimeout(t); t = setTimeout(scan, 500); });
		obs.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('hashchange', function () { setTimeout(scan, 150); });
		loadLists();
		setInterval(loadLists, REFRESH_MS);
		loadOscars();
		setInterval(loadOscars, REFRESH_MS);
		loadNations();
		setInterval(loadNations, REFRESH_MS);
	}

	function waitForApi() {
		if (ready()) { start(); return; }
		var tries = 0;
		var iv = setInterval(function () {
			if (ready()) { clearInterval(iv); start(); }
			else if (++tries > 600) clearInterval(iv); // give up after ~2 min
		}, 200);
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForApi);
	else waitForApi();
})();
