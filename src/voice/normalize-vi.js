'use strict';
/**
 * Vietnamese text normalizer for TTS: numbers, dates, times, money, %, units, abbreviations, phone numbers,
 * simple math. Pure function, no deps. Merged from two production apps:
 *   (C) a lesson-video app (vitest-covered: math, dates, units, ordinals)
 *   (A) a video app's voice-clone path (money "199k/1,2tr/$99", phones, 1m75, GB/mAh, markdown/emoji cleanup)
 *
 * Why: TTS engines read "199.000đ", "12/5/2025", "9h30", "x^2" wrongly or skip them; some (OmniVoice, Kokoro)
 * have no Vietnamese normalizer at all. Run this ONLY for Vietnamese voices/text (see isViVoice / looksVietnamese).
 *
 *   const { normalizeVi } = require('./normalize-vi');
 *   normalizeVi('Giá 199.000đ, giảm 50% đến 12/5/2025 lúc 9h30.')
 *   // → 'Giá một trăm chín mươi chín nghìn đồng, giảm năm mươi phần trăm đến ngày mười hai tháng năm năm …'
 *
 * CLI (used by python/local_tts to avoid a second implementation):  echo "3,5 km" | node src/voice/normalize-vi.js
 */

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const GROUPS = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ', 'tỷ tỷ'];

const isViVoice = (voice) => /^vi[-_]/i.test(String(voice || ''));
const VI_ONLY = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹĩũ]/i;
const VI_WORD = /(^|[\s,.!?])(các|của|và|là|có|cho|này|được|chào|những|không|với|một)(?=$|[\s,.!?])/i;
/** Multilingual voices (ElevenLabs, Gemini) decide by the text itself, so detect Vietnamese from letters. */
const looksVietnamese = (text) => VI_ONLY.test(String(text || '')) || VI_WORD.test(String(text || ''));

/** 3 digits; full = always read hundreds ("không trăm") and the "linh/lẻ" filler (non-leading group). */
function readTriple(n, full, le) {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
  const out = [];
  if (full || h > 0) out.push(DIGITS[h], 'trăm');
  if (t === 0) { if (u > 0 && (full || h > 0)) out.push(le); }
  else if (t === 1) out.push('mười');
  else out.push(DIGITS[t], 'mươi');
  if (u > 0) {
    if (u === 1 && t >= 2) out.push('mốt');
    else if (u === 4 && t >= 2) out.push('tư');
    else if (u === 5 && t >= 1) out.push('lăm');
    else out.push(DIGITS[u]);
  }
  return out.join(' ');
}

const readDigits = (s) => [...String(s)].filter((d) => /\d/.test(d)).map((d) => DIGITS[Number(d)]).join(' ');

/** Non-negative integer given as a digit string. le = 'linh' (North, default) | 'lẻ' (South). */
function readInteger(digits, le = 'linh') {
  const s = String(digits).replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(s)) return 'không';
  if (s.length > 21) return readDigits(s);
  const triples = [];
  for (let i = s.length; i > 0; i -= 3) triples.unshift(Number(s.slice(Math.max(0, i - 3), i)));
  const out = [];
  triples.forEach((v, i) => {
    const g = triples.length - 1 - i;
    if (v === 0) return;
    out.push(readTriple(v, i > 0, le));
    if (GROUPS[g]) out.push(GROUPS[g]);
  });
  return out.join(' ');
}

/** Integer part + decimal part (after "phẩy"); a leading-zero integer like "0912" is read digit by digit. */
function readNumber(intPart, frac, negative = false, le = 'linh') {
  let r = /^0\d+$/.test(intPart) && !frac ? readDigits(intPart) : readInteger(intPart, le);
  if (frac) r += ' phẩy ' + (frac.startsWith('0') || frac.length > 3 ? readDigits(frac) : readInteger(frac, le));
  return (negative ? 'âm ' : '') + r;
}

/** "1.000.000" | "3,5" | "3.14" | "1,000,000" → words (VN uses "." for thousands, "," for decimals). */
function readNumToken(tok, negative = false, le = 'linh') {
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(tok)) { const [i, f] = tok.split(','); return readNumber(i.replace(/\./g, ''), f, negative, le); }
  if (/^\d{1,3}(,\d{3}){2,}(\.\d+)?$/.test(tok)) { const [i, f] = tok.split('.'); return readNumber(i.replace(/,/g, ''), f, negative, le); }
  const m = tok.match(/^(\d+)(?:[.,](\d+))?$/);
  return m ? readNumber(m[1], m[2], negative, le) : tok;
}

const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?|\d+(?:[.,]\d+)?`;
const NOT_BEFORE = String.raw`(?<![\p{L}\d])`;

// Longest first is not required (regex alternation is built sorted by length below).
const UNITS = [
  ['km/h', 'ki lô mét trên giờ'], ['km/giờ', 'ki lô mét trên giờ'], ['kmh', 'ki lô mét trên giờ'],
  ['m/s²', 'mét trên giây bình phương'], ['m/s', 'mét trên giây'],
  ['km²', 'ki lô mét vuông'], ['cm²', 'xen ti mét vuông'], ['cm³', 'xen ti mét khối'], ['dm²', 'đề xi mét vuông'],
  ['dm³', 'đề xi mét khối'], ['m²', 'mét vuông'], ['m³', 'mét khối'], ['m2', 'mét vuông'], ['m3', 'mét khối'],
  ['°C', 'độ xê'], ['ºC', 'độ xê'], ['°F', 'độ ép'], ['°', 'độ'],
  ['km', 'ki lô mét'], ['dm', 'đề xi mét'], ['cm', 'xen ti mét'], ['mm', 'mi li mét'],
  ['kg', 'ki lô gam'], ['mg', 'mi li gam'], ['ml', 'mi li lít'],
  ['kWh', 'ki lô oát giờ'], ['kW', 'ki lô oát'], ['mAh', 'mi li am pe giờ'], ['GHz', 'gi ga héc'], ['MHz', 'mê ga héc'],
  ['GB', 'gi ga bai'], ['MB', 'mê ga bai'], ['TB', 'tê ra bai'], ['KB', 'ki lô bai'],
  ['W', 'oát'], ['V', 'vôn'], ['Hz', 'héc'], ['ha', 'héc ta'], ['%', 'phần trăm'],
  ['m', 'mét'], ['g', 'gam'], ['l', 'lít'], ['h', 'giờ'], ['s', 'giây'],
  ['đ', 'đồng'], ['₫', 'đồng'], ['VNĐ', 'đồng'], ['VND', 'đồng'], ['vnđ', 'đồng'], ['đồng', 'đồng'],
  ['USD', 'đô la'], ['usd', 'đô la'], ['EUR', 'ơ rô'], ['€', 'ơ rô'],
];
// Money shorthand only when glued to the number ("199k", "1,2tr") — "5 k" is too ambiguous.
const GLUED_UNITS = [['k', 'nghìn'], ['K', 'nghìn'], ['tr', 'triệu'], ['ty', 'tỷ']];
const PREFIX_CURRENCY = { $: 'đô la', '€': 'ơ rô', '¥': 'yên', '£': 'bảng Anh' };

const B = String.raw`(?<![\p{L}])`; // left word boundary that understands Vietnamese letters
const E = String.raw`(?![\p{L}])`;
const ABBR = [
  [/\bv\.v\.?/g, 'vân vân'],
  [new RegExp(`${B}TP\\.?\\s*HCM${E}`, 'gu'), 'thành phố Hồ Chí Minh'],
  [new RegExp(`${B}TP\\.?\\s*Hồ Chí Minh`, 'gu'), 'thành phố Hồ Chí Minh'],
  [new RegExp(`${B}(TP|Tp)\\.\\s*`, 'gu'), 'thành phố '],
  [new RegExp(`${B}TP${E}`, 'gu'), 'thành phố'],
  [new RegExp(`${B}HCM${E}`, 'gu'), 'Hồ Chí Minh'],
  [new RegExp(`${B}(VD|Vd|vd)${E}\\.?`, 'gu'), 'ví dụ'],
  [new RegExp(`${B}GS\\.\\s*TS\\.\\s*`, 'gu'), 'giáo sư tiến sĩ '],
  [new RegExp(`${B}PGS\\.\\s*`, 'gu'), 'phó giáo sư '],
  [new RegExp(`${B}GS\\.\\s*`, 'gu'), 'giáo sư '],
  [new RegExp(`${B}TS\\.\\s*`, 'gu'), 'tiến sĩ '],
  [new RegExp(`${B}ThS\\.\\s*`, 'gu'), 'thạc sĩ '],
  [new RegExp(`${B}THCS${E}`, 'gu'), 'trung học cơ sở'],
  [new RegExp(`${B}THPT${E}`, 'gu'), 'trung học phổ thông'],
  [new RegExp(`${B}SGK${E}`, 'gu'), 'sách giáo khoa'],
  [new RegExp(`${B}GV${E}`, 'gu'), 'giáo viên'],
  [new RegExp(`${B}HS${E}`, 'gu'), 'học sinh'],
  [new RegExp(`${B}ĐH${E}`, 'gu'), 'đại học'],
  [new RegExp(`${B}UBND${E}`, 'gu'), 'ủy ban nhân dân'],
  [new RegExp(`${B}KCN${E}`, 'gu'), 'khu công nghiệp'],
  [new RegExp(`${B}TW${E}`, 'gu'), 'trung ương'],
  [new RegExp(`${B}VN${E}`, 'gu'), 'Việt Nam'],
  [new RegExp(`${B}(SĐT|sđt|Sđt)${E}`, 'gu'), 'số điện thoại'],
  [new RegExp(`${B}đ/c${E}`, 'gu'), 'địa chỉ'],
  [new RegExp(`${B}(ko|k0)${E}`, 'gu'), 'không'],
  [new RegExp(`${B}(đc|dc)${E}`, 'gu'), 'được'],
  [new RegExp(`${B}TCN${E}`, 'gu'), 'trước Công nguyên'],
  [new RegExp(`${B}SCN${E}`, 'gu'), 'sau Công nguyên'],
  [new RegExp(`${B}Q\\.\\s*(?=\\d)`, 'gu'), 'quận '],
  [new RegExp(`${B}P\\.\\s*(?=\\d)`, 'gu'), 'phường '],
  [new RegExp(`${B}(tr|Tr)\\.\\s*(?=\\d)`, 'gu'), 'trang '],
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ORD = { 1: 'nhất', 2: 'hai', 4: 'tư' };
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
const power = (e) => (e === '2' ? ' bình phương' : e === '3' ? ' lập phương' : ` mũ ${e}`);

function normalizeMath(s) {
  // Parentheses holding an expression are read ("mở ngoặc … đóng ngoặc"); plain asides stay as they are.
  s = s.replace(/\(([^()]*)\)/g, (m, inner) =>
    /[+\-−×÷*/^=]|bình phương|lập phương/.test(inner) && /^[\p{L}\d\s+\-−×÷*/^.,²³]+$/u.test(inner) && inner.length <= 40 ? `\u0001${inner}\u0002` : m);
  // Minus between operands BEFORE "=" becomes a word (else "bằng -5" → "bằng trừ 5").
  s = s.replace(/(?<=[\p{L}\d)\u0002²³])\s*[-−]\s*(?=[\p{L}\d(\u0001√])/gu, ' trừ ');
  s = s.replace(/\u0001/g, ' mở ngoặc ').replace(/\u0002/g, ' đóng ngoặc ');
  s = s.replace(/\s*≤\s*|\s*<=\s*/g, ' nhỏ hơn hoặc bằng ').replace(/\s*≥\s*|\s*>=\s*/g, ' lớn hơn hoặc bằng ');
  s = s.replace(/\s*≠\s*|\s*!=\s*/g, ' khác ').replace(/\s*≈\s*/g, ' xấp xỉ ');
  s = s.replace(/(?<=[\p{L}\d)])\s*<\s*(?=[\p{L}\d(-])/gu, ' nhỏ hơn ').replace(/(?<=[\p{L}\d)])\s*>\s*(?=[\p{L}\d(-])/gu, ' lớn hơn ');
  s = s.replace(/\s*=\s*/g, ' bằng ').replace(/\s*\+\s*/g, ' cộng ');
  s = s.replace(/\s*[×✕]\s*/g, ' nhân ').replace(/(?<=[\p{L}\d)])\s*\*\s*(?=[\p{L}\d(])/gu, ' nhân ');
  s = s.replace(/\s*÷\s*/g, ' chia ').replace(/(?<=\d)\s*:\s*(?=\d)/g, ' chia ');
  s = s.replace(/√\s*(\d+|\p{L})/gu, 'căn bậc hai của $1');
  s = s.replace(/(?<![\p{L}\d])-(?=\d)/gu, '−');
  return s;
}

const readMonth = (mo, le) => (Number(mo) === 4 ? 'tư' : readInteger(String(Number(mo)), le));
const validDay = (d, mo) => Number(d) >= 1 && Number(d) <= 31 && Number(mo) >= 1 && Number(mo) <= 12;

/**
 * @param {string} input
 * @param {{le?:'linh'|'lẻ', clean?:boolean}} [opts]  le: filler word for 105 ("một trăm linh năm" | "lẻ năm");
 *        clean (default true): drop markdown emphasis, emoji and zero-width chars that some engines read aloud.
 */
function normalizeVi(input, opts = {}) {
  const le = opts.le === 'lẻ' ? 'lẻ' : 'linh';
  const R = (n) => readInteger(n, le);
  const RT = (t, neg) => readNumToken(t, neg, le);
  // NFD-composed tone marks make some models misread; NFC first.
  let s = String(input ?? '').normalize('NFC').replace(/[​‌‍﻿]/g, '');
  if (opts.clean !== false) {
    s = s.replace(/\*\*|__|`+/g, ' ').replace(/^\s*#{1,6}\s+/gm, '');
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, ' ');
    s = s.replace(/\s+—\s*|\s*—\s+|(?<=\p{L})—(?=\p{L})|\s+–\s+(?=\p{L})/gu, ', '); // dash used as a pause
  }

  // 1. abbreviations
  for (const [re, rep] of ABBR) s = s.replace(re, rep);

  // 2. phone numbers before anything reads them as thousands ("0912.345.678")
  s = s.replace(/(?<![\d.,])(?:\+84\s?|0)\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}(?![\d]|[.,]\d)/g, (m) => readDigits(m.replace('+84', '0')));

  // 3. dates: 2/9/1945, 12-05-2025, 12.05.2025, "ngày 30/4", "tháng 4/2024"
  s = s.replace(/(?:(ngày|Ngày)\s+)?(?<!\d)(\d{1,2})([/.-])(\d{1,2})\3(\d{4})(?!\d)/g, (m, w, d, _sep, mo, y) =>
    validDay(d, mo) ? `${w || 'ngày'} ${R(d)} tháng ${readMonth(mo, le)} năm ${R(y)}` : m);
  s = s.replace(/(ngày|Ngày)\s+(\d{1,2})\/(\d{1,2})(?![\d/])/g, (m, w, d, mo) => (validDay(d, mo) ? `${w} ${R(d)} tháng ${readMonth(mo, le)}` : m));
  s = s.replace(/(tháng|Tháng)\s+(\d{1,2})\/(\d{4})(?!\d)/g, (_m, w, mo, y) => `${w} ${readMonth(mo, le)} năm ${R(y)}`);
  s = s.replace(/(tháng|Tháng)\s+0?4(?![\d/.,])/g, '$1 tư');

  // 4. times: 7h30, 21h15p, "lúc 7:30", 21:45
  s = s.replace(/(?<![\p{L}\d])(\d{1,2})h(\d{2})(?:p|ph)?(?![\p{L}\d])/gu, (_m, h, mi) => `${R(h)} giờ ${R(mi)}${mi === '00' ? '' : ' phút'}`.replace(/ giờ không$/, ' giờ'));
  s = s.replace(/(lúc|Lúc)\s+(\d{1,2}):(\d{2})(?!\d)/g, (_m, w, h, mi) => `${w} ${R(h)} giờ${mi === '00' ? '' : ` ${R(mi)} phút`}`);
  s = s.replace(/(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g, (_m, h, mi) => `${R(h)} giờ${mi === '00' ? '' : ` ${R(mi)} phút`}`);

  // 5. height "1m75"
  s = s.replace(/(?<![\p{L}\d])(\d)m(\d{2})(?![\p{L}\d])/gu, (_m, a, b) => `${R(a)} mét ${R(b)}`);

  // 6. superscripts → ^n, but keep m²/cm³ for the unit step
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => '^' + [...m].map((c) => SUP[c]).join(''));
  s = s.replace(/(?<=\d\s?)(km|cm|dm|mm|m)\^([23])(?!\d)/g, (_m, u, e) => `${u}${e === '2' ? '²' : '³'}`);
  s = s.replace(/(?<=\d\s?m\/s)\^2/g, '²');

  // 7. money with a leading symbol: $99, €5 → "99 đô la" (read in step 8/12)
  s = s.replace(new RegExp(`([$€¥£])\\s?(${NUM})(\\s?(?:k|tr|triệu|nghìn|ngàn|tỷ)(?![\\p{L}]))?`, 'gu'),
    (_m, cur, n, mult) => `${n}${mult || ''} ${PREFIX_CURRENCY[cur]}`);

  // 8. number + unit ("3,5 km", "199.000đ", "50%") and glued money shorthand ("199k", "1,2tr")
  const unitMap = new Map(UNITS);
  const unitAlt = [...unitMap.keys()].sort((a, b) => b.length - a.length).map(escRe).join('|');
  // "150 triệu km", "2 nghìn tỷ đồng": a scale word between the number and the unit
  s = s.replace(new RegExp(`${NOT_BEFORE}(${NUM})\\s?((?:nghìn|ngàn|triệu|tỷ)(?:\\s(?:nghìn|triệu|tỷ))?)\\s?(${unitAlt})(?![\\p{L}\\d])`, 'gu'),
    (_m, n, scale, u) => `${RT(n)} ${scale} ${unitMap.get(u)}`);
  s = s.replace(new RegExp(`${NOT_BEFORE}(-?)(${NUM})\\s?(${unitAlt})(?![\\p{L}\\d])`, 'gu'), (_m, neg, n, u) => `${RT(n, neg === '-')} ${unitMap.get(u)}`);
  const glued = new Map(GLUED_UNITS);
  s = s.replace(new RegExp(`${NOT_BEFORE}(${NUM})(k|K|tr|ty)(?![\\p{L}\\d])`, 'gu'), (_m, n, u) => `${RT(n)} ${glued.get(u)}`);
  s = s.replace(/%/g, ' phần trăm');

  // 9. powers: x^2, (a+b)^2, 2^10
  s = s.replace(/\^\s*\{?\s*(-?\d+|\p{L})\s*\}?/gu, (_m, e) => power(e));

  // 10. fractions a/b (dates and units are already gone)
  s = s.replace(new RegExp(`${NOT_BEFORE}(\\d+)\\s?\\/\\s?(\\d+)(?![\\d/])`, 'gu'), (_m, a, b) => `${R(a)} phần ${R(b)}`);
  s = s.replace(/(?<![\p{L}\d/])(\p{L})\s?\/\s?(\p{L}|\d+)(?![\p{L}\d/])/gu, '$1 phần $2');

  // 11. ordinals: "thứ 4" → "thứ tư", "lần thứ 1" → "nhất"; centuries
  s = s.replace(/(thứ|Thứ)\s+(\d+)(?![\d.,])/g, (_m, w, n) => `${w} ${ORD[n] ?? R(n)}`);
  s = s.replace(/(thế kỷ|Thế kỷ|thế kỉ|Thế kỉ)\s+(\d+)/g, (_m, w, n) => `${w} ${R(n)}`);

  // 12. math only in sentences that look like math (so "bài học - phần mở đầu" keeps its dash)
  s = s.split(/(?<=[.!?…\n])\s+/)
    .map((sent) => (/[=<>≤≥≠≈+×÷−√*]|\b\p{L}\s*-\s*\d|\d\s*-\s*\p{L}\b|bình phương|lập phương|\smũ\s/u.test(sent) ? normalizeMath(sent) : sent))
    .join(' ');
  // ranges: 2020-2021, 3-5 ngày → "đến"
  s = s.replace(new RegExp(`${NOT_BEFORE}(${NUM})\\s?[-–~]\\s?(${NUM})(?!\\d)`, 'gu'), (_m, a, b) => `${RT(a)} đến ${RT(b)}`);

  // 13. negative numbers, then every remaining number
  s = s.replace(new RegExp(`(^|[\\s(\\[{"'“])[-−](${NUM})(?!\\d)`, 'gu'), (_m, pre, n) => `${pre}${RT(n, true)}`);
  s = s.replace(new RegExp(`${NOT_BEFORE}(${NUM})`, 'gu'), (_m, n) => ' ' + RT(n) + ' ');

  // 14. leftover symbols
  s = s.replace(/&/g, ' và ').replace(/\s*@\s*/g, ' a còng ').replace(/#(?=\d|\s)/g, ' số ').replace(/\s*~\s*/g, ' khoảng ');

  // 15. whitespace / punctuation spacing
  return s.replace(/[ \t]+/g, ' ').replace(/ +([,.!?;:…])/g, '$1').replace(/,(\s*,)+/g, ',')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

module.exports = { normalizeVi, readInteger, readNumber, readDigits, isViVoice, looksVietnamese };

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => process.stdout.write(normalizeVi(buf, { le: process.argv.includes('--le') ? 'lẻ' : 'linh' })));
}
