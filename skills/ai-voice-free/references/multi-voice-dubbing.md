# Lồng tiếng nhiều giọng (người kể + từng nhân vật)

> Mã: `src/voice/multi-voice.js` (hàm thuần, test trong `test/voice.test.js`). Nguồn: (A) lồng tiếng phim ngắn/drama theo nhân vật, sửa qua nhiều vòng trên video thật 10/2026.

## Luồng

```js
const mv = require('./src/voice/multi-voice');
const chars = [{ name: 'Lan', description: 'Lan, cô gái ba mươi tuổi' }, { name: 'Bắp', description: 'Bắp là mèo đực con' }];
const voices = [{ id: 'vi-VN-HoaiMyNeural', gender: 'female', desc: 'trẻ, tươi sáng' }, /* … */];
const cast = mv.castVoices(chars, voices, { narratorVoice: 'narrator-voice-id' });     // Map tên → giọng
const lines = mv.parseScript(script, chars);                                             // mỗi câu → [{who, text}]
const chunks = mv.planChunks(lines, (who) => cast.get(who), 'narrator-voice-id', { maxChars: 220, transform: normalizeVi });
const gaps = mv.gapsAfter(chunks);                                                       // giây im lặng sau mỗi mảnh
// TTS từng chunk bằng chunk.voice → audio.concatWav(buffers, { gapsSec: gaps }) hoặc audio.concatFiles(files, out, { gapsSec: gaps })
```

Kịch bản hiểu được: `Tên hành động: "thoại"` (người kể đọc phần hành động, nhân vật đọc trong ngoặc), `"thoại," Tên nói.`, câu chỉ có ngoặc (= người vừa nói), `Tên: thoại` không ngoặc.
Nếu dùng LLM để phân vai, chạy `fixTaggedParts` trên kết quả của nó.

## Bẫy

1. **Giọng nhân vật đọc luôn tên mình ("Dâu Tây: …").**
   - Nguyên nhân: kịch bản có nhãn `Dâu Tây: "…"`; bộ phân vai giao cả câu (kể cả nhãn) cho nhân vật (A).
   - Cách tránh: nhãn chỉ có tên đứng sát lời thoại của chính người đó thì **bỏ, không đọc**; phần của nhân vật bắt đầu bằng "Tên:" thì cắt tiền tố. Khi viết kịch bản bằng LLM: yêu cầu nhãn có **hành động** ("Dâu Tây ôm hộp nhẫn:"), không dùng tên trơn (A).
2. **Lời dẫn đọc bằng giọng nhân vật.**
   - Triệu chứng: «Trạng Quỳnh điềm đạm cất giọng châm chọc: "…"» đọc cả câu bằng giọng Trạng Quỳnh (A: 15/15 câu thoại trong một video).
   - Nguyên nhân: LLM phân vai gán cả lời dẫn + lời thoại cho nhân vật; kiểm tra "chữ nối lại khớp câu" vẫn qua.
   - Cách tránh: phần lời dẫn trước ngoặc mở / sau ngoặc đóng trả về người kể (`fixTaggedParts`). Giữ nguyên trích từ ngữ ("tiền riêng") và mảnh đóng ngoặc bị cắt giữa câu.
3. **Bộ tách câu cắt giữa lời thoại ở dấu "?"/"!".**
   - Triệu chứng: `Hạnh: "Cháo à?` | `Sao mẹ… gì"` → mảnh sau thành người kể (A).
   - Cách tránh: `parseScript` nối lại câu khi ngoặc chưa đóng. Với ngoặc lẻ: mảnh mở (`Tên: "…`) là của Tên, mảnh đóng (`…"`) là tiếp lời người vừa nói. Mảnh chỉ có dấu câu ("?") gộp vào mảnh trước, không đọc riêng.
4. **Thoại nghe như một người đọc liền.**
   - Nguyên nhân: nối các mảnh bằng crossfade, không có nhịp đổi lượt (A).
   - Cách tránh: đệm im lặng **0,45 s** khi đổi giọng, **0,12 s** giữa hai mảnh cùng giọng (`gapsAfter`). Một video thử: 75,7 s → 92,2 s, nghe như phim (A, đã đo).
5. **Đoán sai tuổi/giới tính → mọi con mèo là "Nữ · 72 tuổi".**
   - Nguyên nhân (A): (a) mô tả nhân vật mở đầu bằng câu phong cách ảnh của kênh ("…người phụ nữ…"), (b) tuổi viết bằng chữ ("ba mươi tuổi") không đọc được, (c) "già" khớp trong "giàu", (d) "nam" trong "Việt Nam" bị tính là nam giới.
   - Cách tránh: chỉ xét đoạn từ **tên nhân vật** trở đi (≤ 320 ký tự); đọc số bằng chữ tiếng Việt; so khớp theo ranh giới từ có dấu; bỏ "Việt Nam / miền Nam / Nam Bộ…" trước khi đếm; dấu hiệu rõ thắng dấu hiệu yếu: "đực", "(mèo…) cái", "là mèo mẹ", "là cậu bé". Kết quả sau sửa: Mây nữ 30, Bắp đực 6 tuổi, Na cái 5 tuổi (A).
6. **Chọn giọng.** Điểm: đúng giới tính +10, sai −12; từ khoá tuổi trong mô tả giọng (+2 mỗi từ: "trẻ/tươi/sáng" cho trẻ, "trầm/ấm/chậm" cho người già); phạt giọng đã dùng (người kể, nhân vật khác) −9; hoà điểm bằng hash (seed + id) để lần sau vẫn ra cùng giọng (A).
7. **Kịch bản "phim" nhưng gần như không có thoại.** Mô hình viết kịch bản hay ra văn kể (1/35 câu có thoại trong một video). (A) phải ép trong prompt: 45–65 % câu là thoại dạng `Tag: "lời"`, và nếu < 25 % thì yêu cầu viết lại. Đo tỷ lệ thoại trước khi lồng tiếng.
8. **Phim nhân vật tự nói trên hình** (clip video có tiếng thoại): bỏ phần lời dẫn kết thúc bằng ":" ngay trước thoại → `planChunks(…, { readActionTags: false })`.

## Chưa kiểm chứng

- Tách bằng heuristic (ngoặc kép + tên được nhắc) không thay được LLM phân vai khi kịch bản không có ngoặc và không có nhãn. (A) dùng LLM theo lô 80 câu, kiểm chữ nối lại == câu gốc, sửa trường hợp gán ngược; mã LLM không đưa vào repo.
- Ngưỡng 0,45 s / 0,12 s đo với tiếng Việt, tốc độ đọc bình thường; tiếng khác chưa thử.
- Từ khoá tuổi trong mô tả giọng phụ thuộc cách nhà cung cấp mô tả giọng; Edge chỉ có giới tính.
