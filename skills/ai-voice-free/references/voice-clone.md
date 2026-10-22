# Clone giọng chạy máy: OmniVoice (+ Kokoro, phương án thương mại)

> Mã: `python/local_tts/omnivoice_clone/` (gói nhỏ chạy độc lập), `python/local_tts/kokoro_tts.py`.
> Nguồn: (A) tính năng "Clone giọng" dùng OmniVoice zero-shot cho người dùng thật (09–10/2026), có số đo RAM và lỗi thật; API thư viện đối chiếu mã nguồn gói `omnivoice` 0.2.1.

## ⚠ Giấy phép — đọc trước

| Model | Mã | Trọng số | Thương mại? | Tiếng Việt |
|---|---|---|---|---|
| **OmniVoice** (k2-fsa) | Apache-2.0 | **CC-BY-NC** (+ điều khoản tokenizer Boson Higgs Audio 2, Meta Llama 3) | **KHÔNG**: không bán, không video kiếm tiền, không app trả phí | Có (dữ liệu lớn) |
| **VoxCPM2** (OpenBMB) | — | nhãn Apache-2.0 | Nhãn cho phép, **tự đọc model card** | Có |
| **Confucius4-TTS** (NetEase Youdao) | — | nhãn Apache-2.0 (kèm thành phần MIT/Apache) | Nhãn cho phép, **tự đọc model card** | Có |
| **Kokoro-82M** | — | nhãn Apache-2.0 | Nhãn cho phép | **Không** |

Chi tiết và link: `voicestudio-notes.md` mục 2 và 5. Giấy phép mã không cấp quyền dùng trọng số; bản convert (GGUF/ONNX) có thể có giấy phép khác.
**Chỉ clone giọng của bạn hoặc người đã đồng ý.** Giả giọng người khác để lừa đảo/mạo danh là vi phạm pháp luật ở nhiều nước.

## Dùng nhanh

```bash
cd python/local_tts
pip install -r requirements.txt            # cài torch đúng bản CUDA trước
python -m omnivoice_clone.cli --ref mau.mp4 --demucs --asr small --text-file kich_ban.txt --out doc.wav
```

Từ app: chạy `python -m omnivoice_clone.worker --idle-min 12` làm tiến trình con, gửi JSON lines (`prepare`, `synth`), xem README của gói.

## Bẫy khi chuẩn bị MẪU (quyết định chất lượng clone)

1. **Clone ra giọng "không có ai", toàn nhạc.**
   - Nguyên nhân: cắt cứng 12 s **đầu** clip (`ffmpeg -t 12`). Clip mở đầu bằng nhạc intro → mẫu 100 % nhạc, 0 % lời (A, ca người dùng thật).
   - Cách tránh: đo năng lượng theo khung 20 ms, tìm đoạn có lời (ngưỡng = phân vị 95 − 32 dB), nối khoảng lặng < 260 ms, chọn **cửa sổ 6–15 s nhiều lời nhất**, cắt ở chỗ ngắt hơi ≥ 260 ms (không cắt giữa chữ). Nói liền > 20 s không nghỉ → cắt ở khung nhỏ tiếng nhất trong 10–15 s. Chừa 0,12 s trước, 0,25 s sau.
2. **Mẫu gần như không có lời vẫn được lưu.** Tổng lời nói < **2,5 s** → từ chối, báo người dùng cắt đoạn có một người nói rõ 5–20 s (A).
3. **Nhạc nền bị clone theo.**
   - Cách tránh: tách giọng bằng Demucs (htdemucs). Chỉ dùng phần giọng đã tách khi nhạc nghe rõ: trung vị (nhạc − giọng) trên các khung có lời > −20 dB (A).
   - Chạy Demucs ở **tiến trình con**: nạp torch của Demucs chung tiến trình với một bộ CUDA/cuDNN khác (Whisper) vỡ với WinError 127 trên DLL cuDNN (A, đã gặp trên Windows).
4. **Lời chép của mẫu là "Hãy subscribe cho kênh…".**
   - Nguyên nhân: Whisper tự đoán ngôn ngữ trên đoạn có nhạc → ảo giác câu kết video, và câu đó được lưu làm `ref_text` (A).
   - Cách tránh: **ép ngôn ngữ** (`language="vi"`), bật VAD, từ chối transcript rỗng, khớp mẫu ảo giác (subscribe, đăng ký kênh, like và share, bấm chuông, cảm ơn các bạn đã theo dõi, thanks for watching, vietsub, phụ đề…), hoặc có < **4 chữ cái / giây** audio. Khi từ chối: bảo người dùng tự gõ đúng lời của mẫu.
5. **Người dùng tự gõ lời cho cả clip** → không cắt cửa sổ nữa (sẽ lệch lời/tiếng), chỉ cắt im lặng/nhạc hai đầu (A).
6. **Âm lượng mẫu quá nhỏ/vỡ.** Chuẩn RMS vùng có lời ≈ −20 dBFS, đỉnh ≤ −1 dBFS, fade 10 ms hai đầu, 24 kHz mono 16-bit (A).
7. **Mẫu là bài hát.** Giọng hát làm mẫu khiến model đọc như đang hát (A). (A) đã thử Demucs + đổi âm sắc (Seed-VC) rồi **gỡ bỏ** vì người dùng chê không chuẩn. Đừng hứa clone từ bài hát.

## Bẫy khi ĐỌC

8. **Số/ngày/tiền đọc sai.** OmniVoice không có bộ chuẩn hoá tiếng Việt → `vi_text_norm.normalize_vi` trước (A). Giữ nguyên thẻ điều khiển `[laughter]`.
9. **Mất âm tiết cuối câu ("xứng đáng" → "xứng").**
   - Nguyên nhân: model ước lượng độ dài output theo văn bản; câu càng dài càng hụt (A, đã gặp).
   - Cách tránh: chia theo câu thành đoạn **≤ 220 ký tự** (câu quá dài cắt ở dấu phẩy), đọc từng đoạn **cùng seed** (giữ âm sắc), nối với **0,18 s** im lặng; nhân tốc độ **× 0,96** để kết câu tự nhiên (A).
10. **Mỗi lần dựng lại ra giọng hơi khác.** Seed ổn định theo (giọng, văn bản) → `stable_seed`.

## Bẫy về TÀI NGUYÊN

11. **App ngốn 3,2 GB RAM ngay khi mở dù không dùng clone.**
    - Số đo (A, 30/09/2026): worker OmniVoice nạp sẵn lúc khởi động chiếm **2 347 MB RAM / 6 664 MB commit**; cả app 3 199 MB. Máy 8 GB bị Windows giết tiến trình.
    - Cách tránh: **không warm-up** lúc mở app; nạp model ở yêu cầu đầu tiên; worker **tự thoát sau 12 phút rảnh** (0 = không bao giờ). Sau khi sửa: app 837 MB / 1 589 MB commit (−74 % RAM); lần dùng kế tiếp tự bật lại worker (yêu cầu nghe thử đầu tiên mất ~12 s trên GPU).
12. **RAM kernel (non-paged pool) tăng ~1 GB/phút tới khi phải khởi động lại máy.**
    - Nguyên nhân: numba (librosa `@jit(cache=True)`) ghi cache cạnh mã nguồn qua một **directory junction**; ghi thất bại và thử lại ~2·10⁹ lần (A, đã gặp, Windows).
    - Cách tránh: đặt `NUMBA_CACHE_DIR` vào thư mục thật có quyền ghi, `realpath()` mọi đường dẫn trước khi dùng (`engine.setup_env`). Khi thử tiến trình torch/librosa mới, theo dõi bộ đếm `\Memory\Pool Nonpaged Bytes`.
13. `CUDA_MODULE_LOADING=LAZY`: để lại vì vô hại, **không đo được** lợi ích lúc chưa nạp model (A). `KMP_DUPLICATE_LIB_OK=TRUE` tránh lỗi hai runtime OpenMP.
14. **Tiến trình con in rác ra stdout làm hỏng giao thức JSON.** Worker giữ stdout riêng cho giao thức, đẩy `sys.stdout` sang stderr.

## Kokoro

- Không có giọng Việt (chỉ Anh Mỹ/Anh, Tây Ban Nha, Pháp, Hindi, Ý, Nhật, Bồ Đào Nha Brazil, Quan thoại).
- **Bẫy (A, log lỗi người dùng 19/10):** kênh tiếng Việt chọn giọng Kokoro tiếng Anh → bộ phát âm tiếng Anh đọc chữ Việt thành tiếng bồi, chỉ hỏng ở bước kiểm tra thời gian sau đó (khớp 6 %), sau khi đã tốn cả bước TTS. Cách tránh: **chặn sớm** khi văn bản là tiếng Việt (`kokoro_tts.py` ném lỗi), hoặc tự đổi sang giọng Việt khác và cảnh báo.

## Chưa kiểm chứng

- Gói `omnivoice_clone` mới qua `py_compile` + import + test `split_text`; chưa chạy model thật trong repo này. Tên tham số `omnivoice` đúng với mã nguồn 0.2.1; nâng phiên bản phải kiểm lại.
- `language="vi"` hay `"Vietnamese"`: tài liệu gói nói nhận cả hai.
- Demucs gọi bằng CLI bản pip 4.0.x; (A) dùng `demucs.api` trong bản dựng riêng.
- faster-whisper model `small` cho tiếng Việt: (A) dùng Whisper của app; chất lượng `small` vs `medium` chưa so.
- Kokoro API (`KPipeline`) viết theo tài liệu gói 0.9.x, chưa chạy.
- VoxCPM2 / Confucius4-TTS: chưa có mã; xem ghi chú tham khảo.
