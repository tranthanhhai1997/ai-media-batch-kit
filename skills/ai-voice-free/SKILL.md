---
name: ai-voice-free
description: Tích hợp GIỌNG ĐỌC (TTS) miễn phí / giá rẻ vào app — Microsoft Edge Read Aloud (miễn phí, không key), Gemini TTS (key Google của người dùng, tầng free, 30 giọng, giọng vùng Bắc/Nam, khoá giới tính, xoay nhiều key), ai33.pro (trả phí rẻ, có Vbee tiếng Việt), Kokoro và OmniVoice clone giọng chạy máy; chuẩn hoá chữ tiếng Việt, chia đoạn, ghép audio có khoảng lặng, lồng tiếng nhiều nhân vật, phụ đề SRT/VTT từ mốc từ. Dùng khi cần thêm lồng tiếng/thuyết minh/đọc kịch bản hàng loạt hoặc gỡ lỗi giọng đọc tiếng Việt.
---

# ai-voice-free — giọng đọc miễn phí cho app (Node + Python tham chiếu)

Rút từ hai app desktop đang chạy thật (10/2026): **(A)** app sản xuất video AI (lồng tiếng đa giọng, clone giọng, Gemini nhiều key),
**(C)** app video bài giảng (Edge TTS, Gemini, ai33, phụ đề theo mốc từ, có unit test).
**Chạy thật 22/10/2026** (xem `docs/LIVE_TEST_2026-10-22.md`): Edge ✅, Gemini TTS ✅ (khoá giới tính đo F0 115 Hz), batch đa giọng ✅; ai33 và OmniVoice chưa chạy thật.
Mỗi bẫy ghi nguồn (A)/(C), **đã đo** hay **suy ra**. Mục "Chưa kiểm chứng" ở cuối mỗi tài liệu: coi là giả thuyết.

## Đọc theo thứ tự

1. `references/providers.md` — chọn provider: miễn phí tới đâu, tiếng Việt tốt không, cần key/GPU, giấy phép, rủi ro.
2. `references/vietnamese-text.md` — **bắt buộc nếu đọc tiếng Việt**: chuẩn hoá số/ngày/tiền trước khi gửi TTS.
3. Tài liệu provider cần dùng: `edge-tts.md`, `gemini-tts.md`, `ai33.md`, `voice-clone.md` (OmniVoice, Kokoro).
4. `multi-voice-dubbing.md` nếu kịch bản có nhân vật nói chuyện.
5. `voicestudio-notes.md` — ghi chú tham khảo một app TTS mã nguồn mở (engine, giấy phép model).

## Mã (Node ≥ 22, CommonJS, không dependency)

| File | Làm gì | Lỗi (`err.code`) |
|---|---|---|
| `src/voice/edge-tts.js` (gọi gói Python `edge-tts`, cần `pip install edge-tts`) | `synthesize({text, voice, rate, pitch, volume})` → `{buffer mp3, words, durationMs}`; `listVoices()` | `EDGE_NOT_INSTALLED/FORBIDDEN/NETWORK/TIMEOUT/NO_AUDIO/BAD_INPUT` |
| `src/voice/gemini-tts.js` | `createGeminiTts({keys})` → `synthesize({text, voice, accent, gender, style})` → WAV; `checkKeys()` | `GEMINI_TTS_NO_KEY/QUOTA/AUTH/BAD_REQUEST/NO_AUDIO/NETWORK/TIMEOUT` |
| `src/voice/ai33.js` | `createAi33({apiKey})` → `listVoices({provider})`, `synthesize({voiceId, text, speed})`, `credits()` | `AI33_NO_KEY/AUTH/NO_CREDIT/VOICE_NOT_FOUND/RATE_LIMIT/NETWORK/TIMEOUT/BAD_RESPONSE/FAILED` |
| `src/voice/normalize-vi.js` | `normalizeVi(text, {le})`, `isViVoice`, `looksVietnamese` (cũng chạy được như CLI qua stdin) | — |
| `src/voice/chunk.js` | `splitText(text, {maxChars, maxBytes, measure})`, `splitSentences` | — |
| `src/voice/audio.js` | `pcmToWav`, `wavInfo`, `concatWav({gapsSec})`, `mp3Duration`, `concatFiles` / `encodeMp3` (ffmpeg) | `AUDIO_*` |
| `src/voice/multi-voice.js` | `castVoices`, `inferGenderAge`, `parseScript`, `planChunks`, `gapsAfter`, `fixTaggedParts` | — |
| `src/voice/subtitles.js` | `cuesFromWords(words, {text})`, `cuesFromText`, `toSrt`, `toVtt` | — |
| `python/local_tts/omnivoice_clone/` | clone giọng chạy máy: làm sạch mẫu, chuẩn hoá VI, engine, worker tự tắt, CLI (**trọng số CC-BY-NC**) | `SAMPLE` / `FAILED` |
| `python/local_tts/kokoro_tts.py` | Kokoro-82M (Apache-2.0), **không có tiếng Việt** | — |

Mốc từ thống nhất: `{ text, offsetMs, durationMs }`. Mã lỗi có tiền tố provider để nối vào `runBatch.classify` của `src/core/queue.js`
(`*_NETWORK/*_TIMEOUT` → retry, `*_QUOTA/*_RATE_LIMIT` → cooldown, còn lại → fail). Ví dụ: `examples/voice-batch.js`.

## Quy trình tích hợp đề xuất (cho AI)

1. Hỏi người dùng: ngôn ngữ (Việt? vùng miền?), có được dùng dịch vụ không chính thức (Edge) không, có key Gemini/ai33 không,
   có dùng thương mại không (loại OmniVoice), máy có GPU không.
2. Pipeline mỗi câu/cảnh: `normalizeVi` (nếu tiếng Việt) → provider `synthesize` → lưu file ngay → `cuesFromWords(words, {text: chữ gốc})` hoặc `cuesFromText`.
3. Kịch bản nhiều nhân vật: `parseScript` → `castVoices` → `planChunks` → TTS từng mảnh → `concatWav`/`concatFiles` với `gapsAfter`.
4. Test theo thang: 1 câu ngắn → 1 đoạn dài > 1 500 ký tự (chia đoạn) → 1 kịch bản đa giọng → batch. Trước bước tốn quota/credit (Gemini, ai33), **hỏi người dùng**.
5. Luôn có giọng dự phòng: Edge có thể bị chặn bất cứ lúc nào; Gemini free hết lượt theo phút/ngày.

## Quy tắc vàng

- Chuẩn hoá chữ tiếng Việt **trước** TTS, nhưng làm phụ đề từ **chữ gốc** (người xem muốn thấy "50 km", không phải "năm mươi ki lô mét").
- Không bao giờ log/ghi key vào URL hoặc thông báo lỗi. Key của người dùng lưu mã hoá (Electron `safeStorage`, keychain…).
- POST tốn tiền (ai33, Gemini) chỉ gửi lại khi chắc server **chưa nhận** (429/503). Lỗi mạng giữa chừng: không tự gửi lại.
- Giọng không có tiếng Việt (Kokoro gốc, nhiều giọng thư viện) phải bị **chặn** khi văn bản là tiếng Việt, đừng để đọc bồi rồi hỏng ở bước sau.
- Model chạy máy: nạp khi cần, tự tắt khi rảnh. Không nạp sẵn lúc mở app.
- Tôn trọng điều khoản: Edge là endpoint không chính thức; Gemini free có hạn mức, xoay key chỉ cho các key bạn sở hữu hợp lệ;
  OmniVoice không thương mại; chỉ clone giọng khi có quyền.
