"""Clean a voice-clone reference sample: the step that decides clone quality more than the model does.

What it fixes (all seen in production, A):
- The old code kept the FIRST 12 s (`ffmpeg -t 12`). A clip that starts with an intro gave a "reference"
  that was 100 % music and 0 % speech → the clone sounded like nothing. Now: pick the 6–15 s window with the
  most speech, cut at pauses ≥ 260 ms (never mid-word), reject samples with < 2.5 s of speech.
- Background music in the sample is cloned too. Optional Demucs separation (vocals) when music is loud
  (music − voice > −20 dB). Demucs runs in a CHILD process: loading its torch next to another CUDA stack in
  the same process failed with WinError 127 on cudnn DLLs (A).
- Whisper with auto language hallucinated "Hãy subscribe cho kênh …" on music and it was saved as the
  reference transcript. Now: language is FORCED, and the transcript is rejected if empty, if it matches a
  known hallucination phrase, or if it has < 4 letters per second of audio.
- Level: speech RMS ≈ −20 dBFS, peak ≤ −1 dBFS, 10 ms fades, 24 kHz mono 16-bit.

    python -m omnivoice_clone.prepare_reference sample.mp4 ref.wav --lang vi [--demucs] [--asr small]

Needs: ffmpeg on PATH (or FFMPEG_PATH), numpy. Optional: demucs (pip install demucs), faster-whisper.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SR = 24_000
HOP = SR // 50  # 20 ms frames

HALLUCINATION = re.compile(
    r"subscribe|đăng ký kênh|đăng kí kênh|like và share|bấm chuông|"
    r"cảm ơn các bạn đã (theo dõi|xem|lắng nghe)|hẹn gặp lại các bạn|"
    r"thanks for watching|thank you for watching|amara\.org|vietsub|phụ đề|subtitles? by",
    re.I)


class SampleError(ValueError):
    """Raised with a user-facing message when the sample cannot be used."""


def ffmpeg_exe() -> str:
    exe = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not exe:
        raise SampleError("ffmpeg not found (install it or set FFMPEG_PATH)")
    return exe


def run_ffmpeg(args: list[str]) -> None:
    kw = {"creationflags": 0x08000000} if os.name == "nt" else {}  # CREATE_NO_WINDOW: no console flash on Windows
    p = subprocess.run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", *args],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **kw)
    if p.returncode != 0:
        raise SampleError("ffmpeg failed: " + p.stderr.decode("utf-8", "ignore")[-300:])


def read_wav(p):
    import numpy as np
    with wave.open(str(p), "rb") as w:
        ch = w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return x.reshape(-1, ch).mean(axis=1) if ch > 1 else x


def write_wav(p, y) -> None:
    import numpy as np
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(y, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes())


def frame_db(x):
    import numpy as np
    n = len(x) // HOP
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    fr = x[: n * HOP].reshape(n, HOP)
    return 20.0 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)


def voiced_segments(db, min_gap=13, min_len=5):
    """Frames above (95th percentile − 32 dB) → [start, end) runs; gaps < min_gap frames (260 ms) are bridged."""
    import numpy as np
    if len(db) == 0:
        return []
    thr = max(float(np.percentile(db, 95)) - 32.0, -50.0)
    runs, start = [], None
    for i, v in enumerate(db > thr):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([start, i])
            start = None
    if start is not None:
        runs.append([start, len(db)])
    merged = []
    for s, e in runs:
        if merged and s - merged[-1][1] < min_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [r for r in merged if r[1] - r[0] >= min_len]


def best_window(segs, db, min_s=6, max_s=15):
    """Window of whole segments with the most speech, 6–15 s, short windows penalised."""
    import numpy as np
    max_w, min_w = max_s * 50, min_s * 50
    best, best_score = None, -1.0
    for i in range(len(segs)):
        speech = 0
        for j in range(i, len(segs)):
            span = segs[j][1] - segs[i][0]
            if span > max_w and j > i:
                break
            speech += segs[j][1] - segs[j][0]
            score = speech - (0.5 * (min_w - span) if span < min_w else 0)
            if score > best_score:
                best, best_score = (segs[i][0], segs[j][1]), score
    a, b = best
    if b - a > 20 * 50:  # one long breathless run: cut at the quietest frame between 10 and 15 s
        lo, hi = a + 10 * 50, min(a + 15 * 50, b)
        b = lo + int(np.argmin(db[lo:hi])) if hi > lo else a + 15 * 50
    return a, b


# Demucs in a child process (see module doc). Uses the CLI, which exists in the pip release (demucs 4.0.x).
def separate_vocals(full_wav: Path, work: Path):
    out = work / "demucs"
    kw = {"creationflags": 0x08000000} if os.name == "nt" else {}
    p = subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(out), str(full_wav)],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600, **kw)
    stem = out / "htdemucs" / full_wav.stem
    voc, mus = stem / "vocals.wav", stem / "no_vocals.wav"
    if p.returncode != 0 or not voc.exists() or not mus.exists():
        raise RuntimeError(p.stderr.decode("utf-8", "ignore").strip()[-300:] or f"demucs exit {p.returncode}")
    v24, m24 = work / "voc24.wav", work / "mus24.wav"
    run_ffmpeg(["-i", str(voc), "-ac", "1", "-ar", str(SR), "-acodec", "pcm_s16le", str(v24)])
    run_ffmpeg(["-i", str(mus), "-ac", "1", "-ar", str(SR), "-acodec", "pcm_s16le", str(m24)])
    return v24, m24


def transcribe(wav: Path, lang: str, model: str = "small", device: str = "auto") -> str:
    """faster-whisper with the language FORCED (auto-detect hallucinates on music). Returns '' if unusable."""
    from faster_whisper import WhisperModel  # optional dependency
    m = WhisperModel(model, device=device, compute_type="auto")
    segs, _ = m.transcribe(str(wav), language=lang, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    return re.sub(r"\s+", " ", " ".join(s.text.strip() for s in segs)).strip()


def check_transcript(text: str, duration_s: float) -> str:
    letters = sum(ch.isalpha() for ch in text)
    if not text or HALLUCINATION.search(text) or (duration_s > 0 and letters / duration_s < 4.0):
        raise SampleError("No clear speech recognised in the sample (music/noise?). Type the exact "
                              "words of the sample as ref_text, or use a clip with only speech.")
    return text if text[-1] in ".!?…。" else text + "."


def prepare_reference(src, out_wav, lang: str = "vi", ref_text: str | None = None,
                      use_demucs: bool = False, asr_model: str | None = None) -> dict:
    """
    src → out_wav (24 kHz mono). Returns {"wav", "ref_text", "duration_s", "info"}.
    ref_text given → the user typed what the WHOLE clip says → only trim silence/music at both ends (cutting a
    window would break the text/audio match). No ref_text and asr_model set → transcribe the chosen window.
    """
    import numpy as np
    work = Path(tempfile.mkdtemp(prefix="ovc_ref_"))
    try:
        full = work / "full.wav"
        run_ffmpeg(["-i", str(src), "-t", "60", "-vn", "-ac", "1", "-ar", str(SR), "-af", "highpass=f=60",
                    "-acodec", "pcm_s16le", str(full)])
        x = read_wav(full)
        info: dict = {"separated": False}
        signal = x
        if use_demucs:
            try:
                voc, mus = separate_vocals(full, work)
                v, m = read_wav(voc), read_wav(mus)
                n = min(len(v), len(m), len(x))
                v, m = v[:n], m[:n]
                dbv, dbm = frame_db(v), frame_db(m)
                vmask = dbv > max(float(np.percentile(dbv, 95)) - 30.0, -45.0)
                if vmask.any():
                    bg = float(np.median(dbm[vmask]) - np.median(dbv[vmask]))
                    info["bg_db"] = round(bg, 1)
                    if bg > -20.0:  # background clearly audible → use the separated voice
                        signal, info["separated"] = v, True
            except Exception as e:  # Demucs is optional: continue with the raw sample
                info["demucs_error"] = str(e)[:200]
        db = frame_db(signal)
        segs = voiced_segments(db)
        speech_s = sum(e - s for s, e in segs) / 50.0
        info["speech_s"] = round(speech_s, 2)
        if speech_s < 2.5:
            raise SampleError("The sample has almost no speech (music/noise only). Cut a part where one person "
                                  "speaks clearly, 5–20 s.")
        a, b = (segs[0][0], segs[-1][1]) if ref_text else best_window(segs, db)
        s = max(0, a * HOP - int(0.12 * SR))
        e = min(len(signal), b * HOP + int(0.25 * SR))
        y = signal[s:e].astype(np.float32).copy()
        ydb = frame_db(y)
        act = y[: len(ydb) * HOP].reshape(-1, HOP)[ydb > (ydb.max() - 30.0)] if len(ydb) else y[None, :]
        rms = float(np.sqrt((act ** 2).mean())) if act.size else 0.0
        if rms > 1e-5:
            y *= min(0.1 / rms, 30.0)  # speech RMS ≈ −20 dBFS
        pk = float(np.abs(y).max()) if y.size else 0.0
        if pk > 0.89:
            y *= 0.89 / pk  # peak ≤ −1 dBFS
        f = min(int(0.01 * SR), len(y) // 2)
        if f > 0:
            ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)
            y[:f] *= ramp
            y[-f:] *= ramp[::-1]
        write_wav(out_wav, y)
        dur = len(y) / SR
        info["clip"] = [round(s / SR, 2), round(e / SR, 2)]
        text = (ref_text or "").strip()
        if not text and asr_model:
            text = check_transcript(transcribe(Path(out_wav), lang.split("-")[0], asr_model), dur)
        return {"wav": str(out_wav), "ref_text": text or None, "duration_s": round(dur, 2), "info": info}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Clean a voice-clone reference sample")
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--lang", default="vi")
    ap.add_argument("--ref-text", default=None, help="exact words of the WHOLE clip (skips window picking + ASR)")
    ap.add_argument("--demucs", action="store_true", help="separate vocals from music (pip install demucs)")
    ap.add_argument("--asr", default=None, help="faster-whisper model for the transcript, e.g. small / medium")
    a = ap.parse_args(argv)
    try:
        r = prepare_reference(a.src, a.out, a.lang, a.ref_text, a.demucs, a.asr)
    except SampleError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, **r}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
