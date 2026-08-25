// Small numeric helpers. Deliberately dependency-free: every function here is a few lines, and a
// chart library would hide the one thing this tool exists to make visible — exactly which numbers
// go into a curve.

export const asc = (a, b) => a - b;
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
export function summary(values) {
  const s = values.filter(Number.isFinite).sort(asc);
  if (!s.length) return null;
  return {
    n: s.length, min: s[0], max: s[s.length - 1],
    p10: quantile(s, 0.10), p25: quantile(s, 0.25), median: quantile(s, 0.50),
    p75: quantile(s, 0.75), p90: quantile(s, 0.90), mean: mean(s), sd: stdev(s),
  };
}

// Spearman rank correlation. Ties get average ranks.
//
// Kept for when a VALID subjective label exists. The 2026-08-13 eleven-film test was retracted on
// 2026-08-18: what was being scored as "artifacts" turned out to be grain, so the labels measured
// grain-visibility rather than compression, and every correlation computed against them was
// withdrawn — including the -0.090 that was once read as falsifying blockMean. blockMean is
// UNTESTED, not falsified. A label good enough to use here needs paired or reference-anchored
// presentation; "rate this clip" cannot produce one.
export function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 3) return null;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(pairs.map((p) => p[0]));
  const ry = rank(pairs.map((p) => p[1]));
  const mx = mean(rx); const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

// Ordinary least squares on log-log, i.e. fit y = a * x^b. The whole model rests on an exponent
// (bpp -> perceived quality, currently 0.5), so being able to FIT one from data instead of
// asserting it is the point of the Curve view.
export function powerFit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0);
  if (pts.length < 3) return null;
  const lx = pts.map((p) => Math.log(p[0]));
  const ly = pts.map((p) => Math.log(p[1]));
  const mx = mean(lx); const my = mean(ly);
  let num = 0; let den = 0;
  for (let i = 0; i < lx.length; i += 1) { num += (lx[i] - mx) * (ly[i] - my); den += (lx[i] - mx) ** 2; }
  if (!den) return null;
  const b = num / den;
  const a = Math.exp(my - b * mx);
  // R^2 in log space, which is what was actually fitted.
  const ss = ly.reduce((s, y) => s + (y - my) ** 2, 0);
  const rs = ly.reduce((s, y, i) => s + (y - (Math.log(a) + b * lx[i])) ** 2, 0);
  return { a, b, r2: ss ? 1 - rs / ss : null, n: pts.length };
}

// k-means with k-means++ seeding, on z-scored features. Seeded deterministically (no Math.random)
// so that re-rendering the same k never silently re-labels the clusters underneath you — a
// cluster's identity has to be stable to be worth reasoning about.
export function kmeans(rows, featureFns, k, iters = 60) {
  const raw = rows.map((r) => featureFns.map((f) => f(r)));
  const ok = raw.map((v) => v.every(Number.isFinite));
  const data = raw.filter((_, i) => ok[i]);
  if (data.length < k) return null;
  const d = featureFns.length;
  // z-score, so a feature measured in millions does not drown one measured in units.
  const mu = []; const sd = [];
  for (let j = 0; j < d; j += 1) {
    const col = data.map((v) => v[j]);
    mu[j] = mean(col); sd[j] = stdev(col) || 1;
  }
  const Z = data.map((v) => v.map((x, j) => (x - mu[j]) / sd[j]));
  const dist2 = (a, b) => a.reduce((s, x, j) => s + (x - b[j]) ** 2, 0);

  // k-means++ but with a deterministic "pick the farthest point" rule instead of the usual weighted
  // random draw. Same intent (spread the seeds out), no RNG.
  const cents = [Z[0].slice()];
  while (cents.length < k) {
    let best = 0; let bestD = -1;
    for (let i = 0; i < Z.length; i += 1) {
      const dd = Math.min(...cents.map((c) => dist2(Z[i], c)));
      if (dd > bestD) { bestD = dd; best = i; }
    }
    cents.push(Z[best].slice());
  }
  let assign = new Array(Z.length).fill(0);
  for (let it = 0; it < iters; it += 1) {
    let moved = false;
    for (let i = 0; i < Z.length; i += 1) {
      let bi = 0; let bd = Infinity;
      for (let c = 0; c < k; c += 1) { const dd = dist2(Z[i], cents[c]); if (dd < bd) { bd = dd; bi = c; } }
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    }
    for (let c = 0; c < k; c += 1) {
      const mem = Z.filter((_, i) => assign[i] === c);
      if (!mem.length) continue;
      for (let j = 0; j < d; j += 1) cents[c][j] = mean(mem.map((v) => v[j]));
    }
    if (!moved && it > 0) break;
  }
  // Order clusters by the first feature's centre so labels are stable and readable.
  const order = cents.map((c, i) => [c[0], i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const remap = new Map(order.map((old, nw) => [old, nw]));
  // Push labels back onto the ORIGINAL rows; rows with a missing feature get null, not cluster 0.
  const labels = new Array(rows.length).fill(null);
  let p = 0;
  for (let i = 0; i < rows.length; i += 1) if (ok[i]) { labels[i] = remap.get(assign[p]); p += 1; }
  const centres = order.map((old) => cents[old].map((z, j) => z * sd[j] + mu[j]));
  return { labels, centres, k };
}
