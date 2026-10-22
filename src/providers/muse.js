'use strict';
/**
 * Muse (muse.ai — Meta's personal AI agent) image + image→video generation by driving a REAL
 * Chrome profile over CDP. Muse has NO public API: we type into the chat, wait for a NEW
 * <img>/<video> after our own message bubble, then fetch its blob: URL inside the page.
 *
 * Battle-tested in production (thousands of scenes). Every constant below was measured; read
 * skills/ai-media-batch/references/muse.md before changing timings.
 *
 *   const muse = createMuse({ profileDir: 'D:/profiles/muse1' });
 *   const img = await muse.generateImage({ prompt: 'A red fox in snow', aspect: '16:9' });
 *   fs.writeFileSync('fox.webp', img.buffer);
 *   const clip = await muse.generateVideo({ prompt: 'The fox turns its head', refs: [] }); // animates image above
 *
 * One instance = one profile = one Muse account. Requests on one instance are serialized
 * (one Muse account keeps ONE live session). Run several instances (different accounts) in parallel.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
  CdpClient, getJson, sleep, keepAlive, openBackgroundTab, closeTarget, setFileInput, attachViaChooser,
} = require('../core/cdp');
const { ensureProfileChrome } = require('../core/chrome');
const { hideWindow } = require('../core/window');
const { withProfileLock } = require('../core/profile-lock');

const MUSE_URL = 'https://muse.ai/';
const MUSE_HOST_RE = /(^|\/\/)([^/]*\.)?muse\.ai(\/|$)/i;

const DEFAULT_IMAGE_TIMEOUT = 900_000; // 16:9 ~25-70s, 9:16 (1152x2048) measured >7 min
const DEFAULT_VIDEO_TIMEOUT = 480_000; // 16:9 clips 41-148s, 9:16 ~2-3 min
const CHUNK = 400_000;                 // bytes per base64 chunk when pulling media out of the page

// Muse VM asleep → /api/hatch/vm/wake can keep "Connecting…" for ~5 min. Anything < 6 min = false alarm.
const STUCK_CONNECTING_MS = 360_000;
const STUCK_SEND_MS = 150_000;         // "still sending" this long → reload + resend once
const REVIVE_RELOAD_MS = 90_000;       // stuck connecting → reload page
const REVIVE_REOPEN_MS = 240_000;      //                  → close tab, open a fresh one
const REVIVE_RESTART_MS = 420_000;     //                  → close every tab (Chrome exits) and relaunch
const READY_STABLE = 6;                // composer shows BEFORE the "Connecting" chip: require 6 reads × 1.5 s
const NO_CHIP_GRACE_MS = 60_000;       // no status chip at all for 60 s → accept (UI wording changed)
const FACELESS_MS = 6 * 3600 * 1000;   // remember "faceless" prompts per account after a face refusal

class MuseError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'MuseError'; }
}

// ── page scripts ──────────────────────────────────────────────────────────────
// innerText is '' when the window is not painted; fall back to textContent of <main>.
const JS_TEXT = `
  function __mText() {
    var t = (document.body && document.body.innerText) || "";
    if (t) return t;
    var m = document.querySelector("main") || document.body;
    return (m && m.textContent) || "";
  }
`;

// Read the status CHIP only (leaf element, <= 28 chars). Scanning the whole page breaks as soon
// as a prompt contains "connecting"/"processing". Chip text is e.g. "<Agent> is connecting".
const JS_STATUS = `
  function __mStatus() {
    var out = { connecting: false, connected: false, busy: false, sending: false };
    var nodes = document.querySelectorAll('span,div,p,li,button');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.children.length) continue;
      var s = (el.textContent || '').trim();
      if (!s || s.length > 28) continue;
      if (/(đang kết nối|connecting)/i.test(s)) out.connecting = true;
      else if (/(đã kết nối|connected)/i.test(s)) out.connected = true;
      else if (/(vẫn đang gửi|chưa xác nhận|không xác nhận|still sending|unconfirmed|not confirmed)/i.test(s)) out.sending = true;
      else if (/(đang xử lý|processing)/i.test(s)) out.busy = true;
    }
    return out;
  }
`;

const JS_STATE = `(() => {
  ${JS_TEXT}
  ${JS_STATUS}
  const t = __mText();
  const f = __mStatus();
  return {
    composer: !!document.querySelector("textarea"),
    connecting: f.connecting && !f.connected,
    connected: f.connected,
    login: /Log in or create an account|Đăng nhập hoặc tạo tài khoản/i.test(t),
    len: t.length
  };
})()`;

const JS_BUSY = `(() => { ${JS_STATUS} const f = __mStatus(); return f.busy || f.sending || f.connecting; })()`;

// Account identity: ONLY storage / __NEXT_DATA__, never page text (chat content may contain emails).
const JS_ACCOUNT = `(() => {
  try {
    const re = /[\\w.+-]+@[\\w-]+\\.[\\w.-]{2,}/;
    const bag = [];
    try { bag.push(JSON.stringify(window.__NEXT_DATA__ || null)); } catch (e) {}
    for (const st of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          if (!/user|account|profile|auth|me\\b|session/i.test(k)) continue;
          bag.push(String(st.getItem(k) || '').slice(0, 4000));
        }
      } catch (e) {}
    }
    for (const t of bag) { const m = t && t.match(re); if (m) return m[0].toLowerCase(); }
    return null;
  } catch (e) { return null; }
})()`;

// "Seen" = attribute AND src set: the chat list is virtualized, old images get re-mounted as new
// elements without the attribute and would be mistaken for fresh results.
const JS_SEEN = `
  function __mSeenSet() { return window.__mSeenSrc || (window.__mSeenSrc = new Set()); }
  function __mIsSeen(el) {
    if (el.hasAttribute("data-m-seen")) return true;
    const u = el.currentSrc || el.src || "";
    return !!u && __mSeenSet().has(u);
  }
  function __mMarkSeen(el) {
    el.setAttribute("data-m-seen", "1");
    const u = el.currentSrc || el.src || "";
    if (u) __mSeenSet().add(u);
  }
`;
const JS_MARK_SEEN = `(() => { ${JS_SEEN} const n = document.querySelectorAll("img, video"); n.forEach(__mMarkSeen); return n.length; })()`;

// Muse always honours aspect (16:9 → 2048×1152, 9:16 → 1152×2048): a wrong-shaped image is an OLD one.
const JS_SHAPE = `
  function __mShapeOk(w, h, orient) {
    if (!orient || !w || !h) return true;
    const r = w / h;
    if (orient === 'landscape') return r > 1.1;
    if (orient === 'portrait') return r < 0.9;
    if (orient === 'square') return r >= 0.9 && r <= 1.1;
    return true;
  }
`;

// Message cells AFTER the bubble containing our prompt. Each message is a sibling DIV in one list;
// the 720×720 avatar video lives in a different (sidebar) branch. Use the LAST occurrence: a retried
// prompt already exists earlier in the history.
const JS_SCOPE_AFTER = `
  function __mScopeAfter(needle) {
    if (!needle) return null;
    var leaf = null;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      var n = w.currentNode;
      if (n.children.length === 0 && n.textContent && n.textContent.indexOf(needle) >= 0) leaf = n;
    }
    if (!leaf) return null;
    var cell = leaf;
    while (cell.parentElement && cell.parentElement !== document.body && cell.parentElement.children.length < 8) cell = cell.parentElement;
    if (!cell.parentElement) return null;
    var sibs = Array.prototype.slice.call(cell.parentElement.children);
    var i = sibs.indexOf(cell);
    return i < 0 ? null : sibs.slice(i + 1);
  }
`;

const JS_NEW_CHAT = `(() => {
  const RX = /(đoạn|cuộc)\\s*(chat|trò chuyện|hội thoại)\\s*mới|chat\\s*mới|new\\s*(chat|conversation|thread)/i;
  const els = Array.from(document.querySelectorAll('a, button, [role=button], [role=menuitem]'));
  const hit = els.find(e => {
    const s = [e.getAttribute('aria-label'), e.getAttribute('title'), e.innerText].filter(Boolean).join(' ').trim();
    return s && s.length < 60 && RX.test(s) && e.offsetParent !== null;
  });
  if (!hit) return { ok: false };
  const before = location.href;
  hit.click();
  return { ok: true, before };
})()`;

const JS_FILE_INPUT = `(() => { const a = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled); return a.length ? a[a.length - 1] : null; })()`;

// Muse clears input.files after reading → accept any of 3 signals.
const jsAttached = (names) => `(() => {
  const inp = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled).pop();
  const files = inp && inp.files ? inp.files.length : 0;
  const ta = document.querySelector('textarea');
  const box = (ta && (ta.closest('form') || (ta.parentElement && ta.parentElement.parentElement))) || document.body;
  const prev = box.querySelectorAll('img[src^="blob:"],img[src^="data:"]').length;
  const txt = box.innerText || '';
  const named = ${JSON.stringify(names)}.some(n => txt.indexOf(n) >= 0);
  return { files, prev, named };
})()`;

// The paperclip ("Đính kèm file" / "Attach file"); it may open a small menu first.
const JS_ATTACH_BUTTON = `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => { const a = (x.getAttribute('aria-label') || '').toLowerCase(); return a === 'đính kèm file' || a === 'attach file' || a.indexOf('attach') === 0 || a.indexOf('đính kèm') === 0 }); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`;
const JS_UPLOAD_ITEM = `(() => { const re = /tải lên|tải tệp|từ máy|upload|from (your )?(computer|device)|chọn tệp|choose file/i; const e = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] button, [role="dialog"] button')).find((x) => re.test(x.innerText || x.getAttribute('aria-label') || '')); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`;

// The textarea is NOT inside a <form>: set value via the native setter (React) and fire Enter keys.
function jsSend(text) {
  return `(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return "no-textarea";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    ta.focus();
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const key = k => new KeyboardEvent(k, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true });
    setTimeout(() => { ta.dispatchEvent(key("keydown")); ta.dispatchEvent(key("keypress")); ta.dispatchEvent(key("keyup")); }, 250);
    return "ok";
  })()`;
}

// Fallback attach (does NOT work on current muse.ai UI, kept for UI changes).
function jsAttachDataTransfer(refs) {
  return `(async () => {
    const inp = [...document.querySelectorAll("input[type=file]")].filter(i => !i.disabled).pop();
    if (!inp) return "no-file-input";
    const dt = new DataTransfer();
    for (const r of ${JSON.stringify(refs)}) {
      const bin = atob(r.b64); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      dt.items.add(new File([u], r.name, { type: r.mime }));
    }
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  })()`;
}

function sentLinesOf(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 4);
}

/** Poll state: is a NEW media ready after our bubble? Also detects refusal / face question / stuck send. */
/** Extra filter for <video>: optional duration window (a whole MV must not be taken for one of its scenes). */
function durOk(v, minDur, maxDur) {
  return (minDur ? ` && ${v}.duration >= ${minDur}` : '') + (maxDur ? ` && ${v}.duration <= ${maxDur}` : '');
}

function jsWaitNewAfter(tag, needle, sentText, orient, minDur = 0, maxDur = 0) {
  const dim = tag === 'video' ? ['videoWidth', 'videoHeight'] : ['naturalWidth', 'naturalHeight'];
  const mine = JSON.stringify(sentLinesOf(sentText));
  return `(() => {
    ${JS_SCOPE_AFTER} ${JS_TEXT} ${JS_STATUS} ${JS_SEEN} ${JS_SHAPE}
    const ORIENT = ${JSON.stringify(tag === 'img' ? (orient || '') : '')};
    const NL = String.fromCharCode(10);
    const MINE = ${mine};
    const isMine = (l) => { const s = l.trim().replace(/(…|[.][.][.])$/, ''); return !s || MINE.some(m => m === s || (s.length >= 20 && m.indexOf(s) === 0)); };
    const t = __mText();
    const f = __mStatus();
    const cells = __mScopeAfter(${JSON.stringify(needle)});
    let wrongShape = 0;
    const fresh = (el) => {
      if (__mIsSeen(el)) return false;
      if (el.${dim[0]} > 0 && !__mShapeOk(el.${dim[0]}, el.${dim[1]}, ORIENT)) { __mMarkSeen(el); wrongShape++; return false; }
      return true;
    };
    const list = Array.from(document.querySelectorAll("${tag}")).filter(fresh);
    const after = cells ? cells.flatMap(c => Array.from(c.querySelectorAll("${tag}"))).filter(el => list.indexOf(el) >= 0) : [];
    for (const el of after) if (el.${dim[0]} > 0${tag === 'video' ? ' && el.videoWidth !== el.videoHeight' + durOk('el', minDur, maxDur) : ''}) return { ready: true, w: el.${dim[0]}, h: el.${dim[1]} };
    const replyText = cells ? cells.map(c => c.innerText || c.textContent || '').join(NL).split(NL).filter(l => !isMine(l)).join(NL) : '';
    return {
      ready: false,
      anchored: !!cells,
      wrongShape,
      // 720x720 square video = Muse's built-in avatar, never our clip
      anyReady: list.some(el => el.${dim[0]} > 0${tag === 'video' ? ' && el.videoWidth !== el.videoHeight' + durOk('el', minDur, maxDur) : ''}),
      busy: f.busy || f.sending,
      stuck: f.sending || (f.connecting && !f.connected),
      faceAsk: !!cells && /(mặt|gương mặt)[^.!?]{0,40}(ảnh thật|người thật)|không thấy rõ mặt|real (person|people|face)|identifiable (person|people|face)/i.test(replyText.slice(-800)),
      refused: (() => {
        const src = cells ? replyText : t.slice(-600).split(NL).filter(l => !isMine(l)).join(NL);
        if (/không thể tạo|can't create|cannot create|vi phạm|policy/i.test(src.slice(-600))) return true;
        // "done!" without media — only trusted when anchored (the task panel holds old failures)
        return !!cells && /không tìm thấy (video|ảnh|hình)|couldn't find the (video|image)|không tạo được/i.test(src.slice(-600));
      })()
    };
  })()`;
}

function jsLoadBuf(tag, needle, orient, minDur = 0, maxDur = 0) {
  const dim = tag === 'video' ? 'videoWidth' : 'naturalWidth';
  return `(async () => {
    ${JS_SCOPE_AFTER} ${JS_SEEN} ${JS_SHAPE}
    const ORIENT = ${JSON.stringify(tag === 'img' ? (orient || '') : '')};
    const cells = __mScopeAfter(${JSON.stringify(needle)});
    const list = (cells ? cells.flatMap(c => Array.from(c.querySelectorAll("${tag}"))) : Array.from(document.querySelectorAll("${tag}")))
      .filter(e => !__mIsSeen(e) && e.${dim} > 0${tag === 'video' ? ' && e.videoWidth !== e.videoHeight' + durOk('e', minDur, maxDur) : ''}
        && (${tag === 'img' ? '__mShapeOk(e.naturalWidth, e.naturalHeight, ORIENT)' : 'true'}));
    const el = list[0];
    if (!el) return null;
    const res = await fetch(el.currentSrc || el.src);
    const blob = await res.blob();
    window.__mBuf = new Uint8Array(await blob.arrayBuffer());
    __mMarkSeen(el);
    return { bytes: window.__mBuf.length, type: blob.type, w: el.${dim}, h: el.${tag === 'video' ? 'videoHeight' : 'naturalHeight'} };
  })()`;
}
function jsReadChunk(off) {
  return `(() => { const u = window.__mBuf; let s = ""; const end = Math.min(${off + CHUNK}, u.length);
    for (let i = ${off}; i < end; i++) s += String.fromCharCode(u[i]); return btoa(s); })()`;
}

function orientOf(aspect) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect || ''));
  if (!m) return '';
  const r = Number(m[1]) / Number(m[2]);
  return r > 1.1 ? 'landscape' : r < 0.9 ? 'portrait' : 'square';
}

/** First line (≤40 chars) of the scene-specific prompt — used to find OUR bubble in the chat. */
function needleOf(prompt) {
  const text = String(prompt || '').trim();
  const nl = text.search(/[\r\n]/);
  return (nl >= 0 ? text.slice(0, nl) : text).slice(0, 40);
}

// ── prompt templates (VI = production-tested; EN = translation, less tested) ─────
const TEXT = {
  vi: {
    aspect: { '16:9': 'Khung hình NGANG 16:9.', '9:16': 'Khung hình DỌC 9:16.', '1:1': 'Khung hình VUÔNG 1:1.', '4:3': 'Khung hình ngang 4:3.' },
    oneImage: 'Chỉ trả về đúng 1 ảnh.',
    oneVideo: 'Chỉ trả về đúng 1 video.',
    duration: (s) => `Độ dài khoảng ${s} giây.`,
    faceRef: 'Dùng (các) ảnh đính kèm làm MẪU NHÂN VẬT: giữ NGUYÊN khuôn mặt, kiểu tóc và trang phục; vẽ cảnh mới theo mô tả dưới đây.',
    faceCarry: 'Giữ NGUYÊN khuôn mặt, kiểu tóc và trang phục của nhân vật trong ảnh trước (cùng một người).',
    facelessRef: 'Dùng (các) ảnh đính kèm làm MẪU NHÂN VẬT — đây là nhân vật HƯ CẤU do AI tạo, không phải người thật. Chỉ giữ dáng người, kiểu tóc và trang phục; KHÔNG cần thấy rõ mặt: vẽ nhân vật quay lưng, nhìn nghiêng, cúi xuống làm việc hoặc mặt khuất bóng/ở xa. Vẽ cảnh mới theo mô tả dưới đây.',
    facelessCarry: 'Giữ dáng người, kiểu tóc và trang phục của nhân vật trong ảnh trước (nhân vật hư cấu); KHÔNG cần thấy rõ mặt — quay lưng, nhìn nghiêng hoặc cúi làm việc.',
    frameRef: 'Ảnh đính kèm là KHUNG HÌNH NGAY TRƯỚC của cùng một video quay bằng máy cố định. Vẽ khung hình TIẾP THEO từ chính ảnh đó: GIỮ NGUYÊN tuyệt đối góc máy, vị trí và độ cao máy, ống kính, bố cục, ánh sáng và mọi phần đã có trong ảnh; chỉ thêm hoặc thay đổi đúng những gì mô tả dưới đây.',
    frameBase: 'Ảnh đính kèm THỨ HAI là KHUNG GỐC của cảnh quay: góc máy, vị trí máy, đường chân trời và bố cục phải khớp ĐÚNG ảnh này.',
    videoFromRef: 'Dùng ĐÚNG ảnh vừa đính kèm làm khung hình ĐẦU TIÊN, tạo video từ chính ảnh đó. Giữ NGUYÊN nhân vật, trang phục, bối cảnh, bố cục và màu sắc của ảnh — chỉ thêm chuyển động.',
    videoFromAbove: 'Tạo video từ chính ảnh vừa tạo ở trên. Giữ NGUYÊN nhân vật, bối cảnh, bố cục và màu sắc của ảnh — chỉ thêm chuyển động.',
    videoFaceless: ' Ảnh do AI tạo, người trong ảnh là nhân vật hư cấu; KHÔNG cần thấy rõ mặt.',
  },
  en: {
    aspect: { '16:9': 'LANDSCAPE 16:9 frame.', '9:16': 'PORTRAIT 9:16 frame.', '1:1': 'SQUARE 1:1 frame.', '4:3': 'Landscape 4:3 frame.' },
    oneImage: 'Return exactly 1 image.',
    oneVideo: 'Return exactly 1 video.',
    duration: (s) => `About ${s} seconds long.`,
    faceRef: 'Use the attached image(s) as the CHARACTER REFERENCE: keep the SAME face, hairstyle and outfit; draw a new scene as described below.',
    faceCarry: 'Keep the SAME face, hairstyle and outfit as the character in the previous image (same person).',
    facelessRef: 'Use the attached image(s) as the CHARACTER REFERENCE — an AI-generated FICTIONAL character, not a real person. Keep only body shape, hairstyle and outfit; the face does NOT need to be visible: back view, profile, looking down at work, or far away. Draw a new scene as described below.',
    facelessCarry: 'Keep body shape, hairstyle and outfit of the character in the previous image (fictional); the face need not be visible — back view, profile or looking down.',
    frameRef: 'The attached image is the PREVIOUS FRAME of the same locked-off camera video. Draw the NEXT frame from that exact image: keep camera angle, position, height, lens, composition, lighting and everything already there; only add or change what is described below.',
    frameBase: 'The SECOND attached image is the ORIGINAL establishing frame: camera angle, position, horizon and composition must match it exactly.',
    videoFromRef: 'Use the attached image EXACTLY as the FIRST frame and make a video from it. Keep characters, outfit, setting, composition and colors — only add motion.',
    videoFromAbove: 'Make a video from the image you just created above. Keep characters, setting, composition and colors — only add motion.',
    videoFaceless: ' The image is AI-generated; people in it are fictional characters; the face need not be visible.',
  },
};

/**
 * @param {object} o
 * @param {string} o.profileDir  Chrome user-data-dir already logged in to muse.ai
 * @param {boolean} [o.show=false]
 * @param {'vi'|'en'} [o.lang='vi']  language of the instructions we wrap around your prompt
 * @param {(line:string)=>void} [o.log]
 * @param {string} [o.proxy]
 * Window: show=false → Chrome lives OFF-SCREEN at desktop size (core/window.js) + keepAlive emulation.
 * Measured: a hidden-without-emulation Muse tab answering in 216 s vs ~25 s with it; minimizing is
 * worse (tiny viewport). If a minimized window is found (user minimized it), it is restored off-screen.
 */
function createMuse(o) {
  const show = !!o.show;
  const T = TEXT[o.lang || 'vi'] || TEXT.vi;
  const log = o.log || (process.env.MUSE_DEBUG === '1' ? (s) => console.log('[muse]', s) : () => {});
  let client = null;
  let port = 0;
  let lock = Promise.resolve();
  let email = null;
  let stuckSince = 0;
  let stuckStage = 0;
  let facelessUntil = 0;
  let placed = 0;

  // in-process queue + cross-process file lock in the profile dir (another app/script on the same account)
  function withLock(fn) {
    const guarded = () => withProfileLock(o.profileDir, 'muse', 'muse job', fn, { log });
    const next = lock.then(guarded, guarded);
    lock = next.then(() => undefined, () => undefined);
    return next;
  }

  function dropTab() { if (client) { try { client.close(); } catch (_) {} } client = null; }

  async function renderable(c) {
    await keepAlive(c);
    try {
      const w = await c.send('Browser.getWindowForTarget', {});
      if (w && w.bounds && w.bounds.windowState === 'minimized') {
        await c.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
        if (!show) await hideWindow(c); // a minimized window is not painted at all → back off-screen instead
      }
    } catch (_) {}
  }

  async function ensureTab() {
    if (client) {
      const alive = await Promise.race([client.evaluate('1+1').catch(() => -1), sleep(4000).then(() => -1)]);
      if (alive === 2) return client;
      dropTab();
    }
    port = await ensureProfileChrome({ profileDir: o.profileDir, offscreen: !show, proxy: o.proxy });
    for (let attempt = 0; attempt < 20; attempt++) {
      const list = (await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])) || [];
      const tabs = list.filter((t) => t.type === 'page' && MUSE_HOST_RE.test(String(t.url || '')));
      // TWO muse.ai tabs of one account = the client cancels /api/hatch/token and hangs forever.
      if (tabs.length > 1) {
        log(`found ${tabs.length} muse.ai tabs — keeping one`);
        for (const extra of tabs.slice(1)) await closeTarget(port, extra.id);
        await sleep(1200);
        continue;
      }
      const tab = tabs[0];
      if (tab && tab.webSocketDebuggerUrl) {
        const c = new CdpClient();
        if (await c.connect(tab.webSocketDebuggerUrl)) {
          await c.send('Page.enable').catch(() => undefined);
          await c.send('Runtime.enable').catch(() => undefined);
          client = c;
          if (!show && placed !== port) { placed = port; await hideWindow(c); } // once per launch: user may move it back to watch
          return c;
        }
      }
      if (!tab) await openBackgroundTab(port, MUSE_URL);
      await sleep(800);
    }
    throw new MuseError('MUSE_BRIDGE_UNAVAILABLE', 'Cannot open/attach a muse.ai tab.');
  }

  function clearStuck() { stuckSince = 0; stuckStage = 0; }

  /** Escalating self-heal while "Connecting…": reload → reopen tab → restart Chrome. */
  async function reviveStuck(c) {
    const now = Date.now();
    if (!stuckSince) { stuckSince = now; stuckStage = 0; }
    const waited = now - stuckSince;
    if (stuckStage < 1 && waited > REVIVE_RELOAD_MS) {
      stuckStage = 1;
      log(`stuck connecting ${Math.round(waited / 1000)}s → reload`);
      try { await c.send('Page.reload', {}); await sleep(5000); await renderable(c); } catch (_) {}
      return c;
    }
    if (stuckStage < 2 && waited > REVIVE_REOPEN_MS) {
      stuckStage = 2;
      log(`still stuck ${Math.round(waited / 1000)}s → reopen tab`);
      try {
        if (client && client.targetId) await closeTarget(port, client.targetId);
        dropTab();
        const fresh = await ensureTab(); await renderable(fresh); return fresh;
      } catch (_) {}
    }
    if (stuckStage < 3 && waited > REVIVE_RESTART_MS) {
      stuckStage = 3;
      stuckSince = Date.now();
      log(`stuck ${Math.round(waited / 1000)}s → restart Chrome of this profile`);
      try {
        const list = (await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])) || [];
        for (const t of list.filter((x) => x.type === 'page')) await closeTarget(port, t.id); // last tab closed → Chrome exits
        dropTab();
        await sleep(8000);
        const fresh = await ensureTab(); await renderable(fresh); return fresh;
      } catch (_) {}
    }
    return c;
  }

  async function waitReady(c, timeoutMs = 420_000) {
    const started = Date.now();
    let last = null;
    let held = 0;
    while (Date.now() < started + timeoutMs) {
      const s = await c.evaluate(JS_STATE).catch(() => null);
      last = s;
      if (s && s.login) throw new MuseError('MUSE_AUTH', 'Not logged in to muse.ai in this profile.');
      if (s && s.composer && !s.connecting && (s.connected || Date.now() - started > NO_CHIP_GRACE_MS)) {
        if (++held >= READY_STABLE) { clearStuck(); return c; }
        await sleep(1500);
        continue;
      }
      held = 0;
      if (s && s.connecting) c = await reviveStuck(c);
      if (s && s.composer && s.connecting && Date.now() - started > STUCK_CONNECTING_MS) {
        throw new MuseError('MUSE_SESSION_TAKEN',
          'Logged in but realtime channel never connects. One Muse account keeps ONE session: it was probably opened in another Chrome profile.');
      }
      await sleep(1500);
    }
    throw new MuseError('MUSE_NETWORK', `Muse not connected after ${Math.round(timeoutMs / 1000)}s (${JSON.stringify(last)})`);
  }

  async function waitIdle(c, timeoutMs = 180_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!(await c.evaluate(JS_BUSY).catch(() => false))) return true;
      await sleep(3000);
    }
    return false;
  }

  async function startNewChat(c) {
    const r = await c.evaluate(JS_NEW_CHAT).catch(() => null);
    if (!r || !r.ok) { log('new-chat button not found — continuing in current chat'); return false; }
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      await sleep(1000);
      const st = await c.evaluate(`({ href: location.href, ta: !!document.querySelector('textarea') })`).catch(() => null);
      if (st && st.ta && st.href !== r.before) break;
    }
    await sleep(1500);
    await c.evaluate(JS_MARK_SEEN).catch(() => undefined);
    return true;
  }

  /** refs: [{path}] or [{b64, mime}] → written to temp files, attached via DOM.setFileInputFiles. */
  async function attachRefs(c, refs) {
    const tmp = [];
    const list = refs.map((r, i) => {
      if (r.path) return { path: r.path, b64: fs.readFileSync(r.path).toString('base64'), mime: r.mime || mimeOf(r.path), name: path.basename(r.path) };
      const ext = String(r.mime || '').includes('webp') ? 'webp' : String(r.mime || '').includes('jp') ? 'jpg' : 'png';
      const p = path.join(os.tmpdir(), `mref${i + 1}_${Date.now()}.${ext}`);
      fs.writeFileSync(p, Buffer.from(String(r.b64 || ''), 'base64'));
      tmp.push(p);
      return { path: p, b64: String(r.b64 || ''), mime: r.mime || 'image/png', name: path.basename(p) };
    });
    const names = list.map((f) => f.name);
    const attached = async () => { const st = await c.evaluate(jsAttached(names)).catch(() => null); return !!(st && (st.files > 0 || st.prev > 0 || st.named)); };
    const settle = async (ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await attached()) return true; await sleep(1000); } return false; };
    let ok = false;
    // 1) click the real paperclip + intercept the native file chooser, one file per click (works for images + mp3)
    try {
      let how = '';
      for (const f of list) how = await attachViaChooser(c, [f.path], { buttonExpr: JS_ATTACH_BUTTON, menuItemExpr: JS_UPLOAD_ITEM });
      ok = await settle(20_000);
      // audio has no preview and Muse clears input.files: a real chooser hit is good enough
      if (!ok && how === 'chooser') { await sleep(4000); ok = true; }
      log('attach via ' + how + ' → ' + ok);
    } catch (e) { log('attach via chooser: ' + e.message); }
    // 2) DOM.setFileInputFiles on the last <input type=file> (older production path)
    if (!ok) { try { await setFileInput(c, JS_FILE_INPUT, list.map((f) => f.path)); ok = await settle(20_000); } catch (e) { log('setFileInputFiles: ' + e.message); } }
    if (!ok) {
      const att = await c.evaluate(jsAttachDataTransfer(list)).catch((e) => 'err:' + e.message);
      ok = att === 'ok' && (await settle(15_000));
    }
    if (!ok) {
      cleanup(tmp);
      // Better fail than send: without the image Muse invents a clip and burns weekly quota.
      throw new MuseError('MUSE_ATTACH_FAILED', 'Could not attach reference image (muse.ai UI may have changed). Prompt NOT sent.');
    }
    await sleep(1500);
    return tmp;
  }

  // SHA-1 of every media taken from this profile, persisted: the virtualized chat re-draws an OLD clip as a
  // new element and plan B took it (measured 08/10/2026: a re-asked part came back byte-identical in 93 s).
  const seenFile = path.join(o.profileDir, '.mbk-muse-seen.json');
  function rememberMedia(buf) {
    let seen = [];
    try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch (_) {}
    const sha = crypto.createHash('sha1').update(buf).digest('hex');
    if (seen.includes(sha)) return false;
    try { fs.writeFileSync(seenFile, JSON.stringify([...seen, sha].slice(-2000))); } catch (_) {}
    return true;
  }

  /** @returns media, or null when it is a byte-identical copy of something taken before (keep waiting) */
  async function pullMedia(c, tag, needle, orient, minDur, maxDur) {
    const meta = await c.evaluate(jsLoadBuf(tag, needle, orient, minDur, maxDur));
    if (!meta || !meta.bytes) throw new MuseError('MUSE_BAD_RESPONSE', 'Cannot read media bytes from page.');
    const parts = [];
    for (let off = 0; off < meta.bytes; off += CHUNK) {
      const b64 = await c.evaluate(jsReadChunk(off));
      if (typeof b64 !== 'string') throw new MuseError('MUSE_BAD_RESPONSE', 'Lost a chunk while pulling media.');
      parts.push(Buffer.from(b64, 'base64'));
    }
    await c.evaluate('delete window.__mBuf').catch(() => undefined);
    const buffer = Buffer.concat(parts);
    if (buffer.length !== meta.bytes) throw new MuseError('MUSE_BAD_RESPONSE', `Short read ${buffer.length}/${meta.bytes}`);
    if (!rememberMedia(buffer)) { log(`skipped a ${tag} taken before (old message re-drawn)`); return null; }
    return { buffer, contentType: meta.type || (tag === 'video' ? 'video/mp4' : 'image/webp'), width: meta.w, height: meta.h };
  }

  async function runOne(tag, body) {
    let c = await ensureTab();
    await renderable(c);
    c = await waitReady(c);
    c = await ensureTab(); // waitReady may have reopened the tab
    let tmpRefs = [];
    const hasRefs = Array.isArray(body.refs) && body.refs.length > 0;
    try {
      if (body.newChat) { await waitIdle(c); await startNewChat(c); }
      if (hasRefs) tmpRefs = await attachRefs(c, body.refs);
      // An older request may still deliver media AFTER our prompt → wait idle before marking/sending.
      await waitIdle(c);
      const pre = await c.evaluate(JS_STATE).catch(() => null);
      if (pre && pre.connecting) { // session dropped while attaching → message would be lost
        c = await waitReady(c);
        const cur = await ensureTab();
        if (cur !== c) { c = cur; if (hasRefs) { cleanup(tmpRefs); tmpRefs = await attachRefs(c, body.refs); } }
      }
      await c.evaluate(JS_MARK_SEEN);
      const sent = await c.evaluate(jsSend(body.text));
      if (sent !== 'ok') throw new MuseError('MUSE_BAD_RESPONSE', 'Cannot type prompt: ' + sent);

      const timeoutMs = body.timeoutMs || (tag === 'video' ? DEFAULT_VIDEO_TIMEOUT : DEFAULT_IMAGE_TIMEOUT);
      const until = Date.now() + timeoutMs;
      let last = null; let idleSince = 0; let refusedSince = 0; let sawBusy = false; let stuckAt = 0; let resent = 0;
      await sleep(4000);
      while (Date.now() < until) {
        const st = await c.evaluate(jsWaitNewAfter(tag, body.needle, body.text, body.orient, body.minDur, body.maxDur)).catch(() => null);
        last = st;
        if (st && st.ready) { const got = await pullMedia(c, tag, body.needle, body.orient, body.minDur, body.maxDur); if (got) return got; continue; }
        if (st && st.busy) sawBusy = true;
        // Plan B: virtualized list sometimes renders media BEFORE our bubble. Only after Muse was busy
        // and is now idle >= 15 s with a fresh media present.
        if (sawBusy && st && st.anyReady && !st.busy) {
          if (!idleSince) idleSince = Date.now();
          else if (Date.now() - idleSince > 15_000) {
            idleSince = 0;
            log('taking media via plan B (anchor mismatch)');
            const got = await pullMedia(c, tag, null, body.orient, body.minDur, body.maxDur);
            if (got) return got;
          }
        } else idleSince = 0;
        if (st && st.faceAsk && !st.busy) throw new MuseError('MUSE_FACE_REFUSED', 'Muse refused: reference looks like a real person.');
        if (st && st.refused) { // MV answers often carry a caveat line ("no lip-sync, but…") → optional grace
          refusedSince = refusedSince || Date.now();
          if (Date.now() - refusedSince >= (body.refuseGraceMs || 0)) throw new MuseError('MUSE_MODERATED', 'Muse refused or reported it could not create the media.');
        }
        if (typeof body.shouldAbort === 'function' && body.shouldAbort()) throw new MuseError('MUSE_CANCELLED', 'Cancelled by caller.');
        // Session dropped mid-request ("still sending" forever) → reload + resend ONCE.
        if (st && st.stuck) {
          if (!stuckAt) stuckAt = Date.now();
          else if (Date.now() - stuckAt > STUCK_SEND_MS && resent < 1) {
            resent++; stuckAt = 0;
            log('stuck sending → reload and resend');
            try {
              await c.send('Page.reload', {}); await sleep(5000); await renderable(c);
              c = await waitReady(c); c = await ensureTab();
              if (hasRefs) { cleanup(tmpRefs); tmpRefs = await attachRefs(c, body.refs); }
              await c.evaluate(JS_MARK_SEEN);
              const again = await c.evaluate(jsSend(body.text));
              if (again !== 'ok') throw new Error('retype failed: ' + again);
              sawBusy = false; await sleep(4000);
            } catch (e) { throw new MuseError('MUSE_NETWORK', 'Session dropped and resend failed: ' + e.message); }
          }
        } else stuckAt = 0;
        await sleep(2500);
      }
      // Never trust "done!" text — only a real new <img>/<video> counts.
      throw new MuseError('MUSE_NO_MEDIA', `No ${tag === 'video' ? 'video' : 'image'} after ${Math.round(timeoutMs / 1000)}s (${JSON.stringify(last)})`);
    } finally {
      cleanup(tmpRefs);
    }
  }

  function imageText(body, faceless) {
    const bits = [];
    const hasRefs = Array.isArray(body.refs) && body.refs.length > 0;
    if (body.previousFrame && hasRefs) { bits.push(T.frameRef); if (body.refs.length > 1) bits.push(T.frameBase); }
    else if (hasRefs) bits.push(faceless ? T.facelessRef : T.faceRef);
    else if (body.carryCharacter) bits.push(faceless ? T.facelessCarry : T.faceCarry);
    bits.push(String(body.prompt || '').trim());
    if (body.extra) bits.push(String(body.extra).trim());
    bits.push(T.aspect[body.aspect || '16:9'] || T.aspect['16:9']);
    bits.push(T.oneImage); // one media per message — 4 per message fails
    return bits.filter(Boolean).join('\n');
  }

  /** Retry once with a "faceless" prompt when Muse refuses a photoreal reference face. */
  async function withFaceFallback(hasChar, once) {
    const faceless = facelessUntil > Date.now();
    try { return await once(faceless); } catch (e) {
      if (!(e && e.code === 'MUSE_FACE_REFUSED')) throw e;
      if (faceless || !hasChar) throw new MuseError('MUSE_MODERATED', 'Muse refuses this reference (real-looking face). Use another provider or drop the reference.');
      log('face refusal → retry with faceless prompt (remembered 6h)');
      facelessUntil = Date.now() + FACELESS_MS;
      try { return await once(true); } catch (e2) {
        if (e2 && e2.code === 'MUSE_FACE_REFUSED') throw new MuseError('MUSE_MODERATED', 'Muse refuses this reference even faceless.');
        throw e2;
      }
    }
  }

  return {
    /** @returns {Promise<{connected:boolean, connecting?:boolean, email:string|null}>} */
    status() {
      return withLock(async () => {
        try {
          let c = await ensureTab();
          await renderable(c);
          let s = await c.evaluate(JS_STATE).catch(() => null);
          if (!s || s.login) return { connected: false, email: null };
          if (s.connecting) { const n = await reviveStuck(c); if (n !== c) { c = n; s = await c.evaluate(JS_STATE).catch(() => s); } } else clearStuck();
          if (!email) email = await c.evaluate(JS_ACCOUNT).catch(() => null);
          // A page stuck on "Connecting…" still has a composer — only the "Connected" chip counts.
          return { connected: !!s.composer && !s.connecting && !!s.connected, connecting: !!s.connecting, email };
        } catch (e) {
          if (e && e.code === 'MUSE_AUTH') return { connected: false, email: null };
          throw e;
        }
      });
    },

    /**
     * @param {object} b
     * @param {string} b.prompt
     * @param {string} [b.aspect='16:9']  '16:9' | '9:16' | '1:1' | '4:3'
     * @param {Array<{path?:string,b64?:string,mime?:string}>} [b.refs]  character references
     * @param {boolean} [b.carryCharacter]  keep the character of the previous image in this chat (cheapest consistency)
     * @param {boolean} [b.previousFrame]   refs[0] = previous frame of a locked-off shot, refs[1] = establishing frame
     * @param {boolean} [b.newChat]         start a new conversation (new topic/video)
     * @param {string} [b.extra]            extra instructions appended to the prompt
     * @returns {Promise<{buffer:Buffer, contentType:string, width:number, height:number}>}
     */
    generateImage(b) {
      const hasChar = (Array.isArray(b.refs) && b.refs.length > 0) || !!b.carryCharacter;
      return withLock(() => withFaceFallback(hasChar, (fl) => runOne('img', {
        text: imageText(b, fl), refs: b.refs, needle: needleOf(b.prompt), timeoutMs: b.timeoutMs,
        newChat: !!b.newChat, orient: orientOf(b.aspect || '16:9'), shouldAbort: b.shouldAbort,
      })));
    },

    /**
     * Image → video (~10 s, 1216×672 for 16:9). refs = start image; no refs = animate the latest
     * image in the current chat (i.e. right after generateImage on this instance).
     */
    generateVideo(b) {
      const hasRefs = Array.isArray(b.refs) && b.refs.length > 0;
      return withLock(() => withFaceFallback(true, (fl) => {
        const bits = [(hasRefs ? T.videoFromRef : T.videoFromAbove) + (fl ? T.videoFaceless : ''), String(b.prompt || '').trim()];
        if (b.extra) bits.push(String(b.extra).trim());
        if (b.durationSec) bits.push(T.duration(b.durationSec));
        bits.push(T.oneVideo);
        return runOne('video', {
          text: bits.filter(Boolean).join('\n'), refs: b.refs, needle: needleOf(b.prompt), // no needle = clip never detected
          timeoutMs: b.timeoutMs, newChat: !!b.newChat, shouldAbort: b.shouldAbort,
          minDur: b.minDurationSec, maxDur: b.maxDurationSec, refuseGraceMs: b.refuseGraceMs,
        });
      }));
    },

    /**
     * Send a message VERBATIM (no wrapper text) with any attachments and wait for one media.
     * Music video (measured 05/10/2026): attach the song stretch (mp3) + a scene-by-scene brief →
     * ONE 1280x720 clip whose audio IS the attached mp3 (lag 0 ms), ~20–26 min for 30 s. Muse cannot lip-sync.
     *   muse.ask({ kind: 'video', text: brief, files: [{ path: 'part1.mp3' }], minDurationSec: 28,
     *              timeoutMs: 50 * 60e3, refuseGraceMs: 5 * 60e3 })
     */
    ask(b) {
      return withLock(() => runOne(b.kind === 'img' ? 'img' : 'video', {
        text: String(b.text || ''), refs: b.files, needle: needleOf(b.text), timeoutMs: b.timeoutMs,
        newChat: !!b.newChat, shouldAbort: b.shouldAbort, orient: b.kind === 'img' ? orientOf(b.aspect) : '',
        minDur: b.minDurationSec, maxDur: b.maxDurationSec, refuseGraceMs: b.refuseGraceMs,
      }));
    },

    newChat() { return withLock(async () => { const c = await ensureTab(); await renderable(c); await waitIdle(c); return startNewChat(c); }); },
    close() { dropTab(); },
  };
}

function mimeOf(p) {
  const e = path.extname(p).toLowerCase();
  return { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.mp4': 'video/mp4' }[e] || 'image/png';
}
function cleanup(files) { for (const p of files || []) { try { fs.unlinkSync(p); } catch (_) {} } }

module.exports = { createMuse, MuseError };
// page scripts, exported for offline tests (test/page-scripts.test.js)
module.exports._page = { jsWaitNewAfter, jsLoadBuf, jsReadChunk, jsAttached, jsSend, jsAttachDataTransfer, JS_STATE, JS_BUSY, JS_ACCOUNT, JS_MARK_SEEN, JS_NEW_CHAT, JS_FILE_INPUT, JS_ATTACH_BUTTON, JS_UPLOAD_ITEM };
