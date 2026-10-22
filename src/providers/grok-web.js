'use strict';
/**
 * Grok Imagine (grok.com/imagine) — image -> video through the WEB UI, driven over CDP.
 *
 * One Chrome profile directory = one grok.com account, logged in once by hand.
 * No dependencies, Node >= 22. Requires only ../core/*.
 *
 *   const { createGrokWeb } = require('./grok-web');
 *   const grok = createGrokWeb({ profileDir: 'D:/profiles/grok-1', show: true, log: console.log });
 *   const st = await grok.status();                       // { loggedIn, email, challenge }
 *   if (!st.loggedIn) await grok.login();                 // opens the window, waits for manual sign-in
 *   const { buffer, contentType } = await grok.imageToVideo({
 *     image: { path: 'scene01.png' }, prompt: 'slow push-in, hair moving in the wind',
 *     aspect: '9:16', durationSec: 6,
 *   });
 *
 * How it works (see skills/ai-media-batch/references/grok.md):
 *   UI path only (the page signs its own API calls with an anti-bot header; hand-built
 *   fetch() calls get rejected). We fill the composer like a user, then SNIFF the page's
 *   own generate request (/rest/app-chat/conversations/new, NDJSON stream) via the
 *   Network domain to get videoId / videoUrl / moderated flags. Fallback: the new
 *   <video src=".../generated/<uuid>/generated_video.mp4"> on /imagine/post/<uuid>.
 *
 * Selectors were observed on grok.com in 09/2026 — expect them to drift.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findOrOpenPage, keepAlive, pullBytes, setFileInput, sleep } = require('../core/cdp');
const { ensureProfileChrome } = require('../core/chrome');

const IMAGINE_URL = 'https://grok.com/imagine';
const ASSET_BASE = 'https://assets.grok.com/';
const GEN_URL_RE = /\/rest\/app-chat\/conversations\/(new|[0-9a-f-]{8,}\/responses)(\?|$)/;
const DURATIONS = [6, 10, 15];
const RESOLUTIONS = ['480p', '720p', '1080p'];

class GrokError extends Error {
  /**
   * @param {'GROK_AUTH'|'GROK_AGE_GATE'|'GROK_QUOTA'|'GROK_MODERATED'|'GROK_TIMEOUT'|'GROK_UI'|'GROK_BROWSER'|'GROK_DOWNLOAD'} code
   */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'GrokError';
  }
}

// ---------------------------------------------------------------------------
// In-page snippets (strings evaluated inside grok.com)
// ---------------------------------------------------------------------------

/** Center point of the first visible element returned by `expr`, or null. */
const pointOf = (expr) => `(() => {
  const e = (${expr});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

const VISIBLE = `((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`;

const JS = {
  // 22/10/2026 live: the mode switch became role=group (was radiogroup) — match on the aria-label only
  composerReady: `location.pathname === '/imagine'
    && !!document.querySelector("[aria-label='Generation mode']")
    && !!document.querySelector("div.tiptap.ProseMirror[contenteditable='true']")`,
  cloudflare: `/Performing security verification|Just a moment|verify you are not a bot/i.test(document.body.innerText || '')`,
  ageGate: `/confirm your age|verify your age|age verification/i.test(document.body.innerText || '')`,
  signInWall: `[...document.querySelectorAll("[role='dialog'],[data-radix-popper-content-wrapper]")]
    .filter(${VISIBLE}).some((d) => /Sign in|Sign up/i.test(d.innerText || ''))`,
  // Unverified wording: grok.com shows a limit/upsell message when the free daily quota is used up.
  quotaText: `/rate limit|limit reached|reached your (daily )?limit|out of (free )?(credits|generations)|upgrade to (supergrok|premium)|try again (later|tomorrow)/i
    .test(document.body.innerText || '')`,
  cookieBtn: pointOf(`[...document.querySelectorAll('button')].filter(${VISIBLE})
    .find((b) => b.getAttribute('aria-label') === 'Dismiss cookie notice'
      || /^(Reject All|Accept All Cookies)$/i.test((b.innerText || '').trim()))`),
  videoModeOn: `(() => {
    const v = document.querySelector("[aria-label='Generation mode'] [aria-label='Video']");
    if (v && v.hasAttribute('aria-checked')) return v.getAttribute('aria-checked') === 'true';
    return document.querySelectorAll("[aria-label='Video duration']").length > 0;
  })()`,
  videoModeBtn: pointOf(`document.querySelector("[aria-label='Generation mode'] [aria-label='Video']")
    || [...document.querySelectorAll('button')].filter(${VISIBLE}).find((b) => (b.innerText || '').trim() === 'Video')`),
  aspectLabel: `(() => { const b = document.querySelector("button[aria-label='Aspect Ratio']");
    return b ? (b.innerText || '').replace(/\\s+/g, ' ').trim() : ''; })()`,
  menuOpen: `document.querySelectorAll("[role='menu'],[role='listbox'],[data-radix-popper-content-wrapper]").length > 0`,
  attached: `[...document.querySelectorAll("button[aria-label='Remove image']")].some(${VISIBLE})`,
  removeImageBtn: pointOf(`[...document.querySelectorAll("button[aria-label='Remove image']")].filter(${VISIBLE})[0]`),
  promptText: `(() => { const el = document.querySelector('div.tiptap.ProseMirror'); return el ? el.innerText || '' : ''; })()`,
  promptBox: pointOf(`document.querySelector("div.tiptap.ProseMirror[contenteditable='true']")`),
  submitEnabled: `(() => { const b = document.querySelector("button[aria-label='Submit']");
    return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; })()`,
  // Submit point only when the button is really on top (not covered by a toast/overlay).
  submitPoint: `(() => {
    const b = [...document.querySelectorAll("button[aria-label='Submit']")].filter(${VISIBLE})[0];
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
    const r = b.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return null;
    const hit = document.elementFromPoint(x, y);
    return hit && hit.closest('button') === b ? { x, y } : null;
  })()`,
  // After submit: composer emptied, a busy label, or navigation to /imagine/post/<id>.
  submitAccepted: `(() => {
    const el = document.querySelector('div.tiptap.ProseMirror');
    return (!!el && !(el.innerText || '').trim())
      || /generating|creating|rendering/i.test(document.body.innerText || '')
      || location.pathname.includes('/imagine/post/')
      || /confirm your age|verify your age/i.test(document.body.innerText || '');
  })()`,
  domVideos: `(() => {
    const out = [];
    for (const v of document.querySelectorAll('video, video source')) {
      const src = (v.currentSrc || v.src || '').split('?')[0];
      const m = src.match(/generated\\/([0-9a-f-]{36})\\/generated_video\\.mp4/);
      if (m) out.push({ id: m[1], url: src });
    }
    return out;
  })()`,
  postIdFromPath: `((location.pathname.match(/\\/imagine\\/post\\/([0-9a-f-]{36})/) || [])[1] || '')`,
  scrollTop: `(() => { window.scrollTo(0, 0);
    for (const e of document.querySelectorAll('*')) if (e.scrollTop > 0 && !e.closest('.ProseMirror')) e.scrollTop = 0;
    return true; })()`,
};

/** grok.com /api/auth/session: an anonymous visitor ALSO gets status "authenticated" — require a real identity. */
const JS_SESSION = `(async () => {
  try {
    const r = await fetch('/api/auth/session', { credentials: 'include', headers: { accept: 'application/json' } });
    const ct = r.headers.get('content-type') || '';
    if (r.status === 403 || ct.includes('text/html')) return { loggedIn: false, challenge: true };
    if (!r.ok) return { loggedIn: false, challenge: false, status: r.status };
    const j = await r.json();
    const s = (j && j.session) || {};
    const identified = !!(s.userId || s.email || s.xUserId);
    return { loggedIn: identified, email: s.email || null, challenge: false, anonymous: !identified };
  } catch (e) { return { loggedIn: false, challenge: true, error: String(e) }; }
})()`;

/** Parse the NDJSON generate stream (we only need a few fields, regex is enough and tolerant to schema drift). */
function parseVideoStream(text) {
  if (!text) return null;
  const ids = [...text.matchAll(/"(?:videoPostId|videoId)":"([0-9a-f-]{8,})"/g)].map((m) => m[1]);
  const urls = [...text.matchAll(/"videoUrl":"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  const progress = [...text.matchAll(/"progress":(\d+)/g)].map((m) => +m[1]);
  const ageGate = /_AGE_VERIFICATION_REQUIRED/.test(text);
  const quota = /RESOURCE_EXHAUSTED|rate.?limit|too many requests|limit reached/i.test(text);
  if (!ids.length && !ageGate && !quota) return null;
  return {
    videoId: ids.length ? ids[ids.length - 1] : '',
    videoUrl: urls.length ? absoluteAssetUrl(urls[urls.length - 1]) : '',
    moderated: /"moderated":true/.test(text),
    kind: (text.match(/"(imageToVideo|textToVideo)"/) || [])[1] || '',
    maxProgress: progress.length ? Math.max(...progress) : 0,
    ageGate,
    quota,
  };
}

function absoluteAssetUrl(u) {
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : ASSET_BASE + u.replace(/^\/+/, '');
}

function normalizeAspect(a) {
  if (['9:16', '16:9', '2:3', '3:2', '1:1'].includes(a)) return a;
  if (a === '3:4' || a === '4:5') return '2:3';
  if (a === '4:3' || a === '5:4') return '3:2';
  return '16:9';
}

function snapDuration(sec) {
  const s = Number(sec) || 6;
  return DURATIONS.find((d) => s <= d + 0.5) ?? DURATIONS[DURATIONS.length - 1];
}

// ---------------------------------------------------------------------------
// Low-level input helpers
// ---------------------------------------------------------------------------

async function realClick(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40 + Math.random() * 60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function pressKey(c, key, code, vk, extra = {}) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...extra });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}

const evalSafe = (c, expr, fallback = null) => c.evaluate(expr).catch(() => fallback);

async function waitFor(c, expr, timeoutMs, everyMs = 800) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evalSafe(c, expr, false)) return true;
    await sleep(everyMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.profileDir   Chrome user-data-dir of ONE grok.com account (not shared with other jobs)
 * @param {boolean} [o.show=true] false -> window off-screen (never headless: Cloudflare blocks it)
 * @param {string} [o.proxy]
 * @param {string} [o.resolution='720p']  480p | 720p | 1080p (applied if the menu exists)
 * @param {(msg:string)=>void} [o.log]
 */
function createGrokWeb(o) {
  if (!o || !o.profileDir) throw new Error('createGrokWeb: profileDir required');
  const log = typeof o.log === 'function' ? (m) => o.log('[grok] ' + m) : () => {};
  const show = o.show !== false;
  let client = null;
  let chain = Promise.resolve(); // serialize jobs on this profile (one composer per tab)

  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  async function tab() {
    if (client && !client.closed) {
      const alive = await Promise.race([evalSafe(client, '1+1', 0), sleep(4000).then(() => 0)]);
      if (alive === 2) return client;
      try { client.close(); } catch (_) {}
      client = null;
    }
    let port;
    try {
      port = await ensureProfileChrome({ profileDir: o.profileDir, url: IMAGINE_URL, show, proxy: o.proxy });
    } catch (e) {
      throw new GrokError('GROK_BROWSER', 'Chrome/CDP not available: ' + e.message);
    }
    try {
      client = await findOrOpenPage(port, /grok\.com/i, IMAGINE_URL);
    } catch (e) {
      throw new GrokError('GROK_BROWSER', 'cannot attach to a grok.com tab: ' + e.message);
    }
    await keepAlive(client);
    await client.send('Network.enable', { maxResourceBufferSize: 64 << 20, maxTotalBufferSize: 256 << 20 }).catch(() => undefined);
    // We feed files with DOM.setFileInputFiles; never let a native picker block the page.
    await client.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    return client;
  }

  async function gotoImagine(c, { force = false } = {}) {
    const href = await evalSafe(c, 'location.href', '');
    if (force || !/grok\.com\/imagine\/?(\?|$)/.test(href || '')) {
      await c.send('Page.navigate', { url: IMAGINE_URL }).catch(() => undefined);
      await sleep(2500);
    }
    // Cloudflare interstitial: a real (non-headless) profile normally passes by itself.
    const until = Date.now() + 90_000;
    while (await evalSafe(c, JS.cloudflare, false)) {
      if (Date.now() > until) throw new GrokError('GROK_BROWSER', 'stuck on the Cloudflare check (open the profile with show:true and pass it once)');
      log('waiting for Cloudflare check...');
      await sleep(3000);
    }
  }

  async function probe(c) {
    // Right after navigation the session endpoint may still answer with the challenge page — retry briefly.
    let st = { loggedIn: false, challenge: true };
    for (let i = 0; i < 12; i++) {
      st = (await evalSafe(c, JS_SESSION, null)) || st;
      if (st.loggedIn || !st.challenge) break;
      await sleep(1500);
    }
    return { loggedIn: !!st.loggedIn, email: st.email || null, challenge: !!st.challenge, anonymous: !!st.anonymous };
  }

  /** Is this profile signed in to grok.com? Cheap; call it BEFORE queueing jobs. */
  function status() {
    return locked(async () => {
      const c = await tab();
      await gotoImagine(c);
      return probe(c);
    });
  }

  /** Bring the window up and wait (default 5 min) until the user signs in by hand. */
  function login({ maxWaitMs = 300_000 } = {}) {
    return locked(async () => {
      const c = await tab();
      await gotoImagine(c);
      await c.send('Page.bringToFront').catch(() => undefined);
      const until = Date.now() + maxWaitMs;
      while (Date.now() < until) {
        const st = await probe(c);
        if (st.loggedIn) return st;
        await sleep(2500);
      }
      return { loggedIn: false, email: null };
    });
  }

  // --- composer steps -------------------------------------------------------

  async function ensureVideoMode(c) {
    for (let i = 0; i < 3; i++) {
      if (await evalSafe(c, JS.videoModeOn, false)) return;
      const p = await evalSafe(c, JS.videoModeBtn);
      if (p) await realClick(c, p.x, p.y);
      await sleep(900);
    }
    if (!(await evalSafe(c, JS.videoModeOn, false))) throw new GrokError('GROK_UI', 'cannot switch Imagine to Video mode (selector drift?)');
  }

  /** Click a visible menu item whose first word equals `label`. */
  async function pickMenuItem(c, label) {
    const p = await evalSafe(c, pointOf(`[...document.querySelectorAll("[role='menu'] [role='menuitemradio'],[role='menuitem'],[role='option']")]
      .filter(${VISIBLE}).find((e) => (e.innerText || '').trim().split(/\\s+/)[0] === ${JSON.stringify(label)})`));
    if (!p) { await pressKey(c, 'Escape', 'Escape', 27); return false; }
    await realClick(c, p.x, p.y);
    await sleep(700);
    return true;
  }

  async function applyAspect(c, aspect) {
    if (((await evalSafe(c, JS.aspectLabel, '')) || '').includes(aspect)) return;
    const btn = await evalSafe(c, pointOf(`document.querySelector("button[aria-label='Aspect Ratio']")`));
    if (!btn) { log('aspect button not found, keeping page default'); return; }
    await realClick(c, btn.x, btn.y);
    if (!(await waitFor(c, JS.menuOpen, 3000, 300))) return;
    if (!(await pickMenuItem(c, aspect))) log('aspect ' + aspect + ' not offered, keeping page default');
  }

  /** Newer composer: button[aria-label='Video duration'|'Video resolution'][aria-haspopup] -> menuitemradio. */
  async function applyComposerMenu(c, ariaLabel, value) {
    const labelJs = `(() => { const b = document.querySelector("button[aria-label='${ariaLabel}'][aria-haspopup]");
      return b ? (b.innerText || '').replace(/\\s+/g, ' ').trim() : null; })()`;
    const cur = await evalSafe(c, labelJs);
    if (cur === null) return false;
    if (cur === value) return true;
    const btn = await evalSafe(c, pointOf(`document.querySelector("button[aria-label='${ariaLabel}'][aria-haspopup]")`));
    if (!btn) return false;
    await realClick(c, btn.x, btn.y);
    if (!(await waitFor(c, `document.querySelectorAll("[role='menu'] [role='menuitemradio']").length > 0`, 4000, 300))) return false;
    await pickMenuItem(c, value);
    return (await evalSafe(c, labelJs)) === value;
  }

  async function applyDuration(c, sec) {
    const want = snapDuration(sec);
    if (await applyComposerMenu(c, 'Video duration', want + 's')) return want;
    // Older composer: inline radio buttons 6s / 10s only.
    const fallback = want === 15 ? 10 : want;
    const p = await evalSafe(c, pointOf(`[...document.querySelectorAll("[aria-label='Video duration'] button, [aria-label='Video duration'] [role='radio']")]
      .find((b) => (b.innerText || '').trim() === ${JSON.stringify(fallback + 's')})`));
    if (p) { await realClick(c, p.x, p.y); await sleep(500); return fallback; }
    log('duration control not found, keeping page default');
    return 0;
  }

  async function attachImage(c, filePath) {
    for (let i = 0; i < 12; i++) { // remove images left from a previous job
      const p = await evalSafe(c, JS.removeImageBtn);
      if (!p) break;
      await realClick(c, p.x, p.y);
      await sleep(500);
    }
    // MUST target the composer input (name=files). An unnamed hidden input belongs to the
    // Uploads tray: the image lands there only and the page silently runs text-to-video.
    await setFileInput(c, `document.querySelector("input[type='file'][name='files']")
      || document.querySelector("input[type='file'][accept*='image']")`, [path.resolve(filePath)])
      .catch((e) => { throw new GrokError('GROK_UI', 'cannot set composer file input: ' + e.message); });
    const name = path.basename(filePath);
    const until = Date.now() + 60_000;
    let trayOpened = false;
    while (Date.now() < until) {
      if (await evalSafe(c, JS.attached, false)) return;
      // Sometimes the upload only reaches the tray: pick it from there ("Select image <file name>").
      const sel = await evalSafe(c, pointOf(`[...document.querySelectorAll('button[aria-label]')].filter(${VISIBLE})
        .find((b) => b.getAttribute('aria-label') === ${JSON.stringify('Select image ' + name)})`));
      if (sel) { await realClick(c, sel.x, sel.y); await sleep(1500); continue; }
      if (!trayOpened) {
        trayOpened = true;
        await evalSafe(c, JS.scrollTop);
        const up = await evalSafe(c, pointOf(`document.querySelector("button[aria-label='Upload']")`));
        if (up) { await realClick(c, up.x, up.y); await sleep(1200); }
        const tray = await evalSafe(c, pointOf(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Uploads')`));
        if (tray) { await realClick(c, tray.x, tray.y); await sleep(1200); }
      } else {
        await sleep(1500);
      }
    }
    throw new GrokError('GROK_UI', 'image was not attached as first frame within 60s (no "Remove image" chip)');
  }

  async function typePrompt(c, prompt) {
    for (let i = 0; i < 3; i++) {
      const p = await evalSafe(c, JS.promptBox);
      if (!p) throw new GrokError('GROK_UI', 'prompt box (div.tiptap.ProseMirror) not found');
      await realClick(c, p.x, p.y);
      await pressKey(c, 'a', 'KeyA', 65, { modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
      await pressKey(c, 'Backspace', 'Backspace', 8);
      await c.send('Input.insertText', { text: prompt });
      await sleep(400);
      const probeText = prompt.slice(0, 14);
      if (((await evalSafe(c, JS.promptText, '')) || '').includes(probeText)) return;
    }
    throw new GrokError('GROK_UI', 'prompt text did not stick in the composer');
  }

  async function clickSubmit(c) {
    await waitFor(c, JS.submitEnabled, 60_000, 1500); // upload must finish before Submit enables
    for (let attempt = 1; attempt <= 4; attempt++) {
      await evalSafe(c, JS.scrollTop);
      const a = await evalSafe(c, JS.submitPoint);
      await sleep(350);
      const b = await evalSafe(c, JS.submitPoint);
      if (a && b && a.x === b.x && a.y === b.y) { // button stopped moving (layout settled)
        await realClick(c, b.x, b.y);
        if (await waitFor(c, JS.submitAccepted, 20_000)) return;
        log('submit #' + attempt + ' not accepted yet');
      } else {
        await sleep(1200);
      }
    }
    const p = await evalSafe(c, JS.promptBox);
    if (p) {
      await realClick(c, p.x, p.y);
      await pressKey(c, 'Enter', 'Enter', 13, { text: '\r' });
      if (await waitFor(c, JS.submitAccepted, 20_000)) return;
    }
    throw new GrokError('GROK_UI', 'grok.com did not accept the generate command (Submit x4 + Enter)');
  }

  /** Collect network facts while the job runs: generate request ids, their HTTP status, x-statsig-id. */
  function startCapture(c) {
    const cap = { reqIds: new Set(), finished: new Set(), httpStatus: new Map(), statsig: '' };
    const offs = [
      c.on('Network.requestWillBeSent', (p) => {
        const h = (p.request && p.request.headers) || {};
        const s = h['x-statsig-id'] || h['X-Statsig-Id'];
        if (s) cap.statsig = String(s);
        if (GEN_URL_RE.test((p.request && p.request.url) || '')) cap.reqIds.add(p.requestId);
      }),
      c.on('Network.responseReceived', (p) => {
        if (cap.reqIds.has(p.requestId)) cap.httpStatus.set(p.requestId, p.response && p.response.status);
      }),
      c.on('Network.loadingFinished', (p) => { if (cap.reqIds.has(p.requestId)) cap.finished.add(p.requestId); }),
    ];
    cap.stop = () => offs.forEach((off) => off());
    return cap;
  }

  async function streamBody(c, requestId) {
    try {
      const r = await c.send('Network.getResponseBody', { requestId }, { timeoutMs: 15_000 });
      return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body || '';
    } catch (_) { return ''; } // not finished yet / evicted from buffer
  }

  async function mp4Ready(c, url) {
    return !!(await evalSafe(c, `(async () => {
      try { const r = await fetch(${JSON.stringify(url)}, { method: 'HEAD', credentials: 'include' });
        if (!r.ok) return false; const n = +(r.headers.get('content-length') || 0); return n === 0 || n > 50000;
      } catch (e) { return false; } })()`, false));
  }

  /** Wait for the finished clip: stream result first, DOM <video> as fallback. */
  async function waitResult(c, cap, knownIds, timeoutMs) {
    const until = Date.now() + timeoutMs;
    let lastLog = 0;
    while (Date.now() < until) {
      for (const id of cap.reqIds) {
        const st = cap.httpStatus.get(id);
        if (st === 429) throw new GrokError('GROK_QUOTA', 'grok.com answered 429 (daily/rate limit) for this account');
        if (st === 401) throw new GrokError('GROK_AUTH', 'grok.com answered 401 — session expired, sign in again');
        if (!cap.finished.has(id)) continue;
        const parsed = parseVideoStream(await streamBody(c, id));
        if (!parsed) continue;
        if (parsed.ageGate) throw new GrokError('GROK_AGE_GATE', 'grok.com requires age verification for this account (do it once by hand)');
        if (parsed.moderated) throw new GrokError('GROK_MODERATED', 'Grok moderated (refused) this generation');
        if (parsed.quota && !parsed.videoId) throw new GrokError('GROK_QUOTA', 'Grok reports a usage limit for this account');
        if (parsed.videoId || parsed.videoUrl) return { ...parsed, source: 'stream' };
      }
      const postId = await evalSafe(c, JS.postIdFromPath, '');
      if (postId) {
        const vids = (await evalSafe(c, JS.domVideos, [])) || [];
        const hit = vids.find((v) => v.id === postId && !knownIds.has(v.id));
        if (hit && (await mp4Ready(c, hit.url))) return { videoId: hit.id, videoUrl: hit.url, moderated: false, source: 'dom' };
      }
      if (await evalSafe(c, JS.ageGate, false)) throw new GrokError('GROK_AGE_GATE', 'grok.com shows an age verification dialog');
      if (await evalSafe(c, JS.quotaText, false)) throw new GrokError('GROK_QUOTA', 'grok.com shows a usage-limit message for this account');
      if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); log('generating... ' + Math.round((until - Date.now()) / 1000) + 's left'); }
      await sleep(1500);
    }
    return null;
  }

  async function resolveMediaUrl(c, result, statsig) {
    if (result.videoUrl) return { url: result.videoUrl, mime: 'video/mp4' };
    if (!result.videoId || !statsig) return { url: '', mime: '' };
    // Same call the page makes; reuses the page's own anti-bot header captured from its traffic.
    const r = await evalSafe(c, `(async () => {
      try {
        const r = await fetch('/rest/media/post/get', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'x-statsig-id': ${JSON.stringify(statsig)}, 'x-xai-request-id': crypto.randomUUID() },
          body: JSON.stringify({ id: ${JSON.stringify(result.videoId)} }) });
        const j = await r.json();
        return { url: (j && j.post && j.post.mediaUrl) || '', mime: (j && j.post && j.post.mimeType) || '' };
      } catch (e) { return { url: '', mime: '' }; } })()`, null);
    return r || { url: '', mime: '' };
  }

  /**
   * Animate one still image. The image becomes the FIRST FRAME (near pixel-identical).
   * @param {object} a
   * @param {{path:string}|{b64:string, mime?:string}} a.image
   * @param {string} [a.prompt]        motion prompt (English works best)
   * @param {string} [a.aspect='9:16'] 9:16 | 16:9 | 2:3 | 3:2 | 1:1 (UI may offer fewer)
   * @param {number} [a.durationSec=6] snapped to 6 / 10 / 15
   * @param {string} [a.resolution]    overrides the factory default
   * @param {number} [a.timeoutMs=360000]
   * @returns {Promise<{buffer:Buffer, contentType:string, videoId:string, url:string, durationSec:number}>}
   */
  function imageToVideo(a) {
    return locked(async () => {
      if (!a || !a.image) throw new GrokError('GROK_UI', 'image required (Grok web is image->video only)');
      const prompt = String(a.prompt || '').replace(/\s+/g, ' ').trim() || 'animate the image with subtle natural motion';
      const aspect = normalizeAspect(a.aspect || '9:16');
      const resolution = RESOLUTIONS.includes(a.resolution || o.resolution) ? (a.resolution || o.resolution) : '720p';
      const timeoutMs = a.timeoutMs || 360_000;

      let tmp = null;
      let filePath = a.image.path;
      if (!filePath) {
        if (!a.image.b64) throw new GrokError('GROK_UI', 'image.path or image.b64 required');
        const ext = /jpe?g/i.test(a.image.mime || '') ? 'jpg' : /webp/i.test(a.image.mime || '') ? 'webp' : 'png';
        tmp = path.join(os.tmpdir(), `grok_kf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
        fs.writeFileSync(tmp, Buffer.from(a.image.b64, 'base64'));
        filePath = tmp;
      }

      const c = await tab();
      let cap = null;
      try {
        await gotoImagine(c, { force: true }); // fresh composer for every job
        if (!(await waitFor(c, JS.composerReady, 30_000, 1000))) {
          if (await evalSafe(c, JS.signInWall, false)) throw new GrokError('GROK_AUTH', 'not signed in to grok.com (Sign in dialog)');
          throw new GrokError('GROK_UI', 'Imagine composer did not render (selector drift or page not loaded)');
        }
        // Fail fast on auth — otherwise the job only fails after the full generation timeout.
        const st = await probe(c);
        if (!st.loggedIn) throw new GrokError('GROK_AUTH', st.anonymous ? 'grok.com session is anonymous — sign in to this profile' : 'not signed in to grok.com');

        const cookie = await evalSafe(c, JS.cookieBtn);
        if (cookie) { await realClick(c, cookie.x, cookie.y); await sleep(800); }
        if (await evalSafe(c, JS.ageGate, false)) throw new GrokError('GROK_AGE_GATE', 'grok.com requires age verification (do it once by hand)');
        if (await evalSafe(c, JS.signInWall, false)) throw new GrokError('GROK_AUTH', 'grok.com shows a Sign in dialog');

        await evalSafe(c, JS.scrollTop);
        await ensureVideoMode(c);
        await applyAspect(c, aspect);
        if (!(await applyComposerMenu(c, 'Video resolution', resolution))) log('resolution menu not found, keeping default');
        const usedDuration = await applyDuration(c, a.durationSec || 6);
        await attachImage(c, filePath);
        await typePrompt(c, prompt);

        const knownIds = new Set(((await evalSafe(c, JS.domVideos, [])) || []).map((v) => v.id));
        cap = startCapture(c);
        await clickSubmit(c);
        await sleep(1500);
        if (await evalSafe(c, JS.ageGate, false)) throw new GrokError('GROK_AGE_GATE', 'grok.com asked for age verification after submit');
        log('submitted, waiting for the clip');

        const result = await waitResult(c, cap, knownIds, timeoutMs);
        if (!result) throw new GrokError('GROK_TIMEOUT', `no finished clip within ${Math.round(timeoutMs / 1000)}s (check grok.com/imagine history)`);
        if (result.kind === 'textToVideo') log('WARNING: page ran textToVideo — the image was not used as first frame');

        const media = await resolveMediaUrl(c, result, cap.statsig);
        if (!media.url) throw new GrokError('GROK_DOWNLOAD', `clip ${result.videoId.slice(0, 8)} done but no download URL`);
        let lastErr = null;
        for (let i = 0; i < 4; i++) { // CDN may 403/404 for a few seconds right after completion
          try {
            const out = await pullBytes(c, media.url);
            if (out.buffer.length > 10_000) {
              return { buffer: out.buffer, contentType: media.mime || out.contentType || 'video/mp4', videoId: result.videoId, url: media.url, durationSec: usedDuration };
            }
          } catch (e) { lastErr = e; }
          await sleep(4000);
        }
        throw new GrokError('GROK_DOWNLOAD', 'mp4 download failed: ' + (lastErr ? lastErr.message : 'empty file'));
      } catch (e) {
        if (e instanceof GrokError) throw e;
        throw new GrokError('GROK_UI', 'Grok UI step failed: ' + (e && e.message ? e.message : String(e)));
      } finally {
        if (cap) cap.stop();
        if (tmp) fs.rm(tmp, { force: true }, () => undefined);
      }
    });
  }

  /** Detach CDP (Chrome keeps running so the next job reuses the session). */
  function close() {
    try { if (client) client.close(); } catch (_) {}
    client = null;
  }

  return { status, login, imageToVideo, close, profileDir: o.profileDir };
}

/**
 * Daily-quota rotation across several accounts (one GrokWeb per profile).
 * Moves to the next account on GROK_QUOTA / GROK_AUTH / GROK_AGE_GATE; other errors are rethrown.
 * `state.skip` (Set of profileDir) persists exhausted accounts for the rest of the day — reset it yourself.
 */
async function rotateAccounts(providers, job, state = { skip: new Set() }) {
  let last = null;
  for (const p of providers) {
    if (state.skip.has(p.profileDir)) continue;
    try { return await job(p); } catch (e) {
      if (e instanceof GrokError && ['GROK_QUOTA', 'GROK_AUTH', 'GROK_AGE_GATE'].includes(e.code)) {
        state.skip.add(p.profileDir);
        last = e;
        continue;
      }
      throw e;
    }
  }
  throw last || new GrokError('GROK_QUOTA', 'no usable Grok account left');
}

module.exports = { createGrokWeb, rotateAccounts, GrokError, parseVideoStream, normalizeAspect, snapDuration };
