# Google Flow (Veo 3 / Omni / Nano Banana) — tạo ảnh + video hàng loạt bằng CDP

> **Chạy thật 22/10/2026 (tài khoản PRO):** `getCredits`, ảnh Nano Banana 2.1 (0 credit, 30 s, JPEG 1376×768), text→video và ảnh→video Veo 3.1 Lite (10 credit, ~65 s, 1280×720 8 s) đều đạt.
> Sửa khi chạy: nút cài đặt ô soạn là `aria-label="Settings trigger"`; thanh trên cũng có `"Settings"` (đừng khớp nhầm). Menu model của tài khoản PRO không có bản "Lower Priority". Xem `docs/LIVE_TEST_2026-10-22.md`.

> Mã: `src/providers/flow.js`, ví dụ `examples/flow-batch.js`.
> Nguồn: hai app production độc lập cùng lái Flow:
> - **(A)** app video — mã main-process cũ (đến 20/10/2026) + module chống treo/hết credit/chính sách; ghi chép đo thật 09–10/2026.
> - **(B)** app nhạc/MV — mã mới nhất, **cập nhật 21/10/2026 sau khi Flow đổi giao diện**, đã chạy thật (Veo Lite 8 s 1280×720).
>
> Khi (A) và (B) khác nhau, **ưu tiên (B)** (mới hơn). Mỗi sự kiện ghi nguồn: (A), (B), hoặc *(suy ra)* = đọc từ mã, chưa ai đo.
> Trạng thái bản trong repo: viết lại sạch, qua `node --check`, selector đã thử trên trang giả lập (DOM mock) — **chưa chạy với tài khoản Flow thật**.

## 1. Bức tranh chung

- Flow ở `https://flow.google.com/` (trước đây `labs.google/fx/tools/flow`). Đăng nhập bằng tài khoản Google; gói AI Pro/Ultra có credit tháng. (A)(B)
- **Không còn API dùng được.** Flow viết lại thành app Angular: `/fx/api/auth/session`, `/fx/api/trpc/*` trả HTML, `__NEXT_DATA__` biến mất → đường cũ `aisandbox-pa.googleapis.com` + Bearer token + reCAPTCHA **đã chết**. (B đo; A ghi trong mã "đường fetch đã chết với build Flow mới")
- Đường sống duy nhất: **lái giao diện trong Chrome thật** + đọc lưu lượng/RPC của chính trang. (A)(B)

```
createFlowClient({profileDir})
   │ ensureProfileChrome (core) ── Chrome --user-data-dir=<profile> --remote-debugging-port
   ▼
 tab https://flow.google.com/project/<projectId>
   │ 1. chờ composer + nút Cài đặt vẽ xong
   │ 2. Ctrl+A xoá ô soạn  (TRƯỚC khi đính ảnh)
   │ 3. Cài đặt (overlay): Video · Khung hình|Thành phần · 16:9|9:16 · x1 · model
   │ 4. đính ảnh: + → Tải nội dung lên → file chooser (CDP) → chip trong ô soạn
   │ 5. Input.insertText prompt → kiểm tra chữ đã vào
   │ 6. chụp lưới ô (snapshot) + số thẻ "Không thành công" + bật nghe Network
   │ 7. bấm Tạo MỘT LẦN
   ▼
 kết quả:  (a) media id từ RPC MZZa6b/jwpduf → poll batchexecute as29s → URL ký /video/<id>
           (b) dự phòng: ô MỚI trên lưới → mở /project/<p>/edit/<id> → có nút share|keyboard_return = kết quả
   ▼
 tải:      URL ký qua Network.loadNetworkResource  →  nếu 403/CORS: ⋮ → Tải xuống → "Kích thước gốc"
           + móc URL.createObjectURL để giữ Blob → rút bytes base64 theo khúc
```

## 2. Dùng nhanh

```js
const { createFlowClient } = require('./src/providers/flow');
const flow = createFlowClient({ profileDir: 'D:/profiles/flow-1', show: true });
console.log(await flow.status());      // { loggedIn, email, url, projectId }
console.log(await flow.getCredits());  // { credits, tier, email }
const [img] = await flow.generateImages({ prompt: 'a red apple', aspect: '16:9', model: 'nano_banana' });
await flow.download(img, 'out/apple.png');
// cách an toàn (B): tạo → chờ → tải trong MỘT job giữ tab
const r = await flow.makeVideo({ prompt: 'slow push-in', startImage: 'out/apple.png', model: 'veo3_lite', aspect: '16:9' }, 'out/apple.mp4');
// tách bước (nâng cao): const op = await flow.generateVideo({...}); const done = await flow.waitVideo(op); await flow.download(done, 'x.mp4');
```

Lần đầu mỗi tài khoản: `node examples/flow-batch.js --login <profileDir>` → đăng nhập Google, mở 1 project, đóng cửa sổ.

## 3. Đăng nhập & profile

- 1 profile Chrome (`--user-data-dir`) = 1 tài khoản Google. Đăng nhập tay 1 lần; cookie dùng lại. (A)(B)
- **Kiểm tra đăng nhập đáng tin nhất:** `location.pathname === '/about'` = chưa đăng nhập (Flow đẩy khách vào /about). (B; A đo 01/10)
- Token trang cho batchexecute: `window.WIZ_global_data.SNlM0e`; email: `WIZ_global_data.oPEP7c`. Không có SNlM0e = chưa đăng nhập hoặc Flow đổi. (A)(B)
- (A) còn kiểm cookie `__Secure-1PSID` / `__Secure-3PSID` / `SID` qua `Network.getCookies` — chỉ là phụ.
- **Profile bị xoá/copy sang máy khác = mất đăng nhập** (khoá thiết bị Google không đi theo): mở ra sẽ về `/about`. Phải đăng nhập lại từng profile. (A đo 01/10)
- Cửa sổ: **không headless, không thu nhỏ**. Ẩn thì đặt ngoài màn hình (`--window-position=-32000,-32000`) ở cỡ desktop 1440×900 + giả focus (`keepAlive`). Thu nhỏ → viewport bé → Flow chuyển giao diện điện thoại, picker che composer. (B đo) Tab ẩn lúc bấm Tạo → điểm hành vi gửi Google = 0. (A, ghi trong mã)

## 4. Project

- Flow chỉ sinh nội dung **trong project**; id lấy từ URL `/project/<uuid>`. (A)(B)
- Tạo project: (A) RPC `jHPbke` payload `["projects/*",[null,["<tiêu đề>"]],[null,22]]` → uuid trong response; dự phòng (B) bấm nút "Dự án mới"/"New project" hoặc mở project đầu tiên trong danh sách. Project miễn phí (chỉ là thư mục). (B)
- Project chết → `flow.google.com/404` → tạo cái mới. (A)
- URL đổi sang `/project/` **trước** khi trang vẽ xong — phải chờ có cả ô soạn **và** nút Cài đặt (tới ~30 s). (B đo 21/10: thiếu bước này cả 6 profile báo "không có composer" trong vài giây)
- Trang clip `/project/<p>/edit/<id>` cũng có ô ProseMirror ("mô tả cách sửa video") nhưng **không tạo clip** → luôn quay về `/project/<p>`. (B)

## 5. Giao diện composer (đổi 21/10/2026)

| Việc | Cách tìm (B, 21/10) | Dự phòng (A, trước 21/10) |
|---|---|---|
| Ô prompt | `flow-rich-text-editor .ProseMirror`, `.ProseMirror[contenteditable=true]` | `div[role=textbox][contenteditable]`, … (bỏ qua `textarea[name=g-recaptcha-response]`) |
| Nút Tạo | `button[aria-label="Bắt đầu tạo"]` hoặc nút `arrow_forward` trong composer, chỉ khi **không disabled** | `flow-generate-icon-button button`, `button[type=submit]` |
| Nút Cài đặt | `button` có aria-label chứa "cài đặt" hoặc class `settings-…` | nút dưới đáy có chữ `crop_16_9`/`Video ·` |
| Bảng cài đặt | `.cdk-overlay-container [role=radio]`, khớp **dòng chữ cuối**: `Video`, `Hình ảnh`, `Khung hình`/`Frames`, `Thành phần`/`Ingredients`, `16:9`, `9:16`, `x1`, `720p`; đã chọn = `aria-checked="true"` | radio inline nhận theo icon `videocam`/`image`/`crop_free`/`chrome_extension`/`crop_9_16` |
| Model | nút trong overlay có `arrow_drop_down` → `[role=menuitem]` | `button[aria-haspopup=menu]` aria-label "Chọn mô hình…" |
| Giá lượt | chữ `(\d+) tín dụng|credits` trong overlay | — |
| Nút "+" đính kèm | aria-label bắt đầu "Thêm thành phần" | nút `add`/`add_2` trong `flow-prompt-box` |
| Hết credit | nút có aria-label chứa "không đủ tín dụng"/"not enough credit" thay chỗ nút Tạo | toast "insufficient credits"/"Add AI credits" (A) |

- Giao diện có **tiếng Việt và tiếng Anh** tuỳ tài khoản → luôn khớp cả hai, ưu tiên icon (ligature Material) vì không đổi theo ngôn ngữ. Chữ trên trang có thể ở dạng **NFD** → `normalize('NFC')` trước khi so. (A)(B)
- Click: radio cài đặt nhận `el.click()` (B); **menu item / nút tải lên bỏ qua `el.click()`** → dùng `Input.dispatchMouseEvent` thật (B). Bản repo dùng chuột thật cho mọi thứ.
- Gõ chữ: **chỉ `Input.insertText`** qua CDP; `execCommand`/gán `textContent` bị editor Angular bỏ qua. (A)(B)
- Đóng popover cài đặt bằng cách **focus lại ô soạn**, không click ra trang (click rơi vào nút Cài đặt → huỷ lựa chọn; B đo: clip vẫn ra 9:16). (B)
- Nút Cài đặt là **toggle**: popover đang mở mà bấm lại sẽ đóng nó. Kiểm tra trước, chỉ bấm khi chưa thấy radio. (B)
- Tắt chế độ "Tác nhân/Agent" (chat agent) nếu đang bật (`aria-pressed="true"`). (A)

## 6. Thiết lập phải "ghim" mỗi lượt

Flow **nhớ lựa chọn lần trước**; project mới mặc định **Hình ảnh · Nano Banana · x2** (tạo video sẽ thành 2 ảnh và tốn tiền ảnh). (B)
Thứ tự: loại (Video/Hình ảnh) → chế độ (Khung hình/Thành phần, các hàng khác đổi theo) → tỉ lệ → x1 → model → (720p chỉ có khi model là Omni) → đọc giá. (B)

- **Text→video:** Video · **Khung hình** · tỉ lệ · x1 · Veo. (B đo 21/10)
- **Ảnh→video:** (A) đính ảnh làm **Thành phần** (ingredient = ảnh tham chiếu, không phải khung đầu chính xác), clip 8 s. Đây là đường (A) chạy production; (B) dùng Thành phần + Omni cho hát nhép.
- **Khung đầu/cuối chính xác** (chế độ Khung hình, ô "Bắt đầu"/"Kết thúc"): có trên UI nhưng **chưa ai tự động hoá ổn định** → bản repo báo lỗi nếu truyền `endImage`. *(suy ra)*
- Thời lượng: Veo/Omni thường 4/6/8/10 s; khi có Thành phần là video thì ô thời lượng biến mất, clip theo độ dài video vào; Thành phần ảnh → 8 s. (B đo 05/10; A trong mã) (B) còn thêm "(8 giây)" vào cuối prompt.
- Tỉ lệ: video chỉ có 16:9 / 9:16 (không 1:1). (B)

### Model & chi phí (credit / clip 8 s, x1)

| Khoá trong repo | Nhãn menu Flow | Credit | Nguồn |
|---|---|---|---|
| `veo3_lite` | Veo 3.1 - Lite | 10 | (B đo 21/10) |
| `veo3_fast` | Veo 3.1 - Fast | 20 | (A 14/10, B 21/10) |
| `veo3_quality` | Veo 3.1 - Quality | 100 | (A)(B) — (B) **không bao giờ** tự chọn |
| `veo3_lite_low` | Veo 3.1 - Lite [Lower Priority] | 0 | (A) |
| `omni` | Omni 1.1 Flash (model mặc định của Flow) | ~12–20 | (B 02/10: 12; 05/10: ~20 khi 720p + thành phần) |
| ảnh `nano_banana` / `_pro` / `_lite` | 🍌 Nano Banana 2 / Pro / 2 Lite | chưa đo | (A) |

- Model không có trong gói tài khoản → menu không có mục đó, Flow **giữ model đang chọn** (A). Bản repo mặc định `strictModel: true`: không chọn được model thì **không bấm Tạo** (tránh render nhầm Quality/Omni tốn tiền). (B cũng chặn: "không bao giờ gửi khi đang ở Hình ảnh/Nano Banana hay Omni" cho clip nền)
- Tài khoản để 360p → menu tải không có 720p (B đo).

## 7. Bắt kết quả

### 7a. Media id từ lưu lượng của trang (A — đến 20/10; *chưa xác nhận sau 21/10*)
Bật `Network.enable`, xoá bộ đệm ngay trước khi bấm Tạo, rồi:
- Video: response của `…/batchexecute?rpcids=MZZa6b` chứa `"<mediaId>","<uuid>","<uuid>","CA?"` → uuid đầu là clip; hoặc request `rpcids=jwpduf` (trang tự poll clip mới) có `f.req` chứa `[["<mediaId>"]]`. Hạn 150 s (A); repo nghe 30 s rồi chuyển sang 7b.
- Ảnh: response `rpcids=ogiZ0b` chứa `https://flow-content.google/image/<uuid>?…Expires=…&Signature=…` (chuỗi có `\u003d`, `\u0026` phải bỏ escape).
- **Loại trừ id cũ**: ảnh tham chiếu vừa tải lên, clip trước đó trang vẫn đang poll (jwpduf) — nếu không sẽ bắt nhầm. (A)
- "Đã nhận lệnh" = ô soạn tự xoá trắng **hoặc** thấy request generate. Ô trống sau khi bấm là **bình thường** — đừng kết luận "gõ hỏng" (B: từng báo sai "chưa tốn credit" trong khi clip đã tạo).

### 7b. Lưới project (B — chạy thật 21/10)
- Trước khi bấm: **cuộn hết lưới** (ô nạp lười) và chờ số ô đứng yên 3 nhịp → chụp danh sách `src` của `<img>` rộng ≥80 px nằm ngoài composer/overlay, **bỏ phần `?…`**. Thumbnail đã chuyển từ `flow-content.google/image/<id>` sang `flow.google.com/asb/<token>` (05/10) → dùng chính địa chỉ làm danh tính. (B)
- Thêm `src` của chip vừa đính vào danh sách loại trừ: file tải lên hiện trên lưới muộn, từng bị nhận nhầm là kết quả. (B)
- Mỗi 5 s: ô mới → click → URL thành `/edit/<id>` → trang có nút `share` hoặc `keyboard_return` ("dùng lại prompt") = kết quả do Flow tạo; không có = file tải lên → bỏ qua, quay lại lưới. (B)

### 7c. Poll trạng thái (A)
- `POST /_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=<pathname>&_reqid=<rand>&rt=c`, body form `f.req=[[["as29s","[\"<mediaId>\"]",null,"generic"]]]&at=<SNlM0e>`, gọi bằng `fetch` **trong trang** (credentials include).
- Xong = response có URL **ký** `flow-content.google/video/<mediaId>?…Signature=…`. Đang render = có bản ghi nhưng chưa có URL ký.
- Response dạng `)]}'` + các dòng JSON; mỗi phong bì `["wrb.fr","<rpcid>","<payload JSON dạng chuỗi>",null,null,<lỗi>,"generic"]`. Lỗi `[5]` = NOT_FOUND.

## 8. Tải file

1. URL ký (`Expires/Signature`) → `Network.loadNetworkResource` (dùng cookie profile, không dính CORS) → `IO.read` từng 1 MB. (A)
2. (B, 21/10) **URL `/video/` trả 403 và `fetch` trong trang bị CORS** → dùng nút Tải của Flow:
   mở `/project/<p>/edit/<id>` → (nếu không thấy nút `download` hiển thị) bấm ⋮ (aria-label "Tuỳ chọn khác"/"More options"/`more_vert`) → mục `download…` → **"Kích thước gốc"/"Original size"** (720p cho clip 720p; mục "Đã tăng độ phân giải"/upscale là nâng cấp trả phí, **không tải gì**) → trước đó đã móc `URL.createObjectURL` để giữ `Blob` video (>100 KB) → đọc `arrayBuffer` → rút base64 400 KB/khúc. Clip vừa xong chưa có nút tải: thử lại tối đa 6 vòng (6 s rồi 15 s).
   Trang còn một nút `download` ẩn 0 px → chỉ tính nút có kích thước. (B)
3. Thumbnail `asb/…` cùng origin → `fetch` trong trang được, nhưng có thể là bản thu nhỏ. *(suy ra)*
- Bản repo thử theo thứ tự 1 → 3 → 2. URL ký hết hạn sau vài giờ *(suy ra từ tham số Expires)* → tải ngay khi xong.

## 9. Credit

- Đọc nhanh, không bấm UI: batchexecute `nzlxg` payload `[]` → `[credits, tier, …]`, ví dụ `[866,1,2,2,null,866,[…]]`, ~0,3 s. (A đo 14/10). Payload `DviW9c`/`[["PINHOLE"]]` → lỗi.
- Dự phòng UI: bấm chip gói (aria-label "Account details"/"Chi tiết tài khoản" hoặc chữ PRO/ULTRA) → hộp thoại có "N Flow credits"/"N tín dụng". (A)
- REST cũ `aisandbox-pa…/v1/credits?key=…` đã bị gỡ. (A)
- Credit hết rất nhanh: ~2 clip Omni/tài khoản (B); làm mới theo tháng, mỗi tài khoản ngày riêng → (B) gác tài khoản hết credit **7 ngày**, lưu ra file để khởi động lại không mở lại từng cái.
- Chặn trước khi gửi: credit < giá đọc trong overlay (hoặc bảng §6) → `FLOW_QUOTA`. Credit không đọc được thì **không chặn**. (A)

## 10. Bảng mã lỗi (`FlowError.code`) và cách xử lý

`err.submitted === true` nghĩa là **đã bấm Tạo** → Flow có thể đã trừ tiền và vẫn trả kết quả: **không chạy lại job ở tài khoản khác** (B: pool chỉ chuyển profile khi lỗi xảy ra TRƯỚC bấm Tạo).

| Mã | Khi nào | Xử lý |
|---|---|---|
| `FLOW_AUTH` | về `/about`, thiếu SNlM0e, rpc 401/403, hộp thoại quyền tải lên chưa được trả lời (`reason:'consent'`) | tạm gác tài khoản, người dùng đăng nhập lại / trả lời hộp thoại |
| `FLOW_QUOTA` | nút "không đủ tín dụng", credit < giá, toast insufficient credits | gác tài khoản tới kỳ nạp; chuyển tài khoản khác |
| `FLOW_RATE_LIMIT` | thẻ/banner "hoạt động bất thường"/"unusual activity" tăng sau khi bấm; HTTP 429 | nghỉ **~60 s** rồi thử lại là được (A đo 14/09); ≥2 lần/15' → gác 30', ≥4 → bỏ cảnh (A 16/10) |
| `FLOW_POLICY` | as29s `[5]` 3 lượt liên tiếp (≥15 s sau gửi); số thẻ "Không thành công"/"Generation failed" tăng; `reason`: `policy`/`audio`/`failed`/`not_found` | viết lại prompt trung tính, đổi ảnh đầu/model, gửi lại **1–2 lần** |
| `FLOW_TIMEOUT` | tab im lặng >5' (đã nối lại 1 lần), quá `timeoutMs`, CDP không trả lời | mở lại Chrome profile, kiểm tra clip cũ trước khi tạo lại |
| `FLOW_RESULT_LOST` | đã bấm Tạo mà không thấy kết quả nào | **không gửi lại mù** (tốn gấp đôi); kiểm tra project bằng tay |
| `FLOW_PROJECT_DEAD` | composer không vẽ, project 404 | tạo/đổi project, thử lại (chưa gửi gì) |
| `FLOW_BAD_RESPONSE` | không thấy phần tử UI (`err.role`), upload hỏng, model không chọn được, tải không được | có `role` + chưa submit → thử tài khoản khác; còn lại báo lỗi |

## 11. Song song, xoay vòng tài khoản

- **Một job một lúc trên một profile, từ bấm Tạo tới tải xong.** Hai job chung tab cướp kết quả của nhau (B đo: job sau chờ hết 10' trong khi clip nằm sẵn trong project). → dùng `makeVideo()`.
- (A) từng cho nhiều clip render song song trên 1 tài khoản (khoá chỉ quanh bước gửi, poll as29s theo media id). Chỉ dùng `generateVideo()` + `waitVideo()` song song khi **chắc chắn bắt được media id** (7a); số clip song song tối đa mỗi tài khoản: **chưa đo**.
- Khoảng cách tối thiểu giữa 2 lần bấm Tạo cùng tài khoản: **25 s** (A, `FLOW_MIN_GAP_MS`); bị chặn thì nghỉ 60 s.
- Khoá theo tài khoản **giữa các tiến trình**: file lock trong thư mục profile (pid + thời điểm, hết hạn 20', pid chết thì gỡ) — tránh app khác/script khác lái cùng tài khoản. (B) *(repo chưa có — xem đề xuất lõi)*
- Pool (B): chọn profile ít bận nhất, ưu tiên cửa sổ đang mở, profile đang bị tiến trình khác khoá xếp cuối; lỗi trước-bấm-Tạo (`FLOW_QUOTA/AUTH/NO_WINDOW/NO_PROJECT/NO_COMPOSER/UPLOAD/CONSENT`) → chuyển profile kế. Ví dụ repo dùng `src/core/queue.js` với `classify` tương đương.
- Proxy riêng từng profile: `ensureProfileChrome({proxy})`; Chrome không nhận user/pass proxy → cần relay cục bộ. (A)

## 12. Bẫy đã gặp (triệu chứng → nguyên nhân → cách tránh)

1. Cả pool báo "không có composer" trong vài giây → URL đã là `/project/` nhưng trang chưa vẽ → chờ ô soạn **và** nút Cài đặt. (B 21/10)
2. Clip ra 720×1280 dù muốn 16:9 → Flow nhớ tỉ lệ lần trước → ghim tỉ lệ mỗi lượt và xác nhận `aria-checked`. (B)
3. Tạo "video" mà ra 2 ảnh → project mới để Hình ảnh · x2 → ghim Video + x1. (B)
4. Chọn xong tỉ lệ lại mất → đóng popover bằng click ra trang (click rơi vào nút Cài đặt) → focus ô soạn. (B)
5. Chip ảnh đính kèm biến mất → `Ctrl+A` trong ô soạn xoá luôn chip → xoá chữ **trước** khi đính. (B)
6. Upload "đứng mãi" → từ 21/10 file tự thành chip trong ô soạn, không còn hiện trong danh sách để chọn → đếm `button.chip-container` không có `chip-container-disabled`; kẹt >90 s hoặc chip lỗi → reload (tự chấp nhận hộp "Rời trang?"), gửi lại 1 lần. Upload dở ở tab cũ làm upload sau xếp hàng mãi → reload trước. (B)
7. Lần tải lên đầu tiên của tài khoản hỏi về **quyền với nội dung** ("Tôi đồng ý"/"I agree") → **không tự trả lời thay người dùng**; hiện cửa sổ, chờ tối đa 10'. (B)
8. Bắt nhầm kết quả cũ → lưới nạp lười, ô cũ hiện sau snapshot → cuộn hết + chờ số ô ổn định; loại `src` của chip. (B)
9. Cờ đánh dấu `data-…-seen` trên phần tử sống suốt đời tab → clip thứ 2 bị coi là "đã lấy" → so theo danh sách chụp ngay trước khi bấm, không mang trạng thái qua lượt. (B)
10. Bị từ chối chính sách mà app chờ ~7' → clip bị từ chối **không báo lỗi**, bản ghi biến mất (as29s `[5]`) → 3 lần `[5]` liên tiếp = bị từ chối. (A đo 29/09)
11. Viết lại prompt trung tính vẫn bị từ chối → nguyên nhân là **ảnh đầu có khuôn mặt thật chính diện**, không phải chữ → đổi ảnh / model. (A đo 29/09)
12. Prompt nhắc "khẩu hình/khớp lời" bị từ chối kiểu "chỉnh sửa lời nói" (không trừ tiền) → chỉ tả chuyển động, cảm xúc. (B)
13. Veo báo "Audio generation failed" với lời thoại rất ngắn → không phải lỗi chính sách: lượt 1 gọn lời thoại, lượt 2 bỏ thoại (clip câm). (A 13/10)
14. Bấm Tạo 2 lần khi chờ → tốn 2 clip → chỉ bấm khi nút **enabled**, sau đó tuyệt đối không bấm lại. (A)(B)
15. Hết credit mà app chờ 150–400 s rồi giữ ảnh tĩnh → đọc `nzlxg` trước khi gửi + phát hiện nút "không đủ tín dụng". (A 14/10)
16. Tab đơ/không tín hiệu → sau 5' đóng & mở lại Chrome profile, xem clip cũ đã xong chưa rồi mới tạo lại tối đa 1 lần; clip render >9' cũng coi là đứng. (A 14/10)
17. Treo vô hạn ở `grecaptcha.enterprise.ready/execute` (đường API cũ) → luôn bọc timeout. (A — chỉ còn giá trị lịch sử)
18. Banner "hoạt động bất thường" còn trên trang làm lượt sau hỏng → reload trước khi gõ; thẻ lỗi cũ trong lưới không tính (so với mốc trước khi bấm). (A)
19. Cửa sổ bé/thu nhỏ → giao diện điện thoại, picker che ô soạn → cỡ ≥1280×820, ẩn bằng toạ độ âm. (B)
20. File tạm trong `%TEMP%` không đọc được từ Chrome khi app chạy trong sandbox MSIX → để file nguồn trong thư mục dự án. (B)
21. Regex literal gửi vào trang qua template string mất dấu `\` → `/\/about/` thành comment → dựng bằng `new RegExp('…')` hoặc `RegExp#toString()` từ Node. (B)
22. `setTimeout(...).unref()` trong Electron main process không chạy → đừng `unref` timer chống treo. (A)

## 13. Checklist tích hợp

- [ ] Mỗi tài khoản 1 thư mục profile; đăng nhập tay 1 lần (`--login`), mở 1 project.
- [ ] `status()` → `loggedIn:true`; `getCredits()` đọc được số.
- [ ] Thử 1 ảnh: `generateImages` → `download`. Thử 1 clip rẻ: `makeVideo({model:'veo3_lite'})` (10 credit) hoặc `veo3_lite_low` (0).
- [ ] Log `[flow] settings …` phải cho thấy đúng `video:true frames|ingredients:true 16:9:true x1:true model:Veo… cost:N`.
- [ ] Xử lý `err.submitted` (không chuyển tài khoản sau khi đã bấm Tạo).
- [ ] Gác tài khoản `FLOW_QUOTA` lâu (B: 7 ngày, lưu file), `FLOW_RATE_LIMIT` 60 s.
- [ ] Không chạy 2 job trên cùng profile (kể cả từ tiến trình khác).
- [ ] Ghi log mỗi lượt: profile, project, media id, model thật (`modelLabel`), giá, thời gian.

## 14. Chưa kiểm chứng độc lập

- Toàn bộ `flow.js` trong repo **chưa chạy với tài khoản thật**; selector chỉ thử trên DOM giả lập theo mô tả của (A)/(B).
- Đường 7a (MZZa6b/jwpduf/ogiZ0b/as29s) sau đợt đổi giao diện 21/10: (B) không dùng nữa; (A) chưa phát hành bản sau 21/10 → có thể đã đổi id RPC. Repo coi 7a là lớp nhanh, 7b là lớp chắc.
- Tạo ảnh (Nano Banana): selector tab "Hình ảnh" và tên model theo (A) trước 21/10; (B) không tạo ảnh bằng Flow.
- `nzlxg` (credit) và `jHPbke` (tạo project) đo trước 21/10 (A).
- Chi phí Omni/ảnh, số clip render song song tối đa mỗi tài khoản, thời hạn URL ký, nhãn tiếng Anh của nút Cài đặt (repo khớp "settings").
- Khung đầu + cuối chính xác (chế độ Khung hình) chưa được tự động hoá ở cả hai nguồn.
- Đường API cũ (aisandbox-pa `v1/video:batchAsyncGenerateVideoText|StartImage|StartAndEndImage|ReferenceImages`, `uploadImage`, `batchCheckAsyncVideoGenerationStatus`, model key `veo_3_1_t2v_fast|lite|lite_low_priority`, `abra_t2v_<4|6|8|10>s` cho Omni, reCAPTCHA action `VIDEO_GENERATION`) chỉ còn giá trị tham khảo — (B) đo là đã chết.
