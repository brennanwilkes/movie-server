'use strict';
// Part 6/9 — Downloads tab: row rendering + action buttons (retry/force-grab/
// pause/delete via event delegation), batch summary, stale indicator, Movie
// Mode button, pollDownloads(). Sheets it opens live in sheets.js.

// ── Downloads ──
function renderDownloads(items) {
  $('#downloads-empty').hidden = items.length > 0;
  // Red is reserved for "a human needs to look at this" (Needs attention, Error, Declined, and a
  // Not found that's been negative-cached). Blue is anything actively progressing on its own —
  // including the post-download steps (subtitles/import/processing), not just live byte transfer.
  // Orange is everything else mid-recovery: stalled, still searching/retrying, not yet resolved.
  const COLOR = { Declined: 'var(--danger)', 'Needs attention': 'var(--danger)', Error: 'var(--danger)', Unreleased: 'var(--muted)', 'Ready': 'var(--ok)', Done: 'var(--ok)', Importing: 'var(--accent)', 'Getting subtitles': 'var(--accent)', Processing: 'var(--accent)', Stalled: 'var(--warn)', 'Not found': 'var(--warn)', 'Not found (recent)': 'var(--muted)' };
  $('#downloads').innerHTML = items.map((d) => {
    const eta = d.state === 'Downloading' ? fmtEta(d.etaSeconds) : '';
    // Show the % on anything mid-transfer (not just "Downloading") — a partially-grabbed torrent
    // that's currently Queued/Stalled has real progress, and the bar floats it near the top, so
    // the label must explain why ("Queued · 25% · 8.5 GB") instead of looking like it hasn't started.
    const pctShown = d.progress > 0 && d.progress < 100 ? d.progress + '%' : '';
    const searchHint = d.searchHint ? ` · ${d.searchHint}` : '';
    const leftMeta = d.state === 'Declined'
      ? `Declined · Not enough disk space, needs ${fmtBytes(d.neededBytes)}, only ${fmtBytes(d.freeBytes)} free`
      : d.state === 'Not found' || d.state === 'Not found (recent)'
      ? `${d.state} · ${fmtRecovery(d)}${searchHint}`
      : d.state === 'Stalled' && d.stallGiveUpAt
      ? `Stalled · ${fmtGiveUp(d.stallGiveUpAt)}`
      : [d.state, pctShown, d.sizeBytes > 0 ? fmtBytes(d.sizeBytes) : '', d.note, d.searchHint].filter(Boolean).join(' · ');
    const color = COLOR[d.state] || '';
    const seedsShown = typeof d.seeds === 'number' ? `Seeds: ${d.seeds}` : '';
    const barW = (d.state === 'Declined' || d.attention) ? 100 : Math.min(100, d.progress);
    const isDone = d.state === 'Ready' || d.state === 'Done';
    const canDelete = d.hash && d.state !== 'Ready' && d.state !== 'Done';
    const isMissing = d.state === 'Not found' || d.state === 'Not found (recent)';
    const canForceGrab = isMissing && d.source === 'sonarr' && d._id != null;
    // Pause/resume: only for a real torrent that's actively in flight (not a "missing:" pseudo-row,
    // not a finished/importing item). Paused rows offer Resume; the rest offer Pause.
    const realHash = d.hash && !String(d.hash).startsWith('missing:');
    const pausable = realHash && ['Downloading', 'Stalled', 'Queued', 'Starting', 'Paused'].includes(d.state);
    const isPaused = d.state === 'Paused';
    let cleanTitle = '';
    if (isDone) {
      const mt = d.title.match(/^(.+?)[. _-]+(?:S\d{2,}|Season\s*\d+|19\d{2}|20\d{2}|Full|COMPLETE)/i);
      if (mt) cleanTitle = mt[1].replace(/[._]/g, ' ').trim();
      else {
        const mt2 = d.title.match(/^(.+?)[. _-]+(?:1080p|720p|2160p|480p|REMUX|BLURAY|WEB-?DL|WEBRIP|HDTV)/i);
        cleanTitle = mt2 ? mt2[1].replace(/[._]/g, ' ').trim() : d.title.replace(/-[A-Za-z0-9]+$/, '').replace(/[._]/g, ' ').trim();
      }
    }
    return `<li class="row dl${(d.attention || d.state === 'Declined') ? ' attn' : ''}${isDone ? ' done' : ''}" data-hash="${esc(d.hash || '')}" data-state="${esc(d.state)}" data-title="${esc(cleanTitle)}" data-source="${esc(d.source)}"${d._id ? ` data-app="${esc(d.source)}" data-id="${esc(d._id)}"` : ''}>
      <div class="dl-title-row">
        <span class="title">${esc(d.title)}</span>
        <span class="dl-actions">${isMissing ? `<button class="dl-retry" aria-label="Retry search"><svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>` : ''}${canForceGrab ? `<button class="dl-force" aria-label="Force grab via search"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 20h14"/></svg></button>` : ''}${pausable ? `<button class="dl-pause" aria-label="${isPaused ? 'Resume' : 'Pause'} download">${isPaused ? '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>'}</button>` : ''}${canDelete ? `<button class="dl-stop" aria-label="Delete torrent & files"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg></button>` : ''}</span>
      </div>
      <div class="mini-bar"><div style="width:${barW}%${color ? `;background:${color}` : ''}"></div></div>
      <div class="sub dl-meta"><span>${esc(leftMeta)}</span><span class="dl-meta-right">${[eta, seedsShown].filter(Boolean).map(esc).join(' · ')}</span></div>
    </li>`;
  }).join('');
  // Event delegation on the parent list (survives 4s DOM replacement from poll)
  const dl = $('#downloads');
  if (!dl._listener) {
    dl._listener = true;
    dl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.dl-stop');
      const rbtn = e.target.closest('.dl-retry');
      const pbtn = e.target.closest('.dl-pause');
      const li = e.target.closest('li.dl.done');
      if (pbtn) {
        const bli = pbtn.closest('li');
        const hash = bli && bli.dataset.hash;
        if (!hash) return;
        const paused = bli.dataset.state === 'Paused';
        pbtn.disabled = true;
        try {
          await postJSON(paused ? '/api/torrent/resume' : '/api/torrent/pause', { hash });
          toast(paused ? 'Resumed' : 'Paused');
          pollDownloads();                       // refresh so the icon flips to its new state
        } catch { pbtn.disabled = false; toast(paused ? 'Resume failed' : 'Pause failed'); }
      } else if (e.target.closest('.dl-force')) {
        const bli = e.target.closest('li');
        const app = bli && bli.dataset.app;
        const id = bli && bli.dataset.id;
        if (!app || !id) return;
        openForceGrabSheet(app, Number(id));
      } else if (rbtn) {
        const bli = rbtn.closest('li');
        const app = bli && bli.dataset.app;
        const id = bli && bli.dataset.id;
        if (!app || !id) return;
        rbtn.disabled = true;
        try {
          await postJSON('/api/retry', { app, id: Number(id) });
          rbtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
          toast('Search triggered · check back soon');
        } catch { rbtn.disabled = false; toast('Retry failed'); }
      } else if (btn) {
        const bli = btn.closest('li');
        const hash = bli && bli.dataset.hash;
        if (!hash) return;
        const state = bli && bli.dataset.state;
        if (state === 'Declined') {
          try {
            await postJSON('/api/declined/dismiss', { hash });
            btn.disabled = true;
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
          } catch { toast('Failed to dismiss'); }
        } else {
          const t = bli.querySelector('.title');
          openSheet({ hash, source: bli.dataset.source, title: t ? t.textContent : 'this download' });
        }
      } else if (li) {
        const title = li.dataset.title;
        const w = window.open(`${WATCH_URL}/web/`, '_blank');
        let path = `#/search?query=${encodeURIComponent(title)}`;
        try {
          const qs = new URLSearchParams({ title, hash: li.dataset.hash || '', source: li.dataset.source || '' });
          const { id, serverId } = await getJSON(`/api/jellyfin/resolve?${qs}`);
          if (id) path = `#/details?id=${id}${serverId ? `&serverId=${serverId}` : ''}`;
        } catch { /* keep the search fallback */ }
        if (w) w.location.href = `${WATCH_URL}/web/${path}`;
      }
    });
  }
}
// Batch estimate — "how long to clear the backlog": remaining bytes ÷ current speed. Hidden
// unless there's actually pending work, so a settled queue shows nothing.
function renderDlSummary(s) {
  const el = $('#dl-summary'); if (!el) return;
  projectedIncoming = (s && s.remainingBytes) || 0;             // feed the disk meter's incoming segment
  if (lastDisk) renderDisk(lastDisk);                           // reflect it without waiting for the 10s home poll
  const c = s && s.counts;
  if (!c || (c.inProgress + c.queued + c.attention + c.blocked) < 1) { el.hidden = true; return; }
  const b = s.bytes, total = (b.completed + b.inProgress + b.queued + b.attention + b.blocked) || 1;
  const pct = (x) => (x / total * 100).toFixed(2);
  const eta = s.etaSeconds ? `${fmtDur(s.etaSeconds)} left` : null;
  // Sub-info only makes sense alongside a time estimate — speed without context
  // is just noise (e.g. a bare "34 MB/s" tells you nothing useful).
  const subParts = eta ? [
    s.remainingBytes ? fmtBytes(s.remainingBytes) : '',
    s.speedBytes ? `${fmtBytes(s.speedBytes)}/s` : '',
    s.sizing ? `${s.sizing} sizing` : '',
  ].filter(Boolean) : [];
  // Only render the eta span when there's a time estimate — an empty one creates
  // awkward flex gap in the badge.
  const displayHead = eta || (s.remainingBytes ? `${fmtBytes(s.remainingBytes)} to go` : 'Idle');
  const displaySub = subParts.join(' · ');
  el.hidden = false;
  el.innerHTML = `
    <div class="dls-head">${displayHead ? `<span class="dls-eta">${esc(displayHead)}</span>` : ''}${displaySub ? `<span class="dls-rate">${esc(displaySub)}</span>` : ''}</div>
    <div class="dls-bar">
      <span class="seg done" style="width:${pct(b.completed)}%"></span>
      <span class="seg prog" style="width:${pct(b.inProgress)}%"></span>
      <span class="seg queue" style="width:${pct(b.queued)}%"></span>
      <span class="seg attn" style="width:${pct(b.attention)}%"></span>
      <span class="seg blocked" style="width:${pct(b.blocked)}%"></span>
    </div>
    <div class="dls-legend">
      <span class="done">${c.completed} done</span>
      <span class="prog">${c.inProgress} resolving</span>
      <span class="queue">${c.queued} pending</span>
      ${c.attention ? `<span class="attn">${c.attention} needs attention</span>` : ''}
      ${c.blocked ? `<span class="blocked">${c.blocked} waiting</span>` : ''}
    </div>`;
}

// Show a spinner ONLY until the first successful load (the library lookups make the first
// fetch slow); the 4s background refreshes then update in place with no flicker.
let dlLoaded = false, dlInflight = false, dlLastUpdate = 0;
function setDlLoading(v) { const el = $('#downloads-loading'); if (el) el.hidden = !v; }
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function updateDlStale() {
  const el = $('#dl-summary');
  if (!el) return;
  const stale = dlLastUpdate > 0 && Date.now() - dlLastUpdate > 10000;
  el.classList.toggle('stale', stale);
  const head = el.querySelector('.dls-head');
  if (head) {
    let span = head.querySelector('.dls-stale');
    if (stale) {
      if (!span) { span = document.createElement('span'); span.className = 'dls-stale'; head.appendChild(span); }
      span.textContent = `stale (${fmtDuration(Date.now() - dlLastUpdate)})`;
    } else if (span) span.remove();
  }
}
// Movie Mode (master pause) — one tap frees the NUC's CPU + disk for smooth Jellyfin playback.
const mmBtn = $('#movie-mode-btn');
let mmBusy = false;
function renderMovieMode(paused) {
  if (!mmBtn) return;
  mmBtn.classList.toggle('on', !!paused);
  mmBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  const label = mmBtn.querySelector('.mm-label');
  if (label) label.textContent = paused ? 'Paused for streaming · tap to resume everything' : 'Movie Mode · pause everything for streaming';
  const path = mmBtn.querySelector('svg path');
  if (path) path.setAttribute('d', paused ? 'M7 5l12 7-12 7z' : 'M9 5v14M15 5v14');   // play triangle when paused, pause bars otherwise
}
if (mmBtn) mmBtn.addEventListener('click', async () => {
  if (mmBusy) return;
  const pausing = !mmBtn.classList.contains('on');
  mmBusy = true; mmBtn.disabled = true;
  renderMovieMode(pausing);                                   // optimistic flip
  try {
    const out = await postJSON(pausing ? '/api/master-pause' : '/api/master-resume', {});
    if (out && out.qbit === false) toast(pausing ? 'Sweeps paused — but qBittorrent didn’t confirm, torrents may still run' : 'Sweeps resumed — but qBittorrent didn’t confirm');
    else toast(pausing ? 'Movie Mode on · everything paused' : 'Resumed · downloads back on');
    pollDownloads();
  } catch { renderMovieMode(!pausing); toast('Could not reach the server'); }
  finally { mmBusy = false; mmBtn.disabled = false; }
});

async function pollDownloads() {
  if (offline) { setDlLoading(false); return; }
  updateDlStale();
  if (dlInflight) return;                                     // a poll is still running — don't stack another
  if (!dlLoaded) setDlLoading(true);
  dlInflight = true;
  try {
    const data = await getJSON('/api/downloads');
    if (!data.ts) return;   // snapshot not built yet (controller warming up) — keep the spinner,
                            // don't render a confident "Nothing downloading right now" from ts:0
    dlLastUpdate = data.ts;
    dlLoaded = true;
    setDlLoading(false);
    renderDownloads(data.items || []);
    renderDlSummary(data.summary);
    renderMovieMode(data.masterPaused);
    updateDlStale();                                          // clear stale indicator
  } catch { if (dlLoaded) setDlLoading(false); /* else keep spinner; it retries next tick */ }
  finally { dlInflight = false; }
}
