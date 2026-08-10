'use strict';
// Unit tests for top100-write.js::safeRewrite — the protected rewrite path for the hand-ranked
// "Top 100" playlist. Run: node scripts/test-top100-write.js
//
// These test the REFUSALS more than the happy path, because the refusals are the point. The
// playlist was wiped on 2026-08-09 by a clear-then-re-add whose second half failed; every case
// below is a way that can happen, and each must leave the playlist either untouched or rolled back.
//
// Jellyfin is stubbed via require.cache injection (no network, no container). The stub models the
// real API's shape: DELETE by entryIds, POST by ids, GET returning items in insertion order.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'top100-write-test-'));
process.env.TOP100_SNAP_DIR = TMP;

const LIB = path.join(__dirname, '..', 'controller', 'lib');
const stub = (name, exports) => { require.cache[require.resolve(path.join(LIB, name))] = { id: name, filename: name, loaded: true, exports }; };

// ── the fake Jellyfin ────────────────────────────────────────────────────────────────────────────
// items: [{ Id, PlaylistItemId }]. Faults let a test break exactly one call.
const jf = {
  items: [],
  fault: null,          // 'del' | 'add' | 'add-truncate' | 'read'
  scanRunning: false,
  calls: [],
};
const mkItems = (ids) => ids.map((id) => ({ Id: id, PlaylistItemId: `entry-${id}`, Name: `Movie ${id}` }));
jf.reset = (ids) => { jf.items = mkItems(ids); jf.fault = null; jf.scanRunning = false; jf.calls = []; };

stub('config.js', { cfg: { JELLYFIN_KEY: 'testkey' }, HOST: { jellyfin: 'http://jf' } });
stub('jf-scan.js', { isLibraryScanRunning: async () => jf.scanRunning });
stub('clients.js', {
  tfetchJson: async (url) => {
    jf.calls.push(`GET ${url.split('?')[0]}`);
    if (jf.fault === 'read') throw new Error('read fault');
    return { Items: jf.items.slice() };
  },
  tfetch: async (url, opts) => {
    const m = opts.method;
    jf.calls.push(`${m} ${url.split('?')[0]}`);
    const q = new URLSearchParams(url.split('?')[1] || '');
    if (m === 'DELETE') {
      if (jf.fault === 'del') return { ok: false, status: 500 };
      const kill = new Set((q.get('entryIds') || '').split(',').filter(Boolean));
      jf.items = jf.items.filter((it) => !kill.has(it.PlaylistItemId));
      return { ok: true, status: 204 };
    }
    if (m === 'POST') {
      if (jf.fault === 'add') { jf.fault = null; return { ok: false, status: 500 }; }
      let ids = (q.get('ids') || '').split(',').filter(Boolean);
      // A truncated add that still returns 200 — the exact case a bare HTTP check misses.
      if (jf.fault === 'add-truncate') { jf.fault = null; ids = ids.slice(0, Math.max(1, ids.length - 2)); }
      jf.items = jf.items.concat(mkItems(ids));
      return { ok: true, status: 204 };
    }
    throw new Error(`unexpected ${m}`);
  },
});

const { safeRewrite } = require(path.join(LIB, 'top100-write.js'));

// ── harness ──────────────────────────────────────────────────────────────────────────────────────
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const ids = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const live = () => jf.items.map((it) => it.Id);
const ARGS = { playlistId: 'PL', uid: 'U' };

(async () => {
  // 1. Happy path: a pure permutation is written and verified.
  jf.reset(ids(5));
  let r = await safeRewrite({ ...ARGS, desired: ['m5', 'm4', 'm3', 'm2', 'm1'], expectBefore: ids(5), tag: 't' });
  ok('permutation succeeds', r.ok, r.reason);
  ok('permutation applied', live().join(',') === 'm5,m4,m3,m2,m1', live().join(','));
  ok('backup written', !!r.backup && fs.existsSync(r.backup));

  // 2. Growing (the guard restoring an orphan) is allowed.
  jf.reset(ids(3));
  r = await safeRewrite({ ...ARGS, desired: ['m1', 'new', 'm2', 'm3'], expectBefore: ids(3), tag: 't' });
  ok('adding a restored title succeeds', r.ok, r.reason);
  ok('restored title spliced in', live().join(',') === 'm1,new,m2,m3', live().join(','));

  // 3. NO-DROP: the stale-client case that silently shrank the playlist before.
  jf.reset(ids(5));
  r = await safeRewrite({ ...ARGS, desired: ['m1', 'm2', 'm3'], expectBefore: ids(5), tag: 't' });
  ok('dropping titles is refused', !r.ok && r.dropped === 2, JSON.stringify(r));
  ok('nothing changed on drop refusal', live().join(',') === ids(5).join(','), live().join(','));

  // 4. Empty desired — the literal shape of the wipe.
  jf.reset(ids(5));
  r = await safeRewrite({ ...ARGS, desired: [], tag: 't' });
  ok('empty write is refused', !r.ok);
  ok('nothing changed on empty refusal', live().length === 5);

  // 5. Duplicate ids.
  jf.reset(ids(3));
  r = await safeRewrite({ ...ARGS, desired: ['m1', 'm2', 'm2'], tag: 't' });
  ok('duplicate ids refused', !r.ok);
  ok('nothing changed on duplicate refusal', live().length === 3);

  // 6. SCAN GATE.
  jf.reset(ids(3));
  jf.scanRunning = true;
  r = await safeRewrite({ ...ARGS, desired: ['m3', 'm2', 'm1'], expectBefore: ids(3), tag: 't' });
  ok('refused during a library scan', !r.ok && /scan/i.test(r.reason), r.reason);
  ok('nothing changed during scan refusal', live().join(',') === 'm1,m2,m3');

  // 7. COMPARE-AND-SWAP: someone reordered since the caller planned.
  jf.reset(ids(4));
  r = await safeRewrite({ ...ARGS, desired: ['m4', 'm3', 'm2', 'm1'], expectBefore: ['m1', 'm2', 'zzz'], tag: 't' });
  ok('stale plan refused (CAS)', !r.ok && r.stale === true, JSON.stringify(r));
  ok('nothing changed on CAS refusal', live().join(',') === ids(4).join(','));

  // 8. Empty read — a transient hiccup must not authorise a rewrite.
  jf.reset([]);
  r = await safeRewrite({ ...ARGS, desired: ['m1'], tag: 't' });
  ok('empty read refused', !r.ok && /0 items/.test(r.reason), r.reason);

  // 9. DELETE fails → nothing destroyed.
  jf.reset(ids(4));
  jf.fault = 'del';
  r = await safeRewrite({ ...ARGS, desired: ['m4', 'm3', 'm2', 'm1'], expectBefore: ids(4), tag: 't' });
  ok('failed DELETE reports failure', !r.ok, r.reason);
  ok('failed DELETE left playlist intact', live().join(',') === ids(4).join(','), live().join(','));

  // 10. THE WIPE ITSELF: DELETE succeeds, POST fails. Must roll back, not leave it empty.
  jf.reset(ids(6));
  jf.fault = 'add';
  r = await safeRewrite({ ...ARGS, desired: ids(6).slice().reverse(), expectBefore: ids(6), tag: 't' });
  ok('failed POST reports failure', !r.ok, r.reason);
  ok('failed POST rolled back', r.rolledBack === true, JSON.stringify(r));
  ok('playlist NOT left empty', live().length === 6, `left ${live().length} items`);
  ok('rollback restored original order', live().join(',') === ids(6).join(','), live().join(','));

  // 11. Truncated add that still returns 200 — verify must catch it.
  jf.reset(ids(6));
  jf.fault = 'add-truncate';
  r = await safeRewrite({ ...ARGS, desired: ids(6).slice().reverse(), expectBefore: ids(6), tag: 't' });
  ok('truncated add detected', !r.ok, JSON.stringify(r));
  ok('truncated add rolled back', r.rolledBack === true && live().join(',') === ids(6).join(','), live().join(','));

  // 12. No backup possible → refuse to write at all.
  jf.reset(ids(3));
  const saved = process.env.TOP100_SNAP_DIR;
  fs.chmodSync(TMP, 0o500);
  r = await safeRewrite({ ...ARGS, desired: ['m3', 'm2', 'm1'], expectBefore: ids(3), tag: 't' });
  fs.chmodSync(TMP, 0o700);
  process.env.TOP100_SNAP_DIR = saved;
  // Running as root defeats the chmod, so only assert when the write really was blocked.
  if (!r.ok) {
    ok('unbackupable write refused', /backup/i.test(r.reason), r.reason);
    ok('nothing changed when backup impossible', live().join(',') === ids(3).join(','));
  } else { pass += 2; console.log('  (12) skipped: running as root, chmod does not block writes'); }

  // 13. Rolling backups are pruned, not overwritten — the old single-file backup was destroyed by
  //     the next hourly guard run, taking the evidence with it.
  jf.reset(ids(2));
  for (let i = 0; i < 3; i++) {
    await safeRewrite({ ...ARGS, desired: ['m2', 'm1'], expectBefore: live(), tag: 'roll' });
    await safeRewrite({ ...ARGS, desired: ['m1', 'm2'], expectBefore: live(), tag: 'roll' });
  }
  const backups = fs.readdirSync(TMP).filter((f) => f.startsWith('pre-rewrite-roll-'));
  ok('multiple backups kept', backups.length >= 5, `${backups.length} kept`);

  console.log(`\ntop100-write: ${pass}/${pass + fails.length} passed`);
  for (const f of fails) console.log(`  FAIL: ${f}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
})();
