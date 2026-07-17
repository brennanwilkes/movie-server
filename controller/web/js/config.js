'use strict';
// Movie Night dashboard — part 1/9 (load order matters; see index.html).
// Deep-link config: NUC_BASE derived from how the user reached the dashboard,
// Watch/Request URLs, openJellyfin(), and the offline launcher CATALOG.

// Served from the NUC (controller container) over HTTP, so the API is same-origin
// (relative). If the backend is ever unreachable, the UI degrades to a deep-link
// launcher + a "not on your home network" banner.
// Base for deep-links to the other services (Jellyfin, *arr, …). Derived from however the user
// reached THIS dashboard — LAN IP, mesh 100.x, or movies.local — so links always point at a host
// they can actually reach, instead of a hardcoded LAN IP that breaks over Tailscale/cellular.
const NUC_BASE = `${location.protocol}//${location.hostname}`;
const API = '';

// The two everyday actions are the big buttons on Home (set once — deep-links work
// in both live and launcher modes). Jellyfin = Watch, Jellyseerr = Request.
const WATCH_URL = `${NUC_BASE}:8096`;
const REQUEST_URL = `${NUC_BASE}:5055`;

// Deep-link helper — opens Jellyfin web UI in a new tab.
function openJellyfin(path = '') {
  window.open(`${WATCH_URL}/web/${path}`, '_blank');
}

// Static fallback so the launcher renders the "Tools" without the backend (matches /api/status).
const CATALOG = [
  { id: 'qbittorrent', name: 'Torrents', brand: 'qBittorrent', port: 8080 },
  { id: 'radarr', name: 'Movies', brand: 'Radarr', port: 7878 },
  { id: 'sonarr', name: 'TV Shows', brand: 'Sonarr', port: 8989 },
  { id: 'prowlarr', name: 'Sources', brand: 'Prowlarr', port: 9696 },
  { id: 'bazarr', name: 'Subtitles', brand: 'Bazarr', port: 6767 },
];
