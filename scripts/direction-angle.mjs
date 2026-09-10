/* THE DECISIVE GEOMETRY TEST — is the encoder axis actually a DIFFERENT DIRECTION from bits?
 *
 * WHY THIS IS THE QUESTION. 11.12 proved the panel ORDERS encode quality at fixed bits. 11.21 proved
 * it cannot QUANTIFY that ordering in bitrate units, because the conversion divides by blocking's
 * 0.103 slope and multiplies every confound by ~10. Six constructions died there.
 *
 * THE WAY OUT, if the geometry allows it. Stop converting. Treat the four detectors as a 4-vector and
 * note that a bitrate change and an encoder change move that vector in DIFFERENT DIRECTIONS:
 *     u_bits     = d(log L)/d(log bpp)      measured on the bitrate ladders, encoder fixed
 *     u_encoder  = d(log L)/d(preset step)  measured on the encoder ladder,  bits fixed
 * If those two directions are far apart, a film's artifact residual can be PROJECTED onto u_encoder
 * and that projection is information BPP+ structurally cannot have. Projecting onto a known direction
 * is a matched filter: it pulls a specific signal out of isotropic noise with an SNR gain, and it
 * never divides by any one detector's slope.
 *
 * IF THE ANGLE IS SMALL the whole idea is dead on arrival and no amount of fitting rescues it — the
 * projection would just be re-reading bits, which BPP+ already knows. That is the falsification, and
 * it is available BEFORE any model is built. This is the check that six previous constructions
 * skipped.
 *
 * PRE-REGISTERED READING (written before running):
 *     cos > 0.9   directions nearly parallel  -> DEAD, abandon the projection idea
 *     cos 0.5-0.9 partial overlap             -> usable only after orthogonalising against u_bits
 *     cos < 0.5   genuinely different axes    -> the matched filter is justified
 * 11.13 predicts the second or third: cambi's bitrate/encoder response ratio is 6.7 but blocking's is
 * 1.0, so the two vectors CANNOT be parallel unless every detector shares one response profile.
 *
 * USAGE: node scripts/direction-angle.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const unit = (v) => { const n = norm(v); return v.map((x) => x / n); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/* Ordinary least squares slope of y on x, ignoring pairs where either is missing or non-positive. */
function slope(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let num = 0; let den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den > 0 ? num / den : null;
}

/* ---------- u_bits, from the bitrate ladders (encoder held fixed, bits swept 8.3x) ---------- */
/* Per film, regress log(detector) on log(level). Take the median across films so one weird film
 * cannot set the direction. Sign convention: positive = artifact RISES. Levels rise, artifacts fall,
 * so these slopes are negative; we flip to "per unit DECREASE in bits" so both vectors point the same
 * way — toward WORSE. */
const lad = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const bitsPer = { cambi: [], block: [], blur: [], grain: [] };
for (const f of lad) {
  const pts = (f.points || []).filter((p) => p.level > 0);
  if (pts.length < 3) continue;
  const lx = pts.map((p) => Math.log(p.level));
  for (const d of DET) {
    const ly = pts.map((p) => (p[d] > 0 ? Math.log(p[d]) : NaN));
    const s = slope(lx, ly);
    if (s !== null && Number.isFinite(s)) bitsPer[d].push(s);
  }
}
const uBitsRaw = DET.map((d) => -med(bitsPer[d]));   // flip: per unit decrease in log bpp
const uBits = unit(uBitsRaw);

/* ---------- u_encoder, from the encoder ladder (bits held fixed, preset swept) ---------- */
/* x264 presets ONLY. Including x265 would mix in a CODEC FINGERPRINT (32x32 transforms vs 4x4/8x8),
 * which is a different physical thing and was already shown in 11.12 to reverse banding's ordering.
 * Rank 1 = veryfast = worst, so rank rises toward BETTER; flip so the vector points toward WORSE. */
const enc = JSON.parse(fs.readFileSync('data/encoder-ladder-wide.json', 'utf8')).films;
const encPer = { cambi: [], block: [], blur: [], grain: [] };
let nEncFilms = 0;
for (const f of enc) {
  const rows = (f.rows || []).filter((r) => /x264/.test(r.name));
  if (rows.length < 3) continue;
  nEncFilms += 1;
  const rank = rows.map((r) => r.rank);
  for (const d of DET) {
    const ly = rows.map((r) => (r[d] > 0 ? Math.log(r[d]) : NaN));
    const s = slope(rank, ly);
    if (s !== null && Number.isFinite(s)) encPer[d].push(s);
  }
}
const uEncRaw = DET.map((d) => -med(encPer[d]));     // flip: per preset step toward WORSE
const uEnc = unit(uEncRaw);

const cos = dot(uBits, uEnc);
const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;

console.log('\n  THE TWO DIRECTIONS — d(log artifact) per unit of movement toward WORSE\n');
console.log(`  ${'detector'.padEnd(9)} ${'u_bits'.padStart(9)} ${'u_encoder'.padStart(10)}   `
  + `${'raw bits'.padStart(9)} ${'raw enc'.padStart(9)}   films`);
DET.forEach((d, i) => {
  console.log(`  ${d.padEnd(9)} ${uBits[i].toFixed(3).padStart(9)} ${uEnc[i].toFixed(3).padStart(10)}   `
    + `${uBitsRaw[i].toFixed(4).padStart(9)} ${uEncRaw[i].toFixed(4).padStart(9)}   `
    + `${String(bitsPer[d].length).padStart(3)}/${String(encPer[d].length).padStart(2)}`);
});
console.log(`\n  ladder films ${lad.length}   encoder-ladder films ${nEncFilms}`);
console.log(`\n  cos(u_bits, u_encoder) = ${cos.toFixed(4)}      angle = ${angle.toFixed(1)} degrees\n`);

const verdict = Math.abs(cos) > 0.9 ? 'DEAD — the projection just re-reads bits'
  : Math.abs(cos) > 0.5 ? 'USABLE ONLY AFTER ORTHOGONALISING against u_bits'
    : 'GENUINELY DIFFERENT AXES — the matched filter is justified';
console.log(`  VERDICT: ${verdict}\n`);

/* The component of u_encoder that bits cannot express. This is the part that carries information
 * BPP+ structurally lacks, and its size is the honest ceiling on how much the panel can ever move a
 * score. Report it even when the verdict is favourable. */
const par = uBits.map((x) => x * cos);
const perp = uEnc.map((x, i) => x - par[i]);
console.log('  DECOMPOSITION of u_encoder against u_bits');
console.log(`  ${'detector'.padEnd(9)} ${'parallel'.padStart(9)} ${'orthogonal'.padStart(11)}`);
DET.forEach((d, i) => console.log(`  ${d.padEnd(9)} ${par[i].toFixed(3).padStart(9)} ${perp[i].toFixed(3).padStart(11)}`));
console.log(`  orthogonal fraction of u_encoder: ${(norm(perp)).toFixed(3)} `
  + `(${(norm(perp) ** 2 * 100).toFixed(0)}% of its variance is unreachable by bits)\n`);

/* A third direction as a sanity control. Preprocessing (denoise) is a DIFFERENT provenance axis, so
 * if the geometry story is right it should point somewhere else again — three axes, three directions.
 * If instead every axis gives the same direction, the "directions" are an artifact of the detectors
 * sharing a common mode and none of this works. */
try {
  const den = JSON.parse(fs.readFileSync('data/denoise-test.json', 'utf8')).films;
  const denPer = { cambi: [], block: [], blur: [], grain: [] };
  for (const f of den) {
    const rows = f.rows || [];
    if (rows.length < 3) continue;
    const x = rows.map((r, i) => (r.rank !== undefined ? r.rank : i));
    for (const d of DET) {
      const s = slope(x, rows.map((r) => (r[d] > 0 ? Math.log(r[d]) : NaN)));
      if (s !== null && Number.isFinite(s)) denPer[d].push(s);
    }
  }
  if (DET.every((d) => denPer[d].length >= 3)) {
    const uDen = unit(DET.map((d) => med(denPer[d])));
    console.log('  CONTROL — a third axis (preprocessing/denoise) should point somewhere else again');
    console.log(`  ${'detector'.padEnd(9)} ${'u_denoise'.padStart(10)}`);
    DET.forEach((d, i) => console.log(`  ${d.padEnd(9)} ${uDen[i].toFixed(3).padStart(10)}`));
    console.log(`  cos(u_denoise, u_bits)    = ${dot(uDen, uBits).toFixed(4)}`);
    console.log(`  cos(u_denoise, u_encoder) = ${dot(uDen, uEnc).toFixed(4)}`);
    console.log('  Three well-separated directions would mean the panel spans a real 3D provenance space.\n');
  } else {
    console.log('  CONTROL: denoise-test.json lacks per-detector coverage; skipped.\n');
  }
} catch (e) {
  console.log(`  CONTROL: denoise axis unavailable (${e.message}).\n`);
}
