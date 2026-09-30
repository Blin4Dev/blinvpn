from __future__ import annotations

import math
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

import database as db  # type: ignore


def _trial_days_text() -> str:
    """срок пробной из настроек: «3 дня», «7 дней», …"""
    try:
        n = max(1, int(float(db.get_setting("trial_days", "3") or 3)))
    except (TypeError, ValueError):
        n = 3
    a, b = n % 100, n % 10
    word = "дней" if 11 <= a <= 14 else "день" if b == 1 else "дня" if 2 <= b <= 4 else "дней"
    return f"{n} {word}"
import services  # type: ignore
import fulfillment  # type: ignore
import provisioning  # type: ignore
import grace  # type: ignore

EMOJI_WARN_SOFT = (os.getenv("EMOJI_WARN_SOFT") or "5447644880824181073").strip()
EMOJI_WARN_HARD = (os.getenv("EMOJI_WARN_HARD") or "5420323339723881652").strip()
EMOJI_STOP = (os.getenv("EMOJI_STOP") or "5260293700088511294").strip()
EMOJI_SIREN = (os.getenv("EMOJI_SIREN") or "5395695537687123235").strip()
EMOJI_ANTIABUSE = (os.getenv("EMOJI_ANTIABUSE") or "5420323339723881652").strip()

# интервал проверки, сек
INTERVAL = max(60, int(os.getenv("REMINDER_INTERVAL", "300") or "300"))

_H = 3600
_STAGE_72 = 72 * _H
_STAGE_48 = 48 * _H
_STAGE_24 = 24 * _H
_LOOKBACK = 24 * _H  # окно для expired; дальше del*

MINIAPP_URL = (os.getenv("MINIAPP_URL") or "").strip().rstrip("/")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _utf16_len(s: str) -> int:
    """длина в utf-16 code units (смещения entity в telegram)."""
    return len(s.encode("utf-16-le")) // 2


def _build(segments: list[tuple[str, Optional[dict[str, Any]]]]) -> tuple[str, list[dict[str, Any]]]:
    """текст + entity с utf-16 смещениями."""
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


def _plural_hours(n: int) -> str:
    """русская форма: 1 час / 2 часа / 5 часов."""
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} час"
    if 2 <= n % 10 <= 4 and not (12 <= n % 100 <= 14):
        return f"{n} часа"
    return f"{n} часов"


_TAIL = " ваша подписка закончится. Не забудьте продлить подписку, чтобы сохранить доступ в свободный интернет."


_TAIL_NO_RENEW = (" ваша подписка закончится и будет удалена. Продление этой подписки недоступно — "
                  "после окончания вы сможете оформить новую.")


def _message_no_renew(stage: str, remaining_sec: float) -> tuple[str, list[dict[str, Any]]]:
    """напоминания для no_renew (без призыва продлить)."""
    bold = {"type": "bold"}
    if stage == "1d":
        hours = max(1, math.ceil(remaining_sec / _H))
        when, emoji = f"Через {_plural_hours(hours)}", EMOJI_WARN_HARD
    else:
        when, emoji = ("Через 3 дня" if stage == "3d" else "Через 2 дня"), EMOJI_WARN_SOFT
    return _build([
        ("⚠️", {"type": "custom_emoji", "custom_emoji_id": emoji}),
        (" ", None),
        ("Подписка скоро закончится!", bold),
        ("\n\n", None),
        (when, bold),
        (_TAIL_NO_RENEW, None),
    ])


def _message_for(stage: str, remaining_sec: float, no_renew: bool = False) -> tuple[str, list[dict[str, Any]]]:
    if no_renew:
        return _message_no_renew(stage, remaining_sec)
    bold = {"type": "bold"}
    if stage == "3d":
        return _build([
            ("⚠️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_WARN_SOFT}),
            (" ", None),
            ("Подписка почти закончилась!", bold),
            ("\n\nЧерез ", None),
            ("3 дня", bold),
            (_TAIL, None),
        ])
    if stage == "2d":
        return _build([
            ("⚠️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_WARN_SOFT}),
            (" ", None),
            ("Подписка почти закончилась!", bold),
            ("\n\nЧерез ", None),
            ("2 дня", bold),
            (_TAIL, None),
        ])
    if stage == "1d":
        hours = max(1, math.ceil(remaining_sec / _H))
        return _build([
            ("⚠️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_WARN_HARD}),
            (" ", None),
            ("Подписка вот-вот закончится!", bold),
            ("\n\n", None),
            (f"Через {_plural_hours(hours)}", bold),
            (_TAIL, None),
        ])
    return _build([
        ("⛔️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_STOP}),
        (" ", None),
        ("Подписка закончилась!", bold),
        ("\n\nВы не успели продлить подписку заранее и она была отключена. "
         "Но оплатить её можно в любой момент в личном кабинете.", None),
    ])


def _stage_for(remaining_sec: float) -> Optional[str]:
    if remaining_sec <= 0:
        return "expired"
    if remaining_sec <= _STAGE_24:
        return "1d"
    if remaining_sec <= _STAGE_48:
        return "2d"
    if remaining_sec <= _STAGE_72:
        return "3d"
    return None


def _renew_keyboard() -> Optional[dict[str, Any]]:
    if not MINIAPP_URL:
        return None
    return {"inline_keyboard": [[{"text": "Продлить подписку", "web_app": {"url": MINIAPP_URL}}]]}


def _already_sent(subscription_id: int, stage: str, cycle_exp: str) -> bool:
    row = db.fetchone(
        "SELECT cycle_expires_at FROM sub_reminders WHERE subscription_id = ? AND stage = ?",
        (subscription_id, stage),
    )
    return bool(row) and str(row["cycle_expires_at"]) == cycle_exp


def _mark_sent(subscription_id: int, stage: str, cycle_exp: str) -> None:
    db.execute(
        "INSERT OR REPLACE INTO sub_reminders (subscription_id, stage, cycle_expires_at, sent_at) "
        "VALUES (?, ?, ?, ?)",
        (subscription_id, stage, cycle_exp, db.utcnow_iso()),
    )


def run_once(api: Callable[..., Any], log: Callable[[str], None] = print) -> int:
    """один проход: созревшие подписки → недостающие напоминания; число отправок."""
    now = _utcnow()
    lo = (now - timedelta(seconds=_LOOKBACK)).isoformat()
    hi = (now + timedelta(seconds=_STAGE_72)).isoformat()

    rows = db.fetchall(
        "SELECT s.id AS sub_id, s.expires_at AS expires_at, u.telegram_id AS telegram_id, "
        "COALESCE(s.no_renew, 0) AS no_renew "
        "FROM subscriptions s JOIN users u ON u.id = s.user_id "
        "WHERE s.status IN ('Active', 'Expired') AND s.expires_at IS NOT NULL "
        "AND s.expires_at BETWEEN ? AND ? "
        "AND COALESCE(u.is_banned, 0) = 0 AND u.telegram_id IS NOT NULL",
        (lo, hi),
    )

    sent = 0
    for row in rows:
        exp_raw = str(row["expires_at"])
        exp = _parse_iso(exp_raw)
        if exp is None:
            continue
        remaining = (exp - now).total_seconds()
        stage = _stage_for(remaining)
        if stage is None:
            continue
        no_renew = bool(row.get("no_renew"))
        if no_renew and stage == "expired":
            continue  # удалит run_expiry_cleanup
        sub_id = int(row["sub_id"])
        if _already_sent(sub_id, stage, exp_raw):
            continue
        chat_id = int(row["telegram_id"])
        text, entities = _message_for(stage, remaining, no_renew)
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "entities": entities,
            "link_preview_options": {"is_disabled": True},
        }
        kb = _renew_keyboard()
        if kb and no_renew:
            kb = {"inline_keyboard": [[{"text": "Открыть BlinVPN", "web_app": {"url": MINIAPP_URL}}]]}
        if kb:
            payload["reply_markup"] = kb

        result = api("sendMessage", payload)
        if result is not None:
            _mark_sent(sub_id, stage, exp_raw)
            sent += 1
        else:
            log(f"[reminders] не удалось отправить {stage} для подписки {sub_id}")
        time.sleep(0.05)  # ~20 msg/s

    if sent:
        log(f"[reminders] отправлено напоминаний: {sent}")
    return sent


# онбординг от first_start_at; любая подписка обрывает

OB_EMOJI = {
    "m30": "5341715473882955310",
    "h24": "5424972470023104089",
    "h48": "5460755126761312667",
    "h71": "5224607267797606837",
    "h72": "5399913388845322366",
}
OB_CHAR = {"m30": "⚙️", "h24": "🔥", "h48": "🚩", "h71": "☄️", "h72": "🌧"}

# (этап, часы)
OB_STAGES: list[tuple[str, float]] = [
    ("m30", 0.5), ("h24", 24.0), ("h48", 48.0), ("h71", 71.0), ("h72", 72.0)
]
OB_DISCOUNT_PERCENT = 10
OB_DISCOUNT_HOURS = 24


def _ob_message(stage: str) -> tuple[str, list[dict[str, Any]]]:
    b = {"type": "bold"}
    em = {"type": "custom_emoji", "custom_emoji_id": OB_EMOJI[stage]}
    ch = OB_CHAR[stage]
    if stage == "m30":
        return _build([
            (ch, em), (" ", None), ("Вы всё еще не оформили подписку!", b),
            ("\n\nА ведь с BlinVPN вы бы получили доступ в свободный интернет, "
             "безопасность и качественную поддержку.", None),
        ])
    if stage == "h24":
        return _build([
            (ch, em), (" ", None), ("Где ваша подписка?", b),
            ("\n\nПрошли уже сутки, а подписки у вас всё ещё нет. "
             f"Вы можете бесплатно протестировать {_trial_days_text()} и проверить качество VPN", None),
        ])
    if stage == "h48":
        return _build([
            (ch, em), (" ", None), ("Слушай сюда, ты так и не оформил подписку...", b),
            ("\n\nМы даём тебе скидку ", None), ("10%", b),
            (" на покупку, но она действует только один раз и только в течение 24 часов. "
             "Если не успеешь купить... потеряешь её.", None),
        ])
    if stage == "h71":
        return _build([
            (ch, em), (" ", None), ("Остался один час...", b),
            ("\n\nВы ещё помните про персональную скидку ", None), ("10%", b),
            ("? Так вот... Остался всего час, чтобы успеть воспользоваться ею.", None),
        ])
    return _build([
        (ch, em), (" ", None), ("Мы пытались...", b),
        ("\n\nЗдесь могло быть ещё одно сообщение, чтобы заставить вас купить подписку, "
         "но вы хорошо держитесь. Поэтому мы оставим вас, но знайте — ", None),
        ("если свободный интернет, то только BlinVPN", b), (".", None),
    ])


def _ob_keyboard(stage: str) -> Optional[dict[str, Any]]:
    # h72 без кнопки
    if stage == "h72" or not MINIAPP_URL:
        return None
    return {"inline_keyboard": [[{"text": "Оформить подписку", "web_app": {"url": MINIAPP_URL}}]]}


def _ob_mark(user_id: int, stage: str) -> None:
    db.execute(
        "INSERT OR IGNORE INTO onboarding_reminders (user_id, stage, sent_at) VALUES (?, ?, ?)",
        (user_id, stage, db.utcnow_iso()),
    )


def run_onboarding_once(api: Callable[..., Any], log: Callable[[str], None] = print) -> int:
    now = _utcnow()
    lo = (now - timedelta(hours=96)).isoformat()  # окно 4 суток
    rows = db.fetchall(
        "SELECT u.id AS uid, u.telegram_id AS tg, u.first_start_at AS fs FROM users u "
        "WHERE u.telegram_id IS NOT NULL AND COALESCE(u.is_banned, 0) = 0 "
        "AND u.first_start_at IS NOT NULL AND u.first_start_at >= ? "
        "AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)",
        (lo,),
    )
    sent = 0
    for r in rows:
        fs = _parse_iso(r["fs"])
        if not fs:
            continue
        hours = (now - fs).total_seconds() / 3600.0
        done = {x["stage"] for x in db.fetchall(
            "SELECT stage FROM onboarding_reminders WHERE user_id = ?", (r["uid"],))}
        due = [name for name, th in OB_STAGES if hours >= th and name not in done]
        if not due:
            continue
        # после простоя шлём только последнюю стадию; остальные mark без send
        target = due[-1]
        for name in due[:-1]:
            _ob_mark(r["uid"], name)

        text, entities = _ob_message(target)
        payload: dict[str, Any] = {
            "chat_id": int(r["tg"]),
            "text": text,
            "entities": entities,
            "link_preview_options": {"is_disabled": True},
        }
        kb = _ob_keyboard(target)
        if kb:
            payload["reply_markup"] = kb
        if api("sendMessage", payload) is not None:
            _ob_mark(r["uid"], target)
            if target == "h48":
                try:
                    services.grant_personal_discount(int(r["uid"]), OB_DISCOUNT_PERCENT, OB_DISCOUNT_HOURS)
                except Exception:  # noqa: BLE001
                    pass
            sent += 1
        else:
            log(f"[onboarding] не удалось отправить {target} пользователю {r['uid']}")
        time.sleep(0.05)  # ~20 msg/s

    if sent:
        log(f"[onboarding] отправлено сообщений: {sent}")
    return sent


EMOJI_TRIAL_FAIL = (os.getenv("EMOJI_TRIAL_FAIL") or "5210952531676504517").strip()


def _trial_no_connect_message() -> tuple[str, list[dict[str, Any]]]:
    b = {"type": "bold"}
    em = {"type": "custom_emoji", "custom_emoji_id": EMOJI_TRIAL_FAIL}
    return _build([
        ("❌", em), (" ", None), ("Кажется, не всё прошло гладко...", b),
        ("\n\nВы подключили пробную подписку, но так и ни разу не подключились. "
         "Найти инструкцию можно в разделе «Управление подпиской» → «Добавить подписку».\n"
         "Если подключиться не получится — напишите в поддержку.", None),
    ])


def run_trial_connection_checks(api: Callable[..., Any], log: Callable[[str], None] = print) -> int:
    """через 15 мин после trial: ни разу не подключился → лс."""
    try:
        import provisioning  # type: ignore
    except Exception:  # noqa: BLE001
        return 0
    now = _utcnow()
    cutoff = (now - timedelta(minutes=15)).isoformat()
    give_up = (now - timedelta(hours=6)).isoformat()
    rows = db.fetchall(
        "SELECT * FROM trial_checks WHERE checked = 0 AND granted_at <= ?", (cutoff,))
    sent = 0
    for r in rows:
        tg = int(r.get("telegram_id") or 0)
        connected = provisioning.user_ever_connected(tg) if tg else None
        if connected is None:
            # unknown: закрываем старые записи
            if str(r.get("granted_at") or "") <= give_up:
                db.execute("UPDATE trial_checks SET checked = 1 WHERE id = ?", (r["id"],))
            continue
        db.execute("UPDATE trial_checks SET checked = 1 WHERE id = ?", (r["id"],))
        if connected:
            continue
        # ещё trial?
        sub = db.fetchone("SELECT type, status FROM subscriptions WHERE id = ?", (r["subscription_id"],))
        if not sub or sub.get("type") != "trial":
            continue
        text, entities = _trial_no_connect_message()
        payload: dict[str, Any] = {
            "chat_id": tg, "text": text, "entities": entities,
            "link_preview_options": {"is_disabled": True},
        }
        if MINIAPP_URL:
            payload["reply_markup"] = {
                "inline_keyboard": [[{"text": "Открыть BlinVPN", "web_app": {"url": MINIAPP_URL}}],
                                    [{"text": "Поддержка", "web_app": {"url": f"{MINIAPP_URL}/support"}}]]}
        if api("sendMessage", payload) is not None:
            sent += 1
        time.sleep(0.05)  # ~20 msg/s
    if sent:
        log(f"[trial-check] отправлено сообщений: {sent}")
    return sent


SURVEY_DELAY_HOURS = 1        # часов после первого коннекта
SURVEY_GIVEUP_DAYS = 14       # не ждать дольше


def run_survey_invites(api: Callable[..., Any], log: Callable[[str], None] = print) -> int:
    """через час после первого vpn-коннекта: приглашение в опрос (connected_at кэшируем)."""
    try:
        import provisioning  # type: ignore
        import survey  # type: ignore
    except Exception:  # noqa: BLE001
        return 0
    now = _utcnow()
    giveup_before = (now - timedelta(days=SURVEY_GIVEUP_DAYS)).isoformat()
    rows = db.fetchall(
        "SELECT si.user_id AS uid, si.telegram_id AS tg, si.enrolled_at AS enrolled, "
        "si.connected_at AS conn FROM survey_invites si JOIN users u ON u.id = si.user_id "
        "WHERE si.invited = 0 AND si.gave_up = 0 AND si.telegram_id IS NOT NULL "
        "AND COALESCE(u.is_banned, 0) = 0"
    )
    sent = 0
    for r in rows:
        uid, tg = int(r["uid"]), int(r["tg"])
        conn_iso = r.get("conn")
        if not conn_iso:
            # connected_at неизвестен -> remnawave
            u = db.fetchone("SELECT email FROM users WHERE id = ?", (uid,))
            conn_iso = provisioning.user_first_connected_at(tg, (u or {}).get("email"))
            if not conn_iso:
                # так и не подключился: сдаёмся
                if str(r.get("enrolled") or "") <= giveup_before:
                    db.execute("UPDATE survey_invites SET gave_up = 1 WHERE user_id = ?", (uid,))
                continue
            db.execute("UPDATE survey_invites SET connected_at = ? WHERE user_id = ?", (conn_iso, uid))
        conn_dt = _parse_iso(conn_iso)
        if not conn_dt:
            continue
        if (now - conn_dt).total_seconds() < SURVEY_DELAY_HOURS * 3600:
            continue  # ещё рано
        if survey.has_completed(uid):
            db.execute("UPDATE survey_invites SET invited = 1 WHERE user_id = ?", (uid,))
            continue
        # mark до send (антидубль если ack потерялся)
        # invite строго один раз
        db.execute(
            "UPDATE survey_invites SET invited = 1, invited_at = ? WHERE user_id = ?",
            (db.utcnow_iso(), uid),
        )
        if api("sendMessage", survey.invite_payload(tg)) is not None:
            sent += 1
        else:
            log(f"[survey] не удалось отправить приглашение пользователю {uid}")
        time.sleep(0.05)  # ~20 msg/s
    if sent:
        log(f"[survey] отправлено приглашений: {sent}")
    return sent


_DAY = 24 * _H
# давно истёкшие удаляем молча
_DELETE_NOTIFY_WINDOW_DAYS = 2


def _plural_days(n: int) -> str:
    a, b = n % 100, n % 10
    if b == 1 and a != 11:
        return f"{n} день"
    if 2 <= b <= 4 and not (12 <= a <= 14):
        return f"{n} дня"
    return f"{n} дней"


def _deletion_warning(days_left: int) -> tuple[str, list[dict[str, Any]]]:
    bold = {"type": "bold"}
    return _build([
        ("🚨", {"type": "custom_emoji", "custom_emoji_id": EMOJI_SIREN}),
        (" ", None),
        ("Подписка скоро удалится!", bold),
        ("\n\nУ вас есть неоплаченная подписка. Продлите её, либо она будет удалена автоматически через ", None),
        (f"{_plural_days(days_left)}.", bold),
    ])


def _deleted_message() -> tuple[str, list[dict[str, Any]]]:
    return _build([
        ("⛔️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_STOP}),
        (" ", None),
        ("Подписка удалена.", {"type": "bold"}),
        ("\n\nСрок оплаты истёк — подписка была удалена навсегда. "
         "Оформить новую можно в любой момент.", None),
    ])


def _deleted_no_renew_message() -> tuple[str, list[dict[str, Any]]]:
    return _build([
        ("⛔️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_STOP}),
        (" ", None),
        ("Подписка удалена.", {"type": "bold"}),
        ("\n\nСрок действия подписки закончился — она удалена. "
         "Оформить новую можно в любой момент.", None),
    ])


def _send(api: Callable[..., Any], chat_id: int, built: tuple[str, list[dict[str, Any]]],
          keyboard_text: Optional[str]) -> bool:
    text, entities = built
    payload: dict[str, Any] = {
        "chat_id": chat_id, "text": text, "entities": entities,
        "link_preview_options": {"is_disabled": True},
    }
    if keyboard_text and MINIAPP_URL:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": keyboard_text, "web_app": {"url": MINIAPP_URL}}]]}
    return api("sendMessage", payload) is not None


def _aa_grace_hours() -> int:
    try:
        import antiabuse  # type: ignore
        return int(antiabuse.limits()["grace_hours"])
    except Exception:  # noqa: BLE001
        return 24


def _antiabuse_warning(kind: str, count: int, limit: int) -> tuple[str, list[dict[str, Any]]]:
    bold = {"type": "bold"}

    def dev(n: int) -> str:
        if n % 10 == 1 and n % 100 != 11:
            return "устройство"
        return "устройства" if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else "устройств"

    if kind == "hwid":
        what = f"К вашей подписке подключено {count} {dev(count)}, а по тарифу — {limit}."
    else:
        what = f"Вашей подпиской одновременно пользуются с {count} разных IP-адресов, а по тарифу — {limit} {dev(limit)}."
    return _build([
        ("⚠️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_ANTIABUSE}),
        (" ", None),
        ("Обнаружено нарушение!", bold),
        (f"\n\n{what} Передавать подписку другим людям запрещено.\n\n", None),
        (f"Если через {_plural_hours(_aa_grace_hours())} нарушение сохранится, подписка будет заблокирована.", bold),
        (" Отключите лишние устройства — или докупите устройства в приложении, если их нужно больше.", None),
    ])


def send_antiabuse_warning(api: Callable[..., Any], chat_id: int, kind: str, count: int, limit: int) -> bool:
    return _send(api, chat_id, _antiabuse_warning(kind, count, limit), "Открыть BlinVPN")


def delete_subscription(sub: dict[str, Any], log: Callable[[str], None] = print) -> bool:
    """удалить неоплаченную sub (rw + status Deleted); при сбое remnawave бд не трогаем."""
    uid = int(sub["user_id"])
    # другая активная sub на том же rw-аккаунте -> только mark строки
    other_alive = db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND id != ? AND status = 'Active' "
        "AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
        (uid, int(sub["id"]), _utcnow().isoformat()),
    )
    if not other_alive:
        user = db.fetchone("SELECT telegram_id, email FROM users WHERE id = ?", (uid,)) or {}
        if provisioning.is_configured():
            res = provisioning.delete_user(user.get("telegram_id"), user.get("email"))
            if not res.get("ok"):
                log(f"[expiry] Remnawave: не удалось удалить пользователя {uid}: {res.get('error')}")
                return False
    db.execute(
        "UPDATE subscriptions SET status = 'Deleted', deleted_at = ? WHERE id = ? AND status IN ('Active', 'Expired')",
        (db.utcnow_iso(), int(sub["id"])),
    )
    try:
        fulfillment._sync_user_status(uid)
    except Exception:  # noqa: BLE001
        pass
    log(f"[expiry] подписка #{sub['id']} (user {uid}) удалена после окончания")
    return True


def run_expiry_cleanup(api: Callable[..., Any], log: Callable[[str], None] = print) -> int:
    """истёкшие: предупреждения «удалится через N дней», на 7-й день удаление."""
    now = _utcnow()
    delete_after = int(fulfillment.DELETE_AFTER_DAYS)
    rows = db.fetchall(
        "SELECT s.id, s.user_id, s.expires_at, u.telegram_id AS telegram_id, COALESCE(u.is_banned, 0) AS banned, "
        "COALESCE(s.no_renew, 0) AS no_renew "
        "FROM subscriptions s JOIN users u ON u.id = s.user_id "
        "WHERE s.status IN ('Active', 'Expired') AND s.type IN ('vpn', 'trial') "
        "AND s.expires_at IS NOT NULL AND s.expires_at <= ?",
        (now.isoformat(),),
    )
    done = 0
    for row in rows:
        if row.get("banned"):
            continue  # заблокированных не трогаем
        exp_raw = str(row["expires_at"])
        exp = _parse_iso(exp_raw)
        if exp is None:
            continue
        # продлили другой sub
        if db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND id != ? AND status = 'Active' "
            "AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
            (int(row["user_id"]), int(row["id"]), now.isoformat()),
        ):
            continue
        days_since = int((now - exp).total_seconds() // _DAY)
        sub_id = int(row["id"])
        chat_id = int(row["telegram_id"]) if row.get("telegram_id") else None

        no_renew = bool(row.get("no_renew"))
        # no_renew: удаляем сразу
        limit = 0 if no_renew else delete_after
        if days_since >= limit:
            if not delete_subscription(row, log):
                continue
            done += 1
            fresh = days_since < limit + _DELETE_NOTIFY_WINDOW_DAYS
            if chat_id and fresh and not _already_sent(sub_id, "deleted", exp_raw):
                msg = _deleted_no_renew_message() if no_renew else _deleted_message()
                if _send(api, chat_id, msg, "Оформить подписку"):
                    _mark_sent(sub_id, "deleted", exp_raw)
                time.sleep(0.05)
            continue

        if days_since < 1 or not chat_id:
            continue  # день 0: уже ушло expired
        days_left = delete_after - days_since  # 6..1
        stage = f"del{days_left}"
        if _already_sent(sub_id, stage, exp_raw):
            continue
        if _send(api, chat_id, _deletion_warning(days_left), "Продлить подписку"):
            _mark_sent(sub_id, stage, exp_raw)
            done += 1
        time.sleep(0.05)
    if done:
        log(f"[expiry] предупреждений/удалений: {done}")
    return done


def _blacklist_refresh_sec() -> int:
    try:
        import blacklist  # type: ignore
        return max(300, int(blacklist.REFRESH_SEC))
    except Exception:  # noqa: BLE001
        return 3600


def start_background(api: Callable[..., Any], log: Callable[[str], None] = print) -> threading.Thread:
    """фоновый цикл напоминаний в демон-потоке."""

    def _loop() -> None:
        log(f"[reminders] фоновый рассыльщик запущен (интервал {INTERVAL}с)")
        aa_counter = 0
        bl_last = 0.0
        while True:
            # blacklist раз в час (+ на старте)
            if time.time() - bl_last >= _blacklist_refresh_sec():
                bl_last = time.time()
                try:
                    import blacklist  # type: ignore
                    blacklist.refresh(log)
                except Exception as exc:  # noqa: BLE001
                    log(f"[blacklist] ошибка обновления: {type(exc).__name__}: {exc}")
            # grace (тихо)
            try:
                grace.run_once(log)
            except Exception as exc:  # noqa: BLE001
                log(f"[grace] ошибка прохода: {type(exc).__name__}: {exc}")
            try:
                run_once(api, log)
            except Exception as exc:  # noqa: BLE001
                log(f"[reminders] ошибка прохода: {type(exc).__name__}: {exc}")
            try:
                run_expiry_cleanup(api, log)
            except Exception as exc:  # noqa: BLE001
                log(f"[expiry] ошибка прохода: {type(exc).__name__}: {exc}")
            try:
                run_onboarding_once(api, log)
            except Exception as exc:  # noqa: BLE001
                log(f"[onboarding] ошибка прохода: {type(exc).__name__}: {exc}")
            try:
                run_trial_connection_checks(api, log)
            except Exception as exc:  # noqa: BLE001
                log(f"[trial-check] ошибка прохода: {type(exc).__name__}: {exc}")
            try:
                run_survey_invites(api, log)
            except Exception as exc:  # noqa: BLE001
                log(f"[survey] ошибка прохода: {type(exc).__name__}: {exc}")
            # antiabuse ~раз в 10 мин
            aa_counter += 1
            if aa_counter * INTERVAL >= 600:
                aa_counter = 0
                try:
                    import antiabuse  # type: ignore
                    antiabuse.scan_once(log, notify=lambda tg, kind, n, lim: send_antiabuse_warning(api, tg, kind, n, lim))
                except Exception as exc:  # noqa: BLE001
                    log(f"[antiabuse] ошибка прохода: {type(exc).__name__}: {exc}")
                try:
                    import antiabuse  # type: ignore
                    antiabuse.scan_trial_hwids(log)
                except Exception as exc:  # noqa: BLE001
                    log(f"[antiabuse] пробные/HWID: ошибка прохода: {type(exc).__name__}: {exc}")
            time.sleep(INTERVAL)

    thread = threading.Thread(target=_loop, name="sub-reminders", daemon=True)
    thread.start()
    return thread
