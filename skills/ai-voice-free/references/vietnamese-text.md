# Chuẩn hoá chữ tiếng Việt trước TTS

> Mã: `src/voice/normalize-vi.js` (Node) và `python/local_tts/omnivoice_clone/vi_text_norm.py` (Python, gọn hơn).
> Nguồn: (C) bộ chuẩn hoá cho bài giảng (toán, ngày, đơn vị; ~60 ca test) + (A) bộ chuẩn hoá cho clone giọng (tiền, số điện thoại, k/tr, emoji). Ca test lấy từ hai app: `test/voice.test.js`.

## Dùng

```js
const { normalizeVi, isViVoice, looksVietnamese } = require('./src/voice/normalize-vi');
normalizeVi('Giá 199.000đ, giảm 50% đến 12/5/2025 lúc 9h30.');
// 'Giá một trăm chín mươi chín nghìn đồng, giảm năm mươi phần trăm đến ngày mười hai tháng năm năm hai nghìn không trăm hai mươi lăm lúc chín giờ ba mươi phút.'
normalizeVi('105', { le: 'lẻ' });   // 'một trăm lẻ năm' (miền Nam); mặc định 'linh'
```

CLI (cho ngôn ngữ khác): `echo "3,5 km" | node src/voice/normalize-vi.js` → `ba phẩy năm ki lô mét`.

Xử lý: số (dấu `.` ngăn nghìn, `,` thập phân; `1,000,000` kiểu Anh), số âm, khoảng `3-5` → "ba đến năm", ngày `d/m/yyyy` `d-m-yyyy` `d.m.yyyy` + "ngày d/m" + "tháng m/yyyy", "tháng 4" → "tháng tư", giờ `7h30` `21h15p` `21:45` "lúc 7:30", `1m75`, %, đơn vị (km, km/h, m², °C, kg, ml, GB, mAh, GHz…), tiền (`199.000đ`, `₫`, `VNĐ`, `USD`, `$99`, `€5`, `199k`, `1,2tr`), số điện thoại (`0912.345.678`, `+84 …` → đọc từng số), viết tắt (TP.HCM, UBND, THCS, VD, v.v., GS.TS, VN, SĐT, ko, đc, Q.1, P.5…), thứ tự ("thứ 4" → "thứ tư", "lần thứ 1" → "nhất"), toán (x², (a+b)², phân số, =, <, ≥, √…) chỉ trong câu có dấu hiệu toán, emoji/markdown.

## Bẫy

1. **Đọc sai hoặc bỏ qua số, ngày, tiền.**
   - Triệu chứng: "199.000đ", "50%", "12/5/2025", "9h30" bị đọc sai hoặc mất chữ (A); "12/5" có thể bị đọc như phân số.
   - Nguyên nhân: Edge đọc được một phần, OmniVoice/Kokoro không có bộ chuẩn hoá tiếng Việt (chỉ zh/en) (A, đã gặp).
   - Cách tránh: chuẩn hoá **trước** TTS, chỉ khi giọng/văn bản là tiếng Việt (`isViVoice(voice) || looksVietnamese(text)`). Áp cho tiếng Anh sẽ làm hỏng "3.5".
2. **Dấu thanh tổ hợp (NFD) làm model đọc sai.** Văn bản copy từ macOS/web hay ở dạng NFD → luôn `normalize('NFC')` trước (A).
3. **`\b` không hiểu chữ có dấu.**
   - Nguyên nhân: trong regex JS, `\b` coi "à", "đ" là ký tự không phải chữ → "già" khớp trong "giàu", "TP" khớp giữa từ.
   - Cách tránh: dùng `(?<![\p{L}])…(?![\p{L}])` với cờ `u` (đã làm trong mã) (A, C).
4. **Python: `\b` bị biến thành ký tự backspace.** Khi sinh mã Python qua shell/heredoc, chuỗi `\b` trong regex có thể thành byte 0x08 → regex hỏng âm thầm (A, đã gặp). Kiểm bằng `grep -rlP "\x08"`.
5. **Phân số và ngày lẫn nhau.** "3/4 cái bánh" là phân số, "ngày 30/4" là ngày. Quy tắc (C): `d/m/yyyy` luôn là ngày; `d/m` chỉ là ngày khi có chữ "ngày" đứng trước; còn lại là phân số.
6. **Dấu gạch ngang.** "Bài học - phần mở đầu" không phải phép trừ; "2020-2021" là khoảng; "x - 5 = 0" là trừ. Chỉ đọc toán trong câu có dấu hiệu toán học (=, +, ², …) (C).
7. **Đơn vị một chữ cái nuốt chữ thường.** "2 l" → "hai lít" là đúng, nhưng "5 k" (năm cái gì?) thì mơ hồ → `k`/`tr` chỉ nhận khi **dính liền** số ("199k") (A).
8. **"150 triệu km"** có chữ số lớn chen giữa số và đơn vị → xử lý riêng (số + nghìn/triệu/tỷ + đơn vị).
9. **Phụ đề hiện chữ đã chuẩn hoá.** Phụ đề lấy từ **chữ gốc**, không phải chữ đã chuẩn hoá (xem `subtitles.cuesFromWords`).
10. **Linh hay lẻ.** Miền Bắc "một trăm linh năm", miền Nam "một trăm lẻ năm" → tuỳ chọn `le` theo giọng vùng.

## Chưa kiểm chứng

- Viết tắt mơ hồ ("ko", "đc", "VN") có thể sai ngữ cảnh (tên riêng, mã sản phẩm). Tắt bớt trong `ABBR` nếu nội dung của bạn hay có.
- Năm đọc kiểu "hai nghìn không trăm hai mươi tư" (chuẩn) — một số người đọc "hai không hai tư"; chưa có tuỳ chọn.
- Số La Mã ("thế kỷ XX"), số thứ tự kiểu "1st", đơn vị ít gặp: chưa xử lý.
