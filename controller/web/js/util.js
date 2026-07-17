'use strict';
// Part 2/9 — DOM + formatting helpers: $/$$, esc() (real HTML escaping for
// untrusted torrent titles), sameHost(), and the fmt* formatters.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Real HTML escaping — every esc() call site interpolates into innerHTML or a quoted
// attribute (data-hash/data-title/aria-label). Torrent/release names are untrusted input:
// a `"` broke attribute parsing (dead buttons), `<`/`>` mangled rows, and markup executed.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Rewrite a URL's host to the one the dashboard was opened with (keeps scheme/port/path), so the
// server-built service links (which use the LAN IP) resolve over whatever path the user is on.
const sameHost = (u) => String(u || '').replace(/^(https?:\/\/)[^/:]+/i, `$1${location.hostname}`);

function fmtBytes(b) {
  if (!b) return '0 GB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i < 2 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtEta(s) {
  if (!s || s <= 0) return '';
  if (s < 90) return '1 min';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
// "Not found" rows: say when the next recovery search will actually fire, so it doesn't just
// sit there looking abandoned. d.recoveryNext is an absolute ms timestamp from the server.
function fmtRecovery(d) {
  if (d.recoveryBlocked) {
    if (d.recentRelease) return `no torrent yet — will retry ${fmtWhen(d.recoveryNext)}`;
    return `gave up after ${d.recoveryFails} tries, will retry ${fmtWhen(d.recoveryNext)}`;
  }
  if (!d.recoveryNext) return 'retrying soon';
  const ms = d.recoveryNext - Date.now();
  if (ms <= 0) return 'retrying now';
  return `next retry in ${fmtDur(ms / 1000)}`;
}
// "Stalled" rows: say when the give-up (blocklist + re-search) clock fires.
function fmtGiveUp(giveUpAt) {
  const ms = giveUpAt - Date.now();
  if (ms <= 0) return 'giving up now';
  return `giving up in ${fmtDur(ms / 1000)}`;
}
function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// Coarser, two-part duration for the batch estimate (e.g. "2d 4h", "9h 30m", "12 min").
function fmtDur(s) {
  if (!s || s <= 0) return '';
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}
