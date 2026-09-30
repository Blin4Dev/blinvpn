from __future__ import annotations

import json
from typing import Any, Callable, Optional

import database as db  # type: ignore

SURVEY_DISCOUNT_PERCENT = 5  # скидка за опрос (стекается)

EMOJI_INVITE = "5460795800101594035"
EMOJI_BUTTON = "5443038326535759644"

# тип: single|multi|text
# text_follow=True: потом спросим текст
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

DEFAULT_QUESTIONS = QUESTIONS
SETTINGS_KEY = "survey_questions"
MAX_QUESTIONS = 20
MAX_OPTIONS = 10
MAX_Q_LEN = 300
MAX_OPT_LEN = 60
FOLLOW_PROMPT = "Напишите свой вариант:"


def questions() -> list[dict[str, Any]]:
    """Вопросы опроса (редактируются в панели). n — постоянный номер вопроса, порядок — по списку."""
    raw = db.get_setting(SETTINGS_KEY, "")
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list) and data:
                return data
        except (TypeError, ValueError):
            pass
    return DEFAULT_QUESTIONS


def _by_n() -> dict[int, dict[str, Any]]:
    return {int(q["n"]): q for q in questions()}


def _first_n() -> Optional[int]:
    qs = questions()
    return int(qs[0]["n"]) if qs else None


def _next_n(n: int) -> Optional[int]:
    ids = [int(q["n"]) for q in questions()]
    if n in ids:
        i = ids.index(n)
        return ids[i + 1] if i + 1 < len(ids) else None
    return None


def _pos(n: int) -> int:
    ids = [int(q["n"]) for q in questions()]
    return ids.index(n) + 1 if n in ids else 1


def reward_value() -> int:
    try:
        v = int(float(db.get_setting("survey_reward_percent", str(SURVEY_DISCOUNT_PERCENT)) or SURVEY_DISCOUNT_PERCENT))
    except (TypeError, ValueError):
        v = SURVEY_DISCOUNT_PERCENT
    return max(0, min(50, v))


class SurveyError(ValueError):
    pass


def _clean(v: Any, max_len: int) -> str:
    import re
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(v or ""))).strip()[:max_len + 1]


def validate_questions(items: Any) -> list[dict[str, Any]]:
    """Проверка вопросов из панели. Номера n сохраняются (ответы привязаны к ним), новым — новые."""
    if not isinstance(items, list) or not items:
        raise SurveyError("Нужен хотя бы один вопрос")
    if len(items) > MAX_QUESTIONS:
        raise SurveyError(f"Не больше {MAX_QUESTIONS} вопросов")
    used: set[int] = set()
    # n нового вопроса не должен совпасть со старыми
    old = db.fetchone("SELECT MAX(question) AS m FROM survey_answers") or {}
    top = max([int(q.get("n") or 0) for q in questions()] + [int(old.get("m") or 0),
              int(db.get_setting("survey_max_n", "0") or 0)])
    known = {int(q.get("n") or 0) for q in questions()}
    out: list[dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            raise SurveyError("Неверный формат вопроса")
        kind = raw.get("kind")
        if kind not in ("single", "multi", "text"):
            raise SurveyError("Неверный тип вопроса")
        q = _clean(raw.get("q"), MAX_Q_LEN)
        if not q:
            raise SurveyError("Текст вопроса не может быть пустым")
        if len(q) > MAX_Q_LEN:
            raise SurveyError(f"Вопрос — до {MAX_Q_LEN} символов")
        try:
            n = int(raw.get("n") or 0)
        except (TypeError, ValueError):
            n = 0
        if n <= 0 or n in used or n not in known:
            top += 1
            n = top
        top = max(top, n)
        used.add(n)
        item: dict[str, Any] = {"n": n, "kind": kind, "q": q}
        if kind != "text":
            opts: list[str] = []
            for o in raw.get("options") or []:
                t = _clean(o, MAX_OPT_LEN)
                if len(t) > MAX_OPT_LEN:
                    raise SurveyError(f"Вариант ответа — до {MAX_OPT_LEN} символов")
                if t and t not in opts:
                    opts.append(t)
            if len(opts) < 2:
                raise SurveyError(f"В вопросе «{q[:40]}» нужно хотя бы 2 варианта ответа")
            if len(opts) > MAX_OPTIONS:
                raise SurveyError(f"Не больше {MAX_OPTIONS} вариантов ответа")
            item["options"] = opts
            if kind == "single":
                follow = [str(x) for x in (raw.get("ask_text") or []) if str(x) in opts][:MAX_OPTIONS]
                if follow:
                    item["text_follow"] = {o: FOLLOW_PROMPT for o in follow}
        out.append(item)
    return out


def save_questions(items: Any, reward: Any = None) -> list[dict[str, Any]]:
    qs = validate_questions(items)
    db.set_setting(SETTINGS_KEY, json.dumps(qs, ensure_ascii=False))
    db.set_setting("survey_max_n", str(max([int(q["n"]) for q in qs] + [int(db.get_setting("survey_max_n", "0") or 0)])))
    if reward is not None:
        try:
            r = int(reward)
        except (TypeError, ValueError):
            raise SurveyError("Неверная скидка")
        if not 0 <= r <= 50:
            raise SurveyError("Скидка — от 0 до 50%")
        db.set_setting("survey_reward_percent", str(r))
    return qs


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
    return float(reward_value()) if has_completed(user_id) else 0.0


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


def _send_question(api: Callable[..., Any], chat_id: int, q: dict[str, Any],
                   chosen: Optional[list[str]] = None) -> None:
    head = f"Вопрос {_pos(int(q['n']))} из {len(questions())}\n\n{q['q']}"
    payload: dict[str, Any] = {
        "chat_id": chat_id, "text": head,
        "link_preview_options": {"is_disabled": True},
    }
    if q["kind"] == "single":
        payload["reply_markup"] = _single_kb(q)
    elif q["kind"] == "multi":
        payload["reply_markup"] = _multi_kb(q, chosen or [])
    # text: ждём сообщение
    api("sendMessage", payload)


def _advance(api: Callable[..., Any], user_id: int, chat_id: int, next_n: Optional[int]) -> None:
    """Переходит к вопросу next_n (или завершает опрос, если вопросы кончились)."""
    q = _by_n().get(int(next_n)) if next_n is not None else None
    if not q:
        _finish(api, user_id, chat_id)
        return
    db.execute("UPDATE survey_state SET step = ?, await_text = ? WHERE user_id = ?",
               (int(q["n"]), 1 if q["kind"] == "text" else 0, user_id))
    _send_question(api, chat_id, q)


def start(api: Callable[..., Any], user_id: int, telegram_id: int) -> None:
    """Начинает опрос заново (кнопка «Пройти опрос»)."""
    if has_completed(user_id):
        api("sendMessage", {"chat_id": telegram_id,
                            "text": "Вы уже прошли опрос. Спасибо! 🎁"})
        return
    now = db.utcnow_iso()
    first = _first_n()
    if first is None:
        return
    first_q = _by_n()[first]
    db.execute(
        "INSERT INTO survey_state (user_id, telegram_id, step, answers_json, await_text, "
        "completed, started_at) VALUES (?, ?, ?, '{}', ?, 0, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET step = ?, answers_json = '{}', await_text = ?, "
        "completed = 0, started_at = ?, completed_at = NULL",
        (user_id, telegram_id, first, 1 if first_q["kind"] == "text" else 0, now,
         first, 1 if first_q["kind"] == "text" else 0, now),
    )
    _send_question(api, telegram_id, first_q)


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

    # multi: переключение
    if data.startswith("svm:"):
        try:
            _, sn, si = data.split(":")
            n, i = int(sn), int(si)
        except ValueError:
            return True
        q = _by_n().get(n)
        if n != step or not q or not 0 <= i < len(q.get("options") or []):
            return True
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

    # multi: готово
    if data.startswith("svd:"):
        try:
            n = int(data.split(":")[1])
        except ValueError:
            return True
        q = _by_n().get(n)
        if n != step or not q:
            return True
        chosen = list(answers.get(str(n)) or [])
        if not chosen:
            return True  # нужен хотя бы один
        if message_id is not None:
            _lock_message(api, chat_id, message_id, q["q"], ", ".join(chosen))
        _advance(api, user_id, chat_id, _next_n(n))
        return True

    # одиночный выбор
    try:
        _, sn, si = data.split(":")
        n, i = int(sn), int(si)
    except ValueError:
        return True
    q = _by_n().get(n)
    if n != step or not q or not 0 <= i < len(q.get("options") or []):
        return True
    opt = q["options"][i]

    # text_follow (q4 другое)?
    follow = (q.get("text_follow") or {}).get(opt)
    if follow:
        answers[str(n)] = opt  # временно, текст допишем
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
    _advance(api, user_id, chat_id, _next_n(n))
    return True


def _lock_message(api: Callable[..., Any], chat_id: int, message_id: int,
                  question: str, answer: str) -> None:
    """Заменяет вопрос на «вопрос → ваш ответ» и убирает кнопки."""
    api("editMessageText", {
        "chat_id": chat_id, "message_id": message_id,
        "text": f"{question}\n\n✓ {answer}",
        "link_preview_options": {"is_disabled": True},
    })


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
    q = _by_n().get(step)
    if not q:
        return False

    if q["kind"] == "text":
        answers[str(step)] = text[:1000]
    else:
        # уточнение к варианту
        base = answers.get(str(step)) or ""
        answers[str(step)] = f"{base}: {text[:500]}" if base else text[:500]
    _save_answers(user_id, answers)
    db.execute("UPDATE survey_state SET await_text = 0 WHERE user_id = ?", (user_id,))
    _advance(api, user_id, chat_id, _next_n(step))
    return True


def _finish(api: Callable[..., Any], user_id: int, chat_id: int) -> None:
    st = _state(user_id)
    if not st:
        return
    answers = _answers(st)
    now = db.utcnow_iso()
    # ответы для статистики (multi: строка на вариант)
    db.execute("DELETE FROM survey_answers WHERE user_id = ?", (user_id,))
    for q in questions():
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
    # invite done (гонки)
    db.execute("UPDATE survey_invites SET invited = 1 WHERE user_id = ?", (user_id,))

    segs: list[tuple[str, Optional[dict[str, Any]]]] = [("🎁 ", None), ("Спасибо за ответы!", {"type": "bold"})]
    if reward_value() > 0:
        segs.append((f"\n\nВаша скидка {reward_value()}% уже активна и суммируется с другими "
                     "скидками — она применится при следующей покупке подписки.", None))
    text, entities = _build(segs)
    api("sendMessage", {
        "chat_id": chat_id, "text": text, "entities": entities,
        "link_preview_options": {"is_disabled": True},
    })


def invite_payload(chat_id: int) -> dict[str, Any]:
    """Сообщение-приглашение: премиум-эмодзи 🗣️ + зелёная кнопка «Пройти опрос»."""
    text, entities = _build([
        ("🗣️", {"type": "custom_emoji", "custom_emoji_id": EMOJI_INVITE}),
        (" ", None),
        ("Пройдите опрос и получите подарок", {"type": "bold"}),
        (f"\n\nНажмите на кнопку ниже, ответьте на {_n_questions_text()} и получите "
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
            "style": "success",                       # success (bot api 9.4+)
            "icon_custom_emoji_id": EMOJI_BUTTON,
        }]]},
    }


def _n_questions_text() -> str:
    n = len(questions())
    a, b = n % 100, n % 10
    word = "простых вопросов" if 11 <= a <= 14 else "простой вопрос" if b == 1 else "простых вопроса" if 2 <= b <= 4 else "простых вопросов"
    return f"{n} {word}"
