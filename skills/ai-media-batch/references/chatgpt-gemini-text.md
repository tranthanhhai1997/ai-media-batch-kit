# ChatGPT & Gemini — hỏi text bằng tài khoản web (viết/viết lại prompt hàng loạt)

> **Chạy thật 22/10/2026:** ChatGPT text (`auto` → api, sentinel + PoW) 5 s; Gemini text 5 s — cả hai trả đúng.

> Mã: `src/providers/chatgpt-text.js` (+ `chatgpt-session.js`, `chatgpt-backend.js`, `chatgpt-pow.js`), `src/providers/gemini-text.js`.
>
> **Nhãn nguồn:** **[A]** bản gốc thứ nhất (app video; Electron `session.fetch`, chạy thật 09–10/2026) ·
> **[M]** bản gốc thứ hai (app nhạc; Electron `session.fetch`, unit test Vitest, dùng hằng ngày để viết lời) ·
> **[Đo]** quan sát/số đo thật trong nhật ký dự án · **[Suy]** suy luận · **[Repo]** code repo này — **mới qua `node --check` + test offline parser/PoW (đã chạy lại các fixture test của [M]), chưa gọi dịch vụ thật.**

Dùng khi cần AI viết kịch bản, sinh/viết lại hàng trăm prompt mà **không có API key**. Có API key thì dùng API chính thức.

## 1. Chọn đường

| Cách | Ưu | Nhược | Repo |
|---|---|---|---|
| A. Gõ vào UI chatgpt.com rồi đọc | Trang tự lo sentinel/PoW/Turnstile | Chậm hơn vài giây; phụ thuộc selector | ChatGPT `mode:'ui'` |
| B. `/backend-api/conversation` (sentinel + PoW) | Nhanh; [A][M] chạy thật | Vỡ khi OpenAI đổi (Turnstile, conduit) | ChatGPT `mode:'api'` — **fetch trong tab**, PoW ở Node |
| C. StreamGenerate của gemini.google.com | Không cần PoW | Payload mảng lồng nhau không tài liệu | Gemini — **fetch trong tab** |

ChatGPT mặc định `mode:'auto'` = B, nếu lỗi `CHATGPT_SENTINEL / BAD_RESPONSE / EMPTY` (và không phải hội thoại nối tiếp) thì tự chuyển A. [Repo]

Khác với hai bản gốc: [A][M] gọi bằng `session.fetch` của Electron với cookie chép từ profile + cửa sổ ẩn "warm" để làm mới cookie. Repo gọi **ngay trong tab Chrome của profile** → không chép cookie, Chrome tự xoay `__Secure-1PSIDTS`/Cloudflare. [Repo]

```
ChatGPT api: lock(profile) → tab chatgpt.com → chat-requirements → PoW (Node) → POST conversation (SSE, trong trang)
             → parse SSE → [rỗng & không tạm: poll GET conversation ≤ 90 s] → [không tạm: PATCH is_visible:false]
ChatGPT ui:  lock → chat mới → gõ (Shift+Enter giữa dòng) → Enter → chờ hết nút Stop + chữ ổn định 3 s
             → GET /backend-api/conversation/{id} trong trang (markdown chuẩn) | innerText → ẩn hội thoại
Gemini:      lock → tab gemini.google.com/app → WIZ_global_data (SNlM0e, cfb2h, FdrFJe) → POST StreamGenerate trong trang
             → parse payload[4][0][1][0] → (mặc định) xoá hội thoại GzXR5e
```

## 2. Dùng nhanh

```js
const { createChatGptText, extractJson } = require('./src/providers/chatgpt-text');
const { createGeminiText } = require('./src/providers/gemini-text');
const gpt = createChatGptText({ profileDir: 'D:/profiles/gpt-1', mode: 'auto' });
const gem = createGeminiText({ profileDir: 'D:/profiles/google-1' });

const list = extractJson(await gpt.ask({ prompt: 'Rewrite into 3 cinematic image prompts. Answer in text only, JSON array of strings:\n- a cat on a roof' }));
const g = await gem.ask({ prompt: 'Viết 5 prompt ảnh về mùa thu Hà Nội, mỗi dòng một prompt' });

// nhiều lượt
const r1 = await gpt.askDetailed({ prompt: 'Remember 7.', mode: 'api' });          // {text, conversationId, parentMessageId, source}
const r2 = await gpt.askDetailed({ prompt: 'Which number?', mode: 'api', conversation: { conversationId: r1.conversationId, parentMessageId: r1.parentMessageId } });
const g1 = await gem.askDetailed({ prompt: 'Nhớ số 7.' });                        // giữ hội thoại
const g2 = await gem.askDetailed({ prompt: 'Số vừa rồi?', conversation: g1.conversation });
```
ChatGPT: `temporary` (api mặc định `true` = `history_and_training_disabled`, không đọc lại được; ui mặc định `false`), `keepConversation`, `model` (api, mặc định `auto`), `timeoutMs`.
Gemini: `lang` (mặc định `en`), `modelHeader` (§5), `keepConversation`.

**Batch:** mỗi profile tuần tự (khoá), song song = nhiều profile; `src/core/queue.js` `runBatch` với `classify`: `*_RATE_LIMIT` → cooldown; `*_TIMEOUT|*_TAB_LOST|GEMINI_OVERLOAD|*_EMPTY|*_NETWORK` → retry; `*_AUTH` → bỏ worker; `CHATGPT_POLICY` → fail.
**Fallback chéo** [A][M]: ChatGPT lỗi (AUTH, MODEL_NOT_FOUND, mạng, rỗng) → Gemini, nhớ "hỏng" ~10 phút [A]; [M] xếp AI đang lỗi xuống cuối danh sách.

## 3. Đăng nhập & phiên

ChatGPT: xem `chatgpt-image.md` §3 (RefreshAccessTokenError, cookie chia khúc, 403 Cloudflare khi hỏi dồn, không chép cookie Cloudflare).

Gemini:
- Đăng nhập Google trong profile (dùng lại profile Flow/Veo được). Đã đăng nhập ⇔ có cookie `__Secure-1PSID` **và** `/app` chứa `SNlM0e`. [A][M]
- `/app` chỉ trả `SNlM0e` khi `__Secure-1PSIDTS` còn tươi; cookie này chỉ được xoay khi có trang Google đang mở. Hỏi lúc "nguội" = trông như chưa đăng nhập dù tài khoản tốt → **làm nóng (mở /app) rồi hỏi lại, vẫn không được thì tải lại trang một lần**. [M][Đo] Repo: đợi SNlM0e tối đa 20 s, 400/401 → tải lại /app + gửi lại một lần.
- Cookie đọc từ đĩa ngay sau khi bật Chrome là bản cũ (`/app` 200 nhưng không có SNlM0e). [A][Đo]
- Chép profile sang máy khác không giữ được đăng nhập Google. [A][Đo] Bản sao cookie chết sau một thời gian khi Chrome gốc xoay PSIDTS. [A][Đo]
- `__Secure-1PSIDRTS` (DBSC) không cần. [A]

## 4. ChatGPT backend-api — chi tiết (mode 'api')

Header (trong trang): `authorization: Bearer <accessToken>`, `content-type/accept: application/json`, `oai-device-id`, `oai-client-version`, `oai-language`. [A][M]

1. `GET /api/auth/session` → accessToken (JWT ~10 ngày [A][Đo]). [M] cache token 5 phút; Repo cache **trong trang** 5 phút.
2. `POST /backend-api/sentinel/chat-requirements` `{"p":"gAAAAAC"+base64(JSON([rand 3000–6000, ngày giờ, 4294705152, 0, UA, "en-US","en",401,"mediaSession","location","scrollX", số thực, uuid, "",12,1700000000000]))}` → `{token, proofofwork:{required,seed,difficulty}, turnstile:{required}}`. Không phải JSON → `BAD_RESPONSE` [M][test].
3. PoW chỉ khi `required` [M]: cfg = `[pick(8,12,16,24)+pick(3000,4000,6000), ngày giờ lùi 8 h, 4294705152, n, UA]`; tìm n ≤ 500 000 với `sha3_512_hex(seed + base64(JSON(cfg)))` có tiền tố ≤ `difficulty` → `"gAAAAAB"+base64`. Electron main không có sha3-512 → JS; Node ≥ 22 có sẵn. [M][Repo]
4. `POST /backend-api/conversation`, header thêm `accept: text/event-stream`, `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`. Body:
   ```json
   { "action":"next",
     "messages":[{ "id":"<uuid>", "author":{"role":"user"}, "create_time":<sec>,
                   "content":{"content_type":"text","parts":["<prompt>"]}, "metadata":{} }],
     "parent_message_id":"client-created-root", "model":"auto",
     "timezone_offset_min":<new Date().getTimezoneOffset()>, "suggestions":[],
     "history_and_training_disabled":true, "conversation_mode":{"kind":"primary_assistant"},
     "supports_buffering":false }
   ```
   Nối tiếp: thêm `conversation_id`, `parent_message_id` = id tin assistant trước. [A][M] ([A] dùng `timezone_offset_min:-420` cố định.)
   10/2026 web chuyển sang `/backend-api/f/conversation` + `OpenAI-Sentinel-Turnstile-Token`, `x-conduit-token`, `x-oai-mcp-form-version` [A][Đo 15/10]; [M] vẫn chạy đường cũ không Turnstile (13/10). Chưa ai tái hiện Turnstile.
5. SSE: dòng `data: …`, bỏ `[DONE]`. [M][test]
   - Đầy đủ: `{conversation_id, message:{id, author:{role:"assistant"}, content:{parts}}}` (bỏ tin user/system/tool).
   - Delta v1: `data: "v1"` (chuỗi — bỏ qua, đừng `'o' in ev`); `{p:"/message/content/parts/0", o:"append"|"replace", v}`; `{o:"patch", v:[ops]}`; **`{v:[ops]}` không có `o` = danh sách patch** (kế thừa `o`); `{v:"chữ"}` = nối vào part cuối; `{p:"", o:"add", v:{message, conversation_id}}`.
   - `type:"resume_conversation_token"|"stream_handoff"` + parts `[""]` = chữ đi kênh khác (khi `supports_buffering:true`). [A][Đo]
   - Marker `"turn_use_case":"image gen"`, `"skipped_mainline":true`, `"image_gen_title"` = router chuyển sang vẽ ảnh → không có chữ; thêm "Answer in text only". [A]
6. `GET /backend-api/conversation/{id}` → `{mapping:{id:{parent, message:{author, content:{content_type, parts}, status, end_turn}}}, current_node}`; đi ngược `parent` từ `current_node`, **dừng ở tin user**, lấy `content_type:"text"`. Chat tạm → 404. [A][M]
7. `PATCH /backend-api/conversation/{id}` `{"is_visible":false}`; chat tạm → bỏ qua (404). [M]
8. `GET /backend-api/models` → `{models:[{slug,title}], default_model_slug}`; [M] chọn model viết nhanh nhất: `gpt-N` cao nhất, bỏ mini/nano/thinking/pro/research/image/audio/realtime.

Mã HTTP [M][test]: **429 trước** → RATE_LIMIT; 401/403 hoặc HTML với 2xx → AUTH; HTML 5xx → NETWORK; lỗi mạng ở sentinel → lỗi có mã (để fallback được); 404 `{"detail":"Model not found"}` → thử lại `model:"auto"` [A]; 15/10/2026 lỗi này xảy ra cho **mọi** model của tài khoản Free, cả trên web → chuyển Gemini [A][Đo].

Thời gian [M]: status 20 s, sentinel 45 s, conversation 240 s. [A][Đo]: chat-requirements ~0,4 s, header conversation ~2 s, stream 6–12 s; SSE thô 60–270 KB cho 2–9 nghìn ký tự.

## 5. Gemini StreamGenerate

- Token từ `/app` (`window.WIZ_global_data` hoặc regex HTML): `SNlM0e` → form `at`; `cfb2h` → query `bl`; `FdrFJe` → `f.sid`. [A][M]
- `POST https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=<bl>&f.sid=<fsid>&hl=en&_reqid=<6 chữ số>&rt=c`; header `content-type: application/x-www-form-urlencoded;charset=UTF-8`, `x-same-domain: 1`, tuỳ chọn `x-goog-ext-525001261-jspb: <giá trị chọn model>`; body `f.req=<…>&at=<SNlM0e>`. [A][M]
  ```
  f.req = JSON([null, JSON([[prompt,0,null,null,null,null,0], ["en"], [cid,rid,rcid] | ["","",""], null,null,null,[1],0,[],[],1,0])])
  ```
- Header model: giá trị là chuỗi mờ, bắt từ DevTools; cả hai bản gốc **không có giá trị nào** → luôn dùng model mặc định của tài khoản. [A][M]
- Phản hồi: `)]}'`, rồi dòng độ dài + dòng JSON `[["wrb.fr", null, "<payload chuỗi JSON>"], …]`. [A][M]
  - **Text = `payload[4][0][1][0]`**, đôi khi **lồng thêm một lớp `[[text]]`** → lấy `[0]`. [M][test]
  - Mỗi frame mang toàn bộ text tới lúc đó → lấy frame dài nhất **trong các frame có text**. `cid=payload[1][0]`, `rid=payload[1][1]`, `rcid=payload[4][0][0]`.
  - **Frame metadata cuối stream** (`{11:[tiêu đề]}`, `{26:"token"}`, `{46:[cid,""]}`, không có `[4]`) phải bỏ qua; nếu lấy "chuỗi dài nhất bất kỳ" thì câu trả lời ngắn thua tiêu đề/token → trả về tiêu đề hội thoại hoặc `AwAAAA…`. [A][Đo]
  - Lỗi: `["…BardErrorInfo",[code]]` (thường ở `f[5]`; regex `BardErrorInfo",\s*\[(\d+)\]` trên text thô cũng được [M]). `1155` = quá tải/timeout → thử lại. [A][M]
- Xoá: `POST /_/BardChatUi/data/batchexecute?rpcids=GzXR5e&source-path=/app&bl=…&f.sid=…&hl=en&_reqid=…&rt=c`, body `f.req=[[["GzXR5e","[\"<cid>\"]",null,"generic"]]]&at=<SNlM0e>`. [A][M]
- Thời gian [M]: GET /app 25 s, StreamGenerate 240 s.
- **Upload ảnh lên Gemini: không có trong cả hai bản gốc** — chưa có tài liệu/code. [A][M]

## 6. Mã lỗi

| Mã | Ý nghĩa | Nên làm |
|---|---|---|
| `CHATGPT_AUTH` | Chưa đăng nhập / phiên hết hạn / HTML | Đăng nhập lại; tạm Gemini |
| `CHATGPT_RATE_LIMIT` | 429 / câu "limit" | Cooldown profile |
| `CHATGPT_MODEL_NOT_FOUND` | "Model not found" | `auto` / Gemini |
| `CHATGPT_SENTINEL` | PoW không giải / Turnstile bắt buộc | `mode:'ui'` (auto tự làm) |
| `CHATGPT_EMPTY` / `CHATGPT_BAD_RESPONSE` | Không có chữ / router vẽ ảnh / JSON lạ | Thử lại, "Answer in text only" |
| `CHATGPT_POLICY` | Từ chối | Sửa prompt |
| `CHATGPT_TIMEOUT` / `CHATGPT_NETWORK` | Hết giờ / HTTP khác | Thử lại |
| `CHATGPT_TAB_LOST`, `CHATGPT_UI`, `CHATGPT_CLOUDFLARE`, `CHATGPT_CONFIG` | Như `chatgpt-image.md` §8 | |
| `GEMINI_AUTH` | Không có SNlM0e sau khi tải lại / 401/403 / HTML | Đăng nhập Google (`show:true`) |
| `GEMINI_RATE_LIMIT` | 429 | Cooldown |
| `GEMINI_OVERLOAD` | 1155 | Thử lại sau 30–60 s |
| `GEMINI_ERROR` | BardErrorInfo mã khác | Log mã, thử lại |
| `GEMINI_EMPTY` | Không có frame text | Thử lại; kiểm parser |
| `GEMINI_NETWORK`, `GEMINI_TAB_LOST`, `GEMINI_CONFIG` | | |

## 7. Các bẫy đã gặp (triệu chứng → nguyên nhân → cách tránh)

1. ChatGPT trả rỗng, raw có `resume_conversation_token` → `supports_buffering:true` → gửi `false`; dự phòng GET conversation (không được với chat tạm). [A][M]
2. Mọi request treo (bước "thu thập dữ kiện" kẹt 10 %) → `webRequest.onBeforeSendHeaders` không gọi `callback` → luôn gọi; thêm timeout từng bước. [A][M]
3. "Đã kết nối" mà 401 `token_expired` → `RefreshAccessTokenError` → kiểm `error`+`exp`. [A]
4. 404 "Model not found" → slug bị gỡ hoặc sự cố OpenAI cho Free → `auto`, rồi Gemini. [A]
5. Hỏi chữ mà ChatGPT vẽ ảnh → router image gen → "Answer in text only". [A]
6. Parser SSE văng TypeError trên `data: "v1"`; mất chữ khi `{v:[…]}` không có `o` → sửa như §4.5. [M][test]
7. Trang 429/502 dạng HTML bị coi là đăng xuất → thứ tự kiểm tra §4. [M][test]
8. Gemini trả tiêu đề hội thoại / `AwAAAA…` → chỉ nhận `payload[4][0][1][0]`. [A]
9. Gemini mất chữ với dạng `[[text]]` → lấy `[0]` khi là mảng. [M][test]
10. Gemini "chưa đăng nhập" ngay sau khi mở app → phiên nguội → làm nóng, hỏi lại, tải lại một lần. [M]
11. Gemini chạy ~1 giờ rồi hỏng (bản sao cookie) → chạy trong tab profile. [A]
12. Câu trả lời ChatGPT mất định dạng / dính "Copy code" (ui) → đọc qua GET conversation. [Repo]
13. Prompt nhiều dòng bị gửi giữa chừng (ui) → xuống dòng bằng Shift+Enter. [Repo]
14. Lịch sử ngập hội thoại batch → ẩn (ChatGPT) / xoá (Gemini) sau mỗi lượt; chat tạm thì khỏi ẩn. [A][M]
15. Lỗi lần đầu bị tính là profile hỏng → chỉ cảnh báo profile khi lỗi hạn mức hoặc lỗi lần 3; thành công thì xoá cảnh báo. [M][test]

## 8. Checklist tích hợp

- [ ] Profile riêng ChatGPT / Google; `status()` trước batch.
- [ ] ChatGPT `mode:'auto'`; khi OpenAI bật Turnstile, `api` sẽ lỗi → `ui` vẫn chạy.
- [ ] Một instance/profile; song song = nhiều profile; nhiều tiến trình → file khoá.
- [ ] Yêu cầu JSON + `extractJson()`, validate, sai thì hỏi lại 1 lần.
- [ ] Fallback ChatGPT ↔ Gemini, nhớ "hỏng" ~10 phút.
- [ ] Log raw khi parser rỗng.

## 9. Chưa kiểm chứng độc lập

- Code Repo chưa gọi dịch vụ thật; điểm khác lớn nhất so với hai bản gốc: request chạy **trong tab** thay vì Electron `session.fetch` (cùng endpoint/payload). [Suy] tương đương hoặc tốt hơn vì header/cookie đúng của trình duyệt.
- Bắt `oai-client-version` bằng CDP `Network.requestWillBeSent` [Suy]; thiếu header này [M] vẫn chạy (chỉ gửi khi bắt được).
- ui: `Input.insertText` với prompt rất dài; điều kiện "xong" (hết Stop + chữ ổn định 3 s) có thể sớm với model Thinking.
- `/backend-api/f/conversation` + Turnstile/conduit: chưa tái hiện.
- Gemini: header chọn model; rpc `GzXR5e`; vị trí BardErrorInfo.
