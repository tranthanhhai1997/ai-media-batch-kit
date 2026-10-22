# Grok Imagine — ảnh → video qua grok.com (CDP) + API chính thức xAI

> **Chạy thật 22/10/2026:** `status` OK. Khung chọn chế độ đã đổi sang `role="group"` (đã sửa selector).
> - Lần đầu bấm tạo: grok.com hiện **"Please confirm your age"** (chọn năm sinh) → `GROK_AGE_GATE`. Chủ tài khoản phải tự xác nhận **một lần** trong cửa sổ Chrome của profile; code không tự điền.
> - Sau khi xác nhận: ảnh→video **đạt**, tổng 24 s (render ~14 s), mp4 6 s **736×400**. Khung đầu trùng ảnh nguồn. Không thấy menu độ phân giải nên dùng mặc định thấp; cần soi lại selector độ phân giải.

> Mã: `src/providers/grok-web.js` (lái giao diện web) và `src/providers/xai-api.js` (API trả phí).
> Trạng thái: đường web **đã chạy thật một lần** (22/10/2026, xem trên). Phần còn lại vẫn là phân tích tĩnh một bản tích hợp
> chưa từng chạy hoàn chỉnh (lần thử duy nhất dừng ở `GROK_AUTH` vì phiên grok.com đã hết hạn).
> Đường API viết theo ghi chép docs.x.ai 09/2026, chưa gọi thử. Cả hai mới qua `node --check`.
> Xem mục 10 trước khi dùng cho sản xuất.

## 1. Chọn đường nào

| | Web (`grok-web.js`) | API (`xai-api.js`) |
|---|---|---|
| Chi phí | Miễn phí / gói SuperGrok, có **hạn mức ngày** theo tài khoản | Trả theo giây video (~$0.05–0.08/s, 09/2026) |
| Đầu vào | **Chỉ ảnh → video** (ảnh làm khung đầu) | Chữ → video, ảnh → video, ảnh tham chiếu (≤720p) |
| Thời lượng | 6 / 10 / 15 s (nút trong UI) | 1–15 s |
| Ổn định | Phụ thuộc DOM, Cloudflare, chống bot, kiểm duyệt | Hợp đồng JSON, mã HTTP rõ ràng |
| Song song | 1 job / profile; nhiều tài khoản = nhiều profile | Theo giới hạn rate của key |
| Ảnh tĩnh | Không làm (chưa viết) | `generateImage()` |

Khuyến nghị: thử web cho khối lượng nhỏ/miễn phí; sản xuất hàng loạt cần ổn định → API.

## 2. Dùng nhanh

```js
const { createGrokWeb, rotateAccounts } = require('./src/providers/grok-web');
const grok = createGrokWeb({ profileDir: 'D:/profiles/grok-1', show: true, log: console.log });

const st = await grok.status();            // { loggedIn, email, challenge, anonymous }
if (!st.loggedIn) await grok.login();      // cửa sổ hiện lên, người dùng tự đăng nhập (chờ tối đa 5 phút)

const clip = await grok.imageToVideo({
  image: { path: 'scene01.png' },          // hoặc { b64, mime }
  prompt: 'slow push-in, leaves drifting, soft wind',
  aspect: '9:16', durationSec: 6, timeoutMs: 360_000,
});
fs.writeFileSync('scene01.mp4', clip.buffer); // clip.videoId, clip.url, clip.durationSec
```

```js
const { createXaiClient } = require('./src/providers/xai-api');
const xai = createXaiClient();             // đọc XAI_API_KEY
const v = await xai.imageToVideo({ image: { path: 'scene01.png' }, prompt: '...', duration: 6, aspectRatio: '9:16', resolution: '720p' });
const imgs = await xai.generateImage({ prompt: 'a red fox in snow', n: 2 });
```

## 3. Sơ đồ luồng (đường web)

```
imageToVideo()
  │ (khoá theo profile: mỗi profile chỉ chạy 1 job)
  ├─ ensureProfileChrome(profileDir) ─► Chrome thật, cổng CDP (không headless)
  ├─ tab grok.com ─► Page.navigate https://grok.com/imagine (composer mới mỗi job)
  ├─ chờ Cloudflare qua (≤90 s)  ─ chờ composer dựng (≤30 s)
  ├─ GET /api/auth/session trong trang ─► chưa đăng nhập → GROK_AUTH NGAY (không chờ hết giờ)
  ├─ dẹp banner cookie · kiểm tra hộp xác nhận tuổi / hộp Sign in
  ├─ chế độ Video ─► tỉ lệ ─► độ phân giải ─► thời lượng
  ├─ gắn ảnh vào input[name=files] (DOM.setFileInputFiles) ─► chờ chip "Remove image"
  ├─ gõ prompt (Input.insertText) ─► kiểm tra chữ đã vào ô
  ├─ bật nghe Network (request tạo video + header x-statsig-id)
  ├─ bấm Submit (chờ nút đứng yên, tối đa 4 lần, rồi Enter)
  ├─ chờ kết quả (mặc định 6 phút):
  │     ① body stream NDJSON của /rest/app-chat/conversations/new → videoId, videoUrl, moderated
  │     ② dự phòng: trang chuyển /imagine/post/<uuid> + <video src=…/generated/<uuid>/generated_video.mp4>
  ├─ chưa có URL → POST /rest/media/post/get {id} (dùng lại x-statsig-id của chính trang) → post.mediaUrl
  └─ pullBytes(url) trong trang (kèm cookie), thử lại 4 lần × 4 s → { buffer, contentType }
```

## 4. Đăng nhập & profile

- Một **thư mục profile Chrome = một tài khoản grok.com** (đăng nhập bằng X/Google/email). Đăng nhập tay một lần với `show:true`.
- Kiểm tra đăng nhập: `fetch('/api/auth/session')` trong trang.
  - Trả HTML hoặc 403 → đang ở trang Cloudflare (`challenge:true`), chờ rồi hỏi lại.
  - **Bẫy:** khách vãng lai cũng nhận `status:"authenticated"` nhưng `userId`/`email` rỗng. Chỉ tính là đã đăng nhập khi có `userId` hoặc `email` hoặc `xUserId`.
- Không chạy headless: Cloudflare chặn. `show:false` chỉ đẩy cửa sổ ra ngoài màn hình; `keepAlive()` giữ trang ở trạng thái "visible".
- Tài khoản mới có thể bị **hộp xác nhận tuổi** trước khi tạo video (stream có `_AGE_VERIFICATION_REQUIRED`) → `GROK_AGE_GATE`; người dùng mở profile, xác nhận năm sinh một lần.

## 5. Các bước UI — selector & tín hiệu (quan sát 09/2026, sẽ thay đổi)

| Bước | Selector / tín hiệu |
|---|---|
| Composer sẵn sàng | `location.pathname === '/imagine'` + `[role=radiogroup][aria-label='Generation mode']` + `div.tiptap.ProseMirror[contenteditable=true]` |
| Cloudflare | chữ "Performing security verification" / "Just a moment" / "verify you are not a bot" |
| Banner cookie | `button[aria-label='Dismiss cookie notice']` hoặc nút "Reject All"/"Accept All Cookies" |
| Chế độ Video | `[aria-label='Generation mode'] [aria-label='Video']` có `aria-checked="true"` (cũ: nút chữ "Video"; có `[aria-label='Video duration']` cũng coi là đang ở Video) |
| Tỉ lệ | `button[aria-label='Aspect Ratio']` → menu (`[role=menu]`/`[role=menuitemradio]`) → mục có chữ `9:16`/`16:9`… Nhãn nút chứa tỉ lệ hiện tại |
| Thời lượng | mới: `button[aria-label='Video duration'][aria-haspopup]` → `menuitemradio` "6s/10s/15s"; cũ: nút radio "6s"/"10s" trong `[aria-label='Video duration']` |
| Độ phân giải | `button[aria-label='Video resolution'][aria-haspopup]` → "480p/720p/1080p" (không có thì giữ mặc định) |
| Gắn ảnh | `input[type=file][name=files]` (**không** lấy input đầu tiên trong DOM). Gắn xong có `button[aria-label='Remove image']` hiển thị |
| Ảnh lạc vào khay | `button[aria-label='Upload']` → tab "Uploads" → `button[aria-label='Select image <tên file>']` |
| Ô prompt | `div.tiptap.ProseMirror` (TipTap): click → Ctrl+A → Backspace → `Input.insertText` |
| Submit | `button[aria-label='Submit']` không `disabled`/`aria-disabled`; `elementFromPoint` ở tâm nút phải là chính nút (không bị toast che) |
| Lệnh đã nhận | ô prompt rỗng, hoặc chữ "generating/creating/rendering", hoặc URL đổi sang `/imagine/post/<uuid>` |
| Video xong (①) | request `/rest/app-chat/conversations/new` (hoặc `/conversations/<id>/responses`) **loadingFinished**; body có `"videoId"`/`"videoPostId"`, `"videoUrl"`, `"progress":100`, `"moderated"` |
| Video xong (②) | `/imagine/post/<uuid>` + `<video>` có `src` khớp `generated/<uuid>/generated_video.mp4` (uuid chưa có trước khi bấm) + `HEAD` OK và `content-length` > 50 KB |
| Ảnh có được dùng không | stream ghi `"imageToVideo"` (đúng) hay `"textToVideo"` (ảnh không vào composer) |

`videoUrl` trong stream có thể là đường dẫn tương đối → ghép `https://assets.grok.com/`.

## 6. Tải bytes

- URL `assets.grok.com` cần cookie phiên → tải **bên trong trang** bằng `fetch(url, {credentials:'include'})`, rồi rút base64 từng khúc (`pullBytes` trong `core/cdp.js`). Không tải bằng Node trực tiếp.
- Ngay sau khi xong, CDN đôi khi trả 403/404 vài giây → thử lại 4 lần, cách 4 s.
- `POST /rest/media/post/get` cần header `x-statsig-id` (chống bot, sinh bởi JS của trang). Không tự sinh được: **bắt** từ chính request của trang qua `Network.requestWillBeSent`.

## 7. Hạn mức ngày & xoay vòng tài khoản

- Tài khoản free/SuperGrok có giới hạn số video/ngày (con số chưa đo). Dấu hiệu dự kiến: HTTP 429 ở request tạo video, chữ "rate limit / limit reached / upgrade to SuperGrok / try again later" trên trang → `GROK_QUOTA`. **Các mẫu chữ này chưa kiểm chứng**, hãy chụp lại thông báo thật rồi chỉnh regex `JS.quotaText`.
- Xoay vòng: một `createGrokWeb` cho mỗi profile, dùng `rotateAccounts`:

```js
const pool = ['D:/profiles/grok-1', 'D:/profiles/grok-2'].map((d) => createGrokWeb({ profileDir: d, show: false }));
const today = { skip: new Set() };            // tự reset mỗi ngày
const clip = await rotateAccounts(pool, (g) => g.imageToVideo(job), today);
```

  Chuyển tài khoản khi gặp `GROK_QUOTA`, `GROK_AUTH`, `GROK_AGE_GATE`; lỗi khác ném ra ngay.
- Hàng loạt: các profile khác nhau chạy song song được; **cùng profile thì tuần tự** (mã đã khoá sẵn).

## 8. Kiểm duyệt (moderation)

- Stream có `"moderated":true` → `GROK_MODERATED`. Không thử lại nguyên prompt/ảnh đó: đổi prompt trung tính hơn hoặc đổi ảnh.
- Hay bị từ chối: người thật/nổi tiếng nhận diện được, trẻ em trong ngữ cảnh nhạy cảm, bạo lực, khoả thân. Có thể thoát nhờ prompt chỉ mô tả chuyển động máy quay ("slow dolly in, gentle wind").
- Chế độ "Spicy" của Grok không dùng cho tự động hoá.
- API: job `failed` có lý do chứa moderation/policy/safety → `XAI_MODERATED`.

## 9. Bảng mã lỗi

| Mã | Nguồn | Ý nghĩa | Xử lý |
|---|---|---|---|
| `GROK_AUTH` | web | chưa đăng nhập / phiên ẩn danh / hộp Sign in / HTTP 401 | `login()` rồi chạy lại; xoay tài khoản |
| `GROK_AGE_GATE` | web | yêu cầu xác nhận tuổi | người dùng xác nhận tay 1 lần |
| `GROK_QUOTA` | web | hết lượt ngày / 429 | xoay tài khoản, hoặc chờ sang ngày |
| `GROK_MODERATED` | web | nội dung bị từ chối | sửa prompt/ảnh, không thử lại y nguyên |
| `GROK_TIMEOUT` | web | hết `timeoutMs` không thấy clip | xem lịch sử grok.com/imagine; tăng timeout; thử lại 1 lần |
| `GROK_UI` | web | selector không khớp, ảnh không gắn được, Submit không nhận | cập nhật selector mục 5 |
| `GROK_BROWSER` | web | không mở được Chrome/CDP, kẹt Cloudflare | xem bẫy 1, 3 |
| `GROK_DOWNLOAD` | web | xong nhưng không lấy được URL/mp4 | thử lại; tải tay từ trang |
| `XAI_AUTH` | API | thiếu key / 401 / 403 | kiểm tra `XAI_API_KEY` |
| `XAI_QUOTA` | API | 402 / 429 (hết tiền, rate) | nạp tiền, giảm song song |
| `XAI_BAD_REQUEST` | API | 4xx khác (sai tham số, model) | đối chiếu docs.x.ai |
| `XAI_MODERATED` / `XAI_FAILED` / `XAI_EXPIRED` / `XAI_TIMEOUT` / `XAI_NETWORK` | API | như tên | `EXPIRED`: URL kết quả tạm thời, tải ngay khi `done` |

## 10. Các bẫy (triệu chứng → nguyên nhân → cách tránh)

1. **Chrome không lên cổng CDP trong 60 s** → profile đang được mở bởi một Chrome khác không có cổng debug (thường là job Flow/Muse khác dùng chung profile, hoặc người dùng tự mở) → mỗi provider một profile riêng; kiểm tra `runningPort(profileDir)` trước; đóng Chrome đang chiếm.
2. **Job chạy ~9 phút rồi mới báo `GROK_AUTH`** → phiên grok.com trong profile đã hết hạn (đăng nhập từ vài tuần trước) và bản cũ chỉ phát hiện ở cuối → gọi `status()` trước khi xếp hàng job; `imageToVideo` cũng tự kiểm tra phiên trước khi bấm gì.
3. **Kẹt trang "Just a moment…"** → Cloudflare; headless hoặc profile mới tinh dễ bị → mở `show:true` một lần cho qua, không dùng headless, đừng xoá cookie `cf_clearance`.
4. **Tưởng đã đăng nhập nhưng bấm Upload lại hiện Sign in/Sign up** → `/api/auth/session` trả `authenticated` cho khách vãng lai → chỉ tin khi có `userId`/`email`.
5. **Video ra nhưng không giống ảnh (trang chạy textToVideo)** → ảnh được nạp vào input ẩn của khay Uploads (input đầu tiên trong DOM), không vào composer → luôn nhắm `input[type=file][name=files]` và chờ chip "Remove image"; log cảnh báo khi stream ghi `textToVideo`.
6. **Gọi API nội bộ grok.com bằng fetch tự dựng bị từ chối ("out of date / Reload to continue", 403)** → chống bot theo từng request (header `x-statsig-id` + chữ ký phía trang) → chỉ dùng đường UI; chỉ gọi `/rest/media/post/get` với header bắt từ chính trang.
7. **Bấm Submit không ăn** → nút còn `disabled` khi ảnh đang upload, hoặc bị toast/banner che, hoặc layout còn dịch chuyển → chờ nút enable, đo vị trí 2 lần giống nhau, kiểm tra `elementFromPoint`, cuối cùng mới Enter.
8. **Hộp chọn file của hệ điều hành bật lên làm treo** → bật `Page.setInterceptFileChooserDialog` và nạp file bằng `DOM.setFileInputFiles`.
9. **Clip của job trước bị nhận nhầm** → chụp danh sách uuid `<video>` trước khi bấm, chỉ nhận uuid mới **và** trùng `/imagine/post/<uuid>` hiện tại.
10. **Tải mp4 403 ngay khi vừa xong** → CDN chưa sẵn → thử lại có giãn cách; tải trong trang để kèm cookie.
11. **Ảnh cũ còn dính trong composer** → mỗi job điều hướng lại `/imagine` và gỡ hết chip "Remove image" trước khi gắn ảnh mới.
12. **Thời lượng/tỉ lệ không như yêu cầu** → UI chỉ có một số lựa chọn (6/10/15 s; bản UI cũ chỉ 6/10 s; tỉ lệ có thể chỉ 9:16, 16:9, 2:3, 3:2, 1:1) → mã chọn gần nhất và trả `durationSec` thực tế; kiểm tra lại thời lượng file trước khi ghép.
13. **API: URL kết quả hết hạn** → `video.url` là tạm thời → tải ngay khi `status=done`, lưu file cục bộ.

## 11. API chính thức xAI (tóm tắt, theo ghi chép docs.x.ai 09/2026 — có thể đã đổi)

- `POST https://api.x.ai/v1/videos/generations`, header `Authorization: Bearer $XAI_API_KEY`
  `{ model: "grok-imagine-video-1.5" | "grok-imagine-video", prompt, duration: 1–15, aspect_ratio: "9:16"…, resolution: "480p"|"720p"|"1080p", image (ảnh→video), reference_images (chế độ reference-to-video, ≤720p), generate_audio }` → `{ request_id }`
- `GET /v1/videos/{request_id}` → `status: pending | done | expired | failed`, `video.url` (tạm thời). Client poll 5 s/lần, tối đa 15 phút.
- `POST /v1/images/generations` `{ model, prompt, n, response_format: "b64_json"|"url" }` → `data[]`.
- Giá ghi nhận 09/2026: video ~$0.05/s (grok-imagine-video), ~$0.08/s (1.5); ảnh ~$0.02–0.05/ảnh. **Kiểm tra lại bảng giá trước khi chạy số lượng lớn.**
- Ảnh đầu vào được gửi dạng data URI (`data:image/png;base64,…`) hoặc URL https. Dạng trường `image` (`{url}` hay chuỗi) chưa chắc → tham số `imageField: 'object'|'string'`.
- Tên model ảnh mặc định (`grok-imagine-image`) là **giả định** — đặt `imageModel` theo docs.

## 12. Chưa kiểm chứng độc lập

- Tính năng Grok web trong ứng dụng gốc **chưa từng chạy hoàn chỉnh**: lần thử duy nhất mở được grok.com/imagine rồi dừng ở `GROK_AUTH` (phiên hết hạn). Toàn bộ luồng UI ở đây chưa sinh được clip thật nào.
- Selector, cấu trúc stream (`streamingVideoGenerationResponse`, `videoId`, `progress`, `moderated`), đường dẫn `/rest/media/post/get`, `assets.grok.com` — đọc từ mã phân tích 09/2026; grok.com đổi giao diện thường xuyên.
- Dấu hiệu hết hạn mức (`GROK_QUOTA`) hoàn toàn là phỏng đoán; chưa biết số lượt/ngày.
- Menu "Video resolution" / "Video duration" dạng popup: bản gốc gọi qua một vai trò selector không được định nghĩa nên có thể chưa bao giờ chạy được; ở đây viết lại bằng `aria-label` trực tiếp.
- Độ giống khung đầu: ghi chép cũ nói Grok giữ ảnh gần như nguyên pixel (SSIM khung đầu ~0.99, so với Muse ~0.71) — con số Grok **chưa đo lại**.
- `Network.getResponseBody` cho stream dài: chỉ đọc được sau `loadingFinished`; nếu trang dùng WebSocket/SSE kiểu khác thì chỉ còn đường dự phòng DOM.
- API xAI: chưa gọi thử; tên trường, model, giá lấy từ ghi chép, cần đối chiếu https://docs.x.ai.
- Thứ tự test đề xuất: `status()` → `login()` → 1 clip 6 s 9:16 với `show:true` (quan sát) → kiểm tra `kind` là `imageToVideo` → rồi mới chạy hàng loạt / xoay vòng.
