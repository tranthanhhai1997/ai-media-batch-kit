# ChatGPT (chatgpt.com) — tạo ảnh hàng loạt bằng tài khoản web, qua CDP

> **Chạy thật 22/10/2026 (gói free):** `mode:"ui"` 24 s, PNG 1672×941; `mode:"api"` 54 s. Đính ảnh mẫu (cả 2 chế độ) **chưa** chạy thật.

> Mã: `src/providers/chatgpt-image.js` (+ `chatgpt-session.js` dùng chung tab/khoá, `chatgpt-backend.js` gọi /backend-api trong tab, `chatgpt-pow.js` proof-of-work). Ví dụ: `examples/chatgpt-batch-images.js`.
>
> **Nhãn nguồn** dùng trong tài liệu này:
> **[A]** = bản gốc thứ nhất (app video, lái giao diện chatgpt.com, đã chạy thật 09–10/2026) ·
> **[M]** = bản gốc thứ hai (app nhạc, gọi /backend-api bằng Electron, có unit test; ảnh bìa đã chạy thật 30/09/2026) ·
> **[Đo]** = số đo/quan sát thật ghi trong nhật ký dự án gốc · **[Suy]** = suy luận, chưa kiểm chứng ·
> **[Repo]** = code mới trong repo này: **mới qua `node --check` + test offline các hàm thuần (parser, PoW, phân loại lỗi), chưa chạy với chatgpt.com thật.**

## 1. Hai chế độ

| | `mode: 'ui'` (mặc định) | `mode: 'api'` |
|---|---|---|
| Cách làm | Gõ prompt vào chatgpt.com, chờ `<img>` mới, tải trong trang | `fetch` /backend-api **ngay trong tab**: sentinel + PoW → conversation → poll → files/download |
| Nguồn | [A] chạy thật (thumbnail ~35 s, có ảnh mẫu) | [M] chạy thật **không ảnh mẫu** (PNG 1254×1254 ~60 s). Upload ảnh mẫu: chỉ có code ở [A] (`generateImageWithReference`), **không thấy bằng chứng đã chạy** |
| Ảnh mẫu | Đính qua ô file của giao diện | `POST /backend-api/files` → PUT blob → `/uploaded` |
| Khi OpenAI đổi giao thức (Turnstile, conduit…) | Vẫn chạy (trang tự lo) | Vỡ → chuyển `ui` |
| Khi OpenAI đổi giao diện | Vỡ selector → sửa `SEL`/`JS_IMG_LIB` | Không ảnh hưởng |
| Tốc độ | Chậm hơn (điều hướng, gõ) | Nhanh hơn |

Khác biệt với cả hai bản gốc **[Repo]**: không chép cookie ra Electron/Node. Mọi request chạy trong Chrome thật của profile → cookie, Cloudflare, `sec-ch-ua`, TLS là của trình duyệt; accessToken không rời trang. Node chỉ tính PoW và parse.

```
generateImage(job)  ── withProfileLock(profile) ─┬─ mode 'ui'  ─ chat mới → [đính ảnh mẫu] → baseline ảnh → gõ + Enter
                                                 │               → poll 2 s: ảnh MỚI ổn định → pullBytes/canvas
                                                 └─ mode 'api' ─ [upload ảnh mẫu] → chat-requirements + PoW
                                                                 → POST /backend-api/conversation (không tạm)
                                                                 → asset_pointer trong SSE, hoặc poll GET conversation 4 s
                                                                 → files/download → PATCH is_visible:false
```

## 2. Dùng nhanh

```js
const { createChatGptImage } = require('./src/providers/chatgpt-image');
const gpt = createChatGptImage({ profileDir: 'D:/profiles/gpt-1', mode: 'ui', log: console.log });
console.log(await gpt.status());                       // {connected, email, plan} | {connected:false, reason}
const { buffer, contentType } = await gpt.generateImage({
  prompt: 'A red fox standing in fresh snow at dawn, cinematic lighting',
  aspect: '16:9',
  refs: [{ path: 'char.png' }],                        // hoặc { b64, mime }
  timeoutMs: 240000,
  // mode: 'api', onWait: (s) => …, model: 'auto', keepConversation: false   ← chỉ cho api
});
gpt.close();                                           // ngắt CDP; Chrome vẫn chạy
```
`rawPrompt:true` = gửi nguyên văn; `allowText:true` (ui) = bỏ câu "No captions, no watermark".
Lần đầu: `createChatGptImage({ profileDir, show: true }).status()` → người dùng tự đăng nhập → đóng.

## 3. Đăng nhập, cookie, profile

- 1 profile = 1 tài khoản; đăng nhập tay một lần. [A][M]
- `GET /api/auth/session` → `{user:{email}, accessToken:"<JWT>", account:{planType}, error?}`. [A][M]
  - **`error:"RefreshAccessTokenError"`** = phiên chết nhưng vẫn trả accessToken CŨ; mọi `/backend-api/*` → `401 token_expired`. Code kiểm `error` + `exp` của JWT. [A][Đo]
  - Cloudflare trả **403** cho `/api/auth/session` khi bị gọi nhiều lần trong một giây (bảng trạng thái hỏi liên tục) — tài khoản vẫn tốt. Đừng coi một lần 403 là đăng xuất: làm nóng trang rồi hỏi lại. [M][Đo] (Repo: 403 → kiểm DOM ô nhập/nút đăng nhập.)
- Cookie phiên `__Secure-next-auth.session-token` **có thể chia khúc `.0/.1`** → regex `^__Secure-next-auth\.session-token(\.\d+)?$`; `csrf-token` có cả khi đăng xuất. [A][M]
- Nếu buộc phải chép cookie sang trình duyệt/Electron khác: **KHÔNG chép `cf_clearance`, `__cf_bm`, `_cfuvid`** — chúng gắn với trình duyệt đã nhận; chép sang nơi khác thì mọi request thành trang thử thách 403. Chỉ giữ `next-auth.(session-token|csrf-token|callback-url)` + `oai-did`, rồi tải chatgpt.com để nơi mới tự lấy cookie Cloudflare. [M] (bản [A] cũ có chép → khác biệt.)
- Một phiên dùng ở hai nơi: refresh token xoay vòng, bên sau thắng. [A][Đo] → Repo chạy trong chính Chrome của profile.
- UA phải khớp trình duyệt gửi request (sec-ch-ua, TLS). [M] Trong Repo tự khớp vì request đi từ trang.

## 4. Chế độ UI — nhận diện ảnh MỚI (dễ sai nhất)

1. **Chat mới mỗi job** (`https://chatgpt.com/`), không dùng `/images` (thư viện ảnh cũ). [A][Đo]
2. **Baseline** khoá mọi ảnh trên trang trước khi gửi; chỉ nhận khoá mới. [A]
3. **Khoá = tham số `id`** của URL (`/backend-api/estuary/content?id=file_<...>&sig=<...>`); không có `id` thì URL bỏ query. [A]
4. **Loại ảnh trong lượt user** (ảnh mẫu đính kèm): `[data-message-author-role='user'], [data-turn='user'], [class*='user-message'], [data-chatgpt-search-unit-key$=':user'], form`. Từ 10/2026 một số tài khoản **mất `data-message-author-role`** → ảnh mẫu bị lấy làm kết quả. [A][Đo] (`[data-turn=…]`: [Suy])
5. Có `[data-testid*='generated-image']` thì chỉ tin vùng đó. [A]
6. Bỏ ảnh < 128 px, avatar/icon/logo; nhận khi `naturalWidth ≥ 256`, `complete`, **cùng src qua 2 lần poll**, hết nút Stop. [A]
7. **Regex trong chuỗi JS gửi vào trang phải escape `/`** — thiếu = SyntaxError trong trang = không bao giờ thấy ảnh. [A][Đo]
8. Tải bằng `fetch(src)` trong trang (`pullBytes`); src cuối có thể chưa sẵn → đọc lại theo id, thử 6 × 2,5 s; cuối cùng `<canvas>`. Kiểm magic PNG/JPEG/WEBP ≥ 4 KB. [A]

### Đính ảnh mẫu (UI)
- [A] chạy thật bằng cách: chép base64 vào trang → `new File` → `DataTransfer` → gán `input.files` + phát `input`/`change`.
- Repo: thử **`DOM.setFileInputFiles` trước** (core `setFileInput`; cần thiết cho muse.ai), **không thấy trong ô soạn → dự phòng DataTransfer**. Mỗi file phải làm **tăng số dấu hiệu đính kèm** trong form ô soạn (`img`, `[data-testid*=attachment]`, `[data-testid*=file-tile]`, nút "Remove") trong 15 s; không thì `CHATGPT_ATTACH` và **không gửi prompt** (tránh tốn lượt). [Repo][Suy: bộ dấu hiệu]
- Gửi: chờ nút Send hết `disabled` (ảnh đang upload) tối đa 60 s rồi Enter; Enter không ăn → bấm nút. [A][Repo]

## 5. Chế độ API — giao thức

Header chung (request chạy trong trang): `accept: application/json`, `content-type: application/json`, `authorization: Bearer <accessToken>`, `oai-device-id` (bắt từ request của trang hoặc cookie `oai-did`), `oai-client-version` (bắt qua `Network.requestWillBeSent`), `oai-language`. [M][A]

1. `POST /backend-api/sentinel/chat-requirements` `{"p":"gAAAAAC<base64 cấu hình trình duyệt>"}` → `{token, proofofwork:{required, seed, difficulty}, turnstile:{required}}`. [A][M]
2. PoW **chỉ khi `proofofwork.required`**: tìm n ≤ 500 000 để `sha3_512_hex(seed + base64(cfg[3]=n))[:len(difficulty)] <= difficulty` → `gAAAAAB…`; không tìm được thì lỗi (bản [A] gửi chuỗi dự phòng, server thường từ chối). [M]
   - **Electron main không có sha3-512** (BoringSSL) → [M] dùng thư viện JS; Repo có Keccak JS riêng (khớp 300/300 với `node:crypto`, ~5 µs/lần). [M][Repo]
3. `POST /backend-api/conversation`, header thêm `accept: text/event-stream`, `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`. Body: `action:"next"`, `messages:[…]`, `parent_message_id:"client-created-root"`, `model:"auto"`, `timezone_offset_min:<offset thật>`, **`history_and_training_disabled:false`** (ảnh: phải đọc lại được hội thoại), **`supports_buffering:false`**. [M]
   - Turnstile: [M] không gửi, vẫn chạy (13/10/2026). [A] thấy `turnstile.required` + web dùng `/backend-api/f/conversation` + `x-conduit-token` (15/10/2026). Repo: nếu `turnstile.required` và POST lỗi 4xx → `CHATGPT_SENTINEL` → dùng `ui`. [Suy]
4. Prompt [M] (đã chạy): `Generate exactly ONE image, wide landscape 16:9 aspect ratio. Do not ask questions, just create it.\n\n<mô tả>`. Công cụ vẽ 1024², 1536×1024 hoặc 1024×1536 → 16:9/9:16 ra khổ ngang/dọc gần nhất. [M]
5. Ảnh: `"asset_pointer":"file-service://…"` hoặc **`sediment://…`** (mới hơn) trong SSE; thường SSE kết thúc **trước** khi có ảnh → poll `GET /backend-api/conversation/{id}` mỗi 4 s, tối đa 300 s (404 ngay sau POST = chưa lưu, chờ tiếp). [M][A]
   - Chỉ nhận pointer của tin **`author.role:"tool"`, `status:"finished_successfully"`**, trong lượt hiện tại (đi ngược tới tin user thì dừng) — ảnh xem trước dở dang không `finished`. [M]
   - Lượt kết thúc không có ảnh: tin cuối là assistant `text`, `finished_successfully`, `end_turn:true` (từ chối, hết lượt, tool trả `content_type:"system_error"`, ví dụ "Instant limit" của Free) — kiểm sau ≥ 2 lần poll. [M]
6. Tải: `sediment://<id>` → `GET /backend-api/files/download/<id>?conversation_id=<cid>&inline=false`; `file-service://<id>` → `GET /backend-api/files/<id>/download` → `{download_url}` (có thể tương đối → ghép với origin). Link cùng origin cần phiên + Bearer; **link CDN không được nhận Bearer**. Ảnh < 1000 byte = lỗi. [M]
7. Dọn: `PATCH /backend-api/conversation/{id}` `{"is_visible":false}`; chat tạm thì PATCH trả 404 → khỏi gọi. [M][A]
8. Ảnh mẫu (chỉ có code [A], chưa xác nhận chạy): `POST /backend-api/files` `{file_name, file_size, use_case:"multimodal", timezone_offset_min, reset_rate_limits:false}` → `{upload_url, file_id}` → `PUT upload_url` (Azure blob, header `x-ms-blob-type: BlockBlob`, `content-type`) → `POST /backend-api/files/<file_id>/uploaded` `{}` → tin nhắn `content:{content_type:"multimodal_text", parts:[{content_type:"image_asset_pointer", asset_pointer:"file-service://<file_id>", size_bytes, width, height}, "<prompt>"]}`, `metadata.attachments:[{id,name,mimeType,width,height,size}]`. [A]

Thứ tự ánh xạ HTTP → lỗi (đã có test [M]): **429 trước** (trang 429 cũng là HTML) → `RATE_LIMIT`; 401/403 hoặc HTML với mã 2xx → `AUTH`; HTML 5xx (gateway) → `NETWORK`, không phải đăng xuất; 404 "Model not found" → gửi lại `model:"auto"` một lần.

## 6. Prompt: tốt / xấu

**Bẫy EDIT mode** [A][Đo]: các từ edit/modify/upload/attach/"reference image"/"source image"/"from scratch"/"this image" làm công cụ ảnh chuyển sang *sửa ảnh* và trả lời *"Please upload the image you want me to edit"* — kể cả khi không đính ảnh. Chính câu "Create FROM SCRATCH (there is NO source image to edit or upload)" đã gây lỗi.

| Xấu | Tốt |
|---|---|
| `Create this FROM SCRATCH (no source image to edit or upload)` | `Generate an image: …` [A] / `Generate exactly ONE image, … Do not ask questions, just create it.` [M] |
| `If the referenced character image is not attached, …` | Chỉ nhắc ảnh mẫu khi **thật sự** đính |
| Nhắc lại bằng "please edit/upload…" | `Generate a new image now that follows the description in my previous message. Reply with the image only.` [A] |

- `scrubEditTriggers()` xoá các từ đó khi không có ảnh mẫu. [Repo]
- Một ảnh mỗi tin nhắn. [A][M]
- Chữ trong ảnh: memory/custom instructions (vd. tiếng Việt) lấn câu "Write the text in en." → khối `TEXT LANGUAGE (strict): …` rõ ràng. [A][Đo]

## 7. Hạn mức & xoay vòng profile

- Hết lượt Free được báo **bằng chữ** (HTTP 200): *"You've hit the Free plan limit for image generations requests… limit resets in N hours"*, *"generating images too quickly"*, *"image creation is temporarily unavailable … limit has been reached"*. [A][M][Đo]
- `parseResetHours()`: `in 3 hours`, `in 45 minutes`, `in 1 day`, `at/after 4:30 PM`, `tomorrow`; không đọc được → `null` → mặc định 12 h. [A: mặc định 12 h][Repo: các mẫu khác chưa gặp thật]
- Hết lượt **ảnh** không có nghĩa tài khoản hỏng: vẫn viết chữ được → đừng đánh dấu profile lỗi chung. [M]
- Chiến lược (ví dụ `examples/chatgpt-batch-images.js`): LRU; `RATE_LIMIT` → đỗ profile `resetHours`(+6 phút) và trả prompt về đầu hàng; `AUTH/CLOUDFLARE` → bỏ profile lượt này; `POLICY` → bỏ prompt; lỗi khác → thử lại ≤ 3. Trạng thái đỗ lưu đĩa. [A: LRU + file đỗ][Repo]
- [M] xoay **vòng tròn** sau profile đang dùng, profile "bị cảnh báo" (lỗi hạn mức hoặc lỗi lần 3) xếp cuối; thành công thì xoá cảnh báo. Cả hai cách đều được.
- Giãn nhịp 15 s/profile. [A] Song song = nhiều profile; mỗi Chrome 300–600 MB RAM. [Suy]
- **Khoá liên tiến trình** [M][Đo 05/10]: hai tiến trình trên cùng tài khoản trộn lẫn tin nhắn. [M] dùng file khoá trong thư mục profile (`open 'wx'`, ghi `{pid, at}`, quá 20 phút hoặc pid chết = khoá cũ). Repo hiện chỉ khoá trong một tiến trình.

## 8. Mã lỗi (`ChatGptError.code`)

| Mã | Ý nghĩa | Nên làm |
|---|---|---|
| `CHATGPT_AUTH` | Chưa đăng nhập / phiên hết hạn / HTML thay JSON | Đăng nhập lại (`show:true`) |
| `CHATGPT_RATE_LIMIT` | Hết lượt (`resetHours` nếu đọc được) hoặc HTTP 429 | Đỗ profile, đổi profile |
| `CHATGPT_POLICY` | Từ chối nội dung | Sửa prompt |
| `CHATGPT_TEXT_REPLY` | Trả chữ thay vì vẽ (ui: sau 1 lần nhắc; api: lượt kết thúc không ảnh) | Xem bẫy EDIT §6 |
| `CHATGPT_TIMEOUT` | Hết thời gian không có ảnh / request bị huỷ | Thử lại |
| `CHATGPT_ATTACH` | Không đính được ảnh mẫu, prompt chưa gửi | Kiểm UI / thử `mode:'api'` |
| `CHATGPT_SENTINEL` | PoW không giải được / Turnstile bắt buộc | Dùng `mode:'ui'` |
| `CHATGPT_MODEL_NOT_FOUND` | Model không cấp cho tài khoản | `model:'auto'` hoặc provider khác |
| `CHATGPT_DOWNLOAD` | Có ảnh nhưng tải lỗi | Thử lại |
| `CHATGPT_NETWORK` / `CHATGPT_BAD_RESPONSE` | HTTP khác / phản hồi lạ | Thử lại, xem log |
| `CHATGPT_TAB_LOST` / `CHATGPT_CLOUDFLARE` / `CHATGPT_UI` / `CHATGPT_CONFIG` | Mất tab / thử thách CF / UI đổi / đầu vào sai | |

Thời gian chờ: ui 240 s/ảnh [A]; api: conversation ≤ 300 s, poll ≤ 300 s, GET 30 s, chat-requirements 45 s [M].

## 9. Các bẫy đã gặp (triệu chứng → nguyên nhân → cách tránh)

1. Chờ mãi dù ảnh đã hiện → regex trong chuỗi JS chưa escape `/` → escape + thử trong DevTools. [A]
2. Trả ảnh cũ → bắt đầu ở `/images` → chat mới + baseline. [A]
3. Ảnh tải về = ảnh mẫu đã đính → mất `data-message-author-role` → loại lượt user bằng nhiều selector. [A]
4. "Please upload the image you want me to edit" → từ khoá EDIT trong prompt (§6). [A]
5. "Không tải được dữ liệu ảnh" → tải đúng lúc ảnh xem trước bị thay → đọc lại theo id, thử nhiều lần. [A]
6. Hết lượt nhưng không nhận ra → câu thông báo mới → regex rộng + log nguyên văn. [A][M]
7. Kẹt khi người dùng đóng cửa sổ Chrome → đếm evaluate lỗi liên tiếp (8) → `TAB_LOST`. [A]
8. "Đã kết nối" mà 401 → `RefreshAccessTokenError` → kiểm `error` + `exp`. [A]
9. SSE rỗng + `resume_conversation_token` → `supports_buffering:true` → luôn `false`. [A][M]
10. Mọi request /backend-api treo (Electron) → listener `onBeforeSendHeaders` không gọi `callback`. [A][M]
11. Trang 429 bị hiểu là đăng xuất → kiểm 429 **trước** kiểm HTML. [M][test]
12. Lỗi gateway 502 (HTML) bị hiểu là đăng xuất → HTML chỉ = AUTH khi mã 2xx. [M][test]
13. Parser SSE văng TypeError → dòng `data: "v1"` là chuỗi JSON → bỏ qua sự kiện không phải object; `{v:[…]}` không có `o` là danh sách patch. [M][test]
14. Chép cookie sang Electron → mọi request 403 → không chép cookie Cloudflare. [M]
15. Hai job/hai tiến trình cùng tài khoản trộn tin → khoá theo profile (trong tiến trình: Repo; liên tiến trình: file khoá [M]).
16. Cửa sổ thu nhỏ → viewport nhỏ, trang đổi giao diện điện thoại → đặt cửa sổ ngoài màn hình (-32000) với kích thước desktop, không minimize; giả focus. [M][Đo: Muse ẩn trả lời 25 s thay vì 216 s khi có giả focus]

## 10. Checklist tích hợp

- [ ] 1 profile/tài khoản, đăng nhập tay bằng `show:true`; `status()` trước batch.
- [ ] Chọn `mode`: `ui` khi cần ảnh mẫu hoặc API đang vỡ; `api` khi không cần ảnh mẫu và muốn nhanh.
- [ ] Một instance/profile; song song = nhiều profile; nếu nhiều tiến trình dùng chung profile → thêm file khoá.
- [ ] Xử lý theo mã lỗi §8; lưu thời gian đỗ profile; hết lượt ảnh ≠ tài khoản hỏng.
- [ ] Kiểm magic bytes/kích thước ảnh trước khi dùng; log nguyên văn chữ trả lời để cập nhật regex.
- [ ] UI đổi → sửa `SEL` (`chatgpt-session.js`), `JS_IMG_LIB`/`JS_ATTACH_COUNT` (`chatgpt-image.js`).

## 11. Chưa kiểm chứng độc lập

- Toàn bộ code Repo chưa chạy với chatgpt.com thật.
- `DOM.setFileInputFiles` trên ChatGPT; bộ dấu hiệu "đã đính" (thumbnail có thể là `background-image` → không đếm được → báo `CHATGPT_ATTACH` dù đã đính).
- Upload ảnh mẫu qua files API: chỉ có code [A], chưa thấy chạy thật; PUT lên blob từ trang phụ thuộc CORS của blob (giao diện tự làm được nên [Suy] là cho phép).
- Bắt `oai-client-version` qua `Network.requestWillBeSent`: [Suy] (bản gốc bắt bằng `webRequest` của Electron).
- Turnstile: chưa có cách giải; chỉ biết [M] bỏ qua vẫn chạy tới 13/10/2026.
- Selector `[data-turn=…]`, URL `estuary/content?id=`, `parseResetHours` cho "at 4:30 PM"/"in 1 day".
- Không tìm thấy code upload ảnh lên **Gemini** ở cả hai bản gốc.
