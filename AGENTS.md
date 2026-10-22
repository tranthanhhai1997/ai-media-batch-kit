# AGENTS.md — hướng dẫn cho AI (Claude Code, Codex, Cursor, Gemini CLI…) đọc repo này

Bạn được người dùng đưa repo này để **ghép tính năng tạo & tải ảnh/video AI hàng loạt, và giọng đọc (TTS) miễn phí / giá rẻ, vào dự án của họ**.
Đừng research lại từ đầu: các bẫy và con số ở đây đều đo trên app production.

## Thứ tự đọc (đừng đọc hết mã ngay)

1. `skills/ai-media-batch/SKILL.md`: bản đồ, bảng provider, trạng thái kiểm chứng.
2. `skills/ai-media-batch/references/chrome-profiles-cdp.md` + `batch-pipeline.md`.
3. Chỉ tài liệu + mã của **provider người dùng cần** (`references/<provider>.md` → `src/providers/<provider>.js`).
4. `src/core/*.js` khi cần chi tiết.

### Nếu việc là GIỌNG ĐỌC (TTS, lồng tiếng, phụ đề)

1. `skills/ai-voice-free/SKILL.md` → `references/providers.md` (chọn provider) → `references/vietnamese-text.md` nếu đọc tiếng Việt.
2. Tài liệu + mã của provider cần: `edge-tts.md` → `src/voice/edge-tts.js`, `gemini-tts.md` → `gemini-tts.js`, `ai33.md` → `ai33.js`,
   `voice-clone.md` → `python/local_tts/`. Nhiều nhân vật: `multi-voice-dubbing.md` → `multi-voice.js`.
3. Không cần Chrome/CDP. Copy `src/voice/` (tự chứa, chỉ phụ thuộc lẫn nhau). Ngôn ngữ khác: port, giữ nguyên các hằng số đã đo
   (giới hạn ký tự/byte, thời gian nghỉ key, khoảng lặng 0,45/0,12/0,18/0,15 s) và **giữ nguyên ca test** trong `test/voice.test.js`.
4. Trước bước tốn quota/credit (Gemini, ai33) hỏi người dùng. Không đưa key vào URL/log. OmniVoice: nhắc người dùng giấy phép **CC-BY-NC**.

## Khi tích hợp

- Hỏi người dùng 3 điều nếu chưa rõ:
  - provider nào;
  - runtime đích (Node/Electron/Python/khác);
  - chạy trên máy người dùng có Chrome hay trên server. Các provider web **cần Chrome thật, có giao diện, đã đăng nhập**, nên không chạy trên server headless.
- Node/Electron: copy `src/core/` + provider cần dùng, giữ nguyên API. Ngôn ngữ khác: port, nhưng **giữ nguyên các chuỗi JS chạy trong trang** (`JS_*`, `js*()`) và mọi hằng số thời gian (đều đã đo).
- Test theo thang:
  1. `status()`;
  2. 1 ảnh;
  3. 1 video với một profile, `show:true`;
  4. batch 3 việc trên 2 profile;
  5. mới chạy thật.
  Trước mỗi bước tốn credit/hạn mức, **hỏi người dùng**.
- Phần ghi "Chưa kiểm chứng độc lập" trong tài liệu: coi là giả thuyết. Khi lệch với trang thật, soi DOM/network qua CDP rồi sửa đúng chỗ, và cập nhật lại tài liệu nếu được phép.
- Không đưa cookie, token, email, file profile của người dùng ra ngoài máy. Không commit thư mục `profiles/`.

## Lệnh

```bash
npm run check   # node --check + require mọi module (không mạng)
npm test        # test offline: hàng đợi batch, page scripts, profile lock, giọng đọc (voice.test.js)
node examples/voice-batch.js examples/voice.sample.json          # TTS hàng loạt (Edge mặc định, gọi mạng thật)
cd python/local_tts && python -m py_compile kokoro_tts.py omnivoice_clone/*.py
node examples/muse-batch.js examples/prompts.sample.json D:/profiles/muse-1
```

## Quy ước mã

CommonJS, Node ≥ 22 (WebSocket/fetch toàn cục), không dependency. Comment tiếng Anh, giải thích "vì sao".
Mỗi provider ném lỗi có `code` dạng `PROVIDER_REASON` (vd `FLOW_QUOTA`, `MUSE_AUTH`, `EDGE_FORBIDDEN`, `GEMINI_TTS_QUOTA`, `AI33_NO_CREDIT`) để `runBatch.classify` phân loại.
Python (`python/local_tts/`): 3.10–3.12, import nặng (torch, omnivoice) đặt trong hàm; `scripts/check.js` không kiểm Python.
