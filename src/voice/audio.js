'use strict';
/**
 * Audio helpers for TTS output. Pure JS for WAV/PCM (no deps); MP3 joins with gaps need ffmpeg.
 *
 *   pcmToWav(pcm, { sampleRate: 24000 })              // Gemini returns raw s16le PCM → playable WAV
 *   concatWav([a, b, c], { gapsSec: [0.45, 0.12] })     // join + silence between pieces (multi-voice turns)
 *   wavInfo(buf).durationSec · mp3Duration(buf)        // duration without ffprobe
 *   await concatFiles(['a.mp3','b.mp3'], 'out.mp3', { gapsSec: [0.3] })   // ffmpeg, any format
 *
 * Why MP3 gaps need ffmpeg: silence cannot be spliced into an MP3 byte stream without re-encoding
 * (frame headers + bit reservoir). Plain byte-concat of same-format MP3s (no gaps) does play — that is what
 * Edge chunks are (same voice, same bitrate) — but some players show a wrong duration; re-mux if it matters.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

class AudioError extends Error {
  /** @param {'AUDIO_BAD_WAV'|'AUDIO_FORMAT_MISMATCH'|'AUDIO_NO_FFMPEG'|'AUDIO_FFMPEG_FAILED'} code */
  constructor(code, message) { super(message); this.code = code; this.name = 'AudioError'; }
}

/** 44-byte canonical WAV header + PCM. */
function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Parse a PCM WAV by walking chunks (handles LIST/fact chunks and odd padding, not only 44-byte headers). */
function wavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioError('AUDIO_BAD_WAV', 'not a RIFF/WAVE buffer');
  }
  let fmt = null, data = null;
  for (let i = 12; i + 8 <= buf.length;) {
    const id = buf.toString('ascii', i, i + 4);
    let size = buf.readUInt32LE(i + 4);
    const body = i + 8;
    if (id === 'data' && (size === 0xffffffff || body + size > buf.length)) size = buf.length - body; // streamed WAVs
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') { data = buf.subarray(body, body + size); break; }
    i = body + size + (size % 2);
  }
  if (!fmt || !data) throw new AudioError('AUDIO_BAD_WAV', 'WAV without fmt/data chunk');
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return { ...fmt, data, durationSec: bytesPerSec ? data.length / bytesPerSec : 0 };
}

/** Zero PCM of `sec` seconds for the given format (frame-aligned). */
function silencePcm(sec, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const frames = Math.max(0, Math.round(sec * sampleRate));
  return Buffer.alloc(frames * channels * (bitsPerSample / 8));
}

/**
 * Join WAVs of the SAME format. gapsSec[i] = silence after piece i (number = same gap everywhere).
 * Different sample rates are refused instead of silently pitch-shifting — resample with ffmpeg first.
 */
function concatWav(buffers, { gapsSec = 0 } = {}) {
  if (!buffers.length) throw new AudioError('AUDIO_BAD_WAV', 'nothing to join');
  const infos = buffers.map(wavInfo);
  const f = infos[0];
  for (const x of infos) {
    if (x.sampleRate !== f.sampleRate || x.channels !== f.channels || x.bitsPerSample !== f.bitsPerSample) {
      throw new AudioError('AUDIO_FORMAT_MISMATCH', `format differs: ${x.sampleRate}/${x.channels}/${x.bitsPerSample} vs ${f.sampleRate}/${f.channels}/${f.bitsPerSample}`);
    }
  }
  const parts = [];
  infos.forEach((x, i) => {
    parts.push(x.data);
    const gap = Array.isArray(gapsSec) ? gapsSec[i] : i < infos.length - 1 ? gapsSec : 0;
    if (gap > 0) parts.push(silencePcm(gap, f));
  });
  return pcmToWav(Buffer.concat(parts), f);
}

// MPEG audio frame tables (bitrate kbps by version-layer, sample rates by version).
const BR = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SR = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** MP3 duration in seconds by walking frame headers (works for CBR and VBR); 0 if not MP3. */
function mp3Duration(b) {
  let i = 0;
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'ID3') {
    i = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
  }
  let sec = 0, frames = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const vb = (b[i + 1] >> 3) & 3, lb = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (vb === 1 || lb === 0 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }
    const ver = vb === 3 ? 1 : vb === 2 ? 2 : 25;
    const layer = 4 - lb;
    const br = BR[`${ver === 1 ? 1 : 2}-${layer}`][bri] * 1000;
    const sr = SR[ver][sri];
    const samples = layer === 1 ? 384 : layer === 2 || ver === 1 ? 1152 : 576;
    const len = layer === 1 ? (Math.floor((12 * br) / sr) + pad) * 4 : Math.floor(((samples / 8) * br) / sr) + pad;
    if (len < 4) { i++; continue; }
    sec += samples / sr;
    frames++;
    i += len;
  }
  return frames ? Math.round(sec * 1000) / 1000 : 0;
}

/** Duration of a WAV or MP3 buffer in seconds (0 if unknown). */
function durationOf(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') return wavInfo(buf).durationSec;
  return mp3Duration(buf);
}

/** Resolve an ffmpeg binary: explicit path → FFMPEG_PATH env → "ffmpeg" on PATH. Returns null if none runs. */
async function findFfmpeg(explicit) {
  for (const exe of [explicit, process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean)) {
    const ok = await new Promise((resolve) => {
      const p = spawn(exe, ['-version'], { stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('exit', (c) => resolve(c === 0));
    });
    if (ok) return exe;
  }
  return null;
}

function runFfmpeg(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => reject(new AudioError('AUDIO_NO_FFMPEG', e.message)));
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new AudioError('AUDIO_FFMPEG_FAILED', `ffmpeg exit ${c}: ${err.trim().slice(-400)}`))));
  });
}

/**
 * Join audio files (any format ffmpeg reads) with silence between them, re-encoding once.
 * Output format follows the extension (.mp3 → libmp3lame, .wav → pcm_s16le). Inputs are resampled to
 * `sampleRate` mono so mixed sources (Edge 24 kHz mp3 + Gemini 24 kHz wav + 44.1 kHz) line up.
 */
async function concatFiles(inputs, outFile, { gapsSec = 0, sampleRate = 24000, ffmpeg, bitrate = '128k' } = {}) {
  const exe = await findFfmpeg(ffmpeg);
  if (!exe) throw new AudioError('AUDIO_NO_FFMPEG', 'ffmpeg not found: install it or set FFMPEG_PATH (or write WAV and use concatWav)');
  const args = [];
  const labels = [];
  inputs.forEach((f, i) => {
    args.push('-i', f);
    labels.push(`[a${i}]`);
  });
  // Per-input: resample + pad silence at the end (apad), then concat — one filter graph, one encode.
  const filters = inputs.map((_, i) => {
    const gap = Array.isArray(gapsSec) ? gapsSec[i] || 0 : i < inputs.length - 1 ? gapsSec : 0;
    return `[${i}:a]aresample=${sampleRate},aformat=channel_layouts=mono${gap > 0 ? `,apad=pad_dur=${gap}` : ''}[a${i}]`;
  });
  filters.push(`${labels.join('')}concat=n=${inputs.length}:v=0:a=1[out]`);
  const codec = /.wav$/i.test(outFile) ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', bitrate];
  // Inline graph (~80 chars per input). Script files are avoided on purpose: -filter_complex_script was
  // removed in ffmpeg 8 and its replacement syntax differs by version (A: RENDER_FAILED on users' ffmpeg 8).
  // Windows caps a command line at ~32k chars → split very long lists (>300 files) into batches.
  await runFfmpeg(exe, [...args, '-filter_complex', filters.join(';'), '-map', '[out]', ...codec, outFile]);
  return outFile;
}

/** WAV/PCM buffer → MP3 file via ffmpeg (tempo 0.5–2 and volume optional). */
async function encodeMp3(input, outFile, { ffmpeg, tempo = 1, volume = 1, bitrate = '64k', pcm } = {}) {
  const exe = await findFfmpeg(ffmpeg);
  if (!exe) throw new AudioError('AUDIO_NO_FFMPEG', 'ffmpeg not found: install it or set FFMPEG_PATH');
  const tmp = path.join(os.tmpdir(), `voice-enc-${process.pid}-${Date.now()}.${pcm ? 'pcm' : 'wav'}`);
  fs.writeFileSync(tmp, input);
  const inArgs = pcm ? ['-f', 's16le', '-ar', String(pcm.sampleRate || 24000), '-ac', String(pcm.channels || 1), '-i', tmp] : ['-i', tmp];
  const af = [];
  if (tempo !== 1) af.push(`atempo=${Math.min(2, Math.max(0.5, tempo))}`);
  if (volume !== 1) af.push(`volume=${volume.toFixed(2)}`);
  try {
    await runFfmpeg(exe, [...inArgs, ...(af.length ? ['-af', af.join(',')] : []), '-c:a', 'libmp3lame', '-b:a', bitrate, outFile]);
  } finally { fs.rmSync(tmp, { force: true }); }
  return outFile;
}

module.exports = { AudioError, pcmToWav, wavInfo, silencePcm, concatWav, mp3Duration, durationOf, findFfmpeg, concatFiles, encodeMp3 };
