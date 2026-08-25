#!/usr/bin/env node
/* BACKFILL `srcBasis` INTO THE PROBE CACHE — one-shot migration, 2026-08-20.
 *
 * WHY. probe-film.sh takes srcBitrate from the video stream when ffprobe reports one and falls back
 * to the container total when it does not. Only the fallback path carries audio inside the number.
 * R is a supply ratio and must be video-only on both sides (§3.2 removed audio from the numerator
 * for exactly this reason), so probe.js subtracts the measured audio — but ONLY on the container
 * path, and it needs `srcBasis` to tell the two apart.
 *
 * Entries measured before 2026-08-20 have no `srcBasis`, so probe.js leaves them uncorrected: the
 * old, wrong behaviour, chosen deliberately over guessing. This script fills the flag in by re-
 * asking ffprobe the same two questions probe-film.sh asked, and applying the identical rule.
 *
 * WHY NOT JUST RE-PROBE. A re-probe is ~40s of x265 per unit — hours for the library, and it would
 * churn the complexity measurements this flag has nothing to do with. ffprobe reads container
 * metadata only: no decode, ~150ms per file.
 *
 * SAFETY. Writes a timestamped backup beside the cache before touching it. Never reads or writes
 * media — ffprobe is metadata-only and /data is mounted read-only anyway. Idempotent: entries that
 * already carry `srcBasis` are skipped, so it is safe to re-run. --dry-run prints and writes nothing.
 *
 * USAGE
 *   node scripts/backfill-srcbasis.js [--dry-run] [--cache PATH] [--jobs N]
 */
const fs = require('fs');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has('--dry-run');
const CACHE = val('--cache', '/opt/appdata/controller/probe-cache.json');
const JOBS = Math.max(1, Number(val('--jobs', 8)) || 8);

const ffprobe = (a) => new Promise((res) => {
  execFile('ffprobe', a, { timeout: 30000 }, (err, out) => res(err ? '' : String(out).trim()));
});

// EXACTLY probe-film.sh's reads and its trust rule. If this drifts from that, the flag lies.
//
// SOURCE DIMENSIONS COME ALONG FOR FREE. Entries measured before 2026-08-20 kept only the PROBE
// geometry, which equals the source only while the source is no wider than PROBE_REFERENCE_WIDTH.
// Provenance rather than an input — nothing scores off it — but one ffprobe answers both questions,
// so there is no reason to make it wait for a re-probe.
async function readOf(path) {
  const one = (s) => (s ? s.split('\n')[0].trim() : '');
  const vb = one(await ffprobe(['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=bit_rate', '-of', 'default=nw=1:nk=1', path]));
  const tb = one(await ffprobe(['-v', 'error',
    '-show_entries', 'format=bit_rate', '-of', 'default=nw=1:nk=1', path]));
  const wh = one(await ffprobe(['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path]));
  const n = (s) => (s && s !== 'N/A' ? Number(s) || 0 : 0);
  const v = n(vb); const t = n(tb);
  const m = /^(\d+)x(\d+)$/.exec(wh || '');
  const dims = m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  if (v <= 0 && t <= 0) return dims ? { basis: null, dims } : null;  // keep geometry even if rates fail
  return { basis: (v > 0 && (t <= 0 || v <= t * 1.05)) ? 'video' : 'container', dims };
}

// `measuredFrom` is "path|size|mtime"; the path is the file the numbers were taken from.
const pathOf = (e) => {
  const m = e && e.measuredFrom;
  if (!m || typeof m !== 'string') return null;
  const p = m.split('|')[0];
  return p && p.startsWith('/') ? p : null;
};

(async () => {
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const entries = cache.entries || {};
  const todo = [];
  let already = 0; let noPath = 0;
  for (const [key, e] of Object.entries(entries)) {
    if (!e || e.error || !(e.complexity > 0)) continue;
    if (e.srcBasis && e.srcW > 0) { already += 1; continue; }
    const p = pathOf(e);
    if (!p) { noPath += 1; continue; }
    todo.push({ key, e, path: p });
  }
  console.log(`cache ${CACHE}: ${Object.keys(entries).length} entries, `
    + `${already} already flagged, ${noPath} without a usable path, ${todo.length} to classify`);
  if (!todo.length) return;

  const counts = { video: 0, container: 0, unreadable: 0, dims: 0 };
  let done = 0;
  const worker = async () => {
    for (;;) {
      const job = todo.pop();
      if (!job) return;
      const r = await readOf(job.path);
      if (r && r.basis) { job.e.srcBasis = r.basis; counts[r.basis] += 1; } else counts.unreadable += 1;
      if (r && r.dims) { job.e.srcW = r.dims.w; job.e.srcH = r.dims.h; counts.dims += 1; }
      done += 1;
      if (done % 100 === 0) process.stderr.write(`  ${done}/${done + todo.length}\r`);
    }
  };
  const total = todo.length;
  await Promise.all(Array.from({ length: JOBS }, worker));
  process.stderr.write(`  ${total}/${total}\n`);
  console.log(`classified: video ${counts.video}, container ${counts.container}, `
    + `unreadable ${counts.unreadable} (left unflagged); source dimensions on ${counts.dims}`);

  if (DRY) { console.log('--dry-run: nothing written'); return; }
  const bak = `${CACHE}.bak-srcbasis-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  fs.copyFileSync(CACHE, bak);
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`backup ${bak}\nwrote ${CACHE}`);
  console.log('NOTE: the controller holds the cache in memory — restart it to pick this up.');
})();
