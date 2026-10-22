'use strict';
/**
 * chatgpt.com /backend-api over CDP: every request is a fetch() executed INSIDE the logged-in chatgpt.com tab
 * (same origin → cookies, Cloudflare clearance, sec-ch-ua and TLS fingerprint are the browser's own; the
 * access token never leaves the page). Node only computes the sentinel proof-of-work and parses results.
 *
 * Used by chatgpt-text.js (mode 'api') and chatgpt-image.js (mode 'api').
 * Protocol: references/chatgpt-gemini-text.md §4 and chatgpt-image.md §11.
 */
const crypto = require('node:crypto');
const { requirementsToken, solveProof } = require('./chatgpt-pow');
const { ChatGptError, classifyReply, parseResetHours } = require('./chatgpt-session');

const ORIGIN = 'https://chatgpt.com';
const CHUNK = 500_000;

// ---- low level: fetch in page ------------------------------------------------------------------------------
const rid = () => '__mbkCg' + crypto.randomBytes(6).toString('hex');

/**
 * @param {object} o
 * @param {string} [o.method='GET']
 * @param {object} [o.headers]
 * @param {string} [o.body]        string body
 * @param {string} [o.bodyKey]     window[bodyKey] holds a Uint8Array body (uploads)
 * @param {boolean} [o.bearer]     add "authorization: Bearer <accessToken>" (token cached IN the page 5 min)
 * @param {boolean} [o.binary]     read the response as bytes
 * @param {number} [o.timeoutMs=60000]
 * @returns {Promise<{status:number, text?:string, buffer?:Buffer, type:string, err?:string, aborted?:boolean}>}
 */
async function pageFetch(client, url, o = {}) {
  const key = rid();
  const timeoutMs = o.timeoutMs || 60_000;
  const sameOrigin = url.startsWith('/') || url.startsWith(ORIGIN);
  const meta = await client.evaluate(`(async () => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ${timeoutMs});
    try {
      const h = Object.assign({}, ${JSON.stringify(o.headers || {})});
      if (${!!o.bearer}) {
        const c = window.__mbkTok;
        if (!c || Date.now() - c.at > 300000) {
          const s = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
          if (!s || !s.accessToken || s.error) return { status: 401, size: 0, err: 'no access token' + (s && s.error ? ' (' + s.error + ')' : '') };
          window.__mbkTok = { v: s.accessToken, at: Date.now() };
        }
        h.authorization = 'Bearer ' + window.__mbkTok.v;
      }
      const init = { method: ${JSON.stringify(o.method || 'GET')}, headers: h, signal: ctl.signal,
                     credentials: ${sameOrigin ? "'include'" : "'omit'"} };
      ${o.bodyKey ? `init.body = window[${JSON.stringify(o.bodyKey)}];` : o.body != null ? `init.body = ${JSON.stringify(o.body)};` : ''}
      const r = await fetch(${JSON.stringify(url)}, init);
      if (r.status === 401) window.__mbkTok = null;
      const type = r.headers.get('content-type') || '';
      if (${!!o.binary}) { const b = new Uint8Array(await r.arrayBuffer()); window[${JSON.stringify(key)}] = b; return { status: r.status, size: b.length, type }; }
      const t = await r.text(); window[${JSON.stringify(key)}] = t; return { status: r.status, size: t.length, type };
    } catch (e) { return { status: 0, size: 0, err: String(e), aborted: e && e.name === 'AbortError' }; }
    finally { clearTimeout(timer); ${o.bodyKey ? `delete window[${JSON.stringify(o.bodyKey)}];` : ''} }
  })()`, { timeoutMs: timeoutMs + 15_000 });
  const out = { status: meta.status, type: meta.type || '', err: meta.err, aborted: meta.aborted };
  if (o.binary) {
    const parts = [];
    for (let off = 0; off < meta.size; off += CHUNK) {
      const b = await client.evaluate(`(() => { const b = window[${JSON.stringify(key)}].subarray(${off}, ${off + CHUNK});
        let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); })()`);
      parts.push(Buffer.from(b, 'base64'));
    }
    out.buffer = Buffer.concat(parts);
  } else {
    let t = '';
    for (let off = 0; off < meta.size; off += CHUNK) t += await client.evaluate(`window[${JSON.stringify(key)}].slice(${off}, ${off + CHUNK})`);
    out.text = t;
  }
  await client.evaluate(`delete window[${JSON.stringify(key)}]`).catch(() => undefined);
  return out;
}

/** Copy bytes into window[key] as a Uint8Array (base64 in chunks: CDP messages have size limits). */
async function pushBytes(client, buf) {
  const key = rid();
  await client.evaluate(`window[${JSON.stringify(key)}] = ''`);
  const b64 = buf.toString('base64');
  for (let i = 0; i < b64.length; i += CHUNK) await client.evaluate(`window[${JSON.stringify(key)}] += ${JSON.stringify(b64.slice(i, i + CHUNK))}`);
  await client.evaluate(`(() => { const s = atob(window[${JSON.stringify(key)}]); const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); window[${JSON.stringify(key)}] = a; return a.length; })()`);
  return key;
}

/**
 * Status → error. Order matters (tested upstream): 429 first (its page is HTML too); 401/403 or an HTML 2xx
 * = dead session; an HTML 5xx is a gateway fault, not a signed-out account.
 */
function check(r, what) {
  const body = r.text || '';
  if (r.status === 0) throw new ChatGptError(r.aborted ? 'CHATGPT_TIMEOUT' : 'CHATGPT_NETWORK', `${what}: ${r.err || 'fetch failed'}`);
  if (r.status === 429) throw new ChatGptError('CHATGPT_RATE_LIMIT', `${what}: HTTP 429`, { resetHours: null });
  if (r.status === 401 || r.status === 403 || (r.status < 300 && body.trimStart().startsWith('<'))) {
    throw new ChatGptError('CHATGPT_AUTH', `${what}: HTTP ${r.status} (session expired / Cloudflare)`);
  }
  if (r.status === 404 && /model not found/i.test(body)) throw new ChatGptError('CHATGPT_MODEL_NOT_FOUND', `${what}: Model not found`);
  if (r.status < 200 || r.status >= 300) throw new ChatGptError('CHATGPT_NETWORK', `${what}: HTTP ${r.status} ${body.slice(0, 200)}`);
}

// ---- header capture ---------------------------------------------------------------------------------------
// oai-device-id / oai-client-version: copied from the page's own /backend-api requests (Network domain).
const captured = new WeakMap(); // client -> {deviceId, clientVersion}

async function captureHeaders(client) {
  if (captured.has(client)) return captured.get(client);
  const cap = {};
  captured.set(client, cap);
  await client.send('Network.enable').catch(() => undefined);
  client.on('Network.requestWillBeSent', (p) => {
    const req = p && p.request;
    if (!req || !/\/backend-api\//.test(req.url)) return;
    for (const [k, v] of Object.entries(req.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === 'oai-device-id' && v && !cap.deviceId) cap.deviceId = v;
      if (lk === 'oai-client-version' && v && !cap.clientVersion) cap.clientVersion = v;
    }
  });
  // oai-did cookie = device id (readable from JS) when the page has not fired a request yet
  const did = await client.evaluate("(document.cookie.match(/(?:^|; )oai-did=([^;]+)/) || [])[1] || ''").catch(() => '');
  if (did && !cap.deviceId) cap.deviceId = decodeURIComponent(did);
  return cap;
}

async function baseHeaders(client, extra = {}) {
  const cap = await captureHeaders(client);
  const h = { accept: 'application/json', 'content-type': 'application/json', 'oai-language': 'en-US' };
  if (cap.deviceId) h['oai-device-id'] = cap.deviceId;
  if (cap.clientVersion) h['oai-client-version'] = cap.clientVersion;
  return Object.assign(h, extra);
}

// ---- SSE ---------------------------------------------------------------------------------------------------
const IMAGE_ROUTE_RE = /"skipped_mainline"\s*:\s*true|"turn_use_case"\s*:\s*"image gen"|"image_gen_title"/;
const POINTER_RE = /"asset_pointer"\s*:\s*"((?:file-service|sediment):\/\/[^"]+)"/g;

/**
 * Parse a /backend-api/conversation SSE body. Handles both formats seen in the wild:
 *  - full messages: {conversation_id, message:{id, author:{role}, content:{parts}}}
 *  - delta encoding v1: {p:"/message/content/parts/0", o:"append"|"replace", v}, {o:"patch", v:[ops]},
 *    a bare {v:"text"} appends to the last part, a bare {v:[ops]} is a patch list (o inherited),
 *    and `data: "v1"` (a JSON string) is only the encoding marker.
 */
function parseSse(raw) {
  const st = { parts: [], last: 0, conversationId: '', messageId: '', handoff: false, content: false };
  const absorb = (m) => {
    if (!m || typeof m !== 'object' || !m.author || m.author.role !== 'assistant') return;
    if (m.id) st.messageId = m.id;
    const parts = m.content && m.content.parts;
    if (Array.isArray(parts)) parts.forEach((p, i) => { if (typeof p === 'string' && p) st.parts[i] = p; });
  };
  const apply = (p, o, v, depth = 0) => {
    if (depth > 4) return;
    if ((o === 'patch' || o === undefined) && Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object') apply(x.p, x.o, x.v, depth + 1);
      return;
    }
    const m = typeof p === 'string' ? /\/message\/content\/parts\/(\d+)$/.exec(p) : null;
    if (m && typeof v === 'string') {
      const i = Number(m[1]);
      st.parts[i] = (o === 'append' ? (st.parts[i] || '') : '') + v;
      st.last = i;
      return;
    }
    if (p === undefined && typeof v === 'string') { st.parts[st.last] = (st.parts[st.last] || '') + v; return; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.conversation_id === 'string') st.conversationId = v.conversation_id;
      if (v.message) absorb(v.message);
    }
  };
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(data); } catch (_) { continue; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    if (ev.type === 'resume_conversation_token' || ev.type === 'stream_handoff') { st.handoff = true; continue; }
    if (ev.message || ev.v !== undefined) st.content = true;
    if (typeof ev.conversation_id === 'string') st.conversationId = ev.conversation_id;
    if (ev.message) absorb(ev.message);
    if ('o' in ev || 'v' in ev) apply(ev.p, ev.o, ev.v);
  }
  let pointer = null;
  for (const m of String(raw || '').matchAll(POINTER_RE)) pointer = m[1];
  return {
    text: st.parts.filter(Boolean).join('').trim(),
    conversationId: st.conversationId || null,
    messageId: st.messageId || null,
    handoff: st.handoff && !st.content,
    imageRouted: IMAGE_ROUTE_RE.test(raw || ''),
    pointer,
  };
}

// ---- conversation document (GET /backend-api/conversation/{id}) --------------------------------------------
function branch(conv) {
  const out = [];
  const map = (conv && conv.mapping) || {};
  for (let id = conv && conv.current_node, i = 0; id && map[id] && i < 500; id = map[id].parent, i++) {
    if (map[id].message) out.unshift(map[id].message);
  }
  return out;
}

/** Finished image of the current turn's tool message (partial previews are not finished_successfully). */
function imagePointer(conv) {
  for (const m of branch(conv).reverse()) {
    const role = m.author && m.author.role;
    if (role === 'user') break;
    if (role !== 'tool' || m.status !== 'finished_successfully') continue;
    for (const p of (m.content && m.content.parts) || []) {
      const ap = p && p.asset_pointer;
      if (typeof ap === 'string' && /^(file-service|sediment):\/\//.test(ap)) return ap;
    }
  }
  return null;
}

function turnText(conv) {
  for (const m of branch(conv).reverse()) {
    const role = m.author && m.author.role;
    if (role === 'user') return '';
    if (role !== 'assistant' || !m.content || m.content.content_type !== 'text') continue;
    const t = (m.content.parts || []).filter((p) => typeof p === 'string').join('').trim();
    if (t) return t;
  }
  return '';
}

/** Turn over without an image: last message = assistant text with end_turn true (refusal, quota, system_error). */
function finishedWithoutTool(conv) {
  const msgs = branch(conv);
  const last = msgs[msgs.length - 1];
  return !!last && last.author && last.author.role === 'assistant' && last.content && last.content.content_type === 'text'
    && last.status === 'finished_successfully' && last.end_turn === true;
}

// ---- high level -------------------------------------------------------------------------------------------
async function getConversation(client, id) {
  const r = await pageFetch(client, `/backend-api/conversation/${encodeURIComponent(id)}`, { bearer: true, headers: await baseHeaders(client), timeoutMs: 30_000 });
  if (r.status === 404) return null;
  check(r, 'GET conversation');
  return JSON.parse(r.text);
}

async function hideConversation(client, id) {
  if (!id) return;
  await pageFetch(client, `/backend-api/conversation/${encodeURIComponent(id)}`, {
    method: 'PATCH', bearer: true, headers: await baseHeaders(client), body: JSON.stringify({ is_visible: false }), timeoutMs: 20_000,
  }).catch(() => undefined);
}

function textMessage(prompt) {
  return { id: crypto.randomUUID(), author: { role: 'user' }, create_time: Date.now() / 1000, content: { content_type: 'text', parts: [prompt] }, metadata: {} };
}

/** content_type multimodal_text: image pointers first, then the prompt; metadata.attachments mirrors the files. */
function multimodalMessage(prompt, files) {
  return {
    id: crypto.randomUUID(), author: { role: 'user' }, create_time: Date.now() / 1000,
    content: {
      content_type: 'multimodal_text',
      parts: [...files.map((f) => ({ content_type: 'image_asset_pointer', asset_pointer: `file-service://${f.fileId}`, size_bytes: f.size, width: f.width, height: f.height })), prompt],
    },
    metadata: { attachments: files.map((f) => ({ id: f.fileId, name: f.name, mimeType: f.mime, width: f.width, height: f.height, size: f.size })) },
  };
}

/**
 * sentinel chat-requirements → PoW → POST /backend-api/conversation → raw SSE (+ parsed).
 * @param {object} o {message, model='auto', ephemeral=true, conversation?:{conversationId,parentMessageId}, timeoutMs}
 */
async function converse(client, o) {
  const ua = await client.evaluate('navigator.userAgent');
  const hdr = await baseHeaders(client);
  const req = await pageFetch(client, '/backend-api/sentinel/chat-requirements', {
    method: 'POST', bearer: true, headers: hdr, body: JSON.stringify({ p: requirementsToken(ua) }), timeoutMs: 45_000,
  });
  check(req, 'chat-requirements');
  let rq;
  try { rq = JSON.parse(req.text); } catch (_) { throw new ChatGptError('CHATGPT_BAD_RESPONSE', 'chat-requirements is not JSON'); }
  if (!rq || !rq.token) throw new ChatGptError('CHATGPT_BAD_RESPONSE', 'chat-requirements without token');
  const headers = Object.assign({}, hdr, { accept: 'text/event-stream', 'openai-sentinel-chat-requirements-token': rq.token });
  if (rq.proofofwork && rq.proofofwork.required) {
    const proof = solveProof(rq.proofofwork.seed, rq.proofofwork.difficulty, ua);
    if (!proof) throw new ChatGptError('CHATGPT_SENTINEL', 'proof-of-work not solved');
    headers['openai-sentinel-proof-token'] = proof;
  }
  // Turnstile is not solved here. Upstream code ignoring it still worked (10/2026); if the server starts to
  // enforce it, conversation answers 4xx → switch to mode 'ui'.
  const turnstile = !!(rq.turnstile && rq.turnstile.required);
  const conv = o.conversation;
  const body = {
    action: 'next',
    messages: [o.message],
    parent_message_id: (conv && conv.parentMessageId) || 'client-created-root',
    ...(conv && conv.conversationId ? { conversation_id: conv.conversationId } : {}),
    model: o.model || 'auto',
    timezone_offset_min: new Date().getTimezoneOffset(),
    suggestions: [],
    history_and_training_disabled: o.ephemeral !== false,
    conversation_mode: { kind: 'primary_assistant' },
    supports_buffering: false, // true = answer goes through a side "conduit" stream and this SSE stays empty
  };
  let res = await pageFetch(client, '/backend-api/conversation', { method: 'POST', bearer: true, headers, body: JSON.stringify(body), timeoutMs: o.timeoutMs || 240_000 });
  if (res.status === 404 && /model not found/i.test(res.text || '') && body.model !== 'auto') {
    body.model = 'auto'; // slug withdrawn for this account → retry once with auto
    res = await pageFetch(client, '/backend-api/conversation', { method: 'POST', bearer: true, headers, body: JSON.stringify(body), timeoutMs: o.timeoutMs || 240_000 });
  }
  if (turnstile && res.status >= 400 && res.status !== 429) {
    throw new ChatGptError('CHATGPT_SENTINEL', `conversation HTTP ${res.status} with turnstile required — use mode 'ui'`);
  }
  check(res, 'conversation');
  return { raw: res.text, parsed: parseSse(res.text) };
}

// ---- files API ---------------------------------------------------------------------------------------------
function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 12, 16) === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
  } catch (_) {}
  return { width: 1024, height: 1024 };
}

/**
 * Upload one reference image: POST /backend-api/files → PUT upload_url (Azure blob, x-ms-blob-type: BlockBlob)
 * → POST /backend-api/files/{id}/uploaded. Returns the descriptor used by multimodalMessage().
 */
async function uploadFile(client, { buffer, mime, name }) {
  const hdr = await baseHeaders(client);
  const create = await pageFetch(client, '/backend-api/files', {
    method: 'POST', bearer: true, headers: hdr, timeoutMs: 30_000,
    body: JSON.stringify({ file_name: name, file_size: buffer.length, use_case: 'multimodal', timezone_offset_min: new Date().getTimezoneOffset(), reset_rate_limits: false }),
  });
  check(create, 'files(create)');
  const j = JSON.parse(create.text || '{}');
  if (!j.upload_url || !j.file_id) throw new ChatGptError('CHATGPT_BAD_RESPONSE', 'files(create) without upload_url/file_id');
  const key = await pushBytes(client, buffer);
  const put = await pageFetch(client, j.upload_url, { method: 'PUT', bodyKey: key, headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': mime }, timeoutMs: 120_000 });
  if (put.status < 200 || put.status >= 300) throw new ChatGptError('CHATGPT_NETWORK', `upload PUT HTTP ${put.status} ${put.err || ''}`);
  const done = await pageFetch(client, `/backend-api/files/${encodeURIComponent(j.file_id)}/uploaded`, { method: 'POST', bearer: true, headers: hdr, body: '{}', timeoutMs: 30_000 });
  check(done, 'files(uploaded)');
  return { fileId: j.file_id, mime, name, size: buffer.length, ...imageSize(buffer) };
}

/** asset pointer → bytes. sediment:// (newer) and file-service:// use different download routes. */
async function downloadPointer(client, pointer, conversationId) {
  const [scheme, id] = pointer.split('://');
  const url = scheme === 'sediment'
    ? `/backend-api/files/download/${encodeURIComponent(id)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`
    : `/backend-api/files/${encodeURIComponent(id)}/download`;
  const hdr = await baseHeaders(client);
  const r = await pageFetch(client, url, { bearer: true, headers: hdr, timeoutMs: 30_000 });
  check(r, 'files/download');
  const link = (JSON.parse(r.text || '{}') || {}).download_url;
  if (!link) throw new ChatGptError('CHATGPT_DOWNLOAD', 'no download_url for ' + id);
  const abs = new URL(link, ORIGIN).toString();
  // same-origin link needs the session; a CDN link must NOT receive the bearer token
  const same = new URL(abs).origin === ORIGIN;
  const img = await pageFetch(client, abs, { binary: true, bearer: same, headers: same ? hdr : {}, timeoutMs: 60_000 });
  if (img.status !== 200 || !img.buffer || img.buffer.length < 1000) throw new ChatGptError('CHATGPT_DOWNLOAD', `image download HTTP ${img.status}`);
  return { buffer: img.buffer, contentType: img.type || 'image/png' };
}

/** Free-plan image quota texts seen in the assistant turn (tested upstream + UI messages). */
const IMAGE_LIMIT_RE = /limit|temporarily unavailable|quota|try again later|too quickly/i;

function imageFailure(text) {
  const v = classifyReply(text);
  if (v) return new ChatGptError(v.code, 'ChatGPT: ' + text.slice(0, 200), v.resetHours != null ? { resetHours: v.resetHours } : undefined);
  if (IMAGE_LIMIT_RE.test(text)) return new ChatGptError('CHATGPT_RATE_LIMIT', 'ChatGPT: ' + text.slice(0, 200), { resetHours: parseResetHours(text) });
  return new ChatGptError(text ? 'CHATGPT_TEXT_REPLY' : 'CHATGPT_TIMEOUT', text ? 'ChatGPT answered without an image: ' + text.slice(0, 200) : 'no image');
}

module.exports = {
  pageFetch, pushBytes, check, captureHeaders, baseHeaders,
  parseSse, branch, imagePointer, turnText, finishedWithoutTool,
  getConversation, hideConversation, textMessage, multimodalMessage, converse,
  uploadFile, downloadPointer, imageSize, imageFailure,
};
