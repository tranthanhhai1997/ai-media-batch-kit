"""OmniVoice zero-shot voice clone engine (k2-fsa/OmniVoice).

⚠ LICENSE: the OmniVoice CODE is Apache-2.0 but the MODEL WEIGHTS are CC-BY-NC (non-commercial), and its audio
tokenizer carries extra terms (Boson Higgs Audio 2, Meta Llama 3). Do NOT use the output commercially (sales,
monetised videos, paid apps). Commercial-friendly local models with Vietnamese: VoxCPM2, Confucius4-TTS
(Apache-2.0 labels — still read their model cards). See skills/ai-voice-free/references/voice-clone.md.

API used (checked against the source of pip package `omnivoice` 0.2.1, 10/2026 — re-check after upgrades):
    OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device, dtype=torch.float16)
    prompt = model.create_voice_clone_prompt(ref_audio=path, ref_text=text_or_None)   # None → needs load_asr_model()
    audios = model.generate(text=..., language="vi", voice_clone_prompt=prompt, speed=1.0)  # → list[np.ndarray]
    model.sampling_rate                                                                 # 24 kHz
If a future version renames these, only `_load()` and `_generate()` below need changing.

Production fixes kept here (A):
- Vietnamese text normalisation first (OmniVoice reads "199.000đ" / "12/5" / "9h30" wrongly).
- Long text: OmniVoice estimates the output length from the text; long inputs came out with the last syllable
  CUT ("xứng đáng" → "xứng"). Split at sentences into ≤ 220-char pieces, same seed for every piece (same timbre),
  join with 0.18 s silence, and slow down 4 % (speed × 0.96) so sentence endings are not clipped.
- Environment set BEFORE torch/librosa import: NUMBA_CACHE_DIR on a real (realpath) writable dir — numba's cache
  write through a directory junction failed and retried ~2e9 times, growing the Windows kernel non-paged pool
  ~1 GB/min until reboot; CUDA_MODULE_LOADING=LAZY; KMP_DUPLICATE_LIB_OK for mixed OpenMP runtimes.
"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import threading
from pathlib import Path

MAX_CHARS = 220
GAP_S = 0.18
SPEED_FACTOR = 0.96


def setup_env(cache_root: str | None = None) -> None:
    """Call before importing torch/librosa (engine does it on first load)."""
    root = Path(os.path.realpath(cache_root or os.path.join(tempfile.gettempdir(), "omnivoice_cache")))
    (root / "numba").mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NUMBA_CACHE_DIR", str(root / "numba"))
    os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def split_text(text: str, max_chars: int = MAX_CHARS) -> list[str]:
    """Sentences first, then commas; pack back up to max_chars."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= max_chars:
        return [text] if text else []
    units = []
    for sent in re.split(r"(?<=[.!?…])\s+", text):
        if len(sent) <= max_chars:
            units.append(sent)
            continue
        cur = ""
        for part in re.split(r"(?<=[,;:])\s+", sent):
            if cur and len(cur) + 1 + len(part) > max_chars:
                units.append(cur)
                cur = part
            else:
                cur = f"{cur} {part}".strip()
        if cur:
            units.append(cur)
    chunks, cur = [], ""
    for u in units:
        if cur and len(cur) + 1 + len(u) > max_chars:
            chunks.append(cur)
            cur = u
        else:
            cur = f"{cur} {u}".strip()
    if cur:
        chunks.append(cur)
    return [c for c in chunks if c.strip()]


def stable_seed(*parts: str) -> int:
    """Same voice + same text → same seed → same result on re-render."""
    return int(hashlib.md5("\x1f".join(parts).encode("utf-8")).hexdigest()[:8], 16)


class OmniVoiceEngine:
    """Holds the model (≈2.3 GB RAM + VRAM once loaded — load lazily, unload when idle; see worker.py)."""

    def __init__(self, model_id: str = "k2-fsa/OmniVoice", device: str | None = None, asr: bool = False):
        self.model_id, self.device, self.asr = model_id, device, asr
        self.model = None
        self._prompts: dict[str, object] = {}  # reference wav + text → reusable clone prompt
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def _load(self):
        setup_env()
        import torch
        from omnivoice import OmniVoice
        dev = self.device or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if dev.startswith("cuda") else torch.float32
        self.model = OmniVoice.from_pretrained(self.model_id, device_map=dev, dtype=dtype, load_asr=self.asr)
        self.device = dev

    def load(self) -> None:
        with self._lock:
            if self.model is None:
                self._load()

    def unload(self) -> None:
        """Free RAM/VRAM. The worker exits instead (more reliable on Windows), this is for in-process use."""
        with self._lock:
            self.model = None
            self._prompts.clear()
        try:
            import gc
            import torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    @property
    def sample_rate(self) -> int:
        return int(getattr(self.model, "sampling_rate", 24_000))

    def _prompt(self, ref_wav: str, ref_text: str | None):
        key = f"{os.path.realpath(ref_wav)}|{os.path.getmtime(ref_wav)}|{ref_text or ''}"
        if key not in self._prompts:
            self._prompts[key] = self.model.create_voice_clone_prompt(ref_audio=ref_wav, ref_text=ref_text or None)
        return self._prompts[key]

    def _generate(self, text: str, prompt, lang: str | None, speed: float, seed: int):
        import torch
        torch.manual_seed(seed)  # same seed per chunk → consistent timbre across chunks
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        out = self.model.generate(text=text, language=lang, voice_clone_prompt=prompt, speed=speed)
        return out[0]

    def synthesize(self, text: str, ref_wav: str, ref_text: str | None = None, lang: str = "vi",
                   speed: float = 1.0, seed: int | None = None, normalize: bool = True):
        """Long text → one float32 numpy array at self.sample_rate."""
        import numpy as np
        self.load()
        if normalize and lang.lower().startswith("vi"):
            from .vi_text_norm import normalize_vi
            text = normalize_vi(text) or text
        chunks = split_text(text)
        if not chunks:
            raise ValueError("empty text")
        seed = stable_seed(os.path.basename(ref_wav), text) if seed is None else seed
        with self._lock:
            prompt = self._prompt(ref_wav, ref_text)
            pieces = [np.asarray(self._generate(c, prompt, lang.split("-")[0], speed * SPEED_FACTOR, seed), dtype=np.float32).reshape(-1)
                      for c in chunks]
        gap = np.zeros(int(self.sample_rate * GAP_S), dtype=np.float32)
        out = []
        for i, p in enumerate(pieces):
            if i:
                out.append(gap)
            out.append(p)
        return np.concatenate(out)

    def synthesize_to_file(self, out_wav: str, *args, **kwargs) -> dict:
        import numpy as np
        y = self.synthesize(*args, **kwargs)
        import wave
        with wave.open(str(out_wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.sample_rate)
            w.writeframes((np.clip(y, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes())
        return {"wav": str(out_wav), "duration_s": round(len(y) / self.sample_rate, 3), "sample_rate": self.sample_rate}
