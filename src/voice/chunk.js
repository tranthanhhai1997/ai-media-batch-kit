'use strict';
/**
 * Split long text into TTS-sized pieces at sentence boundaries, keeping punctuation. Pure, no deps.
 *
 * Why chunk at all:
 *  - Edge Read Aloud rejects / truncates SSML much over ~4 KB (UTF-8, after XML escaping).      (C) measured
 *  - Gemini TTS drifts in voice/pace on long inputs; 800 chars per call was stable.             (C)
 *  - OmniVoice estimates the frame count from text length; long sentences come out with the LAST
 *    syllable clipped ("xứng đáng" → "xứng"). 220 chars per piece + same seed fixed it.        (A) measured
 *
 *   splitText(longText, { maxChars: 800 })          → ['Câu 1. Câu 2.', 'Câu 3 …']
 *   splitText(t, { maxChars: 1500, maxBytes: 3500, measure: (s) => Buffer.byteLength(escapeXml(s)) })
 */

// End of sentence = punctuation (+ closing quotes) followed by whitespace, so "3.5" or "TP.HCM" never split.
const SENTENCE_END = /(?<=[.!?…;]["'”’»)\]]*)\s+|\s*\n\s*/;

/** Sentences with their trailing punctuation (and closing quotes) kept. */
function splitSentences(text) {
  const clean = String(text ?? '').replace(/[ \t\r\f\v]+/g, ' ').trim();
  if (!clean) return [];
  return clean.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {string} text
 * @param {{maxChars?:number, maxBytes?:number, measure?:(s:string)=>number}} [o]
 *   maxChars: char limit per piece (default 800). maxBytes + measure: extra byte limit (e.g. escaped UTF-8).
 * @returns {string[]} pieces; joining them with ' ' gives back the whitespace-collapsed text.
 */
function splitText(text, o = {}) {
  const maxChars = o.maxChars || 800;
  const measure = o.measure || ((s) => Buffer.byteLength(s, 'utf8'));
  const fits = (s) => s.length <= maxChars && (!o.maxBytes || measure(s) <= o.maxBytes);
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (fits(clean)) return [clean];

  const pieces = [];
  for (const s of splitSentences(clean)) {
    if (fits(s)) { pieces.push(s); continue; }
    // Sentence too long → cut after commas/semicolons, then between words; never mid-word unless one word is huge.
    let cur = '';
    for (const w of s.split(/(?<=[,，:;])\s*|\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (fits(next)) { cur = next; continue; }
      if (cur) pieces.push(cur);
      cur = w;
      while (!fits(cur)) { // a single "word" longer than the limit (URLs, no-space scripts)
        let n = Math.min(cur.length, maxChars);
        while (n > 1 && !fits(cur.slice(0, n))) n = Math.floor(n * 0.9);
        pieces.push(cur.slice(0, n));
        cur = cur.slice(n);
      }
    }
    if (cur) pieces.push(cur);
  }
  // Re-pack small sentences together up to the limit (fewer requests = fewer seams).
  const out = [];
  let cur = '';
  for (const p of pieces) {
    const next = cur ? `${cur} ${p}` : p;
    if (fits(next)) cur = next;
    else { if (cur) out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { splitText, splitSentences };
