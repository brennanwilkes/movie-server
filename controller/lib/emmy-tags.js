'use strict';
// Emmy badge tags sweep. Writes per-SERIES Emmy standing onto Jellyfin item Tags, which both
// clients read to draw a badge on the poster — the same tags-as-shared-source-of-truth recipe as
// oscar-tags.js (films) and nation-tags.js. Owns: emmyTagsBusy.
// Timers: startEmmyTagsTimer() → every 24h (boot run sequenced by server.js bootSequence()).
//
// WHY THIS IS NOT JUST "N EMMY WINS". Emmy totals are an order of magnitude bigger than Oscar
// totals and are dominated by craft categories: Game of Thrones is 59 wins from 159 nominations,
// and 47 of those wins are Creative Arts. A poster badge reading "59 EMMY WINS" would make Cheers
// (95 major nominations) look like the best show ever made, and "159N" does not fit the compact
// Fire Stick pill. A boolean over ALL nominations does not discriminate either — 97% of the series
// with any Emmy history have at least one nomination.
//
// So the badge names the PROGRAM award (the show itself winning: Outstanding Drama Series,
// Animated Program, Documentary Series…), whose counts are naturally single-digit, and falls back
// to a plain "nominated" marker over MAJOR nominations only, which does discriminate — 53 of this
// library's 98 series. See docs/DESIGN-EMMY-BADGES.md.
//
// Tags written (idempotent, diff-only):
//   emmys                  presence marker (lets a client bulk-load every badged series in one
//                          Tags= query instead of one request per show)
//   emmy-wins-{N}          times the show won its TOP program award (only if > 0)
//   emmy-name-{DISPLAY}    that award's short name, e.g. `emmy-name-DRAMA SERIES`
//   emmy-nominated         has a major nomination but no program win — the fallback tier
//
// MATCHING is by PROVIDER ID (IMDb, then TMDb, then TVDB), never by title. controller/
// emmy-awards.json is keyed by all three. Titles are unsafe here: this library holds Dexter ×4,
// Cosmos ×2 and Suits/Suits LA, and an earlier title-based prototype matched our `House` to the
// Emmy record of an unrelated show called "In The House".
//
// SAFETY (memory: storm 2026-07-07): metadata Tags only. Never deletes items, triggers searches or
// grabs, or touches user policies. emmy* tags must NEVER be added to any BlockedTags.
// GOTCHA (memory: jellyfin-dto-write-gotchas): strip .Trickplay before POST /Items or items with
// trickplay images 500.

const fs = require('fs');
const path = require('path');
const app = require('./app');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');
const jobs = require('./jobs');

const EMMY_TAG_RE = /^emmy(s|-wins-\d+|-name-.+|-nominated)$/;

const emmyAwards = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'emmy-awards.json'), 'utf8')); }
  catch { return {}; }
})();

let emmyTagsBusy = false;

// IMDb first: Wikidata's coverage of it is the best of the three, and it is the id Jellyfin is most
// likely to carry for a series.
function lookup(providerIds) {
  const p = providerIds || {};
  const tries = [['imdb', p.Imdb || p.IMDB], ['tmdb', p.Tmdb || p.TMDB], ['tvdb', p.Tvdb || p.TVDB]];
  for (const [k, v] of tries) {
    if (v == null) continue;
    const hit = (emmyAwards[k] || {})[String(v)];
    if (hit) return hit;
  }
  return null;
}

function desiredTags(current, e) {
  const base = (current || []).filter((t) => !EMMY_TAG_RE.test(t));
  if (!e) return base;
  const wins = e.topAwardWins || 0;
  const nominated = !e.programWins && (e.majorNoms || 0) > 0;
  if (!wins && !nominated) return base;
  base.push('emmys');
  if (wins > 0) {
    base.push(`emmy-wins-${wins}`);
    if (e.topAward) base.push(`emmy-name-${e.topAward}`);
  } else if (nominated) {
    base.push('emmy-nominated');
  }
  return base;
}

function sameTags(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((t) => s.has(t));
}

// Full-DTO fetch→patch→POST: POST /Items/{id} REPLACES the item, so patch only .Tags on the
// complete DTO — omitted fields get erased.
async function reconcileTags(uid, h, item, e) {
  const current = item.Tags || [];
  const want = desiredTags(current, e);
  if (sameTags(current, want)) return 'skip';
  try {
    const dto = await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items/${item.Id}`, { headers: h }, 15000);
    dto.Tags = want;
    delete dto.Trickplay;   // Jellyfin 500s deserialising its own TrickplayInfoDto on POST
    const r = await tfetch(`${HOST.jellyfin}/Items/${item.Id}`, {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h),
      body: JSON.stringify(dto),
    }, 20000);
    return (r && r.ok) ? 'written' : 'failed';
  } catch { return 'failed'; }
}

async function emmyTagsSweep() {
  if (emmyTagsBusy) return;
  if (isMasterPaused()) { console.log('emmyTagsSweep: skipped — master paused'); return; }
  if (!Object.keys(emmyAwards).length) { console.log('emmyTagsSweep: skipped — no emmy-awards.json'); return; }
  emmyTagsBusy = true;
  try {
    const uid = await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"` };
    const r = await tfetchJson(
      `${HOST.jellyfin}/Users/${uid}/Items?IncludeItemTypes=Series&Recursive=true`
      + '&Fields=ProviderIds,Tags&Limit=100000', { headers: h }, 120000);
    const series = (r && r.Items) || [];
    let matched = 0, written = 0, removed = 0, failed = 0, winners = 0;
    for (const s of series) {
      const e = lookup(s.ProviderIds);
      if (e) {
        matched++;
        if (e.topAwardWins > 0) winners++;
      }
      const res = await reconcileTags(uid, h, s, e);
      if (res === 'written') { written++; if (!e) removed++; }
      else if (res === 'failed') failed++;
    }
    console.log(`emmyTagsSweep: ${series.length} series scanned, ${matched} with Emmy majors `
      + `(${winners} with a program win), ${written} written${removed ? `, ${removed} cleared` : ''}`
      + (failed ? `, ${failed} failed` : ''));
  } catch (e) { console.log(`emmyTagsSweep: failed — ${e.message || e}`); }
  finally { emmyTagsBusy = false; }
}

// Detail-screen list: WHICH awards, not just the headline count. Mirrors /api/awards for films.
app.get('/api/emmys', (req, res) => {
  try {
    const e = lookup({ Imdb: req.query.imdb, Tmdb: req.query.tmdb, Tvdb: req.query.tvdb });
    res.json(e ? {
      programWins: e.programWins, programNoms: e.programNoms, majorNoms: e.majorNoms,
      topAward: e.topAward, topAwardWins: e.topAwardWins,
      awards: Object.entries(e.awards || {}).map(([name, n]) => ({ name, wins: n }))
        .sort((a, b) => b.wins - a.wins),
    } : { programWins: 0, programNoms: 0, majorNoms: 0, topAward: null, topAwardWins: 0, awards: [] });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

const tracked = jobs.define({
  id: 'emmy-tags', name: 'Emmy badges', group: 'Metadata', weight: 57,
  what: 'Tags series with their Emmy program awards',
  every: 24 * 3600000, scheduleText: 'daily · and on boot', pausedByMovieMode: true,
}, emmyTagsSweep);

function startEmmyTagsTimer() {
  setInterval(tracked, 24 * 3600000);   // award data changes once a year — daily is plenty
}

module.exports = { emmyTagsSweep: tracked, startEmmyTagsTimer };
