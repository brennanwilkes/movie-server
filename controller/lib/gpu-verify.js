'use strict';
// GPU-compat verification sweep (movies): post-import mediaInfo ground truth →
// zero-gap swap of CPU-only files (10-bit/HDR/AV1/VP9) for GPU-decodable H.264
// when a strictly better release exists. Owns: gpuVerifyBusy; the persisted
// gpuSwapped/gpuPending Maps live in state.js. Timers: startGpuVerify() →
// every 15 min, first at 60s.

const metrics = require('../metrics');
const { cfg, HOST } = require('./config');
const { tfetch, qbit, arrGet, arrDelete, arrOf } = require('./clients');
const { getQbitTorrents, getQueueMap, torrentApp } = require('./arr-data');
const { jellyfinUserId, jellyfinIdByTmdb } = require('./jellyfin');
const { gpuSwapped, gpuPending, persistState, isMasterPaused } = require('./state');
const { videoLabel, gpuTier } = require('./arr-inspect');
const { importViaManual } = require('./importer');

// ---- GPU-compat verification sweep (movies): post-import ground truth ────────────────────
// Release titles can't prove bit depth — modern x265 is 10-bit-by-default without saying so,
// so some hidden-10-bit releases will always slip past the title-based custom formats. After
// import, Radarr's ffprobe mediaInfo KNOWS the truth.
//
// SWAP-SAFE DESIGN (a library title must never just vanish, and a swap must never downgrade):
//   1. Only files imported < 48h ago — a settled library is NEVER touched.
//   2. Playstate guard: skip anything anyone has started watching (fail-CLOSED: if Jellyfin
//      can't confirm, we don't act); already-watched titles are marked done (swap value ~0).
//   3. Search FIRST, act only if a STRICTLY better GPU-friendly release exists (custom-format
//      score > the current file's, real H.264, no 10-bit/HDR/AV1 markers, actually seeded) —
//      an indexer outage can't make us trade a small 10-bit file for a bloated x264.
//   4. ZERO-GAP: the old file is NOT deleted when the replacement is grabbed. It stays fully
//      playable until the new download COMPLETES; only then (Phase 1, playstate re-checked)
//      is the old copy removed and the new file imported. If the replacement never completes
//      (48h), the swap is abandoned and the old copy simply stays.
//   5. Once per movie EVER on success/watched (persisted in gpuSwapped); a no-better-release
//      pass retries at most every 6h within the 48h window. Max 2 new swaps per cycle. Never
//      in Movie Mode. Movies only. The Downloads UI labels the replacement download as an
//      auto-upgrade so an un-requested download always explains itself.
const GPU_SWAP_WINDOW_MS = 48 * 3600 * 1000;
let gpuVerifyBusy = false;
async function gpuVerifySweep() {
  if (isMasterPaused() || gpuVerifyBusy) return;
  gpuVerifyBusy = true;
  try {
    let movies; try { movies = await arrGet('radarr', '/movie'); } catch { return; }
    const queue = await getQueueMap('radarr');
    const queuedIds = new Set([...queue.values()].map((q) => q.movieId));
    const now = Date.now();

    // Phase 1 — finalize in-flight zero-gap swaps. The old copy is removed ONLY here: after
    // the replacement finished downloading, and never while someone is mid-watch.
    if (gpuPending.size) {
      let torrents = [];
      try { torrents = await getQbitTorrents(); } catch { /* qbit down — try next cycle */ }
      for (const [mid, p] of gpuPending) {
        if (now - p.ts > 48 * 3600000) {              // replacement never completed — stand down, keep the old copy
          gpuPending.delete(mid); gpuSwapped.set(mid, { ts: now, done: true }); persistState();
          console.log(`gpuVerify: upgrade of "${p.title}" abandoned after 48h — old copy kept`);
          metrics.emitEvent('swap_abandon', { ti: p.title, reason: '48h_timeout' });
          continue;
        }
        const old = new Set((p.oldHashes || []).map((x) => x.toLowerCase()));
        const fresh = torrents.filter((t) => torrentApp(t) === 'radarr'
          && !old.has((t.hash || '').toLowerCase())
          && (queue.get((t.hash || '').toLowerCase()) || {}).movieId === mid);
        const done = fresh.find((t) => (t.progress || 0) >= 1);
        if (!done) continue;                          // replacement still downloading — old copy stays playable
        try {                                          // fail CLOSED: no playstate confirmation → no deletion
          const jfId = await jellyfinIdByTmdb('Movie', p.tmdbId);
          if (jfId) {
            const uid = await jellyfinUserId();
            const it = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${jfId}`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 6000)).json();
            if (((it.UserData || {}).PlaybackPositionTicks || 0) > 0) {
              console.log(`gpuVerify: "${p.title}" replacement ready but someone is mid-watch — waiting`);
              metrics.emitEvent('swap_defer', { ti: p.title, reason: 'mid_watch' });
              continue;
            }
          }
        } catch { continue; }
        const files = await arrGet('radarr', `/moviefile?movieId=${mid}`).catch(() => []);
        for (const f of (Array.isArray(files) ? files : [])) { try { await arrDelete('radarr', `/moviefile/${f.id}`); } catch { /* */ } }
        if (old.size) {
          try { await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: [...old].join('|'), deleteFiles: 'true' }) }); } catch { /* */ }
        }
        if (done.content_path) { try { await importViaManual('radarr', done.content_path, mid); } catch { /* watchdog retries */ } }
        gpuPending.delete(mid); gpuSwapped.set(mid, { ts: now, done: true }); persistState();
        console.log(`gpuVerify: "${p.title}" upgraded — replacement complete, old copy removed, new file importing`);
        metrics.emitEvent('swap_done', { ti: p.title });
      }
    }

    // Phase 2 — scan fresh imports for non-GPU-decodable files and start new swaps.
    let acted = 0;
    const BAD_CF = new Set(['10-bit (CPU)', 'HDR / Dolby Vision (CPU)', 'Likely 10-bit group (CPU)', 'AV1 (CPU)', 'VP9 (CPU)']);
    for (const m of movies) {
      if (acted >= 2) break;
      const mf = m.movieFile;
      if (!m.hasFile || !mf || !mf.mediaInfo) continue;
      if (queuedIds.has(m.id) || gpuPending.has(m.id)) continue;
      const st = gpuSwapped.get(m.id);
      if (st && (st.done || st === true || typeof st === 'number')) continue;   // done (legacy entries = plain ts)
      if (st && now - st.ts < 6 * 3600000) continue;                            // no-better-release backoff
      const added = new Date(mf.dateAdded || 0).getTime();
      if (!added || now - added > GPU_SWAP_WINDOW_MS) continue;    // settled library — only police fresh imports
      if (gpuTier(mf.mediaInfo) === 'ok') continue;
      const label = videoLabel(mf.mediaInfo);
      try {
        // Playstate guard — fail CLOSED: if Jellyfin can't confirm nobody's watching, don't act.
        try {
          const jfId = await jellyfinIdByTmdb('Movie', m.tmdbId);
          if (jfId) {
            const uid = await jellyfinUserId();
            const it = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${jfId}`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 6000)).json();
            const ud = it.UserData || {};
            if (ud.PlayCount > 0) { gpuSwapped.set(m.id, { ts: now, done: true }); persistState(); continue; }  // already watched fine — swap value ~0
            if ((ud.PlaybackPositionTicks || 0) > 0) continue;                   // someone is mid-watch — hands off
          }
        } catch { continue; }
        // Search FIRST. Act only if a STRICTLY better GPU-friendly release exists right now.
        const fileScore = mf.customFormatScore ?? 0;
        const { base, key } = arrOf('radarr');
        const rels = await (await tfetch(`${base}/release?movieId=${m.id}`, { headers: { 'X-Api-Key': key } }, 90000)).json();
        const best = (Array.isArray(rels) ? rels : [])
          .filter((r) => !r.rejected && (r.seeders || 0) > 0)
          .filter((r) => {
            const names = (r.customFormats || []).map((c) => c.name);
            return names.includes('H.264 (GPU)') && !names.some((n) => BAD_CF.has(n));
          })
          .sort((a, b) => (b.customFormatScore || 0) - (a.customFormatScore || 0) || (b.seeders || 0) - (a.seeders || 0))[0];
        acted++;                                                   // a /release search is the expensive unit — count it
        if (!best || (best.customFormatScore || 0) <= fileScore) {
          gpuSwapped.set(m.id, { ts: now, done: false });          // nothing better out there — retry in 6h within the window
          persistState();
          console.log(`gpuVerify: "${m.title}" is ${label} but no better H.264 release available (file score ${fileScore}) — keeping it, retry in 6h`);
          metrics.emitEvent('swap_none', { ti: m.title, label, score: fileScore });
          continue;
        }
        // Snapshot the OLD copy's torrent hashes BEFORE grabbing, so the replacement's own
        // torrent can never appear in the removal list.
        let oldHashes = [];
        try {
          const hist = await arrGet('radarr', `/history/movie?movieId=${m.id}`);
          const recs = Array.isArray(hist) ? hist : (hist.records || []);
          oldHashes = [...new Set(recs.map((r) => r.downloadId).filter(Boolean))];
        } catch { /* */ }
        // Grab the replacement FIRST — if this fails, the current file is untouched.
        const gr = await tfetch(`${base}/release`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }) }, 30000);
        if (!gr.ok) { console.log(`gpuVerify: "${m.title}" replacement grab failed (HTTP ${gr.status}) — leaving file in place`); metrics.emitEvent('swap_fail', { ti: m.title, status: gr.status }); continue; }
        // ZERO-GAP: the old file is NOT touched now. Register the pending swap — Phase 1
        // removes the old copy only after the replacement finishes downloading (and nobody
        // is watching). The Downloads UI labels this download as an auto-upgrade.
        gpuPending.set(m.id, { oldHashes, ts: now, title: m.title, tmdbId: m.tmdbId });
        persistState();
        console.log(`gpuVerify: "${m.title}" is ${label} (file score ${fileScore}) — grabbed better H.264 "${(best.title || '').slice(0, 60)}" (score ${best.customFormatScore}, ${best.seeders} seeds); old copy stays until it completes`);
        metrics.emitEvent('swap_start', { ti: m.title, label, oldScore: fileScore, newScore: best.customFormatScore, seeds: best.seeders });
      } catch (e) { console.log(`gpuVerify: failed for "${m.title}" — ${e.message || e}`); }
    }
  } finally { gpuVerifyBusy = false; }
}

function startGpuVerify() {
setInterval(gpuVerifySweep, 900000); // every 15 min (was 10min); well within the 48h swap window; per-cycle cap + once-per-movie guard bound the work
setTimeout(gpuVerifySweep, 60000);
}

module.exports = { gpuVerifySweep, startGpuVerify };
