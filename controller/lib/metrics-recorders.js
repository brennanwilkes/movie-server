'use strict';
// Metrics recording glue over metrics.js: system/disk/dl-summary samples and
// service up/down probes (staggered so CPU readings aren't contaminated by
// probe load), plus the /api/metrics query route. Owns: _lastServiceStates.
// Timers: startRecorders() → system at 2s then every 10s; services at 7s then
// every 30s.

const fs = require('fs');
const app = require('./app');
const metrics = require('../metrics');
const { HOST } = require('./config');
const { tfetch } = require('./clients');
const { getCpuPct, readMemPct, readTempC } = require('./system-stats');
const { STATUS_SERVICES } = require('./routes-system');
const { getDl } = require('./downloads');

// ── Metrics: system + disk + dl summary (no HTTP — lightweight) ──
// Sampled independently from service probes so CPU/temp readings aren't
// contaminated by the sweep's own HTTP load. First stab at 2s, offset
// from service probes by 5s.
function recordSystemMetrics() {
  metrics.recordSystem(getCpuPct(), readMemPct(), readTempC());
  try {
    const s = fs.statfsSync('/data');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    metrics.recordDisk(Math.round(total / (1024*1024*1024)), Math.round(used / (1024*1024*1024)), Math.round(free / (1024*1024*1024)), pct);
  } catch { /* disk check failed */ }
  if (getDl().summary) metrics.recordDlSummary(getDl().summary);
}
// ── Metrics: service uptime (HTTP probes, 5s STAGGERED from system) ──
// CPU readings are taken 5s apart from HTTP probes, so the metrics
// reflect real system load, not the cost of collecting them.
let _lastServiceStates = {};
async function recordServiceMetrics() {
  const curStates = {};
  for (const s of STATUS_SERVICES) {
    let up = false;
    try { const r = await tfetch(s.url, { headers: s.headers ? s.headers() : {} }, 4000); up = true; } catch { /* down */ }
    curStates[s.id] = up;
  }
  try { await tfetch(`${HOST.jellyfin}/System/Info`, {}, 4000); curStates.jellyfin = true; } catch { curStates.jellyfin = false; }
  try { await tfetch(`${HOST.jellyseerr}/api/v1/status`, {}, 4000); curStates.jellyseerr = true; } catch { curStates.jellyseerr = false; }
  metrics.recordServices(curStates);
  for (const [id, up] of Object.entries(curStates)) {
    const prev = _lastServiceStates[id];
    if (prev !== undefined && prev !== up) {
      metrics.emitEvent(up ? 'svc_up' : 'svc_down', { svc: id });
    }
  }
  _lastServiceStates = curStates;
}
// Metrics query endpoint
app.get('/api/metrics', (req, res) => {
  const stream = req.query.stream;
  if (!stream) return res.json({ streams: metrics.listStreams() });
  const from = Number(req.query.from) || 0;
  const to = Number(req.query.to) || Infinity;
  const limit = Math.min(Number(req.query.limit) || 10000, 50000);
  const data = metrics.queryMetrics(stream, { from, to, limit });
  const info = metrics.listStreams()[stream] || {};
  res.json({ stream, data, info, count: data.length });
});

function startRecorders() {
// Fire at 2s, then every 10s via a chained setInterval so the first
// callback and all subsequent repeats keep a consistent offset.
setTimeout(() => { recordSystemMetrics(); setInterval(recordSystemMetrics, 10000); }, 2000);
// Fire at 7s (5s after system first fire), then every 10s.
setTimeout(() => { recordServiceMetrics(); setInterval(recordServiceMetrics, 30000); }, 7000);   // 30s (was 10s): service up/down is meaningful at 30s; cuts Jellyfin auth-challenge frequency ~67%
}

module.exports = { startRecorders };
