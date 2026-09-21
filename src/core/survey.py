"""
Опрос пользователей BlinVPN (8 вопросов) с наградой-скидкой.

Приглашение уходит в ЛС через 1 час после первого подключения к VPN
(см. reminders.run_survey_invites). По кнопке «Пройти опрос» бот по очереди
задаёт вопросы с кнопками вариантов; часть вопросов — с мультивыбором (Q6)
или свободным ответом текстом (Q4 «Другое», Q8). После завершения пользователю
начисляется скидка 5%, которая СУММИРУЕТСЯ с другими скидками.

Модуль не зависит от сети напрямую — Telegram-вызовы идут через переданный
callable `api(method, payload)` (как в reminders/bot).
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

import database as db  # type: ignore

# ── Награда ──────────────────────────────────────────────────
SURVEY_DISCOUNT_PERCENT = 5  # скидка за прохождение опроса (стекается с другими)

# ── Премиум-эмодзи (custom_emoji_id обязан соответствовать базовому эмодзи) ──
EMOJI_INVITE = "5460795800101594035"  # 🗣️ — заголовок приглашения
EMOJI_BUTTON = "5443038326535759644"  # 💬 — иконка на зелёной кнопке

# ── Определение вопросов ─────────────────────────────────────
# kind: "single" | "multi" | "text"
# для варианта можно указать text_follow=True → после выбора спросим текст.
QUESTIONS: list[dict[str, Any]] = [
    {
        "n": 1, "kind": "single",
        "q": "Устраивает ли вас качество работы VPN?",
        "options": ["Да", "Могло быть и лучше", "Нет"],
    },
    {
        "n": 2, "kind": "single",
        "q": "Устраивает ли вас качество работы обхода белых списков?",
        "options": ["Да", "Могло быть и лучше", "Нет", "Никогда не пользовался"],
    },
    {
        "n": 3, "kind": "single",
        "q": "Устраивает ли вас цена VPN?",
        "options": ["Да", "Могло быть и лучше", "Нет"],
    },
    {
        "n": 4, "kind": "single",
        "q": "Откуда вы узнали о нас?",
        "options": ["Порекомендовал знакомый", "Реклама в Telegram", "Threads", "X",
                    "Другое", "Уже не помню"],
        "text_follow": {"Другое": "Напишите, откуда вы узнали о нас:"},
    },
    {
        "n": 5, "kind": "single",
        "q": "Устраивает ли вас работа службы поддержки?",
        "options": ["Да", "Могло быть и лучше", "Нет", "Никогда не писал туда"],
    },
    {
        "n": 6, "kind": "multi",
        "q": "На каких устройствах используете VPN? (можно выбрать несколько)",
        "options": ["Телефон", "Планшет", "Компьютер", "Телевизор", "Роутер"],
    },
    {
        "n": 7, "kind": "single",
        "q": "Как часто вы используете VPN?",
        "options": ["Всегда включён", "Больше половины суток", "Несколько раз в день",
                    "Редко, по необходимости"],
    },
    {
        "n": 8, "kind": "text",
        "q": "Что вы хотели бы улучшить в BlinVPN?",
    },
]

_BY_N = {q["n"]: q for q in QUESTIONS}
TOTAL = len(QUESTIONS)


# ── UTF-16 entities (премиум-эмодзи) ─────────────────────────

def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _build(segments: list[tuple[str, Optional[dict[str, Any]]]]) -> tuple[str, list[dict[str, Any]]]:
    text, entities, offset = "", [], 0
    for chunk, ent in segments:
        length = _utf16_len(chunk)
        if ent:
            entities.append({**ent, "offset": offset, "length": length})
        text += chunk
        offset += length
    return text, entities


# ── Состояние ────────────────────────────────────────────────

def _state(user_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM survey_state WHERE user_id = ?", (user_id,))


def _answers(st: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(st.get("answers_json") or "{}")
    except (TypeError, ValueError):
        return {}


def _save_answers(user_id: int, answers: dict[str, Any]) -> None:
    db.execute("UPDATE survey_state SET answers_json = ? WHERE user_id = ?",
               (json.dumps(answers, ensure_ascii=False), user_id))


def has_completed(user_id: int) -> bool:
    row = db.fetchone("SELECT completed FROM survey_state WHERE user_id = ?", (user_id,))
    return bool(row and int(row.get("completed") or 0) == 1)


def reward_percent(user_id: int) -> float:
    """Скидка за пройденный опрос (0, если не пройден)."""
    return float(SURVEY_DISCOUNT_PERCENT) if has_completed(user_id) else 0.0


# ── Клавиатуры ───────────────────────────────────────────────

def _single_kb(q: dict[str, Any]) -> dict[str, Any]:
    rows = [[{"text": opt, "callback_data": f"sv:{q['n']}:{i}"}]
            for i, opt in enumerate(q["options"])]
    return {"inline_keyboard": rows}


def _multi_kb(q: dict[str, Any], chosen: list[str]) -> dict[str, Any]:
    rows = []
    for i, opt in enumerate(q["options"]):
        mark = "☑️ " if opt in chosen else "⬜️ "
        rows.append([{"text": mark + opt, "callback_data": f"svm:{q['n']}:{i}"}])
    rows.append([{"text": "Готово ✓", "callback_data": f"svd:{q['n']}"}])
    return {"inline_keyboard": rows}


# ── Отправка вопросов ────────────────────────────────────────

def _send_question(api: Callable[..., Any], chat_id: int, q: dict[str, Any],
                   chosen: Optional[list[str]] = None) -> None:
    head = f"Вопрос {q['n']} из {TOTAL}\n\n{q['q']}"
    payload: dict[str, Any] = {
        "chat_id": chat_id, "text": head,
        "link_preview_options": {"is_disabled": True},
    }
    if q["kind"] == "single":
        payload["reply_markup"] = _single_kb(q)
    elif q["kind"] == "multi":
        payload["reply_markup"] = _multi_kb(q, chosen or [])
    # text — без клавиатуры, ждём сообщение
    api("sendMessage", payload)


def _advance(api: Callable[..., Any], user_id: int, chat_id: int, next_n: int) -> None:
    """Переходит к вопросу next_n (или завершает опрос, если вопросы кончились)."""
    if next_n > TOTAL:
        _finish(api, user_id, chat_id)
        return
    q = _BY_N[next_n]
    db.execute("UPDATE survey_state SET step = ?, await_text = ? WHERE user_id = ?",
               (next_n, 1 if q["kind"] == "text" else 0, user_id))
    _send_question(api, chat_id, q)


def start(api: Callable[..., Any], user_id: int, telegram_id: int) -> None:
    """Начинает опрос заново (кнопка «Пройти опрос»)."""
    if has_completed(user_id):
        api("sendMessage", {"chat_id": telegram_id,
                            "text": "Вы уже прошли опрос. Спасибо! 🎁"})
        return
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO survey_state (user_id, telegram_id, step, answers_json, await_text, "
        "completed, started_at) VALUES (?, ?, 1, '{}', 0, 0, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET step = 1, answers_json = '{}', await_text = 0, "
        "completed = 0, started_at = ?, completed_at = NULL",
        (user_id, telegram_id, now, now),
    )
    _send_question(api, telegram_id, _BY_N[1])


# ── Обработка нажатий на варианты ────────────────────────────

def handle_callback(api: Callable[..., Any], user_id: int, chat_id: int,
                    message_id: Optional[int], data: str) -> bool:
    """
    Обрабатывает callback опроса (data начинается с 'sv:'/'svm:'/'svd:').
    Возвращает True, если это был callback опроса.
    """
    if not (data.startswith("sv:") or data.startswith("svm:") or data.startswith("svd:")):
        return False
    st = _state(user_id)
    if not st or int(st.get("completed") or 0) == 1:
        return True
    step = int(st.get("step") or 0)
    answers = _answers(st)

    # Мультивыбор: переключение варианта
    if data.startswith("svm:"):
        _, sn, si = data.split(":")
        n, i = int(sn), int(si)
        if n != step:
            return True
        q = _BY_N[n]
        chosen: list[str] = list(answers.get(str(n)) or [])
        opt = q["options"][i]
        if opt in chosen:
            chosen.remove(opt)
        else:
            chosen.append(opt)
        answers[str(n)] = chosen
        _save_answers(user_id, answers)
        if message_id is not None:
            api("editMessageReplyMarkup", {
                "chat_id": chat_id, "message_id": message_id,
                "reply_markup": _multi_kb(q, chosen)})
        return True

    # Мультивыбор: «Готово»
    if data.startswith("svd:"):
        n = int(data.split(":")[1])
        if n != step:
            return True
        chosen = list(answers.get(str(n)) or [])
        if not chosen:
            return True  # ждём хотя бы один вариант
        if message_id is not None:
            _lock_message(api, chat_id, message_id, _BY_N[n]["q"], ", ".join(chosen))
        _advance(api, user_id, chat_id, n + 1)
        return True

    # Одиночный выбор
    _, sn, si = data.split(":")
    n, i = int(sn), int(si)
    if n != step:
        return True
    q = _BY_N[n]
    opt = q["options"][i]

    # Вариант требует уточнения текстом (Q4 «Другое»)?
    follow = (q.get("text_follow") or {}).get(opt)
    if follow:
        answers[str(n)] = opt  # предварительно; финальный текст допишем
        _save_answers(user_id, answers)
        if message_id is not None:
            _lock_message(api, chat_id, message_id, q["q"], opt)
        db.execute("UPDATE survey_state SET await_text = 1 WHERE user_id = ?", (user_id,))
        api("sendMessage", {"chat_id": chat_id, "text": follow})
        return True

    answers[str(n)] = opt
    _save_answers(user_id, answers)
    if message_id is not None:
        _lock_message(api, chat_id, message_id, q["q"], opt)
    _advance(api, user_id, chat_id, n + 1)
    return True


def _lock_message(api: Callable[..., Any], chat_id: int, message_id: int,
                  question: str, answer: str) -> None:
    """Заменяет вопрос на «вопрос → ваш ответ» и убирает кнопки."""
    api("editMessageText", {
        "chat_id": chat_id, "message_id": message_id,
        "text": f"{question}\n\n✓ {answer}",
        "link_preview_options": {"is_disabled": True},
    })


# ── Обработка текстовых ответов (Q4 «Другое», Q8) ────────────

def handle_text(api: Callable[..., Any], user_id: int, chat_id: int, text: str) -> bool:
    """Ловит свободный ответ, если опрос ждёт текст. True — если обработали."""
    st = _state(user_id)
    if not st or int(st.get("completed") or 0) == 1 or int(st.get("await_text") or 0) != 1:
        return False
    text = (text or "").strip()
    if not text:
        return False
    step = int(st.get("step") or 0)
    answers = _answers(st)
    q = _BY_N.get(step)
    if not q:
        return False

    if q["kind"] == "text":
        answers[str(step)] = text[:1000]
    else:
        # уточнение к выбранному варианту (Q4 «Другое»)
        base = answers.get(str(step)) or ""
        answers[str(step)] = f"{base}: {text[:500]}" if base else text[:500]
    _save_answers(user_id, answers)
    db.execute("UPDATE survey_state SET await_text = 0 WHERE user_id = ?", (user_id,))
    _advance(api, user_id, chat_id, step + 1)
    return True


# ── Финализация ──────────────────────────────────────────────

def _finish(api: Callable[..., Any], user_id: int, chat_id: int) -> None:
    st = _state(user_id)
    if not st:
        return
    answers = _answers(st)
    now = db.utcnow_iso()
    # Нормализованные ответы для статистики (мультивыбор — по строке на вариант).
    db.execute("DELETE FROM survey_answers WHERE user_id = ?", (user_id,))
    for q in QUESTIONS:
        val = answers.get(str(q["n"]))
        if val is None:
            continue
        vals = val if isinstance(val, list) else [val]
        for v in vals:
            db.execute(
                "INSERT INTO survey_answers (user_id, question, answer, created_at) "
                "VALUES (?, ?, ?, ?)",
                (user_id, int(q["n"]), str(v), now),
            )
    db.execute(
        "UPDATE survey_state SET completed = 1, await_text = 0, completed_at = ? WHERE user_id = ?",
        (now, user_id),
    )
    # Отметим приглашение как отработанное (на случай гонок).
    db.execute("UPDATE survey_invites SET invited = 1 WHERE user_id = ?", (user_id,))

    text, entities = _build([
        ("🎁 ", None),
        ("Спасибо за ответы!", {"type": "bold"}),
        (f"\n\nВаша скидка {SURVEY_DISCOUNT_PERCENT}% уже активна и суммируется с другими "
         "скидками — она применится при следующей покупке подписки.", None),
    ])
    api("sendMessage", {
        "chat_id": chat_id, "text": text, "entities": entities,
        "link_preview_options": {"is_disabled": True},
    })


# ── Приглашение в опрос ──────────────────────────────────────

def invite_payload(chat_id: int) -> dict[str, Any]:
    """Сообщение-приглашение: премиум-эмодзи 🗣️ + зелёная кнопка «Пройти опрос»."""
    text, entities = _build([
        ("🗣️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_INVITE}),
        (" ", None),
        ("Пройдите опрос и получите подарок", {"type": "bold"}),
        ("\n\nНажмите на кнопку ниже, ответьте на 8 простых вопросов и получите "
         "небольшую скидку.", None),
    ])
    return {
        "chat_id": chat_id,
        "text": text,
        "entities": entities,
        "link_preview_options": {"is_disabled": True},
        "reply_markup": {"inline_keyboard": [[{
            "text": "Пройти опрос",
            "callback_data": "survey:start",
            "style": "success",                       # зелёная кнопка (Bot API 9.4+)
            "icon_custom_emoji_id": EMOJI_BUTTON,     # 💬
        }]]},
    }
