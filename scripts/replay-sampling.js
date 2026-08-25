#!/usr/bin/env node
/* ADAPTIVE-SAMPLING REPLAY — does the probe need 8 samples, or would 4 decide the same thing?
 *
 * THE IDEA UNDER TEST (docs/research-2026-08-19/08-innovations.md, idea C). Every unit gets exactly
 * PROBE_SAMPLES clips regardless of what the measurement is FOR. But the score feeds decisions with
 * known boundaries — the band edges at BPP+ 75 / 100 / 125. A unit whose 4-sample interval is nowhere
 * near a boundary does not need 8 clips; a unit straddling one deserves more. Wall time saved on the
 * easy units converts directly into more units per night inside the same thermal budget.
 *
 * THE DECISION RULE, STATED BEFORE THE RUN so it cannot be fitted afterwards:
 *   if a 4-sample estimate lands in a DIFFERENT BAND than the full-sample estimate materially more
 *   than ~1% of the time, the fixed grid is buying decision safety and this idea dies.
 *
 * WHY IT IS REPLAYABLE AT ALL. 196 units carry their individual readings (`sampleCx`), so a smaller
 * probe can be simulated by drawing subsets and re-deriving the whole chain: mean -> cxEff -> target
 * -> BPP+ -> band. Zero encodes.
 *
 * *** THE HONEST LIMITATION, AND IT IS NOT SMALL. *** A real n=4 probe samples at DIFFERENT OFFSETS
 * than an n=8 one: probe-film.sh puts clip i at S + SPAN*(i+phase)/N, so N is in the denominator. A
 * subset of 8 existing readings is therefore NOT the same thing as a 4-clip probe — it is the
 * sampling error of a 4-clip mean drawn from the same scene distribution. That is the quantity the
 * stopping rule actually depends on, so the replay is informative; it just cannot be called a
 * simulation of the real grid. Every subset of size 4 is enumerated (C(8,4)=70) rather than sampled,
 * so the numbers below are exact for the readings we hold.
 *
 * DUPLICATES ARE DROPPED FIRST. Before 2026-08-18 a revisit re-encoded the same offsets, so pooled
 * entries hold byte-identical repeats (24 units still do). Drawing subsets from those would
 * understate the spread — the same error the 2026-08-19 cache repair existed to remove. Readings are
 * de-duplicated by `samplePos` where it exists.
 *
 * USAGE
 *   node scripts/replay-sampling.js [--n 4] [--out PATH]
 */
const fs = require('fs');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = process.env.CONTROLLER || 'http://localhost:8088';
const SUB = Number(val('--n', 4));
const OUT = val('--out', `${__dirname}/../docs/replay-sampling.json`);

const BANDS = [[125, 'wow'], [100, 'ok'], [75, 'warn'], [0, 'bad']];
const bandOf = (p) => BANDS.find(([lo]) => p >= lo)[1];
const plusOf = (bpp, cx, bias) => {
  const target = cx * bias;                    // headroomTarget is 1.0; kept explicit
  return (bpp > 0 && target > 0) ? Math.round(100 * Math.sqrt(bpp / target)) : null;
};

// every k-subset of [0..n), as index arrays
function combos(n, k) {
  const out = []; const idx = [];
  (function rec(start) {
    if (idx.length === k) { out.push(idx.slice()); return; }
    for (let i = start; i < n; i += 1) { idx.push(i); rec(i + 1); idx.pop(); }
  }(0));
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };

(async () => {
  const res = await fetch(`${API}/api/probe/dataset`);
  const ds = await res.json();

  const units = [];
  for (const r of ds.rows) {
    if (!Array.isArray(r.sampleCx) || !r.sampleCx.length) continue;
    if (!(r.bpp > 0) || !(r.biasFactor > 0)) continue;
    // De-duplicate by position; fall back to value when samplePos predates the entry.
    let cx = r.sampleCx;
    if (Array.isArray(r.samplePos) && r.samplePos.length === cx.length) {
      const seen = new Set(); const keep = [];
      for (let i = 0; i < cx.length; i += 1) {
        const k = r.samplePos[i];
        if (seen.has(k)) continue;
        seen.add(k); keep.push(cx[i]);
      }
      cx = keep;
    } else {
      cx = [...new Set(cx)];
    }
    if (cx.length < SUB + 1) continue;          // need something to compare a subset against
    units.push({ ...r, cx });
  }

  const rows = [];
  for (const u of units) {
    const full = mean(u.cx);
    const fullPlus = plusOf(u.bpp, full, u.biasFactor);
    if (fullPlus == null) continue;
    const fullBand = bandOf(fullPlus);

    const subs = combos(u.cx.length, SUB);
    let flips = 0; let worst = 0;
    const plusList = [];
    for (const s of subs) {
      const p = plusOf(u.bpp, mean(s.map((i) => u.cx[i])), u.biasFactor);
      plusList.push(p);
      if (bandOf(p) !== fullBand) flips += 1;
      worst = Math.max(worst, Math.abs(p - fullPlus));
    }
    // THE RULE ITSELF, which is the only thing worth judging. A blind cut to 4 samples is not the
    // proposal; the proposal is "stop early ONLY when the 4-sample interval is clear of every band
    // edge". So the number that decides it is not the raw flip rate — it is
    //     P(band was wrong | the rule said it was safe to stop)
    // and the rule has to use the SUBSET's own sd, because that is all it would have had at the time.
    // A rule that is confidently wrong is worse than no rule, and this is where that shows up.
    let wouldStop = 0; let stopWrong = 0;
    for (const s of subs) {
      const v = s.map((i) => u.cx[i]);
      const m = mean(v); const se = sd(v) / Math.sqrt(SUB);
      const p = plusOf(u.bpp, m, u.biasFactor);
      // BPP+ ∝ cx^-1/2, so a relative error e on cx is ~e/2 on the score.
      const half = 1.96 * (se / m) / 2 * p;
      const nearEdge = [75, 100, 125].some((e) => Math.abs(p - e) <= half);
      if (!nearEdge) {
        wouldStop += 1;
        if (bandOf(p) !== fullBand) stopWrong += 1;
      }
    }
    rows.push({
      key: u.key, title: u.title, kind: u.kind, n: u.cx.length,
      fullPlus, fullBand, flipRate: flips / subs.length, worstDelta: worst,
      stopRate: wouldStop / subs.length,
      stopDraws: wouldStop, stopWrong,
      spread: Math.max(...u.cx) / Math.min(...u.cx),
      cxRSE: u.cxRSE ?? null,
      nearestEdge: Math.min(...[75, 100, 125].map((e) => Math.abs(fullPlus - e))),
    });
  }

  const flipRates = rows.map((r) => r.flipRate);
  const overall = mean(flipRates);
  const stops = mean(rows.map((r) => r.stopRate));
  const near = rows.filter((r) => r.nearestEdge <= 10);
  const far = rows.filter((r) => r.nearestEdge > 25);

  // Pooled over DRAWS, not over units: a unit contributing 70 subsets should weigh 70 decisions.
  const stopDraws = rows.reduce((a2, r) => a2 + r.stopDraws, 0);
  const stopWrong = rows.reduce((a2, r) => a2 + r.stopWrong, 0);
  const summary = {
    generated: ds.generated, subsetSize: SUB, units: rows.length,
    ruleStopDraws: stopDraws,
    ruleWrongWhenStopped: stopWrong,
    ruleErrorRate: stopDraws ? +(stopWrong / stopDraws).toFixed(4) : null,
    meanFlipRate: +overall.toFixed(4),
    medianFlipRate: +med(flipRates).toFixed(4),
    unitsNeverFlipping: rows.filter((r) => r.flipRate === 0).length,
    unitsFlippingOver10pct: rows.filter((r) => r.flipRate > 0.10).length,
    meanStopRate: +stops.toFixed(4),
    medianWorstDelta: +med(rows.map((r) => r.worstDelta)).toFixed(1),
    p90WorstDelta: +[...rows.map((r) => r.worstDelta)].sort((a, b) => a - b)[Math.floor(rows.length * 0.9)],
    nearEdge: { n: near.length, meanFlipRate: near.length ? +mean(near.map((r) => r.flipRate)).toFixed(4) : null },
    farFromEdge: { n: far.length, meanFlipRate: far.length ? +mean(far.map((r) => r.flipRate)).toFixed(4) : null },
    verdictBlindCut: overall > 0.01 ? 'a blind cut to this n FAILS the pre-registered 1% threshold'
      : 'a blind cut to this n is within the pre-registered threshold',
    verdictRule: stopDraws && (stopWrong / stopDraws) > 0.01
      ? 'IDEA DIES — the stopping rule is wrong more than 1% of the times it claims to be safe'
      : 'the stopping rule holds: when it says stop, the band is right',
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log('\nworst 12 units by flip rate:');
  for (const r of [...rows].sort((a, b) => b.flipRate - a.flipRate).slice(0, 12)) {
    console.log(`  ${(r.flipRate * 100).toFixed(1).padStart(5)}%  BPP+ ${String(r.fullPlus).padStart(3)} `
      + `(${r.fullBand}, ${r.nearestEdge} from an edge)  +/-${r.worstDelta} worst  n=${r.n}  ${r.title}`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));
  console.log(`\nwrote ${OUT}`);
})();
