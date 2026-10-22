"""Clone a voice from a sample file and read a (long) text with it → WAV.

    cd python/local_tts
    python -m omnivoice_clone.cli --ref sample.mp4 --text-file script.txt --out out.wav --lang vi --asr small
    python -m omnivoice_clone.cli --ref clean.wav --ref-text "Lời đúng của mẫu." --text "Xin chào." --out a.wav --skip-prepare

⚠ OmniVoice weights are CC-BY-NC: personal / research use only. Only clone a voice you have the right to use
(your own, or with the speaker's consent).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="OmniVoice zero-shot clone (non-commercial weights)")
    ap.add_argument("--ref", required=True, help="voice sample (any audio/video ffmpeg reads)")
    ap.add_argument("--ref-text", default=None, help="exact words spoken in the sample (best quality)")
    ap.add_argument("--text", default=None)
    ap.add_argument("--text-file", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default="vi")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--demucs", action="store_true", help="remove background music from the sample")
    ap.add_argument("--asr", default=None, help="faster-whisper model to transcribe the sample (small/medium)")
    ap.add_argument("--skip-prepare", action="store_true", help="--ref is already a clean 24 kHz sample")
    ap.add_argument("--device", default=None)
    a = ap.parse_args(argv)

    text = a.text if a.text is not None else open(a.text_file, encoding="utf-8").read() if a.text_file else None
    if not text or not text.strip():
        ap.error("give --text or --text-file")

    from .engine import OmniVoiceEngine, setup_env
    setup_env()
    ref, ref_text = a.ref, a.ref_text
    if not a.skip_prepare:
        from .prepare_reference import SampleError, prepare_reference
        ref = os.path.join(tempfile.gettempdir(), f"ovc_ref_{os.getpid()}.wav")
        try:
            r = prepare_reference(a.ref, ref, a.lang, a.ref_text, a.demucs, a.asr)
        except SampleError as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
            return 2
        ref_text = r["ref_text"]
        print(f"[ref] {r['duration_s']} s, {r['info']}, text={ref_text!r}", file=sys.stderr)
    # ref_text None → OmniVoice needs its own ASR model loaded (asr=True), slower and less reliable than ours.
    eng = OmniVoiceEngine(device=a.device, asr=not ref_text)
    out = eng.synthesize_to_file(a.out, text, ref, ref_text, a.lang, a.speed, a.seed)
    print(json.dumps({"ok": True, **out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
