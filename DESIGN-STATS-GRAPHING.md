# Feasibility & Design — Graphing System Stats Over Time

**Date:** 2026-07-10 · **Status:** Feasibility / design / no code yet

## TL;DR verdict

**Highly feasible, and cheaper than expected** — the data layer and query API already exist. The three asks decompose into:

| Feature | Effort | New dependency? |
|---|---|---|
| A. Faded trend sparklines behind CPU/RAM/Temp cards | Low | **None** (hand-rolled SVG) |
| B. Uptime bars behind Service rows | Low | **None** (hand-rolled SVG/CSS) |
| C. New "Stats" tab with real charts | Medium | One vendored chart lib (see §5) |

The only genuinely new backend work is **server-side downsampling** (§6) — a ~40-line addition. Everything else is frontend, no build step, no framework.

---

## 1. What already exists (verified 2026-07-10)

### Data layer — `controller/metrics.js` + `/opt/appdata/controller/metrics/`
- Per-day JSONL files, one dir per **stream**: `system`, `disk`, `dl`, `services`, `events`.
- `system` record: `{"cpu":85,"mem":29,"temp":84,"t":1783580406}` — written every **10s** (`recordSystemMetrics`, server.js:2654).
- `disk`: `{total,used,free,pct,t}` (GB) every 10s. `dl`: download summary every 10s. `services`: per-service `up/down` map every **30s** (server.js:2679). `events`: `svc_up`/`svc_down`/`grab`/… point-in-time.
- Volume: ~2 MB/day across all streams (~0.4 MB/day for `system`). **No retention/rollup** — files just accumulate (~730 MB/yr). Fine for now; see §10.

### Query API — already wired
- `GET /api/metrics` → `{streams: {...}}` (lists streams + first/last date).
- `GET /api/metrics?stream=system&from=<epoch>&to=<epoch>&limit=N` → `{stream, data:[{cpu,mem,temp,t}], info, count}` (server.js:2682).
- `GET /api/system` → live `{cpuPct, memPct, tempC}` (server.js:340).
- `metrics.stats(arr, field)` → `{min,max,avg,median,count}` (already used by `scripts/query-metrics.sh`).

### Frontend — `controller/web/` (vanilla, no framework, no build)
- `index.html` (138 lines): dark PWA-style SPA. **Bottom tab bar** with Home / Downloads / Library (`.tabbar`), each a `<section class="tab">`. Adding a 4th tab is trivial.
- System widget is `#sysstats.stat-strip`, rendered by `renderSystem(s)` (app.js:204) — three `.stat` cards each with `.stat-top` (label+value) and a `.stat-meter` "now" bar, colored by health level (`ok`/`warn`/`bad`).
- Services are `.row` elements with a status `.dot` (app.js:117 `renderServices`).
- Poll loop: `poll(pollHome, 10000)` (app.js:775) — 10s, and **pauses when the tab is backgrounded** (`document.hidden`). Good citizen already.
- Served statically via `express.static('web')` (server.js:200). **No external scripts anywhere** — confirmed no CDN/unpkg/jsdelivr refs. Theme = CSS custom props in `:root`: `--bg #0b0d12`, `--card #161a23`, `--ok #34c759`, `--warn #ffb020`, `--danger #ff453a`, `--accent #4f8cff`. Single dark theme.

### Why "no external scripts" matters
The dashboard is reached over the LAN and over Tailscale (often as an HTTP origin, sometimes mixed-content-sensitive). A CDN `<script>` would fail offline and risk mixed-content blocks on mobile. **Any chart lib must be vendored into `web/vendor/`** and served locally. This is the single biggest constraint on the library choice.

---

## 2. The gaps (what's actually missing)

1. **No downsampling.** `queryMetrics` (metrics.js:77) reads points in time order and returns the **first `limit`** matches. A 24h query (~8,640 pts) fits under the 10k limit, but a **7-day query (~60k pts) truncates to the oldest ~28h** — silently wrong for a week view, and 60k points would choke a phone anyway. Need bucketed aggregation server-side.
2. **No chart rendering** on the frontend (no lib, no canvas/SVG chart code yet).
3. **Minor:** `queryMetrics` reads *every* daily file regardless of range. Negligible today; add date-range file filtering when retention grows.
4. **System-wide only.** `cpu/mem/temp` are whole-box (not per-container). Per-service CPU (what we read live via `docker stats` during the thermal work) is **not** in the metrics streams. Out of scope here; noted as a future stream in §10.

---

## 3. Feature A — faded trend sparklines behind CPU / RAM / Temp cards

**Goal:** each `.stat` card shows its last-24h (toggle 7d) trend as a faint line filling the card behind the label/value, keeping the existing `.stat-meter` as the crisp "now" indicator.

**Approach — hand-rolled inline SVG, zero dependency.** SVG `viewBox` scales perfectly on any screen (the mobile win), and a `<polyline>` of ~60–100 downsampled points is trivial.

```
.stat { position: relative; overflow: hidden; }          /* card already has radius/padding */
.stat-spark { position:absolute; inset:0; width:100%; height:100%;
              opacity:.18; pointer-events:none; z-index:0; }
.stat-top, .stat-meter { position: relative; z-index: 1; } /* keep text above the spark */
```

- `renderSystem()` gains a `#{stat}-spark` SVG per card. Path colored by the card's current level var (`--ok`/`--warn`/`--danger`) so the trend inherits the health color already computed at app.js:208.
- Temp is the compelling one: a faded curve showing the nightly trickplay bump (03:00–07:00) and daytime calm right behind the "72°" number.
- Data: one `GET /api/metrics?stream=system&points=90&from=<now-24h>` on load, refreshed every ~60s (not the 10s poll — trends don't move that fast). A tiny in-memory ring of the last ~90 live samples can also feed it with no fetch.

**Effort:** ~40 lines JS + ~10 lines CSS. No dependency.

---

## 4. Feature B — uptime bars behind Service rows

**Goal:** behind each service `.row`, a faint horizontal "uptime bar" (GitHub-status style) over the last 24h/7d — green = up, red = down — plus an optional `99.8%` uptime figure in the `.sub` line.

**Data:** the `services` stream records the per-service up/down map every 30s. For a row, bucket the window into N segments (e.g. 48 bars for 24h = 30-min segments); a segment is red if *any* sample in it was down, green otherwise. `events` (`svc_down`/`svc_up`) gives exact outage boundaries for tooltips.

**Approach:** hand-rolled — a flexbox strip of `<i>` segments, or a single SVG rect row, positioned `absolute; inset:0; opacity:.12` behind `.row .grow`. Reuse `--ok`/`--danger`.

```
GET /api/metrics?stream=services&from=<now-24h>&points=48   → array of {svc→up} buckets
uptime% = up_samples / total_samples   (shown in the row subtitle)
```

**Effort:** ~30 lines JS + ~10 lines CSS. No dependency. **Needs one small server addition:** service-stream bucketing that reduces to per-bucket "all up?" (part of §6).

---

## 5. Feature C — "Stats" tab with real charts (the mobile question)

Add a 4th tab: a `<section id="tab-stats">` + a `.tabbar` button (📈). Content: a **time-range segmented control** (Live / 24h / 7d) and stacked chart cards — **CPU %**, **Temp °C** (with min/avg/max band), **RAM %**, **Disk used**, and a **service-uptime timeline**.

### Chart library evaluation — mobile is the deciding axis

| Option | Size (vendored) | Mobile touch | Dense-data perf | Verdict |
|---|---|---|---|---|
| **uPlot** | ~47 KB | Manual (cursor is good; tooltips DIY) | **Excellent** (built for 10k+ pts) | **Recommended** — tiny, fast, crisp on retina, ideal for time-series |
| **Chart.js** | ~200 KB (+ ~20 KB date adapter) | Good, but needs config (see below) | OK to ~1–2k pts | Fine if you want batteries-included tooltips/legends; heavier |
| **Apex/Recharts/D3** | 140 KB–500 KB+ | Good | OK | Overkill for a vanilla, no-build app |
| **Hand-rolled SVG** | 0 KB | DIY | Fine (post-downsample) | Great for A/B, but a full interactive multi-series tab is a lot to hand-build |

**Recommendation: vendor uPlot for the Stats tab**, and keep A/B as hand-rolled SVG. Rationale: it's ~4× smaller than Chart.js (matters over Tailscale/mobile), purpose-built for exactly this (time-series, thousands of points), and renders razor-sharp on phone DPRs. The cost is that tooltips/legends are more DIY than Chart.js.

**If you specifically prefer Chart.js** (familiarity, richer built-ins), it is viable — the mobile pitfalls and their fixes:

- `responsive:true, maintainAspectRatio:false` + a **fixed-height container** (`height: 42vw` / min 180px). Aspect-ratio mode collapses on narrow screens — this is the #1 mobile gotcha.
- Touch tooltips: `interaction:{mode:'index', intersect:false}` so a tap anywhere shows the nearest point (finger precision ≠ mouse).
- **Downsample to ~200–400 points per view** before handing to the chart. A 360px-wide phone can't show 8,640 points; rendering them is the real perf killer, not the lib.
- Avoid the time-scale date adapter dep: pre-format bucket labels server-side (or use a linear axis + custom tick callback) to save ~20 KB and a moving part.
- Retina: Chart.js handles `devicePixelRatio` automatically; uPlot needs `pxRatio` set — both fine.
- Theme: pass `--muted` for grid/ticks, health colors for series; set legend below the plot (vertical space is scarcer than horizontal on phones... actually the opposite — keep legend compact/top).

**Universal mobile rules (whichever lib):** one metric per chart card (don't cram CPU+temp+RAM into one axis); fixed-height scroll-stacked cards; no hover-only affordances; fetch history once per tab-open, then only tail live data; lazy-load the vendored lib script **only when the Stats tab is first opened** (keeps Home fast).

---

## 6. Server-side downsampling (the one real backend task)

Add bucketed aggregation so any view returns ≤ ~400 points with peaks preserved.

**New in `metrics.js`:**
```js
// queryDownsampled(stream, {from, to, points=300, fields=['cpu','temp','mem']})
//  → [{ t, cpu:{min,avg,max}, temp:{min,avg,max}, ... }]  (one entry per bucket)
// bucketMs = (to-from)/points; assign each raw point to floor((t-from)/bucketMs);
// per bucket, per field: min/avg/max. Empty buckets → null (charts show gaps).
```
**Extend `/api/metrics`:** accept `?points=N` (or `?bucket=<sec>`). When present, return downsampled min/avg/max; else current raw behavior (back-compatible). Also fix the limit-truncates-oldest trap by preferring bucketing for ranges > ~6h.

**Why min/avg/max, not LTTB:** the avg line + shaded min–max band *shows the spikes* (e.g. the 95°C evening blips, the 88°C trickplay plateau) instead of hiding them between samples — far more useful here than a single decimated line. Renders as one line + one band in any lib.

**View presets:**
| Range | Bucket | ~Points | Source |
|---|---|---|---|
| Live | raw 10s | last ~30 | in-memory ring or `from=now-5m` |
| 24h | 5 min | ~288 | `?stream=system&from=now-24h&points=288` |
| 7d | 30 min | ~336 | `?stream=system&from=now-7d&points=336` |

---

## 7. Implementation surface (no build step)

- `controller/metrics.js` — add `queryDownsampled()` (~35 lines) + service-bucket reducer for Feature B (~15).
- `controller/server.js` — extend `/api/metrics` with `points`/`bucket` (~10 lines). *(Requires a controller image rebuild + redeploy to ship — same as the interval changes.)*
- `controller/web/index.html` — add `#tab-stats` section + `.tabbar` button (~15 lines).
- `controller/web/app.js` — `renderStats()` + range control + lazy lib load (~120 lines); sparkline injection into `renderSystem()` (~40); uptime bars in `renderServices()` (~30).
- `controller/web/style.css` — spark/uptime/stats-tab styles (~40 lines).
- `controller/web/vendor/uplot.iife.min.js` + `uplot.min.css` — vendored (only if doing Feature C).

**Rough total:** ~300 lines + one ~47 KB vendored asset. All static-served; frontend-only changes need no rebuild, backend changes need the usual controller redeploy.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| CDN/mixed-content failure on mobile/Tailscale | Vendor the lib locally in `web/vendor/`; never `<script src=cdn>` |
| 60k-point week view chokes phone / truncates | Server-side downsampling to ≤400 pts (§6) — mandatory before any week view |
| Chart lib slows Home tab load | Lazy-load the vendored script only on first Stats-tab open |
| Backgrounds hurt legibility of the value | Keep spark `opacity ≤ .2`, text on `z-index:1`; test on OLED |
| Poll amplification (charts on 10s loop) | History fetched once per tab-open + slow (~60s) trend refresh; live tail only on Live range |
| Metrics files grow unbounded | Optional prune/rollup (§10) — not urgent at ~2 MB/day |
| Per-container CPU expected but absent | Set expectation: charts are system-wide; per-service CPU is a future stream |

---

## 9. Recommended phasing

1. **Phase 1 (frontend-only, no rebuild, no dependency):** Feature A sparklines from the *existing* raw `/api/metrics` (24h fits under the 10k limit). Immediate visible win, validates the SVG approach.
2. **Phase 2 (backend):** add `queryDownsampled` + `?points=` and the service-bucket reducer; ship with the next controller redeploy. Unlocks 7d + Feature B uptime bars.
3. **Phase 3 (Stats tab):** vendor uPlot, build the tab with Live/24h/7d, CPU + Temp(band) + RAM + Disk + uptime timeline.
4. **Phase 4 (optional):** per-service CPU stream; retention/rollup; export/share.

---

## 10. Notes

- **Retention/rollup (optional, later):** keep raw 14d, then a 5-min rollup for 90d, 1-hr rollup beyond — would cap disk and speed week/month views. Not needed now (~730 MB/yr).
- **Per-service CPU (future):** a `proc`/`cgroup` stream (read `/sys/fs/cgroup/.../cpu.stat` per container, or periodic `docker stats`) would let the Stats tab attribute CPU to Jellyfin/Radarr/etc — the thing we had to read live during the 2026-07-09 thermal work.
- **Cross-ref:** relates to the (not-yet-built) `docs/telemetry-plan.md` Phase 2; this doc covers *visualization*, that one covers *collection*.
