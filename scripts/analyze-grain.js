#!/usr/bin/env node
// analyze-grain.js — turn the grain CSVs into the three answers they were run to produce.
//
//   1. OFFSET STABILITY  is a film's gShare a property of the FILM, or of which scenes we sampled?
//      Decided by comparing the phase=0 and phase=0.33 runs against the WITHIN-film standard error,
//      not against zero. A shift smaller than one standard error is what a stable quantity looks
//      like; the question is never "did it move" (it always moves) but "did it move more than noise".
//
//   2. FALSIFICATION     does the metric separate groups whose grain content is not in dispute?
//      Rendered CGI has NO photochemical grain. If it scores like 35mm, the metric is noise.
//
//   3. CONSTANT SCALE    is the correction a per-film insight or a whole-library rescale?
//      A rescale cannot reorder. Spearman against the uncorrected ordering measures how much it does.
//
// Usage: node scripts/analyze-grain.js [dir]   (default docs/audit-2026-07-31/raw)
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = process.argv[2] || 'docs/audit-2026-07-31/raw';

const readCsv = (p) => {
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) return null;
  // Fields are quoted only where they may contain commas; a simple split would break on those.
  const split = (l) => l.match(/("[^"]*"|[^,]*)(,|$)/g).map((s) => s.replace(/,$/, '').replace(/^"|"$/g, ''));
  const hdr = split(lines[0]);
  return lines.slice(1).map((l) => {
    const c = split(l); const o = {};
    hdr.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
};

const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => (a.length < 2 ? null : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const pear = (a, b) => {
  const n = a.length; if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let s = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return (da && db) ? s / Math.sqrt(da * db) : null;
};
const spearman = (a, b) => {
  const rk = (v) => { const s = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], j) => { r[i] = j + 1; }); return r; };
  return pear(rk(a), rk(b));
};
const f3 = (x) => (x == null ? ' n/a ' : x.toFixed(3));

// ── per-film standard error, straight from the stored per-sample values (todo #9's whole point) ──
const perSample = (row) => (row.per_sample || '').split(';').map(num).filter((x) => x != null);
const se = (row) => { const s = perSample(row); const d = sd(s); return d == null ? null : d / Math.sqrt(s.length); };

console.log('='.repeat(78));
console.log('GRAIN ANALYSIS —', new Date().toISOString().slice(0, 16).replace('T', ' '));
console.log('='.repeat(78));

// ── 1. OFFSET STABILITY ──────────────────────────────────────────────────────────────────────────
const PHASE0 = {
  'Lawrence of Arabia (1962)': 0.528, '2001: A Space Odyssey (1968)': 0.595,
  'Blade Runner (1982)': 0.354, 'Alien (1979)': 0.421, 'Raiders of the Lost Ark (1981)': 0.218,
  'Skyfall (2012)': 0.354, 'Blade Runner 2049 (2017)': 0.216, 'The Social Network (2010)': 0.421,
  'Gone Girl (2014)': 0.380, 'Whiplash (2014)': 0.452,
};
const ph = [...(readCsv(path.join(DIR, 'grain-phase033.csv')) || []),
  ...(readCsv(path.join(DIR, 'grain-phase033-rest.csv')) || [])]
  .filter((r) => num(r.grain_share) != null);

if (ph.length) {
  console.log('\n1. OFFSET STABILITY — same film, same n, DIFFERENT SCENES (phase 0 -> 0.33)\n');
  console.log('   film                            phase0  phase.33   shift   within-film SE   shift/SE');
  const shifts = [];
  for (const r of ph) {
    const a = PHASE0[r.film], b = num(r.grain_share), s = se(r);
    if (a == null || b == null) continue;
    const d = b - a; shifts.push(Math.abs(d));
    const ratio = s ? Math.abs(d) / s : null;
    console.log(`   ${r.film.padEnd(30)} ${a.toFixed(3)}   ${b.toFixed(3)}   ${(d >= 0 ? '+' : '') + d.toFixed(3)}       ${f3(s)}        ${ratio == null ? ' n/a' : ratio.toFixed(2)}`);
  }
  const spread = Math.max(...Object.values(PHASE0)) - Math.min(...Object.values(PHASE0));
  console.log(`\n   mean |shift| = ${f3(mean(shifts))}   vs BETWEEN-FILM spread ${spread.toFixed(3)}`);
  console.log(`   -> scene selection accounts for ${(mean(shifts) / spread * 100).toFixed(0)}% of the between-film range.`);
  console.log('      Under ~25% the ordering is real; over ~50% the spread is largely sampling luck.');
  const pa = ph.map((r) => PHASE0[r.film]).filter((x) => x != null);
  const pb = ph.filter((r) => PHASE0[r.film] != null).map((r) => num(r.grain_share));
  if (pa.length >= 3) {
    console.log(`   r(phase0, phase.33) = ${f3(pear(pa, pb))}   Spearman = ${f3(spearman(pa, pb))}`);
    console.log('      This is the reproducibility ceiling: nothing downstream can be more reliable than this.');
  }
} else {
  console.log('\n1. OFFSET STABILITY — no data yet');
}

// ── 2. FALSIFICATION ─────────────────────────────────────────────────────────────────────────────
const ex = (readCsv(path.join(DIR, 'grain-extremes.csv')) || []).filter((r) => num(r.grain_share) != null);
if (ex.length) {
  console.log('\n2. FALSIFICATION — groups whose grain content is NOT in dispute\n');
  console.log('   film                            group           gShare   per-sample SE');
  const grp = {};
  for (const r of ex.sort((a, b) => num(b.grain_share) - num(a.grain_share))) {
    const g = (r.prior || '').split(' ')[0];
    (grp[g] = grp[g] || []).push(num(r.grain_share));
    console.log(`   ${r.film.padEnd(30)} ${g.padEnd(15)} ${num(r.grain_share).toFixed(3)}    ${f3(se(r))}`);
  }
  console.log('\n   group medians:');
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  for (const g of Object.keys(grp)) {
    console.log(`     ${g.padEnd(16)} n=${grp[g].length}  median ${med(grp[g]).toFixed(3)}  range ${Math.min(...grp[g]).toFixed(3)}-${Math.max(...grp[g]).toFixed(3)}`);
  }
  const cgi = grp['FLOOR-CGI'], bw = grp['CEILING-BW'];
  if (cgi && bw) {
    const sep = med(bw) - med(cgi);
    const overlap = Math.min(...bw) <= Math.max(...cgi);
    console.log(`\n   VERDICT: CGI median ${med(cgi).toFixed(3)} vs B&W-film median ${med(bw).toFixed(3)}  separation ${sep.toFixed(3)}`);
    console.log(overlap
      ? '   -> RANGES OVERLAP. Rendered frames containing no grain score like film stock: the metric\n      is NOT measuring grain, and any per-film correction built on it is noise plus a rescale.'
      : '   -> CLEAN SEPARATION. Content with no photochemical grain scores below content that is all\n      grain, with no overlap. The metric tracks something real.');
  }
} else {
  console.log('\n2. FALSIFICATION — no data yet');
}

// ── 3. ABLATION ──────────────────────────────────────────────────────────────────────────────────
const ab = readCsv(path.join(DIR, 'grain-ablation.csv'));
if (ab && ab.length) {
  console.log('\n3. ABLATION — which of `-tune grain`\'s knobs actually produces gShare?\n');
  const knobs = Object.keys(ab[0]).filter((k) => !['film', 'prior', 'secs'].includes(k));
  console.log('   film                          ' + knobs.map((k) => k.padStart(9)).join(''));
  for (const r of ab) console.log('   ' + r.film.slice(0, 28).padEnd(30) + knobs.map((k) => String(r[k]).padStart(9)).join(''));
  const full = ab.map((r) => num(r.full)).filter((x) => x != null);
  console.log('\n   how each knob\'s per-film ORDERING compares to the full bundle (Spearman):');
  for (const k of knobs) {
    if (k === 'full') continue;
    const pairs = ab.map((r) => [num(r[k]), num(r.full)]).filter(([a, b]) => a != null && b != null);
    if (pairs.length < 3) continue;
    const rho = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    const contrib = mean(pairs.map((p) => p[0])) - 1;
    console.log(`     ${k.padEnd(10)} rho=${f3(rho)}   mean cost ${(contrib * 100).toFixed(1)}% of base bitrate`);
  }
  console.log('\n   A knob with HIGH rho and HIGH cost is what gShare is really measuring. If that knob is\n   aq0/cutree0 rather than psy, the bundle is a bit-allocation artefact, not a grain measurement.');
} else {
  console.log('\n3. ABLATION — no data yet');
}

// ── 4. CHEAP DETECTOR ────────────────────────────────────────────────────────────────────────────
const fg = [...(readCsv(path.join(DIR, 'grain-flatgrain-ablateset.csv')) || []),
  ...(readCsv(path.join(DIR, 'grain-flatgrain-extremes.csv')) || [])]
  .filter((r) => num(r.flat_res) != null);
if (fg.length) {
  console.log('\n4. CHEAP DETECTOR — flat-region residual vs the expensive gShare\n');
  console.log('   film                          flat_frac  raw_res  flat_res   gShare');
  const gs = {};
  for (const r of ex) gs[r.film] = num(r.grain_share);
  for (const r of ph) gs[r.film] = gs[r.film] ?? num(r.grain_share);
  Object.assign(gs, Object.fromEntries(Object.entries(PHASE0).filter(([k]) => !(k in gs))));
  const pairs = [];
  for (const r of fg.sort((a, b) => num(b.flat_res) - num(a.flat_res))) {
    const g = gs[r.film];
    console.log(`   ${r.film.slice(0, 28).padEnd(30)} ${String(r.flat_frac).padStart(7)}  ${String(r.raw_res).padStart(7)}  ${String(r.flat_res).padStart(7)}   ${g == null ? '  -' : g.toFixed(3)}`);
    if (g != null) pairs.push([num(r.flat_res), g, num(r.raw_res)]);
  }
  if (pairs.length >= 3) {
    console.log(`\n   r(flat_res, gShare) = ${f3(pear(pairs.map((p) => p[0]), pairs.map((p) => p[1])))}   Spearman = ${f3(spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])))}`);
    console.log(`   r(raw_res,  gShare) = ${f3(pear(pairs.map((p) => p[2]), pairs.map((p) => p[1])))}   <- the UNMASKED control`);
    console.log('   If flat_res correlates and raw_res does not, the flat-region masking is doing the work —\n   which is the whole claim, and the thing `jitter` got wrong.');
  }
} else {
  console.log('\n4. CHEAP DETECTOR — no data yet');
}
console.log('');
