/* IS THE 0.103 BLOCKING SLOPE THE WRONG NUMBER FOR THE FILMS THAT MATTER? (2026-08-27)
 *
 * WHERE THIS CAME FROM. The flagged-film ladders show blocking slopes of -0.10 to -0.33 on films where
 * blocking is actually VISIBLE (Mr Inbetween S03 -0.332, Gran Torino -0.176, Mr Inbetween S01 -0.100).
 * The library median that this project has quoted for weeks is 0.103, and that number is load-bearing:
 *
 *   11.21 rejected the encoder axis as cardinal because "converting a blocking difference into a
 *         bitrate difference divides by 0.103 and multiplies both the signal and every confound by
 *         ~10". The 4.64x implied BD-rate came from exactly that.
 *
 * IF THE SLOPE IS REGIME-DEPENDENT, that argument was made with the wrong slope. A median over the
 * whole library is dominated by films whose blocking sits at the detector's floor and physically
 * cannot move; those films contribute ~0 slopes and drag the median down. The films the score
 * actually needs to judge are the ones where blocking is visible — and there the slope may be several
 * times steeper, making 1/S several times smaller.
 *
 * THE TEST. Across all laddered films, does |slope| rise with the film's own artifact LEVEL? Run for
 * all four detectors, because if it is a general property of measuring near a floor it should appear
 * in more than one.
 *
 * THE ALTERNATIVE EXPLANATION, WHICH MUST BE STATED EITHER WAY. This could be a DETECTOR FLOOR
 * artifact rather than a content regime: near its floor a detector is saturated and insensitive, so
 * low-level films show flat slopes for an instrumental reason, not a physical one. The practical
 * conclusion is the same — use the film's OWN slope, never the library median — but the two readings
 * differ in what they say about the detector, and only one of them is a fact about films.
 *
 * A THIRD, DULLER EXPLANATION worth ruling out: log-scale arithmetic. A slope of d(log L)/d(log bits)
 * is already scale-free, so a film with twice the blocking does NOT mechanically get twice the slope.
 * That is why the fit is done in logs; if the relationship appeared only in raw units it would be
 * arithmetic rather than physics.
 *
 * USAGE: node scripts/slope-regime.mjs
 */
import fs from 'fs';

const ART = [
  { key: 'cambi', label: 'banding', T: 2.817 },
  { key: 'block', label: 'blocking', T: 3.710 },
  { key: 'blur', label: 'blur', T: 8.026 },
  { key: 'grain', label: 'grain', T: 0.905 },
];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
const rankOf = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (a, b) => corr(rankOf(a), rankOf(b));
function fit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 4) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  if (!(d > 0)) return null;
  const s = n / d;
  const sse = pts.reduce((a, [x, y]) => a + (y - (my + s * (x - mx))) ** 2, 0);
  const tot = pts.reduce((a, [, y]) => a + (y - my) ** 2, 0);
  return { slope: s, r2: tot > 0 ? 1 - sse / tot : 0 };
}

const FILES = ['artifact-ladder-grain.json', 'artifact-ladder-v1.json', 'artifact-ladder-wideA.json',
  'artifact-ladder-grain2.json', 'artifact-ladder-blindspot.json', 'artifact-ladder-underscored.json',
  'artifact-ladder-flagged.json'];
const films = [];
const seen = new Set();
for (const fn of FILES) {
  let d; try { d = JSON.parse(fs.readFileSync(`data/${fn}`, 'utf8')); } catch { continue; }
  for (const f of d.films || []) if (!seen.has(f.key)) { films.push(f); seen.add(f.key); }
}
console.log(`\n  ${films.length} laddered films\n`);

for (const a of ART) {
  const recs = [];
  for (const f of films) {
    const pts = (f.points || []).filter((p) => p.level > 0 && p[a.key] > 0);
    if (pts.length < 5) continue;
    const g = fit(pts.map((p) => Math.log(p.level)), pts.map((p) => Math.log(p[a.key])));
    if (!g) continue;
    /* The film's own level at its native bitrate — the 1.0x rung — as the regime indicator. Using the
     * lossless rung instead would mix in the release encoder's contribution, which is a different
     * question and the one 11.20 already found confounded. */
    const one = pts.find((p) => Math.abs(p.level - 1) < 1e-6);
    if (!one) continue;
    recs.push({ title: f.title, level: one[a.key], slope: Math.abs(g.slope), r2: g.r2 });
  }
  if (recs.length < 20) { console.log(`  ${a.label}: only ${recs.length} films, skipped\n`); continue; }

  const lv = recs.map((r) => Math.log(r.level));
  const sl = recs.map((r) => Math.log(Math.max(r.slope, 1e-4)));
  const r = corr(lv, sl); const rs = spearman(lv, sl);
  console.log(`  ${a.label.toUpperCase()}   n=${recs.length}`);
  console.log(`    corr(log level, log |slope|)   pearson ${r.toFixed(3)}   spearman ${rs.toFixed(3)}`);

  /* Terciles by level, so the size of the effect is readable rather than only its significance. */
  const sorted = recs.slice().sort((x, y) => x.level - y.level);
  const t = Math.floor(sorted.length / 3);
  const bands = [['low level', sorted.slice(0, t)], ['mid', sorted.slice(t, 2 * t)], ['high level', sorted.slice(2 * t)]];
  console.log(`    ${'band'.padEnd(12)} ${'n'.padStart(4)} ${'median level'.padStart(13)} ${'median |slope|'.padStart(15)}`);
  for (const [nm, g] of bands) {
    console.log(`    ${nm.padEnd(12)} ${String(g.length).padStart(4)} ${med(g.map((x) => x.level)).toFixed(3).padStart(13)} `
      + `${med(g.map((x) => x.slope)).toFixed(3).padStart(15)}`);
  }
  const loS = med(bands[0][1].map((x) => x.slope));
  const hiS = med(bands[2][1].map((x) => x.slope));
  console.log(`    high/low slope ratio ${(hiS / Math.max(loS, 1e-4)).toFixed(2)}x`);

  /* The number that matters for 11.21: the slope among films where the artifact is actually VISIBLE. */
  const vis = recs.filter((x) => x.level >= a.T);
  if (vis.length >= 5) {
    console.log(`    films with ${a.label} ABOVE its threshold (${a.T}): n=${vis.length}, `
      + `median |slope| ${med(vis.map((x) => x.slope)).toFixed(3)}  vs library median ${med(recs.map((x) => x.slope)).toFixed(3)}`);
  } else {
    console.log(`    only ${vis.length} films above threshold — cannot quote a visible-regime slope`);
  }
  console.log('');
}

console.log('  WHY THIS MATTERS. 11.21 rejected the encoder axis as cardinal on the grounds that');
console.log('  converting blocking into bitrate divides by 0.103 and amplifies every confound ~10x.');
console.log('  If the visible-regime slope is materially steeper, that argument was made with a slope');
console.log('  drawn from films where blocking cannot move — and 1/S is correspondingly smaller for');
console.log('  the films the score actually has to judge. It does NOT revive the per-film exchange');
console.log('  rate on its own; it means the rejection was quantitatively overstated, and the');
console.log('  provenance factor should use each film\'s own slope wherever one exists.\n');
