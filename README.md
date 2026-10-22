# ai-media-batch-kit

Kinh nghiệm + mã tham chiếu để **tạo và tải ảnh / video AI hàng loạt** từ:

- **Google Flow**: Veo 3 (text→video, ảnh→video theo ảnh tham chiếu) + tạo ảnh
- **Muse** (muse.ai của Meta): ảnh + ảnh→video
- **ChatGPT**: tạo ảnh (chế độ UI hoặc backend-api, có đính ảnh mẫu); hỏi text để viết prompt hàng loạt
- **Gemini**: hỏi text
- **Grok**: grok.com/imagine (web) và xAI API chính thức

Tất cả chạy bằng **Chrome profile thật đã đăng nhập**, điều khiển qua Chrome DevTools Protocol (CDP).
Không dùng Puppeteer/Playwright, không cần API key (trừ xAI API).

Rút ra từ **hai app desktop đang chạy thật** (một app sản xuất video AI, một app nhạc/MV): hàng nghìn ảnh/clip, hàng chục lỗi đã sửa.
Mỗi lỗi được ghi lại thành "bẫy" kèm cách tránh.

## Dành cho ai

Bạn muốn thêm tính năng tạo ảnh/video AI hàng loạt vào app của mình và để **AI coding agent** (Claude Code, Codex, Cursor…) làm.
Đưa repo này cho nó đọc để khỏi tốn token research lại.

```text
Prompt gợi ý cho AI của bạn:
"Đọc AGENTS.md và skills/ai-media-batch/SKILL.md trong repo ai-media-batch-kit,
 rồi tích hợp provider <Flow/Muse/ChatGPT…> vào dự án này theo checklist trong đó."
```

## Cấu trúc

```
AGENTS.md / CLAUDE.md            ← AI đọc đầu tiên
skills/ai-media-batch/
  SKILL.md                       ← bản đồ + bảng provider + quy tắc vàng (dùng được như Claude Code skill)
  references/
    chrome-profiles-cdp.md       ← nền móng: profile, CDP, proxy, 16 bẫy chung
    batch-pipeline.md            ← chạy hàng loạt nhiều tài khoản, phân loại lỗi, ảnh→video, prompt
    flow-veo3.md  muse.md  chatgpt-image.md  chatgpt-gemini-text.md  grok.md
src/
  core/       cdp.js  chrome.js  window.js  profile-lock.js  proxy-relay.js  queue.js
  providers/  flow.js  muse.js  grok-web.js  xai-api.js
              chatgpt-session.js  chatgpt-image.js  chatgpt-text.js  chatgpt-backend.js  chatgpt-pow.js  gemini-text.js
examples/     muse-batch.js  flow-batch.js  chatgpt-batch-images.js  prompts.sample.json
test/         queue / page-scripts / profile-lock (offline) · live/smoke.js (chạy thật, tốn ít credit)
docs/         LIVE_TEST_2026-10-22.md (kết quả chạy thật)
scripts/      check.js  (node --check + require mọi module)
```

## Bắt đầu nhanh (Node ≥ 22, Windows/macOS/Linux có Chrome)

```bash
npm run check
npm test
```

```js
const { ensureProfileChrome } = require('./src/core/chrome');
// 1) Lần đầu: mở Chrome của profile, tự đăng nhập muse.ai / labs.google / chatgpt.com bằng tay
await ensureProfileChrome({ profileDir: 'D:/profiles/acc1', url: 'https://muse.ai/' });

// 2) Sau đó tự động hoá
const { createMuse } = require('./src/providers/muse');
const muse = createMuse({ profileDir: 'D:/profiles/acc1' });
const img = await muse.generateImage({ prompt: 'A red fox in snow', aspect: '16:9' });
require('fs').writeFileSync('fox.webp', img.buffer);
```

Hàng loạt trên nhiều tài khoản: `node examples/muse-batch.js examples/prompts.sample.json D:/profiles/acc1 D:/profiles/acc2`

## Mức độ kiểm chứng

Kinh nghiệm và các đoạn JS chạy trong trang lấy từ bản production. Mã trong repo này là **bản viết lại sạch, độc lập**:

| Provider | Mức độ |
|---|---|
| Muse | Port gần 1:1 từ bản production, cộng các sửa lỗi của app thứ hai |
| Flow / ChatGPT / Gemini | Viết lại; **đã chạy thật 22/10/2026** (ảnh, video, text). Đính ảnh mẫu ChatGPT chưa chạy |
| Grok | Viết lại; **đã chạy thật 22/10/2026** ảnh→video (sau khi chủ tài khoản xác nhận tuổi 1 lần) |

Chi tiết số đo: [`docs/LIVE_TEST_2026-10-22.md`](docs/LIVE_TEST_2026-10-22.md). Tự chạy lại: `node test/live/smoke.js <provider> <profileDir>`.

Hãy test với một tài khoản trước khi chạy hàng loạt. Giao diện web của các dịch vụ này thay đổi thường xuyên. Khi hỏng, tài liệu chỉ cách soi DOM qua CDP để sửa selector.

## Lưu ý pháp lý

Tự động hoá giao diện web của Google/OpenAI/Meta/xAI có thể trái điều khoản dịch vụ của họ. Hãy:
- dùng tài khoản riêng, tần suất vừa phải;
- tự chịu trách nhiệm với nội dung tạo ra;
- ưu tiên API chính thức khi cần ổn định cho mục đích thương mại.

Repo không chứa cookie, token hay dữ liệu tài khoản nào.

## Giấy phép

[MIT](LICENSE) © 2026 Hai Tran. Dùng, sửa, phân phối tự do (kể cả thương mại), miễn giữ lại thông báo bản quyền.
Phần mềm cung cấp "như hiện trạng", không bảo hành.
