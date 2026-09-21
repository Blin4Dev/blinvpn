"""
Отправка сообщений в Telegram из backend-процессов (рассылки и т.п.).

Только стандартная библиотека. Токен берётся из TELEGRAM_BOT_TOKEN.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Optional

API_BASE = "https://api.telegram.org"

# Разметка из панели → Telegram HTML.
_EMOJI_RE = re.compile(r"!\[(\d+)\]")            # ![premium_emoji_id]
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.S)    # **жирный**
_MONO_RE = re.compile(r"`([^`]+?)`")              # `моно`
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", re.S)  # *курсив*


def format_markup(text: str) -> str:
    """
    Преобразует упрощённую разметку рассылки в Telegram HTML:
      **жирный** → <b>, *курсив* → <i>, `моно` → <code>,
      ![ID] → премиум-эмодзи <tg-emoji>. Готовые HTML-теги (<b>,<i>,<code>)
      админ может писать напрямую — они остаются как есть.
    """
    if not text:
        return text
    text = _EMOJI_RE.sub(r'<tg-emoji emoji-id="\1">⭐</tg-emoji>', text)
    text = _BOLD_RE.sub(r"<b>\1</b>", text)
    text = _MONO_RE.sub(r"<code>\1</code>", text)
    text = _ITALIC_RE.sub(r"<i>\1</i>", text)
    return text


def _token() -> str:
    return (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()


def call(method: str, payload: dict[str, Any], *, timeout: float = 30.0,
         _retries: int = 1, on_throttle=None) -> Optional[dict[str, Any]]:
    """
    Вызов Bot API. При 429 (Too Many Requests) уважаем parameters.retry_after
    и делаем один повтор — так соблюдаем лимит Telegram (~30 сообщений/сек для
    рассылки разным людям). Если передан on_throttle(retry_after) — вызываем его
    (рассылка использует это, чтобы АВТОМАТИЧЕСКИ снизить скорость).
    """
    token = _token()
    if not token:
        return None
    url = f"{API_BASE}/bot{token}/{method}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            return None
        # 429 → подождать retry_after и повторить один раз.
        if e.code == 429:
            retry_after = 1.0
            try:
                retry_after = float(((body or {}).get("parameters") or {}).get("retry_after") or 1)
            except (TypeError, ValueError):
                retry_after = 1.0
            if on_throttle is not None:
                try:
                    on_throttle(retry_after)
                except Exception:  # noqa: BLE001
                    pass
            if _retries > 0:
                time.sleep(min(retry_after, 30) + 0.1)
                return call(method, payload, timeout=timeout, _retries=_retries - 1, on_throttle=on_throttle)
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    if not body.get("ok"):
        return None
    return body.get("result")


def get_chat_member_status(chat_id: Any, user_id: int) -> Optional[str]:
    """
    Статус пользователя в канале/чате (getChatMember). Возвращает строку статуса
    ('creator'|'administrator'|'member'|'restricted'|'left'|'kicked') либо None,
    если проверить нельзя (бот не админ канала / ошибка сети).
    """
    res = call("getChatMember", {"chat_id": chat_id, "user_id": int(user_id)}, timeout=15.0)
    if isinstance(res, dict):
        return str(res.get("status") or "") or None
    return None


def send_document(
    chat_id: Any,
    file_path: str,
    *,
    caption: str = "",
    message_thread_id: Optional[int] = None,
    parse_mode: str = "HTML",
    timeout: float = 120.0,
) -> bool:
    """Отправляет файл (sendDocument) через multipart/form-data. Для бэкапов."""
    token = _token()
    if not token or not os.path.isfile(file_path):
        return False
    boundary = "----blinvpn" + os.urandom(16).hex()
    fields: list[tuple[str, str]] = [("chat_id", str(chat_id)), ("parse_mode", parse_mode)]
    if caption:
        fields.append(("caption", caption[:1024]))
    if message_thread_id is not None:
        fields.append(("message_thread_id", str(message_thread_id)))

    with open(file_path, "rb") as fh:
        file_bytes = fh.read()
    filename = os.path.basename(file_path)

    body = bytearray()
    for name, value in fields:
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += value.encode("utf-8") + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="document"; filename="{filename}"\r\n'.encode()
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += file_bytes + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{API_BASE}/bot{token}/sendDocument",
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return bool(data.get("ok"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
        return False


def _keyboard(
    button_type: Optional[str],
    button_value: Optional[str],
    miniapp_url: str,
    bot_username: str,
) -> Optional[dict[str, Any]]:
    """
    Инлайн-кнопка под сообщением рассылки. Типы соответствуют панели:
      • open_miniapp   — button_value "Текст|URL" → web_app (URL или miniapp_url)
      • external_link  — button_value "Текст|URL" → url-кнопка
      • activate_promo — button_value "CODE"      → deep-link t.me/<bot>?start=promo_CODE
    """
    if not button_type or button_type in ("none", ""):
        return None

    if button_type == "open_miniapp":
        label, url = "Открыть", miniapp_url
        if button_value and "|" in button_value:
            lbl, _, u = button_value.partition("|")
            label = lbl.strip() or "Открыть"
            url = (u.strip() or miniapp_url)
        elif button_value:
            label = button_value.strip() or "Открыть"
        if not url:
            return None
        return {"inline_keyboard": [[{"text": label, "web_app": {"url": url}}]]}

    if button_type == "external_link":
        if not button_value:
            return None
        if "|" in button_value:
            lbl, _, u = button_value.partition("|")
            label = lbl.strip() or "Перейти"
            url = u.strip()
        else:
            label, url = "Перейти", button_value.strip()
        if not url:
            return None
        return {"inline_keyboard": [[{"text": label, "url": url}]]}

    if button_type == "activate_promo":
        code = (button_value or "").strip().upper()
        if not code or not bot_username:
            return None
        url = f"https://t.me/{bot_username}?start=promo_{code}"
        return {"inline_keyboard": [[{"text": "Активировать промокод", "url": url}]]}

    return None


def send_broadcast_message(
    chat_id: int,
    text: str,
    *,
    image_url: Optional[str] = None,
    button_type: Optional[str] = None,
    button_value: Optional[str] = None,
    miniapp_url: str = "",
    bot_username: str = "",
    parse_mode: str = "HTML",
    on_throttle=None,
) -> bool:
    """
    Отправляет одно сообщение рассылки. С картинкой — sendPhoto (текст в подписи),
    иначе sendMessage. Возвращает True при успешной доставке.
    on_throttle(retry_after) вызывается при 429 (для авто-снижения скорости).
    """
    reply_markup = _keyboard(button_type, button_value, miniapp_url, bot_username)
    html = format_markup(text)
    if image_url:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "photo": image_url,
            "caption": html[:1024],
            "parse_mode": parse_mode,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        if call("sendPhoto", payload, on_throttle=on_throttle) is not None:
            return True
        # если картинка не принята Telegram — отправим хотя бы текст
    payload = {
        "chat_id": chat_id,
        "text": html,
        "parse_mode": parse_mode,
        "link_preview_options": {"is_disabled": True},
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return call("sendMessage", payload, on_throttle=on_throttle) is not None
