# Chrome profile + CDP — nền móng chung của mọi provider

> Mã: `src/core/cdp.js`, `src/core/chrome.js`, `src/core/proxy-relay.js`. Không cần Puppeteer/Playwright:
> chỉ dùng WebSocket có sẵn của Node ≥ 22 và các endpoint HTTP `/json/*` của Chrome.

## 1. Mô hình

```
1 tài khoản (Google / OpenAI / Meta / xAI)  ⇔  1 thư mục Chrome profile riêng (--user-data-dir)
                                            ⇔  1 Chrome đang chạy với --remote-debugging-port=<cổng>
                                            ⇔  1 việc tại một thời điểm (khoá theo tài khoản)
```

- Mỗi profile do **người dùng đăng nhập tay một lần**: mở `ensureProfileChrome({profileDir, url})` rồi tự đăng nhập. Sau đó tự động hoá dùng lại cookie.
- Muốn chạy song song thì thêm tài khoản/profile. Bắn nhiều yêu cầu vào một tài khoản không làm nhanh hơn (xem `src/core/queue.js`).
- Một profile có thể đăng nhập nhiều dịch vụ: một Google profile dùng được Flow + Gemini, và thường đăng nhập luôn ChatGPT/Muse/Grok.

## 2. API lõi

| Hàm | Việc |
|---|---|
| `ensureProfileChrome({profileDir, url, proxy, offscreen})` | Bật Chrome cho profile hoặc dùng lại Chrome đang chạy (đọc `.mbk-cdp-port` / `DevToolsActivePort`); trả về cổng CDP |
| `findOrOpenPage(port, urlRe, openUrl)` | Gắn vào tab khớp URL, chưa có thì mở tab mới |
| `openBackgroundTab(port, url)` | Mở tab **không cướp focus** (`Target.createTarget {background:true}`) |
| `keepAlive(client)` | Giữ tab "sống" khi cửa sổ thu nhỏ/bị che (viewport + focus + `visibilityState`) |
| `client.evaluate(js)` | `Runtime.evaluate` với `awaitPromise` + `returnByValue` + `userGesture` |
| `setFileInput(client, exprTrảVềInput, [paths])` | Đính file thật qua `DOM.setFileInputFiles` |
| `pullBytes(client, url)` | `fetch` ngay trong trang (kèm cookie, đọc được `blob:`) rồi rút bytes ra theo khúc base64 |
| `connectBrowser(port)` | Target cấp trình duyệt: `Storage.getCookies`, `Browser.close`, `Target.*` |
| `startRelay(getCfg)` / `parseProxy` / `testProxy` | Proxy riêng cho từng profile, hỗ trợ HTTP/SOCKS5 có mật khẩu |

## 3. Các bẫy đã gặp (triệu chứng → nguyên nhân → cách tránh)

1. **Không gắn được CDP vào profile mặc định của Chrome.**
   - Nguyên nhân: Chrome ≥ 136 chặn remote debugging trên user-data-dir mặc định.
   - Cách tránh: luôn dùng thư mục profile riêng do app tạo.
2. **"Chrome không lên cổng CDP trong 60 s".**
   - Nguyên nhân: profile đó đang mở sẵn trong một Chrome khác **không có** cổng debug (người dùng tự mở, hoặc job khác mở). Mỗi user-data-dir chỉ có một tiến trình Chrome.
   - Cách tránh: dùng lại cổng cũ (`runningPort`), hoặc đóng Chrome đó trước.
   - Chrome mở với cổng **cố định** (`--remote-debugging-port=9555`) **không ghi `DevToolsActivePort`** (đo 22/10/2026). `runningPort` nên lấy cổng từ dòng lệnh tiến trình Chrome có cùng `--user-data-dir` (`chrome.js` đã làm).
3. **Bị Google/Meta chặn hoặc giao diện lạ khi chạy headless.**
   - Cách tránh: không dùng headless. Dùng cửa sổ thật, **đẩy ra ngoài màn hình ở cỡ desktop** (`--window-position=-32000,-32000 --window-size=1440,900` hoặc `hideWindow`), và gọi `keepAlive`.
   - **Đừng thu nhỏ:** cửa sổ thu nhỏ báo viewport tí hon, Flow chuyển sang giao diện điện thoại (bảng chọn nguyên liệu che mất ô nhập).
   - Câu hỏi chỉ người dùng trả lời được (hộp thoại quyền của Flow, captcha, đăng nhập) → `showWindow`. Trên Windows phải thu nhỏ rồi khôi phục thì cửa sổ mới chịu lên trên. Trả lời xong thì ẩn lại.
4. **Thu nhỏ/che cửa sổ là trang "chết".**
   - Triệu chứng: `visibilityState='hidden'`, body cao 0 px, `innerText` rỗng, ảnh không mount, websocket realtime không nối.
   - Cách tránh: `keepAlive(client)` trước mỗi yêu cầu. `Emulation.setFocusEmulationEnabled` chỉ lo focus, **không** lo visibility, nên phải ghi đè thêm trong JS.
5. **Mở ngoài màn hình ngay từ đầu: hai app cho kết quả khác nhau.** Một app từng đo muse.ai không hydrate; app kia chạy như vậy trong production (có `keepAlive`) mà không gặp.
   - Nếu gặp: mở bình thường, gắn CDP, rồi mới `hideWindow` một lần.
   - Người dùng đã tự kéo cửa sổ vào xem thì đừng ẩn lại.
6. **`/json/new` kéo cửa sổ Chrome lên trước mặt người dùng.**
   - Cách tránh: mở tab bằng `Target.createTarget {background:true}`.
7. **Gán `input.files = DataTransfer.files` trong trang không ăn** (React của Muse/ChatGPT bỏ qua).
   - Cách tốt nhất: `attachViaChooser` → bật `Page.setInterceptFileChooserDialog` → click chuột thật vào nút 📎 → `Page.fileChooserOpened` → `DOM.setFileInputFiles {backendNodeId}`.
   - Dự phòng: `DOM.setFileInputFiles` vào `<input type=file>` cuối cùng. Sau đó kiểm chứng đã đính bằng dấu hiệu UI (ảnh xem trước / tên file), vì nhiều app tự xoá `input.files` sau khi đọc.
8. **Media là `blob:` hoặc URL cần cookie.**
   - Cách tránh: tải từ Node sẽ hỏng; dùng `pullBytes` (fetch trong trang). Mỗi khúc ~400 KB để tránh giới hạn kích thước message CDP.
9. **Đọc cookie từ ổ đĩa ngay khi Chrome vừa mở thì phiên Google chưa hợp lệ.**
   - Nguyên nhân: Google xoay vòng `__Secure-1PSIDTS` khi trang Google được mở (RotateCookies). Cookie trên đĩa là bản cũ.
   - Cách tránh: mở trang dịch vụ (vd `gemini.google.com/app`, `chatgpt.com`), chờ trang báo đã đăng nhập (vd có `SNlM0e`, hoặc `/api/auth/session` có `accessToken`), rồi mới `Storage.getCookies`.
10. **Chép profile sang máy/tài khoản Windows khác thì mất đăng nhập.**
    - Nguyên nhân: cookie được mã hoá gắn với máy/người dùng (DPAPI / app-bound encryption).
    - Lưu ý: chép trong **cùng máy, cùng user** thì được, nhưng bỏ `Cache`, `Code Cache`, `GPUCache`, `Crashpad`, file cổng (`.mbk-cdp-port`, `DevToolsActivePort`). Thư mục profile mất là phải đăng nhập lại.
11. **NetworkService ăn 100 % CPU, kernel pool phình nhiều GB** (Windows).
    - Nguyên nhân: `--user-data-dir` đi qua một **junction**. Chrome mkdir cache qua junction thất bại, thử lại ~80k lần/giây.
    - Cách tránh: `realpath` trước khi bật Chrome (`chrome.js` đã làm sẵn).
12. **Chrome không nhận mật khẩu proxy qua tham số, cũng không hỗ trợ SOCKS5 có mật khẩu.**
    - Cách tránh: chạy `startRelay` ở `127.0.0.1` rồi `--proxy-server=http://127.0.0.1:<port>`. Thêm `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` để WebRTC không lộ IP. Relay chưa sẵn sàng thì trỏ tới `http://127.0.0.1:9` (chặn) chứ đừng để lộ IP thật.
13. **Relay proxy làm sập tiến trình "Array buffer allocation failed".**
    - Nguyên nhân: cổng không phải proxy trả luồng dữ liệu không có `\r\n\r\n`, buffer phình vô hạn.
    - Cách tránh: giới hạn phần header ở 64 KB (`readUntil` đã làm).
14. **Regex trạng thái quét toàn trang bị dương tính giả**, do chính prompt của mình có chữ "connecting/processing/policy".
    - Cách tránh: chỉ đọc phần tử lá ngắn (chip trạng thái), và loại các dòng trùng prompt đã gửi khỏi câu trả lời trước khi dò "từ chối".
15. **Hai tiến trình cùng lái một tài khoản** (2 cửa sổ app, bản dev, script) làm tin nhắn chen nhau.
    - Khoá trong app không thấy tiến trình khác.
    - Cách tránh: file lock trong thư mục profile (`src/core/profile-lock.js`: pid + heartbeat, tự gỡ khi tiến trình chết).
16. **Nhận nhầm ảnh/video cũ**, do danh sách chat ảo hoá: phần tử cũ được dựng lại thành phần tử mới.
    - Cách tránh: trước khi gửi, đánh dấu mọi media hiện có bằng cả thuộc tính **lẫn** tập `src` đã thấy. Lưu thêm SHA-1 của mọi file đã lấy ra đĩa để chặn bản trùng byte. Chỉ nhận media nằm sau tin nhắn của mình, kiểm thêm khổ ảnh.

## 4. Riêng cho app Electron (nếu nhúng vào Electron)

- Mọi listener `webRequest.onBeforeSendHeaders(filter, (details, callback) => …)` **bắt buộc gọi `callback`**. Quên gọi thì mọi request khớp filter treo vĩnh viễn, trong khi trạng thái vẫn báo "connected".
- `setTimeout(...).unref()` trong main process có thể không bao giờ chạy. Đừng `unref` timer quan trọng.
- `fetch` của Node (undici) bỏ qua proxy hệ thống và kho CA của Windows (antivirus quét HTTPS, VPN công ty). Khi lỗi mạng, thử lại bằng `electron.net.fetch`.
- Hộp thoại phải gắn vào cửa sổ **đang hiển thị**; app thường có nhiều cửa sổ ẩn.

## 5. Riêng cho AI agent chạy trong Claude Desktop trên Windows (MSIX)

Shell của Claude Desktop chạy trong container MSIX: đọc/ghi `%APPDATA%` bị chuyển hướng sang
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\…`, trong khi `$env:APPDATA` vẫn in đường dẫn gốc.
Profile hay DB mà agent chép vào `%APPDATA%` thì app thật **không thấy**, và Chrome do agent bật cũng đọc bản trong container.
Nên đặt thư mục profile ở ổ dữ liệu (vd `D:\profiles\…`), hoặc nhờ người dùng tự chạy script chép.
