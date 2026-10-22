'use strict';
/**
 * Microsoft Edge "Read Aloud" voices (free, no key) through the open-source python package **edge-tts**
 * (https://github.com/rany2/edge-tts, LGPL-3.0). We do NOT bundle or re-implement its protocol/token code:
 * this module only runs the package the user installed (`pip install edge-tts`) in a child process and reads
 * the result, so this MIT repo stays license-clean and every protocol fix lands with `pip install -U edge-tts`.
 *
 * ⚠ UNOFFICIAL service: it is the endpoint the Edge browser uses; no SLA, Microsoft can change or block it
 *   (it did in 10/2026 — fixed upstream in edge-tts 7.x). Keep a fallback provider. For guaranteed / commercial
 *   use, Azure AI Speech is the official paid service with the same neural voices.
 *
 *   const edge = require('./edge-tts');
 *   const r = await edge.synthesize({ text: 'Xin chào các em!', voice: 'vi-VN-HoaiMyNeural', rate: -4 });
 *   fs.writeFileSync('a.mp3', r.buffer);            // r.words = [{ text, offsetMs, durationMs }]
 *   const vi = (await edge.listVoices()).filter((v) => v.Locale === 'vi-VN');   // HoaiMy (F), NamMinh (M)
 *
 * Python: env EDGE_TTS_PYTHON, else `python` (Windows also tries `py -3`). Tested with edge-tts 7.2.8.
 * Errors: EdgeTtsError.code = EDGE_NOT_INSTALLED | EDGE_FORBIDDEN | EDGE_NETWORK | EDGE_TIMEOUT | EDGE_NO_AUDIO | EDGE_BAD_INPUT.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mp3Duration } = require('./audio');

const TIMEOUT_MS = 180_000;

class EdgeTtsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'EdgeTtsError'; }
}

// Runs inside python: stream audio to a file, print word boundaries as JSON lines (offsets in 100-ns ticks).
const PY_SYNTH = `
import asyncio, json, sys
import edge_tts
a = json.loads(sys.stdin.read())
async def main():
    kw = dict(rate=a["rate"], pitch=a["pitch"], volume=a["volume"])
    try:
        c = edge_tts.Communicate(a["text"], a["voice"], boundary="WordBoundary", **kw)
    except TypeError:  # edge-tts < 7 has no boundary argument (word boundaries were the default)
        c = edge_tts.Communicate(a["text"], a["voice"], **kw)
    with open(a["out"], "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                print(json.dumps({"t": ch["text"], "o": ch["offset"], "d": ch["duration"]}, ensure_ascii=False), flush=True)
asyncio.run(main())
`;
const PY_VOICES = `
import asyncio, json, edge_tts
print(json.dumps(asyncio.run(edge_tts.list_voices()), ensure_ascii=False))
`;

function pythonCandidates() {
  if (process.env.EDGE_TTS_PYTHON) return [[process.env.EDGE_TTS_PYTHON, []]];
  return process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
}

/** Run a python snippet; resolves {stdout, stderr, code}. Injectable for tests via o.runPython. */
function runPython(script, stdin, { timeoutMs = TIMEOUT_MS } = {}) {
  const cands = pythonCandidates();
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      if (i >= cands.length) return reject(new EdgeTtsError('EDGE_NOT_INSTALLED', 'python not found — install Python 3 and `pip install edge-tts` (or set EDGE_TTS_PYTHON)'));
      const [cmd, pre] = cands[i];
      let child;
      try {
        child = spawn(cmd, [...pre, '-X', 'utf8', '-c', script], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      } catch (_) { return tryAt(i + 1); }
      let out = ''; let err = ''; let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new EdgeTtsError('EDGE_TIMEOUT', `edge-tts did not finish in ${timeoutMs} ms`)); } }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { if (done) return; clearTimeout(timer); if (e.code === 'ENOENT') tryAt(i + 1); else { done = true; reject(new EdgeTtsError('EDGE_NETWORK', e.message)); } });
      child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, code }); });
      child.stdin.end(stdin || '');
    };
    tryAt(0);
  });
}

function classify(stderr) {
  const s = String(stderr || '');
  if (/No module named ['"]?edge_tts/.test(s)) return new EdgeTtsError('EDGE_NOT_INSTALLED', 'python package edge-tts missing — run: pip install -U edge-tts');
  if (/\b403\b|Forbidden/i.test(s)) return new EdgeTtsError('EDGE_FORBIDDEN', 'service refused the request (403) — update the package: pip install -U edge-tts');
  if (/NoAudioReceived|No audio was received/i.test(s)) return new EdgeTtsError('EDGE_NO_AUDIO', 'no audio received (bad voice name or unsupported text?)');
  return new EdgeTtsError('EDGE_NETWORK', s.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400) || 'edge-tts failed');
}

/** −4 → "-4%", "+10%" stays; pitch in Hz. */
function fmt(v, unit) {
  if (v == null || v === '') return `+0${unit}`;
  if (typeof v === 'string' && /^[+-]?\d+(\.\d+)?(%|Hz)$/.test(v.trim())) return v.trim().replace(/^(\d)/, '+$1');
  const n = Math.round(Number(v) || 0);
  return `${n >= 0 ? '+' : ''}${n}${unit}`;
}

/**
 * @param {{text:string, voice:string, rate?:number|string, pitch?:number|string, volume?:number|string,
 *          timeoutMs?:number, retries?:number, runPython?:Function}} o
 *   rate/volume: percent (−50 = half speed), pitch: Hz (+18 Hz turns an adult VI voice into a "child" voice — C).
 *   Long text is fine: edge-tts splits it itself and offsets stay continuous.
 * @returns {Promise<{buffer:Buffer, mime:'audio/mpeg', durationMs:number, words:{text:string,offsetMs:number,durationMs:number}[]}>}
 */
async function synthesize(o) {
  if (!o || !o.voice) throw new EdgeTtsError('EDGE_BAD_INPUT', 'voice is required, e.g. vi-VN-HoaiMyNeural');
  const text = String(o.text || '').normalize('NFC').trim(); // decomposed Vietnamese (NFD) is read badly
  if (!text) throw new EdgeTtsError('EDGE_BAD_INPUT', 'empty text');
  const run = o.runPython || runPython;
  const retries = o.retries == null ? 2 : o.retries;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const out = path.join(os.tmpdir(), `edge-tts-${process.pid}-${Date.now()}-${attempt}.mp3`);
    try {
      const args = JSON.stringify({ text, voice: o.voice, rate: fmt(o.rate, '%'), pitch: fmt(o.pitch, 'Hz'), volume: fmt(o.volume, '%'), out });
      const r = await run(PY_SYNTH, args, { timeoutMs: o.timeoutMs || TIMEOUT_MS });
      const buffer = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
      if (r.code !== 0) throw classify(r.stderr);
      if (!buffer.length) throw new EdgeTtsError('EDGE_NO_AUDIO', 'no audio received');
      const words = [];
      for (const line of String(r.stdout).split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try { const w = JSON.parse(line); words.push({ text: w.t, offsetMs: Math.round(w.o / 1e4), durationMs: Math.round(w.d / 1e4) }); } catch (_) {}
      }
      return { buffer, mime: 'audio/mpeg', durationMs: Math.round((mp3Duration(buffer) || 0) * 1000), words };
    } catch (e) {
      last = e instanceof EdgeTtsError ? e : new EdgeTtsError('EDGE_NETWORK', e.message);
      if (['EDGE_NOT_INSTALLED', 'EDGE_BAD_INPUT'].includes(last.code)) throw last; // retrying won't help
      // NO_AUDIO is often transient on long text (live 22/10/2026: same text OK on the next try) → retry
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    } finally {
      try { fs.unlinkSync(out); } catch (_) {}
    }
  }
  throw last;
}

/** Voice catalog: [{ Name, ShortName, Gender, Locale, FriendlyName, VoiceTag }]. */
async function listVoices(o = {}) {
  const r = await (o.runPython || runPython)(PY_VOICES, '', { timeoutMs: 60_000 });
  if (r.code !== 0) throw classify(r.stderr);
  try { return JSON.parse(r.stdout); } catch (_) { throw new EdgeTtsError('EDGE_NETWORK', 'bad voice list output'); }
}

/** Voices that worked in (C) (static list, no network). Child voices = adult voice + pitch, see references. */
const KNOWN_VOICES = [
  { voice: 'vi-VN-HoaiMyNeural', gender: 'female', locale: 'vi-VN' },
  { voice: 'vi-VN-NamMinhNeural', gender: 'male', locale: 'vi-VN' },
  { voice: 'en-US-AriaNeural', gender: 'female', locale: 'en-US' }, { voice: 'en-US-JennyNeural', gender: 'female', locale: 'en-US' },
  { voice: 'en-US-GuyNeural', gender: 'male', locale: 'en-US' }, { voice: 'en-US-AndrewNeural', gender: 'male', locale: 'en-US' },
  { voice: 'en-US-EmmaNeural', gender: 'female', locale: 'en-US' }, { voice: 'en-US-BrianNeural', gender: 'male', locale: 'en-US' },
  { voice: 'en-US-AnaNeural', gender: 'female', locale: 'en-US', child: true },
  { voice: 'en-GB-SoniaNeural', gender: 'female', locale: 'en-GB' }, { voice: 'en-GB-RyanNeural', gender: 'male', locale: 'en-GB' },
  { voice: 'en-GB-ThomasNeural', gender: 'male', locale: 'en-GB' }, { voice: 'en-GB-MaisieNeural', gender: 'female', locale: 'en-GB', child: true },
  { voice: 'en-AU-NatashaNeural', gender: 'female', locale: 'en-AU' }, { voice: 'en-AU-WilliamNeural', gender: 'male', locale: 'en-AU' },
  { voice: 'zh-CN-XiaoxiaoNeural', gender: 'female', locale: 'zh-CN' }, { voice: 'zh-CN-YunxiNeural', gender: 'male', locale: 'zh-CN' },
  { voice: 'ja-JP-NanamiNeural', gender: 'female', locale: 'ja-JP' }, { voice: 'ja-JP-KeitaNeural', gender: 'male', locale: 'ja-JP' },
  { voice: 'ko-KR-SunHiNeural', gender: 'female', locale: 'ko-KR' }, { voice: 'ko-KR-InJoonNeural', gender: 'male', locale: 'ko-KR' },
];

/** XML-escape (kept for callers that measure SSML-ish byte length when chunking). */
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { synthesize, listVoices, EdgeTtsError, KNOWN_VOICES, escapeXml, fmt, classify, runPython };
