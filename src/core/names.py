from __future__ import annotations

import re
import unicodedata
from typing import Any, Optional

# ник telegram: a-z0-9_, 4-32
_TG_USERNAME = re.compile(r"^[A-Za-z0-9_]{4,32}$")
# управляющие/невидимые/bidi/bom
_INVISIBLE = re.compile(
    "[\u0000-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠎"
    "​-‏ -‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￿]"
)


def tg_username(value: Any) -> Optional[str]:
    """Ник Telegram без «@», если он корректный, иначе None."""
    if not isinstance(value, str):
        return None
    v = value.strip().lstrip("@")
    return v if _TG_USERNAME.fullmatch(v) else None


def display_name(value: Any, max_len: int = 40) -> str:
    """Имя для показа: без невидимых символов и «залго», пробелы схлопнуты, длина ограничена."""
    s = unicodedata.normalize("NFC", str(value or ""))[:max_len * 4]
    s = _INVISIBLE.sub("", s)
    out: list[str] = []
    marks = 0
    for ch in s:
        if unicodedata.combining(ch):
            marks += 1# не больше 2 combining подряд
            if marks > 2:  # не больше двух надстрочных знаков подряд
                continue
        else:
            marks = 0
        out.append(ch)
    s = re.sub(r"\s+", " ", "".join(out)).strip()
    return s[:max_len].strip()
