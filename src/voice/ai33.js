'use strict';
/**
 * ai33.pro — PAID third-party TTS aggregator (cheaper than going to each vendor directly) with the USER'S key:
 * ElevenLabs, MiniMax, Vbee (Vietnamese, North/Central/South), FishAudio, Kokoro, Edge, user clones.
 * Node >= 22 (global fetch/FormData), no deps. Contract from the vendor's docs as summarised 29/09/2026 and
 * used in production by (C); see skills/ai-voice-free/references/ai33.md.
 *
 *   POST /v3/text-to-speech (FormData voice_id, text ≤1M, speed 0.5–1.5, with_transcript) → { task_id }
 *   GET  /v1/task/{id} → { status: doing|done|error, progress, error_message, credit_cost, metadata.audio_url … }
 *   GET  /v3/voices?provider=&page=&page_size≤100[&search&language…]  ·  GET /v1/credits
 *   Auth header: xi-api-key: <KEY>. 429 → Retry-After. Quota is per USER (all keys share it).
 *
 *   const { createAi33 } = require('./ai33');
 *   const ai = createAi33();                          // AI33_API_KEY env
 *   const vi = await ai.listVoices({ provider: 'vbee' });
 *   const r = await ai.synthesize({ voiceId: vi[0].voiceId, text: 'Xin chào các em.' });
 *   fs.writeFileSync('a.mp3', r.buffer);              // r.words [{text, offsetMs, durationMs}] when available
 *
 * Errors: Ai33Error.code = AI33_NO_KEY | AI33_AUTH | AI33_NO_CREDIT | AI33_VOICE_NOT_FOUND | AI33_RATE_LIMIT |
 * AI33_NETWORK | AI33_TIMEOUT | AI33_BAD_RESPONSE | AI33_FAILED | AI33_BAD_INPUT | AI33_ABORTED.
 * The key is never logged or put in a message.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { mp3Duration } = require('./audio');

const BASE = 'https://api.ai33.pro';
const PROVIDERS = ['elevenlabs', 'vbee', 'minimax', 'fishaudio', 'kokoro'];
const PREFIXES = ['elevenlabs', 'minimax', 'clone', 'edge', 'kokoro', 'vbee', 'fishaudio']; // voice_id must start with "<p>_"
const PAGE_SIZE = 100;
const MAX_TEXT = 1_000_000;
const MAX_DOWNLOAD = 200 * 1024 * 1024;
const CACHE_TTL = 24 * 3600_000;
// ElevenLabs alone lists ~16,500 voices (166 pages) → cap pages and filter server-side (search/language).
const MAX_PAGES = { elevenlabs: 5, vbee: 30, minimax: 30, fishaudio: 30, kokoro: 30 };

class Ai33Error extends Error {
  constructor(code, message) { super(message); this.code = `AI33_${code}`; this.name = 'Ai33Error'; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Ai33Error('ABORTED', 'aborted'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Ai33Error('ABORTED', 'aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const withTimeout = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** Users paste "xi-api-key: …", "Bearer …" or quoted keys. */
const cleanKey = (k) => String(k ?? '').trim().replace(/^(xi-api-key|authorization)\s*[:=]\s*/i, '').replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
const fingerprint = (k) => createHash('sha256').update(cleanKey(k), 'utf8').digest('hex').slice(0, 12);

function shortBody(b) {
  try {
    const j = JSON.parse(b);
    const m = j.message ?? j.error ?? j.detail ?? j.error_message;
    if (typeof m === 'string') return m.slice(0, 200);
    if (m && typeof m === 'object') return JSON.stringify(m).slice(0, 200);
  } catch (_) { /* not JSON */ }
  return String(b).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const CREDIT_RE = /credit|balance|insufficient|not enough|top.?up|quota exceeded|số dư|hết/i;
const VOICE_RE = /voice[^.]{0,40}(not[ _]found|not[ _]exist|does not exist|invalid|unknown|không tồn tại)|invalid[ _]voice|voice_id/i;

/** HTTP status + body → Ai33Error. Exported for tests. */
function httpError(status, body, retryAfter) {
  const msg = shortBody(body);
  if (status === 401 || status === 403) return new Ai33Error('AUTH', 'ai33 rejected the API key (wrong, expired or locked)');
  // ai33 reports "out of credit" as 400 with a message, not only 402.
  if (status === 402 || CREDIT_RE.test(msg)) return new Ai33Error('NO_CREDIT', 'ai33 account is out of credit — top up at ai33.pro');
  if (status === 404 || VOICE_RE.test(msg)) return new Ai33Error('VOICE_NOT_FOUND', 'ai33 voice not found or removed — pick another voice');
  if (status === 429) { const e = new Ai33Error('RATE_LIMIT', `ai33 rate limit (429)${retryAfter ? `, retry in ${retryAfter}s` : ''}`); e.retryAfterMs = (retryAfter || 30) * 1000; return e; }
  if (status >= 500) return new Ai33Error('NETWORK', `ai33 server busy (HTTP ${status})`);
  return new Ai33Error('FAILED', `ai33 error (HTTP ${status})${msg ? `: ${msg}` : ''}`);
}

/** Task error_message → Ai33Error. */
function taskError(message) {
  const m = String(message || '').slice(0, 300);
  if (CREDIT_RE.test(m)) return new Ai33Error('NO_CREDIT', 'ai33 account is out of credit — top up at ai33.pro');
  if (VOICE_RE.test(m)) return new Ai33Error('VOICE_NOT_FOUND', 'ai33 voice not found or removed — pick another voice');
  return new Ai33Error('FAILED', `ai33 task failed${m ? `: ${m}` : ''}`);
}

const retryAfterOf = (res) => { const n = Number(res.headers.get('retry-after')); return Number.isFinite(n) && n > 0 ? Math.min(120, n) : undefined; };

/** "vi", "Vietnamese", "English (US)", "American English", "vi-VN" → normalized code ("vi-VN", "en-GB", "es"…). */
function langCode(raw, accent) {
  const s = String(raw ?? '').trim();
  if (!s) return 'und';
  const m = /^([a-z]{2,3})[-_]([a-z]{2})$/i.exec(s);
  if (m) return `${m[1].toLowerCase()}-${m[2].toUpperCase()}`;
  if (/^(vi|vie|vietnamese|tiếng việt)\b/i.test(s)) return 'vi-VN';
  if (/^(en[-_ ]?gb|english \((british|uk|united kingdom)\)|british( english)?)$/i.test(s)) return 'en-GB';
  if (/^(en[-_ ]?au|english \(australia\)|australian english)$/i.test(s)) return 'en-AU';
  if (/^(en[-_ ]?us|english \((us|united states)\)|american( english)?|en|eng|english)$/i.test(s)) {
    // ElevenLabs: language "en" + accent "british"/"australian"
    if (/brit|uk/i.test(accent || '')) return 'en-GB';
    if (/austral/i.test(accent || '')) return 'en-AU';
    return 'en-US';
  }
  return s.toLowerCase().split(/[\s(_-]/)[0] || 'und';
}

/** Vietnamese region from Vbee id prefixes (hn_/sg_/hue_) or accent text. */
function viRegion(voiceId, accent) {
  const id = voiceId.toLowerCase();
  if (/^vbee_(hn|hanoi|north)_/.test(id) || /north|bắc|hanoi/i.test(accent || '')) return 'vi-n';
  if (/^vbee_(sg|hcm|saigon|south)_/.test(id) || /south|nam bộ|saigon/i.test(accent || '')) return 'vi-s';
  if (/^vbee_(hue|dn|central)_/.test(id) || /central|trung|huế|hue/i.test(accent || '')) return 'vi-c';
  return undefined;
}

/** Raw /v3/voices item → { voiceId, provider, name, lang, gender, region, previewUrl, … } (null if unusable). */
function mapVoice(raw, provider) {
  if (!raw || typeof raw !== 'object') return null;
  let voiceId = str(raw.voice_id) || str(raw.id) || (str(raw.name).includes('_') && !/\s/.test(str(raw.name)) ? str(raw.name) : '');
  if (!voiceId) return null;
  if (!PREFIXES.some((p) => voiceId.startsWith(`${p}_`))) voiceId = `${provider}_${voiceId}`;
  const labels = raw.labels && typeof raw.labels === 'object' ? raw.labels : {};
  const accent = str(raw.accent) || str(labels.accent) || undefined;
  const language = str(raw.language) || str(raw.language_code) || str(raw.locale) || str(labels.language) || undefined;
  const lang = langCode(language, accent);
  const g = (str(raw.gender) || str(labels.gender)).toLowerCase();
  const gender = /^(f|female|woman|nữ|nu)$/.test(g) ? 'female' : /^(m|male|man|nam)$/.test(g) ? 'male' : undefined;
  const age = str(raw.age) || str(labels.age) || undefined;
  const description = (str(raw.description) || str(labels.description) || str(labels.descriptive)).slice(0, 200) || undefined;
  const name = (str(raw.friendly_name) || str(raw.display_name) || (str(raw.name) !== voiceId ? str(raw.name) : '') || voiceId.replace(/^[a-z]+_/, '')).slice(0, 80);
  const https = (v) => (/^https:\/\//i.test(str(v)) ? str(v) : undefined); // never play http previews in an app
  return {
    voiceId, provider, name, lang, language, gender, age, accent, description,
    region: lang.startsWith('vi') ? viRegion(voiceId, accent) : undefined,
    child: /child|kid|teen|trẻ em|em bé/i.test(`${age || ''} ${name} ${description || ''}`) || undefined,
    category: str(raw.category) || undefined,
    previewUrl: https(raw.preview_url) ?? https(raw.demo) ?? https(raw.sample_url) ?? https(raw.demo_url) ?? https(raw.audio_url),
  };
}

function pageItems(j) {
  for (const k of ['data', 'voices', 'items', 'results']) {
    const v = j[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && Array.isArray(v.voices)) return v.voices;
  }
  return [];
}

/** Word timings from whatever with_transcript returned: SRT/VTT text, [{text,start,end}] (s or ms), segments[].words[], ElevenLabs char alignment. */
function parseTranscript(x, durationSec) {
  if (x == null) return [];
  if (typeof x === 'string') {
    const s = x.trim();
    if (!s) return [];
    if (s[0] === '{' || s[0] === '[') { try { return parseTranscript(JSON.parse(s), durationSec); } catch (_) { return []; } }
    return s.includes('-->') ? parseSrt(s) : [];
  }
  if (Array.isArray(x)) {
    const items = x.filter((i) => i && typeof i === 'object');
    if (!items.length) return [];
    if (items.some((i) => Array.isArray(i.words) && i.words.length)) return items.flatMap((i) => (Array.isArray(i.words) ? parseTranscript(i.words, durationSec) : []));
    const msByName = items.some((i) => 'start_ms' in i || 'startMs' in i || 'end_ms' in i || 'start_time_ms' in i);
    const segs = [];
    for (const i of items) {
      const text = str(i.text) || str(i.word) || str(i.content) || str(i.value);
      if (typeof i.start === 'string' && /:/.test(i.start)) {
        const a = parseClock(i.start), z = parseClock(String(i.end ?? ''));
        if (text && a !== undefined && z !== undefined) segs.push({ text, start: a, end: z, clock: true });
        continue;
      }
      const start = num(i.start) ?? num(i.start_time) ?? num(i.startTime) ?? num(i.start_ms) ?? num(i.startMs) ?? num(i.start_time_ms) ?? num(i.from) ?? num(i.offset);
      let end = num(i.end) ?? num(i.end_time) ?? num(i.endTime) ?? num(i.end_ms) ?? num(i.endMs) ?? num(i.end_time_ms) ?? num(i.to);
      if (end === undefined && start !== undefined && num(i.duration) !== undefined) end = start + num(i.duration);
      if (text && start !== undefined && end !== undefined) segs.push({ text, start, end });
    }
    if (!segs.length) return [];
    // Unit guess: names say ms, or the numbers are far larger than the audio length.
    const maxEnd = Math.max(...segs.filter((s) => !s.clock).map((s) => s.end), 0);
    const k = msByName || (durationSec ? maxEnd > durationSec * 5 + 5 : maxEnd > 3600) ? 1 / 1000 : 1;
    const out = [];
    for (const s of segs) {
      const f = s.clock ? 1 : k;
      if (/\s/.test(s.text.trim())) out.push(...spreadWords(s.text, s.start * f, s.end * f));
      else out.push(word(s.text.trim(), s.start * f, s.end * f));
    }
    return out.filter((w) => w.text && w.durationMs >= 0).sort((a, b) => a.offsetMs - b.offsetMs);
  }
  if (typeof x === 'object') {
    const chars = x.characters ?? x.chars, cs = x.character_start_times_seconds ?? x.start_times, ce = x.character_end_times_seconds ?? x.end_times;
    if (Array.isArray(chars) && Array.isArray(cs) && Array.isArray(ce) && chars.length === cs.length) {
      const out = [];
      let cur = null;
      for (let i = 0; i < chars.length; i++) {
        const ch = String(chars[i]);
        if (/\s/.test(ch)) { if (cur) out.push(cur); cur = null; continue; }
        if (!cur) cur = { text: ch, a: Number(cs[i]), z: Number(ce[i]) };
        else { cur.text += ch; cur.z = Number(ce[i]); }
      }
      if (cur) out.push(cur);
      return out.map((w) => word(w.text, w.a, w.z));
    }
    for (const key of ['words', 'word_timestamps', 'timestamps', 'segments', 'transcript', 'alignment', 'normalized_alignment', 'subtitles', 'items', 'data', 'srt']) {
      if (x[key] != null) { const w = parseTranscript(x[key], durationSec); if (w.length) return w; }
    }
  }
  return [];
}
const word = (text, a, z) => ({ text, offsetMs: Math.round(a * 1000), durationMs: Math.max(0, Math.round((z - a) * 1000)) });
/** Spread a segment's time over its words by character length (cue-level timings only). */
function spreadWords(text, a, z) {
  const toks = String(text).split(/\s+/).filter(Boolean);
  if (!toks.length || !(z > a)) return [];
  const total = toks.reduce((s, t) => s + t.length + 1, 0);
  let t0 = a;
  return toks.map((tk) => { const d = ((z - a) * (tk.length + 1)) / total; const w = word(tk, t0, t0 + d); t0 += d; return w; });
}
function parseClock(s) {
  const m = /^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(String(s).trim());
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3].replace(',', '.')) : num(s);
}
function parseSrt(s) {
  const out = [];
  for (const b of s.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = b.split('\n').filter((l) => l.trim() && l.trim() !== 'WEBVTT');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map((x) => x.trim().split(/\s+/)[0]);
    const st = parseClock(a), en = parseClock(z);
    const text = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (st !== undefined && en !== undefined && text) out.push(...spreadWords(text, st, en));
  }
  return out;
}
function findTranscript(meta) {
  if (!meta) return {};
  for (const k of ['transcript', 'words', 'word_timestamps', 'timestamps', 'alignment', 'subtitles', 'srt']) {
    const v = meta[k];
    if (v == null || v === '') continue;
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return { url: v.trim() };
    return { inline: v };
  }
  for (const k of ['transcript_url', 'srt_url', 'subtitle_url', 'alignment_url', 'timestamps_url', 'vtt_url']) if (str(meta[k])) return { url: str(meta[k]) };
  return {};
}

/** Only HTTPS downloads (plus localhost for fake servers in tests). */
function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(x.hostname)); } catch (_) { return false; }
}

/**
 * @param {{apiKey?:string, base?:string, fetchImpl?:typeof fetch, pollMs?:number, taskTimeoutMs?:number,
 *          requestTimeoutMs?:number, cacheDir?:string}} [o]   cacheDir: where voice lists are cached 24 h (optional).
 */
function createAi33(o = {}) {
  const key = cleanKey(o.apiKey ?? process.env.AI33_API_KEY ?? '');
  const base = (o.base || process.env.AI33_BASE || BASE).replace(/\/+$/, '');
  const f = o.fetchImpl || fetch;
  const pollMs = o.pollMs ?? 1500;
  const reqMs = o.requestTimeoutMs ?? 60_000;
  const mem = new Map(); // in-memory voice cache: cacheKey → {at, voices}

  const headers = () => {
    if (!key) throw new Ai33Error('NO_KEY', 'no ai33 API key (set AI33_API_KEY or pass apiKey)');
    return { 'xi-api-key': key, Accept: 'application/json' };
  };

  /** GET JSON; retries network/429/5xx (GETs cost no credit). */
  async function getJson(p, signal, tries = 3) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      if (signal?.aborted) throw new Ai33Error('ABORTED', 'aborted');
      let res;
      try { res = await f(`${base}${p}`, { headers: headers(), signal: withTimeout(signal, reqMs) }); }
      catch (e) {
        if (e instanceof Ai33Error) throw e;
        if (signal?.aborted) throw new Ai33Error('ABORTED', 'aborted');
        last = new Ai33Error('NETWORK', `cannot reach ai33 (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
        await sleep(Math.min(4000, pollMs * (i + 1)), signal);
        continue;
      }
      const body = await res.text();
      if (res.ok) { try { return JSON.parse(body); } catch (_) { throw new Ai33Error('BAD_RESPONSE', 'ai33 returned unreadable JSON'); } }
      const err = httpError(res.status, body, retryAfterOf(res));
      if (res.status === 429 || res.status >= 500) { last = err; await sleep(Math.min(20_000, (retryAfterOf(res) ?? 0) * 1000 || pollMs * (i + 1)), signal); continue; }
      throw err;
    }
    throw last || new Ai33Error('NETWORK', 'cannot reach ai33');
  }

  /** Credit balance (number). */
  async function credits(signal) {
    const j = await getJson('/v1/credits', signal, 2);
    const d = j.data && typeof j.data === 'object' ? j.data : {};
    for (const v of [j.credits, j.credit, j.balance, j.remaining_credits, j.ec_remain_credits, d.credits, d.balance]) {
      if (v !== undefined && v !== null && Number.isFinite(Number(v))) return Number(v);
    }
    throw new Ai33Error('BAD_RESPONSE', 'ai33 returned no credit balance');
  }

  const voicesPath = (provider, page, q) => {
    const p = new URLSearchParams({ provider, page: String(page), page_size: String(PAGE_SIZE) });
    for (const k of ['search', 'language', 'gender', 'locale']) if (q[k]) p.set(k, String(q[k]).trim());
    return `/v3/voices?${p}`;
  };

  /** All pages (≤ maxPages): page 1 gives pagination.total → fetch the rest 4 at a time; else follow has_more. */
  async function fetchVoices(provider, q, signal) {
    const maxPages = q.maxPages || MAX_PAGES[provider] || 10;
    const out = [], seen = new Set();
    const absorb = (j) => { const items = pageItems(j); for (const r of items) { const v = mapVoice(r, provider); if (v && !seen.has(v.voiceId)) { seen.add(v.voiceId); out.push(v); } } return items.length; };
    const first = await getJson(voicesPath(provider, 1, q), signal);
    const n1 = absorb(first);
    const pg = first.pagination && typeof first.pagination === 'object' ? first.pagination : first;
    const total = Number(pg.total ?? pg.total_count ?? pg.count);
    const size = Number(pg.page_size ?? pg.per_page) || PAGE_SIZE;
    if (Number.isFinite(total) && total > 0) {
      const rest = Array.from({ length: Math.max(0, Math.min(maxPages, Math.ceil(total / size)) - 1) }, (_, i) => i + 2);
      const results = {};
      let idx = 0;
      await Promise.all(Array.from({ length: Math.min(4, rest.length) }, async () => {
        while (idx < rest.length) { const page = rest[idx++]; results[page] = await getJson(voicesPath(provider, page, q), signal); }
      }));
      for (const page of rest) absorb(results[page]);
      return out;
    }
    let more = pg.has_more === true || pg.hasMore === true || pg.next_page != null || (pg.has_more === undefined && n1 >= size);
    for (let page = 2; more && page <= maxPages; page++) {
      const j = await getJson(voicesPath(provider, page, q), signal);
      const n = absorb(j);
      const p2 = j.pagination && typeof j.pagination === 'object' ? j.pagination : j;
      more = n > 0 && (p2.has_more === true || p2.hasMore === true || (p2.has_more === undefined && n >= size));
    }
    return out;
  }

  /**
   * Voice list with a 24 h cache (memory, plus `cacheDir` file if given) keyed by key fingerprint + filter.
   * @param {{provider?:string, search?:string, language?:string, gender?:string, locale?:string, refresh?:boolean, maxPages?:number, signal?:AbortSignal}} q
   */
  async function listVoices(q = {}) {
    const provider = q.provider || 'vbee';
    if (!PROVIDERS.includes(provider)) throw new Ai33Error('BAD_INPUT', `unsupported provider: ${provider} (one of ${PROVIDERS.join(', ')})`);
    headers();
    const ck = JSON.stringify([fingerprint(key), provider, q.search || '', q.language || '', q.gender || '', q.locale || '']);
    const file = o.cacheDir ? path.join(o.cacheDir, `ai33-voices-${createHash('sha1').update(ck).digest('hex').slice(0, 12)}.json`) : null;
    if (!q.refresh) {
      const hit = mem.get(ck) || (file && readJson(file));
      if (hit && Date.now() - hit.at < CACHE_TTL && Array.isArray(hit.voices)) return hit.voices;
    }
    let voices = await fetchVoices(provider, q, q.signal);
    // ElevenLabs: a language filter the server doesn't know returns []; refetch unfiltered and filter locally.
    if (!voices.length && q.language) {
      const lang = String(q.language).toLowerCase();
      voices = (await fetchVoices(provider, { ...q, language: undefined }, q.signal)).filter((v) => v.lang.toLowerCase().startsWith(lang));
    }
    const entry = { at: Date.now(), voices };
    mem.set(ck, entry);
    if (file) writeJson(file, entry);
    return voices;
  }

  async function download(url, signal) {
    if (!safeUrl(url)) throw new Ai33Error('BAD_RESPONSE', 'ai33 returned a non-HTTPS audio URL');
    let res;
    try { res = await f(url, { signal: withTimeout(signal, 120_000) }); }
    catch (_) { if (signal?.aborted) throw new Ai33Error('ABORTED', 'aborted'); throw new Ai33Error('NETWORK', 'cannot download ai33 audio'); }
    if (!res.ok) throw new Ai33Error('NETWORK', `cannot download ai33 audio (HTTP ${res.status})`);
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_DOWNLOAD) throw new Ai33Error('BAD_RESPONSE', 'ai33 audio > 200 MB');
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > MAX_DOWNLOAD) throw new Ai33Error('BAD_RESPONSE', 'ai33 audio > 200 MB');
    return b;
  }

  /** POST costs credit → resend only on 429/503 (the server certainly did not accept it). */
  async function createTask(form, signal) {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new Ai33Error('ABORTED', 'aborted');
      let res;
      try { res = await f(`${base}/v3/text-to-speech`, { method: 'POST', headers: headers(), body: form(), signal: withTimeout(signal, reqMs) }); }
      catch (e) {
        if (e instanceof Ai33Error) throw e;
        if (signal?.aborted) throw new Ai33Error('ABORTED', 'aborted');
        // Do NOT retry here: the request may have been accepted (and charged) before the connection dropped.
        throw new Ai33Error('NETWORK', 'cannot reach ai33 to create the task');
      }
      const body = await res.text();
      if ((res.status === 429 || res.status === 503) && i < 2) { await sleep(Math.min(20_000, (retryAfterOf(res) ?? 0) * 1000 || 3000 * (i + 1)), signal); continue; }
      if (!res.ok) throw httpError(res.status, body, retryAfterOf(res));
      let j;
      try { j = JSON.parse(body); } catch (_) { throw new Ai33Error('BAD_RESPONSE', 'ai33 returned unreadable task JSON'); }
      if (j.success === false) throw taskError(shortBody(body));
      const id = str(j.task_id) || str(j.id) || str(j.data?.task_id);
      if (!id) throw new Ai33Error('BAD_RESPONSE', 'ai33 returned no task_id');
      return id;
    }
  }

  async function waitTask(id, signal, onProgress) {
    const deadline = Date.now() + (o.taskTimeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Ai33Error('ABORTED', 'aborted');
      let t;
      try { t = await getJson(`/v1/task/${encodeURIComponent(id)}`, signal, 2); }
      catch (e) {
        if (['AI33_NETWORK', 'AI33_RATE_LIMIT', 'AI33_BAD_RESPONSE'].includes(e.code)) { await sleep(pollMs * 2, signal); continue; }
        throw e;
      }
      const st = String(t.status ?? '').toLowerCase();
      if (['done', 'success', 'completed'].includes(st)) return t;
      if (['error', 'failed', 'fail', 'cancelled', 'canceled'].includes(st)) throw taskError(t.error_message);
      const p = Number(t.progress);
      if (onProgress && Number.isFinite(p)) onProgress(Math.max(0, Math.min(0.98, p > 1 ? p / 100 : p)));
      await sleep(pollMs, signal);
    }
    throw new Ai33Error('TIMEOUT', 'ai33 task not done after the timeout');
  }

  /**
   * @param {{voiceId:string, text:string, speed?:number, withTranscript?:boolean, signal?:AbortSignal, onProgress?:(p:number)=>void}} s
   *   voiceId must carry its provider prefix ("vbee_…", "elevenlabs_…"); speed 0.5–1.5.
   * @returns {Promise<{buffer:Buffer, mime:string, durationMs:number, words:{text:string,offsetMs:number,durationMs:number}[], creditCost?:number, taskId:string}>}
   */
  async function synthesize(s) {
    const text = String(s.text ?? '').trim();
    if (!text) throw new Ai33Error('BAD_INPUT', 'empty text');
    if (text.length > MAX_TEXT) throw new Ai33Error('BAD_INPUT', 'ai33 accepts at most 1,000,000 chars per task');
    if (!PREFIXES.some((p) => String(s.voiceId || '').startsWith(`${p}_`))) throw new Ai33Error('VOICE_NOT_FOUND', 'voiceId needs a provider prefix, e.g. vbee_… (use listVoices)');
    const withTranscript = s.withTranscript !== false;
    const speed = Math.min(1.5, Math.max(0.5, Math.round((Number(s.speed) || 1) * 100) / 100));
    const form = () => {
      const fd = new FormData();
      fd.set('voice_id', s.voiceId);
      fd.set('text', text);
      fd.set('speed', String(speed));
      fd.set('with_transcript', withTranscript ? 'true' : 'false');
      return fd;
    };
    const taskId = await createTask(form, s.signal);
    const t = await waitTask(taskId, s.signal, s.onProgress);
    const meta = t.metadata || {};
    const url = str(meta.audio_url) || str(meta.url) || str(meta.audio?.url);
    if (!url) throw new Ai33Error('BAD_RESPONSE', 'ai33 task done but no audio_url');
    const buffer = await download(url, s.signal);
    if (buffer.length < 200) throw new Ai33Error('BAD_RESPONSE', 'ai33 returned an empty audio file');
    let durSec = mp3Duration(buffer) || num(meta.duration) || num(meta.audio_duration) || 0;
    let words = [];
    if (withTranscript) {
      const tr = findTranscript(meta);
      try {
        if (tr.inline !== undefined) words = parseTranscript(tr.inline, durSec || undefined);
        else if (tr.url && safeUrl(tr.url)) words = parseTranscript((await download(tr.url, s.signal)).toString('utf8'), durSec || undefined);
      } catch (e) { if (e.code === 'AI33_ABORTED') throw e; words = []; } // no timings → subtitles split by sentence
    }
    if (!durSec && words.length) { const l = words[words.length - 1]; durSec = (l.offsetMs + l.durationMs) / 1000; }
    const mime = buffer.subarray(0, 4).toString('ascii') === 'RIFF' ? 'audio/wav' : 'audio/mpeg';
    return { buffer, mime, durationMs: Math.round(durSec * 1000), words, creditCost: num(t.credit_cost), taskId };
  }

  return { listVoices, synthesize, credits, hasKey: () => !!key };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJson(file, v) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v));
    fs.renameSync(tmp, file);
  } catch (_) { /* cache is best-effort */ }
}

module.exports = { createAi33, Ai33Error, mapVoice, langCode, viRegion, parseTranscript, findTranscript, httpError, taskError, cleanKey, PROVIDERS, PREFIXES };
