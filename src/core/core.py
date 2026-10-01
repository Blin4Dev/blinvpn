
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import string
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import parse_qsl

try:
    from . import database as db
except ImportError:
    import database as db  # type: ignore

# src/api (platega, telegram_stars, remnawave) в sys.path
import sys as _sys
_API_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
if os.path.isdir(_API_DIR) and _API_DIR not in _sys.path:
    _sys.path.insert(0, _API_DIR)

try:
    from . import fulfillment
except ImportError:
    import fulfillment  # type: ignore

try:
    from . import provisioning
except ImportError:
    import provisioning  # type: ignore

try:
    from . import services
except ImportError:
    import services  # type: ignore

try:
    from . import notifier
except ImportError:
    import notifier  # type: ignore

try:
    from . import forum
except ImportError:
    import forum  # type: ignore

try:
    from . import survey
except ImportError:
    import survey  # type: ignore

try:
    from . import mailer
except ImportError:
    import mailer  # type: ignore

try:
    from . import ratelimit
except ImportError:
    import ratelimit  # type: ignore

try:
    from . import blacklist  # type: ignore
except ImportError:
    import blacklist  # type: ignore

try:
    from . import moderation  # type: ignore
except ImportError:  # pragma: no cover
    import moderation  # type: ignore

try:
    from . import teamchat  # type: ignore
except ImportError:  # pragma: no cover
    import teamchat  # type: ignore

try:
    from . import xbm  # type: ignore
except ImportError:  # pragma: no cover
    import xbm  # type: ignore

try:
    from . import grace  # type: ignore
    from . import names  # type: ignore
except ImportError:  # pragma: no cover
    import grace  # type: ignore
    import names  # type: ignore

try:
    from . import antiabuse  # type: ignore
except ImportError:  # pragma: no cover
    import antiabuse  # type: ignore

try:
    from . import support  # type: ignore
    from . import s3store  # type: ignore
    from . import captcha as captcha_mod  # type: ignore
except ImportError:  # pragma: no cover
    import support  # type: ignore
    import s3store  # type: ignore
    import captcha as captcha_mod  # type: ignore
try:
    from . import monitoring  # type: ignore
except ImportError:
    import monitoring  # type: ignore
try:
    from . import staff as staffmod  # type: ignore
    from . import staffpay  # type: ignore
    from . import webpush  # type: ignore
except ImportError:  # pragma: no cover
    import staff as staffmod  # type: ignore
    import staffpay  # type: ignore
    import webpush  # type: ignore
try:
    from . import stats as stats_mod  # type: ignore
except ImportError:  # pragma: no cover
    import stats as stats_mod  # type: ignore

try:
    import platega  # type: ignore
except Exception:  # noqa: BLE001
    platega = None  # type: ignore
try:
    import telegram_stars  # type: ignore
except Exception:  # noqa: BLE001
    telegram_stars = None  # type: ignore
try:
    import applinks  # type: ignore
except Exception:  # noqa: BLE001
    applinks = None  # type: ignore

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field


def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


TELEGRAM_BOT_TOKEN = _env("TELEGRAM_BOT_TOKEN")
TELEGRAM_WEBHOOK_SECRET = _env("TELEGRAM_WEBHOOK_SECRET")
# обязательная подписка на канал (только telegram-вход)
REQUIRED_CHANNEL_ID = _env("REQUIRED_CHANNEL_ID", "-1003036752851")
REQUIRED_CHANNEL_URL = _env("REQUIRED_CHANNEL_URL", "https://t.me/blinvpn")
CHANNEL_CHECK_TTL = _env_int("CHANNEL_CHECK_TTL", 600)  # кэш проверки подписки, сек
TELEGRAM_ADMIN_ID = _env("TELEGRAM_ADMIN_ID")
BOT_USERNAME = _env("BOT_USERNAME") or _env("VITE_BOT_USERNAME") or "blinvpn_bot"
PANEL_SETUP_TOKEN = _env("PANEL_SETUP_TOKEN")
INTERNAL_API_SECRET = _env("INTERNAL_API_SECRET")
TELEGRAM_INITDATA_MAX_AGE = _env_int("TELEGRAM_INITDATA_MAX_AGE", 3600)
MINIAPP_ALLOW_UNAUTH = _env("MINIAPP_ALLOW_UNAUTH", "0") in ("1", "true", "True", "yes")
CORS_ORIGINS = [o.strip() for o in _env("CORS_ORIGINS", "*").split(",") if o.strip()]
# fail-closed: без ENV считаем production
ENV = _env("ENV", "production")
IS_PROD = ENV == "production"

MINIAPP_URL = _env("MINIAPP_URL").rstrip("/")
PLATEGA_RETURN_URL = _env("PLATEGA_RETURN_URL") or (f"{MINIAPP_URL}/payment/success" if MINIAPP_URL else "")
PLATEGA_FAILED_URL = _env("PLATEGA_FAILED_URL") or (f"{MINIAPP_URL}/payment/failed" if MINIAPP_URL else "")


# в проде без swagger/openapi
app = FastAPI(
    title="BlinVPN API",
    version="1.0.0",
    docs_url=None if IS_PROD else "/api/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/api/openapi.json",
)

# при origin=* credentials нельзя: куки утекли бы на любой сайт
# у нас auth в заголовках, при wildcard credentials выключаем
_cors_wildcard = CORS_ORIGINS == ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _cors_wildcard else CORS_ORIGINS,
    allow_credentials=not _cors_wildcard,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Telegram-Init-Data",
                   "X-App-Session", "X-Panel-Setup-Token"],
)


# get карточки юзера/подписки тоже пишем в журнал
_AUDIT_GET_RX = re.compile(r"^/api/panel/users/\d+(?:/detail|/remnawave)?$")


class PanelAuditMiddleware:
    """журнал изменяющих запросов панели (asgi, без basehttpmiddleware)."""

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        path = str(scope.get("path") or "")
        if scope.get("type") != "http" or not path.startswith("/api/panel/") or path.startswith("/api/panel/auth/") \
                or scope.get("method") == "OPTIONS" \
                or (scope.get("method") in ("GET", "HEAD") and not _AUDIT_GET_RX.match(path)):
            return await self.app(scope, receive, send)
        scope.setdefault("state", {})
        status = {"code": 0}

        async def _send(msg):
            if msg.get("type") == "http.response.start":
                status["code"] = int(msg.get("status") or 0)
            await send(msg)

        try:
            await self.app(scope, receive, _send)
        finally:
            st = scope.get("state") or {}
            actor = st.get("panel_actor") if isinstance(st, dict) else None
            if actor:
                ip = _client_ip(Request(scope))
                await run_in_threadpool(audit, actor, st.get("panel_actor_name"), f"{scope['method']} {scope['path']}",
                                        status["code"] or 500, ip)


app.add_middleware(PanelAuditMiddleware)


def _backup_scheduler_loop() -> None:
    """автобэкап бд по enabled + interval_hours."""
    import threading

    while True:
        try:
            settings = get_backup_settings()
            if settings.get("enabled"):
                interval = max(1, int(settings.get("interval_hours") or 12))
                last = db.get_setting("backup_last", "") or None
                due = True
                if last:
                    dt = parse_iso(last)
                    if dt and (utcnow() - dt) < timedelta(hours=interval):
                        due = False
                if due:
                    create_backup()
        except Exception:  # noqa: BLE001
            pass
        # сверка платежей (потерянные callback и т.п.)
        try:
            fulfillment.reconcile_payments(lambda m: print(m, flush=True))
        except Exception as exc:  # noqa: BLE001
            print(f"[payments] сверка упала: {exc}", flush=True)
        # чистка старых записей rate limit
        try:
            ratelimit.cleanup()
        except Exception:  # noqa: BLE001
            pass
        # цикл раз в 5 мин; бэкап сам смотрит interval_hours
        threading.Event().wait(300)


@app.exception_handler(Exception)
async def _unhandled_exc(request: Request, exc: Exception):
    # необработанное исключение -> топик «ошибки»
    try:
        forum.report_error(
            f"500 {request.method} {request.url.path}",
            f"{type(exc).__name__}: {exc}",
        )
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse({"detail": {"message": "Внутренняя ошибка сервера"}}, status_code=500)


def _bootstrap_admin() -> None:
    """первый запуск: случайный админ, креды в first_run_credentials.txt."""
    if get_admin() is not None:
        return
    admin, password = create_admin()  # логин случайный; пароль в бд не хранится

    # пароль один раз в файл для install.sh
    # в логи контейнера пароль не пишем
    wrote_file = False
    path = os.path.join(os.path.dirname(os.path.abspath(db.get_db_path())), "first_run_credentials.txt")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"login={admin['username']}\npassword={password}\n")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        wrote_file = True
    except Exception:  # noqa: BLE001
        wrote_file = False

    if wrote_file:
        print(f"[BlinVPN] Учётные данные панели записаны в {path} — показ при установке, затем файл удаляется.", flush=True)
    else:
        # файл не записался, печатаем в консоль
        print(
            "\n============================================================\n"
            "  BlinVPN — доступ в панель (сохраните, больше не покажем)\n"
            f"  Логин:  {admin['username']}\n"
            f"  Пароль: {password}\n"
            "============================================================\n",
            flush=True,
        )


@app.on_event("startup")
def _startup() -> None:
    db.init_db()
    _bootstrap_admin()
    try:
        n = unfreeze_legacy_frozen_subscriptions()
        if n:
            print(f"[BlinVPN] заморозка удалена — возвращено в работу подписок: {n}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[BlinVPN] unfreeze legacy failed: {exc}", flush=True)
    # рассылки, прерванные рестартом, не должны висеть «отправляется»
    try:
        db.execute("UPDATE mailings SET status = 'Interrupted' WHERE status = 'Sending'")
    except Exception:  # noqa: BLE001
        pass
    # недоделанное удаление рассылки после рестарта
    try:
        import threading as _th
        for m in db.fetchall("SELECT id FROM mailings WHERE status = 'Deleting'"):
            _th.Thread(target=_purge_mailing, args=(int(m["id"]),), daemon=True).start()
    except Exception:  # noqa: BLE001
        pass
    # статус юзеров по фактическим подпискам
    # (раньше новым ставили Trial даже без подписки)
    try:
        for uid, st in user_states_map().items():
            if st != "Banned":
                db.execute("UPDATE users SET status = ? WHERE id = ? AND status != ?", (st, uid, st))
    except Exception as exc:  # noqa: BLE001
        print(f"[BlinVPN] status resync failed: {exc}", flush=True)
    import threading
    threading.Thread(target=_backup_scheduler_loop, name="backup-scheduler", daemon=True).start()
    if db.get_setting("rw_description_backfill_v1") != "1":
        threading.Thread(target=_rw_description_backfill, name="rw-description-backfill", daemon=True).start()


def _rw_description_backfill() -> None:
    """разово: внутренний id в описание существующих юзеров remnawave."""
    try:
        rows = db.fetchall("SELECT id, telegram_id FROM users WHERE telegram_id IS NOT NULL")
        mapping = {int(r["telegram_id"]): int(r["id"]) for r in rows if r.get("telegram_id")}
        res = provisioning.backfill_descriptions(mapping)
        if res.get("ok"):
            db.set_setting("rw_description_backfill_v1", "1")
            print(f"[BlinVPN] Remnawave: ID проставлен в описание у {res['updated']} польз.", flush=True)
        else:
            print(f"[BlinVPN] Remnawave description backfill: {res.get('error')}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[BlinVPN] Remnawave description backfill failed: {exc}", flush=True)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime] = None) -> str:
    if dt is None:
        return db.utcnow_iso()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def gen_token(n: int = 48) -> str:
    return secrets.token_urlsafe(n)


def gen_password(n: int = 24) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def gen_ref_code(n: int = 8) -> str:
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(n))
        if not db.fetchone("SELECT id FROM users WHERE referral_code = ?", (code,)):
            return code


def hash_password(password: str, salt: Optional[str] = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return digest, salt


def verify_password(password: str, digest: str, salt: str) -> bool:
    check, _ = hash_password(password, salt)
    return hmac.compare_digest(check, digest)


def paginate(items: list[Any], limit: int = 100, offset: int = 0) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    return {"items": items[offset : offset + limit], "total": len(items)}


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(int(value))
    s = str(value).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


def _telegram_data_check_string(fields: dict[str, str]) -> str:
    return "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))


class InitDataExpired(HTTPException):
    """подпись initdata верна, но протухла."""

    def __init__(self, telegram_id: int):
        super().__init__(401, detail={"message": "initData устарел"})
        self.telegram_id = telegram_id


def validate_webapp_init_data(init_data: str) -> dict[str, Any]:
    if not init_data:
        raise HTTPException(401, detail={"message": "Пустой initData"})
    if not TELEGRAM_BOT_TOKEN:
        if MINIAPP_ALLOW_UNAUTH or ENV != "production":
            parsed = dict(parse_qsl(init_data, keep_blank_values=True))
            user_raw = parsed.get("user", "{}")
            try:
                user = json.loads(user_raw)
            except json.JSONDecodeError:
                user = {"id": 0}
            return {"user": user}
        raise HTTPException(503, detail={"message": "TELEGRAM_BOT_TOKEN не задан"})

    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    received = parsed.pop("hash", "")
    if not received:
        raise HTTPException(401, detail={"message": "Нет hash в initData"})

    check = _telegram_data_check_string(parsed)
    secret = hmac.new(b"WebAppData", TELEGRAM_BOT_TOKEN.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, received):
        raise HTTPException(401, detail={"message": "Неверная подпись Telegram"})

    try:
        user = json.loads(parsed.get("user") or "{}")
    except json.JSONDecodeError:
        raise HTTPException(401, detail={"message": "Некорректный user в initData"})

    auth_date = int(parsed.get("auth_date") or 0)
    if not auth_date or (time.time() - auth_date) > TELEGRAM_INITDATA_MAX_AGE:
        raise InitDataExpired(int(user.get("id") or 0))
    return {"user": user, "raw": parsed}


def validate_oauth_login(payload: dict[str, Any]) -> dict[str, Any]:
    if not TELEGRAM_BOT_TOKEN:
        if MINIAPP_ALLOW_UNAUTH or ENV != "production":
            return payload
        raise HTTPException(503, detail={"message": "TELEGRAM_BOT_TOKEN не задан"})

    data = {k: str(v) for k, v in payload.items() if k != "hash" and v is not None and str(v) != ""}
    received = str(payload.get("hash") or "")
    check = _telegram_data_check_string(data)
    secret = hashlib.sha256(TELEGRAM_BOT_TOKEN.encode()).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, received):
        raise HTTPException(401, detail={"message": "Неверная подпись OAuth"})

    auth_date = int(data.get("auth_date") or 0)
    if auth_date and (time.time() - auth_date) > TELEGRAM_INITDATA_MAX_AGE:
        raise HTTPException(401, detail={"message": "OAuth данные устарели"})
    return data


def get_admin() -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM admin WHERE id = 1")


def gen_admin_username() -> str:
    """случайный логин админа (не admin)."""
    alphabet = string.ascii_lowercase + string.digits
    return "adm-" + "".join(secrets.choice(alphabet) for _ in range(7))


def create_admin(username: Optional[str] = None, password: Optional[str] = None) -> tuple[dict[str, Any], str]:
    """создать/сбросить админа: в бд только соль и pbkdf2-хэш."""
    username = username or gen_admin_username()
    password = password or gen_password()
    digest, salt = hash_password(password)
    now = db.utcnow_iso()
    existing = get_admin()
    if existing:
        db.execute(
            "UPDATE admin SET username = ?, password_hash = ?, password_salt = ?, plaintext_once = NULL WHERE id = 1",
            (username, digest, salt),
        )
        # смена пароля сбрасывает все сессии панели
        try:
            db.execute("DELETE FROM panel_sessions")
        except Exception:  # noqa: BLE001
            pass
    else:
        db.execute(
            "INSERT INTO admin (id, username, password_hash, password_salt, plaintext_once, created_at) "
            "VALUES (1, ?, ?, ?, NULL, ?)",
            (username, digest, salt, now),
        )
    admin = get_admin()
    assert admin is not None
    return admin, password


def clear_admin_plaintext() -> None:
    db.execute("UPDATE admin SET plaintext_once = NULL WHERE id = 1")


PANEL_SESSION_TTL = 60 * 60  # 60 минут


def _token_hash(token: str) -> str:
    """в бд храним sha-256 токена сессии, не сам токен."""
    return hashlib.sha256(str(token or "").encode()).hexdigest()


def create_panel_session(username: str, staff_id: Optional[int] = None) -> str:
    """staff_id=None: сессия владельца, иначе сотрудника."""
    token = gen_token()
    now = time.time()
    db.execute(
        "INSERT INTO panel_sessions (token, username, expires_at, staff_id, created_at) VALUES (?, ?, ?, ?, ?)",
        (_token_hash(token), username, now + PANEL_SESSION_TTL, int(staff_id) if staff_id is not None else None, now),
    )
    return token


def delete_staff_sessions(staff_id: int) -> None:
    db.execute("DELETE FROM panel_sessions WHERE staff_id = ?", (int(staff_id),))
    db.execute("DELETE FROM temp_2fa WHERE staff_id = ?", (int(staff_id),))


def delete_panel_session(token: str) -> None:
    db.execute("DELETE FROM panel_sessions WHERE token = ?", (_token_hash(token),))


def get_panel_session(token: str) -> Optional[dict[str, Any]]:
    th = _token_hash(token)
    row = db.fetchone("SELECT * FROM panel_sessions WHERE token = ?", (th,))
    if not row:
        return None
    if float(row["expires_at"]) < time.time():
        db.execute("DELETE FROM panel_sessions WHERE token = ?", (th,))
        return None
    return row


APP_SESSION_TTL = 30 * 86400  # 30 дней
EMAIL_CODE_TTL = 600          # 10 минут
EMAIL_CODE_RESEND = 60        # анти-спам на повторную отправку


def create_app_session(user_id: int) -> str:
    token = gen_token()
    now = time.time()
    db.execute(
        "INSERT INTO app_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (_token_hash(token), int(user_id), now, now + APP_SESSION_TTL),
    )
    # оставляем 10 свежих сессий, истёкшие удаляем
    db.execute(
        "DELETE FROM app_sessions WHERE user_id = ? AND token NOT IN "
        "(SELECT token FROM app_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)",
        (int(user_id), int(user_id)),
    )
    db.execute("DELETE FROM app_sessions WHERE expires_at < ?", (now,))
    return token


def get_app_session(token: str) -> Optional[dict[str, Any]]:
    th = _token_hash(token)
    row = db.fetchone("SELECT * FROM app_sessions WHERE token = ?", (th,))
    if not row:
        return None
    if float(row["expires_at"]) < time.time():
        db.execute("DELETE FROM app_sessions WHERE token = ?", (th,))
        return None
    return row


def delete_app_session(token: str) -> None:
    db.execute("DELETE FROM app_sessions WHERE token = ?", (_token_hash(token),))


_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.(?:[A-Za-z]{2,24}|xn--[A-Za-z0-9\-]{1,59})$")


def _valid_email(email: str) -> bool:
    return bool(email) and len(email) <= 254 and bool(_EMAIL_RE.match(email))


def create_email_code(email: str) -> tuple[str, bool]:
    """создаёт код входа. возвращает (code, throttled)."""
    email = email.strip().lower()
    now = time.time()
    existing = db.fetchone("SELECT last_sent_at FROM email_codes WHERE email = ?", (email,))
    if existing and (now - float(existing.get("last_sent_at") or 0)) < EMAIL_CODE_RESEND:
        row = db.fetchone("SELECT code FROM email_codes WHERE email = ?", (email,))
        return (str(row["code"]) if row else ""), True
    code = f"{secrets.randbelow(1_000_000):06d}"
    # у каждого кода свои 5 попыток
    attempts = 0
    db.execute(
        "INSERT OR REPLACE INTO email_codes (email, code, expires_at, attempts, last_sent_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (email, code, now + EMAIL_CODE_TTL, attempts, now),
    )
    return code, False


def verify_email_code(email: str, code: str) -> bool:
    email = email.strip().lower()
    code = str(code or "").strip()
    # атомарно тратим попытку; верный код удаляется тут же
    with db.transaction() as tx:
        row = tx.execute("SELECT * FROM email_codes WHERE email = ?", (email,)).fetchone()
        if not row:
            return False
        if float(row["expires_at"]) < time.time():
            tx.execute("DELETE FROM email_codes WHERE email = ?", (email,))
            return False
        if int(row["attempts"] or 0) >= 5:
            return False
        if not hmac.compare_digest(str(row["code"]).encode(), code.encode()):
            tx.execute("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?", (email,))
            return False
        tx.execute("DELETE FROM email_codes WHERE email = ?", (email,))
        return True


def send_login_code(email: str, code: str) -> None:
    """доставка кода на почту; логируем результат."""
    if mailer.is_configured():
        ok, err = mailer.send_login_code(email, code)
        if ok:
            return
        print(f"[email] не удалось отправить код на {email}: {err}", flush=True)
        try:
            forum.report_error("Не удалось отправить код входа на почту", err)
        except Exception:  # noqa: BLE001
            pass
    # код входа в проде в логи не пишем
    if not IS_PROD:
        print(f"[email] код входа для {email}: {code}", flush=True)


def set_temp_2fa(username: str, staff_id: Optional[int] = None) -> tuple[str, str]:
    temp = gen_token(24)
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.execute(
        "INSERT OR REPLACE INTO temp_2fa (token, code, username, expires_at, staff_id) VALUES (?, ?, ?, ?, ?)",
        (_token_hash(temp), code, username, time.time() + 300, int(staff_id) if staff_id is not None else None),
    )
    return temp, code


def pop_temp_2fa(token: str) -> Optional[dict[str, Any]]:
    """забрать код один раз: read+delete в одной транзакции."""
    th = _token_hash(token)
    with db.transaction() as tx:
        row = tx.execute("SELECT * FROM temp_2fa WHERE token = ?", (th,)).fetchone()
        if not row:
            return None
        tx.execute("DELETE FROM temp_2fa WHERE token = ?", (th,))
    row = dict(row)
    if float(row["expires_at"]) < time.time():
        return None
    return row


def get_user(user_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM users WHERE id = ?", (user_id,))


def find_user_by_tg(telegram_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))


def upsert_telegram_user(
    telegram_id: int,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
) -> dict[str, Any]:
    # имя/фамилию из telegram не храним (параметры для совместимости)
    first_name = last_name = None
    existing = find_user_by_tg(telegram_id)
    if existing:
        db.execute(
            "UPDATE users SET username = COALESCE(?, username) WHERE id = ?",
            (names.tg_username(username), existing["id"]),
        )
        user = get_user(int(existing["id"]))
        assert user is not None
        if not user.get("is_banned"):
            _enforce_blacklist(user)
            user = get_user(int(existing["id"])) or user
        return user

    code = gen_ref_code()
    db.execute(
        "INSERT INTO users (telegram_id, username, first_name, last_name, balance, status, is_banned, "
        "referral_code, is_partner, partner_balance, partner_rate, "
        "autopay_enabled, created_at) VALUES (?, ?, ?, ?, 0, 'None', 0, ?, 0, 0, 25, 0, ?)",
        (
            telegram_id,
            names.tg_username(username),
            first_name,
            last_name,
            code,
            db.utcnow_iso(),
        ),
    )
    user = get_user(db.last_id())
    assert user is not None
    _enforce_blacklist(user)
    return get_user(int(user["id"])) or user


def _enforce_blacklist(user: dict[str, Any]) -> None:
    """юзер из общего чёрного списка блокируется при входе."""
    try:
        blacklist.enforce(user)
    except Exception as exc:  # noqa: BLE001
        print(f"[blacklist] ошибка проверки: {exc}", flush=True)


def referrals_count(user_id: int) -> int:
    row = db.fetchone("SELECT COUNT(*) AS c FROM users WHERE referred_by = ?", (user_id,))
    return int(row["c"]) if row else 0


def paid_until_for_user(user_id: int) -> Optional[str]:
    row = db.fetchone(
        "SELECT expires_at FROM subscriptions WHERE user_id = ? AND status = 'Active' "
        "AND expires_at IS NOT NULL ORDER BY expires_at DESC LIMIT 1",
        (user_id,),
    )
    return row["expires_at"] if row else None


def subscription_status_for_user(u: dict[str, Any]) -> str:
    """статус юзера: banned/blocked/active/trial/expired/none."""
    if u.get("is_banned"):
        return "banned"
    blocked = db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Banned' LIMIT 1",
        (u["id"],),
    )
    if blocked:
        return "blocked"
    active = db.fetchone(
        "SELECT type, expires_at FROM subscriptions WHERE user_id = ? AND status = 'Active' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC LIMIT 1",
        (u["id"],),
    )
    if active:
        exp = parse_iso(active.get("expires_at"))
        if not exp or exp > utcnow():
            return "trial" if active.get("type") == "trial" else "active"
    if db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('Active', 'Expired') "
        "AND COALESCE(no_renew, 0) = 0 LIMIT 1",
        (u["id"],),
    ):
        return "expired"
    if db.fetchone("SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1", (u["id"],)):
        return "lapsed"
    return "never"


def last_expired_subscription(user_id: int) -> Optional[dict[str, Any]]:
    """последняя истёкшая, ещё не удалённая подписка (для продления)."""
    return db.fetchone(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('Active', 'Expired') "
        "AND COALESCE(no_renew, 0) = 0 "
        "AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at DESC, id DESC LIMIT 1",
        (user_id, iso()),
    )


def serialize_user(u: dict[str, Any], *, revenue: Optional[float] = None) -> dict[str, Any]:
    banned = bool(u.get("is_banned"))
    uid = int(u["id"])
    if revenue is None:
        row = db.fetchone(
            "SELECT COALESCE(SUM(amount), 0) AS s FROM payments "
            "WHERE user_id = ? AND status IN ('paid', 'completed') AND COALESCE(amount, 0) > 0",
            (uid,),
        )
        revenue = float(row["s"]) if row else 0.0
    return {
        "id": u["id"],
        "telegram_id": u.get("telegram_id"),
        "username": u.get("username"),
        "first_name": u.get("first_name"),
        "last_name": u.get("last_name"),
        "email": u.get("email"),
        "balance": u.get("balance", 0),
        # всегда фактическое состояние по подпискам
        "status": u.get("_state") or fulfillment.compute_user_state(uid),
        "in_blacklist": banned,
        "is_banned": banned,
        "registration_date": u.get("created_at"),
        "paid_until": paid_until_for_user(uid),
        "referral_code": u.get("referral_code"),
        "is_partner": bool(u.get("is_partner")),
        "partner_balance": u.get("partner_balance", 0),
        "partner_rate": u.get("partner_rate", 25),
        "referrals": referrals_count(uid),
        "revenue": round(float(revenue or 0), 2),
        "no_renew": no_renew_for_user(uid),
    }


def no_renew_for_user(user_id: int) -> bool:
    """есть ли живая подписка с запретом продления."""
    return bool(db.fetchone(
        "SELECT 1 FROM subscriptions WHERE user_id = ? AND COALESCE(no_renew, 0) = 1 "
        "AND status IN ('Active', 'Expired', 'Banned') LIMIT 1",
        (int(user_id),),
    ))


def serialize_app_user(u: dict[str, Any]) -> dict[str, Any]:
    status = subscription_status_for_user(u)
    until = paid_until_for_user(int(u["id"]))
    return {
        "id": u["id"],
        "telegram_id": u["telegram_id"],
        "username": u.get("username"),
        "email": u.get("email"),
        "subscription_status": status,
        "subscription_until": until,
        # чёрный список: в приложении даже поддержка недоступна
        "blacklisted": bool(u.get("is_banned")) and str(u.get("ban_reason") or "").startswith(blacklist.BAN_REASON_PREFIX),
        "is_banned": bool(u.get("is_banned")),
        "referral_code": u.get("referral_code"),
        "is_partner": bool(u.get("is_partner")),
        "partner_balance": float(u.get("partner_balance") or 0),
        "discount": active_discount_for_user(int(u["id"])),
        # принял ли оферту и политику
        "terms_accepted": bool(u.get("terms_accepted_at")),
    }


def days_left_for_expiry(expires_at: Optional[str]) -> Optional[int]:
    if not expires_at:
        return None
    dt = parse_iso(expires_at)
    if not dt:
        return 0
    return max(0, int((dt - utcnow()).total_seconds() // 86400))


def refresh_subscription_row(sub: dict[str, Any]) -> dict[str, Any]:
    """обновляет expired при необходимости и добавляет days_left."""
    status = sub.get("status") or "Active"
    exp = parse_iso(sub.get("expires_at"))
    if exp and exp < utcnow() and status == "Active":
        db.execute("UPDATE subscriptions SET status = 'Expired' WHERE id = ?", (sub["id"],))
        status = "Expired"
        sub = {**sub, "status": status}
    sub = {**sub, "days_left": days_left_for_expiry(sub.get("expires_at")), "status": status}
    return sub


def serialize_key(sub: dict[str, Any], user: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    sub = refresh_subscription_row(sub)
    if user is None and sub.get("user_id"):
        user = get_user(int(sub["user_id"]))
    username = None
    if user:
        username = _user_label(user)
    return {
        "id": sub["id"],
        "key_uuid": sub.get("key_uuid"),
        "short_uuid": sub.get("short_uuid"),
        "key_config": sub.get("key_config"),
        "user_id": sub["user_id"],
        "username": username,
        "status": sub.get("status", "Active"),
        "expiry_date": sub.get("expires_at"),
        "days_left": sub.get("days_left"),
        "traffic_used": sub.get("traffic_used", 0),
        "traffic_limit": sub.get("traffic_limit", 0),
        "devices_used": sub.get("devices_used", 0),
        "devices_limit": sub.get("devices_limit", 1),
        "type": sub.get("type", "vpn"),
        "no_renew": bool(sub.get("no_renew")),
        "custom_name": sub.get("custom_name"),
        "rw_id": sub.get("rw_id"),
        "created_at": sub.get("created_at"),
        "ban_reason": sub.get("ban_reason") if sub.get("status") == "Banned" else None,
        "banned_at": sub.get("banned_at") if sub.get("status") == "Banned" else None,
    }


def _aa_warning(user_id: int) -> Optional[dict[str, Any]]:
    """действующее предупреждение анти-абуза."""
    row = db.fetchone("SELECT id, aa_warned_at FROM subscriptions WHERE user_id = ? AND status = 'Active' "
                      "AND aa_warned_at IS NOT NULL ORDER BY aa_warned_at DESC LIMIT 1", (int(user_id),))
    if not row:
        return None
    at = parse_iso(row.get("aa_warned_at"))
    lim = antiabuse.limits()
    if not at or utcnow() - at > timedelta(days=lim["warn_days"]):
        return None
    ev = db.fetchone("SELECT reason FROM moderation_events WHERE user_id = ? AND kind = 'aa_warn' AND sub_id = ? "
                     "ORDER BY id DESC LIMIT 1", (int(user_id), row["id"]))
    return {"sub_id": row["id"], "at": row.get("aa_warned_at"), "reason": (ev or {}).get("reason"),
            "grace_until": iso(at + timedelta(hours=lim["grace_hours"])),
            "valid_until": iso(at + timedelta(days=lim["warn_days"]))}


def sync_user_status_from_subs(user_id: int) -> None:
    fulfillment._sync_user_status(user_id)


def user_states_map() -> dict[int, str]:
    """состояние всех юзеров одним запросом."""
    now_iso = iso()
    rows = db.fetchall(
        """
        SELECT u.id AS id, u.is_banned AS banned, s.total AS total, s.paid_now AS paid_now, s.trial_now AS trial_now
        FROM users u LEFT JOIN (
            SELECT user_id, COUNT(*) AS total,
                   MAX(CASE WHEN status = 'Active' AND type != 'trial'
                             AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS paid_now,
                   MAX(CASE WHEN status = 'Active' AND type = 'trial'
                             AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS trial_now
            FROM subscriptions GROUP BY user_id
        ) s ON s.user_id = u.id
        """,
        (now_iso, now_iso),
    )
    out: dict[int, str] = {}
    for r in rows:
        if r.get("banned"):
            st = "Banned"
        elif not r.get("total"):
            st = "None"
        elif r.get("paid_now"):
            st = "Active"
        elif r.get("trial_now"):
            st = "Trial"
        else:
            st = "Expired"
        out[int(r["id"])] = st
    return out


def create_key(
    user_id: int,
    days: int = 30,
    traffic: int = 0,
    devices: int = 1,
    is_trial: bool = False,
    is_forever: bool = False,
    squads: Optional[list[str]] = None,
    custom_name: Optional[str] = None,
) -> dict[str, Any]:
    key_uuid = str(uuid.uuid4())
    short = key_uuid.split("-")[0]
    rw_id = str(uuid.uuid4())
    expiry = None if is_forever else iso(utcnow() + timedelta(days=max(1, days)))
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO subscriptions (user_id, rw_id, key_uuid, short_uuid, key_config, status, expires_at, "
        "devices_limit, devices_used, traffic_used, traffic_limit, custom_name, type, squads_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, 0, 0, ?, ?, ?, ?, ?)",
        (
            user_id,
            rw_id,
            key_uuid,
            short,
            "",  # конфиг из remnawave, не из vless-плейсхолдера
            expiry,
            int(devices or 1),
            int(traffic or 0),
            custom_name,
            "trial" if is_trial else "vpn",
            db.dumps(squads or []),
            now,
        ),
    )
    sub = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (db.last_id(),))
    assert sub is not None
    sync_user_status_from_subs(user_id)
    return sub


def add_transaction(
    user_id: int,
    amount: float,
    status: str = "completed",
    payment_method: str = "manual",
    payment_id: Optional[str] = None,
    description: Optional[str] = None,
) -> dict[str, Any]:
    pid = payment_id or secrets.token_hex(8)
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO transactions (user_id, amount, status, payment_method, hash, payment_id, description, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, float(amount), status, payment_method, pid, pid, description, now),
    )
    return serialize_transaction(db.fetchone("SELECT * FROM transactions WHERE id = ?", (db.last_id(),)))


def serialize_transaction(tx: Optional[dict[str, Any]]) -> dict[str, Any]:
    if not tx:
        return {}
    username = None
    if tx.get("user_id"):
        user = get_user(int(tx["user_id"]))
        if user:
            username = user.get("username") or str(user.get("telegram_id"))
    return {
        "id": tx["id"],
        "user_id": tx.get("user_id"),
        "user": username,
        "amount": tx.get("amount", 0),
        "status": tx.get("status"),
        "payment_method": tx.get("payment_method"),
        "created_at": tx.get("created_at"),
        "hash": tx.get("hash"),
        "payment_id": tx.get("payment_id"),
        "description": tx.get("description"),
    }


def _grant_fresh_subscription(user_id: int, days: int) -> None:
    """новая подписка из панели: remnawave (если есть tg) и бд."""
    user = get_user(user_id)
    if user and (user.get("telegram_id") or user.get("email")):
        new_exp = utcnow() + timedelta(days=days)
        prov = provisioning.provision(
            user_id=int(user["id"]), telegram_id=int(user["telegram_id"]) if user.get("telegram_id") else None,
            username=user.get("username"), expire_at=new_exp,
            devices=1, squads=fulfillment.vpn_squads(), email=user.get("email"),
            traffic_limit_bytes=fulfillment.paid_traffic_gb() * fulfillment.GB,
            traffic_reset_strategy=fulfillment.RESET_STRATEGY,
        )
        fulfillment._create_subscription_row(
            user=user, devices=1, expire_at=new_exp, provision=prov,
            traffic_gb=fulfillment.paid_traffic_gb(), sub_type="vpn",
        )
        return
    create_key(user_id, days=days)


def extend_user_sub(user_id: int, days: int, subscription_id: Optional[int] = None) -> None:
    if subscription_id:
        subs = db.fetchall(
            "SELECT * FROM subscriptions WHERE user_id = ? AND id = ?",
            (user_id, subscription_id),
        )
    else:
        subs = db.fetchall("SELECT * FROM subscriptions WHERE user_id = ? AND status != 'Deleted'", (user_id,))
    # удалённая подписка не оживает, выдаём новую
    subs = [x for x in subs if x.get("status") != "Deleted"]

    if not subs:
        if days > 0:
            _grant_fresh_subscription(user_id, days)
        return

    for sub in subs:
        base = parse_iso(sub.get("expires_at")) or utcnow()
        if base < utcnow():
            base = utcnow()
        new_exp = base + timedelta(days=days)
        status = "Active" if new_exp > utcnow() else "Expired"
        db.execute(
            "UPDATE subscriptions SET expires_at = ?, status = ? WHERE id = ?",
            (iso(new_exp), status, sub["id"]),
        )
    sync_user_status_from_subs(user_id)


GB = 1024 ** 3  # трафик в бд в гб, в remnawave в байтах


def _rw_client():
    """клиент remnawave или none."""
    try:
        import remnawave  # type: ignore
        if not provisioning.is_configured():
            return None
        return remnawave.get_client()
    except Exception:  # noqa: BLE001
        return None


def _rw_find_user(user: dict[str, Any]):
    """(client, rw_user|none): сначала telegram_id, потом email."""
    client = _rw_client()
    if not client:
        return None, None
    rw = None
    try:
        if user.get("telegram_id"):
            rw = client.find_user_by_telegram(int(user["telegram_id"]))
    except Exception:  # noqa: BLE001
        rw = None
    if not rw and user.get("email"):
        try:
            rw = unwrap_rw(client.resolve_user(email=user["email"]))
        except Exception:  # noqa: BLE001
            rw = None
    if not rw and not user.get("telegram_id"):
        try:
            rw = unwrap_rw(client.resolve_user(username=f"web_{int(user['id'])}"))
        except Exception:  # noqa: BLE001
            rw = None
    if not isinstance(rw, dict) or not (rw.get("uuid") or rw.get("id")):
        rw = None
    return client, rw


def unwrap_rw(data: Any) -> Any:
    if isinstance(data, dict) and "response" in data:
        return data["response"]
    return data


def _rw_uid(rw: dict[str, Any]) -> Optional[str]:
    val = rw.get("uuid") or rw.get("id") or rw.get("userId")
    return str(val) if val is not None else None


def _rw_num_id(rw: dict[str, Any]) -> Optional[int]:
    """числовой id юзера remnawave (ручки 3.x не принимают uuid)."""
    if not isinstance(rw, dict):
        return None
    val = rw.get("id")
    if val is None:
        val = rw.get("userId")
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _rw_sync_expiry(user: dict[str, Any]) -> None:
    """пушим дату окончания основной подписки в remnawave."""
    client, rw = _rw_find_user(user)
    if not client or not rw:
        return
    row = db.fetchone(
        "SELECT expires_at FROM subscriptions WHERE user_id = ? AND status != 'Deleted' AND type != 'trial' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user["id"],),
    ) or db.fetchone(
        "SELECT expires_at FROM subscriptions WHERE user_id = ? AND status != 'Deleted' ORDER BY id DESC LIMIT 1",
        (user["id"],),
    )
    if not row or not row.get("expires_at"):
        return
    exp = parse_iso(row["expires_at"])
    if not exp:
        return
    try:
        client.update_user(id=_rw_num_id(rw), expire_at=exp, status="ACTIVE")
    except Exception:  # noqa: BLE001
        pass
    # ручное продление во время grace: вернуть сквады и трафик
    try:
        grace.end_for_user(int(user["id"]))
    except Exception:  # noqa: BLE001
        pass


def _rw_sync_traffic(user: dict[str, Any], gb: int) -> None:
    """лимит трафика в remnawave (гб->байты, 0=безлимит)."""
    # grace по трафику снимаем; grace по сроку лимит не трогаем
    grace.end_for_user(int(user["id"]), traffic=True)
    if grace.active_for_user(int(user["id"])):
        return
    client, rw = _rw_find_user(user)
    if not client or not rw:
        return
    try:
        client.update_user(id=_rw_num_id(rw), traffic_limit_bytes=int(max(0, gb)) * GB)
    except Exception:  # noqa: BLE001
        pass


def _rw_sync_devices(user: dict[str, Any], devices: int) -> None:
    """лимит устройств (hwid) в remnawave."""
    client, rw = _rw_find_user(user)
    if not client or not rw:
        return
    try:
        client.update_user(id=_rw_num_id(rw), hwid_device_limit=int(max(1, devices)))
    except Exception:  # noqa: BLE001
        pass


def _rw_set_enabled(user: dict[str, Any], enabled: bool) -> None:
    """включить/выключить юзера в remnawave."""
    client, rw = _rw_find_user(user)
    if not client or not rw:
        return
    try:
        if enabled:
            client.enable_user(_rw_num_id(rw))
        else:
            client.disable_user(_rw_num_id(rw))
    except Exception:  # noqa: BLE001
        pass


def _notify_user(user: dict[str, Any], text: str, *, email: bool = False) -> dict[str, Any]:
    """уведомление в бота; на почту только если email=true."""
    result = {"telegram": False, "email": False}
    if not text:
        return result
    if telegram_stars is not None and user.get("telegram_id"):
        try:
            # текст из панели экранируем под html
            telegram_stars.TelegramStars().send_message(int(user["telegram_id"]), _esc_html(text))
            result["telegram"] = True
        except Exception:  # noqa: BLE001
            pass
    if email and user.get("email") and mailer.is_configured():
        ok, _ = mailer.send_broadcast(user["email"], "BlinVPN", _esc_html(text).replace("\n", "<br>"), body_text=text)
        result["email"] = ok
    return result


def _mail_async(fn, *args, **kwargs) -> None:
    """служебное письмо в фоне, не блокируя ответ."""
    if not mailer.is_configured():
        return

    def _run() -> None:
        try:
            ok, err = fn(*args, **kwargs)
            if not ok:
                print(f"[email] {getattr(fn, '__name__', 'mail')}: {err}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[email] {getattr(fn, '__name__', 'mail')}: {exc}", flush=True)

    threading.Thread(target=_run, daemon=True).start()


def _email_changed(old: Optional[str], new: Optional[str]) -> None:
    """письма о привязке/смене/отвязке почты."""
    old = (old or "").strip().lower() or None
    new = (new or "").strip().lower() or None
    if old == new:
        return
    if new:
        _mail_async(mailer.send_email_bound, new)
    if old:
        _mail_async(mailer.send_email_unbound, old, new)


def _device_from_ua(ua: str) -> str:
    """короткое имя устройства по user-agent."""
    ua = ua or ""
    os_name = next((n for k, n in (
        ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
        ("Mac OS X", "macOS"), ("Macintosh", "macOS"), ("Linux", "Linux"),
    ) if k in ua), "")
    br = next((n for k, n in (
        ("YaBrowser", "Яндекс Браузер"), ("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
        ("Chrome/", "Chrome"), ("Safari/", "Safari"),
    ) if k in ua), "")
    return ", ".join(x for x in (br, os_name) if x)


def _notify_login(user: dict[str, Any], method: str, request: Optional[Request]) -> None:
    """письмо о входе на сайт (мини-приложение не считается)."""
    email = (user.get("email") or "").strip()
    if not email:
        return
    ua = ""
    try:
        ua = (request.headers.get("user-agent") or "") if request is not None else ""
    except Exception:  # noqa: BLE001
        ua = ""
    when = _msk_datetime(datetime.now(timezone.utc))
    _mail_async(mailer.send_login_notice, email, when, method, _client_ip(request), _device_from_ua(ua))


def _msk_datetime(dt: datetime) -> str:
    return (dt + timedelta(hours=3)).strftime("%d.%m.%Y %H:%M")


def _esc_html(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_SAFE_TG_URL = re.compile(r"^(https?://|mailto:|tg://)", re.I)
_MD_LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
_MD_CODE = re.compile(r"`([^`\n]+)`")
_MD_BOLD = re.compile(r"\*\*([^*\n]+?)\*\*")
_MD_BOLD2 = re.compile(r"(?<![\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])")
_MD_ITALIC = re.compile(r"(?<![\w_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\w_])")
_MD_UNDER = re.compile(r"__([^_\n]+?)__")
_MD_STRIKE = re.compile(r"~~([^~\n]+?)~~")
_HTML_A = re.compile(r'<a\s+href\s*=\s*(?:"([^"]*)"|\'([^\']*)\')[^>]*>([\s\S]*?)</a\s*>', re.I)
_HTML_TAG = re.compile(
    r"<(b|strong|i|em|u|s|del|strike|code)\s*>([\s\S]*?)</\1\s*>|"
    r"<(br|hr)\s*/?>",
    re.I,
)


def _md_html_to_tg(text: str, limit: int = 700) -> str:
    """markdown/html поддержки → безопасный HTML Telegram (b/i/u/s/code/a)."""
    s = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not s.strip():
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<p\s*>", "", s, flags=re.I)
    s = re.sub(r"</?(?:ul|ol)\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<li\s*>", "• ", s, flags=re.I)
    s = re.sub(r"</li\s*>", "\n", s, flags=re.I)
    s = re.sub(r"</?blockquote\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<h([1-3])\s*>([\s\S]*?)</h\1\s*>", lambda m: f"\n<b>{m.group(2).strip()}</b>\n", s, flags=re.I)
    s = re.sub(r"<hr\s*/?>", "\n—\n", s, flags=re.I)

    held: list[str] = []

    def hold(html: str) -> str:
        held.append(html)
        return f"\x00{len(held) - 1}\x00"

    def wrap_inner(tag: str, inner: str) -> str:
        return hold(f"<{tag}>{_md_html_to_tg_inline(inner, held)}</{tag}>")

    # html-ссылки и теги (до экранирования)
    def repl_a(m: re.Match) -> str:
        href = (m.group(1) or m.group(2) or "").strip()
        if not _SAFE_TG_URL.match(href):
            return m.group(3)
        return hold(f'<a href="{_esc_html(href)}">{_md_html_to_tg_inline(m.group(3), held)}</a>')

    s = _HTML_A.sub(repl_a, s)

    def repl_tag(m: re.Match) -> str:
        if m.group(3):  # br|hr
            return "\n" if m.group(3).lower() == "br" else "\n—\n"
        tag = m.group(1).lower()
        tg = {"b": "b", "strong": "b", "i": "i", "em": "i", "u": "u",
              "s": "s", "del": "s", "strike": "s", "code": "code"}.get(tag, "b")
        return wrap_inner(tg, m.group(2))

    s = _HTML_TAG.sub(repl_tag, s)

    # markdown
    s = _MD_LINK.sub(
        lambda m: hold(f'<a href="{_esc_html(m.group(2))}">{_esc_html(m.group(1))}</a>')
        if _SAFE_TG_URL.match(m.group(2).strip()) else _esc_html(m.group(1)), s)
    s = _MD_CODE.sub(lambda m: hold(f"<code>{_esc_html(m.group(1))}</code>"), s)
    s = _MD_BOLD.sub(lambda m: wrap_inner("b", m.group(1)), s)
    s = _MD_UNDER.sub(lambda m: wrap_inner("u", m.group(1)), s)
    s = _MD_STRIKE.sub(lambda m: wrap_inner("s", m.group(1)), s)
    s = _MD_BOLD2.sub(lambda m: wrap_inner("b", m.group(1)), s)
    s = _MD_ITALIC.sub(lambda m: wrap_inner("i", m.group(1)), s)

    # экранировать остаток, вернуть плейсхолдеры
    parts: list[str] = []
    i = 0
    while i < len(s):
        if s[i] == "\x00":
            j = s.find("\x00", i + 1)
            if j > i:
                try:
                    parts.append(held[int(s[i + 1:j])])
                except (ValueError, IndexError):
                    parts.append(_esc_html(s[i:j + 1]))
                i = j + 1
                continue
        # обычный текст до следующего плейсхолдера
        j = s.find("\x00", i)
        chunk = s[i:] if j < 0 else s[i:j]
        parts.append(_esc_html(chunk))
        i = len(s) if j < 0 else j

    out = "".join(parts)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    if len(out) > limit:
        # обрезать по символам, не разрывая тег посередине
        cut = out[:limit]
        if cut.count("<") != cut.count(">"):
            cut = cut.rsplit("<", 1)[0]
        out = cut.rstrip() + "…"
    return out


def _md_html_to_tg_inline(inner: str, held: list[str]) -> str:
    """экранировать внутренность уже выбранного тега (без повторного разбора md)."""
    # внутри тега плейсхолдеров быть не должно — просто escape
    return _esc_html(re.sub(r"<[^>]+>", "", inner or ""))


def trial_enabled() -> bool:
    return db.get_setting("trial_enabled", "1") in ("1", "true", "True", "yes")


MAX_PLAN_DEVICES = 20


def _float_setting(key: str, default: float) -> float:
    try:
        return float(db.get_setting(key, str(default)) or default)
    except (TypeError, ValueError):
        return float(default)


def get_plans_meta() -> dict[str, Any]:
    return {
        # цена = base + extra * (devices - 1)
        "base_price": _float_setting("base_price", 99),
        "extra_device_price": _float_setting("extra_device_price", 40),
        "trial_enabled": trial_enabled(),
        "trial_days": fulfillment.trial_days(),
        "trial_traffic_gb": fulfillment.trial_traffic_gb(),
        "trial_devices": fulfillment.trial_devices(),
        "paid_traffic_gb": fulfillment.paid_traffic_gb(),
        "traffic_reset_price": _float_setting("traffic_reset_price", 0),
        "antiabuse_enabled": db.get_setting("antiabuse_enabled", "1") in ("1", "true", "True", "yes"),
        "antiabuse": antiabuse.limits(),
        "trial_hwid_enabled": db.get_setting("trial_hwid_enabled", "1") in ("1", "true", "True", "yes"),
        "trial_hwid_max": fulfillment._int_setting("trial_hwid_max", 2, 1, 10),
    }


def price_for_devices(devices: int) -> float:
    meta = get_plans_meta()
    n = max(1, int(devices))
    return round(float(meta["base_price"]) + float(meta["extra_device_price"]) * (n - 1), 2)


def get_active_plans() -> list[dict[str, Any]]:
    """цены для 1..20 устройств из base + extra."""
    out = []
    for n in range(1, MAX_PLAN_DEVICES + 1):
        price = price_for_devices(n)
        out.append({"devices": n, "price_rub": price, "price_stars": float(round(price))})
    return out


def plan_price_map() -> dict[int, float]:
    return {int(p["devices"]): float(p["price_rub"]) for p in get_active_plans()}


def plan_stars_map() -> dict[int, float]:
    return {int(p["devices"]): float(p["price_stars"]) for p in get_active_plans()}


def min_plan_price() -> Optional[float]:
    return price_for_devices(1)


def _backup_dir() -> str:
    d = os.path.join(os.path.dirname(os.path.abspath(db.get_db_path())), "backups")
    os.makedirs(d, exist_ok=True)
    return d


BACKUPS_KEEP = 10  # и на диске, и в s3


def _s3_backups() -> list[dict[str, Any]]:
    """бэкапы в s3, новые первыми."""
    items = db.loads(db.get_setting("s3_backups", "[]"), []) or []
    return [x for x in items if isinstance(x, dict) and x.get("key") and x.get("name")]


def list_backups() -> list[dict[str, Any]]:
    d = _backup_dir()
    out: list[dict[str, Any]] = []
    for name in sorted(os.listdir(d), reverse=True):
        if not name.endswith(".db"):
            continue
        path = os.path.join(d, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({
            "name": name,
            "size": st.st_size,
            "created_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            "s3": False,
        })
    local = {x["name"] for x in out}
    for x in _s3_backups():
        if x["name"] in local:
            for y in out:
                if y["name"] == x["name"]:
                    y["s3"] = True
        else:
            out.append({"name": x["name"], "size": x.get("size") or 0, "created_at": x.get("created_at"), "s3": True, "only_s3": True})
    out.sort(key=lambda x: x["name"], reverse=True)
    return out


# таблицы вне бэкапа (сессии/коды/временное)
_BACKUP_SCRUB_TABLES = ("app_sessions", "panel_sessions", "temp_2fa", "email_codes", "rate_limits",
                        # history мониторинга объёмная, ноды/инциденты оставляем
                        "mon_metrics", "mon_pings", "mon_speed", "mon_vless")


def create_backup() -> dict[str, Any]:
    """онлайн-копия sqlite (wal). возвращает сведения о файле."""
    import sqlite3

    ts = utcnow().strftime("%Y%m%d-%H%M%S")
    name = f"backup-{ts}.db"
    path = os.path.join(_backup_dir(), name)
    src = sqlite3.connect(db.get_db_path())
    try:
        dst = sqlite3.connect(path)
        try:
            src.backup(dst)
            # из копии убираем сессии, коды входа/2fa, счётчики
            for table in _BACKUP_SCRUB_TABLES:
                try:
                    dst.execute(f"DELETE FROM {table}")
                except sqlite3.Error:
                    pass
            dst.commit()
            dst.execute("VACUUM")
        finally:
            dst.close()
    finally:
        src.close()
    try:
        os.chmod(path, 0o640)
    except OSError:
        pass
    last = db.utcnow_iso()
    db.set_setting("backup_last", last)
    # на диске последние BACKUPS_KEEP копий
    local = sorted((n for n in os.listdir(_backup_dir()) if n.endswith(".db")), reverse=True)
    for old in local[BACKUPS_KEEP:]:
        try:
            os.remove(os.path.join(_backup_dir(), old))
        except OSError:
            pass
    st = os.stat(path)
    _backup_to_s3(path, name)
    # в telegram сжатую копию (лимит бота 50 мб)
    try:
        import gzip
        import shutil
        gz_path = path + ".gz"
        with open(path, "rb") as f_in, gzip.open(gz_path, "wb", compresslevel=9) as f_out:
            shutil.copyfileobj(f_in, f_out)
        gz_size = os.path.getsize(gz_path)
        try:
            if gz_size < 49 * 1024 * 1024:
                forum.send_document("backups", gz_path,
                                    caption=f"🗄 Бэкап БД · {name}.gz · {gz_size // 1024} КБ")
            else:
                forum.send("backups", f"🗄 Бэкап <b>{forum._esc(name)}</b> создан на сервере, но слишком "
                                      f"большой для Telegram ({gz_size // (1024 * 1024)} МБ сжатым). "
                                      "Скачайте его из панели → Настройки → Резервные копии.")
        finally:
            os.remove(gz_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[backup] не удалось отправить в Telegram: {exc}", flush=True)
    return {"name": name, "size": st.st_size, "created_at": last, "last_backup": last}


def _backup_to_s3(path: str, name: str) -> None:
    """если есть s3: кладём сжатую копию, держим BACKUPS_KEEP."""
    try:
        if not s3store.enabled():
            return
        import gzip
        import hashlib
        import shutil
        cfg = s3store.get_config()
        gz = path + ".s3.gz"
        with open(path, "rb") as f_in, gzip.open(gz, "wb", compresslevel=9) as f_out:
            shutil.copyfileobj(f_in, f_out)
        try:
            h = hashlib.sha256()
            with open(gz, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
            key = f"{cfg['prefix']}backups/{name}.gz"
            s3store.put_file(key, gz, h.hexdigest(), "application/gzip", f'attachment; filename="{name}.gz"')
            size = os.path.getsize(gz)
        finally:
            os.remove(gz)
        items = [x for x in _s3_backups() if x["name"] != name]
        items.insert(0, {"key": key, "name": name, "size": size, "created_at": db.utcnow_iso()})
        for old in items[BACKUPS_KEEP:]:
            try:
                s3store.delete(old["key"])
            except Exception as exc:  # noqa: BLE001
                print(f"[backup] S3: не удалось удалить {old['key']}: {exc}", flush=True)
        db.set_setting("s3_backups", db.dumps(items[:BACKUPS_KEEP]))
    except Exception as exc:  # noqa: BLE001
        print(f"[backup] S3: не удалось загрузить: {exc}", flush=True)
        try:
            forum.report_error("Бэкап не загрузился в S3", f"{type(exc).__name__}: {exc}")
        except Exception:  # noqa: BLE001
            pass


def get_backup_settings() -> dict[str, Any]:
    last = db.get_setting("backup_last", "") or None
    return {
        "enabled": db.get_setting("backup_enabled", "0") in ("1", "true", "True"),
        "interval_hours": int(float(db.get_setting("backup_interval_hours", "12") or 12)),
        "last_backup": last or None,
        "backups": list_backups(),
    }


def get_squad_mapping() -> dict[str, list[str]]:
    return {
        "vpn": db.loads(db.get_setting("squad_mapping_vpn", "[]"), []) or [],
        "trial": db.loads(db.get_setting("squad_mapping_trial", "[]"), []) or [],
    }


def set_squad_mapping(vpn: list[str], trial: list[str]) -> None:
    db.set_setting("squad_mapping_vpn", db.dumps(list(vpn)))
    db.set_setting("squad_mapping_trial", db.dumps(list(trial)))


def serialize_promocode(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": p["id"],
        "code": p["code"],
        "name": p.get("name"),
        "type": "discount",  # единственный тип: скидка
        "value": p["value"],  # процент скидки
        "uses_limit": p.get("uses_limit"),
        "uses_count": p.get("uses_count", 0),
        "expires_at": p.get("expires_at"),  # срок, до которого промокод можно активировать
        "is_active": bool(p.get("is_active")),
        "created_at": p.get("created_at"),
    }


PROMO_DISCOUNT_DAYS = 90


def active_global_discount() -> Optional[dict[str, Any]]:
    """активная глобальная скидка или none."""
    now_iso = db.utcnow_iso()
    row = db.fetchone(
        "SELECT name, value, expires_at FROM promotions "
        "WHERE type = 'global_discount' AND is_active = 1 AND value > 0 "
        "AND (expires_at IS NULL OR expires_at > ?) "
        "ORDER BY value DESC LIMIT 1",
        (now_iso,),
    )
    if not row:
        return None
    return {
        "percent": float(row["value"] or 0),
        "expires_at": row.get("expires_at"),
        "code": None,
        "name": row.get("name"),
        "promocode_id": None,
        "is_global": True,
    }


def active_discount_for_user(user_id: int) -> Optional[dict[str, Any]]:
    """лучшая неистёкшая скидка юзера (промо или акция)."""
    now_iso = db.utcnow_iso()
    row = db.fetchone(
        "SELECT a.discount_percent AS percent, a.expires_at AS expires_at, p.code AS code, "
        "p.name AS name, p.id AS promocode_id "
        "FROM promocode_activations a JOIN promocodes p ON p.id = a.promocode_id "
        "WHERE a.user_id = ? AND a.discount_percent > 0 "
        "AND (a.expires_at IS NULL OR a.expires_at > ?) "
        "ORDER BY a.discount_percent DESC, a.expires_at DESC LIMIT 1",
        (user_id, now_iso),
    )
    personal = None
    if row:
        personal = {
            "percent": float(row["percent"] or 0),
            "expires_at": row.get("expires_at"),
            "code": row.get("code"),
            "name": row.get("name"),
            "promocode_id": row.get("promocode_id"),
        }
    global_disc = active_global_discount()

    candidates = [d for d in (personal, global_disc) if d and d["percent"] > 0]
    if not candidates:
        return None
    return max(candidates, key=lambda d: d["percent"])


def discounted(amount: float, percent: float) -> float:
    """цена со скидкой, вниз до целого, не ниже 1."""
    if percent <= 0:
        return float(amount)
    result = float(amount) * (1.0 - percent / 100.0)
    return float(max(1, round(result)))


# потолок суммарной скидки
MAX_TOTAL_DISCOUNT = 90.0


def survey_bonus_percent(user_id: int) -> float:
    """скидка за опрос (0 если не пройден)."""
    try:
        return float(survey.reward_percent(int(user_id)))
    except Exception:  # noqa: BLE001
        return 0.0


def effective_discount(user_id: int) -> dict[str, Any]:
    """итоговая скидка: лучший промо/акция + бонус опроса."""
    base_disc = active_discount_for_user(user_id)
    base = float((base_disc or {}).get("percent") or 0)
    bonus = survey_bonus_percent(user_id)
    total = min(MAX_TOTAL_DISCOUNT, base + bonus)
    out: dict[str, Any] = {
        "active": total > 0,
        "percent": total,
        "base": base,
        "survey": bonus,
    }
    if base_disc:
        out["code"] = base_disc.get("code")
        out["name"] = base_disc.get("name")
        out["expires_at"] = base_disc.get("expires_at")
    return out


def apply_promo_to_user(user_id: int, code: str, *, by_admin: bool = False) -> dict[str, Any]:
    """активирует промокод-скидку на 90 дней (один раз на юзера)."""
    try:
        return services.activate_promocode(user_id, code)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})


def remove_user_promo(user_id: int, code: Optional[str] = None) -> int:
    """снимает скидку у юзера (админ); code=только этот промо."""
    if code:
        promo = db.fetchone("SELECT id FROM promocodes WHERE code = ?", (code.upper().strip(),))
        if not promo:
            return 0
        cur = db.execute(
            "DELETE FROM promocode_activations WHERE user_id = ? AND promocode_id = ?",
            (user_id, promo["id"]),
        )
    else:
        cur = db.execute("DELETE FROM promocode_activations WHERE user_id = ?", (user_id,))
    return cur.rowcount if hasattr(cur, "rowcount") else 0


def serialize_promotion(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": p["id"],
        "name": p["name"],
        "type": p["type"],
        "value": p["value"],
        "min_amount": p.get("min_amount"),
        "max_amount": p.get("max_amount"),
        "uses_limit": p.get("uses_limit"),
        "uses_count": p.get("uses_count", 0),
        "expires_at": p.get("expires_at"),
        "is_active": bool(p.get("is_active")),
        "created_at": p.get("created_at"),
    }


def serialize_mailing(m: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": m["id"],
        "title": m.get("title"),
        "date": m.get("created_at"),
        "created_at": m.get("created_at"),
        "status": m.get("status"),
        "sent_count": m.get("sent_count", 0),
        "message_text": m.get("message_text"),
        "target_users": m.get("target_users"),
        "button_type": m.get("button_type"),
        "button_value": m.get("button_value"),
        "image_url": m.get("image_url"),
        "channel": m.get("channel") or "telegram",
    }


def serialize_tracking(link: dict[str, Any], include_users: bool = False) -> dict[str, Any]:
    out = {
        "id": link["id"],
        "name": link["name"],
        "code": link["code"],
        "promocode": link.get("promocode"),
        "welcome_message": link.get("welcome_message"),
        "url": link.get("url") or _tracking_url(link["code"]),
        "clicks": link.get("clicks", 0),
        "is_active": bool(link.get("is_active")),
        "created_at": link.get("created_at"),
        "unique_users": link.get("unique_users", 0),
        "new_users": link.get("new_users", 0),
        "total_revenue": link.get("total_revenue", 0),
        "paid_users": link.get("paid_users", 0),
        "active_subscriptions": link.get("active_subscriptions", 0),
        "total_keys": link.get("total_keys", 0),
        "conversion_rate": link.get("conversion_rate", 0),
    }
    if include_users:
        users = db.fetchall(
            "SELECT * FROM tracking_link_users WHERE link_id = ? ORDER BY id DESC",
            (link["id"],),
        )
        out["users"] = users
    return out


def serialize_squad(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s.get("priority", 0),
        "squad_uuid": s["squad_uuid"],
        "squad_name": s["squad_name"],
        "squad_type": s.get("squad_type", "vpn"),
        "max_users": s.get("max_users", 0),
        "current_users": s.get("current_users", 0),
        "inbounds_count": s.get("inbounds_count", 0),
        "is_active": bool(s.get("is_active")),
        "priority": s.get("priority", 0),
    }


OWNER_NAME = "Администратор"


def _owner_principal(username: str) -> dict[str, Any]:
    return {"kind": "owner", "role": "owner", "actor": "owner", "staff_id": None, "username": username, "name": OWNER_NAME}


def _staff_principal(st: dict[str, Any]) -> dict[str, Any]:
    return {"kind": "staff", "role": staffmod.role_of(st), "actor": f"staff:{int(st['id'])}", "staff_id": int(st["id"]),
            "username": st["username"], "name": staffmod.display_name(st)}


def is_full(p: dict[str, Any]) -> bool:
    """полный доступ к поддержке: владелец и кураторы."""
    return p.get("role") in ("owner", "curator")


def _staff_has_ticket_with(actor: str, user_id: int) -> bool:
    """сотрудник сейчас ведёт обращение этого юзера."""
    return bool(db.fetchone(
        "SELECT 1 FROM support_chats c JOIN support_tickets t ON t.id = c.open_ticket_id "
        "WHERE c.user_id = ? AND t.status = 'open' AND t.assigned_admin = ? LIMIT 1", (int(user_id), actor)))


def can_manage_user(p: dict[str, Any], user_id: int) -> bool:
    if is_full(p):
        return True
    return 0 < int(user_id) < 10 ** 18 and _staff_has_ticket_with(p["actor"], int(user_id))


def _authorize_staff(p: dict[str, Any], method: str, path: str) -> None:
    """путь открыт сотруднику только через staff.ROUTES + роль."""
    deny = HTTPException(403, detail={"message": "Недостаточно прав"})
    if not path.startswith("/api/panel/"):
        raise deny
    hit = staffmod.match_route(method, path[len("/api/panel"):])
    if hit is None:
        raise deny
    rule, groups = hit
    if rule == "any":
        return
    if rule == "curator" and p["role"] == "curator":
        return
    if rule == "manage":
        uid = groups.get("uid") or ""
        if uid and len(uid) <= 18 and can_manage_user(p, int(uid)):
            return
    raise deny


def require_panel(request: Request, authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """сессия панели -> кто это + права на запрос."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    session = get_panel_session(token)
    if not session:
        raise HTTPException(401, detail="Unauthorized")
    sid = session.get("staff_id")
    if sid is None:
        admin = get_admin()
        if not admin or not hmac.compare_digest(str(session.get("username") or "").encode(), str(admin["username"]).encode()):
            delete_panel_session(token)
            raise HTTPException(401, detail="Unauthorized")
        p = _owner_principal(admin["username"])
    else:
        st = staffmod.get(int(sid))
        if not st or not st.get("is_active"):
            delete_panel_session(token)
            raise HTTPException(401, detail="Unauthorized")
        p = _staff_principal(st)
    try:
        request.state.panel_actor = p["actor"]
        request.state.panel_actor_name = p["name"]
    except Exception:  # noqa: BLE001
        pass
    if p["kind"] != "owner":
        _authorize_staff(p, request.method, request.scope.get("path") or "")
    return p


def require_owner(p: dict[str, Any] = Depends(require_panel)) -> dict[str, Any]:
    """только владелец панели."""
    if p.get("kind") != "owner":
        raise HTTPException(403, detail={"message": "Недостаточно прав"})
    return p


def audit(actor: str, name: Optional[str], action: str, status: Optional[int] = None, ip: str = "") -> None:
    try:
        db.execute("INSERT INTO panel_audit (ts, actor, actor_name, action, status, ip) VALUES (?, ?, ?, ?, ?, ?)",
                   (iso(), actor, (name or "")[:60], action[:200], status, (ip or "")[:64]))
    except Exception:  # noqa: BLE001
        pass


def _setup_token_ok(setup_token: Optional[str], header_token: Optional[str]) -> bool:
    if not PANEL_SETUP_TOKEN:
        return ENV != "production"
    candidate = (setup_token or header_token or "").strip()
    return bool(candidate) and hmac.compare_digest(candidate, PANEL_SETUP_TOKEN)


class LoginBody(BaseModel):
    username: str
    password: str


class VerifyCodeBody(BaseModel):
    temp_token: str
    code: str


class UserActionBody(BaseModel):
    action: str
    value: Any = None
    notify: bool = False
    subscription_id: Optional[int] = None
    confirm: bool = False  # подтверждено объединение аккаунтов


class MassActionBody(BaseModel):
    action: str
    value: Any = None
    notify: bool = False


class CreateKeyBody(BaseModel):
    user_id: int
    days: int = 30
    traffic: int = 0
    devices: int = 1
    is_trial: bool = False
    is_forever: bool = False
    squads: list[str] = Field(default_factory=list)
    custom_name: Optional[str] = None


class BlockKeyBody(BaseModel):
    blocked: bool


class MailingBody(BaseModel):
    message: str
    target_users: str = "all"
    title: Optional[str] = None
    button_type: Optional[str] = None
    button_value: Optional[str] = None
    image_url: Optional[str] = None
    channels: list[str] = Field(default_factory=lambda: ["telegram"])  # telegram | email
    subject: Optional[str] = None  # тема письма (email-канал)


class PromocodeBody(BaseModel):
    code: str
    name: Optional[str] = None
    type: str = "discount"  # единственный поддерживаемый тип
    value: float = 0        # процент скидки
    uses_limit: Optional[int] = None
    expires_at: Optional[str] = None  # срок активации промокода
    is_active: Any = 1


class PromotionBody(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    value: Optional[float] = None
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    uses_limit: Optional[int] = None
    expires_at: Optional[str] = None
    is_active: Optional[bool] = None


class TrackingBody(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    promocode: Optional[str] = None
    welcome_message: Optional[str] = None
    is_active: Optional[bool] = None


class SquadUpdateBody(BaseModel):
    squad_name: Optional[str] = None
    squad_type: Optional[str] = None
    max_users: Optional[int] = None
    priority: Optional[int] = None
    is_active: Optional[bool] = None


class SquadMappingBody(BaseModel):
    vpn: list[str] = Field(default_factory=list)
    trial: list[str] = Field(default_factory=list)


class GraceSettingsBody(BaseModel):
    enabled: bool = False
    squads: list[str] = Field(default_factory=list, max_length=20)
    traffic_gb: int = Field(1, ge=0, le=1000)
    trial: bool = False


class BackupSettingsBody(BaseModel):
    enabled: bool = False
    interval_hours: int = 12


class ForumConfigBody(BaseModel):
    forum_chat_id: Optional[str] = None
    panel_url: Optional[str] = None
    topics: dict[str, Any] = Field(default_factory=dict)


class WithdrawCompleteBody(BaseModel):
    tx_hash: str


class WithdrawRejectBody(BaseModel):
    reason: str = ""
    refund: bool = True


class OauthBody(BaseModel):
    id: Any
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    username: Optional[str] = None
    photo_url: Optional[str] = None
    auth_date: Any = None
    hash: str
    captcha_token: Optional[str] = None


class RedeemPromoBody(BaseModel):
    code: str


class WithdrawBody(BaseModel):
    amount: float
    address: str


class CreatePaymentBody(BaseModel):
    plan_devices: int = 1
    months: int = 1
    method: str = "sbp"
    extra_devices: int = 0
    purpose: str = "subscription"  # subscription | extend | devices
    subscription_id: Optional[int] = None
    use_referral_balance: bool = False  # частично оплатить реф. балансом
    return_to: Optional[str] = None  # экран мини-приложения после оплаты


# минимум суммы у провайдера (руб)
PROVIDER_MIN_RUB: dict[str, float] = {
    "card": 50.0,
    "sberpay": 50.0,
    "international": 50.0,
    "sbp": 10.0,
    "erip": 10.0,
    "crypto": 10.0,
}


def provider_min_rub(method: str) -> float:
    return float(PROVIDER_MIN_RUB.get(str(method or "").lower(), 10.0))


class UpdateEmailBody(BaseModel):
    email: str


class EmailRequestBody(BaseModel):
    email: str
    captcha_token: Optional[str] = None


class EmailVerifyBody(BaseModel):
    email: str
    code: str
    ref: Optional[str] = None  # ref с сайта только при регистрации
    merge: bool = False       # подтверждено объединение с аккаунтом этого email
    captcha_token: Optional[str] = None


class OauthLoginBody(OauthBody):
    ref: Optional[str] = None


class ContentTextBody(BaseModel):
    text: str = ""


class PlansUpdateBody(BaseModel):
    base_price: Optional[float] = None
    extra_device_price: Optional[float] = None
    trial_enabled: Optional[bool] = None
    trial_days: Optional[int] = None
    trial_traffic_gb: Optional[int] = None
    trial_devices: Optional[int] = None
    paid_traffic_gb: Optional[int] = None
    traffic_reset_price: Optional[float] = None
    antiabuse_enabled: Optional[bool] = None
    aa_hwid_multiplier: Optional[int] = Field(None, ge=2, le=10)
    aa_ip_extra: Optional[int] = Field(None, ge=1, le=20)
    aa_grace_hours: Optional[int] = Field(None, ge=1, le=168)
    aa_warn_days: Optional[int] = Field(None, ge=1, le=60)
    trial_hwid_enabled: Optional[bool] = None
    trial_hwid_max: Optional[int] = Field(None, ge=1, le=10)


@app.get("/api/health")
@app.get("/health")
def health() -> dict[str, Any]:
    # не светим внутренние пути наружу
    return {"ok": True, "service": "blinvpn-api"}


@app.get("/api/panel/auth/init")
def panel_auth_init(
    setup_token: Optional[str] = Query(None),
    reset: Optional[int] = Query(0),
    x_panel_setup_token: Optional[str] = Header(None, alias="X-Panel-Setup-Token"),
) -> dict[str, Any]:
    # нужен PANEL_SETUP_TOKEN из .env
    if not _setup_token_ok(setup_token, x_panel_setup_token):
        return {"show_credentials": False}

    admin = get_admin()

    if admin is None:
        admin, password = create_admin()
        return {
            "show_credentials": True,
            "username": admin["username"],
            "password": password,
            "new_admin": True,
            "message": "Сохраните логин и пароль — повторно они не показываются.",
        }

    # пароль в бд только хэш, старый не показать
    # &reset=1: новый пароль, один раз
    if reset:
        admin, password = create_admin(username=admin["username"])
        return {
            "show_credentials": True,
            "username": admin["username"],
            "password": password,
            "new_admin": False,
            "reset": True,
            "message": "Пароль сброшен. Сохраните новый — повторно он не показывается.",
        }

    return {
        "show_credentials": False,
        "message": "Пароль не хранится на сервере. Для сброса откройте панель по ссылке #setup_token=…&reset=1.",
    }


def _client_ip(request: Optional[Request]) -> str:
    if not request:
        return ""
    # nginx кладёт реальный ip в конец x-forwarded-for
    # берём последний элемент (клиентский xff левее)
    fwd = request.headers.get("x-forwarded-for") or request.headers.get("X-Forwarded-For")
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else ""


LOGIN_FAIL_LIMIT = 10          # неудач в логин с одного ip…
LOGIN_FAIL_WINDOW = 15 * 60    # …за 15 мин -> вход с этого ip закрыт
LOGIN_FAIL_GLOBAL = 100        # со всех ip за час: защита от разнесённого брутфорса
LOGIN_FAIL_GLOBAL_WINDOW = 3600
_DUMMY_SALT = secrets.token_hex(16)
_DUMMY_HASH = hash_password(secrets.token_hex(16), _DUMMY_SALT)[0]


def _trusted_ip(login: str, ip: str) -> bool:
    """с этого ip в этот логин уже входили (90 дней)."""
    admin = get_admin() or {}
    if admin and hmac.compare_digest(login.encode(), str(admin.get("username") or "").encode()):
        actor = "owner"
    else:
        st = staffmod.by_username(login)
        if not st:
            return False
        actor = f"staff:{int(st['id'])}"
    since = iso(utcnow() - timedelta(days=90))
    return bool(db.fetchone("SELECT 1 FROM panel_audit WHERE actor = ? AND action = 'login_ok' AND ip = ? AND ts >= ? LIMIT 1",
                            (actor, ip, since)))


def _send_staff_code(st: dict[str, Any], code: str, ip: str, ua: str) -> bool:
    """код 2fa сотруднику в лс от бота."""
    if not TELEGRAM_BOT_TOKEN:
        return False
    text = (f"🔒 <b>Код входа в панель</b>: <code>{code}</code>\n"
            f"<b>Логин</b>: {_esc_html(st['username'])}\n<b>IP</b>: {_esc_html(ip or '—')}"
            f"{(' (' + _esc_html(ua[:150]) + ')') if ua else ''}\n\n"
            "Никому не сообщайте код. Если входили не вы — сообщите администратору.")
    try:
        r = notifier.call("sendMessage", {"chat_id": int(st["telegram_id"]), "text": text, "parse_mode": "HTML"}, timeout=10.0)
    except Exception:  # noqa: BLE001
        return False
    return bool(r)  # none: telegram не принял


@app.post("/api/panel/auth/login")
def panel_login(body: LoginBody, request: Request = None) -> Any:  # type: ignore[assignment]
    # 5 попыток с одного ip за 60 сек
    ip = _client_ip(request) or "unknown"
    ua = ((request.headers.get("user-agent") if request else "") or "")[:300]
    allowed, retry = ratelimit.rate_limit(f"login:{ip}", 5, 60)
    if not allowed:
        return JSONResponse(
            {"error": f"Слишком много попыток. Повторите через {retry} сек."},
            status_code=429,
            headers={"Retry-After": str(retry)},
        )

    login = str(body.username or "").strip()[:64]
    password = str(body.password or "")[:256]
    fail_key = f"loginfail:{login.lower()}:{ip}"
    fail_all = f"loginfail:{login.lower()}"
    # 10 ошибок логин+ip / 15 мин -> блок с этого ip
    # со всех ip: не больше 100 ошибок в час
    if (ratelimit.peek(fail_key, LOGIN_FAIL_WINDOW) >= LOGIN_FAIL_LIMIT
            or (ratelimit.peek(fail_all, LOGIN_FAIL_GLOBAL_WINDOW) >= LOGIN_FAIL_GLOBAL and not _trusted_ip(login, ip))):
        return JSONResponse({"error": "Слишком много неудачных попыток. Повторите через 15 минут."},
                            status_code=429, headers={"Retry-After": str(LOGIN_FAIL_WINDOW)})

    def fail(actor: str = "anon", name: Optional[str] = None) -> JSONResponse:
        ratelimit.rate_limit(fail_key, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW)
        ratelimit.rate_limit(fail_all, LOGIN_FAIL_GLOBAL, LOGIN_FAIL_GLOBAL_WINDOW)
        audit(actor, name or login[:40], "login_fail", 401, ip)
        return JSONResponse({"error": "Неверные учётные данные"}, status_code=401)

    admin = get_admin()
    if not admin:
        if ENV != "production" and not PANEL_SETUP_TOKEN:
            admin, _ = create_admin()
        else:
            return JSONResponse({"error": "Админ не инициализирован. Вызовите /api/panel/auth/init"}, status_code=401)

    if hmac.compare_digest(login.encode(), str(admin["username"]).encode()):
        if not verify_password(password, admin["password_hash"], admin["password_salt"]):
            return fail("owner", OWNER_NAME)
        # 2fa если есть куда слать код (форум или лс)
        can_deliver = bool(TELEGRAM_BOT_TOKEN and (forum.chat_id() or forum.admin_chat_id()))
        if can_deliver:
            temp, code = set_temp_2fa(admin["username"])
            forum.send_code(code, ip=ip, user_agent=ua)
            if ENV != "production":
                print(f"[BlinVPN] 2FA code for panel: {code}")
            return {"requires_2fa": True, "temp_token": temp}
        token = create_panel_session(admin["username"])
        clear_admin_plaintext()
        audit("owner", OWNER_NAME, "login_ok", 200, ip)
        print("[panel] вход без 2FA: не настроены ни форум, ни TELEGRAM_ADMIN_ID", flush=True)
        return {
            "session_token": token,
            "warning": "Двухфакторная защита выключена: коды входа некуда отправлять. "
                       "Настройте форум (Настройки → Форум) или TELEGRAM_ADMIN_ID в .env.",
        }

    st = staffmod.by_username(login)
    if not st:
        verify_password(password, _DUMMY_HASH, _DUMMY_SALT)  # одинаковое время ответа, чтобы не перебирать логины
        return fail()
    if not verify_password(password, st["password_hash"], st["password_salt"]):
        return fail(f"staff:{st['id']}", staffmod.display_name(st))
    if not st.get("is_active"):
        audit(f"staff:{st['id']}", staffmod.display_name(st), "login_disabled", 403, ip)
        return JSONResponse({"error": "Доступ отключён администратором"}, status_code=403)
    temp, code = set_temp_2fa(st["username"], staff_id=int(st["id"]))
    if not _send_staff_code(st, code, ip, ua):
        db.execute("DELETE FROM temp_2fa WHERE token = ?", (_token_hash(temp),))
        return JSONResponse({"error": "Не удалось отправить код в Telegram. Откройте бота и нажмите «Запустить» (/start), "
                                      "затем войдите снова."}, status_code=502)
    if ENV != "production":
        print(f"[BlinVPN] 2FA code for staff {st['username']}: {code}")
    return {"requires_2fa": True, "temp_token": temp}


@app.post("/api/panel/auth/logout")
def panel_logout(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """завершает сессию панели на сервере."""
    if authorization and authorization.lower().startswith("bearer "):
        delete_panel_session(authorization.split(" ", 1)[1].strip())
    return {"ok": True}


@app.post("/api/panel/auth/verify-code")
def panel_verify_code(body: VerifyCodeBody, request: Request = None) -> Any:  # type: ignore[assignment]
    ip = _client_ip(request) or "unknown"
    entry = pop_temp_2fa(body.temp_token)  # одна попытка на код: ошибка -> вход заново
    if not entry:
        return JSONResponse({"error": "Код истёк"}, status_code=401)
    sid = entry.get("staff_id")
    actor = "owner" if sid is None else f"staff:{int(sid)}"
    if not hmac.compare_digest(str(body.code).strip().encode(), str(entry["code"]).encode()):
        ratelimit.rate_limit(f"loginfail:{str(entry['username']).lower()}:{ip}", LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW)
        ratelimit.rate_limit(f"loginfail:{str(entry['username']).lower()}", LOGIN_FAIL_GLOBAL, LOGIN_FAIL_GLOBAL_WINDOW)
        audit(actor, entry["username"], "2fa_fail", 401, ip)
        return JSONResponse({"error": "Неверный код"}, status_code=401)
    if sid is None:
        admin = get_admin()
        if not admin or not hmac.compare_digest(str(entry["username"]).encode(), str(admin["username"]).encode()):
            return JSONResponse({"error": "Код истёк"}, status_code=401)
        token = create_panel_session(entry["username"])
        clear_admin_plaintext()
        ratelimit.reset(f"loginfail:{str(entry['username']).lower()}:{ip}")
        audit("owner", OWNER_NAME, "login_ok", 200, ip)
        return {"session_token": token}
    st = staffmod.get(int(sid))
    if not st or not st.get("is_active"):
        return JSONResponse({"error": "Доступ отключён администратором"}, status_code=403)
    token = create_panel_session(st["username"], staff_id=int(st["id"]))
    db.execute("UPDATE panel_staff SET last_login_at = ?, last_login_ip = ? WHERE id = ?", (iso(), ip[:64], int(st["id"])))
    ratelimit.reset(f"loginfail:{st['username']}:{ip}")
    audit(actor, staffmod.display_name(st), "login_ok", 200, ip)
    return {"session_token": token}


@app.get("/api/panel/auth/me")
def panel_me(p: dict = Depends(require_panel)) -> dict[str, Any]:
    """кто вошёл: owner/curator/operator."""
    out = {"kind": p["kind"], "role": p["role"], "username": p["username"], "name": p["name"]}
    if p["kind"] == "staff":
        out["staff_id"] = int(p["staff_id"])
        out["shift"] = staffpay.shift_now(int(p["staff_id"]))
    return out


class StaffCreateBody(BaseModel):
    username: str
    name: Optional[str] = ""
    password: str
    telegram_id: Any
    role: str = "operator"
    default_pay: Any = 0
    default_intervals: Optional[list[Any]] = None


class StaffUpdateBody(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    telegram_id: Any = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    default_pay: Any = None
    default_intervals: Optional[list[Any]] = None


class StaffDayBody(BaseModel):
    intervals: Optional[list[Any]] = None   # none: выходной
    pay: Any = 0


class StaffBulkBody(BaseModel):
    date_from: str
    date_to: str
    weekdays: list[int] = Field(default_factory=list)
    intervals: list[Any] = Field(default_factory=list)
    pay: Any = 0
    overwrite: bool = True
    clear_other: bool = False


class FineBody(BaseModel):
    amount: Any
    reason: str = ""


class PayoutBody(BaseModel):
    amount: Any
    note: Optional[str] = ""
    paid_on: Optional[str] = None


def _staff_call(fn, *a, **k):
    try:
        return fn(*a, **k)
    except staffmod.StaffError as e:
        raise HTTPException(e.status, detail={"message": e.message})
    except staffpay.PayError as e:
        raise HTTPException(e.status, detail={"message": e.message})


def _staff_or_404(staff_id: int) -> dict[str, Any]:
    st = staffmod.get(staff_id)
    if not st:
        raise HTTPException(404, detail={"message": "Сотрудник не найден"})
    return st


def _curator_target(p: dict[str, Any], staff_id: int) -> dict[str, Any]:
    """куратор работает только с операторами."""
    st = _staff_or_404(staff_id)
    if p["kind"] != "owner" and (staffmod.role_of(st) != "operator" or int(st["id"]) == int(p.get("staff_id") or 0)):
        raise HTTPException(403, detail={"message": "Куратор работает только с операторами"})
    return st


def _release_staff_tickets(staff_id: int) -> None:
    """обращения сотрудника снова в пуле."""
    actor = f"staff:{int(staff_id)}"
    db.execute("UPDATE support_tickets SET assigned_admin = NULL, assigned_name = NULL WHERE status = 'open' AND assigned_admin = ?", (actor,))
    db.execute("UPDATE support_chats SET assigned_admin = NULL, assigned_name = NULL WHERE assigned_admin = ?", (actor,))


def _staff_card(st: dict[str, Any], owner: bool) -> dict[str, Any]:
    card = staffmod.public(st) if owner else {"id": st["id"], "name": st.get("name") or "", "username": st["username"],
                                               "role": staffmod.role_of(st), "is_active": bool(st.get("is_active"))}
    card["shift"] = staffpay.shift_now(int(st["id"]))
    if owner:
        card["balance"] = staffpay.ledger(int(st["id"]))["balance"]
    t = db.fetchone("SELECT COUNT(*) AS c FROM support_tickets WHERE status = 'open' AND assigned_admin = ?", (f"staff:{int(st['id'])}",))
    card["tickets_in_work"] = int(t["c"]) if t else 0
    return card


@app.get("/api/panel/staff")
def panel_staff_list(p: dict = Depends(require_panel)) -> dict[str, Any]:
    owner = p["kind"] == "owner"
    rows = db.fetchall("SELECT * FROM panel_staff ORDER BY role, id")
    if not owner:
        # куратору только активные операторы
        rows = [r for r in rows if r.get("is_active") and staffmod.role_of(r) == "operator"]
    return {"staff": [_staff_card(r, owner) for r in rows], "roles": staffmod.ROLES, "bot_ready": bool(TELEGRAM_BOT_TOKEN),
            "today": staffpay.today_msk().isoformat()}


@app.post("/api/panel/staff")
def panel_staff_create(body: StaffCreateBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    admin = get_admin() or {}
    username = _staff_call(staffmod.validate_username, body.username, admin.get("username") or "")
    password = _staff_call(staffmod.validate_password, body.password)
    tg = _staff_call(staffmod.validate_tg, body.telegram_id)
    name = _staff_call(staffmod.validate_name, body.name)
    role = _staff_call(staffmod.validate_role, body.role)
    iv = _staff_call(staffpay.validate_intervals, body.default_intervals if body.default_intervals is not None else [["10:00", "19:00"]])
    pay = _staff_call(staffpay.validate_money, body.default_pay, "Базовая ставка")
    if staffmod.by_username(username):
        raise HTTPException(409, detail={"message": "Сотрудник с таким логином уже есть"})
    digest, salt = hash_password(password)
    now = iso()
    cur = db.execute(
        "INSERT INTO panel_staff (username, name, password_hash, password_salt, telegram_id, permissions, role, "
        "is_active, created_at, updated_at, default_pay, default_intervals) VALUES (?, ?, ?, ?, ?, '{}', ?, 1, ?, ?, ?, ?)",
        (username, name, digest, salt, tg, role, now, now, pay, json.dumps(iv)),
    )
    return staffmod.public(staffmod.get(int(cur.lastrowid)))


@app.put("/api/panel/staff/{staff_id}")
def panel_staff_update(staff_id: int, body: StaffUpdateBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    st = _staff_or_404(staff_id)
    sets: dict[str, Any] = {}
    kill = False
    if body.name is not None:
        sets["name"] = _staff_call(staffmod.validate_name, body.name)
    if body.telegram_id not in (None, ""):
        tg = _staff_call(staffmod.validate_tg, body.telegram_id)
        if tg != int(st["telegram_id"]):
            sets["telegram_id"] = tg
            kill = True
    if body.password:
        digest, salt = hash_password(_staff_call(staffmod.validate_password, body.password))
        sets["password_hash"], sets["password_salt"] = digest, salt
        kill = True
    if body.role is not None:
        sets["role"] = _staff_call(staffmod.validate_role, body.role)
    if body.is_active is not None:
        sets["is_active"] = 1 if body.is_active else 0
        if not body.is_active:
            kill = True
    if body.default_pay is not None:
        sets["default_pay"] = _staff_call(staffpay.validate_money, body.default_pay, "Базовая ставка")
    if body.default_intervals is not None:
        sets["default_intervals"] = json.dumps(_staff_call(staffpay.validate_intervals, body.default_intervals))
    if sets:
        sets["updated_at"] = iso()
        cols = ", ".join(f"{k} = ?" for k in sets)  # ключи только из кода выше
        db.execute(f"UPDATE panel_staff SET {cols} WHERE id = ?", (*sets.values(), int(staff_id)))
    if kill:
        delete_staff_sessions(staff_id)       # смена пароля/tg или отключение -> выход везде
    if body.is_active is False:
        _release_staff_tickets(staff_id)
        webpush.drop_actor(f"staff:{int(staff_id)}")
        # будущие смены отключённого не начисляются
        db.execute("DELETE FROM staff_days WHERE staff_id = ? AND day >= ?", (int(staff_id), staffpay.today_msk().isoformat()))
    return staffmod.public(staffmod.get(staff_id))


@app.post("/api/panel/staff/{staff_id}/logout")
def panel_staff_logout(staff_id: int, _: dict = Depends(require_owner)) -> dict[str, Any]:
    _staff_or_404(staff_id)
    delete_staff_sessions(staff_id)
    return {"ok": True}


@app.delete("/api/panel/staff/{staff_id}")
def panel_staff_delete(staff_id: int, _: dict = Depends(require_owner)) -> dict[str, Any]:
    _staff_or_404(staff_id)
    delete_staff_sessions(staff_id)
    _release_staff_tickets(staff_id)
    webpush.drop_actor(f"staff:{int(staff_id)}")
    teamchat.drop_actor(f"staff:{int(staff_id)}")
    db.execute("DELETE FROM panel_staff WHERE id = ?", (int(staff_id),))
    return {"ok": True}


def _range(date_from: str, date_to: str) -> tuple[Any, Any]:
    a = _staff_call(staffpay.parse_day, date_from)
    b = _staff_call(staffpay.parse_day, date_to)
    if b < a:
        raise HTTPException(400, detail={"message": "Конец периода раньше начала"})
    return a, b


@app.get("/api/panel/staff/{staff_id}/schedule")
def panel_staff_schedule(staff_id: int, date_from: str = Query(..., alias="from", max_length=10),
                         date_to: str = Query(..., alias="to", max_length=10), p: dict = Depends(require_panel)) -> dict[str, Any]:
    if p["kind"] == "owner":
        _staff_or_404(staff_id)
    else:
        _curator_target(p, staff_id)
    a, b = _range(date_from, date_to)
    days = _staff_call(staffpay.schedule, staff_id, a, b)
    if p["kind"] != "owner":
        days = [{"day": d["day"], "intervals": d["intervals"]} for d in days]  # оплату видит только владелец
    return {"days": days, "today": staffpay.today_msk().isoformat()}


@app.put("/api/panel/staff/{staff_id}/schedule/{day}")
def panel_staff_day(staff_id: int, day: str, body: StaffDayBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    if not _staff_or_404(staff_id).get("is_active") and body.intervals is not None:
        raise HTTPException(400, detail={"message": "Сотрудник отключён — сначала включите доступ"})
    d = _staff_call(staffpay.parse_day, day)
    return {"day": _staff_call(staffpay.set_day, staff_id, d, body.intervals, body.pay)}


@app.post("/api/panel/staff/{staff_id}/schedule/bulk")
def panel_staff_bulk(staff_id: int, body: StaffBulkBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    if not _staff_or_404(staff_id).get("is_active"):
        raise HTTPException(400, detail={"message": "Сотрудник отключён — сначала включите доступ"})
    a, b = _range(body.date_from, body.date_to)
    n = _staff_call(staffpay.bulk_fill, staff_id, a, b, body.weekdays, body.intervals, body.pay, body.overwrite, body.clear_other)
    return {"days": n}


@app.get("/api/panel/staff/{staff_id}/ledger")
def panel_staff_ledger(staff_id: int, _: dict = Depends(require_owner)) -> dict[str, Any]:
    _staff_or_404(staff_id)
    return staffpay.ledger(staff_id)


@app.post("/api/panel/staff/{staff_id}/payouts")
def panel_staff_payout(staff_id: int, body: PayoutBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    _staff_or_404(staff_id)
    return _staff_call(staffpay.add_payout, staff_id, body.amount, body.note, body.paid_on)


@app.delete("/api/panel/staff/payouts/{payout_id}")
def panel_staff_payout_delete(payout_id: int, _: dict = Depends(require_owner)) -> dict[str, Any]:
    staffpay.delete_payout(payout_id)
    return {"ok": True}


class BonusBody(BaseModel):
    amount: Any
    reason: str = Field("", max_length=300)


@app.post("/api/panel/staff/{staff_id}/bonuses")
def panel_staff_bonus(staff_id: int, body: BonusBody, p: dict = Depends(require_owner)) -> dict[str, Any]:
    """премия сотруднику, только владелец."""
    st = _staff_or_404(staff_id)
    r = _staff_call(staffpay.add_bonus, staff_id, body.amount, body.reason, p["actor"], p["name"] or "Администратор")
    if st.get("telegram_id"):
        try:
            notifier.call("sendMessage", {"chat_id": int(st["telegram_id"]), "parse_mode": "HTML",
                                          "text": f"🎉 <b>Премия {r['amount']:g} ₽</b>\nЗа что: {_esc_html(r['reason'])}"}, timeout=10.0)
        except Exception:  # noqa: BLE001
            pass
    return r


@app.delete("/api/panel/staff/bonuses/{bonus_id}")
def panel_staff_bonus_cancel(bonus_id: int, p: dict = Depends(require_owner)) -> dict[str, Any]:
    return _staff_call(staffpay.cancel_bonus, bonus_id, p["actor"])


@app.get("/api/panel/staff/{staff_id}/fines")
def panel_staff_fines(staff_id: int, p: dict = Depends(require_panel)) -> dict[str, Any]:
    if p["kind"] != "owner":
        _curator_target(p, staff_id)
    else:
        _staff_or_404(staff_id)
    return {"fines": staffpay.ledger(staff_id)["fines"]}


@app.post("/api/panel/staff/{staff_id}/fines")
def panel_staff_fine(staff_id: int, body: FineBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    st = _curator_target(p, staff_id) if p["kind"] != "owner" else _staff_or_404(staff_id)
    r = _staff_call(staffpay.add_fine, staff_id, body.amount, body.reason, p["actor"], p["name"])
    if st.get("telegram_id"):
        try:
            notifier.call("sendMessage", {"chat_id": int(st["telegram_id"]), "parse_mode": "HTML",
                                          "text": f"⚠️ <b>Штраф {r['amount']:g} ₽</b>\nПричина: {_esc_html(r['reason'])}"}, timeout=10.0)
        except Exception:  # noqa: BLE001
            pass
    return r


@app.delete("/api/panel/staff/fines/{fine_id}")
def panel_staff_fine_cancel(fine_id: int, p: dict = Depends(require_panel)) -> dict[str, Any]:
    return _staff_call(staffpay.cancel_fine, fine_id, p["actor"], None if p["kind"] == "owner" else p["actor"])


@app.get("/api/panel/me/salary")
def panel_my_salary(date_from: Optional[str] = Query(None, alias="from", max_length=10),
                    date_to: Optional[str] = Query(None, alias="to", max_length=10), p: dict = Depends(require_panel)) -> dict[str, Any]:
    """сотрудник: график, начисления, штрафы, выплаты, баланс."""
    if p["kind"] != "staff":
        raise HTTPException(404, detail={"message": "Только для сотрудников"})
    sid = int(p["staff_id"])
    t = staffpay.today_msk()
    if date_from and date_to:
        a, b = _range(date_from, date_to)
    else:
        # день до 1-го — чтобы хвост смены через полночь был виден в календаре
        a, b = t.replace(day=1) - timedelta(days=1), t + timedelta(days=45)
    return {**staffpay.ledger(sid), "schedule": _staff_call(staffpay.schedule, sid, a, b), "today": t.isoformat(),
            "shift": staffpay.shift_now(sid)}


@app.get("/api/panel/staff/audit")
def panel_staff_audit(actor: str = Query("", max_length=32), limit: int = Query(200, ge=1, le=500),
                      _: dict = Depends(require_owner)) -> dict[str, Any]:
    if actor and not re.fullmatch(r"owner|staff:\d+", actor):
        raise HTTPException(400, detail={"message": "Неверный фильтр"})
    if actor:
        rows = db.fetchall("SELECT * FROM panel_audit WHERE actor = ? ORDER BY id DESC LIMIT ?", (actor, limit))
    else:
        rows = db.fetchall("SELECT * FROM panel_audit ORDER BY id DESC LIMIT ?", (limit,))
    return {"items": rows}


class PushSubBody(BaseModel):
    endpoint: str = Field(..., max_length=1000)
    keys: dict[str, str] = Field(default_factory=dict)


def _push(fn, *a, **k):
    try:
        return fn(*a, **k)
    except webpush.PushError as e:
        raise HTTPException(e.status, detail={"message": e.message})


@app.get("/api/panel/push/key")
def panel_push_key(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return {"key": webpush.public_key()}


@app.post("/api/panel/push/subscribe")
def panel_push_subscribe(body: PushSubBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    _push(webpush.subscribe, p["actor"], body.endpoint, str(body.keys.get("p256dh") or "")[:200], str(body.keys.get("auth") or "")[:100])
    return {"ok": True}


@app.post("/api/panel/push/unsubscribe")
def panel_push_unsubscribe(body: PushSubBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    webpush.unsubscribe(p["actor"], body.endpoint)
    return {"ok": True}


@app.post("/api/panel/push/test")
def panel_push_test(p: dict = Depends(require_panel)) -> dict[str, Any]:
    allowed, _r = ratelimit.rate_limit(f"pushtest:{p['actor']}", 5, 300)
    if not allowed:
        raise HTTPException(429, detail={"message": "Не чаще 5 раз за 5 минут"})
    subs = db.fetchall("SELECT * FROM push_subs WHERE actor = ? ORDER BY id DESC LIMIT 3", (p["actor"],))
    ok = sum(1 for sub in subs if webpush._send_one(sub, {"title": "BlinVPN", "body": "Уведомления работают", "url": "/"}))
    return {"sent": ok, "subscriptions": len(subs)}


@app.get("/api/panel/dashboard")
def panel_dashboard(_: dict = Depends(require_panel)) -> dict[str, Any]:
    """главная: деньги, новые юзеры, список дел."""
    return stats_mod.dashboard()


@app.get("/api/panel/statistics")
def panel_statistics(period: str = Query("30d", max_length=10),
                     date_from: Optional[str] = Query(None, alias="from", max_length=10),
                     date_to: Optional[str] = Query(None, alias="to", max_length=10),
                     _: dict = Depends(require_panel)) -> dict[str, Any]:
    """статистика: пресет или from/to (гггг-мм-дд)."""
    d1 = d2 = None
    if date_from and date_to:
        try:
            d1, d2 = date.fromisoformat(date_from), date.fromisoformat(date_to)
        except ValueError:
            raise HTTPException(400, detail={"message": "Неверная дата"})
        if d1 > d2:
            d1, d2 = d2, d1
        if d1.year < 2000:
            raise HTTPException(400, detail={"message": "Неверная дата"})
    data = stats_mod.statistics(period, d1, d2)
    data["subs"]["state_dist"] = _user_distribution()
    return data


@app.get("/api/panel/stats/summary")
def panel_stats_summary(_: dict = Depends(require_panel)) -> dict[str, Any]:
    total_users = db.fetchone("SELECT COUNT(*) AS c FROM users")
    active_keys = db.fetchone("SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'Active'")
    month_start = utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    revenue_row = db.fetchone(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM transactions "
        "WHERE status = 'completed' AND amount > 0 AND created_at >= ?",
        (month_start,),
    )
    return {
        "total_users": int(total_users["c"]) if total_users else 0,
        "active_keys": int(active_keys["c"]) if active_keys else 0,
        "monthly_revenue": round(float(revenue_row["s"]) if revenue_row else 0, 2),
    }


def _tx_date(tx: dict[str, Any]):
    try:
        return datetime.fromisoformat(str(tx["created_at"]).replace("Z", "+00:00")).date()
    except (ValueError, TypeError, KeyError):
        return None


_METHOD_LABELS = {
    "sbp": "СБП",
    "card": "Карта",
    "sberpay": "SberPay",
    "tg_stars": "Звёзды Telegram",
    "stars": "Звёзды Telegram",
    "balance": "Реф. баланс",
}


def _payment_methods_chart() -> list[dict[str, Any]]:
    """сколько оплат каждым способом (только успешные)."""
    rows = db.fetchall(
        "SELECT CASE WHEN provider = 'balance' THEN 'balance' ELSE COALESCE(method, provider, 'other') END AS m, "
        "COUNT(*) AS c FROM payments WHERE status = 'paid' GROUP BY m ORDER BY c DESC"
    )
    return [{"name": _METHOD_LABELS.get(str(r["m"]).lower(), str(r["m"])), "value": int(r["c"])} for r in rows]


def _user_distribution() -> list[dict[str, Any]]:
    """разбивка статусов по фактическим подпискам."""
    counts = {"Active": 0, "Trial": 0, "Expired": 0, "None": 0, "Banned": 0}
    for st in user_states_map().values():
        counts[st] = counts.get(st, 0) + 1
    return [
        {"name": "Активные", "value": counts["Active"]},
        {"name": "Пробные", "value": counts["Trial"]},
        {"name": "Истекла", "value": counts["Expired"]},
        {"name": "Нет подписки", "value": counts["None"]},
        {"name": "Забанен", "value": counts["Banned"]},
    ]


@app.get("/api/panel/statistics/full")
def panel_statistics_full(
    period: str = Query("week"),
    _: dict = Depends(require_panel),
) -> dict[str, Any]:
    days = {"week": 7, "month": 30, "year": 365}.get(period, 7)
    now = utcnow()
    txs = db.fetchall("SELECT * FROM transactions WHERE status = 'completed'")
    # транзакции по дням один раз, не на каждый день
    by_day: dict[Any, float] = {}
    for tx in txs:
        amt = float(tx.get("amount") or 0)
        if amt <= 0:
            continue
        d = _tx_date(tx)
        if d is not None:
            by_day[d] = by_day.get(d, 0.0) + amt
    revenue_by_day: list[dict[str, Any]] = []
    for i in range(days - 1, -1, -1):
        day = (now - timedelta(days=i)).date()
        label = day.isoformat()
        total = round(by_day.get(day, 0.0), 2)
        revenue_by_day.append(
            {"label": label, "date": label, "value": total, "amount": total, "revenue": total}
        )

    values = [d["value"] for d in revenue_by_day]
    best_idx = max(range(len(values)), key=lambda i: values[i]) if values else 0

    users = db.fetchall("SELECT * FROM users")
    active_subs = db.fetchone("SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'Active'")
    paid_subs = db.fetchone(
        "SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'Active' AND type = 'vpn'"
    )
    total_subs = db.fetchone("SELECT COUNT(*) AS c FROM subscriptions")
    # приглашающие: кто привёл хотя бы одного
    partners = int((db.fetchone(
        "SELECT COUNT(DISTINCT referred_by) AS c FROM users WHERE referred_by IS NOT NULL") or {}).get("c") or 0)
    # число приглашённых одним запросом
    ref_counts = {
        int(r["rid"]): int(r["c"])
        for r in db.fetchall(
            "SELECT referred_by AS rid, COUNT(*) AS c FROM users WHERE referred_by IS NOT NULL GROUP BY referred_by"
        )
    }
    total_invited = sum(ref_counts.values())
    clients_balance = sum(float(u.get("partner_balance") or 0) for u in users)

    today = now.date()
    payments_today = sum(
        1
        for tx in txs
        if float(tx.get("amount") or 0) > 0 and _tx_date(tx) == today
    )

    top_referrers = sorted(
        (
            {
                "id": u["id"],
                "name": u.get("username") or str(u["telegram_id"]),
                "count": ref_counts.get(int(u["id"]), 0),
                "earned": float(u.get("partner_balance") or 0),
            }
            for u in users
            if ref_counts.get(int(u["id"]), 0) > 0
        ),
        key=lambda x: x["count"],
        reverse=True,
    )[:10]

    total_users = len(users)
    paid_count = int(paid_subs["c"]) if paid_subs else 0

    return {
        "totalUsers": total_users,
        "activeSubscriptions": int(active_subs["c"]) if active_subs else 0,
        "paymentsToday": payments_today,
        "clientsBalance": round(clients_balance, 2),
        "revenueByDay": revenue_by_day,
        "dailyRevenue": revenue_by_day,
        "avgDaily": round(sum(values) / len(values), 2) if values else 0,
        "bestDayValue": values[best_idx] if values else 0,
        "bestDayDate": revenue_by_day[best_idx]["label"] if revenue_by_day else None,
        "boughtThisWeek": sum(1 for tx in txs if float(tx.get("amount") or 0) > 0),
        "userDistData": _user_distribution(),
        "paymentMethodsData": _payment_methods_chart(),
        "totalSubscriptions": int(total_subs["c"]) if total_subs else 0,
        "paidSubscriptions": paid_count,
        "conversionRate": round((paid_count / total_users * 100) if total_users else 0, 1),
        "totalInvited": total_invited,
        "partners": partners,
        "totalPaid": round(sum(float(tx.get("amount") or 0) for tx in txs if float(tx.get("amount") or 0) > 0), 2),
        "topReferrers": top_referrers,
    }


@app.get("/api/panel/finance/stats")
def panel_finance_stats(_: dict = Depends(require_panel)) -> dict[str, Any]:
    # считаем по payments, как в «финансах»
    deposits = db.fetchone(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM payments "
        "WHERE status IN ('paid', 'completed') AND COALESCE(amount, 0) > 0"
    )
    withdrawals = db.fetchone(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM payments "
        "WHERE status = 'refunded' AND COALESCE(amount, 0) > 0"
    )
    successful = db.fetchone(
        "SELECT COUNT(*) AS c FROM payments WHERE status IN ('paid', 'completed')"
    )
    return {
        "deposits": round(float(deposits["s"]) if deposits else 0, 2),
        "withdrawals": round(float(withdrawals["s"]) if withdrawals else 0, 2),
        "successfulOps": int(successful["c"]) if successful else 0,
    }


@app.get("/api/panel/transactions")
def panel_transactions(
    limit: int = Query(100),
    offset: int = Query(0),
    _: dict = Depends(require_panel),
) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    rows = db.fetchall(
        "SELECT * FROM transactions ORDER BY id DESC LIMIT ? OFFSET ?",
        (limit, offset),
    )
    return [serialize_transaction(tx) for tx in rows]


def _payment_actions(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider_payment_id": p.get("provider_payment_id"),
        "chargeback_at": p.get("chargeback_at"),
        "chargeback_reported": bool(p.get("chargeback_reported_at")),
        "can_chargeback": p.get("status") == "paid" and p.get("provider") in CHARGEBACK_PROVIDERS,
        "refundable": _payment_refundable(p) and not p.get("chargeback_reported_at"),
    }


@app.get("/api/panel/payments")
def panel_payments(
    limit: int = Query(100),
    offset: int = Query(0),
    q: str = Query("", max_length=120),
    _: dict = Depends(require_panel),
) -> list[dict[str, Any]]:
    """оплаченные/возвраты/чарджбеки; поиск по id и юзеру."""
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    where = "p.status IN ('paid', 'completed', 'refunding', 'refunded', 'chargeback')"
    params: list[Any] = []
    q = q.strip().lstrip("@#")
    if q:
        esc = q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{esc}%"
        where += (" AND (lower(p.payment_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.provider_payment_id, '')) LIKE ? ESCAPE '\\' "
                  "OR lower(COALESCE(u.username, '')) LIKE ? ESCAPE '\\' OR CAST(p.user_id AS TEXT) = ? OR CAST(u.telegram_id AS TEXT) = ?)")
        params += [like, like, like, q, q]
    rows = db.fetchall(
        "SELECT p.*, u.username AS u_username, u.telegram_id AS u_tg "
        f"FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE {where} "
        "ORDER BY p.id DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    return [
        {
            "id": p["id"],
            "payment_id": p.get("payment_id"),
            "user_id": p.get("user_id"),
            "username": p.get("u_username"),
            "telegram_id": p.get("u_tg"),
            "provider": p.get("provider"),
            "method": p.get("method"),
            "amount": p.get("amount"),
            "currency": p.get("currency"),
            "stars": p.get("stars"),
            "status": p.get("status"),
            "purpose": p.get("purpose"),
            "description": _payment_description(p.get("purpose"), p.get("user_id")),
            "created_at": p.get("created_at"),
            "paid_at": p.get("paid_at"),
            "referral_applied": p.get("referral_applied") or 0,
            "refunded_at": p.get("refunded_at"),
            **_payment_actions(p),
        }
        for p in rows
    ]


def _filter_users(search: Optional[str], status: Optional[str]) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM users ORDER BY id DESC")
    states = user_states_map()
    for u in items:
        u["_state"] = states.get(int(u["id"]), "None")
    if status and status != "all":
        st = status.lower()
        items = [u for u in items if str(u.get("_state", "")).lower() == st]
    if search:
        q = search.lower().lstrip("@")
        items = [
            u
            for u in items
            if q in str(u.get("username") or "").lower()
            or q in str(u.get("telegram_id") or "")
            or q in str(u.get("id") or "")
            or q in str(u.get("referral_code") or "").lower()
        ]
    return items


@app.get("/api/panel/users")
def panel_users(
    limit: int = Query(100),
    offset: int = Query(0),
    page: int = Query(1),
    search: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    p: dict = Depends(require_panel),
) -> dict[str, Any]:
    items = _filter_users(search or q, status)
    page_data = paginate(items, limit, offset if offset else (page - 1) * limit)
    page_items = page_data["items"]
    # сумма успешных платежей пачкой (не n+1)
    revenue_map: dict[int, float] = {}
    manage_ids: Optional[set[int]] = None  # None = полный доступ (owner/curator)
    if page_items:
        ids = [int(u["id"]) for u in page_items]
        placeholders = ",".join("?" * len(ids))
        rows = db.fetchall(
            f"SELECT user_id, COALESCE(SUM(amount), 0) AS s FROM payments "
            f"WHERE user_id IN ({placeholders}) AND status IN ('paid', 'completed') "
            f"AND COALESCE(amount, 0) > 0 GROUP BY user_id",
            tuple(ids),
        )
        for r in rows:
            revenue_map[int(r["user_id"])] = float(r["s"] or 0)
        if not is_full(p):
            manage_ids = {
                int(r["user_id"]) for r in db.fetchall(
                    f"SELECT c.user_id FROM support_chats c "
                    f"JOIN support_tickets t ON t.id = c.open_ticket_id "
                    f"WHERE c.user_id IN ({placeholders}) AND t.status = 'open' AND t.assigned_admin = ?",
                    (*ids, p["actor"]),
                )
            }
    return {
        "items": [
            {
                **serialize_user(u, revenue=revenue_map.get(int(u["id"]), 0.0)),
                "can_manage": manage_ids is None or int(u["id"]) in manage_ids,
            }
            for u in page_items
        ],
        "total": page_data["total"],
    }


@app.get("/api/panel/users/{user_id}")
def panel_user_get(user_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")
    return serialize_user(user)


@app.get("/api/panel/users/{user_id}/subscriptions")
def panel_user_subs(user_id: int, _: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    if not get_user(user_id):
        raise HTTPException(404, detail="User not found")
    keys = db.fetchall(
        "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC", (user_id,)
    )
    user = get_user(user_id)
    return [serialize_key(k, user) for k in keys]


@app.get("/api/panel/users/{user_id}/referrals")
def panel_user_referrals(user_id: int, _: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    if not get_user(user_id):
        raise HTTPException(404, detail="User not found")
    refs = db.fetchall("SELECT * FROM users WHERE referred_by = ?", (user_id,))
    return [
        {
            "id": u["id"],
            "telegram_id": u["telegram_id"],
            "username": u.get("username"),
            "full_name": " ".join(filter(None, [u.get("first_name"), u.get("last_name")])) or None,
            "is_partner": bool(u.get("is_partner")),
            "partner_rate": u.get("partner_rate", 25),
        }
        for u in refs
    ]


@app.post("/api/panel/users/{user_id}/referrals/{ref_id}/unlink")
def panel_unlink_referral(user_id: int, ref_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    parent = get_user(user_id)
    child = get_user(ref_id)
    if not parent or not child:
        raise HTTPException(404, detail="User not found")
    if child.get("referred_by") == user_id:
        db.execute("UPDATE users SET referred_by = NULL WHERE id = ?", (ref_id,))
    return {"success": True}


@app.get("/api/panel/users/{user_id}/payments")
def panel_user_payments(user_id: int, _: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    if not get_user(user_id):
        raise HTTPException(404, detail="User not found")
    rows = db.fetchall(
        "SELECT * FROM payments WHERE user_id = ? AND status IN ('paid', 'completed', 'refunding', 'refunded', 'chargeback') "
        "ORDER BY id DESC LIMIT 100",
        (user_id,),
    )
    txs = db.fetchall(
        "SELECT * FROM transactions WHERE user_id = ? AND status = 'completed' "
        "ORDER BY id DESC LIMIT 100",
        (user_id,),
    )
    paid_ids = {p.get("payment_id") for p in rows}
    result = [
        {
            "id": p["id"],
            "payment_id": p.get("payment_id"),
            "provider": p.get("provider"),
            "method": p.get("method"),
            "amount": p.get("amount"),
            "currency": p.get("currency"),
            "stars": p.get("stars"),
            "status": p.get("status"),
            "purpose": p.get("purpose"),
            "description": _payment_description(p.get("purpose"), user_id),
            "created_at": p.get("created_at"),
            "paid_at": p.get("paid_at"),
            "referral_applied": p.get("referral_applied") or 0,
            "refunded_at": p.get("refunded_at"),
            **_payment_actions(p),
        }
        for p in rows
    ]
    # транзакции без платежа (ручные, рефералка)
    for t in txs:
        if t.get("payment_id") and t.get("payment_id") in paid_ids:
            continue
        result.append({
            "id": f"tx-{t['id']}",
            "payment_id": t.get("payment_id"),
            "provider": {"referral": "рефералка", "referral_reversal": "рефералка", "panel": "панель"}.get(
                str(t.get("payment_method") or ""), t.get("payment_method")),
            "method": t.get("payment_method"),
            "amount": t.get("amount"),
            "currency": "RUB",
            "stars": None,
            "status": t.get("status"),
            "purpose": _panel_tx_label(t),
            "description": _panel_tx_label(t),
            "created_at": t.get("created_at"),
            "paid_at": t.get("created_at") if t.get("status") == "completed" else None,
        })
    result.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return result


def _panel_tx_label(t: dict[str, Any]) -> str:
    """подпись операции без платежа для панели."""
    m = str(t.get("payment_method") or "")
    desc = str(t.get("description") or "")
    ref = re.search(r"user (\d+)", desc)
    who = f" от #{ref.group(1)}" if ref else ""
    if m == "referral":
        return f"Бонус за приглашённого{who}"
    if m == "referral_reversal":
        return f"Бонус снят: возврат{who}"
    if m == "panel":
        return "Начислено вручную" if float(t.get("amount") or 0) >= 0 else "Списано вручную"
    return desc or "Операция"


def _payment_refundable(p: dict[str, Any]) -> bool:
    return bool(
        p.get("provider") in ("platega", "tg_stars")
        and p.get("status") == "paid"
        and p.get("provider_payment_id")
    )


def _payment_description(purpose: Optional[str], user_id: Any) -> str:
    """описание платежа для панели (в скобках внутренний id)."""
    uid = user_id if user_id is not None else "—"
    label = {
        "subscription": "Покупка подписки",
        "extend": "Покупка подписки",
        "devices": "Изменение лимита устройств",
        "traffic_reset": "Сброс трафика",
    }.get(str(purpose or "").lower(), "Платёж")
    return f"{label} ({uid})"


def _reverse_referral_bonus(payment: dict[str, Any]) -> None:
    """снять реф. бонус пригласившему за этот платёж."""
    try:
        pid = payment.get("payment_id")
        if db.fetchone("SELECT 1 FROM transactions WHERE payment_id = ? AND payment_method = 'referral_reversal' LIMIT 1",
                       (pid,)):
            return  # уже снят
        # снимаем ровно тот бонус и тому, кому начислили
        credited = db.fetchone("SELECT user_id, amount FROM transactions WHERE hash = ? AND payment_method = 'referral' "
                               "AND amount > 0 ORDER BY id LIMIT 1", (f"pay:{pid}",))
        if credited:
            referrer = get_user(int(credited["user_id"]))
            bonus = round(float(credited["amount"]), 2)
        else:
            # нет бонуса с пометкой платежа: либо новый учёт, либо старый по ставке
            since = (db.fetchone("SELECT value FROM settings WHERE key = 'ref_hash_since'") or {}).get("value")
            paid = payment.get("paid_at") or payment.get("created_at") or ""
            if not since or paid >= since:
                return
            user = get_user(int(payment["user_id"]))
            if not user or not user.get("referred_by") or (payment.get("currency") or "RUB") != "RUB":
                return
            amount = float(payment.get("amount") or 0)
            if amount <= 0:
                return
            referrer = get_user(int(user["referred_by"]))
            bonus = round(amount * float((referrer or {}).get("partner_rate") or 25) / 100.0, 2)
        if not referrer or bonus <= 0:
            return
        db.execute(
            "UPDATE users SET partner_balance = MAX(0, partner_balance - ?) WHERE id = ?",
            (bonus, referrer["id"]),
        )
        db.execute(
            "INSERT INTO transactions (user_id, amount, status, payment_method, hash, payment_id, description, created_at) "
            "VALUES (?, ?, 'completed', 'referral_reversal', ?, ?, ?, ?)",
            (referrer["id"], -bonus, secrets.token_hex(8), pid,
             f"referral reversal user {payment.get('user_id')}", db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001
        pass


def _refund_undo_plan(payment: dict[str, Any]) -> dict[str, Any]:
    """что откатить: из grant_info или полей старого платежа."""
    info = db.loads(payment.get("grant_info"), None) if payment.get("grant_info") else None
    if isinstance(info, dict) and info.get("kind"):
        return info
    purpose = payment.get("purpose") or "subscription"
    if purpose == "traffic_reset":
        return {"kind": "traffic_reset"}
    if purpose == "devices":
        return {"kind": "devices", "sub_id": payment.get("subscription_id"),
                "added_devices": max(1, int(payment.get("extra_devices") or 1))}
    return {"kind": "extend", "sub_id": payment.get("subscription_id"),
            "added_seconds": int(fulfillment.DAYS_PER_MONTH * max(1, int(payment.get("months") or 1)) * 86400),
            "added_devices": 0, "upgraded_trial": False, "legacy": True}


def _later_paid_extends(payment: dict[str, Any], sub_id: int) -> list[dict[str, Any]]:
    """оплаченные после этого продления той же подписки."""
    rows = db.fetchall(
        "SELECT payment_id, grant_info, paid_at, id FROM payments WHERE user_id = ? AND status = 'paid' AND payment_id != ?",
        (int(payment["user_id"]), payment.get("payment_id")))
    mine = (payment.get("paid_at") or "", int(payment.get("id") or 0))
    out = []
    for r in rows:
        info = db.loads(r.get("grant_info"), None) if r.get("grant_info") else None
        if not isinstance(info, dict) or info.get("kind") != "extend" or int(info.get("sub_id") or 0) != int(sub_id):
            continue
        if (r.get("paid_at") or "", int(r.get("id") or 0)) > mine:
            out.append(r)
    return out


def _segment_left_seconds(payment: dict[str, Any], plan: dict[str, Any], sub_id: int, now: datetime) -> int:
    """сколько оплаченных этим платежом дней ещё не прошло."""
    months = max(1, int(payment.get("months") or 1))
    added = int(plan.get("added_seconds") or fulfillment.DAYS_PER_MONTH * months * 86400)
    # позднее продление истёкшей: дни этого платежа уже истрачены
    for r in _later_paid_extends(payment, sub_id):
        info = db.loads(r.get("grant_info"), None) or {}
        prev = parse_iso(info.get("prev_expires_at"))
        at = parse_iso(r.get("paid_at"))
        if prev and at and prev <= at:
            return 0
    if plan.get("legacy"):
        return added  # старый платёж без отрезка: как раньше
    end = parse_iso(plan.get("end_at"))
    if not end:
        paid = parse_iso(payment.get("paid_at")) or parse_iso(payment.get("created_at")) or now
        if plan.get("kind") == "extend":
            prev = parse_iso(plan.get("prev_expires_at"))
            base = max(prev, paid) if prev else paid
        else:
            base = paid
        end = base + timedelta(seconds=added)
    # ранние откаты сдвинули наш отрезок назад
    shift = 0
    for r in db.fetchall("SELECT grant_info FROM payments WHERE user_id = ? AND status IN ('refunded', 'chargeback') "
                         "AND payment_id != ?", (int(payment["user_id"]), payment.get("payment_id"))):
        info = db.loads(r.get("grant_info"), None) if r.get("grant_info") else None
        if not isinstance(info, dict) or int(info.get("sub_id") or 0) != int(sub_id):
            continue
        r_end = parse_iso(info.get("end_at"))
        if r_end and r_end <= end:
            shift += int(info.get("rolled_back_seconds") or 0)
    end = end - timedelta(seconds=shift)
    left = max(0.0, min(float(added), (end - now).total_seconds()))
    return int(math.ceil(left))


def _revoke_subscription_for_payment(payment: dict[str, Any]) -> None:
    """откатить ровно то, что дал этот платёж, не трогая поздние."""
    try:
        plan = _refund_undo_plan(payment)
        kind = plan.get("kind")
        if kind == "traffic_reset":
            return
        sub_id = plan.get("sub_id") or payment.get("subscription_id")
        sub = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)) if sub_id else None
        user = get_user(int(payment["user_id"]))
        if not sub or not user:
            return
        client, rw = _rw_find_user(user)
        now = utcnow()
        later = bool(_later_paid_extends(payment, int(sub["id"])))
        cur_dev = int(sub.get("devices_limit") or 1)

        def _remember(seconds: int) -> None:
            plan2 = dict(plan)
            plan2["rolled_back_seconds"] = int(seconds)
            db.execute("UPDATE payments SET grant_info = ? WHERE payment_id = ?",
                       (db.dumps(plan2), payment.get("payment_id")))

        def _revoke_fully() -> None:
            db.execute("UPDATE subscriptions SET status = 'Refunded', expires_at = ? WHERE id = ?",
                       (iso(now), sub["id"]))
            if client and rw:
                try:
                    client.disable_user(_rw_num_id(rw))
                except Exception:  # noqa: BLE001
                    pass

        if kind == "devices":
            new_dev = cur_dev if later else max(1, cur_dev - int(plan.get("added_devices") or 0))
            db.execute("UPDATE subscriptions SET devices_limit = ? WHERE id = ?", (new_dev, sub["id"]))
            if client and rw:
                try:
                    client.update_user(id=_rw_num_id(rw), hwid_device_limit=new_dev)
                except Exception:  # noqa: BLE001
                    pass
        else:  # new / extend
            left = _segment_left_seconds(payment, plan, int(sub["id"]), now)
            _remember(left)
            cur_exp = parse_iso(sub.get("expires_at")) or now
            new_exp = cur_exp - timedelta(seconds=left)
            if new_exp <= now + timedelta(minutes=1):
                new_exp = now  # остались секунды: считаем, что оплаченного времени нет
            if kind == "new":
                given = int(plan.get("devices") or 0) or max(1, int(payment.get("plan_devices") or 1) + int(payment.get("extra_devices") or 0))
                new_dev = cur_dev if later else max(1, cur_dev - (given - 1))
            else:
                new_dev = cur_dev if later else max(1, cur_dev - max(0, int(plan.get("added_devices") or 0)))
            if new_exp <= now:
                _revoke_fully()
            else:
                to_trial = bool(plan.get("upgraded_trial")) and not later
                if to_trial:
                    new_dev = max(1, int(plan.get("prev_devices") or 1))
                    tr_limit = plan.get("prev_traffic_limit")
                    tr_limit = int(tr_limit) if tr_limit is not None else fulfillment.trial_traffic_gb()
                    squads = plan.get("prev_squads_json") or db.dumps(fulfillment.trial_squads())
                    db.execute(
                        "UPDATE subscriptions SET expires_at = ?, devices_limit = ?, type = 'trial', "
                        "traffic_limit = ?, squads_json = ?, status = 'Active' WHERE id = ?",
                        (iso(new_exp), new_dev, tr_limit, squads, sub["id"]),
                    )
                else:
                    db.execute("UPDATE subscriptions SET expires_at = ?, devices_limit = ? WHERE id = ?",
                               (iso(new_exp), new_dev, sub["id"]))
                if client and rw:
                    patch: dict[str, Any] = {"id": _rw_num_id(rw), "expire_at": new_exp, "hwid_device_limit": new_dev}
                    if to_trial:
                        patch["active_internal_squads"] = db.loads(squads, []) or fulfillment.trial_squads()
                        patch["traffic_limit_bytes"] = int(tr_limit) * fulfillment.GB
                    try:
                        client.update_user(**patch)
                    except Exception as exc:  # noqa: BLE001
                        try:
                            forum.report_error("Откат платежа: Remnawave не обновлён",
                                               f"{payment.get('payment_id')}: {exc}")
                        except Exception:  # noqa: BLE001
                            pass
        try:
            sync_user_status_from_subs(int(user["id"]))
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        pass


def _finalize_refund(payment_id: str, p: dict[str, Any], admin: dict[str, Any],
                     message: str, manual: bool = False) -> dict[str, Any]:
    """финализация возврата: refunded, бонус, подписка, уведомление."""
    info = db.dumps({"message": message, "manual": manual, "by": admin.get("username")})
    cur = db.execute(
        "UPDATE payments SET status = 'refunded', refunded_at = ?, refund_info = ? "
        "WHERE payment_id = ? AND status = 'refunding'",
        (db.utcnow_iso(), info, payment_id),
    )
    if cur.rowcount == 0:
        fresh = fulfillment.get_payment(payment_id) or {}
        try:
            forum.report_error("Возврат: платёж сменил статус во время возврата",
                               f"{payment_id}: {fresh.get('status')}")
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "message": f"Платёж в статусе «{fresh.get('status')}» — проверьте вручную"}
    db.execute("UPDATE transactions SET status = 'refunded' WHERE payment_id = ?", (payment_id,))
    _reverse_referral_bonus(p)  # для xtr no-op: реф. бонус там не начислялся
    _revoke_subscription_for_payment(p)
    try:
        services.reverse_tracking_payment(int(p["user_id"]), float(p.get("amount") or 0))
    except Exception:  # noqa: BLE001
        pass
    try:
        is_stars = p.get("provider") == "tg_stars"
        amt = p.get("stars") if is_stars else p.get("amount")
        cur_sym = " ⭐" if is_stars else "₽"
        forum.send(
            "purchases",
            f"↩️ <b>Возврат</b> по платежу <code>{forum._esc(payment_id)}</code> — "
            f"{forum._fmt_amount(amt)}{cur_sym} · {forum.user_link(int(p['user_id']))}",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "message": message or "Возврат выполнен", "manual": bool(manual)}


CHARGEBACK_PROVIDERS = ("platega", "tg_stars")

CHARGEBACK_REFUND_BLOCK = ("По этому платежу пришёл чарджбек — возвращать деньги нельзя (правило Platega). "
                           "Нажмите «Чарджбек»: он откатит подписку без возврата денег.")


def _rollback_payment(payment_id: str, p: dict[str, Any], admin: dict[str, Any], note: str,
                      ban: bool = False) -> dict[str, Any]:
    """чарджбек: банк уже вернул деньги, откатываем последствия у нас."""
    if p.get("provider") not in CHARGEBACK_PROVIDERS:
        raise HTTPException(400, detail={"message": "Чарджбек бывает только по оплате картой/СБП или звёздами"})
    info = db.dumps({"note": note, "by": admin.get("name") or admin.get("username")})
    cur = db.execute("UPDATE payments SET status = 'chargeback', chargeback_at = ?, chargeback_info = ? "
                     "WHERE payment_id = ? AND status = 'paid'", (db.utcnow_iso(), info, payment_id))
    if cur.rowcount == 0:
        fresh = fulfillment.get_payment(payment_id) or {}
        if fresh.get("status") == "chargeback":
            banned_now = _chargeback_ban(p, payment_id, note, admin) if ban else False
            return {"ok": True, "already": True, "banned": banned_now,
                    "message": "Чарджбек по этому платежу уже проведён" + (", аккаунт заблокирован" if banned_now else "")}
        raise HTTPException(400, detail={"message": "Чарджбек можно провести только по оплаченному платежу"})
    db.execute("UPDATE transactions SET status = 'chargeback' WHERE payment_id = ?", (payment_id,))
    _reverse_referral_bonus(p)
    _revoke_subscription_for_payment(p)
    try:
        services.reverse_tracking_payment(int(p["user_id"]), float(p.get("amount") or 0))
    except Exception:  # noqa: BLE001
        pass
    try:
        is_stars = p.get("provider") == "tg_stars"
        amt = p.get("stars") if is_stars else p.get("amount")
        forum.send("purchases", f"⚠️ <b>Чарджбек</b> по платежу <code>{forum._esc(payment_id)}</code> — "
                                f"{forum._fmt_amount(amt)}{' ⭐' if is_stars else '₽'} · {forum.user_link(int(p['user_id']))}. "
                                "Подписка откатана, деньги не возвращались.")
    except Exception:  # noqa: BLE001
        pass
    banned_now = _chargeback_ban(p, payment_id, note, admin) if ban else False
    return {"ok": True, "banned": banned_now,
            "message": "Чарджбек проведён: последствия платежа откатаны, деньги не возвращались"
                       + (", аккаунт заблокирован" if banned_now else "")}


def _chargeback_ban(p: dict[str, Any], payment_id: str, note: str, admin: dict[str, Any]) -> bool:
    """бан за чарджбек. true если забанили сейчас."""
    user = get_user(int(p["user_id"]))
    if not user or user.get("is_banned"):
        return False
    reason = f"Чарджбек по платежу {payment_id}" + (f" — {note}" if note and note != "Чарджбек" else "")
    _ban_account(user, reason[:200], admin)
    try:
        forum.send("purchases", f"🚫 Аккаунт {forum.user_link(int(user['id']))} заблокирован за чарджбек "
                                f"<code>{forum._esc(payment_id)}</code>.")
    except Exception:  # noqa: BLE001
        pass
    return True


class ChargebackBody(BaseModel):
    note: str = Field("", max_length=300)
    ban: bool = False  # заодно заблокировать аккаунт


@app.post("/api/panel/payments/{payment_id}/chargeback")
def panel_payment_chargeback(payment_id: str, body: Optional[ChargebackBody] = None, admin: dict = Depends(require_owner)) -> dict[str, Any]:
    p = fulfillment.get_payment(payment_id)
    if not p:
        raise HTTPException(404, detail={"message": "Платёж не найден"})
    return _rollback_payment(payment_id, p, admin, (body.note if body else "") or "Чарджбек", bool(body and body.ban))


@app.get("/api/panel/payments/{payment_id}/refund-check")
def panel_payment_refund_check(payment_id: str, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """можно ли вернуть: platega cancel-supported; stars всегда."""
    p = fulfillment.get_payment(payment_id)
    if not p:
        raise HTTPException(404, detail={"message": "Платёж не найден"})
    if p.get("chargeback_reported_at"):
        return {"supported": False, "blockReason": CHARGEBACK_REFUND_BLOCK}
    if not _payment_refundable(p):
        return {"supported": False, "blockReason": "Платёж нельзя вернуть (не оплачен или уже возвращён)"}
    if p.get("provider") == "tg_stars":
        return {"supported": True, "kind": "stars"}
    if platega is None:
        raise HTTPException(503, detail={"message": "Платёжный модуль недоступен"})
    client = platega.get_client()
    if not client.is_configured():
        raise HTTPException(503, detail={"message": "Platega не настроена"})
    try:
        info = client.cancel_supported(str(p["provider_payment_id"]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail={"message": f"Platega: {exc}"})
    return info


@app.post("/api/panel/payments/{payment_id}/refund")
def panel_payment_refund(payment_id: str, admin: dict = Depends(require_panel)) -> dict[str, Any]:
    """возврат: platega cancel или stars refundstarpPayment."""
    p = fulfillment.get_payment(payment_id)
    if not p:
        raise HTTPException(404, detail={"message": "Платёж не найден"})
    if p.get("chargeback_reported_at"):
        raise HTTPException(409, detail={"message": CHARGEBACK_REFUND_BLOCK})
    if not _payment_refundable(p):
        raise HTTPException(400, detail={"message": "Этот платёж нельзя вернуть"})
    # сначала paid->refunding, потом к провайдеру
    claim = db.execute("UPDATE payments SET status = 'refunding' WHERE payment_id = ? AND status = 'paid' "
                       "AND chargeback_reported_at IS NULL", (payment_id,))
    if claim.rowcount == 0:
        fresh = fulfillment.get_payment(payment_id) or {}
        if fresh.get("chargeback_reported_at") or fresh.get("status") == "chargeback":
            raise HTTPException(409, detail={"message": CHARGEBACK_REFUND_BLOCK})
        raise HTTPException(409, detail={"message": "Платёж уже возвращается или возвращён"})

    def _unclaim() -> None:
        db.execute("UPDATE payments SET status = 'paid' WHERE payment_id = ? AND status = 'refunding'", (payment_id,))

    if p.get("provider") == "tg_stars":
        if telegram_stars is None or not telegram_stars.TelegramStars().is_configured():
            _unclaim()
            raise HTTPException(503, detail={"message": "Оплата звёздами не настроена"})
        user = get_user(int(p["user_id"]))
        tgid = (user or {}).get("telegram_id")
        if not tgid:
            _unclaim()
            raise HTTPException(400, detail={"message": "У пользователя нет Telegram id для возврата звёзд"})
        try:
            telegram_stars.TelegramStars().refund_star_payment(int(tgid), str(p["provider_payment_id"]))
        except Exception as exc:  # noqa: BLE001
            _unclaim()
            raise HTTPException(502, detail={"message": f"Telegram: {exc}"})
        return _finalize_refund(payment_id, p, admin, "Звёзды возвращены пользователю")

    if platega is None:
        _unclaim()
        raise HTTPException(503, detail={"message": "Платёжный модуль недоступен"})
    client = platega.get_client()
    if not client.is_configured():
        _unclaim()
        raise HTTPException(503, detail={"message": "Platega не настроена"})
    try:
        res = client.cancel_transaction(str(p["provider_payment_id"]))
    except Exception as exc:  # noqa: BLE001
        _unclaim()
        raise HTTPException(502, detail={"message": f"Platega: {exc}"})
    if not bool(res.get("accepted")):
        _unclaim()
        return {"ok": False, "message": res.get("message") or "Возврат отклонён провайдером", "raw": res}
    return _finalize_refund(payment_id, p, admin,
                            res.get("message") or "Возврат в процессе",
                            manual=bool(res.get("manualControlRequired")))


@app.get("/api/panel/surveys/stats")
def panel_survey_stats(_: dict = Depends(require_panel)) -> dict[str, Any]:
    """статистика опроса: сколько прошло + ответы."""
    total_started = int((db.fetchone("SELECT COUNT(*) c FROM survey_state") or {}).get("c") or 0)
    total_completed = int((db.fetchone(
        "SELECT COUNT(*) c FROM survey_state WHERE completed = 1") or {}).get("c") or 0)
    total_invited = int((db.fetchone(
        "SELECT COUNT(*) c FROM survey_invites WHERE invited = 1") or {}).get("c") or 0)
    questions: list[dict[str, Any]] = []
    for q in survey.questions():
        n = int(q["n"])
        if q["kind"] == "text":
            rows = db.fetchall(
                "SELECT sa.answer AS answer, sa.created_at AS created_at, sa.user_id AS user_id, "
                "u.username AS username, u.telegram_id AS telegram_id "
                "FROM survey_answers sa JOIN users u ON u.id = sa.user_id "
                "WHERE sa.question = ? ORDER BY sa.id DESC LIMIT 300", (n,))
            questions.append({
                "n": n, "q": q["q"], "kind": "text",
                "answers": [{
                    "answer": r["answer"], "user_id": r["user_id"],
                    "username": r.get("username"), "telegram_id": r.get("telegram_id"),
                    "created_at": r.get("created_at"),
                } for r in rows],
            })
        else:
            rows = db.fetchall(
                "SELECT answer, COUNT(*) AS c FROM survey_answers WHERE question = ? "
                "GROUP BY answer ORDER BY c DESC", (n,))
            questions.append({
                "n": n, "q": q["q"], "kind": q["kind"],
                "options": [{"answer": r["answer"], "count": int(r["c"])} for r in rows],
            })
    return {
        "total_started": total_started,
        "total_completed": total_completed,
        "total_invited": total_invited,
        "reward_percent": survey.reward_value(),
        "questions": questions,
        "config": [{"n": q["n"], "kind": q["kind"], "q": q["q"], "options": q.get("options") or [],
                    "ask_text": list((q.get("text_follow") or {}).keys())} for q in survey.questions()],
    }


@app.put("/api/panel/surveys/questions")
def panel_survey_questions(body: dict[str, Any] = Body(...), _: dict = Depends(require_owner)) -> dict[str, Any]:
    """вопросы опроса и скидка (только владелец)."""
    if len(json.dumps(body, ensure_ascii=False)) > 64_000:
        raise HTTPException(413, detail={"message": "Слишком много текста"})
    try:
        survey.save_questions(body.get("questions"), body.get("reward_percent"))
    except survey.SurveyError as e:
        raise HTTPException(400, detail={"message": str(e)})
    return panel_survey_stats(_)


@app.get("/api/panel/users/{user_id}/survey")
def panel_user_survey(user_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """ответы юзера на опрос."""
    st = db.fetchone(
        "SELECT completed, started_at, completed_at FROM survey_state WHERE user_id = ?", (user_id,))
    if not st:
        return {"taken": False}
    rows = db.fetchall(
        "SELECT question, answer FROM survey_answers WHERE user_id = ? ORDER BY question, id",
        (user_id,))
    by_q: dict[int, list[str]] = {}
    for r in rows:
        by_q.setdefault(int(r["question"]), []).append(r["answer"])
    answers = [{"n": int(q["n"]), "q": q["q"], "answers": by_q.get(int(q["n"]), [])}
               for q in survey.questions()]
    return {
        "taken": True,
        "completed": bool(st.get("completed")),
        "started_at": st.get("started_at"),
        "completed_at": st.get("completed_at"),
        "answers": answers,
    }


@app.get("/api/panel/users/{user_id}/remnawave")
def panel_user_remnawave(user_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """данные remnawave: онлайн, подключения, hwid."""
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")
    out: dict[str, Any] = {
        "configured": provisioning.is_configured(),
        "found": False,
        "online_at": None,
        "first_connected_at": None,
        "last_user_agent": None,
        "status": None,
        "used_traffic_bytes": None,
        "traffic_limit_bytes": None,
        "expire_at": None,
        "hwid_device_limit": None,
        "subscription_url": None,
        "devices": [],
        "error": None,
    }
    client, rw = _rw_find_user(user)
    if not client:
        out["error"] = "remnawave_not_configured"
        return out
    if not rw:
        out["error"] = "user_not_found_in_remnawave"
        return out
    out["found"] = True
    rw = grace.mask_rw(int(user_id), rw)
    out["online_at"] = rw.get("onlineAt") or rw.get("online_at")
    out["first_connected_at"] = rw.get("firstConnectedAt") or rw.get("first_connected_at")
    out["last_user_agent"] = rw.get("subLastUserAgent") or rw.get("sub_last_user_agent")
    out["status"] = rw.get("status")
    _tr = _rw_traffic(rw)
    out["used_traffic_bytes"] = _tr["used_bytes"]
    out["traffic_limit_bytes"] = _tr["limit_bytes"]
    out["expire_at"] = rw.get("expireAt") or rw.get("expire_at")
    out["hwid_device_limit"] = rw.get("hwidDeviceLimit") or rw.get("hwid_device_limit")
    try:
        out["subscription_url"] = client.subscription_url_for(rw)
    except Exception:  # noqa: BLE001
        pass
    try:
        raw = unwrap_rw(client.get_user_hwid_devices(_rw_num_id(rw)))
        devices = raw.get("devices") if isinstance(raw, dict) else raw
        out["devices"] = [
            {
                "hwid": d.get("hwid"),
                "platform": d.get("platform"),
                "os_version": d.get("osVersion") or d.get("os_version"),
                "device_model": d.get("deviceModel") or d.get("device_model"),
                "user_agent": d.get("userAgent") or d.get("user_agent"),
                "created_at": d.get("createdAt") or d.get("created_at"),
                "updated_at": d.get("updatedAt") or d.get("updated_at"),
            }
            for d in (devices or [])
        ]
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"hwid_error: {type(exc).__name__}"
    return out


class HwidUnlinkBody(BaseModel):
    hwid: str


@app.post("/api/panel/users/{user_id}/hwid/unlink")
def panel_user_hwid_unlink(user_id: int, body: HwidUnlinkBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")
    client, rw = _rw_find_user(user)
    if not client or not rw:
        raise HTTPException(400, detail="Пользователь не найден в Remnawave")
    try:
        client.delete_hwid_device({"userId": _rw_num_id(rw), "hwid": body.hwid})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"Не удалось отвязать устройство: {exc}")
    return {"success": True}


@app.get("/api/panel/users/{user_id}/detail")
def panel_user_detail(user_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """полная карточка юзера для панели."""
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")

    subs = db.fetchall("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC", (user_id,))
    primary = db.fetchone(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status != 'Deleted' AND type != 'trial' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user_id,),
    ) or next((x for x in subs if x.get("status") != "Deleted"), None)

    refs = db.fetchall("SELECT * FROM users WHERE referred_by = ?", (user_id,))
    has_trial = bool(db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND type = 'trial' LIMIT 1", (user_id,)
    ))

    return {
        "id": user["id"],
        "telegram_id": user.get("telegram_id"),
        "username": user.get("username"),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "email": user.get("email"),
        "registration_date": user.get("created_at"),
        "status": subscription_status_for_user(user),  # trial|active|expired|lapsed|never|banned
        "is_banned": bool(user.get("is_banned")),
        "balance": user.get("balance", 0),
        "partner_rate": user.get("partner_rate", 25),
        "partner_balance": user.get("partner_balance", 0),
        "is_partner": bool(user.get("is_partner")),
        "ban_reason": user.get("ban_reason") if user.get("is_banned") else None,
        "blacklist_reason": blacklist.reason_for(user.get("telegram_id")) if user.get("telegram_id") else None,
        "blacklist_ignored": bool(user.get("blacklist_ignored")),
        "has_trial": has_trial,
        "referrals": [
            {
                "id": u["id"],
                "telegram_id": u.get("telegram_id"),
                "username": u.get("username"),
                "email": u.get("email"),
                "full_name": " ".join(filter(None, [u.get("first_name"), u.get("last_name")])) or None,
            }
            for u in refs
        ],
        "subscription": serialize_key(primary, user) if primary else None,
        # все подписки, включая удалённые
        "subscriptions_history": [
            {**serialize_key(x, user), "deleted_at": x.get("deleted_at"), "type": x.get("type")}
            for x in subs
        ],
        "key_blocked": bool(db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Banned' LIMIT 1", (user_id,)
        )),
        "banned_at": user.get("banned_at") if user.get("is_banned") else None,
        # блокировки, баны, предупреждения анти-абуза
        "moderation": moderation.for_user(user_id),
        "aa_warning": _aa_warning(user_id),
        "discount": active_discount_for_user(user_id),
        "promo_activations": [
            {
                "id": a["id"],
                "code": a.get("code"),
                "name": a.get("name"),
                "discount_percent": a.get("discount_percent"),
                "expires_at": a.get("expires_at"),
                "created_at": a.get("created_at"),
                "active": bool(
                    float(a.get("discount_percent") or 0) > 0
                    and (not a.get("expires_at") or parse_iso(str(a["expires_at"])) and parse_iso(str(a["expires_at"])) > utcnow())
                ),
            }
            for a in db.fetchall(
                "SELECT a.*, p.code AS code, p.name AS name FROM promocode_activations a "
                "JOIN promocodes p ON p.id = a.promocode_id WHERE a.user_id = ? ORDER BY a.id DESC",
                (user_id,),
            )
        ],
    }


def _ban_account(user: dict[str, Any], reason: Optional[str], p: dict[str, Any]) -> None:
    """блокировка аккаунта: причина, журнал, remnawave."""
    uid = int(user["id"])
    db.execute(
        "UPDATE users SET is_banned = 1, status = 'Banned', ban_reason = ?, banned_at = ? WHERE id = ?",
        (reason or "Заблокирован вручную", db.utcnow_iso(), uid),
    )
    moderation.log(uid, "ban", reason or "Заблокирован вручную", actor=p.get("actor") or "owner", actor_name=p.get("name"))
    _reject_withdrawals_on_ban(uid)
    client, rw = _rw_find_user(user)
    if client and rw:
        try:
            client.disable_user(_rw_num_id(rw))
        except Exception:  # noqa: BLE001
            pass


@app.post("/api/panel/users/{user_id}/action")
def panel_user_action(user_id: int, body: UserActionBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")
    action = str(body.action or "").upper()
    if p["role"] == "operator" and action in staffmod.OPERATOR_FORBIDDEN_ACTIONS:
        raise HTTPException(403, detail={"message": "Оператору это действие недоступно — передайте обращение админу"})
    value = body.value

    if action in ("ADD_BALANCE", "SUB_BALANCE"):
        # внутреннего баланса нет, старые действия отключены
        raise HTTPException(400, detail={"message": "Внутреннего баланса нет — используйте реферальный баланс"})
    if action == "EXTEND_SUB":
        extend_user_sub(user_id, int(float(value or 0)), body.subscription_id)
        _rw_sync_expiry(user)
    elif action == "REDUCE_SUB":
        extend_user_sub(user_id, -int(float(value or 0)), body.subscription_id)
        _rw_sync_expiry(user)
    elif action == "SET_TRAFFIC":
        gb = int(float(value or 0))
        if body.subscription_id:
            db.execute(
                "UPDATE subscriptions SET traffic_limit = ? WHERE user_id = ? AND id = ?",
                (gb, user_id, body.subscription_id),
            )
        else:
            db.execute(
                "UPDATE subscriptions SET traffic_limit = ? WHERE user_id = ?",
                (gb, user_id),
            )
        _rw_sync_traffic(user, gb)
    elif action in ("ADD_TRAFFIC", "SUB_TRAFFIC"):
        delta = int(float(value or 0)) * (1 if action == "ADD_TRAFFIC" else -1)
        row = db.fetchone(
            "SELECT id, traffic_limit FROM subscriptions WHERE user_id = ? "
            "ORDER BY id DESC LIMIT 1", (user_id,)
        )
        if row:
            new_gb = max(0, int(row.get("traffic_limit") or 0) + delta)
            db.execute("UPDATE subscriptions SET traffic_limit = ? WHERE id = ?", (new_gb, row["id"]))
            _rw_sync_traffic(user, new_gb)
    elif action == "SET_DEVICES":
        try:
            n_dev = int(float(value))
        except (TypeError, ValueError):
            raise HTTPException(400, detail={"message": "Укажите число устройств"})
        if not 1 <= n_dev <= MAX_PLAN_DEVICES:
            raise HTTPException(400, detail={"message": f"Устройств: от 1 до {MAX_PLAN_DEVICES}"})
        if body.subscription_id:
            db.execute(
                "UPDATE subscriptions SET devices_limit = ? WHERE user_id = ? AND id = ? AND status != 'Deleted'",
                (n_dev, user_id, body.subscription_id),
            )
        else:
            db.execute(
                "UPDATE subscriptions SET devices_limit = ? WHERE user_id = ? AND status != 'Deleted'",
                (n_dev, user_id),
            )
        _rw_sync_devices(user, n_dev)
    elif action == "BAN":
        _ban_account(user, (str(value).strip()[:200] or None) if value else None, p)
    elif action == "UNBAN":
        # разбан снимает и чёрный список
        db.execute("UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL, blacklist_ignored = 1 WHERE id = ?", (user_id,))
        moderation.log(user_id, "unban", (str(value).strip()[:200] or None) if value else None,
                       actor=p.get("actor") or "owner", actor_name=p.get("name"))
        sync_user_status_from_subs(user_id)
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.enable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "BLOCK_KEY":
        # блокируем ключ, не аккаунт
        kreason = (str(value).strip()[:200] or None) if value else None
        for ks in db.fetchall("SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('Active', 'Expired')", (user_id,)):
            moderation.log(user_id, "key_block", kreason, sub_id=int(ks["id"]), actor=p.get("actor") or "owner", actor_name=p.get("name"))
        db.execute("UPDATE subscriptions SET status = 'Banned', ban_reason = ?, banned_at = ? "
                   "WHERE user_id = ? AND status IN ('Active', 'Expired')",
                   (kreason or "Заблокирована вручную", db.utcnow_iso(), user_id))
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.disable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "UNBLOCK_KEY":
        # активные снова active; истёкшие станут expired при обращении
        # сбрасываем предупреждение анти-абуза
        for ks in db.fetchall("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Banned'", (user_id,)):
            moderation.log(user_id, "key_unblock", None, sub_id=int(ks["id"]), actor=p.get("actor") or "owner", actor_name=p.get("name"))
        db.execute(
            "UPDATE subscriptions SET status = 'Active', aa_warned_at = NULL, ban_reason = NULL, banned_at = NULL "
            "WHERE user_id = ? AND status = 'Banned'",
            (user_id,),
        )
        sync_user_status_from_subs(user_id)
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.enable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "SET_NO_RENEW":
        # запрет продления для текущих подписок
        try:
            flag = 1 if float(value or 0) > 0 else 0
        except (TypeError, ValueError):
            flag = 1 if str(value).lower() in ("true", "yes", "on") else 0
        db.execute(
            "UPDATE subscriptions SET no_renew = ? WHERE user_id = ? AND status IN ('Active', 'Expired', 'Banned')",
            (flag, user_id),
        )
    elif action == "RESET_SUB":
        info = reset_user_subscription(user)
        if body.notify:
            _notify_user(get_user(user_id) or user, _action_notify_text(action, value))
        return {"success": True, "subscription_url": info.get("subscription_url"),
                "user": serialize_user(get_user(user_id) or user)}
    elif action == "NOTIFY":
        delivery = _notify_user(user, str(value or ""), email=True)
        return {"success": True, "delivery": delivery, "user": serialize_user(user)}
    elif action == "SET_PARTNER_RATE":
        db.execute(
            "UPDATE users SET partner_rate = ? WHERE id = ?",
            (float(value or 0), user_id),
        )
    elif action == "SET_PARTNER_BALANCE":
        db.execute("UPDATE users SET partner_balance = ? WHERE id = ?", (float(value or 0), user_id))
    elif action == "ADD_PARTNER_BALANCE":
        db.execute("UPDATE users SET partner_balance = partner_balance + ? WHERE id = ?", (float(value or 0), user_id))
    elif action == "SUB_PARTNER_BALANCE":
        db.execute("UPDATE users SET partner_balance = MAX(0, partner_balance - ?) WHERE id = ?", (float(value or 0), user_id))
    elif action == "SET_TELEGRAM_ID":
        new_tg = int(float(value))
        clash = db.fetchone("SELECT id FROM users WHERE telegram_id = ? AND id != ?", (new_tg, user_id))
        if clash:
            other = get_user(int(clash["id"]))
            assert other is not None
            if not body.confirm:
                raise HTTPException(409, detail={"message": "Этот Telegram ID уже есть у другого аккаунта — аккаунты будут объединены",
                                                 "merge": merge_preview(user, other)})
            merge_accounts(user_id, int(other["id"]))
        db.execute("UPDATE users SET telegram_id = ? WHERE id = ?", (new_tg, user_id))
    elif action == "UNBIND_TELEGRAM":
        if not user.get("email"):
            raise HTTPException(400, detail="Нельзя отвязать Telegram: не привязан email")
        db.execute("UPDATE users SET telegram_id = NULL WHERE id = ?", (user_id,))
    elif action == "SET_EMAIL":
        new_email = str(value or "").strip().lower()
        if not _valid_email(new_email):
            raise HTTPException(400, detail="Некорректный email")
        clash = db.fetchone("SELECT id FROM users WHERE lower(email) = ? AND id != ?", (new_email, user_id))
        if clash:
            other = get_user(int(clash["id"]))
            assert other is not None
            if not body.confirm:
                raise HTTPException(409, detail={"message": "Этот email уже есть у другого аккаунта — аккаунты будут объединены",
                                                 "merge": merge_preview(user, other)})
            merge_accounts(user_id, int(other["id"]))
        db.execute("UPDATE users SET email = ? WHERE id = ?", (new_email, user_id))
        _email_changed(user.get("email"), new_email)
    elif action == "UNBIND_EMAIL":
        if not user.get("telegram_id"):
            raise HTTPException(400, detail="Нельзя отвязать email: не привязан Telegram")
        db.execute("UPDATE users SET email = NULL WHERE id = ?", (user_id,))
        _email_changed(user.get("email"), None)
    elif action == "RESET_TRIAL":
        if db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND type = 'trial' AND status = 'Active' "
            "AND (expires_at IS NULL OR expires_at > ?)", (user_id, iso()),
        ):
            raise HTTPException(400, detail={"message": "Пробная подписка ещё действует — сбросить можно после её окончания"})
        db.execute("DELETE FROM subscriptions WHERE user_id = ? AND type = 'trial'", (user_id,))
        sync_user_status_from_subs(user_id)
    elif action == "APPLY_PROMO":
        code = str(value or "").strip()
        if not code:
            raise HTTPException(400, detail="Не указан промокод")
        info = apply_promo_to_user(user_id, code, by_admin=True)
        return {"success": True, "discount": info, "user": serialize_user(get_user(user_id) or user)}
    elif action == "REMOVE_PROMO":
        code = str(value or "").strip() or None
        removed = remove_user_promo(user_id, code)
        return {"success": True, "removed": removed, "user": serialize_user(get_user(user_id) or user)}
    elif action == "DELETE_USER":
        if db.fetchone(
            "SELECT id FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'approved') LIMIT 1",
            (user_id,),
        ):
            raise HTTPException(400, detail={"message": "У пользователя есть незавершённые выводы — сначала обработайте их"})
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.delete_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
        _delete_user_keep_history(user_id)
        return {"success": True, "deleted": True}
    else:
        raise HTTPException(400, detail=f"Unknown action: {action}")

    if body.notify and action not in ("NOTIFY",):
        _notify_user(get_user(user_id) or user, _action_notify_text(action, value))

    user = get_user(user_id)
    assert user is not None
    return {"success": True, "user": serialize_user(user)}


def reset_user_subscription(user: dict[str, Any]) -> dict[str, Any]:
    """revoke в remnawave: новый ключ/shortuuid/ссылка."""
    client, rw = _rw_find_user(user)
    if not client:
        raise HTTPException(400, detail={"message": "Remnawave не настроена"})
    if not rw:
        raise HTTPException(404, detail={"message": "Пользователь не найден в Remnawave"})
    rw_id = _rw_num_id(rw)
    if rw_id is None:
        raise HTTPException(400, detail={"message": "Не удалось определить id пользователя в Remnawave"})
    old_short = rw.get("shortUuid") or rw.get("short_uuid")
    try:
        fresh_rw = unwrap_rw(client.revoke_user_subscription(rw_id))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail={"message": f"Remnawave: не удалось сбросить подписку ({exc})"})
    if not isinstance(fresh_rw, dict) or not (fresh_rw.get("shortUuid") or fresh_rw.get("short_uuid")):
        # некоторые версии отдают неполный объект, перечитываем
        _, fresh_rw = _rw_find_user(user)
    if not isinstance(fresh_rw, dict):
        raise HTTPException(502, detail={"message": "Remnawave не вернула нового пользователя"})
    new_short = fresh_rw.get("shortUuid") or fresh_rw.get("short_uuid")
    try:
        sub_url = client.subscription_url_for(fresh_rw, public_base=_env("REMWAVE_SUB_PUBLIC_URL") or None)
    except Exception:  # noqa: BLE001
        sub_url = None
    if new_short:
        db.execute(
            "UPDATE subscriptions SET short_uuid = ?, key_config = COALESCE(?, key_config) WHERE user_id = ?",
            (str(new_short), sub_url, int(user["id"])),
        )
    return {"old_short_uuid": old_short, "short_uuid": new_short, "subscription_url": sub_url}


def _delete_user_keep_history(user_id: int) -> None:
    """удаляет аккаунт, финансовую историю сохраняет."""
    conn = db.connect()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        with db.transaction() as tx:
            tx.execute("UPDATE users SET referred_by = NULL WHERE referred_by = ?", (user_id,))
            for table in ("subscriptions", "app_sessions", "promocode_activations", "onboarding_reminders",
                          "survey_invites", "survey_state", "trial_checks", "moderation_events"):
                try:
                    tx.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
                except Exception:  # noqa: BLE001 — таблицы может не быть в старой БД
                    pass
            tx.execute("DELETE FROM users WHERE id = ?", (user_id,))
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _action_notify_text(action: str, value: Any) -> str:
    a = action.upper()
    if a == "EXTEND_SUB":
        return f"✅ Ваша подписка продлена на {int(float(value or 0))} дн."
    if a == "REDUCE_SUB":
        return f"ℹ️ Срок вашей подписки уменьшен на {int(float(value or 0))} дн."
    if a in ("ADD_TRAFFIC", "SET_TRAFFIC"):
        return "ℹ️ Лимит трафика по вашей подписке обновлён."
    if a == "RESET_SUB":
        return ("🔑 Ваша ссылка на подписку обновлена — старая больше не работает.\n\n"
                "Откройте приложение BlinVPN → «Подписка» → «Добавить подписку», чтобы подключиться заново.")
    if a == "BAN":
        return "🚫 Ваш аккаунт заблокирован."
    if a == "UNBAN":
        return "✅ Ваш аккаунт разблокирован."
    return "ℹ️ Ваш аккаунт был обновлён администратором."


MASS_ACTIONS = ("MASS_ADD_DAYS", "MASS_RESET_TRIAL", "MASS_RESET_TRAFFIC")


def _mass_add_days_worker(sub_ids: list[int], days: int) -> None:
    """продление в фоне: сначала бд, потом remnawave."""
    done_users: set[int] = set()
    for sid in sub_ids:
        sub = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (sid,))
        if not sub or sub.get("status") != "Active":
            continue
        base = parse_iso(sub.get("expires_at")) or utcnow()
        if base < utcnow():
            base = utcnow()
        db.execute("UPDATE subscriptions SET expires_at = ? WHERE id = ?",
                   (iso(base + timedelta(days=days)), sid))
        uid = int(sub["user_id"])
        if uid not in done_users:
            done_users.add(uid)
            user = get_user(uid)
            if user:
                _rw_sync_expiry(user)
    print(f"[mass] +{days} дн.: продлено подписок {len(sub_ids)}, пользователей {len(done_users)}", flush=True)


class ExchangeBody(BaseModel):
    devices: int
    days: Optional[float] = None      # итоговый остаток дней вручную, иначе по расчёту
    notify: bool = True


class TransferBody(BaseModel):
    target_id: int
    notify: bool = True


def _primary_sub(user_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status != 'Deleted' AND type != 'trial' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user_id,),
    )


def _live_paid_sub(user_id: int) -> Optional[dict[str, Any]]:
    """платная подписка с оставшимся сроком."""
    sub = _primary_sub(user_id)
    if not sub or sub.get("status") != "Active":
        return None
    exp = parse_iso(sub.get("expires_at"))
    if not exp or exp <= utcnow():
        return None
    return sub


def _msk_date(dt: datetime) -> str:
    return (dt.astimezone(timezone.utc) + timedelta(hours=3)).strftime("%d.%m.%Y %H:%M")


def _dev_word(n: int) -> str:
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return "устройство"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "устройства"
    return "устройств"


def _exchange_calc(user_id: int, devices: int, days: Optional[float] = None) -> dict[str, Any]:
    sub = _live_paid_sub(user_id)
    if not sub:
        raise HTTPException(400, detail={"message": "Нет платной подписки с оставшимся сроком — менять нечего"})
    if not 1 <= int(devices) <= MAX_PLAN_DEVICES:
        raise HTTPException(400, detail={"message": f"Устройств: от 1 до {MAX_PLAN_DEVICES}"})
    now = utcnow()
    exp = parse_iso(sub["expires_at"])
    assert exp is not None
    old_dev = int(sub.get("devices_limit") or 1)
    left = (exp - now).total_seconds() / 86400
    p_old, p_new = price_for_devices(old_dev), price_for_devices(int(devices))
    # стоимость срока сохраняется при смене числа устройств
    fair = left * p_old / p_new if p_new > 0 else left
    new_left = fair if days is None else max(0.0, float(days))
    new_exp = now + timedelta(days=new_left)
    return {
        "subscription_id": sub["id"],
        "old_devices": old_dev, "new_devices": int(devices),
        "days_left": round(left, 1), "fair_days": round(fair, 1), "new_days": round(new_left, 1),
        "delta_days": round(new_left - left, 1),
        "expires_at": iso(exp), "new_expires_at": iso(new_exp),
        "price_old": p_old, "price_new": p_new,
        "value_left": round(left * p_old / 30, 2),
    }


@app.get("/api/panel/users/{user_id}/exchange")
def panel_exchange_preview(user_id: int, devices: int = Query(...), days: Optional[float] = Query(None),
                           _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not get_user(user_id):
        raise HTTPException(404, detail={"message": "Пользователь не найден"})
    return _exchange_calc(user_id, devices, days)


@app.post("/api/panel/users/{user_id}/exchange")
def panel_exchange(user_id: int, body: ExchangeBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail={"message": "Пользователь не найден"})
    calc = _exchange_calc(user_id, body.devices, body.days)
    if calc["new_devices"] == calc["old_devices"] and body.days is None:
        raise HTTPException(400, detail={"message": "Число устройств не изменилось"})
    new_exp = parse_iso(calc["new_expires_at"])
    assert new_exp is not None
    db.execute("UPDATE subscriptions SET devices_limit = ?, expires_at = ?, status = CASE WHEN status = 'Banned' THEN status ELSE 'Active' END WHERE id = ?",
               (calc["new_devices"], iso(new_exp), calc["subscription_id"]))
    client, rw = _rw_find_user(user)
    if client and rw:
        try:
            client.update_user(id=_rw_num_id(rw), hwid_device_limit=calc["new_devices"], expire_at=new_exp)
        except Exception:  # noqa: BLE001
            pass
    sync_user_status_from_subs(user_id)
    if body.notify:
        _notify_user(user, (
            "🔄 Подписка изменена\n\n"
            f"Теперь: {calc['new_devices']} {_dev_word(calc['new_devices'])}\n"
            f"Действует до: {_msk_date(new_exp)} (МСК)"
        ))
    return {"success": True, **calc}


def _user_label(u: dict[str, Any]) -> str:
    if u.get("username"):
        return f"@{u['username']}"
    if u.get("telegram_id"):
        return f"id{u['telegram_id']}"
    return u.get("email") or f"#{u['id']}"


def _transfer_plan(src: dict[str, Any], dst: dict[str, Any]) -> dict[str, Any]:
    if int(src["id"]) == int(dst["id"]):
        raise HTTPException(400, detail={"message": "Нельзя перенести подписку самому себе"})
    if dst.get("is_banned"):
        raise HTTPException(400, detail={"message": "Получатель заблокирован — сначала разбаньте его"})
    sub = _live_paid_sub(int(src["id"]))
    if not sub:
        raise HTTPException(400, detail={"message": "У пользователя нет платной подписки с оставшимся сроком"})
    exp = parse_iso(sub["expires_at"])
    assert exp is not None
    left_days = (exp - utcnow()).total_seconds() / 86400
    dst_sub = _live_paid_sub(int(dst["id"]))
    same_link = dst_sub is None and bool(dst.get("telegram_id")) and _rw_client() is not None
    if same_link:
        _, rw_src = _rw_find_user(src)
        same_link = rw_src is not None
    if same_link:
        mode, text = "move", (
            f"Подписка целиком переходит к {_user_label(dst)}: та же ссылка, {int(sub.get('devices_limit') or 1)} "
            f"{_dev_word(int(sub.get('devices_limit') or 1))}, до {_msk_date(exp)}. "
            "Приложения, куда она уже добавлена, продолжат работать. "
            f"У {_user_label(src)} подписки не останется."
        )
    else:
        dev = max(int(sub.get("devices_limit") or 1), int((dst_sub or {}).get("devices_limit") or 1))
        base = parse_iso(dst_sub["expires_at"]) if dst_sub else utcnow()
        mode, text = "merge", (
            f"{_user_label(dst)} получит оставшиеся {(f'{left_days:.1f}'.rstrip('0').rstrip('.')).replace('.', ',')} дн."
            + (f" к своей подписке (станет до {_msk_date(base + timedelta(days=left_days))})" if dst_sub else " новой подпиской")
            + f", устройств: {dev}. Ссылка будет у него своя — подписку нужно добавить в приложение заново. "
            f"Подписка {_user_label(src)} отключится."
        )
    return {"mode": mode, "text": text, "subscription_id": sub["id"], "days_left": round(left_days, 1),
            "devices": int(sub.get("devices_limit") or 1), "expires_at": sub["expires_at"],
            "target": {"id": dst["id"], "label": _user_label(dst), "has_sub": bool(dst_sub)}}


@app.get("/api/panel/users/{user_id}/transfer")
def panel_transfer_preview(user_id: int, target_id: int = Query(...), _: dict = Depends(require_panel)) -> dict[str, Any]:
    src, dst = get_user(user_id), get_user(target_id)
    if not src or not dst:
        raise HTTPException(404, detail={"message": "Пользователь не найден"})
    return _transfer_plan(src, dst)


@app.post("/api/panel/users/{user_id}/transfer")
def panel_transfer(user_id: int, body: TransferBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    src, dst = get_user(user_id), get_user(body.target_id)
    if not src or not dst:
        raise HTTPException(404, detail={"message": "Пользователь не найден"})
    plan = _transfer_plan(src, dst)
    sub = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (plan["subscription_id"],))
    assert sub is not None
    now = utcnow()
    exp = parse_iso(sub["expires_at"]) or now
    client = _rw_client()

    if plan["mode"] == "move":
        _, rw_src = _rw_find_user(src)
        _, rw_dst = _rw_find_user(dst)
        if client and rw_dst and rw_src and _rw_num_id(rw_dst) != _rw_num_id(rw_src):
            # старый rw-юзер у получателя мешает, удаляем
            try:
                client.delete_user(_rw_num_id(rw_dst))
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(502, detail={"message": f"Remnawave: не удалось удалить старого пользователя получателя ({exc})"})
        patch: dict[str, Any] = {"id": _rw_num_id(rw_src), "telegram_id": int(dst["telegram_id"]), "description": str(int(dst["id"]))}
        if dst.get("email"):
            patch["email"] = dst["email"]
        try:
            client.update_user(**patch)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail={"message": f"Remnawave: не удалось передать подписку ({exc})"})
        with db.transaction():
            db.execute("UPDATE subscriptions SET status = 'Deleted', deleted_at = ? WHERE user_id = ? AND status != 'Deleted'",
                       (iso(now), dst["id"]))
            db.execute("UPDATE subscriptions SET user_id = ? WHERE id = ?", (dst["id"], sub["id"]))
    else:
        left = max(timedelta(0), exp - now)
        dst_sub = _live_paid_sub(int(dst["id"]))
        dev = max(int(sub.get("devices_limit") or 1), int((dst_sub or {}).get("devices_limit") or 1))
        if dst_sub:
            new_exp = (parse_iso(dst_sub["expires_at"]) or now) + left
            db.execute("UPDATE subscriptions SET expires_at = ?, devices_limit = ? WHERE id = ?", (iso(new_exp), dev, dst_sub["id"]))
        else:
            extend_user_sub(int(dst["id"]), max(1, math.ceil(left.total_seconds() / 86400)))
            fresh = _primary_sub(int(dst["id"]))
            if fresh:
                new_exp = now + left
                db.execute("UPDATE subscriptions SET expires_at = ?, devices_limit = ?, status = 'Active' WHERE id = ?",
                           (iso(new_exp), dev, fresh["id"]))
        dst_now = get_user(int(dst["id"])) or dst
        _rw_sync_expiry(dst_now)
        _rw_sync_devices(dst_now, dev)
        db.execute("UPDATE subscriptions SET status = 'Deleted', deleted_at = ?, expires_at = ? WHERE id = ?",
                   (iso(now), iso(now), sub["id"]))
        _rw_set_enabled(src, False)

    sync_user_status_from_subs(int(src["id"]))
    sync_user_status_from_subs(int(dst["id"]))
    if body.notify:
        _notify_user(get_user(int(dst["id"])) or dst, (
            "🎁 Вам передали подписку\n\n"
            + ("Откройте приложение — подписка уже работает." if plan["mode"] == "move"
               else "Добавьте подписку в приложение заново: в боте нажмите «Подписка» → «Добавить подписку».")
        ))
        _notify_user(src, f"🔁 Ваша подписка передана пользователю {_user_label(dst)}.")
    return {"success": True, **plan}


def _live_any_sub(user_id: int) -> Optional[dict[str, Any]]:
    """действующая подписка с оставшимся сроком."""
    now_iso = iso()
    return db.fetchone(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'Active' AND expires_at > ? "
        "ORDER BY CASE WHEN type = 'trial' THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user_id, now_iso),
    )


def _sub_left(sub: Optional[dict[str, Any]]) -> timedelta:
    if not sub:
        return timedelta(0)
    exp = parse_iso(sub.get("expires_at"))
    return max(timedelta(0), (exp - utcnow())) if exp else timedelta(0)


def _days_str(td: timedelta) -> str:
    d = td.total_seconds() / 86400
    if d <= 0:
        return "0 дн."
    return (f"{d:.1f}".rstrip("0").rstrip(".").replace(".", ",")) + " дн."


def _merged_left(ks: Optional[dict[str, Any]], ds: Optional[dict[str, Any]]) -> timedelta:
    """что останется после объединения (оплата складывается, trial нет)."""
    subs = [x for x in (ks, ds) if x]
    if not subs:
        return timedelta(0)
    paid = [_sub_left(x) for x in subs if x.get("type") != "trial"]
    return sum(paid, timedelta(0)) if paid else max(_sub_left(x) for x in subs)


def merge_preview(keep: dict[str, Any], drop: dict[str, Any]) -> dict[str, Any]:
    """превью объединения для панели и мини-приложения."""
    if int(keep["id"]) == int(drop["id"]):
        raise HTTPException(400, detail={"message": "Это тот же аккаунт"})
    # заблокированный аккаунт/ключ объединять нельзя
    if subscription_status_for_user(drop) in ("banned", "blocked"):
        raise HTTPException(409, detail={"message": "Второй аккаунт заблокирован — объединить нельзя. Напишите в поддержку."})
    if subscription_status_for_user(keep) in ("banned", "blocked"):
        raise HTTPException(409, detail={"message": "Этот аккаунт заблокирован — объединить нельзя. Напишите в поддержку."})
    ks, ds = _live_any_sub(int(keep["id"])), _live_any_sub(int(drop["id"]))
    kl, dl = _sub_left(ks), _sub_left(ds)
    kd = int((ks or {}).get("devices_limit") or 0)
    dd = int((ds or {}).get("devices_limit") or 0)
    total = _merged_left(ks, ds)
    devices = max(kd, dd)
    fmt_side = lambda s, left, dev: (f"{_days_str(left)}, {dev} {_dev_word(dev)}" if s else "нет подписки")
    lines = [
        f"Этот аккаунт: {fmt_side(ks, kl, kd)}",
        f"Второй аккаунт: {fmt_side(ds, dl, dd)}",
    ]
    if ks or ds:
        lines.append(f"Станет: {_days_str(total)}, {devices} {_dev_word(devices)}")
    bal = float(drop.get("partner_balance") or 0)
    if bal > 0:
        lines.append(f"Реферальный баланс второго аккаунта ({bal:.2f} ₽) перейдёт сюда".replace(".00", ""))
    # ссылка подписки drop перестанет работать, если keep уже имеет свою
    link_changes = bool(ks and ds)
    if link_changes:
        lines.append("Подписку второго аккаунта нужно будет заново добавить в VPN-приложение")
    lines.append("Платежи, история и друзья переедут сюда, второй аккаунт удалится")
    return {
        "merge": True,
        "other": {"id": drop["id"], "label": _user_label(drop)},
        "keep": {"days": round(kl.total_seconds() / 86400, 1), "devices": kd, "has_sub": bool(ks)},
        "drop": {"days": round(dl.total_seconds() / 86400, 1), "devices": dd, "has_sub": bool(ds)},
        "result": {"days": round(total.total_seconds() / 86400, 1), "devices": devices},
        "link_changes": link_changes,
        "balance": round(bal, 2),
        "text": "\n".join(lines),
    }


def merge_accounts(keep_id: int, drop_id: int) -> dict[str, Any]:
    """переносит всё с drop на keep и удаляет drop."""
    keep, drop = get_user(keep_id), get_user(drop_id)
    if not keep or not drop:
        raise HTTPException(404, detail={"message": "Пользователь не найден"})
    preview = merge_preview(keep, drop)
    now = utcnow()
    ks, ds = _live_any_sub(keep_id), _live_any_sub(drop_id)
    client, rw_keep = _rw_find_user(keep)
    _, rw_drop = _rw_find_user(drop)

    final_sub_id: Optional[int] = None
    with db.transaction():
        if ks and ds:
            # оплаченное время складывается, пробное нет
            new_exp = now + _merged_left(ks, ds)
            dev = max(int(ks.get("devices_limit") or 1), int(ds.get("devices_limit") or 1))
            to_paid = ks.get("type") == "trial" and ds.get("type") != "trial"
            # запрет продления, если был хотя бы на одной
            no_renew = 1 if (ks.get("no_renew") or ds.get("no_renew")) else 0
            db.execute("UPDATE subscriptions SET no_renew = ? WHERE id = ?", (no_renew, ks["id"]))
            db.execute(
                "UPDATE subscriptions SET expires_at = ?, devices_limit = ?, status = 'Active'"
                + (", type = 'vpn', traffic_limit = ?, squads_json = ?" if to_paid else "") + " WHERE id = ?",
                ((iso(new_exp), dev, ds.get("traffic_limit"), ds.get("squads_json"), ks["id"]) if to_paid
                 else (iso(new_exp), dev, ks["id"])),
            )
            db.execute("UPDATE subscriptions SET status = 'Deleted', deleted_at = ? WHERE id = ?", (iso(now), ds["id"]))
            final_sub_id = int(ks["id"])
        elif ds:
            # подписка только у drop: переезжает целиком
            db.execute("UPDATE subscriptions SET status = 'Deleted', deleted_at = ? "
                       "WHERE user_id = ? AND status != 'Deleted'", (iso(now), keep_id))
            final_sub_id = int(ds["id"])
        elif ks:
            final_sub_id = int(ks["id"])
        # переписку поддержки сливаем в один чат
        kc = db.fetchone("SELECT id FROM support_chats WHERE user_id = ?", (keep_id,))
        dc = db.fetchone("SELECT id FROM support_chats WHERE user_id = ?", (drop_id,))
        if kc and dc:
            # обращения drop после keep; открытым остаётся одно
            shift = int(db.fetchone("SELECT COALESCE(MAX(number), 0) AS n FROM support_tickets WHERE chat_id = ?", (kc["id"],))["n"])
            db.execute("UPDATE support_tickets SET chat_id = ?, number = number + ? WHERE chat_id = ?", (kc["id"], shift, dc["id"]))
            kopen = db.fetchone("SELECT open_ticket_id FROM support_chats WHERE id = ?", (kc["id"],))["open_ticket_id"]
            dopen = db.fetchone("SELECT open_ticket_id FROM support_chats WHERE id = ?", (dc["id"],))["open_ticket_id"]
            if dopen and kopen:
                db.execute("UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by = 'объединение' WHERE id = ?",
                           (iso(), dopen))
            elif dopen:
                db.execute("UPDATE support_chats SET open_ticket_id = ? WHERE id = ?", (dopen, kc["id"]))
            db.execute("UPDATE support_messages SET chat_id = ? WHERE chat_id = ?", (kc["id"], dc["id"]))
            db.execute("UPDATE support_files SET chat_id = ? WHERE chat_id = ?", (kc["id"], dc["id"]))
            db.execute("UPDATE support_chats SET unread_admin = unread_admin + (SELECT unread_admin FROM support_chats "
                       "WHERE id = ?), last_message_at = MAX(COALESCE(last_message_at, ''), COALESCE((SELECT last_message_at "
                       "FROM support_chats WHERE id = ?), '')) WHERE id = ?", (dc["id"], dc["id"], kc["id"]))
            db.execute("DELETE FROM support_chats WHERE id = ?", (dc["id"],))
        # строки drop -> keep
        tables = [r["name"] for r in db.fetchall("SELECT name FROM sqlite_master WHERE type = 'table'")]
        for t in tables:
            cols = {c["name"] for c in db.fetchall(f"PRAGMA table_info({t})")}
            if "user_id" in cols and t != "users":
                db.execute(f"UPDATE OR IGNORE {t} SET user_id = ? WHERE user_id = ?", (keep_id, drop_id))
                db.execute(f"DELETE FROM {t} WHERE user_id = ?", (drop_id,))
        db.execute("UPDATE users SET referred_by = ? WHERE referred_by = ? AND id != ?", (keep_id, drop_id, keep_id))
        db.execute(
            "UPDATE users SET balance = balance + ?, partner_balance = partner_balance + ?, "
            "partner_rate = MAX(partner_rate, ?), is_partner = MAX(is_partner, ?), "
            "terms_accepted_at = COALESCE(terms_accepted_at, ?), "
            "referred_by = COALESCE(referred_by, CASE WHEN ? = id THEN NULL ELSE ? END), "
            "tracking_code = COALESCE(tracking_code, ?) WHERE id = ?",
            (float(drop.get("balance") or 0), float(drop.get("partner_balance") or 0),
             float(drop.get("partner_rate") or 0), int(drop.get("is_partner") or 0), drop.get("terms_accepted_at"),
             drop.get("referred_by"), drop.get("referred_by"), drop.get("tracking_code"), keep_id),
        )
        drop_tg, drop_email = drop.get("telegram_id"), drop.get("email")
        db.execute("DELETE FROM users WHERE id = ?", (drop_id,))
        # недостающие способы входа с drop
        if drop_tg and not keep.get("telegram_id"):
            db.execute("UPDATE users SET telegram_id = ?, username = COALESCE(username, ?) WHERE id = ?",
                       (drop_tg, drop.get("username"), keep_id))
        if drop_email and not keep.get("email"):
            db.execute("UPDATE users SET email = ? WHERE id = ?", (drop_email, keep_id))

    # remnawave: один юзер на итоговую подписку
    fresh = get_user(keep_id) or keep
    if client:
        try:
            final = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (final_sub_id,)) if final_sub_id else None
            keep_rw_id = _rw_num_id(rw_keep) if rw_keep else None
            drop_rw_id = _rw_num_id(rw_drop) if rw_drop else None
            if final and ds and not ks and drop_rw_id and not keep_rw_id:
                # подписка у drop: переводим его rw-юзера на keep
                patch: dict[str, Any] = {"id": drop_rw_id, "description": str(keep_id)}
                if fresh.get("telegram_id"):
                    patch["telegram_id"] = int(fresh["telegram_id"])
                if fresh.get("email"):
                    patch["email"] = fresh["email"]
                client.update_user(**patch)
            else:
                if drop_rw_id and drop_rw_id != keep_rw_id:
                    client.delete_user(drop_rw_id)
                if final and keep_rw_id:
                    client.update_user(id=keep_rw_id, expire_at=parse_iso(final["expires_at"]),
                                       hwid_device_limit=int(final.get("devices_limit") or 1), status="ACTIVE",
                                       email=fresh.get("email") or None)
                elif final and not keep_rw_id:
                    _rw_sync_expiry(fresh)
        except Exception as exc:  # noqa: BLE001
            forum.report_error("Объединение аккаунтов: не удалось обновить Remnawave",
                               f"keep={keep_id} drop={drop_id}: {type(exc).__name__}: {exc}")
    sync_user_status_from_subs(keep_id)
    # мог получить tg drop: ещё раз чёрный список
    _enforce_blacklist(get_user(keep_id) or fresh)
    try:
        forum.send("errors", f"🔗 Аккаунты объединены: #{drop_id} → {forum.user_link(keep_id)}")
    except Exception:  # noqa: BLE001
        pass
    return {"merged": True, **preview}


@app.post("/api/panel/users/mass-action")
def panel_mass_action(body: MassActionBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    action = body.action.upper()
    if action not in MASS_ACTIONS:
        raise HTTPException(400, detail={"message": f"Неизвестное массовое действие: {action}"})

    if action == "MASS_ADD_DAYS":
        try:
            days = int(float(body.value))
        except (TypeError, ValueError):
            raise HTTPException(400, detail={"message": "Укажите число дней"})
        if not 1 <= days <= 365:
            raise HTTPException(400, detail={"message": "Дней: от 1 до 365"})
        # только действующие подписки; истёкшие не оживляем
        rows = db.fetchall(
            "SELECT id FROM subscriptions WHERE status = 'Active' AND (expires_at IS NULL OR expires_at > ?)",
            (iso(),),
        )
        ids = [int(r["id"]) for r in rows]
        threading.Thread(target=_mass_add_days_worker, args=(ids, days), daemon=True).start()
        return {"success": True, "affected": len(ids), "background": True,
                "message": f"Продлеваем {len(ids)} подписок на {days} дн. — выполняется в фоне"}

    if action == "MASS_RESET_TRAFFIC":
        client = _rw_client()
        if not client:
            raise HTTPException(400, detail={"message": "Remnawave не настроена"})
        try:
            client.bulk_all_reset_traffic()
        except Exception as exc:  # noqa: BLE001
            forum.report_error("Массовый сброс трафика не удался", f"{type(exc).__name__}: {exc}")
            raise HTTPException(502, detail={"message": "Remnawave не смогла сбросить трафик"})
        cur = db.execute("UPDATE subscriptions SET traffic_used = 0 WHERE status != 'Deleted'")
        # трафик снова есть: снимаем grace по трафику
        threading.Thread(target=grace.end_traffic_all, name="grace-traffic-end", daemon=True).start()
        return {"success": True, "affected": cur.rowcount or 0}

    # mass_reset_trial: разрешить пробный снова после окончания
    # действующие пробные не трогаем
    now_iso = iso()
    rows = db.fetchall(
        "SELECT DISTINCT user_id FROM subscriptions WHERE type = 'trial' "
        "AND NOT (status = 'Active' AND (expires_at IS NULL OR expires_at > ?))",
        (now_iso,),
    )
    db.execute(
        "DELETE FROM subscriptions WHERE type = 'trial' "
        "AND NOT (status = 'Active' AND (expires_at IS NULL OR expires_at > ?))",
        (now_iso,),
    )
    for r in rows:
        sync_user_status_from_subs(int(r["user_id"]))
    return {"success": True, "affected": len(rows)}


@app.get("/api/panel/keys")
def panel_keys(
    limit: int = Query(100),
    offset: int = Query(0),
    page: int = Query(1),
    search: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    _: dict = Depends(require_panel),
) -> dict[str, Any]:
    items = db.fetchall("SELECT * FROM subscriptions ORDER BY id DESC")
    if status and status != "all":
        items = [k for k in items if str(k.get("status", "")).lower() == status.lower()]
    needle = (search or q or "").lower().lstrip("@")
    serialized: list[dict[str, Any]] = []
    for k in items:
        ser = serialize_key(k)
        if needle:
            hay = " ".join(
                str(x or "")
                for x in (ser.get("key_uuid"), ser.get("username"), ser.get("user_id"), ser.get("short_uuid"))
            ).lower()
            if needle not in hay:
                continue
        serialized.append(ser)
    page_data = paginate(serialized, limit, offset if offset else (page - 1) * limit)
    return {"items": page_data["items"], "total": page_data["total"]}


@app.post("/api/panel/keys")
def panel_create_key(body: CreateKeyBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not get_user(body.user_id):
        raise HTTPException(404, detail="User not found")
    key = create_key(
        user_id=body.user_id,
        days=body.days,
        traffic=body.traffic,
        devices=body.devices,
        is_trial=body.is_trial,
        is_forever=body.is_forever,
        squads=body.squads,
        custom_name=body.custom_name,
    )
    return serialize_key(key)


@app.post("/api/panel/keys/{key_id}/block")
def panel_block_key(key_id: int, body: BlockKeyBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    key = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (key_id,))
    if not key:
        raise HTTPException(404, detail="Key not found")
    # та же запись, что block_key/unblock_key в карточке
    if body.blocked:
        db.execute("UPDATE subscriptions SET status = 'Banned', ban_reason = 'Заблокирована вручную', banned_at = ? WHERE id = ?",
                   (db.utcnow_iso(), key_id))
        moderation.log(int(key["user_id"]), "key_block", "Заблокирована вручную", sub_id=int(key_id),
                       actor=p.get("actor") or "owner", actor_name=p.get("name"))
    else:
        db.execute("UPDATE subscriptions SET status = 'Active', ban_reason = NULL, banned_at = NULL, aa_warned_at = NULL WHERE id = ?",
                   (key_id,))
        if key.get("status") == "Banned":
            moderation.log(int(key["user_id"]), "key_unblock", None, sub_id=int(key_id),
                           actor=p.get("actor") or "owner", actor_name=p.get("name"))
    owner = get_user(int(key["user_id"]))
    if owner:
        _rw_set_enabled(owner, not body.blocked)
        sync_user_status_from_subs(int(owner["id"]))
    key = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (key_id,))
    assert key is not None
    return serialize_key(key)


@app.get("/api/panel/mailing/stats")
def panel_mailing_stats(_: dict = Depends(require_panel)) -> dict[str, Any]:
    row = db.fetchone("SELECT COALESCE(SUM(sent_count), 0) AS s FROM mailings")
    return {"totalSent": int(row["s"]) if row else 0}


@app.get("/api/panel/mailing/history")
def panel_mailing_history(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM mailings ORDER BY id DESC")
    return [serialize_mailing(m) for m in items]


def _mailing_recipients(target: str) -> list[dict[str, Any]]:
    recipients = db.fetchall("SELECT * FROM users WHERE COALESCE(is_banned, 0) = 0")
    if target == "active":
        recipients = [u for u in recipients if subscription_status_for_user(u) in ("active", "trial")]
    elif target == "expired":
        recipients = [u for u in recipients if subscription_status_for_user(u) == "expired"]
    elif target == "no_subscription":
        recipients = [u for u in recipients if subscription_status_for_user(u) in ("never", "lapsed")]
    return recipients


def _email_html_from_message(msg: str) -> str:
    """разметка рассылки -> html для письма."""
    import re
    text = _esc_html(msg)
    text = re.sub(r"!\[(\d+)\]", "", text)  # премиум-эмодзи в письме не нужны
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text, flags=re.S)
    text = re.sub(r"`([^`]+?)`", r"<code>\1</code>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", text, flags=re.S)
    return text.replace("\n", "<br>")


# параллельная рассылка, общий лимитер (~30 msg/s)
BROADCAST_RATE = max(1, _env_int("BROADCAST_RATE", 25))       # сообщений/сек
BROADCAST_WORKERS = max(1, _env_int("BROADCAST_WORKERS", 8))  # параллельных отправок


class _RateLimiter:
    """потокобезопасный лимитер с адаптацией под 429."""

    def __init__(self, rate_per_sec: float, min_rate: float = 5.0) -> None:
        base = 1.0 / max(0.1, float(rate_per_sec))
        self._min_interval = base                       # самый быстрый темп (база)
        self._max_interval = 1.0 / max(0.1, float(min_rate))  # самый медленный
        self._interval = base
        self._lock = threading.Lock()
        self._next = time.monotonic()
        self._ok_since = 0

    def acquire(self) -> None:
        with self._lock:
            now = time.monotonic()
            start = self._next if self._next > now else now
            self._next = start + self._interval
            wait = start - now
            # плавное восстановление скорости после успехов
            self._ok_since += 1
            if self._ok_since >= 300 and self._interval > self._min_interval:
                self._interval = max(self._min_interval, self._interval * 0.9)
                self._ok_since = 0
        if wait > 0:
            time.sleep(wait)

    def throttle(self, retry_after: Optional[float] = None) -> None:
        """telegram 429: снижаем скорость, пауза retry_after."""
        with self._lock:
            self._interval = min(self._max_interval, self._interval * 1.5)
            self._ok_since = 0
            if retry_after:
                try:
                    self._next = max(self._next, time.monotonic() + min(float(retry_after), 30))
                except (TypeError, ValueError):
                    pass

    def current_rate(self) -> float:
        return round(1.0 / self._interval, 1)


def _deliver_mailing(mailing_id: int, body: MailingBody, recipients: list[dict[str, Any]], channels: list[str]) -> None:
    """фоновая доставка рассылки пулом воркеров."""
    import concurrent.futures as _fut

    do_tg = "telegram" in channels
    do_email = "email" in channels
    subject = (body.subject or body.title or "BlinVPN").strip() or "BlinVPN"
    email_html = _email_html_from_message(body.message) if do_email else ""

    limiter = _RateLimiter(BROADCAST_RATE)
    counter = {"sent": 0, "done": 0}
    lock = threading.Lock()
    total = len(recipients)

    def _send_one(u: dict[str, Any]) -> None:
        if mailing_id in _MAILING_CANCELLED:
            return  # рассылку удалили во время отправки
        ok_any = False
        if do_tg and u.get("telegram_id"):
            limiter.acquire()  # общий темп только для telegram
            chat_id = int(u["telegram_id"])
            msg_id = notifier.send_broadcast_message(
                chat_id, body.message,
                image_url=body.image_url, button_type=body.button_type,
                button_value=body.button_value, miniapp_url=MINIAPP_URL, bot_username=BOT_USERNAME,
                on_throttle=limiter.throttle,  # 429 -> авто-снижение скорости
            )
            if msg_id is not None:
                ok_any = True
                if msg_id:
                    # запоминаем msg_id для последующего удаления
                    try:
                        db.execute(
                            "INSERT INTO mailing_messages (mailing_id, chat_id, message_id, sent_at) VALUES (?, ?, ?, ?)",
                            (mailing_id, chat_id, int(msg_id), db.utcnow_iso()),
                        )
                    except Exception:  # noqa: BLE001
                        pass
        if do_email and u.get("email"):
            try:
                ok, _err = mailer.send_broadcast(str(u["email"]), subject, email_html, body_text=body.message)
                ok_any = ok or ok_any
            except Exception:  # noqa: BLE001
                pass
        with lock:
            if ok_any:
                counter["sent"] += 1
            counter["done"] += 1
            done = counter["done"]
            sent = counter["sent"]
        # прогресс пишем нечасто
        if done % 200 == 0 or done == total:
            try:
                db.execute("UPDATE mailings SET sent_count = ? WHERE id = ?", (sent, mailing_id))
            except Exception:  # noqa: BLE001
                pass

    with _fut.ThreadPoolExecutor(max_workers=BROADCAST_WORKERS) as pool:
        list(pool.map(_send_one, recipients))

    if mailing_id in _MAILING_CANCELLED:
        return  # удалением займётся _purge_mailing
    db.execute("UPDATE mailings SET sent_count = ?, status = 'Completed' WHERE id = ?",
               (counter["sent"], mailing_id))


# удаляемые рассылки: отправку стопаем
_MAILING_CANCELLED: set[int] = set()
_MAILING_THREADS: dict[int, "threading.Thread"] = {}


def _purge_mailing(mailing_id: int) -> None:
    """удаляет сообщения рассылки в telegram, потом запись."""
    import concurrent.futures as _fut

    # ждём остановку отправки, чтобы не пропустить хвост
    t = _MAILING_THREADS.get(mailing_id)
    if t is not None and t.is_alive():
        t.join(timeout=120)

    rows = db.fetchall(
        "SELECT chat_id, message_id FROM mailing_messages WHERE mailing_id = ?", (mailing_id,)
    )
    limiter = _RateLimiter(BROADCAST_RATE)
    counter = {"ok": 0, "fail": 0}
    lock = threading.Lock()

    def _del_one(r: dict[str, Any]) -> None:
        limiter.acquire()
        ok = notifier.delete_message(int(r["chat_id"]), int(r["message_id"]), on_throttle=limiter.throttle)
        with lock:
            counter["ok" if ok else "fail"] += 1

    if rows:
        with _fut.ThreadPoolExecutor(max_workers=BROADCAST_WORKERS) as pool:
            list(pool.map(_del_one, rows))

    db.execute("DELETE FROM mailing_messages WHERE mailing_id = ?", (mailing_id,))
    db.execute("DELETE FROM mailings WHERE id = ?", (mailing_id,))
    _MAILING_CANCELLED.discard(mailing_id)
    _MAILING_THREADS.pop(mailing_id, None)
    print(f"[mailing] рассылка #{mailing_id} удалена: сообщений убрано {counter['ok']}, "
          f"не удалось {counter['fail']} (старше 48 ч или чат удалён)", flush=True)


@app.post("/api/panel/mailing")
def panel_mailing_create(body: MailingBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not (body.message or "").strip():
        raise HTTPException(400, detail={"message": "Пустое сообщение"})
    channels = [c for c in (body.channels or ["telegram"]) if c in ("telegram", "email")] or ["telegram"]
    if "email" in channels and not mailer.is_configured():
        raise HTTPException(400, detail={"message": "Почта не настроена (Настройки → Почта)"})

    recipients = _mailing_recipients(body.target_users)
    # кого реально достанем выбранными каналами
    reach = [
        u for u in recipients
        if ("telegram" in channels and u.get("telegram_id")) or ("email" in channels and u.get("email"))
    ]

    title = body.title or (body.message[:40] + ("…" if len(body.message) > 40 else ""))
    now = db.utcnow_iso()
    status = "Sending" if reach else "Completed"
    db.execute(
        "INSERT INTO mailings (title, message_text, target_users, status, sent_count, "
        "button_type, button_value, image_url, channel, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
        (
            title, body.message, body.target_users, status,
            body.button_type, body.button_value, body.image_url,
            "+".join(channels), now,
        ),
    )
    mailing_id = db.last_id()

    if reach:
        t = threading.Thread(
            target=_deliver_mailing,
            args=(mailing_id, body, reach, channels),
            name=f"mailing-{mailing_id}",
            daemon=True,
        )
        _MAILING_THREADS[mailing_id] = t
        t.start()

    item = db.fetchone("SELECT * FROM mailings WHERE id = ?", (mailing_id,))
    assert item is not None
    result = serialize_mailing(item)
    result["recipients_total"] = len(reach)
    return result


@app.delete("/api/panel/mailing/{mailing_id}")
def panel_mailing_delete(mailing_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    row = db.fetchone("SELECT id, status, channel FROM mailings WHERE id = ?", (mailing_id,))
    if not row:
        raise HTTPException(404, detail="Mailing not found")
    if row.get("status") == "Deleting":
        return {"success": True, "status": "Deleting"}
    tg_count = db.fetchone(
        "SELECT COUNT(*) AS n FROM mailing_messages WHERE mailing_id = ?", (mailing_id,)
    )
    _MAILING_CANCELLED.add(mailing_id)
    db.execute("UPDATE mailings SET status = 'Deleting' WHERE id = ?", (mailing_id,))
    threading.Thread(target=_purge_mailing, args=(mailing_id,), name=f"mailing-purge-{mailing_id}",
                     daemon=True).start()
    return {
        "success": True,
        "status": "Deleting",
        "telegram_messages": int(tg_count["n"]) if tg_count else 0,
        "had_email": "email" in str(row.get("channel") or ""),
    }


@app.get("/api/panel/promocodes/stats")
def panel_promo_stats(_: dict = Depends(require_panel)) -> dict[str, Any]:
    items = db.fetchall("SELECT * FROM promocodes")
    return {
        "total": len(items),
        "totalUses": sum(int(p.get("uses_count") or 0) for p in items),
        "activeCount": sum(1 for p in items if p.get("is_active")),
    }


@app.get("/api/panel/promocodes")
def panel_promocodes(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM promocodes ORDER BY id DESC")
    # системные (персональные от бота) в панели не показываем
    return [serialize_promocode(p) for p in items if str(p.get("code") or "").upper() not in services.SYSTEM_PROMO_CODES]


@app.post("/api/panel/promocodes")
def panel_promo_create(body: PromocodeBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO promocodes (code, name, type, value, uses_limit, uses_count, expires_at, is_active, created_at) "
        "VALUES (?, ?, 'discount', ?, ?, 0, ?, ?, ?)",
        (
            body.code.upper().strip(),
            (body.name or "").strip() or None,
            float(body.value),
            body.uses_limit,
            body.expires_at,
            1 if _as_bool(body.is_active, True) else 0,
            now,
        ),
    )
    item = db.fetchone("SELECT * FROM promocodes WHERE id = ?", (db.last_id(),))
    assert item is not None
    return serialize_promocode(item)


@app.put("/api/panel/promocodes/{promo_id}")
def panel_promo_update(promo_id: int, body: PromocodeBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    item = db.fetchone("SELECT * FROM promocodes WHERE id = ?", (promo_id,))
    if not item:
        raise HTTPException(404, detail="Promocode not found")
    db.execute(
        "UPDATE promocodes SET code = ?, name = ?, type = 'discount', value = ?, uses_limit = ?, "
        "expires_at = ?, is_active = ? WHERE id = ?",
        (
            body.code.upper().strip(),
            (body.name or "").strip() or None,
            float(body.value),
            body.uses_limit,
            body.expires_at,
            1 if _as_bool(body.is_active, bool(item.get("is_active"))) else 0,
            promo_id,
        ),
    )
    item = db.fetchone("SELECT * FROM promocodes WHERE id = ?", (promo_id,))
    assert item is not None
    return serialize_promocode(item)


@app.delete("/api/panel/promocodes/{promo_id}")
def panel_promo_delete(promo_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    item = db.fetchone("SELECT id FROM promocodes WHERE id = ?", (promo_id,))
    if not item:
        raise HTTPException(404, detail="Promocode not found")
    db.execute("DELETE FROM promocodes WHERE id = ?", (promo_id,))
    return {"success": True}


@app.get("/api/panel/promotions")
def panel_promotions(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM promotions ORDER BY id DESC")
    return [serialize_promotion(p) for p in items]


@app.post("/api/panel/promotions")
def panel_promo_campaign_create(body: PromotionBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    # пополнение убрано, только global_discount
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO promotions (name, type, value, min_amount, max_amount, uses_limit, uses_count, "
        "expires_at, is_active, created_at) VALUES (?, 'global_discount', ?, NULL, NULL, ?, 0, ?, ?, ?)",
        (
            body.name or "Скидка",
            float(body.value or 0),
            body.uses_limit,
            body.expires_at,
            1 if (True if body.is_active is None else bool(body.is_active)) else 0,
            now,
        ),
    )
    item = db.fetchone("SELECT * FROM promotions WHERE id = ?", (db.last_id(),))
    assert item is not None
    return serialize_promotion(item)


@app.put("/api/panel/promotions/{promo_id}")
def panel_promo_campaign_update(
    promo_id: int, body: PromotionBody, _: dict = Depends(require_panel)
) -> dict[str, Any]:
    item = db.fetchone("SELECT * FROM promotions WHERE id = ?", (promo_id,))
    if not item:
        raise HTTPException(404, detail="Promotion not found")
    data = body.model_dump(exclude_unset=True)
    fields = []
    params: list[Any] = []
    for k, v in data.items():
        if k == "is_active":
            fields.append("is_active = ?")
            params.append(1 if bool(v) else 0)
        elif k == "type":
            # тип всегда global_discount
            fields.append("type = ?")
            params.append("global_discount")
        elif k in ("min_amount", "max_amount"):
            continue  # не применимо к глобальной скидке
        elif v is not None:
            fields.append(f"{k} = ?")
            params.append(v)
    if fields:
        params.append(promo_id)
        db.execute(f"UPDATE promotions SET {', '.join(fields)} WHERE id = ?", params)
    item = db.fetchone("SELECT * FROM promotions WHERE id = ?", (promo_id,))
    assert item is not None
    return serialize_promotion(item)


@app.delete("/api/panel/promotions/{promo_id}")
def panel_promo_campaign_delete(promo_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    item = db.fetchone("SELECT id FROM promotions WHERE id = ?", (promo_id,))
    if not item:
        raise HTTPException(404, detail="Promotion not found")
    db.execute("DELETE FROM promotions WHERE id = ?", (promo_id,))
    return {"success": True}


def _tracking_url(code: str) -> str:
    return f"https://t.me/{BOT_USERNAME}?start=trk_{code}"


@app.get("/api/panel/tracking-links/stats")
def panel_tracking_stats(_: dict = Depends(require_panel)) -> dict[str, Any]:
    links = db.fetchall("SELECT * FROM tracking_links")
    return {
        "total_links": sum(1 for l in links if l.get("is_active")),
        "total_clicks": sum(int(l.get("clicks") or 0) for l in links),
        "total_unique_users": sum(int(l.get("unique_users") or 0) for l in links),
        "total_revenue": sum(float(l.get("total_revenue") or 0) for l in links),
        "paid_users": sum(int(l.get("paid_users") or 0) for l in links),
    }


@app.get("/api/panel/tracking-links")
def panel_tracking_list(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM tracking_links ORDER BY id DESC")
    return [serialize_tracking(l) for l in items]


@app.get("/api/panel/tracking-links/{link_id}")
def panel_tracking_detail(link_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    link = db.fetchone("SELECT * FROM tracking_links WHERE id = ?", (link_id,))
    if not link:
        raise HTTPException(404, detail="Link not found")
    return serialize_tracking(link, include_users=True)


@app.post("/api/panel/tracking-links")
def panel_tracking_create(body: TrackingBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not body.name or not body.name.strip():
        raise HTTPException(400, detail="name required")
    code = (body.code or gen_ref_code(6)).strip()
    code = "".join(c for c in code if c.isalnum() or c in "_-")
    now = db.utcnow_iso()
    url = _tracking_url(code)
    db.execute(
        "INSERT INTO tracking_links (name, code, promocode, welcome_message, url, clicks, is_active, "
        "unique_users, new_users, total_revenue, paid_users, active_subscriptions, total_keys, "
        "conversion_rate, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, 0, 0, 0, 0, 0, 0, 0, ?)",
        (
            body.name.strip(),
            code,
            (body.promocode or "").upper() or None,
            body.welcome_message,
            url,
            now,
        ),
    )
    item = db.fetchone("SELECT * FROM tracking_links WHERE id = ?", (db.last_id(),))
    assert item is not None
    return serialize_tracking(item)


@app.put("/api/panel/tracking-links/{link_id}")
def panel_tracking_update(link_id: int, body: TrackingBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    link = db.fetchone("SELECT * FROM tracking_links WHERE id = ?", (link_id,))
    if not link:
        raise HTTPException(404, detail="Link not found")
    data = body.model_dump(exclude_unset=True)
    name = data.get("name", link["name"])
    code = link["code"]
    if data.get("code"):
        code = data["code"]
    promocode = link.get("promocode")
    if "promocode" in data:
        promocode = (data["promocode"] or "").upper() or None
    welcome = data["welcome_message"] if "welcome_message" in data else link.get("welcome_message")
    is_active = link.get("is_active")
    if "is_active" in data and data["is_active"] is not None:
        is_active = 1 if data["is_active"] else 0
    db.execute(
        "UPDATE tracking_links SET name = ?, code = ?, promocode = ?, welcome_message = ?, "
        "url = ?, is_active = ? WHERE id = ?",
        (name, code, promocode, welcome, _tracking_url(code), is_active, link_id),
    )
    item = db.fetchone("SELECT * FROM tracking_links WHERE id = ?", (link_id,))
    assert item is not None
    return serialize_tracking(item)


@app.delete("/api/panel/tracking-links/{link_id}")
def panel_tracking_delete(link_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    link = db.fetchone("SELECT id FROM tracking_links WHERE id = ?", (link_id,))
    if not link:
        raise HTTPException(404, detail="Link not found")
    db.execute("DELETE FROM tracking_links WHERE id = ?", (link_id,))
    return {"success": True}


@app.get("/api/panel/remnawave/squads")
def panel_remnawave_squads(_: dict = Depends(require_owner)) -> list[dict[str, Any]]:
    rows = db.fetchall("SELECT squad_uuid, squad_name FROM squads WHERE is_active = 1")
    return [{"uuid": r["squad_uuid"], "name": r["squad_name"]} for r in rows]


@app.get("/api/panel/squads")
def panel_squads(_: dict = Depends(require_owner)) -> dict[str, Any]:
    rows = db.fetchall("SELECT * FROM squads ORDER BY priority DESC")
    return {
        "squads": [serialize_squad(s) for s in rows],
        "mapping": get_squad_mapping(),
    }


@app.post("/api/panel/squads/sync")
def panel_squads_sync(_: dict = Depends(require_owner)) -> dict[str, Any]:
    """синхронизация internal-squads из remnawave."""
    client = _rw_client()
    if client is None:
        raise HTTPException(503, detail={"message": "Remnawave не настроена (укажите URL и API-токен)"})
    try:
        resp = client.get_internal_squads()
    except Exception as exc:  # noqa: BLE001
        forum.report_error("Синхронизация сквадов Remnawave", f"{type(exc).__name__}: {exc}")
        raise HTTPException(502, detail={"message": f"Ошибка Remnawave: {exc}"})

    squads = resp
    if isinstance(resp, dict):
        squads = resp.get("internalSquads") or resp.get("squads") or resp.get("items") or []
    if not isinstance(squads, list):
        squads = []

    seen: list[str] = []
    for s in squads:
        if not isinstance(s, dict):
            continue
        su = s.get("uuid") or s.get("id")
        if not su:
            continue
        su = str(su)
        name = s.get("name") or "Squad"
        members = int(s.get("membersCount") or s.get("members_count") or 0)
        inbounds = s.get("inbounds")
        inb = len(inbounds) if isinstance(inbounds, list) else int(s.get("inboundsCount") or 0)
        seen.append(su)
        if db.fetchone("SELECT squad_uuid FROM squads WHERE squad_uuid = ?", (su,)):
            db.execute(
                "UPDATE squads SET squad_name = ?, current_users = ?, inbounds_count = ?, is_active = 1 "
                "WHERE squad_uuid = ?",
                (name, members, inb, su),
            )
        else:
            db.execute(
                "INSERT INTO squads (squad_uuid, squad_name, squad_type, max_users, current_users, "
                "inbounds_count, is_active, priority) VALUES (?, ?, 'vpn', 0, ?, ?, 1, 0)",
                (su, name, members, inb),
            )

    # сквады, которых нет в remnawave, помечаем неактивными
    if seen:
        placeholders = ",".join("?" * len(seen))
        db.execute(f"UPDATE squads SET is_active = 0 WHERE squad_uuid NOT IN ({placeholders})", seen)

    count_row = db.fetchone("SELECT COUNT(*) AS c FROM squads WHERE is_active = 1")
    return {"success": True, "count": int(count_row["c"]) if count_row else 0, "synced": len(seen)}


@app.put("/api/panel/squads/{squad_uuid}")
def panel_squad_update(
    squad_uuid: str, body: SquadUpdateBody, _: dict = Depends(require_owner)
) -> dict[str, Any]:
    squad = db.fetchone("SELECT * FROM squads WHERE squad_uuid = ?", (squad_uuid,))
    if not squad:
        raise HTTPException(404, detail="Squad not found")
    data = body.model_dump(exclude_unset=True)
    fields = []
    params: list[Any] = []
    for k, v in data.items():
        if v is None:
            continue
        if k == "is_active":
            fields.append("is_active = ?")
            params.append(1 if v else 0)
        else:
            fields.append(f"{k} = ?")
            params.append(v)
    if fields:
        params.append(squad_uuid)
        db.execute(f"UPDATE squads SET {', '.join(fields)} WHERE squad_uuid = ?", params)
    return {"success": True}


@app.put("/api/panel/squads/mapping")
def panel_squad_mapping(body: SquadMappingBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    set_squad_mapping(list(body.vpn), list(body.trial))
    return {"success": True}


@app.get("/api/panel/grace")
def panel_grace_get(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return grace.settings()


@app.put("/api/panel/grace")
def panel_grace_save(body: GraceSettingsBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    try:
        grace.save_settings(body.enabled, [str(x)[:64] for x in body.squads], body.traffic_gb, body.trial)
    except ValueError as e:
        raise HTTPException(400, detail={"message": str(e)})
    return panel_grace_get(_)


@app.get("/api/panel/backups/status")
def panel_backup_status(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return get_backup_settings()


@app.post("/api/panel/backups/create")
def panel_backup_create(_: dict = Depends(require_owner)) -> dict[str, Any]:
    try:
        info = create_backup()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, detail={"message": f"Не удалось создать бэкап: {exc}"})
    return {"success": True, **info, "backups": list_backups()}


@app.get("/api/panel/backups/download")
def panel_backup_download(name: str = Query(...), _: dict = Depends(require_owner)):
    from fastapi.responses import FileResponse

    from fastapi.responses import RedirectResponse

    safe = os.path.basename(name)
    if not re.fullmatch(r"backup-\d{8}-\d{6}\.db", safe):
        raise HTTPException(400, detail={"message": "Некорректное имя файла"})
    path = os.path.join(_backup_dir(), safe)
    if os.path.isfile(path):
        return FileResponse(path, media_type="application/octet-stream", filename=safe)
    item = next((x for x in _s3_backups() if x["name"] == safe), None)
    if item and s3store.enabled():
        # нет на диске: временная ссылка на s3
        return {"url": s3store.presign_get(item["key"], 600)}
    raise HTTPException(404, detail={"message": "Бэкап не найден"})


@app.put("/api/panel/backups/settings")
def panel_backup_settings(body: BackupSettingsBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    db.set_setting("backup_enabled", "1" if body.enabled else "0")
    db.set_setting("backup_interval_hours", str(max(1, body.interval_hours)))
    return get_backup_settings()


@app.get("/api/panel/forum")
def panel_forum_get(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return forum.get_config()


@app.put("/api/panel/forum")
def panel_forum_put(body: ForumConfigBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    return forum.save_config(body.forum_chat_id or "", body.topics or {}, panel_url_value=body.panel_url)


class MonNodeCreateBody(BaseModel):
    name: str
    ip: str
    port: Optional[int] = None


class MonNodeUpdateBody(BaseModel):
    name: Optional[str] = None
    ip: Optional[str] = None
    port: Optional[int] = None
    vless: Optional[str] = None       # "": убрать проверку vless
    pay_date: Optional[str] = None    # "": убрать iso-дату
    pay_url: Optional[str] = None


def _mon(fn, *a, **k):
    try:
        return fn(*a, **k)
    except monitoring.MonitorError as e:
        raise HTTPException(e.status, detail={"message": e.message})


@app.get("/api/panel/monitoring")
def panel_mon_overview(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return monitoring.overview()


@app.post("/api/panel/monitoring/nodes")
def panel_mon_create(body: MonNodeCreateBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    node, secret = _mon(monitoring.create_node, body.name, body.ip, body.port or monitoring.DEFAULT_PORT)
    # ключ показывается один раз, в бд только шифротекст
    return {"node": monitoring.node_brief(node), "secret": secret}


@app.get("/api/panel/monitoring/nodes/{node_id}")
def panel_mon_node(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    return _mon(monitoring.node_detail, node_id)


@app.get("/api/panel/monitoring/nodes/{node_id}/series")
def panel_mon_series(node_id: int, metric: str = Query(...), range: str = Query("24h"),
                     _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not monitoring.get_node(node_id):
        raise HTTPException(404, detail={"message": "Нода не найдена"})
    return _mon(monitoring.series, node_id, metric, range)


@app.patch("/api/panel/monitoring/nodes/{node_id}")
def panel_mon_update(node_id: int, body: MonNodeUpdateBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    _mon(monitoring.update_node, node_id, body.model_dump())
    return _mon(monitoring.node_detail, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/start")
def panel_mon_start(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    _mon(monitoring.start_node, node_id)
    return _mon(monitoring.node_detail, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/stop")
def panel_mon_stop(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    _mon(monitoring.stop_node, node_id)
    return _mon(monitoring.node_detail, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/speedtest")
def panel_mon_speedtest(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    return _mon(monitoring.trigger_speedtest, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/reboot")
def panel_monitoring_reboot(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    _mon(monitoring.reboot_node, node_id)
    return _mon(monitoring.node_detail, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/update")
def panel_monitoring_update(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    _mon(monitoring.request_update, node_id)
    return _mon(monitoring.node_detail, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/vless-check")
def panel_mon_vless_check(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    node = monitoring.get_node(node_id)
    if not node:
        raise HTTPException(404, detail={"message": "Нода не найдена"})
    if not node.get("vless_enc"):
        raise HTTPException(400, detail={"message": "VLESS-ключ не задан"})
    monitoring.vless_node(node)
    return _mon(monitoring.node_detail, node_id)


@app.post("/api/panel/monitoring/nodes/{node_id}/rotate-secret")
def panel_mon_rotate(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not monitoring.get_node(node_id):
        raise HTTPException(404, detail={"message": "Нода не найдена"})
    return {"secret": monitoring.rotate_secret(node_id)}


@app.delete("/api/panel/monitoring/nodes/{node_id}")
def panel_mon_delete(node_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    monitoring.delete_node(node_id)
    return {"ok": True}


def _serialize_withdrawal_admin(w: dict[str, Any]) -> dict[str, Any]:
    user = get_user(int(w["user_id"])) if w.get("user_id") else None
    data = services.serialize_withdrawal(w)
    data["username"] = (user or {}).get("username")
    data["telegram_id"] = (user or {}).get("telegram_id")
    data["email"] = (user or {}).get("email")
    data["is_banned"] = bool((user or {}).get("is_banned"))
    return data


@app.get("/api/panel/withdrawals")
def panel_withdrawals(status: Optional[str] = Query(None), _: dict = Depends(require_panel)) -> dict[str, Any]:
    if status and status != "all":
        rows = db.fetchall("SELECT * FROM withdrawals WHERE status = ? ORDER BY id DESC", (status,))
    else:
        rows = db.fetchall("SELECT * FROM withdrawals ORDER BY id DESC")
    pending = db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'pending'")
    approved = db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'approved'")
    done = db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'completed'")
    return {
        "items": [_serialize_withdrawal_admin(w) for w in rows],
        "pending_count": int(pending["c"]) if pending else 0,
        "pending_amount": round(float(pending["s"]) if pending else 0, 2),
        "approved_count": int(approved["c"]) if approved else 0,
        "approved_amount": round(float(approved["s"]) if approved else 0, 2),
        "completed_count": int(done["c"]) if done else 0,
        "completed_amount": round(float(done["s"]) if done else 0, 2),
    }


@app.post("/api/panel/withdrawals/{withdrawal_id}/approve")
def panel_withdraw_approve(withdrawal_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """одобрить вывод: статус «одобрен»."""
    try:
        w = services.approve_withdrawal(withdrawal_id)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})
    return _serialize_withdrawal_admin(w)


@app.post("/api/panel/withdrawals/{withdrawal_id}/complete")
def panel_withdraw_complete(withdrawal_id: int, body: WithdrawCompleteBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """завершить вывод: hash + статус + сообщение юзеру."""
    try:
        w = services.complete_withdrawal(withdrawal_id, body.tx_hash)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})
    user = get_user(int(w["user_id"])) if w.get("user_id") else None
    delivered = False
    if user and user.get("telegram_id"):
        try:
            delivered = forum.dm_withdrawal_completed(int(user["telegram_id"]), w["amount"], str(w.get("tx_link") or ""))
        except Exception:  # noqa: BLE001
            delivered = False
    return {**_serialize_withdrawal_admin(w), "notified": delivered}


@app.post("/api/panel/withdrawals/{withdrawal_id}/reject")
def panel_withdraw_reject(withdrawal_id: int, body: WithdrawRejectBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """отказ; refund=true вернуть сумму на реф. баланс."""
    reason = (body.reason or "").strip()
    if not reason:
        raise HTTPException(400, detail={"message": "Укажите причину отказа"})
    try:
        w = services.reject_withdrawal(withdrawal_id, reason, refund=bool(body.refund))
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})
    user = get_user(int(w["user_id"])) if w.get("user_id") else None
    if user and user.get("telegram_id"):
        try:
            forum.dm_withdrawal_rejected(int(user["telegram_id"]), w["amount"], reason, bool(body.refund))
        except Exception:  # noqa: BLE001
            pass
    return _serialize_withdrawal_admin(w)


def _reject_withdrawals_on_ban(user_id: int) -> int:
    """при бане незавершённые выводы отклоняются с возвратом."""
    return len(services.reject_open_withdrawals_for_user(user_id, "Аккаунт заблокирован"))


@app.get("/api/panel/content/offer")
def panel_get_offer(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return {"text": db.get_setting("offer_text", "")}


@app.put("/api/panel/content/offer")
def panel_put_offer(body: ContentTextBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    db.set_setting("offer_text", body.text)
    return {"text": body.text}


@app.get("/api/panel/content/privacy")
def panel_get_privacy(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return {"text": db.get_setting("privacy_text", "")}


@app.put("/api/panel/content/privacy")
def panel_put_privacy(body: ContentTextBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    db.set_setting("privacy_text", body.text)
    return {"text": body.text}


@app.get("/api/panel/plans")
def panel_get_plans(_: dict = Depends(require_owner)) -> list[dict[str, Any]]:
    return get_active_plans()


@app.get("/api/panel/plans/meta")
def panel_plans_meta(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return get_plans_meta()


@app.put("/api/panel/plans")
def panel_put_plans(body: PlansUpdateBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    def _num(v: Any, lo: float, hi: float) -> float:
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise HTTPException(400, detail={"message": "Некорректное число"})
        if f < lo or f > hi:
            raise HTTPException(400, detail={"message": f"Значение должно быть от {lo:g} до {hi:g}"})
        return f

    if body.base_price is not None:
        db.set_setting("base_price", f"{_num(body.base_price, 1, 100000):g}")
    if body.extra_device_price is not None:
        db.set_setting("extra_device_price", f"{_num(body.extra_device_price, 0, 100000):g}")
    if body.trial_enabled is not None:
        db.set_setting("trial_enabled", "1" if body.trial_enabled else "0")
    if body.trial_days is not None:
        db.set_setting("trial_days", str(int(_num(body.trial_days, 1, 365))))
    if body.trial_traffic_gb is not None:
        db.set_setting("trial_traffic_gb", str(int(_num(body.trial_traffic_gb, 0, 100000))))
    if body.trial_devices is not None:
        db.set_setting("trial_devices", str(int(_num(body.trial_devices, 1, 20))))
    if body.paid_traffic_gb is not None:
        db.set_setting("paid_traffic_gb", str(int(_num(body.paid_traffic_gb, 0, 100000))))
    if body.traffic_reset_price is not None:
        db.set_setting("traffic_reset_price", f"{_num(body.traffic_reset_price, 0, 100000):g}")
    if body.antiabuse_enabled is not None:
        db.set_setting("antiabuse_enabled", "1" if body.antiabuse_enabled else "0")
    for k in ("aa_hwid_multiplier", "aa_ip_extra", "aa_grace_hours", "aa_warn_days", "trial_hwid_max"):
        v = getattr(body, k)
        if v is not None:
            db.set_setting(k, str(int(v)))
    if body.trial_hwid_enabled is not None:
        db.set_setting("trial_hwid_enabled", "1" if body.trial_hwid_enabled else "0")
    return {"plans": get_active_plans(), **get_plans_meta()}


@app.get("/api/app/config")
def app_config(request: Request) -> dict[str, Any]:
    bot_id = ""
    if TELEGRAM_BOT_TOKEN and ":" in TELEGRAM_BOT_TOKEN:
        bot_id = TELEGRAM_BOT_TOKEN.split(":", 1)[0]
    meta = get_plans_meta()
    prices = {p["devices"]: p["price_rub"] for p in get_active_plans()}
    offer = db.get_setting("offer_text", "")
    privacy = db.get_setting("privacy_text", "")
    ip = _client_ip(request)
    return {
        "telegramOauthBotId": bot_id,
        "telegramOauthUrl": "",
        "botUsername": BOT_USERNAME,
        "prices": prices,
        "extraDevicePrice": meta["extra_device_price"],
        "basePrice": meta["base_price"],
        "minPrice": min_plan_price(),
        "legalAvailable": bool(offer.strip() or privacy.strip()),
        "supportUrl": _env("SUPPORT_URL") or "",
        "trialEnabled": trial_enabled(),
        "trialDays": fulfillment.trial_days(),
        "providerMin": PROVIDER_MIN_RUB,
        "trafficResetPrice": float(db.get_setting("traffic_reset_price", "0") or 0),
        "captcha": captcha_mod.public_config(request.headers, ip),
    }


# заблокированный видит главную в состоянии «заблокирована»
_BANNED_ALLOWED_PATHS = {"/api/app/auth", "/api/app/me", "/api/app/membership",
                         # заблокированным поддержка всё равно нужна
                         "/api/app/support", "/api/app/support/upload", "/api/app/support/messages",
                         "/api/app/support/read", "/api/app/support/close"}


def _resolve_app_user_from_tg(tg: dict[str, Any], allow_banned: bool = False) -> dict[str, Any]:
    telegram_id = int(tg.get("id") or 0)
    if not telegram_id:
        raise HTTPException(401, detail={"message": "Нет telegram id"})
    user = upsert_telegram_user(
        telegram_id=telegram_id,
        username=tg.get("username"),
        first_name=tg.get("first_name"),
        last_name=tg.get("last_name"),
    )
    if user.get("is_banned") and not allow_banned:
        raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
    return user


def _resolve_app_user_from_email(email: str) -> dict[str, Any]:
    """найти юзера по email или создать (вход = регистрация)."""
    email = email.strip().lower()
    user = db.fetchone("SELECT * FROM users WHERE lower(email) = ?", (email,))
    if user:
        if user.get("is_banned"):
            raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
        return user
    db.execute(
        "INSERT INTO users (telegram_id, username, email, balance, status, is_banned, referral_code, "
        "is_partner, partner_balance, partner_rate, autopay_enabled, created_at) "
        "VALUES (NULL, NULL, ?, 0, 'None', 0, ?, 0, 0, 25, 0, ?)",
        (email, gen_ref_code(), db.utcnow_iso()),
    )
    fresh = get_user(db.last_id())
    assert fresh is not None
    return fresh


@app.post("/api/app/auth")
def app_auth(x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data")) -> dict[str, Any]:
    data = validate_webapp_init_data(x_telegram_init_data or "")
    user = _resolve_app_user_from_tg(data.get("user") or {}, allow_banned=True)
    # сессия-страховка, когда initdata протух
    token = create_app_session(int(user["id"]))
    return {"user": serialize_app_user(user), "token": token}


def _apply_web_referral(user_id: int, code: Optional[str]) -> None:
    """реферал с сайта /?ref=<id>: только для нового аккаунта."""
    code = str(code or "").strip()
    if not code or len(code) > 32:
        return
    user = get_user(user_id)
    if not user or user.get("referred_by"):
        return
    ref = get_user(int(code)) if code.isdigit() else None
    if not ref:
        ref = db.fetchone("SELECT * FROM users WHERE referral_code = ?", (code.upper(),))
    if not ref or int(ref["id"]) == int(user_id):
        return
    if ref.get("referred_by") and int(ref["referred_by"]) == int(user_id):
        return
    db.execute("UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL", (ref["id"], user_id))


def _require_captcha(token: Optional[str], request: Optional[Request]) -> None:
    """капча на веб-входе (почта / telegram widget); в mini app не вызывается."""
    if not captcha_mod.enabled():
        return
    try:
        captcha_mod.verify(token or "", request.headers if request else {}, _client_ip(request))
    except captcha_mod.CaptchaError as e:
        raise HTTPException(e.status, detail={"message": e.message})


@app.post("/api/app/auth/oauth")
def app_auth_oauth(body: OauthLoginBody, request: Request = None) -> dict[str, Any]:  # type: ignore[assignment]
    _require_captcha(body.captcha_token, request)
    payload = body.model_dump(exclude={"ref", "captcha_token"})
    validated = validate_oauth_login(payload)
    was_new = find_user_by_tg(int(validated.get("id") or 0)) is None
    user = _resolve_app_user_from_tg(
        {
            "id": validated.get("id"),
            "username": validated.get("username"),
            "first_name": validated.get("first_name"),
            "last_name": validated.get("last_name"),
        }
    )
    if was_new:
        _apply_web_referral(int(user["id"]), body.ref)
    else:
        _notify_login(user, "Telegram", request)
    token = create_app_session(int(user["id"]))
    return {"user": serialize_app_user(user), "token": token}


@app.post("/api/app/auth/email/request")
def app_auth_email_request(body: EmailRequestBody, request: Request = None) -> dict[str, Any]:  # type: ignore[assignment]
    email = (body.email or "").strip().lower()
    if not _valid_email(email):
        raise HTTPException(400, detail={"message": "Введите корректный email"})
    _require_captcha(body.captcha_token, request)

    # лимиты писем на адрес и с ip
    ip = _client_ip(request) or "unknown"
    allowed, retry = ratelimit.rate_limit(f"emailcode:{email}:{ip}", 3, 300)
    if allowed:
        allowed, retry = ratelimit.rate_limit(f"emailcode_hour:{email}:{ip}", 10, 3600)
    if allowed:
        allowed, retry = ratelimit.rate_limit(f"emailcode_all:{email}", 30, 3600)
    if allowed:
        if ip:
            allowed, retry = ratelimit.rate_limit(f"emailcode_ip:{ip}", 10, 300)
            if allowed:
                allowed, retry = ratelimit.rate_limit(f"emailcode_iphour:{ip}", 30, 3600)
    if not allowed:
        wait = f"{retry} сек." if retry < 90 else f"{math.ceil(retry / 60)} мин."
        raise HTTPException(429, detail={"message": f"Слишком много запросов. Повторите через {wait}"})

    code, throttled = create_email_code(email)
    if not throttled:
        send_login_code(email, code)
    resp: dict[str, Any] = {"ok": True, "throttled": throttled, "resend_after": EMAIL_CODE_RESEND}
    # без smtp отдаём код для отладки (не в проде)
    if ENV != "production" and not mailer.is_configured():
        resp["dev_code"] = code
    return resp


def _email_verify_limits(email: str, request: Optional[Request]) -> None:
    """лимиты перебора кода на адрес и ip."""
    ip = _client_ip(request) or "unknown"
    allowed, retry = ratelimit.rate_limit(f"emailverify:{email}:{ip}", 10, 3600)
    if allowed:
        allowed, retry = ratelimit.rate_limit(f"emailverify_ip:{ip}", 30, 3600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком много попыток. Повторите через {max(1, retry // 60)} мин."})


@app.post("/api/app/auth/email/verify")
def app_auth_email_verify(body: EmailVerifyBody, request: Request = None) -> dict[str, Any]:  # type: ignore[assignment]
    email = (body.email or "").strip().lower()
    _email_verify_limits(email, request)
    _require_captcha(body.captcha_token, request)
    if not verify_email_code(email, body.code or ""):
        raise HTTPException(401, detail={"message": "Неверный или истёкший код"})
    was_new = db.fetchone("SELECT id FROM users WHERE lower(email) = ?", (email,)) is None
    user = _resolve_app_user_from_email(email)
    if was_new:
        _apply_web_referral(int(user["id"]), body.ref)
    else:
        _notify_login(user, "код на почту", request)
    token = create_app_session(int(user["id"]))
    return {"user": serialize_app_user(user), "token": token}


@app.post("/api/app/auth/logout")
def app_auth_logout(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    x_app_session: Optional[str] = Header(None, alias="X-App-Session"),
) -> dict[str, Any]:
    token = _extract_app_token(authorization, x_app_session)
    if token:
        delete_app_session(token)
    return {"ok": True}


def _extract_app_token(authorization: Optional[str], x_app_session: Optional[str]) -> Optional[str]:
    if x_app_session:
        return x_app_session.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def _app_user_from_init(
    request: Request,
    x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    x_app_session: Optional[str] = Header(None, alias="X-App-Session"),
) -> dict[str, Any]:
    allow_banned = request.url.path in _BANNED_ALLOWED_PATHS
    token = _extract_app_token(authorization, x_app_session)
    # 1) telegram mini app: подпись initdata
    if x_telegram_init_data:
        try:
            data = validate_webapp_init_data(x_telegram_init_data)
        except InitDataExpired as exc:
            # initdata протух: пускаем по сессии того же tg
            sess = get_app_session(token) if token else None
            user = get_user(int(sess["user_id"])) if sess else None
            if not user or not exc.telegram_id or int(user.get("telegram_id") or 0) != exc.telegram_id:
                raise
            if user.get("is_banned") and not allow_banned:
                raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
            return user
        tg = data.get("user") or {}
        if tg.get("id"):
            return _resolve_app_user_from_tg(tg, allow_banned)
    # 2) сессионный токен (email / oauth)
    if token:
        sess = get_app_session(token)
        if not sess:
            raise HTTPException(401, detail={"message": "Сессия истекла, войдите заново"})
        user = get_user(int(sess["user_id"]))
        if not user:
            raise HTTPException(401, detail={"message": "Пользователь не найден"})
        if user.get("is_banned") and not allow_banned:
            raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
        return user
    # 3) dev/allow-unauth (в проде 401)
    data = validate_webapp_init_data(x_telegram_init_data or "")
    return _resolve_app_user_from_tg(data.get("user") or {})


_CHANNEL_MEMBER_STATUSES = {"creator", "administrator", "member", "restricted"}


def _check_channel_membership(user: dict[str, Any], *, force: bool = False) -> bool:
    """подписан ли на обязательный канал (с кэшем ttl)."""
    tgid = user.get("telegram_id")
    if not tgid or not REQUIRED_CHANNEL_ID:
        return True
    # кэш: channel_ok не чаще ttl
    if not force and int(user.get("channel_ok") or 0) == 1:
        ts = parse_iso(user.get("channel_checked_at"))
        if ts and (utcnow() - ts).total_seconds() < CHANNEL_CHECK_TTL:
            return True
    status = notifier.get_chat_member_status(REQUIRED_CHANNEL_ID, int(tgid))
    if status is None:
        # не смогли проверить (бот не админ канала?)
        print(f"[channel] не удалось проверить подписку user {user.get('id')} "
              f"(бот админ канала {REQUIRED_CHANNEL_ID}?)", flush=True)
        return True  # fail-open
    subscribed = status in _CHANNEL_MEMBER_STATUSES and status not in ("left", "kicked")
    try:
        db.execute(
            "UPDATE users SET channel_ok = ?, channel_checked_at = ? WHERE id = ?",
            (1 if subscribed else 0, db.utcnow_iso(), user["id"]),
        )
    except Exception:  # noqa: BLE001
        pass
    return subscribed


def require_channel_dep(
    user: dict = Depends(_app_user_from_init),
    x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
) -> dict[str, Any]:
    """действия: tg без подписки на канал -> 403."""
    if user.get("telegram_id") and REQUIRED_CHANNEL_ID:
        if not _check_channel_membership(user, force=False):
            raise HTTPException(403, detail={
                "message": "Подпишитесь на канал BlinVPN, чтобы продолжить",
                "code": "channel_required",
                "channel_url": REQUIRED_CHANNEL_URL,
            })
    return user


@app.get("/api/app/membership")
def app_membership(
    force: int = Query(0),
    user: dict = Depends(_app_user_from_init),
    x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
) -> dict[str, Any]:
    """статус обязательной подписки; для email required=false."""
    fresh = get_user(int(user["id"])) or user
    if not fresh.get("telegram_id") or not REQUIRED_CHANNEL_ID:
        return {"required": False, "subscribed": True, "channel_url": REQUIRED_CHANNEL_URL}
    # принудительная перепроверка: rate limit
    if force:
        allowed, _ = ratelimit.rate_limit(f"membership:{fresh['id']}", 6, 60)
        force = 1 if allowed else 0
    subscribed = _check_channel_membership(fresh, force=bool(force))
    return {
        "required": True,
        "subscribed": bool(subscribed),
        "channel_url": REQUIRED_CHANNEL_URL,
    }


@app.get("/api/app/me")
def app_me(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


@app.post("/api/app/me/email/request")
def app_me_email_request(body: UpdateEmailBody, user: dict = Depends(_app_user_from_init), request: Request = None) -> dict[str, Any]:  # type: ignore[assignment]
    """Отправить код для привязки/смены email (нужно подтверждение кодом)."""
    email = (body.email or "").strip().lower()
    if not _valid_email(email):
        raise HTTPException(400, detail={"message": "Введите корректный email"})
    clash = db.fetchone("SELECT id FROM users WHERE lower(email) = ? AND id != ?", (email, user["id"]))
    merge = None
    if clash:
        other = get_user(int(clash["id"]))
        if other:
            merge = merge_preview(get_user(int(user["id"])) or user, other)  # 409, если объединить нельзя

    allowed, retry = ratelimit.rate_limit(f"emailbind:{user['id']}", 3, 300)
    if allowed:
        ip = _client_ip(request)
        if ip:
            allowed, retry = ratelimit.rate_limit(f"emailbind_ip:{ip}", 10, 300)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком много запросов. Повторите через {retry} сек."})

    code, throttled = create_email_code(email)
    if not throttled:
        send_login_code(email, code)
    resp: dict[str, Any] = {"ok": True, "throttled": throttled, "resend_after": EMAIL_CODE_RESEND}
    if merge:
        resp["merge"] = merge  # мини-приложение покажет предупреждение об объединении
    if ENV != "production" and not mailer.is_configured():
        resp["dev_code"] = code
    return resp


@app.post("/api/app/me/terms")
def app_me_accept_terms(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """согласие с офертой и политикой."""
    db.execute("UPDATE users SET terms_accepted_at = COALESCE(terms_accepted_at, ?) WHERE id = ?",
               (iso(), user["id"]))
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


@app.put("/api/app/me/email")
def app_me_email(body: EmailVerifyBody, request: Request, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """привязать/сменить email после кода из письма."""
    email = (body.email or "").strip().lower()
    if not _valid_email(email):
        raise HTTPException(400, detail={"message": "Некорректный email"})
    _email_verify_limits(email, request)
    clash = db.fetchone("SELECT id FROM users WHERE lower(email) = ? AND id != ?", (email, user["id"]))
    other = get_user(int(clash["id"])) if clash else None
    if other and not body.merge:
        # код не тратим, пока нет согласия на объединение
        raise HTTPException(409, detail={"message": "Этот email уже есть у другого аккаунта",
                                         "merge": merge_preview(get_user(int(user["id"])) or user, other)})
    if not verify_email_code(email, body.code or ""):
        raise HTTPException(401, detail={"message": "Неверный или истёкший код"})
    merged = None
    old_email = (get_user(int(user["id"])) or user).get("email")
    if other:
        merged = merge_accounts(int(user["id"]), int(other["id"]))
    db.execute("UPDATE users SET email = ? WHERE id = ?", (email, user["id"]))
    _email_changed(old_email, email)
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh), "merged": merged}


@app.delete("/api/app/me/email")
def app_me_email_unbind(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    if not fresh.get("telegram_id"):
        raise HTTPException(400, detail={"message": "Нельзя отвязать email: это единственный способ входа"})
    db.execute("UPDATE users SET email = NULL WHERE id = ?", (user["id"],))
    _email_changed(fresh.get("email"), None)
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


@app.put("/api/app/me/telegram")
def app_me_telegram(body: OauthBody, merge: bool = Query(False),
                    user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """привязать telegram; при конфликте 409 или merge=1."""
    validated = validate_oauth_login(body.model_dump())
    new_tg = int(validated.get("id") or 0)
    if not new_tg:
        raise HTTPException(400, detail={"message": "Нет Telegram id"})
    clash = db.fetchone("SELECT id FROM users WHERE telegram_id = ? AND id != ?", (new_tg, user["id"]))
    if clash:
        other = get_user(int(clash["id"]))
        assert other is not None
        if not merge:
            raise HTTPException(409, detail={"message": "Этот Telegram уже есть у другого аккаунта",
                                             "merge": merge_preview(get_user(int(user["id"])) or user, other)})
        merge_accounts(int(user["id"]), int(other["id"]))
    before = get_user(int(user["id"])) or user
    db.execute(
        "UPDATE users SET telegram_id = ?, username = COALESCE(?, username) WHERE id = ?",
        (new_tg, validated.get("username"), user["id"]),
    )
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    # rw ищет по tg id: переносим привязку вместе
    if before.get("telegram_id") != new_tg:
        try:
            client, rw = _rw_find_user(before)
            rw_id = _rw_num_id(rw) if rw else None
            if client and rw_id:
                client.update_user(id=rw_id, telegram_id=new_tg)
        except Exception as exc:  # noqa: BLE001
            forum.report_error("Смена Telegram: не удалось обновить Remnawave", f"user {user['id']}: {type(exc).__name__}: {exc}")
    return {"user": serialize_app_user(fresh)}


def _has_trial_ever(user_id: int) -> bool:
    return bool(db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND type = 'trial' LIMIT 1", (user_id,)
    ))


def _has_any_sub(user_id: int) -> bool:
    return bool(db.fetchone("SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1", (user_id,)))


def _trial_available_for(user_id: int) -> bool:
    """пробный доступен: вкл, нет подписок, tg ещё не брал."""
    if not trial_enabled() or _has_any_sub(user_id):
        return False
    u = get_user(user_id) or {}
    if u.get("telegram_id") and db.fetchone("SELECT 1 FROM trial_claims WHERE telegram_id = ?", (int(u["telegram_id"]),)):
        return False
    return True


@app.get("/api/app/subscription")
def app_subscription(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    keys = db.fetchall(
        "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC", (fresh["id"],)
    )
    serialized = [serialize_key(k, fresh) for k in keys]
    active = next((k for k in serialized if k.get("status") == "Active"), None)
    status = subscription_status_for_user(fresh)
    expired_key = None
    delete_at = None
    if status == "expired":
        last = last_expired_subscription(int(fresh["id"]))
        if last:
            expired_key = serialize_key(last, fresh)
            exp = parse_iso(last.get("expires_at"))
            if exp:
                delete_at = iso(exp + timedelta(days=fulfillment.DELETE_AFTER_DAYS))
    return {
        "status": status,
        "until": paid_until_for_user(int(fresh["id"])) if status in ("active", "trial") else None,
        "key": active if status in ("active", "trial") else None,
        # закончившаяся подписка и дата автоудаления
        "expired_key": expired_key,
        "delete_at": delete_at,
        "keys": [k for k in serialized if k.get("status") != "Deleted"],
        "trial_enabled": trial_enabled(),
        "trial_available": _trial_available_for(int(fresh["id"])),
    }


def _rw_traffic(rw: dict[str, Any]) -> dict[str, Any]:
    """трафик юзера remnawave (userTraffic в 3.x)."""
    ut = rw.get("userTraffic") if isinstance(rw.get("userTraffic"), dict) else {}

    def _n(*vals: Any) -> Optional[int]:
        for v in vals:
            try:
                if v is not None:
                    return int(float(v))
            except (TypeError, ValueError):
                continue
        return None

    return {
        "used_bytes": _n(ut.get("usedTrafficBytes"), rw.get("usedTrafficBytes"), rw.get("used_traffic_bytes")),
        "limit_bytes": _n(rw.get("trafficLimitBytes"), rw.get("traffic_limit_bytes")) or 0,
        "strategy": str(rw.get("trafficLimitStrategy") or rw.get("traffic_limit_strategy") or "NO_RESET").upper(),
        "last_reset_at": rw.get("lastTrafficResetAt") or ut.get("lastTrafficResetAt"),
    }


@app.get("/api/app/subscription/traffic")
def app_subscription_traffic(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """сколько трафика потрачено; available=false если не узнали."""
    fresh = get_user(int(user["id"])) or user
    try:
        _client, rw = _rw_find_user(fresh)
    except Exception:  # noqa: BLE001
        rw = None
    if not isinstance(rw, dict):
        return {"available": False}
    return {"available": True, **_rw_traffic(grace.mask_rw(int(fresh["id"]), rw))}


@app.get("/api/app/setup-status")
def app_setup_status(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """нужен ли онбординг «не завершили настройку»."""
    fresh = get_user(int(user["id"])) or user
    has_sub = bool(db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Active' LIMIT 1",
        (fresh["id"],),
    ))
    ever: Optional[bool] = None
    if has_sub:
        try:
            ever = provisioning.user_ever_connected(
                int(fresh.get("telegram_id") or 0), fresh.get("email"))
        except Exception:  # noqa: BLE001
            ever = None
    return {
        "show_setup_prompt": bool(has_sub and ever is False),
        "has_subscription": has_sub,
        "ever_connected": ever,
    }


def unfreeze_legacy_frozen_subscriptions() -> int:
    """заморозка удалена: frozen один раз возвращаем в работу."""
    rows = db.fetchall("SELECT * FROM subscriptions WHERE status = 'Frozen'")
    for sub in rows:
        rem = int(sub.get("frozen_remaining") or 0)
        new_exp = utcnow() + timedelta(seconds=max(0, rem))
        db.execute(
            "UPDATE subscriptions SET status = 'Active', frozen_at = NULL, frozen_remaining = NULL, "
            "expires_at = ? WHERE id = ?",
            (iso(new_exp), sub["id"]),
        )
        user = get_user(int(sub["user_id"]))
        if user:
            client, rw = _rw_find_user(user)
            if client and rw:
                try:
                    client.enable_user(_rw_num_id(rw))
                    client.update_user(id=_rw_num_id(rw), expire_at=new_exp, status="ACTIVE")
                except Exception:  # noqa: BLE001
                    pass
            sync_user_status_from_subs(int(sub["user_id"]))
    return len(rows)


@app.post("/api/app/trial")
def app_activate_trial(user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    """активация бесплатного пробного."""
    allowed, retry = ratelimit.rate_limit(f"trial:{user['id']}", 5, 3600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    if not fresh.get("terms_accepted_at"):
        raise HTTPException(403, detail={"message": "Сначала примите условия оферты и политику конфиденциальности"})
    if not trial_enabled():
        raise HTTPException(403, detail={"message": "Пробный период сейчас недоступен"})
    if not fresh.get("telegram_id"):
        raise HTTPException(400, detail={"message": "Пробный доступен только при входе через Telegram"})
    if _has_any_sub(int(fresh["id"])):
        raise HTTPException(400, detail={"message": "Пробный период уже был активирован"})
    # один пробный на tg; отметка атомарно до выдачи
    cur = db.execute("INSERT OR IGNORE INTO trial_claims (telegram_id, user_id, claimed_at) VALUES (?, ?, ?)",
                     (int(fresh["telegram_id"]), int(fresh["id"]), iso()))
    if not cur.rowcount:
        raise HTTPException(400, detail={"message": "Пробный период уже был активирован"})
    try:
        result = fulfillment.grant_trial(fresh)
    except Exception as exc:  # noqa: BLE001
        db.execute("DELETE FROM trial_claims WHERE telegram_id = ? AND user_id = ?", (int(fresh["telegram_id"]), int(fresh["id"])))
        forum.report_error("Не удалось выдать пробную подписку", f"{type(exc).__name__}: {exc}")
        raise HTTPException(502, detail={"message": "Не удалось активировать пробный период"})
    return {"success": True, **result}


def _app_sub_url(user: dict[str, Any]) -> Optional[str]:
    """url подписки для импорта в приложение."""
    # 1) remnawave: настоящая ссылка
    client, rw = _rw_find_user(user)
    if client and rw:
        try:
            u = client.subscription_url_for(rw)
            if u:
                return str(u)
        except Exception:  # noqa: BLE001
            pass
    # 2) fallback: short_uuid или сохранённый конфиг
    row = db.fetchone(
        "SELECT short_uuid, key_config FROM subscriptions WHERE user_id = ? AND status != 'Banned' "
        "ORDER BY id DESC LIMIT 1",
        (user["id"],),
    )
    if not row:
        return None
    base = _env("REMWAVE_SUB_PUBLIC_URL")
    if base and row.get("short_uuid"):
        return f"{base.rstrip('/')}/api/sub/{row['short_uuid']}"
    return row.get("key_config")


@app.get("/api/app/subscription/applink")
def app_subscription_applink(
    app: str = Query("incy"),
    user: dict = Depends(require_channel_dep),
) -> dict[str, Any]:
    """deep-link для добавления подписки в приложение."""
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    if subscription_status_for_user(fresh) == "blocked":
        raise HTTPException(403, detail={"message": "Подписка заблокирована"})
    sub_url = _app_sub_url(fresh)
    if not sub_url:
        raise HTTPException(404, detail={"message": "Нет активной подписки"})

    which = (app or "incy").lower()
    if which in ("incy", "happ"):
        if applinks is None:
            raise HTTPException(503, detail={"message": "Модуль шифрования недоступен"})
        try:
            link = applinks.build_link(which, sub_url, name="BlinVPN")
            if which == "happ" and link.startswith("happ://add/") and getattr(applinks, "LAST_HAPP_ERROR", None):
                forum.report_error("Happ: сервис шифрования недоступен — выдана ссылка без шифрования",
                                   str(applinks.LAST_HAPP_ERROR))
                applinks.LAST_HAPP_ERROR = None
        except Exception as exc:  # noqa: BLE001
            forum.report_error(f"Не удалось сформировать ссылку {which}", f"{type(exc).__name__}: {exc}")
            raise HTTPException(502, detail={"message": "Не удалось сформировать ссылку. Попробуйте ещё раз или выберите «Другое приложение»."})
        # telegram не открывает incy/happ://, отдаём https-редирект
        return {"app": which, "link": link, "encrypted": True, "open_url": _deeplink_redirect_url(link)}
    # other: просто https
    return {"app": "other", "link": sub_url, "encrypted": False, "open_url": sub_url}


def _deeplink_redirect_url(deep_link: str) -> str:
    """https://сайт/redirect.html?url=<схема> для telegram."""
    from urllib.parse import quote
    base = (_env("SITE_URL") or MINIAPP_URL).rstrip("/")
    if not base:
        return deep_link
    return f"{base}/redirect.html?url={quote(deep_link, safe='')}"


@app.get("/api/app/devices")
def app_devices(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    meta = get_plans_meta()
    keys = db.fetchall(
        "SELECT devices_limit, type FROM subscriptions WHERE user_id = ? AND status = 'Active'",
        (fresh["id"],),
    )
    limit = max((int(k.get("devices_limit") or 0) for k in keys), default=1)
    # докупка устройств только к платной
    can_buy = any(str(k.get("type") or "") != "trial" for k in keys)

    # реальные hwid из remnawave
    devices: list[dict[str, Any]] = []
    client, rw = _rw_find_user(fresh)
    if client and rw:
        try:
            raw = unwrap_rw(client.get_user_hwid_devices(_rw_num_id(rw)))
            items = raw.get("devices") if isinstance(raw, dict) else raw
            for d in (items or []):
                name = " · ".join(x for x in (d.get("platform"), d.get("deviceModel") or d.get("device_model")) if x)
                devices.append({
                    "id": d.get("hwid"),
                    "name": name or "Устройство",
                    "platform": d.get("platform"),
                    "last_seen": d.get("updatedAt") or d.get("updated_at") or d.get("createdAt") or d.get("created_at"),
                })
        except Exception:  # noqa: BLE001
            pass
    return {"devices": devices, "used": len(devices), "limit": limit, "can_buy": can_buy}


@app.delete("/api/app/devices/{device_id}")
def app_revoke_device(device_id: str, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    client, rw = _rw_find_user(fresh)
    if not client or not rw:
        raise HTTPException(400, detail={"message": "Устройства недоступны"})
    if not device_id:
        raise HTTPException(400, detail={"message": "Не указано устройство"})
    try:
        # отвязываем только у своего rw-аккаунта
        client.delete_hwid_device({"userId": _rw_num_id(rw), "hwid": device_id})
    except Exception as exc:  # noqa: BLE001
        forum.report_error("Не удалось отвязать устройство (мини-приложение)", f"{type(exc).__name__}: {exc}")
        raise HTTPException(502, detail={"message": "Не удалось отвязать устройство. Попробуйте позже."})
    return {"success": True, "device_id": device_id}


def _compute_order_price(user: dict[str, Any], body: CreatePaymentBody) -> dict[str, Any]:
    """цена заказа (руб/звёзды) с учётом назначения и скидки."""
    prices = plan_price_map()
    meta = get_plans_meta()
    # подписка продаётся помесячно
    if int(body.months or 1) != 1:
        raise HTTPException(400, detail={"message": "Оплата — только на 1 месяц"})
    months = 1
    extra = min(50, max(0, int(body.extra_devices or 0)))
    purpose = body.purpose or "subscription"
    extra_price = float(meta["extra_device_price"])

    if purpose == "traffic_reset":
        tr_price = float(db.get_setting("traffic_reset_price", "0") or 0)
        if tr_price <= 0:
            raise HTTPException(400, detail={"message": "Досрочный сброс трафика недоступен"})
        if subscription_status_for_user(user) not in ("active", "trial"):
            raise HTTPException(400, detail={"message": "Сброс трафика доступен только при активной подписке"})
        price = tr_price
        stars = int(round(tr_price))
    elif purpose == "devices":
        # докупка устройств: цена пропорциональна остатку дней
        if extra <= 0:
            raise HTTPException(400, detail={"message": "Не указано число устройств"})
        sub = None
        if body.subscription_id:
            sub = db.fetchone(
                "SELECT expires_at, type FROM subscriptions WHERE id = ? AND user_id = ? AND status = 'Active'",
                (body.subscription_id, user["id"]),
            )
            if not sub:
                raise HTTPException(400, detail={"message": "Подписка не найдена или не активна"})
        if not sub:
            sub = db.fetchone(
                "SELECT expires_at, type FROM subscriptions WHERE user_id = ? AND status = 'Active' "
                "ORDER BY id DESC LIMIT 1",
                (user["id"],),
            )
        if sub and sub.get("type") == "trial":
            raise HTTPException(400, detail={"message": "В пробной подписке докупить устройства нельзя — сначала оформите подписку"})
        exp = parse_iso(sub.get("expires_at")) if sub else None
        remaining_days = (exp - utcnow()).total_seconds() / 86400.0 if exp else 0
        if remaining_days <= 0:
            raise HTTPException(400, detail={"message": "Нет активной подписки для докупки устройств"})
        per_device = extra_price * (remaining_days / float(fulfillment.DAYS_PER_MONTH))
        price = round(per_device * extra, 2)
        stars = int(round(price))
        if price <= 0:
            raise HTTPException(400, detail={"message": "Стоимость докупки не рассчитана"})
    else:
        # покупка/продление: число устройств = план
        target, _upg = fulfillment.find_extend_target(int(user["id"]), purpose, body.subscription_id)
        if target and target.get("no_renew"):
            raise HTTPException(400, detail={"message": "Продление этой подписки недоступно"})
        base = prices.get(int(body.plan_devices))
        if base is None:
            raise HTTPException(400, detail={"message": "Тариф не найден"})
        total_devices = int(body.plan_devices) + extra
        keep = fulfillment.retained_devices(
            int(user["id"]), purpose, body.subscription_id, total_devices)
        # доп. устройства в месяц, как тариф, на срок
        price = float(base) * months + (extra + keep) * extra_price * months
        stars = int(round(price))  # курс 1 звезда = 1 рубль

    # скидка: промо/акция + бонус опроса; reset трафика без скидки
    full_price = round(float(price), 2)
    percent = 0.0
    if purpose != "traffic_reset":
        percent = float(effective_discount(int(user["id"]))["percent"])
        if percent > 0:
            price = discounted(price, percent)
            stars = int(discounted(stars, percent))

    return {"price": round(float(price), 2), "stars": int(stars), "months": months,
            "extra": extra, "purpose": purpose, "full_price": full_price, "discount_percent": percent}


def _referral_split(bal: float, price: float, pmin: float) -> float:
    """сколько списать с реф. баланса с учётом минимума провайдера."""
    if bal <= 0 or price <= 0:
        return 0.0
    desired = min(bal, price)
    leftover = round(price - desired, 2)
    if 0 < leftover < pmin:
        desired = price if bal >= price else round(price - pmin, 2)
    return round(max(0.0, min(bal, desired)), 2)


def _referral_preview(user_id: int, price: float, method: str, use_ref: bool) -> dict[str, Any]:
    """сколько спишется с реф. баланса и итог к оплате."""
    pmin = provider_min_rub(method)
    if not use_ref or method == "tg_stars" or price <= 0:
        return {"referral_applied": 0.0, "charge": round(price, 2), "provider_min": pmin}
    u = get_user(user_id)
    bal = float((u or {}).get("partner_balance") or 0)
    applied = _referral_split(bal, price, pmin)
    return {"referral_applied": applied, "charge": round(price - applied, 2), "provider_min": pmin}


@app.post("/api/app/payment/quote")
def app_payment_quote(body: CreatePaymentBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """предпросмотр цены без создания платежа."""
    q = _compute_order_price(get_user(int(user["id"])) or user, body)
    is_stars = body.method == "tg_stars"
    prev = _referral_preview(int(user["id"]), q["price"], body.method, bool(body.use_referral_balance))
    return {
        "purpose": q["purpose"],
        "price": q["price"],
        "stars": q["stars"],
        "full_price": q.get("full_price"),
        "discount_percent": q.get("discount_percent") or 0,
        "referral_applied": prev["referral_applied"],
        "charge": 0 if is_stars else prev["charge"],
        "provider_min": prev["provider_min"],
        "is_stars": is_stars,
    }


_MAIN_APP_CACHE: dict[str, Any] = {"at": 0.0, "value": None}


def _bot_has_main_app() -> bool:
    """есть ли у бота главное мини-приложение."""
    now = time.time()
    if _MAIN_APP_CACHE["value"] is not None and now - _MAIN_APP_CACHE["at"] < 600:
        return bool(_MAIN_APP_CACHE["value"])
    me = notifier.call("getMe", {}, timeout=5.0) or {}
    val = bool(me.get("has_main_web_app")) if me else None
    if val is not None:
        _MAIN_APP_CACHE.update(at=now, value=val)
    return bool(val)


def _payment_return_url(payment_id: str, in_telegram: bool, failed: bool = False) -> Optional[str]:
    """куда platega вернёт после оплаты (сайт или мини-приложение)."""
    if in_telegram and BOT_USERNAME:
        tag = f"{'payfail' if failed else 'pay'}_{payment_id}"
        link = (_env("TELEGRAM_MINIAPP_LINK") or "").strip().rstrip("/")
        if re.fullmatch(r"https://t\.me/[A-Za-z0-9_]{4,32}/[A-Za-z0-9_]{3,64}", link):
            return f"{link}?startapp={tag}"
        if _bot_has_main_app():
            return f"https://t.me/{BOT_USERNAME}?startapp={tag}"
        # нет главного мини-приложения: кнопка «открыть» через бота
        return f"https://t.me/{BOT_USERNAME}?start={tag}"
    suffix = "&result=fail" if failed else ""
    if MINIAPP_URL:
        return f"{MINIAPP_URL}/payment/return?payment_id={payment_id}{suffix}"
    base = PLATEGA_FAILED_URL if failed else PLATEGA_RETURN_URL
    return f"{base}?payment_id={payment_id}" if base else None


@app.post("/api/app/payment/create")
def app_payment_create(body: CreatePaymentBody, request: Request, user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    # rate limit на создание платежей
    allowed, retry = ratelimit.rate_limit(f"pay:{user['id']}", 20, 600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})

    if not user.get("terms_accepted_at"):
        raise HTTPException(403, detail={"message": "Сначала примите условия оферты и политику конфиденциальности"})
    q = _compute_order_price(user, body)
    price = q["price"]
    stars = q["stars"]
    months = q["months"]
    extra = q["extra"]

    # докупка без subscription_id: берём активную
    if q["purpose"] == "devices" and not body.subscription_id:
        s = db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Active' "
            "ORDER BY id DESC LIMIT 1", (user["id"],))
        if s:
            body.subscription_id = int(s["id"])

    is_stars = body.method == "tg_stars"
    pmin = provider_min_rub(body.method)

    # оплата реф. балансом (рубли, не stars), до 100%
    referral_applied = 0.0
    if body.use_referral_balance and not is_stars and price > 0:
        fresh = get_user(int(user["id"]))
        bal = float((fresh or {}).get("partner_balance") or 0)
        if bal > 0:
            referral_applied = _referral_split(bal, float(price), pmin)
            if referral_applied > 0:
                frozen = db.execute(
                    "UPDATE users SET partner_balance = partner_balance - ? "
                    "WHERE id = ? AND partner_balance >= ?",
                    (referral_applied, int(user["id"]), referral_applied),
                )
                if frozen.rowcount == 0:
                    referral_applied = 0.0  # баланс изменился между чтением и списанием

    charge = round(float(price) - referral_applied, 2)

    # минимум провайдера, если ему что-то платим
    if not is_stars and charge > 0 and charge < pmin:
        if referral_applied > 0:  # разморозить, раз платёж не создаём
            db.execute("UPDATE users SET partner_balance = partner_balance + ? WHERE id = ?",
                       (referral_applied, int(user["id"])))
        method_name = {"card": "картой", "sberpay": "через SberPay", "sbp": "через СБП"}.get(
            body.method, "этим способом")
        raise HTTPException(400, detail={
            "message": f"Минимальная сумма оплаты {method_name} — {int(pmin)} ₽"})

    # полностью с баланса: провайдер не нужен
    fully_by_balance = (not is_stars) and charge <= 0 and referral_applied > 0
    provider = "tg_stars" if is_stars else ("balance" if fully_by_balance else "platega")

    payment = fulfillment.create_payment_intent(
        user_id=int(user["id"]),
        provider=provider,
        method="balance" if fully_by_balance else body.method,
        amount=float(max(0.0, charge)),
        currency="XTR" if is_stars else "RUB",
        stars=stars if is_stars else None,
        purpose=body.purpose or "subscription",
        plan_devices=int(body.plan_devices),
        months=months,
        extra_devices=extra,
        subscription_id=body.subscription_id,
        referral_applied=referral_applied,
    )
    payment_id = payment["payment_id"]
    ret = str(body.return_to or "").strip()
    if ret.startswith("/") and not ret.startswith("//") and len(ret) <= 200:
        db.execute("UPDATE payments SET return_to = ? WHERE payment_id = ?", (ret, payment_id))

    if fully_by_balance:
        res = fulfillment.fulfill_payment(payment_id)
        if res.get("ok"):
            return {
                "payment_id": payment_id, "amount": 0, "full_price": float(price),
                "referral_applied": referral_applied, "currency": "RUB",
                "method": "balance", "provider": "balance", "status": "paid", "paid": True,
            }
        fulfillment.mark_failed(payment_id, "balance_fulfill_failed")  # вернёт баланс
        raise HTTPException(502, detail={"message": "Не удалось активировать. Средства возвращены на баланс."})

    # описание для провайдера: «назначение (id юзера)»
    title = "BlinVPN"
    description = _payment_description(q["purpose"], int(user["id"]))

    if is_stars:
        if telegram_stars is None or not telegram_stars.TelegramStars().is_configured():
            fulfillment.mark_failed(payment_id, "stars_not_configured")
            raise HTTPException(503, detail={"message": "Оплата звёздами недоступна"})
        try:
            link = telegram_stars.TelegramStars().create_invoice_link(
                title=title, description=description, payload=payment_id, stars=stars
            )
        except Exception as exc:  # noqa: BLE001
            fulfillment.mark_failed(payment_id, f"stars_invoice_error: {exc}")
            forum.report_error("Не удалось создать счёт Telegram Stars", f"{type(exc).__name__}: {exc}")
            raise HTTPException(502, detail={"message": "Не удалось создать счёт в звёздах"})
        fulfillment.set_provider_data(payment_id, invoice_link=link)
        return {
            "payment_id": payment_id,
            "amount": stars,
            "currency": "XTR",
            "method": body.method,
            "provider": "tg_stars",
            "invoice_link": link,
            "pay_url": None,
            "status": "pending",
        }

    if platega is None:
        fulfillment.mark_failed(payment_id, "platega_module_missing")
        raise HTTPException(503, detail={"message": "Платёжная система недоступна"})
    client = platega.get_client()
    if not client.is_configured():
        fulfillment.mark_failed(payment_id, "platega_not_configured")
        raise HTTPException(503, detail={"message": "Платёжная система не настроена"})

    method_code = platega.APP_METHOD_MAP.get(body.method, platega.METHOD_SBP)
    # return url: мини-приложение или сайт
    in_telegram = bool((request.headers.get("X-Telegram-Init-Data") or "").strip())
    return_url = _payment_return_url(payment_id, in_telegram)
    failed_url = _payment_return_url(payment_id, in_telegram, failed=True)
    try:
        tx = client.create_transaction(
            amount=float(charge),
            method=method_code,
            currency="RUB",
            description=description,
            return_url=return_url,
            failed_url=failed_url,
            payload=payment_id,
            user_id=str(user["telegram_id"] or f"web{int(user['id'])}"),
        )
    except Exception as exc:  # noqa: BLE001
        fulfillment.mark_failed(payment_id, f"platega_error: {exc}")
        forum.report_error("Не удалось создать ссылку на оплату (Platega)", f"{type(exc).__name__}: {exc}")
        raise HTTPException(502, detail={"message": "Не удалось создать платёж"})

    provider_txn = tx.get("transactionId") or tx.get("id")
    pay_url = tx.get("redirect") or tx.get("url")
    fulfillment.set_provider_data(
        payment_id, provider_payment_id=str(provider_txn) if provider_txn else None, pay_url=pay_url
    )
    return {
        "payment_id": payment_id,
        "amount": charge,
        "full_price": float(price),
        "referral_applied": referral_applied,
        "currency": "RUB",
        "method": body.method,
        "provider": "platega",
        "pay_url": pay_url,
        "transaction_id": provider_txn,
        "status": "pending",
    }


def _devices_label(n: int) -> str:
    n = max(1, int(n))
    if n == 1:
        return "1 устройство"
    if 2 <= n <= 4:
        return f"{n} устройства"
    return f"{n} устройств"


@app.get("/api/app/payment/unseen")
def app_payment_unseen(payment_id: Optional[str] = Query(None, max_length=64),
                       user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """платёж, итог которого юзер ещё не видел."""
    now = utcnow()
    if payment_id:
        row = db.fetchone(
            "SELECT * FROM payments WHERE payment_id = ? AND user_id = ? AND provider != 'balance' AND created_at >= ?",
            (str(payment_id), int(user["id"]), iso(now - timedelta(hours=24))))
    else:
        row = None
    row = row or db.fetchone(
        "SELECT * FROM payments WHERE user_id = ? AND result_seen_at IS NULL "
        "AND provider != 'balance' AND created_at >= ? "
        "AND (status IN ('paid', 'processing') OR (status = 'pending' AND created_at >= ?)) "
        "ORDER BY created_at DESC LIMIT 1",
        (int(user["id"]), iso(now - timedelta(hours=24)), iso(now - timedelta(minutes=30))),
    )
    if not row:
        return {"payment": None}
    return {"payment": {
        "payment_id": row["payment_id"],
        "status": row["status"],
        "provider": row.get("provider"),
        "purpose": row.get("purpose"),
        "return_to": row.get("return_to"),
        "pay_url": row.get("pay_url"),
        "invoice_link": row.get("invoice_link"),
    }}


class PaymentSeenBody(BaseModel):
    payment_id: str


@app.post("/api/app/payment/seen")
def app_payment_seen(body: PaymentSeenBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """юзер увидел итог оплаты: больше не показываем при старте."""
    db.execute(
        "UPDATE payments SET result_seen_at = ? WHERE payment_id = ? AND user_id = ? AND result_seen_at IS NULL",
        (db.utcnow_iso(), str(body.payment_id), int(user["id"])),
    )
    return {"ok": True}


@app.get("/api/app/payment/status")
def app_payment_status(
    payment_id: str = Query(...), user: dict = Depends(_app_user_from_init)
) -> dict[str, Any]:
    payment = fulfillment.get_payment(payment_id)
    if not payment or int(payment["user_id"]) != int(user["id"]):
        raise HTTPException(404, detail={"message": "Платёж не найден"})

    # pending: спросить провайдера не чаще раза / 10 сек
    if payment["status"] == "pending":
        allowed, _ = ratelimit.rate_limit(f"paycheck:{payment_id}", 1, 10)
        if allowed:
            fulfillment.confirm_via_provider(payment_id)
            payment = fulfillment.get_payment(payment_id) or payment

    sub = None
    if payment.get("subscription_id"):
        row = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (payment["subscription_id"],))
        if row:
            sub = serialize_key(row, get_user(int(user["id"])))

    return {
        "payment_id": payment_id,
        "status": payment["status"],  # pending | paid | failed
        "provider": payment.get("provider"),
        "amount": payment.get("amount"),
        "currency": payment.get("currency"),
        "pay_url": payment.get("pay_url"),
        "invoice_link": payment.get("invoice_link"),
        "purpose": payment.get("purpose"),
        "subscription": sub,
    }


@app.post("/api/app/promocode/redeem")
def app_promo_redeem(body: RedeemPromoBody, user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    # защита от перебора промокодов
    allowed, retry = ratelimit.rate_limit(f"promo:{user['id']}", 10, 600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком много попыток. Повторите через {retry} сек."})
    info = apply_promo_to_user(int(user["id"]), body.code)
    return {
        "success": True,
        "type": "discount",
        "value": info["percent"],
        "discount_percent": info["percent"],
        "expires_at": info["expires_at"],
    }


@app.get("/api/app/discount")
def app_discount(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """итоговая скидка или {active: false}."""
    return effective_discount(int(user["id"]))


def mask_email(email: str) -> str:
    """маскировка локальной части email."""
    email = (email or "").strip()
    if "@" not in email:
        return email
    local, _, dom = email.partition("@")
    if len(local) <= 2:
        masked = (local[:1] or "*") + "**"
    else:
        masked = local[0] + "**" + local[-2:]
    return f"{masked}@{dom}"


def _referral_display(u: dict[str, Any]) -> dict[str, Any]:
    """данные приглашённого для мини-приложения."""
    username = (u.get("username") or "").lstrip("@")
    email = u.get("email")
    if username:
        name = f"@{username}"
    elif email:
        name = mask_email(str(email))
    elif u.get("telegram_id"):
        # telegram id приглашённого целиком не показываем
        tg = str(u.get("telegram_id"))
        name = f"id{tg[:3]}•••{tg[-2:]}" if len(tg) > 5 else "Пользователь"
    else:
        name = f"#{u.get('id')}"
    seed = (username or (str(email) if email else "") or "?")
    initial = (seed.lstrip("@")[:1] or "?").upper()
    return {
        "id": u.get("id"),
        "username": username or None,
        "name": name,
        "initial": initial,
    }


@app.get("/api/app/referral")
def app_referral(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    refs = db.fetchall("SELECT * FROM users WHERE referred_by = ? ORDER BY id DESC", (fresh["id"],))
    # заработок с приглашённого из transactions
    earned: dict[int, float] = {}
    for r in db.fetchall(
        "SELECT description, SUM(amount) AS total FROM transactions "
        "WHERE user_id = ? AND payment_method = 'referral' AND status = 'completed' "
        "AND description LIKE 'referral bonus from user %' GROUP BY description",
        (fresh["id"],),
    ):
        try:
            earned[int(str(r["description"]).rsplit(" ", 1)[-1])] = round(float(r["total"] or 0), 2)
        except (TypeError, ValueError):
            continue
    items = []
    for u in refs:
        item = _referral_display(u)
        item["earned"] = earned.get(int(u["id"]), 0)
        items.append(item)
    # сначала кто принёс больше, потом новые
    items.sort(key=lambda x: -float(x["earned"] or 0))
    return {
        # реф. ссылка: t.me/<bot>?start=ref_<id>
        "code": str(fresh["id"]),
        "link": f"https://t.me/{BOT_USERNAME}?start=ref_{fresh['id']}",
        "is_partner": bool(fresh.get("is_partner")),
        "partner_balance": fresh.get("partner_balance", 0),
        "partner_rate": fresh.get("partner_rate", 25),
        "referrals_count": len(refs),
        "referrals": items,
        "earned_total": round(sum(earned.values()), 2),
        "min_withdraw": int(services.MIN_WITHDRAW_RUB),
    }


@app.get("/api/app/withdrawals")
def app_withdrawals(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    rows = db.fetchall(
        "SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50",
        (int(user["id"]),),
    )
    return {
        "items": [services.serialize_withdrawal(w) for w in rows],
        "min_withdraw": int(services.MIN_WITHDRAW_RUB),
    }


@app.post("/api/app/withdraw")
def app_withdraw(body: WithdrawBody, user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    # rate limit на заявки вывода
    allowed, retry = ratelimit.rate_limit(f"withdraw:{user['id']}", 5, 600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})
    try:
        w = services.request_withdrawal(int(user["id"]), body.amount, body.address)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})

    # уведомление в форум «выводы»
    try:
        res = forum.notify_withdrawal(w)
        if res and res.get("message_id"):
            services.set_withdrawal_forum_ref(int(w["id"]), res.get("chat", {}).get("id") or forum.chat_id(), int(res["message_id"]))
    except Exception:  # noqa: BLE001
        pass

    fresh = get_user(int(user["id"]))
    return {
        "success": True,
        "withdrawal": services.serialize_withdrawal(w),
        "partner_balance": (fresh or {}).get("partner_balance", 0),
    }


@app.get("/api/app/history")
def app_history(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    uid = int(user["id"])
    items = db.fetchall(
        # только проведённые и возвраты
        "SELECT t.*, p.purpose AS p_purpose, p.method AS p_method, p.provider AS p_provider, "
        "p.stars AS p_stars, p.amount AS p_amount, p.extra_devices AS p_extra, p.grant_info AS p_grant, "
        "p.id AS p_id FROM transactions t "
        "LEFT JOIN payments p ON p.payment_id = t.payment_id AND p.user_id = t.user_id "
        "WHERE t.user_id = ? AND t.status IN ('completed', 'refunded') "
        "ORDER BY t.created_at DESC, t.id DESC",
        (uid,),
    )
    # первая оплата: покупка, дальше продление
    first = db.fetchone(
        "SELECT MIN(id) AS id FROM payments WHERE user_id = ? AND purpose IN ('subscription', 'extend') "
        "AND status IN ('paid', 'completed', 'refunded')", (uid,))
    first_id = (first or {}).get("id")
    out = [_history_item(tx, first_id) for tx in items]
    # выводы (отклонённые не показываем)
    wd_status = {"pending": "на рассмотрении", "approved": "одобрен, ждёт перевода", "completed": "выплачено"}
    for w in db.fetchall("SELECT * FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'approved', 'completed')", (uid,)):
        out.append({
            "id": f"w{w['id']}", "title": "Вывод средств", "method": wd_status.get(w["status"], ""),
            "amount": round(float(w.get("amount") or 0), 2), "stars": None, "direction": "out",
            "status": "completed", "created_at": w.get("created_at"),
            "payment_method": "withdrawal", "description": "Вывод средств",
        })
    out.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return {"items": out}


_HISTORY_METHOD = {"sbp": "СБП", "card": "картой", "sberpay": "SberPay", "tg_stars": "звёздами",
                   "stars": "звёздами", "balance": "с реф. баланса", "crypto": "криптой"}


def _history_item(tx: dict[str, Any], first_sub_payment_id: Any = None) -> dict[str, Any]:
    """строка истории для мини-приложения."""
    method = str(tx.get("payment_method") or "")
    amount = float(tx.get("amount") or 0)
    stars = None
    if tx.get("p_purpose"):  # операция связана с нашим платежом
        purpose = str(tx["p_purpose"])
        if purpose == "devices":
            g = db.loads(tx.get("p_grant"), {}) if tx.get("p_grant") else {}
            before, after = (g or {}).get("devices_before"), (g or {}).get("devices_after")
            if before and after:
                title = f"Покупка устройства ({before} → {after})"
            else:
                n = int(tx.get("p_extra") or 1)
                title = f"Покупка устройства (+{n})"
        elif purpose == "traffic_reset":
            title = "Сброс трафика"
        else:
            # оплата с реф. баланса / докупка устройств: всё равно подписка
            title = "Покупка подписки" if tx.get("p_id") == first_sub_payment_id else "Продление подписки"
        pm = str(tx.get("p_method") or tx.get("p_provider") or "")
        sub = _HISTORY_METHOD["balance"] if tx.get("p_provider") == "balance" else _HISTORY_METHOD.get(pm.lower(), "")
        if pm == "tg_stars" and tx.get("p_stars"):
            stars = int(tx["p_stars"])
        amount = -abs(float(tx.get("p_amount") if tx.get("p_amount") is not None else amount))
        direction = "out"
    elif method == "referral":
        title, sub, direction = "Бонус за друга", "", "in"
    elif method == "referral_reversal":
        title, sub, direction = "Бонус за друга", "отменён: друг вернул оплату", "out"
    elif amount >= 0:
        title, sub, direction = "Начисление баланса", "", "in"
    else:
        title, sub, direction = "Списание баланса", "", "out"
    return {
        "id": tx["id"],
        "title": title,
        "method": sub,
        "amount": round(abs(amount), 2),
        "stars": stars,
        "direction": direction,
        "status": tx.get("status"),
        "created_at": tx.get("created_at"),
        # старые поля для кэшированной старой версии мини-приложения
        "payment_method": tx.get("payment_method"),
        "description": title,
    }


@app.get("/api/app/plans")
def app_plans() -> dict[str, Any]:
    meta = get_plans_meta()
    return {
        "plans": get_active_plans(),
        "extra_device_price": meta["extra_device_price"],
        "base_price": meta["base_price"],
    }


@app.get("/api/app/legal")
def app_legal() -> dict[str, Any]:
    return {
        "offer": db.get_setting("offer_text", ""),
        "privacy": db.get_setting("privacy_text", ""),
    }


def _require_internal(secret: Optional[str]) -> None:
    """доступ к internal api; без секрета в проде закрыто."""
    if not INTERNAL_API_SECRET:
        if ENV == "production":
            raise HTTPException(403, detail="Forbidden")
        return
    if not secret or not hmac.compare_digest(str(secret), INTERNAL_API_SECRET):
        raise HTTPException(403, detail="Forbidden")


@app.post("/api/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: Optional[str] = Header(None, alias="X-Telegram-Bot-Api-Secret-Token"),
) -> dict[str, Any]:
    # апдейт проверяем по secret из setwebhook
    # без секрета в проде вебхук запрещён
    if not TELEGRAM_WEBHOOK_SECRET:
        if IS_PROD:
            raise HTTPException(403, detail="Forbidden")
    elif not x_telegram_bot_api_secret_token or not hmac.compare_digest(
        str(x_telegram_bot_api_secret_token), TELEGRAM_WEBHOOK_SECRET
    ):
        raise HTTPException(403, detail="Forbidden")
    try:
        update = await request.json()
    except Exception:  # noqa: BLE001
        return {"ok": True}

    try:
        # pre_checkout_query: ответить за 10 сек
        pcq = update.get("pre_checkout_query")
        if pcq:
            payment_id = pcq.get("invoice_payload") or ""
            payment = fulfillment.get_payment(payment_id) if payment_id else None
            ok = fulfillment.stars_precheckout_ok(payment, pcq)
            body: dict[str, Any] = {"pre_checkout_query_id": pcq["id"], "ok": ok}
            if not ok:
                body["error_message"] = "Платёж не найден или уже обработан."
            notifier.call("answerPreCheckoutQuery", body)
            return {"ok": True}

        message = update.get("message") or {}
        sp = message.get("successful_payment")
        if sp:
            payment_id = sp.get("invoice_payload") or ""
            charge_id = sp.get("telegram_payment_charge_id") or ""
            if payment_id:
                res = fulfillment.fulfill_payment(
                    payment_id, stars_charge_id=charge_id, amount=sp.get("total_amount"),
                    stars_payer_id=(message.get("from") or {}).get("id"),
                )
                chat_id = (message.get("chat") or {}).get("id")
                if chat_id:
                    text = ("✅ <b>Оплата получена!</b>\nПодписка активирована."
                            if res.get("ok") else
                            "⚠️ Оплата получена, но при активации возникла ошибка. Напишите в поддержку.")
                    notifier.call("sendMessage", {"chat_id": chat_id, "text": text, "parse_mode": "HTML"})
    except Exception as exc:  # noqa: BLE001
        try:
            forum.report_error("Ошибка обработки Telegram webhook", f"{type(exc).__name__}: {exc}")
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True}


@app.get("/api/internal/ping")
def internal_ping(x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret")) -> dict[str, Any]:
    _require_internal(x_internal_secret)
    return {"ok": True}


class InternalFulfillBody(BaseModel):
    payment_id: str
    provider_payment_id: Optional[str] = None
    amount: Optional[float] = None
    stars_charge_id: Optional[str] = None


@app.post("/api/internal/payments/fulfill")
def internal_payment_fulfill(
    body: InternalFulfillBody,
    x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
) -> dict[str, Any]:
    _require_internal(x_internal_secret)
    return fulfillment.fulfill_payment(
        body.payment_id,
        provider_payment_id=body.provider_payment_id,
        amount=body.amount,
        stars_charge_id=body.stars_charge_id,
    )


@app.post("/api/internal/payments/fail")
def internal_payment_fail(
    body: InternalFulfillBody,
    x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
) -> dict[str, Any]:
    _require_internal(x_internal_secret)
    fulfillment.mark_failed(body.payment_id, "provider_canceled")
    return {"ok": True}


@app.post("/api/internal/payments/chargeback")
def internal_payment_chargeback(
    body: InternalFulfillBody,
    x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
) -> dict[str, Any]:
    """чарджбек от platega: помечаем, автоматом не откатываем."""
    _require_internal(x_internal_secret)
    p = fulfillment.get_payment(body.payment_id)
    if not p:
        return {"ok": False, "error": "payment_not_found"}
    if p.get("chargeback_reported_at"):
        return {"ok": True, "skipped": "already_reported"}
    db.execute("UPDATE payments SET chargeback_reported_at = ? WHERE payment_id = ? AND chargeback_reported_at IS NULL",
               (db.utcnow_iso(), body.payment_id))
    st = str(p.get("status") or "")
    if st == "paid":
        todo = "НЕ делайте возврат. Панель → Финансы → ⋯ → «Чарджбек»."
    elif st in ("refunding", "refunded"):
        todo = "ВНИМАНИЕ: по этому платежу уже делался возврат — деньги могли уйти дважды, свяжитесь с Platega."
    elif st == "chargeback":
        todo = "Чарджбек в панели уже проведён."
    else:
        todo = f"Статус платежа: {st}."
    try:
        forum.report_error(
            "Platega: чарджбек по платежу",
            f"payment_id={body.payment_id}, транзакция Platega {p.get('provider_payment_id')}, user id{p.get('user_id')}, "
            f"{p.get('amount')}₽. {todo}",
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "reported": True}


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "message" in detail:
        return JSONResponse(status_code=exc.status_code, content={"detail": detail, "error": detail.get("message")})
    if isinstance(detail, str):
        return JSONResponse(status_code=exc.status_code, content={"detail": detail, "error": detail})
    return JSONResponse(status_code=exc.status_code, content={"detail": detail})


@app.exception_handler(OverflowError)
async def overflow_handler(_: Request, __: OverflowError):
    # id слишком большой для sqlite: объекта нет
    return JSONResponse(status_code=404, content={"detail": {"message": "Не найдено"}, "error": "Не найдено"})


def _sup(fn, *a, **k):
    try:
        return fn(*a, **k)
    except support.SupportError as e:
        raise HTTPException(e.status, detail={"message": e.message})


def _support_user(user: dict[str, Any]) -> dict[str, Any]:
    """из чёрного списка поддержку не видит."""
    fresh = get_user(int(user["id"])) or user
    if fresh.get("is_banned") and str(fresh.get("ban_reason") or "").startswith(blacklist.BAN_REASON_PREFIX):
        raise HTTPException(403, detail={"message": "Поддержка недоступна"})
    return fresh


def _support_limits() -> dict[str, Any]:
    return {"max_file_mb": support.MAX_FILE_BYTES // support.MB, "max_files": support.MAX_FILES_PER_MESSAGE,
            "max_text": support.MAX_TEXT, "keep_days": support.KEEP_AFTER_CLOSE_DAYS}


def _for_user(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ответ юзеру без имён сотрудников и номеров."""
    return [support.public_message(m) for m in msgs if not m.get("internal")]


async def _stream_upload(request: Request, chat_id: int, uploader: str, uploader_id: str, name: str) -> dict[str, Any]:
    """тело = байты файла; обрыв сверх лимита."""
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > support.MAX_FILE_BYTES:
        raise HTTPException(413, detail={"message": f"Файл больше {support.MAX_FILE_BYTES // support.MB} МБ"})
    up = _sup(support.Upload, chat_id, uploader, uploader_id, name)
    if declared and declared > up.limit:
        up.abort()
        raise HTTPException(413, detail={"message": f"Файл больше {up.limit // support.MB} МБ"})
    try:
        async for chunk in request.stream():
            up.write(chunk)
    except support.SupportError as e:
        raise HTTPException(e.status, detail={"message": e.message})
    except BaseException:
        up.abort()
        raise
    return _sup(up.finish)


def _notify_support_forum(user: dict[str, Any], chat: dict[str, Any], msg: dict[str, Any]) -> None:
    """сообщение юзера -> топик поддержки."""
    try:
        fresh = support.get_chat(int(chat["id"])) or chat
        t = support.ticket_info(fresh) or {}
        first = bool(db.fetchone("SELECT 1 FROM support_messages WHERE ticket_id = ? AND sender = 'user' AND id < ? LIMIT 1",
                                 (msg.get("ticket_id"), msg["id"]))) is False
        if not first and int(fresh.get("unread_admin") or 0) > 1:
            prev = db.fetchone("SELECT created_at FROM support_messages WHERE chat_id = ? AND sender = 'user' AND id < ? "
                               "ORDER BY id DESC LIMIT 1", (chat["id"], msg["id"]))
            p = parse_iso(prev["created_at"]) if prev else None
            if p and (utcnow() - p).total_seconds() < 120:
                return
        base = forum.panel_url()
        who = forum.user_link(int(user["id"]))
        head = f"🆕 <b>Новое обращение №{t.get('number')}</b>" if first else f"💬 <b>Обращение №{t.get('number')}</b>"
        text = _esc_html(msg.get("text") or "")[:600]
        files = msg.get("files") or []
        att = f"\n📎 {len(files)} влож." if files else ""
        link = f'\n<a href="{_esc_html(base)}/support/{int(chat["id"])}">Открыть чат</a>' if base else ""
        forum.send("support", f"{head} · {who} ({_esc_html(_user_label(user))})\n{text}{att}{link}")
        if first:
            webpush.send("all", "🆕 Новое обращение", f"{_user_label(user)}: {(msg.get('text') or '📎 вложение')[:200]}",
                         url=f"/support/{int(chat['id'])}", tag=f"chat{int(chat['id'])}")
    except Exception:  # noqa: BLE001
        pass


def _notify_support_user(user: dict[str, Any], msg: dict[str, Any], chat: Optional[dict[str, Any]] = None) -> Optional[int]:
    """ответ поддержки -> бот и почта."""
    email = (user.get("email") or "").strip()
    if email and chat is not None and mailer.is_configured():
        last = parse_iso(chat.get("last_email_at")) if chat.get("last_email_at") else None
        if not last or (utcnow() - last).total_seconds() > 600:
            db.execute("UPDATE support_chats SET last_email_at = ? WHERE id = ?", (iso(), chat["id"]))
            _mail_async(mailer.send_support_reply, email, msg.get("text") or "", len(msg.get("files") or []),
                        f"{MINIAPP_URL}/support" if MINIAPP_URL else "")
    tg = user.get("telegram_id")
    if not tg:
        return None
    try:
        payload: dict[str, Any] = {"chat_id": int(tg), "text": _tg_support_text(msg.get("text") or ""), "parse_mode": "HTML",
                                   "link_preview_options": {"is_disabled": True}}
        if MINIAPP_URL:
            payload["reply_markup"] = {"inline_keyboard": [[{"text": "Открыть чат", "web_app": {"url": f"{MINIAPP_URL}/support"}}]]}
        res = notifier.call("sendMessage", payload)
        return int(res["message_id"]) if isinstance(res, dict) and res.get("message_id") else None
    except Exception:  # noqa: BLE001
        return None


def _support_cleanup_loop() -> None:
    """раз в час: чистка старых переписок и журнала."""
    while True:
        try:
            db.execute("DELETE FROM panel_audit WHERE ts < ?", (iso(utcnow() - timedelta(days=180)),))
        except Exception:  # noqa: BLE001
            pass
        try:
            r = support.cleanup()
            if r.get("messages") or r.get("files"):
                print(f"[support] удалено старых сообщений: {r['messages']}, файлов: {r['files']}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[support] cleanup failed: {exc}", flush=True)
        time.sleep(3600)


def _support_autoclose_loop() -> None:
    """раз в минуту: закрыть тикеты без ответа 60 мин."""
    while True:
        time.sleep(60)
        try:
            support.auto_close_expired()
        except Exception as exc:  # noqa: BLE001
            print(f"[support] autoclose failed: {exc}", flush=True)


def _xbm_client():
    client = _rw_client()
    if client is None:
        raise xbm.XbmError("Remnawave не настроена — хосты взять неоткуда", 503)
    return client


def _xbm_hosts_raw() -> Any:
    return _xbm_client().get_hosts()


def _xbm_templates() -> tuple[Optional[list[dict[str, Any]]], Optional[str]]:
    """шаблоны xray json из remnawave."""
    try:
        return xbm.normalize_templates(_xbm_client().get_subscription_templates()), None
    except xbm.XbmError as e:
        return None, e.message
    except Exception as exc:  # noqa: BLE001
        return None, f"Не удалось получить шаблоны из Remnawave: {type(exc).__name__}"


def _xbm_sync(hosts: Optional[list[dict[str, Any]]] = None, strict: bool = False) -> dict[str, Any]:
    client = _xbm_client()
    return xbm.sync(client.get_hosts, client.get_subscription_templates, client.get_subscription_template,
                    hosts=hosts, strict=strict)


def _xbm_state(hosts: Optional[list[dict[str, Any]]] = None, error: Optional[str] = None,
               templates: Optional[list[dict[str, Any]]] = None, templates_error: Optional[str] = None) -> dict[str, Any]:
    s = xbm.get_settings()
    hosts = hosts or []
    in_group = {u: g["id"] for g in s["groups"] for u in g["hosts"]}
    return {
        "xbm": xbm.health(),
        "configured": xbm.configured(),
        "settings": s,
        "hosts": [{k: h[k] for k in ("uuid", "remark", "address", "port", "disabled", "hidden", "description")}
                  | {"group": in_group.get(h["uuid"])} for h in hosts],
        "templates": [{"uuid": t["uuid"], "name": t["name"]} for t in templates] if templates is not None else None,
        "templates_error": templates_error,
        "duplicates": xbm.duplicate_remarks(hosts),
        "last_sync": xbm.last_sync(),
        "error": error,
        "limits": {"name": xbm.MAX_NAME, "description": xbm.MAX_DESCRIPTION, "groups": xbm.MAX_GROUPS},
    }


@app.get("/api/panel/xbm")
def panel_xbm_get(_: dict = Depends(require_owner)) -> dict[str, Any]:
    try:
        hosts = xbm.normalize_hosts(_xbm_hosts_raw())
    except xbm.XbmError as e:
        return _xbm_state([], e.message)
    except Exception as exc:  # noqa: BLE001
        return _xbm_state([], f"Не удалось получить хосты из Remnawave: {type(exc).__name__}")
    tpls, tpl_err = _xbm_templates()
    return _xbm_state(hosts, templates=tpls, templates_error=tpl_err)


@app.put("/api/panel/xbm")
def panel_xbm_save(body: dict[str, Any] = Body(...), _: dict = Depends(require_owner)) -> dict[str, Any]:
    if len(json.dumps(body, ensure_ascii=False)) > 256_000:
        raise HTTPException(413, detail={"message": "Слишком большие настройки"})
    try:
        hosts = xbm.normalize_hosts(_xbm_hosts_raw())
        tpls, tpl_err = _xbm_templates()
        with xbm.save_lock:  # сверка не вклинится между save и rollback
            prev = db.get_setting(xbm.SETTINGS_KEY, "")
            xbm.save_settings(xbm.validate(body, hosts, tpls))
            try:
                _xbm_sync(hosts, strict=True)
            except Exception:
                # panel.json не записался: откатываем настройки в панели
                db.set_setting(xbm.SETTINGS_KEY, prev)
                raise
    except xbm.XbmError as e:
        raise HTTPException(e.status, detail={"message": e.message})
    except OSError as exc:
        raise HTTPException(500, detail={"message": f"Не удалось записать настройки для XBM: {exc.strerror or exc}"})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail={"message": f"Remnawave не ответила: {type(exc).__name__}"})
    return _xbm_state(hosts, templates=tpls, templates_error=tpl_err)


@app.get("/api/panel/xbm/preview")
def panel_xbm_preview(user_id: int = Query(..., ge=1, le=2 ** 62), _: dict = Depends(require_owner)) -> dict[str, Any]:
    """как подписку юзера увидит happ через xbm."""
    sub = db.fetchone("SELECT short_uuid FROM subscriptions WHERE user_id = ? AND status = 'Active' AND short_uuid IS NOT NULL "
                      "AND short_uuid != '' ORDER BY id DESC LIMIT 1", (int(user_id),))
    if not sub:
        raise HTTPException(404, detail={"message": "У пользователя нет активной подписки"})
    # hwid уже привязанного устройства, если есть
    hwid = None
    user = get_user(int(user_id))
    try:
        client, rw = _rw_find_user(user) if user else (None, None)
        if client and rw:
            raw = unwrap_rw(client.get_user_hwid_devices(_rw_num_id(rw)))
            items = raw.get("devices") if isinstance(raw, dict) else raw
            if items:
                hwid = str((items[0] or {}).get("hwid") or "") or None
    except Exception:  # noqa: BLE001
        hwid = None
    try:
        return {"locations": xbm.preview(str(sub["short_uuid"]), hwid=hwid)}
    except xbm.XbmError as e:
        raise HTTPException(e.status, detail={"message": e.message})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail={"message": f"XBM недоступен: {type(exc).__name__}"})


_HOST_RX = re.compile(r"^(?=.{4,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")


def _server_ip() -> str:
    ip = _env("SERVER_IP")
    if ip:
        return ip
    try:
        import socket as _s
        with _s.socket(_s.AF_INET, _s.SOCK_DGRAM) as so:
            so.connect(("1.1.1.1", 53))
            return so.getsockname()[0]
    except OSError:
        return ""


def _mail_smtp_params(body: dict[str, Any]) -> tuple[str, int, str, Optional[str]]:
    provider = str(body.get("provider") or "")
    if provider in mailer.SMTP_PRESETS:
        host, port = mailer.SMTP_PRESETS[provider]
    else:
        host = str(body.get("host") or "").strip().lower()
        try:
            port = int(body.get("port") or 465)
        except (TypeError, ValueError):
            port = 0
        if not _HOST_RX.fullmatch(host):
            raise HTTPException(400, detail={"message": "Неверный адрес SMTP-сервера"})
        if port not in (465, 587, 2525, 25):
            raise HTTPException(400, detail={"message": "Порт — 465 или 587"})
    user = str(body.get("user") or "").strip()
    if not _valid_email(user):
        raise HTTPException(400, detail={"message": "Неверный адрес почты"})
    pwd = body.get("password")
    pwd = re.sub(r"\s+", "", str(pwd))[:200] if pwd else None  # google показывает пароль с пробелами
    return host, port, user, pwd


@app.get("/api/panel/mail")
def panel_mail_get(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return {**mailer.public_config(), "server_ip": _server_ip()}


@app.post("/api/panel/mail/login-test")
def panel_mail_login_test(body: dict[str, Any] = Body(...), _: dict = Depends(require_owner)) -> dict[str, Any]:
    host, port, user, pwd = _mail_smtp_params(body)
    if not pwd:
        cur = mailer.config()
        pwd = cur["password"] if cur.get("user") == user and cur.get("host") == host else ""
    if not pwd:
        raise HTTPException(400, detail={"message": "Введите пароль приложения"})
    ok, err = mailer.smtp_login_test(host, port, user, pwd)
    if not ok:
        raise HTTPException(400, detail={"message": err})
    return {"ok": True}


@app.post("/api/panel/mail/port25")
def panel_mail_port25(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return {"open": mailer.port25_open(), "server_ip": _server_ip()}


@app.post("/api/panel/mail/dns")
def panel_mail_dns(body: dict[str, Any] = Body(...), _: dict = Depends(require_owner)) -> dict[str, Any]:
    dom = str(body.get("domain") or "").strip().lower()
    if not _HOST_RX.fullmatch(dom):
        raise HTTPException(400, detail={"message": "Неверный домен"})
    return {"records": mailer.dns_records(dom, _server_ip()), "ptr": f"mail.{dom}"}


@app.put("/api/panel/mail")
def panel_mail_save(body: dict[str, Any] = Body(...), _: dict = Depends(require_owner)) -> dict[str, Any]:
    mode = str(body.get("mode") or "")
    if mode == "off":
        cur = mailer.config()
        mailer.save_config("off", host=cur["host"], port=cur["port"], user=cur["user"], domain_name=cur["domain"])
    elif mode == "smtp":
        host, port, user, pwd = _mail_smtp_params(body)
        cur = mailer.config()
        same_box = cur.get("user") == user and str(cur.get("host") or "").lower() == host.lower()
        if not pwd and not (same_box and cur.get("password")):
            raise HTTPException(400, detail={"message": "Введите пароль приложения"})
        if pwd is None and cur.get("source") == "env" and same_box:
            pwd = cur["password"]
        mailer.save_config("smtp", host=host, port=port, user=user, password=pwd)
    elif mode == "direct":
        dom = str(body.get("domain") or "").strip().lower()
        if not _HOST_RX.fullmatch(dom):
            raise HTTPException(400, detail={"message": "Неверный домен"})
        mailer.ensure_dkim(dom)
        mailer.save_config("direct", domain_name=dom)
    else:
        raise HTTPException(400, detail={"message": "Неверный способ"})
    return panel_mail_get(_)


@app.post("/api/panel/mail/send-test")
def panel_mail_send_test(body: dict[str, Any] = Body(...), _: dict = Depends(require_owner)) -> dict[str, Any]:
    to = str(body.get("to") or "").strip()
    if not _valid_email(to):
        raise HTTPException(400, detail={"message": "Неверный адрес"})
    if not mailer.is_configured():
        raise HTTPException(409, detail={"message": "Почта не настроена"})
    ok, err = mailer.send(to, "BlinVPN: проверка почты", text="Почта настроена — письма уходят.")
    if not ok:
        raise HTTPException(502, detail={"message": err[:300]})
    return {"ok": True}


@app.get("/api/panel/xbm/setup")
def panel_xbm_setup_info(_: dict = Depends(require_owner)) -> dict[str, Any]:
    """мастер xbm: жив ли помощник, подсказки полей."""
    from urllib.parse import urlsplit
    sub = urlsplit(_env("REMWAVE_SUB_PUBLIC_URL") or "")
    panel = (_env("REMWAVE_PANEL_URL") or "").rstrip("/") or "http://remnawave:3000"
    return {"runner": xbm.runner_alive(), "xbm": xbm.health(),
            "defaults": {"remnawave_url": panel, "sub_domain": sub.hostname or "",
                         "conf": "/opt/remnawave/nginx/nginx.conf", "container": "remnawave-nginx",
                         "network": "remnawave-network"}}


@app.post("/api/panel/xbm/setup/{action}")
def panel_xbm_setup_run(action: str, body: dict[str, Any] = Body(default={}), _: dict = Depends(require_owner)) -> dict[str, Any]:
    params = {k: str(v)[:260] for k, v in (body or {}).items()
              if k in ("remnawave_url", "sub_domain", "network", "conf", "container") and v not in (None, "")}
    if action == "xbm_connect":
        # чья-нибудь подписка: проверить nginx после правки
        tok = xbm.sample_short_uuid() or ""
        if re.fullmatch(r"[A-Za-z0-9_-]{4,128}", tok):
            params["token"] = tok
    try:
        return {"job": xbm.submit_job(action, params)}
    except xbm.XbmError as e:
        raise HTTPException(e.status, detail={"message": e.message})


@app.get("/api/panel/xbm/setup/jobs/{job_id}")
def panel_xbm_setup_job(job_id: str, _: dict = Depends(require_owner)) -> dict[str, Any]:
    try:
        return xbm.job_result(job_id)
    except xbm.XbmError as e:
        raise HTTPException(e.status, detail={"message": e.message})


@app.get("/api/panel/xbm/response-rules")
def panel_xbm_rules(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return {"text": xbm.response_rules_text()}


@app.post("/api/panel/xbm/check")
def panel_xbm_check(_: dict = Depends(require_owner)) -> dict[str, Any]:
    """проверка response rules: xbm отдаёт xray json (заглушка тоже ok)."""
    if not xbm.health().get("running"):
        raise HTTPException(409, detail={"message": "XBM не запущен"})
    subs = xbm.sample_subscriptions(8)
    if not subs:
        raise HTTPException(409, detail={"message": "Нет ни одной активной подписки — проверьте позже"})

    def _hwid_for(user_id: int) -> Optional[str]:
        user = get_user(int(user_id))
        try:
            client, rw = _rw_find_user(user) if user else (None, None)
            if not client or not rw:
                return None
            raw = unwrap_rw(client.get_user_hwid_devices(_rw_num_id(rw)))
            items = raw.get("devices") if isinstance(raw, dict) else raw
            if items:
                return str((items[0] or {}).get("hwid") or "") or None
        except Exception:  # noqa: BLE001
            return None
        return None

    last_err: Optional[xbm.XbmError] = None
    for sub in subs:
        su = str(sub.get("short_uuid") or "")
        hwid = _hwid_for(int(sub["user_id"])) if sub.get("user_id") is not None else None
        try:
            return xbm.check_xray_json(su, hwid=hwid)
        except xbm.XbmError as e:
            last_err = e
            if e.status == 429:
                raise HTTPException(429, detail={"message": e.message})
            # не json / не xray — rules точно не те, дальше пробовать бессмысленно
            if e.status == 502 and "не Xray JSON" in (e.message or ""):
                raise HTTPException(502, detail={"message": e.message})
            continue
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail={"message": f"XBM недоступен: {type(exc).__name__}"})
    if last_err:
        raise HTTPException(last_err.status, detail={"message": last_err.message})
    raise HTTPException(502, detail={"message": "XBM недоступен"})


def _xbm_sync_loop() -> None:
    """раз в минуту: пересобрать panel.json для xbm."""
    last_err = None
    time.sleep(5)
    while True:
        try:
            xbm.ensure_default_file()
            if provisioning.is_configured():
                _xbm_sync()
                last_err = None
        except Exception as exc:  # noqa: BLE001
            err = f"{type(exc).__name__}: {getattr(exc, 'message', exc)}"
            if err != last_err:  # не спамим одной ошибкой раз в минуту
                print(f"[xbm] sync failed: {err}", flush=True)
            last_err = err
        time.sleep(60)


@app.on_event("startup")
def _clean_usernames() -> None:
    """разово чиним ники, попавшие до валидации."""
    try:
        for r in db.fetchall("SELECT id, username FROM users WHERE username IS NOT NULL"):
            ok = names.tg_username(r["username"])
            if ok != r["username"]:
                db.execute("UPDATE users SET username = ? WHERE id = ?", (ok, r["id"]))
    except Exception as exc:  # noqa: BLE001
        print(f"[names] cleanup failed: {exc}", flush=True)


@app.on_event("startup")
def _xbm_startup() -> None:
    threading.Thread(target=_xbm_sync_loop, name="xbm-sync", daemon=True).start()


@app.on_event("startup")
def _support_startup() -> None:
    threading.Thread(target=_support_cleanup_loop, name="support-cleanup", daemon=True).start()
    threading.Thread(target=_support_autoclose_loop, name="support-autoclose", daemon=True).start()


class SupportMessageBody(BaseModel):
    text: Optional[str] = ""
    files: list[str] = Field(default_factory=list)
    reply_to: Optional[int] = None
    internal: bool = False  # комментарий только для сотрудников


@app.get("/api/app/support")
def app_support_get(after: int = Query(0, ge=0), user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    u = _support_user(user)
    chat = support.chat_for_user(int(u["id"]), create=False)
    t = support.ticket_info(chat) if chat else None
    return {
        "chat": {"id": chat["id"], "unread": int(chat.get("unread_user") or 0)} if chat else None,
        "ticket": {"status": t["status"]} if t else None,     # номер обращения юзеру не показываем
        "messages": support.messages(int(chat["id"]), after, for_user=True) if chat else [],
        # изменённые/удалённые сообщения из уже показанных
        "changes": support.changes(int(chat["id"]), after, for_user=True) if chat and after else [],
        "limits": _support_limits(),
    }


@app.post("/api/app/support/upload")
async def app_support_upload(request: Request, name: str = Query("file", max_length=200),
                             user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    u = _support_user(user)
    allowed, retry = ratelimit.rate_limit(f"supup:{u['id']}", 30, 3600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком много файлов. Повторите через {max(1, retry // 60)} мин."})
    chat = support.chat_for_user(int(u["id"]))
    return await _stream_upload(request, int(chat["id"]), "user", str(u["id"]), name)


@app.post("/api/app/support/messages")
def app_support_send(body: SupportMessageBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    u = _support_user(user)
    allowed, retry = ratelimit.rate_limit(f"supmsg:{u['id']}", 30, 300)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком много сообщений. Повторите через {retry} сек."})
    chat = support.chat_for_user(int(u["id"]))
    msg = _sup(support.send_message, chat, "user", None, body.text or "", body.files, str(u["id"]), body.reply_to)
    _notify_support_forum(u, chat, msg)
    return _for_user([msg])[0]


class SupportCloseBody(BaseModel):
    message_id: int


@app.post("/api/app/support/close")
def app_support_close(body: SupportCloseBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """кнопка «нет, спасибо»: закрыть обращение."""
    u = _support_user(user)
    chat = support.chat_for_user(int(u["id"]), create=False)
    if not chat:
        raise HTTPException(404, detail={"message": "Чат не найден"})
    return _sup(support.user_close, chat, body.message_id)


@app.post("/api/app/support/read")
def app_support_read(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    u = _support_user(user)
    chat = support.chat_for_user(int(u["id"]), create=False)
    if chat:
        support.mark_read(int(chat["id"]), "user")
    return {"ok": True}


@app.get("/api/support/file/{fid}")
def support_file(fid: str, exp: int = Query(0), sig: str = Query("", max_length=64)):
    """вложение по подписанной ссылке."""
    f = support.check_file_token(fid, exp, sig)
    if not f:
        raise HTTPException(404, detail={"message": "Файл не найден или ссылка устарела"})
    if (f.get("storage") or "local") == "s3":
        # файл отдаёт хранилище по временной ссылке
        try:
            return RedirectResponse(support.s3_download_url(f), status_code=302, headers={"Cache-Control": "no-store"})
        except s3store.S3Error:
            raise HTTPException(503, detail={"message": "Хранилище временно недоступно"})
    inline = f["kind"] in ("image", "video")
    from urllib.parse import quote
    disp = ("inline" if inline else "attachment") + f"; filename*=UTF-8''{quote(f['name'])}"
    return FileResponse(f["path"], media_type=f["mime"] if inline else "application/octet-stream", headers={
        "Content-Disposition": disp,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=3600",
    })


def _chat_visible(c: dict[str, Any], p: dict[str, Any], t: Any = False) -> bool:
    """что видит сотрудник: владелец/куратор все; оператор — пул и свои (чужие взятые и эскалации скрыты)."""
    if is_full(p):
        return True
    if t is False:
        t = support.ticket_info(c)
    if not t or t["status"] != "open":
        return False
    if t.get("escalated"):
        return False
    assigned = t.get("assigned_admin")
    if assigned and assigned != p["actor"]:
        return False
    return True


def _visible_tickets(chat: dict[str, Any], p: dict[str, Any]) -> Optional[set[int]]:
    """какие обращения видит сотрудник."""
    if is_full(p):
        return None
    ids = {int(r["id"]) for r in db.fetchall("SELECT id FROM support_tickets WHERE chat_id = ? AND assigned_admin = ?",
                                            (int(chat["id"]), p["actor"]))}
    t = support.open_ticket(chat)
    # открытое без исполнителя — пул (можно читать и писать комментарии)
    if t and not t.get("escalated") and not t.get("assigned_admin"):
        ids.add(int(t["id"]))
    return ids


def _tab_of(c: dict[str, Any], t: Optional[dict[str, Any]], p: dict[str, Any]) -> str:
    """вкладки open/work/archive для ролей."""
    if not t or t["status"] != "open":
        return "archive"
    mine = t.get("assigned_admin") == p["actor"]
    if not is_full(p):
        # у оператора open = только пул; чужие взятые сюда не попадают (_chat_visible)
        return "mine" if mine else "open"
    if not t.get("assigned_admin") and not t.get("escalated"):
        return "open"
    return "work"


def _work_group(t: Optional[dict[str, Any]], p: dict[str, Any]) -> str:
    """во вкладке «в работе»: escalated → mine → others."""
    if not t:
        return ""
    if t.get("escalated") and not t.get("assigned_admin"):
        return "escalated"
    if t.get("assigned_admin") == p["actor"]:
        return "mine"
    return "others"


def _panel_chat_row(c: dict[str, Any], p: dict[str, Any], t: Any = False) -> dict[str, Any]:
    u = get_user(int(c["user_id"])) or {"id": c["user_id"]}
    if t is False:
        t = support.ticket_info(c)
    tt = dict(t) if t else None
    if tt:
        assigned = tt.get("assigned_admin")
        tt["assigned_to_me"] = assigned == p["actor"]
        tt["holder_role"] = _holder_role(assigned) if assigned else None
        # куратор может забрать только у оператора; админ — у всех
        tt["can_takeover"] = bool(
            assigned and assigned != p["actor"] and tt.get("status") == "open"
            and _can_manage_assigned(p, assigned)
        )
        tt.pop("assigned_admin", None)
    return {
        "id": c["id"], "user_id": c["user_id"], "user_label": _user_label(u),
        "user_name": " ".join(filter(None, [u.get("first_name"), u.get("last_name")])) or None,
        "is_banned": bool(u.get("is_banned")), "status": subscription_status_for_user(u) if u.get("created_at") else None,
        "last_message_at": c.get("last_message_at"), "last_preview": c.get("last_preview"), "last_sender": c.get("last_sender"),
        "unread": int(c.get("unread_admin") or 0),
        "ticket": tt, "tab": _tab_of(c, t, p), "group": _work_group(t, p) if _tab_of(c, t, p) == "work" else "",
    }


SUPPORT_TABS_FULL = ("open", "work", "archive")
SUPPORT_TABS_OPERATOR = ("open", "mine")


@app.get("/api/panel/support/chats")
def panel_support_chats(q: str = Query("", max_length=100), status: str = Query("open", max_length=10),
                        p: dict = Depends(require_panel)) -> dict[str, Any]:
    """список обращений по вкладкам."""
    tabs = SUPPORT_TABS_FULL if is_full(p) else SUPPORT_TABS_OPERATOR
    if status not in tabs:
        status = "open"
    # открытые все; закрытые последние 1000
    rows = db.fetchall("SELECT * FROM support_chats WHERE open_ticket_id IS NOT NULL")
    if "archive" in tabs:
        rows += db.fetchall("SELECT * FROM support_chats WHERE open_ticket_id IS NULL AND last_message_at IS NOT NULL "
                            "ORDER BY last_message_at DESC LIMIT 1000")
    items = []
    counts = {k: 0 for k in tabs}
    for c in rows:
        t = support.ticket_info(c)
        if not _chat_visible(c, p, t):
            continue
        tab = _tab_of(c, t, p)
        if tab not in counts:
            continue
        counts[tab] += 1
        if tab == status:
            items.append((c, t))
    q = q.strip().lower().lstrip("@#")
    if q:
        def hit(c: dict[str, Any]) -> bool:
            u = get_user(int(c["user_id"])) or {}
            hay = " ".join(str(x or "") for x in (u.get("id"), u.get("telegram_id"), u.get("username"), u.get("email"),
                                                   u.get("first_name"), u.get("last_name"), c.get("last_preview"))).lower()
            return q in hay
        items = [(c, t) for c, t in items if hit(c)]
    if status == "archive":
        items.sort(key=lambda ct: ct[0].get("last_message_at") or "", reverse=True)
    else:
        # «в работе»: сначала переданные админу, потом мои, потом чужие; closing внизу
        _wg = {"escalated": 0, "mine": 1, "others": 2}
        items.sort(key=lambda ct: (_wg.get(_work_group(ct[1], p), 9) if status == "work" else 0,
                                   1 if (ct[1] or {}).get("close_prompt") else 0, (ct[1] or {}).get("queue_at") or ""))
    return {"chats": [_panel_chat_row(c, p, t) for c, t in items[:500]], "counts": counts, "tabs": list(tabs)}


class TeamMessageBody(BaseModel):
    text: str = Field("", max_length=teamchat.MAX_TEXT + 100)
    reply_to: Optional[int] = Field(None, ge=1, le=2 ** 62)


class TeamReadBody(BaseModel):
    last_id: int = Field(0, ge=0, le=2 ** 62)


def _team_call(fn, *a):
    try:
        return fn(*a)
    except teamchat.TeamChatError as e:
        raise HTTPException(e.status, detail={"message": e.message})


def _team_role(p: dict[str, Any]) -> str:
    return "owner" if p["kind"] == "owner" else str(p.get("role") or "operator")


@app.get("/api/panel/team-chat")
def panel_team_chat(after: int = Query(0, ge=0, le=2 ** 62), before: int = Query(0, ge=0, le=2 ** 62),
                    p: dict = Depends(require_panel)) -> dict[str, Any]:
    return {"messages": teamchat.messages(p["actor"], after, before), "last_read": teamchat.last_read(p["actor"]),
            # удалённые за сутки: чтобы клиенты убрали текст
            "deleted": teamchat.recently_deleted(), "edited": teamchat.recently_edited(p["actor"]) if after else [],
            "me": {"actor": p["actor"], "owner": p["kind"] == "owner"}}


@app.get("/api/panel/team-chat/members")
def panel_team_members(_: dict = Depends(require_panel)) -> dict[str, Any]:
    """активные сотрудники + админ — для @упоминаний в чате."""
    return {"members": teamchat.members(OWNER_NAME)}


@app.get("/api/panel/team-chat/unread")
def panel_team_unread(p: dict = Depends(require_panel)) -> dict[str, Any]:
    return {"unread": teamchat.unread(p["actor"])}


@app.post("/api/panel/team-chat/messages")
def panel_team_post(body: TeamMessageBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    allowed, retry = ratelimit.rate_limit(f"teamchat:{p['actor']}", 30, 60)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Подождите {retry} сек."})
    name = p.get("name") or ("Администратор" if p["kind"] == "owner" else p.get("username") or "")
    m = _team_call(teamchat.post, p["actor"], name, _team_role(p), body.text, body.reply_to)
    try:
        mentioned = teamchat.mentioned_actors(m["text"], exclude=p["actor"])
        preview = m["text"][:140]
        if mentioned:
            webpush.send("all", f"{name} упомянул вас", preview, url="/support/team", tag="team-mention",
                         only=mentioned)
            webpush.send("all", f"Чат сотрудников · {name}", preview, url="/support/team", tag="team-chat",
                         exclude=[p["actor"], *mentioned])
        else:
            webpush.send("all", f"Чат сотрудников · {name}", preview, url="/support/team", tag="team-chat",
                         exclude=p["actor"])
    except Exception:  # noqa: BLE001
        pass
    return m


@app.post("/api/panel/team-chat/read")
def panel_team_read(body: TeamReadBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    teamchat.mark_read(p["actor"], body.last_id)
    return {"ok": True}


@app.post("/api/panel/team-chat/messages/{message_id}/edit")
def panel_team_edit(message_id: int, body: TeamMessageBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    return _team_call(teamchat.edit, p["actor"], message_id, body.text)


@app.delete("/api/panel/team-chat/messages/{message_id}")
def panel_team_delete(message_id: int, p: dict = Depends(require_panel)) -> dict[str, Any]:
    _team_call(teamchat.delete, p["actor"], p["kind"] == "owner", message_id)
    return {"ok": True}


@app.get("/api/panel/support/unread")
def panel_support_unread(p: dict = Depends(require_panel)) -> dict[str, Any]:
    """бейдж поддержки: пул + мои с новыми."""
    n = 0
    for c in db.fetchall("SELECT * FROM support_chats WHERE open_ticket_id IS NOT NULL"):
        t = support.ticket_info(c)
        if not t or not _chat_visible(c, p, t):
            continue
        tab = _tab_of(c, t, p)
        own = tab == "mine" or (tab == "work" and _work_group(t, p) == "mine")
        escalated = tab == "work" and not t.get("assigned_admin") and t.get("escalated")
        if tab == "open" or escalated or (own and int(c.get("unread_admin") or 0) > 0):
            n += 1
    return {"chats": n, "team": teamchat.unread(p["actor"])}


def _panel_chat(chat_id: int, p: dict[str, Any]) -> dict[str, Any]:
    chat = support.get_chat(chat_id)
    if not chat or not _chat_visible(chat, p):
        raise HTTPException(404, detail={"message": "Чат не найден"})
    return chat


def _started_by(chat: dict[str, Any], p: dict[str, Any]) -> bool:
    t = support.open_ticket(chat)
    return bool(t and t.get("assigned_admin") == p["actor"])


@app.get("/api/panel/support/chats/{chat_id}")
def panel_support_chat(chat_id: int, after: int = Query(0, ge=0), p: dict = Depends(require_panel)) -> dict[str, Any]:
    chat = _panel_chat(chat_id, p)
    full = is_full(p)
    return {"chat": {**_panel_chat_row(chat, p), "started_by_me": _started_by(chat, p)},
            "messages": _staff_view(support.messages(chat_id, after, tickets=_visible_tickets(chat, p)), p),
            "changes": _staff_view(support.changes(chat_id, after, tickets=_visible_tickets(chat, p)), p) if after else [],
            "edit_window_h": support.EDIT_WINDOW // 3600,
            "limits": _support_limits(),
            "me": {"name": p["name"], "role": p["role"], "full": full, "can_manage_user": can_manage_user(p, int(chat["user_id"])),
                   "prompt_ttl_min": support.CLOSE_PROMPT_TTL // 60}}


@app.post("/api/panel/support/chats/{chat_id}/read")
def panel_support_read(chat_id: int, p: dict = Depends(require_panel)) -> dict[str, Any]:
    chat = _panel_chat(chat_id, p)
    # прочитанным отмечает ведущий (или куратор/владелец)
    if is_full(p) or _started_by(chat, p):
        support.mark_read(chat["id"], "admin")
    return {"ok": True}


class SupportStartBody(BaseModel):
    takeover: bool = False


@app.post("/api/panel/support/chats/{chat_id}/start")
def panel_support_start(chat_id: int, body: Optional[SupportStartBody] = None, p: dict = Depends(require_panel)) -> dict[str, Any]:
    chat = _panel_chat(chat_id, p)
    full = is_full(p)
    if not full and not support.open_ticket(chat):
        raise HTTPException(403, detail={"message": "Обращение закрыто. Оно откроется, когда пользователь напишет снова"})
    takeover = bool(body and body.takeover) and full
    t = support.open_ticket(chat)
    if takeover and t and t.get("assigned_admin") and t.get("assigned_admin") != p["actor"]:
        if not _can_manage_assigned(p, t.get("assigned_admin")):
            who = {"owner": "администратор", "curator": "другой куратор"}.get(_holder_role(t.get("assigned_admin")) or "", "другой сотрудник")
            raise HTTPException(403, detail={"message": f"Нельзя забрать обращение — его ведёт {who}"})
    return _sup(support.start, chat, p["actor"], p["name"], takeover, _guard(p, "start"))


class SupportCloseBody2(BaseModel):
    force: bool = False


@app.post("/api/panel/support/chats/{chat_id}/close")
def panel_support_close(chat_id: int, body: Optional[SupportCloseBody2] = None, p: dict = Depends(require_panel)) -> dict[str, Any]:
    """закрыть: вопрос юзеру; force сразу (владелец/куратор)."""
    chat = _panel_chat(chat_id, p)
    full = is_full(p)
    force = bool(body and body.force)
    if force and not full:
        raise HTTPException(403, detail={"message": "Закрыть сразу может только куратор или администратор"})
    if not full and not _started_by(chat, p):
        raise HTTPException(403, detail={"message": "Закрыть можно только своё обращение"})
    res = _sup(support.close, chat, p["actor"], p["name"], force, _guard(p, "close"))
    if res.get("state") == "asked":
        user = get_user(int(chat["user_id"]))
        if user:
            _notify_support_user(user, res["message"], support.get_chat(int(chat["id"])))
    return res


class PoolBody(BaseModel):
    note: str = Field("", max_length=500)


@app.post("/api/panel/support/chats/{chat_id}/pool")
def panel_support_pool(chat_id: int, body: Optional[PoolBody] = None, p: dict = Depends(require_panel)) -> dict[str, Any]:
    """вернуть в пул; оператор обязан указать причину."""
    chat = _panel_chat(chat_id, p)
    return _sup(support.to_pool, chat, p["actor"], p["name"], not is_full(p), _guard(p, "pool"),
                (body.note if body else ""))


class EscalateBody(BaseModel):
    note: str = Field("", max_length=500)


def _notify_admins_escalation(chat: dict[str, Any], who: str, note: str) -> None:
    """передать админу: лс + push."""
    u = get_user(int(chat["user_id"])) or {}
    base = forum.panel_url()
    text = (f"🆘 <b>Обращение передано админу</b>\nОт: {_esc_html(who)}\nПользователь: {_esc_html(_user_label(u))}"
            + (f"\nПричина: {_esc_html(note)}" if note else "")
            + (f'\n<a href="{_esc_html(base)}/support/{int(chat["id"])}">Открыть</a>' if base.startswith("https://") else ""))
    ids: set[int] = set()
    for part in str(forum.admin_chat_id() or "").replace(",", " ").split():
        try:
            ids.add(int(part))
        except ValueError:
            pass
    ids |= {int(r["telegram_id"]) for r in db.fetchall("SELECT telegram_id FROM panel_staff WHERE role = 'curator' AND is_active = 1")}

    def run() -> None:
        for tg in ids:
            try:
                notifier.call("sendMessage", {"chat_id": tg, "text": text, "parse_mode": "HTML",
                                              "link_preview_options": {"is_disabled": True}}, timeout=10.0)
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=run, daemon=True).start()
    webpush.send("full", "🆘 Передано админу", f"{who}: {_user_label(u)}" + (f" — {note}" if note else ""),
                 url=f"/support/{int(chat['id'])}", tag=f"esc{int(chat['id'])}")


@app.post("/api/panel/support/chats/{chat_id}/escalate")
def panel_support_escalate(chat_id: int, body: Optional[EscalateBody] = None, p: dict = Depends(require_panel)) -> dict[str, Any]:
    """оператор отдаёт своё обращение админу."""
    chat = _panel_chat(chat_id, p)
    if is_full(p):
        raise HTTPException(400, detail={"message": "Вы и так администратор — верните обращение в пул или ведите сами"})
    res = _sup(support.escalate, chat, p["actor"], p["name"], (body.note if body else ""))
    _notify_admins_escalation(chat, p["name"], res.get("note") or "")
    return {"ok": True}


def _holder_role(assigned: Optional[str]) -> Optional[str]:
    """роль текущего ведущего: owner | curator | operator."""
    if not assigned:
        return None
    if assigned == "owner":
        return "owner"
    if assigned.startswith("staff:"):
        try:
            st = staffmod.get(int(assigned.split(":", 1)[1]))
        except ValueError:
            return "operator"
        return staffmod.role_of(st) if st else "operator"
    return "operator"


def _can_manage_assigned(p: dict[str, Any], assigned: Optional[str]) -> bool:
    """можно ли действовать поверх чужого назначения (забрать / пул / писать / закрыть).
    владелец — всех; куратор — только операторов; оператор — никого чужого."""
    if not assigned or assigned == p["actor"]:
        return True
    if p.get("kind") == "owner" or p.get("role") == "owner":
        return True
    if p.get("role") == "curator":
        return _holder_role(assigned) == "operator"
    return False


def _holder_is_senior(assigned: Optional[str], p: dict[str, Any]) -> bool:
    """обращение ведёт тот, кого нельзя перебить."""
    if not assigned or assigned == p["actor"]:
        return False
    return not _can_manage_assigned(p, assigned)


def _guard(p: dict[str, Any], op: str):
    """права на обращение внутри транзакции."""
    full = is_full(p)

    def g(t: dict[str, Any]):
        assigned = t.get("assigned_admin")
        if assigned and assigned != p["actor"] and not _can_manage_assigned(p, assigned):
            who = {"owner": "администратор", "curator": "другой куратор"}.get(_holder_role(assigned) or "", "другой сотрудник")
            return (f"Обращение ведёт {who}", 403)
        if full:
            return None
        if op == "start" and (t.get("escalated") or (assigned and assigned != p["actor"])):
            return ("Обращение уже взял другой сотрудник", 409)
        if op in ("close", "pool") and assigned != p["actor"]:
            return ("Это обращение сейчас не у вас", 403)
        return None
    return g


def _require_writer(chat: dict[str, Any], p: dict[str, Any]) -> None:
    """писать может ведущий; куратор/владелец — в чужие только если можно перебить ведущего."""
    if _started_by(chat, p):
        return
    if is_full(p):
        t = support.open_ticket(chat)
        if not t:
            raise HTTPException(409, detail={"message": "Обращение закрыто — нажмите «Начать», чтобы открыть новое"})
        assigned = t.get("assigned_admin")
        if assigned and assigned != p["actor"] and not _can_manage_assigned(p, assigned):
            who = {"owner": "администратор", "curator": "другой куратор"}.get(_holder_role(assigned) or "", "другой сотрудник")
            raise HTTPException(403, detail={"message": f"Обращение ведёт {who}"})
        return
    raise HTTPException(409, detail={"message": "Сначала нажмите «Начать»"})


@app.post("/api/panel/support/chats/{chat_id}/upload")
async def panel_support_upload(chat_id: int, request: Request, name: str = Query("file", max_length=200),
                               p: dict = Depends(require_panel)) -> dict[str, Any]:
    chat = _panel_chat(chat_id, p)
    _require_writer(chat, p)
    return await _stream_upload(request, int(chat["id"]), "admin", p["actor"], name)


@app.post("/api/panel/support/chats/{chat_id}/messages")
def panel_support_send(chat_id: int, body: SupportMessageBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    chat = _panel_chat(chat_id, p)
    # внутренний комментарий: любой, кто видит чат (тикет брать не нужно)
    if body.internal:
        if body.files:
            raise HTTPException(400, detail={"message": "К комментарию для сотрудников нельзя прикрепить файлы"})
        msg = _sup(support.send_note, chat, p["name"], body.text or "", p["actor"], body.reply_to,
                   quote_tickets=_visible_tickets(chat, p))
        return _staff_view([msg], p)[0]

    _require_writer(chat, p)
    full = is_full(p)
    t = support.open_ticket(chat)
    if full and t and not t.get("assigned_admin"):
        # куратор/владелец ответил в ничьё: оно становится его
        _sup(support.start, chat, p["actor"], p["name"], False, _guard(p, "start"))
        chat = support.get_chat(int(chat["id"])) or chat
    msg = _sup(support.send_message, chat, "admin", p["name"], body.text or "", body.files, p["actor"], body.reply_to,
               actor=p["actor"], quote_tickets=_visible_tickets(chat, p), any_ticket=full, guard=_guard(p, "write"))
    if _started_by(chat, p) or full:
        support.mark_read(int(chat["id"]), "admin")
    user = get_user(int(chat["user_id"]))
    if user:
        tg_id = _notify_support_user(user, msg, support.get_chat(int(chat["id"])))
        if tg_id:
            db.execute("UPDATE support_messages SET tg_msg_id = ? WHERE id = ?", (int(tg_id), int(msg["id"])))
    return _staff_view([msg], p)[0]


def _staff_view(msgs: list[dict[str, Any]], p: dict[str, Any]) -> list[dict[str, Any]]:
    """для панели: моё/не моё вместо ключа автора."""
    out = []
    for m in msgs:
        m = dict(m)
        m["mine"] = bool(m.get("author_actor")) and m.get("author_actor") == p["actor"]
        m.pop("author_actor", None)
        out.append(m)
    return out


class SupportEditBody(BaseModel):
    text: str = Field("", max_length=support.MAX_TEXT + 100)


def _tg_support_text(text: str) -> str:
    body = _md_html_to_tg(text, 700) if text else "📎 Вложение"
    if not body:
        body = "📎 Вложение"
    return f"💬 <b>Ответ поддержки</b>\n\n{body}"


@app.post("/api/panel/support/chats/{chat_id}/messages/{message_id}/edit")
def panel_support_edit(chat_id: int, message_id: int, body: SupportEditBody, p: dict = Depends(require_panel)) -> dict[str, Any]:
    """изменить своё сообщение (48 ч)."""
    chat = _panel_chat(chat_id, p)
    msg = _sup(support.edit_message, chat, message_id, p["actor"], body.text)
    row = db.fetchone("SELECT tg_msg_id FROM support_messages WHERE id = ?", (int(message_id),))
    user = get_user(int(chat["user_id"]))
    if row and row.get("tg_msg_id") and user and user.get("telegram_id"):
        try:
            notifier.call("editMessageText", {"chat_id": int(user["telegram_id"]), "message_id": int(row["tg_msg_id"]),
                                              "text": _tg_support_text(msg.get("text") or ""), "parse_mode": "HTML",
                                              "link_preview_options": {"is_disabled": True},
                                              **({"reply_markup": {"inline_keyboard": [[{"text": "Открыть чат", "web_app": {"url": f"{MINIAPP_URL}/support"}}]]}}
                                                 if MINIAPP_URL else {})}, timeout=10.0)
        except Exception:  # noqa: BLE001
            pass
    return _staff_view([msg], p)[0]


@app.delete("/api/panel/support/chats/{chat_id}/messages/{message_id}")
def panel_support_delete(chat_id: int, message_id: int, p: dict = Depends(require_panel)) -> dict[str, Any]:
    """удалить своё сообщение (48 ч)."""
    chat = _panel_chat(chat_id, p)
    r = _sup(support.delete_message, chat, message_id, p["actor"])
    user = get_user(int(chat["user_id"]))
    if r.get("tg_msg_id") and user and user.get("telegram_id"):
        try:
            notifier.call("deleteMessage", {"chat_id": int(user["telegram_id"]), "message_id": int(r["tg_msg_id"])}, timeout=10.0)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "id": r["id"]}


@app.get("/api/panel/support/storage")
def panel_support_storage(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return support.storage_stats()


@app.get("/api/panel/users/{user_id}/can-manage")
def panel_user_can_manage(user_id: int, p: dict = Depends(require_panel)) -> dict[str, Any]:
    """может ли сотрудник менять этого юзера."""
    return {"can_manage": can_manage_user(p, user_id), "restricted_actions":
            sorted(staffmod.OPERATOR_FORBIDDEN_ACTIONS) if p["role"] == "operator" else []}


class S3ConfigBody(BaseModel):
    enabled: Optional[bool] = None
    endpoint: Optional[str] = None
    region: Optional[str] = None
    bucket: Optional[str] = None
    access_key: Optional[str] = None
    secret_key: Optional[str] = None      # пусто: оставить сохранённый
    prefix: Optional[str] = None
    size_gb: Optional[float] = None


def _s3(fn, *a, **k):
    try:
        return fn(*a, **k)
    except s3store.S3Error as e:
        raise HTTPException(400, detail={"message": e.message})


@app.get("/api/panel/settings/s3")
def panel_s3_get(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return {**s3store.get_config(), "storage": support.storage_stats()}


@app.put("/api/panel/settings/s3")
def panel_s3_put(body: S3ConfigBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    data = body.model_dump()
    if data.get("enabled"):
        # включаем только проверенное хранилище
        cfg = {**s3store.get_config(with_secret=True), **{k: v for k, v in data.items() if v not in (None, "")}}
        _s3(s3store.check, cfg)
    cfg = _s3(s3store.save_config, data)
    return {**cfg, "storage": support.storage_stats()}


@app.post("/api/panel/settings/s3/check")
def panel_s3_check(body: S3ConfigBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    cfg = {**s3store.get_config(with_secret=True), **{k: v for k, v in body.model_dump().items() if v not in (None, "")}}
    if not (cfg.get("bucket") and cfg.get("access_key") and cfg.get("secret_key")):
        raise HTTPException(400, detail={"message": "Укажите бакет, Access Key и Secret Key"})
    return _s3(s3store.check, cfg)


class CaptchaConfigBody(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None  # auto | yandex | turnstile
    yandex_site_key: Optional[str] = None
    yandex_secret: Optional[str] = None
    turnstile_site_key: Optional[str] = None
    turnstile_secret: Optional[str] = None


@app.get("/api/panel/settings/captcha")
def panel_captcha_get(_: dict = Depends(require_owner)) -> dict[str, Any]:
    return captcha_mod.get_config()


@app.put("/api/panel/settings/captcha")
def panel_captcha_put(body: CaptchaConfigBody, _: dict = Depends(require_owner)) -> dict[str, Any]:
    try:
        return captcha_mod.save_config(body.model_dump())
    except captcha_mod.CaptchaError as e:
        raise HTTPException(e.status, detail={"message": e.message})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("core:app", host="0.0.0.0", port=int(_env("API_PORT", "8000")), reload=ENV != "production")
