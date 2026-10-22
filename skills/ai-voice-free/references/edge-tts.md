# Edge Read Aloud TTS — miễn phí, không key

> Mã: `src/voice/edge-tts.js`. Đây là lớp mỏng gọi gói Python mã nguồn mở **edge-tts**
> (https://github.com/rany2/edge-tts, LGPL-3.0) mà người dùng tự cài: `pip install -U edge-tts`.
> - Repo này **không** chứa mã giao thức hay mã tạo token của Microsoft. Gói edge-tts lo phần đó, và mỗi lần
>   Microsoft đổi cơ chế chỉ cần `pip install -U edge-tts`. Cách này cũng giữ repo MIT sạch giấy phép.
> - Nguồn kinh nghiệm: (C) dùng Edge làm giọng mặc định cho hàng trăm cảnh bài giảng.
>
> ⚠ **Dịch vụ không chính thức**: đây là endpoint trình duyệt Edge dùng cho tính năng "Đọc to". Không có SLA,
> Microsoft có thể đổi hoặc chặn bất kỳ lúc nào. Cần ổn định hoặc dùng thương mại thì chọn Azure AI Speech
> (trả phí, cùng bộ giọng neural).

## Cài và dùng nhanh

```bash
pip install -U edge-tts          # Python 3.8+; đặt EDGE_TTS_PYTHON nếu python không nằm trong PATH
```

```js
const edge = require('./src/voice/edge-tts');
const { normalizeVi } = require('./src/voice/normalize-vi');
const r = await edge.synthesize({ text: normalizeVi('Có 3 quả táo.'), voice: 'vi-VN-HoaiMyNeural', rate: -4 });
fs.writeFileSync('a.mp3', r.buffer);   // mp3 24 kHz 48 kbps mono
// r.words = [{ text: 'Có', offsetMs: 50, durationMs: 212 }, …]  → subtitles.cuesFromWords(r.words, { text: chữ gốc })
const voices = await edge.listVoices(); // [{ ShortName, Gender, Locale, … }]
```

- `rate`/`volume` tính bằng %, `pitch` tính bằng Hz.
- Tiếng Việt chỉ có 2 giọng: `vi-VN-HoaiMyNeural` (nữ), `vi-VN-NamMinhNeural` (nam).
- Giọng trẻ em tiếng Việt không có sẵn. (C) lấy giọng người lớn rồi nâng `pitch: +18..+20 Hz`. Giọng trẻ em tiếng Anh có sẵn: `en-US-AnaNeural`, `en-GB-MaisieNeural`.

Văn bản dài không cần tự cắt: gói edge-tts tự chia đoạn, và mốc thời gian từng từ (WordBoundary) vẫn liền mạch.
Mốc từ ở đơn vị 100 ns; mã đã đổi sang ms.

## Bẫy

1. **403 khi kết nối.**
   - Nguyên nhân: Microsoft đổi cơ chế token. Từ 10/2026 token kiểu cũ bị từ chối, gói edge-tts bản cũ cũng dính (C).
   - Cách tránh: `pip install -U edge-tts`. Mã trả `EDGE_FORBIDDEN` kèm gợi ý này.
2. **403 chỉ trên một số máy.**
   - Nguyên nhân: token phụ thuộc giờ máy; đồng hồ lệch nhiều phút là sai token (C).
   - Cách tránh: đồng bộ giờ Windows. Bản mới của edge-tts tự bù lệch theo giờ server.
3. **Đọc méo tiếng Việt.**
   - Nguyên nhân: văn bản dán từ Word/PDF/web ở dạng Unicode tách dấu (NFD).
   - Cách tránh: chuẩn hoá NFC (mã đã làm), và chạy `normalizeVi` cho số/ngày/tiền.
4. **Phụ đề hiện "năm mươi ki lô mét", không có dấu câu, hai câu dính một dòng.**
   - Nguyên nhân: WordBoundary trả **chữ đã đọc**, không có dấu câu (C, đã sửa sau lỗi thật).
   - Cách tránh: `subtitles.cuesFromWords(words, { text: chữ gốc })` để căn lại theo chữ gốc.
5. **Ký tự điều khiển trong văn bản (copy từ Word/PDF) làm request bị bỏ qua.** Thay `\u0000–\u001f` bằng dấu cách trước khi gửi (suy ra).
6. **`EDGE_NOT_INSTALLED`** khi máy có nhiều bản Python và gói chỉ được cài cho một bản.
   - Cách tránh: đặt `EDGE_TTS_PYTHON` trỏ đúng `python.exe` có edge-tts.

## Ghi chú giấy phép

- edge-tts là LGPL-3.0. Repo này chỉ **gọi** gói đã cài (tiến trình con), không chép hay sửa mã của nó.
- App của bạn phân phối kèm edge-tts thì phải tuân LGPL: giữ thông báo bản quyền, cho người dùng thay được bản gói.

## Số đo thật (22/10/2026, edge-tts 7.3.1)

- Câu ~170 ký tự: 12,5 s để ra 11,8 s audio. Văn bản 2.219 ký tự: **169 s để ra 136 s audio**, tức **chậm hơn thời gian thực**. Batch lớn nên chạy song song 2–4 luồng.
- edge-tts **7.2.8 bị 403**, lên 7.3.1 thì chạy.
- Văn bản dài có lúc trả `EDGE_NO_AUDIO` rồi lần sau lại được, nên mã tự thử lại.

## Chưa kiểm chứng

- Giới hạn tần suất của server: chưa đo. Ví dụ batch để `concurrency: 2`.
