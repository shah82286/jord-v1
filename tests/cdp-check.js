'use strict';
const http   = require('http');
const net    = require('net');
const crypto = require('crypto');

http.get('http://localhost:9222/json', (r) => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => {
    const tabs  = JSON.parse(d);
    const tab   = tabs.find(t => t.url.includes('mapdiag')) || tabs[0];
    if (!tab) { console.log('No tab'); return; }

    const wsUrl = new URL(tab.webSocketDebuggerUrl);
    const key   = crypto.randomBytes(16).toString('base64');

    const expr = `JSON.stringify({
      mapboxDefined: typeof mapboxgl !== 'undefined',
      mapboxVersion: typeof mapboxgl !== 'undefined' ? mapboxgl.version : null,
      supported: typeof mapboxgl !== 'undefined' ? mapboxgl.supported() : null,
      results: document.getElementById('results') ? document.getElementById('results').innerText.trim() : 'no div',
      errors:  document.getElementById('errors')  ? document.getElementById('errors').innerText.trim()  : ''
    })`;

    const msg = JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true } });

    const handshake = [
      'GET ' + wsUrl.pathname + ' HTTP/1.1',
      'Host: ' + wsUrl.host,
      'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13',
      '', ''
    ].join('\r\n');

    const socket = net.createConnection(9222, '127.0.0.1', () => socket.write(handshake));
    let upgraded = false, buf = Buffer.alloc(0);

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const s = buf.toString();
        if (!s.includes('\r\n\r\n')) return;
        upgraded = true;
        buf = buf.slice(s.indexOf('\r\n\r\n') + 4);

        const payload = Buffer.from(msg);
        const mask    = crypto.randomBytes(4);
        const frame   = Buffer.alloc(6 + payload.length);
        frame[0] = 0x81;
        frame[1] = 0x80 | payload.length;
        mask.copy(frame, 2);
        for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
        socket.write(frame);
      } else {
        if (buf.length < 2) return;
        const len = buf[1] & 0x7f;
        if (buf.length < 2 + len) return;
        const body = JSON.parse(buf.slice(2, 2 + len).toString());
        if (body.result && body.result.result) {
          const info = JSON.parse(body.result.result.value);
          console.log('\n=== BROWSER DIAGNOSTIC ===');
          console.log('mapboxgl defined:', info.mapboxDefined);
          console.log('version:         ', info.mapboxVersion);
          console.log('supported():     ', info.supported);
          console.log('\nResults on page:\n' + info.results);
          if (info.errors) console.log('\nErrors on page:\n' + info.errors);
        }
        socket.destroy();
      }
    });

    socket.on('error', e => console.log('socket error:', e.message));
    setTimeout(() => { console.log('timeout'); process.exit(1); }, 6000);
  });
}).on('error', e => console.log('CDP error:', e.message));
