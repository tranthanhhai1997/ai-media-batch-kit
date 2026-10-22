"""OmniVoice zero-shot voice clone helpers (reference prep, Vietnamese normalizer, engine, idle-killed worker).

⚠ OmniVoice model weights are CC-BY-NC — non-commercial use only. See README.md.
Heavy imports (torch, omnivoice, numpy) happen lazily inside functions so importing this package is cheap.
"""
__all__ = ["vi_text_norm", "prepare_reference", "engine", "worker", "cli"]
