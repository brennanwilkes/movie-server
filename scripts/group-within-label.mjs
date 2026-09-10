/* DOES P SEE PROVENANCE THAT THE SOURCE LABEL CANNOT? — and is the shrinkage floor too low?
 *
 * WHY THIS MATTERS RIGHT NOW. 11.37 set the shipped shrinkage to the between-SOURCE-LABEL variance
 * share of P (~0.10) and called it a LOWER bound, because labels are coarse: two files both labelled
 * Bluray can differ by release group, encoder preset and generation, and all of that real provenance
 * sits inside the within-label term where the floor cannot see it. If that hidden variance is large,
 * the floor is too conservative and the shipped adjustment is too small.
 *
 * THE TEST, AND WHY YIFY IS THE RIGHT INSTRUMENT. YIFY/YTS is the most aggressive re-encoder in
 * common circulation: small files, heavy preprocessing, single pass. Its releases are nonetheless
 * LABELLED Bluray, because that is what they were sourced from. So comparing YIFY against other
 * Bluray-labelled units is a within-label provenance contrast — exactly the variance the floor
 * misses. n = 61 is enough to say something.
 *
 * PRE-REGISTERED, from what YIFY demonstrably does rather than from the data:
 *     YIFY should sit HIGHER in P (more re-encode damage) than other Bluray-labelled units.
 *     A null would mean either P cannot see within-label provenance, or YIFY is not as different as
 *     its reputation — and those are not separable here.
 *     YIFY sitting LOWER would be evidence against P outright, and should be treated as such.
 *
 * 11.17's WARNING, WHICH APPLIES AND IS NOT FATAL. 65% of this library was renamed by *arr to
 * "Title (Year) Bluray-1080p.mkv", destroying the group tag, and the survivors are heavily skewed to
 * small-file re-encoders (YIFY, LAMA, RARBG, ETRG). That is a restricted range, so any variance
 * component computed from groups is itself a LOWER bound. Since the question is whether the floor
 * should RISE, a lower bound is the useful direction — it can only strengthen the conclusion.
 *
 * THE VARIANCE COMPONENT IS COMPUTED UNBIASED. Raw between-group variance is inflated by sampling
 * noise when groups are small, which would manufacture exactly the result being looked for. The
 * standard one-way ANOVA estimator (MSB - MSW) / n_bar removes it, and it is allowed to go negative;
 * a negative estimate is reported as zero-with-a-note rather than clipped silently.
 *
 * USAGE: node scripts/group-within-label.mjs
 */
import fs from 'fs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/* Tokens that look like a group to a naive trailing-dash regex but are not. *arr renames strip the
 * real tag, and what is left after the last dash is often a resolution or codec. Without this filter
 * "1080p" is the largest "group" in the library at n=567. */
const NOT_A_GROUP = /^(1080p|720p|2160p|480p|x264|x265|h264|h265|hevc|avc|bluray|web|webdl|webrip|hdtv|dvd|remux|aac|ac3|dts|mkv|mp4|proper|repack|extended|uncut|internal)$/i;
const groupOf = (p) => {
  const base = (p || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/-([A-Za-z0-9]{2,20})$/);
  if (!m) return null;
  return NOT_A_GROUP.test(m[1]) ? null : m[1];
};
/* YIFY tags itself several ways and often WITHOUT a dash ("...x264.YIFY.mp4"), so the trailing-dash
 * parse misses most of them. Matched separately on the whole filename. */
const isYify = (p) => /\b(yify|yts)\b/i.test((p || '').split('/').pop());

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const ds = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
const rows = [];
for (const r of ds.rows || []) {
  const u = P.units[r.key];
  if (!u || !r.path) continue;
  rows.push({ key: r.key, title: r.title, path: r.path, source: u.source, P: u.P,
    group: isYify(r.path) ? 'YIFY' : groupOf(r.path) });
}
console.log(`\n  ${rows.length} units with both a P and a path\n`);

/* ---- 1. THE PRE-REGISTERED CONTRAST: YIFY vs other Bluray ---- */
const bluray = rows.filter((r) => /Bluray/i.test(r.source || ''));
const yify = bluray.filter((r) => r.group === 'YIFY');
const otherBlu = bluray.filter((r) => r.group !== 'YIFY');
console.log('  1. WITHIN-LABEL CONTRAST — YIFY vs other Bluray-labelled units\n');
console.log(`  ${'group'.padEnd(20)} ${'n'.padStart(5)} ${'mean P'.padStart(9)} ${'sd'.padStart(7)}`);
console.log(`  ${'YIFY (Bluray)'.padEnd(20)} ${String(yify.length).padStart(5)} ${mean(yify.map((r) => r.P)).toFixed(3).padStart(9)} ${sd(yify.map((r) => r.P)).toFixed(3).padStart(7)}`);
console.log(`  ${'other Bluray'.padEnd(20)} ${String(otherBlu.length).padStart(5)} ${mean(otherBlu.map((r) => r.P)).toFixed(3).padStart(9)} ${sd(otherBlu.map((r) => r.P)).toFixed(3).padStart(7)}`);
if (yify.length >= 15 && otherBlu.length >= 15) {
  const diff = mean(yify.map((r) => r.P)) - mean(otherBlu.map((r) => r.P));
  const se = Math.sqrt(sd(yify.map((r) => r.P)) ** 2 / yify.length + sd(otherBlu.map((r) => r.P)) ** 2 / otherBlu.length);
  console.log(`\n  difference ${diff.toFixed(3)} +- ${se.toFixed(3)}   t = ${(diff / se).toFixed(2)}`);
  console.log(`  pre-registered direction: YIFY HIGHER.  ${diff > 0 ? 'CORRECT' : 'WRONG DIRECTION'}`);
  /* Scale it against the thing that gives the number meaning. */
  const perGen = 0.1121;
  console.log(`  in generations (0.1121 P-sd each): ${(diff / perGen).toFixed(2)} generations' worth`);
  console.log(`  for comparison, the whole WEB-vs-Bluray label gap is ${(P.anchor.gap / perGen).toFixed(2)} generations`);
} else {
  console.log('\n  groups too small for a contrast');
}

/* ---- 2. HOW MUCH VARIANCE DOES GROUP ADD *INSIDE* A LABEL? ---- */
console.log('\n  2. VARIANCE COMPONENT FOR GROUP, computed WITHIN Bluray only\n');
const byGroup = {};
for (const r of bluray) if (r.group) (byGroup[r.group] ||= []).push(r.P);
const usable = Object.entries(byGroup).filter(([, v]) => v.length >= 3);
console.log(`  ${usable.length} groups with n>=3, covering ${usable.reduce((s, [, v]) => s + v.length, 0)} of ${bluray.length} Bluray units`);
console.log(`  ${'group'.padEnd(14)} ${'n'.padStart(4)} ${'mean P'.padStart(9)}`);
for (const [g, v] of usable.sort((a, b) => mean(b[1]) - mean(a[1]))) {
  console.log(`  ${g.padEnd(14)} ${String(v.length).padStart(4)} ${mean(v).toFixed(3).padStart(9)}`);
}
if (usable.length >= 3) {
  const k = usable.length;
  const N = usable.reduce((s, [, v]) => s + v.length, 0);
  const grand = mean(usable.flatMap(([, v]) => v));
  const SSB = usable.reduce((s, [, v]) => s + v.length * (mean(v) - grand) ** 2, 0);
  const SSW = usable.reduce((s, [, v]) => s + v.reduce((t, x) => t + (x - mean(v)) ** 2, 0), 0);
  const MSB = SSB / (k - 1);
  const MSW = SSW / (N - k);
  /* n_bar for unequal group sizes — the standard correction, not the plain mean of sizes. */
  const sumN2 = usable.reduce((s, [, v]) => s + v.length ** 2, 0);
  const nBar = (N - sumN2 / N) / (k - 1);
  const comp = (MSB - MSW) / nBar;
  console.log(`\n  MSB ${MSB.toFixed(4)}   MSW ${MSW.toFixed(4)}   n_bar ${nBar.toFixed(2)}   F ${(MSB / MSW).toFixed(2)}`);
  console.log(`  unbiased between-group variance component: ${comp.toFixed(4)}`
    + `${comp < 0 ? '  (NEGATIVE -> no detectable group effect; read as 0)' : ''}`);
  const total = sd(rows.map((r) => r.P)) ** 2;
  const share = Math.max(0, comp) / total;
  console.log(`  as a share of P's total variance: ${share.toFixed(4)}  -> sd ${Math.sqrt(share).toFixed(3)} P-sd`);
  console.log(`\n  SHIPPED FLOOR (between source label): ${P.shrink ? P.shrink.floor.toFixed(3) : 'n/a'} P-sd`);
  if (P.shrink && Math.sqrt(share) > 0) {
    /* Label and group are nested, so their variance components ADD — group variance measured WITHIN
     * Bluray is by construction not part of the between-label term. */
    const combined = Math.sqrt(P.shrink.floor ** 2 + share);
    console.log(`  label + group combined (they are nested, so components add): ${combined.toFixed(3)} P-sd`);
    console.log(`  ceiling from four-generation plausibility:                    ${P.shrink.ceiling.toFixed(3)} P-sd`);
    console.log(`  ${combined > P.shrink.ceiling ? '  -> the combined estimate EXCEEDS the physical ceiling; the ceiling binds'
      : '  -> still inside the physical ceiling'}`);
  }
}
console.log('\n  READ IT THIS WAY: this is a LOWER bound on a LOWER bound — 65% of the library lost its');
console.log('  group tag to *arr renaming (11.17), and the survivors skew to small-file re-encoders. If');
console.log('  group adds real variance here, the shipped floor is too conservative and the honest');
console.log('  shrinkage sits nearer the physical ceiling.\n');
