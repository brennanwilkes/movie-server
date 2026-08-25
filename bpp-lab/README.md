# bpp-lab

An exploration and experimentation UI for the BPP+ model. Same shape as `elo-tuner/`: plain Vite,
no framework, `/api` proxied to the NUC.

```bash
cd bpp-lab
npm install
npm run dev          # http://localhost:5174
```

The algorithm itself is documented in [`../docs/BPP-PLUS.txt`](../docs/BPP-PLUS.txt). This tool is
for looking at it; that file is for understanding it. **If you change the model, update that file in
the same change.**

## Where the data comes from

Everything is one call to `GET /api/probe/dataset` — a read-only per-unit measurement table added to
`controller/lib/probe.js` for this tool. It returns both the raw and the corrected complexity, the
per-sample control points, the banked upgrade pairs, and the score the app currently shows.

**It deliberately does not read `/config/probe-cache.json` directly.** The cache holds the raw
measurement but not the derived numbers — the bias factor, the effective target, the score — because
those live in code. A lab that re-implemented them would drift from the controller silently, and then
every finding here would be about the lab rather than about the library.

The one exception is `score()` in `src/data.js`, which recomputes the index so a what-if slider can
ask "what would the library look like at a different exponent". (The overview's headroom what-if was
dropped on 2026-08-18 and the Quality curve's draggable control points went with it; the curve is a
view now, not a rig.) Nothing in this tool writes to the server.

## The tabs

| tab | what it is for |
|---|---|
| **Overview** | Where the library sits, precision coverage, the BPP+ distribution, complexity vs bitrate, source tiers. Start here. |
| **Quality curve** | The library plotted on the axis everything else derives from: x = supply, y = BPP+, with the corrections drawn as overlays and colour-by to show which kinds of film each one hits. |
| **Film** | One title all the way down — its sample readings as a quantile plot, its error bar, percentile context, banked upgrade pairs. |
| **Table** | Every derived column, sortable, with CSV export. |

Two tabs were built and removed. **Clusters** (k-means over content-cost features) went on 2026-08-18
as the most machinery for the least actionable output. **Pinning bias** was folded into the Quality
curve's correction overlay once it became clear the correction is a shift along one axis and did not
need a page of its own.

`kmeans()` survives in `src/stats.js` if the clustering question comes back.

## Things to know before you trust a chart here

- **Nothing here has been validated against a subjective label.** The 2026-08-13 eleven-film test was
  retracted — what was being scored as "artifacts" was grain, so the labels measured grain-visibility
  rather than compression. There is currently **no confirmed case in this library of a film judged
  genuinely compression-damaged**, which means BPP+ has never been shown to misrank anything, and
  also that no proposed curve can be shown to beat it. The honest state is *untested*, not broken.
- **`blockMean` and `blurMean` are untested, not falsified.** The correlations that appeared to rule
  them out came from those same retracted labels and were withdrawn with them. `spearman()` is in
  `src/stats.js` for whenever a valid label exists — which needs *paired or reference-anchored*
  presentation, not "rate this clip".
- **`sampleCx` is sparse, mostly through recency.** Per-sample detail exists only for units measured
  since 2026-08-14; everything older kept the mean and the spread. The Overview's "Precision
  coverage" panel shows the split. The *structural* half of this was fixed on 2026-08-19 — ~750 units
  had been unreachable by the refine queue, which only picked units it already believed imprecise
  (judged on `spreadRatio` when no `cxRSE` exists), so anything under that threshold was never
  revisited. They now get a guaranteed share.
- **Use `sampleNEff`, not `sampleN`, for anything about precision.** Until 2026-08-18 a revisit
  re-encoded the SAME clips — offsets are deterministic and so is x265 — so pooled entries held
  byte-identical duplicates and their error bars shrank on evidence that did not exist. The cache has
  been repaired and revisits now phase-shift the sample grid, but the distinction stays.
- **The starved-copy correction was recalibrated on 2026-08-18** from a controlled experiment, and
  has **no trust cut-off any more**: `1.114 · R^−0.392` (refitted 2026-08-20), held flat below
R 0.423, decaying to 1.0 by R 1.32 on
  its own. It rests on one unvalidated assumption — an assumed ×1.06 codec-matching floor estimated
  from a single film. If that floor is larger, the curve over-corrects.
- **Compare against `cxEff`, never raw `complexity`.** The raw value is only meaningful when studying
  the correction itself.

