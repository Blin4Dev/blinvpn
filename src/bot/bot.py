from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

# src/core и src/api в path
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
import blacklist  # type: ignore
import names  # type: ignore

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
SUPPORT_URL = _env("SUPPORT_URL")  # fallback если нет miniapp

# premium emoji (нужен premium/fragment + bot api 9.4+)
EMOJI_FOX = _env("EMOJI_FOX", default="5283051451889756068")
EMOJI_KEY = _env("EMOJI_KEY", default="6005570495603282482")
EMOJI_CHAT = _env("EMOJI_CHAT", default="5994297722574737553")


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
        # 429: один retry по retry_after
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


def _support_button(**extra: Any) -> Optional[dict[str, Any]]:
    """кнопка «поддержка» в мини-приложении."""
    if MINIAPP_URL:
        return {"text": "Поддержка", "web_app": {"url": f"{MINIAPP_URL}/support"}, **extra}
    if SUPPORT_URL:
        return {"text": "Поддержка", "url": SUPPORT_URL, **extra}
    return None


def _open_app_keyboard() -> dict[str, Any]:
    """клавиатура для сервисных сообщений (оплата)."""
    buttons: list[list[dict[str, Any]]] = []
    if MINIAPP_URL:
        buttons.append([{"text": "🚀 Открыть BlinVPN", "web_app": {"url": MINIAPP_URL}}])
    sup = _support_button()
    if sup:
        buttons.append([{**sup, "text": "💬 Поддержка"}])
    return {"inline_keyboard": buttons} if buttons else {}


def _utf16_len(s: str) -> int:
    """длина в utf-16 code units (смещения entity в telegram)."""
    return len(s.encode("utf-16-le")) // 2


def _welcome_text_entities() -> tuple[str, list[dict[str, Any]]]:
    """приветствие: premium-эмодзи + bold «добро пожаловать!»."""
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
    """/start: приветствие + кнопки «запустить» / «поддержка» (bot api 9.4+)."""
    text, entities = _welcome_text_entities()
    launch = _launch_button()
    rows: list[list[dict[str, Any]]] = [[{**launch, "style": "primary", "icon_custom_emoji_id": EMOJI_KEY}]]
    sup = _support_button(icon_custom_emoji_id=EMOJI_CHAT)
    if sup:
        rows.append([sup])
    api("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "entities": entities,
        "link_preview_options": {"is_disabled": True},
        "reply_markup": {"inline_keyboard": rows},
    })


def _send_banned(chat_id: int) -> None:
    """заблокированному: сообщение о блокировке вместо приветствия."""
    text = "⛔️ Ваш аккаунт заблокирован за нарушение правил сервиса."
    api("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "entities": [
            {"type": "custom_emoji", "custom_emoji_id": reminders.EMOJI_STOP, "offset": 0, "length": 2},
            {"type": "bold", "offset": 3, "length": len(text) - 3},
        ],
        **({"reply_markup": {"inline_keyboard": [[_support_button()]]}} if _support_button() else {}),
    })


def handle_start(message: dict[str, Any]) -> None:
    chat_id = message["chat"]["id"]
    frm = message.get("from") or {}
    telegram_id = int(frm.get("id") or chat_id)

    # payload у /start
    text = message.get("text") or ""
    parts = text.split(maxsplit=1)
    payload = parts[1].strip() if len(parts) > 1 else ""

    existed = db.fetchone("SELECT id FROM users WHERE telegram_id = ?", (telegram_id,)) is not None
    user = fulfillment.get_user(_ensure_user(telegram_id, frm))
    is_new = not existed

    # blacklist при входе
    try:
        blacklist.enforce(user, log=lambda m: print(m, flush=True))
    except Exception as exc:  # noqa: BLE001
        print(f"[blacklist] ошибка проверки: {exc}", flush=True)
    if user and user.get("is_banned"):
        _send_banned(chat_id)
        return

    # first_start_at один раз
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
    elif payload.startswith("pay_") and user and _send_payment_return(chat_id, user, payload[4:].strip()):
        return
    elif payload.startswith("payfail_") and user and _send_payment_return(chat_id, user, payload[8:].strip(), failed=True):
        return

    _send_welcome(chat_id)


def _send_payment_return(chat_id: int, user: dict[str, Any], payment_id: str, failed: bool = False) -> bool:
    """возврат из platega: кнопка на платёж в мини-приложении; false если не найден."""
    if not MINIAPP_URL or not re.fullmatch(r"[a-f0-9]{16,64}", payment_id or ""):
        return False
    pay = db.fetchone("SELECT status FROM payments WHERE payment_id = ? AND user_id = ?", (payment_id, int(user["id"])))
    if not pay:
        return False
    status = pay.get("status")
    if status in ("paid", "processing"):
        text, failed = "✅ Оплата прошла", False
    elif status == "failed" or failed:
        text, failed = ("❌ Платёж отклонён\n\nПроизошла ошибка на стороне провайдера. "
                        "Если деньги списались, они вернутся автоматически в течение 3 дней."), True
    else:
        text = "Возвращаемся к оплате"
    api("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "reply_markup": {"inline_keyboard": [[{
            "text": "Попробовать снова" if failed else "Открыть", "style": "primary",
            "web_app": {"url": f"{MINIAPP_URL}/payment/return?payment_id={payment_id}{'&result=fail' if failed else ''}"},
        }]]},
    })
    return True


def _apply_tracking(user: dict[str, Any], code: str, frm: dict[str, Any], is_new: bool) -> None:
    """учёт перехода по трекинг-ссылке + её приветствие."""
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
    """активация промокода из deep-link (/start promo_CODE)."""
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
    """создаёт пользователя в бд при отсутствии; возвращает internal id."""
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
        "VALUES (?, ?, ?, ?, 0, 'None', 0, ?, 0, 0, 25, 0, ?)",
        (
            telegram_id,
            names.tg_username(frm.get("username")),
            None,  # имя/фамилию не храним
            None,
            _ref_code(),
            db.utcnow_iso(),
        ),
    )
    return db.last_id()


def _apply_referral(user: dict[str, Any], code: str, is_new: bool = True) -> None:
    # реферер только у нового юзера (иначе фарм со старого)
    if not code or user.get("referred_by") or not is_new:
        return
    # ref_<uid>; старые ref_<CODE> ок
    ref = None
    if code.isdigit():
        ref = db.fetchone("SELECT id, referred_by FROM users WHERE id = ?", (int(code),))
    if not ref:
        ref = db.fetchone("SELECT id, referred_by FROM users WHERE referral_code = ?", (code,))
    if not ref or int(ref["id"]) == int(user["id"]):
        return
    # без петель a<->b
    if ref.get("referred_by") and int(ref["referred_by"]) == int(user["id"]):
        return
    db.execute("UPDATE users SET referred_by = ? WHERE id = ?", (ref["id"], user["id"]))


def handle_pre_checkout(query: dict[str, Any]) -> None:
    # подтвердить за 10с
    payment_id = query.get("invoice_payload") or ""
    payment = fulfillment.get_payment(payment_id) if payment_id else None
    ok = fulfillment.stars_precheckout_ok(payment, query)
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
        payment_id, stars_charge_id=charge_id, amount=sp.get("total_amount"),
        stars_payer_id=(message.get("from") or {}).get("id"),
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
    """кнопки форума «выводы»: одобрить / отклонить."""
    data = str(cq.get("data") or "")
    cq_id = cq.get("id")
    from_id = int((cq.get("from") or {}).get("id") or 0)
    msg = cq.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    message_id = msg.get("message_id")
    thread_id = msg.get("message_thread_id")

    def answer(text: str = "") -> None:
        api("answerCallbackQuery", {"callback_query_id": cq_id, "text": text})

    # опрос
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

    # старые кнопки выводов: только панель
    if data.startswith("wd_ok_") or data.startswith("wd_no_"):
        answer("Выводы обрабатываются в панели: Пользователи → Выводы")
        return

    answer()


def handle_survey_text(message: dict[str, Any]) -> bool:
    """свободный ответ в опросе (q4 «другое», q8), если бот ждёт текст."""
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
        # текст ответа в опросе
        if text and handle_survey_text(message):
            return
    except Exception as exc:  # noqa: BLE001
        print(f"[bot] ошибка обработки апдейта: {type(exc).__name__}: {exc}", flush=True)


def run() -> None:
    if not TOKEN:
        print("[bot] TELEGRAM_BOT_TOKEN не задан — бот не запущен.", flush=True)
        # не валимся (контейнер иначе рестартит)
        while True:
            time.sleep(3600)

    db.init_db()

    me = api("getMe")
    if me:
        print(f"[bot] запущен как @{me.get('username')}", flush=True)
    else:
        print("[bot] предупреждение: getMe не ответил (проверьте токен/сеть).", flush=True)

    # polling: снять webhook
    api("deleteWebhook", {"drop_pending_updates": False})

    # команда: /start
    api("setMyCommands", {"commands": [{"command": "start", "description": "Запустить BlinVPN"}]})

    # фоновые reminders по локальной бд
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
