# Quality tab — the visual spec

`build-mockup.js` renders the proposed Library (Quality) tab from **live** `/api/probe/dataset`
rows. It is the reference the real implementation is checked against, and it is in the repo because
the design was *measured*, not drawn.

```bash
node docs/quality-mockup/build-mockup.js                    # live from the NUC
node docs/quality-mockup/build-mockup.js data/snapshot.json # or replay a snapshot
CONTROLLER=http://localhost:8088 node docs/quality-mockup/build-mockup.js
```

Then screenshot it. **`--headless=old` is not a typo:** `--headless=new` silently ignores
`--window-size` and renders at 500×767, so every measurement taken with it is against the wrong
viewport. That cost an hour.

```bash
for w in 320 390 700 820 1440; do
  google-chrome-stable --headless=old --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=$w,1500 --screenshot=/tmp/q-$w.png docs/quality-mockup/mockup.html
done
```

## What rendering caught that reading the CSS did not

Nine defects, in the order they appeared. Each is a rule the implementation must not re-break.

1. **The header grid and the row grid were written twice** and drifted, putting every numeric column
   ~20px off its label. → one `--qgrid` custom property on the list wrapper, consumed by both.
2. **The year truncated instead of the title** (`…The Phantom Menace 1…`). → the year is
   `flex: none`; only the title text may ellipsise.
3. **A position chip collided with the `CX` header** at 390px. → it rides in the header's title cell
   with `margin-left: auto`, outside the numeric tracks, and hides below 360px.
4. **Artifact `%` labels were clipped** by the lab's `margin-top: -19px`. → the `%` belongs in the
   label row; the track gets its own full-width row.
5. **Every percentile dot was pinned to the far left.** `calc(7px + var(--x) * 0.01 * (100% - 14px))`
   with `--x: 100%` is invalid CSS math — a percentage times a length. → `--x` is a **unitless**
   number and the expression divides by 100.
6. **The median label collided with the domain-min label.** → suppressed within 8–16% of either end.
7. **`--tw` was defined on `.qg-row` but consumed by the inline `--qgc` on its parent**, so
   `grid-template-columns` was invalid and the whole grid collapsed to one column. A custom property
   must be defined at or above the element that consumes it.
8. **The control-point chart plotted flat on the floor.** CAMBI spans 0–11.7 library-wide against a
   2.817 threshold with a ~1.08 median, so a linear axis anchored to the threshold wastes the entire
   plot for any clean film. → `sqrt` y-axis (it handles exact zeros; `log` does not).
9. **The sticky header did not stick.** `overflow-x: auto` computes `overflow-y: auto`, so the
   scroller's internal vertical range is 0 and `top: 0` resolves against *it*, not the page — the
   header scrolled off to −415px at `scrollY = 600`. → the header is a separate
   `position: sticky` strip outside the scroller, with `scrollLeft` synced on scroll.

## Structural findings

- **One breakpoint, at 700px.** A two-line card stretched to 820px leaves ~350px of dead space with
  the numbers marooned at the right edge. Below 700 the card (stacking is a necessity, not a style);
  at and above it the one-line grid, so a tablet gets the real table.
- **76px fixed rows + a 104px control block = 7.5 rows** on a 390×844 phone. The first design spent
  302px on chrome and showed 3.5.
- **Flags are exception-only.** Bluray is 83% of sources and h264 is 89% of codecs; printing them on
  every row is 1054 renders of "normal".
- **Defaults come from the data.** The worst-scoring films are uniformly explained by low `R`
  (0.19–0.35 — starved copies) and high banding (105–235% of threshold). `cxRSE` (60% null),
  `sampleNEff` (61% null) and `top100` (90% null) are excluded from defaults on measured emptiness.
- **The four band hues cannot be an ordinal scale** — L\* is non-monotone and the hue spread is 83°.
  `--wow` (L\* 58.6) and `--danger` (57.9) are 0.7 L\* apart, so best and worst band are identical in
  luminance. Hue carries band *identity*; the adjacent number carries the *order*.

## Palette

The mockup uses two proposed lifts, `--wow: #c79cf7` and `--ok: #28d9a0`, which fix the two
measured colour-blind failures in the shipped palette (`--ok`↔`--warn` at ΔE 3.5 protan — that is the
BPP+ 100 boundary; `--wow`↔`--accent` at ΔE 14.0, below the floor even for normal vision). Verify
with the `dataviz` skill's validator:

```bash
node scripts/validate_palette.js "#c79cf7,#28d9a0,#ffb020,#ff453a,#4f8cff" \
  --mode dark --surface "#161a23" --pairs all
```

If the lifts are declined the design still works — the number is the redundant channel — but the 100
boundary stays ambiguous for protanopes.
