'use strict';
/**
 * Minimal Chrome DevTools Protocol client — Node >= 22 (global WebSocket), zero dependencies.
 * Works the same inside Electron main process or plain Node.
 *
 *   const { CdpClient, listTargets, findOrOpenPage } = require('./cdp');
 *   const tab = await findOrOpenPage(port, /flow\.google\.com|labs\.google/, 'https://labs.google/fx/tools/flow');
 *   const title = await tab.evaluate('document.title');
 */

const DEFAULT_TIMEOUT = 60_000;

class CdpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'CdpError';
  }
}

class CdpClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.listeners = new Map(); // method -> Set<fn>
    this.closed = true;
  }

  /** @returns {Promise<boolean>} true when connected */
  connect(wsUrl, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      let ws;
      try { ws = new WebSocket(wsUrl); } catch (_) { return finish(false); }
      this.ws = ws;
      const t = setTimeout(() => { try { ws.close(); } catch (_) {} finish(false); }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); this.closed = false; finish(true); };
      ws.onerror = () => { clearTimeout(t); finish(false); };
      ws.onclose = () => {
        this.closed = true;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new CdpError('CDP_CLOSED', 'CDP socket closed')); }
        this.pending.clear();
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch (_) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError('CDP_' + (msg.error.code || 'ERR'), msg.error.message || 'CDP error'));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) { try { fn(msg.params || {}, msg.sessionId); } catch (_) {} }
    }
  }

  send(method, params = {}, { sessionId, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (!this.ws || this.closed) return Promise.reject(new CdpError('CDP_CLOSED', 'CDP not connected'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError('CDP_TIMEOUT', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  /**
   * Runtime.evaluate with awaitPromise + returnByValue. Throws on page exceptions.
   * userGesture:true lets clicks/file pickers/clipboard behave like a real user action.
   */
  async evaluate(expression, { timeoutMs = DEFAULT_TIMEOUT, sessionId } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, { sessionId, timeoutMs });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate failed';
      throw new CdpError('PAGE_EXCEPTION', String(text).slice(0, 500));
    }
    return r.result ? r.result.value : undefined;
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch (_) {}
    this.closed = true;
  }
}

async function getJson(url, { method = 'GET', timeoutMs = 4000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

/** All targets of a Chrome started with --remote-debugging-port. */
function listTargets(port) {
  return getJson(`http://127.0.0.1:${port}/json/list`);
}

/** Browser-level target (needed for Target.*, Storage.getCookies, Browser.*). */
async function connectBrowser(port) {
  const ver = await getJson(`http://127.0.0.1:${port}/json/version`);
  const c = new CdpClient();
  if (!(await c.connect(ver.webSocketDebuggerUrl))) throw new CdpError('CDP_CONNECT', 'cannot connect browser target');
  return c;
}

/**
 * Attach to the first page whose URL matches `urlRe`; if none, open `openUrl` in a new tab.
 * Enables Page + Runtime. Caller owns the returned client (close() when done).
 */
async function findOrOpenPage(port, urlRe, openUrl, { waitMs = 30_000 } = {}) {
  const pick = (list) => list.find((t) => t.type === 'page' && urlRe.test(t.url || ''));
  let target = pick(await listTargets(port));
  if (!target && openUrl) {
    // PUT /json/new is the documented way since Chrome 111 (GET is rejected).
    await getJson(`http://127.0.0.1:${port}/json/new?${encodeURI(openUrl)}`, { method: 'PUT' }).catch(() => undefined);
    const until = Date.now() + waitMs;
    while (!target && Date.now() < until) {
      await sleep(500);
      target = pick(await listTargets(port).catch(() => []));
    }
  }
  if (!target) throw new CdpError('NO_TAB', `no tab matching ${urlRe}`);
  const c = new CdpClient();
  if (!(await c.connect(target.webSocketDebuggerUrl))) throw new CdpError('CDP_CONNECT', 'cannot attach to tab');
  c.targetId = target.id;
  await c.send('Page.enable').catch(() => undefined);
  await c.send('Runtime.enable').catch(() => undefined);
  return c;
}

/**
 * Keep a background/minimized/covered tab "alive": force viewport layout, focus and
 * document.visibilityState = 'visible'. Many SPA (muse.ai, labs.google) stop working when hidden.
 */
const JS_FORCE_VISIBLE = `(() => {
  try {
    if (window.__mbkForceVisible) return 'already';
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    window.__mbkForceVisible = 1;
    return 'ok';
  } catch (e) { return 'err:' + e.message; }
})()`;

const kept = new WeakSet(); // clients that already have the on-new-document script

/**
 * Measured on muse.ai: a minimized/covered window gives visibilityState='hidden', body height 0,
 * innerText '' and images never mount. Viewport override makes layout run, focus emulation fixes
 * focus, but VISIBILITY must be overridden in JS. Safe to call before every request.
 */
async function keepAlive(client, { width = 1440, height = 900 } = {}) { // < ~1000 px wide → Flow uses its phone layout
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  await client.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined); // un-freeze long-hidden pages
  if (!kept.has(client)) {
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: JS_FORCE_VISIBLE }).catch(() => undefined);
    kept.add(client);
  }
  return client.evaluate(JS_FORCE_VISIBLE).catch(() => undefined);
}

/** Open a tab WITHOUT stealing focus (/json/new brings the window to front). */
async function openBackgroundTab(port, url) {
  try {
    const b = await connectBrowser(port);
    try {
      const r = await b.send('Target.createTarget', { url, background: true });
      if (r && r.targetId) return r.targetId;
    } finally { b.close(); }
  } catch (_) {}
  await getJson(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' }).catch(() => undefined);
  return null;
}

function closeTarget(port, targetId) {
  return getJson(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => undefined);
}

/**
 * Attach a local file to an <input type=file> picked by `selectorExpr` (a JS expression returning the element).
 * DOM.setFileInputFiles fires real events — assigning input.files via DataTransfer inside the page is
 * ignored by many React apps (muse.ai, chatgpt.com).
 */
async function setFileInput(client, selectorExpr, paths) {
  await client.send('DOM.enable', {}).catch(() => undefined);
  const r = await client.send('Runtime.evaluate', { expression: selectorExpr, returnByValue: false });
  const objectId = r && r.result && r.result.objectId;
  if (!objectId) throw new CdpError('NO_FILE_INPUT', 'file input not found');
  await client.send('DOM.setFileInputFiles', { objectId, files: paths });
}

/**
 * Pull bytes of a media URL out of the page (works for blob: and cookie-protected URLs).
 * fetch() runs inside the page, bytes are read back in base64 chunks (CDP messages have size limits).
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function pullBytes(client, url, { chunk = 400_000, timeoutMs = 120_000 } = {}) {
  const key = '__mbkBuf' + Math.random().toString(36).slice(2);
  const meta = await client.evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!r.ok) return { ok: false, status: r.status };
    const b = new Uint8Array(await r.arrayBuffer());
    window[${JSON.stringify(key)}] = b;
    return { ok: true, size: b.length, type: r.headers.get('content-type') || '' };
  })()`, { timeoutMs });
  if (!meta || !meta.ok) throw new CdpError('PULL_FAILED', `fetch in page failed (${meta && meta.status})`);
  const parts = [];
  for (let off = 0; off < meta.size; off += chunk) {
    const b64 = await client.evaluate(`(() => {
      const b = window[${JSON.stringify(key)}].subarray(${off}, ${off + chunk});
      let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    })()`);
    parts.push(Buffer.from(b64, 'base64'));
  }
  await client.evaluate(`delete window[${JSON.stringify(key)}]`).catch(() => undefined);
  return { buffer: Buffer.concat(parts), contentType: meta.type };
}

/** Real mouse click at page coordinates (synthetic el.click() is ignored by some file pickers/menus). */
async function clickAt(client, { x, y }) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

/**
 * Most robust way to attach files to a React chat composer (measured on muse.ai: images AND mp3):
 * intercept the native file chooser, click the real paperclip button, feed the chooser.
 *   buttonExpr  JS expression → {x,y} centre of the attach button (scrollIntoView first: an
 *               off-screen button takes no synthetic click) or null
 *   menuItemExpr optional JS expression → {x,y} of an "Upload from computer" menu item, for UIs
 *               where the paperclip opens a small menu first
 * Falls back to the LAST <input type=file> in the document (the composer's) via DOM.setFileInputFiles.
 * @returns {Promise<'chooser'|'input'>}
 */
async function attachViaChooser(client, paths, { buttonExpr, menuItemExpr, waitMs = 6000 } = {}) {
  let chooser = null;
  const off = client.on('Page.fileChooserOpened', (p) => { chooser = p; });
  const waitChooser = async () => { const until = Date.now() + waitMs; while (!chooser && Date.now() < until) await sleep(300); return !!chooser; };
  try {
    await client.send('DOM.enable').catch(() => undefined);
    await client.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    const p = buttonExpr ? await client.evaluate(buttonExpr).catch(() => null) : null;
    if (p) {
      await clickAt(client, p);
      if (!(await waitChooser()) && menuItemExpr) {
        const item = await client.evaluate(menuItemExpr).catch(() => null);
        if (item) { await clickAt(client, item); await waitChooser(); }
      }
    }
    if (chooser && chooser.backendNodeId) {
      await client.send('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
      return 'chooser';
    }
    const { root } = await client.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeIds || !nodeIds.length) throw new CdpError('NO_FILE_INPUT', 'no file chooser and no <input type=file>');
    await client.send('DOM.setFileInputFiles', { files: paths, nodeId: nodeIds[nodeIds.length - 1] });
    return 'input';
  } finally {
    off();
    await client.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  CdpClient, CdpError, listTargets, connectBrowser, findOrOpenPage,
  keepAlive, pullBytes, openBackgroundTab, closeTarget, setFileInput, attachViaChooser, clickAt,
  JS_FORCE_VISIBLE, getJson, sleep,
};
