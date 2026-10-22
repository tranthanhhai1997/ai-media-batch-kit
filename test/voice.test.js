'use strict';
const fs = require('node:fs');
// node test/voice.test.js — offline tests for src/voice (no network, no ffmpeg needed).
// Vietnamese cases come from the vitest suites of the lesson-video app (C) plus the voice-clone normalizer (A).
const assert = require('node:assert');
const { normalizeVi, readInteger, isViVoice, looksVietnamese } = require('../src/voice/normalize-vi');
const { splitText, splitSentences } = require('../src/voice/chunk');
const audio = require('../src/voice/audio');
const mv = require('../src/voice/multi-voice');
const subs = require('../src/voice/subtitles');
const edge = require('../src/voice/edge-tts');
const gem = require('../src/voice/gemini-tts');
const ai33 = require('../src/voice/ai33');

let fails = 0, passed = 0;
const pending = [];
const t = (name, fn) => pending.push(async () => {
  try { await fn(); passed++; } catch (e) { fails++; console.error('FAIL', name, '\n ', String(e.message).split('\n').slice(0, 8).join('\n  ')); }
});

// ───────── normalize-vi ─────────
const VI_CASES = [
  ['0', 'không'], ['5', 'năm'], ['10', 'mười'], ['15', 'mười lăm'], ['21', 'hai mươi mốt'], ['24', 'hai mươi tư'],
  ['25', 'hai mươi lăm'], ['11', 'mười một'], ['14', 'mười bốn'], ['105', 'một trăm linh năm'], ['110', 'một trăm mười'],
  ['1.005', 'một nghìn không trăm linh năm'], ['1.000.000', 'một triệu'], ['2.050.000', 'hai triệu không trăm năm mươi nghìn'],
  ['3.000.000.000', 'ba tỷ'], ['3,5', 'ba phẩy năm'], ['3,05', 'ba phẩy không năm'], ['3.14', 'ba phẩy mười bốn'],
  ['50%', 'năm mươi phần trăm'], ['3,5 km', 'ba phẩy năm ki lô mét'], ['60 km/h', 'sáu mươi ki lô mét trên giờ'],
  ['10 m/s', 'mười mét trên giây'], ['37°C', 'ba mươi bảy độ xê'], ['5kg', 'năm ki lô gam'], ['200 g', 'hai trăm gam'],
  ['2 l', 'hai lít'], ['500 ml', 'năm trăm mi li lít'], ['3 cm', 'ba xen ti mét'], ['20 m²', 'hai mươi mét vuông'],
  ['x^2', 'x bình phương'], ['x²', 'x bình phương'], ['x^3', 'x lập phương'], ['y^10', 'y mũ mười'], ['1/2', 'một phần hai'],
  ['3/4 cái bánh', 'ba phần bốn cái bánh'], ['x^2 - 5x + 6 = 0', 'x bình phương trừ năm x cộng sáu bằng không'],
  ['x = -5', 'x bằng âm năm'], ['3 × 4 ÷ 2 = 6', 'ba nhân bốn chia hai bằng sáu'], ['7 − 2 = 5', 'bảy trừ hai bằng năm'],
  ['(a + b)² = a² + 2ab + b²', 'mở ngoặc a cộng b đóng ngoặc bình phương bằng a bình phương cộng hai ab cộng b bình phương'],
  ['Năm 938, Ngô Quyền', 'Năm chín trăm ba mươi tám, Ngô Quyền'], ['năm 2024', 'năm hai nghìn không trăm hai mươi tư'],
  ['ngày 2/9/1945', 'ngày hai tháng chín năm một nghìn chín trăm bốn mươi lăm'], ['Ngày 30/4', 'Ngày ba mươi tháng tư'],
  ['TP. Hà Nội', 'thành phố Hà Nội'], ['TP. HCM', 'thành phố Hồ Chí Minh'], ['VD: táo, cam, v.v.', 'ví dụ: táo, cam, vân vân'],
  ['học sinh THCS', 'học sinh trung học cơ sở'], ['thứ 4', 'thứ tư'], ['lần thứ 1', 'lần thứ nhất'],
  ['2020-2021', 'hai nghìn không trăm hai mươi đến hai nghìn không trăm hai mươi mốt'], ['lúc 7:30', 'lúc bảy giờ ba mươi phút'],
  ['7h30', 'bảy giờ ba mươi phút'], ['0912345678', 'không chín một hai ba bốn năm sáu bảy tám'],
  ['Trang 5 (hình minh hoạ)', 'Trang năm (hình minh hoạ)'], ['Có 3 quả táo.', 'Có ba quả táo.'], ['a < b', 'a nhỏ hơn b'],
  ['x ≥ 2', 'x lớn hơn hoặc bằng hai'],
  ['Trái Đất quay quanh Mặt Trời.', 'Trái Đất quay quanh Mặt Trời.'], ['Bài học hôm nay - phần mở đầu', 'Bài học hôm nay - phần mở đầu'],
  // (A) voice-clone normalizer cases
  ['Giá chỉ 199.000đ', 'Giá chỉ một trăm chín mươi chín nghìn đồng'], ['giảm 199k', 'giảm một trăm chín mươi chín nghìn'],
  ['còn 1,2tr', 'còn một phẩy hai triệu'], ['giá $99', 'giá chín mươi chín đô la'],
  ['hotline 0912.345.678', 'hotline không chín một hai ba bốn năm sáu bảy tám'], ['cao 1m75', 'cao một mét bảy mươi lăm'],
  ['pin 5000mAh', 'pin năm nghìn mi li am pe giờ'], ['ngày 12/5/2025', 'ngày mười hai tháng năm năm hai nghìn không trăm hai mươi lăm'],
  ['tối 21:45', 'tối hai mươi mốt giờ bốn mươi lăm phút'], ['tháng 4 này', 'tháng tư này'], ['từ 3-5 ngày', 'từ ba đến năm ngày'],
  ['**nổi bật** 🔥', 'nổi bật'], ['cách 150 triệu km.', 'cách một trăm năm mươi triệu ki lô mét.'], ['Ở VN, sđt là', 'Ở Việt Nam, số điện thoại là'],
];
for (const [input, want] of VI_CASES) t(`normalizeVi ${input}`, () => assert.strictEqual(normalizeVi(input), want));
t('readInteger nghìn tỷ / linh / mốt / lẻ', () => {
  assert.strictEqual(readInteger('1000000000000'), 'một nghìn tỷ');
  assert.strictEqual(readInteger('1000001'), 'một triệu không trăm linh một');
  assert.strictEqual(readInteger('91'), 'chín mươi mốt');
  assert.strictEqual(normalizeVi('105', { le: 'lẻ' }), 'một trăm lẻ năm');
});
t('voice language helpers', () => {
  assert.ok(isViVoice('vi-VN-HoaiMyNeural') && !isViVoice('en-US-AriaNeural'));
  assert.ok(looksVietnamese('Xin chào các em') && !looksVietnamese('Hello world'));
});

// ───────── chunk ─────────
t('splitText keeps everything, ≤ limit, ends on sentences', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Đây là câu thứ ${i + 1} trong bài giảng về Trái Đất.`).join(' ');
  const parts = splitText(long, { maxChars: 800 });
  assert.ok(parts.length > 1);
  for (const p of parts) { assert.ok(p.length <= 800); assert.ok(p.endsWith('.')); }
  assert.strictEqual(parts.join(' '), long);
});
t('splitText: no punctuation → by words; byte limit respected', () => {
  const long = 'từ '.repeat(1200).trim();
  const parts = splitText(long, { maxChars: 1500, maxBytes: 3500, measure: (s) => Buffer.byteLength(edge.escapeXml(s)) });
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1500 && Buffer.byteLength(p) <= 3500));
  assert.strictEqual(parts.join(' ').split(' ').length, 1200);
});
t('splitText: very long sentence → commas', () => {
  const s = Array.from({ length: 200 }, (_, i) => `từ${i},`).join(' ');
  const parts = splitText(s, { maxChars: 100 });
  assert.ok(parts.every((p) => p.length <= 100));
  assert.strictEqual(parts.join(' ').split(/\s+/).length, 200);
});
t('splitSentences does not split decimals / TP.HCM', () => {
  assert.deepStrictEqual(splitSentences('Giá 3.5 triệu ở TP.HCM. Rẻ quá! Mua "ngay." Được'), ['Giá 3.5 triệu ở TP.HCM.', 'Rẻ quá!', 'Mua "ngay."', 'Được']);
});

// ───────── audio ─────────
const mp3Frame = () => { const f = Buffer.alloc(144); f[0] = 0xff; f[1] = 0xf3; f[2] = 0x64; f[3] = 0xc4; return f; }; // MPEG-2 L3 48 kbps 24 kHz = 24 ms
t('pcmToWav header + wavInfo round trip', () => {
  const wav = audio.pcmToWav(Buffer.alloc(48000), { sampleRate: 24000 }); // 1 s s16 mono
  assert.strictEqual(wav.length, 44 + 48000);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(4), 36 + 48000);
  assert.strictEqual(wav.readUInt32LE(28), 48000);
  const info = audio.wavInfo(wav);
  assert.strictEqual(info.sampleRate, 24000);
  assert.strictEqual(info.durationSec, 1);
});
t('wavInfo skips LIST chunk', () => {
  const wav = audio.pcmToWav(Buffer.alloc(4800), { sampleRate: 24000 });
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('abcde'), Buffer.from([0])]);
  assert.strictEqual(audio.wavInfo(Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)])).data.length, 4800);
});
t('concatWav inserts gaps; refuses mixed rates', () => {
  const a = audio.pcmToWav(Buffer.alloc(48000), { sampleRate: 24000 });
  const out = audio.concatWav([a, a, a], { gapsSec: [0.45, 0.12] });
  assert.ok(Math.abs(audio.wavInfo(out).durationSec - 3.57) < 1e-6);
  const b = audio.pcmToWav(Buffer.alloc(100), { sampleRate: 44100 });
  assert.throws(() => audio.concatWav([a, b]), (e) => e.code === 'AUDIO_FORMAT_MISMATCH');
});
t('mp3Duration counts frames', () => {
  const mp3 = Buffer.concat(Array(50).fill(mp3Frame()));
  assert.strictEqual(audio.mp3Duration(mp3), 1.2);
  assert.strictEqual(audio.durationOf(mp3), 1.2);
});

// ───────── multi-voice ─────────
t('inferGenderAge: number words, già ≠ giàu, đực/cái, focus on the name', () => {
  assert.deepStrictEqual(mv.inferGenderAge('Lan', 'Lan, cô gái ba mươi tuổi'), { gender: 'female', age: 30 });
  assert.deepStrictEqual(mv.inferGenderAge('Minh', 'Minh là anh trai, bốn mươi lăm tuổi'), { gender: 'male', age: 45 });
  assert.strictEqual(mv.inferGenderAge('Phú', 'Phú là người đàn ông giàu có').age, null);
  assert.strictEqual(mv.inferGenderAge('Ông Tư', 'Ông Tư là cụ ông già').age, 72);
  assert.deepStrictEqual(mv.inferGenderAge('Bắp', 'Bắp là mèo đực con'), { gender: 'male', age: 8 });
  assert.strictEqual(mv.inferGenderAge('Na', 'Na là mèo cái tam thể').gender, 'female');
  assert.strictEqual(mv.inferGenderAge('Tí', 'Phong cách tranh vẽ người phụ nữ. Tí là cậu bé tám tuổi').gender, 'male');
  assert.strictEqual(mv.inferGenderAge('Hà', 'Hà sống ở miền Nam Việt Nam').gender, null);
});
const VOICES = [
  { id: 'nu-tre', gender: 'female', desc: 'trẻ trung, tươi sáng' }, { id: 'nu-am', gender: 'female', desc: 'ấm áp, truyền cảm' },
  { id: 'nam-tre', gender: 'male', desc: 'trẻ, năng động' }, { id: 'nam-tram', gender: 'male', desc: 'trầm ấm, kể chuyện' },
  { id: 'narr', gender: 'female', desc: 'rõ ràng' },
];
t('castVoices: gender/age match, no reuse of narrator or each other, stable', () => {
  const chars = [{ name: 'Lan', description: 'Lan, cô gái hai mươi tuổi' }, { name: 'Ông Ba', description: 'Ông Ba là cụ ông' }, { name: 'Tí', description: 'Tí là cậu bé' }];
  const c1 = mv.castVoices(chars, VOICES, { narratorVoice: 'narr' });
  assert.strictEqual(c1.get('Lan'), 'nu-tre');
  assert.strictEqual(c1.get('Ông Ba'), 'nam-tram');
  assert.strictEqual(c1.get('Tí'), 'nam-tre');
  assert.deepStrictEqual([...mv.castVoices(chars, VOICES, { narratorVoice: 'narr' })], [...c1]);
});
const CHARS = [{ name: 'Trạng Quỳnh' }, { name: 'Sứ thần' }, { name: 'Lan' }, { name: 'Minh' }, { name: 'Dâu Tây' }];
const N = 'narrator';
t('splitSentence: action tag before quote → narrator reads the tag', () => {
  assert.deepStrictEqual(mv.splitSentence('Trạng Quỳnh điềm đạm cất giọng châm chọc: "Thứ dốt nát ấy làm sao biết được."', CHARS).parts,
    [{ who: N, text: 'Trạng Quỳnh điềm đạm cất giọng châm chọc: ' }, { who: 'Trạng Quỳnh', text: '"Thứ dốt nát ấy làm sao biết được."' }]);
});
t('splitSentence: tag after quote, quoted term stays narration, label without quotes', () => {
  assert.deepStrictEqual(mv.splitSentence('"Thôi, để mai tính," Minh lẩm bẩm.', CHARS).parts, [{ who: 'Minh', text: '"Thôi, để mai tính,"' }, { who: N, text: ' Minh lẩm bẩm.' }]);
  assert.deepStrictEqual(mv.splitSentence('Bà gọi đó là "tiền riêng" của mình.', CHARS).parts, [{ who: N, text: 'Bà gọi đó là "tiền riêng" của mình.' }]);
  assert.deepStrictEqual(mv.splitSentence('Lan mỉm cười: Con về rồi mẹ ơi.', CHARS).parts, [{ who: N, text: 'Lan mỉm cười: ' }, { who: 'Lan', text: 'Con về rồi mẹ ơi.' }]);
});
t('splitSentence: sentence cut inside speech (odd quotes)', () => {
  const a = mv.splitSentence('Sứ thần hoảng hốt lắp bắp hỏi: "Sao...', CHARS);
  assert.deepStrictEqual(a.parts, [{ who: N, text: 'Sứ thần hoảng hốt lắp bắp hỏi: ' }, { who: 'Sứ thần', text: '"Sao...' }]);
  assert.deepStrictEqual(mv.splitSentence('sao ngươi lại nhìn ra nhanh thế"', CHARS, a.lastSpeaker).parts, [{ who: 'Sứ thần', text: 'sao ngươi lại nhìn ra nhanh thế"' }]);
});
t('fixTaggedParts (A test cases)', () => {
  const Q = 'Trạng Quỳnh';
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: Q, text: 'Trạng Quỳnh điềm đạm cất giọng châm chọc: "Thứ dốt nát ấy"' }, { who: N, text: '.' }]),
    [{ who: N, text: 'Trạng Quỳnh điềm đạm cất giọng châm chọc: ' }, { who: Q, text: '"Thứ dốt nát ấy"' }, { who: N, text: '.' }]);
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: 'Minh', text: '"Thôi, để mai tính," Minh lẩm bẩm.' }]), [{ who: 'Minh', text: '"Thôi, để mai tính,"' }, { who: N, text: ' Minh lẩm bẩm.' }]);
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: N, text: 'Lan nói: ' }, { who: 'Lan', text: '"Con về rồi."' }]), [{ who: N, text: 'Lan nói: ' }, { who: 'Lan', text: '"Con về rồi."' }]);
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: 'Sứ thần', text: ' sao ngươi lại nhìn ra nhanh thế"' }]), [{ who: 'Sứ thần', text: ' sao ngươi lại nhìn ra nhanh thế"' }]);
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: 'Sứ thần', text: 'Sứ thần hoảng hốt lắp bắp hỏi: "Sao...' }]), [{ who: N, text: 'Sứ thần hoảng hốt lắp bắp hỏi: ' }, { who: 'Sứ thần', text: '"Sao...' }]);
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: 'Lan', text: 'Mình phải cố lên thôi.' }]), [{ who: 'Lan', text: 'Mình phải cố lên thôi.' }]);
  assert.deepStrictEqual(mv.fixTaggedParts([{ who: 'Lan', text: 'Bà gọi đó là "tiền riêng" của mình' }]), [{ who: 'Lan', text: 'Bà gọi đó là "tiền riêng" của mình' }]);
});
t('parseScript + planChunks: name label not read, voices switch, gaps', () => {
  const lines = mv.parseScript('Trời tối dần. Dâu Tây: "Mình về thôi!" Lan gật đầu: "Ừ, về." "Nhanh lên nào," Lan giục.', CHARS);
  const voice = { 'Dâu Tây': 'v-dau', Lan: 'v-lan' };
  const chunks = mv.planChunks(lines, (w) => voice[w], 'v-narr', { maxChars: 220 });
  assert.deepStrictEqual(chunks.map((c) => [c.voice, c.text]), [
    ['v-narr', 'Trời tối dần.'], ['v-dau', '"Mình về thôi!"'], ['v-narr', 'Lan gật đầu:'], ['v-lan', '"Ừ, về." "Nhanh lên nào,"'], ['v-narr', 'Lan giục.'],
  ]);
  assert.deepStrictEqual(mv.gapsAfter(chunks), [0.45, 0.45, 0.45, 0.45, 0]);
  assert.ok(!mv.planChunks(lines, (w) => voice[w], 'v-narr', { readActionTags: false }).some((c) => c.text === 'Lan gật đầu:'));
});
t('planChunks: whole "Name: line" given to the character → name cut; lone "?" merged', () => {
  assert.deepStrictEqual(mv.planChunks([[{ who: 'Dâu Tây', text: 'Dâu Tây: "Đi đâu đấy"' }, { who: N, text: '?' }]], () => 'v', 'n'),
    [{ text: '"Đi đâu đấy"?', voice: 'v', who: 'Dâu Tây' }]);
});

// ───────── subtitles ─────────
const edgeWords = (spoken) => spoken.split(' ').map((text, i) => ({ text, offsetMs: i * 500, durationMs: 400 }));
t('alignWords restores punctuation + written numbers (C cases)', () => {
  assert.deepStrictEqual(subs.alignWords(edgeWords('trái đất quay mặt trời đứng yên'), 'Trái Đất quay. Mặt Trời đứng yên!').map((w) => w.text),
    ['Trái', 'Đất', 'quay.', 'Mặt', 'Trời', 'đứng', 'yên!']);
  const b = subs.alignWords(edgeWords('cách mặt trời năm mươi triệu ki lô mét nhé'), 'Cách Mặt Trời 50 triệu km. Nhé');
  assert.deepStrictEqual(b.map((w) => w.text), ['Cách', 'Mặt', 'Trời', '50', 'triệu', 'km.', 'Nhé']);
  assert.deepStrictEqual([b[3].offsetMs, b[3].offsetMs + b[3].durationMs], [1500, 2400]);
  assert.deepStrictEqual(subs.alignWords(edgeWords('xin chào ừm các em'), 'Xin chào, các em.').map((w) => w.text), ['Xin', 'chào,', 'ừm', 'các', 'em.']);
});
t('cuesFromWords breaks at sentences; SRT/VTT format', () => {
  const text = 'Trái Đất quay quanh Mặt Trời. Một vòng mất bao lâu? Khoảng 365 ngày!';
  const cues = subs.cuesFromWords(edgeWords('trái đất quay quanh mặt trời một vòng mất bao lâu khoảng ba trăm sáu mươi lăm ngày'), { text });
  assert.deepStrictEqual(cues.map((c) => c.text), ['Trái Đất quay quanh Mặt Trời.', 'Một vòng mất bao lâu?', 'Khoảng 365 ngày!']);
  assert.strictEqual(cues[1].startMs, 3000);
  assert.strictEqual(subs.srtTime(3723046), '01:02:03,046');
  assert.ok(subs.toSrt(cues).startsWith('1\r\n00:00:00,000 --> 00:00:02,900\r\nTrái Đất quay quanh Mặt Trời.\r\n'));
  assert.ok(subs.toVtt(cues).startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.900\n'));
});
t('cue limits 12 words / 42 chars; cuesFromText by length', () => {
  const words = Array.from({ length: 30 }, (_, i) => ({ text: `từ${i}`, offsetMs: i * 300, durationMs: 250 }));
  for (const c of subs.cuesFromWords(words)) assert.ok(c.text.split(' ').length <= 12 && c.text.length <= 42);
  const c = subs.cuesFromText('Xin chào các em. Hôm nay chúng ta học về hệ Mặt Trời nhé.', 6000);
  assert.deepStrictEqual(c.map((x) => x.text), ['Xin chào các em.', 'Hôm nay chúng ta học về hệ Mặt Trời nhé.']);
  assert.strictEqual(c[c.length - 1].endMs, 6000);
});

// ───────── edge-tts (offline: fake python runner) ─────────
t('edge fmt: rate/pitch/volume strings', () => {
  assert.strictEqual(edge.fmt(-4, '%'), '-4%');
  assert.strictEqual(edge.fmt(18, 'Hz'), '+18Hz');
  assert.strictEqual(edge.fmt('10%', '%'), '+10%');
  assert.strictEqual(edge.fmt(undefined, '%'), '+0%');
});
t('edge classify stderr', () => {
  assert.strictEqual(edge.classify("ModuleNotFoundError: No module named 'edge_tts'").code, 'EDGE_NOT_INSTALLED');
  assert.strictEqual(edge.classify('aiohttp.client_exceptions.WSServerHandshakeError: 403, message=Invalid response status').code, 'EDGE_FORBIDDEN');
  assert.strictEqual(edge.classify('edge_tts.exceptions.NoAudioReceived: No audio was received').code, 'EDGE_NO_AUDIO');
});
t('edge synthesize: audio file + word offsets (100-ns → ms), NFC text', async () => {
  let seenArgs;
  const runPython = async (_script, stdin) => {
    seenArgs = JSON.parse(stdin);
    fs.writeFileSync(seenArgs.out, Buffer.concat(Array(10).fill(mp3Frame())));
    return { code: 0, stderr: '', stdout: JSON.stringify({ t: 'Xin', o: 1_000_000, d: 3_000_000 }) + '\n' };
  };
  const r = await edge.synthesize({ text: 'Xin cha\u0300o', voice: 'vi-VN-HoaiMyNeural', rate: -4, pitch: 18, runPython });
  assert.strictEqual(r.buffer.length, 1440);
  assert.deepStrictEqual(r.words, [{ text: 'Xin', offsetMs: 100, durationMs: 300 }]);
  assert.strictEqual(r.durationMs, 240);
  assert.strictEqual(seenArgs.text, 'Xin chào');
  assert.strictEqual(seenArgs.rate, '-4%');
  assert.strictEqual(seenArgs.pitch, '+18Hz');
  assert.ok(!fs.existsSync(seenArgs.out), 'temp file removed');
});
t('edge synthesize: missing package → EDGE_NOT_INSTALLED, no retry', async () => {
  let calls = 0;
  const runPython = async () => { calls++; return { code: 1, stdout: '', stderr: "No module named 'edge_tts'" }; };
  await assert.rejects(edge.synthesize({ text: 'a', voice: 'x', runPython }), (e) => e.code === 'EDGE_NOT_INSTALLED');
  assert.strictEqual(calls, 1);
});

// ───────── gemini-tts (fake fetch) ─────────
const K1 = 'AIzaSyA1111111111111111111111111111111', K2 = 'AQ.Ab8RN6Kzz-2222222222222222222222222222', K3 = 'AIzaSyC3333333333333333333333333333333';
const pcmOk = (bytes = 4800) => ({ status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(bytes, 1).toString('base64') } }] } }] } });
const quota = (day) => ({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: day ? 'Quota exceeded for metric: generate_requests_per_model_per_day' : 'Quota exceeded per minute' } } });
function fakeFetch(byKey, log = []) {
  return async (url, init) => {
    const key = init?.headers?.['x-goog-api-key'];
    log.push({ key, url: String(url), body: init?.body });
    const r = byKey[key];
    const one = Array.isArray(r) ? r.shift() : r;
    if (!one) throw new Error('fetch failed');
    return new Response(typeof one.body === 'string' ? one.body : JSON.stringify(one.body), { status: one.status });
  };
}
t('gemini: parseKeys / classify / prompt with gender lock', () => {
  assert.deepStrictEqual(gem.parseKeys([`${K1}\n${K2}, ${K1};  "${K3}"`, 'abc']), [K1, K2, K3]);
  assert.strictEqual(gem.classifyHttpError(429, JSON.stringify(quota(true).body)), 'quotaDay');
  assert.strictEqual(gem.classifyHttpError(400, 'API key not valid. API_KEY_INVALID'), 'invalid');
  assert.strictEqual(gem.classifyHttpError(400, 'bad text'), 'bad');
  const p = gem.buildPrompt('Xin chào.', { accent: 'vi-s', gender: 'male', style: 'trầm ấm:' });
  assert.ok(p.includes('miền Nam') && p.includes("male speaker (man's voice)") && p.includes('never sound female') && p.includes('trầm ấm.') && p.endsWith('\nXin chào.'));
  assert.ok(gem.buildPrompt('Hi.', { accent: 'en-gb', gender: 'female' }).includes('British'));
});
t('gemini: rotates keys, rests 429 key 65 s, WAV out, key never in URL', async () => {
  let now = 1_000_000;
  const log = [];
  const tts = gem.createGeminiTts({ keys: [K1, K2], now: () => now, fetchImpl: fakeFetch({ [K1]: [quota(), pcmOk()], [K2]: [pcmOk(), pcmOk()] }, log) });
  const r = await tts.synthesize({ text: 'Xin chào các em.', voice: 'Charon', accent: 'vi-n' });
  assert.strictEqual(r.buffer.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(r.durationMs, 100);
  assert.deepStrictEqual(log.map((l) => l.key), [K1, K2]);
  assert.ok(log.every((l) => !l.url.includes('key=')));
  assert.ok(JSON.parse(log[0].body).contents[0].parts[0].text.includes('giọng nam'), 'Charon is male → locked male');
  assert.strictEqual(tts.keys()[0].cooldownUntil, now + 65_000);
  assert.ok(!JSON.stringify(tts.keys()).includes(K1), 'state never exposes keys');
  await tts.synthesize({ text: 'Câu hai.', voice: 'Kore' }); // K1 resting → K2
  assert.strictEqual(log[2].key, K2);
  now += 66_000;
  await tts.synthesize({ text: 'Câu ba.', voice: 'Kore' }); // cursor after K2 → K1 is back
  assert.strictEqual(log[3].key, K1);
});
t('gemini: all keys resting → QUOTA; daily quota rests 1 h; no key → NO_KEY', async () => {
  const now = 5_000;
  const tts = gem.createGeminiTts({ keys: [K1], now: () => now, fetchImpl: fakeFetch({ [K1]: [quota(true)] }) });
  await assert.rejects(tts.synthesize({ text: 'a' }), (e) => e.code === 'GEMINI_TTS_QUOTA');
  assert.strictEqual(tts.keys()[0].cooldownUntil, now + 3_600_000);
  await assert.rejects(gem.createGeminiTts({ keys: [] }).synthesize({ text: 'a' }), (e) => e.code === 'GEMINI_TTS_NO_KEY');
});

// ───────── ai33 (fake fetch) ─────────
t('ai33: errors, language codes, voice mapping, transcript shapes', () => {
  assert.strictEqual(ai33.httpError(400, '{"message":"Insufficient credits"}').code, 'AI33_NO_CREDIT');
  assert.strictEqual(ai33.httpError(401, '').code, 'AI33_AUTH');
  assert.strictEqual(ai33.httpError(400, '{"detail":"voice_id does not exist"}').code, 'AI33_VOICE_NOT_FOUND');
  assert.strictEqual(ai33.httpError(429, '', 7).retryAfterMs, 7000);
  assert.strictEqual(ai33.langCode('en', 'british'), 'en-GB');
  assert.strictEqual(ai33.langCode('Vietnamese'), 'vi-VN');
  const v = ai33.mapVoice({ voice_id: 'hn_female_ngochuyen', name: 'Ngọc Huyền', language: 'vi', gender: 'female', preview_url: 'http://x/a.mp3' }, 'vbee');
  assert.deepStrictEqual([v.voiceId, v.lang, v.region, v.gender, v.previewUrl], ['vbee_hn_female_ngochuyen', 'vi-VN', 'vi-n', 'female', undefined]);
  assert.deepStrictEqual(ai33.parseTranscript({ characters: [...'Hi bé'], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5] }),
    [{ text: 'Hi', offsetMs: 0, durationMs: 200 }, { text: 'bé', offsetMs: 300, durationMs: 200 }]);
  assert.deepStrictEqual(ai33.parseTranscript([{ text: 'Xin', start_ms: 0, end_ms: 300 }]), [{ text: 'Xin', offsetMs: 0, durationMs: 300 }]);
  assert.strictEqual(ai33.parseTranscript('1\n00:00:00,000 --> 00:00:01,000\nXin chào\n').length, 2);
  assert.strictEqual(ai33.cleanKey('xi-api-key: "abc123"'), 'abc123');
});
t('ai33: create task → poll → download, header auth, credits', async () => {
  const calls = [];
  let polls = 0;
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, key: init.headers?.['xi-api-key'], method: init.method || 'GET', form: init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : null });
    const json = (s, b) => new Response(JSON.stringify(b), { status: s });
    if (u.hostname === 'cdn.example') return new Response(Buffer.concat(Array(10).fill(mp3Frame())), { status: 200 });
    if (u.pathname === '/v1/credits') return json(200, { credits: 12345 });
    if (u.pathname === '/v3/text-to-speech') return json(200, { success: true, task_id: 't1' });
    if (u.pathname === '/v1/task/t1') {
      return ++polls < 2 ? json(200, { status: 'doing', progress: 40 })
        : json(200, { status: 'done', credit_cost: 9, metadata: { audio_url: 'https://cdn.example/t1.mp3', transcript: [{ text: 'Xin', start: 0, end: 0.3 }] } });
    }
    return json(404, {});
  };
  const ai = ai33.createAi33({ apiKey: 'sk-test-123', fetchImpl: f, pollMs: 1 });
  assert.strictEqual(await ai.credits(), 12345);
  const r = await ai.synthesize({ voiceId: 'vbee_hn_female_x', text: 'Xin chào.', speed: 1.2 });
  assert.strictEqual(r.durationMs, 240);
  assert.deepStrictEqual(r.words, [{ text: 'Xin', offsetMs: 0, durationMs: 300 }]);
  assert.strictEqual(r.creditCost, 9);
  assert.deepStrictEqual(calls.find((c) => c.method === 'POST').form, { voice_id: 'vbee_hn_female_x', text: 'Xin chào.', speed: '1.2', with_transcript: 'true' });
  assert.ok(calls.filter((c) => c.path !== '/t1.mp3').every((c) => c.key === 'sk-test-123'));
  await assert.rejects(ai.synthesize({ voiceId: 'nope', text: 'x' }), (e) => e.code === 'AI33_VOICE_NOT_FOUND');
  await assert.rejects(ai33.createAi33({ apiKey: '' }).credits(), (e) => e.code === 'AI33_NO_KEY');
});
t('ai33: listVoices paginates by total and caches', async () => {
  let gets = 0;
  const all = Array.from({ length: 250 }, (_, i) => ({ voice_id: `hn_female_v${i}`, name: `V${i}`, language: 'vi', gender: 'female' }));
  const f = async (url) => {
    gets++;
    const u = new URL(String(url));
    const page = Number(u.searchParams.get('page')), size = Number(u.searchParams.get('page_size'));
    return new Response(JSON.stringify({ data: all.slice((page - 1) * size, page * size), pagination: { total: all.length, page_size: size } }), { status: 200 });
  };
  const ai = ai33.createAi33({ apiKey: 'k', fetchImpl: f });
  assert.strictEqual((await ai.listVoices({ provider: 'vbee' })).length, 250);
  assert.strictEqual(gets, 3);
  await ai.listVoices({ provider: 'vbee' });
  assert.strictEqual(gets, 3, 'second call served from cache');
});

(async () => {
  for (const run of pending) await run();
  console.log(fails ? `voice.test: ${fails} FAILED, ${passed} passed` : `voice.test OK (${passed} tests)`);
  process.exit(fails ? 1 : 0);
})();
