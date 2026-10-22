"""Kokoro-82M local TTS (Apache-2.0 weights → commercial use allowed; check the model card yourself).

⚠ NO VIETNAMESE. Official Kokoro voices cover English (US/UK), Spanish, French, Hindi, Italian, Japanese,
Brazilian Portuguese and Mandarin. Feeding Vietnamese text to an English Kokoro voice produces gibberish with an
English accent; in (A) this passed silently and only failed later at the timing/subtitle check (speech matched
6 %). So this script REFUSES Vietnamese text — use Edge, Gemini, ai33/Vbee or a Vietnamese model instead.

    pip install kokoro soundfile          # + espeak-ng on the system for some languages
    python kokoro_tts.py --text "Hello there." --voice af_heart --out hello.wav
API used (kokoro 0.9.x, 10/2026, not run in this repo): KPipeline(lang_code=...)(text, voice=..., speed=...)
yields (graphemes, phonemes, audio) per segment, audio = 24 kHz float.
"""
from __future__ import annotations

import argparse
import re
import sys

# voice prefix → pipeline language code ("af_heart" = American female, "bm_george" = British male…)
LANG_BY_PREFIX = {"a": "a", "b": "b", "e": "e", "f": "f", "h": "h", "i": "i", "j": "j", "p": "p", "z": "z"}
_VI = re.compile(r"[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹĩũ]", re.I)


def looks_vietnamese(text: str) -> bool:
    return bool(_VI.search(text or ""))


def synthesize(text: str, voice: str = "af_heart", speed: float = 1.0):
    if looks_vietnamese(text):
        raise ValueError("Kokoro has no Vietnamese voice: use Edge/Gemini/ai33 (Vbee) or a Vietnamese model")
    import numpy as np
    from kokoro import KPipeline
    pipe = KPipeline(lang_code=LANG_BY_PREFIX.get(voice[:1], "a"))
    parts = [np.asarray(audio, dtype=np.float32).reshape(-1) for _, _, audio in pipe(text, voice=voice, speed=speed)]
    if not parts:
        raise RuntimeError("kokoro produced no audio")
    return np.concatenate(parts), 24_000


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Kokoro-82M TTS (no Vietnamese)")
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    y, sr = synthesize(a.text, a.voice, a.speed)
    import soundfile as sf
    sf.write(a.out, y, sr)
    print(f"{a.out}: {len(y) / sr:.2f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
