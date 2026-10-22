'use strict';
/**
 * Ask ChatGPT for text (e.g. write / rewrite prompts in bulk) through the chatgpt.com UI of a logged-in
 * Chrome profile.
 *
 *   const { createChatGptText } = require('./chatgpt-text');
 *   const gpt = createChatGptText({ profileDir: 'D:/profiles/gpt1' });
 *   const answer = await gpt.ask({ prompt: 'Rewrite as a cinematic image prompt: a cat on a roof' });
 *
 * Two transports (option `mode`, default 'auto' = api then ui):
 *  - 'api': sentinel chat-requirements + SHA3 proof-of-work (Node) → POST /backend-api/conversation, executed
 *    as fetch() inside the tab (chatgpt-backend.js). Fast; breaks if OpenAI starts enforcing Turnstile.
 *  - 'ui': the page sends the request itself, so whatever new token it needs is handled for us:
 *   1. type the prompt in a fresh chat and press Enter (the page sends the request);
 *   2. wait until streaming stops and the answer is stable;
 *   3. read the exact markdown via GET /backend-api/conversation/{id} (a plain bearer call, run inside the
 *      page so the token never leaves the browser); fall back to the bubble's innerText.
 *   4. hide the conversation (PATCH is_visible:false) so batch runs do not flood the history.
 */
const { sleep } = require('../core/cdp');
const S = require('./chatgpt-session');
const B = require('./chatgpt-backend');

const { ChatGptError, SEL } = S;

function jsState() {
  return `(() => {
    const msgs = document.querySelectorAll(${JSON.stringify(SEL.assistant.join(', '))});
    const last = msgs[msgs.length - 1] || null;
    const alert = Array.from(document.querySelectorAll("[role='alert'], [class*='text-token-text-error']"))
      .map((e) => e.innerText || '').filter((t) => t && t.length < 400).join(' | ');
    const m = /\\/c\\/([0-9a-f-]{20,})/.exec(location.pathname);
    return { count: msgs.length, text: last ? (last.innerText || '') : '', alert,
             streaming: !!document.querySelector(${JSON.stringify(SEL.stop.join(', '))}), cid: m ? m[1] : '' };
  })()`;
}

// Bearer-authenticated call executed in the page. Returns {status, body}.
function jsApi(method, apiPath, body) {
  return `(async () => {
    try {
      const s = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json());
      if (!s || !s.accessToken) return { status: 401, body: '' };
      const r = await fetch(${JSON.stringify(apiPath)}, { method: ${JSON.stringify(method)}, credentials: 'include',
        headers: { authorization: 'Bearer ' + s.accessToken, 'content-type': 'application/json' }
        ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} });
      return { status: r.status, body: ${method === 'GET' ? 'await r.text()' : "''"} };
    } catch (e) { return { status: 0, body: String(e) }; }
  })()`;
}

/**
 * Text of the latest assistant turn in a GET /backend-api/conversation/{id} JSON:
 * walk from current_node up through `parent`, stop at the user message (do not leak the previous turn),
 * keep only content_type "text" (skips thoughts / tool calls / image pointers).
 */
function lastAssistantText(conv) {
  const map = conv && conv.mapping;
  if (!map) return '';
  let id = conv.current_node;
  for (let i = 0; id && map[id] && i < 200; i++, id = map[id].parent) {
    const m = map[id].message;
    if (!m || !m.author) continue;
    if (m.author.role === 'user') return '';
    if (m.author.role !== 'assistant') continue;
    const c = m.content || {};
    if (c.content_type !== 'text' || !Array.isArray(c.parts)) continue;
    const t = c.parts.filter((p) => typeof p === 'string').join('').trim();
    if (t) return t;
  }
  return '';
}

/** Pull a JSON value out of an answer that may be wrapped in ```json fences or prose. */
function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [fence && fence[1], s];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c.trim()); } catch (_) {}
    const a = c.indexOf('['), o = c.indexOf('{');
    const start = a >= 0 && (o < 0 || a < o) ? a : o;
    const end = Math.max(c.lastIndexOf(']'), c.lastIndexOf('}'));
    if (start >= 0 && end > start) { try { return JSON.parse(c.slice(start, end + 1)); } catch (_) {} }
  }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.profileDir
 * @param {boolean} [o.show=false]
 * @param {string} [o.proxy]
 * @param {(msg:string)=>void} [o.log]
 * @param {'auto'|'api'|'ui'} [o.mode='auto'] 'api' = /backend-api from inside the tab (sentinel + PoW computed
 *        in Node; the path an upstream app uses daily); 'ui' = type + read; 'auto' = api, then ui when the
 *        sentinel/stream path breaks (CHATGPT_SENTINEL / BAD_RESPONSE / EMPTY).
 */
function createChatGptText({ profileDir, show = false, proxy, log = () => {}, mode = 'auto' } = {}) {
  const say = (m) => { try { log('[chatgpt-text] ' + m); } catch (_) {} };

  async function status() {
    return S.withProfileLock(profileDir, async () => {
      const tab = await S.getTab(profileDir, { show, proxy });
      await S.waitCloudflare(tab, 25_000).catch(() => undefined);
      return S.readStatus(tab);
    });
  }

  async function run({ prompt, timeoutMs = 300_000, keepConversation = false, temporary = false }) {
    if (!prompt || !String(prompt).trim()) throw new ChatGptError('CHATGPT_CONFIG', 'prompt is empty');
    const tab = await S.getTab(profileDir, { show, proxy });
    // Temporary chats are not stored → GET conversation 404s → we fall back to innerText (markdown lost).
    const composer = await S.openNewChat(tab, temporary ? S.ORIGIN + '/?temporary-chat=true' : S.HOME_URL);
    const st = await S.readStatus(tab);
    if (!st.connected) throw new ChatGptError('CHATGPT_AUTH', `profile not logged in to chatgpt.com (${st.reason || 'unknown'})`);

    const needle = await S.typePrompt(tab, composer, String(prompt), { multiline: true });
    await S.submit(tab, composer, needle);
    say(`sent ${String(prompt).length} chars`);

    const until = Date.now() + timeoutMs;
    let last = '';
    let stable = 0;
    let cid = '';
    let fails = 0;
    let s = null;
    while (Date.now() < until) {
      await sleep(1500);
      s = await tab.evaluate(jsState()).catch(() => null);
      if (!s) { if (++fails >= 10) { S.dropTab(profileDir); throw new ChatGptError('CHATGPT_TAB_LOST', 'lost the chatgpt.com tab'); } continue; }
      fails = 0;
      if (s.cid) cid = s.cid;
      const bad = S.classifyReply(s.alert) || (!s.streaming && s.count ? S.classifyReply(s.text.slice(0, 400)) : null);
      // Only treat a short bubble as an error message: a long answer may legitimately mention "limit".
      if (bad && (s.alert || s.text.length < 400)) {
        throw new ChatGptError(bad.code, 'ChatGPT: ' + (s.alert || s.text).slice(0, 200), bad.resetHours != null ? { resetHours: bad.resetHours } : undefined);
      }
      if (s.streaming || !s.count || !s.text.trim()) { stable = 0; continue; }
      stable = s.text === last ? stable + 1 : 0;
      last = s.text;
      if (stable >= 2) break; // ~3 s without change and no stop button
    }
    if (stable < 2) throw new ChatGptError('CHATGPT_TIMEOUT', `no finished answer after ${Math.round(timeoutMs / 1000)}s`);

    let text = '';
    let source = 'dom';
    if (cid) {
      const r = await tab.evaluate(jsApi('GET', '/backend-api/conversation/' + cid)).catch(() => null);
      if (r && r.status === 200) {
        try { text = lastAssistantText(JSON.parse(r.body)); source = 'api'; } catch (_) {}
      } else say(`GET conversation → ${r && r.status} (using innerText)`);
      if (!keepConversation) await tab.evaluate(jsApi('PATCH', '/backend-api/conversation/' + cid, { is_visible: false })).catch(() => undefined);
    }
    if (!text) text = last.trim();
    if (!text) throw new ChatGptError('CHATGPT_EMPTY', 'empty answer');
    return { text, conversationId: cid || null, source };
  }

  /**
   * mode 'api'. temporary (default true) = history_and_training_disabled: nothing to hide afterwards, but the
   * conversation cannot be read back (GET → 404), so the empty-stream fallback only works with temporary:false.
   */
  async function runApi({ prompt, timeoutMs = 240_000, keepConversation = false, temporary = true, model, conversation }) {
    if (!prompt || !String(prompt).trim()) throw new ChatGptError('CHATGPT_CONFIG', 'prompt is empty');
    const tab = await S.getTab(profileDir, { show, proxy });
    const href = await tab.evaluate('location.href').catch(() => '');
    if (!/^https:\/\/chatgpt\.com\//.test(href)) await S.navigate(tab, S.HOME_URL);
    await S.waitCloudflare(tab);
    const { parsed } = await B.converse(tab, { message: B.textMessage(String(prompt)), model, ephemeral: temporary, conversation, timeoutMs });
    let text = parsed.text;
    const cid = parsed.conversationId;
    if (!text && cid && !temporary) {
      // "conduit"/handoff stream: the answer exists server-side → poll the stored conversation (≤ 90 s)
      const until = Date.now() + 90_000;
      while (!text && Date.now() < until) {
        await sleep(3000);
        const conv = await B.getConversation(tab, cid).catch(() => null);
        if (conv) text = B.turnText(conv);
      }
    }
    if (!temporary && cid && !keepConversation) await B.hideConversation(tab, cid);
    if (!text) {
      const why = parsed.imageRouted ? 'router sent the turn to image generation' : parsed.handoff ? 'answer streamed through another channel (handoff)' : 'no text in stream';
      throw new ChatGptError(parsed.imageRouted ? 'CHATGPT_BAD_RESPONSE' : 'CHATGPT_EMPTY', 'empty answer: ' + why);
    }
    say(`api: ${text.length} chars`);
    return { text, conversationId: cid, parentMessageId: parsed.messageId, source: 'api' };
  }

  async function dispatch(o) {
    const m = o.mode || mode;
    if (m === 'ui') return run(o);
    if (m === 'api') return runApi(o);
    try {
      return await runApi(o);
    } catch (e) {
      if (!['CHATGPT_SENTINEL', 'CHATGPT_BAD_RESPONSE', 'CHATGPT_EMPTY'].includes(e.code) || o.conversation) throw e;
      say(`api failed (${e.code}) → ui`);
      return run(o);
    }
  }

  return {
    status,
    /** @returns {Promise<string>} */
    ask: async (o) => (await S.withProfileLock(profileDir, () => dispatch(o || {}))).text,
    /** @returns {Promise<{text:string, conversationId:string|null, parentMessageId?:string|null, source:'api'|'dom'}>} pass {conversationId,parentMessageId} as `conversation` to continue (api) */
    askDetailed: (o) => S.withProfileLock(profileDir, () => dispatch(o || {})),
    close: () => S.dropTab(profileDir),
  };
}

module.exports = { createChatGptText, lastAssistantText, extractJson, ChatGptError };
