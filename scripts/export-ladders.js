#!/usr/bin/env node
/* MERGE EVERY LADDER RUN INTO ONE FILE THE LAB CAN READ.
 *
 * The lab otherwise takes everything from GET /api/probe/dataset, deliberately, so it can never
 * drift from the controller. Ladder slopes are the one thing that does not live there: they come
 * from `scripts/banding-ladder.js`, which is an offline experiment, not a nightly job. Rather than
 * teach the controller about an experiment, this writes a static file into bpp-lab/public/ and the
 * lab fetches it. Re-run after any ladder run.
 *
 * THE ONE TRAP THIS FILE MUST NOT HIDE. Ladder ABSOLUTES are not comparable between runs — clip
 * offsets are T = start + span*k/CLIPS, so changing the clip count changes which scenes are sampled,
 * and banding is violently scene-dependent (The Big Sleep read 0.0859 at level 1.0 with 4 clips and
 * 0.00716 with 3 — twelve times apart, same film, same level, same encoder). Only RATIOS within one
 * run are meaningful, which is exactly why the fitted SLOPE travels between runs and the LEVEL does
 * not. So each film carries `run`, and any cross-film comparison of levels must use the nightly
 * banding job's reading (which samples every film identically), never `levelAt1`.
 *
 * Measured 2026-08-25, and it matters: predicting |S| from the ladder's own level gives R^2 0.251;
 * predicting it from the nightly level gives R^2 0.363. Same films, same slopes — the difference is
 * purely that the nightly reading is comparable across films and the ladder's own is not.
 *
 * USAGE: node scripts/export-ladders.js
 */
const fs = require('fs');
const path = require('path');

// Later files win, and the order matters: the grain runs re-measure films that earlier runs covered
// with fewer artifacts, and a film with four curves must not be overwritten by its three-curve self.
const SRC = ['banding-ladder-v3.json', 'artifact-ladder-v1.json', 'artifact-ladder-blindspot.json',
  'artifact-ladder-underscored.json', 'artifact-ladder-wideA.json', 'artifact-ladder-wideB.json',
  'artifact-ladder-grain.json', 'artifact-ladder-grain2.json', 'artifact-ladder-day2.json', 'artifact-ladder-flagged.json'];
const OUT = path.join(__dirname, '..', 'bpp-lab', 'public', 'ladders.json');

const films = new Map();
for (const name of SRC) {
  const p = path.join(__dirname, '..', 'data', name);
  let d;
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  for (const f of d.films || []) {
    if (!f.fit) continue;
    const at1 = (f.points || []).find((q) => q.level === 1);
    if (!at1) continue;
    // THE LOSSLESS RUNG IS A PHYSICAL BOUND, not a diagnostic. It is the film's own banding with no
    // compression added by us, so it is what the curve tends to as bits -> infinity. A film cannot
    // band LESS than its own lossless extract, which makes it the floor for any anchor level — and
    // the nightly reading does sometimes fall below it (The Godfather: nightly 0.104, lossless 0.391)
    // because the two sample different scenes. Blending on the lower of those is what manufactures
    // impossible headroom, so the number has to travel with the film.
    const ll = (f.points || []).find((q) => q.lossless);
    // Later runs win: they measure more artifacts off the same decode.
    films.set(f.key, {
      key: f.key,
      title: f.title,
      run: name,
      lossless: ll ? ll.cambi : null,
      // The grain axis needs its own lossless anchor, and for a different reason than banding's. It
      // is not a physical bound here, it is the DENOMINATOR: grain retention is only comparable
      // between films as a ratio to the film's own ungraded grain, because the raw residual measures
      // how much grain a film HAS, not how much it lost. Without this the axis would rank 12 Angry
      // Men above Arrival on content rather than on damage.
      grainLossless: ll && ll.grain != null ? ll.grain : null,
      levelAt1: at1.cambi,
      blockAt1: at1.block ?? null,
      blurAt1: at1.blur ?? null,
      grainAt1: at1.grain ?? null,
      S: f.fit.S,
      r2: f.fit.r2,
      n: f.fit.n,
      sBlock: f.fitBlock ? f.fitBlock.S : null,
      sBlur: f.fitBlur ? f.fitBlur.S : null,
      sGrain: f.fitGrain ? f.fitGrain.S : null,
      r2Grain: f.fitGrain ? f.fitGrain.r2 : null,
      points: (f.points || []).filter((q) => q.level).map((q) => ({
        level: q.level, cambi: q.cambi, block: q.block ?? null, blur: q.blur ?? null,
        grain: q.grain ?? null,
      })),
    });
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generated: Date.now(),
  note: 'Slopes travel between runs; levels do not. Use the nightly banding reading for cross-film level.',
  films: [...films.values()],
}, null, 1));
console.log(`wrote ${OUT} — ${films.size} films with a measured slope`);
for (const f of films.values()) {
  console.log(`  ${f.title.slice(0, 34).padEnd(36)} S ${f.S.toFixed(2).padStart(6)}  r2 ${f.r2.toFixed(3)}  (${f.run})`);
}
