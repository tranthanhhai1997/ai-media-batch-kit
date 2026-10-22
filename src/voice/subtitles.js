'use strict';
/**
 * Word timings → subtitle cues → SRT / VTT. Pure, no deps. From a lesson-video app (C), vitest-covered.
 *
 *   const { cuesFromWords, toSrt } = require('./subtitles');
 *   const r = await edge.synthesize({ text: original, voice });          // words: [{text, offsetMs, durationMs}]
 *   fs.writeFileSync('a.srt', toSrt(cuesFromWords(r.words, { text: original })));
 *
 * Why pass the ORIGINAL text: Edge WordBoundary words have no punctuation and are the SPOKEN form
 * ("năm mươi triệu ki lô mét" for "50 triệu km"). alignWords() maps them back to the written tokens so cues
 * show "50 triệu km." and break at sentence ends (before this, two sentences were merged into one cue — C).
 * No word timings (Gemini)? cuesFromText() spreads the text over the audio duration by length.
 */

const MAX_WORDS = 12;
const MAX_CHARS = 42; // ~ one line on a 9:16 phone screen at a readable size
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const SOFT_BREAK = /[,;:]["'”’)\]]*$/;
const TRAIL_PUNCT = /[.!?…,;:]+["'”’)\]]*$/;
const LOOKAHEAD = 8; // spoken words searched ahead for a written-token match

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Match key: no tone marks, no case, no punctuation. */
function wordKey(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Group tokens into cues: ≤ maxWords / ≤ maxChars, break after sentence punctuation (or a comma once ≥ 3 words). */
function groupTokens(tokens, { maxWords = MAX_WORDS, maxChars = MAX_CHARS } = {}) {
  const groups = [];
  let from = 0, chars = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const n0 = i - from;
    const added = (n0 ? chars + 1 : 0) + t.length;
    if (n0 > 0 && (n0 >= maxWords || added > maxChars)) { groups.push([from, i]); from = i; chars = t.length; } else chars = added;
    if (SENTENCE_END.test(t) || (SOFT_BREAK.test(t) && i - from + 1 >= 3)) { groups.push([from, i + 1]); from = i + 1; chars = 0; }
  }
  if (from < tokens.length) groups.push([from, tokens.length]);
  return groups;
}

/**
 * Align spoken words (ms) with the written text: keeps written tokens + punctuation; a run of spoken words that
 * matches no token (number/unit read aloud) becomes ONE item showing the skipped written tokens.
 */
function alignWords(words, text) {
  const toks = clean(text).split(' ').filter(Boolean);
  if (!toks.length || !words.length) return words;
  const keys = toks.map(wordKey);
  const out = [];
  let j = 0, pending = [];
  const flush = (skipped) => {
    if (pending.length && skipped.length) {
      const a = pending[0], z = pending[pending.length - 1];
      out.push({ text: skipped.join(' '), offsetMs: a.offsetMs, durationMs: z.offsetMs + z.durationMs - a.offsetMs });
    } else {
      out.push(...pending);
      const p = skipped.length ? TRAIL_PUNCT.exec(skipped[skipped.length - 1]) : null; // unspoken token: keep its punctuation
      const last = out[out.length - 1];
      if (p && last && !TRAIL_PUNCT.test(last.text)) out[out.length - 1] = { ...last, text: last.text + p[0] };
    }
    pending = [];
  };
  for (const w of words) {
    const k = wordKey(w.text);
    let hit = -1;
    if (k) for (let t = j; t < Math.min(toks.length, j + LOOKAHEAD); t++) if (keys[t] === k) { hit = t; break; }
    if (hit < 0) { pending.push(w); continue; }
    flush(toks.slice(j, hit));
    out.push({ ...w, text: toks[hit] });
    j = hit + 1;
  }
  flush(toks.slice(j));
  return out;
}

/**
 * @param {{text:string, offsetMs:number, durationMs:number}[]} words
 * @param {{text?:string, offsetMs?:number, maxWords?:number, maxChars?:number}} [o]  offsetMs shifts every cue (scene start).
 * @returns {{startMs:number, endMs:number, text:string, words:object[]}[]}
 */
function cuesFromWords(words, o = {}) {
  let ws = (words || []).map((w) => ({ ...w, text: clean(w.text) })).filter((w) => w.text);
  if (o.text) ws = alignWords(ws, o.text);
  if (!ws.length) return [];
  const off = o.offsetMs || 0;
  return groupTokens(ws.map((w) => w.text), o).map(([a, b]) => {
    const startMs = Math.max(0, ws[a].offsetMs) + off;
    const endMs = Math.max(startMs, ws[b - 1].offsetMs + ws[b - 1].durationMs + off);
    return { startMs: Math.round(startMs), endMs: Math.round(endMs), text: ws.slice(a, b).map((w) => w.text).join(' '), words: ws.slice(a, b) };
  }).filter((c) => c.endMs - c.startMs > 0);
}

/** No timings: split into cues, give each a share of `durationMs` proportional to its length. */
function cuesFromText(text, durationMs, o = {}) {
  const toks = clean(text).split(' ').filter(Boolean);
  if (!toks.length || !(durationMs > 0)) return [];
  const parts = groupTokens(toks, o).map(([a, b]) => toks.slice(a, b).join(' '));
  const total = parts.reduce((s, p) => s + p.length, 0);
  let t = o.offsetMs || 0;
  return parts.map((p) => { const d = (p.length / total) * durationMs; const c = { startMs: Math.round(t), endMs: Math.round(t + d), text: p }; t += d; return c; });
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function clock(ms, sep) {
  const v = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(v / 3_600_000))}:${pad(Math.floor((v % 3_600_000) / 60_000))}:${pad(Math.floor((v % 60_000) / 1000))}${sep}${pad(v % 1000, 3)}`;
}
const srtTime = (ms) => clock(ms, ',');
const vttTime = (ms) => clock(ms, '.');

/** SRT with CRLF (some Windows players and editors want it); UTF-8 — add a BOM yourself if a player needs one. */
const toSrt = (cues) => cues.map((c, i) => `${i + 1}\r\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\r\n${c.text.replace(/\r?\n/g, '\r\n')}\r\n`).join('\r\n');
const toVtt = (cues) => `WEBVTT\n\n${cues.map((c) => `${vttTime(c.startMs)} --> ${vttTime(c.endMs)}\n${c.text}\n`).join('\n')}`;

module.exports = { cuesFromWords, cuesFromText, alignWords, groupTokens, wordKey, toSrt, toVtt, srtTime, vttTime, MAX_WORDS, MAX_CHARS };
