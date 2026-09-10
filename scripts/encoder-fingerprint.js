#!/usr/bin/env node
/* THE ENCODER FINGERPRINT — the finer provenance marker 11.50 wrongly said does not exist.
 *
 * THE CLAIM BEING CORRECTED. 11.50 states "a finer provenance marker does not exist" and uses that to
 * justify leaning on the WEB/Bluray source tag as the only observable field contrast. That is FALSE.
 * x264 and x265 both write a version-and-options string into the bitstream (an SEI user-data unquoted
 * NAL for x264, the "x265 (build ...)" banner for x265), and containers carry a writing-library tag.
 * A spot check found these survive on about 92.5% of the library.
 *
 * WHY IT MATTERS, TWICE OVER.
 *   1. THE STRUCTURAL GAP (task 82). Four provenance axes are validated in controlled conditions —
 *      encoder, generations, preprocessing, bits — but the field has only ONE observable contrast to
 *      test them against, the source tag, and 11.44 shows that contrast is dominated by bits. An
 *      encoder identity read straight off the bitstream is a SECOND field contrast, and an
 *      independent one: it is a fact about the last encode, not about the release channel.
 *   2. PROVENANCE SHARE. provShare = 0.075 is the fraction of P attributable to provenance rather
 *      than content, and it is currently an estimate. A directly observed encoder identity lets that
 *      fraction be MEASURED as variance explained rather than assumed — and provShare multiplies
 *      every shipped adjustment, so it is load-bearing.
 *
 * WHAT IS EXTRACTED, in decreasing order of strength:
 *   encoder family + version   x264 core 148 vs core 164 is a real, dated difference in the encoder
 *   crf / bitrate mode         the options string usually carries crf= or bitrate=, i.e. how it was
 *                              targeted, which is exactly the provenance the source tag cannot see
 *   psy / aq / ref / bframes   settings that change artifact signatures in known directions
 *   writing library            container-level, weaker (a remux rewrites it) but nearly universal
 *
 * *** THE TRAP, STATED BEFORE ANY ANALYSIS. *** Encoder version correlates with YEAR, and year
 * correlates with content, resolution and bitrate. A raw association between fingerprint and P is
 * therefore NOT evidence the fingerprint carries provenance. It has to be read against the same
 * residual surface everything else is read against, and checked for degeneracy with year and bpp the
 * way gridRatio was checked before it was falsified at n=101. This script only EXTRACTS; it draws no
 * conclusion.
 *
 * READ-ONLY. Reads a bounded prefix of each file and never writes to media.
 * USAGE: node scripts/encoder-fingerprint.js [--bytes 24] [--limit 0]
 */
const fs = require('fs');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const MB = Number(val('--bytes', 24));
const LIMIT = Number(val('--limit', 0));
const OUT = val('--out', `${__dirname}/../data/encoder-fingerprint.json`);

/* The x264 SEI rides with the first keyframe, and the x265 banner sits near the start of the stream.
 * A bounded prefix catches both without reading terabytes; files that miss are reported as such
 * rather than silently counted as "no encoder", because that distinction is the whole coverage claim. */
function scan(file, mb) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, mb * 1024 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    const s = buf.toString('latin1');
    const out = {};

    /* The capture must be long enough to reach the END of the options list: x264 writes the rate
     * control keys (rc=, crf=, qcomp=, qpmin=) last, after ~900 characters of analysis settings, so a
     * short window silently loses the single most informative field. */
    const x264 = /x264 - core (\d+)([^\0]{0,1600})/.exec(s);
    if (x264) { out.family = 'x264'; out.build = Number(x264[1]); out.opts = x264[2].replace(/\0.*$/s, '').slice(0, 1500); }
    const x265 = /x265 \(build (\d+)\)[^\0]{0,200}/.exec(s);
    if (!x264 && x265) { out.family = 'x265'; out.build = Number(x265[1]); }
    const x265v = /x265 \[info\]: HEVC encoder version ([0-9.+a-z-]+)/.exec(s);
    if (x265v) { out.family = out.family || 'x265'; out.version = x265v[1]; }
    /* the x265 options line is written separately from the version banner */
    const x265o = /x265 \[info\]: (?:tools|Encode settings): ([^\r\n\0]{0,400})/.exec(s);
    if (x265o) out.opts = (out.opts ? `${out.opts} ` : '') + x265o[1];

    for (const [k, re] of [['writingLib', /(?:writing(?:_| )?(?:library|app)|encoder)[\s:=]*([A-Za-z0-9_.\- ()+]{3,60})/i],
      ['handbrake', /(HandBrake [0-9.]+)/], ['ffmpegLavc', /(Lavf[0-9.]+)/]]) {
      const m = re.exec(s); if (m) out[k] = m[1].trim();
    }
    if (out.opts) {
      /* Builds differ on hyphen vs underscore (mod builds use underscores throughout), so every key
       * is matched tolerantly. Getting this wrong reads as "the field is absent" rather than as a
       * parse failure, which is the more dangerous of the two. */
      const g = (re) => { const m = re.exec(out.opts); return m ? Number(m[1]) : null; };
      const t = (re) => (re.exec(out.opts) || [])[1] || null;
      out.rc = t(/\brc=([a-z0-9]+)/);
      out.crf = g(/\bcrf=([0-9.]+)/);
      out.bitrateOpt = g(/\bbitrate=([0-9.]+)/);
      out.qp = g(/\bqp=([0-9.]+)/);
      out.qcomp = g(/\bqcomp=([0-9.]+)/);
      out.ref = g(/\bref=(\d+)/);
      out.bframes = g(/\bbframes=(\d+)/);
      out.subme = g(/\bsubme=(\d+)/);
      out.trellis = g(/\btrellis=(\d+)/);
      out.aqMode = g(/\baq[-_]mode=(\d+)/);
      out.aq = g(/\baq[-_]strength=([0-9.]+)/);
      out.psyrd = t(/\bpsy[-_]rd=([0-9.:]+)/);
      out.deblock = t(/\bdeblock=([0-9:.-]+)/);
      out.me = t(/\bme=([a-z]+)/);
      out.tune = t(/\btune=([a-z]+)/);
    }
    out.scannedMB = Math.round(n / 1048576);
    out.truncated = n < size;
    return out;
  } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* */ } }
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  let rows = ds.rows.filter((r) => r.path);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`${rows.length} units, scanning first ${MB}MB of each\n`);

  const units = {};
  let fam = 0; let opt = 0; let crf = 0; let none = 0; let unread = 0;
  for (const r of rows) {
    const f = scan(r.path, MB);
    if (f == null) { unread += 1; continue; }
    units[r.key] = { title: r.title, bpp: r.bpp, cxEff: r.cxEff, codec: r.codec, bppPlus: r.bppPlus,
      year: r.year ?? null, source: r.source ?? null, ...f };
    if (f.family) fam += 1; else none += 1;
    if (f.opts) opt += 1;
    if (f.crf != null) crf += 1;
    if ((fam + none) % 100 === 0) process.stdout.write(`  ${fam + none}/${rows.length}  family ${fam}\r`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), scannedMB: MB, units }, null, 1));

  const n = Object.keys(units).length;
  console.log(`\n\n  COVERAGE (extraction only — no claim is made here about what it means)\n`);
  console.log(`    files read              ${n}${unread ? `   (${unread} unreadable)` : ''}`);
  console.log(`    encoder family found    ${fam}  ${(100 * fam / Math.max(1, n)).toFixed(1)}%`);
  console.log(`    options string found    ${opt}  ${(100 * opt / Math.max(1, n)).toFixed(1)}%`);
  console.log(`    crf= recovered          ${crf}  ${(100 * crf / Math.max(1, n)).toFixed(1)}%`);
  console.log(`    no encoder in prefix    ${none}`);
  const byFam = {};
  for (const u of Object.values(units)) { const k = u.family || '(none)'; byFam[k] = (byFam[k] || 0) + 1; }
  console.log('');
  for (const [k, v] of Object.entries(byFam).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(10)} ${v}`);
  console.log(`\nwrote ${OUT}`);
  console.log('\n  NEXT: this is raw extraction. Encoder version correlates with year, and year with');
  console.log('  content and bitrate, so a raw association with P proves nothing. It must be read');
  console.log('  against the residual surface and checked for degeneracy with year and bpp.');
})();
