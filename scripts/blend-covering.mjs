/* DOES THE COVERING SET BOUND THE ANSWER WITHOUT A SINGLE CUT-OFF?
 *
 * Brennan, 2026-08-25: "There should be no artificial constants in our formula except maybe some
 * weights to adjust the multipliers, or a general one that shifts the whole library up and down.
 * There should be no 'cut off point' constances when computing bpp+"
 *
 * The claim to test: the Godfather's 782 is not a defect in the arithmetic, it is banding correctly
 * reporting that banding has enormous headroom. Under
 *
 *     m_binding = max over artifacts of (T_a / L_a)^(1/S_a)
 *
 * that number is simply not selected, because blocking crosses ITS threshold first. If that is true,
 * every guard can be deleted and nothing explodes.
 *
 * WE DO NOT KNOW T_block YET — that is what CVQAD is for. So this sweeps it, and asks two things:
 *   1. Is there a value of T_block that makes the whole library behave, with no other guard?
 *   2. How precisely does CVQAD need to pin it down for the answer to be stable?
 *
 * ANCHORS. L is the artifact level of the file we actually have, so it comes from the LOSSLESS rung
 * (our copy, re-extracted, no compression added by us). S is that film's own fitted slope for that
 * artifact. Both are per-film measurements; neither is chosen.
 *
 * USAGE: node scripts/blend-covering.mjs
 */
import fs from 'fs';

const T_BAND = 2.817;
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '   -');
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

const lads = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const wideFiles = ['data/artifact-ladder-wideA.json', 'data/artifact-ladder-wideB.json'];
const extra = [];
for (const w of wideFiles) {
  try { extra.push(...JSON.parse(fs.readFileSync(w, 'utf8')).films); } catch { /* not yet */ }
}
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const byKey = new Map(ds.rows.filter((r) => r.bppPlus != null).map((r) => [r.key, r]));

/* Fit log(artifact) on log(level) for whichever artifact is asked for, and read the film's own level
 * off the lossless rung. Returns null when the artifact never moved — a flat curve carries no
 * crossing, and inventing one is the mistake this whole exercise is trying to stop making. */
function curve(f, field) {
  const pts = (f.points || []).filter((p) => p.level > 0 && p[field] > 0);
  if (pts.length < 3) return null;
  const xs = pts.map((p) => Math.log(p.level));
  const ys = pts.map((p) => Math.log(p[field]));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const S = sxy / sxx;
  const ll = (f.points || []).find((p) => p.lossless);
  const L = ll && ll[field] > 0 ? ll[field] : Math.exp(my - S * mx);
  return { S, L, n };
}

const films = [];
for (const f of [...lads, ...extra]) {
  const r = byKey.get(f.key);
  if (!r) continue;
  const band = curve(f, 'cambi');
  const block = curve(f, 'block');
  if (!band || !block) continue;
  films.push({ key: f.key, title: f.title, bppPlus: r.bppPlus, band, block });
}
console.log(`\n${films.length} films carry BOTH a banding and a blocking curve.\n`);

const mOf = (c, T) => ((c.S === 0 || !Number.isFinite(c.S)) ? null : (T / c.L) ** (1 / c.S));

// ── 1. THE SWEEP ─────────────────────────────────────────────────────────────────────────────────
console.log('1. SWEEPING THE UNKNOWN BLOCKING THRESHOLD — what does max-over-artifacts give?\n');
console.log(`  ${'T_block'.padStart(8)} ${'median m'.padStart(9)} ${'p95 m'.padStart(8)} ${'max m'.padStart(9)} `
  + `${'blocking binds'.padStart(15)} ${'median BPP+ x'.padStart(14)} ${'worst BPP+ x'.padStart(13)}`);
for (const Tb of [1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
  const ms = []; let bindCount = 0;
  for (const f of films) {
    const mb = mOf(f.band, T_BAND); const mk = mOf(f.block, Tb);
    if (mb == null || mk == null) continue;
    const m = Math.max(mb, mk);
    if (mk >= mb) bindCount += 1;
    ms.push(m);
  }
  ms.sort((a, b) => a - b);
  const mult = ms.map((m) => 1 / Math.sqrt(m)).sort((a, b) => a - b);
  console.log(`  ${num(Tb, 1).padStart(8)} ${num(ms[Math.floor(ms.length / 2)], 3).padStart(9)} `
    + `${num(ms[Math.floor(ms.length * 0.95)], 2).padStart(8)} ${num(ms[ms.length - 1], 2).padStart(9)} `
    + `${(`${bindCount}/${ms.length}`).padStart(15)} `
    + `${(`x${num(mult[Math.floor(mult.length / 2)])}`).padStart(14)} `
    + `${(`x${num(mult[mult.length - 1])}`).padStart(13)}`);
}

// ── 2. THE FILM THAT STARTED IT ──────────────────────────────────────────────────────────────────
console.log('\n2. THE GODFATHER, AND THE OTHER FORMER EXPLOSIONS, UNDER THE MAX RULE\n');
const watch = films.filter((f) => /Godfather|Big Sleep|Ocean|Man Who Knew|Dune|Otto|Swingers|Knocked/.test(f.title));
console.log(`  ${pad('film', 26)} ${'BPP+'.padStart(5)} ${'m_band'.padStart(8)} `
  + [2, 3, 4, 5, 6].map((t) => `m_blk@${t}`.padStart(9)).join(' '));
for (const f of watch) {
  const mb = mOf(f.band, T_BAND);
  console.log(`  ${pad(f.title, 26)} ${String(f.bppPlus).padStart(5)} ${num(mb, 3).padStart(8)} `
    + [2, 3, 4, 5, 6].map((t) => num(mOf(f.block, t), 3).padStart(9)).join(' '));
}
console.log('\n  (m_blk larger than m_band means BLOCKING is the binding artifact and banding\'s');
console.log('   headroom is never selected — no cap required, the max simply does not pick it.)');

// ── 3. HOW PRECISE DOES CVQAD HAVE TO BE? ────────────────────────────────────────────────────────
// If the answer swings wildly with T_block, we need a tight threshold; if it is flat, a rough one
// will do. This is the difference between an 8-hour run being sufficient and being a down payment.
console.log('\n3. SENSITIVITY — how much does the final score move per 1 unit of T_block?\n');
console.log(`  ${pad('film', 26)} ${'BPP+'.padStart(5)} ${'@T=3'.padStart(7)} ${'@T=4'.padStart(7)} `
  + `${'@T=5'.padStart(7)} ${'swing'.padStart(7)}`);
for (const f of watch) {
  const mb = mOf(f.band, T_BAND);
  const at = [3, 4, 5].map((t) => {
    const m = Math.max(mb, mOf(f.block, t));
    return f.bppPlus / Math.sqrt(m);
  });
  console.log(`  ${pad(f.title, 26)} ${String(f.bppPlus).padStart(5)} `
    + at.map((v) => num(v, 0).padStart(7)).join(' ')
    + ` ${num(Math.max(...at) / Math.min(...at), 2).padStart(7)}x`);
}
