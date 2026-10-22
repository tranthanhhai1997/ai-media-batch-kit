'use strict';
/**
 * Local HTTP proxy relay for Chrome: Chrome cannot send proxy passwords and has no SOCKS5 auth, so
 * launch Chrome with --proxy-server=http://127.0.0.1:<relay.port> and let this relay talk to the
 * upstream HTTP (CONNECT + Basic) or SOCKS5 (user/pass, remote DNS) proxy. Pure Node, no deps.
 *
 *   const relay = await startRelay(() => parseProxy('socks5://user:pass@1.2.3.4:1080'));
 *   ensureProfileChrome({ profileDir, proxy: 'http://127.0.0.1:' + relay.port });
 *   console.log(await testProxy(parseProxy('user:pass@1.2.3.4:8080'))); // {ip, country, ...}
 *
 * If the relay is not ready, point Chrome to http://127.0.0.1:9 (blackhole) — never leak the real IP.
 */
const net = require('net');
const tls = require('tls');

const TIMEOUT_MS = 20000;

// max: phần đầu (header HTTP / gói SOCKS) không bao giờ quá vài KB. Không chặn → "proxy" trả luồng dữ liệu không có
// \r\n\r\n (sai kiểu proxy, cổng không phải proxy…) làm buffer phình tới hết RAM → main crash "Array buffer allocation
// failed" (đã gặp thật).
function readUntil(sock, test, ms, max = 65536) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => done(new Error('proxy không trả lời (quá ' + Math.round(ms / 1000) + 's)')), ms);
    function onData(d) {
      buf = Buffer.concat([buf, d]);
      const n = test(buf);
      if (n > 0) {
        const rest = buf.subarray(n);
        if (rest.length) sock.unshift(rest);
        done(null, buf.subarray(0, n));
      } else if (buf.length > max) {
        done(new Error('proxy trả dữ liệu không đúng giao thức (sai kiểu HTTP/SOCKS5 hoặc không phải cổng proxy?)'));
        sock.destroy();
      }
    }
    function onEnd() { done(new Error('proxy đóng kết nối')); }
    function onErr(e) { done(e); }
    function done(err, val) {
      clearTimeout(t);
      sock.removeListener('data', onData); sock.removeListener('end', onEnd); sock.removeListener('error', onErr);
      if (err) reject(err); else resolve(val);
    }
    sock.on('data', onData); sock.once('end', onEnd); sock.once('error', onErr);
  });
}

function connectTcp(host, port, ms) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('không kết nối được proxy ' + host + ':' + port + ' (quá thời gian)')); }, ms);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(new Error('không kết nối được proxy ' + host + ':' + port + ': ' + (e.code || e.message))); });
  });
}

// Mở đường hầm TCP tới host:port qua proxy cfg {type:'http'|'socks5', host, port, user, pass}. → net.Socket
async function openTunnel(cfg, host, port, ms = TIMEOUT_MS) {
  const s = await connectTcp(cfg.host, Number(cfg.port), ms);
  try {
    if (cfg.type === 'socks5') await socks5Handshake(s, cfg, host, port, ms);
    else await httpConnect(s, cfg, host, port, ms);
    return s;
  } catch (e) { s.destroy(); throw e; }
}

async function httpConnect(s, cfg, host, port, ms) {
  const target = (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
  let head = 'CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n';
  if (cfg.user) head += 'Proxy-Authorization: Basic ' + Buffer.from(cfg.user + ':' + (cfg.pass || '')).toString('base64') + '\r\n';
  s.write(head + '\r\n');
  const res = (await readUntil(s, (b) => { const i = b.indexOf('\r\n\r\n'); return i < 0 ? 0 : i + 4; }, ms)).toString('latin1');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(res);
  const code = m ? Number(m[1]) : 0;
  if (code === 200) return;
  if (code === 407) throw new Error('proxy từ chối đăng nhập (407) — sai user/mật khẩu');
  throw new Error('proxy HTTP trả ' + (code || res.split('\r\n')[0].slice(0, 60)));
}

async function socks5Handshake(s, cfg, host, port, ms) {
  const auth = !!cfg.user;
  s.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const g = await readUntil(s, (b) => (b.length >= 2 ? 2 : 0), ms);
  if (g[0] !== 5) throw new Error('không phải proxy SOCKS5');
  if (g[1] === 0xff) throw new Error('proxy SOCKS5 không chấp nhận cách đăng nhập (cần user/mật khẩu?)');
  if (g[1] === 2) {
    const u = Buffer.from(String(cfg.user || ''), 'utf8'), p = Buffer.from(String(cfg.pass || ''), 'utf8');
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const a = await readUntil(s, (b) => (b.length >= 2 ? 2 : 0), ms);
    if (a[1] !== 0) throw new Error('proxy SOCKS5 từ chối đăng nhập — sai user/mật khẩu');
  } else if (g[1] !== 0) throw new Error('proxy SOCKS5 chọn cách đăng nhập lạ (' + g[1] + ')');
  let addr;
  if (net.isIPv4(host)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
  else if (net.isIPv6(host)) {
    const full = host.includes('::') ? expandV6(host) : host.split(':');
    addr = Buffer.concat([Buffer.from([4]), Buffer.from(full.flatMap((h) => { const n = parseInt(h || '0', 16); return [n >> 8, n & 255]; }))]);
  } else { const h = Buffer.from(host, 'utf8'); addr = Buffer.concat([Buffer.from([3, h.length]), h]); }
  s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  const r = await readUntil(s, (b) => {
    if (b.length < 5) return 0;
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : -1;
    if (len < 0) return b.length; // atyp lạ → trả hết để báo lỗi
    return b.length >= 4 + len + 2 ? 4 + len + 2 : 0;
  }, ms);
  if (r[1] !== 0) {
    const why = { 1: 'lỗi chung', 2: 'không được phép', 3: 'mạng không tới được', 4: 'máy đích không tới được', 5: 'bị từ chối', 6: 'hết hạn TTL', 7: 'lệnh không hỗ trợ', 8: 'kiểu địa chỉ không hỗ trợ' }[r[1]];
    throw new Error('proxy SOCKS5 không mở được kết nối: ' + (why || 'mã ' + r[1]));
  }
}

function expandV6(h) {
  const [a, b] = h.split('::');
  const A = a ? a.split(':') : [], B = b ? b.split(':') : [];
  return [...A, ...Array(8 - A.length - B.length).fill('0'), ...B];
}

// Relay HTTP ở 127.0.0.1 cho Chrome (không cần đăng nhập). → Promise<{port, close()}>
function startRelay(getCfg, opts = {}) {
  const sockets = new Set();
  const server = net.createServer((c) => {
    sockets.add(c); c.once('close', () => sockets.delete(c));
    c.on('error', () => {});
    readUntil(c, (b) => { const i = b.indexOf('\r\n\r\n'); return i < 0 ? (b.length > 65536 ? b.length : 0) : i + 4; }, 30000)
      .then(async (headBuf) => {
        const head = headBuf.toString('latin1');
        const [line, ...hdrs] = head.split('\r\n');
        const [method, uri] = line.split(' ');
        const cfg = getCfg();
        if (!cfg) { c.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return; }
        if (method === 'CONNECT') {
          const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(uri || '');
          if (!m) { c.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
          let up;
          try { up = await openTunnel(cfg, m[1], Number(m[2])); } catch (e) {
            if (opts.onError) opts.onError(e);
            c.end('HTTP/1.1 502 Bad Gateway\r\nX-Proxy-Error: ' + encodeURIComponent(e.message).slice(0, 200) + '\r\nConnection: close\r\n\r\n'); return;
          }
          sockets.add(up); up.once('close', () => sockets.delete(up)); up.on('error', () => c.destroy());
          c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          up.pipe(c); c.pipe(up);
          return;
        }
        // HTTP thường (dạng URL tuyệt đối) → mở đường hầm tới máy đích, gửi lại dạng đường dẫn, đóng sau 1 lượt
        let u;
        try { u = new URL(uri); } catch (_) { c.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        let up;
        try { up = await openTunnel(cfg, u.hostname, Number(u.port || 80)); } catch (e) {
          if (opts.onError) opts.onError(e);
          c.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return;
        }
        sockets.add(up); up.once('close', () => sockets.delete(up)); up.on('error', () => c.destroy());
        const keep = hdrs.filter((h) => h && !/^(proxy-|connection:|keep-alive:)/i.test(h));
        up.write(method + ' ' + (u.pathname + u.search) + ' HTTP/1.1\r\n' + keep.join('\r\n') + '\r\nConnection: close\r\n\r\n');
        up.pipe(c); c.pipe(up);
      })
      .catch(() => c.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

// Kiểm tra proxy: IP ra ngoài + quốc gia (HTTPS qua đường hầm). → {ip, country, city, org, ms}
async function testProxy(cfg, ms = TIMEOUT_MS) {
  const t0 = Date.now();
  const tries = [['ipinfo.io', '/json'], ['api.ipify.org', '/?format=json']];
  let last;
  for (const [host, p] of tries) {
    let s;
    try {
      s = await openTunnel(cfg, host, 443, ms);
      const t = tls.connect({ socket: s, servername: host });
      await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); setTimeout(() => rej(new Error('TLS quá thời gian')), ms); });
      t.write('GET ' + p + ' HTTP/1.1\r\nHost: ' + host + '\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n');
      const body = await new Promise((res, rej) => {
        const ch = []; t.on('data', (d) => ch.push(d)); t.once('end', () => res(Buffer.concat(ch).toString('utf8'))); t.once('error', rej);
        setTimeout(() => rej(new Error('đọc kết quả quá thời gian')), ms);
      });
      const json = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
      t.destroy();
      return { ip: json.ip, country: json.country || '', city: json.city || '', org: json.org || '', ms: Date.now() - t0 };
    } catch (e) { last = e; if (s) s.destroy(); }
  }
  throw last || new Error('không kiểm tra được');
}

// "ip:port", "ip:port:user:pass", "user:pass@ip:port", "socks5://user:pass@ip:port", "http://ip:port" → cfg
function parseProxy(text, defType = 'http') {
  let s = String(text || '').trim();
  if (!s) return null;
  let type = defType;
  const sm = /^(https?|socks5h?|socks):\/\//i.exec(s);
  if (sm) { type = /^socks/i.test(sm[1]) ? 'socks5' : 'http'; s = s.slice(sm[0].length); }
  s = s.replace(/\/+$/, '');
  let user = '', pass = '', host, port;
  if (s.includes('@')) {
    const at = s.lastIndexOf('@');
    const cred = s.slice(0, at), hp = s.slice(at + 1);
    const ci = cred.indexOf(':');
    user = ci < 0 ? cred : cred.slice(0, ci); pass = ci < 0 ? '' : cred.slice(ci + 1);
    const hi = hp.lastIndexOf(':'); host = hp.slice(0, hi); port = hp.slice(hi + 1);
  } else {
    const p = s.split(':');
    if (p.length >= 4) { host = p[0]; port = p[1]; user = p[2]; pass = p.slice(3).join(':'); }
    else { host = p[0]; port = p[1]; }
  }
  host = String(host || '').replace(/^\[|\]$/g, '');
  port = Number(port);
  if (!host || !(port > 0 && port < 65536)) return null;
  try { user = decodeURIComponent(user); pass = decodeURIComponent(pass); } catch (_) {}
  return { type, host, port, user, pass };
}

module.exports = { openTunnel, startRelay, testProxy, parseProxy };
