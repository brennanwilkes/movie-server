'use strict';
// Top 100 membership guard. Keeps the hand-ranked playlist from silently losing titles when a file
// is replaced.
//
// THE BUG THIS EXISTS FOR (Brennan, 2026-07-30 — 12 of 112 titles had already vanished):
// Jellyfin derives a movie's item Id from its FILE PATH. Every audit swap and every library re-pull
// renames the file, so Jellyfin retires the old item and mints a brand-new one with a different Id.
// A Jellyfin playlist stores raw item Ids, so the entry is left pointing at an item that no longer
// exists and Jellyfin prunes it. The title is still in the library, still perfect — just no longer
// in the Top 100. Nothing logged it, and the only reason it was caught is that the weekly export in
// top100-export.js recorded 112 items and the live playlist read 100.
//
// WHY UserData IS NOT HERE. Watch status was measured, not assumed, and it survives: on every
// swapped title LastPlayedDate PREDATES DateCreated (Casablanca created 07-31 00:04, last played
// 07-28 04:38, PlayCount 4). An item cannot be played before it exists, so Jellyfin keys UserData on
// the provider id already — Played/PlayCount/resume/favourites all ride through a swap untouched.
// Playlists are the one thing keyed on the bare item Id. Do not add a UserData store here; it would
// be a second source of truth for something that is already correct.
//
// THE FIX, per Brennan ("can we somehow use tmdb ids instead of file hashes?"): stop DEPENDING on
// the Jellyfin id rather than trying to hold it stable. We cannot change how Jellyfin mints ids, but
// we can keep our own membership record keyed on the TMDB id, which is stable across a rename, a
// re-import, and a full library rebuild. All 809 movies carry one, so the join is total.
//
// Owns: /config/top100-membership.json. Timers: startTop100GuardTimer() → hourly, first run at 5min.

const fs = require('fs/promises');
const path = require('path');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');

const STORE = '/config/top100-membership.json';
const SNAP_DIR = '/config/top100-snapshots';
const PLAYLIST_NAME = 'Top 100';

const key = (it) => {
  const p = it.ProviderIds || {};
  return p.Tmdb ? `tmdb:${p.Tmdb}` : (p.Imdb ? `imdb:${p.Imdb}` : null);
};

// ── reading live state ───────────────────────────────────────────────────────────────────────────
async function readPlaylist() {
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const pq = new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true', Limit: '200' });
  const pls = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 20000)).Items) || [];
  const pl = pls.find((p) => p.Name === PLAYLIST_NAME);
  if (!pl) return null;
  const iq = new URLSearchParams({ Limit: '500', Fields: 'ProviderIds,ProductionYear', userId: uid });
  const items = ((await tfetchJson(`${HOST.jellyfin}/Playlists/${pl.Id}/Items?${iq}`, { headers: h }, 20000)).Items) || [];
  return { uid, playlistId: pl.Id, items };
}

// One library-wide read rather than N per-title lookups: 809 movies come back in a single call, and
// the reconcile needs to resolve every missing title at once anyway.
async function movieIndex() {
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ IncludeItemTypes: 'Movie', Recursive: 'true', Fields: 'ProviderIds', Limit: '5000' });
  const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 30000)).Items) || [];
  const byKey = new Map();
  for (const it of items) {
    const p = it.ProviderIds || {};
    if (p.Tmdb) byKey.set(`tmdb:${p.Tmdb}`, it);
    if (p.Imdb) byKey.set(`imdb:${p.Imdb}`, it);   // so an Imdb-only store entry still resolves
  }
  return byKey;
}

// Does this Jellyfin id still exist? This is the DISCRIMINATOR that makes automatic restore safe:
//   - id gone   → the item was retired by a re-import, so the entry was ORPHANED → restore it.
//   - id alive  → the item is fine and Brennan took it out of the playlist on purpose → forget it.
// Without this, a guard that simply re-added anything missing would fight the user every hour.
async function idAlive(id) {
  if (!id) return false;
  try {
    const r = await tfetch(`${HOST.jellyfin}/Items/${id}`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 10000);
    return r.ok;
  } catch { return false; }
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────
// An ORDERED list, because order is how a returning title finds its way home: we re-insert it after
// the nearest preceding title that is still present. Storing an absolute rank instead would fight
// the Elo tuner, which legitimately reorders everything around it.
async function loadStore() {
  try {
    const d = JSON.parse(await fs.readFile(STORE, 'utf8'));
    return Array.isArray(d.items) ? d : { ts: 0, items: [] };
  } catch { return { ts: 0, items: [] }; }
}
async function saveStore(items) {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify({ ts: Date.now(), items }, null, 1), 'utf8');
}

// ── seeding from a TXT snapshot ──────────────────────────────────────────────────────────────────
// The 12 titles already lost predate the store, so the only record of them is the weekly export.
// Its columns are `rank <TAB> title (year) <TAB> imdb <TAB> jellyfinId`, and the Jellyfin id in it
// is the DEAD one — which is exactly the evidence idAlive() needs to prove the entry was orphaned
// rather than removed by hand.
function parseSnapshot(txt) {
  const out = [];
  for (const ln of String(txt).split('\n')) {
    if (!ln.trim() || ln.startsWith('#')) continue;
    const p = ln.split('\t');
    if (p.length < 4) continue;
    const imdb = p[2].trim();
    if (!imdb || imdb === '-') continue;
    out.push({ k: `imdb:${imdb}`, name: p[1].trim(), lastId: p[3].trim() });
  }
  return out;
}
async function newestSnapshot() {
  const files = (await fs.readdir(SNAP_DIR)).filter((f) => /^top100-\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
  if (!files.length) return null;
  const f = files[files.length - 1];
  return { file: f, entries: parseSnapshot(await fs.readFile(path.join(SNAP_DIR, f), 'utf8')) };
}
// Widest possible recovery: a title lost on 07-28 is absent from every snapshot after it, so the
// NEWEST file alone cannot see it. Merge oldest→newest, letting later files correct the order.
async function mergedSnapshots() {
  let files = [];
  try {
    files = (await fs.readdir(SNAP_DIR)).filter((f) => /^top100-\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
  } catch { return []; }
  const merged = [];
  const seen = new Set();
  for (const f of files) {
    const entries = parseSnapshot(await fs.readFile(path.join(SNAP_DIR, f), 'utf8'));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (seen.has(e.k)) continue;
      seen.add(e.k);
      // Insert after whichever earlier-listed neighbour we already know, so a title only present in
      // an old snapshot still lands next to the company it kept.
      let at = merged.length;
      for (let j = i - 1; j >= 0; j--) {
        const idx = merged.findIndex((m) => m.k === entries[j].k);
        if (idx >= 0) { at = idx + 1; break; }
      }
      merged.splice(at, 0, e);
    }
  }
  return merged;
}

// ── where does a returning title go? ─────────────────────────────────────────────────────────────
// PURE, and deliberately so: this is the one calculation that can corrupt the playlist, because the
// write is clear-then-re-add and a dropped id is gone for good. Kept free of network calls so it can
// be tested exhaustively (scripts/test-top100-order.js).
//
// The rule: never rearrange the live order — the Elo tuner owns that, and it has legitimately moved
// things since the record was taken. A returnee is spliced in directly after the nearest PRECEDING
// title from the record that is still present. Anchoring on a neighbour rather than an absolute rank
// is what lets a title come home to roughly the right place in a playlist that has since been
// reshuffled around it.
//   liveKeyed: [{ id, k }] in current playlist order   want: [{ k }] the recorded order
//   restore:   [{ k, newId }]                          → [{ id, k }] in the order to write
function planOrder(liveKeyed, want, restore) {
  const out = liveKeyed.filter((o) => o.k);
  const wantIdx = new Map(want.map((w, i) => [w.k, i]));
  // Restore in RECORDED order, so two titles that used to sit next to each other come back in
  // sequence instead of in whatever order the caller happened to collect them.
  const todo = restore.slice().sort((a, b) => (wantIdx.get(a.k) ?? Infinity) - (wantIdx.get(b.k) ?? Infinity));
  for (const r of todo) {
    const wi = wantIdx.has(r.k) ? wantIdx.get(r.k) : -1;
    // Unknown to the record → append. Guessing the front would promote a title into the top ranks,
    // which is the one mistake that actually matters in a hand-ranked list.
    let at = wi < 0 ? out.length : 0;
    for (let j = wi - 1; j >= 0; j--) {
      const idx = out.findIndex((o) => o.k === want[j].k);
      if (idx >= 0) { at = idx + 1; break; }
    }
    out.splice(at, 0, { id: r.newId, k: r.k });
  }
  return out;
}

// ── reconcile ────────────────────────────────────────────────────────────────────────────────────
// Returns a PLAN always; only writes when commit is true. Never throws on a missing playlist.
async function reconcile({ commit = false, useSnapshots = false } = {}) {
  if (!cfg.JELLYFIN_KEY) return { ok: false, reason: 'no jellyfin key' };
  const live = await readPlaylist();
  if (!live) return { ok: false, reason: 'no "Top 100" playlist' };

  // Never act on an empty read. A transient Jellyfin hiccup returning zero items would otherwise
  // look like "everything was orphaned" and trigger a 100-title rewrite. Same guard, same reason,
  // as top100-export.js refusing to overwrite a good snapshot with an empty one.
  if (!live.items.length) return { ok: false, reason: 'playlist read returned 0 items — refusing to act' };

  const lib = await movieIndex();
  // ONE canonical key per title before anything is compared. The store keys live items `tmdb:` (that
  // is what a Jellyfin item reports) while the TXT snapshots only ever recorded an Imdb id, so
  // without this every recovered title would look absent from the store and get added a second time.
  // Resolving both through the library's own ProviderIds is the only join that can't drift.
  const canon = (k) => {
    const it = lib.get(k);
    if (!it) return k;
    const p = it.ProviderIds || {};
    return p.Tmdb ? `tmdb:${p.Tmdb}` : (p.Imdb ? `imdb:${p.Imdb}` : k);
  };
  const withCanon = (arr) => arr.map((e) => ({ ...e, k: canon(e.k) }));

  const liveKeys = new Set(live.items.map(key).filter(Boolean).map(canon));
  const store = await loadStore();

  // The reference list of what membership SHOULD be: the store, plus snapshot history when asked.
  const dedupe = (arr) => { const s = new Set(); return arr.filter((e) => e.k && !s.has(e.k) && s.add(e.k)); };
  let want = dedupe(withCanon(store.items));
  if (useSnapshots) {
    const snap = dedupe(withCanon(await mergedSnapshots()));
    // Snapshot order is authoritative only when the store has never run; otherwise the store is the
    // more recent truth and snapshots contribute just the titles it never got to see.
    want = store.items.length ? dedupe([...want, ...snap]) : snap;
  }
  const missing = want.filter((w) => !liveKeys.has(w.k));
  const restore = [];
  const forget = [];
  const gone = [];
  for (const m of missing) {
    const cur = lib.get(m.k);
    if (!cur) { gone.push(m); continue; }                    // not in the library at all — nothing to restore
    if (await idAlive(m.lastId)) { forget.push(m); continue; } // item intact → deliberate removal
    restore.push({ ...m, newId: cur.Id, name: cur.Name || m.name });
  }

  const ordered = planOrder(live.items.map((it) => ({ id: it.Id, k: key(it) })), want, restore);
  const desired = ordered.map((o) => o.id);
  const nameOf = new Map([...live.items.map((it) => [it.Id, it.Name]), ...restore.map((r) => [r.newId, r.name])]);

  const plan = {
    ok: true,
    playlistId: live.playlistId,
    liveCount: live.items.length,
    restore: restore.map((r) => ({ key: r.k, name: r.name, deadId: r.lastId, newId: r.newId })),
    forget: forget.map((f) => ({ key: f.k, name: f.name })),
    gone: gone.map((g) => ({ key: g.k, name: g.name })),
    committed: false,
  };
  if (!commit) return plan;

  // ── the write ──────────────────────────────────────────────────────────────────────────────────
  // THE PLAYLIST IN JELLYFIN IS THE SOURCE OF TRUTH. The store never overrides it: planOrder cannot
  // reorder survivors, so an in-app reorder is always preserved, and a title removed by hand lands in
  // `forget` and is dropped rather than re-added. The store only remembers "this was a member, under
  // this id" so a DEAD id can prove orphaning. It is an audit log, not a second source of truth.
  //
  // THIS WRITE IS NOT ATOMIC and cannot be made so: Jellyfin's MoveItem 400s under API-key auth (see
  // routes-elo.js), so repositioning means DELETE-all then POST-all — two calls, with a window where
  // the playlist is empty. Since it cannot be atomic it is instead made RECOVERABLE and CHECKED:
  //   1. a pre-write backup on disk, so a crash mid-write always leaves the old order somewhere;
  //   2. compare-and-swap against a fresh read, so a concurrent in-app edit is never clobbered;
  //   3. a post-write verify with automatic rollback, so a partial add cannot pass silently.
  if (restore.length) {
    // Invariant check on the splice: every surviving entry plus every restored one, exactly once. A
    // logic error in the anchor walk could drop an id, and after a clear-then-add that entry is gone.
    if (desired.length !== plan.liveCount + restore.length || new Set(desired).size !== desired.length) {
      return { ...plan, ok: false, reason: `refusing to rewrite: built ${desired.length} ids (${new Set(desired).size} unique) for ${plan.liveCount}+${restore.length} expected` };
    }
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const readNow = async () => ((await tfetchJson(`${HOST.jellyfin}/Playlists/${live.playlistId}/Items?${new URLSearchParams({ UserId: live.uid, Limit: '500' })}`, { headers: h }, 15000)).Items) || [];

    // (2) COMPARE-AND-SWAP. The plan was built from a read taken seconds ago; if Brennan reordered or
    // edited the playlist in the meantime, writing the plan would silently discard his change. Bail
    // instead — the next hourly tick re-plans against whatever he left behind. A missed restore costs
    // one more hour; a clobbered hand-reorder is unrecoverable.
    const cur = await readNow();
    const before = cur.map((it) => it.Id);
    if (before.join(',') !== live.items.map((it) => it.Id).join(',')) {
      return { ...plan, ok: false, reason: 'playlist changed while the plan was being built — skipped, will retry next tick' };
    }

    // (1) PRE-WRITE BACKUP, on disk, before anything is destroyed. This is the artifact that makes a
    // crash between DELETE and POST survivable.
    await fs.mkdir(SNAP_DIR, { recursive: true }).catch(() => {});
    const bak = path.join(SNAP_DIR, 'pre-rewrite-backup.txt');
    await fs.writeFile(bak, `# pre-rewrite backup — ${new Date().toISOString()}\n# ${before.length} ids, playlist ${live.playlistId}\n${before.join('\n')}\n`, 'utf8');

    const entryIds = cur.map((it) => it.PlaylistItemId).filter(Boolean);
    if (entryIds.length) {
      const del = await tfetch(`${HOST.jellyfin}/Playlists/${live.playlistId}/Items?${new URLSearchParams({ entryIds: entryIds.join(',') })}`, { method: 'DELETE', headers: h }, 20000);
      if (!del.ok) return { ...plan, ok: false, reason: `clearing playlist failed: HTTP ${del.status} — nothing was changed` };
    }
    const add = await tfetch(`${HOST.jellyfin}/Playlists/${live.playlistId}/Items?${new URLSearchParams({ ids: desired.join(','), userId: live.uid })}`, { method: 'POST', headers: h }, 30000);

    // (3) POST-WRITE VERIFY + ROLLBACK. Trusting HTTP 200 is not enough — a truncated add still
    // returns 200. Confirm the playlist really holds what was planned, and if it does not, put the
    // ORIGINAL ids back immediately rather than leaving a mangled list behind.
    const after = await readNow().catch(() => []);
    const okNow = add.ok && after.length === desired.length && after.map((it) => it.Id).join(',') === desired.join(',');
    if (!okNow) {
      console.log(`top100Guard: rewrite verify FAILED (wanted ${desired.length}, got ${after.length}) — rolling back to the ${before.length} ids in ${bak}`);
      const undoEntries = after.map((it) => it.PlaylistItemId).filter(Boolean);
      if (undoEntries.length) await tfetch(`${HOST.jellyfin}/Playlists/${live.playlistId}/Items?${new URLSearchParams({ entryIds: undoEntries.join(',') })}`, { method: 'DELETE', headers: h }, 20000).catch(() => {});
      const undo = await tfetch(`${HOST.jellyfin}/Playlists/${live.playlistId}/Items?${new URLSearchParams({ ids: before.join(','), userId: live.uid })}`, { method: 'POST', headers: h }, 30000).catch(() => null);
      const rolled = undo && undo.ok;
      return { ...plan, ok: false, rolledBack: !!rolled, backup: bak,
        reason: rolled ? 'rewrite failed verification — playlist rolled back to its previous state, nothing lost'
          : `rewrite failed AND rollback failed — restore the ids in ${bak} by hand` };
    }
    console.log(`top100Guard: restored ${restore.length} orphaned title(s): ${restore.map((r) => r.name).join(', ')}`);
  }

  // Persist the new truth, from the ORDER WE JUST WROTE — not from the pre-restore read, which no
  // longer describes the playlist. Entries carry the CURRENT id so the next tick's idAlive() check is
  // asking about the item that is really in there. Titles in `forget` fall out here by construction,
  // which is how a deliberate removal stops being re-added.
  const next = ordered.map((o, i) => ({ k: o.k, name: nameOf.get(o.id) || null, lastId: o.id, rank: i + 1 }));
  await saveStore(next);
  return { ...plan, committed: true, restored: restore.length, stored: next.length };
}

// Observe-only: refresh the store from live state without changing Jellyfin. This is what makes the
// guard work at all — it has to have seen a title in the playlist while its id was still valid.
async function observe() {
  const live = await readPlaylist();
  if (!live || !live.items.length) return { ok: false, reason: 'empty read' };
  await saveStore(live.items.map((it, i) => ({ k: key(it), name: it.Name, lastId: it.Id, rank: i + 1 })).filter((x) => x.k));
  return { ok: true, stored: live.items.length };
}

async function guardSweep() {
  if (isMasterPaused()) return;
  try {
    const r = await reconcile({ commit: true });
    if (!r.ok) { console.log(`top100Guard: ${r.reason}`); return; }
    if (r.restored) console.log(`top100Guard: playlist now ${r.stored} items`);
    for (const f of r.forget) console.log(`top100Guard: "${f.name}" left the playlist but its item is intact — treating as a deliberate removal`);
    for (const g of r.gone) console.log(`top100Guard: "${g.name}" is in the playlist record but no longer in the library — cannot restore`);
  } catch (e) { console.log(`top100Guard: failed — ${e.message || e}`); }
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────
// dryRun is the DEFAULT here, the opposite of most endpoints, and on purpose: the commit path
// rewrites the hand-ranked Top 100. You have to ask for that explicitly.
//   GET  /api/top100/reconcile              → what would change (reads only)
//   POST /api/top100/reconcile?commit=1     → do it
//   &snapshots=1                            → also consider titles only the weekly TXT exports know
//                                             about, i.e. the ones lost before the store existed
const app = require('./app');
const handler = (commitAllowed) => async (req, res) => {
  try {
    const q = { ...req.query, ...(req.body || {}) };
    const commit = commitAllowed && (q.commit === '1' || q.commit === true || q.commit === 'true');
    const r = await reconcile({ commit, useSnapshots: q.snapshots === '1' || q.snapshots === true || q.snapshots === 'true' });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
};
app.get('/api/top100/reconcile', handler(false));
app.post('/api/top100/reconcile', handler(true));

function startTop100GuardTimer() {
  setInterval(guardSweep, 3600000);        // hourly: swaps finalise on their own schedule
  setTimeout(guardSweep, 300000);          // and once 5 min after boot, past the initial scan storm
}

module.exports = { reconcile, observe, guardSweep, startTop100GuardTimer, planOrder, parseSnapshot, mergedSnapshots };
