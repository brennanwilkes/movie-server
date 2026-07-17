'use strict';
// NUC host stats sampled from the container (which sees the host /proc and
// /sys): rolling CPU%, RAM%, CPU temperature. Owns: _cpuPrev/_cpuPct sample
// state. Timers: startCpuSampling() → immediate sample + every 3s.

const fs = require('fs');

// ── NUC host stats (CPU% / RAM% / CPU temperature) ──
// In a container /proc and /sys still reflect the HOST, so these read the NUC itself.
// CPU% is sampled on a rolling interval (a single reading can't yield a rate).
let _cpuPrev = null, _cpuPct = null;
function readCpuTimes() {
  try {
    const t = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { idle: (t[3] || 0) + (t[4] || 0), total: t.reduce((a, b) => a + (b || 0), 0) }; // idle = idle + iowait
  } catch { return null; }
}
function sampleCpu() {
  const cur = readCpuTimes();
  if (cur && _cpuPrev) {
    const dt = cur.total - _cpuPrev.total, di = cur.idle - _cpuPrev.idle;
    if (dt > 0) _cpuPct = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  }
  if (cur) _cpuPrev = cur;
}
function readMemPct() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => { const x = m.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return x ? Number(x[1]) : null; };
    const total = g('MemTotal'), avail = g('MemAvailable');
    return (total && avail != null) ? Math.round((1 - avail / total) * 100) : null;
  } catch { return null; }
}
// Prefer the CPU package sensor; else the hottest real zone (ignore the wifi radio).
function readTempC() {
  try {
    const base = '/sys/class/thermal';
    let pkg = null, best = null;
    for (const z of fs.readdirSync(base).filter((z) => z.startsWith('thermal_zone'))) {
      let type = '', milli = NaN;
      try { type = fs.readFileSync(`${base}/${z}/type`, 'utf8').trim(); } catch { /* */ }
      try { milli = Number(fs.readFileSync(`${base}/${z}/temp`, 'utf8').trim()); } catch { /* */ }
      if (!Number.isFinite(milli)) continue;
      const c = milli / 1000;
      if (type === 'x86_pkg_temp') pkg = c;
      if (!/iwlwifi|wifi/i.test(type) && (best == null || c > best)) best = c;
    }
    const c = pkg != null ? pkg : best;
    return c == null ? null : Math.round(c);
  } catch { return null; }
}

function startCpuSampling() {
  sampleCpu();
  setInterval(sampleCpu, 3000); // rolling CPU% over ~the last 3s
}
function getCpuPct() { return _cpuPct; }

module.exports = { startCpuSampling, getCpuPct, readMemPct, readTempC };
