from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

try:
    from . import database as db
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

MAX_TEXT = 4000
PAGE = 100


class TeamChatError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _clean(text: Any) -> str:
    s = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    # управляющие символы вон (кроме \n\t)
    s = "".join(ch for ch in s if ch in "\n\t" or ord(ch) >= 32)
    return s.strip()


def members(owner_name: str = "Администратор") -> list[dict[str, Any]]:
    """кого можно упомянуть через @."""
    out = [{"actor": "owner", "name": owner_name, "username": "admin", "role": "owner"}]
    for s in db.fetchall("SELECT id, username, name, role FROM panel_staff WHERE is_active = 1 ORDER BY role, id"):
        name = (s.get("name") or "").strip() or s["username"]
        out.append({"actor": f"staff:{int(s['id'])}", "name": name, "username": s["username"], "role": s["role"]})
    return out


def _mention_keys(m: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    for k in (m.get("name"), m.get("username")):
        s = str(k or "").strip()
        if s and s not in keys:
            keys.append(s)
    return keys


def mentioned_actors(text: str, exclude: str = "") -> list[str]:
    """actors, которых явно упомянули через @Имя или @username."""
    t = str(text or "")
    if "@" not in t:
        return []
    found: list[str] = []
    seen: set[str] = set()
    # длинные имена раньше, чтобы «Иван Петров» не съел «Иван»
    cands: list[tuple[str, str]] = []
    for m in members():
        actor = m["actor"]
        if actor == exclude or actor in seen:
            continue
        for key in _mention_keys(m):
            cands.append((key, actor))
    cands.sort(key=lambda x: len(x[0]), reverse=True)
    used: list[tuple[int, int]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(not (b <= x or a >= y) for x, y in used)

    for key, actor in cands:
        if actor in seen:
            continue
        for m in re.finditer(r"(?<![\w@])@" + re.escape(key) + r"(?=$|[\s,.!?;:)\]])", t, flags=re.IGNORECASE | re.UNICODE):
            a, b = m.start(), m.end()
            if overlaps(a, b):
                continue
            used.append((a, b))
            seen.add(actor)
            found.append(actor)
            break
    return found


def _row(r: dict[str, Any], actor: str) -> dict[str, Any]:
    deleted = bool(r.get("deleted_at"))
    reply = None
    if r.get("reply_to"):
        q = db.fetchone("SELECT id, author_name, text, deleted_at FROM team_messages WHERE id = ?", (int(r["reply_to"]),))
        if q:
            reply = {"id": q["id"], "author": q.get("author_name") or "",
                     "text": "" if q.get("deleted_at") else (q.get("text") or "")[:200], "deleted": bool(q.get("deleted_at"))}
    return {
        "id": r["id"], "author": r.get("author_name") or "", "role": r.get("author_role") or "",
        "mine": r.get("actor") == actor, "text": "" if deleted else r.get("text") or "", "deleted": deleted,
        "edited": bool(r.get("edited_at")) and not deleted,
        "reply_to": reply, "created_at": r.get("created_at"),
    }


def post(actor: str, name: str, role: str, text: Any, reply_to: Optional[int] = None) -> dict[str, Any]:
    t = _clean(text)
    if not t:
        raise TeamChatError("Пустое сообщение")
    if len(t) > MAX_TEXT:
        raise TeamChatError(f"Сообщение длиннее {MAX_TEXT} символов")
    rid = None
    if reply_to:
        q = db.fetchone("SELECT id FROM team_messages WHERE id = ?", (int(reply_to),))
        rid = int(q["id"]) if q else None
    cur = db.execute(
        "INSERT INTO team_messages (actor, author_name, author_role, text, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (actor, (name or "")[:60], role[:16], t, rid, db.utcnow_iso()),
    )
    mid = int(cur.lastrowid)
    # cursor двигаем только если всё до своего сообщения уже прочитано
    if not db.fetchone("SELECT 1 FROM team_messages WHERE id > ? AND id < ? AND actor != ? AND deleted_at IS NULL LIMIT 1",
                       (last_read(actor), mid, actor)):
        mark_read(actor, mid)
    return _row(db.fetchone("SELECT * FROM team_messages WHERE id = ?", (mid,)), actor)


def messages(actor: str, after: int = 0, before: int = 0) -> list[dict[str, Any]]:
    if after > 0:
        rows = db.fetchall("SELECT * FROM team_messages WHERE id > ? ORDER BY id LIMIT ?", (int(after), PAGE))
    elif before > 0:
        rows = list(reversed(db.fetchall("SELECT * FROM team_messages WHERE id < ? ORDER BY id DESC LIMIT ?", (int(before), PAGE))))
    else:
        rows = list(reversed(db.fetchall("SELECT * FROM team_messages ORDER BY id DESC LIMIT ?", (PAGE,))))
    return [_row(r, actor) for r in rows]


def recently_deleted(hours: int = 24) -> list[int]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    return [int(r["id"]) for r in db.fetchall("SELECT id FROM team_messages WHERE deleted_at > ? ORDER BY id DESC LIMIT 500", (since,))]


def recently_edited(actor: str, hours: int = 24) -> list[dict[str, Any]]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = db.fetchall("SELECT * FROM team_messages WHERE edited_at > ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 100", (since,))
    return [_row(r, actor) for r in rows]


def edit(actor: str, message_id: int, text: Any) -> dict[str, Any]:
    """Изменить своё сообщение (чужое не может никто, даже владелец)."""
    r = db.fetchone("SELECT * FROM team_messages WHERE id = ?", (int(message_id),))
    if not r or r.get("deleted_at"):
        raise TeamChatError("Сообщение не найдено", 404)
    if r["actor"] != actor:
        raise TeamChatError("Изменить можно только своё сообщение", 403)
    t = _clean(text)
    if not t:
        raise TeamChatError("Пустое сообщение — удалите его вместо этого")
    if len(t) > MAX_TEXT:
        raise TeamChatError(f"Сообщение длиннее {MAX_TEXT} символов")
    if t != r.get("text"):
        db.execute("UPDATE team_messages SET text = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL",
                   (t, db.utcnow_iso(), int(message_id)))
    return _row(db.fetchone("SELECT * FROM team_messages WHERE id = ?", (int(message_id),)), actor)


def last_read(actor: str) -> int:
    r = db.fetchone("SELECT last_id FROM team_reads WHERE actor = ?", (actor,))
    return int(r["last_id"]) if r else 0


def mark_read(actor: str, last_id: int) -> None:
    top = db.fetchone("SELECT COALESCE(MAX(id), 0) AS m FROM team_messages")
    last_id = max(0, min(int(last_id), int(top["m"]) if top else 0))
    db.execute("INSERT INTO team_reads (actor, last_id) VALUES (?, ?) "
               "ON CONFLICT(actor) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)", (actor, last_id))


def unread(actor: str) -> int:
    r = db.fetchone("SELECT COUNT(*) AS c FROM team_messages WHERE id > ? AND actor != ? AND deleted_at IS NULL",
                    (last_read(actor), actor))
    return int(r["c"]) if r else 0


def delete(actor: str, is_owner: bool, message_id: int) -> None:
    r = db.fetchone("SELECT * FROM team_messages WHERE id = ?", (int(message_id),))
    if not r:
        raise TeamChatError("Сообщение не найдено", 404)
    if r["actor"] != actor and not is_owner:
        raise TeamChatError("Удалить можно только своё сообщение", 403)
    db.execute("UPDATE team_messages SET deleted_at = ?, text = '' WHERE id = ? AND deleted_at IS NULL",
               (db.utcnow_iso(), int(message_id)))


def drop_actor(actor: str) -> None:
    """Сотрудник удалён — его отметка «прочитано» больше не нужна (сообщения остаются)."""
    db.execute("DELETE FROM team_reads WHERE actor = ?", (actor,))
