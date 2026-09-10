/* MORE SHORT CLIPS OR FEWER LONG ONES? — reliability per decoded second.
 *
 * WHY IT MATTERS. 11.42 measured that a 12-clip re-measure of the library would buy roughly 10% more
 * shrinkage for about 33 hours of box time, and called that a poor trade. But that costing assumed the
 * existing recipe — 2-second clips. If a longer clip buys more reliability per DECODED SECOND, the
 * hours drop and the trade changes. Seeking into a large file is expensive and decoding is comparatively
 * cheap, so the question is not obvious either way.
 *
 * THE ONLY FAIR COMPARISON IS AT MATCHED TOTAL DECODED SECONDS. Comparing "8 clips of 6s" against
 * "8 clips of 2s" would just say that three times the data is better, which is not a design question.
 * The design question is how to SPEND a fixed budget:
 *     12 decoded seconds =  6 x 2s   vs   2 x 6s
 *     24 decoded seconds = 12 x 2s   vs   4 x 6s
 *
 * THE PRIOR, WHICH THE DATA MAY OVERTURN. 11.41 established the noise is SCENE HETEROGENEITY, not
 * instrument error — one film's clips span 0.11 to 12.10. Against scene variance, spreading the budget
 * over MORE POSITIONS should beat concentrating it in fewer longer windows, because a 6-second window
 * is still mostly one scene. But a 6-second clip crosses more cuts than a 2-second one, so it samples
 * more scenes than its length suggests, and that could close the gap or reverse it.
 *
 * WALL TIME IS REPORTED TOO, because reliability per second of DECODE is only half the cost question —
 * seek overhead is paid per clip regardless of length.
 *
 * USAGE: node scripts/clip-length-compare.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
let seed = 20260827;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

function reliabilityCurve(file) {
  let units;
  try { units = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).units); } catch { return null; }
  if (units.length < 15) return null;
  const nClips = Math.min(...units.map((u) => u.clips.length));
  const out = { n: units.length, nClips, curve: {} };
  for (const d of DET) out.curve[d] = {};
  for (let k = 1; k <= Math.floor(nClips / 2); k += 1) {
    for (const d of DET) {
      const rs = [];
      for (let s = 0; s < 60; s += 1) {
        const A = []; const B = [];
        for (const u of units) {
          const idx = shuffle(u.clips.map((_, i) => i));
          const va = idx.slice(0, k).map((i) => u.clips[i][d]).filter((x) => x > 0);
          const vb = idx.slice(k, 2 * k).map((i) => u.clips[i][d]).filter((x) => x > 0);
          if (va.length < k || vb.length < k) continue;
          A.push(Math.log(mean(va))); B.push(Math.log(mean(vb)));
        }
        if (A.length >= 15) rs.push(corr(A, B));
      }
      out.curve[d][k] = rs.length ? med(rs) : NaN;
    }
  }
  return out;
}

const c2 = reliabilityCurve('data/clip-reliability.json');
const c6 = reliabilityCurve('data/clip-reliability-6s.json');
if (!c2 || !c6) { console.log('\n  need both runs; one is missing or too small\n'); process.exit(0); }

/* Restrict to the units measured in BOTH runs would be ideal, but the 6s run used a coarser stride
 * over the same deterministic ordering, so the samples overlap only partly. The comparison is
 * therefore BETWEEN SAMPLES, and the n of each is reported so the reader can weight it accordingly. */
console.log(`\n  2s run: ${c2.n} units x ${c2.nClips} clips     6s run: ${c6.n} units x ${c6.nClips} clips`);
console.log('  Different film samples (coarser stride at 6s), so treat small differences as noise.\n');

console.log('  RELIABILITY AT MATCHED TOTAL DECODED SECONDS\n');
console.log(`  ${'budget'.padEnd(10)} ${'scheme'.padEnd(12)} ${DET.map((d) => d.padStart(9)).join(' ')}`);
const rows = [
  ['12 sec', '6 x 2s', c2.curve, 6],
  ['12 sec', '2 x 6s', c6.curve, 2],
  ['24 sec', '4 x 6s', c6.curve, 4],
];
for (const [budget, scheme, curve, k] of rows) {
  const vals = DET.map((d) => {
    const v = curve[d][k];
    return (Number.isFinite(v) ? v.toFixed(3) : '—').padStart(9);
  });
  console.log(`  ${budget.padEnd(10)} ${scheme.padEnd(12)} ${vals.join(' ')}`);
}

console.log('\n  HEAD TO HEAD at 12 decoded seconds\n');
console.log(`  ${'detector'.padEnd(9)} ${'6 x 2s'.padStart(9)} ${'2 x 6s'.padStart(9)} ${'winner'.padStart(10)}`);
let shortWins = 0; let longWins = 0;
for (const d of DET) {
  const a = c2.curve[d][6]; const b = c6.curve[d][2];
  if (!Number.isFinite(a) || !Number.isFinite(b)) { console.log(`  ${d.padEnd(9)} insufficient`); continue; }
  const diff = a - b;
  const w = Math.abs(diff) < 0.03 ? 'tie' : (diff > 0 ? 'MORE SHORT' : 'FEWER LONG');
  if (w === 'MORE SHORT') shortWins += 1;
  if (w === 'FEWER LONG') longWins += 1;
  console.log(`  ${d.padEnd(9)} ${a.toFixed(3).padStart(9)} ${b.toFixed(3).padStart(9)} ${w.padStart(10)}`);
}

console.log('\n  WALL COST, from the runs themselves');
console.log('    2s recipe: 1.9 min/unit for 12 clips = 24 decoded sec  ->  0.079 min per decoded sec');
console.log('    6s recipe: 3.2 min/unit for  8 clips = 48 decoded sec  ->  0.067 min per decoded sec');
console.log('    Longer clips are ~15% cheaper per decoded second, because the seek is paid once per');
console.log('    clip regardless of length. That is a real but small saving.');

console.log('\n  VERDICT\n');
if (shortWins > longWins) {
  console.log(`  MORE SHORT CLIPS WIN (${shortWins} detectors to ${longWins}). The noise is scene`);
  console.log('  heterogeneity, so spreading a fixed budget over more POSITIONS beats concentrating it');
  console.log('  in longer windows — a 6-second clip is still largely one scene. The ~15% saving per');
  console.log('  decoded second does not repay the reliability lost, so KEEP THE 2-SECOND RECIPE and');
  console.log('  spend any extra budget on more clips.');
} else if (longWins > shortWins) {
  console.log(`  FEWER LONG CLIPS WIN (${longWins} to ${shortWins}). Longer windows cross more cuts than`);
  console.log('  their length suggests, so they sample more scenes than expected AND cost ~15% less per');
  console.log('  decoded second. A re-measure should use longer clips, which makes 11.42\'s 33-hour');
  console.log('  figure an overestimate — recost it before deciding.');
} else {
  console.log('  TIE. Clip length does not matter much at a fixed decode budget, so the ~15% wall-cost');
  console.log('  saving from longer clips is the only reason to prefer them. It does not change');
  console.log('  11.42\'s conclusion that the re-measure is a poor trade.');
}
console.log('');
