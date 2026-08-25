'use strict';
// Part 2/9 — DOM + formatting helpers: $/$$, esc() (real HTML escaping for
// untrusted torrent titles), sameHost(), and the fmt* formatters.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Real HTML escaping — every esc() call site interpolates into innerHTML or a quoted
// attribute (data-hash/data-title/aria-label). Torrent/release names are untrusted input:
// a `"` broke attribute parsing (dead buttons), `<`/`>` mangled rows, and markup executed.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// ── PICTURE QUALITY: bits per pixel per frame ────────────────────────────────────────────────
// REPLACED the old raw-Mbps bands (>=15 purple / 8 green / 4 orange) on 2026-08-01. Measured
// against the live library those bands put 82.7% of movies in the worst colour, which is not a
// signal, it is a constant. Mbps is not comparable between two files here:
//   * only 171 of 860 movies are a full 1920x1080 — the rest are letterboxed to heights from
//     528 to 1076, so the same Mbps buys visibly more on a scope film
//   * 24 vs 30 fps is a 25% difference in bits per frame at identical Mbps
//   * HEVC needs roughly 55% of H.264's bits for the same picture
// bpp = videoBitrate / (w * h * fps), HEVC scaled x1.8, collapses all three into one number.
//
// THE BAND IS COMPUTED SERVER-SIDE (arr-inspect.js bppBand) and arrives on the payload as
// `bppBand`. This function is a RENDERER, not a second classifier — duplicating the thresholds
// in the browser is exactly the drift that made the Library and Audit tabs disagree before.
// The band→dots map below is presentation only.
//
// What the colours mean, agreed with Brennan 2026-08-01 after measuring the playback chain:
//   purple (wow)  >=0.20  beyond what the old native-720p projector could resolve — this is the
//                         band that starts to matter now that projector is dead (2026-08-19) and
//                         a 1080p one is replacing it
//   green  (ok)   >=0.13  good enough for the film to look its best on CURRENT hardware
//   orange (warn) >=0.08  diminished even today; may still be fine, that is the human call
//   red    (bad)   <0.08  worse than that. The YTS family sits around 0.05.
const BPP_HELP = 'BPP+ — bits per pixel per frame, indexed so 100 is exactly what a film needs to '
  + 'look its best on this hardware. 100 is measured PER FILM: the nightly CRF probe encodes eight '
  + 'samples at a fixed quality, so 100 means "as many bits as a visually transparent encode of THIS '
  + 'film", which costs Casablanca four times what it costs Blade Runner 2049. Normalised for '
  + 'resolution, frame rate and codec (HEVC x1.6), so it is comparable across the whole library. The '
  + 'scale is square-rooted, so it tracks picture rather than bits: 200 is roughly half as much '
  + 'visible error as 100, and 50 is roughly double. 125+ is more than the projector can resolve (it '
  + 'starts to pay off after a hardware upgrade); under 75 is compromised.';
// CONFIDENCE, carried by typography — Brennan, 2026-08-06: "showing estimated bpp+ (unprobed) with
// italics would be good, while confirmed ones can be bolded."
//
// It has to be shown somehow (DESIGN-CRF-PROBE.md §6): a value whose denominator came from five other
// films is not the same claim as one measured from this film, and rendering them identically is fake
// precision. Weight/slope is the right channel because the badge's COLOUR is already spoken for by
// quality — confidence is a different axis and should not compete for the same signal. Earlier
// attempts at a leading `~` and a dashed underline both read as an error marker rather than a
// qualifier.
const BPP_EST_HELP = 'Estimated — this film has not been probed yet, so 100 is inferred from films '
  + 'that have (same series, then same source, then the library median). The colour and ranking are '
  + 'usable; the exact number will shift once this title is measured.';
const BPP_MEAS_HELP = 'Measured — this film has been probed, so 100 is what a visually transparent '
  + 'encode of THIS film actually costs.';
// 'measured:series' is a WHOLE SHOW, aggregated from its own measured seasons (see
// seriesComplexity() in lib/probe.js). It counts as MEASURED — the show really was probed, every
// season of it — because rendering it italic told the opposite of the truth: that it had never been
// probed at all. The tooltip below still says it is an aggregate, so the distinction is not lost,
// it just stops being carried by a glyph that means something else.
const MEASURED_BASES = ['measured', 'measured:stale', 'measured:series'];
const bppEstimated = (basis) => !!basis && !MEASURED_BASES.includes(basis);
const bppMeasured = (basis) => MEASURED_BASES.includes(basis);
const BPP_SERIES_HELP = 'This is the whole show: 100 is the episode-weighted average of what a '
  + 'transparent encode of each of its seasons costs. Individual seasons can differ — a film-stock '
  + 'first season and a digital revival are not the same picture.';
// A one-word name per band, used ONLY in tooltips and aria-labels — never rendered as a row
// label. Brennan, 2026-08-01: colour and number carry the meaning; prose does not.
const BPP_WORD = { wow: 'beyond what this display can show', ok: 'looks its best on current hardware',
  warn: 'diminished today', bad: 'compromised' };
// THE QUALITY BAR. A full-height coloured rule down the left edge of the row, replacing the four
// dots that shipped earlier the same day — Brennan: "I dont like the dots... perhaps a vertical
// bar filling up on the far left of their row, taking the whole height (minus some margin)."
// It reads as a column when you scroll, which the dots never did because they sat inline with a
// variable-length title. Returns the row's class list, so the colour is a property of the ROW
// rather than another badge competing for space.
const qbarCls = (band) => (band ? ` qbar q-${band}` : '');
// The number. BPP+ (see bppIndex in lib/arr-inspect.js) rather than raw bpp: 0.033 vs 0.043 is
// unreadable, 25 vs 33 is not. `bppPlus` is computed server-side and arrives on the payload.
// `basis` is optional and arrives on the payload as `cxBasis` — see bppTargetFor() in
// lib/arr-inspect.js. Absent (an older cached verdict, or a payload that predates the probe) renders
// exactly as before, so no row can break for want of it.
// PROVISIONAL MARK. BPP+ divides by a measured complexity, and that measurement has a standard
// error — so a 94 pinned to +/-3% and a 94 pinned to +/-25% used to print identically. Brennan,
// 2026-08-17: "if uncertainty is above a certain threshold we do bpp+* instead of bpp+... on hover
// show a tooltip with the actual number." So: one asterisk, nothing else in the row, and the figure
// lives in the tooltip. This deliberately does NOT reopen "we dont render error bars or hidden stats
// #s" — the default rendering is unchanged, and the mark appears only when the number is loose
// enough that acting on it would be a mistake.
//
// `rse` arrives as `bppRSE` on the payload and is ALREADY the error of the index (the server halves
// the complexity error, because BPP+ takes a square root). Null means "no error bar available",
// which is most of the library today and renders bare — marking a thousand films provisional would
// make the mark meaningless.
const BPP_RSE_LOOSE = 0.10;
const bppSpan = (plus, band, basis, rse) => {
  if (plus == null) return '';
  const est = bppEstimated(basis);
  const meas = bppMeasured(basis);
  const loose = typeof rse === 'number' && rse > BPP_RSE_LOOSE;
  let tip = est ? `${BPP_HELP}\n\n${BPP_EST_HELP}`
    : (meas ? `${BPP_HELP}\n\n${basis === 'measured:series' ? BPP_SERIES_HELP : BPP_MEAS_HELP}` : BPP_HELP);
  if (loose) {
    const pct = Math.round(rse * 100);
    tip += `\n\nPROVISIONAL (*): this film's complexity is still loosely measured, so the score is`
      + ` roughly ${plus} +/-${pct}% (about ${Math.round(plus * (1 - rse))}-${Math.round(plus * (1 + rse))}).`
      + ` The nightly probe revisits the least certain films and pools their samples, so it tightens`
      + ` on its own. Treat it as a hint, not a verdict.`;
  }
  // Neither class when basis is absent (an older cached verdict, or a payload predating the probe) —
  // the badge then renders exactly as it always did rather than claiming a confidence we do not have.
  const cls = est ? ' est' : (meas ? ' meas' : '');
  return `<span class="mbps ${band || ''}${cls}${loose ? ' prov' : ''}" title="${esc(tip)}"`
    + ` aria-label="${esc(BPP_WORD[band] || '')}${est ? ', estimated' : (meas ? ', measured' : '')}`
    + `${loose ? ', provisional' : ''}">`
    + `${plus}${loose ? '<sup class="prov-mark">*</sup>' : ''}<small>bpp+</small></span>`;
};

// ── AUDIO ────────────────────────────────────────────────────────────────────────────────────
// NO LONGER A QUALITY LADDER, AND NO LONGER COLOURED AT ALL. Two separate findings forced this:
//
// 1. IT REWARDED NOTHING. This used to paint TrueHD/Atmos/DTS-HD purple and AAC orange. Measured
//    on the real chain 2026-08-01: TrueHD 7.1, DTS 5.1, EAC3-JOC Atmos and FLAC are all decoded
//    in software by ExoPlayer and then leave AudioALSAStreamOut at channel_mask=3 — STEREO —
//    into a WiMiUS K5 (3.5 mm out) feeding a PreSonus Eris 3.5 stereo PAIR. Purple was rewarding
//    1-3 GB per film of data that never reaches a speaker.
//
// 2. WE CANNOT HONESTLY COLOUR THE ALTERNATIVE EITHER. The obvious replacement was "red when no
//    PS4-playable track exists", but `audioCodec` from mediaInfo is only the PRIMARY track. Blade
//    Runner's primary is EAC3 and it carries three AC3 commentary tracks the PS4 plays fine, so
//    that rule would be confidently wrong. Judging PS4 compatibility needs the full track list,
//    which this payload does not have.
//
// So the badge stays as INFORMATION — codec and channel count, monochrome. The tracks themselves
// are untouched; a future speaker upgrade could make surround matter again and throwing the data
// away would be irreversible. If per-track data is ever plumbed through, colour can come back.
// See docs/audit-2026-07-31/raw/playback-tests-2026-08-01.md and RESEARCH-APPENDIX.md Q4.
function audioCls() { return ''; }
// Rewrite a URL's host to the one the dashboard was opened with (keeps scheme/port/path), so the
// server-built service links (which use the LAN IP) resolve over whatever path the user is on.
const sameHost = (u) => String(u || '').replace(/^(https?:\/\/)[^/:]+/i, `$1${location.hostname}`);

function fmtBytes(b) {
  if (!b) return '0 GB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i < 2 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtEta(s) {
  if (!s || s <= 0) return '';
  if (s < 90) return '1 min';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
// "Not found" rows: say when the next recovery search will actually fire, so it doesn't just
// sit there looking abandoned. d.recoveryNext is an absolute ms timestamp from the server.
function fmtRecovery(d) {
  if (d.recoveryBlocked) {
    if (d.recentRelease) return `no torrent yet — will retry ${fmtWhen(d.recoveryNext)}`;
    return `gave up after ${d.recoveryFails} tries, will retry ${fmtWhen(d.recoveryNext)}`;
  }
  if (!d.recoveryNext) return 'retrying soon';
  const ms = d.recoveryNext - Date.now();
  if (ms <= 0) return 'retrying now';
  return `next retry in ${fmtDur(ms / 1000)}`;
}
// "Stalled" rows: say when the give-up (blocklist + re-search) clock fires.
function fmtGiveUp(giveUpAt) {
  const ms = giveUpAt - Date.now();
  if (ms <= 0) return 'giving up now';
  return `giving up in ${fmtDur(ms / 1000)}`;
}
function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// Coarser, two-part duration for the batch estimate (e.g. "2d 4h", "9h 30m", "12 min").
function fmtDur(s) {
  if (!s || s <= 0) return '';
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}
