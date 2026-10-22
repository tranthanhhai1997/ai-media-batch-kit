'use strict';
/**
 * Gemini TTS — official Google Gemini API (generativelanguage.googleapis.com) with the USER'S OWN API key(s).
 * Node >= 22 (global fetch), no deps. Output: raw PCM s16le 24 kHz → wrapped as WAV here (no ffmpeg needed).
 *
 * Free tier: Google AI Studio keys have a free tier for the preview TTS models, with low per-minute and per-day
 * request caps (exact numbers change — check the "rate limits" page of the Gemini API docs). Respect them:
 * key rotation below is meant for several keys you legitimately own (e.g. separate projects / a team's keys),
 * NOT for mass-creating accounts to dodge limits — that can breach Google's terms and get keys/projects banned.
 *
 *   const { createGeminiTts } = require('./gemini-tts');
 *   const tts = createGeminiTts({ keys: [process.env.GEMINI_API_KEY] });
 *   const r = await tts.synthesize({ text: 'Xin chào các em.', voice: 'Kore', accent: 'vi-n', style: 'chậm rãi, ấm áp' });
 *   fs.writeFileSync('a.wav', r.buffer);   // r.durationMs; no word timings (Gemini returns none)
 *
 * Errors: GeminiTtsError.code = GEMINI_TTS_NO_KEY | GEMINI_TTS_QUOTA (all keys resting) | GEMINI_TTS_AUTH (all keys
 * invalid) | GEMINI_TTS_BAD_REQUEST | GEMINI_TTS_NO_AUDIO | GEMINI_TTS_NETWORK | GEMINI_TTS_TIMEOUT | GEMINI_TTS_ABORTED.
 * The key is never put in an error message or log.
 */
const { splitText } = require('./chunk');
const { pcmToWav, silencePcm } = require('./audio');

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']; // names as used 10/2026 — may be renamed
const SAMPLE_RATE = 24_000;
const MAX_CHUNK = 800; // longer inputs drift in voice/pace (C)
const GAP_SEC = 0.15; // silence between chunks so sentences don't run together
const TIMEOUT_MS = 120_000;

/** Key rest times after a failure (A and C, same numbers). */
const COOLDOWN_MS = { quota: 65_000, quotaDay: 60 * 60_000, invalid: 30 * 60_000, server: 20_000 };

/** The 30 prebuilt voices with gender + trait (Google docs). Gender matters: see gender lock below. */
const VOICES = [
  ['Zephyr', 'female', 'Bright'], ['Puck', 'male', 'Upbeat'], ['Charon', 'male', 'Informative'], ['Kore', 'female', 'Firm'],
  ['Fenrir', 'male', 'Excitable'], ['Leda', 'female', 'Youthful'], ['Orus', 'male', 'Firm'], ['Aoede', 'female', 'Breezy'],
  ['Callirrhoe', 'female', 'Easy-going'], ['Autonoe', 'female', 'Bright'], ['Enceladus', 'male', 'Breathy'], ['Iapetus', 'male', 'Clear'],
  ['Umbriel', 'male', 'Easy-going'], ['Algieba', 'male', 'Smooth'], ['Despina', 'female', 'Smooth'], ['Erinome', 'female', 'Clear'],
  ['Algenib', 'male', 'Gravelly'], ['Rasalgethi', 'male', 'Informative'], ['Laomedeia', 'female', 'Upbeat'], ['Achernar', 'female', 'Soft'],
  ['Alnilam', 'male', 'Firm'], ['Schedar', 'male', 'Even'], ['Gacrux', 'female', 'Mature'], ['Pulcherrima', 'female', 'Forward'],
  ['Achird', 'male', 'Friendly'], ['Zubenelgenubi', 'male', 'Casual'], ['Vindemiatrix', 'female', 'Gentle'], ['Sadachbia', 'male', 'Lively'],
  ['Sadaltager', 'male', 'Knowledgeable'], ['Sulafat', 'female', 'Warm'],
].map(([name, gender, trait]) => ({ name, gender, trait }));

/**
 * Regional accents: the same 30 voices read in another language/accent → 30 × N "voices" in a UI.
 * Vietnamese is said in Vietnamese inside the instruction (worked better in C); others in English.
 */
const ACCENTS = {
  'vi-n': { lang: 'vi-VN', vi: 'giọng miền Bắc (Hà Nội)' },
  'vi-s': { lang: 'vi-VN', vi: 'giọng miền Nam (Sài Gòn)' },
  'en-us': { lang: 'en-US', en: 'English with an American (US) accent' },
  'en-gb': { lang: 'en-GB', en: 'English with a British (UK) accent' },
  'zh-cn': { lang: 'zh-CN', en: 'Mandarin Chinese' }, 'ja-jp': { lang: 'ja-JP', en: 'Japanese' }, 'ko-kr': { lang: 'ko-KR', en: 'Korean' },
  'th-th': { lang: 'th-TH', en: 'Thai' }, 'fr-fr': { lang: 'fr-FR', en: 'French' }, 'de-de': { lang: 'de-DE', en: 'German' },
  'es-es': { lang: 'es-ES', en: 'Spanish' },
};

class GeminiTtsError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; this.name = 'GeminiTtsError'; }
}

/** HTTP error → why the KEY should rest (or 'bad' = the request itself is wrong, don't punish the key). */
function classifyHttpError(status, body) {
  const b = String(body || '');
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(b)) return /per[ _-]?day|daily/i.test(b) ? 'quotaDay' : 'quota';
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|API_KEY_SERVICE_BLOCKED/i.test(b)) return 'invalid';
  if (status >= 500) return 'server';
  if (status === 400) return 'bad';
  return 'other';
}

/** "AIza…" and the newer "AQ.…" keys (with a dot) — pasted lists split by newline / comma / space. */
function parseKeys(inputs) {
  const seen = new Set();
  for (const raw of [].concat(inputs || [])) {
    for (const part of String(raw ?? '').split(/[\s,;]+/)) {
      const k = part.trim().replace(/^["'`]+|["'`]+$/g, '');
      if (/^[A-Za-z0-9_\-.]{30,200}$/.test(k)) seen.add(k);
    }
  }
  return [...seen];
}
const maskKey = (k) => (k.length <= 12 ? `${k.slice(0, 2)}…` : `${k.slice(0, 6)}…${k.slice(-4)}`);
const redact = (s) => String(s || '').replace(/key=[^&\s"]+/g, 'key=***').replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***');

function shortErr(body) {
  try { const j = JSON.parse(body); const m = j.error?.message || j.error?.status; if (m) return redact(m).slice(0, 160); } catch (_) { /* not JSON */ }
  return redact(body).slice(0, 160);
}

/**
 * Instruction placed BEFORE the text. Gemini has no "accent" or "gender" parameter: it follows the prompt.
 * Gender lock (A, measured by F0): with a "Southern Vietnamese" accent, male voices Fenrir/Charon/Algenib drifted
 * to a FEMALE voice (~205–253 Hz vs ~126 Hz). A director note alone was not enough (Fenrir still 253 Hz); adding
 * BOTH the note and ", male speaker (man's voice)" next to the accent fixed it (Fenrir 126, Algenib 115, Kore 195 Hz).
 */
function buildPrompt(text, { accent = 'vi-n', gender, style } = {}) {
  const a = ACCENTS[accent] || ACCENTS['vi-n'];
  const st = String(style || '').trim().replace(/[:：]+$/, '');
  const lock = gender === 'male'
    ? "male speaker (man's voice). The speaker is an adult MAN with a natural male voice and male pitch range; never sound female"
    : gender === 'female'
      ? "female speaker (woman's voice). The speaker is an adult WOMAN with a natural female voice and female pitch range; never sound male"
      : '';
  if (a.vi) {
    const who = gender === 'male' ? `giọng nam — ${lock}` : gender === 'female' ? `giọng nữ — ${lock}` : '';
    return `Đọc bằng tiếng Việt ${a.vi}${who ? `, ${who}` : ''}. Phong cách: ${st || 'rõ ràng, tự nhiên, ấm áp'}. `
      + `Chỉ đọc đúng phần lời sau, không đọc chỉ dẫn này:\n${text}`;
  }
  return `Read aloud in ${a.en}${lock ? `, ${lock}` : ''}. Style: ${st || 'clear, natural and warm'}. `
    + `Only read the following text, not these instructions:\n${text}`;
}

const pcmRate = (mime) => { const m = /rate=(\d+)/i.exec(mime || ''); return m ? Number(m[1]) : SAMPLE_RATE; };

/**
 * In-memory key pool with round-robin + per-key cooldown. Persist `state()` yourself if you want rests to
 * survive a restart (store only ids/cooldowns, never the keys in plain text logs).
 */
function createKeyPool(keys, { now = Date.now } = {}) {
  const slots = parseKeys(keys).map((key, i) => ({ id: `k${i}`, key, masked: maskKey(key), cooldownUntil: 0, invalid: false, lastError: '', lastOk: 0 }));
  let cursor = 0;
  return {
    size: () => slots.length,
    /** indexes to try, starting at the cursor, skipping resting keys */
    order() {
      const t = now();
      const out = [];
      for (let k = 0; k < slots.length; k++) { const i = (cursor + k) % slots.length; if (slots[i].cooldownUntil <= t) out.push(i); }
      return out;
    },
    key: (i) => slots[i].key,
    ok(i) { Object.assign(slots[i], { cooldownUntil: 0, invalid: false, lastError: '', lastOk: now() }); cursor = (i + 1) % slots.length; },
    fail(i, kind, detail) {
      const ms = COOLDOWN_MS[kind] || 0;
      if (ms) slots[i].cooldownUntil = now() + ms;
      slots[i].invalid = kind === 'invalid';
      slots[i].lastError = detail || kind;
    },
    /** error to throw when no key is usable */
    exhausted() {
      if (!slots.length) return new GeminiTtsError('GEMINI_TTS_NO_KEY', 'no Gemini API key configured');
      if (slots.every((s) => s.invalid)) return new GeminiTtsError('GEMINI_TTS_AUTH', 'all Gemini keys are invalid or blocked');
      const t = now();
      const waits = slots.filter((s) => !s.invalid && s.cooldownUntil > t).map((s) => s.cooldownUntil - t);
      const min = Math.max(1, Math.ceil(Math.min(...waits, 60_000) / 60_000));
      const e = new GeminiTtsError('GEMINI_TTS_QUOTA', `all Gemini keys are rate-limited, retry in ~${min} min or add a key`);
      e.retryAfterMs = Math.min(...waits, 60_000);
      return e;
    },
    state: () => slots.map(({ key, ...s }) => ({ ...s })), // never expose the key
  };
}

/**
 * @param {{keys:string|string[], model?:string, fetchImpl?:typeof fetch, timeoutMs?:number, now?:()=>number}} opts
 */
function createGeminiTts(opts = {}) {
  const pool = createKeyPool(opts.keys ?? process.env.GEMINI_API_KEY, { now: opts.now });
  const fetchImpl = opts.fetchImpl || fetch;
  const model = opts.model || MODELS[0];
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  async function callOnce(key, prompt, voice, signal) {
    const url = `${API}/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    };
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    // Key in a header, not the URL: URLs end up in proxies/logs.
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: sig });
    const txt = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: txt };
    let j;
    try { j = JSON.parse(txt); } catch (_) { return { ok: false, status: 502, body: 'invalid json' }; }
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) return { ok: false, status: 204, body: j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason || 'no audio' };
    return { ok: true, pcm: Buffer.from(part.inlineData.data, 'base64'), rate: pcmRate(part.inlineData.mimeType) };
  }

  /** One chunk: try every non-resting key once; rotate so the next chunk starts on the next key. */
  async function synthChunk(prompt, voice, signal) {
    const order = pool.order();
    if (!order.length) throw pool.exhausted();
    let noAudio = 0, netErr = null;
    for (const i of order) {
      if (signal?.aborted) throw new GeminiTtsError('GEMINI_TTS_ABORTED', 'aborted');
      let r;
      try { r = await callOnce(pool.key(i), prompt, voice, signal); }
      catch (e) {
        if (signal?.aborted) throw new GeminiTtsError('GEMINI_TTS_ABORTED', 'aborted');
        netErr = e; continue; // flaky network: try the next key, don't punish this one
      }
      if (r.ok) { pool.ok(i); return r; }
      if (r.status === 204) {
        // Sometimes the model answers with TEXT instead of audio — one more try on another key, then give up.
        if (++noAudio >= 2) throw new GeminiTtsError('GEMINI_TTS_NO_AUDIO', `Gemini returned no audio (${r.body}); rephrase the text or change voice`);
        continue;
      }
      const kind = classifyHttpError(r.status, r.body);
      if (kind === 'bad' || kind === 'other') throw new GeminiTtsError('GEMINI_TTS_BAD_REQUEST', `Gemini rejected the request (HTTP ${r.status}): ${shortErr(r.body)}`, r.status);
      pool.fail(i, kind, `HTTP ${r.status}: ${shortErr(r.body)}`);
    }
    if (noAudio) throw new GeminiTtsError('GEMINI_TTS_NO_AUDIO', 'Gemini returned no audio; rephrase the text or change voice');
    if (netErr && pool.order().length) {
      const to = netErr.name === 'TimeoutError';
      throw new GeminiTtsError(to ? 'GEMINI_TTS_TIMEOUT' : 'GEMINI_TTS_NETWORK', to ? 'Gemini took too long' : `cannot reach Gemini: ${redact(netErr.message)}`);
    }
    throw pool.exhausted();
  }

  /**
   * @param {{text:string, voice?:string, accent?:keyof ACCENTS, gender?:'male'|'female', style?:string,
   *          raw?:boolean, signal?:AbortSignal}} o
   *   gender defaults to the voice's own gender (always locked). raw:true sends the text without instruction.
   * @returns {Promise<{buffer:Buffer, mime:'audio/wav', pcm:Buffer, sampleRate:number, durationMs:number, words:[]}>}
   */
  async function synthesize(o) {
    const voice = o.voice || 'Kore';
    const v = VOICES.find((x) => x.name === voice);
    const chunks = splitText(o.text, { maxChars: MAX_CHUNK });
    if (!chunks.length) throw new GeminiTtsError('GEMINI_TTS_BAD_REQUEST', 'empty text');
    if (!pool.size()) throw pool.exhausted();
    const pcms = [];
    let rate = SAMPLE_RATE;
    for (let i = 0; i < chunks.length; i++) {
      const prompt = o.raw ? chunks[i] : buildPrompt(chunks[i], { accent: o.accent, gender: o.gender || v?.gender, style: o.style });
      const r = await synthChunk(prompt, voice, o.signal);
      if (i > 0) pcms.push(silencePcm(GAP_SEC, { sampleRate: r.rate }));
      pcms.push(r.pcm);
      rate = r.rate;
    }
    const pcm = Buffer.concat(pcms);
    return { buffer: pcmToWav(pcm, { sampleRate: rate }), mime: 'audio/wav', pcm, sampleRate: rate, durationMs: Math.round((pcm.length / 2 / rate) * 1000), words: [] };
  }

  /** GET /models — validates keys without spending TTS quota. */
  async function checkKeys() {
    const out = [];
    const st = pool.state();
    for (let i = 0; i < pool.size(); i++) {
      try {
        const res = await fetchImpl(`${API}/models?pageSize=1`, { headers: { 'x-goog-api-key': pool.key(i) }, signal: AbortSignal.timeout(20_000) });
        if (res.ok) out.push({ id: st[i].id, masked: st[i].masked, ok: true });
        else {
          const body = await res.text();
          const kind = classifyHttpError(res.status, body);
          if (kind === 'invalid' || kind === 'bad') pool.fail(i, 'invalid', `HTTP ${res.status}`);
          out.push({ id: st[i].id, masked: st[i].masked, ok: false, kind, detail: `HTTP ${res.status}: ${shortErr(body)}` });
        }
      } catch (e) { out.push({ id: st[i].id, masked: st[i].masked, ok: false, kind: 'network', detail: redact(e.message) }); }
    }
    return out;
  }

  return { synthesize, checkKeys, keys: () => pool.state(), model };
}

module.exports = { createGeminiTts, createKeyPool, buildPrompt, classifyHttpError, parseKeys, maskKey, GeminiTtsError, VOICES, ACCENTS, MODELS, COOLDOWN_MS };
