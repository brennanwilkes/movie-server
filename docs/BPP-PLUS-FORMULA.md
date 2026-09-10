# BPP+ — Formal Specification

*The formula, its variables, its constants and their units. Nothing here is a proposal; every
value is either measured, decided, or derived, and each is labelled as such. Derivations,
evidence and the experiments that failed live in `docs/BPP-PLUS.txt`.*

---

## 0. What the score is

**BPP+ is a bitrate-adequacy index.** It answers one question:

> *Given what this particular film costs to encode transparently, how well provisioned is the
> copy we hold?*

It is **not** a quality score. Two films with the same BPP+ are equally well *served by their
bitrate*; one may still be a better-looking film. The scale is anchored so that

| BPP+ | meaning |
|---|---|
| **100** | the copy carries exactly as many bits as a CRF-20 (visually transparent) encode of **this** film |
| 200 | roughly **half** the visible error of 100 (the square root makes the scale perceptual) |
| ~67 | the library median |

The per-film normalisation is the whole point: Casablanca costs 3853 kb/s to hit CRF 20 and
Blade Runner 2049 costs 1035 kb/s, so a flat bitrate target would call one bloated and the
other starved when both are transparent.

---

## 1. Notation

A **unit** *u* is one movie file, or one TV **season** (episode-weighted). Probing and scoring
both operate on units.

| symbol | name | units |
|---|---|---|
| $b_v$ | video bitrate | bit·s⁻¹ |
| $W, H$ | frame dimensions | pixel |
| $f$ | frame rate | s⁻¹ |
| $\beta$ | bits per pixel (codec-normalised) | bit·pixel⁻¹ |
| $C_0$ | raw complexity (transparent cost) | bit·pixel⁻¹ |
| $C$ | complexity, starvation-corrected | bit·pixel⁻¹ |
| $R$ | supply ratio | dimensionless |
| $P$ | provenance index | library sd (dimensionless) |
| $z_d$ | standardised artifact residual | sd (dimensionless) |

---

## 2. The core formula

$$\boxed{\;\mathrm{BPP{+}}(u) \;=\; \underbrace{\mathrm{round}\!\left[\,100 \cdot \left(\frac{\beta(u)}{C(u)^{a}\cdot \Pi(u)\cdot H}\right)^{k}\right]}_{\text{bits, content, provenance}} \;+\; \underbrace{\Delta_{\text{adq}}(u)}_{\text{§4}}\;}$$

**Three terms, and they do different jobs.**

| term | what it asks | can it move the library median? |
|---|---|---|
| $\beta / C^a H$ | how many bits, against this film's own transparent cost | — it *is* the baseline |
| $\Pi$ (§3) | is this copy more damaged than its bitrate explains? | **No** — $P$ is centred on the library, so it is zero-sum |
| $\Delta_{\text{adq}}$ (§4) | do the artifacts say we are past the elbow? | **Yes** — anchored to an absolute reference, not centred |

$\Pi$ multiplies the *denominator*, so the square root halves it. $\Delta_{\text{adq}}$ is a shift
on the *score*, because it speaks about which side of 100 the film sits on.

> **$\Pi$ and $\Delta_{\text{adq}}$ cannot double-count, by construction.** Measured
> $\mathrm{corr}(P, \log \mathrm{BPP{+}_0}) = +0.0002$. $P$ is the residual after removing
> $\log\beta$, $\log C$ and their squares and cross-terms; BPP+ is a function of $\beta/C$, which
> lies *entirely* in that removed span. Same linear-algebra argument as §9.0p.

### BPP+ and BPP+₀

Two names, and the subscript is **the value of $P$, not a version number**:

| | |
|---|---|
| **BPP+** | the score. Includes provenance whenever the file has been measured. |
| **BPP+₀** | the same score with **neither** adjustment: $\Pi = 1$ *and* $\Delta_{\text{adq}} = 0$. Bits against cost, nothing else. |

> ⚠️ **BPP+₀ must be computed forwards from $\beta$ and $C$, never by undoing factors off the live
> score.** It was derived as $\mathrm{BPP{+}} \cdot \sqrt{\Pi}$, which undid provenance only — and
> the day the adequacy term shipped, that leaked straight into BPP+₀ (12 Angry Men reported 84
> instead of 72). Undoing *one of two* adjustments is wrong in a way that still looks plausible.

BPP+₀ is not a legacy number kept for comparison. It is **exactly what an unmeasured file reports**,
because an unmeasured file's factor is 1.0 by construction. So the baseline and the fallback are the
same object rather than two ideas that happen to coincide — which is why the UI can render an
unmeasured score in italics and mean precisely one thing by it.

The four terms are defined below, with

| constant | value | status | what it is |
|---|---|---|---|
| $k$ | **1/2** | **decided** (design) | perceptual index. The square root is what makes 200 ≈ half the visible error of 100. |
| $a$ | **1** | **measured** (0.987 ± 0.056) | complexity exponent. Two independent routes — human MOS and VMAF — converge; the shipped 1 sits 0.23 SE away. |
| $H$ | **1.0** | **decided** (anchor) | headroom target. 1.0 places 100 at CRF-20 transparency. Moving it does **not** require re-probing: a preference for CRF 22 is $H \approx 0.85^2 \approx 0.72$, applied at read time. |

### 2.1 $\beta$ — bits per pixel, codec-normalised

$$\beta \;=\; \kappa_c \cdot \frac{b_v}{W \cdot H \cdot f}$$

The denominator is pixels per second, so $\beta$ is **bits per pixel**.

$b_v$ is chosen by a trust rule, because MediaInfo reports a *nominal or peak* rate on some
HEVC files (Challengers: claimed 30.3 Mb/s in a 4.6 Mb/s container):

$$b_v = \begin{cases}
b_{\text{video}} & \text{if } 0 < b_{\text{video}} \le 1.05\,b_{\text{total}}\\[2pt]
\max\!\big(0,\; b_{\text{total}} - \min(b_{\text{audio}},\, 0.40\,b_{\text{total}})\big) & \text{otherwise}
\end{cases}$$

where $b_{\text{total}} = 8 \cdot \text{bytes} / \text{duration}$. **Audio is never charged to
video** — it inflated bpp ~19% on lossless-audio releases, and in the wrong direction (it
flattered exactly the multi-dub / lossless-audio rips we do not want flattered).

| constant | value | status | note |
|---|---|---|---|
| $\kappa_c$ (`X265_EFFICIENCY`) | **1.6** if HEVC/x265, else **1** | assumed (literature) | "H.265 at the same bpp looks like 1.6× the bits of H.264." |
| audio-share cap | **0.40** | decided (backstop) | a bogus audio figure must not wipe out the video rate. |

### 2.2 $C_0$ — complexity, i.e. what transparency costs *this* film

$C_0$ is **measured, not modelled**: the film is re-encoded at

- **CRF 20**, x265, preset `medium`
- **8 samples × 4 s** — 8 is a floor, not a luxury; scene complexity varies **8.2×** *within* a
  single film, so one clip produces a number with no meaning
- scaled to a **reference width of 1920** so a 4K and a 1080p copy of the same film land on the
  same axis

and the resulting bitrate is expressed in bit·pixel⁻¹. CRF is a **perceptual-quality** anchor,
not a bitrate one, which is exactly why this works: CRF 20 of Casablanca and CRF 20 of Blade
Runner 2049 are the same visual quality at wildly different cost.

### 2.3 $\Phi$ — the starvation correction (the "pinning curve")

Probing a **starved** copy measures the previous encoder's damage, not the film: a smeared,
detail-destroyed source is *cheap* to re-encode, so $C_0$ comes out too low and the file scores
too well. $\Phi$ inflates $C_0$ back toward what the film would have cost from a clean master.

$$R \;=\; \frac{\beta}{C_0}, \qquad
\Phi(R) \;=\; \mathrm{clamp}\!\Big(A \cdot \max(R, R_{\min})^{\,B},\; 1,\; \Phi_{\max}\Big),
\qquad C \;=\; C_0 \cdot \Phi(R)$$

| constant | value | status |
|---|---|---|
| $A$ | **1.114** | **measured** (refit, deployed 2026-08-20) |
| $B$ | **−0.392** | **measured** |
| $R_{\min}$ | **0.423** | measured (the curve goes flat below this) |
| $\Phi_{\max}$ | **2.0** | decided (backstop) |

> ⚠️ **$R$ is a supply ratio, never a source ratio.** It is $\beta / C_0$ — the file's own bits
> against its own transparent cost — with audio removed whenever $\beta$ came from the container
> path. It is *not* `src/probe`. This has been "fixed" wrongly before.

---

## 3. The provenance factor $\Pi$

***SHIPPED 2026-08-29.*** Live in the controller: `controller/lib/artifacts.js` computes $P$ over the
whole library and `installScoring()` in `probe.js` applies $\Pi$ to the scoring target. Every BPP+ on
the site — Library, Audit rows, replacement candidates — carries it.

BPP+ sees **bits** and **content** and nothing else. But

$$\text{artifacts} = f(\text{bits},\, \text{content},\, \textbf{encoder},\, \textbf{settings},\, \textbf{master},\, \textbf{generations},\, \textbf{preprocessing})$$

so two files with identical bits and identical content can differ in quality by a factor of two.
The fix is to **measure the artifacts, predict what they should be from bits and content, and
read the difference.**

### 3.1 The four detectors

| detector | measures | direction in $P$ |
|---|---|---|
| `cambi` | banding (CAMBI, no reference needed) | **+1** |
| `block` | blocking | **+1** |
| `blur` | blur | **+1** |
| `grain` | grain retained | **−1** |

The direction vector is **pre-registered from what a re-encode physically does** — another
generation *adds* banding, blocking and blur and *destroys* grain — and was never fitted. PC1 of
the residual correlation matrix independently lands on the same pattern (cos 0.947).

### 3.2 Residualisation

Each detector is regressed, in log space, on a library-wide surface that carries bits, content
**and codec**:

$$X = \big[\,1,\; \ell_\beta,\; \ell_\beta^2,\; \ell_C,\; \ell_C^2,\; \ell_\beta \ell_C,\; h,\; h\,\ell_\beta\,\big],
\qquad \ell_\beta = \ln \beta,\quad \ell_C = \ln C,\quad h = \mathbb{1}[\text{HEVC}]$$

$$e_d = \ln(\text{detector}_d) - X\beta_d, \qquad z_d = e_d / \mathrm{sd}(e_d)$$

$$P \;=\; \mathrm{standardise}\Big(\textstyle\sum_d w_d\, z_d\Big), \qquad w = (+1,+1,+1,-1)$$

$P$ is dimensionless, mean 0 and sd 1 **across the library**. $P > 0$ = more damaged than its
bitrate explains; $P < 0$ = cleaner than its bitrate explains.

> **Removing codec is not optional.** $\beta$ already carries a codec factor ($\kappa_c = 1.6$),
> so a $P$ that still read codec would double-count it.

> **Do not** rewrite this surface to take $\ln(\mathrm{BPP{+}})$ as a single regressor. Carrying
> $\ell_\beta$ and $\ell_C$ as *separate* basis vectors is what makes $P$ and $\lambda$ invariant
> to the exponent $a$ — every possible BPP+ already lies in the column space. That invariance is
> a proof, not a measurement, and it is what removes any ordering hazard when wiring this up.

### 3.3 The factor

$$\boxed{\;\Pi \;=\; \exp\!\big(s \cdot \varphi \cdot \lambda \cdot P\big)\;}
\qquad\Longrightarrow\qquad
\mathrm{BPP{+}} \;=\; \mathrm{BPP{+}_0} \cdot \Pi^{-k} \;=\; \mathrm{BPP{+}_0}\cdot e^{-k s \varphi \lambda P}$$

$\Pi$ multiplies the **denominator**, which is why the same $k = 1/2$ that defines the scale also
halves any misread here. Equivalently, and more intuitively — $P$ converts into an **effective-bits
multiplier** that flows through the ordinary formula:

$$\beta_{\text{eff}} = \beta \cdot e^{-s\varphi\lambda P}$$

*"Worse provenance than your bitrate explains ⇒ you effectively have fewer bits than you paid
for."*

| constant | value | status | what it is |
|---|---|---|---|
| $\lambda$ | **1.519** | **derived identity** | $\lambda = 1/A_{\text{bits}}$ where $A_{\text{bits}} = \lvert dP/d\ln\beta \rvert = 0.6555$. Units: ln-bitrate per P-sd. |
| $\varphi$ (`provShare`) | **0.1089** | **measured** | the fraction of observed $P$'s variance attributable to provenance. Adjusted $R^2$ of $P$ on the bitstream encoder fingerprint: 803 films, $p = 0.0025$ vs a 400-shuffle null, year-controlled (year alone 2.1%; encoder adds 10.7 points on top). **A lower bound.** |
| $s$ (`strength`) | **1.0** | **DECIDED** (Brennan, 2026-08-29) | the exchange rate between evidence and score movement. A preference, not a quantity — nothing measures it and nothing was ever going to. Ships as a **fixed constant, not a dial**. |

**There are no free parameters in BPP+.**

Measured on the live library at deploy: $\Pi$ spans **0.608 – 1.838**, $P$ spans **−3.01 – +3.68**,
and the median is **unchanged** (66 → 66) because $P$ is centred on the library — the factor re-ranks
files and *cannot* move the library as a whole.

**A corruption backstop, not a cap.** `FACTOR_MAX = 3.0` needs $|P| = 6.6$ sd, which a standardised
index over ~1000 units cannot reach unless the standardisation itself has failed. It shipped at 1.35
for one deploy on a comment whose arithmetic was wrong by 2× — 1.35 binds at $|P| = 1.81$ sd, and it
was silently clamping **71 of 1048 units**. That was a cut-off, not a backstop. **If it ever binds,
something upstream is broken — do not raise it.**

#### Three things that are easy to get wrong here

1. **$\lambda$ is not free, and the generation step cancels.** The anchor was *derived* from
   $dP/d\text{gen}$ as $e^{B/A}-1$, so $\ln(1+\text{anchor}) = B/A$ and
   $\lambda = (B/A)/(dP/d\text{gen}) = 1/A$. Re-measuring $dP/d\text{gen}$ alone changes
   $\lambda$ by **arithmetic accident, not by a finding**.
2. **The shrinkage is $\varphi$, not $\sqrt{\varphi}$.** That is a choice of *objective*, not an
   estimate: $\varphi$ is MSE-optimal per film, $\sqrt{\varphi}$ is spread-matching. This score
   is consumed per film, so $\varphi$ is right.
3. **Do not additionally shrink by $P$'s reliability (0.674).** $\varphi$ is already the fraction
   of the *observed*, noisy, 4-clip $P$ that is provenance, so sampling noise is netted out.
   Applying both double-counts.

### 3.4 There are TWO blends, and conflating them is a live bug

| blend | what it weights | composition |
|---|---|---|
| **adequacy** | how bits translate to visible quality | banding **90.9%**, grain 4.9%, blur 0.3%, blocking −4.0% — i.e. **banding essentially alone** |
| **provenance** ($P$) | evidence of a damaged pipeline | all four, in the pre-registered direction |

Three of the four detectors justify their existence **only** through $P$. Any UI that says
"artifacts" without saying *which* blend is misleading.

---

## 4. The adequacy term $\Delta_{\text{adq}}$ — the elbow pool

***SHIPPED 2026-08-29.*** `controller/lib/artifacts.js` computes it; `bppIndex()` in
`arr-inspect.js` applies it through an injected resolver. **This is the only term that can move the
library median**, and that is its purpose.

**100 is defined qualitatively** — the *elbow* of the rate–distortion curve, where more bits give
diminishing returns and fewer fall away steeply. **CRF 20 is one estimator of that elbow. "Artifacts
below their visibility threshold" is a second, independent one.** This pools them. Where they agree
nothing moves; where they disagree, the disagreement is information about that film. Same structure
as §100, which pooled CVQAD and VMAF to settle $a$.

### 4.1 The estimator

$$c_i = 2\Phi\!\left(\frac{\ln T - \ln L_i}{\sigma_L}\right) - 1,
\qquad c = \overline{c_i}\cdot\frac{n}{n + n_0}$$

Per **clip**, a smooth saturating vote; then the mean; then an evidence shrink. $c \in (-1, +1)$.

| constant | value | status |
|---|---|---|
| $T$ | 2.817 | `BANDING_HIGH`, matches `banding.js` |
| $\sigma_L$ | 0.242 | **measured** — 21 paired readings |
| $n_0$ | 4 | evidence prior: 8 clips cap $c$ at 0.67, 16 → 0.80, 32 → 0.89 |
| $w$ | **0.7496** | **measured** — split-half of $c$, 422 films × 70 disjoint 4/4 splits ($r$ = 0.5994, Spearman-Brown to 8). Independently corroborated: `banding.js` derives 0.73 at 8 clips by a different route. |
| $\kappa$ | $\ln 2$ | **decided** — how far below the elbow a confidently-dirty film sits |

**Saturation is the whole point.** Banding 0.01 and 0.09 both give $c_i = 1.0$, so a *grainless*
clean film gets exactly the credit a grainy one does. Grain is irrelevant **by construction** rather
than by control — which matters because grainy films band **6.9× less** (measured), so any
non-saturating form silently becomes a grain bonus.

It is **not** a counted scene fraction — that is a cut-off (§98). Each clip votes on a continuum.

### 4.2 The shift

$$\Delta_{\text{adq}} = \begin{cases}
w\,c\;\mathrm{softplus}(100 - \mathrm{BPP{+}}) & c > 0\\[4pt]
w\,c\;\mathrm{softplus}\big(\mathrm{BPP{+}} - 100e^{\kappa c}\big) & c < 0
\end{cases}$$

**The estimator gives a bound, not a point.** Clean means *at least* the elbow; dirty means *at
most* it. It can never say how far. `softplus` rather than `max(0,\cdot)` so the bound has no hinge.

**A clean film approaches 100 but never reaches it**, and the ceiling depends on where it started:

$$\text{ceiling} = \mathrm{BPP{+}_0} + w\,(100 - \mathrm{BPP{+}_0}) = 0.25\,\mathrm{BPP{+}_0} + 75$$

A film at 40 can never exceed 85 however clean. The bitrate estimator permanently keeps $1-w$ of the
vote — that is what pooling means, and why it is not an override.

### 4.3 Three formulations died first. Do not rebuild them.

1. **A logistic of banding on "is BPP+ ≥ 100" was CIRCULAR** — that outcome *is* the other
   estimator's answer. It also gave grainless clean films **19% less credit** than grainy ones.
2. **A lognormal prediction interval was the wrong shape** for a detector reading exactly 0 on most
   clips and spiking on one. Empire Strikes Back scored +0.88 "clean" with a visibly banded scene.
3. **Pulling dirty films *toward* 100 is wrong** — a dirty film sitting *at* 100 has nowhere to
   fall, yet dirty means *below* the elbow. Office Space (banding 5.36, ~2× threshold) moved −0.2.
   Hence the $100e^{\kappa c}$ target on the dirty side.

**This is not #60/#62.** Those converted an artifact gap into a *bitrate* multiplier via the
within-film slope $S$ — a cross-film use of a within-film law. Run literally on 12 Angry Men it
gives **72 → 7401**, because it must invent a 9-log-unit bitrate difference to explain a *content*
difference (grain acting as dither). This does no bitrate conversion at all.

### 4.4 Live effect, measured at deploy

```
median BPP+  73     median BPP+₀  67
6 films fell, 747 flat, 295 rose      biggest fall −4, biggest rise +30
12 Angry Men   BPP+₀ 72 → BPP+ 87    (adequacy +14.0, 8 clips, c = +0.667)
Office Space   BPP+₀ 95 → BPP+ 96    (adequacy −3.1 — banding 5.36, ~2× threshold)
Casablanca     BPP+₀ 123 → BPP+ 129  (adequacy 0.00 — estimators agree, only provenance moves)
```

**Known limit:** the term uses **banding alone**, per §9.0h's derivation of the adequacy blend. On
12 Angry Men that means it sees banding at 0.6% of threshold and calls the film pristine, while
never seeing **blur at 59% of threshold**. A second independent adequacy detector would raise the
pooled precision legitimately — and would likely pull that film *down*, not up.

---

## 5. Design invariants

These are constraints on the formula itself, not preferences:

- **No cut-offs. Anywhere.** A `max` is a cut-off and so is a hinge. Every guard that looks like
  a threshold has been replaced by a variance that grows continuously — extrapolation is
  penalised by the OLS prediction variance (quadratic in distance from the data centroid), not
  by a validity window. Three invented constants (`L_FLOOR`, `M_UP_FLOOR`, `FLAT`) fell out of
  the math for free once uncertainty was computed rather than assumed.
- **The output is a weighted number, never a flag.** Where a "binding artifact" must be chosen,
  it is a **mixture** over $P(\ln m_a > \ln m_b)$, not an `argmax` — which converges on the hard
  max exactly as the measurements sharpen, and softens only where softening is honest.
- **Anything unmeasured degrades gracefully.** A missing tier is never an error; it yields a more
  conservative number and is *reported as such*.
- **`PROBE_VERSION` gates measurement, not weighting.** Re-weighting (a new $\Phi$, a new $H$, a
  new $a$) is applied at **read time** and must **never** bump `PROBE_VERSION` — that would throw
  away 1044 measured units to change a multiplication.

---

## 6. Worked example

A 1080p23.976 x264 file, 8.2 GB, 2 h 22 m, 640 kb/s audio, on a film whose probe measured
$C_0 = 0.0412$ bit·pixel⁻¹:

| step | value |
|---|---|
| $b_{\text{total}} = 8 \cdot 8.2\text{e}9 / 8520$ | 7.70 Mb/s |
| $b_v = b_{\text{total}} - 0.64$ | 7.06 Mb/s |
| $W H f = 1920 \cdot 1080 \cdot 23.976$ | 4.97e7 px/s |
| $\beta = \kappa_c b_v / WHf$, $\kappa_c = 1$ | **0.1420** bit·px⁻¹ |
| $R = \beta / C_0 = 0.1420/0.0412$ | 3.45 |
| $\Phi = \mathrm{clamp}(1.114 \cdot 3.45^{-0.392}, 1, 2)$ | **1.000** (well supplied, no correction) |
| $C = C_0 \Phi$ | 0.0412 |
| $\mathrm{BPP{+}} = 100\sqrt{0.1420/0.0412}$ | **186** |
| with $P = +0.8$ (dirtier than its bitrate explains) | $186 \cdot e^{-0.5 \cdot 1 \cdot 0.1089 \cdot 1.519 \cdot 0.8} = $ **178** |

---

## 7. What is *not* settled

**One item.** $P$ has never been checked against a human eye — everything known about it is
internal consistency (it reproduces at 0.674; its structure is 3+1; its size is measured; it
passes its pre-registered direction check). None of that establishes that the reproducible thing
is **provenance** rather than a mixture. That is **#93**, and it is blocked on a 1080p projector,
not on analysis. See `docs/HUMAN-GAPS.md`.
