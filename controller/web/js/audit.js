'use strict';
// Audit tab — read-only reporting on the library's worst offenders, in three sections that
// are deliberately NOT one merged list because they are not the same kind of problem:
//   Playback — 10-bit/AV1/VP9/DV. Software-decode on the NUC, no Fire Stick direct-play.
//              Costs CPU, not disk. Movies and TV seasons both appear. Confirmed by measurement
//              2026-08-01: HEVC Main10 is exactly the class that forces a server transcode, and
//              that transcode runs at 1.29x realtime while downloads are active.
//   Disk     — picture quality above what the title's profile asks for, judged on the shared bpp
//              band (was "x264 over 6 Mbps" until 2026-08-01 — raw Mbps is resolution-, framerate-
//              and codec-blind, and the x264-only filter hid fat HEVC seasons entirely).
//              Plays fine, just large. Beloved excluded by design.
//   Stale    — torrent bytes no longer shared with the library. Always actionable.
//
// Only rows with a CONFIRMED better source are listed, and the section counts reflect the
// same filter — a total including rows you cannot act on overstates the opportunity, and it
// should fall as work is done. Verdicts are cached server-side (a live indexer search is
// 5-21s); the backend verifier trickles through them.
//
// NOTHING HERE MUTATES. Picking a candidate is intentionally not wired — see
// AGENTS.md "The Audit tab is full of issues" for how a swap is actually performed.

let auditData = null;
let auditSection = 'cpu';
let auditLoading = false;
let auditSheetRow = null;

// Verified-only is permanent; the checkbox is commented out of index.html. Flip this and
// un-comment the control to read it again if that decision is ever revisited.
const AUDIT_ONLY_IMPROVABLE = true;

const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
const setHidden = (sel, v) => { const el = $(sel); if (el) el.hidden = v; };

// Every mutating action here fires a SLOW server round trip — the reclaim dry run re-walks the
// whole torrent tree and re-queries *arr history, and a replace dry run re-runs the indexer
// search. A button that only goes disabled looks like a tap that missed, especially on a phone
// where there is no hover or cursor to fall back on. Spinner + verb, matching .loading.
function btnBusy(btn, label) {
  if (!btn) return;
  if (btn.dataset.idle == null) btn.dataset.idle = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner sm"></span>${esc(label)}`;
}
function btnIdle(btn) {
  if (!btn) return;
  btn.disabled = false;
  if (btn.dataset.idle != null) { btn.textContent = btn.dataset.idle; delete btn.dataset.idle; }
}
const isBusy = (btn) => !!btn && btn.dataset.idle != null;
// EDITION is deliberately NOT filtered to improvable rows. Everywhere else an unactionable row is
// noise, but here the row itself is the finding: this file is the wrong CUT of the film. Hiding it
// until a replacement happens to be seeded would mean the tab said "nothing to do" about a library
// holding the theatrical Blade Runner. Rows with no candidates render as a statement, not a button.
const auditRows = (sec) => (sec === 'stale' ? [] : (auditData[sec] || [])
  .filter((r) => sec === 'edition' || !AUDIT_ONLY_IMPROVABLE
    || (r.verdict && r.verdict.state === 'improvable' && !r.verdict.stale)));

function auditAge(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 3600000) return `${Math.round(d / 60000)}m`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h`;
  return `${Math.round(d / 86400000)}d`;
}
const sz = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${Math.round(g)} GB`);

// A before→after pair on one line, then one badge line. Two body lines instead of a
// key/value table: the arrow carries the comparison that the "NOW / BEST" labels used to.
// Depth is only shown for HEVC. For H.264 it is noise — 10-bit H.264 (Hi10P) is caught by
// the title regex and excluded, so anything reaching here plays everywhere regardless.
const pill = (t, cls = '') => `<span class="apill ${cls}">${esc(t)}</span>`;
// An in-flight swap must show whether it is actually MOVING. Audit swaps are exempt from
// stallRecovery on purpose (it was deleting live swaps), so a dead swarm sits until the 48 h
// abandon with nothing retrying it — and "swapping · 445 min" made that look like progress.
// Plain text, no spinner: the spinner got shoved around by the flex row.
// Every value goes through pill(), which escapes — never pass markup in here.
function swapPills(s, mins) {
  const age = pill(mins < 1 ? 'just started' : `${mins} min`);
  const pct = s.progress != null ? ` ${Math.round(s.progress * 100)}%` : '';
  if (s.health === 'stalled') {
    return pill(`stalled${pct}`, 'bad')
      + pill(s.seeds === 0 ? 'no seeds' : `${s.seeds} seeds`, 'bad')
      + pill(`quiet ${s.quietMin} min`, 'warn') + age;
  }
  if (s.health === 'gone') return pill('torrent gone', 'bad') + pill('abandoning', 'warn') + age;
  if (s.health === 'importing') return pill('importing', 'ok') + pill('100%', 'ok') + age;
  if (s.health === 'pending') return pill('starting', 'ok') + age;
  // healthy download: say how far along and how fast, so slow-but-alive reads differently to dead
  return pill(`swapping${pct}`, 'ok')
    + (s.etaMin != null ? pill(s.etaMin < 60 ? `~${s.etaMin} min left` : `~${Math.round(s.etaMin / 60)} h left`) : '')
    + (s.dlKbps ? pill(s.dlKbps >= 1024 ? `${(s.dlKbps / 1024).toFixed(1)} MB/s` : `${s.dlKbps} KB/s`) : '')
    + age;
}
const TIER_CLS = { 1: 'ok', 2: 'ok', 3: 'warn' };
// One badge per client instead of a single vague note, so it is obvious WHICH device pays.
// ok = direct play (green) · tx = server transcodes, works but costs CPU (amber) · no = red.
const DEV_CLS = { ok: 'ok', tx: 'warn', no: 'bad' };
// PICTURE QUALITY is a SEPARATE axis from device support, and it now travels as an ABSOLUTE
// figure rather than a ratio. A 2.6 Mbps x264 plays perfectly on every device — all five device
// badges go green — while being a quarter of the bitrate we have, so it still needs its own
// coloured badge or the row reads as an unqualified win. That badge is bppSpan() in util.js.
//
// THE `bandPill` (`~61%`) BADGE WAS REMOVED on 2026-08-01. It rendered candidate-bitrate over
// current-bitrate, x1.8 for HEVC. Two problems: with a coloured bpp figure now on BOTH the
// current card and the candidate, "0.05 -> 0.14" states the same comparison in absolute terms and
// states it better; and a ratio is blind to the case that matters most — a film already sitting at
// 0.05 bpp can offer a candidate at 90% of that and look like a safe trade while still being red.
// The absolute floor (candidateBandOk in lib/audit.js) is what refuses those now, and the
// candidate's own bpp badge rendering orange or red is a stronger caution than the old
// `belowFloor` exclamation mark ever was.
// Under ~5 seeders a grab may simply never finish; that is a practical risk, not a nicety.
// `seeds` right-aligns it so the device badges below line up across cards.
// Below 3 this is RED, not amber (2026-07-30, Brennan): amber reads as "caution", but the honest
// meaning at 0-2 seeders is "this will probably never finish" — every stall we have chased this week
// (Wire S05, American Gods S01, Rings of Power S01, Challengers) began as a low-seed grab that looked
// merely cautionary. 3-4 stays amber; the >=5 threshold is unchanged.
const seedPill = (n) => pill(`${n} seeds`, `seeds ${n < 3 ? 'bad' : (n < 5 ? 'warn' : '')}`);

// Playback candidates may legitimately be BIGGER now that source upgrades are allowed there, so
// this has to render a gain as well as a saving. It previously showed "−0GB" for a candidate 2 GB
// larger, which reads as "no change" — the opposite of the truth.
//
// ONE renderer for the size delta, used by the candidate list AND the final confirm sheet. The
// sheet used to format its own `−${Math.round(plan.freesGb)}GB`, which printed a clipped "−-0GB"
// whenever the replacement was larger: the sign was hardcoded, so a negative freesGb produced two
// minus signs and rounded to zero. Sharing the renderer is what stops the commit step and the list
// it was chosen from ever disagreeing again.
//
// Sub-1 GB differences render as "same size" rather than a rounded "−0GB", which said "no change"
// with a minus sign in front of it — noise on the one screen that has to be unambiguous.
function deltaGbPill(freesGb, cls = '') {
  const gb = Math.abs(freesGb || 0);
  if (gb < 1) return `<span class="aud-save same ${cls}">same<small>size</small></span>`;
  if ((freesGb || 0) > 0) return `<span class="aud-save ${cls}">−${Math.round(gb)}<small>GB</small></span>`;
  return `<span class="aud-save bigger ${cls}" title="This candidate is LARGER than the copy you `
    + `have — offered because it is a better source or fixes playback.">+${Math.round(gb)}<small>GB</small></span>`;
}
const savePill = (curBytes, candBytes, cls = '') =>
  deltaGbPill(((curBytes || 0) - (candBytes || 0)) / 1073741824, cls);

// SOURCE — what the release was made FROM. This caps how good a file can look no matter what
// bitrate it is given, so it was wrong to render every source as the same grey pill: an
// HDTV-sourced encode offered against a Bluray-sourced file is a genuine regression even when
// its bitrate ratio looks healthy.
//   Remux  5 — untouched disc stream, no re-encode. Reference quality.
//   Bluray 4 — re-encoded from the disc. What "1080p" usually means.
//   WEBDL  4 — pulled bit-for-bit from a streaming service. Already compressed by them but not
//              re-encoded again, so at TV sizes it is normally indistinguishable from Bluray.
//   WEBRip 3 — a stream re-encoded by the release group. One extra generation of loss.
//   HDTV   2 — captured off-air. Lower broadcast bitrate, sometimes station logos or cuts.
//   DVD    1 — 480/576p upscaled. Never an upgrade for a 1080p file.
//   CAM/TS 0 — filmed off a screen. Junk.
// NOTE: *arr reports BRRip and BDRip as "Bluray", though both are re-encodes of an existing
// rip rather than of the disc — treat a suspiciously small "Bluray" with that in mind.
const SRC_RANK = [[/remux/i, 5], [/bluray|blu-ray|brrip|bdrip/i, 4], [/web-?dl/i, 4],
  [/webrip/i, 3], [/hdtv/i, 2], [/dvd/i, 1], [/sdtv|\bcam\b|telesync/i, 0]];
const srcRank = (s) => { for (const [re, n] of SRC_RANK) if (re.test(s || '')) return n; return null; };
const SRC_ABS = { 5: 'ok', 4: 'ok', 3: '', 2: 'warn', 1: 'bad', 0: 'bad' };
// Coloured on the ABSOLUTE tier, then downgraded further if it is below what we already hold —
// a relative drop is the thing that actually costs us something.
// `drop` is the server's srcDrop: >0 worse than what we hold, <0 better, 0 same.
function srcPill(source, drop) {
  if (!source) return '';
  const n = srcRank(source);
  if (n == null) return pill(source);
  let cls = SRC_ABS[n];
  let note = `Source tier ${n}/5.`;
  if (drop > 0) {
    cls = n <= 2 ? 'bad' : 'warn';
    note += ' LOWER than the copy you have — expect a real quality drop, not just a smaller file.';
  } else if (drop < 0) {
    cls = 'ok';
    note += ' BETTER source than the copy you have.';
  }
  // "-1080p" is dead weight on a phone: every candidate is 1080p, the filter guarantees it.
  const label = String(source).replace(/-?(1080|720|2160)p/i, '').replace(/[-\s]+$/, '');
  return `<span class="apill ${cls}" title="${esc(`${source}. ${note}`)}">${esc(label)}`
    + `${drop > 0 ? ' ↓' : (drop < 0 ? ' ↑' : '')}</span>`;
}
// Extra format signals, rendered only when they say something. A grey pill on every release
// taught nothing; these mark the specific reason a candidate is a trade rather than a win.
// Split across the two badge rows by MEASUREMENT, not by taste: line 2 holds the compact
// "what is it" set (source, bitrate, audio) and line 3 the caveats plus seeds and devices.
// Putting all of them on line 2 clipped them behind overflow:hidden while line 3 sat with
// 124px unused — see scratchpad/linecheck.js.
// Emitted TWICE, once per badge row, with CSS showing exactly one. Below 380px line 2 has no
// room for it (a "DTS-HD" on a WEBRip candidate clipped at 360px) while line 3 still does, and
// CSS cannot move a node between rows. Duplicating the markup and hiding one is the only way to
// keep the badge at every width without ever clipping it.
function audioPill(c, where) {
  if (!c.audio) return '';
  return pill(c.audio, `${audioCls(c.audio)} ${where}`);
}
function fmtPills(c) {
  let s = '';
  // GENUINELY ORTHOGONAL to the source badge, which is why it is back after a brief removal.
  // *arr's `source` says which MASTER the release descends from (disc / stream / broadcast);
  // "BRRip" in the title says it was encoded from somebody else's RIP of that master rather
  // than from the master itself — one extra lossy generation. Shrek Forever After's YIFY
  // candidate is exactly this: source Bluray-1080p, title BrRip. The format badge cannot say it.
  if (c.reenc) {
    s += `<span class="apill warn" title="Encoded from an existing rip, not from the source `
      + `itself — one extra generation of lossy compression on top of the source tier shown.">re-encode</span>`;
  }
  // LANGUAGE. A release whose audio language *arr could name and which isn't English is refused
  // server-side, so anything reaching here is either fine or UNKNOWN. Unknown gets a visible
  // amber flag rather than silence: "Silicon.Valley.S02.ITA" parsed as Italian-only, and an
  // unlabelled unknown is exactly how that class of release looks safe until you play it.
  if (c.langWarn) {
    s += `<span class="apill warn" title="Audio language could not be determined from this `
      + `release. It is probably fine, but check it is not a foreign dub before committing.">lang?</span>`;
  } else if (c.langs && c.langs.length > 1) {
    s += `<span class="apill" title="Audio tracks: ${esc(c.langs.join(', '))}">${esc(c.langs.length)} audio</span>`;
  }
  // No `repack` pill: it never decides anything and cost a badge slot. No `aggressive` pill
  // either — belowFloor is now carried by the bitrate badge's colour and tooltip instead.
  return s;
}
// Derived HERE, not on the server, from the codec+depth the verdict already carries. Baking
// the matrix into cached verdicts meant every tweak needed a VERDICT_VERSION bump, throwing
// away ~2h of indexer verification for a cosmetic change.
//   Fire - Fire TV Stick 2nd gen (AFTT). MEASURED 2026-08-01 by driving the live session and
//          reading Jellyfin's settled decision: HEVC 8-bit, 19.7 Mbps H.264, DTS-only and
//          TrueHD-only all DIRECT PLAY. The client profile declares `hevc-profile=main` with no
//          main10, and a Main10 file returns TranscodeReasons=VideoProfileNotSupported. So
//          Main10 is the ONLY transcode trigger in the whole library. Decoders cap at 1920x1088.
//          This is ~95% of playback, which is why it is listed first.
//   PS4  - media player is H.264 only; any HEVC is a transcode (cheap via QSV at 8-bit).
//          ~1% of playback. Not verified by measurement; inherited assumption.
//   iOS  - iPhone/iPad, and Jellyfin/Streamyfin on them, decode HEVC incl. Main10 natively.
//   Web  - desktop browsers: H.264 universal, HEVC effectively Safari-only.
//   NUC  - the SERVER's own cost when it must transcode: Iris 540 hardware-decodes H.264 and
//          HEVC 8-bit but NOT Main10 (confirmed absent from vainfo: no VAProfileHEVCMain10, no
//          VP9, no AV1). Measured cost of that software decode at true 1920x1080: 2.1x realtime
//          idle, 1.29x while downloads run, and one transcode took load from 4.1 to 14.3.
//          gpuTier() in lib/arr-inspect.js was amber for 10-bit until 2026-08-01 while this said
//          red; both now say red, which is the honest reading.
// Full method and results: docs/audit-2026-07-31/raw/playback-tests-2026-08-01.md
function devicesFor(c) {
  const h265 = c.codec !== 'H.264';
  const tenbit = h265 && c.depth !== '8bit';
  return { Fire: !h265 ? 'ok' : (tenbit ? 'tx' : 'ok'), PS4: !h265 ? 'ok' : 'tx',
    iOS: 'ok', Web: !h265 ? 'ok' : 'tx', NUC: tenbit ? 'no' : 'ok' };
}
// All five clients are always shown — the colour across the whole row IS the message, and
// collapsing it to exceptions loses the at-a-glance comparison between candidates. They get a
// line of their own; everything else moved up to line 2, which had room to spare.
// The file you ALREADY have, shaped like a candidate so devicesFor() can read it. The server sends
// the current copy's codec and depth fused into one display string (videoLabel: "H.264 8bit"), so
// this splits them back apart. Shared by the sheet's CURRENT card and the Upgrade tab's rows —
// they were deriving it separately, and the two must never disagree about what you own.
function currentAsCandidate(r) {
  return {
    codec: /h\.?264|x264|avc/i.test(r.label || '') ? 'H.264' : 'HEVC',
    depth: /10\s*bit/i.test(r.label || '') ? '10bit' : '8bit',
  };
}
const DEV_NOTE = { ok: 'direct play', tx: 'server transcodes', no: 'software decode — expensive' };
const devPills = (c) => Object.entries(devicesFor(c))
  .map(([k, v]) => `<span class="apill dev ${DEV_CLS[v] || ''}" title="${esc(`${k}: ${DEV_NOTE[v]}`)}">${esc(k)}</span>`).join('');

function auditRowHtml(r) {
  const b = r.verdict.best;
  // BOTH figures, on both tabs. This used to be Mbps-or-label: Disk rows had a bitrate and showed
  // it, Playback rows had no `mbps` and fell back to the codec label. Now that Playback carries a
  // bitrate too, a bare swap to Mbps would have cost that tab the codec — the one thing it exists
  // to fix. Codec first (it is why the row is listed), bitrate second.
  const rate = [esc(r.label || ''), r.bpp != null && b.bpp != null
    ? `${bppSpan(r.bppPlus, r.bppBand)}<i>→</i>${bppSpan(b.bppPlus, b.bppBand)}` : '']
    .filter(Boolean).join('<i>·</i>');
  // A swap already in flight: the row is NOT actionable, so it does not pretend to be. No
  // data-key, no role=button — tapping it does nothing rather than opening a sheet whose Replace
  // button the server would only 409. Shows which release is being fetched and for how long,
  // because a season pack can take hours and "swapping" alone reads like a hang.
  if (r.swapping) {
    const mins = Math.round((Date.now() - r.swapping.since) / 60000);
    return `<li class="row aud swapping">
      <span class="grow">
        <span class="title">${esc(r.title)}</span>
        <div class="aud-line">
          <span class="aud-delta">${fmtBytes(r.bytes)}<i>→</i>${fmtBytes(b.bytes)}</span>
        </div>
        <div class="aud-pills">
          ${swapPills(r.swapping, mins)}
        </div>
        ${r.swapping.rel ? `<div class="aud-swap-rel">${esc(r.swapping.rel)}</div>` : ''}
      </span>
      <span class="aud-right">${savePill(r.bytes, b.bytes)}</span>
    </li>`;
  }
  return `<li class="row aud${qbarCls(r.bppBand)}" data-key="${esc(r.key)}" role="button" tabindex="0">
    <span class="grow">
      <span class="title">${esc(r.title)}</span>
      <div class="aud-line">
        <span class="aud-delta">${fmtBytes(r.bytes)}<i>→</i>${fmtBytes(b.bytes)}</span>
        <span class="aud-rate">${rate}</span>
      </div>
      <div class="aud-pills">${devPills(b)}</div>
    </span>
    <span class="aud-right">${savePill(r.bytes, b.bytes)}${seedPill(b.seeders)}</span>
  </li>`;
}

// EDITION rows. Unlike every other section these are shown whether or not a replacement exists, so
// the renderer has to work with verdict === null. Three states, and each says only what is TRUE:
//   • a candidate exists   → tappable, opens the normal sheet, Replace goes through the zero-gap swap
//   • checked, nothing yet  → not tappable, says so; the row remains as a standing statement
//   • not checked yet       → says that, rather than implying nothing is available
// The badge NEVER claims "theatrical" unless the file actually said so (editionStated). An untagged
// file is usually theatrical but may just be badly named, and asserting it would be confidently wrong
// about the user's own library — the candidate list is what settles it.
function auditEditionRowHtml(r) {
  const v = r.verdict || {};
  const b = v.state === 'improvable' ? v.best : null;
  // Two kinds of row, and they must not look alike. A FLOOR breach is red — a theatrical Blade
  // Runner is a file that should not be on disk. An above-floor PREFERENCE is amber: the Redux
  // Apocalypse Now you own is a perfectly good film, the Final Cut is merely the one to own. Paint
  // both red and the section cries wolf on titles that are already fine.
  const prefer = !!r.editionPrefer;
  const tone = prefer ? 'warn' : 'bad';
  const badge = r.editionStated
    ? pill(String(r.editionLabel).toUpperCase(), tone)
    : pill('EDITION UNKNOWN', tone);
  const status = b
    ? `${fmtBytes(r.bytes)}<i>→</i>${fmtBytes(b.bytes)}`
    : (v.state ? 'nothing better available yet' : 'not checked yet');
  // A swap already in flight renders EXACTLY like the other sections — same .swapping class, same
  // swapPills, same release line. This branch was missing, so a swapping Edition row fell through
  // to the generic `muted` state below and was indistinguishable from "nothing better available
  // yet": no grey-out, no progress, no named release. Reported by Brennan on the Edition tab while
  // Blade Runner was mid-replacement. Keep this ahead of everything else in the function — `muted`
  // alone is a statement about availability, never about work in progress.
  if (r.swapping) {
    const mins = Math.round((Date.now() - r.swapping.since) / 60000);
    return `<li class="row aud swapping">
      <span class="grow">
        <span class="title">${esc(r.title)}</span>
        <div class="aud-line">
          <span class="aud-delta">${b ? `${fmtBytes(r.bytes)}<i>→</i>${fmtBytes(b.bytes)}` : fmtBytes(r.bytes)}</span>
        </div>
        <div class="aud-pills">
          ${swapPills(r.swapping, mins)}
        </div>
        ${r.swapping.rel ? `<div class="aud-swap-rel">${esc(r.swapping.rel)}</div>` : ''}
      </span>
      <span class="aud-right">${b ? savePill(r.bytes, b.bytes) : ''}</span>
    </li>`;
  }
  const tappable = !!b;
  const attrs = tappable ? ` data-key="${esc(r.key)}" role="button" tabindex="0"` : '';
  return `<li class="row aud${tappable ? '' : ' muted'}"${attrs}>
    <span class="grow">
      <span class="title">${esc(r.title)}</span>
      <div class="aud-line">
        <span class="aud-delta">${status}</span>
        <span class="aud-rate">${prefer ? 'prefer' : 'want'} ${esc(r.want || 'a longer cut')}</span>
      </div>
      <!-- NO esc() around pill() arguments: pill() escapes internally, so wrapping it double-encoded
           and rendered a literal "Director&#39;s Cut" on screen. See the note above pill(). -->
      <div class="aud-pills">${badge}${b ? pill(b.edition || 'cut unstated', 'ok') : ''}${b ? devPills(b) : ''}</div>
    </span>
    <span class="aud-right">${b ? seedPill(b.seeders) : ''}</span>
  </li>`;
}

// COVERED = *arr history proves the library still holds what this torrent delivered, so the
// bytes are surplus. LOST = it is the only remaining copy. UNPROVEN = no import record.
// Only COVERED is ever offered for removal, and the server re-derives that itself.
const COV_CLS = { COVERED: 'ok', LOST: 'bad', UNPROVEN: 'warn' };
const COV_TXT = { COVERED: 'safe to remove', LOST: 'only copy — keep', UNPROVEN: 'unproven — check' };
function auditStaleRowHtml(r) {
  return `<li class="row aud">
    <span class="grow">
      <span class="title">${esc(r.title)}</span>
      <div class="aud-pills">
        ${pill(COV_TXT[r.cov] || r.cov || '?', COV_CLS[r.cov] || 'warn')}
        ${pill(`${r.files} file${r.files === 1 ? '' : 's'}`)}
        ${r.ratio != null ? pill(`ratio ${r.ratio}`) : pill('no torrent', 'warn')}
      </div>
    </span>
    <span class="aud-save">−${Math.round(r.bytes / 1073741824)}<small>GB</small></span>
  </li>`;
}

function renderAudit() {
  const d = auditData;
  if (!d) return;
  const t = d.totals;
  const fill = (sec, val, sub) => { setText(`#at-val-${sec}`, val); setText(`#at-sub-${sec}`, sub); };
  // PLAYBACK headline is the size of the AFFECTED material, not a saving. Since v8 this section
  // accepts source upgrades and larger-but-better replacements, so its net disk change can be
  // negative — it totalled -187 GB after the re-scrape, and rendering that as the tile's number
  // claimed recoverable space that does not exist. The disk effect moves to the sub line, where
  // it can honestly say "costs".
  const diskDelta = t.cpuSaveGb;
  fill('cpu', sz(t.cpuGb), `${t.cpuRows} to fix`
    + (Math.abs(diskDelta) >= 1 ? ` · ${diskDelta > 0 ? 'saves' : 'costs'} ${sz(Math.abs(diskDelta))}` : ''));
  fill('bitrate', sz(t.bitrateSaveGb), `${t.bitrateRows} to fix`);
  // A COUNT, not gigabytes. The right cut is usually BIGGER, so a size headline here would read as
  // a cost to avoid rather than a fix to make. The sub-line separates "wrong" from "fixable today",
  // because a wrong cut with nothing seeded is still worth knowing about.
  fill('edition', String(t.editionRows ?? 0), (t.editionRows ?? 0) === 0
    ? 'all correct'
    : `wrong cut · ${t.editionFixable ?? 0} fixable now`);
  fill('stale', sz(t.staleGb), `${t.staleRows} torrents`);
  // Upgrade's figure is the library SIZE, not a count of problems — nothing here is wrong, it is a
  // browse surface. Falls back to an em dash until the section has been opened once.
  fill('upgrade', upgLibTotal ? String(upgLibTotal) : '–', upgLibTotal ? 'movies · pick a better copy' : 'browse the library');

  if (t.unverified > 0) {
    setText('#audit-progress', `Verifying · ${t.unverified} left · ~${t.etaMin} min`);
    setHidden('#audit-progress', false);
  } else { setHidden('#audit-progress', true); }

  // Reclaim is offered only on the Stale section, and only when the server reports rows it
  // has itself judged COVERED.
  const rec = $('#aud-reclaim');
  // Skip entirely while a dry run is in flight: rewriting textContent would delete the spinner
  // and hiding the button mid-request would pull it out from under the tap.
  if (rec && !isBusy(rec)) {
    const n = d.stale.safeCount || 0;
    rec.hidden = !(auditSection === 'stale' && n > 0);
    rec.textContent = `Reclaim ${n} torrent${n === 1 ? '' : 's'} · ${fmtBytes(d.stale.safeBytes || 0)}`;
  }
  // Upgrade holds its OWN paged rows (upgRows), not auditData — it is the one section whose list is
  // fetched separately and grows as you scroll.
  const rows = auditSection === 'stale' ? d.stale.rows
    : (auditSection === 'upgrade' ? upgRows : auditRows(auditSection));
  const html = auditSection === 'stale'
    ? (d.stale.err ? `<li class="row aud muted">${esc(d.stale.err)}</li>` : rows.map(auditStaleRowHtml).join(''))
    : rows.map(auditSection === 'upgrade' ? auditUpgradeRowHtml
      : (auditSection === 'edition' ? auditEditionRowHtml : auditRowHtml)).join('');
  const list = $('#audit-list');
  if (list) list.innerHTML = html;
  // The scroll sentinel is deliberately OUTSIDE #audit-list so re-rendering never destroys the
  // node the observer holds — which also means nothing above hides it. It belongs to Upgrade
  // alone, so without this it survives a section switch and parks a stray loading box at the foot
  // of Disk / Playback / Edition / Stale for the rest of the session.
  setHidden('#audit-more', auditSection !== 'upgrade' || upgDone || !upgRows.length);
  setHidden('#audit-empty', !!html);
  if (!html) {
    setText('#audit-empty', auditSection === 'upgrade'
      ? (upgQuery ? 'No movies match that search.' : 'No movies in the library yet.')
      : auditSection === 'edition'
      ? 'Every film with a definitive cut is the right one.'
      : (t.unverified
        ? 'Nothing confirmed yet — verification is still running.'
        : 'Nothing actionable here.'));
  }
}

async function loadAudit(force) {
  if (auditLoading) return;
  auditLoading = true;
  setHidden('#audit-loading', false);
  try {
    const r = await fetch(`${API}/api/audit${force ? '?refresh=1' : ''}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    auditData = await r.json();
    renderAudit();
  } catch (e) {
    setText('#audit-empty', `Could not load the audit — ${e.message}`);
    setHidden('#audit-empty', false);
  } finally {
    auditLoading = false;
    setHidden('#audit-loading', true);
  }
}

$('#audit-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  auditSection = b.dataset.sec;
  $$('#audit-toggle button').forEach((x) => x.classList.toggle('active', x === b));
  // The search box belongs to Upgrade alone; every other section is short and pre-filtered.
  setHidden('#aud-search', auditSection !== 'upgrade');
  renderAudit();
  // Fetched on FIRST view, not on page load: it is a separate request over the whole library and
  // most visits to this tab are not about upgrading.
  if (auditSection === 'upgrade' && !upgRows.length) loadUpgrade(true);
});

// Debounced so typing does not fire a request per keystroke; 250ms is under the threshold where a
// search feels laggy while still collapsing a burst of letters into one round trip.
let upgSearchTimer = null;
$('#aud-search').addEventListener('input', (e) => {
  const v = e.target.value.trim().toLowerCase();
  clearTimeout(upgSearchTimer);
  upgSearchTimer = setTimeout(() => {
    if (v === upgQuery) return;
    upgQuery = v;
    loadUpgrade(true);
  }, 250);
});

// Infinite scroll. rootMargin pre-fetches before the sentinel is actually visible, so the next page
// is usually already in place by the time the user reaches the bottom.
if (window.IntersectionObserver) {
  const sentinel = $('#audit-more');
  if (sentinel) {
    new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) return;
      if (auditSection !== 'upgrade') return;
      loadUpgrade(false);
    }, { rootMargin: '400px' }).observe(sentinel);
  }
}

// ── Options sheet ──────────────────────────────────────────────────────────────────────
// Candidates open as a bottom sheet rather than expanding the row: an inline panel shoves
// every following row down mid-scroll, and a sheet matches the delete / force-grab pickers.
// btnIdle here too: the re-check spinner lives on a shared button, so a sheet closed mid-search would
// otherwise hand the NEXT film a button that already reads "Checking…".
function closeAudSheet() {
  $('#aud-backdrop').hidden = true;
  auditSheetRow = null;
  const btn = $('#aud-recheck'); if (btn) btnIdle(btn);
}

function renderAudSheet() {
  const r = auditSheetRow;
  if (!r) return;
  const v = r.verdict || {};
  setText('#aud-title', r.title);
  // The current file renders in the SAME card language as the candidates below it, so the
  // comparison is like-for-like instead of a prose line above a set of badges. videoLabel
  // gives "H.264 8bit" / "HEVC 10bit"; split it so devicesFor() can read it.
  const cur = currentAsCandidate(r);
  const curEl = $('#aud-cur');
  if (curEl) {
    curEl.innerHTML = `
      <div class="aud-cand-head">
        <span class="aud-cand-title"><span class="aud-tag">CURRENT</span></span>
        <span class="aud-age">checked ${auditAge(v.ts)} ago</span>
      </div>
      <div class="aud-line">
        <span class="aud-delta">${fmtBytes(r.bytes)}${r.bppPlus != null ? `<i>·</i>${bppSpan(r.bppPlus, r.bppBand)}` : ''}</span>
        <span class="aud-rate">${esc(r.label || '')}</span>
        <span class="aud-inline">${srcPill(r.source, 0)}</span>
      </div>
      <div class="aud-pills">${devPills(cur)}</div>`;
  }
  const cands = v.candidates || [];
  // Title, one figures line, one badge line. The old version spent four lines and a
  // key/value table per candidate, which buried the comparison.
  // The whole card is the target — a separate "Use this" button inside a card that is already
  // a discrete choice is redundant, and on a phone it cost a whole extra row per candidate.
  // Only cards carrying a guid are actionable; the CURRENT card above has none.
  $('#aud-results').innerHTML = cands.length ? cands.map((c) => `
    <div class="aud-cand${c.guid ? ' pick' : ''}"${c.guid ? ` data-guid="${esc(c.guid)}" role="button" tabindex="0"` : ''}>
      <div class="aud-cand-head">
        <span class="aud-cand-title" title="${esc(c.title)}">${esc(c.title)}</span>
        ${savePill(r.bytes, c.bytes, 'sm')}
      </div>
      <div class="aud-line">
        <span class="aud-delta">${fmtBytes(c.bytes)}${c.bppPlus != null ? `<i>·</i>${bppSpan(c.bppPlus, c.bppBand)}` : ''}</span>
        <span class="aud-rate">${esc(c.codec === 'H.264' ? c.codec : `${c.codec} ${c.depth}`)}</span>
        <span class="aud-inline">${srcPill(c.source, c.srcDrop || 0)}${audioPill(c, 'wide-only')}</span>
      </div>
      <div class="aud-pills">${devPills(c)}${fmtPills(c)}${audioPill(c, 'narrow-only')}${seedPill(c.seeders)}</div>
    </div>`).join('') : '<p class="muted">No candidates.</p>';
}

// "Use this" always dry-runs first and shows the SERVER's plan before anything is grabbed.
// The old files are not deleted at confirm time either — the backend keeps them until the
// replacement has finished downloading (zero-gap), so a swap can never leave a title empty.
$('#aud-results').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.aud-cand.pick');
  if (card) { e.preventDefault(); card.click(); }
});
$('#aud-results').addEventListener('click', async (e) => {
  const btn = e.target.closest('.aud-cand.pick');
  if (!btn || !auditSheetRow || btn.classList.contains('busy')) return;
  const guid = btn.dataset.guid;
  btn.classList.add('busy');
  try {
    const body = { section: auditSection, key: auditSheetRow.key, guid, dryRun: true };
    const r = await fetch(`${API}/api/audit/replace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    openSwapConfirm(j, body);
  } catch (err) {
    // LAYER 2 of the in-flight guard. The row markup (layer 1) already refuses to open a sheet
    // for a swapping title, but a tab left open since before the swap started still holds a
    // clickable row — so the server's 409 is the authority, and it is not a failure. Refresh so
    // the row re-renders as "swapping" and the stale view corrects itself.
    if (/already in flight/i.test(err.message)) {
      toast('That title is already being swapped — nothing started');
      await loadAudit(true);
    } else { toast(`Replace failed — ${err.message}`); }
  } finally { btn.classList.remove('busy'); }
});

// Styled confirm sheet — never window.confirm(), which ignores the whole design system.
function closeSwap() { $('#swap-backdrop').hidden = true; }
$('#swap-cancel').addEventListener('click', closeSwap);
$('#swap-backdrop').addEventListener('click', (e) => { if (e.target === $('#swap-backdrop')) closeSwap(); });

// Bumped every time the confirm sheet is opened. #swap-confirm is a SINGLE shared DOM node, so
// without this the sheet was effectively owned by whichever replace POST fired last, on ANY
// title: open a new suggestion while a previous ~30s "Starting…" was still running and the new
// sheet inherited a disabled button reading "Starting…", which only cleared when that unrelated
// request finally settled. Worse, the stale request's success path called closeSwap(), so it
// could shut a sheet the user had since opened for a different film. Capturing the generation at
// bind time makes a late response touch the UI only if it still owns the sheet.
let swapGen = 0;

function openSwapConfirm(plan, body) {
  const myGen = ++swapGen;
  // A fresh sheet always starts clickable — the previous title's in-flight state is not this
  // title's business. The server is the real duplicate guard: a second swap for the SAME row
  // returns 409 "a replacement is already in flight for this title".
  btnIdle($('#swap-confirm'));
  // Clear a previous attempt's error styling, or a stale red "Could not start" outlives the
  // failure it described.
  const noteEl = $('#swap-note'); if (noteEl) noteEl.classList.remove('bad');
  setText('#swap-title', plan.title);
  // Say what actually happens to disk, in the direction it happens. "Frees about -0 GB" was the
  // subtitle on every replacement that was larger than the file it replaced.
  const fg = plan.freesGb || 0;
  setText('#swap-sub', Math.abs(fg) < 1 ? 'About the same size on disk'
    : fg > 0 ? `Frees about ${Math.round(fg)} GB` : `Uses about ${Math.round(-fg)} GB more`);
  $('#swap-plan').innerHTML = `
    <div class="aud-cand">
      <div class="aud-cand-head">
        <span class="aud-cand-title">${esc(plan.pick.title)}</span>
        ${deltaGbPill(fg, 'sm')}
      </div>
      <div class="aud-pills">
        ${pill(`${plan.pick.gb} GB`, 'strong')}
        ${pill(plan.pick.codec === 'H.264' ? plan.pick.codec : `${plan.pick.codec} ${plan.pick.depth}`)}
        ${seedPill(plan.pick.seeders)}
      </div>
    </div>`;
  // The zero-gap promise stated plainly: this is the reassurance that makes the button safe
  // to press, so it belongs on screen rather than buried in a doc.
  setText('#swap-note', `${plan.willRemove} existing file${plan.willRemove === 1 ? '' : 's'} will be removed — `
    + 'but only after the new copy finishes downloading. Nothing is deleted now.');
  $('#swap-confirm').onclick = async () => {
    const cb = $('#swap-confirm');
    btnBusy(cb, 'Starting…');
    try {
      const r2 = await fetch(`${API}/api/audit/replace`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, dryRun: false }),
      });
      const j2 = await r2.json();
      if (!r2.ok) throw new Error(j2.error || `HTTP ${r2.status}`);
      // Only close the sheet if it is still OURS — see swapGen. The grab itself has happened
      // either way, so the toast and the refresh are unconditional.
      if (myGen === swapGen) { closeSwap(); closeAudSheet(); }
      toast('Replacement grabbed — original stays until it completes');
      await loadAudit(true);
    } catch (err) {
      // The error has to appear IN the modal. A toast alone is why this read as "nothing happens
      // when I hit Replace": the sheet stays open by design on failure (so the choice isn't lost),
      // and the toast was missed behind it — leaving a dead-looking button and no explanation.
      toast(`Replace failed — ${err.message}`);
      if (myGen === swapGen) setText('#swap-note', `Could not start: ${err.message}`);
      const note = $('#swap-note'); if (note) note.classList.add('bad');
    }
    finally { if (myGen === swapGen) btnIdle(cb); }
  };
  $('#swap-backdrop').hidden = false;
}

// Rows for the sheet come from whichever list the section owns — Upgrade's are paged separately.
const sectionRows = () => (auditSection === 'upgrade' ? upgRows : auditRows(auditSection));
$('#audit-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li.row.aud[data-key]');
  if (!li) return;
  const row = sectionRows().find((x) => x.key === li.dataset.key);
  if (!row) return;
  auditSheetRow = row;
  // UPGRADE ONLY: an unverified row has nothing to show, so the tap IS the search. 805 titles cannot
  // be pre-verified (~10 hours of paced indexer work), which is why this section is search-on-demand
  // rather than a pre-computed list. The row shows a spinner in place — the sheet does not open until
  // there is something in it, because an empty sheet reads as a broken one.
  if (auditSection === 'upgrade' && !row.verdict) {
    li.classList.add('searching');
    const delta = li.querySelector('.aud-delta');
    if (delta) delta.textContent = 'searching indexers…';
    try {
      const res = await fetch(`${API}/api/audit/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'upgrade', key: row.key }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      row.verdict = { ...j.verdict, stale: false };
      renderAudit();
      if (j.verdict.state !== 'improvable' || !j.verdict.best) { toast('Nothing better available'); return; }
      // Re-resolve from the freshly rendered list so the sheet reads the decorated candidates.
      auditSheetRow = sectionRows().find((x) => x.key === row.key) || row;
    } catch (err) {
      li.classList.remove('searching');
      if (delta) delta.textContent = 'search failed';
      toast(`Search failed — ${err.message}`);
      return;
    }
  }
  if (!auditSheetRow.verdict || !auditSheetRow.verdict.best) return;
  renderAudSheet();
  $('#aud-backdrop').hidden = false;
});
$('#audit-list').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const li = e.target.closest('li.row.aud[data-key]');
  if (li) { e.preventDefault(); li.click(); }
});
$('#aud-close').addEventListener('click', closeAudSheet);
$('#aud-backdrop').addEventListener('click', (e) => { if (e.target === $('#aud-backdrop')) closeAudSheet(); });

// ── Stale reclaim ──────────────────────────────────────────────────────────────────────
function closeRec() { $('#rec-backdrop').hidden = true; }

// Loading state for the reclaim sheet. Confirm is disabled and the hash list CLEARED, so an
// impatient tap on a sheet that has not received the server's plan yet can never delete the
// previous plan's torrents.
function openRecLoading() {
  setText('#rec-sub', 'Re-checking every stale torrent on the server…');
  $('#rec-results').innerHTML = '<p class="force-loading"><span class="spinner"></span></p>';
  const cf = $('#rec-confirm');
  cf.disabled = true;
  cf.dataset.hashes = '[]';
  $('#rec-backdrop').hidden = false;
}
function recError(msg) {
  setText('#rec-sub', '');
  $('#rec-results').innerHTML = `<p class="force-error">${esc(msg)}</p>`;
  $('#rec-confirm').disabled = true;
}
$('#rec-cancel').addEventListener('click', closeRec);
$('#rec-backdrop').addEventListener('click', (e) => { if (e.target === $('#rec-backdrop')) closeRec(); });

// Re-check everything: drop every cached verdict so the paced background verifier re-searches the
// whole library. Verdicts are trusted for 14 days, which is right for a background sweep but means
// "is there something better yet?" could not be asked on demand.
//
// TWO CLICKS, not a modal. A full re-check is ~2.5 hours of paced indexer searching, far too much to
// start from one stray tap — but it is also not destructive (verification only SEARCHES; grabbing and
// deleting are /api/audit/replace, always human-driven), so it does not deserve a confirmation
// dialog either. First click DRY RUNS and puts the real cost on the button; second click commits.
let rescanArmed = false;
function rescanDisarm() {
  rescanArmed = false;
  const btn = $('#aud-rescan');
  if (btn && !isBusy(btn)) btn.textContent = 'Re-check everything';
  setText('#aud-rescan-note', '');
}
$('#aud-rescan').addEventListener('click', async () => {
  const btn = $('#aud-rescan');
  if (isBusy(btn)) return;
  if (!rescanArmed) {
    btnBusy(btn, 'Checking…');
    try {
      const j = await postJSON('/api/audit/rescan', { dryRun: true });
      btnIdle(btn);
      rescanArmed = true;
      btn.textContent = `Re-check ${j.wouldDrop} titles — tap again`;
      // Movie Mode pauses the verifier, so say so BEFORE committing: a rescan started while
      // streaming would otherwise look like a button that did nothing at all.
      setText('#aud-rescan-note', j.paused
        ? `about ${j.etaMinutes} min · will not start until Movie Mode is off`
        : `about ${j.etaMinutes} min, one search at a time`);
    } catch (e) {
      btnIdle(btn);
      setText('#aud-rescan-note', '');
      toast(`Could not check: ${e.message || ''}`);
    }
    return;
  }
  btnBusy(btn, 'Clearing…');
  try {
    const j = await postJSON('/api/audit/rescan', {});
    toast(j.paused ? 'Cleared — will run once Movie Mode is off' : `Re-checking ${j.dropped} titles`);
    rescanArmed = false;
    btnIdle(btn);
    btn.textContent = 'Re-check everything';
    setText('#aud-rescan-note', j.paused
      ? `${j.dropped} verdicts cleared — paused while Movie Mode is on`
      : `Re-checking ${j.dropped} titles · about ${j.etaMinutes} min`);
    loadAudit(true);
  } catch (e) {
    toast(`Could not start the re-check: ${e.message || ''}`);
    btnIdle(btn);
    rescanDisarm();
  }
});
// An armed button must not survive the user's attention moving elsewhere on the tab.
$('#tab-audit').addEventListener('click', (e) => {
  if (rescanArmed && !e.target.closest('#aud-rescan')) rescanDisarm();
});

$('#aud-reclaim').addEventListener('click', async () => {
  const safe = (auditData.stale.rows || []).filter((r) => r.cov === 'COVERED' && r.hash);
  if (!safe.length) return;
  const btn = $('#aud-reclaim');
  if (isBusy(btn)) return;
  btnBusy(btn, 'Checking…');
  // Open the sheet FIRST, in a loading state. The dry run re-walks the torrent tree and
  // re-queries *arr history server-side, so the sheet used to appear seconds after the tap
  // with nothing happening in between — indistinguishable from a dead button.
  openRecLoading();
  try {
    // Dry run FIRST — the sheet shows the server's own list, not the browser's.
    const r = await fetch(`${API}/api/audit/stale/reclaim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: safe.map((x) => x.hash), dryRun: true }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setText('#rec-sub', `${j.wouldRemove.length} torrents · ${j.gb} GB · files removed from disk`
      + (j.refused.length ? ` · ${j.refused.length} refused by the server` : ''));
    $('#rec-results').innerHTML = j.wouldRemove.map((x) => `
      <div class="aud-cand">
        <div class="aud-cand-head">
          <span class="aud-cand-title">${esc(x.title)}</span>
          <span class="aud-save sm">−${Math.round(x.gb)}<small>GB</small></span>
        </div>
        <div class="aud-pills">${pill(`${x.files} file${x.files === 1 ? '' : 's'}`)}</div>
      </div>`).join('');
    $('#rec-confirm').dataset.hashes = JSON.stringify(j.wouldRemove.map((x) => x.hash));
    $('#rec-confirm').disabled = !j.wouldRemove.length;
  } catch (e) {
    // The error belongs IN the sheet — it is already open, and a toast behind an open sheet
    // leaves a spinner turning forever.
    recError(`Could not plan the reclaim — ${e.message}`);
  } finally { btnIdle(btn); }
});

$('#rec-confirm').addEventListener('click', async () => {
  const btn = $('#rec-confirm');
  const hashes = JSON.parse(btn.dataset.hashes || '[]');
  if (!hashes.length) return closeRec();
  // The real delete is per-torrent and now waits for each unlink to be confirmed, so this can
  // run for a while on a big batch. It needs a spinner more than the dry run did.
  btnBusy(btn, 'Removing…');
  try {
    const r = await fetch(`${API}/api/audit/stale/reclaim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes, dryRun: false }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    closeRec();
    // Surface leftovers loudly: qBittorrent has been seen reporting success while leaving
    // files behind, and a silent under-reclaim reads as "it worked".
    toast(j.leftover && j.leftover.length
      ? `Freed ${j.freedGb} GB — ${j.leftover.length} left files on disk, check the logs`
      : `Freed ${j.freedGb} GB`);
    await loadAudit(true);
  } catch (e) { toast(`Reclaim failed — ${e.message}`); }
  finally { btnIdle(btn); }
});

// The sheet is a SINGLE shared element driven by the module-level auditSheetRow/auditSection, and
// this re-check is a LIVE indexer search that can take a minute or more. So the reply must be matched
// back to the film it was asked about: backing out mid-flight and opening another film used to have
// the old response resolve against the NEW globals — it overwrote auditSheetRow with the previous
// film's row and re-rendered the sheet from it, so the wrong results appeared under the right title,
// and the shared #aud-recheck spinner was cleared by whichever request happened to finish.
//
// The verdict is still CACHED either way: it is true for that row whether or not it is still on
// screen, and throwing away a search we already paid an indexer for would be waste. Only the SHEET
// and the toast are gated on "is this still what the user is looking at".
let recheckSeq = 0;
$('#aud-recheck').addEventListener('click', async () => {
  const r = auditSheetRow;
  if (!r) return;
  const btn = $('#aud-recheck');
  if (isBusy(btn)) return;
  // Identity captured at click time, never re-read from the globals after the await.
  const section = auditSection;
  const key = r.key;
  const mySeq = ++recheckSeq;
  const stillShowing = () => auditSheetRow && auditSheetRow.key === key && auditSection === section;
  const isLatest = () => recheckSeq === mySeq;
  btnBusy(btn, 'Checking…');
  try {
    const res = await fetch(`${API}/api/audit/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section, key }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    // Cache against the row it actually belongs to — looked up by the CAPTURED section, not the
    // current one, which is the specific mistake that crossed two films' results over.
    const live = (auditData[section] || []).find((x) => x.key === key);
    if (live) live.verdict = { ...j.verdict, stale: false };
    renderAudit();
    if (!stillShowing()) return;              // user moved on — the list is updated, the sheet is not ours
    auditSheetRow = live;
    // A row that lost its verdict is no longer in the list, so the sheet must close.
    if (j.verdict.state === 'improvable') renderAudSheet(); else closeAudSheet();
    toast(j.verdict.state === 'improvable' ? 'Better source found' : 'Nothing better available');
  } catch (err) {
    if (stillShowing()) toast(`Check failed — ${err.message}`);
  } finally {
    // Only the most recent click owns the shared button, so a slow earlier request cannot clear the
    // spinner of the one the user is currently waiting on.
    if (isLatest()) btnIdle(btn);
  }
});

// ── Upgrade section ────────────────────────────────────────────────────────────────────────────
// The whole movie library (805 titles), so it is the only section that pages and searches. Ranked
// server-side by Top 100 position then Beloved profile — Brennan: "so that the movies I in theory
// should care about the most are near the top."
//
// PAGED, not all-at-once. The Library tab renders its ~805 rows in a single innerHTML and gets away
// with it because its rows are two lines of text; these rows carry pills and a verdict, and each
// verified row can hold up to 24 candidates. So the server sends 40 at a time and an
// IntersectionObserver asks for more.
const UPG_PAGE = 40;
let upgRows = [];
let upgTotal = 0;
let upgLibTotal = 0;
let upgQuery = '';
let upgLoading = false;
let upgDone = false;
let upgSeq = 0;          // request sequence — a slow page-1 must never append after a newer search

// The sentinel doubles as the "Loading more…" indicator AND the element the IntersectionObserver
// watches, and those two jobs want opposite things: the observer needs a live box at all times,
// the indicator must only appear during a fetch. So the BOX stays and its CONTENTS toggle — both
// of them. Hiding only the label leaves the spinner animating forever at the foot of an idle list.
const setMoreBusy = (busy) => {
  setHidden('#audit-more .spinner', !busy);
  setHidden('#audit-more-label', !busy);
};

async function loadUpgrade(reset) {
  // A RESET (a new search) must NOT be dropped just because a page is in flight. It used to be,
  // and that was survivable only while infinite scroll was broken and loads were rare; now that
  // the observer fetches continuously, a keystroke landing mid-page silently left upgQuery
  // pointing at the new search while upgRows still held the old one — the next scroll page then
  // appended `q=star` rows at the old query's offset onto unfiltered rows. Bumping upgSeq below
  // orphans the in-flight page (its own `mySeq !== upgSeq` check discards it), which is exactly
  // what that guard was written for and, until now, could never actually happen.
  if (upgLoading && !reset) return;
  if (reset) { upgRows = []; upgDone = false; }
  if (upgDone) return;
  const mySeq = ++upgSeq;
  upgLoading = true;
  setHidden('#audit-more', upgRows.length === 0);   // first page uses the main spinner, not this one
  // A fetch is now in flight — show the indicator again (the previous finally hid it while idle).
  setMoreBusy(true);
  try {
    const qs = new URLSearchParams({ offset: String(upgRows.length), limit: String(UPG_PAGE) });
    if (upgQuery) qs.set('q', upgQuery);
    const r = await fetch(`${API}/api/audit/upgrade?${qs}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // A newer search has been issued — this page belongs to a query the user has moved on from.
    // Appending it would interleave two different result sets, which is the same class of bug as the
    // re-check cross-talk above.
    if (mySeq !== upgSeq) return;
    upgRows = upgRows.concat(j.rows || []);
    upgTotal = j.total || 0;
    upgLibTotal = j.libraryTotal || 0;
    if (!j.rows || !j.rows.length || upgRows.length >= upgTotal) upgDone = true;
    if (auditSection === 'upgrade') renderAudit();
  } catch (e) {
    if (mySeq === upgSeq) { setText('#audit-empty', `Could not load — ${e.message}`); setHidden('#audit-empty', false); }
  } finally {
    if (mySeq === upgSeq) upgLoading = false;
    // The sentinel must STAY VISIBLE while more rows remain — the IntersectionObserver fires on
    // it to fetch the next page. Hiding it unconditionally here is what killed infinite scroll:
    // after page 1 the sentinel was display:none, the observer never fired again, and the list
    // stopped at UPG_PAGE rows forever. Hide it only once the list is exhausted.
    setHidden('#audit-more', upgDone || auditSection !== 'upgrade');
    // The "Loading more…" indicator belongs only to a fetch in flight; idle, the sentinel is just
    // the scroll trigger the observer watches. Its CSS min-height keeps it intersecting either way.
    setMoreBusy(upgLoading);
  }
}

// One row per movie. The CURRENT file is the headline (that is what you are deciding about), and the
// best candidate — when one has been found — is the second line. Unverified rows say so instead of
// implying nothing exists: 805 titles cannot all be pre-searched (~10 hours of paced indexer work),
// so "not checked yet" is the honest default and tapping a row is what spends a search.
function auditUpgradeRowHtml(r) {
  const v = r.verdict || {};
  const b = v.state === 'improvable' ? v.best : null;
  const rank = r.top100 ? `<span class="upg-rank">#${r.top100}</span>` : '';

  const belovedPill = r.beloved ? pill('beloved', 'ok') : '';
  // A swap already in flight renders EXACTLY like the other audit sections — same .swapping class,
  // same health pills, same release line — rather than a bare "replacing now…" that could not say
  // whether the download was actually moving. Not actionable, so no data-key and no role=button:
  // tapping does nothing instead of opening a sheet whose Replace the server would only 409.
  if (r.swapping) {
    const mins = Math.round((Date.now() - r.swapping.since) / 60000);
    return `<li class="row aud upg swapping">
      <span class="grow">
        <span class="title">${rank}${esc(r.title)}</span>
        <div class="aud-line upg-line">
          <span class="aud-delta">${fmtBytes(r.bytes)}${b ? `<i>→</i>${fmtBytes(b.bytes)}` : ''}</span>
          ${swapPills(r.swapping, mins)}
        </div>
        ${r.swapping.rel ? `<div class="aud-swap-rel">${esc(r.swapping.rel)}</div>` : ''}
      </span>
      <span class="aud-right">${b ? seedPill(b.seeders) : ''}</span>
    </li>`;
  }
  // THE ROW DESCRIBES THE COPY YOU OWN, always. Brennan, 2026-07-30: "we should be showing info
  // about the current on disk copy of each movie without clicking 'search for a better copy' (which
  // is text we can remove entirely) ... so I can scan quickly which movies actually like need to be
  // searched for a better copy."
  //
  // The old row led with an instruction ("tap to search for a better copy") and showed nothing about
  // the file itself until a search had been spent, which is backwards on a tab covering the whole
  // library: the decision to search IS the thing the row should be informing. So the size and
  // bitrate of what you have are always present, and the three states are told apart by what is
  // ADDED to them rather than by replacing them:
  //   candidate found  → the size becomes a "3.5 GB → 12 GB" delta and gain/loss pills appear
  //   checked, nothing → a muted "nothing better found"
  //   not checked yet  → nothing extra; the row is simply a statement of what you own
  const size = b ? `${fmtBytes(r.bytes)}<i>→</i>${fmtBytes(b.bytes)}` : fmtBytes(r.bytes);
  // When a candidate exists the quality figure becomes a BEFORE -> AFTER pair, mirroring the size
  // delta immediately to its left. Showing the current file's BPP+ alone next to "549 MB -> 2.1 GB"
  // read as though the number described the candidate, which is the one thing it does not.
  const facts = [size, r.bppPlus != null
    ? (b && b.bppPlus != null
      ? `${bppSpan(r.bppPlus, r.bppBand)}<i>→</i>${bppSpan(b.bppPlus, b.bppBand)}`
      : bppSpan(r.bppPlus, r.bppBand))
    : ''].filter(Boolean).join('<i>·</i>');
  const none = !b && v.state ? '<span class="aud-none">nothing better found</span>' : '';
  return `<li class="row aud upg${qbarCls(r.bppBand)}" data-key="${esc(r.key)}" role="button" tabindex="0">
    <span class="grow">
      <span class="title">${rank}${esc(r.title)}</span>
      <div class="aud-line upg-line">
        <span class="aud-delta">${facts}</span>${none}
        ${b ? gainPills(b) : ''}${belovedPill}${r.editionLabel ? pill(r.editionLabel) : ''}${r.label ? pill(r.label) : ''}${srcPill(r.source, 0)}
      </div>
      <!-- Device support for the copy ON DISK, rendered by the same devPills the candidate cards
           use, so scanning down this column answers "which of these actually need replacing?" at a
           glance. Its own line rather than appended to the badges above: five short pills in a
           fixed order only read as a column if they start at the same x on every row, and the
           badge line's length varies per title. -->
      <div class="aud-pills">${devPills(currentAsCandidate(r))}</div>
    </span>
    <span class="aud-right">${b ? seedPill(b.seeders) : ''}</span>
  </li>`;
}

// The LABELLED TRADEOFF Brennan asked for: "better on >=1 axis, tradeoffs allowed but labelled".
// Gains green, losses red, side by side — so "2160p but a worse source" reads as exactly that rather
// than as an unqualified win. Server-computed (see verifyRow) because the axes need the current
// file's facts, which the client does not have for every candidate.
function gainPills(b) {
  const g = (b.gains || []).map((x) => pill(`+ ${x}`, 'ok')).join('');
  const l = (b.losses || []).map((x) => pill(`− ${x}`, 'bad')).join('');
  return g + l;
}
