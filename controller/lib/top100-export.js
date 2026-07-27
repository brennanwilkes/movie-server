'use strict';
// Top 100 snapshot export. The ONLY piece of state on this box with no regeneration path.
//
// Everything else self-heals: Jellyseerr availability from its 03:00 full scan, tags from the
// oscar/nation sweeps, collections from collectionsSweep, home shelves from registerHssShelf.
// The Top 100 playlist does not — routes-elo.js reads the Jellyfin playlist and writes the new
// order straight back to it ("no owned state beyond _cache keys"), so the playlist IS the source
// of truth for the ranking. Delete it and the ordering is gone; no sweep can rebuild it, because
// nothing else knows it. (Brennan lost most of Jellyseerr's DB to a stray UI button on
// 2026-07-27; this is the same failure mode against something that is not regenerable.)
//
// Deliberately NOT a database backup — Brennan's call, and the right one: root is 93% full and
// the recoverable-state principle beats snapshots. This is ~10KB of text that a human can read
// and, if it ever comes to it, retype.
//
// Owns: nothing. Timers: startTop100ExportTimer() → weekly, plus one export ~2 min after boot.

const fs = require('fs/promises');
const path = require('path');
const { cfg, HOST } = require('./config');
const { tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');

// /config is the controller's only writable mount (/opt/appdata/controller on the host) and
// survives the image rebuilds that `make deploy s=controller` does on every code change.
const EXPORT_DIR = '/config/top100-snapshots';
const KEEP = 12;                       // ~3 months of weekly snapshots, a few hundred KB total

// Snapshot lines carry the ids as well as the human-readable title: Jellyfin item ids are what a
// restore actually needs, but they are meaningless to a person, and IMDb ids survive a library
// rebuild that reassigns Jellyfin ids. Write all three.
function formatSnapshot(items, stamp) {
  const lines = [
    '# Jellyfin "Top 100" playlist — ordered snapshot',
    `# taken: ${stamp}`,
    `# count: ${items.length}`,
    '#',
    '# The Top 100 ORDER is the irreplaceable part (Elo-tuned by hand); membership is secondary.',
    '# Columns: rank <TAB> title (year) <TAB> imdb <TAB> jellyfinId',
    '#',
  ];
  items.forEach((it, i) => {
    const year = it.ProductionYear ? ` (${it.ProductionYear})` : '';
    const imdb = (it.ProviderIds && it.ProviderIds.Imdb) || '-';
    lines.push(`${String(i + 1).padStart(3)}\t${it.Name}${year}\t${imdb}\t${it.Id}`);
  });
  return `${lines.join('\n')}\n`;
}

async function exportTop100() {
  if (!cfg.JELLYFIN_KEY) return;
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const pq = new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true', Limit: '200' });
    const playlists = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 20000)).Items) || [];
    const pl = playlists.find((p) => p.Name === 'Top 100');
    if (!pl) { console.log('top100Export: no "Top 100" playlist — skipped'); return; }

    const iq = new URLSearchParams({ Limit: '500', Fields: 'ProviderIds,ProductionYear' });
    const items = ((await tfetchJson(`${HOST.jellyfin}/Playlists/${pl.Id}/Items?${iq}&userId=${uid}`, { headers: h }, 20000)).Items) || [];

    // Never overwrite a good snapshot with an empty one. A transient Jellyfin hiccup returning
    // zero items would otherwise quietly destroy the very thing this exists to preserve.
    if (!items.length) { console.log('top100Export: playlist read returned 0 items — refusing to write'); return; }

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(EXPORT_DIR, `top100-${stamp.slice(0, 10)}.txt`);
    await fs.writeFile(file, formatSnapshot(items, new Date().toISOString()), 'utf8');
    // `latest` is a copy, not a symlink, so it survives being read from the host or a bind mount.
    await fs.writeFile(path.join(EXPORT_DIR, 'top100-latest.txt'), formatSnapshot(items, new Date().toISOString()), 'utf8');

    const all = (await fs.readdir(EXPORT_DIR))
      .filter((f) => /^top100-\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
      await fs.unlink(path.join(EXPORT_DIR, old)).catch(() => {});
    }
    console.log(`top100Export: wrote ${items.length} items → ${file} (${all.length} snapshots kept)`);
  } catch (e) { console.log(`top100Export: failed — ${e.message || e}`); }
}

function startTop100ExportTimer() {
  setInterval(exportTop100, 7 * 24 * 3600000);            // weekly
  setTimeout(exportTop100, 120000);                       // and once shortly after boot
}

module.exports = { exportTop100, startTop100ExportTimer };
