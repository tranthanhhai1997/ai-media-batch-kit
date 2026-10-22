# Muse (muse.ai) — tạo ảnh + video từ ảnh bằng CDP

> **Chạy thật 22/10/2026:** ảnh 71 s (webp **1920×1280 = 3:2** dù xin 16:9), video 87 s (mp4 1152×768, 10 s). Đính file/MV chưa chạy lại trên bản repo.

> Mã: `src/providers/muse.js`. Nguồn: hai app production độc lập cùng lái Muse:
> - **A**: app video, hàng nghìn cảnh;
> - **B**: app nhạc/MV, có unit test.
> Chỗ nào hai bên khác nhau đều ghi rõ nguồn (A)/(B).
> Trạng thái: **đã chạy thật trong app gốc**; bản tách riêng trong repo này mới qua `node --check`.
> Hãy test lần lượt `status()` → `generateImage()` → `generateVideo()` trước khi chạy hàng loạt.

## 1. Muse là gì, vì sao phải lái trình duyệt

- `https://muse.ai/` là **AI agent cá nhân của Meta** (chân trang ghi "© Meta"). Tên nội bộ trong cookie/API là `hatch`.
- **Không có API công khai.** Chỉ có cách mở trang thật trong một Chrome profile đã đăng nhập rồi điều khiển qua CDP:
  gõ prompt → chờ `<img>`/`<video>` MỚI xuất hiện sau tin nhắn của mình → `fetch(blob:)` trong trang → rút bytes ra từng khúc base64.
- Đăng nhập bằng số điện thoại/email + OTP. Người dùng **tự đăng nhập một lần** trong cửa sổ Chrome của profile.
- Làm được: ảnh từ chữ, ảnh từ ảnh mẫu (đính kèm), video từ ảnh (~10 giây).

```
App ──► createMuse({profileDir}) ──CDP WebSocket──► Chrome (--user-data-dir=<profile>, --remote-debugging-port)
                                                         └── đúng MỘT tab https://muse.ai/
```

## 2. Dùng nhanh

```js
const { createMuse } = require('./src/providers/muse');
const muse = createMuse({ profileDir: 'D:/profiles/muse-1', lang: 'vi' });
console.log(await muse.status());                      // {connected, connecting, email}
const img = await muse.generateImage({ prompt: 'Chú cáo đỏ trên tuyết', aspect: '16:9', newChat: true });
const clip = await muse.generateVideo({ prompt: 'Cáo quay đầu, tuyết rơi nhẹ' }); // không refs = animate ảnh vừa tạo
// clip ra từ ảnh có sẵn: generateVideo({ prompt, refs: [{ path: 'keyframe.png' }] })
```

Lần đầu: `createMuse({ profileDir, show: true }).status()` để mở cửa sổ, người dùng đăng nhập tay, rồi đóng lại.

## 3. Mười hai quy tắc bắt buộc (mỗi quy tắc là một lỗi đã gặp thật)

1. **Mỗi profile chỉ có MỘT tab muse.ai.** Tab thứ hai làm trang tự huỷ `POST /api/hatch/token` và kẹt "Đang kết nối" mãi. Thấy hơn 1 tab thì đóng bớt.
2. **Một tài khoản Muse chỉ giữ một phiên realtime.** Nếu đăng nhập cùng tài khoản ở profile/app/máy khác, chỗ cũ vẫn thấy lịch sử chat nhưng **không bao giờ gửi được nữa** (`MUSE_SESSION_TAKEN`).
3. **Mỗi tài khoản chạy 1 yêu cầu một lúc.** Muốn song song thì dùng nhiều tài khoản/profile (xem `src/core/queue.js`).
4. **Không tin câu trả lời bằng chữ.** Agent từng nói "Xong 4 ảnh rồi nè" mà không có ảnh nào. Chỉ tính là xong khi có `<img>`/`<video>` mới với kích thước > 0.
5. **Một ảnh/video mỗi tin nhắn.** Xin 4 ảnh trong một tin là hỏng hết.
6. **Chỉ dò trạng thái ở phần tử LÁ có chữ ≤ 28 ký tự** (chip "Iggy đang kết nối", "Đã kết nối", "Đang xử lý", "Vẫn đang gửi", "Không xác nhận là đã gửi"). Dùng regex trên toàn trang sẽ bắt nhầm chữ *connecting/processing* có sẵn trong prompt.
7. **Neo theo ô tin nhắn của mình:** tìm phần tử lá chứa 40 ký tự đầu prompt (lấy **lần xuất hiện CUỐI**), leo lên tới phần tử có cha ≥ 8 con, rồi chỉ nhận media trong các ô **phía sau**. `<video>` **vuông 720×720** ở sidebar là avatar, luôn loại ra. Dòng đầu prompt phải khác nhau giữa các yêu cầu.
8. **Kiểm hướng ảnh.** Trước đây Muse đúng khổ (16:9 → 2048×1152, 9:16 → 1152×2048). Ngày 22/10 xin 16:9 lại ra 1920×1280 (3:2), nên chỉ kiểm **hướng** (ngang/dọc/vuông): ảnh sai hướng là ảnh cũ. Cần đúng tỉ lệ thì cắt/scale sau.
9. **Chờ Muse rảnh hẳn rồi mới gửi.** Nếu không, ảnh trả muộn của yêu cầu trước sẽ bị nhận là ảnh của yêu cầu này. Đây là lá chắn chính.
10. **Cửa sổ thu nhỏ/bị che → trang `hidden`.** Khi đó Muse không giữ phiên, `innerText` rỗng, ảnh không mount. Ép qua CDP: viewport giả + focus giả + ghi đè `visibilityState` (`keepAlive` trong `src/core/cdp.js`). `innerText` rỗng thì lùi về `textContent` của `<main>`.
11. **Đính file qua CDP, không qua JS trong trang.** Gán `input.files` bằng `DataTransfer` thì Muse trả lời "không thấy ảnh đính kèm". Thứ tự trong `muse.js`:
    - Cách chính (B), đính được cả ảnh lẫn **mp3**:
      1. Bật `Page.setInterceptFileChooserDialog`.
      2. Cuộn nút 📎 (`aria-label` "Đính kèm file"/"Attach file") vào khung, rồi **click chuột thật** (`Input.dispatchMouseEvent`).
      3. Nút mở menu thì bấm tiếp mục "Tải lên / Upload".
      4. Bắt `Page.fileChooserOpened` → `DOM.setFileInputFiles {backendNodeId}`.
    - Dự phòng 1 (A): `DOM.setFileInputFiles` vào `<input type=file>` cuối cùng.
    - Dự phòng 2: `DataTransfer`.
    - Chưa xác nhận đính được thì **KHÔNG gửi prompt** (tránh tốn hạn mức). Muse xoá `input.files` sau khi đọc, nên phải kiểm bằng 3 dấu hiệu: ảnh xem trước / tên file / files.
12. **Media là `blob:` URL.** Không tải từ ngoài được, phải `fetch` ngay trong trang rồi rút ra từng khúc 400 KB.
13. **(B) Nhớ SHA-1 của mọi media đã lấy**, lưu theo profile (`<profile>/.mbk-muse-seen.json`).
    - Lý do: danh sách chat ảo hoá vẽ lại clip CŨ thành phần tử mới không còn dấu "đã thấy", và phương án 2 đã nhận nó. Đo 08/10: một khúc hỏi lại trả về sau 93 s, **trùng từng byte** với clip làm buổi sáng.
    - Media trùng thì bỏ qua và chờ tiếp.
14. **(B) Khoá tài khoản giữa các TIẾN TRÌNH**, không chỉ trong app.
    - Lý do: hai tiến trình (2 cửa sổ app, bản dev, script) trên cùng tài khoản Muse chen tin nhắn vào cùng một chat, và Muse trả lời tin đến sau cùng.
    - Cách làm: file lock trong thư mục profile (`src/core/profile-lock.js`, có heartbeat).
15. **Ẩn cửa sổ bằng cách đẩy ra ngoài màn hình ở cỡ desktop, đừng thu nhỏ** (`src/core/window.js`).
    - (B) đo được: tab ẩn **không** giả lập focus/visibility trả ảnh sau 216 s; có giả lập thì ~25 s. Thu nhỏ còn làm viewport tí hon.
    - (A) từng đo: mở ngoài màn hình ngay từ đầu thì trang không hydrate. (B) vẫn chạy ngoài màn hình từ lúc mở trong production, kèm `keepAlive`, mà không gặp lại. Nếu gặp: mở bình thường rồi mới `hideWindow`.

## 4. Số đo thật (tài khoản free, 10/2026)

| Hạng mục | Giá trị |
|---|---|
| Ảnh 16:9 | 25–70 s, `image/webp` 2048×1152, 200–350 KB |
| Ảnh 9:16 | chậm, có khi 7–10 phút (timeout mặc định 15 phút) |
| Clip từ ảnh (~10 s) | trung vị 54 s (41–148 s); 9:16 mất ~2–3 phút; mp4 H.264 1216×672 hoặc 1248×704, 24 fps, 2–4 MB |
| Khung đầu clip so với ảnh nguồn | SSIM ~0,71 (Muse vẽ lại, không giữ nguyên pixel; Grok ~0,99) |
| Hạn mức free | tính theo **% mỗi tuần**, ~0,5 %/clip ≈ 180 clip/tuần. Không có API, muốn biết thì hỏi agent trong chat |
| Máy ảo ngủ | tab mới/reload gọi `/api/hatch/vm/wake`, có thể "Đang kết nối" tới ~5 phút |
| Giữ nhân vật | trong cùng đoạn chat, chỉ cần `carryCharacter: true` ("giữ nguyên khuôn mặt… của ảnh trước"), không cần đính lại |

## 4b. Khả năng thêm (B)

- **MV cả bài trong MỘT tin nhắn** (đo 05/10): đính đoạn nhạc mp3 + kịch bản từng cảnh → **một** clip 1280×720 dài đúng 30 s. Âm thanh **chính là** file mp3 đã đính (lệch 0 ms, tương quan 1.0). Mất ~20–26 phút cho 30 s.
  - Gọi: `muse.ask({ kind: "video", text: brief, files: [{ path: "part1.mp3" }], minDurationSec: 28, timeoutMs: 50 * 60e3, refuseGraceMs: 5 * 60e3 })`.
  - `minDurationSec`: clip ngắn hơn mức này là một cảnh lẻ, không phải bản dựng.
  - `refuseGraceMs`: câu trả lời MV hay kèm dòng "không hát nhép được, nhưng…"; nếu dừng ngay sẽ thành từ chối nhầm.
- **Muse KHÔNG hát nhép theo bài hát** (hỏi trực tiếp, 05/10). Dùng cho cảnh rộng/chuyển cảnh; cảnh cần khẩu hình thì dùng Veo (Flow Omni / lip-sync).
- Video timeout:
  - (A): 8 phút cho clip ~10 s (đo được chậm nhất ~2–3 phút);
  - (B): 23 phút;
  - MV: ~50 phút.
- (B) Đặt **mô tả cảnh LÊN ĐẦU tin nhắn**, câu cố định ("Tạo 1 ảnh…") để sau. Lý do: neo tìm theo đầu tin nhắn; nếu đầu là câu cố định giống mọi tin thì bộ dò khớp nhầm tin cũ. `muse.js` neo theo dòng đầu của **prompt cảnh**, nên vẫn an toàn dù câu bọc đứng trước.

## 5. Luồng một yêu cầu (`runOne`)

1. `ensureProfileChrome`: bật Chrome của profile, hoặc dùng lại nếu cổng CDP còn sống.
2. `ensureTab`: tìm tab qua `/json/list`, đóng tab thừa; chưa có thì mở **nền** (`Target.createTarget {background:true}`). Sau khi bật, đẩy cửa sổ ra ngoài màn hình một lần.
3. `keepAlive`: ép trang luôn "hiển thị".
4. `waitReady`: có `textarea` + chip "đã kết nối" ổn định 6 lần đọc (~9 s). Thấy form đăng nhập thì ném `MUSE_AUTH`.
5. Nếu `newChat`, bấm nút "Đoạn chat mới / New chat" (tìm theo chữ/aria-label).
6. Nếu có `refs`, gọi `attachRefs`.
7. `waitIdle` → đánh dấu mọi media hiện có là "đã thấy" → kiểm lại phiên → gõ prompt (native setter + Enter).
8. Mỗi 2,5 s chạy `jsWaitNewAfter`:
   - có media mới → `pullMedia`;
   - bị từ chối → `MUSE_MODERATED`;
   - hỏi lại về mặt người thật → `MUSE_FACE_REFUSED` → gửi lại 1 lần với câu lệnh "không cần rõ mặt";
   - kẹt gửi > 150 s → reload + gửi lại **1 lần**.
   - **Phương án 2:** Muse đã bận rồi rảnh ≥ 15 s mà có media mới nhưng không khớp neo (danh sách ảo hoá) → vẫn nhận.

## 6. Tự phục hồi và mã lỗi

| Tình huống | Xử lý | Mã lỗi khi bỏ cuộc |
|---|---|---|
| Form đăng nhập | báo ngay | `MUSE_AUTH` |
| Kẹt "Đang kết nối" | 90 s reload → 240 s mở lại tab → 420 s tắt hẳn Chrome profile rồi bật lại | `MUSE_SESSION_TAKEN` (> 6 phút) / `MUSE_NETWORK` |
| Kẹt "Vẫn đang gửi" > 150 s | reload, đính lại, gửi lại 1 lần | `MUSE_NETWORK` |
| Nói xong mà không có media | chờ tới hết giờ | `MUSE_NO_MEDIA` |
| Từ chối / "không tạo được" | báo ngay | `MUSE_MODERATED` |
| Ảnh mẫu giống người thật | gửi lại 1 lần với câu "nhân vật hư cấu, quay lưng/nghiêng", nhớ 6 giờ cho tài khoản | `MUSE_MODERATED` |
| Không đính được ảnh | **không gửi prompt** | `MUSE_ATTACH_FAILED` |
| Media trùng byte với media đã lấy trước | bỏ qua, chờ tiếp | — |
| Tài khoản đang bị tiến trình khác dùng | chờ khoá; tự gỡ khi tiến trình kia đã chết hoặc khoá quá 20 phút không heartbeat | — |
| Phía gọi huỷ (`shouldAbort()`) | thoát ngay để nhả khoá | `MUSE_CANCELLED` |

Gợi ý `classify` cho `runBatch`:
- `MUSE_NETWORK` / `MUSE_NO_MEDIA` → `'retry'`. Muse không ổn định; chạy lại cảnh thiếu thường là được.
- `MUSE_SESSION_TAKEN` / `MUSE_AUTH` → `{action: 'cooldown', ms: 6 * 3600e3}`.
- Còn lại → `'fail'`.

## 7. Mẹo chất lượng đã kiểm chứng

- **Giữ nhân vật xuyên suốt một video:** một đoạn chat cho mỗi video. Cảnh đầu đính ảnh mẫu; các cảnh sau `carryCharacter: true`.
- **Song song có nhân vật:** mỗi làn (tài khoản) đính ảnh mẫu ở cảnh nhân vật đầu tiên trong đoạn chat của nó, sau đó dùng carry.
- **Timelapse máy cố định:** `previousFrame: true` + `refs: [khung trước, khung gốc]` giúp các khung nối tiếp liền mạch, chống trôi góc máy.
- **Prompt tả thực có người:** câu "giữ NGUYÊN khuôn mặt" dễ khiến Muse hỏi lại. Khi dựng clip, đừng nhắc tới mặt.
- Ảnh trả về là `webp`. Pipeline cần png thì tự chuyển (ffmpeg/sharp).

## 8. Kiểm tra đăng nhập không cần mở trang

Cookie của `muse.ai` (lấy bằng `Storage.getCookies` ở browser target):
- **đã đăng nhập:** có `hatch_sess` hoặc `hatch_gw`;
- **bỏ qua `hatch_native_auth_device`:** có chữ "auth" nhưng xuất hiện cả khi chưa đăng nhập.

Phiên **còn sống** hay không thì phải xem `status().connected`.

## 9. Rủi ro / chưa kiểm chứng

- Muse đổi giao diện (chữ trên chip, nút New chat, cấu trúc danh sách tin nhắn) thì bộ dò hỏng. Bộ dò dựa trên chữ VI/EN hiển thị; tài khoản dùng ngôn ngữ khác phải bổ sung regex.
- Prompt bọc tiếng Anh (`lang: 'en'`) là bản dịch, ít được test hơn bản `vi`.
- `startNewChat` không thấy nút thì chỉ ghi log và dùng tiếp đoạn chat cũ.
- Tự động hoá có thể trái điều khoản của Meta. Nên dùng tài khoản riêng và tần suất vừa phải.
