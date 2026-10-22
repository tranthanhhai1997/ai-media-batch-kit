"""Vietnamese text normalizer for TTS models that have none (OmniVoice, Kokoro…).

Why: OmniVoice has no Vietnamese number/date/money reading (its normalizer covers zh/en only) so
"199.000đ", "50%", "12/5/2025", "9h30" were read wrongly or skipped (A). NFD tone marks also confuse the model.
This is the Python twin of src/voice/normalize-vi.js (smaller: no math formulas). Keep OmniVoice control
tags like [laughter] untouched.

    from omnivoice_clone.vi_text_norm import normalize_vi
    normalize_vi("Giá chỉ 199.000đ, giảm 50% đến ngày 12/5/2025 lúc 9h30.")
"""
from __future__ import annotations

import re
import unicodedata

_DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]


def _read_triple(n: int, full: bool, le: str) -> str:
    """0..999. full=True for a non-leading group: always say 'không trăm' and the filler 'linh'/'lẻ'."""
    h, t, u = n // 100, (n // 10) % 10, n % 10
    out = []
    if h or full:
        out.append(_DIGITS[h] + " trăm")
    if t == 0:
        if u and (h or full):
            out.append(le)
        if u:
            out.append(_DIGITS[u])
    elif t == 1:
        out.append("mười")
        if u == 5:
            out.append("lăm")
        elif u:
            out.append(_DIGITS[u])
    else:
        out.append(_DIGITS[t] + " mươi")
        out.append({0: "", 1: "mốt", 4: "tư", 5: "lăm"}.get(u, _DIGITS[u]))
    return " ".join(x for x in out if x)


def _below_billion(n: int, full: bool, le: str) -> str:
    parts, started = [], full
    for g, scale in zip(((n // 10**6) % 1000, (n // 1000) % 1000, n % 1000), (" triệu", " nghìn", "")):
        if g == 0:
            continue
        parts.append(_read_triple(g, started, le) + scale)
        started = True
    return " ".join(parts)


def read_int(n: int, le: str = "linh") -> str:
    if n < 0:
        return "âm " + read_int(-n, le)
    if n == 0:
        return "không"
    if n >= 10**18:
        return read_digits(str(n))
    if n >= 10**9:  # repeated "tỷ": 2.500 tỷ → "hai nghìn năm trăm tỷ"
        hi, lo = divmod(n, 10**9)
        return read_int(hi, le) + " tỷ" + (" " + _below_billion(lo, True, le) if lo else "")
    return _below_billion(n, False, le)


def read_digits(s: str) -> str:
    return " ".join(_DIGITS[int(c)] for c in s if c.isdigit())


def read_number(s: str, le: str = "linh") -> str:
    """'1.250.000' (VN thousands) | '1,250,000' (EN, ≥2 groups) | '3,5' / '3.5' (decimal) | '0912' (digits)."""
    s = s.strip()
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s) or re.fullmatch(r"\d{1,3}(?:,\d{3}){2,}", s):
        return read_int(int(re.sub(r"[.,]", "", s)), le)
    m = re.fullmatch(r"(\d+)[,.](\d+)", s)
    if m:
        a, b = m.groups()
        frac = read_digits(b) if (b.startswith("0") or len(b) > 2) else read_int(int(b), le)
        return f"{read_int(int(a), le)} phẩy {frac}"
    if s.isdigit():
        return read_digits(s) if len(s) > 1 and s.startswith("0") else read_int(int(s), le)
    return s


_NUM = r"\d+(?:[.,]\d+)*"
_UNITS = {
    "km/h": "ki lô mét trên giờ", "kmh": "ki lô mét trên giờ", "m/s": "mét trên giây",
    "km": "ki lô mét", "cm": "xen ti mét", "mm": "mi li mét", "m2": "mét vuông", "m²": "mét vuông",
    "m3": "mét khối", "m³": "mét khối", "kg": "ki lô gam", "mg": "mi li gam", "g": "gam",
    "ml": "mi li lít", "l": "lít", "m": "mét", "gb": "gi ga bai", "mb": "mê ga bai", "tb": "tê ra bai",
    "kw": "ki lô oát", "w": "oát", "v": "vôn", "mah": "mi li am pe giờ", "hz": "héc", "ghz": "gi ga héc",
    "°c": "độ xê", "°f": "độ ép", "°": "độ", "tr": "triệu", "k": "nghìn",
}
_CURRENCY = {
    "đ": "đồng", "₫": "đồng", "vnđ": "đồng", "vnd": "đồng", "đồng": "đồng",
    "usd": "đô la", "$": "đô la", "€": "ơ rô", "eur": "ơ rô", "¥": "yên",
}
_ABBR = [
    (r"\bTP\.?\s?HCM\b", "thành phố Hồ Chí Minh"), (r"\bTP\.?\s?Hồ Chí Minh\b", "thành phố Hồ Chí Minh"),
    (r"\bTP\.(?=\s?[A-ZĐ])", "thành phố"), (r"\bv\.v\.?", "vân vân"),
    (r"\bKCN\b", "khu công nghiệp"), (r"\bUBND\b", "ủy ban nhân dân"), (r"\bTW\b", "trung ương"),
    (r"\bVN\b", "Việt Nam"), (r"\b[Ss]ĐT\b|\bsđt\b", "số điện thoại"),
    (r"\bQ\.(?=\s?\d)", "quận "), (r"\bP\.(?=\s?\d)", "phường "), (r"\bđ/c\b", "địa chỉ"),
    (r"\bko\b", "không"), (r"\bk0\b", "không"), (r"\bđc\b", "được"), (r"\bdc\b", "được"),
]


def _outside_tags(text: str, fn) -> str:
    """Apply fn only outside OmniVoice [tags]."""
    out, last = [], 0
    for m in re.finditer(r"\[[^\[\]]*\]", text):
        out += [fn(text[last:m.start()]), m.group()]
        last = m.end()
    out.append(fn(text[last:]))
    return "".join(out)


def _segment(t: str, le: str) -> str:
    for pat, rep in _ABBR:
        t = re.sub(pat, rep, t)
    # phone numbers before they are read as thousands: 0912 345 678 / 0912.345.678 / +84 912…
    t = re.sub(r"(?<![\d.,])(?:\+84\s?|0)\d{2,3}[\s.\-]?\d{3}[\s.\-]?\d{3,4}(?!\d|[.,]\d)",
               lambda m: read_digits(m.group().replace("+84", "0")), t)

    def _time(m):
        h, mi = m.group(1), m.group(2)
        s = read_int(int(h), le) + " giờ"
        return s + (" " + read_int(int(mi), le) + " phút" if mi and int(mi) else "")
    t = re.sub(r"\b(\d{1,2})\s?[hH](?:\s?(\d{1,2})\s?(?:p|ph|phút)?)?\b", _time, t)
    t = re.sub(r"\b([01]?\d|2[0-3]):([0-5]\d)\b(?!:)", _time, t)

    def _date(m):
        d, mo, y = m.group(1), m.group(2), m.group(3)
        if not (1 <= int(d) <= 31 and 1 <= int(mo) <= 12):
            return m.group()
        s = f"{read_int(int(d), le)} tháng {'tư' if int(mo) == 4 else read_int(int(mo), le)}"
        return s + (" năm " + read_int(int(y), le) if y else "")
    t = re.sub(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b", _date, t)
    t = re.sub(r"(?<=\bngày )(\d{1,2})/(\d{1,2})()\b", _date, t)
    t = re.sub(r"\btháng 0?4\b(?![/\d])", "tháng tư", t)
    t = re.sub(r"\bthứ 4\b", "thứ tư", t)
    t = re.sub(r"\b(\d)m(\d{2})\b", lambda m: f"{read_int(int(m.group(1)), le)} mét {read_int(int(m.group(2)), le)}", t)
    t = re.sub(rf"\b({_NUM})\s?[-–~]\s?({_NUM})\b", lambda m: f"{m.group(1)} đến {m.group(2)}", t)
    t = re.sub(rf"([$€¥])\s?({_NUM})(\s?(?:k|tr|triệu|nghìn|ngàn|tỷ)\b)?",
               lambda m: f"{m.group(2)}{m.group(3) or ''} {_CURRENCY[m.group(1)]}", t)

    unit_re = "|".join(re.escape(u) for u in sorted(list(_UNITS) + list(_CURRENCY), key=len, reverse=True))

    def _num_unit(m):
        num, sp, unit = m.group(1), m.group(2), m.group(3)
        words = read_number(num, le)
        if not unit:
            return words + sp
        u = unit.lower()
        if u == "%":
            return words + " phần trăm"
        if u in _CURRENCY:
            return words + " " + _CURRENCY[u]
        if len(u) == 1 and u != "°" and sp:  # 1-letter units only when glued ("10m", "5k") — else "3 l…" eats words
            return words + sp + unit
        return words + " " + _UNITS.get(u, unit)
    t = re.sub(rf"(?<![\w.,])({_NUM})(\s?)(%|(?:{unit_re})(?![\wà-ỹđ]))?", _num_unit, t, flags=re.I)
    t = t.replace("&", " và ").replace("+", " cộng ").replace("@", " a còng ")
    return re.sub(r"(?<=\s)=(?=\s)", "bằng", t)


def normalize_vi(text: str, le: str = "linh") -> str:
    """le: 'linh' (Northern, default) or 'lẻ' (Southern) for 105 → 'một trăm linh/lẻ năm'."""
    if not text:
        return text
    t = unicodedata.normalize("NFC", text).replace("​", "").replace("﻿", "")
    t = re.sub(r"[*_#`~^|<>{}\\]+", " ", t)                      # markdown / decoration
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿️]", " ", t)  # emoji
    t = re.sub(r"[“”«»]", '"', t)
    t = re.sub(r"[‘’]", "'", t)
    t = re.sub(r"\.{3,}|…", "...", t)
    t = re.sub(r"\s+—\s*|\s*—\s+", ", ", t)
    t = _outside_tags(t, lambda s: _segment(s, le))
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\s+([,.!?;:])", r"\1", t)
    t = re.sub(r",\s*,+", ",", t)
    return t.strip()


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    for s in ["Giá chỉ 199.000đ, giảm 50% đến ngày 12/5/2025 lúc 9h30.",
              "Mua 2 tặng 1, hotline 0912.345.678.", "Sạc 5000mAh, giá $99 hoặc 2.490k, 1,2tr.",
              "Từ 3-5 ngày, 35°C, cao 1m75, 21:45 thứ 4.", "[laughter] Anh ấy cười 2 lần."]:
        print(s, "\n  →", normalize_vi(s))
