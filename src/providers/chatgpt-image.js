'use strict';
/**
 * Generate images through the chatgpt.com web UI in a real, logged-in Chrome profile (CDP).
 *
 *   const { createChatGptImage } = require('./chatgpt-image');
 *   const gpt = createChatGptImage({ profileDir: 'D:/profiles/gpt1' });
 *   const { buffer, contentType } = await gpt.generateImage({ prompt: 'a red fox in snow', aspect: '16:9' });
 *
 * mode 'api' (option): files upload → /backend-api/conversation → poll for the tool's asset pointer →
 * files/download, all as fetch() inside the tab (see runApi / chatgpt-backend.js).
 *
 * mode 'ui' (default) flow: fresh chat → (attach refs with DOM.setFileInputFiles) → baseline of images already on the page →
 * type prompt + Enter → poll until a NEW, assistant-side image is stable → download it from inside the page.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pullBytes, setFileInput, sleep } = require('../core/cdp');
const S = require('./chatgpt-session');
const B = require('./chatgpt-backend');

const { ChatGptError, SEL } = S;

// ---- prompt -----------------------------------------------------------------------------------------
// Measured trap: words about editing/uploading/"from scratch"/"source image" flip ChatGPT's image tool into
// EDIT mode — it then answers "please upload the image you want me to edit" instead of drawing.
const EDIT_TRIGGER_RE = /\b(edit(ing|ed)?|modify|retouch|upload(ed|ing)?|attach(ed|ment|ments)?|reference (image|photo|picture)s?|source (image|photo)|original (image|photo)|from scratch|input image|this (image|photo|picture))\b/gi;

function scrubEditTriggers(text) {
  return String(text || '').replace(EDIT_TRIGGER_RE, ' ')
    .replace(/\s+([,.;:!?])/g, '$1').replace(/([,.;:])\1+/g, '$1').replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:-]+/, '').trim();
}

/**
 * Wrap a scene description into a prompt that reliably triggers GENERATION.
 * Only when refs are really attached do we mention them (and then neutrally).
 */
function buildImagePrompt(desc, { aspect = '16:9', hasRefs = false, allowText = false } = {}) {
  const body = hasRefs ? String(desc || '').trim() : scrubEditTriggers(desc);
  let p = `Generate an image: ${body.replace(/\s*\r?\n\s*/g, ' ')}`;
  if (!/[.!?]$/.test(p)) p += '.';
  p += ` Aspect ratio ${aspect}.`;
  if (!allowText) p += ' No captions, no watermark.';
  if (hasRefs) p += ' Keep the same character/product appearance as in the provided picture(s).';
  return p;
}

/**
 * Prompt for mode 'api' — wording used by an implementation that ran in production (cover art, 09–10/2026).
 * The image tool draws 1024², 1536×1024 or 1024×1536: 16:9 / 9:16 come back as the nearest landscape / portrait.
 */
function buildApiImagePrompt(desc, { aspect = '16:9', hasRefs = false } = {}) {
  const shape = aspect === '16:9' ? 'wide landscape 16:9' : aspect === '9:16' ? 'tall portrait 9:16' : aspect === '1:1' ? 'square 1:1' : aspect;
  const body = hasRefs ? String(desc || '').trim() : scrubEditTriggers(desc);
  let p = `Generate exactly ONE image, ${shape} aspect ratio. Do not ask questions, just create it.`;
  if (hasRefs) p += ' Keep the same character/product appearance as in the provided picture(s).';
  return `${p}\n\n${body}`;
}

// Neutral nudge when ChatGPT answered with text: no edit/upload/reference words (see above).
const NUDGE = 'Generate a new image now that follows the description in my previous message. Reply with the image only.';

// ---- page-side image detection -------------------------------------------------------------------------
// Rules learned the hard way:
//  * ignore images inside the USER turn (the attached refs) — ChatGPT dropped data-message-author-role on
//    some accounts and the attachment was taken as "the new image";
//  * when a generated-image container exists, trust only it;
//  * key images by the ?id= of the URL (estuary/content?id=file_…&sig=…: the signature changes, the id does not);
//  * inside page JS strings every "/" in a regex must be escaped (an unescaped one = SyntaxError = never found).
const JS_IMG_LIB = `
  const USER_SCOPE = "[data-message-author-role='user'], [data-turn='user'], [class*='user-message'], [data-chatgpt-search-unit-key$=':user'], form";
  const GEN_SCOPE = "[data-testid*='generated-image'], [data-message-author-role='assistant'], [data-turn='assistant']";
  const keyOf = (src) => { const m = /[?&]id=([^&]+)/.exec(src || ''); return m ? m[1] : String(src || '').split('?')[0]; };
  const candidates = () => {
    const all = Array.from(document.querySelectorAll('img')).filter((img) => {
      if (!img.src || img.closest(USER_SCOPE)) return false;
      const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
      if (w > 0 && h > 0 && w < 128 && h < 128) return false;
      if (/avatar|profile|user|icon|logo/i.test((img.className || '') + ' ' + (img.alt || ''))) return false;
      if (/avatar|favicon|logo/i.test(img.src)) return false;
      if (/oaiusercontent|oaistatic|blob:|backend-api\\/(files|estuary)|dalle|generated/i.test(img.src + ' ' + (img.alt || ''))) return true;
      return w >= 200 || h >= 200;
    });
    const gen = all.filter((img) => img.closest(GEN_SCOPE));
    return gen.length ? gen : all;
  };`;

const JS_BASELINE = `(() => { ${JS_IMG_LIB} return candidates().map((i) => keyOf(i.src)); })()`;

function jsPollState(baseline) {
  return `(() => { ${JS_IMG_LIB}
    const base = new Set(${JSON.stringify(baseline)});
    const fresh = candidates().filter((i) => !base.has(keyOf(i.src)));
    const img = fresh[fresh.length - 1] || null;
    const msgs = document.querySelectorAll(${JSON.stringify(SEL.assistant.join(', '))});
    const last = msgs[msgs.length - 1] || null;
    return {
      src: img ? img.src : '', key: img ? keyOf(img.src) : '', w: img ? (img.naturalWidth || 0) : 0,
      complete: img ? img.complete : false, n: fresh.length,
      text: last ? (last.innerText || '').slice(0, 800) : '',
      streaming: !!document.querySelector(${JSON.stringify(SEL.stop.join(', '))}),
    }; })()`;
}

/** Current src of the image with this key (the preview src is swapped for the final one). */
function jsSrcByKey(k) {
  return `(() => { ${JS_IMG_LIB} const m = candidates().filter((i) => keyOf(i.src) === ${JSON.stringify(k)}); return m.length ? m[m.length - 1].src : ''; })()`;
}

// Canvas fallback when fetch(src) is refused (CORS/expired signature) but the <img> is rendered.
function jsCanvasDump(k) {
  return `(() => { ${JS_IMG_LIB}
    const img = candidates().filter((i) => keyOf(i.src) === ${JSON.stringify(k)}).pop();
    if (!img || !img.naturalWidth) return '';
    try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png').split(',')[1] || ''; } catch (_) { return ''; } })()`;
}

function sniffType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

// ---- refs -----------------------------------------------------------------------------------------------
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Turn {path}|{b64,mime} refs into file paths Chrome can read (DOM.setFileInputFiles needs real files). */
function materializeRefs(refs) {
  const files = [];
  const temps = [];
  for (const r of refs || []) {
    if (!r) continue;
    if (r.path) {
      if (!fs.existsSync(r.path)) throw new ChatGptError('CHATGPT_CONFIG', 'ref not found: ' + r.path);
      files.push(path.resolve(r.path));
    } else if (r.b64) {
      const b64 = String(r.b64).replace(/^data:[^,]+,/, '');
      const dir = path.join(os.tmpdir(), 'mbk-chatgpt-refs');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, crypto.randomUUID() + (EXT[r.mime] || '.png'));
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      files.push(f);
      temps.push(f);
    }
  }
  return { files, cleanup: () => temps.forEach((f) => fs.rmSync(f, { force: true })) };
}

// Pick the composer's file input: prefer one accepting images, inside the composer form.
const JS_FILE_INPUT = `(() => {
  const all = Array.from(document.querySelectorAll("input[type='file']"));
  const score = (i) => (i.closest('form') ? 2 : 0) + (/image/.test(i.accept || '') || !i.accept ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a))[0] || null;
})()`;

// UI evidence that an attachment landed in the composer (thumbnails / file tiles / remove buttons).
// ChatGPT may clear input.files after reading, so the input itself is not a reliable signal.
const JS_ATTACH_COUNT = `(() => {
  const box = document.querySelector(${JSON.stringify(SEL.composer.join(','))});
  const scope = (box && box.closest('form')) || document;
  const imgs = scope.querySelectorAll('img').length;
  const tiles = scope.querySelectorAll("[data-testid*='attachment'], [data-testid*='file-tile'], button[aria-label*='Remove'], button[aria-label*='remove']").length;
  return imgs + tiles;
})()`;

// Fallback: build a File from bytes in the page and assign input.files via DataTransfer (what the original
// implementation used successfully on chatgpt.com up to 10/2026).
function jsAttachDataTransfer(key, name, mime) {
  return `(() => {
    const input = ${JS_FILE_INPUT};
    if (!input) return 'no-input';
    const s = atob(window[${JSON.stringify(key)}] || ''); const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([a], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    delete window[${JSON.stringify(key)}];
    return 'ok:' + a.length;
  })()`;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

async function waitAttachCount(client, target, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const n = await client.evaluate(JS_ATTACH_COUNT).catch(() => 0);
    if (n >= target) return true;
    await sleep(700);
  }
  return false;
}

/**
 * Attach refs one by one: DOM.setFileInputFiles first, DataTransfer as fallback; each must show up in the
 * composer before going on. Not attached = throw BEFORE sending (a prompt without its refs wastes quota).
 */
async function attachRefs(client, files, log) {
  let count = await client.evaluate(JS_ATTACH_COUNT).catch(() => 0);
  for (const f of files) {
    let ok = false;
    try {
      await setFileInput(client, JS_FILE_INPUT, [f]);
      ok = await waitAttachCount(client, count + 1, 15_000);
    } catch (e) { log('setFileInputFiles: ' + e.message); }
    if (!ok) {
      log('setFileInputFiles not visible in composer → DataTransfer fallback');
      const key = '__mbkRef' + crypto.randomBytes(4).toString('hex');
      const b64 = fs.readFileSync(f).toString('base64');
      await client.evaluate(`window[${JSON.stringify(key)}] = ''`);
      for (let i = 0; i < b64.length; i += 400_000) await client.evaluate(`window[${JSON.stringify(key)}] += ${JSON.stringify(b64.slice(i, i + 400_000))}`);
      const r = await client.evaluate(jsAttachDataTransfer(key, path.basename(f), MIME[path.extname(f).toLowerCase()] || 'image/png')).catch((e) => 'err:' + e.message);
      ok = String(r).startsWith('ok:') && (await waitAttachCount(client, count + 1, 15_000));
    }
    if (!ok) throw new ChatGptError('CHATGPT_ATTACH', `could not attach ${path.basename(f)} (UI changed?) — prompt NOT sent`);
    count = await client.evaluate(JS_ATTACH_COUNT).catch(() => count + 1);
    log(`attached ${path.basename(f)}`);
  }
}

// ---- main ----------------------------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {string} o.profileDir      Chrome profile already logged in to chatgpt.com
 * @param {boolean} [o.show=false]   false = window off-screen (never headless: Cloudflare blocks it)
 * @param {string} [o.proxy]
 * @param {(msg:string)=>void} [o.log]
 * @param {number} [o.minGapMs=15000] pause between two generations of this profile (lowers "too quickly")
 * @param {'ui'|'api'} [o.mode='ui'] 'ui' = type in chatgpt.com and read the <img> (measured with refs);
 *        'api' = /backend-api in the tab: files upload + conversation + files/download (measured without refs)
 */
function createChatGptImage({ profileDir, show = false, proxy, log = () => {}, minGapMs = 15_000, mode = 'ui' } = {}) {
  const say = (m) => { try { log('[chatgpt-image] ' + m); } catch (_) {} };
  let lastGenAt = 0;

  async function status() {
    return S.withProfileLock(profileDir, async () => {
      const tab = await S.getTab(profileDir, { show, proxy });
      await S.waitCloudflare(tab, 25_000).catch(() => undefined);
      return S.readStatus(tab);
    });
  }

  async function run({ prompt, refs = [], aspect = '16:9', timeoutMs = 240_000, rawPrompt = false, allowText = false }) {
    if (!prompt || !String(prompt).trim()) throw new ChatGptError('CHATGPT_CONFIG', 'prompt is empty');
    const { files, cleanup } = materializeRefs(refs);
    try {
      const tab = await S.getTab(profileDir, { show, proxy });
      const composer = await S.openNewChat(tab); // fresh chat: no gallery / previous images on the page
      const st = await S.readStatus(tab);
      if (!st.connected) throw new ChatGptError('CHATGPT_AUTH', `profile not logged in to chatgpt.com (${st.reason || 'unknown'})`);

      const wait = lastGenAt + minGapMs - Date.now();
      if (wait > 0) { say(`pacing ${Math.round(wait / 1000)}s`); await sleep(wait); }

      if (files.length) await attachRefs(tab, files, say);
      const baseline = (await tab.evaluate(JS_BASELINE).catch(() => [])) || [];
      const text = rawPrompt ? String(prompt) : buildImagePrompt(prompt, { aspect, hasRefs: files.length > 0, allowText });
      const needle = await S.typePrompt(tab, composer, text, { multiline: false });
      await S.submit(tab, composer, needle);
      lastGenAt = Date.now();
      say(`sent (${text.length} chars, ${files.length} refs)`);

      const found = await waitForImage(tab, baseline, timeoutMs, composer);
      return await download(tab, found);
    } finally {
      cleanup();
    }
  }

  function refBytes(r) {
    if (r.path) {
      if (!fs.existsSync(r.path)) throw new ChatGptError('CHATGPT_CONFIG', 'ref not found: ' + r.path);
      const ext = path.extname(r.path).toLowerCase();
      return { buffer: fs.readFileSync(r.path), name: path.basename(r.path), mime: { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/png' };
    }
    const mime = r.mime || 'image/png';
    return { buffer: Buffer.from(String(r.b64).replace(/^data:[^,]+,/, ''), 'base64'), mime, name: 'ref-' + crypto.randomUUID() + (EXT[mime] || '.png') };
  }

  /**
   * mode 'api': [upload refs] → POST conversation (saved, not temporary: it must be readable afterwards) →
   * pointer from the SSE or by polling GET conversation every 4 s → files/download → hide the conversation.
   */
  async function runApi({ prompt, refs = [], aspect = '16:9', timeoutMs = 300_000, rawPrompt = false, model, onWait, keepConversation = false }) {
    if (!prompt || !String(prompt).trim()) throw new ChatGptError('CHATGPT_CONFIG', 'prompt is empty');
    const tab = await S.getTab(profileDir, { show, proxy });
    const href = await tab.evaluate('location.href').catch(() => '');
    if (!/^https:\/\/chatgpt\.com\//.test(href)) await S.navigate(tab, S.HOME_URL);
    await S.waitCloudflare(tab);
    const st = await S.readStatus(tab);
    if (!st.connected) throw new ChatGptError('CHATGPT_AUTH', `profile not logged in to chatgpt.com (${st.reason || 'unknown'})`);
    const wait = lastGenAt + minGapMs - Date.now();
    if (wait > 0) { say(`pacing ${Math.round(wait / 1000)}s`); await sleep(wait); }

    const files = [];
    for (const r of refs || []) if (r) files.push(await B.uploadFile(tab, refBytes(r)));
    const text = rawPrompt ? String(prompt) : buildApiImagePrompt(prompt, { aspect, hasRefs: files.length > 0 });
    const message = files.length ? B.multimodalMessage(text, files) : B.textMessage(text);
    const t0 = Date.now();
    lastGenAt = t0;
    const { parsed } = await B.converse(tab, { message, model, ephemeral: false, timeoutMs: Math.min(timeoutMs, 300_000) });
    const cid = parsed.conversationId;
    if (!cid) throw new ChatGptError('CHATGPT_BAD_RESPONSE', 'conversation id missing in SSE');
    say(`api: conversation started (${files.length} refs)`);
    try {
      let pointer = parsed.pointer;
      let answer = parsed.text;
      let finished = false;
      for (let i = 0; !pointer && Date.now() - t0 < timeoutMs; i++) {
        await sleep(4000);
        if (onWait) { try { onWait(Math.round((Date.now() - t0) / 1000)); } catch (_) {} }
        let conv = null;
        try { conv = await B.getConversation(tab, cid); } catch (e) { if (e.code === 'CHATGPT_AUTH') throw e; }
        if (!conv) continue; // 404 right after the POST: not stored yet
        pointer = B.imagePointer(conv);
        answer = B.turnText(conv) || answer;
        // answered in words and stopped (refusal / quota / tool system_error) → no image is coming
        if (!pointer && i >= 2 && B.finishedWithoutTool(conv)) { finished = true; break; }
      }
      if (!pointer) {
        if (!finished) throw new ChatGptError('CHATGPT_TIMEOUT', `no image after ${Math.round(timeoutMs / 1000)}s`);
        throw B.imageFailure(answer);
      }
      return await B.downloadPointer(tab, pointer, cid);
    } finally {
      if (!keepConversation) await B.hideConversation(tab, cid);
    }
  }

  async function waitForImage(tab, baseline, timeoutMs, composer) {
    const until = Date.now() + timeoutMs;
    let lastSrc = '';
    let evalFails = 0;
    let sameText = 0;
    let lastText = '';
    let nudged = false;
    while (Date.now() < until) {
      await sleep(2000);
      const s = await tab.evaluate(jsPollState(baseline)).catch(() => null);
      if (!s) {
        // Every evaluate failing = tab/window closed → stop now instead of waiting the whole timeout.
        if (++evalFails >= 8) { S.dropTab(profileDir); throw new ChatGptError('CHATGPT_TAB_LOST', 'lost the chatgpt.com tab (window closed?)'); }
        continue;
      }
      evalFails = 0;
      if (s.n > 0 && s.src) {
        // Progressive previews replace each other: accept only when the same src survives two polls.
        if (s.src === lastSrc && s.w >= 256 && s.complete && !s.streaming) return { key: s.key, src: s.src };
        lastSrc = s.src;
        continue;
      }
      if (s.streaming || !s.text) continue;
      const verdict = S.classifyReply(s.text);
      if (verdict && verdict.code === 'CHATGPT_RATE_LIMIT') {
        throw new ChatGptError('CHATGPT_RATE_LIMIT', 'image quota reached: ' + s.text.slice(0, 200), { resetHours: verdict.resetHours });
      }
      if (verdict && verdict.code === 'CHATGPT_POLICY') throw new ChatGptError('CHATGPT_POLICY', 'refused: ' + s.text.slice(0, 200));
      // Text-only answer (asks a question / wants an upload): stable for ~8 s → nudge once, then give up.
      if (!/creating image|generating|\d+%/i.test(s.text) && s.text.length > 20) {
        sameText = s.text === lastText ? sameText + 1 : 0;
        lastText = s.text;
        if (sameText >= 4) {
          if (!nudged) {
            nudged = true;
            sameText = 0;
            say('text reply → nudging once: ' + s.text.slice(0, 80));
            const needle = await S.typePrompt(tab, composer, NUDGE, { multiline: false });
            await S.submit(tab, composer, needle);
            continue;
          }
          throw new ChatGptError('CHATGPT_TEXT_REPLY', 'ChatGPT answered with text instead of an image: ' + s.text.slice(0, 200));
        }
      }
    }
    throw new ChatGptError('CHATGPT_TIMEOUT', `no new image after ${Math.round(timeoutMs / 1000)}s`);
  }

  async function download(tab, found) {
    // The final URL may not be ready the moment the <img> appears → retry a few times, re-reading the src.
    let lastErr = '';
    for (let i = 0; i < 6; i++) {
      const src = (await tab.evaluate(jsSrcByKey(found.key)).catch(() => '')) || found.src;
      try {
        const { buffer, contentType } = await pullBytes(tab, src);
        const type = sniffType(buffer);
        if (buffer.length >= 4096 && type) return { buffer, contentType: type || contentType };
        lastErr = `unexpected payload (${buffer.length} B, ${contentType})`;
      } catch (e) { lastErr = e.message; }
      const b64 = await tab.evaluate(jsCanvasDump(found.key)).catch(() => '');
      if (b64 && b64.length > 5000) return { buffer: Buffer.from(b64, 'base64'), contentType: 'image/png' };
      say(`download retry ${i + 1}/6 (${lastErr})`);
      await sleep(2500);
    }
    throw new ChatGptError('CHATGPT_DOWNLOAD', 'cannot download the generated image: ' + lastErr);
  }

  return {
    status,
    /**
     * @param {{prompt:string, refs?:Array<{path:string}|{b64:string,mime?:string}>, aspect?:string,
     *          timeoutMs?:number, rawPrompt?:boolean, allowText?:boolean, mode?:'ui'|'api',
     *          model?:string, onWait?:(sec:number)=>void, keepConversation?:boolean}} job  (model/onWait/keep: api only)
     * @returns {Promise<{buffer:Buffer, contentType:string}>}
     */
    generateImage: (job) => S.withProfileLock(profileDir, () => (((job && job.mode) || mode) === 'api' ? runApi(job || {}) : run(job || {}))),
    /** Detach from the tab (Chrome keeps running; use core/chrome closeProfileChrome to quit it). */
    close: () => S.dropTab(profileDir),
  };
}

module.exports = { createChatGptImage, buildImagePrompt, buildApiImagePrompt, scrubEditTriggers, ChatGptError };
