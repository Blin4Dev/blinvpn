"""
Общий чёрный список Telegram ID (нарушители правил).

Источник — текстовый файл (по умолчанию GitHub Blin4ickUSE/ban-vpn), по одной
записи на строку:  «<telegram_id> # <причина>». Пустые строки и строки без
числа в начале игнорируются.

• refresh() — скачивает список и кладёт в таблицу blacklist (раз в час из бота).
  Если скачать не удалось — остаётся последний сохранённый список.
• enforce(user) — если пользователь в списке и ещё не заблокирован — блокирует
  аккаунт (как «Заблокировать» в панели). Вызывается при каждом входе: /start
  в боте, открытие мини-приложения, вход через Telegram на сайте.
• Уже существующие пользователи из списка блокируются при обновлении списка.
• Если админ разблокировал такого пользователя в панели — ставится отметка
  blacklist_ignored, и список его больше не трогает.

Env: BLACKLIST_URL (пусто или «off» — выключить), BLACKLIST_REFRESH_SEC (3600).
"""

from __future__ import annotations

import os
import time
import urllib.request
from typing import Any, Optional

try:
    from . import database as db  # type: ignore
    from . import provisioning  # type: ignore
    from . import services  # type: ignore
except ImportError:
    import database as db  # type: ignore
    import provisioning  # type: ignore
    import services  # type: ignore

DEFAULT_URL = "https://raw.githubusercontent.com/Blin4ickUSE/ban-vpn/refs/heads/main/blacklist.txt"
REFRESH_SEC = int(os.getenv("BLACKLIST_REFRESH_SEC") or 3600)
BAN_REASON_PREFIX = "Чёрный список"


def url() -> str:
    raw = os.getenv("BLACKLIST_URL")
    if raw is None:
        return DEFAULT_URL
    raw = raw.strip()
    return "" if raw.lower() in ("", "off", "0", "false", "no") else raw


def enabled() -> bool:
    return bool(url())


def parse(text: str) -> dict[int, str]:
    out: dict[int, str] = {}
    for line in (text or "").splitlines():
        line = line.strip().lstrip("﻿")
        if not line or line.startswith("#"):
            continue
        head, _, reason = line.partition("#")
        token = head.strip().split()[0] if head.strip() else ""
        if not token.isdigit():
            continue
        tg = int(token)
        if tg <= 0:
            continue
        out[tg] = reason.strip()[:200]
    return out


def refresh(log=print) -> Optional[int]:
    """Скачивает список и сохраняет в БД. Возвращает число записей или None при ошибке."""
    src = url()
    if not src:
        return None
    try:
        req = urllib.request.Request(src, headers={"User-Agent": "BlinVPN-blacklist/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 — адрес из настроек
            text = resp.read(5 * 1024 * 1024).decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        log(f"[blacklist] не удалось скачать список: {type(exc).__name__}: {exc}")
        return None
    entries = parse(text)
    if not entries:
        # Пустой/битый ответ не должен стереть сохранённый список.
        log("[blacklist] список пуст или не распознан — оставляем прежний")
        return None
    now = db.utcnow_iso()
    with db.transaction() as conn:
        conn.execute("DELETE FROM blacklist")
        conn.executemany(
            "INSERT INTO blacklist (telegram_id, reason, updated_at) VALUES (?, ?, ?)",
            [(tg, reason, now) for tg, reason in entries.items()],
        )
    db.set_setting("blacklist_updated_at", now)
    banned = ban_existing(log)
    log(f"[blacklist] обновлён: {len(entries)} записей" + (f", заблокировано пользователей: {banned}" if banned else ""))
    return len(entries)


def ensure_loaded(log=print) -> None:
    """Если список ещё ни разу не скачивался — скачать сейчас."""
    if enabled() and not db.get_setting("blacklist_updated_at", ""):
        refresh(log)


def reason_for(telegram_id: Any) -> Optional[str]:
    """Причина из списка (или '' без причины); None — не в списке."""
    if not enabled():
        return None
    try:
        tg = int(telegram_id)
    except (TypeError, ValueError):
        return None
    row = db.fetchone("SELECT reason FROM blacklist WHERE telegram_id = ?", (tg,))
    return None if row is None else str(row.get("reason") or "")


def _ban(user: dict[str, Any], reason: str, log=print) -> None:
    uid = int(user["id"])
    full_reason = f"{BAN_REASON_PREFIX}: {reason}" if reason else BAN_REASON_PREFIX
    db.execute(
        "UPDATE users SET is_banned = 1, status = 'Banned', ban_reason = ? WHERE id = ?",
        (full_reason, uid),
    )
    try:
        services.reject_open_withdrawals_for_user(uid, "Аккаунт заблокирован")
    except Exception:  # noqa: BLE001
        pass
    if provisioning.is_configured() and user.get("telegram_id"):
        try:
            provisioning.set_enabled(int(user["telegram_id"]), False, user.get("email"))
        except Exception:  # noqa: BLE001
            pass
    log(f"[blacklist] заблокирован пользователь #{uid} (tg {user.get('telegram_id')}): {full_reason}")


def enforce(user: Optional[dict[str, Any]], log=print) -> bool:
    """Блокирует пользователя, если он в списке. True — пользователь (теперь) заблокирован по списку."""
    if not user or not user.get("telegram_id") or not enabled():
        return False
    if user.get("blacklist_ignored"):
        return False
    reason = reason_for(user["telegram_id"])
    if reason is None:
        return False
    if not user.get("is_banned"):
        _ban(user, reason, log)
        user["is_banned"] = 1
    return True


def ban_existing(log=print) -> int:
    rows = db.fetchall(
        "SELECT u.* FROM users u JOIN blacklist b ON b.telegram_id = u.telegram_id "
        "WHERE COALESCE(u.is_banned, 0) = 0 AND COALESCE(u.blacklist_ignored, 0) = 0"
    )
    for u in rows:
        _ban(u, reason_for(u["telegram_id"]) or "", log)
        time.sleep(0.02)
    return len(rows)
