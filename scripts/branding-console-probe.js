// Movie Night — web theme diagnostic probe.
// Paste this whole file into the browser DevTools Console while logged in (brennan/brennan).
// Run it on the HOME page (nav bar + cards + icons) and again on a MOVIE DETAIL page (tags).
// It prints a JSON blob — copy everything under "=== MN DEBUG DUMP ===" back to Claude.
//
// Why a console probe (not headless): it runs in the real authenticated session against the
// live, hover-able DOM. scyfin's stylesheet is cross-origin (jsdelivr), so its .cssRules are
// CORS-blocked to JS — we rely on COMPUTED styles (the final winning value) instead.
(() => {
  const out = { url: location.href };

  const box = ['display', 'visibility', 'opacity', 'width', 'height', 'transform',
    'position', 'left', 'right', 'z-index', 'overflow', 'background-color', 'color',
    'border-radius', 'clip-path'];
  const pick = (el, props = box) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    const o = { tag: el.tagName, cls: el.className };
    props.forEach(p => o[p] = c.getPropertyValue(p));
    const r = el.getBoundingClientRect();
    o._box = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    return o;
  };
  const first = (sels) => { for (const s of sels) { const e = document.querySelector(s); if (e) return [s, e]; } return [null, null]; };

  // ── environment ─────────────────────────────────────────────────────────
  const root = document.documentElement, body = document.body;
  out.env = {
    htmlClass: root.className,
    bodyClass: body.className,
    mnAttrs: [...body.attributes, ...root.attributes].filter(a => a.name.startsWith('mn-')).map(a => `${a.name}=${a.value}`),
    stylesheets: [...document.styleSheets].map(s => {
      try { return `${s.href || 'inline'} (${s.cssRules ? s.cssRules.length + ' rules' : 'CORS-blocked'})`; }
      catch (e) { return `${s.href || 'inline'} (CORS-blocked)`; }
    }),
    cacheBustStyle: (() => { const e = document.getElementById('mn-branding-cache-bust'); return e ? e.textContent.length + ' chars' : 'MISSING'; })(),
  };

  // ── left nav drawer ─────────────────────────────────────────────────────
  out.nav = {
    mainDrawer: pick(document.querySelector('.mainDrawer')),
    scrollContainer: pick(document.querySelector('.mainDrawer-scrollContainer')),
    drawerButton: pick(document.querySelector('.mainDrawerButton, .headerButton.mainDrawerButton, .headerLeft .paper-icon-button-light')),
    navOptionCount: document.querySelectorAll('.navMenuOption').length,
    navOptions: [...document.querySelectorAll('.navMenuOption')].slice(0, 12)
      .map(e => ({ txt: (e.textContent || '').trim().slice(0, 24), display: getComputedStyle(e).display, cls: e.className })),
    // Any ancestor of the drawer that is hidden would take the whole bar with it:
    hiddenAncestors: (() => {
      let el = document.querySelector('.mainDrawer'); const chain = [];
      while (el && el !== document.body) {
        const c = getComputedStyle(el);
        if (c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0' || /translateX\(-/.test(c.transform))
          chain.push({ tag: el.tagName, cls: el.className, display: c.display, visibility: c.visibility, opacity: c.opacity, transform: c.transform });
        el = el.parentElement;
      }
      return chain;
    })(),
  };

  // ── card heart / checkmark / played icons ───────────────────────────────
  const iconSels = ['.cardOverlayButton', '.cardOverlayButtonIcon', '.cardOverlayFab', '.playedIndicator',
    '.cardIndicators .checkmark', '.cardIndicators .indicator', '.cardIndicators', '.checkmark',
    '.material-icons.favorite', '.material-icons.check', '.emby-button.autoSize .material-icons'];
  out.icons = {};
  iconSels.forEach(sel => { const el = document.querySelector(sel); if (el) out.icons[sel] = pick(el); });

  // ── tags / genres ───────────────────────────────────────────────────────
  const tagSels = ['.itemTags', '.itemTags a', '.tagList', '.tag', '.itemGenres a', '.genreItems a', '.emby-tag', '.chip', '.badge'];
  out.tags = {};
  tagSels.forEach(sel => { const el = document.querySelector(sel); if (el) out.tags[sel] = pick(el); });

  // ── card radii (hover dark-tint mismatch) ───────────────────────────────
  const cardSels = ['.card', '.cardBox', '.cardScalable', '.cardImageContainer', '.cardImage',
    '.cardOverlayContainer', '.cardOverlayInner', '.listItemImage'];
  out.cards = {};
  cardSels.forEach(sel => { const el = document.querySelector(sel); if (el) out.cards[sel] = pick(el); });

  console.log('%c=== MN DEBUG DUMP (copy everything below) ===', 'font-weight:bold;color:#47c4b8');
  console.log(JSON.stringify(out, null, 2));
  return out;
})();
