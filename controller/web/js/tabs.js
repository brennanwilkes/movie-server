'use strict';
// Part 4/9 — tab switching (Home / Downloads / Library). showTab() calls
// loadLibrary() (defined in library.js) only at click/boot time.

// ── Tabs ──
const TITLES = { home: 'Home', downloads: 'Downloads', library: 'Library', audit: 'Audit', jobs: 'Jobs' };
function showTab(name) {
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#page-title').textContent = TITLES[name];
  try { localStorage.setItem('tab', name); } catch { /* ignore */ } // survive refresh
  if (name === 'library') loadLibrary();
  if (name === 'audit') loadAudit();
  // The Jobs tab polls only while it is on screen, and re-paces itself between 5s and 20s depending
  // on whether anything is actually running (see jobsPollStart() in jobs.js). Started here rather
  // than from its own render so leaving the tab reliably stops the polling.
  if (name === 'jobs') jobsPollStart(); else jobsPollStop();
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
