"""
Простой rate-limiter на SQLite (фиксированное окно). Переживает рестарты.

rate_limit(key, limit, window) → (allowed, retry_after_seconds)
  • за окно window допускается не более limit обращений с этим ключом;
  • при превышении allowed=False и retry_after — сколько ждать до сброса окна.

Счётчик обновляется ОДНИМ атомарным запросом (UPSERT … RETURNING), поэтому
параллельные запросы не могут проскочить лимит.
"""

from __future__ import annotations

import math
import time

try:
    from . import database as db  # type: ignore
except ImportError:
    import database as db  # type: ignore

# Записи, окно которых давно закончилось, удаляются фоновой чисткой.
_CLEANUP_AGE = 2 * 86400


def rate_limit(key: str, limit: int, window: float) -> tuple[bool, int]:
    now = time.time()
    conn = db.connect()
    try:
        row = conn.execute(
            "INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "  count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END, "
            "  window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END "
            "RETURNING count, window_start",
            (key, now, now, window, now, window, now),
        ).fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    count = int(row["count"])
    if count > limit:
        retry = max(1, math.ceil(float(row["window_start"]) + window - now))
        return False, retry
    return True, 0


def reset(key: str) -> None:
    db.execute("DELETE FROM rate_limits WHERE key = ?", (key,))


def cleanup() -> int:
    """Удаляет давно истёкшие окна (таблица иначе растёт бесконечно)."""
    cur = db.execute("DELETE FROM rate_limits WHERE window_start < ?", (time.time() - _CLEANUP_AGE,))
    return cur.rowcount or 0
