'use strict';
// Part 9/9 — toast, Home action buttons, visibility-aware polling, and boot
// (restore last tab). Loads last: everything above is defined by now.

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ── Home action buttons ──
$('#request-btn').href = REQUEST_URL;
$('#watch-btn').addEventListener('click', (e) => { e.preventDefault(); openJellyfin(); });

// ── Polling ──
// Skip work while the tab is hidden (backgrounded/screen off) — there's nothing to repaint
// and no point hammering the services. Snap back to fresh data the instant the tab is shown.
function poll(fn, ms) { const tick = () => { if (!document.hidden) fn(); }; tick(); return setInterval(tick, ms); }
poll(pollHome, 10000);
poll(pollDownloads, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollHome(); pollDownloads(); } });
let startTab; try { startTab = localStorage.getItem('tab'); } catch { /* ignore */ }
showTab(['home', 'downloads', 'library'].includes(startTab) ? startTab : 'home');
