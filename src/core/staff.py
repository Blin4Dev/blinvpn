from __future__ import annotations

import json
import re
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore


ROLES = {"curator": "Куратор", "operator": "Оператор"}

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
PASSWORD_MIN = 10
PASSWORD_MAX = 128

# оператору нельзя даже на «своём»: деньги, merge, удаление
OPERATOR_FORBIDDEN_ACTIONS = {
    "ADD_BALANCE", "SUB_BALANCE", "SET_PARTNER_RATE", "SET_PARTNER_BALANCE", "ADD_PARTNER_BALANCE",
    "SUB_PARTNER_BALANCE", "SET_TELEGRAM_ID", "SET_EMAIL", "DELETE_USER",
}


class StaffError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# доступ: any / curator / manage (оператор с тикетом этого uid); иначе владелец

R = "GET"
_USER_VIEW = r"/users/\d+(?:/detail|/payments|/subscriptions|/referrals|/remnawave|/survey)?"

ROUTES: list[tuple[set[str], re.Pattern, str]] = [
    (set(m.split()), re.compile(f"^{p}$"), rule) for m, p, rule in [
        (R, r"/auth/me", "any"),

        (R, r"/users", "any"),
        (R, _USER_VIEW, "any"),
        (R, r"/users/(?P<uid>\d+)/exchange", "manage"),
        ("POST", r"/users/(?P<uid>\d+)/(?:action|exchange|hwid/unlink|referrals/\d+/unlink)", "manage"),
        (R, r"/users/\d+/transfer", "curator"),
        ("POST", r"/users/\d+/transfer", "curator"),
        (R, r"/users/(?P<uid>\d+)/can-manage", "any"),
        (R, r"/keys", "curator"),                 # ключи с uuid: не операторам
        ("POST", r"/keys(?:/\d+/block)?", "curator"),

        (R, r"/support/chats", "any"),
        (R, r"/support/unread", "any"),
        (R, r"/support/chats/\d+", "any"),
        ("POST", r"/support/chats/\d+/(?:read|start|close|upload|messages|pool|escalate)", "any"),
        # своё сообщение (своё+48ч внутри)
        ("POST", r"/support/chats/\d+/messages/\d+/edit", "any"),
        ("DELETE", r"/support/chats/\d+/messages/\d+", "any"),

        (R, r"/team-chat", "any"),                 # team chat
        (R, r"/team-chat/unread", "any"),
        (R, r"/team-chat/members", "any"),         # список для @упоминаний
        ("POST", r"/team-chat/(?:messages|read|messages/\d+/edit)", "any"),
        ("DELETE", r"/team-chat/messages/\d+", "any"),  # своё; чужое - владелец

        (R, r"/staff", "curator"),                 # кураторам краткий список
        (R, r"/staff/\d+/schedule", "curator"),
        (R, r"/staff/\d+/fines", "curator"),
        ("POST", r"/staff/\d+/fines", "curator"),
        ("DELETE", r"/staff/fines/\d+", "curator"),  # только свой штраф

        (R, r"/me/salary", "any"),
        (R, r"/push/key", "any"),
        ("POST", r"/push/(?:subscribe|unsubscribe|test)", "any"),
    ]
]


def match_route(method: str, sub: str) -> Optional[tuple[str, dict[str, str]]]:
    """(правило, группы из пути) или None, если путь сотрудникам не открыт."""
    method = "GET" if method.upper() == "HEAD" else method.upper()
    for methods, rx, rule in ROUTES:
        if method in methods:
            m = rx.match(sub)
            if m:
                return rule, {k: v for k, v in m.groupdict().items() if v is not None}
    return None


def get(staff_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM panel_staff WHERE id = ?", (int(staff_id),))


def by_username(username: str) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM panel_staff WHERE username = ?", (str(username or "").strip().lower(),))


def role_of(s: dict[str, Any]) -> str:
    r = str(s.get("role") or "")
    return r if r in ROLES else "operator"


def public(s: dict[str, Any]) -> dict[str, Any]:
    """Без хэша и соли пароля."""
    iv: list = []
    raw = s.get("default_intervals")
    if raw:
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, list):
                iv = parsed
        except (TypeError, ValueError):
            iv = []
    return {
        "id": s["id"], "username": s["username"], "name": s.get("name") or "", "telegram_id": s["telegram_id"],
        "role": role_of(s), "is_active": bool(s.get("is_active")),
        "default_pay": float(s.get("default_pay") or 0),
        "default_intervals": iv,
        "created_at": s.get("created_at"), "updated_at": s.get("updated_at"),
        "last_login_at": s.get("last_login_at"), "last_login_ip": s.get("last_login_ip"),
    }


def display_name(s: dict[str, Any]) -> str:
    return (s.get("name") or "").strip() or s["username"]


def validate_role(role: Any) -> str:
    r = str(role or "")
    if r not in ROLES:
        raise StaffError("Роль: куратор или оператор")
    return r


def validate_username(username: str, owner_username: str) -> str:
    u = str(username or "").strip().lower()
    if not USERNAME_RE.fullmatch(u):
        raise StaffError("Логин: 3–32 символа, латиница, цифры, «.», «_», «-»")
    if owner_username and u == str(owner_username).strip().lower():
        raise StaffError("Этот логин занят")
    return u


def validate_password(pw: str) -> str:
    pw = str(pw or "")
    if len(pw) < PASSWORD_MIN:
        raise StaffError(f"Пароль — не короче {PASSWORD_MIN} символов")
    if len(pw) > PASSWORD_MAX:
        raise StaffError("Слишком длинный пароль")
    if pw.strip() != pw:
        raise StaffError("Пароль не должен начинаться или заканчиваться пробелом")
    return pw


def validate_tg(tg: Any) -> int:
    try:
        v = int(str(tg).strip())
    except (TypeError, ValueError):
        raise StaffError("Telegram ID — число (узнать можно у @userinfobot)")
    if not 0 < v < 10 ** 13:
        raise StaffError("Неверный Telegram ID")
    return v


def validate_name(name: Any) -> str:
    try:
        from . import names  # type: ignore
    except ImportError:  # pragma: no cover
        import names  # type: ignore
    n = re.sub(r"[<>&\"]", "", names.display_name(name, 80)).strip()
    if len(n) > 40:
        raise StaffError("Имя — до 40 символов")
    return n
