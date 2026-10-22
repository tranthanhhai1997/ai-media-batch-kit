'use strict';
/**
 * ChatGPT sentinel helpers: the fake "requirements" token and the SHA3-512 proof-of-work.
 *
 * Node >= 22 (OpenSSL 3) has sha3-512 in node:crypto. Electron's main process uses BoringSSL, which does NOT
 * → a small pure-JS Keccak fallback (32-bit lane pairs, fast enough for the PoW loop) is included.
 */
const crypto = require('node:crypto');

// ---- SHA3-512 -------------------------------------------------------------------------------------------
const RC = [
  1, 0, 32898, 0, 32906, 2147483648, 2147516416, 2147483648, 32907, 0, 2147483649, 0, 2147516545, 2147483648,
  32777, 2147483648, 138, 0, 136, 0, 2147516425, 0, 2147483658, 0, 2147516555, 0, 139, 2147483648, 32905,
  2147483648, 32771, 2147483648, 32770, 2147483648, 128, 2147483648, 32778, 0, 2147483658, 2147483648,
  2147516545, 2147483648, 32896, 2147483648, 2147483649, 0, 2147516424, 2147483648,
];
// rotation offsets r[x + 5y]
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

function keccakF(s) {
  const C = new Uint32Array(10);
  const B = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const p = (x + 4) % 5, n = (x + 1) % 5;
      const lo = C[2 * p] ^ ((C[2 * n] << 1) | (C[2 * n + 1] >>> 31));
      const hi = C[2 * p + 1] ^ ((C[2 * n + 1] << 1) | (C[2 * n] >>> 31));
      for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= lo; s[2 * (x + y) + 1] ^= hi; }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        let lo = s[2 * i], hi = s[2 * i + 1];
        let r = ROT[i];
        if (r >= 32) { const t = lo; lo = hi; hi = t; r -= 32; }
        if (r) { const l2 = (lo << r) | (hi >>> (32 - r)); hi = (hi << r) | (lo >>> (32 - r)); lo = l2; }
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        B[2 * j] = lo; B[2 * j + 1] = hi;
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const a = 2 * (x + y), b = 2 * (((x + 1) % 5) + y), c = 2 * (((x + 2) % 5) + y);
        s[a] = B[a] ^ (~B[b] & B[c]);
        s[a + 1] = B[a + 1] ^ (~B[b + 1] & B[c + 1]);
      }
    }
    s[0] ^= RC[2 * round];
    s[1] ^= RC[2 * round + 1];
  }
}

function sha3_512HexJs(str) {
  const rate = 72;
  const msg = Buffer.from(str, 'utf8');
  const padLen = rate - (msg.length % rate);
  const data = Buffer.alloc(msg.length + padLen);
  msg.copy(data);
  data[msg.length] ^= 0x06;
  data[data.length - 1] ^= 0x80;
  const s = new Uint32Array(50);
  for (let off = 0; off < data.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) s[i] ^= data.readUInt32LE(off + 4 * i);
    keccakF(s);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(s[i] >>> 0, 4 * i);
  return out.toString('hex');
}

let nativeSha3 = false;
try { crypto.createHash('sha3-512').update('').digest(); nativeSha3 = true; } catch (_) {}

function sha3_512Hex(str) {
  return nativeSha3 ? crypto.createHash('sha3-512').update(str).digest('hex') : sha3_512HexJs(str);
}

// ---- tokens ---------------------------------------------------------------------------------------------
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// The site's own client formats dates like a browser in a European time zone; copied as observed.
const browserDate = (offsetMs = 0) => new Date(Date.now() - offsetMs).toUTCString().replace('GMT', 'GMT+0100 (Central European Time)');
const pick = (a) => a[crypto.randomInt(a.length)];

/** Body `p` of POST /backend-api/sentinel/chat-requirements: a base64 "browser config" with prefix gAAAAAC. */
function requirementsToken(ua) {
  const cfg = [
    crypto.randomInt(3000, 6000), browserDate(), 4294705152, 0, ua, 'en-US', 'en', 401, 'mediaSession', 'location',
    'scrollX', (Math.random() * 4000 + 1000).toFixed(4), crypto.randomUUID(), '', 12, 1700000000000,
  ];
  return 'gAAAAAC' + b64(JSON.stringify(cfg));
}

/**
 * Proof token: find n so that sha3_512(seed + base64(cfg with cfg[3]=n)) has a hex prefix <= difficulty
 * (plain string compare over difficulty.length chars). Returns null when not found (caller decides).
 */
function solveProof(seed, difficulty, ua, maxIter = 500_000) {
  const cfg = [pick([8, 12, 16, 24]) + pick([3000, 4000, 6000]), browserDate(8 * 3600e3), 4294705152, 0, ua];
  const n = String(difficulty).length;
  for (let i = 0; i < maxIter; i++) {
    cfg[3] = i;
    const b = b64(JSON.stringify(cfg));
    if (sha3_512Hex(seed + b).slice(0, n) <= difficulty) return 'gAAAAAB' + b;
  }
  return null;
}

module.exports = { sha3_512Hex, sha3_512HexJs, requirementsToken, solveProof, nativeSha3: () => nativeSha3 };
