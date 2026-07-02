# Deep Audit — 2026-07-02

Consolidated audit of the movie-server stack: controller code, web UI, IaC/provisioning
scripts, and the **live running system** (probed read-only: real quality profiles, grab
history, qBittorrent state, Jellyfin config, on-disk library ffprobes). Cross-referenced
with the three parallel debugging sessions (codec weighting, indexers, PS3 DLNA).

Statuses: **[FIXED]** = implemented in this pass · **[IaC]** = fixed in repo, applies on
next provision · **[REC]** = recommended, not implemented (needs a decision or testing).

**Deployed & verified overnight (2026-07-02):** provision applied to qBittorrent + Radarr +
Sonarr (new codec scores live in all six tier profiles — verified via API), Jellyfin
(PS3 DLNA profile installed, service restarted), controller image rebuilt + restarted
(snapshot healthy, 44 zombie torrents cleaned on first sweep). End-to-end proof:
`make search q="Pulp Fiction"` now ranks x264 Bluray at **380** above the hidden-10-bit
x265 rips at **320** — the exact releases that used to tie at 350 and lose to seeders.
**Two things need you:** (1) `make bootstrap` once, for the sudo systemd drop-in (§5
reboot race); (2) test the PS3 with the §4 protocol when it's next on.

---

## 1. Torrent selection (pain point #1) — why the wrong release wins

### 1.1 The H.264/HEVC dead tie lets seeders pick the codec — [FIXED, IaC]
Live Radarr scored `H.264 (GPU)` **+50** and `HEVC 8-bit (GPU)` **+50**. When custom-format
scores tie, *arr breaks ties by seeders; popular films have better-seeded x265 rips, so
HEVC won 4 of the 5 audited titles (Pulp Fiction, GoodFellas, Parasite, Moneyball).
**Fix:** H.264 → **+80**, HEVC 8-bit → **+20** in `_arr_common.sh` (both apps). H.264 now
always beats HEVC within a size band; HEVC stays positive so it still beats unknown codecs.

### 1.2 Hidden 10-bit x265 — title-based detection can't see bit depth — [FIXED, IaC + controller]
Modern x265 encodes are 10-bit by default *without saying so in the title*. Verified on
disk: `Pulp Fiction … x265 SDR` ffprobes as **HEVC Main 10** yet collected the
"HEVC 8-bit (GPU)" +50. Three-layer fix:
1. The tie-break above (real x264 is reliably 8-bit → it now wins outright).
2. Widened 10-bit regex (`10bit|10-bit|10b|hi10p?`) + a new **"Likely 10-bit group (CPU)"**
   format (−120) for release groups that are always-10-bit in practice (Tigole/QxR family,
   PSA, etc.).
3. **Post-import ground-truth verification** (controller): after import, *arr's mediaInfo
   knows the true bit depth. A new sweep flags titles that landed 10-bit/HDR/AV1
   (`gpuTier != ok`) — surfaced via `/api/library` `gpuCompat`, and the audit recommends
   an auto-re-grab pass as a follow-up **[REC]** (blocklist the 10-bit release + re-search;
   bounded to once per title). Manual path today: Library tab → Redownload.

### 1.3 Repo was BEHIND the live system — a provision would have regressed tuning — [FIXED, IaC]
Live Radarr had hand-tuned scores (HEVC +50, 10-bit −150, HDR −200, different Beloved size
bands) that were never committed; `_arr_common.sh` still said 40/−80/−100. The repo now
carries the live-tuned values (plus the 1.1/1.2 changes) — `make provision` is safe again.
Unified both apps: 10-bit **−150**, HDR/DV **−200**.

### 1.4 `cf_ensure` never updated existing custom formats — the drift machine — [FIXED, IaC]
`_arr_common.sh` created a custom format if missing but returned untouched if present —
so every regex/spec improvement silently never reached the live system (this is exactly
how 1.3 happened, and why the old "superseded formats" delete-dance existed). Now a
reconciler: PUTs name+specifications when they differ from the declared state.
Same class of bug fixed for **quality definitions** (update was keyed on preferredSize
only, so maxSize-only changes never propagated).

### 1.5 `grabBestSeeded()` bypassed every profile rule — [FIXED, controller]
The stall-recovery "accept rare title" fallback grabbed the single best-**seeded** release,
ignoring rejections and custom-format score entirely — it could happily grab a 40 GB
2160p 10-bit HDR remux. Now: non-rejected releases only, ranked by customFormatScore then
seeders; if everything is rejected it grabs nothing and leaves the title to the sweep.

### 1.6 Negative-score grabs are real (working as designed, but know it)
`Enders Game 10bit H265` was grabbed at **score −50** and imported: the delay profile
grabs "best of whatever exists" after 30 min (something-over-nothing, deliberate).
Manual deletes of 10-bit files get re-grabbed as 10-bit again — deleting without
blocklisting can't win. The 1.1/1.2 fixes shift outcomes wherever an H.264 alternative
exists; where none exists, the grab is still the least-bad option. **[REC]**: the
post-import auto-re-grab (1.2.3) is the systemic answer.

### 1.7 Wedged queue items never cleaned — [FIXED, controller]
Live queue had 4 completed torrents stuck forever: 2 × "Not an upgrade" (Green Mile,
Wolf of Wall Street), 1 × "Sample" + not-an-upgrade (Fight Club), 1 × "matched by ID"
(LOTR). Terminal rejections ("not an upgrade" / "sample") now get removed from the queue
+ blocklisted by `arrSweep` so they stop wasting disk and queue slots. The ID-match case
is left to the import watchdog (it has an expectedId fallback for exactly that).

### 1.8 Import churn: watchdog double-imports ("Upgrade over itself") — [FIXED, controller]
History showed the same release re-imported over itself (Moneyball ×2, Mormon Wives
S03E03/S02E08/S02E06) matching watchdog log lines — the watchdog raced *arr's own import
because its 20 s-cached history view said "not imported yet". Now the watchdog does a
fresh per-hash history check (`/history?downloadId=`) with grab/import cycle awareness
before firing a Manual Import.

### 1.9 Seeder count in selection
`minimumSeeders=5` on all torrent indexers (good). Seeders can't be scored inside *arr
custom formats — they only break ties (which 1.1 now makes rare). The Lost season packs
currently downloading at 1–2 seeds were grabbed before the min-seeders reconciler landed.

---

## 2. Custom UI consistency (pain point #2)

Full sweep of `web/app.js` + `index.html` + `server.js` API pairs:

- **[FIXED]** "Declined" rows from the request-stage gate could never be dismissed —
  dismiss only deleted from the `declined` map, but request-gate rows live in `blocked`.
  Dismiss now clears both.
- **[FIXED]** Delete reported "Freed X GB" even when every layer failed — the UI ignored
  the per-layer `results`. It now surfaces failures.
- **[FIXED]** Library tab race: fast Movies↔TV switching could pair the new app with the
  old app's numeric id (a **wrong-title delete/redownload**). Requests are now
  sequence-guarded, items carry their own app, and stale lists are cleared on failure.
- **[FIXED]** `esc()` escaped nothing → torrent names with `"` `<` `>` broke row markup,
  buttons, and were an XSS vector. Real escaping now.
- **[FIXED]** `/api/library` computed rich `downloadStatus`/`downloadDetail`
  ("Downloading (45%)", "Import blocked", …) that the UI never rendered — every missing
  title showed bare "Not downloaded". Now rendered (the orphaned `.ds-*` CSS is live again).
- **[FIXED]** Summary bar vs list mismatch: Declined/blocked rows were injected per-request
  AFTER the summary was computed (its Declined branch was dead code). Rows are now part of
  the snapshot, so the summary counts what the list shows.
- **[FIXED]** Mutations (pause/resume/delete/dismiss/retry) didn't invalidate the 5 s
  qBittorrent cache or the snapshot loop → actions looked ignored for up to ~15 s and
  invited double-taps. Mutations now bust the cache and trigger an immediate refresh.
- **[FIXED]** Controller warm-up rendered a confident "Nothing downloading right now"
  (`ts:0` masked by `|| Date.now()`); now treated as still-loading.
- **[FIXED]** Movie Mode toasted success even when qBittorrent wasn't reached; the toast
  now reflects `qbit:false`.
- **[FIXED]** `fmtBytes(0)` rendered "0 GB" on metadata-less torrents; size is now omitted
  until known.
- **[REC]** Remaining (lower priority): pollHome out-of-order/offline over-triggering
  (`Promise.all` fails the whole poll if `/api/disk` alone fails), no retry/backoff, no
  visible "last updated" timestamp, `/api/status` shows green on HTTP 500 (deliberate),
  ~14 s worst-case progress staleness by design (5 s qbit cache + 5 s snapshot + 4 s poll).

---

## 3. Quality tiers vs your intent (pain point #4)

Your stated intent: **Low** = max quality-per-MB, **Normal** = balanced, **Beloved** =
excellent 1080p that's still GPU/PS3-friendly. Current state after fixes:

- Tier size bands (Radarr live values, now also in repo): Low peaks <1.5 GB (+150),
  Normal peaks 1.5–3 GB (+80), Beloved peaks 6–10 GB (+100), all penalize >15 GB.
  These match your intent. Codec ordering is now consistent across tiers (H.264 first).
- **Quality-per-MB nuance [REC]:** x265 genuinely is ~30–40 % more efficient per MB, so
  for *Low* an 8-bit HEVC at 1.2 GB beats an x264 at 1.2 GB in quality terms — but 10-bit
  detection is unreliable pre-download, and PS3 can't play any HEVC. Current setting
  biases H.264 everywhere, trading a little Low-tier efficiency for guaranteed
  GPU/PS3 compatibility. If Low-tier efficiency matters more than PS3 for those titles,
  raise HEVC-8bit back toward parity *in the low tier only*.
- **Sonarr Normal has no size scores at all** (by design — season-pack size scales with
  episode count). Consequence observed live: 80 GB Lost season packs grabbed with zero
  size pressure. **[REC]**: consider a gentle >15 GB penalty for Sonarr Normal, or accept
  big packs for TV.
- Quality-definition comment drift **[FIXED]**: the §5 comment claimed "cap at 40 MB/min";
  actual caps are 50–120. Comment corrected to match reality.

---

## 4. PS3 / DLNA (pain point #3) — first-principles review

Verified live: Jellyfin **10.11.11**, DLNA **plugin** 11.0.0.0 Active (correct for
10.10+), host networking, bound to 192.168.1.74, blast-alive every 180 s, QSV enabled
with `EnableDecodingColorDepth10Hevc=false` (correct for Skylake Iris 540).

- **Root cause (from the PS3 session, confirmed consistent with my probe):** the stock
  Sony PS3 DLNA profile direct-streams **AAC 5.1** audio (PS3 only decodes stereo AAC-LC,
  AC3, MP3, LPCM) → "video plays, no sound" on ~116 library files; and all HEVC must
  transcode (PS3 is H.264-8bit-only).
- **[FIXED, IaC]** Custom PS3 device profile installed by `jellyfin.sh` into the DLNA
  plugin's user-profile dir: direct-play limited to H.264 ≤ L4.1 8-bit in MP4/TS with
  AAC-**2ch**/AC3/MP3; everything else transcodes to MPEG-TS H.264 with **AC3 5.1**
  audio (surround preserved). Untested against the physical PS3 — test protocol below.
- **Hardware ceiling (not a config bug):** 10-bit HEVC decodes in software on this
  2c/4t Skylake (load was **8.4** during the probe). Real-time SW-decode+encode for the
  PS3 will starve. The §1 fixes shrink the 10-bit population over time; Movie Mode
  (master pause) before PS3 sessions is the operational workaround.
- **Tone mapping is OFF** and an HDR release (Casino 1995) was mid-download during the
  probe: HDR→SDR transcodes will look washed-out grey. **[REC]**: HDR stays heavily
  penalized (−200) so this is rare; don't enable OpenCL tone mapping on this CPU without
  testing. Consider killing + re-searching that Casino grab.
- **Test protocol when the PS3 is next on:** (1) server visible in PS3 video menu?
  (2) play an `x264 AAC 5.1 mp4` title — audio should now work (transcoded to AC3);
  (3) play an 8-bit HEVC title — should transcode via QSV smoothly; (4) note exact titles
  that fail and check `ffprobe` + Jellyfin dashboard's active-transcode reason.

---

## 5. Reliability / IaC robustness

- **[IaC — NEEDS ONE SUDO RUN] Reboot race (top finding):** fstab mounts the 8 TB USB
  drive with `nofail,x-systemd.device-timeout=10s`, and Docker had no dependency on it.
  After a power-loss reboot (already happened 2026-06-29), slow USB enumeration ⇒ the
  whole stack starts against the **empty `/data` dir on the SSD** — qBittorrent marks
  everything missingFiles and re-downloads onto the root disk. Fix codified in
  `bootstrap.sh` (systemd drop-in `docker.service.d/wait-for-data.conf` with
  `RequiresMountsFor=/data`). Sudo needs a password on this box, so it could not be
  installed unattended — **run `make bootstrap` once** (idempotent) to install it.
- **[FIXED]** `diagnose.sh --orphans` always crashed (two JSON blobs fed to one
  `readline()`), killing the whole diagnose run under `set -e` — orphan detection had
  never worked.
- **[FIXED]** Provisioners read the *arr API key **before** waiting for the app to be up
  (fresh-install race), and would proceed with an empty key on a malformed config.xml.
- **[FIXED]** `.env.example` still shipped the retired 20 GB loopback cap
  (`DATA_IMG_SIZE=20G`) — a from-scratch rebuild would have recreated the cap and
  double-mounted `/data`. Template now matches the 8 TB-drive reality.
- **[FIXED]** `search-releases.sh` Quality column always "any" (`quality.quality.name`
  nesting); `make search s=radarr …` routed to Sonarr (`$(if $(s),--sonarr)` tests
  non-emptiness).
- **[FIXED]** Prowlarr TPB tv-search "patch" targeted a container path from the host —
  it has *never* applied, while printing green every provision. It now reports honestly.
  The real custom-definition install (`Definitions/Custom/`) is **[REC]** — TPB is
  currently your highest-volume indexer; changing its definition deserves a supervised
  test (`scripts/provision/custom_tpb_definition.yml` is staged for it).
- **[REC] Create-once drift class** (same shape as 1.4, lower stakes): qBittorrent
  download-client creds, Jellyfin notification API key, Prowlarr app registrations, and
  Jellyseerr *arr connections are created if missing but never reconciled — a config wipe
  of one service leaves its neighbors holding dead API keys while provisioning reports
  "present". Worth converting to reconcilers one by one, as was just done for indexers.
- **[REC]** All images are `:latest` (unpinned) — the qBittorrent v5 cookie rename is the
  incident this causes. Prowlarr/Bazarr are currently running 8-day-old images with newer
  ones already pulled (plus two stale renamed containers from an interrupted
  `compose up`) — next `make deploy` reconciles; pinning tags would make rebuilds
  reproducible.
- **[REC]** `mdns-publish.sh` only republishes when the IP changes — if avahi restarts,
  `movies.local` stays dead until reboot. Needs a liveness check on its publish children.
- **[REC]** `jellyfin.sh`/`controller.sh` unconditionally `docker restart` on every
  provision run (kills playback on a no-op re-run); guard on actual changes.

---

## 6. Pipeline hygiene

- **[FIXED, controller]** 44 zombie `missingFiles` torrents (all from the 2026-06-29
  outage; files long gone, many for titles since re-imported or deleted) sat registered
  in qBittorrent — invisible to the old orphan sweep because its history window (500
  events) no longer reaches June 29. The orphan sweep now also removes long-dead
  missingFiles torrents whose *arr item is gone **or** already has its file.
- **Seeding black hole [FIXED, deployed]:** 373 completed torrents queued-for-upload
  forever (no ratio/time limits, 3 upload slots — they never finish "seeding" and never
  dequeue). `qbittorrent.sh` now sets share limits (ratio 2.0 / 14 days) so completed
  torrents stop cleanly; applied live. Files are hardlinked so this frees no disk (by
  design) — it ends the perpetual-queue noise.
- Hardlinks verified working (`/data` single filesystem, `hardlinks=true` live).
- Recycle bin is empty/disabled in *arr — deletes are permanent (accepted; noted).
- Jellyseerr caches the stale profile *name* "HD-1080p" for profile id 4 (now "Normal") —
  cosmetic; the id mapping is correct, which is what matters.

---

## 7. Browsing, discovery, ratings, playlists — implemented 2026-07-02 (all IaC)

- **[REMOVED 2026-07-02] "Pick" tab** — built, then removed at Brennan's request ("good
  idea but not something I need" — browsing should live inside Jellyfin/Jellyseerr).
  The auto-collections + Home Screen Sections below are the in-Jellyfin replacement.
- **[DONE] Jellyfin auto-collections** (`jellyfin.sh` §3b): Movies library now auto-groups
  into TMDb box sets (trilogies/sagas) — zero new software.
- **[DONE] Playback Reporting plugin** (`jellyfin.sh` §6d2, official repo): records watch
  history from now on — raw material for taste-aware features and pruning decisions.
- **[DONE] Jellyseerr discovery sliders** (`jellyseerr.sh`): Comedy/Sci-Fi/Thriller/Family
  genre rows on the request page. Gotcha codified: `/settings/discover/add` creates sliders
  DISABLED and per-id PUT can't enable them — only the batch POST (full list) does.
- **[DONE] SuggestArr container** (compose): TMDb-similarity recommendations from Jellyfin
  watch history, auto-requested through Jellyseerr (user-selected over Recommendarr — no LLM
  key needed, purpose-built for this exact stack). **Needs one-time setup:** open
  `http://<nuc>:5000`, supply a free TMDb API key + Jellyfin/Jellyseerr URLs+keys; config
  persists in `/opt/appdata/suggestarr`. Suggest conservative limits (a few requests/run) and
  the Low/Normal tier as its default profile.
- **[DONE] Auto-collections sweep** (controller, `collectionsSweep`): decades (50s→2020s)
  plus **15 vibe/theme combos** (decade × genre × runtime × rating cross-sections: Mob &
  Crime Classics 80s–90s, 2000s Rom-Coms, 90s Action Blockbusters, Short Action Fix,
  Date Night, Sci-Fi Mindbenders, Horror Nights, Old Hollywood, Modern Masterpieces, …),
  Critically Loved, Short & Sweet, Epic Runtimes — 26 collections maintained every 12h.
  Plain-genre collections retired (redundant with the Genres tab). **Posters set
  automatically** from each collection's highest-rated member. New vibes are one-line
  rules in the `VIBES` table in `controller/server.js`.
- **[DONE] Home Screen Sections + File Transformation plugins** (iamparadox.dev repo, IaC in
  `jellyfin.sh`) — AND the **section layout itself is IaC** (schema recovered from the
  plugin's OpenAPI; written via `/Plugins/{id}/Configuration`): 13 rows enabled in order —
  My Media, Continue Watching/Next Up, Recently Added Movies/Shows (hide watched), Because
  You Watched (≤3), Genre rows (≤3), Top Ten, Watch Again, Discover Movies/TV +
  My Requests (Jellyseerr-wired), Upcoming Movies/Shows (Radarr/Sonarr-wired). Music/book/
  LiveTV rows disabled; every row user-overridable. NOTE: integrations use $NUC_IP (Jellyfin
  is host-networked — container DNS names never resolve from it).
- **[DONE] SuggestArr fully IaC — the web wizard is bypassed** (`provision/suggestarr.sh`
  writes `config.yaml` directly + restarts): Jellyfin history → TMDb similar → requests as
  the request-only `suggestarr` user → **Pending approval, nothing auto-downloads**; daily
  03:00, 3 movies + 1 show per run. **The one thing only Brennan can do: put a free TMDb
  key in `.env` (`TMDB_API_KEY=`, themoviedb.org/settings/api) then
  `make provision s=suggestarr`.** Until then SuggestArr idles harmlessly.
- **[REC] Smart Playlists plugin** (third-party repo) and **Jellystat** (container+Postgres
  stats dashboard) — still deferred; the native collections sweep covers the decade/genre
  playlist ask without them.

## 8. Live-stack snapshot (2026-07-02, for future reference)

- NUC: i5-6260U (Skylake, Iris 540) — QSV: H.264 8-bit ✓, HEVC 8-bit ✓ (hybrid),
  HEVC 10-bit ✗, AV1 ✗. Load avg during probe: **8.4** (2c/4t).
- `/data`: 7.3 T total, 1.9 T used. Root SSD 76 % used.
- Library: 360 movies (964 G), 38 series / 675 eps (797 G). Movies by title-codec:
  219 x264, 44 x265, 97 unknown. ffprobe confirms hidden Main-10 files among "SDR" x265.
- qBittorrent: 450 torrents — 373 queuedUP, 44 missingFiles (pre-fix), 15 downloading.
- Indexers: YTS (prio 10), Knaben (20), TPB (25), EZTV+LimeTorrents (Sonarr), 1337x
  disabled (Cloudflare 1006 IP ban; Knaben covers it). All recent grabs came via TPB.
- Jellyfin 10.11.11 + DLNA plugin 11.0.0.0; QSV on; 10-bit HEVC → SW decode (correct).
- Radarr v6.2.1 / Sonarr v4.0.19 / qBittorrent v5.2.2 (cookie `QBT_SID_<port>`).

---

**CORRECTION (2026-07-02, late):** the household console is a **PS4**, not a PS3 — every
"PS3" reference above should be read accordingly. Consequences handled: the PS4 identifies
as "PLAYSTATION 4" so the PS3 DLNA profile never matched (that, plus E-AC3 audio in every
WEB-DL, is the complete "silent audio" story); a proper PS4 profile now ships
(`dlna-ps4-profile.xml` — MKV is fine on PS4, E-AC3/DTS/HEVC/10-bit are not). The
normalizer became **additive**: `ps4ify`/`ps4fix.timer` ADD a default-flagged AC3 5.1
compat track and keep the original audio + container untouched — no quality is ever
destroyed for compatibility. Grab-time audio bias renamed to "PS4-native audio (AC3)".
