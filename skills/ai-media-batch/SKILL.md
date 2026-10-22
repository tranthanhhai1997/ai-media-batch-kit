---
name: ai-media-batch
description: Tích hợp tạo & tải ẢNH + VIDEO hàng loạt từ Google Flow (Veo 3 / Imagen), Muse (muse.ai), ChatGPT (ảnh qua web), Grok (grok.com / xAI API) và hỏi text ChatGPT/Gemini bằng Chrome profile đã đăng nhập điều khiển qua CDP. Dùng khi cần thêm provider ảnh/video AI vào một app, chạy batch nhiều tài khoản, xử lý hết lượt/từ chối nội dung/phiên rớt, hoặc gỡ lỗi tự động hoá các trang AI này.
---

# ai-media-batch — playbook tạo ảnh/video AI hàng loạt qua Chrome profile + CDP

Bộ kiến thức + mã tham chiếu rút từ hai app desktop đã chạy thật (10/2026): (A) sản xuất video AI, (B) nhạc/MV.
Tài liệu ghi nguồn từng sự kiện (A)/(B), đã đo hay suy ra. Khi hai nguồn khác nhau, nguồn mới hơn được ưu tiên.
**Mục tiêu: AI đọc xong là ghép được vào dự án khác mà không phải research lại.**

## Đọc theo thứ tự

1. `references/chrome-profiles-cdp.md` — **bắt buộc**: mô hình 1 tài khoản = 1 profile = 1 Chrome có cổng CDP, 16 bẫy chung.
2. `references/batch-pipeline.md` — chạy hàng loạt: song song theo tài khoản, phân loại lỗi, luồng ảnh → video, prompt.
3. Provider cần dùng:

| Provider | Tài liệu | Mã | Làm được | Trạng thái |
|---|---|---|---|---|
| Google Flow (Veo 3, Imagen) | `references/flow-veo3.md` | `src/providers/flow.js`, `examples/flow-batch.js` | ảnh, text→video, ảnh→video theo ảnh tham chiếu (chưa có khung đầu+cuối) | ✅ **chạy thật 22/10**: credit, ảnh, t2v, i2v, tải file |
| Muse (muse.ai, Meta) | `references/muse.md` | `src/providers/muse.js`, `examples/muse-batch.js` | ảnh, ảnh→video ~10 s | ✅ **chạy thật 22/10**: ảnh + video (đính file/MV chưa chạy lại) |
| ChatGPT ảnh (web) | `references/chatgpt-image.md` | `src/providers/chatgpt-image.js` (+ `chatgpt-session.js`, `chatgpt-backend.js`, `chatgpt-pow.js`), `examples/chatgpt-batch-images.js` | ảnh; `mode:"ui"` (gõ vào trang) hoặc `mode:"api"` (backend-api trong tab, upload ảnh mẫu chưa ai chạy thật) | ✅ **chạy thật 22/10**: ảnh `ui` + `api` (đính ảnh mẫu chưa chạy) |
| ChatGPT / Gemini text | `references/chatgpt-gemini-text.md` | `src/providers/chatgpt-text.js`, `gemini-text.js` | viết/viết lại prompt hàng loạt | ✅ **chạy thật 22/10** |
| Grok | `references/grok.md` | `src/providers/grok-web.js`, `xai-api.js` | ảnh→video (web), t2v/i2v/ảnh (API trả phí) | ✅ web **chạy thật 22/10**: ảnh→video 6 s (cần xác nhận tuổi 1 lần/tài khoản; chọn độ phân giải chưa chạy); API theo docs, chưa gọi |

Kết quả chạy thật: `docs/LIVE_TEST_2026-10-22.md`; chạy lại bằng `test/live/smoke.js`. Mỗi tài liệu provider có mục **"Chưa kiểm chứng độc lập"**. Phần nào nằm trong mục đó thì phải test trước khi tin.

## Lõi dùng chung (Node ≥ 22, không dependency)

- `src/core/cdp.js`: `CdpClient`, `findOrOpenPage`, `openBackgroundTab`, `keepAlive`, `setFileInput`, `pullBytes`, `connectBrowser`.
- `src/core/chrome.js`: `ensureProfileChrome({profileDir, url, proxy})` → cổng CDP (dùng lại Chrome đang chạy, realpath chống junction).
- `src/core/proxy-relay.js`: proxy riêng từng profile (HTTP/SOCKS5 có mật khẩu) qua relay `127.0.0.1`.
- `src/core/queue.js`: `runBatch(jobs, {workers, run, classify})`, xoay vòng tài khoản LRU + cooldown + retry.
- `src/core/window.js`: `hideWindow`/`showWindow`/`hiddenWindowArgs`, tức ẩn ngoài màn hình ở cỡ desktop (không thu nhỏ).
- `src/core/profile-lock.js`: `withProfileLock(profileDir, kind, what, fn)`, khoá tài khoản giữa nhiều tiến trình.
- `src/core/cdp.js` → `attachViaChooser(client, paths, {buttonExpr, menuItemExpr})`: đính file bằng nút 📎 thật + chặn hộp chọn file.

## Cách tích hợp vào dự án khác (quy trình đề xuất cho AI)

1. Xác định runtime đích: Node/Electron thì copy thẳng `src/`. Python/khác thì port **giữ nguyên các đoạn JS chạy trong trang** (chuỗi `JS_*`, hàm `js*()`), vì đó là phần đắt nhất để tìm ra.
2. Tạo màn hình quản lý profile: thêm profile → `ensureProfileChrome({profileDir, url})` → người dùng đăng nhập tay → nút "Kiểm tra" gọi `status()`.
3. Gọi `status()` → tạo 1 ảnh → tạo 1 video với **một** profile, có `show:true` để nhìn. Đạt rồi mới bật `runBatch` nhiều profile.
4. Nối mã lỗi provider vào `classify`. Ghi file ngay khi xong từng việc, bỏ qua việc đã có file.
5. Giao diện web của các dịch vụ thay đổi thường xuyên. Khi hỏng, mở tab bằng `show:true`, dùng `client.evaluate` để soi DOM, rồi sửa selector/regex trong chuỗi `JS_*`. Đừng viết lại cả luồng.

## Quy tắc vàng

- Không headless. Không dùng profile mặc định của Chrome. Mỗi tài khoản có profile riêng.
- Một tài khoản = một việc tại một thời điểm. Muốn nhanh thì thêm tài khoản.
- Không tin chữ "xong", chỉ tin file media thật mới xuất hiện.
- Trước khi gửi, đánh dấu mọi media cũ; chỉ nhận media mới nằm sau tin nhắn của mình.
- Bị từ chối nội dung thì viết lại prompt / đổi ảnh / đổi model, không retry nguyên văn.
- Tự động hoá giao diện web có thể trái điều khoản dịch vụ. Dùng tài khoản riêng, tần suất vừa phải. Cần ổn định thì ưu tiên API chính thức (vd `xai-api.js`).
