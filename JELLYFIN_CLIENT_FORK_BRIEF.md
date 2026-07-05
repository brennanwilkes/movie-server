# Brief: Feasibility study — custom build of the Jellyfin TV client

**Audience:** an agent tasked with assessing whether we should fork/customize a Jellyfin TV
client to natively show our curated collections as home-screen rows. This is a **research +
feasibility** brief; it is self-contained (you were not in the session that produced it).

---

## 1. The goal (what the user actually wants)

On the living-room TV, the user wants a **Netflix-style home screen** driven by our Jellyfin
server: **scrolling poster thumbnails**, a **Continue Watching** row, **Recently Added**, and —
most importantly — **our ~27 custom "collection" shelves** (e.g. "Feel-Good", "Epics", "90s
Movies", Oscar categories) each surfaced as its own row, plus **big cinematic fanart
backgrounds**. Watched/resume state must stay in sync with the server.

These collections are generated + rotated server-side by our controller (see the repo's
`controller/server.js` `collectionsSweep`/HSS shelves; the controller re-rolls shelves every
~10 min). On the **web** Jellyfin client we already surface them via the Home Screen Sections
(HSS) plugin. The problem is the TV.

## 2. Why the native Jellyfin app can't do it (established facts)

- The **Home Screen Sections plugin is web-client-only** — it works by patching the
  `jellyfin-web` JS bundle via the File Transformation plugin. Native clients don't load that
  bundle, so our shelves never appear on them.
- The **native Jellyfin Android TV / Fire TV client** renders a **fixed set of home section
  types** (My Media / library tiles, Continue Watching, Next Up, Latest Media, Live TV) via
  hardcoded row implementations. There is **no server-defined-section mechanism** it consumes.
- There is an **unmerged upstream effort**: a `PinnedCollection` home-section type — jellyfin
  server **PR #13820** (draft, rebased on 10.11.8, has a working testable API + a prebuilt
  Docker image) and design discussions **jellyfin-meta #93 / #83**; the canonical client
  request is **jellyfin-androidtv issue #4241**. Client-side adoption is explicitly **out of
  scope** for that PR, and nothing has shipped in a release. (Note: meta #83 warns that sending
  an *unexpected* home-section type has historically **crashed** some native clients — Android
  TV/Swiftfin flagged — so naive DisplayPreferences injection is a crash risk, not a path.)

## 3. What we already tried (the Kodi workaround) and its ceiling

To avoid a fork, we set up **Kodi + the "Jellyfin for Kodi" add-on** on the user's Fire Stick
as a front-end. Full writeup: **`FIRESTICK_KODI.md`** in this repo. Outcome:
- It works: library synced (447 movies, 41 shows/812 eps, and our **27 collections came across
  as Kodi "movie sets"**, `videodb://movies/sets/`), 2-way watch sync, poster views, fanart
  backgrounds, skinned with Aeon Nox: SiLVO.
- **But**: the user's device is a **2017 Fire TV Stick (Android 5.1, ~1 GB RAM) → max Kodi 19**.
  The good lightweight Netflix skins (Bingie) need **Kodi 21**; the Kodi-19 Netflix skin (Titan
  Bingie Mod) is **too heavy and crashes** on 1 GB. The skin we landed on (Aeon Nox) **caps at
  2 widget rows per menu item** — so "one row per collection" (many shelves) is **impossible**
  there. Kodi also isn't the sleek, single-app experience the user ideally wants.

So Kodi is an acceptable stopgap but not the endgame. Hence this feasibility question.

## 4. The proposed direction to evaluate: custom Jellyfin TV client

The official client is open source and forkable:
- **`jellyfin/jellyfin-androidtv`** — Kotlin, **GPL-2.0**, the Fire TV / Android TV app.
- (Also `jellyfin/jellyfin-web` GPL, and the server `jellyfin/jellyfin` GPL, if relevant.)

**Key insight to validate:** the feature may be achievable **client-side only, with no server
fork** — a collection is a `BoxSet`, and its contents are a standard API call
(`GET /Items?ParentId=<collectionId>`). So a fork could add a new home-row type that queries our
collections directly and renders them as poster rows, reusing the existing row/card UI. PR
#13820 is a working reference for the data model even though its client side is unfinished.

## 5. What the feasibility study should determine

1. **Architecture fit:** In `jellyfin-androidtv`, how are home rows built (the `HomeFragmentRow`
   / row-loader system)? How hard is it to add a new row type backed by an arbitrary
   `ParentId`/BoxSet query? Is it truly client-side-only, or does anything need server support?
2. **Config/UX:** How would the user choose *which* collections become rows and in what order —
   hardcoded IDs, an in-app setting, or read from a server-side list our controller already
   maintains? Can we mirror the controller's rotating-shelf idea?
3. **Effort estimate:** Rough LOC / complexity for a working prototype vs. a polished feature.
   Kotlin/Android Studio build toolchain, signing, sideload/update flow to the device(s).
4. **Hardware reality:** The user's current stick is Android 5.1 (API 22). What min-SDK does
   current `jellyfin-androidtv` require? Does a fork have to target this old device, or is the
   realistic plan "fork + a newer 4K Max"? (A 4K Max is already the recommended upgrade path.)
5. **Maintenance cost:** The big downside the user already flagged — owning a fork means rebasing
   on upstream, building/signing APKs, and redistributing on every update. Quantify this. Is it
   lighter to instead **finish PR #13820's client side and contribute upstream** (issue #4241)
   so it lands in the official app with zero long-term fork maintenance?
6. **Alternatives ranking:** Compare (a) fork jellyfin-androidtv, (b) contribute PinnedCollection
   upstream, (c) stay on Kodi (documented), (d) other third-party TV clients that support
   plugins/custom rows and their trust/maturity. End with a recommendation.

## 6. Constraints & facts to carry in

- **Server:** `haleiwa` at `http://192.168.1.74:8096`, admin `brennan`/`brennan`. ~27 collections
  (BoxSets); the controller rotates/curates them (`controller/server.js`).
- **Device today:** Fire TV Stick 2nd-gen (2017), Android 5.1, 32-bit, ~1 GB RAM. Reachable via
  ADB over Ethernet (see `FIRESTICK_KODI.md` §2/§5). A **Fire TV Stick 4K Max** is the assumed
  eventual upgrade.
- **Non-negotiables for the user:** collections-as-rows, Continue Watching, big fanart
  backgrounds, poster thumbnails, watch-state sync, and it should *feel* like a single polished
  streaming app.
- **Prior research** on the native-client limitation and PinnedCollection lives in the session
  history; the primary sources are the GitHub links named in §2.

## 7. Deliverable expected from the study

A written feasibility report answering §5, with: a go/no-go recommendation, an effort + ongoing-
maintenance estimate for the fork option, the upstream-contribution alternative weighed against
it, the minimum viable hardware, and concrete next steps (which repo, which files, what a
prototype milestone looks like). Cite sources; flag guesses vs. confirmed.
