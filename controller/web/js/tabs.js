'use strict';
// Part 4/11 — tab switching. showTab() calls each tab's loader at click/boot time only;
// qShow() (quality.js) no-ops on a warm cache so flicking tabs does not refetch.

// ── Tabs ──
const TITLES = { home: 'Home', downloads: 'Downloads', library: 'Library', audit: 'Audit', jobs: 'Jobs' };
function showTab(name) {
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#page-title').textContent = TITLES[name];
  try { localStorage.setItem('tab', name); } catch { /* ignore */ } // survive refresh
  // The Quality tab is the one view too wide for main's 640px cap.
  document.body.classList.toggle('tab-wide', name === 'library');
  // Leaving the tab with a film open must POP, or the pushed entry survives and the next back
  // press lands in a hidden tab looking dead before dropping the user out of the app.
  if (name !== 'library' && typeof qState === 'object' && qState.view === 'film') qResetToList();
  if (name === 'library') qShow();
  if (name === 'audit') loadAudit();
  // The Jobs tab polls only while it is on screen, and re-paces itself between 5s and 20s depending
  // on whether anything is actually running (see jobsPollStart() in jobs.js). Started here rather
  // than from its own render so leaving the tab reliably stops the polling.
  if (name === 'jobs') jobsPollStart(); else jobsPollStop();
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  // Tapping the tab you are already on is a "take me back to the top" gesture: on Library that
  // means leave the film view and drop its history entry, not re-enter it.
  // The tab bar is navigation, not history: tapping Library always lands on the table.
  if (b.dataset.tab === 'library' && typeof qState === 'object' && qState.view === 'film') qResetToList();
  showTab(b.dataset.tab);
}));
