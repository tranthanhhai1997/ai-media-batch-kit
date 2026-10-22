# Chiến lược chạy hàng loạt (batch) — dùng chung cho mọi provider

> Mã: `src/core/queue.js` (`runBatch`) + `test/queue.test.js` (test offline).

## 1. Nguyên tắc số 1: song song theo TÀI KHOẢN, không theo request

Mọi provider ở đây đều có ràng buộc "**một tài khoản = một việc tại một thời điểm**":

| Provider | Vì sao không bắn song song trên 1 tài khoản |
|---|---|
| Muse | Mỗi tài khoản chỉ có 1 phiên realtime, 1 tab. Gửi chồng thì nhận nhầm media |
| Google Flow / Veo | App gốc khoá theo tài khoản (accountLocks). Dồn dập dễ bị "hoạt động bất thường" / rate-limit (xem `flow-veo3.md`) |
| ChatGPT ảnh | Mỗi lượt một hội thoại mới trong một tab. Gói free có hạn mức ảnh theo giờ |
| Grok web | Hạn mức theo ngày, một tab imagine |

Muốn nhanh hơn thì **thêm tài khoản/profile**. `runBatch` chia việc theo LRU (tài khoản rảnh lâu nhất nhận trước),
cho tài khoản hết lượt nghỉ (`cooldown`), và đẩy việc lỗi tạm sang tài khoản khác (`retry`).

```js
const results = await runBatch(jobs, {
  workers,                                   // mỗi worker = 1 client provider gắn 1 profile
  run: (job, w) => w.generateImage(job),
  classify: (e) => /QUOTA|RATE_LIMIT/.test(e.code) ? { action: 'cooldown', ms: 30 * 60e3 }
                 : /NETWORK|TIMEOUT|NO_MEDIA/.test(e.code) ? 'retry' : 'fail',
  onDone: (job, res) => fs.writeFileSync(job.out, res.buffer),
});
```

## 2. Phân loại lỗi (dùng cho `classify`)

| Nhóm | Ví dụ mã | Hành động |
|---|---|---|
| Tạm thời | `*_NETWORK`, `*_TIMEOUT`, `*_NO_MEDIA`, `*_BAD_RESPONSE` | `retry` (tối đa 1–2 lần, thường sang tài khoản khác) |
| Hết lượt / bị giới hạn | `*_QUOTA`, `*_RATE_LIMIT` | `cooldown` tài khoản đó (Flow 15–30', ChatGPT theo "resets in N hours", Grok tới ngày mai) |
| Phiên hỏng | `*_AUTH`, `MUSE_SESSION_TAKEN` | `cooldown` dài + báo người dùng đăng nhập lại profile |
| Nội dung | `*_POLICY`, `*_MODERATED`, `MUSE_FACE_REFUSED` | **không** retry nguyên văn: viết lại prompt trung tính / bỏ ảnh mẫu / đổi model, rồi mới thử lại 1 lần |
| Huỷ | `*_CANCELLED` | dừng |

**Bẫy:** đừng thử lại vô hạn khi bị rate-limit. App gốc từng chờ 1 phút rồi thử lại chính tài khoản đó mãi mãi.
Bản sửa: nếu một tài khoản bị chặn cứng ≥ 2 lần trong 15 phút thì đánh dấu "ốm" 30 phút; ≥ 4 lần mà không chuyển được tài khoản thì bỏ cảnh.

## 3. Luồng ảnh → video (pipeline video kể chuyện)

```
kịch bản ─► danh sách cảnh {id, prompt ảnh, prompt chuyển động}
          ─► ẢNH keyframe (Flow Imagen / Muse / ChatGPT)   ← giữ nhân vật đồng nhất ở bước này
          ─► CLIP từ keyframe (Veo 3 image→video / Muse / Grok)
          ─► tải về out/<id>.(png|webp|mp4) + manifest.json
          ─► dựng phim (ffmpeg)
```

- **Giữ nhân vật đồng nhất:**
  - vẽ chân dung nhân vật trước, rồi đính làm ảnh mẫu ở mọi cảnh có nhân vật đó;
  - với Muse: cảnh đầu đính ảnh mẫu, các cảnh sau dùng `carryCharacter` trong **cùng đoạn chat**, và mỗi làn (tài khoản) giữ một đoạn chat.
- **Cảnh nối tiếp, máy cố định** (timelapse xây dựng, diorama): truyền khung trước làm ảnh tham chiếu (`previous_frame`) + khung gốc để chống trôi góc máy.
- **Ảnh và clip của cùng một cảnh nên chạy trên cùng tài khoản** khi provider animate "ảnh vừa tạo ở trên" (Muse).
- **Ghi file ngay khi xong từng cảnh, bỏ qua cảnh đã có file.** Chạy lại sau khi crash/huỷ thì chỉ làm phần thiếu. Đừng để một lần "tạo lại" xoá kết quả cũ.
- **Không có file thì không tính là xong.** Một số agent web trả lời "xong rồi" bằng chữ mà không có media.

## 4. Prompt hàng loạt

- Mỗi prompt một dòng đầu **khác nhau**. Bộ dò UI dùng dòng đầu để tìm tin nhắn của mình (Muse, ChatGPT).
- Đặt khổ hình **trong prompt** ("Khung hình DỌC 9:16"), rồi kiểm lại kích thước file trả về.
- Tránh tên người thật / người nổi tiếng / "KOL", và ảnh mẫu tả thực nhìn thẳng mặt. Đây là nguyên nhân số 1 khiến Veo/Muse từ chối.
  - Cách viết an toàn: "An original fictional … character (not a real or famous person)".
  - Lưu ý: Veo từ chối do **ảnh khung đầu** (mặt người tả thực) chứ không chỉ do chữ. Sửa chữ không cứu được thì đổi ảnh/model.
- ChatGPT ảnh: các câu như "from scratch, there is no source image to edit/upload" hoặc "if the reference is not attached" lại **làm nó chuyển sang chế độ EDIT** và hỏi xin ảnh. Viết thẳng "Generate an image: …". Chỉ nhắc ảnh mẫu khi thật sự đính kèm.
- Ngôn ngữ chữ trong ảnh (thumbnail): ghi rõ "TEXT LANGUAGE (strict): English…". Nếu không, memory/custom instructions tiếng Việt của tài khoản sẽ lấn át.
- Dùng LLM (ChatGPT/Gemini text, `chatgpt-gemini-text.md`) để viết prompt hàng loạt. Khi bị từ chối, viết lại prompt ở dạng trung tính.

## 5. Vận hành

- **Kiểm tra sức khoẻ trước khi chạy:** gọi `status()` từng profile, rồi chỉ giao việc cho profile `connected:true`. Riêng Muse, trang kẹt "Connecting…" vẫn có ô nhập: phải thấy chip "Đã kết nối" mới tính là sống.
- **Đọc credit trước** (Flow: rpc `nzlxg`) và bỏ qua tài khoản không đủ cho model đã chọn.
- **Watchdog cho từng lượt:** việc im lặng > 5 phút → đóng/mở lại Chrome profile → kiểm việc cũ → gửi lại tối đa 1 lần.
- **Huỷ phải cắt được vòng chờ** (`shouldAbort`). Nếu không, khoá tài khoản bị giữ tới hết timeout và mọi lượt sau đứng im.
- **Log ra file theo từng provider** (bước gửi, đính ảnh, dò media, tự phục hồi). Khi lỗi, đọc log + `Page.captureScreenshot` của tab thay vì đoán.
- Thông báo cho người dùng theo **nhóm**: gộp các lỗi giống nhau của một tài khoản trong 30 phút, đừng hiện 20 hộp thoại.
