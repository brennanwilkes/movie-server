'use strict';
// Config & topology. Owns: cfg (process.env overlaid with /config/keys.env,
// frozen at boot), the static data files (oscar-winners.json, intl-languages.json),
// upstream base URLs (HOST) and browser deep-link ports (PORTS). No timers.

const fs = require('fs');
const path = require('path');

// ── Config: /config/keys.env (written by scripts/provision/controller.sh) over env ──
function loadCfg() {
  const c = { ...process.env };
  try {
    for (const line of fs.readFileSync('/config/keys.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      c[m[1]] = v;
    }
  } catch { /* not provisioned yet — run degraded */ }
  return c;
}
const cfg = loadCfg();

const oscarWinners = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'oscar-winners.json'), 'utf8')); } catch { return {}; } })();
// Per-film Oscar win/nom COUNTS, IMDb-keyed — feeds oscarTagsSweep() poster badges. Distinct
// from oscarWinners above (which is TMDB-keyed category collections). See DESIGN-OSCAR-BADGES.md.
const filmAwards = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'film-awards.json'), 'utf8')); } catch { return {}; } })();
// Per-person Oscar counts, keyed by NORMALIZED NAME (people mostly lack IMDb ids in Jellyfin, so
// oscarTagsSweep matches Person items by name). Value: {noms, wins, name}. See DESIGN-OSCAR-BADGES.md.
const personAwards = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'person-awards.json'), 'utf8')); } catch { return {}; } })();
const intlLanguages = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'intl-languages.json'), 'utf8')); } catch { return {}; } })();

const PORT = Number(cfg.CONTROLLER_PORT || 8088);
const NUC_IP = cfg.NUC_IP || '192.168.1.74';
// The $DATA loopback image IS the hard cap, so its live filesystem size (from statfs
// below) is the real number — no hardcoded constant to drift out of sync on resize.

// Internal (container-network) bases + external ports for browser deep-links.
const HOST = {
  jellyfin: `http://${NUC_IP}:8096`,   // Jellyfin runs on host networking (for PS4 DLNA), so reach it
                                        // via the NUC's IP, not the container DNS name 'jellyfin'.
  // QBIT_HOST is 'qbittorrent' normally, or 'gluetun' when qBittorrent is routed
  // through the VPN overlay (make vpn-up) — where it shares gluetun's namespace and
  // has no DNS name of its own. Browser deep-links still use NUC_IP:8080 (below).
  qbittorrent: `http://${cfg.QBIT_HOST || 'qbittorrent'}:8080`,
  prowlarr: 'http://prowlarr:9696',
  radarr: 'http://radarr:7878',
  sonarr: 'http://sonarr:8989',
  bazarr: 'http://bazarr:6767',
  jellyseerr: 'http://jellyseerr:5055',
  flaresolverr: 'http://flaresolverr:8191',
};
const PORTS = { jellyfin: 8096, qbittorrent: 8080, prowlarr: 9696, radarr: 7878, sonarr: 8989, bazarr: 6767, jellyseerr: 5055, flaresolverr: 8191 };
const linkFor = (id) => `http://${NUC_IP}:${PORTS[id]}`;

module.exports = { cfg, PORT, NUC_IP, HOST, PORTS, linkFor, oscarWinners, filmAwards, personAwards, intlLanguages };
