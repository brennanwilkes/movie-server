// Movie Night — poster/headshot HOVER diagnostic.
// Paste this whole file into the DevTools Console on a FILM or PERSON detail page, then
// hover the poster (or a cast headshot). It prints, per hovered element:
//   · which computed properties CHANGED between rest and hover, for the whole card subtree
//   · the pixel delta of each box
//   · every :hover rule in the loaded stylesheets that matches the element (scyfin is vendored
//     inline now, so all rules are readable — no CORS blind spot)
// Copy everything under "=== MN HOVER DUMP ===" back to Claude.
(() => {
  const PROPS = ['position', 'top', 'left', 'right', 'bottom', 'inset-block-start',
    'transform', 'transform-origin', 'transform-style', 'scale', 'translate',
    'margin-top', 'margin-left', 'margin-bottom', 'margin-right',
    'padding-top', 'padding-left', 'width', 'height', 'max-width', 'max-height',
    'border-top-width', 'border-left-width', 'border-bottom-width', 'border-right-width',
    'border-radius', 'box-sizing', 'box-shadow', 'outline-width', 'outline-offset',
    'contain', 'z-index', 'float', 'display', 'overflow', 'filter', 'zoom',
    'align-self', 'flex-shrink', 'grid-area'];

  // The nodes worth watching: the hovered card, everything inside it, and its positioning ancestors.
  const chain = (el) => {
    const out = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) out.push(e);
    return out.slice(0, 6);
  };
  const label = (el) => el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');

  const snap = (nodes) => nodes.map((el) => {
    const c = getComputedStyle(el), r = el.getBoundingClientRect();
    const o = { _el: el, _label: label(el), _rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10) };
    PROPS.forEach((p) => { o[p] = c.getPropertyValue(p); });
    return o;
  });

  const diff = (a, b) => {
    const rows = [];
    for (let i = 0; i < a.length; i++) {
      const changed = {};
      PROPS.forEach((p) => { if (a[i][p] !== b[i][p]) changed[p] = a[i][p] + '  ->  ' + b[i][p]; });
      const dr = b[i]._rect.map((v, k) => Math.round((v - a[i]._rect[k]) * 10) / 10);
      if (Object.keys(changed).length || dr.some((v) => v !== 0)) {
        rows.push({ el: a[i]._label, rectDelta_xywh: dr, rest_rect: a[i]._rect, changed });
      }
    }
    return rows;
  };

  // Every :hover rule in every loaded sheet that matches this element (or an ancestor in the chain).
  const hoverRules = (nodes) => {
    const hits = [];
    const sheets = [...document.styleSheets];
    sheets.forEach((sh) => {
      let rules;
      try { rules = sh.cssRules; } catch (e) { hits.push({ sheet: sh.href || 'inline', error: 'CORS-blocked' }); return; }
      const walk = (list, media) => {
        [...list].forEach((r) => {
          if (r.cssRules) { walk(r.cssRules, r.conditionText || r.media?.mediaText || media); return; }
          if (!r.selectorText || !/:hover/.test(r.selectorText)) return;
          // Split on commas at top level, strip :hover, and test each part against the chain.
          r.selectorText.split(/\s*,\s*/).forEach((sel) => {
            if (!/:hover/.test(sel)) return;
            const bare = sel.replace(/:hover/g, '');
            let matched = null;
            for (const n of nodes) {
              try { if (n.matches(bare)) { matched = label(n); break; } } catch (e) { /* unsupported selector */ }
            }
            if (matched) {
              hits.push({
                sheet: (sh.href || 'inline(CustomCss)').split('/').pop(),
                media: media || null,
                selector: sel,
                matchedOn: matched,
                css: r.style.cssText.slice(0, 400),
              });
            }
          });
        });
      };
      walk(rules, null);
    });
    return hits;
  };

  const out = {
    url: location.href,
    htmlClass: document.documentElement.className,
    bodyClass: document.body.className,
    mnAttrs: [...document.documentElement.attributes].filter((a) => a.name.startsWith('mn-')).map((a) => a.name + '=' + a.value),
    viewport: [innerWidth, innerHeight],
    events: [],
  };

  let armed = true;
  const onEnter = (ev) => {
    const card = ev.target.closest('.card, .detailImageContainer, .listItem');
    if (!card || !armed) return;
    armed = false;
    const nodes = [...chain(card), ...card.querySelectorAll('.cardBox, .cardScalable, .cardPadder, .cardImageContainer, .cardContent, img')].slice(0, 14);
    // Rest snapshot must be taken with the pointer OFF the card, so re-read after forcing a
    // reflow with the pointer already on it is useless — instead snapshot on 'mouseover' (the
    // frame the hover state is applied) and compare against the pre-armed baseline below.
    const after = snap(nodes);
    const before = baseline.get(card) || snap(nodes);
    const rec = {
      hovered: label(card),
      isDetailPoster: !!card.closest('.detailImageContainer'),
      diff: diff(before, after),
      hoverRulesMatching: hoverRules(nodes),
    };
    out.events.push(rec);
    console.log('=== MN HOVER DUMP ===');
    console.log(JSON.stringify(out, null, 2));
    console.log('=== END ===  (hover another element to capture again)');
    setTimeout(() => { armed = true; }, 1200);
  };

  // Pre-compute rest snapshots for every card on the page while nothing is hovered.
  const baseline = new Map();
  const cards = [...document.querySelectorAll('.detailImageContainer, .card')].slice(0, 60);
  cards.forEach((card) => {
    const nodes = [...chain(card), ...card.querySelectorAll('.cardBox, .cardScalable, .cardPadder, .cardImageContainer, .cardContent, img')].slice(0, 14);
    baseline.set(card, snap(nodes));
  });

  document.addEventListener('mouseover', onEnter, true);
  console.log('MN hover probe armed — baselines captured for ' + cards.length + ' cards.');
  console.log('Now hover the detail poster (and then a cast headshot). Move the mouse OFF first.');
  window.__mnHoverOut = out;
})();
