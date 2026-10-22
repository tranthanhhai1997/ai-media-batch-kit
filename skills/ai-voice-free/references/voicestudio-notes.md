# Ghi chú nghiên cứu: VoiceStudio (debpalash/VoiceStudio)

> Nguồn: <https://github.com/debpalash/VoiceStudio>, nhánh `main`, commit
> [`28bf2c7`](https://github.com/debpalash/VoiceStudio/tree/28bf2c7a83b8a64836297340c52a45d716684aed)
> (20/10/2026). Đọc ngày 22/10/2026.
>
> **Phạm vi:** đây là ghi chú tóm tắt **bằng lời của chúng tôi**. Không có dòng mã nào được chép từ
> VoiceStudio (repo đó dùng AGPL-3.0, không tương thích với MIT). Ai muốn xem cách cài đặt cụ thể
> thì bấm link đến file gốc. Đừng dán mã của họ vào repo này.
>
> Viết tắt link: `VS/<path>` = `https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/<path>`

---

## 1. VoiceStudio là gì

- App desktop mã nguồn mở, mục tiêu là "ElevenLabs chạy cục bộ". Các tính năng: clone giọng
  zero-shot, thiết kế giọng bằng mô tả (voice design), lồng tiếng video, đọc chính tả (dictation),
  chép lời, sách nói. Họ quảng bá con số **646 ngôn ngữ**, nhưng con số này chỉ đúng với model
  mặc định OmniVoice ([VS/README.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/README.md),
  [VS/docs/languages.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/languages.md)).
- Engine mặc định là **k2-fsa/OmniVoice**. Đây là model diffusion/masked dạng "iterative unmasking",
  xuất 24 kHz mono. Theo bảng ngôn ngữ, tiếng Việt có **~8 482 giờ** dữ liệu huấn luyện (dòng 622
  trong `docs/languages.md`), thuộc nhóm nhiều dữ liệu nhất.
- Giấy phép app là AGPL-3.0. Repo rất phổ biến (~80k sao), phát hành liên tục (không có RC).

### Kiến trúc (sơ đồ)

```
┌──────────────────────────── Electron app (electron/) ────────────────────────────┐
│  UI React: Clone · Design · Dub · Stories/Audiobook · Dictation · Model Catalogue │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ HTTP / WebSocket (loopback, cổng mặc định 3900)
┌───────────────▼──────────────── Backend FastAPI (backend/) ──────────────────────┐
│ routers: /generate  /v1/audio/*  /ws/tts  /dub/*  /profiles  /pronunciation      │
│          /convert   /engines     /models  /watermark  /mcp                         │
│ services: chuẩn hoá văn bản → từ điển phát âm → chia đoạn → GPU pool (giới hạn)  │
│           → engine → trim/crossfade → master → watermark AudioSeal → WAV + lịch sử│
│ engine_memory: chỉ giữ 1 engine TTS trong RAM; idle sweep giải phóng sau 15'     │
└──────┬───────────────────────────────┬──────────────────────────────┬────────────┘
       │ in-process (cùng venv)        │ subprocess sidecar            │ HTTP loopback
       ▼                               ▼ (venv riêng, JSON có         ▼
  OmniVoice, VoxCPM2, Kitten,       tiền tố độ dài qua stdin/stdout)  GPT-SoVITS server,
  MOSS-Nano, MLX-Audio, CosyVoice   IndexTTS 2.5, MOSS v1.5, dots.tts, audio.cpp (Breeze)
  (source), Sherpa-ONNX             Confucius4, Supertonic-3, PocketTTS,
                                    CosyVoice (bản cài 1 cú nhấp)
       ▲
       │ MCP stdio (python -m backend.mcp_shim) / MCP HTTP :3900/mcp/
  Agent (Claude Code, Codex…)
```

- Tách engine ra sidecar để tránh xung đột thư viện. Ví dụ app cần `transformers>=5.3`, còn
  IndexTTS cần `<5` ([VS/backend/services/subprocess_backend.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/subprocess_backend.py)).
- Dữ liệu (giọng, dự án, DB SQLite + alembic) nằm trong `omnivoice_data/`. Trên Windows, cache HF
  nằm ở `%LOCALAPPDATA%\OmniVoice\hf_cache`.

### Cách cài (tóm tắt)

- Windows: chạy `irm https://voicestudio.sh/install | iex` trong PowerShell, hoặc tải `.exe` ở Releases.
  macOS/Linux: dùng `curl -fsSL https://voicestudio.sh/install | sh`, hoặc `.dmg/.AppImage/.deb`. Có Docker
  (`ghcr.io/debpalash/voicestudio:stable`, bản CUDA/ROCm).
- Chạy từ source: `bun install` → `bun run setup:api` → `bun run dev`. Chạy riêng backend (headless):
  `uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900`
  ([VS/.claude/skills/omnivoice/references/mcp-setup.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/.claude/skills/omnivoice/references/mcp-setup.md)).
- Model OmniVoice (~2,4 GB) chỉ tải khi tổng hợp lần đầu. Các engine khác cài trong Model Catalogue.

### Yêu cầu phần cứng

| Cấu hình | Hỗ trợ (theo README / docs/engines/omnivoice.md) |
|---|---|
| NVIDIA (Win/Linux) | CUDA. OmniVoice cần **≥ 6 GB VRAM**. Card 4 GB bị tràn sang RAM nên chậm hàng phút |
| AMD | ROCm (Linux) |
| Apple Silicon | MPS (bộ nhớ hợp nhất) |
| Không có GPU | Chạy được trên CPU nhưng chậm. Cần bản PyTorch CPU (~5 GB ổ đĩa) |
| Ít VRAM / CPU | Dùng **OmniVoice-GGUF**: Q4_K_M ~0,66 GB, Q8_0 ~0,95 GB, BF16 ~1,6 GB |
| Intel Mac | Chỉ có UI, backend phải đặt ở máy khác |

Thời gian chờ tối đa mỗi lần sinh: 300 s trên GPU, 600 s trên CPU, cộng thêm theo độ dài văn bản
([VS/docs/performance.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/performance.md)).
Bảng benchmark của repo **chưa có số đo đã xác minh** ([VS/docs/benchmarks.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/benchmarks.md)).

---

## 2. Bảng engine

Nguồn chính:
[VS/docs/engines/README.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/README.md),
từng trang trong `docs/engines/*.md`, và bảng giấy phép
[VS/backend/config/model_licenses.json](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/config/model_licenses.json).

**Đọc kỹ trước khi dùng bảng:** trong `model_licenses.json`, **mọi** model đều có `commercial_use: false`.
Họ chưa duyệt model nào cho mục đích thương mại. Phần lớn ở trạng thái `unreviewed`, chỉ một số ít
được ghi rõ là `noncommercial`. Cột "Thương mại?" dưới đây dựa trên **nhãn giấy phép của upstream**
mà repo ghi lại. Đó không phải kết luận pháp lý. Hãy kiểm tra lại model card gốc trước khi dùng.

### 2a. TTS / clone

| Engine | Code / trọng số (nhãn repo ghi) | Thương mại? | Ngôn ngữ (tiếng Việt?) | Phần cứng / tốc độ | Điểm mạnh |
|---|---|---|---|---|---|
| **OmniVoice** (mặc định) | Code Apache-2.0 / trọng số **CC-BY-NC** + tokenizer có điều khoản Boson Higgs Audio 2 & Meta Llama 3 | **Không** (`noncommercial`) | 646, **có VI** (8 482 h) | GPU ≥ 6 GB. CPU chậm. Không stream thật | Clone 3–20 s, voice design, phủ ngôn ngữ rộng nhất ([omnivoice.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/omnivoice.md)) |
| OmniVoice-GGUF (Serveurperso) | binary C++ / CC-BY-NC-4.0 | **Không** | Như OmniVoice, có VI | 0,66–1,6 GB VRAM hoặc CPU | Bản lượng tử cho máy yếu ([omnivoice-gguf.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/omnivoice-gguf.md)) |
| **VoxCPM2** (OpenBMB) | trọng số Apache-2.0 (unreviewed) | Nhãn cho phép, cần tự kiểm | 30, **có VI** | CUDA ≥ 12 khuyến nghị; MPS/CPU chạy được; checkpoint vài GB | 48 kHz, clone + **voice design** không cần mẫu ([voxcpm2.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/voxcpm2.md)) |
| **Confucius4-TTS** (NetEase Youdao) | Apache-2.0 (kèm w2v-bert MIT, campplus Apache, BigVGAN MIT) | Nhãn cho phép, cần tự kiểm | 14, **có VI** | Nên dùng CUDA 12.6. CPU ~17× chậm hơn realtime. ~5 GB trọng số | Clone không cần transcript, giữ cùng một giọng khi đổi ngôn ngữ, 22,05 kHz ([confucius4-tts.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/confucius4-tts.md)) |
| MOSS-TTS-v1.5 (8B) | Apache-2.0 code + trọng số | Nhãn cho phép | 31, repo **không liệt kê** từng ngôn ngữ | ~16 GB VRAM (bf16). CPU chậm | Điều khiển thời lượng theo token, marker `[pause Ns]` ([moss-tts-v15.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/moss-tts-v15.md)) |
| MOSS-TTS-Nano (100M) | Apache-2.0 | Nhãn cho phép | 20, **không có VI** | Realtime trên CPU 4 nhân | Clone trên máy yếu, 48 kHz ([moss-tts-nano.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/moss-tts-nano.md)) |
| dots.tts (2B, rednote) | Apache-2.0 | Nhãn cho phép | 24, repo không liệt kê | ~9 GB, GPU 12–16 GB. **Không chạy trên Windows** | Clone zero-shot rất mạnh, 48 kHz ([dots-tts.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/dots-tts.md)) |
| CosyVoice 3 (0.5B) | Apache-2.0 | Nhãn cho phép | Repo không liệt kê | ~5,4 GB trọng số, CUDA/CPU | Clone + chỉ dẫn phong cách ([cosyvoice.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/cosyvoice.md)) |
| IndexTTS 2.5 | "other" | Chưa rõ | zh, en, ja, es, ar (**không có VI**) | Cần ≥ 12 GB ổ đĩa, CUDA/CPU | Cảm xúc (vector, văn bản, audio mẫu) ([indextts.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/indextts.md)) |
| GPT-SoVITS | MIT | Nhãn cho phép | zh/en/ja/yue/ko (**không có VI**) | Chạy server API riêng | Clone few-shot ([gpt-sovits.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/gpt-sovits.md)) |
| KittenTTS | Apache-2.0 | Nhãn cho phép | Chỉ EN | 25–80 MB ONNX, realtime trên mọi CPU | 8 giọng có sẵn, rất nhẹ ([kittentts.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/kittentts.md)) |
| Supertonic-3 (Supertone) | SDK MIT / trọng số **OpenRAIL-M** | Có điều kiện (giới hạn mục đích sử dụng) | 31, repo không liệt kê | ~99M, chỉ CPU, ~400 MB | 44,1 kHz, 7 giọng có sẵn, không clone ([supertonic3.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/supertonic3.md)) |
| PocketTTS (Kyutai) | Code MIT / trọng số CC-BY-4.0, **gated** trên HF | Nhãn cho phép (phải ghi công + chấp nhận AUP) | 6 ngôn ngữ châu Âu (**không có VI**) | Chỉ CPU, ~8–9× realtime trên M3 Pro | Clone nhanh trên CPU ([pockettts.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/pockettts.md)) |
| audio.cpp / Breeze-TTS-2 (3B) | Code Apache-2.0 / trọng số **Research & Non-Commercial** | **Không** | EN + ZH | ~6 GB VRAM, GGUF 4,7 GiB | Clone + design ([audio-cpp.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/audio-cpp.md)) |
| MLX-Audio (chỉ Apple Silicon) | Kokoro, CSM, Qwen3-TTS, Dia: Apache-2.0. Chatterbox: NOASSERTION. MeloTTS: MIT. **OuteTTS: CC-BY-NC-SA + Llama 3.2** | Tuỳ model | Kokoro ~8 ngôn ngữ, **không có VI** | Mac M-series | Nhiều engine phụ ([mlx-audio.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/mlx-audio.md)) |
| Sherpa-ONNX | Apache-2.0 (runtime) | Tuỳ model | Tuỳ model tải về (repo không nêu VI) | CPU/CUDA | Host các model VITS/ONNX mà engine khác không có ([sherpa-onnx.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/sherpa-onnx.md)) |

### 2b. Voice convert / ASR / dịch (để tham khảo)

- **Đổi giọng (speech-to-speech)**: endpoint `POST /convert` chạy ASR → TTS clone theo profile →
  `atempo` cho khớp thời lượng gốc. Đây không phải voice conversion âm học
  ([VS/backend/api/routers/voice_convert.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/routers/voice_convert.py)).
  Có thêm hậu xử lý **RVC** tuỳ chọn, tắt mặc định, bật bằng `OMNIVOICE_RVC_ENABLED=1` cùng file `.pth`/`.index`
  ([VS/backend/services/rvc.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/rvc.py)).
- **ASR**: WhisperX (mặc định cho dub vì có timestamp từng từ + diarization), Faster-Whisper (MIT),
  Parakeet (CC-BY-4.0, 25 ngôn ngữ châu Âu), FunASR SenseVoice, Moonshine (MIT), Sherpa streaming.
- **Dịch**: Argos (offline), **NLLB-200 (CC-BY-NC, không dùng thương mại được)**, Google/MyMemory (free,
  online), DeepL/Microsoft (cần key), LLM tương thích OpenAI
  ([VS/docs/dubbing/translation-engines.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/dubbing/translation-engines.md)).

---

## 3. Kỹ thuật đáng học

Mỗi mục chỉ mô tả ý tưởng. Muốn xem cài đặt thì mở link.

### 3.1 Chia văn bản dài thành đoạn (unlimited length)
- Mặc định mỗi đoạn tối đa **800 ký tự**. Ưu tiên cắt ở cuối câu, sau đó ở dấu phẩy/mệnh đề, cuối cùng
  mới cắt cứng. Không bao giờ cắt giữa một tag `[...]`. Đoạn chỉ có dấu câu được gộp vào đoạn bên cạnh.
- Với chữ dày đặc (CJK, Hangul), giới hạn ký tự chia cho 2,5 vì mỗi ký tự là một âm tiết. Tiếng Việt
  dùng chữ Latin nên giữ nguyên 800.
- Khi ghép các đoạn: cắt im lặng hai đầu mỗi đoạn (ngưỡng -40 dB, chừa lại 40 ms) rồi **crossfade tuyến tính
  50 ms**. Đoạn nào bị rơi được báo qua header `X-OmniVoice-Dropped-Chunks` thay vì im lặng bỏ qua.
- Link: [VS/backend/services/chunked_tts.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/chunked_tts.py) (dòng 30–33, 133).
  Hằng số và ý tưởng gốc lấy từ dự án MIT **voicebox** (jamiepine/voicebox). Có thể học trực tiếp ở nguồn MIT đó.

### 3.2 Chuẩn hoá văn bản trước TTS
- Họ chỉ chuẩn hoá ở những chỗ chắc chắn đúng. Mọi trường hợp mơ hồ (`1,000`, `3-5`, `v2`, `007`, ID 7+
  chữ số) đều để nguyên. Hàm chuẩn hoá có tính luỹ đẳng (chạy hai lần cho cùng kết quả) và bỏ qua các tag `[...]`.
- **Riêng tiếng Việt:** họ **cố ý không** dùng `num2words` cho VI (issue #1139), vì thư viện này dùng sai
  chữ "lẻ" cho năm 2001–2099 (ví dụ 2024 thành "hai nghìn lẻ hai mươi bốn") và không có dạng đọc năm.
  Vì vậy họ để nguyên chữ số cho model tự đọc. Nếu tự viết bộ chuẩn hoá VI thì phải xử lý "linh/lẻ"
  thật cẩn thận.
- `/generate` chuẩn hoá **Unicode NFC** cho văn bản đầu vào (issue #502). Tiếng Việt dán từ nguồn khác
  thường ở dạng NFD (dấu tách rời), khiến giọng đọc bị méo. Bài học: **luôn NFC hoá trước khi đưa vào TTS.**
- Link: [VS/backend/services/text_normalization.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/text_normalization.py#L130-L140),
  [VS/backend/api/routers/generation.py#L1767-L1773](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/routers/generation.py#L1767-L1773).
  Với ngôn ngữ mà num2words không hỗ trợ, họ tự viết bộ đọc số riêng (ví dụ Malayalam trong `number_words_ml.py`).

### 3.3 Từ điển phát âm và markup nhẹ
- Từ điển dạng `{từ: cách đọc}`. Thay nguyên từ, không phân biệt hoa thường, khoá dài nhất được ưu tiên.
  Toàn bộ dùng một regex alternation duy nhất nên không bị ReDoS. Với chữ viết không có dấu cách (CJK, Thái)
  thì bỏ ranh giới từ.
- Thứ tự xử lý: **chuẩn hoá → từ điển → ghi đè inline `[[…]]`**. Lựa chọn của người dùng luôn được áp sau cùng.
- Có API CRUD `/pronunciation`, hỗ trợ test, import và export.
- Markup "SSML-lite" trong một dòng: `[slow]`, `[fast]`, `[emphasis]`, `[spell]`, `[pause 300ms]`.
  Tag lồng nhau thì tag trong cùng thắng.
- Link: [VS/backend/services/pronunciation.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/pronunciation.py),
  [VS/backend/services/ssml_lite.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/ssml_lite.py),
  [VS/backend/api/routers/pronunciation.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/routers/pronunciation.py).

### 3.4 Clone: mẫu tham chiếu
- Mẫu nên dài **5–15 s, giọng sạch**. Người dùng được tải lên tối đa 75 s. Cách engine xử lý mẫu dài:
  - **OmniVoice** dùng tối đa 20 s, chọn **đoạn 15 s có nhiều tiếng nói nhất** (`best_window`) rồi tự ASR
    để lấy transcript.
  - **VoxCPM2** cắt im lặng hai đầu (ngưỡng -50 dBFS, chừa 50 ms), sau đó giữ 30 s đầu (`head`).
  - Nếu gửi kèm transcript cho cả clip dài mà engine lại cắt bớt clip, transcript sẽ không khớp.
    Lúc đó họ trả lỗi `[clone_ref_too_long]` chứ không âm thầm cho sai.
- Khi lồng tiếng: tách vocals bằng Demucs → diarization → với mỗi speaker chọn đoạn dài nhất và sạch nhất
  (ngưỡng 5 s, lý tưởng 8 s, trần 15 s). Lát nhỏ hơn 1,5 s bị bỏ. Lát nằm sát lượt nói của người khác
  (dưới 0,3 s) bị ưu tiên thấp hơn để không lẫn giọng. Nếu muốn clone riêng cho từng câu thì mẫu tối thiểu là 3 s.
- Cache "voice prompt" đã mã hoá theo (file mẫu, transcript), dùng LRU 8 mục và lưu cả ra đĩa.
  Nhờ vậy lần gọi sau không phải mã hoá lại.
- Link: [VS/backend/services/speaker_clone.py#L32-L60](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/speaker_clone.py#L32-L60),
  [VS/backend/services/tts_backend.py#L1545](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/tts_backend.py#L1545),
  bảng "Reference clip length" trong [VS/docs/engines/README.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/engines/README.md).
  Hồ sơ giọng còn có cờ **consent/attestation** để xác nhận đã được phép clone (route `/profiles/{id}/consent`).

### 3.5 API tương thích OpenAI `/v1/audio/speech`
- Dùng thay thẳng cho OpenAI: SDK `openai`, LiveKit, pipecat, n8n, litellm… chỉ cần đổi `base_url`.
- `model` nhận ID engine (`omnivoice`, `voxcpm2`, …). Các tên `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` được hiểu
  là "engine đang bật". `voice` nhận ID hoặc tên profile giọng. Tên giọng OpenAI (alloy, nova…) được ánh xạ
  về giọng mặc định để client cũ không bị lỗi. Nếu nhiều profile trùng tên thì trả 409 kèm danh sách ID.
- Lỗi trả theo đúng khuôn OpenAI `{error:{message,type,param,code}}`, mã 400 (không phải 422).
- Field mở rộng: `language`, `instruct`, `description` (voice design), `duration`, `seed`, `num_step`
  (mặc định 16, chất lượng cao là 32), `guidance_scale` (mặc định 2.0), `denoise`.
- Link: [VS/backend/api/routers/openai_compat.py#L243](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/routers/openai_compat.py#L243) (schema), dòng 651 (handler).

### 3.6 Streaming
- `/v1/audio/speech` có `stream_format=audio|sse`, nhưng đây chỉ là **giả stream**: sinh xong toàn bộ audio
  rồi mới cắt thành gói 32 KB để gửi.
- **Stream thật** dùng `WS /ws/tts`: chuẩn hoá cả văn bản một lần → chia câu (SentenceChunker port từ
  Patter, MIT, xử lý được viết tắt, số thập phân, URL, dấu câu CJK; câu ngắn hơn 20 ký tự được gộp) →
  sinh từng câu → gửi PCM16 24 kHz ngay khi xong. Cuối cùng gửi `{type:"done", ttfa_ms, rtf}`.
  Mục tiêu TTFA dưới 100 ms khi model đã nóng.
- `/generate` có `stream=true`, trả NDJSON (start → chunk base64 → done). File WAV cuối vẫn đi qua cùng
  đường hoàn thiện như bình thường.
- Họ thừa nhận OmniVoice là model diffusion nên **không stream token thật**. Cần realtime thì nên dùng
  Edge TTS hoặc cloud ([engines-comparison.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/.claude/skills/omnivoice/references/engines-comparison.md)).
- Link: [VS/backend/api/routers/tts_stream.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/routers/tts_stream.py),
  [VS/backend/services/sentence_chunker.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/sentence_chunker.py).

### 3.7 Pipeline lồng tiếng video
1. Nhập video (upload hoặc URL qua yt-dlp). Cache theo hash nội dung.
2. Tách vocals/nhạc nền bằng **Demucs**.
3. Chạy ASR **WhisperX** (timestamp từng từ) và diarization **pyannote** (model gated trên HF, cần `HF_TOKEN`).
4. Dịch (Argos/NLLB/Google/LLM). Chế độ **Cinematic**: bản dịch sát nghĩa → LLM phê bình → LLM viết lại
   cho hợp lời thoại phim, giữ cả ba cột để người dùng so sánh
   ([translator.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/translator.py)).
   Có thể dán bản dịch ngoài (SRT, danh sách đánh số, hoặc từng dòng).
5. **Ước lượng trước khi TTS** ([duration_planner.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/duration_planner.py)):
   tốc độ ký tự/giây tự hiệu chỉnh theo các câu đã sinh trong job. Mỗi câu được gắn nhãn fits/tight/impossible,
   câu "impossible" có thể nhờ LLM rút gọn ([speech_rate.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/speech_rate.py)).
6. Sinh TTS cho từng câu bằng giọng clone theo speaker.
7. **Smart Fit** ([fit_planner.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/fit_planner.py#L62-L77)):
   trước hết mượn khoảng lặng trước câu kế (chừa 50 ms). Nếu cần tăng tốc ≤ 1,2× thì chỉ tăng tốc audio.
   Nếu hơn thì chia đôi theo căn bậc hai: audio tối đa 1,5×, video chậm lại tối đa 2×. Phần còn dư thì cắt.
   Chế độ chỉ chỉnh audio cho tối đa 1,8×. Video được retime bằng ffmpeg `setpts`, chia batch khi có hơn ~50
   đoạn, có xử lý VFR ([video_retime.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/video_retime.py)).
8. **QC vòng 2**: chạy ASR lại trên audio đã lồng, so với văn bản yêu cầu và gắn cờ những câu lệch.
   Văn bản đã sinh vẫn là chuẩn ([dub_qc.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/dub_qc.py)).
9. Trộn với nhạc nền, xuất MP4, SRT và phụ đề karaoke ASS. Chỉ sinh lại những câu đã sửa ("Regen N changed").

### 3.8 Quản lý model / bộ nhớ / worker
- **Mỗi lúc chỉ giữ một engine TTS trong bộ nhớ** (`OMNIVOICE_SINGLE_ENGINE_RESIDENT=1`). Trước khi nạp
  engine mới, engine cũ được unload. Trên máy 16 GB, hai engine cùng nạp sẽ gây OOM
  ([engine_memory.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/engine_memory.py)).
- Sau **15 phút không dùng** thì model bị giải phóng khỏi GPU, gọi lại mất 5–10 s để khởi động. Có tuỳ chọn
  chuyển model sang RAM sau mỗi lần sinh (`OMNIVOICE_OFFLOAD_AFTER_GENERATION`).
- Số job chạy song song trên GPU được tính theo VRAM trống: 1 worker cho mỗi 5 GB, tối đa 4. MPS và CPU luôn
  là 1. Không nên tăng trên card ≤ 10 GB.
- Kiểm tra RAM trống chỉ để **cảnh báo**, không chặn việc nạp model, vì ước lượng không chính xác
  ([memory_budget.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/memory_budget.py)).
- Có giới hạn thời gian tính toán: đồng hồ chỉ chạy khi worker bắt đầu làm job, và giới hạn tăng theo độ dài
  văn bản. Lỗi kèm `Retry-After: 30` và header `X-OmniVoice-Retryable`.
- Engine có xung đột thư viện thì chạy trong **sidecar venv riêng**: giao tiếp bằng JSON có tiền tố độ dài,
  mỗi frame tối đa 64 MB, có allowlist các thao tác, dùng Job Object/nhóm tiến trình để dọn dẹp khi
  backend chết ([subprocess_backend.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/subprocess_backend.py)).
- Tải model: dùng huggingface_hub (hf-xet), revision ghim theo SHA. Thử hf-mirror.com cho mạng bị chặn.
  Nếu tải hỏng ở gần cuối thì thử lại một lần với client mới.

### 3.9 Watermark
- **Watermark ẩn bằng AudioSeal (Meta)**, mã hoá 16 bit, chịu được nén và resample. **Bật mặc định** cho
  mọi đường ra (`/generate`, `/v1/audio/speech`, từng câu của `/ws/tts`). AudioSeal nhúng kém với câu ngắn
  dưới 1 s.
- Có watermark nghe được (âm báo ở đầu, tắt mặc định), logo trên video (bật mặc định), và API
  `POST /watermark/detect` để kiểm tra.
- Link: [VS/backend/services/watermark.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/services/watermark.py),
  [VS/backend/api/routers/watermark.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/routers/watermark.py).
  Lưu ý: AudioSeal có giấy phép riêng, cần kiểm tra trước khi dùng.

### 3.10 Một số chi tiết khác
- Các thông báo lỗi trả cho người dùng là **câu đã soạn sẵn theo từng loại** (chưa cài, chưa chấp nhận
  license, sai nền tảng, thiếu file…). Họ không đưa nguyên văn lỗi từ probe ra ngoài vì có thể lộ đường dẫn
  hoặc token ([public_engine_metadata.py](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/backend/api/public_engine_metadata.py)).
- Engine có giấy phép hạn chế (Supertonic, PocketTTS, Breeze) bị khoá cho đến khi người dùng **bấm chấp nhận
  license trong app**.
- Chọn sai ngôn ngữ mà engine không hỗ trợ thì dừng ngay và báo rõ, không đọc ra sai ngôn ngữ.

---

## 4. Dùng VoiceStudio như dịch vụ cục bộ

Đây là cách hợp lệ để tận dụng VoiceStudio: người dùng tự cài VoiceStudio, app MIT của mình chỉ **gọi qua
HTTP** mà không nhúng, link hay sửa mã AGPL. Nếu chỉ chạy bản không sửa và gọi qua mạng thì nghĩa vụ AGPL
§13 (cung cấp mã nguồn cho người dùng qua mạng) không phát sinh cho app của mình. Nếu **sửa** VoiceStudio
rồi cho người khác dùng qua mạng thì phải công bố mã nguồn bản đã sửa.

- **Địa chỉ:** `http://127.0.0.1:3900`. Gọi từ loopback không cần key. Nếu mở ra LAN thì đặt
  `OMNIVOICE_API_KEY` ở backend và gửi `Authorization: Bearer <key>`, không truyền key qua query string
  ([VS/docs/api-auth.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/api-auth.md)).
- **Kiểm tra / khám phá:**
  - `GET /engines/tts` trả danh sách engine, trạng thái, `max_ref_seconds`, `ref_strategy` và `preset_voices`.
  - `GET /v1/models` và `GET /v1/audio/voices` trả danh sách model và giọng.
  - `GET /system/info` trả thông tin hệ thống, trong đó có `idle_timeout_seconds`.
  - `GET /.well-known/voicestudio-speech` mô tả khả năng của dịch vụ.

| Mục đích | Endpoint | Payload chính |
|---|---|---|
| TTS kiểu OpenAI | `POST /v1/audio/speech` (JSON) | `model` ("omnivoice"/"voxcpm2"/… hoặc "tts-1"), `input` (≤ 4096 ký tự), `voice` (ID/tên profile hoặc "default"), `response_format` (mp3/opus/aac/flac/wav/pcm; định dạng nén cần ffmpeg), `speed` 0,25–4, `language` ("vi"), tuỳ chọn `instruct`, `seed`, `num_step`, `guidance_scale`, `stream_format` |
| TTS gốc, có clone ngay và chia đoạn dài | `POST /generate` (multipart) | `text`, `language`, `ref_audio` (file) + `ref_text` **hoặc** `profile_id`, `engine`, `speed`, `num_step`, `guidance_scale`, `seed`, `max_chunk_chars` (mặc định 800), `crossfade_ms` (mặc định 50), `pronounce`, `stream`. Trả `audio/wav`, kèm header `X-Audio-Id`, `X-Audio-Duration`, `X-Seed`, `X-Gen-Time` |
| Tạo giọng clone lưu lại | `POST /profiles` (multipart) | `name`, `ref_audio`, `ref_text`, `language`, `kind=clone` → nhận `id` để dùng làm `voice`/`profile_id` |
| Stream câu theo câu | `WS /ws/tts` | Gửi JSON `{text, voice?, engine?, language?, speed?}`. Nhận các frame nhị phân PCM16 24 kHz, sau đó là JSON `done` |
| Đổi giọng một đoạn ghi âm | `POST /convert` | clip nguồn + profile đích |
| Chép lời | `POST /v1/audio/transcriptions` | Giống OpenAI (`file`, `model=whisper-1`, …) |
| Từ điển phát âm | `GET/POST/PUT/DELETE /pronunciation` | Quản lý các mục `{từ, cách đọc}` |
| Agent | MCP stdio `python -m backend.mcp_shim` hoặc HTTP `/mcp/` | Xem [VS/docs/mcp.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/mcp.md) |

Ví dụ do chúng tôi tự viết (không lấy từ repo của họ):

```bash
curl -s http://127.0.0.1:3900/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","input":"Xin chào, đây là giọng đọc thử.","voice":"default","language":"vi","response_format":"wav"}' \
  -o out.wav
```

Mẹo khi tích hợp:
- NFC hoá văn bản tiếng Việt trước khi gửi. `/generate` tự làm việc này, nhưng nên tự làm để chắc chắn.
- Văn bản dài hơn 4096 ký tự thì dùng `/generate`, vì endpoint này tự chia đoạn. Hoặc tự chia ở phía client.
- Gặp lỗi 503 kèm `Retry-After` thì retry, vì GPU đang bận.
- Lần gọi đầu có thể tải model ~2,4 GB, nên đặt timeout dài hoặc gọi trước một lần để làm nóng.
- Mỗi file đầu ra đều có watermark AudioSeal (bật mặc định). Muốn tắt thì đổi trong cài đặt, nhưng cần cân
  nhắc vấn đề minh bạch nội dung AI.

---

## 5. Lưu ý giấy phép

| Thành phần | Giấy phép | Hệ quả cho repo MIT của chúng ta |
|---|---|---|
| App VoiceStudio (`electron/`, `backend/`, `native/`, `scripts/`…) | **AGPL-3.0-only** ([LICENSE-NOTICE.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/LICENSE-NOTICE.md)) | **Không chép mã** vào repo MIT. Chỉ được tóm tắt ý tưởng và dẫn link. Gọi qua HTTP thì được. Họ có bán license thương mại cho ai muốn nhúng vào sản phẩm đóng |
| Gói Python `omnivoice/` (mã model) | Apache-2.0 | Tương thích với MIT nếu giữ NOTICE. Lấy từ upstream k2-fsa, đừng lấy từ bản trong repo AGPL |
| **Trọng số OmniVoice** (k2-fsa/OmniVoice) | **CC-BY-NC** (không ghi rõ version). Tokenizer âm thanh thêm **Boson Higgs Audio 2 + Meta Llama 3**, và điều khoản Higgs cấm dùng đầu ra để cải thiện LLM khác | **Không dùng cho mục đích thương mại**: không bán, không dùng trong video kiếm tiền. Phải ghi công tác giả và chèn nguyên văn câu "Built with…" theo yêu cầu ([model-credits.md](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/model-credits.md)) |
| OmniVoice-GGUF | CC-BY-NC-4.0 + Higgs/Llama | Giống trên |
| Breeze-TTS-2 (audio.cpp) | Research & Non-Commercial | Không thương mại, kể cả khi tự host |
| NLLB-200 (dịch) | CC-BY-NC-4.0 | Không thương mại |
| OuteTTS (MLX) | CC-BY-NC-SA-4.0 + Llama 3.2 | Không thương mại |
| Supertonic-3 | OpenRAIL-M | Được dùng nhưng có danh sách mục đích bị cấm. Phải đọc kỹ |
| PocketTTS | Code MIT / trọng số CC-BY-4.0, gated + AUP | Thương mại được, phải ghi công và tuân AUP |
| Parakeet (ASR), WeSpeaker | CC-BY-4.0 | Phải ghi công |
| VoxCPM2, Confucius4, MOSS (Nano / v1.5), dots.tts, CosyVoice 3, KittenTTS, Kokoro | Nhãn Apache-2.0 | Có vẻ thương mại được, **nhưng repo VoiceStudio ghi `unreviewed`**. Phải tự đọc model card và các thành phần đi kèm (vocoder, tokenizer, dữ liệu huấn luyện) |
| GPT-SoVITS, Faster-Whisper, Moonshine, pyannote 3.x | MIT | Thương mại được. Riêng model pyannote gated, phải chấp nhận điều kiện trên HF |
| PyAV wheel (kèm FFmpeg, x264/x265) | LGPL/GPL tuỳ build | Họ còn ghi "chưa giải quyết" về việc phân phối lại ([pyav audit](https://github.com/debpalash/VoiceStudio/blob/28bf2c7a83b8a64836297340c52a45d716684aed/docs/licensing/pyav-15.1.0-audit.md)) |

Nguyên tắc chung mà VoiceStudio tự nêu:
- License của app **không** cấp quyền dùng trọng số.
- Nhãn trên HF chỉ là tuyên bố của upstream, không phải giấy phép đã được kiểm duyệt.
- Giấy phép của bản convert (GGUF, MLX, ONNX) có thể khác bản gốc.
- Chỉ clone giọng khi có sự đồng ý của chủ giọng.
