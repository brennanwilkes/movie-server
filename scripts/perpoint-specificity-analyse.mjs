/* LEG C ANALYSIS — does gblur move perPoint along the CONTENT line or the STARVATION line?
 *
 * THE PRE-REGISTRATION, restated so it cannot drift after seeing the data. Both softening and
 * starvation reduce complexity, so perPoint WILL move under gblur. The question is only which
 * direction it moves along, per unit of complexity actually removed:
 *     STARVATION direction   -0.0897 +- 0.0028   within-film, n=24   (E.8.3)
 *     CONTENT direction      -0.0254 +- 0.0101   across films, n=8   (E.8.3)
 * Compute d perPoint / d log(cx20) across the gblur arms, WITHIN each film, and place it between
 * those two references:
 *     near -0.025                     perPoint SEPARATES soft content from starved content.
 *                                     The detail-loss instrument is real and Leg C passes.
 *     >= 70% of the starvation slope  DEAD. perPoint cannot tell soft from starved, it is a
 *                                     softness detector, and the covering set stays permanently
 *                                     incomplete — which must then be written into section 7 as a
 *                                     named blindness, not left implicit.
 *
 * WHY WITHIN-FILM. Each film supplies its own three arms on THE SAME CLIPS, so content, bitrate,
 * codec and scene selection are all exactly constant and only the applied blur differs. That is the
 * same discipline the starvation direction was measured with, and it is what makes the two numbers
 * comparable at all. Pooling across films instead would reintroduce the between-film variation the
 * content direction already describes.
 *
 * A GUARD BEFORE ANY DIRECTION IS COMPUTED: if gblur does not measurably reduce cx20, there is no
 * complexity drop to normalise by and the ratio is noise over noise. Reported per film first.
 *
 * USAGE: node scripts/perpoint-specificity-analyse.mjs
 */
import fs from 'fs';

const STARVE = -0.0897; const STARVE_SE = 0.0028;
const CONTENT = -0.0254; const CONTENT_SE = 0.0101;
const KILL_FRACTION = 0.70;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const slope = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let n = 0; let d = 0;
  for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
};

let raw;
try { raw = JSON.parse(fs.readFileSync('data/perpoint-specificity.json', 'utf8')); } catch {
  console.log('\n  data/perpoint-specificity.json not written yet — run scripts/perpoint-specificity.js\n');
  process.exit(0);
}
const SIGMAS = raw.sigmas;
const units = Object.values(raw.units);
console.log(`\n  ${units.length} films, sigmas ${SIGMAS.join('/')}, ${raw.clips} clips each\n`);
if (units.length < 5) { console.log('  need 5+ films\n'); process.exit(0); }

/* ---- guard: did gblur actually remove complexity? ---- */
console.log(`  ${'film'.padEnd(28)} ${SIGMAS.map((s) => `pp@${s}`.padStart(9)).join('')}   cx20 drop`);
const rows = [];
for (const u of units) {
  const xs = []; const ys = [];
  for (const s of SIGMAS) {
    const a = u.arms[s] ?? u.arms[String(s)];
    if (!a || !(a.cx20 > 0) || !Number.isFinite(a.perPoint)) { xs.length = 0; break; }
    xs.push(Math.log(a.cx20)); ys.push(a.perPoint);
  }
  if (xs.length !== SIGMAS.length) continue;
  const drop = 1 - Math.exp(xs[xs.length - 1] - xs[0]);
  rows.push({ t: u.title, xs, ys, drop, b: slope(xs, ys) });
  console.log(`  ${u.title.slice(0, 27).padEnd(28)} ${ys.map((v) => v.toFixed(4).padStart(9)).join('')}   `
    + `${(100 * drop).toFixed(1)}%`);
}
const usable = rows.filter((r) => r.drop > 0.02 && Number.isFinite(r.b));
console.log(`\n  gblur removed >2% of cx20 on ${usable.length}/${rows.length} films`);
if (usable.length < 5) {
  console.log('\n  *** gblur did not remove enough complexity to normalise by. The ratio would be');
  console.log('  noise over noise. Re-run with larger sigmas before reading anything. ***\n');
  process.exit(0);
}

const bs = usable.map((r) => r.b);
const B = med(bs);
const se = sd(bs) / Math.sqrt(bs.length);
console.log(`\n  *** d perPoint / d log(cx20) UNDER gblur ***\n`);
console.log(`    measured (within film)   median ${B.toFixed(4)}   mean ${mean(bs).toFixed(4)} +- ${se.toFixed(4)}   n ${bs.length}`);
console.log(`    STARVATION reference     ${STARVE.toFixed(4)} +- ${STARVE_SE.toFixed(4)}`);
console.log(`    CONTENT reference        ${CONTENT.toFixed(4)} +- ${CONTENT_SE.toFixed(4)}`);
const fracStarve = B / STARVE;
console.log(`\n    as a fraction of the starvation slope   ${(100 * fracStarve).toFixed(0)}%`);
console.log(`    as a fraction of the content slope      ${(100 * (B / CONTENT)).toFixed(0)}%`);

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
if (fracStarve >= KILL_FRACTION) {
  console.log(`    *** DEAD. *** gblur moves perPoint ${(100 * fracStarve).toFixed(0)}% as much as starvation does for the`);
  console.log('    same complexity drop, against a pre-registered kill line of 70%. perPoint cannot');
  console.log('    distinguish soft content from destroyed detail: it is a SOFTNESS detector.');
  console.log('    CONSEQUENCE: detail loss is not measurable no-reference in this library by any');
  console.log('    route currently known, the covering set is PERMANENTLY INCOMPLETE, and that must');
  console.log('    be written into section 7 as a named blindness beside GRAIN and SOURCE TIER —');
  console.log('    not left implicit in 9.1. It also means E.10.1 stands unresolved: every');
  console.log('    calibration stays biased toward "fewer bits needed" with no counterweight.');
} else if (Math.abs(B - CONTENT) < 2 * Math.sqrt(se ** 2 + CONTENT_SE ** 2)) {
  console.log('    PASSES, and cleanly. gblur moves perPoint along the CONTENT line, statistically');
  console.log('    indistinguishable from how films that merely differ in content behave, and far');
  console.log('    from the starvation direction. perPoint SEPARATES soft photography from destroyed');
  console.log('    detail — the discrimination nothing else in this project can make.');
  console.log('    NEXT: it is an instrument, not yet a term in the score. It still needs the content');
  console.log('    line measured on more than 8 films before anything is weighted by it.');
} else {
  console.log(`    INTERMEDIATE at ${(100 * fracStarve).toFixed(0)}% of starvation — below the 70% kill line but not on the`);
  console.log('    content line either. perPoint carries SOME specificity but is partly confounded.');
  console.log('    Do not adopt. The useful next step is to find what fraction of its response is');
  console.log('    softness and correct for it, which needs the content line at n >> 8 first.');
}
console.log('');
