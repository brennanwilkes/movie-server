// THE VISUAL SPEC for the controller's Library (Quality) tab, built from LIVE dataset rows.
//
// WHY THIS FILE IS IN THE REPO. The design was not drawn, it was rendered and measured. Eight
// iterations of headless screenshots at 320/390/700/820/1100/1440 caught nine defects that no
// amount of reading the CSS would have found — a header/row grid mismatch putting every column
// ~20px off its label, percentile dots pinned left by invalid CSS math (a percentage times a
// length), a custom property consumed above where it was defined collapsing the grid to one
// column, a control-point chart squashed flat by a threshold-anchored linear axis, and a sticky
// header that does not stick at all inside `overflow-x: auto`. Keep this file working: it is
// cheaper to re-render the mockup than to re-discover any of those in production.
//
//   node docs/quality-mockup/build-mockup.js            # fetches live from the NUC
//   node docs/quality-mockup/build-mockup.js snap.json  # or replays a saved snapshot
//   google-chrome-stable --headless=old --disable-gpu --hide-scrollbars \
//     --window-size=390,1500 --screenshot=shot.png docs/quality-mockup/mockup.html
//
// --headless=old is not a typo: --headless=new IGNORES --window-size and silently renders at
// 500x767, so every measurement taken with it is against the wrong viewport.
//
// READ-ONLY against the server. It only GETs /api/probe/dataset.
const fs = require('fs');
const path = require('path');

const SNAP = process.argv[2];
const API = process.env.CONTROLLER || 'http://192.168.1.74:8088';

async function dataset() {
  if (SNAP) return JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const res = await fetch(`${API}/api/probe/dataset`);
  if (!res.ok) throw new Error(`${API} returned ${res.status}`);
  return res.json();
}

dataset().then(main).catch((e) => {
  console.error(`cannot load the dataset — ${e.message}`);
  console.error(`pass a snapshot path, or set CONTROLLER=http://host:port (default ${API}).`);
  process.exit(1);
});

function main(D) {

const T_CAMBI = 2.817;                       // banding visibility threshold
const band = (p) => (p >= 125 ? 'wow' : p >= 100 ? 'ok' : p >= 75 ? 'warn' : 'bad');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A realistic slice: sorted by BPP+ ascending (the actionable end), mixed kinds.
const rows = D.rows
  .filter((r) => r.bppPlus != null)
  .sort((a, b) => a.bppPlus - b.bppPlus);

// Take a spread so every band and several edge cases appear.
const pick = [
  ...rows.slice(0, 9),                                    // the worst
  ...rows.filter((r) => r.kind === 'season').slice(0, 3),  // TV seasons
  ...rows.filter((r) => r.cambi == null).slice(0, 2),      // unmeasured banding
  ...rows.filter((r) => String(r.title).length > 44).slice(0, 2), // long titles
  ...rows.filter((r) => r.top100 && r.top100 <= 20).slice(0, 3),
  ...rows.filter((r) => r.bppPlus >= 100 && r.bppPlus < 125).slice(0, 3),
  ...rows.filter((r) => r.bppPlus >= 125).slice(0, 3),
  ...rows.filter((r) => r.codec === 'hevc').slice(0, 2),
];
const seen = new Set();
const SEL = pick.filter((r) => !seen.has(r.key) && seen.add(r.key)).slice(0, 26);

// ---- cell formatters (the precision decisions, in one place) -------------------------------
const nul = (t) => `<span class="nul" title="${t}">—</span>`;
const F = {
  // complexity ×1000 — integer. Kills the leading '.' (a 3px glyph carrying all the semantics)
  // and 3 sig figs is the measurement's real resolution at 3-19% RSE.
  cx: (r) => (r.cxEff > 0 ? Math.round(r.cxEff * 1000) : nul('not measured')),
  R: (r) => (r.R != null ? r.R.toFixed(2) : nul('no source bitrate')),
  gb: (r) => (r.bytes > 0 ? (r.bytes / 1e9).toFixed(1) : nul('size unknown')),
  // % of the visibility threshold — comparable row-to-row with no threshold in the reader's head,
  // and the SAME representation the film page's artifact bar uses.
  cambi: (r) => {
    if (r.cambi == null) return nul('banding not measured yet — this is NOT "clean"');
    const p = Math.round((r.cambi / T_CAMBI) * 100);
    return p >= 100 ? `<span class="over">${p}%</span>` : `${p}%`;
  },
  P: (r) => (r.P == null ? nul('no artifact reading') : (r.P > 0 ? '+' : '') + r.P.toFixed(2)),
};
const COLS = [
  { id: 'cx', label: 'CX' }, { id: 'R', label: 'R' },
  { id: 'gb', label: 'GB' }, { id: 'cambi', label: 'BAND' },
];

// Exception-only flags: 83% of the library is Bluray and 89% is h264, so printing those on
// every row is 1054 renders of "normal". A flag appears only when it deviates.
function flags(r) {
  const out = [];
  if (r.kind === 'season') out.push(`<span class="flg s">S${String(r.key.split(':')[2]).padStart(2, '0')}</span>`);
  if (r.codec === 'hevc') out.push('<span class="flg hv">HEVC</span>');
  const src = String(r.source || '');
  if (/remux/i.test(src)) out.push('<span class="flg gd">REMUX</span>');
  else if (/webrip|hdtv|sdtv|dvd/i.test(src)) out.push(`<span class="flg bd">${esc(src.replace(/-?\d+p/i, ''))}</span>`);
  if (r.top100 && r.top100 <= 25) out.push(`<span class="flg t1">★${r.top100}</span>`);
  return out.join('');
}

const RAIL_MAX = 150;   // 97% of the library is <=150; 100 lands at 67% of the rail
function railPct(p) { return Math.max(9, Math.min(100, (p / RAIL_MAX) * 100)).toFixed(1); }

function titleOf(r) {
  let t = String(r.title).replace(/\s*\((\d{4})\)\s*$/, '');
  if (r.kind === 'season') t = t.replace(/\s+S\d+$/, '');
  return t;
}

// ---- card list (phone / tablet) ------------------------------------------------------------
const cards = SEL.map((r) => {
  const b = band(r.bppPlus);
  return `<li class="qrow q-${b}" style="--qf:${railPct(r.bppPlus)}%" tabindex="0" role="button">
  <div class="qr-head">
    <span class="qr-title"><b>${esc(titleOf(r))}</b>${r.year ? `<i>${r.year}</i>` : ''}</span>
    <span class="qr-flags">${flags(r)}</span>
    <span class="qr-plus">${r.bppPlus}</span>
  </div>
  <div class="qr-cols">
    ${COLS.map((c) => `<span class="qr-n c-${c.id}">${F[c.id](r)}</span>`).join('')}
  </div>
</li>`;
}).join('\n');

// ---- desktop grid --------------------------------------------------------------------------
const GCOLS = [
  { id: 'bppPlus', label: 'BPP+', w: 58, f: (r) => `<b class="q-${band(r.bppPlus)}">${r.bppPlus}</b>` },
  { id: 'bppPlus0', label: 'BPP+₀', w: 58, f: (r) => (r.bppPlus0 == null ? nul('') : (r.P == null ? `<i class="nul">${r.bppPlus0}</i>` : r.bppPlus0)) },
  { id: 'cx', label: 'CX', w: 54, f: F.cx },
  { id: 'R', label: 'R', w: 54, f: F.R },
  { id: 'mbps', label: 'SRC', w: 62, f: (r) => (r.srcBitrate ? (r.srcBitrate / 1e6).toFixed(1) : nul('')) },
  { id: 'gb', label: 'GB', w: 56, f: F.gb },
  { id: 'cambi', label: 'BAND', w: 62, f: F.cambi },
  { id: 'P', label: 'P', w: 58, f: F.P },
  { id: 'adq', label: 'ΔADQ', w: 62, f: (r) => (r.adequacyDelta == null ? nul('no per-clip banding') : (r.adequacyDelta > 0 ? '+' : '') + r.adequacyDelta.toFixed(1)) },
  { id: 'src', label: 'TIER', w: 92, f: (r) => esc(String(r.source || '').replace(/-?\d+p/i, '')) || nul('') },
];
const gridHead = `<div class="qg-row qg-head">
  <span class="qg-t"><b class="nm">TITLE</b></span>
  ${GCOLS.map((c) => `<span class="qg-c${c.id === 'bppPlus' ? ' on' : ''}" style="--w:${c.w}px">${c.label}${c.id === 'bppPlus' ? '<em>▴</em>' : ''}</span>`).join('')}
</div>`;
const gridRows = SEL.map((r) => `<div class="qg-row q-${band(r.bppPlus)}" style="--qf:${railPct(r.bppPlus)}%">
  <span class="qg-t"><b class="nm">${esc(titleOf(r))}</b>${r.year ? `<i>${r.year}</i>` : ''}${flags(r)}</span>
  ${GCOLS.map((c) => `<span class="qg-c" style="--w:${c.w}px">${c.f(r)}</span>`).join('')}
</div>`).join('\n');

// ---- the film page ------------------------------------------------------------------------
const FILM = D.rows.find((r) => r.key === 'mv:106') || SEL[0];   // Moneyball — has every field
const peers = D.rows.filter((r) => r.kind === FILM.kind && r.cxEff > 0);
function pct(v, key) { const a = peers.map((x) => x[key]).filter((x) => x != null).sort((x, y) => x - y); return Math.round((a.filter((x) => x < v).length / a.length) * 100); }
function hist(key, val, ref, med) {
  const a = peers.map((x) => x[key]).filter((x) => x != null && x > 0);
  const lo = Math.min(...a), hi = Math.max(...a); const N = 40;
  const bins = Array(N).fill(0);
  for (const v of a) bins[Math.min(N - 1, Math.floor(((v - lo) / (hi - lo)) * N))]++;
  const mx = Math.max(...bins);
  const bars = bins.map((n, i) => `<span style="left:${(i / N) * 100}%;width:${100 / N}%;height:${Math.max(2, (n / mx) * 100)}%"></span>`).join('');
  const at = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(2);
  const srt = a.slice().sort((x, y) => x - y);
  const median = srt[srt.length >> 1];
  return { bars, dot: at(val), ref: ref != null && ref >= lo && ref <= hi ? at(ref) : null,
    med: at(median), medVal: median, lo, hi };
}
function pRow(label, key, val, txt, ref, refTxt) {
  const h = hist(key, val, ref);
  const hasRef = h.ref != null;
  const b = key === 'bppPlus' ? band(val) : null;
  return `<div class="pr">
    <div class="pr-top"><span class="pr-l">${label}</span><span class="pr-v${b ? ' q-' + b : ''}">${txt}</span>
      <span class="pr-p">${pct(val, key)}<sup>th</sup></span></div>
    <div class="pr-track">
      <div class="pr-hist">${h.bars}</div>
      ${hasRef ? `<i class="pr-ref" style="left:${h.ref}%"></i>`
        : `<i class="pr-ref med" style="left:${h.med}%"></i>`}
      <b class="pr-dot${b ? ' q-' + b : ''}" style="--x:${h.dot}"></b>
    </div>
    <div class="pr-ends"><span>${h.lo < 1 ? h.lo.toFixed(2) : Math.round(h.lo)}</span>
      ${hasRef && +h.ref > 8 && +h.ref < 88 ? `<span class="pr-reflbl" style="left:${h.ref}%">${refTxt}</span>`
        : (+h.med > 16 && +h.med < 84
          ? `<span class="pr-reflbl" style="left:${h.med}%">med ${h.medVal < 1 ? h.medVal.toFixed(2) : Math.round(h.medVal)}</span>` : '')}
      <span>${h.hi < 1 ? h.hi.toFixed(2) : Math.round(h.hi)}</span></div>
  </div>`;
}

// artifact meters — position + hatch past the tick, no severity hue
const ART = [
  { k: 'cambi', label: 'banding', lv: FILM.cambi, T: 2.817, dir: 'less' },
  { k: 'block', label: 'blocking', lv: FILM.blockMean, T: 3.710, dir: 'less' },
  { k: 'blur', label: 'blur', lv: FILM.blurMean, T: 8.026, dir: 'less' },
];
const artRows = ART.map((a) => {
  if (a.lv == null) return `<div class="ab"><span class="ab-l">${a.label}</span><span class="ab-r">${nul('not measured')}</span></div>`;
  const frac = a.lv / a.T;                       // 100% = at the threshold, drawn at the midpoint
  const w = Math.min(frac, 2) / 2 * 100;
  const over = frac >= 1;
  return `<div class="ab">
    <span class="ab-l">${a.label}</span>
    <span class="ab-r">${a.lv.toFixed(2)} <i>/ ${a.T.toFixed(2)}</i> <b class="ab-p${over ? ' bad' : ''}">${Math.round(frac * 100)}%</b></span>
    <div class="ab-track${over ? ' over' : ''}"><div class="ab-fill" style="width:${w.toFixed(1)}%"></div><i class="ab-tick"></i></div>
  </div>`;
}).join('');
const grainFrac = 2.817 && FILM.blurMean ? null : null;

// the waterfall: BPP+₀ -> provenance -> adequacy -> BPP+
const WF_LO = 50, WF_HI = 250;
const wfx = (v) => (((v - WF_LO) / (WF_HI - WF_LO)) * 100).toFixed(2);
const base = FILM.bppPlus0, live = FILM.bppPlus;
const adq = FILM.adequacyDelta || 0;
const prov = live - base - adq;
const lo_ = Math.min(base, live), hi_ = Math.max(base, live);
const segs = [
  `<i class="wf-span${live < base ? ' sub' : ' add'}" style="left:${wfx(lo_)}%;width:${(wfx(hi_) - wfx(lo_)).toFixed(2)}%"></i>`,
  `<i class="wf-end from" style="left:${wfx(base)}%"></i>`,
  `<i class="wf-end to q-${band(live)}" style="left:${wfx(live)}%"></i>`,
  `<em class="wf-lbl" style="left:${wfx((base + live) / 2)}%">${prov > 0 ? '+' : ''}${prov.toFixed(0)} prov${Math.abs(adq) >= 0.5 ? ` · ${adq > 0 ? '+' : ''}${adq.toFixed(0)} adq` : ''}</em>`,
];
const wfTicks = [50, 75, 100, 125, 150, 200, 250].map((t) => `<i class="wf-t${t === 100 ? ' key' : ''}" style="left:${wfx(t)}%"><b>${t}</b></i>`).join('');

// control-points chart — banding (94% coverage), the default series
const CP = (FILM.sampleCambi || []).map((v, i) => ({ v, p: (FILM.sampleCambiPos || [])[i] }));
const cpMean = CP.length ? CP.reduce((s, x) => s + x.v, 0) / CP.length : 0;
const cpSd = CP.length > 1 ? Math.sqrt(CP.reduce((s, x) => s + (x.v - cpMean) ** 2, 0) / (CP.length - 1)) : 0;
const cpSE = cpSd / Math.sqrt(Math.max(1, CP.length));
const CW = 600, CH = 250, PADL = 34, PADR = 12, PADT = 14, PADB = 30;
const cpTop = Math.max(2.817 * 1.25, ...CP.map((x) => x.v)) * 1.05;
const SQ = (v) => Math.sqrt(Math.max(0, v));      // sqrt: handles exact 0, compresses the tail
const cx_ = (p) => PADL + p * (CW - PADL - PADR);
const cy_ = (v) => PADT + (1 - SQ(v) / SQ(cpTop)) * (CH - PADT - PADB);
const hhmmss = (f) => { const s = Math.round(f * (FILM.duration || 0)); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const cpDots = CP.map((x, i) => `<circle class="cp-hit" cx="${cx_(x.p).toFixed(1)}" cy="${cy_(x.v).toFixed(1)}" r="14"/>
  <circle class="cp-dot${i === 7 ? ' sel' : ''}" cx="${cx_(x.p).toFixed(1)}" cy="${cy_(x.v).toFixed(1)}" r="4.5"/>`).join('');
const cpYt = [0, 2.817 / 4, 2.817, cpTop].map((v) => `<line class="cp-g" x1="${PADL}" x2="${CW - PADR}" y1="${cy_(v).toFixed(1)}" y2="${cy_(v).toFixed(1)}"/>
  <text class="cp-ax" x="${PADL - 6}" y="${(cy_(v) + 3.5).toFixed(1)}" text-anchor="end">${v < 1 ? v.toFixed(2) : v.toFixed(1)}</text>`).join('');
const cpXt = [0, .25, .5, .75, 1].map((p, i) => `<text class="cp-ax" x="${cx_(p).toFixed(1)}" y="${CH - PADB + 16}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${hhmmss(p)}</text>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Quality tab — mockup</title>
<style>
:root{
  --bg:#0b0d12; --card:#161a23; --card-2:#1d2230; --text:#eef1f6; --muted:#8b93a7;
  --line:#262c3a; --accent:#4f8cff; --ok:#28d9a0; --wow:#c79cf7; --off:#5b6270;
  --warn:#ffb020; --danger:#ff453a; --radius:16px; --tabbar-h:58px;
  --topbar-h:calc(env(safe-area-inset-top) + 65px);
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px;
  color-scheme:dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
button,input,select{font:inherit}
html,body{margin:0}
body{background:var(--bg);color:var(--text);
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  padding-bottom:calc(72px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}

/* band colours — hue is IDENTITY; order is carried by the rail's LENGTH */
.q-wow{--qc:var(--wow)} .q-ok{--qc:var(--ok)} .q-warn{--qc:var(--warn)} .q-bad{--qc:var(--danger)}

.topbar{position:sticky;top:0;z-index:5;padding:calc(env(safe-area-inset-top) + 14px) 20px 12px;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line)}
.topbar h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-.02em}
main{padding:var(--s4);max-width:640px;margin:0 auto}
body.tab-wide main{max-width:900px}
@media (min-width:1024px){body.tab-wide main{max-width:1440px;padding:var(--s4) 20px}}
h2.sec{margin:var(--s5) 0 var(--s2);font-size:13px;font-weight:600;text-transform:uppercase;
  letter-spacing:.06em;color:var(--muted)}

/* ── control block: ONE container, 2 rows, 88px ───────────────────────── */
.qctl{position:sticky;top:var(--topbar-h);z-index:4;display:flex;flex-direction:column;gap:var(--s2);
  padding:var(--s2) 0;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(12px)}
.qctl-a{display:flex;gap:var(--s2)}
.segmented{display:flex;background:var(--card-2);border-radius:12px;padding:4px;gap:4px;flex:0 0 172px}
.segmented button{flex:1;min-width:0;min-height:36px;border:0;border-radius:9px;background:transparent;
  color:var(--muted);font-weight:600;font-size:14px;cursor:pointer}
.segmented button.active{background:var(--card);color:var(--text)}
.search{flex:1;min-width:0;min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line);
  background:var(--card);color:var(--text);font-size:16px}
.qctl-b-wrap{position:relative;min-width:0}
.qctl-b{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;
  scroll-padding:0 8px;-webkit-overflow-scrolling:touch;
  /* the fade IS the affordance, and it is a mask so it works over any background.
     It retracts on its own at each end — no scroll listener needed. */
  mask-image:linear-gradient(90deg,transparent 0,#000 14px,#000 calc(100% - 22px),transparent 100%);
  mask-composite:intersect}
.qctl-b::-webkit-scrollbar{display:none}
.qsel{flex:none;min-height:36px;padding:0 28px 0 11px;border-radius:10px;border:1px solid var(--line);
  background:var(--card);color:var(--text);font-size:13.5px;font-weight:600;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b93a7' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center}
.qdir,.qgear{flex:none;width:36px;height:36px;border-radius:10px;border:1px solid var(--line);
  background:var(--card);color:var(--text);font-size:14px;cursor:pointer;position:relative}
.qgear b{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;border-radius:99px;
  background:var(--accent);color:#fff;font-size:9.5px;font-weight:800;line-height:15px}
.chip{flex:none;height:32px;padding:0 11px;border-radius:8px;border:1px solid var(--line);
  background:var(--card);color:var(--muted);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}
.chip.on{background:color-mix(in srgb,var(--accent) 16%,var(--card));border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--text);
  padding-right:4px;display:inline-flex;align-items:center;gap:2px}
.chip.on em{width:26px;height:26px;border-radius:6px;display:grid;place-items:center;font-style:normal;
  color:var(--muted);font-size:13px}

/* ── the sticky mini-header: ONE set of labels, not 4216 ──────────────── */
.qlist-wrap{--qgrid:1fr repeat(4,minmax(0,56px))}
.qhead b{font-weight:700}
.qhead{position:sticky;top:calc(var(--topbar-h) + 104px);z-index:3;height:26px;display:grid;
  grid-template-columns:var(--qgrid);column-gap:var(--s2);
  align-items:center;padding:0 var(--s4) 0 20px;
  background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--muted)}
.qhead span{text-align:right}
.qhead .qh-t{text-align:left;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}
.qhead .qh-t b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qhead .on{color:var(--text)}
/* the position readout rides in the TITLE cell, outside the numeric tracks, so it can never
   shift a column. Live: the range of the sorted value across the rows on screen. */
.qhead .pos{flex:none;margin-left:auto;font-variant-numeric:tabular-nums;letter-spacing:0;
  padding:1px 6px;border-radius:6px;background:var(--card-2);color:var(--muted);white-space:nowrap}

/* ── the list: one panel, hairline rows, FIXED 76px ───────────────────── */
.qlist{list-style:none;margin:0;padding:0;background:var(--card);border-radius:var(--radius);overflow:hidden}
.qrow{position:relative;height:76px;padding:var(--s3) var(--s4) var(--s3) 20px;
  display:grid;grid-template-rows:24px 1fr;row-gap:var(--s1);
  border-top:1px solid var(--line);cursor:pointer;
  content-visibility:auto;contain-intrinsic-size:auto 76px}
.qrow:first-child{border-top:0}
.qrow:active{background:var(--card-2)}
.qrow:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
/* THE RAIL — length = BPP+ (0-150), hue = band. Length is the channel that survives
   every CVD type, greyscale and 4px. */
.qrow::before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:4px;
  border-radius:0 3px 3px 0;background:var(--qc)}
.qr-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.qr-flags{flex:none;display:flex;gap:4px;align-items:center}
.qr-title{flex:1;min-width:0;display:flex;align-items:baseline;gap:7px;overflow:hidden}
.qr-title b{min-width:0;font-weight:600;font-size:16px;line-height:1.4;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qr-title i{flex:none;font-style:normal;font-weight:500;color:var(--muted);font-size:14px}
.qr-plus{flex:0 0 46px;text-align:right;font-size:22px;font-weight:700;line-height:1.1;
  font-variant-numeric:tabular-nums;color:var(--qc)}
.qr-cols{display:grid;grid-template-columns:var(--qgrid);column-gap:var(--s2);align-items:baseline}
.qr-cols .qr-n:first-of-type{grid-column:2}

.qr-n{text-align:right;font-size:13px;font-weight:600;line-height:1.4;
  font-variant-numeric:tabular-nums slashed-zero;color:#dbe1ea}
.qr-n .over,.qg-c .over{color:var(--warn);font-weight:750}
.qr-n .over::before,.qg-c .over::before{content:'▲';font-size:7.5px;margin-right:2px;vertical-align:1.5px}
.nul{color:var(--muted);font-weight:500;display:inline-block;min-width:3ch;text-align:right}
.qr-tail{display:flex;gap:4px;justify-content:flex-end;align-items:center;overflow:hidden}
.flg{flex:none;padding:2px 5px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.02em;
  font-variant-numeric:tabular-nums}
.flg.s {background:color-mix(in srgb,var(--muted) 18%,transparent);color:#c3cad8}
.flg.hv{background:color-mix(in srgb,var(--danger) 10%,transparent);color:var(--danger)}
.flg.bd{background:color-mix(in srgb,var(--warn) 10%,transparent);color:var(--warn)}
.flg.gd{background:color-mix(in srgb,var(--ok) 10%,transparent);color:var(--ok)}
.flg.t1{background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--accent)}
@media (max-width:360px){
  .qlist-wrap{--qgrid:1fr repeat(3,minmax(0,52px))}
  .qhead .h-gb,.qr-cols .c-gb{display:none}
  .qr-title b{font-size:15px}
  .qr-plus{font-size:20px;flex-basis:42px}
  .qctl-a{flex-wrap:wrap}.segmented{flex:1 1 100%}.search{flex:1 1 100%}
}
.qfoot{margin-top:var(--s3);font-size:12.5px;color:var(--muted);display:flex;gap:var(--s2);align-items:center}
.qfoot button{height:30px;padding:0 10px;border-radius:8px;background:var(--card-2);border:1px solid var(--line);
  color:var(--muted);font-size:12px;font-weight:600;cursor:pointer}

/* ── desktop grid ─────────────────────────────────────────────────────── */
.qgrid-wrap{display:none}
@media (min-width:700px){
  .qlist-wrap{display:none}
  .qgrid-wrap{display:block;position:relative;background:var(--card);border-radius:var(--radius);overflow:hidden}
  /* horizontal-scroll affordance: an overlay on the WRAPPER, toggled by a scroll listener that
     compares scrollLeft/scrollWidth. Never permanent — the default 10-column set does not
     overflow a 1440px window, and a shadow over nothing is a lie. */
  .qgrid-wrap::after{content:'';position:absolute;top:0;right:0;bottom:0;width:34px;pointer-events:none;
    background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--bg) 86%,transparent));
    opacity:0;transition:opacity .15s}
  .qgrid-wrap.can-r::after{opacity:1}
  /* the title column width lives on the SCROLLER (which carries --qgc), not on the row —
     a custom property must be defined at or above the element that consumes it. */
  .qgrid{--tw:232px}
  @media (min-width:1024px){.qgrid{--tw:300px}}
  .qgrid{overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
  .qg-row{display:grid;grid-template-columns:var(--qgc);align-items:center;height:34px;
    border-top:1px solid var(--line);position:relative;padding-left:4px;
    content-visibility:auto;contain-intrinsic-size:auto 34px}
  .qg-row:not(.qg-head)::after{content:'';position:absolute;left:0;top:7px;bottom:7px;width:3px;
    background:var(--qc);height:auto}
  .qg-head{height:32px;position:sticky;top:0;z-index:2;background:var(--card);border-top:0;
    font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--muted)}
  .qg-head .qg-c em{font-style:normal;font-size:9px;position:absolute;right:4px;top:50%;margin-top:-5px}
  .qg-head .qg-c{position:relative;padding-right:14px}
  .qg-head .on{color:var(--text)}
  .qg-row:hover:not(.qg-head){background:var(--card-2)}
  .qg-t{position:sticky;left:0;z-index:1;background:inherit;padding:0 14px 0 12px;
    font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}
  .qg-t b.nm{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .qg-t .flg{flex:none}
  .qg-t i{font-style:normal;font-weight:500;color:var(--muted);font-size:12px}
  .qg-c{width:var(--w);text-align:right;padding-right:10px;font-size:13px;font-weight:500;
    color:#dbe1ea;font-variant-numeric:tabular-nums slashed-zero}
  .qg-c.hl{background:color-mix(in srgb,var(--accent) 7%,transparent)}
  .qg-c b{font-weight:700;color:var(--qc)} .qg-c i{font-style:italic;color:var(--muted)}
  .qg-row b.q-wow{color:var(--wow)}.qg-row b.q-ok{color:var(--ok)}
  .qg-row b.q-warn{color:var(--warn)}.qg-row b.q-bad{color:var(--danger)}
  .qgrid.scrolled .qg-t{box-shadow:8px 0 10px -8px rgba(0,0,0,.75)}
}

/* ── film page ────────────────────────────────────────────────────────── */
.card{background:var(--card);border-radius:var(--radius);padding:var(--s4)}
.fhead{display:flex;align-items:center;gap:10px;margin-bottom:var(--s3)}
.fback{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--card);
  color:var(--text);cursor:pointer;flex:none}
.ftitle{font-size:20px;font-weight:700;line-height:1.25;min-width:0}
.fsub{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:12.5px;color:var(--muted)}
.fhero{display:flex;align-items:flex-end;gap:var(--s4);margin-bottom:var(--s4)}
.fplus{font-size:52px;font-weight:700;line-height:.95;letter-spacing:-.02em;
  color:color-mix(in srgb,var(--qc) 88%,var(--text))}
.fband{font-size:13px;font-weight:600;color:var(--qc);text-transform:uppercase;letter-spacing:.06em}
.fconf{font-size:11px;color:var(--muted);margin-top:2px}
.qstats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s2)}
@media (min-width:700px){.qstats{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:1024px){.qstats{grid-template-columns:repeat(4,minmax(0,1fr))}}
.stat{background:var(--card-2);border-radius:12px;padding:8px 11px;min-width:0}
.stat-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.stat-val{font-size:18px;font-weight:700;color:var(--text);white-space:nowrap;margin-top:1px}
.stat-val small{font-size:12px;font-weight:600;color:var(--muted);margin-left:3px}

/* percentile row: TWO POSITIONS + the peer distribution — no fill, no rank-as-length */
.pr{margin-top:var(--s4)}
.pr-top{display:flex;align-items:baseline;gap:var(--s2);font-size:13px}
.pr-l{flex:1;color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
.pr-v{font-weight:700;font-variant-numeric:tabular-nums}
.pr-p{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;min-width:36px;text-align:right}
.pr-p sup{font-size:8.5px}
.pr-track{position:relative;height:26px;margin-top:5px;border-radius:6px;background:var(--card-2);overflow:hidden}
.pr-hist{position:absolute;inset:0}
.pr-hist span{position:absolute;bottom:0;background:color-mix(in srgb,var(--muted) 26%,transparent)}
.pr-ref{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed color-mix(in srgb,var(--text) 45%,transparent)}
.pr-ref.med{border-left-style:dotted;border-left-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.pr-track{overflow:visible}
.pr-hist{overflow:hidden;border-radius:6px}
.pr-dot{position:absolute;top:50%;left:calc(7px + (var(--x) / 100) * (100% - 14px));
  width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:99px;
  background:var(--text);box-shadow:0 0 0 2.5px var(--qc),0 0 0 4.5px var(--card-2)}
.pr-ends{position:relative;display:flex;justify-content:space-between;margin-top:3px;
  font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
.pr-reflbl{position:absolute;transform:translateX(-50%);white-space:nowrap}

/* artifact meters: position + hatch. No severity hue. */
.abs{display:flex;flex-direction:column;gap:var(--s3);margin-top:var(--s3)}
.ab{display:grid;grid-template-columns:1fr auto;row-gap:var(--s1)}
.ab-l{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.ab-r{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--text);text-align:right}
.ab-r i{color:var(--muted);font-style:normal}
.ab-r b{display:inline-block;min-width:38px;text-align:right;color:var(--muted);font-weight:600}
.ab-r b.bad{color:var(--danger);font-weight:800}
.ab-track{grid-column:1/-1;position:relative;height:10px;border-radius:5px;background:var(--card-2);overflow:hidden}
.ab-fill{height:100%;border-radius:5px 0 0 5px;background:color-mix(in srgb,var(--muted) 52%,transparent)}
.ab-track.over .ab-fill{background:repeating-linear-gradient(45deg,transparent 0 3px,color-mix(in srgb,var(--danger) 60%,transparent) 3px 6px),color-mix(in srgb,var(--danger) 22%,transparent)}
.ab-tick{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--text);opacity:.75}

.abhint{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:2px}

/* waterfall on the published score axis */
.wf{position:relative;height:56px;margin:var(--s4) 0 var(--s2)}
.wf-ax{position:absolute;left:0;right:0;bottom:18px;height:1px;background:var(--line)}
.wf-t{position:absolute;bottom:18px;width:1px;height:5px;background:var(--line)}
.wf-t b{position:absolute;bottom:-17px;left:50%;transform:translateX(-50%);font-size:10px;
  font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
.wf-span{position:absolute;top:23px;height:7px;border-radius:4px;min-width:14px}
.wf-span.add{background:color-mix(in srgb,var(--text) 34%,transparent)}
.wf-span.sub{background:repeating-linear-gradient(45deg,transparent 0 3px,color-mix(in srgb,var(--muted) 62%,transparent) 3px 6px),color-mix(in srgb,var(--muted) 16%,transparent)}
.wf-end{position:absolute;top:20px;width:13px;height:13px;margin-left:-6.5px;border-radius:99px}
.wf-end.from{background:var(--card);box-shadow:0 0 0 2.5px var(--muted)}
.wf-end.to{background:var(--qc);box-shadow:0 0 0 2.5px var(--card)}
.wf-lbl{position:absolute;top:0;transform:translateX(-50%);font-size:10.5px;font-weight:700;
  color:var(--muted);font-style:normal;white-space:nowrap}
.wf-t.key{background:color-mix(in srgb,var(--text) 40%,transparent);height:8px}
.wf-t.key b{color:var(--text)}
.wf-cap{display:flex;justify-content:space-between;gap:var(--s3);font-size:11.5px;color:var(--muted);
  align-items:baseline}
.wf-cap b{color:var(--text);font-variant-numeric:tabular-nums}
.wf-cap em{font-style:normal;display:block;font-size:10.5px;opacity:.85}
.wf-key{display:inline-block;width:9px;height:9px;border-radius:99px;margin-right:5px}
.wf-key.from{background:var(--card);box-shadow:0 0 0 2px var(--muted)}
.wf-key.to{background:var(--wow);box-shadow:0 0 0 2px var(--card)}

/* chart */
.cp-wrap{margin-top:var(--s3)}
.cp svg{width:100%;height:auto;display:block;touch-action:pan-y}
.cp-g{stroke:var(--line);stroke-width:1}
.cp-ax{fill:var(--muted);font-size:10px;font-variant-numeric:tabular-nums}
.cp-se{fill:color-mix(in srgb,var(--accent) 12%,transparent)}
.cp-mean{stroke:var(--accent);stroke-width:2}
.cp-thr{stroke:var(--warn);stroke-width:1.5;stroke-dasharray:5 4}
.cp-dot{fill:var(--text);stroke:var(--card);stroke-width:2}
.cp-dot.sel{fill:var(--warn);r:7}
.cp-hit{fill:transparent}
.cp-read{display:flex;gap:var(--s2);align-items:baseline;margin-top:var(--s2);padding:8px 10px;
  background:var(--card-2);border-radius:10px;font-size:12.5px}
.cp-read b{font-variant-numeric:tabular-nums;font-size:14px}
.cp-read span{color:var(--muted)}
.head-ctl{display:flex;gap:6px;align-items:center;margin-left:auto}
.panel-head{display:flex;align-items:center;gap:var(--s2)}
.panel-head h3{margin:0;font-size:15px;font-weight:700}
.qhelp{width:26px;height:26px;flex:none;border-radius:99px;border:1px solid var(--line);
  background:none;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer}
.tog{height:30px;padding:0 10px;border-radius:9px;border:1px solid var(--line);background:var(--card-2);
  color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;min-width:82px}
.seasons{display:flex;gap:6px;overflow-x:auto;margin:0 0 var(--s4);scrollbar-width:none;
  mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 20px),transparent 100%)}
.seasons button{flex:none;width:54px;height:46px;border-radius:10px;border:1px solid var(--line);
  background:var(--card);cursor:pointer;display:grid;place-items:center;gap:1px;padding:0}
.seasons button.on{background:var(--card-2);border-bottom:3px solid var(--qc)}
.seasons em{font-style:normal;font-size:10.5px;font-weight:700;color:var(--muted)}
.seasons b{font-size:15px;font-weight:700}

.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(12px);
  border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
.tabbar button{flex:1;min-width:0;background:none;border:0;color:var(--muted);cursor:pointer;
  padding:8px 0 10px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px}
.tabbar button.active{color:var(--accent)}
.tabbar svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round}
</style></head><body class="tab-wide">
<header class="topbar"><div class="header-disk-row"><h1>Library</h1></div></header>
<main>

  <div class="qctl">
    <div class="qctl-a">
      <div class="segmented"><button>Movies</button><button>TV</button><button class="active">All</button></div>
      <input class="search" type="search" placeholder="Search titles…">
    </div>
    <div class="qctl-b-wrap"><div class="qctl-b">
      <select class="qsel"><option>Sort BPP+</option></select>
      <button class="qdir">↑</button>
      <button class="qgear">⚙<b>2</b></button>
      <button class="chip on">8–40 GB<em>×</em></button>
      <button class="chip on">Banded<em>×</em></button>
      <button class="chip">Top 100</button>
      <button class="chip">Under 75</button>
      <button class="chip">HEVC</button>
      <button class="chip">Unmeasured</button>
    </div></div>
  </div>

  <div class="qlist-wrap">
  <div class="qhead">
    <span class="qh-t"><b class="on">TITLE&nbsp;▴</b><span class="pos">34–71</span></span>
    <span class="h-cx">CX</span><span class="h-R">R</span><span class="h-gb">GB</span><span class="h-cambi">BAND</span>
  </div>
  <ul class="qlist">
${cards}
  </ul>
  </div>

  <div class="qgrid-wrap can-r"><div class="qgrid scrolled" style="--qgc:var(--tw) ${GCOLS.map((c) => c.w + 'px').join(' ')}">
${gridHead}
${gridRows}
  </div></div>

  <div class="qfoot"><span>812 of 1054 measured units</span><button>18 not measured →</button></div>

  <h2 class="sec">Film page</h2>
  <div class="card">
    <div class="fhead">
      <button class="fback">←</button>
      <div style="min-width:0">
        <div class="ftitle">${esc(titleOf(FILM))} <span style="color:var(--muted);font-weight:500">${FILM.year}</span></div>
        <div class="fsub"><span class="flg gd">REMUX</span><span class="flg t1">★${FILM.top100}</span>
          <span>${FILM.probeW}×${FILM.probeH} · ${FILM.fps.toFixed(2)} · ${Math.floor(FILM.duration / 3600)}h${String(Math.round(FILM.duration % 3600 / 60)).padStart(2, '0')} · ${(FILM.bytes / 1e9).toFixed(1)} GB</span></div>
      </div>
    </div>
    <div class="seasons" aria-label="Seasons of this show">
      <button class="on q-warn"><em>S01</em><b style="color:var(--warn)">71</b></button>
      <button class="q-ok"><em>S02</em><b style="color:var(--ok)">112</b></button>
      <button class="q-wow"><em>S03</em><b style="color:var(--wow)">147</b></button>
      <button class="q-bad"><em>S04</em><b style="color:var(--danger)">64</b></button>
    </div>
    <div class="fhero q-${band(FILM.bppPlus)}">
      <div><div class="fplus">${FILM.bppPlus}</div></div>
      <div style="padding-bottom:5px"><div class="fband">${band(FILM.bppPlus) === 'wow' ? 'beyond the display' : band(FILM.bppPlus)}</div>
        <div class="fconf">measured · 16 clips · ±${Math.round(FILM.cxRSE * 50)}%</div></div>
    </div>
    <div class="qstats">
      <div class="stat"><div class="stat-label">at flat 0.13</div><div class="stat-val">${FILM.bppPlusFlat}</div></div>
      <div class="stat"><div class="stat-label">complexity ×1000</div><div class="stat-val">${Math.round(FILM.cxEff * 1000)}</div></div>
      <div class="stat"><div class="stat-label">supply R</div><div class="stat-val">${FILM.R.toFixed(2)}</div></div>
      <div class="stat"><div class="stat-label">source</div><div class="stat-val">${(FILM.srcBitrate / 1e6).toFixed(1)}<small>Mb/s</small></div></div>
      <div class="stat"><div class="stat-label">audio share</div><div class="stat-val">${Math.round(FILM.audioBps / FILM.srcBitrate * 100)}<small>%</small></div></div>
      <div class="stat"><div class="stat-label">clips</div><div class="stat-val">${FILM.sampleNEff}<small>eff</small></div></div>
    </div>
    ${pRow('BPP+', 'bppPlus', FILM.bppPlus, String(FILM.bppPlus), 100, '100')}
    ${pRow('complexity ×1000', 'cxEff', FILM.cxEff, String(Math.round(FILM.cxEff * 1000)), null, '')}
    ${pRow('supply R', 'R', FILM.R, FILM.R.toFixed(2), 1, 'R 1.0')}
  </div>

  <div class="card" style="margin-top:14px">
    <div class="panel-head"><h3>Where the score came from</h3><button class="qhelp">?</button></div>
    <div class="wf">
      <div class="wf-ax"></div>${wfTicks}${segs.join('')}
    </div>
    <div class="wf-cap"><span><i class="wf-key from"></i>BPP+₀ <b>${base}</b> <em>bits vs this film's own transparent cost</em></span>
      <span><i class="wf-key to"></i>BPP+ <b>${live}</b> <em>after provenance</em></span></div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="panel-head"><h3>Artifacts</h3><button class="qhelp">?</button></div>
    <div class="abhint"><span>measured / visibility threshold</span><span>tick = threshold</span></div>
    <div class="abs">${artRows}</div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="panel-head"><h3>Control points</h3>
      <div class="head-ctl"><select class="qsel"><option>banding</option></select><button class="tog">sorted</button></div>
      <button class="qhelp">?</button></div>
    <div class="cp-wrap cp">
      <svg viewBox="0 0 ${CW} ${CH}" role="img">
        ${cpYt}
        <rect class="cp-se" x="${PADL}" y="${cy_(cpMean + cpSE).toFixed(1)}" width="${CW - PADL - PADR}" height="${Math.max(2, cy_(cpMean - cpSE) - cy_(cpMean + cpSE)).toFixed(1)}"/>
        <line class="cp-mean" x1="${PADL}" x2="${CW - PADR}" y1="${cy_(cpMean).toFixed(1)}" y2="${cy_(cpMean).toFixed(1)}"/>
        <line class="cp-thr" x1="${PADL}" x2="${CW - PADR}" y1="${cy_(2.817).toFixed(1)}" y2="${cy_(2.817).toFixed(1)}"/>
        <text class="cp-ax" x="${CW - PADR}" y="${(cy_(2.817) - 5).toFixed(1)}" text-anchor="end" fill="#ffb020">visible 2.82</text>
        ${cpDots}${cpXt}
      </svg>
      <div class="cp-read"><b>${CP[7] ? CP[7].v.toFixed(3) : '—'}</b><span>at ${CP[7] ? hhmmss(CP[7].p) : '—'} · clip 8 of ${CP.length} · ${((CP[7] ? CP[7].v : 0) / 2.817 * 100).toFixed(0)}% of threshold</span></div>
    </div>
  </div>
</main>
<nav class="tabbar">
  <button><svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/></svg><span>Home</span></button>
  <button><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg><span>Downloads</span></button>
  <button class="active"><svg viewBox="0 0 24 24"><path d="M4 5h12v16H4zM16 7l4 1-3 13-4-1"/></svg><span>Library</span></button>
  <button><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><span>Audit</span></button>
  <button><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg><span>Jobs</span></button>
</nav>
</body></html>`;

const out = path.join(__dirname, 'mockup.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} — ${(html.length / 1024).toFixed(0)} KB, ${SEL.length} rows of ${D.n}`);
console.log(`film page: ${FILM.title} — BPP+₀ ${base} → prov ${prov > 0 ? '+' : ''}${prov.toFixed(1)}`
  + `${Math.abs(adq) >= 0.5 ? ` → adq ${adq > 0 ? '+' : ''}${adq.toFixed(1)}` : ''} → BPP+ ${live}`);
}
