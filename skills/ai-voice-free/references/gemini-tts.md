# Gemini TTS — API chính thức, key của người dùng

> Mã: `src/voice/gemini-tts.js`. Nguồn: (A) Gemini TTS nhiều key + 30 giọng × giọng vùng, có đo cao độ F0; (C) Gemini TTS nhiều key, có unit test.
> **Tôn trọng hạn mức & điều khoản Google.** Tầng free của key Google AI Studio có hạn mức theo phút và theo ngày (thấp, thay đổi theo thời gian, xem trang "Rate limits" của Gemini API).
> Xoay vòng nhiều key chỉ dành cho các key bạn **sở hữu hợp lệ** (vd mỗi thành viên nhóm một key, nhiều project trả phí). Tạo hàng loạt tài khoản/key để lách hạn mức free có thể vi phạm điều khoản và bị khoá.

## Dùng nhanh

```js
const { createGeminiTts, VOICES } = require('./src/voice/gemini-tts');
const tts = createGeminiTts({ keys: [process.env.GEMINI_API_KEY] }); // hoặc chuỗi nhiều key cách nhau bởi xuống dòng/dấu phẩy
const r = await tts.synthesize({ text: normalizeVi(text), voice: 'Charon', accent: 'vi-s', style: 'điềm đạm, rõ ràng' });
fs.writeFileSync('a.wav', r.buffer);   // WAV 24 kHz mono 16-bit, r.durationMs; KHÔNG có mốc từ
await tts.checkKeys();                 // GET /models: kiểm key không tốn lượt TTS
tts.keys();                            // trạng thái từng key (id, masked, cooldownUntil, lastError) — không lộ key
```

- `POST /v1beta/models/{model}:generateContent`, `generationConfig.responseModalities=['AUDIO']`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
  Kết quả: PCM s16le base64 (`audio/L16;codec=pcm;rate=24000`) → bọc header WAV bằng JS, không cần ffmpeg. Muốn mp3: `audio.encodeMp3`.
- Model mặc định `gemini-2.5-flash-preview-tts` (có `…-pro-preview-tts`). Tên model preview có thể đổi: truyền `model`.
- 30 giọng gốc kèm giới tính trong `VOICES` (Kore nữ, Charon nam, Sulafat nữ, Achird nam, Aoede nữ…). Giọng vùng: `vi-n`, `vi-s`, `en-us`, `en-gb`, `zh-cn`, `ja-jp`, `ko-kr`, `th-th`, `fr-fr`, `de-de`, `es-es`.
  UI có thể nhân 30 giọng × vùng thành 120+ lựa chọn (A làm vậy vì người dùng chê "ít giọng").
- Không có mốc từ → phụ đề dùng `subtitles.cuesFromText(text, durationMs)` (chia theo độ dài).

## Bẫy

1. **Giọng nam đọc ra giọng nữ khi chọn "miền Nam".**
   - Triệu chứng: Fenrir/Charon/Algenib "miền Nam" nghe như nữ. Đo F0: ~205–253 Hz, trong khi "miền Bắc" 126 Hz (A, đã đo).
   - Nguyên nhân: Gemini không có tham số giọng vùng hay giới tính, chỉ làm theo chỉ dẫn trong prompt; chỉ dẫn vùng miền kéo giọng trôi.
   - Cách tránh: khoá giới tính **ở hai chỗ**: câu chỉ dẫn "The speaker is an adult MAN… never sound female" **và** cụm "male speaker (man's voice)" ngay cạnh mô tả giọng vùng. Chỉ thêm câu chỉ dẫn thì chưa đủ (Fenrir vẫn 253 Hz). Thêm cả hai: Fenrir 126 Hz, Algenib 115 Hz, Kore 195 Hz (A, đã đo). `buildPrompt` tự khoá theo giới tính của giọng.
2. **Đọc luôn cả câu chỉ dẫn.**
   - Cách tránh: kết thúc chỉ dẫn bằng "Chỉ đọc đúng phần lời sau, không đọc chỉ dẫn này:" + xuống dòng + lời (C). Nghe thử câu đầu mỗi giọng mới.
3. **429 liên tục khi chạy batch.**
   - Nguyên nhân: hạn mức theo phút/ngày của từng key.
   - Cách tránh: key gặp 429 nghỉ **65 s**; nếu thông báo có "per day"/"daily" nghỉ **1 giờ**; key sai/bị chặn (401/403/`API_KEY_INVALID`) nghỉ **30 phút**; lỗi 5xx nghỉ 20 s. Đoạn sau dùng key kế tiếp (xoay vòng). Hết key → `GEMINI_TTS_QUOTA` kèm `retryAfterMs` để hàng đợi cooldown (A và C dùng cùng con số).
4. **Lỗi 400 làm "khoá" oan key.**
   - Cách tránh: 400 không phải lỗi key (văn bản/tham số sai) → báo `GEMINI_TTS_BAD_REQUEST`, không phạt key. Riêng 400 kèm `API_KEY_INVALID` mới là key sai (C).
5. **Trả về chữ thay vì âm thanh.**
   - Triệu chứng: 200 OK nhưng không có `inlineData` (có `finishReason`/`blockReason`).
   - Cách tránh: thử key khác 1 lần, lần 2 vẫn vậy → `GEMINI_TTS_NO_AUDIO`, gợi ý sửa lời/đổi giọng (C).
6. **Giọng/tốc độ trôi trong đoạn dài.** Chia ≤ 800 ký tự theo câu, chèn 0,15 s im lặng giữa các đoạn (C).
7. **Key mới dạng `AQ.` bị form từ chối.** Key Google mới có dấu chấm → regex key phải cho `.` (A).
8. **Lộ key.** Không đặt key ở URL (`?key=`): URL hay nằm trong log/proxy. Mã dùng header `x-goog-api-key` và xoá `key=` khỏi mọi thông báo lỗi.
9. **Lỗi mạng chập chờn làm hỏng cả key.** Lỗi mạng → thử key kế tiếp, không phạt key (C).
10. **Nghe thử tốn lượt.** (A)(C) cache file nghe thử theo giọng + vùng (+ hậu tố đánh dấu "đã khoá giới tính"; đổi cách khoá thì đổi tên cache, nếu không người dùng nghe mẫu cũ đã trôi giọng).

## Chưa kiểm chứng

- Tên model và hạn mức free tại thời điểm bạn đọc: kiểm trên trang Gemini API.
- Header `x-goog-api-key` (thay cho `?key=` mà A/C dùng): theo tài liệu Google, chưa chạy thật trong repo.
- Chế độ nhiều người nói của Gemini (`multiSpeakerVoiceConfig`, tối đa 2 giọng trong 1 lần gọi): chưa dùng. Lồng tiếng nhiều nhân vật trong repo này gọi từng mảnh (`multi-voice-dubbing.md`); (A) ghi nhận gemini-tts **không hỗ trợ** nhánh đa giọng của app đó.
- Các accent ngoài vi/en (zh, ja, ko, th, fr, de, es): prompt viết theo mẫu tiếng Anh, chưa nghe thử.
