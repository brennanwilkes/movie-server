'use strict';
// JOBS TAB — one component, every background job. Built 2026-08-06.
//
// THE DESIGN RULE, and the reason this file is small: there is exactly ONE renderer, jobCard(), and
// every job goes through it. The backend normalises three very different runtimes (in-process
// sweeps, Jellyfin scheduled tasks, host systemd timers) into one contract (see lib/jobs.js), so
// this file never asks where a job came from — only what state it is in. Adding a job means adding
// a declaration on the server; nothing here changes.
//
// FOUR FIXED SLOTS per card, always in the same order, so the page is scanned as a column rather
// than read as 36 paragraphs: HEAD (name · badge · figure) → BAR → SUB (one line) → FOOT (meta ·
// buttons). Every card has all four, every card has a badge, every card has a bar — a row missing
// any of them reads as a different component, which is what made the first version look like loose
// text on grey (Brennan, 2026-08-06).
//
// COLOUR IS RESERVED. Running is accent, gated is amber, failed is red, completed bars go green.
// Idle and queued get a muted badge so the slot is filled without competing — 30 bright badges
// would make the one that matters invisible.
//
// POLLING: only while the tab is visible (see showTab in tabs.js). A running job is polled at 5s so
// a progress bar actually moves; an all-idle list at 20s, because nothing on it can change faster
// than its own schedule. That keeps a backgrounded phone from waking the box every few seconds.

let jobsState = null;         // last /api/jobs payload
let jobsTimer = null;
let jobsPollMs = 0;           // current interval, so we only reset the timer when the cadence changes
let jobsBusy = new Set();     // job ids with an action in flight — disables just that card's button
let mmBusy = false;

const JOBS_POLL_ACTIVE_MS = 5000;
const JOBS_POLL_IDLE_MS = 20000;

// ── THE COMPONENT ─────────────────────────────────────────────────────────────────────────────
// THREE FIXED ROWS, one fixed height, identical on every card. Brennan, 2026-08-06: "I want a
// standardized UI where the only text is the title and maybe the desc, everything else is a bar, a
// colour, a badge... standardized to be even, fill width and height."
//
//   row 1   title ......................................... BADGE
//   row 2   live detail, else what the job is for          (one line, ellipsised)
//   row 3   [============ bar ============]  figure  [button]
//
// Only rows 1 and 2 carry prose. Everything else is geometry: the badge carries state, the bar
// carries progress OR time-to-next-run, colour carries urgency. The schedule and last-run text that
// used to sit in a fourth line is GONE from the card — the bar already encodes it, and it is on the
// card's title attribute for anyone who wants the exact words.
const JOB_BADGE = {
  running: { label: 'running', cls: 'run' },
  waiting: { label: 'waiting', cls: 'wait' },
  paused: { label: 'paused', cls: 'wait' },
  error: { label: 'failed', cls: 'bad' },
  // AMBER, NOT RED. A task that was stopped — by its own runtime cap, by a shutdown, by hand — did
  // not go wrong. The trickplay generator hitting its deliberate 4h limit was reporting "FAILED" in
  // red every morning, which trains you to ignore the one colour that should mean "look at me".
  cancelled: { label: 'stopped', cls: 'wait' },
  idle: { label: 'idle', cls: 'dim' },
  never: { label: 'queued', cls: 'dim' },
  off: { label: 'off', cls: 'dim' },
};

// SORT ORDER — Brennan: "anything running or errored sorts above anything not running."
// Errors first: a failure is the only thing on this page that needs a human. Then running (what the
// box is doing now), then gated jobs (they WANT to run), then everything at rest by weight. Done in
// the client, not the API: /api/jobs stays a stable weight-ordered catalogue, and this is a
// presentation priority that changes every few seconds.
// `cancelled` sorts with the gated states, not with errors: it is worth noticing but never urgent.
const STATE_RANK = { error: 0, running: 1, waiting: 2, paused: 2, cancelled: 2 };
function jobRank(j) { return STATE_RANK[j.state] == null ? 3 : STATE_RANK[j.state]; }

// CADENCE OUTRANKS STATE (Brennan: "any crons that run more than once per hour, lets have them sort
// to the bottom regardless of if they're running or not"). Anything on a sub-hourly timer is
// plumbing — the disk gate runs every 30s and the downloads snapshot every 5s, so they are ALWAYS
// mid-run and would otherwise permanently occupy the top of a page whose job is to show what is
// actually happening. Applied before rank, so a running disk-gate still sorts below an idle
// trickplay pass. Jobs with no interval at all (the probe, event-driven work) are never chatty.
const CHATTY_MS = 3600000;
// cadenceMs where the server supplies one — a job whose TICK is fast but whose WORK is a slow
// rolling pass is not plumbing and must not be sunk. The library audit ticks every 45s to run one
// search but re-checks a given file fortnightly; judged on `every` alone it sorted to the bottom of
// the page under the disk gate. See cadenceMs in lib/jobs.js.
function jobCadenceMs(j) { return j.cadenceMs || j.every; }
function isChatty(j) { const ms = jobCadenceMs(j); return !!(ms && ms < CHATTY_MS); }

// Coarse on purpose: "4 min" and "5 min" are the same fact, and a live-ticking seconds counter on
// 36 cards reads as activity where there is none. Only used in the hover title now.
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

function inWords(ms) {
  if (!ms || ms <= 0) return '';
  const m = ms / 60000;
  if (m < 1) return '<1 min';
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 36) return `~${Math.round(h)} h`;
  return `~${Math.round(h / 24)} d`;
}

// The ONE figure a card is allowed, and it is deliberately a single short token. The ETA used to
// ride along ("873 left · ~4 d") and Brennan cut it as noise — the bar already shows how far along
// this is, so the only thing the number adds is scale. The ETA survives on the card's title.
function jobRight(j) {
  const p = j.progress;
  if (!p) return '';
  if (j.source === 'jellyfin') return `${Math.round(p.pct)}%`;   // Jellyfin reports percent, not counts
  const left = Math.max(0, p.total - p.done);
  return left ? `${left} left` : 'done';
}

// EVERY card gets a bar in the same slot — that is what makes the page a grid of components rather
// than a stack of paragraphs. Two kinds, deliberately unequal in weight:
//   work      real progress through a backlog. Coloured by state, GREEN when finished.
//   schedule  a dim tick-along toward the next run, for the ~30 jobs with no backlog. It must not
//             read as work in flight, only as "this thing is alive and on a clock".
function jobBar(j) {
  const p = j.progress;
  if (p) {
    const cls = p.pct >= 99.5 ? 'done' : (j.state === 'error' ? 'bad' : (j.state === 'running' ? 'run' : 'wait'));
    return `<div class="job-bar work ${cls}" role="progressbar" aria-valuenow="${Math.round(p.pct)}"
      aria-valuemin="0" aria-valuemax="100" aria-label="${esc(j.name)}"><i style="width:${Math.max(2, p.pct)}%"></i></div>`;
  }
  if (j.every && j.lastRun) {
    // Elapsed since the last run as a fraction of the interval, so the bar refills as the next run
    // approaches. Clamped: an overdue job pins full rather than overflowing its track.
    const pct = Math.max(0, Math.min(100, (Date.now() - j.lastRun) * 100 / j.every));
    return `<div class="job-bar sched" aria-hidden="true"><i style="width:${Math.max(2, pct)}%"></i></div>`;
  }
  return '<div class="job-bar sched" aria-hidden="true"><i style="width:0"></i></div>';
}

// ── the row-2 tags ────────────────────────────────────────────────────────────────────────────
// Two badges in the dead space to the right of the description, because a card was carrying less
// information than it had room for. Badges, never floating text — the whole point of the redesign.
//
// CADENCE: how often this runs, as one token. It is the single most useful fact that is NOT already
// on the card, and it explains the sort order at a glance (everything sub-hourly is dimmed and
// sunk). Derived from the real interval where there is one, else from the schedule wording.
function cadence(j) {
  const ms = jobCadenceMs(j);
  if (!ms) {
    const t = j.scheduleText || '';
    if (/nightly/i.test(t)) return 'nightly';
    if (/daily/i.test(t)) return 'daily';
    if (/weekly/i.test(t)) return 'weekly';
    if (/boot|startup/i.test(t)) return 'on boot';
    return 'on demand';
  }
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h`;
  const d = hr / 24;
  // 7d is "weekly"; beyond that say the number of days rather than rounding a 14-day cycle down to
  // a word that means something else.
  if (d >= 6.5 && d < 8) return 'weekly';
  if (d >= 8) return d >= 28 ? 'monthly' : `${Math.round(d)}d`;
  return d < 1.5 ? 'daily' : `${Math.round(d)}d`;
}

// AREA: what part of the system this job touches, colour-coded. Deliberately the `group`, not the
// runtime — which container a job happens to live in is an implementation detail this tab exists to
// normalise away, whereas "is this about my picture quality or about downloads" is what someone
// scanning actually wants. The runtime is on the card's title attribute for debugging.
//
// These hues are DESATURATED on purpose and sit apart from the status palette (accent/amber/red/
// green). Area is a permanent property; status is what is happening now, and status must always win
// the eye — hence status gets the rail AND the row-1 badge, area gets one quiet tag.
const GROUP_CLS = {
  // Shares g-quality's violet: the audit jobs ARE the quality story, split out only so the four
  // rows that back the Audit tab read as one family. A separate hue would imply a separate concern.
  Audit: 'g-quality',
  Quality: 'g-quality',
  'Media processing': 'g-media',
  Metadata: 'g-meta',
  Downloads: 'g-dl',
  System: 'g-sys',
};
const GROUP_LABEL = {
  Audit: 'audit',
  Quality: 'quality',
  'Media processing': 'media',
  Metadata: 'metadata',
  Downloads: 'downloads',
  System: 'system',
};

// The schedule/last-run prose that used to be a fourth text line. Kept as the card's hover title so
// the fact survives without costing a row.
function jobTitleAttr(j) {
  const bits = [j.what, `runs on: ${j.source}`];
  if (j.scheduleText) bits.push(j.scheduleText);
  else if (j.every) bits.push(`every ${inWords(j.every)}`);
  if (j.state === 'never') bits.push('not run yet');
  else if (j.state === 'running' && j.startedAt) bits.push(`started ${ago(j.startedAt)}`);
  else if (j.lastRun) bits.push(`last run ${ago(j.lastRun)}`);
  if (j.fails > 0) bits.push(`${j.fails} failure${j.fails === 1 ? '' : 's'}`);
  return bits.filter(Boolean).join(' · ');
}

// Actions worth a second tap: `recheck-sources` throws away every cached verdict and commits the box
// to ~2.5h of paced indexer searches; `rescan-upgrades` is the same trade over a longer backlog
// (~12h). Everything else is cheap or trivially reversible.
const JOB_CONFIRM = { 'recheck-sources': 'Sure?', 'rescan-upgrades': 'Sure?' };
const ARM_MS = 6000;
const jobsArmed = new Map();   // action key -> expiry. Survives the poll's re-render.

function armKey(id, act) { return `${id}:${act}`; }
function isArmed(id, act) {
  const t = jobsArmed.get(armKey(id, act));
  if (!t) return false;
  if (Date.now() > t) { jobsArmed.delete(armKey(id, act)); return false; }
  return true;
}

// Deliberately terse — these sit in the bar row and a long label would steal the bar's width.
//
// "Recheck", not "Re-run", for the two audit sweeps. Run/Stop belongs to the probe, which is a
// SESSION — it is either on or off, and the button is the switch. The sweeps are perpetual: they
// tick forever at their own pace, so there is nothing to start and nothing to stop, and a row that
// says `running` next to a button that says `Re-run` reads as a contradiction. What the button
// actually does is throw away cached verdicts so the sweep asks again — which is a recheck.
const JOB_ACTION_LABEL = {
  'start-session': 'Run', 'stop-session': 'Stop',
  'start-artifacts': 'Run', 'stop-artifacts': 'Stop',
  'start-sweep': 'Run', 'stop-sweep': 'Stop',
  'recheck-sources': 'Recheck', 'rescan-upgrades': 'Recheck',
  start: 'Run', stop: 'Stop',
};

function jobAction(j) {
  if (!j.actions || !j.actions.length) return '';
  const busy = jobsBusy.has(j.id);
  return j.actions.map((a) => {
    // Prefix test, not a list. The list was `stop`/`stop-session`/`stop-sweep` and silently missed
    // `stop-artifacts` when that job shipped — its Stop rendered in the ordinary button colour, so
    // the one destructive-looking control on the card did not look destructive. Every action verb
    // in this app is `<verb>` or `<verb>-<thing>`, so the prefix IS the verb.
    const stop = a === 'stop' || a.startsWith('stop-');
    const armed = isArmed(j.id, a);
    const label = armed ? JOB_CONFIRM[a] : (JOB_ACTION_LABEL[a] || a);
    return `<button class="job-btn${stop ? ' stop' : ''}${armed ? ' armed' : ''}"`
      + ` data-job="${esc(j.id)}" data-act="${esc(a)}"${busy ? ' disabled' : ''}`
      + ` aria-label="${esc(label)} ${esc(j.name)}">`
      + `${busy ? '<span class="spinner sm"></span>' : esc(label)}</button>`;
  }).join('');
}

function jobCard(j) {
  const badge = JOB_BADGE[j.state] || JOB_BADGE.idle;
  const right = jobRight(j);
  const sub = j.detail || j.what;
  // GREEN RAIL = ran and succeeded. Without this the left edge was grey on ~25 of 36 cards, which
  // wasted the strongest signal on the card and made a healthy box look inert. Idle is the resting
  // state of a job that IS working; `never` stays grey because it is genuinely unproven, and `off`
  // stays grey because it is not participating at all.
  const healthy = j.state === 'idle' && j.lastOk ? ' ok' : '';
  return `
    <article class="job-card s-${esc(j.state)}${healthy}${isChatty(j) ? ' chatty' : ''}" data-id="${esc(j.id)}"
             title="${esc(jobTitleAttr(j))}">
      <div class="job-head">
        <span class="job-name">${esc(j.name)}</span>
        <span class="job-tags">
          <span class="job-tag cad">${esc(cadence(j))}</span>
          <span class="job-tag ${GROUP_CLS[j.group] || 'g-sys'}">${esc(GROUP_LABEL[j.group] || j.group)}</span>
          <span class="job-badge ${badge.cls}">${badge.label}</span>
        </span>
      </div>
      <p class="job-sub${j.detail ? ' live' : ''}">${esc(sub)}</p>
      <div class="job-run">
        ${jobBar(j)}
        ${right ? `<span class="job-right">${esc(right)}</span>` : ''}
        ${jobAction(j)}
      </div>
    </article>`;
}

// ── Movie Mode ────────────────────────────────────────────────────────────────────────────────
// Two latches, one button (see lib/state.js). The button drives the MANUAL latch only; the AUTO
// latch belongs to playback. While auto holds it, the button is disabled and says so — Brennan's
// call: overriding it mid-film is not a thing anyone wants to do by accident, and the note explains
// the state rather than leaving a dead-looking control.
function renderMovieMode(mm) {
  const btn = $('#movie-mode-btn');
  if (!btn || !mm) return;
  const on = !!mm.on;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  // Disabled ONLY for auto-without-manual. If the manual latch is also set, the button must stay
  // live so the hold can be released — otherwise starting a film would trap a manual pause on.
  const locked = mm.auto && !mm.manual;
  btn.disabled = locked || mmBusy;
  btn.classList.toggle('locked', !!locked);
  const label = btn.querySelector('.mm-label');
  if (label) {
    label.textContent = locked ? 'Paused automatically · something is playing'
      : on ? 'Paused for streaming · tap to resume everything'
        : 'Movie Mode · pause everything for streaming';
  }
  const path = btn.querySelector('svg path');
  if (path) path.setAttribute('d', on ? 'M7 5l12 7-12 7z' : 'M9 5v14M15 5v14');   // play when paused

  const note = $('#mm-note');
  if (!note) return;
  let text = '';
  if (mm.playing && mm.playing.length) {
    const names = mm.playing.map((s) => s.title + (s.paused ? ' (paused)' : '')).join(', ');
    text = `Playing: ${names}`;
  } else if (mm.resumingInMs != null) {
    // Only shown while a resume is genuinely pending, so it is never a countdown that isn't running.
    text = `Nothing playing — resuming everything in ${inWords(mm.resumingInMs) || 'a moment'}`;
  } else if (mm.manual && mm.auto) {
    text = 'Held on manually, and something is playing';
  } else if (mm.manual) {
    text = 'Held on manually — stays paused until you tap again';
  }
  note.textContent = text;
  note.hidden = !text;
}

// ── render + poll ─────────────────────────────────────────────────────────────────────────────
function renderJobs() {
  const d = jobsState;
  if (!d) return;
  $('#jobs-loading').hidden = true;
  renderMovieMode(d.movieMode);
  const list = $('#jobs-list');
  const jobs = d.jobs || [];
  if (!jobs.length) {
    list.innerHTML = '';
    const err = $('#jobs-error');
    err.textContent = 'No background jobs are reporting. That is itself a problem — check the controller log.';
    err.hidden = false;
    return;
  }
  $('#jobs-error').hidden = true;
  // Active first (see STATE_RANK), then the server's weight order within each rank. Sorted on a
  // COPY so the poll's payload keeps its stable order for anything else reading it.
  const ordered = jobs.slice().sort((a, b) =>
    (isChatty(a) - isChatty(b)) || (jobRank(a) - jobRank(b)) || (b.weight - a.weight));
  list.innerHTML = ordered.map(jobCard).join('');
}

async function loadJobs() {
  try {
    jobsState = await getJSON('/api/jobs');
    renderJobs();
    // Re-pace to match what is happening, so a running job animates and an idle box is left alone.
    const active = (jobsState.jobs || []).some((j) => j.state === 'running');
    const want = active ? JOBS_POLL_ACTIVE_MS : JOBS_POLL_IDLE_MS;
    if (jobsTimer && want !== jobsPollMs) { jobsPollStop(); jobsPollStart(); }
  } catch {
    $('#jobs-loading').hidden = true;
    const err = $('#jobs-error');
    // Keep whatever was last rendered — a transient fetch failure should not blank a page someone
    // is reading. Only say so when there was never anything to show.
    if (!jobsState) { err.textContent = 'Could not reach the server.'; err.hidden = false; }
  }
}

function jobsPollStart() {
  if (jobsTimer) return;
  const active = jobsState && (jobsState.jobs || []).some((j) => j.state === 'running');
  jobsPollMs = active ? JOBS_POLL_ACTIVE_MS : JOBS_POLL_IDLE_MS;
  loadJobs();
  jobsTimer = setInterval(loadJobs, jobsPollMs);
}
function jobsPollStop() {
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = null;
}

// ── actions ───────────────────────────────────────────────────────────────────────────────────
// Delegated off the list container, because the cards are replaced on every poll and per-card
// listeners would be lost with them.
// Each route is called with the JOB ID, so one action name can serve several jobs — `start-sweep`
// is shared by both nightly audit sweeps and resolves against the id the button was rendered on.
// THESE ARE ID-AWARE, AND THAT FIXES A LIVE BUG. `start-session`/`stop-session` were hardcoded to
// the PROBE's URL and ignored the job id — so the banding card, which declares the same action and
// has its own /api/banding/session/* endpoints, posted to /api/probe/session/start and started the
// wrong job. Every job whose session endpoints follow /api/<id>/session/<verb> now resolves
// correctly from the id, and the two that do not (probe, whose route predates the convention) are
// mapped explicitly.
const SESSION_PATH = { probe: 'probe', banding: 'banding', artifacts: 'artifacts' };
const sessionRoute = (id, verb) => `/api/${SESSION_PATH[id] || id}/session/${verb}`;

const JOB_ACTION_ROUTE = {
  'start-session': (id) => [sessionRoute(id, 'start'), 'Running until you stop it'],
  'stop-session': (id) => [sessionRoute(id, 'stop'), 'Stopped'],
  'start-artifacts': (id) => [sessionRoute(id, 'start'), 'Measuring artifacts until you stop it'],
  'stop-artifacts': (id) => [sessionRoute(id, 'stop'), 'Artifact probe stopped'],
  'recheck-sources': () => ['/api/audit/rescan', 'Re-checking every source'],
  'rescan-upgrades': () => ['/api/audit/upgrade-rescan', 'Re-checking every upgrade candidate'],
  'start-sweep': (id) => [`/api/audit/session/${id}/start`, 'Running now — until you stop it'],
  'stop-sweep': (id) => [`/api/audit/session/${id}/stop`, 'Stopped'],
};

$('#jobs-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.job-btn');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.job;
  const act = btn.dataset.act;
  if (jobsBusy.has(id)) return;
  // First tap on a confirming action only arms it; the re-render below relabels the button and the
  // arm lapses on its own so a forgotten tap can never be completed minutes later by accident.
  if (JOB_CONFIRM[act] && !isArmed(id, act)) {
    jobsArmed.set(armKey(id, act), Date.now() + ARM_MS);
    renderJobs();
    setTimeout(renderJobs, ARM_MS + 100);
    return;
  }
  jobsArmed.delete(armKey(id, act));
  jobsBusy.add(id);
  renderJobs();                       // paint the spinner immediately
  try {
    let url;
    let msg;
    const route = JOB_ACTION_ROUTE[act];
    if (route) { [url, msg] = route(id); }
    else if (act === 'start' || act === 'stop') {
      // Jellyfin task. The id is `jf:<taskId>`; the server re-validates the shape.
      url = `/api/jobs/jf/${id.replace(/^jf:/, '')}/${act}`;
      msg = act === 'start' ? 'Started' : 'Stopping';
    } else return;
    await postJSON(url, {});
    toast(msg);
  } catch (err) {
    toast(`Could not do that — ${(err && err.message) || 'server error'}`);
  } finally {
    jobsBusy.delete(id);
    await loadJobs();                 // reflect the real new state rather than assuming it worked
  }
});

$('#movie-mode-btn').addEventListener('click', async () => {
  const btn = $('#movie-mode-btn');
  if (mmBusy || btn.disabled) return;
  const pausing = !btn.classList.contains('on');
  mmBusy = true;
  btn.disabled = true;
  try {
    const out = await postJSON(pausing ? '/api/master-pause' : '/api/master-resume', {});
    if (out && out.qbit === false) {
      toast(pausing ? 'Sweeps paused — but qBittorrent didn’t confirm, torrents may still run'
        : 'Sweeps resumed — but qBittorrent didn’t confirm');
    } else if (!pausing && out && out.auto) {
      // Releasing the manual hold while a film is playing leaves the box paused on the auto latch.
      // Saying "resumed" here would be a lie the user could act on.
      toast('Manual hold cleared — still paused because something is playing');
    } else {
      toast(pausing ? 'Movie Mode on · everything paused' : 'Resumed · downloads back on');
    }
  } catch {
    toast('Could not reach the server');
  } finally {
    mmBusy = false;
    await loadJobs();                 // loadJobs re-renders the button from server truth
  }
});
