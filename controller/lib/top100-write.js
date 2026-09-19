'use strict';
// The ONE protected way to rewrite the "Top 100" playlist. Every caller that reorders or repairs
// the playlist goes through safeRewrite() — top100-guard.js (automatic repair) and routes-elo.js
// (the Elo tuner's save).
//
// WHY THIS EXISTS (Brennan, 2026-08-09 — the playlist was found EMPTY, all 116 titles gone):
// Jellyfin's MoveItem 400s under API-key auth (see routes-elo.js), so "reorder" can only be
// expressed as DELETE-all-then-POST-all. That is two calls with a window in between where the
// playlist is empty, and it CANNOT be made atomic against Jellyfin's API. top100-guard.js had
// already worked this out and wrapped its own write in backup + compare-and-swap + verify/rollback.
// The Elo tuner's reorder route had none of that: a failed POST after a successful DELETE left the
// playlist empty, permanently, with no backup and — because the route logged nothing on failure —
// no trace of what happened. The hand-ranked order is the irreplaceable artifact here; losing it to
// a half-finished write is the worst outcome this codebase can produce.
//
// The fix is not to make the guard's protections a guard-specific detail. It is to make the unsafe
// write UNAVAILABLE: there is no exported helper here that clears the playlist without first taking
// a backup and afterwards verifying what landed.
//
// The five protections, in order of application:
//   0. SCAN GATE      — refuse while Jellyfin is scanning. A scan re-mints item ids for any file
//                       that was renamed (every audit swap renames one), so ids captured seconds
//                       ago can be dead by the time we POST them. Fails CLOSED.
//   1. NO-DROP        — every id currently in the playlist must appear in the new order. A rewrite
//                       may reorder or ADD; it may never silently remove. This is what turns a
//                       stale client into a refusal instead of a shrunken playlist.
//   2. BACKUP         — the pre-write id list on disk, timestamped and ROLLING, before anything is
//                       destroyed. Survives a crash between the DELETE and the POST.
//   3. COMPARE-SWAP   — re-read immediately before writing; bail if it no longer matches what the
//                       caller planned against, so a concurrent edit is never clobbered.
//   4. VERIFY+ROLLBACK— confirm the playlist really holds what was planned (HTTP 200 on a truncated
//                       add is not proof), and put the original ids back if it does not.

const fs = require('fs/promises');
const path = require('path');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { isLibraryScanRunning } = require('./jf-scan');

// Overridable only so the test harness can point it at a tmpdir; production never sets it.
const SNAP_DIR = process.env.TOP100_SNAP_DIR || '/config/top100-snapshots';
// Rolling backups. The old code kept ONE file, pre-rewrite-backup.txt, overwritten by every run —
// so the hourly guard destroyed the evidence of a bad write within the hour. Keep a window instead.
const BACKUP_KEEP = 30;

const hdrs = () => ({ Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"` });

// A playlist read is the input to every decision here, so it gets an explicit Limit: Jellyfin's
// default page size is smaller than the list, and a silently truncated read would look like
// "someone deleted the tail" to the no-drop check.
async function readPlaylistItems(playlistId, uid) {
  const q = new URLSearchParams({ UserId: uid, userId: uid, Limit: '500' });
  return ((await tfetchJson(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${q}`, { headers: hdrs() }, 20000)).Items) || [];
}

async function writeBackup(tag, playlistId, ids) {
  await fs.mkdir(SNAP_DIR, { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SNAP_DIR, `pre-rewrite-${tag}-${stamp}.txt`);
  await fs.writeFile(file,
    `# pre-rewrite backup — ${new Date().toISOString()}\n# caller: ${tag}\n`
    + `# ${ids.length} ids, playlist ${playlistId}\n${ids.join('\n')}\n`, 'utf8');
  // Prune oldest, newest-first by name (the ISO stamp sorts lexically).
  try {
    const all = (await fs.readdir(SNAP_DIR)).filter((f) => f.startsWith('pre-rewrite-')).sort().reverse();
    for (const f of all.slice(BACKUP_KEEP)) await fs.unlink(path.join(SNAP_DIR, f)).catch(() => {});
  } catch { /* pruning is best-effort; never fail a write over housekeeping */ }
  return file;
}

// ── the only write path ──────────────────────────────────────────────────────────────────────────
// playlistId, uid  — what to write to, as whom
// desired          — the full id list to end up with, in order
// expectBefore     — ids the caller planned against (compare-and-swap). Optional but expected.
// tag              — who is writing, for the log line and the backup filename
// Returns { ok, reason?, backup?, wrote?, rolledBack? }. NEVER throws for an expected condition;
// a caller can surface `reason` straight to the UI.
async function safeRewrite({ playlistId, uid, desired, expectBefore = null, tag = 'unknown' }) {
  if (!cfg.JELLYFIN_KEY) return { ok: false, reason: 'no jellyfin key' };
  if (!playlistId || !uid) return { ok: false, reason: 'playlistId and uid required' };
  if (!Array.isArray(desired) || !desired.length) return { ok: false, reason: 'refusing to write an empty playlist' };
  if (new Set(desired).size !== desired.length) return { ok: false, reason: 'refusing to write: duplicate ids in the new order' };

  // (0) SCAN GATE. isLibraryScanRunning fails closed, so an unreachable Jellyfin also blocks the
  // write — correct here: if we cannot tell whether ids are being re-minted, do not destroy a list.
  if (await isLibraryScanRunning()) {
    return { ok: false, reason: 'a Jellyfin library scan is running — item ids are unstable mid-scan, try again once it finishes' };
  }

  const before = (await readPlaylistItems(playlistId, uid).catch(() => null));
  if (!before) return { ok: false, reason: 'could not read the playlist — nothing was changed' };
  const beforeIds = before.map((it) => it.Id);

  // Never rewrite from an empty read. A transient hiccup returning zero items would otherwise look
  // like "the playlist is empty, write whatever you like" — the same refusal top100-guard.js makes.
  if (!beforeIds.length) return { ok: false, reason: 'playlist read returned 0 items — refusing to act' };

  // (1) NO-DROP. A rewrite reorders and may add; it may never drop. This is the check that turns a
  // stale Elo-tuner tab (holding ids Jellyfin re-minted after an audit swap) into an honest refusal
  // rather than a playlist quietly shrunk to whatever the two lists still had in common.
  const want = new Set(desired);
  const dropped = beforeIds.filter((id) => !want.has(id));
  if (dropped.length) {
    return { ok: false, dropped: dropped.length,
      reason: `refusing to write: ${dropped.length} title(s) currently in the playlist are missing from the new order` };
  }

  // (3) COMPARE-AND-SWAP against what the caller planned on.
  if (expectBefore && expectBefore.join(',') !== beforeIds.join(',')) {
    return { ok: false, stale: true,
      reason: 'the playlist changed since this was planned — nothing was written, reload and try again' };
  }

  // (2) BACKUP, before anything is destroyed. If the backup cannot be written, DO NOT WRITE. The
  // backup is the thing that makes a failed rewrite survivable, so proceeding without one trades a
  // delayed reorder for a possible unrecoverable loss — never the right trade for a hand-ranked list.
  let backup;
  try {
    backup = await writeBackup(tag, playlistId, beforeIds);
  } catch (e) {
    console.log(`top100Write[${tag}]: REFUSED — could not write the pre-write backup: ${e.message || e}`);
    return { ok: false, reason: `could not write the pre-write backup (${e.message || e}) — refusing to rewrite without one` };
  }

  const entryIds = before.map((it) => it.PlaylistItemId).filter(Boolean);
  if (entryIds.length) {
    const del = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ entryIds: entryIds.join(',') })}`,
      { method: 'DELETE', headers: hdrs() }, 20000).catch(() => null);
    if (!del || !del.ok) {
      return { ok: false, backup, reason: `clearing the playlist failed${del ? ` (HTTP ${del.status})` : ''} — nothing was changed` };
    }
  }

  const add = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ ids: desired.join(','), userId: uid })}`,
    { method: 'POST', headers: hdrs() }, 30000).catch(() => null);

  // (4) VERIFY. HTTP 200 on a truncated add is not proof; read it back and compare exactly.
  const after = await readPlaylistItems(playlistId, uid).catch(() => []);
  const afterIds = after.map((it) => it.Id);
  if (add && add.ok && afterIds.join(',') === desired.join(',')) {
    console.log(`top100Write[${tag}]: rewrote ${desired.length} items (was ${beforeIds.length}) — verified`);
    return { ok: true, wrote: desired.length, was: beforeIds.length, backup };
  }

  // ROLLBACK. Put the original ids back rather than leave a mangled or empty list behind.
  console.log(`top100Write[${tag}]: verify FAILED (wanted ${desired.length}, got ${afterIds.length}`
    + `${add ? `, add HTTP ${add.status}` : ', add threw'}) — rolling back to the ${beforeIds.length} ids in ${backup}`);
  const undoEntries = after.map((it) => it.PlaylistItemId).filter(Boolean);
  if (undoEntries.length) {
    await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ entryIds: undoEntries.join(',') })}`,
      { method: 'DELETE', headers: hdrs() }, 20000).catch(() => {});
  }
  const undo = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ ids: beforeIds.join(','), userId: uid })}`,
    { method: 'POST', headers: hdrs() }, 30000).catch(() => null);
  const back = await readPlaylistItems(playlistId, uid).catch(() => []);
  const rolled = !!(undo && undo.ok) && back.map((it) => it.Id).join(',') === beforeIds.join(',');
  console.log(`top100Write[${tag}]: rollback ${rolled ? 'OK — playlist is back to its previous state' : `FAILED — restore the ids in ${backup} by hand`}`);
  return { ok: false, rolledBack: rolled, backup,
    reason: rolled
      ? 'the write failed verification — the playlist was rolled back to its previous state, nothing lost'
      : `the write failed AND the rollback failed — restore the ids in ${backup} by hand` };
}

module.exports = { safeRewrite, readPlaylistItems, SNAP_DIR };
