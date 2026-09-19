# Design: knowing when award data has gone stale

**2026-09-13.** Design sketch, not implemented. Answers the standing question behind the
three award R&D studies: *"we'd sort of need some automated way for a Claude prompt to be
aware, award-date-wise, of when to prompt me — hey, TIFF awards have come out, let's
update the data."*

**Principle: poll the sources, don't guess the dates.** A hardcoded calendar goes wrong
the first time a ceremony moves (the 2021 Oscars slipped to April; the 2024 Emmys moved
to January because of the strikes, and *then* there were two Emmy ceremonies in one
calendar year). Every source below can be asked "do you have a year we don't?" in a
single cheap HTTP request, and that question is never wrong.

The calendar in §C is for *display* — telling you what is coming — not for control flow.

---

## A. The feeds

One `awardWatchSweep` job, daily. Each row is one GET; the whole pass is ~8 requests and
a few hundred KB.

| Dataset | Feed | "There is new data" test |
|---|---|---|
| Oscar badge counts (`film-awards.json`, `person-awards.json`) | `api.github.com/repos/DLu/oscar_data/commits?per_page=1` | latest commit sha ≠ the sha stored at last build. *Verified: `c5e9716b`, 2026-04-22, "2025 Wins and SciTech".* |
| Oscar collections (`oscar-winners.json`) | `api.github.com/repos/delventhalz/json-nominations/commits?per_page=1` | same. *Verified — but note this repo has been dormant since 2024-04-03, so in practice the `latest-winners.json` manual-merge path in `data/oscars/SOURCE.md` is the live one.* |
| Cannes | Wikipedia `Palme d'Or` | `max(year)` in the winners table > `max(year)` in `festivals.json` |
| Sundance | Wikipedia `List of Sundance Film Festival award winners` | same |
| Venice | Wikipedia `Golden Lion` | same |
| TIFF | Wikipedia `Toronto International Film Festival People's Choice Award` | same |
| Emmys | `televisionacademy.com/awards/nominees-winners/<year>` | page for the current year returns 200 **and** contains winner badges |

The Wikipedia checks reuse exactly the parser the festival build already needs
(`docs/RND-FESTIVAL-EXPANSION.md` §A), so the watcher and the builder cannot drift apart
— if the parser breaks, the watcher reports an error rather than silently reporting
"nothing new".

A cheaper pre-filter, if the daily parse ever feels wasteful: the MediaWiki API's
`prop=revisions&rvprop=timestamp|ids` gives a page's last-edit id in one small response,
so a full fetch is only needed when the revision id has moved. *Verified: `Palme d'Or`
revid 1373587230, 2026-09-06.*

---

## B. Surfacing it

Three places, because the useful moment is different in each:

1. **Controller Jobs tab** — register `award-watch` through `jobs.define()` and use the
   existing `detail` / `stateOverride` fields:
   `detail: "Venice 2027 published — festivals.json has 2026"`. This is the mechanism
   that already makes every other sweep visible, and it costs one declaration.

2. **`data/awards-pending.json`** — machine-readable, written by the job:

   ```json
   { "checkedAt": "2027-09-14T04:00:00Z",
     "pending": [
       { "award": "TIFF: People's Choice", "haveYear": 2026, "sourceYear": 2027,
         "source": "https://en.wikipedia.org/wiki/Toronto_International_Film_Festival_People%27s_Choice_Award",
         "rebuild": "data/oscars/resolve-festivals.sh && data/oscars/build.sh" } ] }
   ```

   The `rebuild` string matters: it means the file tells whoever reads it what to *do*,
   not just what is stale.

3. **A checked-in `docs/AWARDS-PENDING.md`**, regenerated from the JSON. This is the part
   that answers the actual ask — a Claude session that opens this repo reads the docs
   tree, so a pending award shows up as context at the start of a session without you
   having to remember to mention it. It should also be added to the TODO list the same
   way any other open item is.

If a push channel is wanted for the day-of, the controller already has notification
plumbing; a single "Venice winners are out" push once a year is well within what that is
for. Not required for the mechanism to work.

---

## C. The calendar (for display only)

Typical announcement windows, for the "what's coming" panel. **Do not branch on these.**

| Award | What lands | Typical window |
|---|---|---|
| Sundance | competition winners | late January |
| Oscar nominations | nominee list | late January |
| Academy Awards | ceremony | early–mid March |
| Cannes | Palme d'Or and the rest | late May |
| Emmy nominations | nominee list | mid July |
| Venice | Golden Lion | early September |
| Creative Arts Emmys | | early September |
| TIFF | People's Choice | mid September |
| Primetime Emmys | ceremony | mid September |

Note the September cluster — Venice, TIFF and both Emmy ceremonies land within about two
weeks of each other. That is the one time of year this is worth a single batched
"three datasets are stale" prompt rather than three separate ones.

---

## D. What this deliberately does not do

- **It does not write award data.** It detects staleness and tells you; the builds stay
  manual and reviewed, because every one of these joins is by title and every one of them
  has already produced at least one wrong match (see `docs/RND-FESTIVAL-EXPANSION.md` §A).
- **It does not touch Jellyfin.** Same safety contract as the metadata sweeps: this job
  reads HTTP and writes two files in the repo. No item writes, no searches, no grabs.
