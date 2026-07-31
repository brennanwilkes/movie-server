'use strict';
// CPU-decode census: how much of the library CANNOT be hardware-decoded, measured from
// post-import mediaInfo. Report-only — it never touches a file. Timers: startCpuCensus()
// → every 6h, first at 5 min. Emits a `cpu_census` event; query with:
//   ./scripts/query-metrics.sh events --type cpu_census
//
// WHY THIS EXISTS: gpu-verify.js already fixes this class of problem, but only for MOVIES
// and only inside a 48h post-import window (deliberately — a settled library is never
// auto-modified). Measured 2026-07-27, that scope covers 4% of the actual problem:
//
//     TV (Sonarr)      543 files, 556.1 GiB   10-bit HEVC   <- outside gpu-verify entirely
//     Movies (Radarr)   23 files,  92.7 GiB   10-bit HEVC
//
// Those files cannot direct-play on the Fire TV Stick 2nd gen, and Jellyfin runs with
// EnableDecodingColorDepth10Hevc=false (correct for Skylake, whose 10-bit HEVC decode is
// hybrid and unreliable), so every play software-decodes on the NUC CPU. That is why ~70%
// of playbacks were transcoding video when this was found.
//
// The point of a census rather than an auto-fixer: the settled-library exclusion is the
// right call, so the backlog can only be cleared by deliberate, human-gated re-grabs
// (scripts/find-replacements.sh). What was missing was simply KNOWING the size of it, and
// noticing if it starts growing again. A number that moves is a number someone can act on.
//
// Bit depth is read from mediaInfo, never from the release title: modern x265 is
// 10-bit-by-default without saying so, and the indexers truncate titles at 59 characters
// (observed: "...x265 HEVC 10bi", marker cut off mid-word). Title regexes structurally
// cannot see this; ffprobe already did.

const metrics = require('../metrics');
const { arrGet } = require('./clients');
const { gpuTier, videoLabel } = require('./arr-inspect');
const { isMasterPaused } = require('./state');

let censusBusy = false;

// Returns { files, bytes, worst } for one *arr's file list. `worst` is the biggest
// offenders by bytes, so the event itself is actionable without a second query.
function tally(entries) {
  let files = 0, bytes = 0;
  const byTitle = new Map();
  for (const { title, size, mediaInfo } of entries) {
    // 'ok' = hardware-decodable. 'warn' = 10-bit/HDR, 'bad' = AV1/VP9/Dolby Vision.
    // Both non-ok tiers mean CPU decode on this box, so both count.
    if (!mediaInfo || gpuTier(mediaInfo) === 'ok') continue;
    files++; bytes += size || 0;
    const e = byTitle.get(title) || { n: 0, b: 0, label: videoLabel(mediaInfo) };
    e.n++; e.b += size || 0;
    byTitle.set(title, e);
  }
  const worst = [...byTitle.entries()]
    .sort((a, b) => b[1].b - a[1].b).slice(0, 5)
    .map(([t, e]) => ({ t, n: e.n, gb: +(e.b / 1073741824).toFixed(1), v: e.label }));
  return { files, bytes, worst };
}

async function cpuCensusSweep() {
  // Skip while someone is watching: this is ~100 *arr calls and the number is not urgent.
  if (isMasterPaused() || censusBusy) return;
  censusBusy = true;
  try {
    const mv = [];
    try {
      for (const m of await arrGet('radarr', '/movie')) {
        if (m.hasFile && m.movieFile) {
          mv.push({ title: m.title, size: m.movieFile.size, mediaInfo: m.movieFile.mediaInfo });
        }
      }
    } catch (e) { console.log(`cpuCensus: radarr fetch failed — ${e.message || e}`); return; }

    // Sonarr has no "all episode files" endpoint, so this is one call per series. That is
    // the reason the census runs 6-hourly rather than alongside the 10s system sampler.
    const tv = [];
    try {
      for (const s of await arrGet('sonarr', '/series')) {
        let fl; try { fl = await arrGet('sonarr', `/episodefile?seriesId=${s.id}`); } catch { continue; }
        for (const f of (Array.isArray(fl) ? fl : [])) {
          tv.push({ title: s.title, size: f.size, mediaInfo: f.mediaInfo });
        }
      }
    } catch (e) { console.log(`cpuCensus: sonarr fetch failed — ${e.message || e}`); }

    const M = tally(mv), T = tally(tv);
    const gb = (b) => +(b / 1073741824).toFixed(1);
    const totalFiles = M.files + T.files;
    if (!totalFiles && !mv.length && !tv.length) return;   // both fetches empty — say nothing

    metrics.emitEvent('cpu_census', {
      mv: M.files, mvGb: gb(M.bytes), mvTotal: mv.length,
      tv: T.files, tvGb: gb(T.bytes), tvTotal: tv.length,
      worstTv: T.worst, worstMv: M.worst,
    });
    console.log(`cpuCensus: ${totalFiles} of ${mv.length + tv.length} files need CPU decode `
      + `(${gb(M.bytes + T.bytes)} GB) — movies ${M.files}/${mv.length}, tv ${T.files}/${tv.length}`
      + (T.worst.length ? ` · worst: ${T.worst.map((w) => `${w.t} (${w.n}f ${w.gb}G ${w.v})`).join(', ')}` : ''));
  } finally { censusBusy = false; }
}

function startCpuCensus() {
  setInterval(cpuCensusSweep, 6 * 3600000);   // 6h — the backlog moves slowly; this is a trend line
  setTimeout(cpuCensusSweep, 300000);         // 5 min after boot, well clear of the startup rush
}

module.exports = { cpuCensusSweep, startCpuCensus };
