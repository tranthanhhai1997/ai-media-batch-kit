"""Long-lived OmniVoice worker: JSON lines on stdin → JSON lines on stdout. Logs go to stderr only.

Why a separate process (A, measured 30/09/2026): the model process holds ~2.3 GB RAM / 6.6 GB commit. Started
"warm" at app launch it pushed 8 GB machines into Windows killing processes, even for users who never cloned a
voice (app 3.2 GB → 0.84 GB after the fix). So: NO warm-up at start (model loads on the first request), and
the process EXITS after N idle minutes (default 12; 0 = never). Exiting frees RAM/VRAM reliably; the parent
just restarts the worker on the next request (only that request pays the load time, ~10–20 s on GPU).

Protocol (one JSON object per line):
  → {"id": 1, "op": "synth", "text": "...", "ref_wav": "ref.wav", "ref_text": "...", "lang": "vi",
     "out": "out.wav", "speed": 1.0, "seed": null}
  ← {"id": 1, "ok": true, "wav": "out.wav", "duration_s": 3.2, "sample_rate": 24000}
  → {"id": 2, "op": "prepare", "src": "clip.mp4", "out": "ref.wav", "lang": "vi", "demucs": false, "asr": "small"}
  → {"id": 3, "op": "ping"} | {"op": "unload"} | {"op": "shutdown"}
  ← {"id": .., "ok": false, "error": "...", "code": "SAMPLE" | "FAILED"}

    python -m omnivoice_clone.worker [--idle-min 12] [--warmup] [--device cuda]
Parent side: WorkerClient below (auto-start, auto-restart after idle exit).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time

from .engine import OmniVoiceEngine, setup_env


def serve(idle_min: float = 12.0, warmup: bool = False, device: str | None = None) -> None:
    setup_env()
    # Libraries print to stdout (progress bars, banners) and would corrupt the protocol → keep a private handle
    # to the real stdout and point sys.stdout at stderr.
    proto = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr
    eng = OmniVoiceEngine(device=device)
    last = [time.time()]
    busy = threading.Lock()

    def reply(obj):
        proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto.flush()

    def idle_watch():
        while True:
            time.sleep(30)
            if idle_min > 0 and not busy.locked() and time.time() - last[0] > idle_min * 60:
                print(f"[worker] idle {idle_min} min → exit", file=sys.stderr)
                os._exit(0)  # hard exit: frees CUDA context without waiting for library atexit hooks

    threading.Thread(target=idle_watch, name="ovc-idle", daemon=True).start()
    if warmup:
        eng.load()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            reply({"ok": False, "error": "bad json", "code": "FAILED"})
            continue
        rid, op = req.get("id"), req.get("op")
        last[0] = time.time()
        with busy:
            try:
                if op == "ping":
                    reply({"id": rid, "ok": True, "loaded": eng.loaded, "pid": os.getpid()})
                elif op == "synth":
                    r = eng.synthesize_to_file(req["out"], req["text"], req["ref_wav"], req.get("ref_text"),
                                               req.get("lang", "vi"), float(req.get("speed") or 1.0), req.get("seed"))
                    reply({"id": rid, "ok": True, **r})
                elif op == "prepare":
                    from .prepare_reference import prepare_reference
                    r = prepare_reference(req["src"], req["out"], req.get("lang", "vi"), req.get("ref_text"),
                                          bool(req.get("demucs")), req.get("asr"))
                    reply({"id": rid, "ok": True, **r})
                elif op == "unload":
                    eng.unload()
                    reply({"id": rid, "ok": True})
                elif op == "shutdown":
                    reply({"id": rid, "ok": True})
                    break
                else:
                    reply({"id": rid, "ok": False, "error": f"unknown op {op}", "code": "FAILED"})
            except Exception as e:  # one bad request must not kill the worker
                code = "SAMPLE" if e.__class__.__name__ == "SampleError" else "FAILED"
                reply({"id": rid, "ok": False, "error": str(e)[:500], "code": code})
        last[0] = time.time()


class WorkerClient:
    """Parent-side helper: starts the worker on demand and restarts it if it exited (idle or crash)."""

    def __init__(self, python: str = sys.executable, cwd: str | None = None, idle_min: float = 12.0, env: dict | None = None):
        self.cmd = [python, "-m", "omnivoice_clone.worker", "--idle-min", str(idle_min)]
        self.cwd = cwd or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.env = {**os.environ, **(env or {})}
        self.proc = None
        self._id = 0
        self._lock = threading.Lock()

    def _ensure(self):
        if self.proc is None or self.proc.poll() is not None:
            kw = {"creationflags": 0x08000000} if os.name == "nt" else {}
            self.proc = subprocess.Popen(self.cmd, cwd=self.cwd, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=None, text=True, encoding="utf-8", bufsize=1, **kw)

    def call(self, op: str, **kw) -> dict:
        with self._lock:
            for attempt in range(2):  # the worker may have exited for idleness between two calls
                self._ensure()
                self._id += 1
                try:
                    self.proc.stdin.write(json.dumps({"id": self._id, "op": op, **kw}, ensure_ascii=False) + "\n")
                    self.proc.stdin.flush()
                    line = self.proc.stdout.readline()
                except (BrokenPipeError, OSError):
                    line = ""
                if line:
                    return json.loads(line)
                self.proc = None
            raise RuntimeError("omnivoice worker died (see its stderr)")

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.call("shutdown")
            except Exception:
                self.proc.kill()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--idle-min", type=float, default=float(os.environ.get("OVC_IDLE_MIN", "12")))
    ap.add_argument("--warmup", action="store_true", help="load the model now instead of on the first request")
    ap.add_argument("--device", default=None)
    a = ap.parse_args()
    serve(a.idle_min, a.warmup, a.device)
