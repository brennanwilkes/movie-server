'use strict';
// ui-shot.js — screenshot a controller tab at a given viewport, for visual review.
//
//   node scripts/ui-shot.js library 390 out.png
//   node scripts/ui-shot.js audit 390 out.png bitrate
//
// WHY THIS EXISTS: `chrome --headless --screenshot` cannot run JS, and the dashboard picks its
// tab from localStorage rather than the URL, so a plain screenshot always lands on Home. This
// drives Chrome over the DevTools Protocol instead, which can seed localStorage, click the
// section chip, wait for the fetch to settle, and capture the full scrollable page.
//
// Minimal hand-rolled WebSocket client (text frames only, no compression, no fragmentation) so
// there is no dependency to install on the NUC. CDP frames are well under 64 KB outbound and the
// only large inbound frame is the base64 screenshot, which is handled by the 64-bit length path.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const [, , tabName = 'library', widthArg = '390', outPath = 'shot.png', section] = process.argv;
const WIDTH = Number(widthArg);
const PORT = 9222;

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
      // Text frames only; server->client frames are never masked.
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
      // Client->server frames MUST be masked (RFC 6455 §5.3).
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

(async () => {
  const tabs = await getJson('/json/list');
  const page = tabs.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target — is chrome running with --remote-debugging-port?');
  const ws = await connect(page.webSocketDebuggerUrl);
  const evalJs = (expression) => ws.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

  await ws.send('Page.enable');
  await ws.send('Runtime.enable');
  await ws.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: true });

  // Seed the tab choice on the right origin, then reload so main.js picks it up.
  await ws.send('Network.enable');
  await ws.send('Network.setCacheDisabled', { cacheDisabled: true });
  await ws.send('Page.navigate', { url: 'http://localhost:8088/' });
  await sleep(2500);
  await evalJs(`localStorage.setItem('tab', ${JSON.stringify(tabName)})`);
  await ws.send('Page.reload', { ignoreCache: true });
  await sleep(Number(process.env.WAIT || 6000));
  if (section) {
    await evalJs(`(()=>{const b=[...document.querySelectorAll('[data-sec]')]
      .find(x=>x.dataset.sec===${JSON.stringify(section)}); if(b){b.click();return 'clicked';} return 'not found';})()`);
    await sleep(5000);
  }
  if (process.env.SEARCH) {
    await evalJs(`(()=>{const i=document.querySelector('#lib-search'); i.value=${JSON.stringify(process.env.SEARCH)};
      i.dispatchEvent(new Event('input',{bubbles:true})); return i.value;})()`);
    await sleep(1500);
  }
  // Capture the whole scrollable page, not just the viewport.
  const m = await evalJs('({h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)})');
  const full = Math.min(((m.result || {}).result || {}).value?.h || 1800, Number(process.env.MAXH || 6000));
  await ws.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: full, deviceScaleFactor: 1, mobile: true });
  await sleep(1200);
  const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
  const data = ((shot.result || {}).data) || '';
  if (!data) throw new Error('empty screenshot');
  fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
  console.log(`${outPath}  ${WIDTH}x${full}  tab=${tabName}${section ? ` section=${section}` : ''}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ui-shot failed:', e.message); process.exit(1); });
