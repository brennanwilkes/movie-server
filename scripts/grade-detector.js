#!/usr/bin/env node
/* GRADE AN ARTIFACT DETECTOR WITHOUT LABELS.
 *
 * THE INSIGHT THIS TOOL EXISTS FOR. Grading a detector looks like it needs subjective labels, and
 * this project has none that survived scrutiny (BPP-PLUS.txt §11.1 retracted the only blind test —
 * the artefacts Brennan scored turned out to be grain, so the labels measured grain-visibility, not
 * compression). But a detector can be graded on REPEATED READINGS alone:
 *
 *   RELIABILITY  split the per-clip readings of one film in half, average each half, and correlate
 *                the halves across films. If the detector cannot agree with ITSELF on two samples of
 *                the same film, it cannot be measuring a property of the film. Spearman-Brown
 *                corrects the half-length correlation back up to full length.
 *
 *   DEGENERACY   a detector that correlates hard with mean luma is a brightness statistic wearing a
 *                costume. This is not hypothetical: gShare died at r = -0.885 against luma
 *                (§11.3), and the whole "grain quotient" family died with it. CAMBI passed the same
 *                test at -0.022 on replication, which is why it shipped.
 *
 * WHAT RELIABILITY DOES NOT PROVE, and it must be said every time: repeatable is not the same as
 * correct. A systematically misspecified detector produces repeatable readings too. Reliability is a
 * NECESSARY condition that cheaply kills bad detectors; it is not sufficient, and the sufficiency
 * question needs the external dataset (task #51).
 *
 * `blockMean` and `blurMean` sat ungraded for months on the false assumption that this needed
 * labels. probe-film.sh computed the per-clip readings all along and then averaged them away; since
 * 2026-08-21 it emits them, so the test costs nothing but this script.
 *
 * USAGE: node scripts/grade-detector.js [--api http://localhost:8088]
 */
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const SPLITS = Number(val('--splits', 200));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : 0;
}
const ranks = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = [];
  for (let k = 0; k < idx.length;) {
    let m = k; while (m + 1 < idx.length && idx[m + 1][0] === idx[k][0]) m += 1;
    const avg = (k + m) / 2 + 1;
    for (let z = k; z <= m; z += 1) r[idx[z][1]] = avg;
    k = m + 1;
  }
  return r;
};
const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

// Deterministic PRNG — the splits must be reproducible, so a grade can be re-checked rather than
// re-rolled. Math.random() would make every run disagree slightly with the last for no reason.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/* Split-half reliability, averaged over many random half-splits rather than a single odd/even one.
 * Odd/even is not neutral here: the clips are ordered by position in the film, so odd/even pairs
 * adjacent scenes and would flatter any detector that varies slowly across a runtime. */
function reliability(samples) {
  const rs = [];
  for (let t = 0; t < SPLITS; t += 1) {
    const A = []; const B = [];
    for (const s of samples) {
      const v = [...s].sort(() => rnd() - 0.5);
      const h = Math.floor(v.length / 2);
      A.push(mean(v.slice(0, h))); B.push(mean(v.slice(h, h * 2)));
    }
    const r = pearson(A, B);
    if (Number.isFinite(r)) rs.push(r);
  }
  const half = mean(rs);
  return { half, full: (2 * half) / (1 + half) };   // Spearman-Brown
}

(async () => {
  const [ds, bd] = await Promise.all([
    (await fetch(`${API}/api/probe/dataset`)).json(),
    (await fetch(`${API}/api/banding/dataset`)).json(),
  ]);
  const band = new Map(bd.rows.map((r) => [r.key, r]));

  // Each detector: where its per-clip readings live, and how to reach the film-level value.
  const DETECTORS = [
    { name: 'blockMean (blocking)', per: (r) => r.sampleBlock, agg: (r) => r.blockMean },
    { name: 'blurMean (blur)', per: (r) => r.sampleBlur, agg: (r) => r.blurMean },
    { name: 'cambi (banding)', per: (r) => (band.get(r.key) || {}).sampleCambi, agg: (r) => r.cambi },
    { name: 'complexity (reference)', per: (r) => r.sampleCx, agg: (r) => r.cxEff },
  ];

  for (const d of DETECTORS) {
    const rows = ds.rows.filter((r) => Array.isArray(d.per(r)) && d.per(r).length >= 4
      && d.per(r).every((v) => Number.isFinite(v)) && d.agg(r) != null);
    console.log(`\n=== ${d.name} ===`);
    if (rows.length < 12) { console.log(`  only ${rows.length} units with >=4 readings — not gradeable yet`); continue; }

    const rel = reliability(rows.map(d.per));
    const verdict = rel.full >= 0.7 ? 'USABLE' : rel.full >= 0.5 ? 'MARGINAL — needs more clips per film'
      : 'UNRELIABLE — cannot agree with itself, do not build on it';
    console.log(`  n=${rows.length}  clips/film ${(mean(rows.map((r) => d.per(r).length))).toFixed(1)}`);
    console.log(`  split-half r ${rel.half.toFixed(3)}  ->  Spearman-Brown ${rel.full.toFixed(3)}   ${verdict}`);

    // DEGENERACY — the tests that killed gShare. A detector must not be a restatement of brightness,
    // of the denominator it is meant to complement, or of the score it is meant to correct.
    const v = rows.map(d.agg);
    for (const [n, g] of [['mean luma', (r) => r.cambiLuma ?? (band.get(r.key) || {}).yavg],
      ['complexity', (r) => r.cxEff], ['BPP+', (r) => r.bppPlus],
      ['log bpp', (r) => (r.bpp > 0 ? Math.log(r.bpp) : null)],
      ['resolution', (r) => (r.probeW > 0 && r.probeH > 0 ? r.probeW * r.probeH : null)]]) {
      const ok = rows.map((r, i) => [g(r), v[i]]).filter((p) => p[0] != null && Number.isFinite(p[0]));
      if (ok.length < 12) { console.log(`  vs ${n.padEnd(11)} — too few units carry it`); continue; }
      const p = pearson(ok.map((x) => x[0]), ok.map((x) => x[1]));
      const s = spearman(ok.map((x) => x[0]), ok.map((x) => x[1]));
      const flag = Math.abs(p) > 0.7 ? '  DEGENERATE — this is that variable in disguise'
        : Math.abs(p) > 0.5 ? '  heavily entangled' : '  passes';
      console.log(`  vs ${n.padEnd(11)} pearson ${p >= 0 ? ' ' : ''}${p.toFixed(3)}  spearman ${s >= 0 ? ' ' : ''}${s.toFixed(3)}  n=${ok.length}${flag}`);
    }
  }

  console.log('\nReliability is NECESSARY, not sufficient — a misspecified detector repeats itself too.');
})();
