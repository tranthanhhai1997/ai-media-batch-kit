'use strict';
/**
 * Ask Gemini (consumer gemini.google.com account, no API key) for text, through a logged-in Chrome profile.
 *
 *   const { createGeminiText } = require('./gemini-text');
 *   const gem = createGeminiText({ profileDir: 'D:/profiles/google1' });
 *   const answer = await gem.ask({ prompt: 'Write 5 image prompts about autumn in Hanoi, one per line' });
 *
 * How: the StreamGenerate RPC is POSTed with fetch() INSIDE the gemini.google.com/app tab, so Chrome attaches
 * the cookies and keeps rotating __Secure-1PSIDTS by itself (a copied cookie jar dies within hours).
 * Tokens come from window.WIZ_global_data: SNlM0e (= form field "at"), cfb2h (= "bl"), FdrFJe (= "f.sid").
 * The raw stream is parsed in Node: answer text = payload[4][0][1][0]; frames without it are metadata
 * (title, tokens, ids) and must be ignored — taking "the longest string" returns the chat TITLE on short answers.
 */
const path = require('node:path');
const { ensureProfileChrome } = require('../core/chrome');
const { findOrOpenPage, keepAlive, listTargets, openBackgroundTab, sleep } = require('../core/cdp');

const ORIGIN = 'https://gemini.google.com';
const APP_URL = ORIGIN + '/app';
const TAB_RE = /^https:\/\/gemini\.google\.com\//;
const STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const BATCH_PATH = '/_/BardChatUi/data/batchexecute';
const DELETE_RPC = 'GzXR5e'; // batchexecute rpc id that deletes a conversation (observed; may change)
const MODEL_HEADER = 'x-goog-ext-525001261-jspb'; // optional model selector header (value is opaque, copy from DevTools)

class GeminiError extends Error {
  constructor(code, message) { super(message); this.name = 'GeminiError'; this.code = code; }
}

// ---- pure helpers (testable offline) -------------------------------------------------------------------
/** f.req body: [null, JSON(inner)] — inner[0][0] prompt, inner[1] language, inner[2] [cid, rid, rcid] to continue. */
function buildFreq(prompt, { lang = 'en', conversation = null } = {}) {
  const inner = [
    [prompt, 0, null, null, null, null, 0],
    [lang],
    conversation ? [conversation.cid, conversation.rid, conversation.rcid] : ['', '', ''],
    null, null, null, [1], 0, [], [], 1, 0,
  ];
  return JSON.stringify([null, JSON.stringify(inner)]);
}

function frameText(p) {
  let t = Array.isArray(p) && Array.isArray(p[4]) && Array.isArray(p[4][0]) && Array.isArray(p[4][0][1]) ? p[4][0][1][0] : null;
  if (Array.isArray(t)) t = t[0]; // some responses wrap the answer one level deeper: [[text]] (seen + unit-tested upstream)
  return typeof t === 'string' && t.trim() ? t : '';
}

function findBardError(x, depth = 0) {
  if (depth > 12 || !x) return null;
  if (Array.isArray(x)) {
    if (x.length === 2 && typeof x[0] === 'string' && x[0].includes('BardErrorInfo')) {
      const c = Array.isArray(x[1]) ? x[1][0] : x[1];
      if (typeof c === 'number') return c;
    }
    for (const v of x) { const r = findBardError(v, depth + 1); if (r != null) return r; }
  } else if (typeof x === 'object') {
    for (const k of Object.keys(x)) { const r = findBardError(x[k], depth + 1); if (r != null) return r; }
  }
  return null;
}

/**
 * Parse a StreamGenerate body: ")]}'" prefix, then lines of JSON arrays [["wrb.fr", null, "<payload json>"], …].
 * Each text frame carries the CUMULATIVE answer → keep the longest text among frames that HAVE text.
 * @returns {{text:string, conversation:{cid,rid,rcid}|null, errorCode:number|null}}
 */
function parseStreamGenerate(raw) {
  const body = String(raw || '').replace(/^\)\]\}'\n?/, '');
  let text = '';
  let conversation = null;
  let errorCode = null;
  for (const line of body.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('[')) continue;
    let arr;
    try { arr = JSON.parse(l); } catch (_) { continue; }
    if (!Array.isArray(arr)) continue;
    if (errorCode == null && l.includes('BardErrorInfo')) {
      errorCode = findBardError(arr);
      // the error can also sit inside an escaped payload string → plain regex on the line
      if (errorCode == null) { const m = /BardErrorInfo\\?",\s*\[(\d+)\]/.exec(l); if (m) errorCode = Number(m[1]); }
    }
    for (const f of arr) {
      if (!Array.isArray(f) || f[0] !== 'wrb.fr' || typeof f[2] !== 'string') continue;
      let p;
      try { p = JSON.parse(f[2]); } catch (_) { continue; }
      const t = frameText(p); // metadata frames (title {11:…}, token {26:…}, ids {46:…}) have no [4] → skipped
      if (!t || t.length < text.length) continue;
      text = t;
      const cid = p[1] && p[1][0], rid = p[1] && p[1][1], rcid = p[4] && p[4][0] && p[4][0][0];
      if (typeof cid === 'string' && typeof rid === 'string' && typeof rcid === 'string') conversation = { cid, rid, rcid };
    }
  }
  return { text: text.trim(), conversation, errorCode };
}

// ---- page-side ------------------------------------------------------------------------------------------
const JS_TOKENS = `(() => {
  const w = window.WIZ_global_data || {};
  const html = w.SNlM0e ? '' : document.documentElement.innerHTML;
  const pick = (k) => w[k] || ((new RegExp('"' + k + '":"([^"]*)"').exec(html) || [])[1] || '');
  return { at: pick('SNlM0e'), bl: pick('cfb2h'), fsid: pick('FdrFJe'),
           signin: !!document.querySelector("a[href*='accounts.google.com/ServiceLogin'], a[href*='accounts.google.com/v3/signin']") };
})()`;

/** POST form data inside the page; keep the body in window[key] and return only its size (read in chunks). */
function jsPost(url, form, headers, key) {
  return `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, { method: 'POST', credentials: 'include',
        headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(form)} });
      const t = await r.text();
      window[${JSON.stringify(key)}] = t;
      return { status: r.status, size: t.length };
    } catch (e) { return { status: 0, size: 0, err: String(e) }; }
  })()`;
}

async function readPageString(client, key, size, chunk = 500_000) {
  let out = '';
  for (let off = 0; off < size; off += chunk) {
    out += await client.evaluate(`window[${JSON.stringify(key)}].slice(${off}, ${off + chunk})`);
  }
  await client.evaluate(`delete window[${JSON.stringify(key)}]`).catch(() => undefined);
  return out;
}

// ---- tabs & locks (one tab + one lock per profile) ---------------------------------------------------------
const tabs = new Map();
const locks = new Map();

async function withLock(k, fn) {
  const prev = locks.get(k) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  locks.set(k, tail);
  try { await prev; return await fn(); } finally { release(); if (locks.get(k) === tail) locks.delete(k); }
}

/**
 * @param {object} o
 * @param {string} o.profileDir   Chrome profile logged in to a Google account with Gemini access
 * @param {boolean} [o.show=false]
 * @param {string} [o.proxy]
 * @param {string} [o.lang='en']  hl + f.req language (answer language still follows the prompt)
 * @param {string} [o.modelHeader] optional value for x-goog-ext-525001261-jspb (selects a model)
 * @param {(msg:string)=>void} [o.log]
 */
function createGeminiText({ profileDir, show = false, proxy, lang = 'en', modelHeader = '', log = () => {} } = {}) {
  if (!profileDir) throw new GeminiError('GEMINI_CONFIG', 'profileDir is required');
  const key = path.resolve(profileDir);
  const say = (m) => { try { log('[gemini-text] ' + m); } catch (_) {} };

  async function getTab() {
    const c = tabs.get(key);
    if (c && !c.closed) {
      const ok = await Promise.race([c.evaluate('1+1').catch(() => 0), sleep(4000).then(() => 0)]);
      if (ok === 2) { await keepAlive(c); return c; }
      c.close();
      tabs.delete(key);
    }
    const port = await ensureProfileChrome({ profileDir: key, url: APP_URL, show, proxy });
    const list = await listTargets(port).catch(() => []);
    if (!list.some((t) => t.type === 'page' && TAB_RE.test(t.url || ''))) await openBackgroundTab(port, APP_URL);
    let client;
    try { client = await findOrOpenPage(port, TAB_RE, APP_URL); } catch (e) {
      throw new GeminiError('GEMINI_TAB_LOST', 'cannot open/attach a gemini.google.com tab: ' + e.message);
    }
    await keepAlive(client);
    tabs.set(key, client);
    return client;
  }

  /** Read fresh tokens; reload /app once when missing (stale page or rotated cookies). */
  async function tokens(client, { reload = false } = {}) {
    const url = await client.evaluate('location.href').catch(() => '');
    if (reload || !/^https:\/\/gemini\.google\.com\/app/.test(url)) {
      await client.send('Page.navigate', { url: APP_URL }).catch(() => undefined);
      await sleep(1500);
    }
    for (let i = 0; i < 20; i++) {
      const t = await client.evaluate(JS_TOKENS).catch(() => null);
      if (t && t.at) return t;
      if (t && t.signin && i > 4) break;
      await sleep(1000);
    }
    return null;
  }

  async function status() {
    return withLock(key, async () => {
      const t = await tokens(await getTab());
      return t ? { connected: true } : { connected: false, reason: 'NO_SNLM0E' };
    });
  }

  async function post(client, t, prompt, conversation) {
    const qs = new URLSearchParams({ bl: t.bl, 'f.sid': t.fsid, hl: lang, _reqid: String(100000 + Math.floor(Math.random() * 900000)), rt: 'c' });
    const form = new URLSearchParams({ 'f.req': buildFreq(prompt, { lang, conversation }), at: t.at }).toString();
    const headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' };
    if (modelHeader) headers[MODEL_HEADER] = modelHeader;
    const k = '__mbkGem' + Math.random().toString(36).slice(2);
    const r = await client.evaluate(jsPost(STREAM_PATH + '?' + qs, form, headers, k), { timeoutMs: 330_000 });
    const raw = r && r.size ? await readPageString(client, k, r.size) : '';
    return { status: r ? r.status : 0, raw, err: r && r.err };
  }

  async function run({ prompt, keepConversation = false, conversation = null }) {
    if (!prompt || !String(prompt).trim()) throw new GeminiError('GEMINI_CONFIG', 'prompt is empty');
    const client = await getTab();
    let t = await tokens(client);
    if (!t) throw new GeminiError('GEMINI_AUTH', 'not signed in to gemini.google.com (no SNlM0e) — log in once with show:true');

    let r = await post(client, t, String(prompt), conversation);
    // 400/401 usually = stale "at"/"bl" after a long idle → reload the app page once and retry.
    if (r.status === 400 || r.status === 401) {
      say(`StreamGenerate ${r.status} → reload tokens and retry`);
      t = await tokens(client, { reload: true });
      if (!t) throw new GeminiError('GEMINI_AUTH', 'session expired (no SNlM0e after reload)');
      r = await post(client, t, String(prompt), conversation);
    }
    if (r.status === 401 || r.status === 403) throw new GeminiError('GEMINI_AUTH', 'StreamGenerate ' + r.status);
    if (r.status === 429) throw new GeminiError('GEMINI_RATE_LIMIT', 'Gemini quota (429)');
    if (r.status !== 200) throw new GeminiError('GEMINI_NETWORK', `StreamGenerate HTTP ${r.status} ${r.err || r.raw.slice(0, 200)}`);
    if (r.raw.trimStart().startsWith('<')) throw new GeminiError('GEMINI_AUTH', 'Gemini returned HTML (session expired?)');

    const parsed = parseStreamGenerate(r.raw);
    if (!parsed.text) {
      if (parsed.errorCode === 1155) throw new GeminiError('GEMINI_OVERLOAD', 'Gemini error 1155 (overloaded / timeout) — retry later');
      if (parsed.errorCode != null) throw new GeminiError('GEMINI_ERROR', 'Gemini error code ' + parsed.errorCode);
      throw new GeminiError('GEMINI_EMPTY', `no answer text in stream (${r.raw.length} B)`);
    }
    if (!keepConversation && parsed.conversation) await deleteConversation(client, t, parsed.conversation.cid);
    return parsed;
  }

  async function deleteConversation(client, t, cid) {
    const qs = new URLSearchParams({ rpcids: DELETE_RPC, 'source-path': '/app', bl: t.bl, 'f.sid': t.fsid, hl: lang, _reqid: String(100000 + Math.floor(Math.random() * 900000)), rt: 'c' });
    const form = new URLSearchParams({ 'f.req': JSON.stringify([[[DELETE_RPC, JSON.stringify([cid]), null, 'generic']]]), at: t.at }).toString();
    const k = '__mbkGemDel' + Math.random().toString(36).slice(2);
    const r = await client.evaluate(jsPost(BATCH_PATH + '?' + qs, form, { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' }, k)).catch(() => null);
    await client.evaluate(`delete window[${JSON.stringify(k)}]`).catch(() => undefined);
    if (!r || r.status !== 200) say(`delete conversation → ${r && r.status}`);
  }

  return {
    status,
    /** @returns {Promise<string>} */
    ask: async (o) => (await withLock(key, () => run(o || {}))).text,
    /** @returns {Promise<{text:string, conversation:{cid,rid,rcid}|null}>} pass `conversation` back to continue */
    askDetailed: (o) => withLock(key, () => run(Object.assign({ keepConversation: true }, o || {}))),
    close: () => { const c = tabs.get(key); if (c) { c.close(); tabs.delete(key); } },
  };
}

module.exports = { createGeminiText, parseStreamGenerate, buildFreq, GeminiError };
