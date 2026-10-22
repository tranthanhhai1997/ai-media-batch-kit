# Chọn provider giọng đọc

> Nguồn: (A) app video AI, (C) app video bài giảng, cả hai chạy thật 09–10/2026. Giấy phép model: theo nhãn upstream, xem thêm `voicestudio-notes.md`.
> Không có con số hạn mức chính xác của Google/ai33 ở đây vì chúng thay đổi; xem trang của họ.

## Bảng so sánh

| Provider | Miễn phí tới đâu | Tiếng Việt | Cần gì | Mốc từ (phụ đề) | Giấy phép / điều khoản | Rủi ro chính |
|---|---|---|---|---|---|---|
| **Edge Read Aloud** (`edge-tts.js`) | Miễn phí, không key, không hạn mức công bố; cần `pip install edge-tts` (gói Python LGPL, repo chỉ gọi gói này) | 2 giọng: `vi-VN-HoaiMyNeural` (nữ), `vi-VN-NamMinhNeural` (nam). Rõ, hơi "đọc tin" (C) | Mạng | **Có** (WordBoundary) | Endpoint **không chính thức** của trình duyệt Edge. Bản chính thức trả phí: Azure AI Speech | Bị đổi/chặn bất kỳ lúc nào (10/2026 token cũ bị 403, phải lên token v2) |
| **Gemini TTS** (`gemini-tts.js`) | Tầng free của API key Google AI Studio, hạn mức theo phút + ngày khá thấp | Tốt, tự nhiên. 30 giọng × giọng vùng Bắc/Nam qua chỉ dẫn (A, C) | API key Google của người dùng | Không | API chính thức. Tuân hạn mức và điều khoản Google | Hết lượt (429), giọng nam trôi thành nữ khi đổi vùng (phải khoá giới tính), đôi khi trả chữ thay vì audio |
| **ai33.pro** (`ai33.js`) | **Trả phí** (credit), rẻ hơn mua thẳng từng hãng | Có: Vbee (Bắc/Trung/Nam), ElevenLabs đa ngữ, MiniMax… | API key ai33 + credit | Có nếu task trả transcript | Dịch vụ bên thứ ba, xem điều khoản ai33 | Hết credit, giọng bị gỡ, phụ thuộc bên trung gian |
| **Kokoro-82M** (`kokoro_tts.py`) | Miễn phí, chạy máy | **Không có** | CPU được, GPU nhanh hơn | Không (tự làm) | Nhãn Apache-2.0 | Đọc tiếng Việt thành tiếng bồi nếu không chặn (A) |
| **OmniVoice** (`omnivoice_clone/`) | Miễn phí, chạy máy, **clone giọng** từ mẫu 3–20 s | Có (dữ liệu huấn luyện tiếng Việt lớn) | GPU ≥ 6 GB nên có, ~2,3 GB RAM khi nạp (A) | Không | Mã Apache-2.0, **trọng số CC-BY-NC: KHÔNG thương mại** | Vi phạm giấy phép nếu dùng kiếm tiền; mẫu bẩn → giọng hỏng |
| VoxCPM2 / Confucius4-TTS | Miễn phí, chạy máy, clone | Có | GPU (CUDA 12) | Không | Nhãn Apache-2.0, **tự đọc model card** | Chưa chạy trong (A)/(C); xem `voicestudio-notes.md` |

## Gợi ý chọn nhanh

- **Mặc định, không key**: Edge. Giữ một provider dự phòng (Gemini hoặc ai33) cho ngày Edge bị chặn.
- **Tiếng Việt tự nhiên, miễn phí, ít câu**: Gemini với key của người dùng. Nhiều câu/ngày → hết lượt free, cân nhắc trả phí Google hoặc ai33.
- **Nhiều giọng Việt vùng miền, thương mại, có ngân sách nhỏ**: ai33 (Vbee).
- **Clone giọng của chính mình, không thương mại**: OmniVoice. Thương mại → thử VoxCPM2 / Confucius4-TTS (tự kiểm giấy phép).
- **Tiếng Anh offline**: Kokoro.

## Loại khỏi repo này (cố ý)

- Mọi cách dùng API nội bộ của dịch vụ khác bằng cách giả thiết bị/ứng dụng để lấy giọng "miễn phí": không được phép, có thể khiến tài khoản/IP bị khoá.
- Không có mã ElevenLabs gọi thẳng trong repo. ElevenLabs dùng qua ai33 (trả phí) hoặc tự tích hợp API chính thức bằng key của bạn.
