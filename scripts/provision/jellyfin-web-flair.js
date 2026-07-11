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

	// ---- styles (injected once) --------------------------------------------------------------
	function injectStyles() {
		if (document.getElementById('curated-flair-styles')) return;
		var css =
			'.curated-rank,.curated-bookmark{position:absolute;z-index:3;pointer-events:none;}' +
			'.curated-rank{top:4px;right:4px;padding:0 5px;border-radius:4px;' +
			'font:700 12px/1.5 "Noto Sans",sans-serif;color:#fff;background:rgba(0,0,0,.62);' +
			'border:1px solid ' + ACCENT + ';white-space:nowrap;}' +
			'.curated-bookmark{top:2px;left:4px;width:20px;height:20px;' +
			'filter:drop-shadow(0 0 1px rgba(0,0,0,.7));}' +
			// larger pill on the details page's big poster
			'.curated-host-detail .curated-rank{top:8px;right:8px;padding:1px 8px;font-size:15px;}' +
			'.curated-host-detail .curated-bookmark{top:6px;left:8px;width:28px;height:28px;}';
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
					jobs.push(a.getJSON(a.getUrl('Playlists/' + top100Id + '/Items', { UserId: userId }))
						.then(function (r) {
							((r && r.Items) || []).forEach(function (it, i) {
								if (it.Id && !nextRank.has(it.Id)) nextRank.set(it.Id, i + 1);
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
					watchSet = nextWatch;
					loaded = true;
					// Clear markers so everything on screen re-decorates with the fresh data.
					document.querySelectorAll('[data-curated-flair-id]').forEach(function (c) { delete c.dataset[MARK]; });
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

	function scan() {
		if (loaded) {
			document.querySelectorAll('.card[data-id]').forEach(decorateItem);
			document.querySelectorAll('.listItem[data-id]').forEach(decorateItem);
			decorateDetails();
		}
		playlistClicksToDetails(); // independent of `loaded` — pure DOM attribute rewrite
		shuffleWatchlist();        // needs idByName (set early in loadLists); no-op off the Watchlist page
		addSidebarEntries(); // independent of `loaded` — needs only idByName, set early in loadLists
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
