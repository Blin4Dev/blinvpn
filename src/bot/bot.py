"""
BlinVPN — основной Telegram-бот.

Задачи:
  • /start — приветствие + кнопка запуска мини-приложения (и разбор ref-ссылок);
  • оплата звёздами Telegram: подтверждение pre_checkout_query и обработка
    successful_payment → выдача подписки через общий модуль fulfillment.

Режим по умолчанию — long polling (TELEGRAM_STARS_DELIVERY=bot). Внешних
зависимостей нет — только стандартная библиотека.

Запуск:
  python bot.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

# src/core и src/api в путь импорта
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(_HERE, "..", "core"), os.path.join(_HERE, "..", "api")):
    _p = os.path.abspath(_p)
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

import database as db  # type: ignore
import fulfillment  # type: ignore
import reminders  # type: ignore
import services  # type: ignore
import forum  # type: ignore
import survey  # type: ignore

API_BASE = "https://api.telegram.org"


def _env(*keys: str, default: str = "") -> str:
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return default


TOKEN = _env("TELEGRAM_BOT_TOKEN")
MINIAPP_URL = _env("MINIAPP_URL").rstrip("/")
BOT_USERNAME = _env("BOT_USERNAME", "VITE_BOT_USERNAME", default="blinvpn_bot")
SUPPORT_URL = _env("SUPPORT_URL") or "https://t.me/blinteams"

# Премиум-эмодзи (custom_emoji_id). Работают, только если владелец бота имеет
# Telegram Premium (для личных сообщений) или у бота есть доп. username с Fragment,
# и клиент/сервер на Bot API ≥ 9.4. Иначе — авто-откат на обычные эмодзи.
EMOJI_FOX = _env("EMOJI_FOX", default="5283051451889756068")   # 🦊
EMOJI_KEY = _env("EMOJI_KEY", default="6005570495603282482")   # 🔑
EMOJI_CHAT = _env("EMOJI_CHAT", default="5994297722574737553")  # 💬


def api(method: str, payload: Optional[dict[str, Any]] = None, *, timeout: float = 35.0,
        _retries: int = 1) -> Any:
    url = f"{API_BASE}/bot{TOKEN}/{method}"
    data = json.dumps(payload or {}).encode("utf-8")
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
        # 429 → уважаем retry_after (лимит Telegram) и повторяем один раз.
        if e.code == 429 and _retries > 0:
            try:
                ra = float(((body or {}).get("parameters") or {}).get("retry_after") or 1)
            except (TypeError, ValueError):
                ra = 1.0
            time.sleep(min(ra, 30) + 0.1)
            return api(method, payload, timeout=timeout, _retries=_retries - 1)
    except urllib.error.URLError:
        return None
    if not body.get("ok"):
        return None
    return body.get("result")


# ─────────────────────────────────────────────────────────────
# handlers
# ─────────────────────────────────────────────────────────────

def _open_app_keyboard() -> dict[str, Any]:
    """Простая клавиатура для сервисных сообщений (подтверждение оплаты)."""
    buttons: list[list[dict[str, Any]]] = []
    if MINIAPP_URL:
        buttons.append([{"text": "🚀 Открыть BlinVPN", "web_app": {"url": MINIAPP_URL}}])
    if SUPPORT_URL:
        buttons.append([{"text": "💬 Поддержка", "url": SUPPORT_URL}])
    return {"inline_keyboard": buttons} if buttons else {}


def _utf16_len(s: str) -> int:
    """Длина строки в UTF-16 code units (как считает Telegram смещения entity)."""
    return len(s.encode("utf-16-le")) // 2


def _welcome_text_entities() -> tuple[str, list[dict[str, Any]]]:
    """
    Собирает текст приветствия и entity с ВЕРНЫМИ UTF-16 смещениями.
    Первый символ — премиум-эмодзи лиса (🦊, custom_emoji),
    «Добро пожаловать!» — жирным.
    """
    segments: list[tuple[str, Optional[dict[str, Any]]]] = [
        ("🦊", {"type": "custom_emoji", "custom_emoji_id": EMOJI_FOX}),
        (" ", None),
        ("Добро пожаловать!", {"type": "bold"}),
        ("\n\nПришло время для по-настоящему качественного сервиса.", None),
    ]
    text = ""
    entities: list[dict[str, Any]] = []
    offset = 0
    for chunk, ent in segments:
        length = _utf16_len(chunk)
        if ent:
            entities.append({**ent, "offset": offset, "length": length})
        text += chunk
        offset += length
    return text, entities


def _launch_button() -> dict[str, Any]:
    if MINIAPP_URL:
        return {"text": "Запустить", "web_app": {"url": MINIAPP_URL}}
    return {"text": "Запустить", "url": f"https://t.me/{BOT_USERNAME}"}


def _send_welcome(chat_id: int) -> None:
    """
    Приветствие /start: премиум-эмодзи в тексте + инлайн-кнопки под сообщением —
    синяя «Запустить» (web_app) и обычная «Поддержка» (url), обе с премиум-эмодзи.
    Требует Bot API 9.4+ и Telegram Premium у владельца бота (или Fragment-username).
    """
    text, entities = _welcome_text_entities()
    launch = _launch_button()
    api("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "entities": entities,
        "link_preview_options": {"is_disabled": True},
        "reply_markup": {
            "inline_keyboard": [
                [{**launch, "style": "primary", "icon_custom_emoji_id": EMOJI_KEY}],
                [{"text": "Поддержка", "url": SUPPORT_URL, "icon_custom_emoji_id": EMOJI_CHAT}],
            ]
        },
    })


def handle_start(message: dict[str, Any]) -> None:
    chat_id = message["chat"]["id"]
    frm = message.get("from") or {}
    telegram_id = int(frm.get("id") or chat_id)

    # Разбор payload /start <payload>
    text = message.get("text") or ""
    parts = text.split(maxsplit=1)
    payload = parts[1].strip() if len(parts) > 1 else ""

    existed = db.fetchone("SELECT id FROM users WHERE telegram_id = ?", (telegram_id,)) is not None
    user = fulfillment.get_user(_ensure_user(telegram_id, frm))
    is_new = not existed

    # Фиксируем время ПЕРВОГО /start (для онбординг-цепочки). Ставится один раз.
    if user:
        db.execute(
            "UPDATE users SET first_start_at = ? WHERE id = ? AND first_start_at IS NULL",
            (db.utcnow_iso(), user["id"]),
        )

    if payload.startswith("ref_") and user:
        _apply_referral(user, payload[4:].strip(), is_new)
    elif payload.startswith("trk_") and user:
        _apply_tracking(user, payload[4:].strip(), frm, is_new)
    elif payload.startswith("promo_") and user:
        _apply_promo(chat_id, user, payload[6:].strip())

    _send_welcome(chat_id)


def _apply_tracking(user: dict[str, Any], code: str, frm: dict[str, Any], is_new: bool) -> None:
    """Учёт перехода по специальной (трекинговой) ссылке + приветствие ссылки."""
    if not code:
        return
    try:
        full_name = " ".join(x for x in (frm.get("first_name"), frm.get("last_name")) if x) or None
        link = services.register_tracking_click(
            code,
            user_id=int(user["id"]),
            telegram_id=int(user["telegram_id"]),
            username=user.get("username"),
            full_name=full_name,
            is_new_user=is_new,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[bot] tracking error: {type(exc).__name__}: {exc}", flush=True)
        return
    if link and link.get("welcome_message"):
        api("sendMessage", {
            "chat_id": int(user["telegram_id"]),
            "text": str(link["welcome_message"]),
            "link_preview_options": {"is_disabled": True},
        })


def _apply_promo(chat_id: int, user: dict[str, Any], code: str) -> None:
    """Активация промокода из deep-link рассылки (/start promo_CODE)."""
    if not code:
        return
    try:
        info = services.activate_promocode(int(user["id"]), code)
        safe_code = forum._esc(str(info.get("code") or code).upper())
        api("sendMessage", {
            "chat_id": chat_id,
            "text": f"✅ Промокод <b>{safe_code}</b> активирован — скидка {int(info['percent'])}%.",
            "parse_mode": "HTML",
        })
    except services.ServiceError as exc:
        api("sendMessage", {"chat_id": chat_id, "text": f"⚠️ {exc.message}"})
    except Exception as exc:  # noqa: BLE001
        print(f"[bot] promo error: {type(exc).__name__}: {exc}", flush=True)


def _ensure_user(telegram_id: int, frm: dict[str, Any]) -> int:
    """Создаёт пользователя в БД, если его ещё нет. Возвращает internal id."""
    row = db.fetchone("SELECT id FROM users WHERE telegram_id = ?", (telegram_id,))
    if row:
        return int(row["id"])
    import secrets
    import string

    def _ref_code() -> str:
        alphabet = string.ascii_uppercase + string.digits
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(8))
            if not db.fetchone("SELECT id FROM users WHERE referral_code = ?", (code,)):
                return code

    db.execute(
        "INSERT INTO users (telegram_id, username, first_name, last_name, balance, status, is_banned, "
        "referral_code, is_partner, partner_balance, partner_rate, autopay_enabled, created_at) "
        "VALUES (?, ?, ?, ?, 0, 'Trial', 0, ?, 0, 0, 25, 0, ?)",
        (
            telegram_id,
            (frm.get("username") or "").lstrip("@") or None,
            frm.get("first_name"),
            frm.get("last_name"),
            _ref_code(),
            db.utcnow_iso(),
        ),
    )
    return db.last_id()


def _apply_referral(user: dict[str, Any], code: str, is_new: bool = True) -> None:
    # Привязываем реферера ТОЛЬКО для нового пользователя — иначе существующий
    # аккаунт можно задним числом «пригласить» вторым аккаунтом и фармить бонусы.
    if not code or user.get("referred_by") or not is_new:
        return
    ref = db.fetchone("SELECT id, referred_by FROM users WHERE referral_code = ?", (code,))
    if not ref or int(ref["id"]) == int(user["id"]):
        return
    # Запрещаем взаимные петли A↔B.
    if ref.get("referred_by") and int(ref["referred_by"]) == int(user["id"]):
        return
    db.execute("UPDATE users SET referred_by = ? WHERE id = ?", (ref["id"], user["id"]))


def handle_pre_checkout(query: dict[str, Any]) -> None:
    # Обязательно подтвердить в течение 10 секунд, иначе оплата отменится.
    payment_id = query.get("invoice_payload") or ""
    payment = fulfillment.get_payment(payment_id) if payment_id else None
    ok = bool(payment) and payment.get("status") == "pending"
    body: dict[str, Any] = {"pre_checkout_query_id": query["id"], "ok": ok}
    if not ok:
        body["error_message"] = "Платёж не найден или уже обработан. Попробуйте снова."
    api("answerPreCheckoutQuery", body)


def handle_successful_payment(message: dict[str, Any]) -> None:
    sp = message.get("successful_payment") or {}
    payment_id = sp.get("invoice_payload") or ""
    charge_id = sp.get("telegram_payment_charge_id") or ""
    chat_id = message["chat"]["id"]
    if not payment_id:
        return
    result = fulfillment.fulfill_payment(
        payment_id, stars_charge_id=charge_id, amount=sp.get("total_amount")
    )
    if result.get("ok"):
        api("sendMessage", {
            "chat_id": chat_id,
            "text": "✅ <b>Оплата получена!</b>\nПодписка активирована. Откройте приложение, чтобы получить ключ.",
            "parse_mode": "HTML",
            "reply_markup": _open_app_keyboard(),
        })
    else:
        api("sendMessage", {
            "chat_id": chat_id,
            "text": "⚠️ Оплата получена, но при активации возникла ошибка. Мы уже разбираемся — напишите в поддержку, если ключ не появился.",
            "parse_mode": "HTML",
        })


def handle_callback(cq: dict[str, Any]) -> None:
    """Кнопки в форуме «Выводы»: одобрить / отклонить."""
    data = str(cq.get("data") or "")
    cq_id = cq.get("id")
    from_id = int((cq.get("from") or {}).get("id") or 0)
    msg = cq.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    message_id = msg.get("message_id")
    thread_id = msg.get("message_thread_id")

    def answer(text: str = "") -> None:
        api("answerCallbackQuery", {"callback_query_id": cq_id, "text": text})

    # ── Опрос (кнопки в личке пользователя) ──
    if data == "survey:start" or data.startswith(("sv:", "svm:", "svd:")):
        answer()
        urow = db.fetchone("SELECT id FROM users WHERE telegram_id = ?", (from_id,))
        if not urow:
            return
        uid = int(urow["id"])
        try:
            if data == "survey:start":
                survey.start(api, uid, from_id)
            else:
                survey.handle_callback(api, uid, int(from_id), message_id, data)
        except Exception as exc:  # noqa: BLE001
            print(f"[bot] survey callback error: {type(exc).__name__}: {exc}", flush=True)
        return

    # АВТОРИЗАЦИЯ: только явные админы (TELEGRAM_ADMIN_ID / forum_admin_ids) и
    # только из настроенной форум-группы. Членство в группе прав НЕ даёт.
    if data.startswith("wd_ok_") or data.startswith("wd_no_"):
        if not forum.is_admin(from_id) or not forum.withdrawals_chat_ok(chat_id, thread_id):
            answer("Недостаточно прав")
            return

    if data.startswith("wd_ok_"):
        try:
            wid = int(data[len("wd_ok_"):])
        except ValueError:
            answer("Ошибка"); return
        w = db.fetchone("SELECT * FROM withdrawals WHERE id = ?", (wid,))
        if not w or w.get("status") != "pending":
            answer("Заявка уже обработана"); return
        services.set_pending_tx(from_id, wid)
        answer("Отправьте ссылку на транзакцию")
        prompt = {
            "chat_id": chat_id,
            "text": f"✍️ Отправьте <b>ссылку на транзакцию</b> для вывода #{wid} — ответом на это сообщение.",
            "parse_mode": "HTML",
        }
        if thread_id is not None:
            prompt["message_thread_id"] = thread_id
        api("sendMessage", prompt)
        return

    if data.startswith("wd_no_"):
        try:
            wid = int(data[len("wd_no_"):])
        except ValueError:
            answer("Ошибка"); return
        try:
            w = services.reject_withdrawal(wid)
            services.clear_pending_tx(from_id)
            forum.remove_withdrawal_message(w)
            answer("Отклонено — средства возвращены")
        except services.ServiceError as exc:
            answer(exc.message)
        return

    answer()


def handle_tx_link(message: dict[str, Any]) -> bool:
    """Ловит ссылку на транзакцию от админа после нажатия «Одобрить»."""
    from_id = int((message.get("from") or {}).get("id") or 0)
    # Ссылку на транзакцию принимаем только от админа и только из форум-группы.
    if not forum.is_admin(from_id):
        return False
    wid = services.get_pending_tx(from_id)
    if not wid:
        return False
    link = (message.get("text") or "").strip()
    chat_id = (message.get("chat") or {}).get("id")
    thread_id = message.get("message_thread_id")
    if not forum.withdrawals_chat_ok(chat_id, thread_id):
        return False

    def reply(text: str) -> None:
        p = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
        if thread_id is not None:
            p["message_thread_id"] = thread_id
        api("sendMessage", p)

    if not (link.startswith("http://") or link.startswith("https://")):
        reply("⚠️ Нужна ссылка (http/https) на транзакцию. Попробуйте ещё раз.")
        return True
    try:
        w = services.approve_withdrawal(wid, link)
    except services.ServiceError as exc:
        services.clear_pending_tx(from_id)
        reply(f"⚠️ {exc.message}")
        return True
    services.clear_pending_tx(from_id)
    user = fulfillment.get_user(int(w["user_id"]))
    if user and user.get("telegram_id"):
        forum.dm_withdrawal_approved(int(user["telegram_id"]), link)
    forum.remove_withdrawal_message(w)
    reply(f"✅ Вывод #{wid} одобрен, пользователь уведомлён.")
    return True


def handle_survey_text(message: dict[str, Any]) -> bool:
    """Свободный ответ в опросе (Q4 «Другое», Q8), если бот ждёт текст."""
    frm = message.get("from") or {}
    from_id = int(frm.get("id") or 0)
    chat_id = (message.get("chat") or {}).get("id")
    if not from_id or chat_id is None:
        return False
    urow = db.fetchone("SELECT id FROM users WHERE telegram_id = ?", (from_id,))
    if not urow:
        return False
    try:
        return survey.handle_text(api, int(urow["id"]), int(chat_id), message.get("text") or "")
    except Exception as exc:  # noqa: BLE001
        print(f"[bot] survey text error: {type(exc).__name__}: {exc}", flush=True)
        return False


def process_update(update: dict[str, Any]) -> None:
    try:
        if "pre_checkout_query" in update:
            handle_pre_checkout(update["pre_checkout_query"])
            return
        if "callback_query" in update:
            handle_callback(update["callback_query"])
            return
        message = update.get("message") or update.get("edited_message")
        if not message:
            return
        if message.get("successful_payment"):
            handle_successful_payment(message)
            return
        text = message.get("text") or ""
        if text.startswith("/start"):
            handle_start(message)
            return
        # Свободный ответ в опросе (если бот ждёт текст от этого пользователя)
        if text and handle_survey_text(message):
            return
        # Ссылка на транзакцию для одобренного вывода (ответ админа)
        if text and handle_tx_link(message):
            return
    except Exception as exc:  # noqa: BLE001
        print(f"[bot] ошибка обработки апдейта: {type(exc).__name__}: {exc}", flush=True)


# ─────────────────────────────────────────────────────────────
# long polling loop
# ─────────────────────────────────────────────────────────────

def run() -> None:
    if not TOKEN:
        print("[bot] TELEGRAM_BOT_TOKEN не задан — бот не запущен.", flush=True)
        # Не падаем, чтобы контейнер не рестартовал бесконечно.
        while True:
            time.sleep(3600)

    db.init_db()

    me = api("getMe")
    if me:
        print(f"[bot] запущен как @{me.get('username')}", flush=True)
    else:
        print("[bot] предупреждение: getMe не ответил (проверьте токен/сеть).", flush=True)

    # В режиме polling убираем webhook, иначе getUpdates вернёт ошибку.
    api("deleteWebhook", {"drop_pending_updates": False})

    # Единственная команда бота — /start.
    api("setMyCommands", {"commands": [{"command": "start", "description": "Запустить BlinVPN"}]})

    # Фоновая рассылка напоминаний об окончании подписки (по локальной БД).
    reminders.start_background(api, log=lambda m: print(m, flush=True))

    offset = 0
    allowed = ["message", "edited_message", "callback_query", "pre_checkout_query"]
    while True:
        try:
            updates = api("getUpdates", {"offset": offset, "timeout": 30, "allowed_updates": allowed}, timeout=40)
            if not updates:
                continue
            for upd in updates:
                offset = max(offset, int(upd["update_id"]) + 1)
                process_update(upd)
        except KeyboardInterrupt:
            break
        except Exception as exc:  # noqa: BLE001
            print(f"[bot] ошибка цикла: {type(exc).__name__}: {exc}", flush=True)
            time.sleep(3)


if __name__ == "__main__":
    run()
