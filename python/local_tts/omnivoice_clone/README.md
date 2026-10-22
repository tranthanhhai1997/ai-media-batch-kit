# omnivoice_clone — clone giọng chạy trên máy (OmniVoice)

> ⚠ **Trọng số OmniVoice là CC-BY-NC: KHÔNG dùng thương mại.** Không bán, không dùng trong video kiếm tiền, app trả phí.
> Mã OmniVoice là Apache-2.0, nhưng giấy phép mã không cấp quyền dùng trọng số. Tokenizer âm thanh còn kèm điều khoản Boson Higgs Audio 2 + Meta Llama 3.
> Cần thương mại và có tiếng Việt: xem **VoxCPM2**, **Confucius4-TTS** (nhãn Apache-2.0, vẫn phải tự đọc model card) trong `skills/ai-voice-free/references/voice-clone.md`.
> Chỉ clone giọng của chính bạn hoặc người đã đồng ý.

Gói nhỏ, chạy độc lập, viết lại từ mã chính chủ của app (A) đã chạy thật. Bẫy và số đo ở `skills/ai-voice-free/references/voice-clone.md`.

| File | Việc |
|---|---|
| `prepare_reference.py` | Làm sạch mẫu: ffmpeg → 24 kHz mono, chọn cửa sổ 6–15 s nhiều lời nhất (cắt ở chỗ nghỉ ≥ 260 ms), từ chối < 2,5 s lời nói, Demucs tách nhạc (tuỳ chọn, tiến trình con), ASR ép ngôn ngữ + chặn ảo giác (tuỳ chọn), chuẩn âm lượng |
| `vi_text_norm.py` | Đọc số/ngày/giờ/tiền/đơn vị/viết tắt tiếng Việt (bản Python của `src/voice/normalize-vi.js`) |
| `engine.py` | Nạp OmniVoice, cache prompt clone, cắt câu ≤ 220 ký tự cùng seed, nghỉ 0,18 s, speed × 0,96 |
| `worker.py` | Tiến trình giữ model, JSON lines qua stdin/stdout, **không nạp sẵn**, **tự thoát khi rảnh** (mặc định 12 phút) + `WorkerClient` cho tiến trình cha |
| `cli.py` | Mẫu → đọc văn bản dài → WAV |

## Cài

```bash
# 1) torch đúng bản CUDA (https://pytorch.org), 2) phần còn lại:
pip install -r ../requirements.txt        # omnivoice, numpy, soundfile, (faster-whisper, demucs tuỳ chọn)
# ffmpeg phải có trên PATH hoặc đặt FFMPEG_PATH
```

GPU ≥ 6 GB VRAM nên dùng. CPU chạy được nhưng chậm. Lần đầu tải trọng số `k2-fsa/OmniVoice` từ Hugging Face (vài GB).

## Dùng

```bash
cd python/local_tts
# mẫu có nhạc nền, chưa có lời: tách nhạc + tự chép lời
python -m omnivoice_clone.cli --ref mau.mp4 --demucs --asr small --text-file kich_ban.txt --out doc.wav
# mẫu sạch + lời chính xác (chất lượng tốt nhất)
python -m omnivoice_clone.cli --ref mau.wav --ref-text "Đúng từng chữ trong mẫu." --text "Xin chào các bạn." --out a.wav
# chỉ làm sạch mẫu
python -m omnivoice_clone.prepare_reference mau.mp4 ref.wav --lang vi --demucs --asr small
```

Từ app (Node/Electron/Python): chạy `python -m omnivoice_clone.worker --idle-min 12` làm tiến trình con, gửi từng dòng JSON:

```json
{"id":1,"op":"prepare","src":"mau.mp4","out":"ref.wav","lang":"vi","demucs":true,"asr":"small"}
{"id":2,"op":"synth","text":"Xin chào.","ref_wav":"ref.wav","ref_text":"…","lang":"vi","out":"a.wav"}
```

Mỗi yêu cầu nhận đúng 1 dòng JSON trả lời (`ok`, `error`, `code`). Tiến trình đã tự thoát vì rảnh thì khởi động lại và gửi lại (`WorkerClient` làm sẵn việc này).

## Chưa kiểm chứng trong repo này

- API `omnivoice` (`from_pretrained`, `create_voice_clone_prompt`, `generate`) đã đối chiếu với **mã nguồn gói 0.2.1**, nhưng gói này chưa chạy thật trong repo. Nâng phiên bản thì kiểm lại `engine._load()` / `_generate()`.
- `language="vi"`: tài liệu gói ghi nhận cả tên lẫn mã ngôn ngữ. Nếu đọc sai ngôn ngữ, thử `"Vietnamese"`.
- Demucs gọi bằng CLI `python -m demucs --two-stems=vocals` (bản pip 4.0.x). App (A) dùng `demucs.api` trong bản dựng riêng.
- Các con số (6–15 s, 260 ms, 2,5 s, 4 chữ/giây, 220 ký tự, 0,18 s, × 0,96, 12 phút) đo trên app (A) với tiếng Việt.
