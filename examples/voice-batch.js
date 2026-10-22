'use strict';
/**
 * Batch TTS: a JSON list of lines (or dialogue scripts) → audio files + SRT subtitles.
 *
 *   node examples/voice-batch.js examples/voice.sample.json [outDir]
 *
 * Provider: spec.provider, else Gemini when GEMINI_API_KEY is set, else Edge (free, unofficial).
 *   edge   → <id>.mp3 + <id>.srt (word timings)          gemini → <id>.wav + <id>.srt (timed by length)
 *   ai33   → <id>.mp3 (+ .srt when the task returns a transcript), needs AI33_API_KEY (paid)
 * Items with "script": true use multi-voice dubbing (narrator + one voice per character) and need ffmpeg
 * to join the pieces with pauses (Gemini WAV pieces are joined in pure JS).
 * Already-existing outputs are skipped, so re-running after a crash only does what is missing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { runBatch } = require('../src/core/queue');
const { normalizeVi, looksVietnamese } = require('../src/voice/normalize-vi');
const edge = require('../src/voice/edge-tts');
const { createGeminiTts } = require('../src/voice/gemini-tts');
const { createAi33 } = require('../src/voice/ai33');
const mv = require('../src/voice/multi-voice');
const subs = require('../src/voice/subtitles');
const audio = require('../src/voice/audio');

async function main() {
  const [file, outArg] = process.argv.slice(2);
  if (!file) throw new Error('usage: node examples/voice-batch.js voice.json [outDir]');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const outDir = path.resolve(outArg || 'out/voice');
  fs.mkdirSync(outDir, { recursive: true });
  const provider = spec.provider || (process.env.GEMINI_API_KEY ? 'gemini' : 'edge');
  const p = spec[provider] || {};
  const ext = provider === 'gemini' ? '.wav' : '.mp3';

  let synth;
  if (provider === 'edge') {
    synth = async (text, voice) => edge.synthesize({ text, voice: voice || p.voice || 'vi-VN-HoaiMyNeural', rate: p.rate, pitch: p.pitch });
  } else if (provider === 'gemini') {
    const g = createGeminiTts({ keys: process.env.GEMINI_API_KEY, model: p.model });
    synth = async (text, voice) => g.synthesize({ text, voice: voice || p.voice || 'Kore', accent: p.accent || 'vi-n', style: p.style });
  } else if (provider === 'ai33') {
    const a = createAi33();
    synth = async (text, voice) => a.synthesize({ voiceId: voice || p.voice, text, speed: p.speed });
  } else throw new Error(`unknown provider ${provider}`);

  // Normalize only Vietnamese text: the normalizer would mangle English numbers ("3.5" → Vietnamese words).
  const prep = (t) => (spec.lang === 'vi' || (spec.lang == null && looksVietnamese(t)) ? normalizeVi(t) : t.replace(/\s+/g, ' ').trim());
  const jobs = spec.items.filter((it) => !fs.existsSync(path.join(outDir, it.id + ext)));
  console.log(`${provider}: ${jobs.length}/${spec.items.length} items to do → ${outDir}`);

  const res = await runBatch(jobs, {
    workers: Array.from({ length: spec.concurrency || 2 }, (_, i) => i), // Edge: keep it low (unofficial endpoint)
    retries: 2,
    cooldownMs: 65_000,
    run: async (it) => (it.script ? dialogue(it) : single(it)),
    classify: (e) => (/_(NETWORK|TIMEOUT|NO_AUDIO)$/.test(e.code || '') ? 'retry'
      : /_(QUOTA|RATE_LIMIT)$/.test(e.code || '') ? { action: 'cooldown', ms: e.retryAfterMs || 65_000 } : 'fail'),
    onDone: (it, r) => console.log(`✓ ${it.id} ${(r.durationMs / 1000).toFixed(1)} s`),
    onFail: (it, e) => console.error(`✗ ${it.id} ${e.code || ''} ${e.message}`),
  });

  async function single(it) {
    const r = await synth(prep(it.text), it.voice);
    fs.writeFileSync(path.join(outDir, it.id + ext), r.buffer);
    // Word timings are for the SPOKEN (normalized) text; align against the original so subtitles show "50 km".
    const cues = r.words.length ? subs.cuesFromWords(r.words, { text: it.text }) : subs.cuesFromText(it.text, r.durationMs);
    fs.writeFileSync(path.join(outDir, it.id + '.srt'), subs.toSrt(cues));
    return r;
  }

  async function dialogue(it) {
    const chars = spec.characters || [];
    const cast = new Map(Object.entries(spec.cast || {}));
    const lines = mv.parseScript(it.text, chars);
    const chunks = mv.planChunks(lines, (who) => cast.get(who), spec.narratorVoice || p.voice, { maxChars: 220, transform: prep });
    const gaps = mv.gapsAfter(chunks);
    const pieces = [];
    for (const c of chunks) pieces.push(await synth(c.text, c.voice));
    const out = path.join(outDir, it.id + ext);
    if (provider === 'gemini') fs.writeFileSync(out, audio.concatWav(pieces.map((x) => x.buffer), { gapsSec: gaps }));
    else {
      const tmp = pieces.map((x, i) => { const f = path.join(outDir, `.${it.id}.${i}${ext}`); fs.writeFileSync(f, x.buffer); return f; });
      try { await audio.concatFiles(tmp, out, { gapsSec: gaps }); } finally { tmp.forEach((f) => fs.rmSync(f, { force: true })); }
    }
    let t = 0;
    const cues = [];
    pieces.forEach((x, i) => { cues.push(...subs.cuesFromText(chunks[i].text, x.durationMs, { offsetMs: t })); t += x.durationMs + gaps[i] * 1000; });
    fs.writeFileSync(path.join(outDir, it.id + '.srt'), subs.toSrt(cues));
    return { durationMs: t };
  }

  const bad = res.filter((r) => !r.ok).length;
  console.log(`done: ${res.length - bad} ok, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e.code || '', e.message); process.exit(1); });
