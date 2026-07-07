'use strict';
// Time-series metrics + event log — zero-dependency JSONL writer/reader.
// One file per day per stream in /config/metrics/<stream>/YYYY-MM-DD.jsonl.
// Append-only; rotate by day; queryable via /api/metrics or jq/duckdb directly.

const fs = require('fs');
const path = require('path');

const METRICS_DIR = '/config/metrics';

// ── Helpers ──

function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function streamDir(stream) { return path.join(METRICS_DIR, stream); }

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ } }

const _shortName = { qbittorrent: 'qb', radarr: 'ra', sonarr: 'so', prowlarr: 'pr', bazarr: 'ba', jellyfin: 'jf', jellyseerr: 'js' };

// ── Writes ──

function appendLine(stream, obj) {
  obj.t = Math.floor(Date.now() / 1000);
  const dir = streamDir(stream);
  ensureDir(dir);
  const file = path.join(dir, `${dateStr(new Date())}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function recordSystem(cpu, mem, temp) {
  appendLine('system', { cpu, mem, temp });
}

function recordDisk(totalGb, usedGb, freeGb, pct) {
  appendLine('disk', { uGb: usedGb, fGb: freeGb, tGb: totalGb, pct });
}

function recordServices(services) {
  const s = {};
  for (const [k, v] of Object.entries(services)) {
    const short = _shortName[k];
    if (short) s[short] = v ? 1 : 0;
  }
  appendLine('services', s);
}

function recordDlSummary(summary) {
  if (!summary || !summary.counts) return;
  appendLine('dl', {
    dl: summary.counts.inProgress || 0,
    im: summary.counts.attention || 0,
    rd: summary.counts.completed || 0,
    st: summary.counts.blocked || 0,
    dq: summary.counts.queued || 0,
    spB: summary.speedBytes || 0,
    eta: summary.etaSeconds,
    rGb: summary.remainingBytes ? Math.round(summary.remainingBytes / (1024 * 1024 * 1024) * 100) / 100 : 0,
  });
}

function emitEvent(type, data) {
  const line = { e: type };
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) line[k] = v;
  }
  appendLine('events', line);
}

// ── Reads ──

function queryMetrics(stream, opts = {}) {
  const { from = 0, to = Infinity, limit = 10000 } = opts;
  const dir = streamDir(stream);
  const results = [];

  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); }
  catch { return results; }

  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.t >= from && obj.t <= to) {
            results.push(obj);
            if (results.length >= limit) return results;
          }
        } catch { /* skip corrupt lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return results;
}

function listStreams() {
  const streams = {};
  try {
    for (const name of fs.readdirSync(METRICS_DIR)) {
      const dir = path.join(METRICS_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
      if (!files.length) continue;
      streams[name] = {
        files: files.length,
        first: files[0].replace('.jsonl', ''),
        last: files[files.length - 1].replace('.jsonl', ''),
      };
    }
  } catch { /* not created yet */ }
  return streams;
}

// ── Analysis helpers for CLI use ──

function stats(arr, field) {
  if (!arr.length) return {};
  const vals = arr.map(v => v[field]).filter(v => v != null);
  if (!vals.length) return {};
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length * 10) / 10,
    median: sorted[Math.floor(sorted.length / 2)],
    count: sorted.length,
  };
}

module.exports = { recordSystem, recordDisk, recordServices, recordDlSummary, emitEvent, queryMetrics, listStreams, stats };
