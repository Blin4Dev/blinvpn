from __future__ import annotations

import math
import time

try:
    from . import database as db  # type: ignore
except ImportError:
    import database as db  # type: ignore

# просроченные окна чистит фон
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


def peek(key: str, window: float) -> int:
    """Сколько обращений уже было в текущем окне (без увеличения счётчика)."""
    row = db.fetchone("SELECT count, window_start FROM rate_limits WHERE key = ?", (key,))
    if not row or time.time() - float(row["window_start"]) >= window:
        return 0
    return int(row["count"])
