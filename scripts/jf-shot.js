'use strict';
// jf-shot.js — screenshot the Jellyfin WEB client, logged in, for visual review of the branding.
//
//   node scripts/jf-shot.js home 1280 /tmp/home.png
//   node scripts/jf-shot.js 'details?id=<itemId>' 1280 /tmp/detail.png
//   WAIT=12000 node scripts/jf-shot.js home 390 /tmp/home-mobile.png     # mobile layout
//
// WHY THIS EXISTS, separately from ui-shot.js: that one drives the CONTROLLER dashboard on :8088.
// This drives jellyfin-web on :8096, which is a different origin with a different login model —
// the SPA reads its server + token out of the `jellyfin_credentials` localStorage key and will
// bounce to the login wizard without it, so a plain `chrome --screenshot` only ever captures the
// "select server" screen.
//
// Written during the 2026-09-11 Jellyfin 10.11 -> 12.0.0 recovery: the custom CSS is 3,384 lines
// (1,200 of them vendored scyfin) and asking a human to eyeball every iteration is both slow and
// unfair, so the loop needs to be able to look at its own work.
//
// Chrome must already be listening:
//   google-chrome --headless=new --remote-debugging-port=9222 --no-first-run \
//     --user-data-dir=/tmp/jf-shot-profile about:blank &
//
// Credentials come from the environment so no token is ever written into the repo:
//   JF_URL (default http://127.0.0.1:8096), JF_TOKEN, JF_USER_ID, JF_SERVER_ID
//
// The WebSocket client below is the same minimal text-frame implementation as ui-shot.js — no
// dependency to install on the NUC.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const [, , route = 'home', widthArg = '1280', outPath = 'jf-shot.png'] = process.argv;
const WIDTH = Number(widthArg);
const PORT = Number(process.env.CDP_PORT || 9222);

const JF_URL = process.env.JF_URL || 'http://127.0.0.1:8096';
const JF_TOKEN = process.env.JF_TOKEN || '';
const JF_USER_ID = process.env.JF_USER_ID || '';
const JF_SERVER_ID = process.env.JF_SERVER_ID || '';

if (!JF_TOKEN || !JF_USER_ID) {
  console.error('jf-shot: set JF_TOKEN and JF_USER_ID (see header). Refusing to run unauthenticated.');
  process.exit(2);
}

const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

function connect(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n`
        + `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    let handshake = Buffer.alloc(0);
    let open = false;
    let buf = Buffer.alloc(0);
    const waiters = new Map();
    let nextId = 1;

    const onFrame = (payload) => {
      let msg; try { msg = JSON.parse(payload); } catch { return; }
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    };
    const drain = () => {
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f;
        let off = 2; let len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        onFrame(buf.slice(off, off + len).toString('utf8'));
        buf = buf.slice(off + len);
      }
    };
    sock.on('data', (d) => {
      if (!open) {
        handshake = Buffer.concat([handshake, d]);
        const i = handshake.indexOf('\r\n\r\n');
        if (i < 0) return;
        open = true;
        buf = handshake.slice(i + 4);
        resolve({ send, close: () => sock.destroy() });
        drain();
        return;
      }
      buf = Buffer.concat([buf, d]); drain();
    });
    sock.on('error', reject);

    function send(method, params = {}) {
      const id = nextId++;
      const body = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
      const mask = crypto.randomBytes(4);
      const n = body.length;
      const head = n < 126 ? Buffer.from([0x81, 0x80 | n])
        : n < 65536 ? Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()])
          : Buffer.concat([Buffer.from([0x81, 0xff]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
      const masked = Buffer.alloc(n);
      for (let i = 0; i < n; i++) masked[i] = body[i] ^ mask[i % 4];
      sock.write(Buffer.concat([head, mask, masked]));
      return new Promise((r) => waiters.set(id, r));
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (r) => ((r.result || {}).result || {}).value;

(async () => {
  const tabs = await getJson('/json/list');
  const page = tabs.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target — is chrome running with --remote-debugging-port?');
  const ws = await connect(page.webSocketDebuggerUrl);
  const evalJs = (expression) => ws.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

  await ws.send('Page.enable');
  await ws.send('Runtime.enable');
  await ws.send('Network.enable');

  // Collect page errors. The flair script is ~172 KB of DOM work written against a specific
  // jellyfin-web version; if it throws early, everything after the throw silently never runs and
  // the page looks "unstyled" rather than "broken", which is extremely easy to misread as a CSS
  // problem. Installed before navigation so first-paint errors are caught too.
  // MN_THEME pins the branding theme. The flair script picks one of canyon / matinee / reelone /
  // marquee AT RANDOM per session (sessionStorage.mnTheme), and each one brings its own CSS block
  // keyed on an `mn-*` attribute — so an unpinned rig tests a theme roulette, and a bug that only
  // exists in one theme is unreproducible by construction. Seeded on new document so it is set
  // before the flair script reads it.
  //   MN_THEME=matinee node scripts/jf-shot.js mypreferencesmenu …
  const themeSeed = process.env.MN_THEME
    ? `try{sessionStorage.setItem('mnTheme',${JSON.stringify(process.env.MN_THEME)})}catch(_){}`
    : '';
  await ws.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__mnErrors=[];
      ${themeSeed}
      addEventListener('error',e=>{try{__mnErrors.push((e.message||'')+' @ '+(e.filename||'').split('/').pop()+':'+e.lineno)}catch(_){}}) ;
      addEventListener('unhandledrejection',e=>{try{__mnErrors.push('unhandled: '+((e.reason&&(e.reason.message||e.reason))||''))}catch(_){}});`,
  });
  await ws.send('Network.setCacheDisabled', { cacheDisabled: true });

  // ── MOBILE EMULATION ─────────────────────────────────────────────────────────────────────────
  // CORRECTED 2026-09-13. This used to be `setDeviceMetricsOverride({mobile: WIDTH < 800})` alone,
  // with a comment claiming that is what makes jellyfin-web add `layout-mobile`. IT IS NOT, and
  // every "mobile" shot this rig has ever taken was really the DESKTOP layout at a narrow width —
  // verified by probing `document.documentElement.className` at 390px and getting back
  // "layout-desktop mn-has-sidebar". That is why mobile regressions kept surviving review.
  //
  // jellyfin-web's layoutManager picks its layout from the USER AGENT and TOUCH SUPPORT, not the
  // viewport (see memory: mobile-web-polish). `setDeviceMetricsOverride.mobile` only changes how
  // the viewport meta tag is honoured; it sets neither. So all three have to be overridden
  // together, and the UA has to be a real phone UA because the detection matches on
  // Android/iPhone/iPad tokens.
  // JF_MOBILE=1 forces it on at any width, which is the only way to test a TABLET: an iPad is
  // 820-1194 CSS px wide and still gets `layout-mobile`, so the width heuristic alone would shoot
  // it in desktop mode and miss exactly the layout that is hardest to get right.
  //   JF_MOBILE=1 JF_UA='…iPad…' node scripts/jf-shot.js home 1024 ipad.png
  const MOBILE = process.env.JF_MOBILE === '1' || (process.env.JF_MOBILE !== '0' && WIDTH < 800);
  if (MOBILE) {
    await ws.send('Emulation.setUserAgentOverride', {
      userAgent: process.env.JF_UA
        || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
          + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      platform: process.env.JF_UA && /iPad/.test(process.env.JF_UA) ? 'iPad' : 'iPhone',
    });
    await ws.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await ws.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: MOBILE });

  // Land on the origin first: localStorage is per-origin, so it cannot be seeded before this.
  await ws.send('Page.navigate', { url: `${JF_URL}/web/` });
  await sleep(2500);

  const creds = {
    Servers: [{
      ManualAddress: JF_URL,
      manualAddressOnly: true,
      Name: 'haleiwa',
      Id: JF_SERVER_ID,
      LocalAddress: JF_URL,
      AccessToken: JF_TOKEN,
      UserId: JF_USER_ID,
      DateLastAccessed: Date.now(),
      LastConnectionMode: 2,
    }],
  };
  await evalJs(`localStorage.setItem('jellyfin_credentials', ${JSON.stringify(JSON.stringify(creds))})`);
  await evalJs(`localStorage.setItem('enableAutoLogin', 'true')`);

  await ws.send('Page.navigate', { url: `${JF_URL}/web/#/${route}` });
  await sleep(Number(process.env.WAIT || 9000));

  // FALL BACK TO THE REAL LOGIN FORM. Seeding `jellyfin_credentials` is enough on 10.11 but
  // jellyfin-web 12 re-validates the cached session and bounces to #/login when it doesn't like
  // it, so the reliable path is to do what a person does: type the password in. Needs
  // JF_PASSWORD; the username comes from the account the token belongs to.
  let hash = val(await evalJs('location.hash')) || '';
  if (hash.includes('login') && process.env.JF_USERNAME && process.env.JF_PASSWORD) {
    const found = await evalJs(`(()=>{
      const u = document.querySelector('input[name=username], #txtManualName, input[type=text]');
      const p = document.querySelector('input[name=password], #txtManualPassword, input[type=password]');
      if (!u || !p) return 'no form: ' + [...document.querySelectorAll('input')].map(i=>i.name||i.id||i.type).join(',');
      const set = (el, v) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        // React tracks the last value it set; assigning .value directly is ignored on submit
        // unless the native setter is used and an input event is dispatched.
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(u, ${JSON.stringify(process.env.JF_USERNAME)});
      set(p, ${JSON.stringify(process.env.JF_PASSWORD)});
      const btn = document.querySelector('button[type=submit], .btnManual, .emby-button[type=submit]');
      if (btn) { btn.click(); return 'submitted'; }
      const form = u.closest('form'); if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'form-submit'; }
      return 'no submit button';
    })()`);
    console.log('  login:', val(found));
    await sleep(7000);
    hash = val(await evalJs('location.hash')) || '';
  }

  // ALWAYS land on the requested route before measuring. The SPA bounces to #/login when the
  // seeded session is rejected and then lands on #/home after signing in, so a shot asked for
  // `movies?...` silently returned the home page — which is why several rounds of "the library
  // toolbar isn't in the DOM" were actually "you are not on a library page". Re-assert the route
  // unconditionally, and give the hash a nudge if the SPA ignores an identical-looking navigate.
  if (!hash.startsWith('#/' + route.split('?')[0])) {
    await evalJs(`location.hash = ${JSON.stringify('#/' + route)}`);
    await sleep(Number(process.env.ROUTE_WAIT || 8000));
  }

  // SPA navigation, for bugs that only appear on the route you CLICKED to rather than the route
  // you loaded. A direct load mounts a page into a fresh document; clicking through from the home
  // page mounts it into a document that already has another page's classes, inline styles and
  // layout on it — and Jellyfin 12 leaves some of that behind. A settings page reported as
  // "everything crunched into one spot" rendered perfectly on five direct loads, so the rig has to
  // be able to reproduce the real path.
  //   CLICK='#mn-sidebar a[href="#/mypreferencesmenu"]' node scripts/jf-shot.js home …
  if (process.env.CLICK) {
    const hit = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(process.env.CLICK)});
      if(!e) return null; e.click(); return {href: e.getAttribute('href')||'', txt:(e.textContent||'').trim().slice(0,24)};})()`);
    const h = val(hit);
    console.log('  click:', h ? `${h.txt} -> ${h.href}` : `NO MATCH for ${process.env.CLICK}`);
    if (h) await sleep(Number(process.env.CLICK_WAIT || 12000));
  }

  // Report what the page thinks it is, so a failed login is obvious in the log rather than
  // showing up as a mysteriously blank screenshot.
  const probe = await evalJs(`(()=>{
    const el=document.querySelector('.skinHeader,.mainDrawer,[class*=Header]');
    return JSON.stringify({
      href: location.hash,
      bodyClass: document.body.className,
      cards: document.querySelectorAll('.card').length,
      sections: document.querySelectorAll('[class*=section],[class*=Section]').length,
      header: !!el,
      err: (window.__lastError||''),
    });
  })()`);
  console.log('  page:', val(probe));

  // Real mouse hover, for the questions that only a hover can answer: do the card's overlay
  // controls appear, and do the flair badges survive underneath them? A :hover state cannot be
  // faked from page JS (no class to add — stock Jellyfin styles the pseudo-class directly), so
  // this dispatches a genuine mouseMoved to the centre of HOVER's first match before probing.
  //   HOVER='.homeSectionsContainer .card' JS_PROBE='…' node scripts/jf-shot.js home …
  if (process.env.HOVER) {
    const box = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(process.env.HOVER)});
      if(!e) return null; const r=e.getBoundingClientRect();
      return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)};})()`);
    const pt = val(box);
    if (!pt) {
      console.log('  hover: NO MATCH for', process.env.HOVER);
    } else {
      // Two moves: the first puts the pointer in the document at all (Chrome starts with none),
      // the second lands on the target so the transition has a from-state to animate out of.
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, buttons: 0 });
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
      await sleep(Number(process.env.HOVER_WAIT || 900)); // stock opacity transitions are ~200ms
      console.log('  hover:', process.env.HOVER, 'at', pt.x + ',' + pt.y);
    }
  }

  // Arbitrary DOM probe, so the CSS work can ask the live page what its structure actually is
  // instead of guessing at class names that may or may not have survived a Jellyfin upgrade.
  //   JS_PROBE='[...document.querySelectorAll(".skinHeader *")].map(e=>e.className)' node scripts/jf-shot.js ...
  if (process.env.JS_PROBE) {
    // Always evaluated as an EXPRESSION. Wrap statements in your own IIFE — sniffing for the
    // word "return" mis-fires the moment the expression is itself an arrow function containing one.
    // Promise.resolve() so an ASYNC probe works too. `JSON.stringify(somePromise)` is "{}", which
    // is a silent and very confusing way to lose a result — and a probe that has to click
    // something and then wait for the UI to settle has no choice but to be async.
    const r = await evalJs(`Promise.resolve((${process.env.JS_PROBE})).then(v => JSON.stringify(v))`);
    console.log('  probe:', val(r));
  }

  const m = await evalJs('({h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)})');
  const full = Math.min((val(m) || {}).h || 1800, Number(process.env.MAXH || 4000));
  await ws.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: full, deviceScaleFactor: 1, mobile: MOBILE });
  await sleep(1200);

  const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
  const data = ((shot.result || {}).data) || '';
  if (!data) throw new Error('empty screenshot');
  fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
  console.log(`  ${outPath}  ${WIDTH}x${full}  route=${route}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('jf-shot failed:', e.message); process.exit(1); });
