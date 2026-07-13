const API = '/api/elo';
let state;

const $ = s => document.querySelector(s);
const BASE_K = 24;
const K_DECAY = 5;
const PROXIMITY_SCALE = 40;

function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function updateElo(r, o, s, K) { return r + Math.round(K * (s - expected(r, o))); }

function pickOpponent(a) {
  const aRating = state.ratings[a.Id];
  let total = 0;
  const candidates = state.items
    .filter(it => it.Id !== a.Id)
    .map(it => {
      const dist = Math.abs(state.ratings[it.Id] - aRating);
      const w = 1 / (1 + Math.pow(dist / PROXIMITY_SCALE, 2));
      total += w;
      return { item: it, w };
    });
  let roll = Math.random() * total;
  for (const c of candidates) {
    roll -= c.w;
    if (roll <= 0) return c.item;
  }
  return candidates[candidates.length - 1].item;
}

function pairKey(idA, idB) { return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`; }

function eloK(item) {
  const n = state.items.length;
  const rank = item._eloRank != null ? item._eloRank - 1 : getRanked().findIndex(it => it.Id === item.Id);
  const rankFactor = 0.2 + 1.8 * (rank / n);
  const comparisons = state.compared[item.Id] || 0;
  const progress = Math.min(1, state.matchups / state.hardCapMatchups);
  const globalDecay = 1 - 0.7 * progress;
  return BASE_K * rankFactor * globalDecay / Math.sqrt(1 + comparisons / K_DECAY);
}

async function init() {
  show('loading');
  try {
    const r = await fetch(`${API}/top100`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state = {
      playlistId: data.playlistId,
      items: data.items,
      origOrder: data.items.map(i => i.Id),
      ratings: {},
      matchups: 0,
      maxMatchups: Math.round(data.items.length * 2.5),
      hardCapMatchups: Math.round(data.items.length * 5),
      converged: false,
      compared: {},
      pairsCompared: new Set(),
      priorityQueue: [],
      history: [],
      ooHistory: [],
      lastOrder: data.items.map(i => i.Id),
    };
    data.items.forEach((it, i) => { state.ratings[it.Id] = 1500 - (i * 5); });
    console.log(`[tuner] init: ${data.items.length} items, maxMatchups=${state.maxMatchups}`);
    next();
  } catch (e) {
    const msg = e?.message || String(e) || 'unknown error (check console)';
    const em = $('#error-msg');
    if (em) em.textContent = msg;
    show('error');
  }
}

function show(id) {
  for (const s of ['compare', 'review', 'loading', 'error']) {
    const el = document.getElementById(s);
    if (el) el.hidden = s !== id;
  }
  const lbl = $('#phase-label');
  if (lbl) {
    if (id === 'compare') lbl.textContent = 'Comparing';
    else if (id === 'review') lbl.textContent = 'Review';
    else if (id === 'loading') lbl.textContent = 'Loading…';
    else lbl.textContent = 'Error';
  }
}

function getRanked() {
  return [...state.items].sort((a, b) => state.ratings[b.Id] - state.ratings[a.Id]);
}

function updateRanks() {
  getRanked().forEach((it, i) => { it._eloRank = i + 1; });
}

function estimateRemaining() {
  const h = state.ooHistory;
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const unCompared = state.items.filter(it => (state.compared[it.Id] || 0) < 1).length;
  const unsettled = state.items.length - last.settled;
  const raw = Math.max(unCompared * 2, Math.ceil(unsettled * 1.5));
  return Math.min(raw, state.maxMatchups - state.matchups);
}

function next() {
  resolving = false;
  updateRanks();
  if (state.converged) { goReview(); return; }

  const n = state.items.length;
  if (n < 2) { goReview(); return; }
  show('compare');

  let a, b;
  const itemById = id => state.items.find(it => it.Id === id);
  let queued;
  while (state.priorityQueue.length && !queued) {
    const [idA, idB] = state.priorityQueue.shift();
    // The pair may have already been settled by an earlier direct comparison
    // (e.g. queued twice, or resolved via the back button) — skip stale entries.
    if (!state.pairsCompared.has(pairKey(idA, idB)) && itemById(idA) && itemById(idB)) queued = [idA, idB];
  }
  if (queued) {
    a = itemById(queued[0]);
    b = itemById(queued[1]);
  } else {
    a = state.items[Math.floor(Math.random() * n)];
    b = pickOpponent(a);
  }

  state.matchups++;
  const est = estimateRemaining();
  const pct = est != null
    ? Math.min(100, Math.round((state.matchups / (state.matchups + est)) * 100))
    : Math.min(100, Math.round((state.matchups / state.maxMatchups) * 100));

  const left = Math.random() < 0.5 ? a : b;
  const right = left === a ? b : a;

  $('#title-a').textContent = left.Name;
  $('#meta-a').textContent = [left.ProductionYear, left.Genres?.[0]].filter(Boolean).join(' · ');
  setPoster('poster-a', left.Id, left);

  $('#title-b').textContent = right.Name;
  $('#meta-b').textContent = [right.ProductionYear, right.Genres?.[0]].filter(Boolean).join(' · ');
  setPoster('poster-b', right.Id, right);

  const estText = est != null ? ` · ~${est} left` : '';
  $('#prog-text').textContent = `Matchup ${state.matchups}${estText}`;
  $('#progress-bar').style.width = pct + '%';

  $('#opt-a').onclick = () => resolve(left, right, left, right);
  $('#opt-b').onclick = () => resolve(left, right, right, left);
  updateBackBtn();
}

let resolving = false;

function resolve(left, right, winner, loser) {
    if (resolving) return;
    resolving = true;

    state.history.push({
      left, right,
      leftRating: state.ratings[left.Id],
      rightRating: state.ratings[right.Id],
      matchups: state.matchups,
      compared: { ...state.compared },
      pairsCompared: new Set(state.pairsCompared),
      priorityQueue: [...state.priorityQueue],
      ooHistory: [...state.ooHistory],
      lastOrder: [...state.lastOrder],
    });

  const kW = eloK(winner), kL = eloK(loser);
  state.ratings[winner.Id] = updateElo(state.ratings[winner.Id], state.ratings[loser.Id], 1, kW);
  state.ratings[loser.Id] = updateElo(state.ratings[loser.Id], state.ratings[winner.Id], 0, kL);

  state.compared[winner.Id] = (state.compared[winner.Id] || 0) + 1;
  state.compared[loser.Id] = (state.compared[loser.Id] || 0) + 1;
  state.pairsCompared.add(pairKey(winner.Id, loser.Id));

  if (state.matchups % 10 === 0 && state.matchups >= 60) {
      const s2 = getRanked();
      const currentOrder = s2.map(it => it.Id);
      const prevPos = new Map(state.lastOrder.map((id, i) => [id, i]));
      // Tolerate drift instead of requiring exact position match: intransitive
      // preference cycles (A beats B, B beats C, C beats A) have no stable order and
      // will rotate a few items around each other forever under a strict equality test.
      // Tolerance widens further down the list — the top of the ranking matters most
      // and should settle tightly, while lower-ranked ties are less important to pin down exactly.
      const MIN_DRIFT_TOLERANCE = 1;
      const MAX_DRIFT_TOLERANCE = 8;
      // An item that hasn't been compared (much) yet simply hasn't moved from its initial
      // slot — that's comparison-starvation, not real stability, and would otherwise let
      // "settled" read high before the ranking has actually been vetted.
      const MIN_COMPARISONS_TO_SETTLE = 3;
      const n = currentOrder.length;
      let settled = 0;
      for (let i = 0; i < n; i++) {
        const id = currentOrder[i];
        const prev = prevPos.get(id);
        const comparisons = state.compared[id] || 0;
        const tolerance = MIN_DRIFT_TOLERANCE + (MAX_DRIFT_TOLERANCE - MIN_DRIFT_TOLERANCE) * (i / (n - 1));
        if (comparisons >= MIN_COMPARISONS_TO_SETTLE && prev != null && Math.abs(prev - i) <= tolerance) settled++;
      }
      const unCompared = state.items.filter(it => (state.compared[it.Id] || 0) < 1).length;

      // Once every item has been touched at least once, positions can still shift purely by
      // transitive inference (A>B and B>C implies a guessed A>C, without A and C ever actually
      // being paired). Before calling those swaps real, queue a direct head-to-head for any
      // adjacent pair whose relative order flipped since the last checkpoint but that has never
      // been directly compared — this runs each checkpoint, so it naturally concentrates near
      // the settled tail end of a run rather than during early, noisy exploration.
      if (unCompared === 0) {
        for (let i = 0; i < currentOrder.length - 1; i++) {
          const idA = currentOrder[i], idB = currentOrder[i + 1];
          const prevA = prevPos.get(idA), prevB = prevPos.get(idB);
          const flipped = prevA != null && prevB != null && prevA > prevB;
          if (flipped && !state.pairsCompared.has(pairKey(idA, idB))) {
            state.priorityQueue.push([idA, idB]);
          }
        }
      }

      state.lastOrder = currentOrder;

      state.ooHistory.push({ matchups: state.matchups, settled });

      const est = estimateRemaining();
      console.log(`[tuner] check #${state.ooHistory.length}: matchup=${state.matchups} settled=${settled}/${state.items.length} unCompared=${unCompared} est=${est} maxMatchups=${state.maxMatchups}`);

      const settledEnough = settled >= state.items.length - 2;
      if ((settledEnough && unCompared === 0) || state.matchups >= state.hardCapMatchups) {
        state.converged = true;
        console.log(`[tuner] CONVERGED at matchup ${state.matchups}`);
      } else {
        const unsettled = state.items.length - settled;
        const wanted = Math.max(
          unCompared * 3,
          unsettled > 0 ? Math.ceil(unsettled * state.matchups / s2.length) : 0,
          10
        );
        state.maxMatchups = Math.min(state.hardCapMatchups, Math.max(state.matchups, state.matchups + wanted));
      }
    }
    next();
}

function goReview() {
  const ac = $('#review-accept');
  if (ac) { ac.hidden = false; ac.disabled = false; }
  $('#review-done').hidden = true;
  $('#review-loading').hidden = true;
  show('review');
  updateRanks();
  const sorted = getRanked();
  const origByPos = {};
  state.origOrder.forEach((id, i) => { origByPos[id] = i + 1; });

  $('#review-list').innerHTML = sorted.map((it, i) => {
    const oldRank = origByPos[it.Id] || it._eloRank;
    const diff = oldRank - (i + 1);
    let ch;
    if (diff > 0) ch = `<span class="rl-change up">↑${diff}</span>`;
    else if (diff < 0) ch = `<span class="rl-change down">↓${Math.abs(diff)}</span>`;
    else ch = `<span class="rl-change same">—</span>`;
    return `<li><span class="rl-title">${esc(it.Name)}</span><span class="rl-meta">${it.ProductionYear || ''} · ${Math.round(state.ratings[it.Id])} elo</span>${ch}</li>`;
  }).join('');
}

// ---- Back button ----

function updateBackBtn() {
  const btn = $('#back-btn');
  if (btn) btn.hidden = !state.history.length;
}

function goBack() {
  if (!state.history.length) return;
  resolving = false;
  const e = state.history.pop();
  state.ratings[e.left.Id] = e.leftRating;
  state.ratings[e.right.Id] = e.rightRating;
  state.matchups = e.matchups;
  state.compared = e.compared;
  state.pairsCompared = e.pairsCompared;
  state.priorityQueue = e.priorityQueue;
  state.ooHistory = e.ooHistory;
  state.lastOrder = e.lastOrder;
  state.converged = false;

  updateRanks();
  show('compare');

  $('#title-a').textContent = e.left.Name;
  $('#meta-a').textContent = [e.left.ProductionYear, e.left.Genres?.[0]].filter(Boolean).join(' · ');
  setPoster('poster-a', e.left.Id, e.left);
  $('#title-b').textContent = e.right.Name;
  $('#meta-b').textContent = [e.right.ProductionYear, e.right.Genres?.[0]].filter(Boolean).join(' · ');
  setPoster('poster-b', e.right.Id, e.right);

  const est2 = estimateRemaining();
  const pct2 = est2 != null
    ? Math.min(100, Math.round((state.matchups / (state.matchups + est2)) * 100))
    : Math.min(100, Math.round((state.matchups / state.maxMatchups) * 100));
  const estText2 = est2 != null ? ` · ~${est2} left` : '';
  $('#prog-text').textContent = `Matchup ${state.matchups}${estText2}`;
  $('#progress-bar').style.width = pct2 + '%';

  $('#opt-a').onclick = () => resolve(e.left, e.right, e.left, e.right);
  $('#opt-b').onclick = () => resolve(e.left, e.right, e.right, e.left);
  updateBackBtn();
}

// ---- Wire all click handlers ----

$('#review-accept').onclick = async function () {
  this.disabled = true;
  $('#review-loading').hidden = false;
  try {
    const sorted = getRanked();
    const r = await fetch(`${API}/top100/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistId: state.playlistId, itemIds: sorted.map(it => it.Id) }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    $('#review-loading').hidden = true;
    $('#review-done').hidden = false;
    this.hidden = true;
  } catch (e) {
    $('#review-loading').hidden = true;
    this.disabled = false;
    const em = $('#error-msg');
    if (em) em.textContent = e.message;
    show('error');
  }
};

$('#review-continue').onclick = () => {
  $('#review-done').hidden = true;
  const ac = $('#review-accept');
  if (ac) { ac.hidden = false; ac.disabled = false; }
  init();
};

$('#review-reject').onclick = init;

$('#review-export').onclick = () => {
  const sorted = getRanked();
  const blob = new Blob([JSON.stringify(sorted.map((it, i) => ({ rank: i + 1, title: it.Name, year: it.ProductionYear, rating: state.ratings[it.Id], id: it.Id })), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'top100-proposed.json'; a.click();
  URL.revokeObjectURL(url);
};

$('#error-retry').onclick = init;
$('#back-btn').onclick = goBack;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setPoster(id, itemId, item) {
  const img = $(`#${id}`);
  if (item.ImageTags?.Primary) {
    img.src = `/jf-img/Items/${itemId}/Images/Primary?maxWidth=300&quality=90`;
    img.onerror = () => { img.src = placeholderSvg(item); };
  } else {
    img.src = placeholderSvg(item);
  }
}

function placeholderSvg(item) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" fill="%231d2230"><rect width="200" height="300"/><text x="100" y="150" text-anchor="middle" fill="%238b93a7" font-size="14" font-family="sans-serif">${esc(item.Name?.charAt(0) || '?')}</text></svg>`
  );
}

init();
