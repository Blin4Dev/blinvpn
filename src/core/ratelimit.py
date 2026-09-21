"""
Простой rate-limiter на SQLite (фиксированное окно). Переживает рестарты.

rate_limit(key, limit, window) → (allowed, retry_after_seconds)
  • за окно window допускается не более limit обращений с этим ключом;
  • при превышении allowed=False и retry_after — сколько ждать до сброса окна.
"""

from __future__ import annotations

import math
import time

try:
    from . import database as db  # type: ignore
except ImportError:
    import database as db  # type: ignore


def rate_limit(key: str, limit: int, window: float) -> tuple[bool, int]:
    now = time.time()
    row = db.fetchone("SELECT count, window_start FROM rate_limits WHERE key = ?", (key,))
    if not row or (now - float(row["window_start"])) >= window:
        # новое окно
        db.execute(
            "INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)",
            (key, now),
        )
        return True, 0
    count = int(row["count"])
    if count >= limit:
        retry = max(1, math.ceil(float(row["window_start"]) + window - now))
        return False, retry
    db.execute("UPDATE rate_limits SET count = count + 1 WHERE key = ?", (key,))
    return True, 0


def reset(key: str) -> None:
    db.execute("DELETE FROM rate_limits WHERE key = ?", (key,))
