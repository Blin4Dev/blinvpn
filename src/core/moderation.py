"""
Журнал модерации пользователя (панель → карточка пользователя → «Блокировки и
нарушения»): блокировки/разблокировки аккаунта и подписок, предупреждения и
баны анти-абуза, чёрный список, бан при чарджбеке.

Журнал не очищается при разблокировке — видно всю историю.
"""

from __future__ import annotations

import json
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

KINDS = {
    "ban": "Аккаунт заблокирован",
    "unban": "Аккаунт разблокирован",
    "key_block": "Подписка заблокирована",
    "key_unblock": "Подписка разблокирована",
    "aa_warn": "Предупреждение анти-абуза",
    "aa_ban": "Бан анти-абуза",
    "blacklist": "Чёрный список",
}


def log(user_id: int, kind: str, reason: Optional[str] = None, *, sub_id: Optional[int] = None,
        details: Optional[dict[str, Any]] = None, actor: str = "system", actor_name: Optional[str] = None) -> None:
    """Запись в журнал. Никогда не бросает исключений — модерация важнее журнала."""
    try:
        db.execute(
            "INSERT INTO moderation_events (user_id, sub_id, kind, reason, details, actor, actor_name, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (int(user_id), int(sub_id) if sub_id else None, str(kind)[:32], (str(reason)[:300] if reason else None),
             json.dumps(details, ensure_ascii=False) if details else None, str(actor)[:64],
             (str(actor_name)[:80] if actor_name else None), db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001
        pass


def for_user(user_id: int, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.fetchall("SELECT * FROM moderation_events WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                       (int(user_id), int(limit)))
    out = []
    for r in rows:
        try:
            details = json.loads(r["details"]) if r.get("details") else None
        except (TypeError, ValueError):
            details = None
        out.append({
            "id": r["id"], "kind": r["kind"], "label": KINDS.get(r["kind"], r["kind"]), "reason": r.get("reason"),
            "sub_id": r.get("sub_id"), "details": details, "actor": r.get("actor"), "actor_name": r.get("actor_name"),
            "created_at": r.get("created_at"),
        })
    return out
