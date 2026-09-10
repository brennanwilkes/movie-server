'use strict';
// Durable fault log for the Fire Stick client (Movie Night fork).
//
// WHY: the client's worst bugs are intermittent — the splash "skipping" onto a half-built home
// screen happens roughly one launch in ten, and nothing was recording it. ACRA is installed in
// the app but POSTs to a crash-report URL that was never configured here and deletes the report
// either way, so app_ACRA-approved/ is empty and there is no history of any crash the device has
// ever had. ClientDiagnostics.kt buffers events on the stick and ships them here; this owns the
// receiving end and the read-back.
//
// Storage is /config (the controller's writable volume — ./data is mounted read-only) as JSONL,
// so it survives image rebuilds and can be tailed by hand. No timers.

const fs = require('fs');
const app = require('./app');

const LOG_PATH = '/config/tv-telemetry.jsonl';
// ~2 MB holds months of a handful of events per launch. Trimmed oldest-first rather than
// rotated: there is no value in an archive of superseded startup timings.
const MAX_BYTES = 2 * 1024 * 1024;
// One client POST is a launch's worth of buffered events, not a firehose. This only exists so a
// malformed or hostile body can't stream unbounded data into /config.
const MAX_BODY_BYTES = 512 * 1024;

// Reads the request body as text. Registered per-route rather than as global middleware because
// server.js installs express.json() for everything else and the client posts x-ndjson.
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function trimIfNeeded() {
  try {
    if (!fs.existsSync(LOG_PATH) || fs.statSync(LOG_PATH).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(LOG_PATH, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  } catch { /* a log that can't be trimmed is not worth failing a request over */ }
}

function readEvents() {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Ingest. The client retries the whole buffer until it gets a 200, so this must only succeed
// when the lines are actually on disk — an optimistic 200 would silently drop a launch's events.
app.post('/api/tv-telemetry', async (req, res) => {
  try {
    const body = await readBody(req);
    // Validate before appending so a garbled upload can't poison the log for the reader.
    // `received` is stamped server-side: the stick has no RTC and its clock can be wrong, but
    // its own `ts` is kept too so the ordering within one launch stays intact.
    const now = new Date().toISOString();
    const lines = body.split('\n').filter((l) => l.trim())
      .map((l) => { try { const o = JSON.parse(l); o.received = now; return JSON.stringify(o); } catch { return null; } })
      .filter(Boolean);
    if (lines.length) {
      fs.appendFileSync(LOG_PATH, lines.join('\n') + '\n');
      trimIfNeeded();
    }
    res.json({ ok: true, stored: lines.length });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Raw read-back, newest first. ?event= filters to one kind, ?limit= caps the count.
app.get('/api/tv-telemetry', (req, res) => {
  let events = readEvents().reverse();
  const kind = req.query && req.query.event;
  if (kind) events = events.filter((e) => e.event === kind);
  let limit = parseInt((req.query && req.query.limit) || 200, 10);
  if (!Number.isFinite(limit)) limit = 200;
  res.json({ total: events.length, events: events.slice(0, Math.max(1, Math.min(2000, limit))) });
});

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// The view that makes "come back in a week" worth doing: how often each fault fires and how the
// home build is actually behaving, rather than a wall of individual lines.
app.get('/api/tv-telemetry/summary', (req, res) => {
  const events = readEvents();
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;

  const builds = events.filter((e) => e.event === 'home_build' && e.data);
  const durations = builds.map((b) => b.data.totalMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const outcomes = {};
  const sources = {};
  for (const b of builds) {
    outcomes[b.data.outcome] = (outcomes[b.data.outcome] || 0) + 1;
    sources[b.data.collectionSource] = (sources[b.data.collectionSource] || 0) + 1;
  }

  // MEMORY BREADCRUMBS. `detail_rows_begin` and `playback_start` carry a PSS snapshot written
  // synchronously to disk BEFORE the expensive work, precisely so they survive the two failures
  // that leave nothing behind: a kernel foreground low-memory kill and a native SIGSEGV. Neither
  // runs a Java crash handler, so a `crash` event will never exist for them — instead the shape
  // to look for is a breadcrumb with a high pssKb followed by an `app_start` from a NEW session
  // with no crash in between. That gap IS the kill.
  //
  // Reported as the worst and most recent readings rather than a list: the question is always
  // "how close to the ~180 MB ceiling did it get, and on what", not the whole history.
  const mem = events.filter((e) => (e.event === 'detail_rows_begin' || e.event === 'playback_start')
    && e.data && typeof e.data.pssKb === 'number');
  const memPeak = mem.slice().sort((a, b) => b.data.pssKb - a.data.pssKb)[0] || null;
  const brief = (e) => e && {
    ts: e.received || e.ts, event: e.event, item: e.data.item, peopleN: e.data.peopleN,
    playMethod: e.data.playMethod, pssKb: e.data.pssKb, javaUsedKb: e.data.javaUsedKb,
    nativePssKb: e.data.nativePssKb, sysAvailKb: e.data.sysAvailKb, sysLowMemory: e.data.sysLowMemory,
  };

  res.json({
    total: events.length,
    firstSeen: events.length ? events[0].received || events[0].ts : null,
    lastSeen: events.length ? events[events.length - 1].received || events[events.length - 1].ts : null,
    counts,
    memory: {
      samples: mem.length,
      peak: brief(memPeak),
      latest: brief(mem[mem.length - 1]),
      pssKb: {
        p50: percentile(mem.map((e) => e.data.pssKb).sort((a, b) => a - b), 0.5),
        max: memPeak ? memPeak.data.pssKb : null,
      },
    },
    homeBuild: {
      samples: builds.length,
      outcomes,
      collectionSource: sources,
      // The splash-skip symptom: a build that lifted the splash onto a screen where nothing held
      // focus, leaving the D-pad dead.
      //
      // `splashUp` is what makes this number mean that. A home REBUILD (triggered by a
      // UserDataChanged socket message after playback) legitimately finds the grid unfocused —
      // the user is in the player or on a detail page — and those were being counted too, which
      // reported 4 faults in 29 builds on 2026-09-08 when the real count was zero. Clients
      // predating the field don't send it, so `unfocused` stays permissive for them and
      // `unfocusedAtSplash` is the number to read once the current build has been on the stick
      // for a day.
      unfocused: builds.filter((b) => b.data.focused === false).length,
      unfocusedAtSplash: builds.filter((b) => b.data.focused === false && b.data.splashUp === true).length,
      splashUpSamples: builds.filter((b) => b.data.splashUp === true).length,
      totalMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: durations[durations.length - 1] ?? null },
    },
    crashes: events.filter((e) => e.event === 'crash')
      .map((e) => ({ ts: e.received || e.ts, type: e.data && e.data.type, message: e.data && e.data.message })),
  });
});

module.exports = { LOG_PATH, readEvents };
