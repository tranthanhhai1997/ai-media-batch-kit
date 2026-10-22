'use strict';
/**
 * Google Flow (flow.google.com — Veo 3.x / Omni video, Nano Banana images) batch generation by driving a
 * REAL logged-in Chrome profile over CDP. Flow has no usable public API any more (the old
 * aisandbox-pa + /fx/api/auth/session route answers HTML since Flow became an Angular app), so:
 *
 *   1. drive the composer: pin settings (Video · Frames|Ingredients · ratio · x1 · model), attach
 *      reference image(s), type the prompt with Input.insertText, press Create ONCE;
 *   2. learn the result: (a) the media id from Flow's own batchexecute traffic (MZZa6b / jwpduf for
 *      video, ogiZ0b for images) and poll rpc `as29s`; (b) as a fallback that survives rpc changes,
 *      diff the project grid (a new thumbnail = our result, opened at /project/<p>/edit/<id>);
 *   3. take the file home: signed flow-content URL via Network.loadNetworkResource, else Flow's own
 *      ⋮ → Download → "Original size" while catching the Blob handed to URL.createObjectURL.
 *
 *   const { createFlowClient } = require('./providers/flow');
 *   const flow = createFlowClient({ profileDir: 'D:/profiles/flow1' });
 *   console.log(await flow.status(), await flow.getCredits());
 *   const [img] = await flow.generateImages({ prompt: 'a red apple', aspect: '16:9' });
 *   await flow.download(img, 'out/apple.png');
 *   await flow.makeVideo({ prompt: 'slow push-in', startImage: 'out/apple.png', model: 'veo3_lite' }, 'out/apple.mp4');
 *
 * One client = one profile = one Google account. Everything that touches the tab is serialized:
 * two jobs sharing a tab steal each other's result (measured). Parallelism = more accounts.
 * Read skills/ai-media-batch/references/flow-veo3.md before changing timings or selectors.
 */
const fs = require('node:fs');
const path = require('node:path');
const { findOrOpenPage, keepAlive, pullBytes, sleep } = require('../core/cdp');
const { withProfileLock } = require('../core/profile-lock');
const { ensureProfileChrome, closeProfileChrome } = require('../core/chrome');

// ── constants ───────────────────────────────────────────────────────────────
const FLOW_HOME = 'https://flow.google.com/';
const FLOW_TAB_RE = /flow\.google\.com|labs\.google\/fx/i;

// batchexecute rpc ids of the Flow web app (AiSandboxAngularFrontend). They can change with any Flow build.
const RPC = {
  credits: 'nzlxg',       // [] → [credits, tier, …]
  media: 'as29s',         // [mediaId] → record incl. signed flow-content URL; error [5] = NOT_FOUND
  createProject: 'jHPbke',
  genImage: 'ogiZ0b',     // sent by the page on Create (image); response holds the image URL
  genVideo: 'MZZa6b',     // sent by the page on Create (video); response holds the media id
  videoStatus: 'jwpduf',  // the page polls a new clip with [["<mediaId>"]]
};

// label = text in Flow's model menu; need = credits per 8 s clip (Lite/Fast/Quality measured 21/10/2026,
// *_low = 0 measured 14/10; Omni ~12–20 depending on options).
const VIDEO_MODELS = {
  veo3_lite:     { label: 'Veo 3.1 - Lite', family: /Veo.*Lite(?!.*Lower)/i, need: 10 },
  veo3_fast:     { label: 'Veo 3.1 - Fast', family: /Veo.*Fast/i, need: 20 },
  veo3_quality:  { label: 'Veo 3.1 - Quality', family: /Veo.*Quality/i, need: 100 },
  veo3_lite_low: { label: 'Veo 3.1 - Lite [Lower Priority]', family: /Lite.*Lower/i, need: 0 },
  omni:          { label: 'Omni 1.1 Flash', family: /Omni/i, need: 12 },
};
const IMAGE_MODELS = {
  nano_banana_pro:  'Nano Banana Pro',
  nano_banana:      'Nano Banana 2',
  nano_banana_lite: 'Nano Banana 2 Lite',
};

const MIN_GAP_MS = 25_000;           // between two Create clicks on one account (faster → "unusual activity")
const THROTTLE_COOLDOWN_MS = 60_000; // after "unusual activity": ~1 min rest, a retry then usually works
const ID_CAPTURE_MS = 30_000;        // how long to listen for the media id right after Create (soft)
const IMAGE_TIMEOUT_MS = 240_000;
const VIDEO_TIMEOUT_MS = 15 * 60_000;
const NOT_FOUND_STRIKES = 3;         // as29s [5] this many polls in a row → clip dropped (policy/audio)
const NOT_FOUND_GRACE_MS = 15_000;
const STALL_MS = 5 * 60_000;         // tab silent this long while waiting → reconnect once, then FLOW_TIMEOUT
const CONSENT_TIMEOUT_MS = 10 * 60_000;

const THROTTLE_RE = /hoạt động bất thường|unusual activity|suspicious activity/i;
const POLICY_RE = /violate our policies|might violate|prominent people|vi phạm chính sách|người nổi tiếng/i;
const AUDIO_RE = /Audio generation failed|tạo âm thanh không thành công|không tạo được âm thanh/i;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(UUID);
const CONTENT_URL_RE = new RegExp(`https://flow-content\\.google/(image|video)/(${UUID})(?:\\?[^"'\\\\\\s<>]*)?`, 'g');
const SIGNED_RE = /Expires=|Signature=|getMediaUrlRedirect/;

class FlowError extends Error {
  /**
   * @param {'FLOW_AUTH'|'FLOW_QUOTA'|'FLOW_RATE_LIMIT'|'FLOW_POLICY'|'FLOW_TIMEOUT'|'FLOW_BAD_RESPONSE'|'FLOW_RESULT_LOST'|'FLOW_PROJECT_DEAD'} code
   * @param {string} message
   * @param {object} [extra]  e.g. {submitted:true} = Create was already pressed (credits may be spent:
   *                          never rerun this job on another account blindly), {role}, {reason}
   */
  constructor(code, message, extra) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
    this.submitted = false;
    if (extra) Object.assign(this, extra);
  }
}

// ── page-side helper library (installed idempotently before every UI call) ────
// Since 2026-10-21 the settings, model menu, upload picker and download menu live in Angular CDK
// overlays (.cdk-overlay-container). The pre-10-21 inline layout is kept as a fallback.
// No regex LITERAL is hand-written for the page except via RegExp#toString() of a Node regex.
const PAGE_LIB = String.raw`(() => {
  if (window.__mbkFlow && window.__mbkFlow.v === 5) return;
  const vis = (el) => { try { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; } catch (e) { return false; } };
  const nfc = (s) => String(s || '').normalize('NFC');               // Flow labels arrive decomposed (NFD)
  const norm = (s) => nfc(s).replace(/\s+/g, ' ').trim();
  const text = (el) => norm(el && (el.innerText || el.textContent));
  const aria = (el) => nfc(el && el.getAttribute && el.getAttribute('aria-label')).toLowerCase();
  const lastLine = (el) => nfc((el.innerText || '').trim().split('\n').pop()).trim();
  const icon = (el) => { const i = el.querySelector('mat-icon,.material-icons,.material-symbols-outlined,.google-symbols');
    return i ? norm(i.textContent) : ''; };
  const all = (sel, root) => [...(root || document).querySelectorAll(sel)].filter(vis);
  const low = (el, f) => el.getBoundingClientRect().y > innerHeight * (f == null ? 0.45 : f);
  const lab = (src) => new RegExp('^(\\S+\\s+)?(' + src + ')$', 'i');
  const esc = (s) => s.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
  const overlay = () => document.querySelector('.cdk-overlay-container');
  const editor = () => document.querySelector('flow-rich-text-editor .ProseMirror')
    || document.querySelector(".ProseMirror[contenteditable='true']")
    || all("div[role='textbox'][contenteditable='true'], div[contenteditable='true']")[0] || null;
  const isGo = (b) => { const a = aria(b); return (b.innerText || '').indexOf('arrow_forward') >= 0 || a === 'bắt đầu tạo'
    || a.indexOf('tín dụng') >= 0 || a.indexOf('credit') >= 0; };
  // composer = the editor's nearest ancestor that also holds the Create button (or the no-credit badge)
  const composer = () => { let e = editor(); while (e && ![...e.querySelectorAll('button')].some(isGo)) e = e.parentElement;
    return e || document.querySelector('flow-prompt-box'); };
  // The COMPOSER's settings control (aria "Settings trigger", text "Video · 720p · 8s crop_9_16 x1"). The top bar
  // also has a "Settings" button (grid/view options) — matching /settings/ anywhere picked that one (live 22/10/2026).
  const isSettingsish = (b) => /cài đặt|settings/.test(aria(b)) || String(b.className || '').indexOf('settings-') >= 0
    || /crop_|Nano Banana|Video ·|Image ·|Hình ảnh ·/.test(b.innerText || '');
  const settingsTrigger = () => (composer() && all('button', composer()).find(isSettingsish))
    || all('button').find((b) => aria(b) === 'settings trigger')
    || all('button').find((b) => low(b) && isSettingsish(b))
    || all('button').filter((b) => low(b) && /crop_|Nano Banana|Video ·/.test(b.innerText || ''))
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
  // a settings choice by its visible label (last text line): overlay radios first, old inline radios second
  const radio = (names) => { const N = names.map((n) => nfc(n).toLowerCase());
    const o = overlay();
    const inO = o ? all("[role='radio']", o).find((e) => N.includes(lastLine(e).toLowerCase())) : null;
    if (inO) return inO;
    return all("[role='radio'],[role='tab']").find((e) => N.includes(lastLine(e).toLowerCase())
      || N.some((n) => lab(esc(n)).test(text(e)))) || null; };
  const ICON = { video: 'videocam', image: 'image', frames: 'crop_free', ingredients: 'chrome_extension' };
  const NAMES = { video: ['Video'], image: ['Hình ảnh', 'Image', 'Images'], frames: ['Khung hình', 'Frames'],
    ingredients: ['Thành phần', 'Ingredients'] };
  const choice = (key) => { if (NAMES[key]) return radio(NAMES[key]) || all("[role='radio'],[role='tab']").find((e) => icon(e) === ICON[key]) || null;
    if (/^\d+$/.test(key)) return radio([key + 's', key + ' giây', key + ' sec']);
    return radio([key]); };
  const isOn = (el) => { if (!el) return null;
    const v = ['aria-checked', 'aria-pressed', 'aria-selected', 'data-state'].map((a) => el.getAttribute(a)).filter(Boolean);
    return v.some((x) => /^(true|on|active|selected|checked)$/i.test(x)); };
  const modelButton = () => { const o = overlay();
    return (o && all('button', o).find((b) => (b.innerText || '').indexOf('arrow_drop_down') >= 0))
      || all("button[aria-haspopup='menu']").find((b) => /chọn (nhóm )?(mô hình|model)|select .*model|model (group|family|selector)/i.test(aria(b)))
      || all("button[aria-haspopup='menu']").find((b) => low(b) && /arrow_drop_down/.test(b.innerText || '')) || null; };
  const modelItem = (label) => { const re = new RegExp('^(?:\\S+\\s+)?' + esc(label) + '(?:\\s+arrow_drop_down)?$', 'i');
    return all("[role='menuitem'], [role='option'], [role='menu'] button").find((e) => re.test(text(e))) || null; };
  const generate = () => { const a = all('button').find((b) => aria(b) === 'bắt đầu tạo' && !b.disabled);
    if (a) return a; const c = composer();
    return (c && all('button', c).find((b) => text(b) === 'arrow_forward' && !b.disabled))
      || all("flow-generate-icon-button button, button[type='submit']").find((b) => !b.disabled) || null; };
  const addMedia = () => all('button').find((b) => aria(b).indexOf('thêm thành phần') === 0 || aria(b).indexOf('add ingredient') === 0)
    || (composer() && all('button', composer()).find((b) => /^(add|add_2)$/.test(text(b)))) || null;
  const uploadButton = () => { const o = overlay(); const pool = o ? all('button', o) : all('button');
    return pool.find((b) => { const a = (aria(b) + ' ' + text(b)).toLowerCase(); return a.indexOf('tải nội dung') >= 0 || a.indexOf('upload') >= 0; }) || null; };
  const overlayButton = (labels) => { const o = overlay(); if (!o) return null;
    return all('button', o).find((b) => labels.includes(text(b).toLowerCase())) || null; };
  const chipButtons = () => { const c = composer(); return c ? [...c.querySelectorAll('button.chip-container')] : []; };
  const pointOf = (el) => { if (!el) return null; try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const F = {
    editor, generate, settingsTrigger, modelButton, modelItem, addMedia, uploadButton, choice,
    addToPrompt: () => overlayButton(['thêm vào câu lệnh', 'add to prompt']),
    agent: () => all('button').find((b) => /^(tác nhân|agent)$/i.test(text(b))) || null,
    more: () => all('button').find((b) => { const a = aria(b); return a === nfc('tuỳ chọn khác') || a === nfc('tùy chọn khác')
      || a === 'more options' || text(b) === 'more_vert'; }) || null,
    download: () => all('button').find((b) => text(b) === 'download')
      || (overlay() && all("[role='menuitem']", overlay()).find((b) => text(b).indexOf('download') === 0)) || null,
    originalSize: () => { const o = overlay(); if (!o) return null;
      const items = all("button, [role='menuitem']", o); const t = (b) => text(b).toLowerCase();
      return items.find((b) => t(b).indexOf('kích thước gốc') >= 0 || t(b).indexOf('original size') >= 0)
        || items.find((b) => t(b).indexOf('720p') === 0 && t(b).indexOf('tăng độ phân giải') < 0 && t(b).indexOf('upscal') < 0) || null; },
    tile: (src) => [...document.querySelectorAll('img')].find((i) => (i.currentSrc || i.src || '').split('?')[0] === src) || null,
    uploadedItem: (name) => { const o = overlay(); if (!o) return null;
      return [...o.querySelectorAll('*')].filter((e) => e.children.length < 4 && nfc((e.innerText || '').trim()).indexOf(name) === 0).pop() || null; },
    popupClose: () => { const LBL = /^(Bắt đầu|Đã hiểu|Tôi đã hiểu|Đóng|Không phải bây giờ|Bỏ qua|Got it|Get started|Dismiss)$/i;
      for (const d of all("[role='dialog'], [role='alertdialog']")) {
        if (/tôi đồng ý|i agree|tệp tải lên|uploads/i.test(text(d))) continue;   // never answer the rights question / close the picker
        const btns = all('button', d);
        const hit = btns.find((b) => LBL.test(text(b))) || btns.find((b) => /close|dismiss|đóng/.test(aria(b)));
        if (hit) return hit;
      } return null; },
  };
  const scan = (re) => { const hits = [...document.querySelectorAll('body *')].filter((e) => re.test(e.textContent || '')
      && ![...e.children].some((c) => re.test(c.textContent || '')));
    const banner = hits.filter((e) => e.closest("flow-prompt-box, [role=alert], [role=status], [aria-live]")).length;
    return { total: hits.length, banner, cards: hits.length - banner }; };
  const body = () => nfc(document.body ? document.body.innerText : '');
  window.__mbkFlow = {
    v: 5,
    center: (name, arg) => pointOf(F[name] && F[name](arg)),
    exists: (name, arg) => !!(F[name] && F[name](arg)),
    on: (key) => isOn(choice(key)),
    where: () => { const m = location.href.match(new RegExp('/project/(' + ${JSON.stringify(UUID)} + ')'));
      const e = location.pathname.match(new RegExp('/edit/(' + ${JSON.stringify(UUID)} + ')'));
      return { url: location.href, signedOut: location.pathname === '/about' || location.pathname.indexOf('/about/') === 0,
        project: m ? m[1] : '', edit: e ? e[1] : '', token: !!((window.WIZ_global_data || {}).SNlM0e),
        email: (window.WIZ_global_data || {}).oPEP7c || '' }; },
    ready: () => !!editor() && !!settingsTrigger(),
    settingsOpen: () => { const o = overlay(); return !!(o && all("[role='radio']", o).length) || !!choice('x1'); },
    settingsLabel: () => { const b = settingsTrigger(); return b ? text(b) : ''; },
    modelLabel: () => { const b = modelButton(); return b ? text(b).replace('arrow_drop_down', '').trim() : ''; },
    cost: () => { const o = overlay(); const m = (o ? nfc(o.innerText) : '').match(new RegExp('(\\d+)\\s*(tín dụng|credits?)', 'i')); return m ? Number(m[1]) : null; },
    promptText: () => { const e = editor(); return e ? norm(e.innerText || e.value) : ''; },
    focusEnd: () => { const e = editor(); if (!e) return false; e.focus();
      try { const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (x) {}
      return true; },
    agentOn: () => { const b = F.agent(); return b ? b.getAttribute('aria-pressed') === 'true' : false; },
    agentClick: () => { const b = F.agent(); if (b) b.click(); return !!b; },
    // attached ingredients: since 2026-10-21 a chip is button.chip-container (disabled while uploading/failed)
    chips: () => { const b = chipButtons();
      if (b.length) return b.filter((x) => String(x.className).indexOf('chip-container-disabled') < 0
        && !x.querySelector("[role='progressbar'], mat-progress-spinner")).length;
      const c = composer(); return c ? c.querySelectorAll('img').length : 0; },
    chipFailed: () => chipButtons().some((x) => String(x.className).indexOf('chip-container-disabled') >= 0 && (x.innerText || '').indexOf('error') >= 0),
    chipSrcs: () => { const c = composer(); return c ? [...c.querySelectorAll('img, video')].map((i) => (i.currentSrc || i.src || i.poster || '').split('?')[0]).filter(Boolean) : []; },
    overlayHas: (name) => { const o = overlay(); return !!o && nfc(o.innerText).indexOf(name) >= 0; },
    consent: () => !!overlayButton(['tôi đồng ý', 'i agree']) || all("[role='dialog'] button").some((b) => /^(tôi đồng ý|i agree)$/i.test(text(b))),
    noCredit: () => all('button').some((b) => { const a = aria(b); return a.indexOf('không đủ tín dụng') >= 0 || a.indexOf('not enough credit') >= 0 || a.indexOf('insufficient credit') >= 0; }),
    // project grid thumbnails (outside composer/overlay) by address WITHOUT signature (now flow.google.com/asb/<token>)
    tiles: () => { const c = composer(), o = overlay(), out = [];
      for (const i of document.querySelectorAll('img')) { if ((c && c.contains(i)) || (o && o.contains(i))) continue;
        if (i.getBoundingClientRect().width < 80) continue; const s = (i.currentSrc || i.src || '').split('?')[0];
        if (s && out.indexOf(s) < 0) out.push(s); } return out; },
    scrollGrid: async () => { const s = document.scrollingElement || document.body;
      for (let y = 0; y < s.scrollHeight; y += 600) { s.scrollTop = y; await new Promise((r) => setTimeout(r, 250)); } s.scrollTop = 0; return 1; },
    fails: () => { const t = body(); return t.split('Không thành công').length + t.split('Generation failed').length - 2; },
    lastFail: () => { const t = body(); const i = Math.max(t.lastIndexOf('Không thành công'), t.lastIndexOf('Generation failed'));
      return i < 0 ? '' : t.slice(i, i + 240).split('\n').slice(1, 3).join(' '); },
    isResult: () => all('button').some((b) => { const t = text(b); return t === 'share' || t === 'keyboard_return'; }),
    hookBlobs: () => { window.__mbkBlob = null; if (!window.__mbkHook) { window.__mbkHook = 1; const o = URL.createObjectURL;
        URL.createObjectURL = function (b) { if (b && b.size > 20000 && /^(video|image)\//.test(b.type || '')) window.__mbkBlob = b; return o.call(URL, b); }; }
      return 1; },
    blobSize: async () => { const b = window.__mbkBlob; if (!b) return 0; window.__mbkBytes = new Uint8Array(await b.arrayBuffer()); window.__mbkType = b.type; return window.__mbkBytes.length; },
    blobChunk: (off, n) => { const u = window.__mbkBytes; let s = ''; const end = Math.min(off + n, u.length);
      for (let i = off; i < end; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, Math.min(i + 0x8000, end))); return btoa(s); },
    blobType: () => window.__mbkType || '',
    throttle: () => scan(${THROTTLE_RE.toString()}),
    policy: () => scan(${POLICY_RE.toString()}).total,
    audio: () => scan(${AUDIO_RE.toString()}).total,
    hidden: () => document.visibilityState === 'hidden',
  };
})()`;

// in-page batchexecute call; `at` = WIZ_global_data.SNlM0e (page XSRF token, present only when signed in)
function jsRpc(rpcid, payload) {
  return `(async () => {
    try {
      const at = (window.WIZ_global_data || {}).SNlM0e || '';
      if (!at) return { status: 0, text: '', reason: 'no-at-token' };
      const req = [[[${JSON.stringify(rpcid)}, ${JSON.stringify(JSON.stringify(payload))}, null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(req)) + '&at=' + encodeURIComponent(at) + '&';
      const u = '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${rpcid}&source-path=' + encodeURIComponent(location.pathname)
        + '&_reqid=' + Math.floor(Math.random() * 900000 + 100000) + '&rt=c';
      const r = await fetch(u, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
      return { status: r.status, text: await r.text() };
    } catch (e) { return { status: 0, text: '', reason: String(e && e.message || e) }; }
  })()`;
}

/**
 * Decode a batchexecute response: ")]}'" + chunks; each envelope is
 * ["wrb.fr", rpcid, "<json payload as string>", null, null, <error e.g. [5]>, "generic"].
 */
function parseBatch(text, rpcid) {
  const out = { data: null, error: null, found: false };
  for (const line of String(text || '').replace(/^\)\]\}'\s*/, '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('[')) continue;
    let arr; try { arr = JSON.parse(s); } catch (_) { continue; }
    for (const e of Array.isArray(arr) ? arr : []) {
      if (!Array.isArray(e) || e[0] !== 'wrb.fr' || e[1] !== rpcid) continue;
      out.found = true;
      if (typeof e[2] === 'string') { try { out.data = JSON.parse(e[2]); } catch (_) { out.data = e[2]; } }
      if (e[5] != null) out.error = e[5];
    }
  }
  return out;
}

const unescapeUrl = (s) => String(s || '').replace(/\\+u003d/gi, '=').replace(/\\+u0026/gi, '&').replace(/\\+\//g, '/');

/** All flow-content URLs in a blob of text → [{kind, id, url, signed}] */
function contentUrls(text) {
  const res = [];
  for (const m of unescapeUrl(text).matchAll(CONTENT_URL_RE)) res.push({ kind: m[1], id: m[2], url: m[0], signed: SIGNED_RE.test(m[0]) });
  return res;
}

const aspectOf = (a) => (/9\s*:\s*16|portrait|vertical|dọc/i.test(a || '') ? '9:16' : /1\s*:\s*1|square/i.test(a || '') ? '1:1' : '16:9');
const submittedErr = (e) => { if (e && typeof e === 'object') e.submitted = true; return e; };

// ── client ───────────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {string} o.profileDir           Chrome user-data-dir already signed in to flow.google.com
 * @param {boolean} [o.show=true]         false = window off-screen at desktop size (never minimized/headless)
 * @param {string} [o.proxy]
 * @param {string} [o.projectId]          reuse this Flow project (uuid); default: the open one, else a new one
 * @param {string} [o.projectTitle]
 * @param {number} [o.minGapMs=25000]
 * @param {boolean} [o.strictModel=true]  refuse to press Create when the requested model could not be selected
 * @param {(…args)=>void} [o.log]
 */
function createFlowClient(o) {
  if (!o || !o.profileDir) throw new Error('profileDir is required');
  const log = o.log || (() => {});
  const minGap = o.minGapMs == null ? MIN_GAP_MS : o.minGapMs;
  const strictModel = o.strictModel !== false;
  const st = {
    client: null, port: 0, events: [], projectId: o.projectId || '',
    lastGenerateAt: 0, throttledUntil: 0, baseline: null,
    knownIds: new Set(),          // media ids already returned/uploaded/polled — never "capture" them again
    ops: new Map(),               // mediaId → {projectId, submittedAt}
    chain: Promise.resolve(),     // serializes everything that drives the tab
  };

  // ── connection ──
  async function page() {
    if (st.client && !st.client.closed) return st.client;
    st.port = await ensureProfileChrome({ profileDir: o.profileDir, url: FLOW_HOME, show: o.show !== false, proxy: o.proxy });
    const c = await findOrOpenPage(st.port, FLOW_TAB_RE, FLOW_HOME);
    // keepAlive forces a 1440x900 desktop viewport: below ~1000 px Flow switches to its phone layout
    await keepAlive(c);
    await c.send('Network.enable', { maxPostDataSize: 65536 }).catch(() => undefined);
    await c.send('DOM.enable').catch(() => undefined);
    const push = (method) => (p) => { st.events.push({ method, p, ts: Date.now() }); if (st.events.length > 4000) st.events.splice(0, 1000); };
    for (const m of ['Network.requestWillBeSent', 'Network.loadingFinished']) c.on(m, push(m));
    // a reload with an upload in flight asks "Leave site?" — only ever our own stuck upload: accept
    c.on('Page.javascriptDialogOpening', (p) => { if (p && p.type === 'beforeunload') c.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined); });
    st.client = c;
    return c;
  }

  async function ev(expr, timeoutMs = 60_000) {
    const c = await page();
    try { return await c.evaluate(expr, { timeoutMs }); } catch (e) {
      // a navigation destroys the execution context → reconnect once and retry
      if (!/context|closed|navigat|CDP_CLOSED|not connected|Target/i.test(`${e && e.code} ${e && e.message}`)) throw e;
      try { c.close(); } catch (_) {}
      st.client = null;
      await sleep(800);
      return (await page()).evaluate(expr, { timeoutMs });
    }
  }
  const lib = (fn, ...args) => ev(`(${PAGE_LIB}, window.__mbkFlow.${fn}(${args.map((a) => JSON.stringify(a)).join(',')}))`);
  const libSafe = (fallback, fn, ...args) => lib(fn, ...args).catch(() => fallback);

  // in-process chain + cross-process file lock (another app/script driving the same Google account)
  function exclusive(fn) {
    const guarded = () => withProfileLock(o.profileDir, 'flow', 'flow job', fn);
    const run = st.chain.then(guarded, guarded);
    st.chain = run.catch(() => undefined);
    return run;
  }

  // ── input: trusted CDP mouse events (Flow's menu items ignore a scripted el.click()) ──
  const rand = (a, b) => a + Math.random() * (b - a);
  async function click(pt) {
    const c = await page();
    for (let i = 2; i >= 1; i--) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(pt.x - i * rand(6, 16)), y: Math.round(pt.y - i * rand(4, 12)) }).catch(() => undefined);
      await sleep(rand(35, 90));
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await sleep(rand(60, 140));
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(rand(45, 110));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
  }
  async function clickRole(name, arg, { optional = false, wait = 0 } = {}) {
    const until = Date.now() + wait;
    for (;;) {
      const pt = await libSafe(null, 'center', name, arg);
      if (pt) { await click(pt); return true; }
      if (Date.now() >= until) break;
      await sleep(400);
    }
    if (optional) return false;
    throw new FlowError('FLOW_BAD_RESPONSE', `Flow UI element not found: ${name}${arg != null ? ' ' + arg : ''} (UI changed?)`, { role: name });
  }
  async function key(k, code, vk, modifiers = 0) {
    const c = await page();
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers }).catch(() => undefined);
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }).catch(() => undefined);
  }
  async function waitFor(fn, ms, every = 400) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await fn().catch(() => false)) return true; await sleep(every); }
    return false;
  }
  const navigate = async (url) => (await page()).send('Page.navigate', { url }).catch(() => undefined);

  // ── sign-in / project ──
  async function ensureLoggedIn(timeoutMs = 35_000) {
    const until = Date.now() + timeoutMs;
    let w = null; let navigated = false;
    while (Date.now() < until) {
      w = await libSafe(null, 'where');
      // flow.google.com/about = where Flow sends a signed-out visitor (the one reliable check)
      if (w && (w.signedOut || /accounts\.google\.com|ServiceLogin/i.test(w.url))) break;
      if (w && FLOW_TAB_RE.test(w.url) && w.token) return w;
      if (!navigated && w && !FLOW_TAB_RE.test(w.url)) { navigated = true; await navigate(FLOW_HOME); }
      await sleep(1500);
    }
    if (!w) throw new FlowError('FLOW_TIMEOUT', 'Chrome/Flow tab does not answer over CDP');
    if (w.signedOut || !w.token) throw new FlowError('FLOW_AUTH', `Not signed in to Google Flow in this profile (${w.url.slice(0, 80)}). Open it with show:true and sign in once.`);
    throw new FlowError('FLOW_AUTH', 'Flow page token (WIZ_global_data.SNlM0e) missing — signed out or Flow changed');
  }

  async function rpc(rpcid, payload) {
    await ensureLoggedIn();
    const r = await ev(jsRpc(rpcid, payload), 30_000);
    if (!r || r.status === 0) throw new FlowError('FLOW_TIMEOUT', `batchexecute ${rpcid} failed: ${r && r.reason}`);
    if (r.status === 401 || r.status === 403) throw new FlowError('FLOW_AUTH', `batchexecute ${rpcid} → HTTP ${r.status}`);
    if (r.status === 429) throw new FlowError('FLOW_RATE_LIMIT', `batchexecute ${rpcid} → HTTP 429`);
    return Object.assign(parseBatch(r.text, rpcid), { raw: r.text, status: r.status });
  }

  async function openProject(id) {
    await navigate(`${FLOW_HOME}project/${id}`);
    let dead = false;
    const ok = await waitFor(async () => {
      const w = await lib('where');
      if (/flow\.google\.com\/404/.test(w.url)) { dead = true; return true; }
      return w.project === id;
    }, 15_000, 600);
    return ok && !dead;
  }

  async function ensureProject() {
    let w = await ensureLoggedIn();
    if (st.projectId && w.project === st.projectId) return st.projectId;
    if (st.projectId && (await openProject(st.projectId))) return st.projectId;
    if (!st.projectId && w.project) { st.projectId = w.project; return w.project; }
    // create one through the page's own rpc (payload shape from Flow's traffic, 09/2026)…
    const title = o.projectTitle || `batch ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const r = await rpc(RPC.createProject, ['projects/*', [null, [title]], [null, 22]]).catch(() => null);
    const id = r && (JSON.stringify(r.data || '').match(UUID_RE) || [])[0];
    if (id && (await openProject(id))) { st.projectId = id; log('[flow] new project', id); return id; }
    // …else the UI: "New project" on the home page (a project is free — only a folder)
    await navigate(FLOW_HOME);
    for (let i = 0; i < 15; i++) {
      await sleep(1200);
      w = await libSafe({}, 'where');
      if (w.project) { st.projectId = w.project; return w.project; }
      if (i > 2) await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Dự án mới|New project/i.test(x.innerText || '')); if (b) b.click(); return !!b; })()`).catch(() => false);
    }
    throw new FlowError('FLOW_PROJECT_DEAD', 'Could not create/open a Flow project');
  }

  // The URL turns /project/ long before the page is drawn: wait for composer AND settings control
  // (measured 21/10/2026: without this, 6 profiles failed "no composer" within seconds).
  async function ensureComposer() {
    const pid = await ensureProject();
    const w = await libSafe({}, 'where');
    if (w.edit) { await navigate(`${FLOW_HOME}project/${pid}`); await sleep(3000); }
    if (await waitFor(() => lib('ready'), 30_000, 750)) return pid;
    await (await page()).send('Page.reload', {}).catch(() => undefined);
    if (await waitFor(() => lib('ready'), 30_000, 1000)) return pid;
    throw new FlowError('FLOW_PROJECT_DEAD', 'Flow composer never finished loading in this project (nothing was submitted)');
  }

  async function cleanComposer() {
    for (let i = 0; i < 3; i++) { const pt = await libSafe(null, 'center', 'popupClose'); if (!pt) break; await click(pt); await sleep(900); }
    const t = await libSafe(null, 'throttle');
    if (t && t.banner) { log('[flow] throttle banner → reload'); await (await page()).send('Page.reload', {}).catch(() => undefined); await waitFor(() => lib('ready'), 30_000, 1000); }
    if (await libSafe(false, 'agentOn')) { await lib('agentClick').catch(() => undefined); await sleep(600); } // "Agent" chat mode must be OFF
    // Ctrl+A in the composer also deletes attached chips → clear BEFORE attaching anything
    if (!(await libSafe(false, 'focusEnd'))) throw new FlowError('FLOW_PROJECT_DEAD', 'Flow prompt box not found', { role: 'editor' });
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2);
    await key('Backspace', 'Backspace', 8);
    await sleep(400);
  }

  // ── settings (overlay since 21/10/2026) ──
  async function openSettings() {
    if (await libSafe(false, 'settingsOpen')) return;
    for (let i = 0; i < 3; i++) {
      // the trigger TOGGLES the popover: only click it when the choices are not on screen
      await clickRole('settingsTrigger');
      if (await waitFor(() => lib('settingsOpen'), 3000)) return;
    }
    throw new FlowError('FLOW_BAD_RESPONSE', 'Flow settings popover did not open', { role: 'settingsTrigger' });
  }
  async function setChoice(keyName, label) {
    for (let i = 0; i < 3; i++) {
      if ((await libSafe(null, 'on', keyName)) === true) return true;
      await openSettings();
      if (!(await clickRole('choice', keyName, { optional: true }))) break;
      if (await waitFor(async () => (await lib('on', keyName)) === true, 3000)) return true;
    }
    log(`[flow] could not set ${label || keyName}`);
    return false;
  }
  async function pickModel(label, family) {
    const ok = async () => family.test(await libSafe('', 'modelLabel'));
    if (await ok()) return true;
    for (let i = 0; i < 2; i++) {
      await openSettings();
      if (!(await clickRole('modelButton', undefined, { optional: true }))) return false;
      await sleep(900);
      if (!(await clickRole('modelItem', label, { optional: true }))) {
        log(`[flow] model "${label}" not offered to this account`);
        await key('Escape', 'Escape', 27);
        return false;
      }
      await sleep(900);
      if (await ok()) return true;
    }
    return false;
  }

  /** Pin every choice: Flow keeps whatever the composer was left at (a new project starts on Image · x2!). */
  async function applySettings(kind, { aspect, model, mode, resolution }) {
    await openSettings();
    const report = [];
    report.push(`${kind}:${await setChoice(kind)}`);
    if (kind === 'video') report.push(`${mode}:${await setChoice(mode)}`); // mode first: other rows depend on it
    const a = aspectOf(aspect);
    const aspectOk = await setChoice(a, `aspect ${a}`);
    report.push(`${a}:${aspectOk}`);
    report.push(`x1:${await setChoice('x1')}`);
    let modelOk = true;
    if (kind === 'video') {
      const m = VIDEO_MODELS[model];
      modelOk = await pickModel(m.label, m.family);
      // the resolution row exists only for some models (Omni) → after the model, optional
      if (resolution || model === 'omni') await setChoice(resolution || '720p', 'resolution');
    } else if (model) {
      modelOk = await pickModel(IMAGE_MODELS[model], new RegExp(IMAGE_MODELS[model].replace(/\s+/g, '\\s*') + '(?!\\s*(Lite|Pro))', 'i'));
    }
    const cost = await libSafe(null, 'cost');
    const label = await libSafe('', 'modelLabel');
    report.push(`model:${label || '?'}`, `cost:${cost ?? '?'}`);
    log(`[flow] settings ${report.join(' ')}`);
    if (!aspectOk) throw new FlowError('FLOW_BAD_RESPONSE', `could not set aspect ${a}`, { role: 'aspect' });
    if (!modelOk && strictModel) throw new FlowError('FLOW_BAD_RESPONSE', `could not select model ${model} (now "${label}") — not offered to this account?`, { role: 'model' });
    // close the popover by focusing the composer — a page click lands on the trigger and undoes choices
    await lib('focusEnd').catch(() => undefined);
    await sleep(400);
    return { cost, modelLabel: label, modelOk };
  }

  // ── reference image upload: "+" → "Upload media" → file chooser (fed through CDP) ──
  async function waitConsent() {
    if (!(await libSafe(false, 'consent'))) return;
    // Flow asks once per account about the rights to an upload. Never answer it for the user.
    log('[flow] rights dialog open — answer it in the Chrome window (show:true)');
    if (!(await waitFor(async () => !(await lib('consent')), CONSENT_TIMEOUT_MS, 2000))) {
      throw new FlowError('FLOW_AUTH', 'Flow upload rights dialog was not answered', { reason: 'consent' });
    }
  }
  async function attachIngredient(file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new FlowError('FLOW_BAD_RESPONSE', `reference image not found: ${abs}`);
    const name = path.basename(abs).replace(/\.\w+$/, '');
    const c = await page();
    const before = await libSafe(0, 'chips');
    const upload = async () => {
      let chooser = null;
      const off = c.on('Page.fileChooserOpened', (p) => { chooser = p; });
      await c.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
      try {
        if (!(await libSafe(false, 'exists', 'uploadButton'))) { await clickRole('addMedia'); await sleep(1500); }
        await clickRole('uploadButton', undefined, { wait: 4000 });
        await waitFor(async () => !!chooser, 8000, 300);
        if (!chooser || !chooser.backendNodeId) throw new FlowError('FLOW_BAD_RESPONSE', 'Flow file chooser did not open', { role: 'uploadButton' });
        await c.send('DOM.setFileInputFiles', { files: [abs], backendNodeId: chooser.backendNodeId });
      } finally {
        off();
        await c.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
      }
    };
    await upload();
    await sleep(1500);
    await waitConsent();
    // since 21/10/2026 an upload lands straight in the composer as a chip; older builds list it in the
    // picker first (click it, then "Add to prompt") — handle both
    const until = Date.now() + 300_000;
    let retryAt = Date.now() + 90_000;
    for (;;) {
      if ((await libSafe(0, 'chips')) > before) break;
      const failed = await libSafe(false, 'chipFailed');
      if (retryAt && (failed || Date.now() > retryAt)) {
        retryAt = 0;
        log(`[flow] upload of ${name} ${failed ? 'failed' : 'stuck'} → once more`);
        await upload();
      } else if (failed) throw new FlowError('FLOW_BAD_RESPONSE', `upload of ${name} failed twice`);
      if (Date.now() > until) throw new FlowError('FLOW_BAD_RESPONSE', `upload of ${name} never attached`);
      if (await libSafe(false, 'exists', 'uploadedItem', name)) {
        await clickRole('uploadedItem', name, { optional: true });
        await sleep(1500);
        await clickRole('addToPrompt', undefined, { optional: true });
        // a second click on the same row toggles it off again: give the chip time to land
        await waitFor(async () => (await lib('chips')) > before, 6000, 1000);
      } else {
        await sleep(3000);
      }
    }
    await lib('focusEnd').catch(() => undefined);
  }

  async function typePrompt(text) {
    const c = await page();
    if (!(await libSafe(false, 'focusEnd'))) throw new FlowError('FLOW_PROJECT_DEAD', 'Flow prompt box not found', { role: 'editor' });
    await sleep(150);
    // Input.insertText (not execCommand / textContent): the Angular editor ignores scripted DOM edits
    for (const part of text.match(/[\s\S]{1,16}/g) || []) { await c.send('Input.insertText', { text: part }); await sleep(rand(15, 50)); }
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!(await waitFor(async () => (await lib('promptText')).includes(head), 5000))) {
      throw new FlowError('FLOW_BAD_RESPONSE', 'prompt did not land in the Flow composer', { role: 'editor' });
    }
  }

  // ── pacing + throttle ("unusual activity") ──
  async function pace() {
    const rest = st.throttledUntil - Date.now();
    if (rest > 0) { log(`[flow] throttled, resting ${Math.round(rest / 1000)} s`); await sleep(rest); }
    const gap = st.lastGenerateAt ? minGap - (Date.now() - st.lastGenerateAt) : 0;
    if (gap > 0) await sleep(gap);
  }
  async function throttled() {
    const now = await libSafe(null, 'throttle');
    const base = st.baseline;
    return !!(now && base && (now.banner > base.banner || now.cards > base.cards));
  }
  function markThrottled() { st.throttledUntil = Date.now() + (o.throttleCooldownMs || THROTTLE_COOLDOWN_MS); }

  // ── grid snapshot (lazy tiles: scroll through, wait until the count holds still) ──
  async function snapshotGrid() {
    await lib('scrollGrid').catch(() => undefined);
    let count = -1;
    for (let i = 0, still = 0; i < 20 && still < 3; i++) {
      await sleep(1000);
      const n = (await libSafe([], 'tiles')).length;
      still = n === count ? still + 1 : 0;
      count = n;
    }
    const known = await libSafe([], 'tiles');
    return known.concat(await libSafe([], 'chipSrcs')); // our own upload shows up on the grid later: never ours
  }

  // ── network capture (media id straight from Flow's own rpc traffic) ──
  const rpcidOf = (url) => { const m = /[?&]rpcids=([^&]+)/.exec(url || ''); return m ? decodeURIComponent(m[1]) : ''; };
  const decode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  function armCapture() {
    // clips the page was already polling (earlier jobs, other runs) must never pass for the new one
    for (const e of st.events) {
      if (e.method !== 'Network.requestWillBeSent' || !rpcidOf(e.p.request && e.p.request.url).includes(RPC.videoStatus)) continue;
      for (const m of decode((e.p.request && e.p.request.postData) || '').matchAll(new RegExp(UUID, 'g'))) st.knownIds.add(m[0]);
    }
    st.events.length = 0;
    return Date.now();
  }
  async function responseBody(requestId) {
    try { const r = await (await page()).send('Network.getResponseBody', { requestId }, { timeoutMs: 20_000 }); return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : (r.body || ''); }
    catch (_) { return ''; }
  }
  async function postData(p) {
    if (p.request && p.request.postData) return p.request.postData;
    try { return (await (await page()).send('Network.getRequestPostData', { requestId: p.requestId })).postData || ''; } catch (_) { return ''; }
  }
  const sawRpc = (id, since) => st.events.some((e) => e.ts >= since && e.method === 'Network.requestWillBeSent' && rpcidOf(e.p.request && e.p.request.url).split(',').includes(id));

  async function captureVideoId(since, timeoutMs) {
    const pending = new Set();
    let cursor = 0;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const evs = st.events.slice(cursor); cursor = st.events.length;
      for (const e of evs) {
        if (e.ts < since) continue;
        const url = (e.p.request && e.p.request.url) || '';
        if (e.method === 'Network.requestWillBeSent' && /batchexecute/.test(url)) {
          const id = rpcidOf(url);
          if (id.includes(RPC.videoStatus)) {
            const m = decode(await postData(e.p)).match(new RegExp(`\\[\\[\\\\?"(${UUID})\\\\?"\\]\\]`));
            if (m && !st.knownIds.has(m[1])) return m[1];
          }
          if (id.includes(RPC.genVideo)) pending.add(e.p.requestId);
        }
        if (e.method === 'Network.loadingFinished' && pending.has(e.p.requestId)) {
          pending.delete(e.p.requestId);
          const txt = unescapeUrl(await responseBody(e.p.requestId));
          // MZZa6b answer holds "<mediaId>","<uuid>","<uuid>","CA?" — the first uuid is the clip
          const m = txt.match(new RegExp(`\\\\?"(${UUID})\\\\?",\\\\?"${UUID}\\\\?",\\\\?"${UUID}\\\\?",\\\\?"CA[A-Z]\\\\?"`));
          if (m && !st.knownIds.has(m[1])) return m[1];
        }
      }
      await sleep(1000);
    }
    return '';
  }

  async function captureImage(since, timeoutMs) {
    const pending = new Map();
    let cursor = 0;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const evs = st.events.slice(cursor); cursor = st.events.length;
      for (const e of evs) {
        if (e.ts < since) continue;
        if (e.method === 'Network.requestWillBeSent') {
          const url = (e.p.request && e.p.request.url) || '';
          const id = rpcidOf(url);
          if (/batchexecute/.test(url) && (id.includes(RPC.genImage) || id.includes(RPC.media))) pending.set(e.p.requestId, { rpcid: id, post: decode(await postData(e.p)) });
        } else if (e.method === 'Network.loadingFinished' && pending.has(e.p.requestId)) {
          const info = pending.get(e.p.requestId); pending.delete(e.p.requestId);
          const urls = contentUrls(await responseBody(e.p.requestId)).filter((u) => u.kind === 'image' && !st.knownIds.has(u.id));
          if (info.rpcid.includes(RPC.media)) {
            const asked = (info.post.match(new RegExp(`\\[\\\\?"(${UUID})\\\\?"\\]`)) || [])[1];
            const hit = urls.find((u) => u.id === asked && u.signed);
            if (hit) return hit;
          } else {
            const hit = urls.find((u) => u.signed) || urls[0];
            if (hit) return hit;
          }
        }
      }
      await sleep(400);
    }
    return null;
  }

  // ── grid fallback: new tile → its page /project/<p>/edit/<id> → is it a generated result? ──
  async function awaitTile(projectId, known, fails0, timeoutMs, kind) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      await sleep(5000);
      if ((await libSafe(fails0, 'fails')) > fails0) {
        const why = await libSafe('', 'lastFail');
        throw new FlowError('FLOW_POLICY', `Flow refused the ${kind}: ${why}`, { reason: AUDIO_RE.test(why) ? 'audio' : 'failed', submitted: true });
      }
      const fresh = (await libSafe([], 'tiles')).find((x) => !known.includes(x));
      if (fresh) {
        await sleep(3000);
        await clickRole('tile', fresh, { optional: true });
        let id = '';
        await waitFor(async () => { id = (await lib('where')).edit; return !!id; }, 15_000, 1000);
        const isResult = id ? await waitFor(() => lib('isResult'), 6000, 1000) : false;
        known.push(fresh);
        if (id && isResult) return { mediaId: id, tile: fresh };
        log(`[flow] tile ${id || '?'} is an upload/unknown, waiting on`);
        await navigate(`${FLOW_HOME}project/${projectId}`);
        await sleep(5000);
      }
      if (Date.now() > until) throw new FlowError('FLOW_RESULT_LOST', `no new ${kind} appeared in the project in time`, { submitted: true });
    }
  }

  // ── credits ──
  async function getCredits() {
    const r = await rpc(RPC.credits, []);
    const credits = Array.isArray(r.data) ? Number(r.data[0]) : Number((/"nzlxg","\[(-?\d+)/.exec(r.raw) || [])[1]);
    if (!Number.isFinite(credits)) throw new FlowError('FLOW_BAD_RESPONSE', `cannot read credits (nzlxg): ${String(r.raw).slice(0, 160)}`);
    const w = await libSafe({}, 'where');
    return { credits, tier: Array.isArray(r.data) ? r.data[1] : undefined, email: w.email || '', raw: r.data };
  }

  // ── submit (shared by video + image) ──
  async function submit(kind, { prompt, aspect, model, refs, mode, resolution }) {
    await pace();
    const projectId = await ensureComposer();
    await cleanComposer();
    const s = await applySettings(kind, { aspect, model, mode, resolution });
    for (const r of refs) await attachIngredient(r);
    await typePrompt(prompt);
    if (await libSafe(false, 'noCredit')) throw new FlowError('FLOW_QUOTA', 'Flow shows "not enough credits" for this account');
    if (kind === 'video') {
      const need = s.cost != null ? s.cost : VIDEO_MODELS[model].need;
      const cr = need ? await getCredits().catch(() => null) : null; // unreadable credits must not block
      if (cr && cr.credits < need) throw new FlowError('FLOW_QUOTA', `${cr.credits} credits left, this clip needs ${need}`, { credits: cr.credits });
    }
    const known = await snapshotGrid();
    const fails0 = await libSafe(0, 'fails');
    st.baseline = await libSafe(null, 'throttle');
    if (await libSafe(false, 'hidden')) log('[flow] WARNING: tab is hidden while pressing Create');
    const since = armCapture();
    // press Create ONCE. Only an enabled button is clicked, so retrying the lookup cannot bill twice.
    if (!(await clickRole('generate', undefined, { optional: true, wait: 5000 }))) throw new FlowError('FLOW_BAD_RESPONSE', 'Create button not found/disabled', { role: 'generate' });
    st.lastGenerateAt = Date.now();
    const genRpc = kind === 'video' ? RPC.genVideo : RPC.genImage;
    // accepted = the editor cleared itself or the page sent its generate rpc (an empty box after Create is NORMAL)
    await waitFor(async () => sawRpc(genRpc, since) || !(await lib('promptText')), 15_000, 500);
    for (let i = 0; i < 6; i++) {
      if (await throttled()) { markThrottled(); throw new FlowError('FLOW_RATE_LIMIT', 'Flow "unusual activity": account throttled — rest ~1 min or use another account', { submitted: true }); }
      await sleep(500);
    }
    return { projectId, since, known, fails0, settings: s };
  }

  // ── images ──
  /** @returns {Promise<Array<{kind:'image', mediaId:string, url:string, tile?:string, projectId:string}>>} */
  function generateImages({ prompt, aspect = '16:9', count = 1, model = 'nano_banana', refs = [] } = {}) {
    if (!String(prompt || '').trim()) return Promise.reject(new FlowError('FLOW_BAD_RESPONSE', 'empty prompt'));
    if (model && !IMAGE_MODELS[model]) return Promise.reject(new FlowError('FLOW_BAD_RESPONSE', `unknown image model "${model}"`));
    return exclusive(async () => {
      const out = [];
      for (let i = 0; i < Math.max(1, count); i++) {
        const sub = await submit('image', { prompt, aspect, model, refs: refs.filter(Boolean) });
        try {
          const img = await captureImage(sub.since, 120_000);
          if (img) { st.knownIds.add(img.id); out.push({ kind: 'image', mediaId: img.id, url: img.url, projectId: sub.projectId }); continue; }
          if (await libSafe(false, 'noCredit')) throw new FlowError('FLOW_QUOTA', 'Flow says: not enough credits');
          // rpc shape changed? fall back to the grid (thumbnails live at flow.google.com/asb/…)
          const t = await awaitTile(sub.projectId, sub.known, sub.fails0, IMAGE_TIMEOUT_MS - 120_000, 'image');
          st.knownIds.add(t.mediaId);
          out.push({ kind: 'image', mediaId: t.mediaId, url: '', tile: t.tile, projectId: sub.projectId });
          await navigate(`${FLOW_HOME}project/${sub.projectId}`);
        } catch (e) { throw submittedErr(e); }
      }
      return out;
    });
  }

  // ── video ──
  async function submitVideo({ prompt, aspect = '16:9', model = 'veo3_lite', startImage, refs = [], resolution, endImage } = {}) {
    if (!String(prompt || '').trim()) throw new FlowError('FLOW_BAD_RESPONSE', 'empty prompt');
    if (!VIDEO_MODELS[model]) throw new FlowError('FLOW_BAD_RESPONSE', `unknown model "${model}"; one of ${Object.keys(VIDEO_MODELS).join(', ')}`);
    if (endImage) throw new FlowError('FLOW_BAD_RESPONSE', 'endImage (exact last frame) is not automated: no verified UI path; the old API route is dead');
    const images = [startImage, ...refs].filter(Boolean);
    // Frames mode for pure text (verified 21/10); Ingredients when images are attached (reference image + prompt)
    const mode = images.length ? 'ingredients' : 'frames';
    const sub = await submit('video', { prompt, aspect, model, refs: images, mode, resolution });
    let id = '';
    try { id = await captureVideoId(sub.since, ID_CAPTURE_MS); } catch (_) {}
    if (!id && (await libSafe(false, 'noCredit'))) throw new FlowError('FLOW_QUOTA', 'Flow says: not enough credits', { submitted: true });
    if (id) { st.knownIds.add(id); st.ops.set(id, { projectId: sub.projectId, submittedAt: Date.now() }); }
    return {
      kind: 'video', mediaId: id, opId: id || `grid-${sub.since}`, projectId: sub.projectId, model,
      cost: sub.settings.cost, modelLabel: sub.settings.modelLabel, known: sub.known, fails0: sub.fails0, submittedAt: Date.now(),
    };
  }

  async function waitVideoInner(op, { timeoutMs = VIDEO_TIMEOUT_MS, intervalMs = 10_000, onProgress } = {}) {
    if (!op.mediaId) {
      // no id from the network: watch the grid (needs the tab → caller holds the lock)
      const t = await awaitTile(op.projectId, op.known || [], op.fails0 || 0, timeoutMs, 'clip');
      await navigate(`${FLOW_HOME}project/${op.projectId}`);
      return { kind: 'video', mediaId: t.mediaId, url: '', projectId: op.projectId };
    }
    const id = op.mediaId;
    const start = Date.now();
    const submittedAt = op.submittedAt || (st.ops.get(id) || {}).submittedAt || start;
    let strikes = 0; let lastSignal = Date.now(); let reconnected = false;
    while (Date.now() - start < timeoutMs) {
      let state = 'pending';
      try {
        if (op.fails0 != null && (await lib('fails')) > op.fails0) {
          const why = await libSafe('', 'lastFail');
          throw new FlowError('FLOW_POLICY', `Flow refused clip ${id}: ${why}`, { reason: AUDIO_RE.test(why) ? 'audio' : 'failed' });
        }
        const r = await rpc(RPC.media, [id]);
        lastSignal = Date.now();
        const hit = contentUrls(r.raw).find((u) => u.kind === 'video' && u.id === id && u.signed);
        if (hit) return { kind: 'video', mediaId: id, url: hit.url, projectId: op.projectId };
        if (Array.isArray(r.error) && r.error[0] === 5) {
          // a refused clip never reports an error: its record simply goes missing
          strikes++; state = 'not_found';
          if (strikes >= NOT_FOUND_STRIKES && Date.now() - submittedAt >= NOT_FOUND_GRACE_MS) {
            const reason = (await libSafe(0, 'audio')) ? 'audio' : (await libSafe(0, 'policy')) ? 'policy' : 'not_found';
            throw new FlowError('FLOW_POLICY', `Flow dropped clip ${id} (${reason}). Neutralize the prompt / change start image or model, then resubmit.`, { reason });
          }
        } else { strikes = 0; state = r.found ? 'rendering' : 'pending'; }
      } catch (e) {
        if (e instanceof FlowError && (e.code === 'FLOW_POLICY' || e.code === 'FLOW_AUTH')) throw submittedErr(e);
        state = 'no_signal';
        if (Date.now() - lastSignal > STALL_MS) {
          if (reconnected) throw new FlowError('FLOW_TIMEOUT', `no signal from the Flow tab for ${Math.round(STALL_MS / 60e3)} min (clip ${id})`, { stalled: true, submitted: true });
          reconnected = true; lastSignal = Date.now();
          try { st.client && st.client.close(); } catch (_) {}
          st.client = null; // the clip keeps rendering server-side; we only re-attach
        }
      }
      if (onProgress) { try { onProgress({ mediaId: id, state, elapsedMs: Date.now() - start }); } catch (_) {} }
      await sleep(intervalMs);
    }
    throw new FlowError('FLOW_TIMEOUT', `clip ${id} not ready after ${Math.round(timeoutMs / 60e3)} min`, { submitted: true });
  }

  /**
   * Submit one clip; resolves once Flow accepted it. Never presses Create twice — on any error after
   * the press, err.submitted === true (credits may already be spent; do not rerun elsewhere blindly).
   */
  function generateVideo(opts) { return exclusive(() => submitVideo(opts || {})); }

  /** Wait for a clip from generateVideo(). With a media id this only polls (no tab lock); otherwise it watches the grid. */
  function waitVideo(op, opts) {
    if (!op) return Promise.reject(new FlowError('FLOW_BAD_RESPONSE', 'waitVideo: missing op'));
    return op.mediaId ? waitVideoInner(op, opts) : exclusive(() => waitVideoInner(op, opts));
  }

  // ── download ──
  async function loadResource(url) {
    // with the profile's cookies and no CORS (flow-content.google is cross-origin to flow.google.com)
    const c = await page();
    const { frameTree } = await c.send('Page.getFrameTree');
    const r = await c.send('Network.loadNetworkResource', { frameId: frameTree.frame.id, url, options: { disableCache: true, includeCredentials: true } });
    const res = r && r.resource;
    if (!res || !res.success || !res.stream) return null;
    const parts = [];
    for (;;) {
      const chunk = await c.send('IO.read', { handle: res.stream, size: 1 << 20 });
      if (chunk.data) parts.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
      if (chunk.eof) break;
    }
    await c.send('IO.close', { handle: res.stream }).catch(() => undefined);
    const h = res.headers || {};
    return { buffer: Buffer.concat(parts), contentType: String(h['content-type'] || h['Content-Type'] || '').split(';')[0] };
  }

  /** Flow's own download: /edit/<id> → ⋮ → Download → Original size, catching the Blob (verified 21/10 for clips). */
  async function uiDownload(projectId, mediaId) {
    await navigate(`${FLOW_HOME}project/${projectId}/edit/${mediaId}`);
    try {
      for (let round = 0; round < 6; round++) {
        await sleep(round ? 15_000 : 6000); // a clip still being finished has no download yet
        await lib('hookBlobs');
        if (!(await libSafe(false, 'exists', 'download'))) { await clickRole('more', undefined, { optional: true }); await sleep(1200); }
        if (!(await clickRole('download', undefined, { optional: true }))) continue;
        await sleep(1500);
        // "Original size" = the clip's own resolution; a bigger size is a paid upscale that downloads nothing
        if (!(await clickRole('originalSize', undefined, { optional: true }))) continue;
        let size = 0;
        for (let i = 0; i < 40 && !size; i++) { await sleep(1500); size = await libSafe(0, 'blobSize'); }
        if (!size) continue;
        const parts = [];
        for (let off = 0; off < size; off += 400_000) parts.push(Buffer.from(await lib('blobChunk', off, 400_000), 'base64'));
        return { buffer: Buffer.concat(parts), contentType: await libSafe('', 'blobType') };
      }
      return null;
    } finally {
      await navigate(`${FLOW_HOME}project/${projectId}`);
    }
  }

  const okBytes = (g) => !!(g && g.buffer && g.buffer.length && !/text\/html/.test(g.contentType || ''));

  async function fetchMedia(m) {
    let got = null;
    if (m.url) {
      got = await loadResource(m.url).catch(() => null);
      if (!okBytes(got)) got = await pullBytes(await page(), m.url).catch(() => null);
    }
    if (!okBytes(got) && m.tile) got = await pullBytes(await page(), m.tile).catch(() => null); // same-origin thumbnail (may be downscaled)
    if (!okBytes(got) && m.mediaId) {
      const pid = m.projectId || (st.ops.get(m.mediaId) || {}).projectId || st.projectId;
      if (pid) got = await uiDownload(pid, m.mediaId).catch(() => null);
    }
    return okBytes(got) ? got : null;
  }

  /**
   * Save an image/clip: the object from generateImages/waitVideo, a URL, or a media id.
   * Order: signed URL (fast) → Flow's own Download menu (works when the signed URL answers 403).
   */
  function download(media, outPath) {
    const m = typeof media === 'string' ? (/^https?:/i.test(media) ? { url: media } : { mediaId: media }) : (media || {});
    return exclusive(async () => {
      const got = await fetchMedia(m);
      if (!got) throw new FlowError('FLOW_BAD_RESPONSE', `download failed (${m.mediaId || m.url || '?'})`);
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, got.buffer);
      return { path: outPath, bytes: got.buffer.length, contentType: got.contentType };
    });
  }

  /**
   * The safe default (how the newest production code runs): submit → wait → download as ONE job
   * holding the tab, so no other job can grab this result.
   */
  function makeVideo(opts, outPath, waitOpts) {
    return exclusive(async () => {
      const op = await submitVideo(opts || {});
      try {
        const done = await waitVideoInner(op, waitOpts);
        const got = await fetchMedia(done);
        if (!got) throw new FlowError('FLOW_BAD_RESPONSE', `clip ${done.mediaId} rendered but could not be downloaded`);
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        fs.writeFileSync(outPath, got.buffer);
        return { path: outPath, bytes: got.buffer.length, mediaId: done.mediaId, projectId: op.projectId, cost: op.cost, modelLabel: op.modelLabel };
      } catch (e) { throw submittedErr(e); }
    });
  }

  // ── status / close ──
  async function status() {
    try {
      // right after Chrome launches the tab is still about:blank / mid-redirect (live 22/10/2026: a fresh
      // launch answered loggedIn:false) → wait until the page settled on flow (token) or /about (signed out)
      let w = await lib('where').catch(() => ({ url: '' }));
      for (let i = 0; i < 30 && !(FLOW_TAB_RE.test(w.url || '') && (w.token || w.signedOut)); i++) {
        await sleep(1000);
        w = await lib('where').catch(() => w);
      }
      const loggedIn = !!(w.token && FLOW_TAB_RE.test(w.url) && !w.signedOut);
      return { loggedIn, email: w.email || '', url: w.url, projectId: w.project || st.projectId || '', port: st.port };
    } catch (e) {
      return { loggedIn: false, error: String(e && e.message || e) };
    }
  }

  async function close({ closeBrowser = false } = {}) {
    try { st.client && st.client.close(); } catch (_) {}
    st.client = null;
    if (closeBrowser) await closeProfileChrome(o.profileDir).catch(() => undefined);
  }

  return {
    profileDir: o.profileDir,
    status, getCredits, generateImages, generateVideo, waitVideo, makeVideo, download, close,
    ensureProject, rpc, // low-level
  };
}

module.exports = { createFlowClient, FlowError, VIDEO_MODELS, IMAGE_MODELS, RPC, parseBatch, contentUrls };
