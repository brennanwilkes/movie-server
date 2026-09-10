'use strict';
// Purge zero-byte entries from Jellyfin's resized-image cache.
//
// THE BUG THIS EXISTS FOR: Jellyfin sometimes leaves a 0-byte file behind when generating a
// thumbnail. It then serves that file forever — "200 OK, Content-Type: image/jpeg,
// Content-Length: 0" — because the only thing it checks is whether the cache file exists. No
// client can recover from that: Coil's BitmapFactory returns null ("BitmapFactory returned a null
// bitmap") and the card renders as a black square. That is the black-poster bug on the Fire Stick.
//
// Measured 2026-09-07: 49 of 955 movie posters affected, from 157 dead files out of 7,230. The
// ORIGINALS were all intact — Million Dollar Baby's poster.jpg was a valid 136 KB JPEG on disk and
// its full-size URL served fine; only the resized derivative was empty. So this is purely a cache
// fault, and deleting the empty file is a complete fix: Jellyfin regenerates it on the next
// request (verified — 0 bytes became 36 KB immediately).
//
// SAFETY. The mount is scoped to cache/images (see docker-compose.yml), so this cannot reach
// Jellyfin's database, settings or metadata, and it only ever unlinks files whose size is exactly
// zero. A zero-byte cache entry has no recoverable content by definition, so there is nothing to
// lose and nothing to back up.
//
// Timers: startJfImageCacheTimer() → every 6h, plus one pass shortly after boot.

const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');

// Mounted read-write from ${CONFIG}/jellyfin/cache/images.
const CACHE_DIR = '/jf-image-cache';

// Walk iteratively. The cache is a two-level fan-out of thousands of files; recursion is fine at
// this size but an explicit stack keeps the memory flat and cannot blow the call stack if Jellyfin
// ever nests deeper.
function findEmptyFiles(root) {
  const empty = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }                                  // vanished mid-walk, or unreadable
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;                         // never touch symlinks or specials
      scanned++;
      try { if (fs.statSync(full).size === 0) empty.push(full); }
      catch { /* raced with Jellyfin writing it; it will be caught next pass */ }
    }
  }
  return { empty, scanned };
}

async function jfImageCacheSweep() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.log(`jfImageCache: ${CACHE_DIR} not mounted — skipping`);
    return;
  }
  const { empty, scanned } = findEmptyFiles(CACHE_DIR);
  if (!empty.length) {
    console.log(`jfImageCache: ${scanned} cached images, none empty`);
    return;
  }
  let removed = 0;
  for (const f of empty) {
    // Re-check the size immediately before unlinking: Jellyfin may have finished writing this
    // very file since the walk, and deleting a now-valid thumbnail would just cost a regeneration.
    try {
      if (fs.statSync(f).size !== 0) continue;
      fs.unlinkSync(f);
      removed++;
    } catch { /* already gone, or being written — leave it for the next pass */ }
  }
  console.log(`jfImageCache: ${scanned} cached images, ${removed} zero-byte entries purged`
    + ' (Jellyfin will regenerate them on next request)');
}

// Weight 46 — housekeeping, so it sits below the sweeps that build what the UI shows
// (Auto-collections 60, Crew people 58, Oscar badges 56) but above the Top 100 plumbing.
const tracked = jobs.define({
  id: 'jf-image-cache', name: 'Poster cache repair', group: 'Metadata', weight: 46,
  what: 'Deletes empty thumbnails Jellyfin would otherwise serve as black posters forever',
  every: 6 * 3600000, scheduleText: 'every 6h · and on boot',
}, jfImageCacheSweep);

function startJfImageCacheTimer() {
  setInterval(tracked, 6 * 3600000);
  // Six hours is a long time to stare at a black poster, so also sweep shortly after boot —
  // cheap (a stat() per cached file) and it clears anything that broke while the stack was down.
  setTimeout(tracked, 90000);
}

module.exports = { jfImageCacheSweep: tracked, startJfImageCacheTimer, CACHE_DIR };
