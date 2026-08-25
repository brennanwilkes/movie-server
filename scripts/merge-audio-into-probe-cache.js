#!/usr/bin/env node
'use strict';
// merge-audio-into-probe-cache.js — fold measure-audio.sh's backfill into /config/probe-cache.json.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────────
// probe-film.sh measures true audio bitrate, but only for a unit it actually (re-)probes, and a full
// re-probe of 1026 units is ~14 nights. measure-audio.sh gets the same number for the whole library
// in a couple of hours because it needs no encoding — but it writes a standalone JSONL that nothing
// reads. arr-inspect.js's audio resolver looks up ONE place: the probe cache. So until the JSONL is
// merged, every BPP+ in the UI still charges *arr's unreported audio tracks to video, and the fix
// deployed on 2026-08-13 appears to do nothing. That is not a UI bug; it is this missing step.
//
// ── SAFETY ────────────────────────────────────────────────────────────────────────────────────────
// * Matches on PATH **and** SIZE. `measuredFrom` is "path|size|mtime", so a file replaced since it
//   was probed has a different size and is skipped rather than being given another file's audio.
//   Attaching stale audio would silently deflate a BPP+ with no way to notice.
// * Writes via a temp file + rename, and backs up the original first, mirroring saveProbeCache().
// * Touches ONLY audioBps/audioTracks/audioFrom. Never complexity, never R, never measuredFrom — so
//   a re-probe overwrites these with its own measurement and nothing here can corrupt the expensive
//   half of an entry.
// * Idempotent: re-running with the same input is a no-op. Safe to wire into a nightly job.
//
// ── YOU MUST RESTART THE CONTROLLER AFTERWARDS ────────────────────────────────────────────────────
// probe.js holds the cache in memory and saveProbeCache() rewrites the whole file from that map. An
// on-disk edit therefore survives only until the next probe save, which would clobber it. Restarting
// makes the controller re-read from disk. The script refuses to run during the probe window for the
// same reason.
//
// USAGE:  node scripts/merge-audio-into-probe-cache.js [--dry-run] [--force]
const fs = require('fs');
const path = require('path');

const CACHE = process.env.PROBE_CACHE || '/opt/appdata/controller/probe-cache.json';
const JSONL = process.env.AUDIO_OUT
  || path.join(__dirname, '..', 'docs/audit-2026-07-31/raw/audio-measured.jsonl');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// The nightly probe owns this file between 01:00 and 06:00. Merging underneath a live writer is how
// you lose a night of expensive complexity measurements to a lost update.
const hour = new Date().getHours();
if (hour >= 1 && hour < 6 && !FORCE) {
  console.error(`refusing to merge at ${hour}:xx — the probe window owns the cache. Use --force if the probe is idle.`);
  process.exit(2);
}
if (!fs.existsSync(CACHE)) { console.error(`no cache at ${CACHE}`); process.exit(1); }
if (!fs.existsSync(JSONL)) { console.error(`no backfill at ${JSONL}`); process.exit(1); }

const audio = new Map();
let bad = 0;
for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  // The backfill appends as it goes, so the final line of a RUNNING job is routinely half-written.
  // That is expected, not an error — take what is complete and merge the rest next time.
  try {
    const j = JSON.parse(line);
    if (j.path && j.audioBps > 0) audio.set(j.path, j);
  } catch { bad++; }
}
console.log(`backfill: ${audio.size} usable rows${bad ? ` (${bad} unparseable — expected if the job is still running)` : ''}`);

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const ents = cache.entries || {};
let merged = 0, already = 0, sizeMismatch = 0, noMeasuredFrom = 0, unmatched = 0;
const samples = [];

for (const key of Object.keys(ents)) {
  const e = ents[key];
  if (!e || e.error || !e.measuredFrom) { if (e && !e.error) noMeasuredFrom++; continue; }
  // measuredFrom is "path|size|mtime" and a path can itself contain no '|', so split from the right.
  const parts = String(e.measuredFrom).split('|');
  if (parts.length < 3) { noMeasuredFrom++; continue; }
  const mtime = parts.pop(); const size = Number(parts.pop()); const p = parts.join('|');
  void mtime;
  const a = audio.get(p);
  if (!a) { unmatched++; continue; }
  if (Number(a.size) !== size) { sizeMismatch++; continue; }   // file replaced since the probe
  if (e.audioBps === a.audioBps && e.audioTracks === a.audioTracks) { already++; continue; }
  if (samples.length < 8) samples.push(`  ${(e.title || key).slice(0, 40).padEnd(42)}`
    + `${(a.audioBps / 1000).toFixed(0).padStart(6)}k  x${a.audioTracks}`);
  e.audioBps = Number(a.audioBps);
  e.audioTracks = Number(a.audioTracks) || null;
  // Provenance: a re-probe sets audioBps without this marker, so a later reader can tell a backfilled
  // value from one measured in the same pass that produced the complexity.
  e.audioFrom = 'backfill';
  merged++;
}

console.log(`entries: ${Object.keys(ents).length}`);
console.log(`  merged            ${merged}`);
console.log(`  already current   ${already}`);
console.log(`  no audio row yet  ${unmatched}   (backfill has not reached them)`);
console.log(`  size mismatch     ${sizeMismatch}   (file replaced since probe — SKIPPED on purpose)`);
console.log(`  no measuredFrom   ${noMeasuredFrom}`);
if (samples.length) console.log(`\nsample:\n${samples.join('\n')}`);

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
if (!merged) { console.log('\nnothing to write.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
fs.copyFileSync(CACHE, `${CACHE}.bak-audio-${stamp}`);
const tmp = `${CACHE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cache));
fs.renameSync(tmp, CACHE);
console.log(`\nwrote ${CACHE} (backup .bak-audio-${stamp})`);
console.log('NOW RESTART THE CONTROLLER — it rewrites this file from memory and will otherwise clobber the merge.');
