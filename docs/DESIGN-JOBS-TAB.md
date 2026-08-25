# The Jobs tab + auto Movie Mode

Built 2026-08-06. Two features that ship together because they are the same idea from
opposite ends: *everything this box does in the background should be visible in one
place, and it should get out of the way by itself when someone is watching.*

---

## 1. The problem

Before this, the box ran ~25 recurring jobs across three runtimes. **Two of them had
UI.** The CRF probe and the audit verifier each had a bespoke panel on the Audit tab,
in two different visual formats. The other twenty-three were invisible: the only way
to know whether the Oscar tag sweep had ever run, or why the collections sweep had
stopped, was to `docker logs controller | grep`.

That is bad for three separate reasons:

1. **A silently dead job looks identical to a healthy one.** `ps4fix.timer` failing to
   fire and `ps4fix.timer` finding nothing to do produce exactly the same evidence:
   nothing.
2. **Every new job needed new UI to be visible**, so none of them got any.
3. **Two jobs having pretty panels made everything else look neglected** — which it was.

## 2. The contract

One shape, in `controller/lib/jobs.js`, that all three runtimes are normalised into:

```js
{ id, name, what, group, weight, source,
  state,            // running | waiting | paused | idle | error | never | off
  startedAt,        // when the CURRENT unit of work began (running only)
  detail,           // WHY — only populated when something is off
  progress: { done, total, pct } | null,
  etaMs,
  every, scheduleText, lastRun, lastOk, lastMs, nextRun, runs, fails,
  actions: [] }
```

**A reader must not be able to tell which runtime a card came from.** That is the
whole design constraint; everything below follows from it.

| Source | How it is read | Why |
|--------|---------------|-----|
| `controller` | `jobs.define(desc, fn)` wraps the interval callback | Instruments timing/errors with no change to the job's body |
| `jellyfin` | poll `/ScheduledTasks` | Jellyfin already tracks state/percent/last-result; mirroring it into our own state would just be a second copy to get wrong |
| `host` | status files in `/config/host-jobs/*.json` | The controller is a container: no `/run/systemd`, no `systemctl`. It **cannot** see host timers. The host script pushes instead — the same pattern the Tailscale sidecar already uses |

### Adding a job

Server-side only. Nothing in the frontend changes:

```js
const tracked = jobs.define({
  id: 'my-sweep', name: 'My sweep', group: 'Downloads', weight: 40,
  what: 'Plain-language description of what this is for',
  every: 300000, scheduleText: 'every 5 min', pausedByMovieMode: true,
}, mySweep);
setInterval(tracked, 300000);
module.exports = { mySweep: tracked, ... };   // export the WRAPPED one
```

Export the wrapped function, not the original — otherwise direct callers (notably
`bootSequence()`) run untracked and the tab reports "never run" for hours after
every boot while the job is in fact working.

For richer state, push it: `jobs.report(id, { progress, etaMs, detail, actions })` — and
`stateFn` for anything whose state changes mid-run (see "State must be live" below).

For host-side jobs, `source scripts/lib.sh` and call `job_status <id> <state> [detail]`.

### Why the states are what they are

Every state gets a badge, including the healthy ones — a row with a badge and a row
without read as two different components, and uniformity is the point. `idle` and
`never` use a muted grey so the slot is filled without competing for attention.

Colour is reserved and carries the meaning: **accent = running, amber = gated
(waiting/paused), red = failed, green = a completed bar.** Thirty bright badges would
bury the one that matters.

`paused` is separate from `waiting` because the user causes it directly and should see
the consequence of the button they pressed. `off` exists so a job disabled by config (a
missing API key) reads as explained rather than silently absent.

### Card anatomy — three fixed rows, one fixed height

```
▍ Quality probe               NIGHTLY  QUALITY  RUNNING
▍ Finding Nemo (2003)
▍ [========== bar ==========]   871 left    [Stop]
```

Every card is **exactly the same height** (80px) with the same three rows in the same
places, so the page reads as a grid of instruments rather than a stack of paragraphs.
Both text rows are hard-clipped to a single line, so nothing can push a card taller.

**Only rows 1–2 carry prose — the title and one description line.** Everything else is
geometry. The schedule/last-run line that used to be a fourth row is gone: *"every 6h ·
and on boot · started 5 min ago"* was exactly the poorly-formatted text this redesign
exists to delete. The bar already encodes how far through the interval the job is, and
the words survive on the card's `title` attribute.

**All three badges sit in one right-aligned cluster** on row 1: cadence · area · state,
with state at the outer edge because that is what the page is scanned for. They were
briefly split across two rows and that both read as two unrelated strips and cost the
card the vertical room it needed.

| Badge | Says | Colour |
|-------|------|--------|
| cadence | `NIGHTLY` `12H` `DAILY` `30M` `5S` `ON DEMAND` | none — outlined, it is a reference fact |
| area | `QUALITY` `MEDIA` `METADATA` `DOWNLOADS` `SYSTEM` | its own desaturated palette (`--g-*`) |
| state | `RUNNING` `WAITING` `FAILED` `IDLE` `QUEUED` | the status palette |

The **area** tag is the job's `group`, not its runtime: which container a job happens to
live in is an implementation detail this tab exists to normalise away, whereas "is this
about picture quality or about downloads" is what someone scanning wants. The runtime is
in the card's `title`. Its hues are deliberately a separate, desaturated family — a
permanent property must never outshine what is happening right now. (`MEDIA` was moved
from sky to cyan after a render showed it sitting too close to the accent blue of
`RUNNING`, which appear together on the same card.)

**The left rail carries HEALTH, not just activity:**

| Rail | Meaning |
|------|---------|
| green | idle **and** last run succeeded — the resting state of a working job |
| accent | running |
| amber | waiting / paused |
| red | failed |
| grey | never run, or off — genuinely unproven, not healthy |

Green-for-healthy exists because the rail was grey on ~25 of 36 cards, which wasted the
strongest signal on the card and made a working box look inert. It is said on the rail
*only*: a green badge on 25 cards would drown the handful that need attention, but a
green edge reads as reassurance without competing. Live distribution: 21 green, 9 grey,
6 accent.

**Two bar weights.** `work` is real progress through a backlog, full contrast, coloured
by state, **green at 100%**. `sched` is a thin dim fill toward the next run, for jobs with
no backlog — it must never be mistaken for work in flight, but it fills the slot so every
card keeps the same silhouette. Jellyfin tasks get an interval derived from their trigger
(`jfEvery()`) precisely so they draw a real bar instead of an empty track.

The figure is **one short token** (`873 left`). It used to carry the ETA too
(`873 left · ~4 d`) and that was cut as noise — the bar shows progress, the number only
adds scale. The ETA is in the `title`.

### Ordering — cadence first, then state

1. **Sub-hourly crons sink to the bottom, whatever they are doing.** The disk gate runs
   every 30s and the downloads snapshot every 5s, so they are *always* mid-run and would
   permanently occupy the top of a page whose purpose is showing what is actually
   happening. They are also dimmed (`.chatty`). 18 of the 36 jobs land here.
2. Then by state: **error → running → waiting/paused → rest.** Errors first because a
   failure is the only thing on the page that needs a human.
3. Then by `weight`.

Applied **client-side**. `/api/jobs` stays a stable weight-ordered catalogue — sorting
there would make the API order flap every few seconds, and the smoke test asserts the
weight ordering as an invariant.

Note the consequence: **Source check (one search every 45s) sorts to the bottom** even
during a 2.5-hour verification pass. That follows the rule as specified; if it should be
exempt, give it `every: null` — its cadence is really "continuously while rows remain",
not an hourly cron.

### State must be live, not cached

`jobs.report({stateOverride})` writes a value at report time, which is only correct for a
job that reports on **every** transition. The probe does not: it reports once per tick,
immediately before an encode that then runs for ~200s — so the card read "waiting" for
almost the entire time it was working. That was a real shipped bug.

Anything whose state changes *during* a unit of work must supply `stateFn` instead, a
function evaluated when the tab reads. A throwing hook is caught and ignored, because a
bad hook must never be able to blank the whole tab.

Note also that a manual probe session drives its work through `scheduleSessionTick()`,
bypassing the wrapped function entirely — so the registry's own `running` flag never sees
it. Another reason the live hook is the only reliable answer for that job.

## 3. Auto Movie Mode

### Two latches

`isMasterPaused()` is the **OR** of two independent latches, so none of the ten gating
modules needs to know why the box is quiet:

| Latch | Set by | Persisted | Cleared by |
|-------|--------|-----------|-----------|
| manual | the button | yes | an explicit second tap |
| auto | playback | **no** | playback stopping + grace |

The auto latch is not persisted on purpose: it is a claim about *right now*, and
restoring "someone is watching" from disk would be a guess about a session we can no
longer observe. It re-arms within a minute from the next `PlaybackProgress`.

Consequences, all asserted in `scripts/test-jobs.js`:

- A film ending never clears a manual hold.
- Clearing the manual hold mid-film does **not** resume the box.
- While auto holds it and manual does not, the button renders disabled. If manual is
  *also* set the button stays live — otherwise starting a film would trap a manual
  pause on with no way to release it.

### The latch is derived, not flipped

This is the important part. A webhook is a fire-and-forget POST. A dropped
`PlaybackStop` — client killed, network blip, Jellyfin restarted mid-film, plugin
disabled — would leave the latch stuck ON, which **silently halts every background job
on the box forever, with no error anywhere.**

So the latch is not a boolean that events toggle. It is derived from a table of
sessions that each expire independently: `PlaybackProgress` refreshes a session's
timestamp, and anything unheard-from for 15 minutes is dropped. The worst a lost event
can cost is one stale window.

### Grace on release only

Releasing waits 3 minutes. Pausing for a drink, an episode boundary, and seeking across
a chapter all briefly produce zero sessions, and resuming means starting every torrent
and re-enabling every sweep — expensive churn to undo seconds later. Acquiring has **no**
grace: quieting the box has to be immediate to be worth anything.

### Delivery

The Jellyfin **Webhook plugin**, installed and configured by
`scripts/provision/jellyfin.sh` (§6d4 install, §9b config). It is load-bearing
infrastructure, not a hand-configured convenience — without it nothing arms
automatically and the only symptom is that the box keeps working during films.

The config is **merged** onto the existing destination rather than replacing it: the
plugin serialises fields we do not set with its own defaults, so a wholesale replace
would drop them every run and the block would never be idempotent.

Diagnosing "auto Movie Mode did nothing":

```
curl -s localhost:8088/api/movie-mode | jq
```

`webhook.lastEvent` being null *after a film has played* means the plugin is not
delivering. That field records key names only, so a plugin-side rename is visible
without turning on debug logging.

## 4. Deliberate deviations

- **Auto-resume starts all torrents**, including any paused by hand, because it runs the
  identical recipe as the manual button (Brennan's call — flagged, chosen anyway). The
  fix, if it ever annoys: snapshot running hashes before pausing and restore only those,
  in `applyMovieMode()`.
- **Jellyfin's task list is filtered** to 10 of 28. The rest are Jellyfin plumbing (cache
  cleanup, plugin startup shims, Live TV guide refresh for a tuner we do not have) and
  would bury the jobs that matter. Adding one back is a line in `JF_TASKS`.
- **`recheck-sources` keeps a two-tap arm.** It drops every cached verdict and commits
  the box to ~2.5h of paced indexer searching. It is not destructive — verification only
  searches — so it does not deserve a modal, but it does deserve a second tap.
