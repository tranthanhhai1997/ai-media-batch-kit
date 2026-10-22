'use strict';
/**
 * Multi-voice dubbing (narrator + one voice per character) — pure functions, no I/O, no deps.
 * Ported from a production video app (A) that dubs drama scripts; every rule below fixed a real bug there.
 *
 *   const mv = require('./multi-voice');
 *   const chars = [{ name: 'Lan', description: 'Lan, cô gái ba mươi tuổi' }, { name: 'Bắp', description: 'Bắp là mèo đực con' }];
 *   const cast = mv.castVoices(chars, voices, { narratorVoice: 'vi-VN-HoaiMyNeural' });   // name → voice id
 *   const lines = mv.parseScript('Lan mỉm cười: "Con về rồi." Bắp kêu lên.', chars);
 *   const chunks = mv.planChunks(lines, (who) => cast.get(who), 'vi-VN-HoaiMyNeural', { maxChars: 220 });
 *   const gaps = mv.gapsAfter(chunks);            // 0.45 s when the speaker changes, 0.12 s same speaker
 *   // → TTS each chunk with chunk.voice, then audio.concatWav(buffers, { gapsSec: gaps })
 *
 * Script format understood: `Tên hành động: "lời thoại"` (narrator reads the action tag, the character reads the
 * quote), `"lời thoại," Tên nói.`, quote-only sentences (= last speaker), and `Tên: lời` without quotes.
 * A bare name label ("Dâu Tây:") is never read aloud.
 */
const { createHash } = require('node:crypto');
const { splitSentences } = require('./chunk');

const NARRATOR = 'narrator';
const QUOTES = '"“”«»„‟';

/** lowercase + strip Vietnamese tone marks (đ→d) for name matching */
function fold(s) {
  return String(s ?? '').normalize('NFD').toLowerCase().replace(/đ/g, 'd').replace(/\p{Mn}/gu, '');
}
// Word boundary that understands Vietnamese letters: plain \b treats "à" as a non-word char.
const wordRe = (pat, flags = 'gu') => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pat})(?![\\p{L}\\p{N}_])`, flags);
const count = (pat, text) => (text.match(wordRe(pat)) || []).length;

// ───────── gender / age from a free-text description ─────────
const F_STRONG = 'phụ nữ|người phụ nữ|cô gái|thiếu nữ|bé gái|con gái|nữ giới|nữ|bà lão|cụ bà|woman|female|girl|lady';
const M_STRONG = 'đàn ông|người đàn ông|nam giới|chàng trai|thanh niên|bé trai|con trai|ông lão|cụ ông|man|male|boy|gentleman';
const F_WEAK = 'bà|mẹ|chị|cô|vợ|nàng|em gái|mother|grandmother|wife|sister|she|her';
const M_WEAK = 'ông|bố|cha|anh|chú|chồng|cậu|em trai|father|grandfather|husband|brother|he|his';
// "nam" also means "south": drop place names before counting gender words (A: "người Việt Nam" → male).
const NOT_GENDER = /việt nam|miền nam|nam bộ|phương nam|phía nam|hướng nam|nam phi|nam mỹ|hàn quốc/g;
const F_ANIMAL = '(?:con|mèo|chó|cún|thỏ|gà|vịt|chim|gấu|cáo|sóc|heo|lợn|ngựa|hổ|sư tử|khỉ|chuột|cá)(?:\\s+con)?\\s+cái';
const ROLE_F = 'là\\s+(?:một\\s+)?(?:\\p{L}+\\s+){0,2}(?:mẹ|bà|chị|cô gái|cô|vợ|nàng|em gái|con gái)';
const ROLE_M = 'là\\s+(?:một\\s+)?(?:\\p{L}+\\s+){0,2}(?:bố|cha|ông|anh|chú|chồng|cậu bé|cậu|em trai|con trai)';
const VI_DIGIT = { không: 0, một: 1, mốt: 1, hai: 2, ba: 3, bốn: 4, tư: 4, năm: 5, lăm: 5, sáu: 6, bảy: 7, tám: 8, chín: 9 };

/** "ba mươi" → 30, "mười hai" → 12, "năm" → 5, "bốn mươi lăm" → 45 (2 digits max). */
function viNumber(words) {
  if (!words.length) return null;
  if (words[0] === 'mười') {
    if (words.length === 1) return 10;
    const u = VI_DIGIT[words[1]];
    return u !== undefined && words.length === 2 ? 10 + u : null;
  }
  const t = VI_DIGIT[words[0]];
  if (t === undefined) return null;
  if (words.length === 1) return t;
  if (words[1] !== 'mươi') return null;
  if (words.length === 2) return t * 10;
  const u = VI_DIGIT[words[2]];
  return u !== undefined && words.length === 3 ? t * 10 + u : null;
}

function ageIn(t) {
  const m = /(\d{1,3})\s*(?:tuổi|years?[ -]old|yo\b)/u.exec(t);
  if (m) return Number(m[1]);
  // Ages written in words ("ba mươi tuổi") were read as nothing → everyone got the default age (A).
  for (const mm of t.matchAll(/((?:\p{L}+\s+){1,3})tuổi/gu)) {
    const ws = mm[1].trim().split(/\s+/);
    for (let k = Math.min(3, ws.length); k > 0; k--) {
      const n = viNumber(ws.slice(-k));
      if (n !== null && n > 0 && n < 120) return n;
    }
  }
  return null;
}

/**
 * @returns {{gender:'male'|'female'|null, age:number|null}}
 * Descriptions often start with the channel's art-style sentence, so only the text from the character's
 * name onward (≤ 320 chars) is used — before that fix every cat was "female, 72" (A).
 */
function inferGenderAge(name, desc) {
  let t = `${String(desc ?? '')} `.normalize('NFC').toLowerCase().replace(NOT_GENDER, ' ');
  const n = String(name ?? '').normalize('NFC').toLowerCase().trim();
  const i = n ? t.indexOf(n) : -1;
  if (i >= 0) t = t.slice(i, i + 320);
  let gender;
  if (count('đực', t) || new RegExp(`${ROLE_M}(?!\\p{L})`, 'u').test(t)) gender = 'male'; // explicit markers win
  else if (new RegExp(F_ANIMAL, 'u').test(t) || new RegExp(`${ROLE_F}(?!\\p{L})`, 'u').test(t)) gender = 'female';
  else {
    const f = 3 * count(F_STRONG, t) + count(F_WEAK, t);
    const m = 3 * count(M_STRONG, t) + count(M_WEAK, t);
    gender = f > m ? 'female' : m > f ? 'male' : null;
  }
  let age = ageIn(t);
  if (age === null) {
    // word-boundary match: "già" (old) must not hit "giàu" (rich) — that bug made rich people 72 (A).
    if (count('cụ ông|cụ bà|bà lão|ông lão|già|lớn tuổi|elderly|old man|old woman', t)) age = 72;
    else if (count('em bé|đứa trẻ|cậu bé|cô bé|bé gái|bé trai|child|kid|little boy|little girl', t)
      || /(?<!\p{L})(?:mèo|chó|cún|thỏ|gà|vịt|gấu|heo|lợn)(?:\s+(?:đực|cái))?\s+con(?!\p{L})/u.test(t)) age = 8; // "mèo con", "mèo đực con"
    else if (count('thiếu nữ|học sinh|teen|teenager', t)) age = 16;
  }
  return { gender, age };
}

const ageBand = (age) => (age == null ? 'adult' : age < 13 ? 'child' : age < 30 ? 'young' : age < 55 ? 'adult' : 'elder');
const BAND_WORDS = {
  child: ['trẻ', 'cao', 'sáng', 'tươi', 'child', 'kid', 'young', 'high', 'bright'],
  young: ['trẻ', 'tươi', 'sáng', 'năng động', 'cao', 'nhanh', 'young', 'bright', 'energetic', 'youthful'],
  adult: ['ấm', 'rõ', 'truyền cảm', 'chắc', 'tự nhiên', 'nhẹ nhàng', 'warm', 'clear', 'natural', 'confident', 'firm'],
  elder: ['trầm', 'ấm', 'chậm', 'già', 'lớn tuổi', 'kể chuyện', 'deep', 'mature', 'old', 'elderly', 'calm', 'wise'],
};

/** Gender of a voice entry {gender?, name?, label?}: explicit field first, then words in its name. */
function voiceGender(v) {
  const g = String(v.gender ?? '').trim().toLowerCase();
  if (g.startsWith('f') || g === 'nữ' || g === 'nu') return 'female';
  if (g.startsWith('m') || g === 'nam') return 'male';
  const s = `${v.name ?? ''} ${v.label ?? ''}`.toLowerCase();
  if (/female|(?<!\p{L})nữ(?!\p{L})|\bwoman\b|\bgirl\b/u.test(s)) return 'female';
  if (/(?<!fe)male|\(nam\)|\bman\b|\bboy\b/.test(s)) return 'male';
  return null;
}

/**
 * Score voices for one person. voices: [{id, gender?, desc?, label?, installed?}].
 * Wrong gender −12, right +10; age words in the voice description +2 each; voices already used −9;
 * ties broken by a stable hash of (seed + id) so the same character keeps the same voice across runs.
 */
function pickVoice({ gender, age } = {}, voices = [], { avoid = new Set(), seed = '' } = {}) {
  if (!voices.length) return null;
  const band = ageBand(age);
  let best = null, bestS = -Infinity;
  for (const v of voices) {
    let s = 0;
    const vg = v.gender ? voiceGender(v) : voiceGender(v);
    if (gender && vg) s += vg === gender ? 10 : -12;
    const text = `${v.desc ?? ''} ${v.label ?? ''}`.toLowerCase();
    s += BAND_WORDS[band].filter((w) => text.includes(w)).length * 2;
    if ((band === 'elder' || band === 'adult') && /trẻ|young/.test(text)) s -= 2;
    if ((band === 'child' || band === 'young') && /trầm|deep|già/.test(text)) s -= 2;
    if (v.installed === true) s += 1;
    if (avoid.has(v.id)) s -= 9;
    s += parseInt(createHash('md5').update(seed + v.id).digest('hex').slice(0, 4), 16) / 65535;
    if (s > bestS) { best = v.id; bestS = s; }
  }
  return best;
}

/**
 * characters: [{name, description?, gender?, age?, voice?}] (explicit gender/age/voice win over inference).
 * @returns {Map<string,string>} name → voice id; avoids the narrator voice and repeats while voices last.
 */
function castVoices(characters, voices, { narratorVoice, seed = '' } = {}) {
  const cast = new Map();
  const used = new Set(narratorVoice ? [narratorVoice] : []);
  for (const c of characters || []) {
    if (c.voice) { cast.set(c.name, c.voice); used.add(c.voice); continue; }
    const inf = inferGenderAge(c.name, c.description || '');
    const id = pickVoice({ gender: c.gender || inf.gender, age: c.age ?? inf.age }, voices, { avoid: used, seed: seed + c.name });
    if (id) { cast.set(c.name, id); used.add(id); }
  }
  return cast;
}

// ───────── who speaks which part of a sentence ─────────
/** First character name mentioned (Vietnamese subject comes first: "Hạnh nhìn Lan: …" → Hạnh). */
function matchSpeaker(text, chars) {
  const ft = fold(text);
  let best = null, bestPos = Infinity, bestLen = 0;
  for (const c of chars || []) {
    for (const n of [c.name, ...(c.aliases || [])]) {
      const fn = fold(n).trim();
      if (fn.length < 2) continue;
      const m = new RegExp(`(?<![a-z0-9])${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).exec(ft);
      if (m && (m.index < bestPos || (m.index === bestPos && fn.length > bestLen))) { best = c.name; bestPos = m.index; bestLen = fn.length; }
    }
  }
  return best;
}

const QUOTE_RE = /(“[^”]{2,}”|"[^"]{2,}"|«[^»]{2,}»)/;
const stripQ = (s) => s.replace(new RegExp(`^[${QUOTES}\\s]+|[${QUOTES}\\s]+$`, 'g'), '');

/** A quote is SPEECH (not a quoted term like "tiền riêng"): ≥ 2 words and (":"/dash before it, starts the sentence, or ends with punctuation). */
function isSpeech(before, quote) {
  const inner = stripQ(quote);
  if (inner.split(/\s+/).filter(Boolean).length < 2) return false;
  const b = before.trimEnd();
  return /[:—–-]$/.test(b) || !b.replace(/[ ,.;]/g, '') || /[.!?…,]$/.test(inner);
}

const hasLetter = (s) => /[\p{L}\p{N}]/u.test(s);

/**
 * One sentence → parts [{who, text}] (who = NARRATOR or a character name). Texts concatenate back to the sentence.
 * @returns {{parts:{who:string,text:string}[], lastSpeaker:string|null}}
 */
function splitSentence(sentence, chars, lastSpeaker = null) {
  const qCount = [...sentence].filter((ch) => QUOTES.includes(ch)).length;
  // Unbalanced quote: a sentence splitter cut INSIDE the speech at "?"/"!" (A). Opening piece "Tên: "…" =
  // that character; closing piece "…"" = continuation of whoever spoke last.
  if (qCount % 2 === 1) {
    const qi = [...QUOTES].map((q) => sentence.indexOf(q)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    const head = sentence.slice(0, qi);
    if (/:\s*$/.test(head)) {
      const sp = matchSpeaker(head, chars) || lastSpeaker;
      if (sp) return { parts: [{ who: NARRATOR, text: head }, { who: sp, text: sentence.slice(qi) }], lastSpeaker: sp };
    } else if ((!hasLetter(head) || qi > sentence.trimEnd().replace(/[.!?…]+$/, '').length - 2) && lastSpeaker) {
      return { parts: [{ who: lastSpeaker, text: sentence }], lastSpeaker };
    }
  }
  const pieces = sentence.split(QUOTE_RE);
  if (pieces.length === 1) {
    // No quotes: "Lan: Con về rồi." / "Lan mỉm cười: Con về rồi." — a label that starts with a known name.
    const m = /^([^:"“«]{1,60}?:\s*)(\S.*)$/su.exec(sentence);
    if (m) {
      const sp = matchSpeaker(m[1], chars);
      if (sp && fold(m[1]).trim().startsWith(fold(sp))) return { parts: [{ who: NARRATOR, text: m[1] }, { who: sp, text: m[2] }], lastSpeaker: sp };
    }
    return { parts: [{ who: NARRATOR, text: sentence }], lastSpeaker: matchSpeaker(sentence, chars) || lastSpeaker };
  }
  const parts = [];
  let seen = null;
  pieces.forEach((p, i) => {
    if (!p) return;
    if (i % 2 === 1 && isSpeech(pieces[i - 1], p)) {
      const before = hasLetter(pieces[i - 1]) ? pieces[i - 1] : '';
      const after = pieces[i + 1] || '';
      let sp = (before && matchSpeaker(before, chars)) || matchSpeaker(after, chars);
      if (!sp && !hasLetter(sentence.replace(p, ''))) sp = lastSpeaker; // quote-only sentence
      if (sp) { parts.push({ who: sp, text: p }); seen = sp; return; }
    }
    parts.push({ who: NARRATOR, text: p });
  });
  return { parts: mergeSame(parts), lastSpeaker: seen || matchSpeaker(sentence, chars) || lastSpeaker };
}

const mergeSame = (parts) => parts.reduce((acc, p) => {
  const last = acc[acc.length - 1];
  if (last && last.who === p.who) last.text += p.text; else acc.push({ ...p });
  return acc;
}, []);

/**
 * Repair parts that an LLM labeller produced: it often gives the WHOLE `Tên hành động: "…"` to the character,
 * so the action tag was read in the character's voice (A, 15/15 lines in one video). Narration before the
 * opening / after the closing quote goes back to the narrator. Quoted terms and closing fragments stay.
 */
function fixTaggedParts(parts) {
  const out = [];
  for (const p of parts || []) {
    const t = String(p.text ?? '');
    const qs = [...t].map((c, i) => (QUOTES.includes(c) ? i : -1)).filter((i) => i >= 0);
    if (p.who === NARRATOR || !qs.length) { out.push(p); continue; }
    const a = qs[0];
    let b = qs[qs.length - 1];
    if (qs.length === 1) {
      if (!hasLetter(t.slice(a + 1).replace(new RegExp(`[${QUOTES}]`, 'g'), ''))) { out.push(p); continue; } // "…nhanh thế"" closing fragment
      b = t.length - 1;
    }
    let pre = t.slice(0, a), mid = t.slice(a, b + 1);
    const suf = t.slice(b + 1);
    if (!(/[:：—–]\s*$/.test(pre) || isSpeech(pre, mid))) { out.push(p); continue; }
    if (hasLetter(pre)) out.push({ who: NARRATOR, text: pre }); else mid = pre + mid;
    if (hasLetter(suf)) out.push({ ...p, text: mid }, { who: NARRATOR, text: suf });
    else out.push({ ...p, text: mid + suf });
  }
  return mergeSame(out);
}

/**
 * Whole script → lines (one array of parts per sentence). Sentences are re-joined while a quote is open, so
 * `Hạnh: "Cháo à? Sao mẹ nấu?"` stays one sentence.
 */
function parseScript(script, chars) {
  const raw = Array.isArray(script) ? script : splitSentences(script);
  const sentences = [];
  let buf = '';
  for (const s of raw) {
    buf = buf ? `${buf} ${s}` : s;
    const open = [...buf].filter((ch) => '"'.includes(ch)).length % 2 === 1 || (buf.split('“').length !== buf.split('”').length);
    if (!open) { sentences.push(buf); buf = ''; }
  }
  if (buf) sentences.push(buf);
  let last = null;
  return sentences.map((s) => { const r = splitSentence(s, chars, last); last = r.lastSpeaker; return r.parts; });
}

/** "Dâu Tây:" / "— Dâu Tây" next to Dâu Tây's own line = speaker label, not narration → not read. */
function isNameLabel(text, who) {
  if (!who || who === NARRATOR) return false;
  const t = fold(text).replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, '');
  return !!t && t === fold(who).trim();
}

/**
 * Lines → TTS chunks, one voice per chunk, ≤ maxChars (a single long sentence may exceed it).
 * @param {(who:string)=>string|undefined} voiceOf  character → voice id (missing → narrator voice)
 * @param {{maxChars?:number, readActionTags?:boolean, transform?:(t:string)=>string}} [o]
 *   readActionTags=false: drop narration that ends with ":" right before speech (characters speak on screen).
 * @returns {{text:string, voice:string, who:string}[]}
 */
function planChunks(lines, voiceOf, narratorVoice, o = {}) {
  const maxChars = o.maxChars || 220;
  const chunks = [];
  let cur = null;
  for (const ln of lines) {
    ln.forEach((p, j) => {
      const prev = ln[j - 1], next = ln[j + 1];
      if (p.who === NARRATOR && ((next && isNameLabel(p.text, next.who)) || (prev && isNameLabel(p.text, prev.who)))) return;
      if (p.who === NARRATOR && o.readActionTags === false && next && next.who !== NARRATOR && /[:：]\s*$/.test(p.text)) return;
      let t = String(p.text).replace(/\s+/g, ' ').trim();
      if (t && p.who !== NARRATOR) {
        // Whole 'Dâu Tây: "…"' given to Dâu Tây → cut the name prefix (the voice read the name, A).
        const nm = String(p.who).trim();
        if (fold(t.slice(0, nm.length)) === fold(nm) && /^\s*[:：—–-]/.test(t.slice(nm.length))) t = t.slice(nm.length).replace(/^\s*[:：—–-]\s*/, '');
      }
      if (t && o.transform) t = o.transform(t).trim();
      if (!t) return;
      if (!hasLetter(t)) { if (cur) cur.text += t; return; } // a lone '?' after a quote joins the previous chunk
      const voice = p.who === NARRATOR ? narratorVoice : voiceOf(p.who) || narratorVoice;
      if (cur && (voice !== cur.voice || cur.text.length + t.length + 1 > maxChars)) { chunks.push(cur); cur = null; }
      if (cur) cur.text += ` ${t}`; else cur = { text: t, voice, who: p.who };
    });
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Silence after each chunk. Joined with a crossfade the dialogue sounded like one person reading on (A);
 * 0.45 s at a change of voice and 0.12 s between pieces of the same voice made it sound like a scene.
 */
function gapsAfter(chunks, { switchSec = 0.45, sameSec = 0.12 } = {}) {
  return chunks.map((c, i) => (i === chunks.length - 1 ? 0 : chunks[i + 1].voice !== c.voice ? switchSec : sameSec));
}

module.exports = {
  NARRATOR, inferGenderAge, ageBand, voiceGender, pickVoice, castVoices, matchSpeaker, isSpeech,
  splitSentence, fixTaggedParts, parseScript, isNameLabel, planChunks, gapsAfter, fold, viNumber,
};
