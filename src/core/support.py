"""
Служба поддержки: чат пользователя с поддержкой внутри мини-приложения.

• У пользователя ОДНА переписка (чат) на всю жизнь — в ней видна вся история.
• Внутри переписки — обращения (тикеты): первое сообщение пользователя открывает
  обращение №N, админ его закрывает; следующее сообщение открывает №N+1.
• Можно ответить на конкретное сообщение (цитата).
• Переписка обращения хранится 7 дней после его закрытия, потом удаляется
  вместе с вложениями (cleanup()). Если хранилище заполнено на 90% — удаляются
  самые старые вложения, пока не освободится место.
• Вложения лежат в S3 (Timeweb Cloud, s3store.py), если оно настроено в панели,
  иначе — на диске сервера (data/support).

Вложения. Файл отправляется отдельным запросом «как есть» (тело = байты файла),
пишется на диск по ходу загрузки (в память не копится), получает id, а потом
прикрепляется к сообщению. Тип определяем по содержимому (сигнатуре): «как
картинку/видео» показываем только настоящие JPEG/PNG/GIF/WebP/MP4/MOV/WebM,
остальное — только на скачивание. Отдаются по короткоживущей подписанной ссылке.

Защита хранилища:
  • до 10 файлов в сообщении, до 50 МБ каждый;
  • не больше 10 загруженных, но не отправленных файлов (живут 2 часа);
  • не больше 2 загрузок одновременно;
  • хранилище заполнено на 90% → удаляются самые старые вложения.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

# Проверка прав на обращение ВНУТРИ транзакции: (ticket) → None | (сообщение, http-код)
Guard = Optional[Callable[[dict[str, Any]], Optional[tuple[str, int]]]]


def _check(guard: Guard, t: Optional[dict[str, Any]]) -> None:
    if guard and t:
        err = guard(t)
        if err:
            raise SupportError(err[0], err[1])

try:
    from . import database as db
    from . import s3store
except ImportError:  # pragma: no cover
    import database as db  # type: ignore
    import s3store  # type: ignore

MB = 1024 * 1024


def _env_num(key: str, default: float) -> float:
    try:
        return float(os.getenv(key) or default)
    except ValueError:
        return float(default)


MAX_FILE_BYTES = 50 * MB                # лимит на файл (и для пользователя, и для поддержки)
MAX_FILES_PER_MESSAGE = 10
MAX_TEXT = 4000
EDIT_WINDOW = 48 * 3600  # своё сообщение сотрудник может изменить или удалить в течение 48 часов
FILE_URL_TTL = 6 * 3600                 # ссылка на файл живёт 6 часов
PENDING_TTL = 2 * 3600                  # загруженные, но не отправленные файлы удаляются через 2 часа
KEEP_AFTER_CLOSE_DAYS = 7               # переписка обращения хранится 7 дней после закрытия
FILL_TRIGGER = 0.90                     # хранилище заполнено на 90% — чистим старые вложения…
FILL_TARGET = 0.80                      # …до 80%
USER_MAX_PENDING = 10
MAX_PARALLEL_UPLOADS = 2
MIN_FREE_BYTES = int(_env_num("SUPPORT_MIN_FREE_GB", 2) * 1024 * MB)   # запас на диске для временных файлов
CLOSE_PROMPT_TEXT = "Подскажите, могу ли я ещё чем-то помочь?"
CLOSE_PROMPT_TTL = 60 * 60              # нет ответа на вопрос 60 минут — обращение закрывается само


class SupportError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or _now()).isoformat()


def _parse(v: Any) -> Optional[datetime]:
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def files_dir() -> str:
    base = os.path.dirname(os.path.abspath(db.get_db_path()))
    return os.path.join(base, "support")


# ─────────────────────────────────────────────────────────────
# Тип файла по содержимому
# ─────────────────────────────────────────────────────────────

_INLINE_MIME = {
    "jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
}


def sniff(head: bytes) -> tuple[str, Optional[str]]:
    """(kind, ext): kind — image | video | file. Только по сигнатуре содержимого."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image", "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image", "webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return "video", "mov"
        if brand in (b"heic", b"heix", b"mif1", b"msf1", b"avif"):
            return "file", None          # HEIC/AVIF браузеры показывают не везде — как файл
        return "video", "mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video", "webm"
    return "file", None


def clean_name(name: str) -> str:
    """Имя файла для показа и скачивания: без путей и управляющих символов."""
    name = os.path.basename(str(name or "").replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f\x7f\"<>]", "", name)[:120]
    return name or "file"


# ─────────────────────────────────────────────────────────────
# Переписки и обращения
# ─────────────────────────────────────────────────────────────

def get_chat(chat_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM support_chats WHERE id = ?", (int(chat_id),))


def chat_for_user(user_id: int, create: bool = True) -> Optional[dict[str, Any]]:
    row = db.fetchone("SELECT * FROM support_chats WHERE user_id = ?", (int(user_id),))
    if row or not create:
        return row
    db.execute("INSERT OR IGNORE INTO support_chats (user_id, created_at) VALUES (?, ?)", (int(user_id), _iso()))
    return db.fetchone("SELECT * FROM support_chats WHERE user_id = ?", (int(user_id),))


def open_ticket(chat: dict[str, Any], tx=None) -> Optional[dict[str, Any]]:
    """Открытое обращение переписки. С tx — читаем внутри транзакции (свежие данные)."""
    if tx is not None:
        row = tx.execute("SELECT t.* FROM support_chats c JOIN support_tickets t ON t.id = c.open_ticket_id "
                         "WHERE c.id = ? AND t.status = 'open'", (int(chat["id"]),)).fetchone()
        return dict(row) if row else None
    tid = chat.get("open_ticket_id")
    return db.fetchone("SELECT * FROM support_tickets WHERE id = ? AND status = 'open'", (int(tid),)) if tid else None


def last_ticket(chat: dict[str, Any]) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM support_tickets WHERE chat_id = ? ORDER BY id DESC LIMIT 1", (int(chat["id"]),))


def _new_ticket(chat: dict[str, Any], opened_by: str, tx) -> dict[str, Any]:
    num = int(tx.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM support_tickets WHERE chat_id = ?",
                         (int(chat["id"]),)).fetchone()[0])
    now = _iso()
    cur = tx.execute("INSERT INTO support_tickets (chat_id, number, status, opened_by, opened_at, queue_at) "
                     "VALUES (?, ?, 'open', ?, ?, ?)", (int(chat["id"]), num, opened_by, now, now))
    tid = cur.lastrowid
    tx.execute("UPDATE support_chats SET open_ticket_id = ?, assigned_admin = NULL, assigned_name = NULL WHERE id = ?",
               (tid, int(chat["id"])))
    tx.execute("INSERT INTO support_messages (chat_id, ticket_id, sender, author, text, panel_text, created_at) "
               "VALUES (?, ?, 'system', NULL, ?, '', ?)", (int(chat["id"]), tid, f"Обращение №{num} открыто", now))
    return {"id": tid, "number": num, "assigned_admin": None, "close_prompt_id": None, "escalated": 0}


def ticket_info(chat: dict[str, Any]) -> Optional[dict[str, Any]]:
    t = open_ticket(chat)
    if not t:
        last = last_ticket(chat)
        return ({"id": last["id"], "number": last["number"], "status": "closed", "opened_at": last["opened_at"],
                 "closed_at": last.get("closed_at"), "closed_by": last.get("closed_by"),
                 "assigned_admin": last.get("assigned_admin"), "assigned_name": last.get("assigned_name")} if last else None)
    return {"id": t["id"], "number": t["number"], "status": "open", "opened_at": t["opened_at"],
            "assigned_admin": t.get("assigned_admin"), "assigned_name": t.get("assigned_name"),
            "close_prompt": bool(t.get("close_prompt_id")), "prompt_at": t.get("prompt_at") if t.get("close_prompt_id") else None,
            "escalated": bool(t.get("escalated")), "escalate_note": t.get("escalate_note"),
            "queue_at": t.get("queue_at") or t["opened_at"]}


def start(chat: dict[str, Any], actor: str, name: str, takeover: bool = False, guard: Guard = None) -> dict[str, Any]:
    """
    Сотрудник нажал «Начать»: берёт обращение на себя (если открытого нет —
    открывает новое от имени поддержки). Пользователь видит, что подключился
    специалист. Взять обращение, которое уже ведёт другой, можно только с
    takeover=True (владелец или «полный доступ» к поддержке). Проверка и запись —
    одной транзакцией: два оператора не возьмут одно обращение одновременно.
    """
    now = _iso()
    with db.transaction() as tx:
        t = open_ticket(chat, tx)
        if t and t.get("assigned_admin") == actor:
            return {"ok": True, "changed": False}
        _check(guard, t)
        if t and t.get("assigned_admin") and not takeover:
            raise SupportError(f"Обращение уже ведёт {t.get('assigned_name') or 'другой сотрудник'}", 409)
        took = bool(t and t.get("assigned_admin") and t.get("assigned_admin") != actor)
        if not t:
            t = _new_ticket(chat, "admin", tx)
        tx.execute("UPDATE support_tickets SET assigned_admin = ?, assigned_name = ?, escalated = 0 WHERE id = ?",
                   (actor, name, t["id"]))
        tx.execute("UPDATE support_chats SET assigned_admin = ?, assigned_name = ?, started_at = ? WHERE id = ?",
                   (actor, name, now, int(chat["id"])))
        tx.execute("INSERT INTO support_messages (chat_id, ticket_id, sender, author, text, panel_text, created_at) "
                   "VALUES (?, ?, 'system', ?, ?, ?, ?)",
                   (int(chat["id"]), t["id"], name, "Специалист поддержки подключился к диалогу",
                    f"{name} забрал тикет" if took else f"{name} подключился", now))
    return {"ok": True, "changed": True}


def _close_tx(tx, chat_id: int, t: dict[str, Any], by: str, now: str, panel_text: Optional[str] = None) -> None:
    tx.execute("UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by = ?, close_prompt_id = NULL WHERE id = ?",
               (now, by, t["id"]))
    tx.execute("UPDATE support_chats SET open_ticket_id = NULL, assigned_admin = NULL, assigned_name = NULL, unread_admin = 0 "
               "WHERE id = ?", (int(chat_id),))
    if panel_text is None:
        panel_text = f"{t.get('assigned_name')} закрыл обращение" if t.get("assigned_name") else "Обращение закрыто"
    tx.execute("INSERT INTO support_messages (chat_id, ticket_id, sender, author, text, panel_text, created_at) "
               "VALUES (?, ?, 'system', ?, ?, ?, ?)", (int(chat_id), t["id"], by, f"Обращение №{t['number']} закрыто", panel_text, now))


def _drop_prompt_tx(tx, t: dict[str, Any]) -> None:
    """Убрать вопрос «Могу ли я ещё чем-то помочь?» (сообщение удаляется)."""
    pid = t.get("close_prompt_id")
    if pid:
        tx.execute("UPDATE support_messages SET reply_to = NULL WHERE reply_to = ?", (int(pid),))
        tx.execute("DELETE FROM support_messages WHERE id = ? AND kind = 'close_prompt'", (int(pid),))
    tx.execute("UPDATE support_tickets SET close_prompt_id = NULL, prompt_at = NULL WHERE id = ?", (t["id"],))


def _internal_tx(tx, chat_id: int, ticket_id: int, name: str, text: str, now: str, panel_text: Optional[str] = None) -> None:
    """Служебная строка только для панели — пользователь её не видит."""
    tx.execute("INSERT INTO support_messages (chat_id, ticket_id, sender, author, text, internal, panel_text, created_at) "
               "VALUES (?, ?, 'system', ?, ?, 1, ?, ?)", (int(chat_id), ticket_id, name, text, panel_text, now))


def to_pool(chat: dict[str, Any], actor: str, name: str, only_own: bool, guard: Guard = None) -> dict[str, Any]:
    """«В пул»: обращение снова ничьё и видно всем операторам в «Открыто»."""
    now = _iso()
    with db.transaction() as tx:
        t = open_ticket(chat, tx)
        if not t:
            raise SupportError("Открытого обращения нет", 409)
        _check(guard, t)
        if only_own and t.get("assigned_admin") != actor:
            raise SupportError("Вернуть в пул можно только своё обращение", 403)
        if not t.get("assigned_admin") and not t.get("escalated"):
            raise SupportError("Обращение и так в пуле", 409)
        tx.execute("UPDATE support_tickets SET assigned_admin = NULL, assigned_name = NULL, escalated = 0 WHERE id = ?", (t["id"],))
        tx.execute("UPDATE support_chats SET assigned_admin = NULL, assigned_name = NULL WHERE id = ?", (int(chat["id"]),))
        _internal_tx(tx, int(chat["id"]), t["id"], name, "Обращение возвращено в пул", now, f"{name} отправил в пул")
    return {"ok": True}


def escalate(chat: dict[str, Any], actor: str, name: str, note: str) -> dict[str, Any]:
    """«Передать админу»: из работы оператора в очередь «Админу» (кураторы и владелец)."""
    note = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(note or "")).strip()[:500]
    now = _iso()
    with db.transaction() as tx:
        t = open_ticket(chat, tx)
        if not t:
            raise SupportError("Открытого обращения нет", 409)
        if t.get("assigned_admin") != actor:
            raise SupportError("Передать можно только своё обращение", 403)
        tx.execute("UPDATE support_tickets SET assigned_admin = NULL, assigned_name = NULL, escalated = 1, escalate_note = ? "
                   "WHERE id = ?", (note or None, t["id"]))
        tx.execute("UPDATE support_chats SET assigned_admin = NULL, assigned_name = NULL WHERE id = ?", (int(chat["id"]),))
        _internal_tx(tx, int(chat["id"]), t["id"], name, "Обращение передано админу" + (f": {note}" if note else ""), now,
                     f"{name} позвал Администратора")
    return {"ok": True, "number": t["number"], "note": note}


def close(chat: dict[str, Any], actor: str, name: str, force: bool = False, guard: Guard = None) -> dict[str, Any]:
    """
    «Закрыть»: пользователю уходит вопрос «Подскажите, могу ли я ещё чем-то
    помочь?» с кнопкой «Нет, спасибо» — обращение пока открыто. Нет ответа
    60 минут — закрывается само (auto_close_expired).
    force=True — закрыть сразу (владелец и кураторы), вопрос, если был, удаляется.
    → {"state": "asked", "message": {...}} | {"state": "closed"}
    """
    now = _iso()
    with db.transaction() as tx:
        t = open_ticket(chat, tx)
        if not t:
            raise SupportError("Открытого обращения нет", 409)
        _check(guard, t)
        if force:
            if t.get("close_prompt_id"):
                _drop_prompt_tx(tx, t)
            _close_tx(tx, int(chat["id"]), t, name, now, f"{name} принудительно закрыл обращение")
            return {"state": "closed"}
        if t.get("close_prompt_id"):
            raise SupportError("Вопрос уже задан — ждём ответа пользователя", 409)
        cur = tx.execute("INSERT INTO support_messages (chat_id, ticket_id, sender, author, text, kind, created_at) "
                         "VALUES (?, ?, 'admin', ?, ?, 'close_prompt', ?)",
                         (int(chat["id"]), t["id"], name, CLOSE_PROMPT_TEXT, now))
        mid = cur.lastrowid
        tx.execute("UPDATE support_tickets SET close_prompt_id = ?, prompt_at = ? WHERE id = ?", (mid, now, t["id"]))
        tx.execute("UPDATE support_chats SET last_message_at = ?, last_preview = ?, last_sender = 'admin', "
                   "unread_user = unread_user + 1 WHERE id = ?", (now, CLOSE_PROMPT_TEXT, int(chat["id"])))
    return {"state": "asked", "message": message(mid)}


def auto_close_expired() -> int:
    """Вопрос о закрытии без ответа 60 минут — обращение закрывается само."""
    cutoff = _iso(_now() - timedelta(seconds=CLOSE_PROMPT_TTL))
    n = 0
    for r in db.fetchall("SELECT t.id, t.chat_id FROM support_tickets t WHERE t.status = 'open' AND t.close_prompt_id IS NOT NULL "
                         "AND t.prompt_at IS NOT NULL AND t.prompt_at < ? LIMIT 500", (cutoff,)):
        now = _iso()
        with db.transaction() as tx:
            row = tx.execute("SELECT * FROM support_tickets WHERE id = ? AND status = 'open' AND close_prompt_id IS NOT NULL "
                             "AND prompt_at < ?", (r["id"], cutoff)).fetchone()
            if not row:
                continue  # пользователь успел ответить
            t = dict(row)
            tx.execute("UPDATE support_tickets SET close_prompt_id = NULL, prompt_at = NULL WHERE id = ?", (t["id"],))
            _close_tx(tx, int(t["chat_id"]), t, "auto", now)
            n += 1
    return n


def user_close(chat: dict[str, Any], prompt_id: int) -> dict[str, Any]:
    """Пользователь нажал «Нет, спасибо» под вопросом — обращение закрывается."""
    now = _iso()
    with db.transaction() as tx:
        t = open_ticket(chat, tx)
        if not t or not t.get("close_prompt_id") or int(t["close_prompt_id"]) != int(prompt_id):
            raise SupportError("Вопрос уже неактуален", 409)
        tx.execute("UPDATE support_tickets SET close_prompt_id = NULL, prompt_at = NULL WHERE id = ?", (t["id"],))
        tx.execute("INSERT INTO support_messages (chat_id, ticket_id, reply_to, sender, author, text, created_at) "
                   "VALUES (?, ?, ?, 'user', NULL, 'Нет, спасибо', ?)", (int(chat["id"]), t["id"], int(prompt_id), now))
        _close_tx(tx, int(chat["id"]), t, "user", now)
        tx.execute("UPDATE support_chats SET last_message_at = ?, last_preview = 'Нет, спасибо', last_sender = 'user' "
                   "WHERE id = ?", (now, int(chat["id"])))
    return {"state": "closed"}


_CLOSE_WORD_RX = re.compile(r"^(?:нет|спасиб\w*|спс|благодарю)$")


def is_no_thanks(text: str) -> bool:
    """В ответе на вопрос о закрытии есть «нет» и/или «спасибо» (спс, благодарю) — закрываем."""
    words = re.findall(r"[a-zа-я]+", (text or "").lower().replace("ё", "е"))
    return any(_CLOSE_WORD_RX.match(w) for w in words)




# ─────────────────────────────────────────────────────────────
# Файлы: квоты и потоковая запись
# ─────────────────────────────────────────────────────────────

_active_uploads: dict[str, int] = {}
_active_lock = threading.Lock()


def _dir_free_bytes() -> int:
    os.makedirs(files_dir(), exist_ok=True)
    return shutil.disk_usage(files_dir()).free


def upload_allowance(uploader: str, uploader_id: str) -> int:
    """Сколько байт можно принять в этой загрузке (или SupportError, если нельзя совсем)."""
    _cleanup_pending()
    if _dir_free_bytes() < MIN_FREE_BYTES:
        raise SupportError("Загрузка файлов временно недоступна — напишите текстом", 507)
    pend = int(db.fetchone("SELECT COUNT(*) AS c FROM support_files WHERE uploader = ? AND uploader_id = ? "
                           "AND message_id IS NULL", (uploader, str(uploader_id)))["c"])
    if pend >= USER_MAX_PENDING:
        raise SupportError("Сначала отправьте уже прикреплённые файлы", 429)
    return MAX_FILE_BYTES


class Upload:
    """
    Потоковая загрузка: write(chunk) пишет на диск и обрывает при превышении
    лимита, finish() определяет тип и регистрирует файл. Одновременно не больше
    MAX_PARALLEL_UPLOADS загрузок от одного отправителя.
    """

    def __init__(self, chat_id: int, uploader: str, uploader_id: str, name: str) -> None:
        self.key = f"{uploader}:{uploader_id}"
        with _active_lock:
            if _active_uploads.get(self.key, 0) >= MAX_PARALLEL_UPLOADS:
                raise SupportError("Дождитесь окончания загрузки предыдущих файлов", 429)
            _active_uploads[self.key] = _active_uploads.get(self.key, 0) + 1
        self._released = False
        try:
            self.limit = upload_allowance(uploader, uploader_id)
        except BaseException:
            self._release()
            raise
        self.chat_id, self.uploader, self.uploader_id, self.name = int(chat_id), uploader, str(uploader_id), name
        self.fid = uuid.uuid4().hex
        folder = os.path.join(files_dir(), str(self.chat_id))
        os.makedirs(folder, mode=0o750, exist_ok=True)
        self.path = os.path.join(folder, self.fid)
        self.fh = open(self.path, "xb")
        self.size = 0
        self.head = b""
        self.sha = hashlib.sha256()

    def _release(self) -> None:
        if not self._released:
            self._released = True
            with _active_lock:
                n = _active_uploads.get(self.key, 1) - 1
                if n > 0:
                    _active_uploads[self.key] = n
                else:
                    _active_uploads.pop(self.key, None)

    def write(self, chunk: bytes) -> None:
        if not chunk:
            return
        self.size += len(chunk)
        if self.size > self.limit:
            self.abort()
            raise SupportError(f"Файл больше {self.limit // MB} МБ", 413)
        if len(self.head) < 32:
            self.head += chunk[: 32 - len(self.head)]
        self.sha.update(chunk)
        self.fh.write(chunk)

    def abort(self) -> None:
        try:
            self.fh.close()
        except OSError:
            pass
        try:
            os.remove(self.path)
        except OSError:
            pass
        self._release()

    def finish(self) -> dict[str, Any]:
        try:
            self.fh.close()
            if self.size == 0:
                os.remove(self.path)
                raise SupportError("Пустой файл")
            kind, ext = sniff(self.head)
            name = clean_name(self.name)
            if ext and not name.lower().endswith("." + ext):
                base = name.rsplit(".", 1)[0] if "." in name else name
                name = f"{base}.{ext}"
            mime = _INLINE_MIME.get(ext or "", "application/octet-stream")
            storage, path = "local", self.path
            if s3store.enabled():
                # Наш сервер → S3: файл уже проверен и лежит временно на диске
                cfg = s3store.get_config()
                key = f"{cfg['prefix']}support/{self.chat_id}/{self.fid}"
                inline = kind in ("image", "video")
                try:
                    s3store.put_file(key, self.path, self.sha.hexdigest(), mime if inline else "application/octet-stream",
                                     _disposition(name, inline))
                except s3store.S3Error as e:
                    try:
                        os.remove(self.path)
                    except OSError:
                        pass
                    raise SupportError(f"Не удалось сохранить файл, попробуйте ещё раз ({e.message})", 502)
                try:
                    os.remove(self.path)
                except OSError:
                    pass
                storage, path = "s3", key
            db.execute(
                "INSERT INTO support_files (id, chat_id, message_id, uploader, uploader_id, kind, name, mime, size, path, storage, created_at) "
                "VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (self.fid, self.chat_id, self.uploader, self.uploader_id, kind, name, mime, self.size, path, storage, _iso()),
            )
            if storage == "s3":
                _maybe_free_space()
            return {"id": self.fid, "kind": kind, "name": name, "size": self.size}
        finally:
            self._release()


def save_upload(chat_id: int, uploader: str, uploader_id: str, name: str, chunks) -> dict[str, Any]:
    """Синхронный вариант (тесты, сиды): chunks — итератор байтов."""
    up = Upload(chat_id, uploader, uploader_id, name)
    try:
        for c in chunks:
            up.write(c)
    except BaseException:
        up.abort()
        raise
    return up.finish()


def _disposition(name: str, inline: bool) -> str:
    from urllib.parse import quote
    return ("inline" if inline else "attachment") + f"; filename*=UTF-8''{quote(name)}"


def _drop_blob(f: dict[str, Any]) -> None:
    """Удалить сам файл (с диска или из S3). Ошибку S3 не пробрасываем — повторим при следующей чистке."""
    if (f.get("storage") or "local") == "s3":
        try:
            s3store.delete(f["path"])
        except s3store.S3Error:
            raise
    else:
        try:
            os.remove(f["path"])
        except OSError:
            pass


def _remove_files(rows: list[dict[str, Any]]) -> None:
    for f in rows:
        if not f.get("deleted_at"):
            try:
                _drop_blob(f)
            except s3store.S3Error:
                continue  # S3 сейчас недоступно — запись оставляем, удалим в следующий раз
        db.execute("DELETE FROM support_files WHERE id = ?", (f["id"],))


def _cleanup_pending() -> None:
    cutoff = _iso(_now() - timedelta(seconds=PENDING_TTL))
    _remove_files(db.fetchall("SELECT * FROM support_files WHERE message_id IS NULL AND created_at < ? LIMIT 500", (cutoff,)))


def _file_key() -> bytes:
    key = db.get_setting("support_file_key", "")
    if not key:
        key = secrets.token_hex(32)
        db.set_setting("support_file_key", key)
    return key.encode()


def file_url(fid: str) -> str:
    exp = int(time.time()) + FILE_URL_TTL
    sig = hmac.new(_file_key(), f"{fid}.{exp}".encode(), hashlib.sha256).hexdigest()[:40]
    return f"/api/support/file/{fid}?exp={exp}&sig={sig}"


def check_file_token(fid: str, exp: int, sig: str) -> Optional[dict[str, Any]]:
    if not re.fullmatch(r"[0-9a-f]{32}", fid or "") or exp < time.time():
        return None
    good = hmac.new(_file_key(), f"{fid}.{int(exp)}".encode(), hashlib.sha256).hexdigest()[:40]
    if not hmac.compare_digest(good, str(sig or "")):
        return None
    f = db.fetchone("SELECT * FROM support_files WHERE id = ? AND message_id IS NOT NULL AND deleted_at IS NULL", (fid,))
    if not f:
        return None
    if (f.get("storage") or "local") == "local" and not os.path.isfile(f["path"]):
        return None
    return f


def s3_download_url(f: dict[str, Any]) -> str:
    inline = f["kind"] in ("image", "video")
    return s3store.presign_get(f["path"], 3600, {
        "response-content-type": f["mime"] if inline else "application/octet-stream",
        "response-content-disposition": _disposition(f["name"], inline),
    })


# ─────────────────────────────────────────────────────────────
# Сообщения
# ─────────────────────────────────────────────────────────────

def send_message(chat: dict[str, Any], sender: str, author: Optional[str], text: str, file_ids: list[str],
                 uploader_id: str, reply_to: Optional[int] = None, actor: Optional[str] = None,
                 quote_tickets: Optional[set[int]] = None, any_ticket: bool = False, guard: Guard = None) -> dict[str, Any]:
    """
    sender: user | admin. Сообщение пользователя без открытого обращения открывает
    новое. Сотрудник пишет только в обращение, которое ведёт сам (actor).
    Файлы — только свои, этого чата и ещё не отправленные.
    Если висит вопрос «Могу ли я ещё помочь?», ответ пользователя с «нет» и
    «спасибо» закрывает обращение, любой другой ответ снимает вопрос.
    """
    text = (text or "").strip()
    if len(text) > MAX_TEXT:
        raise SupportError(f"Сообщение длиннее {MAX_TEXT} символов")
    ids = list(dict.fromkeys(str(x) for x in (file_ids or [])))
    if len(ids) > MAX_FILES_PER_MESSAGE:
        raise SupportError(f"Не больше {MAX_FILES_PER_MESSAGE} файлов в одном сообщении")
    if not text and not ids:
        raise SupportError("Пустое сообщение")
    closed = False
    with db.transaction() as tx:
        files = []
        for fid in ids:
            f = tx.execute("SELECT * FROM support_files WHERE id = ?", (fid,)).fetchone()
            if (not f or int(f["chat_id"]) != int(chat["id"]) or f["message_id"] is not None
                    or f["uploader"] != sender or str(f["uploader_id"]) != str(uploader_id)):
                raise SupportError("Файл не найден — загрузите его заново")
            files.append(dict(f))
        if reply_to:
            r = tx.execute("SELECT id, ticket_id FROM support_messages WHERE id = ? AND chat_id = ? AND sender != 'system'",
                           (int(reply_to), int(chat["id"]))).fetchone()
            # оператор цитирует только то, что сам видит (quote_tickets); None — без ограничений
            if not r or (quote_tickets is not None and r["ticket_id"] not in quote_tickets):
                reply_to = None  # цитируемое сообщение уже удалено — отправляем без цитаты
        t = open_ticket(chat, tx)
        if not t:
            if sender != "user":
                raise SupportError("Нажмите «Начать», чтобы открыть обращение", 409)
            t = _new_ticket(chat, "user", tx)
        elif sender == "admin" and t.get("assigned_admin") != actor and not any_ticket:
            raise SupportError("Сначала нажмите «Начать»", 409)
        if sender == "admin":
            _check(guard, t)
        now = _iso()
        cur = tx.execute("INSERT INTO support_messages (chat_id, ticket_id, reply_to, sender, author, author_actor, text, created_at) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (int(chat["id"]), t["id"], reply_to, sender, author,
                                                             actor if sender == "admin" else None, text, now))
        mid = cur.lastrowid
        for f in files:
            tx.execute("UPDATE support_files SET message_id = ? WHERE id = ?", (mid, f["id"]))
        preview = text[:120] if text else ("📎 " + (files[0]["name"] if len(files) == 1 else f"{len(files)} файла"))
        col = "unread_admin" if sender == "user" else "unread_user"
        tx.execute(f"UPDATE support_chats SET last_message_at = ?, last_preview = ?, last_sender = ?, {col} = {col} + 1 "
                   "WHERE id = ?", (now, preview, sender, int(chat["id"])))
        if sender == "admin":
            # ответ поддержки — обращение уходит вниз списка (старые без ответа — наверху)
            tx.execute("UPDATE support_tickets SET queue_at = ? WHERE id = ?", (now, t["id"]))
        if sender == "user" and t.get("close_prompt_id"):
            tx.execute("UPDATE support_tickets SET close_prompt_id = NULL, prompt_at = NULL WHERE id = ?", (t["id"],))
            if not files and is_no_thanks(text):
                _close_tx(tx, int(chat["id"]), t, "user", now)
                closed = True
    out = message(mid)
    out["ticket_closed"] = closed
    return out


def message(mid: int) -> dict[str, Any]:
    m = db.fetchone("SELECT * FROM support_messages WHERE id = ?", (int(mid),))
    assert m is not None
    return _serialize_rows([m])[0]


def _serialize_rows(rows: list[dict[str, Any]], tickets: Optional[set[int]] = None) -> list[dict[str, Any]]:
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    q = ",".join("?" * len(ids))
    by: dict[int, list] = {}
    for f in db.fetchall(f"SELECT * FROM support_files WHERE message_id IN ({q})", tuple(ids)):
        by.setdefault(int(f["message_id"]), []).append(f)
    rids = sorted({int(r["reply_to"]) for r in rows if r.get("reply_to")})
    quoted: dict[int, dict[str, Any]] = {}
    if rids:
        qq = ",".join("?" * len(rids))
        for m in db.fetchall(f"SELECT id, sender, author, text, ticket_id, deleted_at FROM support_messages WHERE id IN ({qq})", tuple(rids)):
            if tickets is not None and m.get("ticket_id") not in tickets:
                continue  # цитата из чужого обращения — оператору не показываем
            if m.get("deleted_at"):
                continue  # удалённое — показывается как «Сообщение удалено»
            nf = db.fetchone("SELECT COUNT(*) AS c FROM support_files WHERE message_id = ?", (m["id"],))["c"]
            quoted[int(m["id"])] = {"id": m["id"], "sender": m["sender"], "text": (m.get("text") or "")[:160], "files": int(nf)}
    active: set[int] = set()
    pids = [int(r["id"]) for r in rows if r.get("kind") == "close_prompt"]
    if pids:
        qq = ",".join("?" * len(pids))
        active = {int(x["close_prompt_id"]) for x in db.fetchall(
            f"SELECT close_prompt_id FROM support_tickets WHERE status = 'open' AND close_prompt_id IN ({qq})", tuple(pids))}
    out = []
    for m in rows:
        r = m.get("reply_to")
        gone = bool(m.get("deleted_at"))
        out.append({
            "id": m["id"], "ticket_id": m.get("ticket_id"), "sender": m["sender"], "author": m.get("author"),
            "author_actor": m.get("author_actor"), "edited": bool(m.get("edited_at")), "deleted": gone,
            "text": "" if gone else (m.get("text") or ""), "created_at": m["created_at"],
            "kind": m.get("kind") or None, "internal": bool(m.get("internal")),
            "panel_text": _panel_text(m),
            "action_active": (int(m["id"]) in active) if m.get("kind") == "close_prompt" else None,
            "reply_to": (quoted.get(int(r)) or {"id": int(r), "deleted": True}) if r else None,
            "files": [({"id": f["id"], "kind": f["kind"], "name": f["name"], "size": f["size"], "url": file_url(f["id"])}
                       if not f.get("deleted_at") else
                       {"id": f["id"], "kind": "deleted", "name": f["name"], "size": f["size"], "url": ""})
                      for f in ([] if gone else by.get(int(m["id"]), []))],
        })
    return out


_LEGACY_PANEL = (
    (re.compile(r"^Обращение №\d+ открыто$"), None),
    (re.compile(r"^Специалист поддержки подключился"), "{a} подключился"),
    (re.compile(r"^Обращение возвращено в пул"), "{a} отправил в пул"),
    (re.compile(r"^Обращение передано админу"), "{a} позвал Администратора"),
)


def _panel_text(m: dict[str, Any]) -> Optional[str]:
    """Текст служебного события для панели ('' — не показывать, None — не служебное)."""
    if m.get("kind") == "close_prompt":
        return f"{m.get('author') or 'Оператор'} закрывает обращение..."
    if m.get("sender") != "system":
        return None
    if m.get("panel_text") is not None:
        return m["panel_text"]
    text, author = m.get("text") or "", m.get("author") or "Оператор"
    for rx, tpl in _LEGACY_PANEL:
        if rx.search(text):
            return tpl.format(a=author) if tpl else ""
    if re.match(r"^Обращение №\d+ закрыто$", text):
        return "Обращение закрыто" if author in ("user", "auto", "Оператор") else f"{author} закрыл обращение"
    return text


def messages(chat_id: int, after: int = 0, limit: int = 500, tickets: Optional[set[int]] = None,
             for_user: bool = False) -> list[dict[str, Any]]:
    """
    tickets — показать только эти обращения (оператору — свои и текущее), None — все.
    for_user — для пользователя: без служебных пометок, без имён сотрудников и
    без номеров обращений.
    """
    extra = " AND internal = 0 AND deleted_at IS NULL" if for_user else ""
    if tickets is not None:
        if not tickets:
            return []
        ids = sorted(int(x) for x in tickets)
        q = ",".join("?" * len(ids))
        rows = db.fetchall(f"SELECT * FROM support_messages WHERE chat_id = ? AND id > ? AND ticket_id IN ({q}){extra} "
                           "ORDER BY id DESC LIMIT ?", (int(chat_id), int(after), *ids, int(limit)))
    else:
        rows = db.fetchall(f"SELECT * FROM support_messages WHERE chat_id = ? AND id > ?{extra} ORDER BY id DESC LIMIT ?",
                           (int(chat_id), int(after), int(limit)))
    rows.reverse()
    out = _serialize_rows(rows, tickets)
    return [public_message(m) for m in out] if for_user else out


_NUM_RX = re.compile(r"Обращение №\d+ ")


def public_message(m: dict[str, Any]) -> dict[str, Any]:
    """Сообщение глазами пользователя: без автора, служебных полей и номера обращения."""
    out = {k: v for k, v in m.items() if k not in ("author", "author_actor", "internal", "ticket_id", "panel_text")}
    if m.get("sender") == "system":
        out["text"] = _NUM_RX.sub("Обращение ", m.get("text") or "")
    return out


def changes(chat_id: int, upto: int, tickets: Optional[set[int]] = None, for_user: bool = False) -> list[dict[str, Any]]:
    """
    Изменённые и удалённые за последние сутки сообщения из уже загруженных (id ≤ upto) —
    открытое окно чата подтягивает их при опросе.
    """
    if upto <= 0:
        return []
    since = _iso(_now() - timedelta(days=1))
    rows = db.fetchall("SELECT * FROM support_messages WHERE chat_id = ? AND id <= ? AND (edited_at > ? OR deleted_at > ?) "
                       + ("AND internal = 0 " if for_user else "") + "ORDER BY id DESC LIMIT 100",
                       (int(chat_id), int(upto), since, since))
    if tickets is not None:
        rows = [r for r in rows if r.get("ticket_id") in tickets]
    out = _serialize_rows(list(reversed(rows)), tickets)
    if for_user:
        return [{"id": m["id"], "deleted": True} if m["deleted"] else public_message(m) for m in out]
    return out


def _own_message(chat: dict[str, Any], mid: int, actor: str) -> dict[str, Any]:
    m = db.fetchone("SELECT * FROM support_messages WHERE id = ? AND chat_id = ?", (int(mid), int(chat["id"])))
    if not m or m.get("deleted_at"):
        raise SupportError("Сообщение не найдено", 404)
    if m["sender"] != "admin" or m.get("kind") or m.get("internal") or m.get("author_actor") != actor:
        raise SupportError("Можно изменить или удалить только своё сообщение", 403)
    created = _parse(m["created_at"])
    if not created or (_now() - created).total_seconds() > EDIT_WINDOW:
        raise SupportError("Сообщение старше 48 часов — изменить или удалить его уже нельзя", 403)
    return m


def edit_message(chat: dict[str, Any], mid: int, actor: str, text: str) -> dict[str, Any]:
    m = _own_message(chat, mid, actor)
    text = (text or "").strip()
    if len(text) > MAX_TEXT:
        raise SupportError(f"Сообщение длиннее {MAX_TEXT} символов")
    has_files = bool(db.fetchone("SELECT 1 FROM support_files WHERE message_id = ? AND deleted_at IS NULL", (m["id"],)))
    if not text and not has_files:
        raise SupportError("Пустое сообщение — удалите его вместо этого")
    if text != (m.get("text") or ""):
        db.execute("UPDATE support_messages SET text = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL",
                   (text, _iso(), m["id"]))
        last = db.fetchone("SELECT MAX(id) AS m FROM support_messages WHERE chat_id = ? AND internal = 0", (int(chat["id"]),))
        if last and int(last["m"] or 0) == int(m["id"]):
            db.execute("UPDATE support_chats SET last_preview = ? WHERE id = ?", (text[:120] or "📎 Вложение", int(chat["id"])))
    return message(int(m["id"]))


def delete_message(chat: dict[str, Any], mid: int, actor: str) -> dict[str, Any]:
    """Удаляет своё сообщение: у пользователя оно пропадает, вложения стираются."""
    m = _own_message(chat, mid, actor)
    db.execute("UPDATE support_messages SET text = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL", (_iso(), m["id"]))
    _remove_files(db.fetchall("SELECT * FROM support_files WHERE message_id = ?", (m["id"],)))
    last = db.fetchone("SELECT id, text FROM support_messages WHERE chat_id = ? AND internal = 0 AND deleted_at IS NULL "
                       "AND sender != 'system' ORDER BY id DESC LIMIT 1", (int(chat["id"]),))
    db.execute("UPDATE support_chats SET last_preview = ? WHERE id = ?",
               (((last or {}).get("text") or "")[:120], int(chat["id"])))
    return {"id": m["id"], "tg_msg_id": m.get("tg_msg_id")}


def mark_read(chat_id: int, who: str) -> None:
    col = "unread_admin" if who == "admin" else "unread_user"
    db.execute(f"UPDATE support_chats SET {col} = 0 WHERE id = ?", (int(chat_id),))


# ─────────────────────────────────────────────────────────────
# Хранение: 7 дней после закрытия + место в хранилище
# ─────────────────────────────────────────────────────────────

def _delete_messages(ids: list[int]) -> int:
    removed = 0
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        q = ",".join("?" * len(part))
        fl = db.fetchall(f"SELECT * FROM support_files WHERE message_id IN ({q})", tuple(part))
        removed += len(fl)
        _remove_files(fl)
        db.execute(f"DELETE FROM support_messages WHERE id IN ({q})", tuple(part))
    return removed


def storage_usage() -> dict[str, Any]:
    """Сколько занято и сколько всего: у S3 — размер из настроек, у диска — сам диск."""
    if s3store.enabled():
        cap = int(s3store.get_config()["size_gb"] * 1024 * MB)
        used = int(db.fetchone("SELECT COALESCE(SUM(size), 0) AS s FROM support_files WHERE storage = 's3' "
                               "AND deleted_at IS NULL")["s"])
        return {"kind": "s3", "used": used, "cap": cap}
    os.makedirs(files_dir(), exist_ok=True)
    du = shutil.disk_usage(files_dir())
    return {"kind": "local", "used": du.used, "cap": du.total}


def free_space() -> int:
    """
    Хранилище заполнено на 90% и больше → удаляем самые старые вложения (сами
    сообщения остаются, вместо файла — «файл удалён»), пока не станет 80%.
    """
    u = storage_usage()
    if not u["cap"] or u["used"] < u["cap"] * FILL_TRIGGER:
        return 0
    need = u["used"] - int(u["cap"] * FILL_TARGET)
    kind = u["kind"]
    freed = count = 0
    for f in db.fetchall("SELECT * FROM support_files WHERE deleted_at IS NULL AND message_id IS NOT NULL AND "
                         "COALESCE(storage, 'local') = ? ORDER BY created_at LIMIT 5000", (kind,)):
        if freed >= need:
            break
        try:
            _drop_blob(f)
        except s3store.S3Error:
            break
        db.execute("UPDATE support_files SET deleted_at = ? WHERE id = ?", (_iso(), f["id"]))
        freed += int(f["size"] or 0)
        count += 1
    if count:
        print(f"[support] хранилище заполнено ≥{int(FILL_TRIGGER * 100)}% — удалено старых вложений: {count} "
              f"({freed // MB} МБ)", flush=True)
    return count


_last_free_check = [0.0]


def _maybe_free_space() -> None:
    if time.time() - _last_free_check[0] > 60:
        _last_free_check[0] = time.time()
        try:
            free_space()
        except Exception:  # noqa: BLE001
            pass


def cleanup() -> dict[str, int]:
    """
    • Обращения, закрытые больше 7 дней назад, удаляются вместе с перепиской и вложениями.
    • Хранилище заполнено на 90% → удаляются самые старые вложения.
    • «Зависшие» загрузки и файлы-сироты на диске.
    """
    cutoff = _iso(_now() - timedelta(days=KEEP_AFTER_CLOSE_DAYS))
    old_tickets = [int(r["id"]) for r in db.fetchall(
        "SELECT id FROM support_tickets WHERE status = 'closed' AND closed_at < ? LIMIT 2000", (cutoff,))]
    ids: list[int] = []
    for i in range(0, len(old_tickets), 500):
        part = old_tickets[i:i + 500]
        q = ",".join("?" * len(part))
        ids += [int(r["id"]) for r in db.fetchall(f"SELECT id FROM support_messages WHERE ticket_id IN ({q})", tuple(part))]
    # Сообщения без обращения (до появления тикетов) — через 7 дней после отправки
    ids += [int(r["id"]) for r in db.fetchall(
        "SELECT id FROM support_messages WHERE ticket_id IS NULL AND created_at < ? LIMIT 5000", (cutoff,))]
    removed_files = _delete_messages(ids)
    if old_tickets:
        q = ",".join("?" * len(old_tickets))
        db.execute(f"DELETE FROM support_tickets WHERE id IN ({q})", tuple(old_tickets))
    _cleanup_pending()
    removed_files += free_space()
    # Переписки, где всё удалилось, — пропадают из списка
    db.execute("UPDATE support_chats SET last_message_at = NULL, last_preview = NULL, last_sender = NULL, unread_admin = 0, "
               "unread_user = 0 WHERE open_ticket_id IS NULL AND NOT EXISTS "
               "(SELECT 1 FROM support_messages m WHERE m.chat_id = support_chats.id AND m.sender != 'system')")
    # Файлы на диске, которых нет в базе (например, оборванные загрузки после перезапуска)
    known = {r["path"] for r in db.fetchall("SELECT path FROM support_files WHERE COALESCE(storage, 'local') = 'local'")}
    base = files_dir()
    stale_before = time.time() - PENDING_TTL
    if os.path.isdir(base):
        for root, _dirs, fnames in os.walk(base):
            for fn in fnames:
                p = os.path.join(root, fn)
                try:
                    if p not in known and os.path.getmtime(p) < stale_before:
                        os.remove(p)
                        removed_files += 1
                except OSError:
                    pass
    return {"messages": len(ids), "files": removed_files}


def storage_stats() -> dict[str, Any]:
    u = storage_usage()
    files = int(db.fetchone("SELECT COALESCE(SUM(size), 0) AS s FROM support_files WHERE deleted_at IS NULL")["s"])
    return {"kind": u["kind"], "used_bytes": u["used"], "cap_bytes": u["cap"], "support_bytes": files,
            "trigger_pct": int(FILL_TRIGGER * 100)}
