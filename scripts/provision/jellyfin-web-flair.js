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
	var idByName = {}; // playlist name -> playlist id (for the sidebar entries)
	var playlistsViewId = null; // the "Playlists" library-view id, to locate its drawer entry
	var loaded = false;
	var top100Items = new Map(); // id -> enriched item (People, ImageTags, ProductionYear, RunTimeTicks)

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
	function injectStyles() {
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
			// Sidebar drawer hover (inline styles handle bg/color/shape; only :hover needs CSS)
			'.mainDrawer .navMenuOption:hover{background:rgba(' +
				'var(--primary-r,71),var(--primary-g,196),var(--primary-b,184),.18)!important;' +
				'transform:none!important;}';
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

	// ---- flair overlay -----------------------------------------------------------------------
	// host = the positioned element that bounds the poster image; id = the movie's item id.
	function applyFlair(host, id, isDetail) {
		if (!host) return;
		if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
		if (isDetail) host.classList.add('curated-host-detail');
		// Clear any prior flair on this host (recycled nodes / data refresh).
		host.querySelectorAll(':scope > .curated-rank, :scope > .curated-bookmark').forEach(function (n) { n.remove(); });
		var rank = rankFor(id);
		if (rank) {
			var pill = document.createElement('div');
			pill.className = 'curated-rank';
			pill.textContent = '#' + rank;
			host.appendChild(pill);
		}
		if (isWatch(id)) host.insertAdjacentHTML('beforeend', bookmarkSvg());
	}

	// A grid card or a list row: id + type live on the element; poster is a known child.
	function decorateItem(el) {
		var id = el.getAttribute('data-id');
		if (!id) return;
		if (el.dataset[MARK] === id) return;
		el.dataset[MARK] = id;
		// Movies only (a ranked all-time list is a movie concept). Still mark, so we don't re-scan it.
		if (el.getAttribute('data-type') !== 'Movie') return;
		if (!rankFor(id) && !isWatch(id)) return;
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
			var THEMES = {
				canyon:  { accent: '#47c4b8', accent2: '#f26d3d', bg: '#091d22', bg2: '#0e2a30', muted: '#7fa8a4', textOnAccent: '#0c2429', r: 71,  g: 196, b: 184, btnRound: '999px', navFont: 'Poppins, "Segoe UI", sans-serif', navCase: 'none', navTrack: 'normal' },
				matinee: { accent: '#d98e32', accent2: '#a62b1f', bg: '#160d06', bg2: '#191009', muted: '#9c7c53', textOnAccent: '#1c120a', r: 217, g: 142, b: 50, btnRound: '2px', navFont: '"Oswald", "Segoe UI", sans-serif', navCase: 'uppercase', navTrack: '.09em' },
				reelone: { accent: '#e8442e', accent2: '#c9a227', bg: '#0b0b0b', bg2: '#101010', muted: '#8d8a80', textOnAccent: '#ffffff', r: 232, g: 68,  b: 46, btnRound: '0px', navFont: '"Archivo", "Segoe UI", sans-serif', navCase: 'lowercase', navTrack: 'normal' },
				marquee: { accent: '#c9a227', accent2: '#7a1e1e', bg: '#0d0a05', bg2: '#0e0b06', muted: '#9a8c6e', textOnAccent: '#1a1406', r: 201, g: 162, b: 39, btnRound: '2px', navFont: '"Jost", "Segoe UI", sans-serif', navCase: 'uppercase', navTrack: '.2em' },
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
			r.setProperty('--mn-text-on-accent', t.textOnAccent);
			r.setProperty('--mn-btn-round', t.btnRound);
			r.setProperty('--mn-nav-font', t.navFont);
			r.setProperty('--mn-nav-case', t.navCase);
			r.setProperty('--mn-nav-track', t.navTrack);
			r.setProperty('--primary-r', t.r); r.setProperty('--primary-g', t.g); r.setProperty('--primary-b', t.b);
			// Per-theme wordmark in top-left corner (matches brand-studies.html treatments)
			var THEMES_WM = {
				canyon:  function(el) {
					el.textContent = 'Movie Night';
					el.style.cssText = 'font-family:"Palm Canyon Drive",cursive;font-weight:400;font-size:28px;letter-spacing:.02em;color:#F5EEDC;text-shadow:0 0 12px rgba(71,196,184,.85),0 0 30px rgba(71,196,184,.4);';
				},
				matinee: function(el) {
					el.textContent = 'MOVIE NIGHT';
					el.style.cssText = 'font-family:Oswald,"Segoe UI",sans-serif;font-weight:800;font-size:18px;letter-spacing:.04em;text-transform:uppercase;color:#D98E32;text-shadow:3px 2px 0 #a62b1f;';
				},
				reelone: function(el) {
					el.innerHTML = '';
					el.style.cssText = 'position:fixed;top:10px;left:14px;z-index:9999;pointer-events:none;display:flex;align-items:center;gap:0;';
					var disc = document.createElement('span');
					disc.style.cssText = 'display:inline-block;width:38px;height:38px;border-radius:50%;background:#E8442E;margin-right:-8px;flex-shrink:0;';
					var txt = document.createElement('span');
					txt.textContent = 'Movie Night';
					txt.style.cssText = 'font-family:Poppins,sans-serif;font-weight:700;font-size:18px;color:#F2EFE6;position:relative;text-shadow:0 0 8px rgba(232,68,46,.3);';
					el.appendChild(disc);
					el.appendChild(txt);
				},
				marquee: function(el) {
					el.textContent = 'MOVIE NIGHT';
					el.style.cssText = 'font-family:Jost,"Segoe UI",sans-serif;font-weight:500;font-size:17px;letter-spacing:.2em;text-transform:uppercase;background:linear-gradient(180deg,#E8C96A,#C9A227 55%,#8F6F14);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent;';
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
						'@font-face{font-family:"Oswald";src:url("https://cdn.jsdelivr.net/npm/@fontsource/oswald@5.1.1/files/oswald-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Oswald";src:url("https://cdn.jsdelivr.net/npm/@fontsource/oswald@5.1.1/files/oswald-latin-600-normal.woff2") format("woff2");font-weight:600;font-display:swap;}' +
						'@font-face{font-family:"Oswald";src:url("https://cdn.jsdelivr.net/npm/@fontsource/oswald@5.1.1/files/oswald-latin-700-normal.woff2") format("woff2");font-weight:700;font-display:swap;}' +
						'@font-face{font-family:"Archivo";src:url("https://cdn.jsdelivr.net/npm/@fontsource/archivo@5.1.1/files/archivo-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Archivo";src:url("https://cdn.jsdelivr.net/npm/@fontsource/archivo@5.1.1/files/archivo-latin-700-normal.woff2") format("woff2");font-weight:700;font-display:swap;}' +
						'@font-face{font-family:"Jost";src:url("https://cdn.jsdelivr.net/npm/@fontsource/jost@5.1.1/files/jost-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap;}' +
						'@font-face{font-family:"Jost";src:url("https://cdn.jsdelivr.net/npm/@fontsource/jost@5.1.1/files/jost-latin-500-normal.woff2") format("woff2");font-weight:500;font-display:swap;}' +
						'#mn-wordmark{position:fixed;top:10px;left:14px;z-index:9999;pointer-events:none;opacity:.9;transition:opacity .3s;}#mn-wordmark:hover{opacity:1;}';
					document.head.appendChild(wmSt);
				}
				// Force-load ALL theme fonts via FontFace API, then create wordmark AFTER
				// fonts are in document.fonts. This avoids the swap race where the element
				// paints in fallback font and never re-renders.
				var FONT_URLS = {
					Poppins: '/web/fonts/poppins.ttf',
					'Palm Canyon Drive': '/web/fonts/palm-canyon-drive.otf',
					Oswald:  'https://cdn.jsdelivr.net/npm/@fontsource/oswald@5.1.1/files/oswald-latin-700-normal.woff2',
					Archivo: 'https://cdn.jsdelivr.net/npm/@fontsource/archivo@5.1.1/files/archivo-latin-700-normal.woff2',
					Jost:    'https://cdn.jsdelivr.net/npm/@fontsource/jost@5.1.1/files/jost-latin-500-normal.woff2'
				};
				function createWmEl() {
					var wmEl = document.getElementById('mn-wordmark');
					if (!wmEl) {
						wmEl = document.createElement('div');
						wmEl.id = 'mn-wordmark';
						document.body.appendChild(wmEl);
					}
					applyWm(wmEl);
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
				'.mn-t3 .mn-rank { font-size: 20px; width: 50px; }',
				'.mn-t3 .mn-meta-line { display: inline; margin-left: 8px; }',
				'.mn-t3 .mn-year { font-size: 13px; color: rgba(255,255,255,0.5); }',
				'.mn-t3 .mn-runtime { font-size: 13px; color: rgba(255,255,255,0.35); margin-left: 6px; }',
			].join('\n');
			document.head.appendChild(st);
		}
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

		var container = document.querySelector('#childrenContent .itemsContainer');
		if (!container) return;

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

			// backdrop gradient
			if (tier !== 'mn-t3' && mid) {
				var w = rank <= 10 ? 780 : 480;
				row.style.setProperty('--mn-bg',
					'linear-gradient(90deg, rgba(9,29,34,.92), rgba(9,29,34,.45) 55%, rgba(9,29,34,.2)),' +
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
	}

	// ---- sidebar drawer: apply inline styles directly (beats all imported CSS) ----------------
	// No guard — runs every scan because Jellyfin re-renders nav options on drawer open/close,
	// creating fresh elements without our inline styles. Idempotent and fast.
	function themeDrawer() {
		var accent = getComputedStyle(document.documentElement).getPropertyValue('--primary-accent-color').trim() || '#47c4b8';
		var accent2 = getComputedStyle(document.documentElement).getPropertyValue('--secondary-accent-color').trim() || '#f26d3d';
		var bg2 = getComputedStyle(document.documentElement).getPropertyValue('--secondary-background-color').trim() || '#0e2a30';
		var muted = getComputedStyle(document.documentElement).getPropertyValue('--mn-muted').trim() || '#7fa8a4';
		var textOnAccent = getComputedStyle(document.documentElement).getPropertyValue('--mn-text-on-accent').trim() || '#0c2429';
		var btnRound = getComputedStyle(document.documentElement).getPropertyValue('--mn-btn-round').trim() || '999px';
		var navFont = getComputedStyle(document.documentElement).getPropertyValue('--mn-nav-font').trim() || 'Poppins, "Segoe UI", sans-serif';
		var navCase = getComputedStyle(document.documentElement).getPropertyValue('--mn-nav-case').trim() || 'none';
		var navTrack = getComputedStyle(document.documentElement).getPropertyValue('--mn-nav-track').trim() || 'normal';
		var menuOpts = document.querySelector('.libraryMenuOptions');
		if (!menuOpts) return;
		var drawer = menuOpts.closest('.mainDrawer') || menuOpts.closest('.sidebarMenu') || menuOpts.parentElement;
		if (!drawer) return;
		// Drawer background
		if (drawer.style.background !== bg2) drawer.style.background = bg2;
		var scroll = drawer.querySelector('.mainDrawer-scrollContainer');
		if (scroll && scroll.style.background !== bg2) scroll.style.background = bg2;
		// Current page ID (exact match only — prevents multi-highlight)
		var curId = (location.hash.match(/[?&]id=([^&]*)/) || [])[1] || '';
		// Theme EVERY nav option
		drawer.querySelectorAll('.navMenuOption').forEach(function (opt) {
			if (opt.dataset.mnStyled) return;
			opt.dataset.mnStyled = '1';
			// Hide stock icons (Material Icons inside nav items)
			opt.querySelectorAll('.navMenuOptionIcon').forEach(function (ic) {
				ic.style.setProperty('display', 'none', 'important');
			});
			opt.style.setProperty('color', muted, 'important');
			opt.style.setProperty('border-radius', btnRound, 'important');
		opt.style.setProperty('margin', '3px 8px', 'important');
		opt.style.setProperty('padding-left', '20px', 'important');
		opt.style.setProperty('padding', '10px 16px', 'important');
			opt.style.setProperty('height', 'auto', 'important');
			opt.style.setProperty('width', 'auto', 'important');
			opt.style.setProperty('text-align', 'left', 'important');
			opt.style.setProperty('border-left', 'none', 'important');
			opt.style.setProperty('transition', 'background .15s, color .15s', 'important');
			opt.style.setProperty('font-family', navFont, 'important');
			opt.style.setProperty('font-size', '14px', 'important');
			opt.style.setProperty('font-weight', '500', 'important');
			opt.style.setProperty('text-transform', navCase, 'important');
			opt.style.setProperty('letter-spacing', navTrack, 'important');
			// hover
			opt.addEventListener('mouseenter', function () {
				if (opt.classList.contains('navMenuOption-selected') || isExactMatch(opt, curId)) return;
				opt.style.setProperty('background', 'rgba(255,255,255,0.06)', 'important');
				opt.style.setProperty('color', 'rgba(255,255,255,.95)', 'important');
			});
			opt.addEventListener('mouseleave', function () {
				if (opt.classList.contains('navMenuOption-selected') || isExactMatch(opt, curId)) return;
				opt.style.setProperty('background', 'transparent', 'important');
				opt.style.setProperty('color', muted, 'important');
			});
		});
		// Clear ALL selected states first (prevents stale highlights)
		drawer.querySelectorAll('.navMenuOption').forEach(function (opt) {
			if (!opt.classList.contains('navMenuOption-selected') && !isExactMatch(opt, curId)) {
				opt.style.removeProperty('background');
				opt.style.setProperty('color', muted, 'important');
				opt.style.removeProperty('box-shadow');
				opt.style.setProperty('font-weight', '500', 'important');
			}
		});
		// Selected: FILLED pill with accent bg + dark text + glow
		drawer.querySelectorAll('.navMenuOption-selected').forEach(function (sel) {
			applySelected(sel, accent, textOnAccent, btnRound);
		});
		// Also highlight by exact ID match (curated links don't get navMenuOption-selected)
		if (curId) {
			drawer.querySelectorAll('a.navMenuOption').forEach(function (a) {
				if (isExactMatch(a, curId) && !a.classList.contains('navMenuOption-selected')) {
					applySelected(a, accent, textOnAccent, btnRound);
				}
			});
		}
		function isExactMatch(el, cid) {
			if (!cid) return false;
			var href = el.getAttribute('href') || '';
			// Extract id param from this link's href and compare exactly
			var m = href.match(/[?&]id=([^&]*)/);
			return m && m[1] === cid;
		}
		function applySelected(el, acc, txtColor, round) {
			el.style.setProperty('background', acc, 'important');
			el.style.setProperty('color', txtColor, 'important');
			el.style.setProperty('font-weight', '700', 'important');
			el.style.setProperty('box-shadow', '0 0 14px ' + acc + '66', 'important');
			el.style.setProperty('border-radius', round, 'important');
		}
	}

	function scan() {
		if (loaded) {
			document.querySelectorAll('.card[data-id]').forEach(decorateItem);
			document.querySelectorAll('.listItem[data-id]').forEach(decorateItem);
			decorateDetails();
		}
		playlistClicksToDetails();
		shuffleWatchlist();
		showcaseTop100();
		addSidebarEntries();
		themeDrawer(); // apply inline styles to sidebar drawer (beats all imported CSS)
	}

	function start() {
		injectStyles();
		var t;
		var obs = new MutationObserver(function () { clearTimeout(t); t = setTimeout(scan, 250); });
		obs.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('hashchange', function () { setTimeout(scan, 150); });
		loadLists();
		setInterval(loadLists, REFRESH_MS);
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
