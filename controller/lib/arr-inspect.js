'use strict';
// Read-only *arr inspection helpers: media-file GPU labelling (videoLabel/
// gpuTier for this NUC's Skylake Iris 540), disk headroom, item titles,
// activity checks, and the disk-only-rejection diagnoser used by requestGate.
// No owned state, no timers.

const fs = require('fs');
const { arrGet } = require('./clients');

// Video format labelling and GPU-compatibility tier.
function videoLabel(mi) {
  if (!mi) return '';
  const c = (mi.videoCodec || '').toLowerCase();
  let codec = '';
  if (c.includes('x265') || c.includes('hevc')) codec = 'HEVC';
  else if (c.includes('av1')) codec = 'AV1';
  else if (c.includes('x264') || c.includes('h264') || c.includes('avc')) codec = 'H.264';
  else if (c.includes('vp9')) codec = 'VP9';
  else codec = c.toUpperCase() || '';
  const d = mi.videoBitDepth ? mi.videoBitDepth + 'bit' : '';
  const dr = mi.videoDynamicRange || '';
  const drt = (mi.videoDynamicRangeType || '').toUpperCase();
  let hdr = '';
  if (drt.includes('DV')) hdr = 'DV';
  else if (drt.includes('HDR10')) hdr = 'HDR10+';
  else if (dr && dr !== 'SDR') hdr = dr;
  return [codec, d, hdr].filter(Boolean).join(' ');
}
function gpuTier(mi) {
  if (!mi) return '';
  const c = (mi.videoCodec || '').toLowerCase();
  const d = mi.videoBitDepth || 8;
  const dr = mi.videoDynamicRange || '';
  const drt = (mi.videoDynamicRangeType || '').toUpperCase();
  // Tuned for this NUC's i5-6260U (Skylake Iris 540):
  //   HW decode: H.264 8-bit, HEVC 8-bit only (10-bit is software).
  //   HW encode: H.264, H.265 8-bit only.
  //   VP9 decode, no AV1, no DoVi.
  if (c.includes('av1')) return 'bad';
  if (c.includes('vp9')) return 'bad';   // VP9 HW decode is not enabled in this Jellyfin config → CPU
  if (drt.includes('DV')) return 'bad';
  if (d >= 10) return 'warn';
  if (drt.includes('HDR') || dr === 'HDR') return 'warn';
  return 'ok';
}
const DISK_REJ = /exceed available disk space/i;

async function freeUnderCap() {
  const s = await fs.promises.statfs('/data');
  const total = s.blocks * s.bsize;
  const cap = total > 0 ? total : 0;
  return Math.max(0, cap - (total - s.bavail * s.bsize));
}
async function arrTitle(app, id, seasons) {
  try {
    const it = await arrGet(app, app === 'radarr' ? `/movie/${id}` : `/series/${id}`);
    let t = it.title + (it.year ? ` (${it.year})` : '');
    if (app === 'sonarr' && seasons.length) t += seasons.length === 1 ? ` — Season ${seasons[0]}` : ` — Seasons ${seasons.join(', ')}`;
    return t;
  } catch { return 'Requested title'; }
}
// True if the *arr is already doing something about this id (queued / grabbed / has a file) —
// i.e. it's NOT stuck, so there's nothing to explain.
async function arrHasActivity(app, id) {
  try { if (((await arrGet(app, '/queue?pageSize=200')).records || []).some((r) => (app === 'radarr' ? r.movieId : r.seriesId) === id)) return true; } catch { /* arr down */ }
  try {
    if (app === 'radarr') { if ((await arrGet('radarr', `/movie/${id}`)).hasFile) return true; }
    else if (((await arrGet('sonarr', `/series/${id}`)).statistics || {}).episodeFileCount > 0) return true;
  } catch { /* arr down */ }
  try {
    const h = await arrGet(app, app === 'radarr' ? `/history/movie?movieId=${id}` : `/history/series?seriesId=${id}`);
    if ((Array.isArray(h) ? h : h.records || []).some((r) => (r.eventType || '').toLowerCase() === 'grabbed')) return true;
  } catch { /* no history */ }
  return false;
}
// Smallest release whose ONLY rejection is disk space = "the one we'd grab if it fit".
function diskOnlyBlocker(releases) {
  let best = null;
  for (const r of releases) {
    const rej = r.rejections || [];
    if (!rej.length) return null;                       // a grabbable release exists → not a disk wall
    if (rej.every((x) => DISK_REJ.test(x)) && (r.size || 0) > 0 && (!best || r.size < best.size)) best = r;
  }
  return best;                                          // null = stuck for some OTHER reason
}
async function diagnose(app, id, seasons) {
  const rels = [];
  try {
    if (app === 'radarr') rels.push(...await arrGet('radarr', `/release?movieId=${id}`, 90000));
    else for (const sn of (seasons.length ? seasons : [1])) { try { rels.push(...await arrGet('sonarr', `/release?seriesId=${id}&seasonNumber=${sn}`, 90000)); } catch { /* indexer hiccup */ } }
  } catch { return null; }
  return diskOnlyBlocker(rels);
}

module.exports = { videoLabel, gpuTier, freeUnderCap, arrTitle, arrHasActivity, diskOnlyBlocker, diagnose };
