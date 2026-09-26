"""
Единая точка отправки уведомлений в форум-группу Telegram (топики) и админу.

Топики (message_thread_id) настраиваются в панели и/или через .env:
  • Выводы   (withdrawals) — уведомления о новых заявках на вывод (обработка — в панели)
  • Коды     (codes)       — коды входа в панель
  • Бэкапы   (backups)     — файлы резервных копий БД
  • Покупки  (purchases)   — уведомления об оплатах
  • Ошибки   (errors)      — только серверные ошибки
  • Инциденты (incidents)  — мониторинг серверов: падения, нагрузка, VLESS, оплата

Настройки берутся из таблицы settings (ключи forum_*), с откатом на .env.
Если форум не настроен, коды/уведомления уходят администратору в ЛС
(TELEGRAM_ADMIN_ID).
"""

from __future__ import annotations

import os
from typing import Any, Optional

try:
    from . import database as db  # type: ignore
except ImportError:
    import database as db  # type: ignore

try:
    from . import notifier  # type: ignore
except ImportError:
    import notifier  # type: ignore

TOPICS = ("withdrawals", "codes", "backups", "purchases", "errors", "incidents")

# Откаты на .env (совместимость со старыми установками).
_ENV_TOPIC_FALLBACK = {
    "withdrawals": "NOTIFY_THREAD_WITHDRAWALS",
    "purchases": "NOTIFY_THREAD_DEPOSITS",
    "errors": "NOTIFY_THREAD_ERRORS",
    "codes": "NOTIFY_THREAD_CODES",
    "backups": "NOTIFY_THREAD_BACKUPS",
}


def _env(key: str) -> str:
    return (os.getenv(key) or "").strip()


def chat_id() -> str:
    return db.get_setting("forum_chat_id", "") or _env("NOTIFY_GROUP_ID")


def admin_chat_id() -> str:
    return _env("TELEGRAM_ADMIN_ID")


def admin_ids() -> set[int]:
    """
    Множество Telegram-id, которым разрешены админ-действия из бота/форума
    (одобрение выводов, приём ссылки на транзакцию). Источник — TELEGRAM_ADMIN_ID
    (можно перечислить через запятую/пробел) и настройка forum_admin_ids из панели.
    Членство в форум-группе НЕ даёт прав — только явный список.
    """
    raw = f"{_env('TELEGRAM_ADMIN_ID')} {db.get_setting('forum_admin_ids', '')}"
    out: set[int] = set()
    for part in raw.replace(",", " ").split():
        try:
            out.add(int(part))
        except ValueError:
            continue
    return out


def is_admin(telegram_id: Any) -> bool:
    try:
        return int(telegram_id) in admin_ids()
    except (TypeError, ValueError):
        return False


def withdrawals_chat_ok(chat: Any, thread: Any) -> bool:
    """
    Действие по выводу должно приходить из настроенной форум-группы (а если топик
    «Выводы» задан — то из него). Защищает от нажатий в посторонних чатах.
    """
    cid = chat_id()
    if not cid:
        # Форум не настроен — заявки уходят админу в ЛС; проверять чат не по чему,
        # достаточно проверки is_admin вызывающим кодом.
        return True
    if str(_as_chat(cid)) != str(chat):
        return False
    wt = topic_id("withdrawals")
    if wt is not None and thread is not None and int(wt) != int(thread):
        return False
    return True


def panel_url() -> str:
    return (db.get_setting("panel_url", "") or _env("PANEL_URL")).rstrip("/")


def topic_id(topic: str) -> Optional[int]:
    raw = db.get_setting(f"forum_topic_{topic}", "")
    if not raw:
        raw = _env(_ENV_TOPIC_FALLBACK.get(topic, ""))
    try:
        return int(raw) if str(raw).strip() else None
    except ValueError:
        return None


def get_config() -> dict[str, Any]:
    """Конфиг форума для панели."""
    return {
        "forum_chat_id": db.get_setting("forum_chat_id", "") or "",
        "panel_url": db.get_setting("panel_url", "") or "",
        "topics": {t: (db.get_setting(f"forum_topic_{t}", "") or "") for t in TOPICS},
    }


def save_config(forum_chat_id: str, topics: dict[str, Any], panel_url_value: Optional[str] = None) -> dict[str, Any]:
    db.set_setting("forum_chat_id", str(forum_chat_id or "").strip())
    if panel_url_value is not None:
        db.set_setting("panel_url", str(panel_url_value or "").strip())
    for t in TOPICS:
        v = topics.get(t)
        db.set_setting(f"forum_topic_{t}", "" if v in (None, "") else str(v).strip())
    return get_config()


def user_link(user_id: int) -> str:
    """Кликабельная ссылка «id<N>» на страницу пользователя в панели."""
    base = panel_url()
    label = f"id{user_id}"
    if base:
        return f'<a href="{base}/users/{user_id}">{label}</a>'
    return f"<b>{label}</b>"


# ── Отправка ─────────────────────────────────────────────────

def send(topic: str, text: str, *, reply_markup: Optional[dict] = None) -> Optional[dict[str, Any]]:
    """
    Шлёт сообщение в топик форума (или админу в ЛС, если форум не настроен).
    Возвращает результат Telegram (для message_id) либо None.
    """
    cid = chat_id()
    thread = topic_id(topic)
    if not cid:
        cid = admin_chat_id()
        thread = None
    if not cid:
        return None
    payload: dict[str, Any] = {
        "chat_id": _as_chat(cid),
        "text": text,
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    }
    if thread is not None:
        payload["message_thread_id"] = thread
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    return notifier.call("sendMessage", payload)


def send_document(topic: str, file_path: str, *, caption: str = "") -> bool:
    cid = chat_id()
    thread = topic_id(topic)
    if not cid:
        cid = admin_chat_id()
        thread = None
    if not cid:
        return False
    return notifier.send_document(
        _as_chat(cid), file_path, caption=caption, message_thread_id=thread
    )


def delete_message(chat: Any, message_id: int) -> bool:
    if not chat or not message_id:
        return False
    return notifier.call("deleteMessage", {"chat_id": _as_chat(chat), "message_id": int(message_id)}) is not None


def _as_chat(value: Any) -> Any:
    """Chat id может быть числом (-100…) или @username."""
    s = str(value).strip()
    if s.startswith("@"):
        return s
    try:
        return int(s)
    except ValueError:
        return s


# ── Готовые уведомления ──────────────────────────────────────

def notify_purchase(user: dict[str, Any], amount: Any, method: str, currency: str = "₽") -> None:
    method_label = {
        "sbp": "СБП", "card": "Карту", "sberpay": "SberPay",
        "tg_stars": "Telegram Stars", "stars": "Telegram Stars",
    }.get(str(method or "").lower(), method or "—")
    text = f"💰 <b>Покупка на {amount}{currency}</b> от {user_link(int(user['id']))} через {method_label}"
    send("purchases", text)


def send_code(code: str, ip: str = "", user_agent: str = "") -> bool:
    ip = ip or "—"
    ua = f" ({user_agent})" if user_agent else ""
    text = f"🔒 <b>Код</b>: <code>{code}</code>\n<b>IP</b>: {ip}{ua}"
    return send("codes", text) is not None


def notify_withdrawal(withdrawal: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    Уведомление о новой заявке на вывод в топик «Выводы». Только информирует —
    сама обработка (одобрить / завершить / отклонить) делается в панели.
    """
    wid = int(withdrawal["id"])
    text = (
        f"💰 <b>Новый запрос на вывод #{wid}</b>\n\n"
        f"Пользователь: {user_link(int(withdrawal['user_id']))}\n"
        f"Сумма: {_fmt_amount(withdrawal['amount'])}₽\n\n"
        "Обработайте заявку в панели → Пользователи → Выводы."
    )
    kb = None
    base = panel_url()
    if base.startswith("https://"):
        kb = {"inline_keyboard": [[{"text": "Открыть в панели", "url": f"{base}/withdrawals"}]]}
    return send("withdrawals", text, reply_markup=kb)


def _fmt_amount(v: Any) -> str:
    try:
        f = float(v)
        return str(int(f)) if f == int(f) else f"{f:.2f}"
    except (TypeError, ValueError):
        return str(v)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def report_error(context: str, detail: str = "") -> None:
    """Серверная ошибка → топик «Ошибки». Вызывать только для НАШИХ сбоев."""
    body = f"❗️ <b>Ошибка</b>: {context}"
    if detail:
        body += f"\n<code>{_esc(detail[:900])}</code>"
    send("errors", body)


# ── Финализация вывода ───────────────────────────────────────

EMOJI_APPROVED = "5206607081334906820"  # ✔️ (премиум)


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _send_entities(telegram_id: int, segments: list[tuple[str, Optional[dict]]]) -> bool:
    text = ""
    entities: list[dict] = []
    offset = 0
    for chunk, ent in segments:
        length = _utf16_len(chunk)
        if ent:
            entities.append({**ent, "offset": offset, "length": length})
        text += chunk
        offset += length
    return notifier.call("sendMessage", {
        "chat_id": int(telegram_id),
        "text": text,
        "entities": entities,
        "link_preview_options": {"is_disabled": True},
    }) is not None


def dm_withdrawal_completed(telegram_id: int, amount: Any, tx_hash: str) -> bool:
    """ЛС пользователю: «✔️ Вывод выполнен» + сумма + hash транзакции."""
    if not telegram_id:
        return False
    return _send_entities(int(telegram_id), [
        ("✔️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_APPROVED}),
        (" ", None),
        ("Вывод выполнен", {"type": "bold"}),
        (f"\n\nСумма: {_fmt_amount(amount)}₽\nHash транзакции:\n", None),
        (str(tx_hash), {"type": "code"}),
    ])


def dm_withdrawal_rejected(telegram_id: int, amount: Any, reason: str, refunded: bool) -> bool:
    """ЛС пользователю об отказе: причина и вернулись ли деньги на баланс."""
    if not telegram_id:
        return False
    tail = (f"\n\n{_fmt_amount(amount)}₽ возвращены на реферальный баланс." if refunded
            else "\n\nСредства не возвращаются.")
    segments: list[tuple[str, Optional[dict]]] = [
        ("❌ ", None),
        ("Вывод отклонён", {"type": "bold"}),
    ]
    if reason:
        segments.append((f"\n\nПричина: {reason}", None))
    segments.append((tail, None))
    return _send_entities(int(telegram_id), segments)
