# Branding deploy pipeline (web client)

How the Movie Night look reaches the Jellyfin **web** client, and the ordering
constraints that make it fragile if reordered. (The Fire Stick fork has its own
pipeline — see `jellyfin-tv-client` notes in AGENTS.md.)

## The three artifacts

| Artifact | File | Delivery |
|---|---|---|
| Custom CSS | `scripts/provision/jellyfin-custom.css` | Jellyfin Branding API (`branding.xml` `<CustomCss>`) |
| Flair JS | `scripts/provision/jellyfin-web-flair.js` | JavaScript Injector plugin (n00bcodr) |
| Fonts | `scripts/provision/fonts/` (Poppins, Oswald, Archivo, Jost, Palm Canyon Drive) | bind-mounted into the container's `/usr/share/jellyfin/web/fonts/` |

## CSS path (jellyfin.sh §6 → §7a)

1. The whole CSS file is HTML-escaped into a `<CustomCss>` element in
   `branding.xml` and `docker cp`'d into `jellyfin:/config/`.
2. **Ordering is load-bearing:** this must be the LAST branding write before the
   restart — the splashscreen POST rewrites `branding.xml` from Jellyfin's
   in-memory state and would clobber a CSS copied earlier.
3. §7a verifies: sha256 of the live `/Branding/Css` response vs the source file.
   Any local edit ⇒ re-run provision or the check fails loudly.
4. Client caching: `CustomCss` arrives inside a JSON API response, so URL
   cache-busting can't work. `refreshBrandingCss()` in the flair JS re-fetches
   `/Branding/Css?v=<now>` on every page load and injects it as a late
   `<style>` that wins by cascade position.

## Flair JS path (jellyfin.sh §6d3 → §9)

1. §6d3 installs the JavaScript Injector plugin from its manifest.
2. §9 pushes the whole file as ONE string (`jq --rawfile`) into the plugin's
   `CustomJavaScripts` array. The plugin concatenates entries into
   `/JavaScriptInjector/public.js` and injects a loader into `index.html`.
3. **Single-file constraint:** no build step, no imports — the file must stay
   self-contained (stated invariant in its header).
4. **Dedupe-by-Name:** entries have no persistent id, so provision drops every
   prior "Curated List Flair" entry and appends exactly one. Renaming the entry
   would strand the old copy, concatenated forever.

## Fonts

`@font-face` inside CustomCss / injected `<style>` doesn't load reliably, so
fonts are self-hosted files referenced at `/web/fonts/`. That directory is a
**bind mount** (not an image layer) since 2026-07-13, so fonts survive image
pulls; `poppins-face.css` is loaded via a real `<link>` tag by the flair JS.

## Theme tokens — one truth, three copies

`docs/branding/THEME-TOKENS.json` is the declared source of truth for the four
palettes (canyon / matinee / reelone / marquee). It is hand-mirrored in:

1. the `THEMES` object in `jellyfin-web-flair.js` (web: themeRoulette sets
   `--mn-*` vars + `[mn-*]` attribute gates on `<html>` per tab-session), and
2. the Android TV fork's `theme_movienight_*.xml`.

`make check-themes` (`scripts/check-theme-sync.sh`) greps both consumers against
the JSON and fails on drift — run it after ANY palette change. The CSS itself
carries only structure + fallbacks; per-theme values arrive at runtime from JS.

## Debugging

`scripts/branding-console-probe.js` — paste into the browser DevTools console on
the home + detail pages; it dumps computed styles (`=== MN DEBUG DUMP ===`) for
the drawer, cards, and `mn-*` attribute state. See also
`docs/branding/TROUBLESHOOTING.md`.
