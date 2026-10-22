'use strict';
/**
 * Shared plumbing for driving chatgpt.com inside a real, logged-in Chrome profile over CDP.
 *
 * Used by chatgpt-image.js and chatgpt-text.js. Both share ONE tab and ONE lock per profile:
 * two jobs typing into the same composer at the same time would corrupt each other's prompt.
 *
 * Why UI automation instead of calling /backend-api directly from Node:
 *   the conversation endpoint needs sentinel chat-requirements + proof-of-work + (lately) Turnstile
 *   and a conduit token, and the exact recipe changes every few weeks. The page itself already knows
 *   how to produce all of that, so we let it send the request and only read the result.
 */
const path = require('node:path');
const { ensureProfileChrome } = require('../core/chrome');
const { withProfileLock: crossProcessLock } = require('../core/profile-lock');
const { findOrOpenPage, keepAlive, listTargets, openBackgroundTab, sleep } = require('../core/cdp');

const ORIGIN = 'https://chatgpt.com';
const HOME_URL = ORIGIN + '/';
const TAB_RE = /^https:\/\/chatgpt\.com\//;

class ChatGptError extends Error {
  /** @param {string} code  CHATGPT_* (see docs table) */
  constructor(code, message, extra) {
    super(message);
    this.name = 'ChatGptError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// Several candidates per element: ChatGPT renames test ids / attributes regularly.
const SEL = {
  composer: ['#prompt-textarea', "div.ProseMirror[contenteditable='true']", "textarea[data-testid='prompt-textarea']", 'main textarea', "main div[contenteditable='true']"],
  send: ["button[data-testid='send-button']", '#composer-submit-button', "button[aria-label*='Send']"],
  stop: ["[data-testid='stop-button']", "button[aria-label*='Stop']"],
  // data-message-author-role disappeared on some accounts (2026-10) → keep newer fallbacks.
  assistant: ["[data-message-author-role='assistant']", "[data-turn='assistant']", 'div.agent-turn', "[data-chatgpt-search-message-ids]:not([class*='user-message'])"],
  login: ["[data-testid='login-button']", "[data-testid='signup-button']", "a[href*='/auth/login']", "[data-testid='mobile-login-button']"],
};

/** Page JS: first selector that matches a visible element (file inputs are allowed to be hidden). */
function jsFirst(list) {
  return `(() => { for (const s of ${JSON.stringify(list)}) { const el = document.querySelector(s);
    if (!el) continue; const r = el.getBoundingClientRect(); if (r.width > 0 || r.height > 0 || el.type === 'file') return s; }
    return ''; })()`;
}

// ---- rate limit / refusal classification (texts observed in the assistant bubble) -------------------
const RATE_LIMIT_RE = /reached (your|the|our) (image|current usage|limit|message)|generating images too quickly|limit for (creating|generating) images|plan limit|limit for image|image generations? (requests?|limit)|limit resets|usage resets|unable to invoke the image generation|(you've|you have) hit|try again (in|after) /i;
const POLICY_RE = /can't (create|generate|assist|help with)|unable to (create|generate)|content polic(y|ies)|may violate|violates? (our|the) (content|usage)|against (our|the) (usage|content)/i;
const MODEL_NOT_FOUND_RE = /model not found/i;

/**
 * Best-effort "how long until the quota resets" from a limit message.
 * Handles "resets in 3 hours", "try again in 45 minutes", "in 1 day", "after 4:30 PM". Returns hours or null.
 */
function parseResetHours(text, now = new Date()) {
  const s = String(text || '');
  let m = /(\d+(?:[.,]\d+)?)\s*(days?)\b/i.exec(s);
  if (m) return parseFloat(m[1].replace(',', '.')) * 24;
  m = /(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h)\b/i.exec(s);
  let h = m ? parseFloat(m[1].replace(',', '.')) : 0;
  const mm = /(\d+)\s*(minutes?|mins?)\b/i.exec(s);
  if (mm) h += parseInt(mm[1], 10) / 60;
  if (m || mm) return h;
  m = /(?:at|after|until)\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
  if (m) {
    let hh = parseInt(m[1], 10) % 12;
    if (!m[3] && parseInt(m[1], 10) >= 12) hh = parseInt(m[1], 10);
    if (m[3] && /pm/i.test(m[3])) hh += 12;
    const t = new Date(now); t.setHours(hh, parseInt(m[2], 10), 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return (t - now) / 3_600_000;
  }
  if (/tomorrow/i.test(s)) return 24;
  return null;
}

/** null when the text is a normal answer, else {code, resetHours?}. */
function classifyReply(text) {
  const s = String(text || '');
  if (!s) return null;
  if (RATE_LIMIT_RE.test(s)) return { code: 'CHATGPT_RATE_LIMIT', resetHours: parseResetHours(s) };
  if (MODEL_NOT_FOUND_RE.test(s)) return { code: 'CHATGPT_MODEL_NOT_FOUND' };
  if (POLICY_RE.test(s)) return { code: 'CHATGPT_POLICY' };
  return null;
}

// ---- tabs & locks ---------------------------------------------------------------------------------
const tabs = new Map();  // resolved profileDir -> CdpClient
const locks = new Map(); // resolved profileDir -> tail promise

function profileKey(profileDir) {
  if (!profileDir) throw new ChatGptError('CHATGPT_CONFIG', 'profileDir is required');
  return path.resolve(profileDir);
}

/** Serialize work per profile (image + text share it). */
async function withProfileLock(profileDir, fn) {
  const key = profileKey(profileDir);
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  try {
    await prev;
    return await crossProcessLock(profileDir, 'chatgpt', 'chatgpt job', fn); // other processes on the same account
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Attach (or re-attach) to the chatgpt.com tab of a profile; launches the profile's Chrome if needed. */
async function getTab(profileDir, { show = false, proxy } = {}) {
  const key = profileKey(profileDir);
  const cached = tabs.get(key);
  if (cached && !cached.closed) {
    // A tab can die silently (window closed by the user) — ping before reusing.
    const ok = await Promise.race([cached.evaluate('1+1').catch(() => 0), sleep(4000).then(() => 0)]);
    if (ok === 2) { await keepAlive(cached); return cached; } // idempotent; re-asserts visibility after long idle
    cached.close();
    tabs.delete(key);
  }
  const port = await ensureProfileChrome({ profileDir: key, url: HOME_URL, show, proxy });
  let client;
  try {
    // Open our tab in the background first (Target.createTarget) so the user's window keeps focus;
    // findOrOpenPage would use /json/new, which raises the window.
    const list = await listTargets(port).catch(() => []);
    if (!list.some((t) => t.type === 'page' && TAB_RE.test(t.url || ''))) await openBackgroundTab(port, HOME_URL);
    client = await findOrOpenPage(port, TAB_RE, HOME_URL);
  } catch (e) {
    throw new ChatGptError('CHATGPT_TAB_LOST', 'cannot open/attach a chatgpt.com tab: ' + e.message);
  }
  await keepAlive(client); // hidden/off-screen tabs otherwise throttle timers and stall streaming
  tabs.set(key, client);
  return client;
}

function dropTab(profileDir) {
  const key = profileKey(profileDir);
  const c = tabs.get(key);
  if (c) { c.close(); tabs.delete(key); }
}

async function navigate(client, url, timeoutMs = 30_000) {
  await client.send('Page.navigate', { url }).catch(() => undefined);
  await sleep(800);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await client.evaluate('document.readyState').catch(() => '');
    if (st === 'complete' || st === 'interactive') return;
    await sleep(400);
  }
}

async function waitCloudflare(client, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const challenged = await client.evaluate(
      "/Just a moment|Verify you are human|Performing security verification/i.test(document.title + ' ' + (document.body ? document.body.innerText : '').slice(0, 400))",
    ).catch(() => false);
    if (!challenged) return;
    await sleep(3000);
  }
  throw new ChatGptError('CHATGPT_CLOUDFLARE', 'Cloudflare challenge did not clear — open the profile visibly (show:true) once and pass it by hand');
}

/** Open a fresh empty chat and wait for the composer. A new chat per job keeps old images out of the page. */
async function openNewChat(client, url = HOME_URL) {
  await navigate(client, url);
  await waitCloudflare(client);
  for (let i = 0; i < 20; i++) {
    const sel = await client.evaluate(jsFirst(SEL.composer)).catch(() => '');
    if (sel) return sel;
    await sleep(1000);
  }
  throw new ChatGptError('CHATGPT_UI', 'composer not found on chatgpt.com (UI changed? update SEL.composer)');
}

// Session check runs INSIDE the page: the access token never leaves the browser.
// error:'RefreshAccessTokenError' = refresh token rotated by another client sharing this login → the
// endpoint still returns the OLD, expired accessToken, so "has token" alone is not "logged in".
const JS_SESSION = `(async () => {
  try {
    const r = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { http: r.status };
    const d = await r.json().catch(() => null);
    if (!d || !d.user) return { http: r.status, loggedOut: true };
    let exp = 0;
    try {
      const p = String(d.accessToken || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      exp = JSON.parse(atob(p + '='.repeat((4 - p.length % 4) % 4))).exp || 0;
    } catch (_) {}
    return { http: 200, email: d.user.email || null, plan: (d.account && d.account.planType) || null,
             hasToken: !!d.accessToken, error: d.error || null, exp };
  } catch (e) { return { http: 0, err: String(e) }; }
})()`;

/** @returns {Promise<{connected:boolean, email?:string|null, plan?:string|null, reason?:string}>} */
async function readStatus(client) {
  // a tab that is still loading (fresh Chrome launch) answers UNKNOWN — live 22/10/2026 — so retry ~15 s
  for (let i = 0; ; i++) {
    const r = await readStatusOnce(client);
    if (r.reason !== 'UNKNOWN' || i >= 10) return r;
    await sleep(1500);
  }
}

async function readStatusOnce(client) {
  const s = await client.evaluate(JS_SESSION).catch(() => null);
  if (s && s.http === 200 && s.hasToken) {
    const expired = !!s.error || (s.exp && s.exp * 1000 < Date.now() + 60_000);
    if (expired) return { connected: false, email: s.email, reason: 'SESSION_EXPIRED' };
    return { connected: true, email: s.email, plan: s.plan };
  }
  if (s && s.http === 429) return { connected: false, reason: 'HTTP_429' };
  // Session API failed (network/CF) → fall back to the DOM: composer visible and no login button.
  const dom = await client.evaluate(`({ composer: !!document.querySelector(${JSON.stringify(SEL.composer.join(','))}),
    login: !!document.querySelector(${JSON.stringify(SEL.login.join(','))}) })`).catch(() => ({}));
  if (dom.composer && !dom.login && !(s && s.loggedOut)) return { connected: true, email: null, reason: 'DOM_ONLY' };
  return { connected: false, reason: (s && s.loggedOut) ? 'LOGGED_OUT' : 'UNKNOWN' };
}

// ---- typing ---------------------------------------------------------------------------------------
const key = (type, modifiers = 0) => ({ type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });

async function pressEnter(client, shift = false) {
  const mod = shift ? 8 : 0; // CDP modifier bit 8 = Shift
  await client.send('Input.dispatchKeyEvent', key('keyDown', mod));
  await client.send('Input.dispatchKeyEvent', key('keyUp', mod));
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Type into the ProseMirror composer. Input.insertText behaves like real typing (React/ProseMirror state
 * updates); newlines are sent as Shift+Enter because a raw "\n" or Enter would submit early.
 */
async function typePrompt(client, composerSel, text, { multiline = true } = {}) {
  await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)}); if (!el) return false; el.focus(); return true; })()`);
  const lines = multiline ? String(text).split(/\r?\n/) : [norm(text)];
  for (let i = 0; i < lines.length; i++) {
    if (i) await pressEnter(client, true);
    if (lines[i]) await client.send('Input.insertText', { text: lines[i] });
  }
  await sleep(300);
  const needle = norm(lines.find((l) => l.trim()) || '').slice(0, 30);
  const ok = await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)});
    const v = el ? (el.innerText || el.value || '') : ''; return v.replace(/\\s+/g, ' ').includes(${JSON.stringify(needle)}); })()`).catch(() => false);
  if (!ok) throw new ChatGptError('CHATGPT_UI', 'typing into the composer had no effect (UI changed?)');
  return needle;
}

/** Wait until the send button is enabled (attachments finished uploading), then submit. */
async function submit(client, composerSel, needle, { waitEnabledMs = 60_000 } = {}) {
  const until = Date.now() + waitEnabledMs;
  while (Date.now() < until) {
    const st = await client.evaluate(`(() => { for (const s of ${JSON.stringify(SEL.send)}) { const b = document.querySelector(s);
      if (b) return !b.disabled && b.getAttribute('aria-disabled') !== 'true'; } return null; })()`).catch(() => null);
    if (st !== false) break; // true = ready, null = no known button (UI changed) → just try Enter
    await sleep(500);
  }
  await pressEnter(client);
  await sleep(1200);
  // Enter is sometimes swallowed (focus lost) → click the button if our text is still in the box.
  const still = await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)});
    return !!el && (el.innerText || el.value || '').replace(/\\s+/g, ' ').includes(${JSON.stringify(needle)}); })()`).catch(() => false);
  if (still) {
    const btn = await client.evaluate(jsFirst(SEL.send)).catch(() => '');
    if (btn) await client.evaluate(`document.querySelector(${JSON.stringify(btn)}).click()`).catch(() => undefined);
    await sleep(800);
  }
}

module.exports = {
  ORIGIN, HOME_URL, SEL, ChatGptError,
  jsFirst, classifyReply, parseResetHours,
  withProfileLock, getTab, dropTab, navigate, waitCloudflare, openNewChat, readStatus,
  typePrompt, submit, pressEnter, norm,
};
