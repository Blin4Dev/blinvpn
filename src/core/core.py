"""
BlinVPN Core REST API

Мост между админ-панелью (/api/panel/*) и Telegram mini-app (/api/app/*).
Данные хранятся в SQLite через database.py.

Запуск:
  uvicorn core:app --host 0.0.0.0 --port 8000
  (из каталога src/core)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import string
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import parse_qsl

try:
    from . import database as db
except ImportError:
    import database as db  # type: ignore

# src/api (platega, telegram_stars, remnawave) в путь импорта
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

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ─────────────────────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────

def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


TELEGRAM_BOT_TOKEN = _env("TELEGRAM_BOT_TOKEN")
TELEGRAM_WEBHOOK_SECRET = _env("TELEGRAM_WEBHOOK_SECRET")
# Обязательная подписка на канал (только при входе через Telegram).
REQUIRED_CHANNEL_ID = _env("REQUIRED_CHANNEL_ID", "-1003036752851")
REQUIRED_CHANNEL_URL = _env("REQUIRED_CHANNEL_URL", "https://t.me/blinvpn")
OPTIONAL_CHANNEL_URL = _env("OPTIONAL_CHANNEL_URL", "https://t.me/blinnotes")
CHANNEL_CHECK_TTL = _env_int("CHANNEL_CHECK_TTL", 600)  # кэш проверки подписки, сек
TELEGRAM_ADMIN_ID = _env("TELEGRAM_ADMIN_ID")
BOT_USERNAME = _env("BOT_USERNAME") or _env("VITE_BOT_USERNAME") or "blinvpn_bot"
PANEL_SETUP_TOKEN = _env("PANEL_SETUP_TOKEN")
INTERNAL_API_SECRET = _env("INTERNAL_API_SECRET")
TELEGRAM_INITDATA_MAX_AGE = _env_int("TELEGRAM_INITDATA_MAX_AGE", 3600)
MINIAPP_ALLOW_UNAUTH = _env("MINIAPP_ALLOW_UNAUTH", "0") in ("1", "true", "True", "yes")
CORS_ORIGINS = [o.strip() for o in _env("CORS_ORIGINS", "*").split(",") if o.strip()]
# Fail-closed по умолчанию: если ENV не задан явно — считаем это продакшеном,
# чтобы забытая переменная не открыла dev-обходы авторизации.
ENV = _env("ENV", "production")
IS_PROD = ENV == "production"

# Платежи
MINIAPP_URL = _env("MINIAPP_URL").rstrip("/")
PLATEGA_RETURN_URL = _env("PLATEGA_RETURN_URL") or (f"{MINIAPP_URL}/payment/success" if MINIAPP_URL else "")
PLATEGA_FAILED_URL = _env("PLATEGA_FAILED_URL") or (f"{MINIAPP_URL}/payment/failed" if MINIAPP_URL else "")

# ─────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────

# В проде не публикуем Swagger/OpenAPI — не отдаём карту всех ручек (в т.ч.
# админских) неаутентифицированному посетителю.
app = FastAPI(
    title="BlinVPN API",
    version="1.0.0",
    docs_url=None if IS_PROD else "/api/docs",
    redoc_url=None,
    openapi_url=None if IS_PROD else "/api/openapi.json",
)

# Безопасность CORS: нельзя одновременно разрешать любой origin ("*") и
# credentials — иначе любой сайт сможет слать запросы с куками/учётными данными.
# Авторизация у нас через заголовки (Bearer / initData), поэтому при wildcard
# просто отключаем credentials. В проде install.sh задаёт явные домены.
_cors_wildcard = CORS_ORIGINS == ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _cors_wildcard else CORS_ORIGINS,
    allow_credentials=not _cors_wildcard,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Telegram-Init-Data",
                   "X-App-Session", "X-Panel-Setup-Token"],
)


def _backup_scheduler_loop() -> None:
    """Периодический автобэкап БД по настройке (enabled + interval_hours)."""
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
        # Заодно снимаем заморозки, которые длятся ≥ 30 дней.
        try:
            auto_unfreeze_expired_all(lambda *_: None)
        except Exception:  # noqa: BLE001
            pass
        # Проверяем раз в 5 минут; сам бэкап — не чаще, чем interval_hours.
        threading.Event().wait(300)


@app.exception_handler(Exception)
async def _unhandled_exc(request: Request, exc: Exception):
    # Непойманное исключение = серверная ошибка → топик «Ошибки».
    try:
        forum.report_error(
            f"500 {request.method} {request.url.path}",
            f"{type(exc).__name__}: {exc}",
        )
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse({"detail": {"message": "Внутренняя ошибка сервера"}}, status_code=500)


def _bootstrap_admin() -> None:
    """
    При первом запуске создаёт админа со СЛУЧАЙНЫМ логином и паролем,
    печатает их в консоль (логи контейнера) и кладёт в data/first_run_credentials.txt,
    откуда install.sh покажет их один раз. Повторно данные не раскрываются.
    """
    if get_admin() is not None:
        return
    admin, password = create_admin()  # логин случайный; пароль в БД не хранится

    # Пароль отдаём один раз через файл, который install.sh покажет и удалит.
    # В логи контейнера пароль НЕ печатаем (логи хранятся) — только в файл.
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
        # Файл записать не удалось — как запасной вариант печатаем в консоль.
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
    import threading
    threading.Thread(target=_backup_scheduler_loop, name="backup-scheduler", daemon=True).start()


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

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


def gen_password(n: int = 14) -> str:
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


# ─────────────────────────────────────────────────────────────
# Telegram crypto
# ─────────────────────────────────────────────────────────────

def _telegram_data_check_string(fields: dict[str, str]) -> str:
    return "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))


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

    auth_date = int(parsed.get("auth_date") or 0)
    if auth_date and (time.time() - auth_date) > TELEGRAM_INITDATA_MAX_AGE:
        raise HTTPException(401, detail={"message": "initData устарел"})

    try:
        user = json.loads(parsed.get("user") or "{}")
    except json.JSONDecodeError:
        raise HTTPException(401, detail={"message": "Некорректный user в initData"})
    return {"user": user, "raw": parsed}


def validate_oauth_login(payload: dict[str, Any]) -> dict[str, Any]:
    if not TELEGRAM_BOT_TOKEN:
        if MINIAPP_ALLOW_UNAUTH or ENV != "production":
            return payload
        raise HTTPException(503, detail={"message": "TELEGRAM_BOT_TOKEN не задан"})

    data = {k: str(v) for k, v in payload.items() if k != "hash" and v is not None}
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


# ─────────────────────────────────────────────────────────────
# Domain helpers (SQLite)
# ─────────────────────────────────────────────────────────────

def get_admin() -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM admin WHERE id = 1")


def gen_admin_username() -> str:
    """Случайный логин админа (не 'admin')."""
    alphabet = string.ascii_lowercase + string.digits
    return "adm-" + "".join(secrets.choice(alphabet) for _ in range(7))


def create_admin(username: Optional[str] = None, password: Optional[str] = None) -> tuple[dict[str, Any], str]:
    """
    Создаёт/сбрасывает админа. В БД пишется ТОЛЬКО соль и PBKDF2-хэш — сам пароль
    нигде не сохраняется (plaintext_once всегда NULL). Открытый пароль существует
    лишь как возвращаемое значение (показать один раз) и в памяти вызывающего.
    """
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
        # Смена/сброс пароля обязана обнулять все активные сессии панели —
        # иначе украденный ранее токен продолжит работать до конца TTL.
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


def create_panel_session(username: str) -> str:
    token = gen_token()
    expires_at = time.time() + PANEL_SESSION_TTL
    db.execute(
        "INSERT INTO panel_sessions (token, username, expires_at) VALUES (?, ?, ?)",
        (token, username, expires_at),
    )
    return token


def get_panel_session(token: str) -> Optional[dict[str, Any]]:
    row = db.fetchone("SELECT * FROM panel_sessions WHERE token = ?", (token,))
    if not row:
        return None
    if float(row["expires_at"]) < time.time():
        db.execute("DELETE FROM panel_sessions WHERE token = ?", (token,))
        return None
    return row


# ── App-сессии (мини-приложение / веб-вход по email) ─────────

APP_SESSION_TTL = 30 * 86400  # 30 дней
EMAIL_CODE_TTL = 600          # 10 минут
EMAIL_CODE_RESEND = 60        # анти-спам на повторную отправку


def create_app_session(user_id: int) -> str:
    token = gen_token()
    now = time.time()
    db.execute(
        "INSERT INTO app_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token, int(user_id), now, now + APP_SESSION_TTL),
    )
    return token


def get_app_session(token: str) -> Optional[dict[str, Any]]:
    row = db.fetchone("SELECT * FROM app_sessions WHERE token = ?", (token,))
    if not row:
        return None
    if float(row["expires_at"]) < time.time():
        db.execute("DELETE FROM app_sessions WHERE token = ?", (token,))
        return None
    return row


def delete_app_session(token: str) -> None:
    db.execute("DELETE FROM app_sessions WHERE token = ?", (token,))


def create_email_code(email: str) -> tuple[str, bool]:
    """Создаёт код входа. Возвращает (code, throttled)."""
    email = email.strip().lower()
    now = time.time()
    existing = db.fetchone("SELECT last_sent_at FROM email_codes WHERE email = ?", (email,))
    if existing and (now - float(existing.get("last_sent_at") or 0)) < EMAIL_CODE_RESEND:
        row = db.fetchone("SELECT code FROM email_codes WHERE email = ?", (email,))
        return (str(row["code"]) if row else ""), True
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.execute(
        "INSERT OR REPLACE INTO email_codes (email, code, expires_at, attempts, last_sent_at) "
        "VALUES (?, ?, ?, 0, ?)",
        (email, code, now + EMAIL_CODE_TTL, now),
    )
    return code, False


def verify_email_code(email: str, code: str) -> bool:
    email = email.strip().lower()
    code = str(code or "").strip()
    row = db.fetchone("SELECT * FROM email_codes WHERE email = ?", (email,))
    if not row:
        return False
    if float(row["expires_at"]) < time.time():
        db.execute("DELETE FROM email_codes WHERE email = ?", (email,))
        return False
    if int(row.get("attempts") or 0) >= 5:
        return False
    if not hmac.compare_digest(str(row["code"]), code):
        db.execute("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?", (email,))
        return False
    db.execute("DELETE FROM email_codes WHERE email = ?", (email,))
    return True


def send_login_code(email: str, code: str) -> None:
    """Доставка кода входа на почту (no-reply@домен). Логируем результат."""
    if mailer.is_configured():
        ok, err = mailer.send_login_code(email, code)
        if ok:
            return
        print(f"[email] не удалось отправить код на {email}: {err}", flush=True)
        try:
            forum.report_error("Не удалось отправить код входа на почту", err)
        except Exception:  # noqa: BLE001
            pass
    # Код входа — это учётные данные. В проде его НЕЛЬЗЯ писать в логи контейнера.
    if not IS_PROD:
        print(f"[email] код входа для {email}: {code}", flush=True)


def set_temp_2fa(username: str) -> tuple[str, str]:
    temp = gen_token(24)
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.execute(
        "INSERT OR REPLACE INTO temp_2fa (token, code, username, expires_at) VALUES (?, ?, ?, ?)",
        (temp, code, username, time.time() + 300),
    )
    return temp, code


def pop_temp_2fa(token: str) -> Optional[dict[str, Any]]:
    row = db.fetchone("SELECT * FROM temp_2fa WHERE token = ?", (token,))
    if not row:
        return None
    db.execute("DELETE FROM temp_2fa WHERE token = ?", (token,))
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
    existing = find_user_by_tg(telegram_id)
    if existing:
        db.execute(
            "UPDATE users SET username = COALESCE(?, username), first_name = COALESCE(?, first_name), "
            "last_name = COALESCE(?, last_name) WHERE id = ?",
            (
                (username.lstrip("@") if username else None),
                first_name,
                last_name,
                existing["id"],
            ),
        )
        user = get_user(int(existing["id"]))
        assert user is not None
        return user

    code = gen_ref_code()
    db.execute(
        "INSERT INTO users (telegram_id, username, first_name, last_name, balance, status, is_banned, "
        "referral_code, is_partner, partner_balance, partner_rate, "
        "autopay_enabled, created_at) VALUES (?, ?, ?, ?, 0, 'Trial', 0, ?, 0, 0, 25, 0, ?)",
        (
            telegram_id,
            (username or "").lstrip("@") or None,
            first_name,
            last_name,
            code,
            db.utcnow_iso(),
        ),
    )
    user = get_user(db.last_id())
    assert user is not None
    return user


def referrals_count(user_id: int) -> int:
    row = db.fetchone("SELECT COUNT(*) AS c FROM users WHERE referred_by = ?", (user_id,))
    return int(row["c"]) if row else 0


def paid_until_for_user(user_id: int) -> Optional[str]:
    row = db.fetchone(
        "SELECT expires_at FROM subscriptions WHERE user_id = ? AND status IN ('Active', 'Frozen') "
        "AND expires_at IS NOT NULL ORDER BY expires_at DESC LIMIT 1",
        (user_id,),
    )
    return row["expires_at"] if row else None


def subscription_status_for_user(u: dict[str, Any]) -> str:
    if u.get("is_banned"):
        return "banned"
    # Блокировка ключа (подписки): если есть заблокированная подписка — статус blocked
    blocked = db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Banned' LIMIT 1",
        (u["id"],),
    )
    if blocked:
        return "blocked"
    frozen = db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Frozen' LIMIT 1", (u["id"],))
    if frozen:
        return "frozen"
    active = db.fetchone(
        "SELECT type, expires_at FROM subscriptions WHERE user_id = ? AND status = 'Active' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC LIMIT 1",
        (u["id"],),
    )
    if not active:
        any_sub = db.fetchone("SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1", (u["id"],))
        return "lapsed" if any_sub else "never"
    if active.get("type") == "trial":
        return "trial"
    exp = parse_iso(active.get("expires_at"))
    if exp and exp < utcnow():
        return "expired"
    return "active"


def serialize_user(u: dict[str, Any]) -> dict[str, Any]:
    banned = bool(u.get("is_banned"))
    return {
        "id": u["id"],
        "telegram_id": u.get("telegram_id"),
        "username": u.get("username"),
        "first_name": u.get("first_name"),
        "last_name": u.get("last_name"),
        "email": u.get("email"),
        "balance": u.get("balance", 0),
        "status": u.get("status", "Trial"),
        "in_blacklist": banned,
        "is_banned": banned,
        "registration_date": u.get("created_at"),
        "paid_until": paid_until_for_user(int(u["id"])),
        "referral_code": u.get("referral_code"),
        "is_partner": bool(u.get("is_partner")),
        "partner_balance": u.get("partner_balance", 0),
        "partner_rate": u.get("partner_rate", 25),
        "referrals": referrals_count(int(u["id"])),
    }


def serialize_app_user(u: dict[str, Any]) -> dict[str, Any]:
    status = subscription_status_for_user(u)
    until = paid_until_for_user(int(u["id"]))
    return {
        "id": u["id"],
        "telegram_id": u["telegram_id"],
        "username": u.get("username"),
        "email": u.get("email"),
        "balance": u.get("balance", 0),
        "subscription_status": status,
        "subscription_until": until,
        "is_banned": bool(u.get("is_banned")),
        "referral_code": u.get("referral_code"),
        "is_partner": bool(u.get("is_partner")),
        "partner_balance": float(u.get("partner_balance") or 0),
        "discount": active_discount_for_user(int(u["id"])),
    }


def days_left_for_expiry(expires_at: Optional[str]) -> Optional[int]:
    if not expires_at:
        return None
    dt = parse_iso(expires_at)
    if not dt:
        return 0
    return max(0, int((dt - utcnow()).total_seconds() // 86400))


def refresh_subscription_row(sub: dict[str, Any]) -> dict[str, Any]:
    """Обновляет статус Expired при необходимости и добавляет days_left."""
    status = sub.get("status") or "Active"
    # Замороженная подписка не «тикает»: дни считаем из сохранённого остатка.
    if status == "Frozen":
        rem = sub.get("frozen_remaining")
        dl = max(0, int(int(rem) // 86400)) if rem is not None else days_left_for_expiry(sub.get("expires_at"))
        return {**sub, "days_left": dl, "status": status, "frozen": True}
    exp = parse_iso(sub.get("expires_at"))
    if exp and exp < utcnow() and status == "Active":
        db.execute("UPDATE subscriptions SET status = 'Expired' WHERE id = ?", (sub["id"],))
        status = "Expired"
        sub = {**sub, "status": status}
    sub = {**sub, "days_left": days_left_for_expiry(sub.get("expires_at")), "status": status, "frozen": False}
    return sub


def serialize_key(sub: dict[str, Any], user: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    sub = refresh_subscription_row(sub)
    if user is None and sub.get("user_id"):
        user = get_user(int(sub["user_id"]))
    username = None
    if user:
        username = f"@{user['username']}" if user.get("username") else f"id{user.get('telegram_id')}"
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
        "custom_name": sub.get("custom_name"),
        "rw_id": sub.get("rw_id"),
        "created_at": sub.get("created_at"),
        "frozen": bool(sub.get("frozen") or sub.get("status") == "Frozen"),
    }


def sync_user_status_from_subs(user_id: int) -> None:
    user = get_user(user_id)
    if not user or user.get("is_banned"):
        return
    active = db.fetchone(
        "SELECT type, expires_at FROM subscriptions WHERE user_id = ? AND status = 'Active' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC LIMIT 1",
        (user_id,),
    )
    if active:
        status = "Trial" if active.get("type") == "trial" else "Active"
    else:
        status = "Trial"
    db.execute("UPDATE users SET status = ? WHERE id = ?", (status, user_id))


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
            "",  # конфиг берётся из Remnawave (реальная подписка), не из vless-плейсхолдера
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


def extend_user_sub(user_id: int, days: int, subscription_id: Optional[int] = None) -> None:
    if subscription_id:
        subs = db.fetchall(
            "SELECT * FROM subscriptions WHERE user_id = ? AND id = ?",
            (user_id, subscription_id),
        )
    else:
        subs = db.fetchall("SELECT * FROM subscriptions WHERE user_id = ?", (user_id,))

    if not subs:
        if days > 0:
            create_key(user_id, days=days)
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


# ── Remnawave sync helpers (panel) ───────────────────────────

GB = 1024 ** 3  # трафик в БД храним в ГБ, в Remnawave — в байтах


def _rw_client():
    """Клиент Remnawave или None, если панель не настроена/недоступна."""
    try:
        import remnawave  # type: ignore
        if not provisioning.is_configured():
            return None
        return remnawave.get_client()
    except Exception:  # noqa: BLE001
        return None


def _rw_find_user(user: dict[str, Any]):
    """(client, rw_user|None). Ищем по telegram_id, затем по email."""
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
    return client, rw


def unwrap_rw(data: Any) -> Any:
    if isinstance(data, dict) and "response" in data:
        return data["response"]
    return data


def _rw_uid(rw: dict[str, Any]) -> Optional[str]:
    val = rw.get("uuid") or rw.get("id") or rw.get("userId")
    return str(val) if val is not None else None


def _rw_num_id(rw: dict[str, Any]) -> Optional[int]:
    """
    ЧИСЛОВОЙ id пользователя Remnawave. В 3.x пользовательские ручки
    (disable/enable/delete/extend/reset-traffic, update body, все HWID-эндпоинты)
    идентифицируют пользователя именно числовым id, а НЕ uuid.
    """
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
    """Пушим актуальную дату окончания основной подписки в Remnawave."""
    client, rw = _rw_find_user(user)
    if not client or not rw:
        return
    row = db.fetchone(
        "SELECT expires_at FROM subscriptions WHERE user_id = ? AND type != 'trial' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user["id"],),
    ) or db.fetchone(
        "SELECT expires_at FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
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


def _rw_sync_traffic(user: dict[str, Any], gb: int) -> None:
    """Устанавливаем лимит трафика в Remnawave (ГБ → байты, 0 = безлимит)."""
    client, rw = _rw_find_user(user)
    if not client or not rw:
        return
    try:
        client.update_user(id=_rw_num_id(rw), traffic_limit_bytes=int(max(0, gb)) * GB)
    except Exception:  # noqa: BLE001
        pass


def _notify_user(user: dict[str, Any], text: str) -> dict[str, Any]:
    """Отправить сообщение пользователю: в бота и/или на email. Возвращает что удалось."""
    result = {"telegram": False, "email": False}
    if not text:
        return result
    if telegram_stars is not None and user.get("telegram_id"):
        try:
            telegram_stars.TelegramStars().send_message(int(user["telegram_id"]), text)
            result["telegram"] = True
        except Exception:  # noqa: BLE001
            pass
    # email-доставка через почтовый модуль (no-reply@домен)
    if user.get("email") and mailer.is_configured():
        ok, _ = mailer.send_broadcast(user["email"], "BlinVPN", _esc_html(text).replace("\n", "<br>"), body_text=text)
        result["email"] = ok
    return result


def _esc_html(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def trial_enabled() -> bool:
    return db.get_setting("trial_enabled", "1") in ("1", "true", "True", "yes")


def get_plans_meta() -> dict[str, Any]:
    return {
        "extra_device_price": float(db.get_setting("extra_device_price", "40") or 40),
        "default_included_devices": int(float(db.get_setting("default_included_devices", "2") or 2)),
        "trial_enabled": trial_enabled(),
        "traffic_reset_price": float(db.get_setting("traffic_reset_price", "0") or 0),
        "antiabuse_enabled": db.get_setting("antiabuse_enabled", "1") in ("1", "true", "True", "yes"),
    }


def get_active_plans() -> list[dict[str, Any]]:
    rows = db.fetchall(
        "SELECT devices, price_rub, price_stars FROM plans WHERE is_active = 1 ORDER BY sort_order, devices"
    )
    return [
        {
            "devices": int(r["devices"]),
            "price_rub": float(r["price_rub"]),
            "price_stars": float(r["price_stars"]),
        }
        for r in rows
    ]


def get_all_plans_panel() -> list[dict[str, Any]]:
    rows = db.fetchall("SELECT * FROM plans ORDER BY sort_order, devices")
    return [
        {
            "id": r["id"],
            "devices": int(r["devices"]),
            "price_rub": float(r["price_rub"]),
            "price_stars": float(r["price_stars"]),
            "is_active": bool(r["is_active"]),
            "sort_order": int(r["sort_order"] or 0),
        }
        for r in rows
    ]


def plan_price_map() -> dict[int, float]:
    return {int(p["devices"]): float(p["price_rub"]) for p in get_active_plans()}


def plan_stars_map() -> dict[int, float]:
    return {int(p["devices"]): float(p["price_stars"]) for p in get_active_plans()}


def min_plan_price() -> Optional[float]:
    row = db.fetchone(
        "SELECT MIN(price_rub) AS m FROM plans WHERE is_active = 1"
    )
    if not row or row["m"] is None:
        return None
    return float(row["m"])


def _backup_dir() -> str:
    d = os.path.join(os.path.dirname(os.path.abspath(db.get_db_path())), "backups")
    os.makedirs(d, exist_ok=True)
    return d


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
        })
    return out


def create_backup() -> dict[str, Any]:
    """Онлайн-копия SQLite (безопасно при WAL). Возвращает сведения о файле."""
    import sqlite3

    ts = utcnow().strftime("%Y%m%d-%H%M%S")
    name = f"backup-{ts}.db"
    path = os.path.join(_backup_dir(), name)
    src = sqlite3.connect(db.get_db_path())
    try:
        dst = sqlite3.connect(path)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    last = db.utcnow_iso()
    db.set_setting("backup_last", last)
    # Ротация: держим последние 30 копий.
    backups = list_backups()
    for old in backups[30:]:
        try:
            os.remove(os.path.join(_backup_dir(), old["name"]))
        except OSError:
            pass
    st = os.stat(path)
    # Отправляем копию в топик «Бэкапы» (или админу в ЛС).
    try:
        forum.send_document("backups", path, caption=f"🗄 Бэкап БД · {name} · {st.st_size // 1024} КБ")
    except Exception:  # noqa: BLE001
        pass
    return {"name": name, "size": st.st_size, "created_at": last, "last_backup": last}


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
        "type": "discount",  # единственный тип — скидка
        "value": p["value"],  # процент скидки
        "uses_limit": p.get("uses_limit"),
        "uses_count": p.get("uses_count", 0),
        "expires_at": p.get("expires_at"),  # срок, до которого промокод можно активировать
        "is_active": bool(p.get("is_active")),
        "created_at": p.get("created_at"),
    }


# ─────────────────────────────────────────────────────────────
# Promo discounts (активированный промокод действует 90 дней, один раз)
# ─────────────────────────────────────────────────────────────

PROMO_DISCOUNT_DAYS = 90


def active_global_discount() -> Optional[dict[str, Any]]:
    """Активная глобальная скидка (акция type=global_discount), либо None."""
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
    """
    Самая выгодная НЕистёкшая скидка пользователя, либо None.
    Учитывает и персональные промокоды, и глобальную акцию (берётся больший %).
    """
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
    """Цена со скидкой (округление до целого рубля/звезды вниз, но не ниже 1)."""
    if percent <= 0:
        return float(amount)
    result = float(amount) * (1.0 - percent / 100.0)
    return float(max(1, round(result)))


# Максимальная суммарная скидка (чтобы стек не увёл цену в ноль).
MAX_TOTAL_DISCOUNT = 90.0


def survey_bonus_percent(user_id: int) -> float:
    """Скидка за пройденный опрос (0, если опрос не пройден). Стекается с остальными."""
    try:
        return float(survey.reward_percent(int(user_id)))
    except Exception:  # noqa: BLE001
        return 0.0


def effective_discount(user_id: int) -> dict[str, Any]:
    """
    Итоговая скидка пользователя: лучшая из промо/акций ПЛЮС бонус за опрос (5%),
    суммарно не выше MAX_TOTAL_DISCOUNT. Возвращает dict с полями percent, base,
    survey, code/name (если есть промо), active.
    """
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
    """
    Активирует промокод-скидку пользователю на 90 дней (одноразово на пользователя).
    Единый источник логики — services.activate_promocode.
    """
    try:
        return services.activate_promocode(user_id, code)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})


def remove_user_promo(user_id: int, code: Optional[str] = None) -> int:
    """
    Снимает скидку у пользователя (админ). Если code задан — только этот промокод,
    иначе все активные скидки. Возвращает число снятых активаций.
    """
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


# ─────────────────────────────────────────────────────────────
# Panel auth dependency
# ─────────────────────────────────────────────────────────────

def require_panel(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    session = get_panel_session(token)
    if not session:
        raise HTTPException(401, detail="Unauthorized")
    return session


def _setup_token_ok(setup_token: Optional[str], header_token: Optional[str]) -> bool:
    if not PANEL_SETUP_TOKEN:
        return ENV != "production"
    candidate = (setup_token or header_token or "").strip()
    return bool(candidate) and hmac.compare_digest(candidate, PANEL_SETUP_TOKEN)


# ─────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────

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
    subject: Optional[str] = None  # тема письма (для email-канала)


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


class BackupSettingsBody(BaseModel):
    enabled: bool = False
    interval_hours: int = 12


class ForumConfigBody(BaseModel):
    forum_chat_id: Optional[str] = None
    panel_url: Optional[str] = None
    topics: dict[str, Any] = Field(default_factory=dict)


class WithdrawApproveBody(BaseModel):
    tx_link: str


class OauthBody(BaseModel):
    id: Any
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    username: Optional[str] = None
    photo_url: Optional[str] = None
    auth_date: Any = None
    hash: str


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


# Минимальная сумма транзакции у провайдера (рубли). Оплата картой/СБП ниже
# этих порогов провайдером не принимается.
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


class EmailVerifyBody(BaseModel):
    email: str
    code: str


class ContentTextBody(BaseModel):
    text: str = ""


class PlanItemBody(BaseModel):
    id: Optional[int] = None
    devices: int
    price_rub: float
    price_stars: float
    is_active: bool = True
    sort_order: int = 0


class PlansUpdateBody(BaseModel):
    plans: list[PlanItemBody]
    extra_device_price: Optional[float] = None
    default_included_devices: Optional[int] = None
    trial_enabled: Optional[bool] = None
    traffic_reset_price: Optional[float] = None
    antiabuse_enabled: Optional[bool] = None


# ─────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────

@app.get("/api/health")
@app.get("/health")
def health() -> dict[str, Any]:
    # Не раскрываем внутренние пути/окружение наружу.
    return {"ok": True, "service": "blinvpn-api"}


# ═════════════════════════════════════════════════════════════
# PANEL AUTH
# ═════════════════════════════════════════════════════════════

@app.get("/api/panel/auth/init")
def panel_auth_init(
    setup_token: Optional[str] = Query(None),
    reset: Optional[int] = Query(0),
    x_panel_setup_token: Optional[str] = Header(None, alias="X-Panel-Setup-Token"),
) -> dict[str, Any]:
    # Требуется PANEL_SETUP_TOKEN (лежит только в .env на сервере).
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

    # Пароль в БД не хранится (только хэш), поэтому «показать старый» нельзя.
    # По &reset=1 генерируем НОВЫЙ пароль (сброс) — показывается один раз.
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
        "message": "Пароль не хранится на сервере. Для сброса добавьте &reset=1 (нужен setup_token).",
    }


def _client_ip(request: Optional[Request]) -> str:
    if not request:
        return ""
    # Наш nginx добавляет реальный IP клиента В КОНЕЦ X-Forwarded-For
    # ($proxy_add_x_forwarded_for). Берём ПОСЛЕДНИЙ элемент — клиент не может
    # его подделать (любой присланный им XFF окажется левее). Это важно для
    # честного rate-limiting входа в панель.
    fwd = request.headers.get("x-forwarded-for") or request.headers.get("X-Forwarded-For")
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else ""


@app.post("/api/panel/auth/login")
def panel_login(body: LoginBody, request: Request = None) -> Any:  # type: ignore[assignment]
    # Ограничение: 5 попыток с одного IP за 60 секунд.
    ip = _client_ip(request) or "unknown"
    allowed, retry = ratelimit.rate_limit(f"login:{ip}", 5, 60)
    if not allowed:
        return JSONResponse(
            {"error": f"Слишком много попыток. Повторите через {retry} сек."},
            status_code=429,
            headers={"Retry-After": str(retry)},
        )

    admin = get_admin()
    if not admin:
        if ENV != "production" and not PANEL_SETUP_TOKEN:
            admin, _ = create_admin()
        else:
            return JSONResponse({"error": "Админ не инициализирован. Вызовите /api/panel/auth/init"}, status_code=401)

    ok_user = hmac.compare_digest(str(body.username or ""), str(admin["username"]))
    ok_pass = verify_password(body.password, admin["password_hash"], admin["password_salt"])
    if not (ok_user and ok_pass):
        return JSONResponse({"error": "Неверные учётные данные"}, status_code=401)

    # 2FA обязателен, если есть куда доставить код (форум «Коды» или админ в ЛС).
    can_deliver = bool(TELEGRAM_BOT_TOKEN and (forum.chat_id() or forum.admin_chat_id()))
    if can_deliver:
        temp, code = set_temp_2fa(admin["username"])
        ip = _client_ip(request)
        ua = (request.headers.get("user-agent") if request else "") or ""
        forum.send_code(code, ip=ip, user_agent=ua)
        if ENV != "production":
            print(f"[BlinVPN] 2FA code for panel: {code}")
        return {"requires_2fa": True, "temp_token": temp}

    token = create_panel_session(admin["username"])
    clear_admin_plaintext()
    return {"session_token": token}


@app.post("/api/panel/auth/verify-code")
def panel_verify_code(body: VerifyCodeBody) -> Any:
    entry = pop_temp_2fa(body.temp_token)
    if not entry:
        return JSONResponse({"error": "Код истёк"}, status_code=401)
    if not hmac.compare_digest(str(body.code).strip(), entry["code"]):
        return JSONResponse({"error": "Неверный код"}, status_code=401)
    token = create_panel_session(entry["username"])
    clear_admin_plaintext()
    return {"session_token": token}


# ═════════════════════════════════════════════════════════════
# PANEL STATS / FINANCE
# ═════════════════════════════════════════════════════════════

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


def _payment_methods_chart() -> list[dict[str, Any]]:
    rows = db.fetchall(
        "SELECT COALESCE(payment_method, 'other') AS m, COUNT(*) AS c FROM transactions GROUP BY m"
    )
    return [{"name": r["m"], "value": int(r["c"])} for r in rows] or [{"name": "none", "value": 0}]


@app.get("/api/panel/statistics/full")
def panel_statistics_full(
    period: str = Query("week"),
    _: dict = Depends(require_panel),
) -> dict[str, Any]:
    days = {"week": 7, "month": 30, "year": 365}.get(period, 7)
    now = utcnow()
    txs = db.fetchall("SELECT * FROM transactions WHERE status = 'completed'")
    revenue_by_day: list[dict[str, Any]] = []
    for i in range(days - 1, -1, -1):
        day = (now - timedelta(days=i)).date()
        label = day.isoformat()
        total = 0.0
        for tx in txs:
            if float(tx.get("amount") or 0) <= 0:
                continue
            created = _tx_date(tx)
            if created == day:
                total += float(tx["amount"])
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
    partners = sum(1 for u in users if u.get("is_partner"))
    total_invited = sum(referrals_count(int(u["id"])) for u in users)
    clients_balance = sum(float(u.get("balance") or 0) for u in users)

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
                "count": referrals_count(int(u["id"])),
                "earned": float(u.get("partner_balance") or 0),
            }
            for u in users
            if referrals_count(int(u["id"])) > 0
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
        "userDistData": [
            {"name": "Active", "value": sum(1 for u in users if u.get("status") == "Active")},
            {"name": "Trial", "value": sum(1 for u in users if u.get("status") == "Trial")},
            {"name": "Banned", "value": sum(1 for u in users if u.get("is_banned"))},
        ],
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
    deposits = db.fetchone(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE amount > 0"
    )
    withdrawals = db.fetchone(
        "SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM transactions WHERE amount < 0"
    )
    successful = db.fetchone(
        "SELECT COUNT(*) AS c FROM transactions WHERE status = 'completed'"
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


@app.get("/api/panel/payments")
def panel_payments(
    limit: int = Query(100),
    offset: int = Query(0),
    _: dict = Depends(require_panel),
) -> list[dict[str, Any]]:
    """Список платежей для раздела «Финансы» (с возможностью возврата)."""
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    rows = db.fetchall(
        "SELECT p.*, u.username AS u_username, u.telegram_id AS u_tg "
        "FROM payments p LEFT JOIN users u ON u.id = p.user_id "
        "ORDER BY p.id DESC LIMIT ? OFFSET ?",
        (limit, offset),
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
            "refundable": _payment_refundable(p),
        }
        for p in rows
    ]


# ═════════════════════════════════════════════════════════════
# PANEL USERS
# ═════════════════════════════════════════════════════════════

def _filter_users(search: Optional[str], status: Optional[str]) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM users ORDER BY id DESC")
    if status and status != "all":
        st = status.lower()
        if st == "banned":
            items = [u for u in items if u.get("is_banned")]
        else:
            items = [u for u in items if str(u.get("status", "")).lower() == st]
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
    _: dict = Depends(require_panel),
) -> dict[str, Any]:
    items = _filter_users(search or q, status)
    page_data = paginate(items, limit, offset if offset else (page - 1) * limit)
    return {
        "items": [serialize_user(u) for u in page_data["items"]],
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
        "SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 100", (user_id,)
    )
    txs = db.fetchall(
        "SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100", (user_id,)
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
            "refundable": _payment_refundable(p),
        }
        for p in rows
    ]
    # транзакции без связанного платежа (ручные начисления, рефералка)
    for t in txs:
        if t.get("payment_id") and t.get("payment_id") in paid_ids:
            continue
        result.append({
            "id": f"tx-{t['id']}",
            "payment_id": t.get("payment_id"),
            "provider": t.get("payment_method"),
            "method": t.get("payment_method"),
            "amount": t.get("amount"),
            "currency": "RUB",
            "stars": None,
            "status": t.get("status"),
            "purpose": t.get("description") or "transaction",
            "created_at": t.get("created_at"),
            "paid_at": t.get("created_at") if t.get("status") == "completed" else None,
        })
    result.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return result


# ── Возвраты (Platega cancel) ────────────────────────────────

def _payment_refundable(p: dict[str, Any]) -> bool:
    return bool(
        p.get("provider") in ("platega", "tg_stars")
        and p.get("status") == "paid"
        and p.get("provider_payment_id")
    )


def _payment_description(purpose: Optional[str], user_id: Any) -> str:
    """Человекочитаемое описание платежа для панели. В скобках — внутренний id юзера."""
    uid = user_id if user_id is not None else "—"
    label = {
        "subscription": "Покупка подписки",
        "extend": "Покупка подписки",
        "devices": "Изменение лимита устройств",
        "traffic_reset": "Сброс трафика",
    }.get(str(purpose or "").lower(), "Платёж")
    return f"{label} ({uid})"


def _reverse_referral_bonus(payment: dict[str, Any]) -> None:
    """Снимает реферальный бонус, начисленный аплайну за этот платёж (при возврате)."""
    try:
        user = get_user(int(payment["user_id"]))
        if not user or not user.get("referred_by"):
            return
        if (payment.get("currency") or "RUB") != "RUB":
            return
        amount = float(payment.get("amount") or 0)
        if amount <= 0:
            return
        referrer = get_user(int(user["referred_by"]))
        if not referrer:
            return
        rate = float(referrer.get("partner_rate") or 25)
        bonus = round(amount * rate / 100.0, 2)
        if bonus <= 0:
            return
        db.execute(
            "UPDATE users SET partner_balance = MAX(0, partner_balance - ?) WHERE id = ?",
            (bonus, referrer["id"]),
        )
        db.execute(
            "INSERT INTO transactions (user_id, amount, status, payment_method, hash, payment_id, description, created_at) "
            "VALUES (?, ?, 'completed', 'referral_reversal', ?, ?, ?, ?)",
            (referrer["id"], -bonus, secrets.token_hex(8), payment.get("payment_id"),
             f"referral reversal (refund) user {user['id']}", db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001
        pass


def _revoke_subscription_for_payment(payment: dict[str, Any]) -> None:
    """Отзывает подписку, оплаченную возвращённым платежом (доступ VPN снимается)."""
    try:
        sub_id = payment.get("subscription_id")
        if sub_id:
            db.execute(
                "UPDATE subscriptions SET status = 'Refunded', expires_at = ? WHERE id = ?",
                (db.utcnow_iso(), sub_id),
            )
        user = get_user(int(payment["user_id"]))
        if user:
            client, rw = _rw_find_user(user)
            if client and rw:
                try:
                    client.disable_user(_rw_num_id(rw))
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
    """Общая финализация возврата: пометка refunded, откат бонуса, отзыв подписки, уведомление."""
    info = db.dumps({"message": message, "manual": manual, "by": admin.get("username")})
    cur = db.execute(
        "UPDATE payments SET status = 'refunded', refunded_at = ?, refund_info = ? "
        "WHERE payment_id = ? AND status = 'paid'",
        (db.utcnow_iso(), info, payment_id),
    )
    if cur.rowcount == 0:
        return {"ok": True, "already": True, "message": "Платёж уже возвращён"}
    db.execute("UPDATE transactions SET status = 'refunded' WHERE payment_id = ?", (payment_id,))
    _reverse_referral_bonus(p)  # для звёзд (XTR) это no-op — реф. бонус там не начислялся
    _revoke_subscription_for_payment(p)
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


@app.get("/api/panel/payments/{payment_id}/refund-check")
def panel_payment_refund_check(payment_id: str, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """Проверка возможности возврата (Platega — cancel-supported; Stars — всегда доступно)."""
    p = fulfillment.get_payment(payment_id)
    if not p:
        raise HTTPException(404, detail={"message": "Платёж не найден"})
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
    """
    Возврат средств: Platega (POST /transaction/{id}/cancel) ИЛИ Telegram Stars
    (refundStarPayment). Помечает платёж refunded, снимает реф. бонус аплайна,
    отзывает подписку. Реферальная часть (если оплачивалась балансом) назад не
    возвращается — возвращается только фактически оплаченная провайдеру сумма.
    """
    p = fulfillment.get_payment(payment_id)
    if not p:
        raise HTTPException(404, detail={"message": "Платёж не найден"})
    if not _payment_refundable(p):
        raise HTTPException(400, detail={"message": "Этот платёж нельзя вернуть"})

    # ── Telegram Stars ───────────────────────────────────────
    if p.get("provider") == "tg_stars":
        if telegram_stars is None or not telegram_stars.TelegramStars().is_configured():
            raise HTTPException(503, detail={"message": "Оплата звёздами не настроена"})
        user = get_user(int(p["user_id"]))
        tgid = (user or {}).get("telegram_id")
        if not tgid:
            raise HTTPException(400, detail={"message": "У пользователя нет Telegram id для возврата звёзд"})
        try:
            telegram_stars.TelegramStars().refund_star_payment(int(tgid), str(p["provider_payment_id"]))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail={"message": f"Telegram: {exc}"})
        return _finalize_refund(payment_id, p, admin, "Звёзды возвращены пользователю")

    # ── Platega ──────────────────────────────────────────────
    if platega is None:
        raise HTTPException(503, detail={"message": "Платёжный модуль недоступен"})
    client = platega.get_client()
    if not client.is_configured():
        raise HTTPException(503, detail={"message": "Platega не настроена"})
    try:
        res = client.cancel_transaction(str(p["provider_payment_id"]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail={"message": f"Platega: {exc}"})
    if not bool(res.get("accepted")):
        return {"ok": False, "message": res.get("message") or "Возврат отклонён провайдером", "raw": res}
    return _finalize_refund(payment_id, p, admin,
                            res.get("message") or "Возврат в процессе",
                            manual=bool(res.get("manualControlRequired")))


@app.get("/api/panel/surveys/stats")
def panel_survey_stats(_: dict = Depends(require_panel)) -> dict[str, Any]:
    """Общая статистика опроса: сколько прошло + разбивка ответов по вопросам."""
    total_started = int((db.fetchone("SELECT COUNT(*) c FROM survey_state") or {}).get("c") or 0)
    total_completed = int((db.fetchone(
        "SELECT COUNT(*) c FROM survey_state WHERE completed = 1") or {}).get("c") or 0)
    total_invited = int((db.fetchone(
        "SELECT COUNT(*) c FROM survey_invites WHERE invited = 1") or {}).get("c") or 0)
    questions: list[dict[str, Any]] = []
    for q in survey.QUESTIONS:
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
        "reward_percent": survey.SURVEY_DISCOUNT_PERCENT,
        "questions": questions,
    }


@app.get("/api/panel/users/{user_id}/survey")
def panel_user_survey(user_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """Ответы конкретного пользователя на опрос (для карточки пользователя)."""
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
               for q in survey.QUESTIONS]
    return {
        "taken": True,
        "completed": bool(st.get("completed")),
        "started_at": st.get("started_at"),
        "completed_at": st.get("completed_at"),
        "answers": answers,
    }


@app.get("/api/panel/users/{user_id}/remnawave")
def panel_user_remnawave(user_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    """Данные из Remnawave: онлайн, первое/последнее подключение, HWID-устройства."""
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
    out["online_at"] = rw.get("onlineAt") or rw.get("online_at")
    out["first_connected_at"] = rw.get("firstConnectedAt") or rw.get("first_connected_at")
    out["last_user_agent"] = rw.get("subLastUserAgent") or rw.get("sub_last_user_agent")
    out["status"] = rw.get("status")
    out["used_traffic_bytes"] = rw.get("usedTrafficBytes") or rw.get("used_traffic_bytes")
    out["traffic_limit_bytes"] = rw.get("trafficLimitBytes") or rw.get("traffic_limit_bytes")
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
    """Полная карточка пользователя для страницы в панели."""
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")

    subs = db.fetchall("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC", (user_id,))
    primary = db.fetchone(
        "SELECT * FROM subscriptions WHERE user_id = ? AND type != 'trial' "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user_id,),
    ) or (subs[0] if subs else None)

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
        "key_blocked": bool(db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Banned' LIMIT 1", (user_id,)
        )),
        "frozen": bool(db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Frozen' LIMIT 1", (user_id,)
        )),
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


@app.post("/api/panel/users/{user_id}/action")
def panel_user_action(user_id: int, body: UserActionBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    user = get_user(user_id)
    if not user:
        raise HTTPException(404, detail="User not found")
    action = body.action.upper()
    value = body.value

    if action == "ADD_BALANCE":
        db.execute(
            "UPDATE users SET balance = balance + ? WHERE id = ?",
            (float(value or 0), user_id),
        )
        add_transaction(user_id, float(value or 0), payment_method="panel")
    elif action == "SUB_BALANCE":
        db.execute(
            "UPDATE users SET balance = balance - ? WHERE id = ?",
            (float(value or 0), user_id),
        )
        add_transaction(user_id, -float(value or 0), payment_method="panel")
    elif action == "EXTEND_SUB":
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
        if body.subscription_id:
            db.execute(
                "UPDATE subscriptions SET devices_limit = ? WHERE user_id = ? AND id = ?",
                (int(float(value or 0)), user_id, body.subscription_id),
            )
        else:
            db.execute(
                "UPDATE subscriptions SET devices_limit = ? WHERE user_id = ?",
                (int(float(value or 0)), user_id),
            )
    elif action == "BAN":
        db.execute(
            "UPDATE users SET is_banned = 1, status = 'Banned' WHERE id = ?",
            (user_id,),
        )
        _, rw = _rw_find_user(user)
        client = _rw_client()
        if client and rw:
            try:
                client.disable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "UNBAN":
        db.execute("UPDATE users SET is_banned = 0 WHERE id = ?", (user_id,))
        sync_user_status_from_subs(user_id)
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.enable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "BLOCK_KEY":
        # Блокируем ключ (подписку), а не аккаунт пользователя
        db.execute("UPDATE subscriptions SET status = 'Banned' WHERE user_id = ?", (user_id,))
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.disable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "UNBLOCK_KEY":
        # Разблокируем: активные снова Active, но истёкшие вернутся в Expired при обращении
        db.execute(
            "UPDATE subscriptions SET status = 'Active' WHERE user_id = ? AND status = 'Banned'",
            (user_id,),
        )
        sync_user_status_from_subs(user_id)
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.enable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    elif action == "FREEZE":
        try:
            freeze_subscription(user_id, enforce_cooldown=False)  # админ — без суточного лимита
        except HTTPException as exc:
            raise exc
    elif action == "UNFREEZE":
        try:
            unfreeze_subscription(user_id)
        except HTTPException as exc:
            raise exc
    elif action == "NOTIFY":
        delivery = _notify_user(user, str(value or ""))
        return {"success": True, "delivery": delivery, "user": serialize_user(user)}
    elif action == "SET_PARTNER_RATE":
        db.execute(
            "UPDATE users SET is_partner = 1, partner_rate = ? WHERE id = ?",
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
            raise HTTPException(409, detail="Этот Telegram ID уже привязан к другому аккаунту")
        db.execute("UPDATE users SET telegram_id = ? WHERE id = ?", (new_tg, user_id))
    elif action == "UNBIND_TELEGRAM":
        if not user.get("email"):
            raise HTTPException(400, detail="Нельзя отвязать Telegram: не привязан email")
        db.execute("UPDATE users SET telegram_id = NULL WHERE id = ?", (user_id,))
    elif action == "SET_EMAIL":
        new_email = str(value or "").strip().lower()
        if not new_email or "@" not in new_email:
            raise HTTPException(400, detail="Некорректный email")
        clash = db.fetchone("SELECT id FROM users WHERE lower(email) = ? AND id != ?", (new_email, user_id))
        if clash:
            raise HTTPException(409, detail="Этот email уже привязан к другому аккаунту")
        db.execute("UPDATE users SET email = ? WHERE id = ?", (new_email, user_id))
    elif action == "UNBIND_EMAIL":
        if not user.get("telegram_id"):
            raise HTTPException(400, detail="Нельзя отвязать email: не привязан Telegram")
        db.execute("UPDATE users SET email = NULL WHERE id = ?", (user_id,))
    elif action == "RESET_TRIAL":
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
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.delete_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
        db.execute("UPDATE users SET referred_by = NULL WHERE referred_by = ?", (user_id,))
        db.execute("DELETE FROM subscriptions WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM payments WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM transactions WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        return {"success": True, "deleted": True}
    else:
        raise HTTPException(400, detail=f"Unknown action: {action}")

    if body.notify and action not in ("NOTIFY",):
        _notify_user(get_user(user_id) or user, _action_notify_text(action, value))

    user = get_user(user_id)
    assert user is not None
    return {"success": True, "user": serialize_user(user)}


def _action_notify_text(action: str, value: Any) -> str:
    a = action.upper()
    if a == "EXTEND_SUB":
        return f"✅ Ваша подписка продлена на {int(float(value or 0))} дн."
    if a == "REDUCE_SUB":
        return f"ℹ️ Срок вашей подписки уменьшен на {int(float(value or 0))} дн."
    if a in ("ADD_TRAFFIC", "SET_TRAFFIC"):
        return "ℹ️ Лимит трафика по вашей подписке обновлён."
    if a == "BAN":
        return "🚫 Ваш аккаунт заблокирован."
    if a == "UNBAN":
        return "✅ Ваш аккаунт разблокирован."
    return "ℹ️ Ваш аккаунт был обновлён администратором."


@app.post("/api/panel/users/mass-action")
def panel_mass_action(body: MassActionBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    action = body.action.upper()
    value = body.value
    users = db.fetchall("SELECT id FROM users")
    affected = 0

    for row in users:
        uid = int(row["id"])
        if action == "MASS_ADD_DAYS":
            extend_user_sub(uid, int(float(value or 0)), None)
            affected += 1
        elif action == "MASS_ADD_BALANCE":
            db.execute(
                "UPDATE users SET balance = balance + ? WHERE id = ?",
                (float(value or 0), uid),
            )
            affected += 1
        elif action == "MASS_BAN":
            db.execute(
                "UPDATE users SET is_banned = 1, status = 'Banned' WHERE id = ?",
                (uid,),
            )
            affected += 1
        elif action == "MASS_UNBAN":
            db.execute("UPDATE users SET is_banned = 0 WHERE id = ?", (uid,))
            sync_user_status_from_subs(uid)
            affected += 1
        elif action == "MASS_RESET_TRIAL":
            db.execute(
                "DELETE FROM subscriptions WHERE user_id = ? AND type = 'trial'",
                (uid,),
            )
            db.execute("UPDATE users SET status = 'Trial' WHERE id = ?", (uid,))
            affected += 1
        elif action == "MASS_DELETE_KEYS":
            db.execute("DELETE FROM subscriptions WHERE user_id = ?", (uid,))
            affected += 1
        elif action == "MASS_SET_PARTNER":
            if value is not None:
                db.execute(
                    "UPDATE users SET is_partner = 1, partner_rate = ? WHERE id = ?",
                    (float(value), uid),
                )
            else:
                db.execute("UPDATE users SET is_partner = 1 WHERE id = ?", (uid,))
            affected += 1
        elif action == "MASS_REMOVE_PARTNER":
            db.execute("UPDATE users SET is_partner = 0 WHERE id = ?", (uid,))
            affected += 1
        else:
            raise HTTPException(400, detail=f"Unknown mass action: {action}")

    return {"success": True, "affected": affected}


# ═════════════════════════════════════════════════════════════
# PANEL KEYS
# ═════════════════════════════════════════════════════════════

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
def panel_block_key(key_id: int, body: BlockKeyBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    key = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (key_id,))
    if not key:
        raise HTTPException(404, detail="Key not found")
    status = "Banned" if body.blocked else "Active"
    db.execute("UPDATE subscriptions SET status = ? WHERE id = ?", (status, key_id))
    key = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (key_id,))
    assert key is not None
    return serialize_key(key)


# ═════════════════════════════════════════════════════════════
# PANEL MAILING
# ═════════════════════════════════════════════════════════════

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
    """Разметка рассылки → HTML для письма (**жирный**, *курсив*, `моно`, переносы)."""
    import re
    text = _esc_html(msg)
    text = re.sub(r"!\[(\d+)\]", "", text)  # премиум-эмодзи в письме не нужны
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text, flags=re.S)
    text = re.sub(r"`([^`]+?)`", r"<code>\1</code>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", text, flags=re.S)
    return text.replace("\n", "<br>")


# Параллельная рассылка: воркеры отправляют одновременно, общий лимитер держит
# скорость у потолка Telegram (~30 msg/сек). Настраивается через .env.
BROADCAST_RATE = max(1, _env_int("BROADCAST_RATE", 25))       # сообщений/сек
BROADCAST_WORKERS = max(1, _env_int("BROADCAST_WORKERS", 8))  # параллельных отправок


class _RateLimiter:
    """
    Потокобезопасный ограничитель скорости с АВТО-АДАПТАЦИЕЙ:
      • базовая скорость = rate/сек;
      • при 429 (throttle) скорость снижается (интервал ×1.5), но не ниже min_rate;
      • при чистой отправке скорость плавно восстанавливается к базовой.
    """

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
            # Плавное восстановление скорости после серии успешных отправок.
            self._ok_since += 1
            if self._ok_since >= 300 and self._interval > self._min_interval:
                self._interval = max(self._min_interval, self._interval * 0.9)
                self._ok_since = 0
        if wait > 0:
            time.sleep(wait)

    def throttle(self, retry_after: Optional[float] = None) -> None:
        """Telegram вернул 429 → снижаем скорость и держим паузу retry_after."""
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
    """
    Фоновая доставка рассылки в Telegram и/или email — ПАРАЛЛЕЛЬНО (пул воркеров)
    с общим ограничителем скорости. При 100к получателей это упирается только в
    лимит Telegram (~25-30/сек ≈ ~1 час на 100к), а не в сетевую задержку.
    """
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
        ok_any = False
        if do_tg and u.get("telegram_id"):
            limiter.acquire()  # держим общий темп только для Telegram
            if notifier.send_broadcast_message(
                int(u["telegram_id"]), body.message,
                image_url=body.image_url, button_type=body.button_type,
                button_value=body.button_value, miniapp_url=MINIAPP_URL, bot_username=BOT_USERNAME,
                on_throttle=limiter.throttle,  # 429 → авто-снижение скорости
            ):
                ok_any = True
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
        # Периодически пишем прогресс (нечасто, чтобы не грузить БД).
        if done % 200 == 0 or done == total:
            try:
                db.execute("UPDATE mailings SET sent_count = ? WHERE id = ?", (sent, mailing_id))
            except Exception:  # noqa: BLE001
                pass

    with _fut.ThreadPoolExecutor(max_workers=BROADCAST_WORKERS) as pool:
        list(pool.map(_send_one, recipients))

    db.execute("UPDATE mailings SET sent_count = ?, status = 'Completed' WHERE id = ?",
               (counter["sent"], mailing_id))


@app.post("/api/panel/mailing")
def panel_mailing_create(body: MailingBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    if not (body.message or "").strip():
        raise HTTPException(400, detail={"message": "Пустое сообщение"})
    channels = [c for c in (body.channels or ["telegram"]) if c in ("telegram", "email")] or ["telegram"]
    if "email" in channels and not mailer.is_configured():
        raise HTTPException(400, detail={"message": "Почта не настроена (Настройки → Почта)"})

    recipients = _mailing_recipients(body.target_users)
    # Кого реально достанем выбранными каналами.
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
        import threading
        threading.Thread(
            target=_deliver_mailing,
            args=(mailing_id, body, reach, channels),
            name=f"mailing-{mailing_id}",
            daemon=True,
        ).start()

    item = db.fetchone("SELECT * FROM mailings WHERE id = ?", (mailing_id,))
    assert item is not None
    result = serialize_mailing(item)
    result["recipients_total"] = len(reach)
    return result


@app.delete("/api/panel/mailing/{mailing_id}")
def panel_mailing_delete(mailing_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    row = db.fetchone("SELECT id FROM mailings WHERE id = ?", (mailing_id,))
    if not row:
        raise HTTPException(404, detail="Mailing not found")
    db.execute("DELETE FROM mailings WHERE id = ?", (mailing_id,))
    return {"success": True}


# ═════════════════════════════════════════════════════════════
# PANEL PROMOCODES
# ═════════════════════════════════════════════════════════════

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
    return [serialize_promocode(p) for p in items]


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


# ═════════════════════════════════════════════════════════════
# PANEL PROMOTIONS
# ═════════════════════════════════════════════════════════════

@app.get("/api/panel/promotions")
def panel_promotions(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    items = db.fetchall("SELECT * FROM promotions ORDER BY id DESC")
    return [serialize_promotion(p) for p in items]


@app.post("/api/panel/promotions")
def panel_promo_campaign_create(body: PromotionBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    # Пополнение убрано — поддерживается только глобальная скидка.
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
            # Пополнение убрано — тип всегда глобальная скидка.
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


# ═════════════════════════════════════════════════════════════
# PANEL TRACKING LINKS
# ═════════════════════════════════════════════════════════════

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


# ═════════════════════════════════════════════════════════════
# PANEL SQUADS (Remnawave)
# ═════════════════════════════════════════════════════════════

@app.get("/api/panel/remnawave/squads")
def panel_remnawave_squads(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    rows = db.fetchall("SELECT squad_uuid, squad_name FROM squads WHERE is_active = 1")
    return [{"uuid": r["squad_uuid"], "name": r["squad_name"]} for r in rows]


@app.get("/api/panel/squads")
def panel_squads(_: dict = Depends(require_panel)) -> dict[str, Any]:
    rows = db.fetchall("SELECT * FROM squads ORDER BY priority DESC")
    return {
        "squads": [serialize_squad(s) for s in rows],
        "mapping": get_squad_mapping(),
    }


@app.post("/api/panel/squads/sync")
def panel_squads_sync(_: dict = Depends(require_panel)) -> dict[str, Any]:
    """Синхронизация внутренних сквадов из Remnawave (/api/internal-squads)."""
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

    # Сквады, которых больше нет в Remnawave, помечаем неактивными.
    if seen:
        placeholders = ",".join("?" * len(seen))
        db.execute(f"UPDATE squads SET is_active = 0 WHERE squad_uuid NOT IN ({placeholders})", seen)

    count_row = db.fetchone("SELECT COUNT(*) AS c FROM squads WHERE is_active = 1")
    return {"success": True, "count": int(count_row["c"]) if count_row else 0, "synced": len(seen)}


@app.put("/api/panel/squads/{squad_uuid}")
def panel_squad_update(
    squad_uuid: str, body: SquadUpdateBody, _: dict = Depends(require_panel)
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
def panel_squad_mapping(body: SquadMappingBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    set_squad_mapping(list(body.vpn), list(body.trial))
    return {"success": True}


# ═════════════════════════════════════════════════════════════
# PANEL BACKUPS
# ═════════════════════════════════════════════════════════════

@app.get("/api/panel/backups/status")
def panel_backup_status(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return get_backup_settings()


@app.post("/api/panel/backups/create")
def panel_backup_create(_: dict = Depends(require_panel)) -> dict[str, Any]:
    try:
        info = create_backup()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, detail={"message": f"Не удалось создать бэкап: {exc}"})
    return {"success": True, **info, "backups": list_backups()}


@app.get("/api/panel/backups/download")
def panel_backup_download(name: str = Query(...), _: dict = Depends(require_panel)):
    from fastapi.responses import FileResponse

    safe = os.path.basename(name)
    if not safe.endswith(".db"):
        raise HTTPException(400, detail={"message": "Некорректное имя файла"})
    path = os.path.join(_backup_dir(), safe)
    if not os.path.isfile(path):
        raise HTTPException(404, detail={"message": "Бэкап не найден"})
    return FileResponse(path, media_type="application/octet-stream", filename=safe)


@app.put("/api/panel/backups/settings")
def panel_backup_settings(body: BackupSettingsBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    db.set_setting("backup_enabled", "1" if body.enabled else "0")
    db.set_setting("backup_interval_hours", str(max(1, body.interval_hours)))
    return get_backup_settings()


# ═════════════════════════════════════════════════════════════
# PANEL FORUM (группа-форум + топики)
# ═════════════════════════════════════════════════════════════

@app.get("/api/panel/forum")
def panel_forum_get(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return forum.get_config()


@app.put("/api/panel/forum")
def panel_forum_put(body: ForumConfigBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    return forum.save_config(body.forum_chat_id or "", body.topics or {}, panel_url_value=body.panel_url)


# ═════════════════════════════════════════════════════════════
# PANEL WITHDRAWALS (выводы реф. средств)
# ═════════════════════════════════════════════════════════════

def _serialize_withdrawal_admin(w: dict[str, Any]) -> dict[str, Any]:
    user = get_user(int(w["user_id"])) if w.get("user_id") else None
    data = services.serialize_withdrawal(w)
    data["username"] = (user or {}).get("username")
    data["telegram_id"] = (user or {}).get("telegram_id")
    return data


@app.get("/api/panel/withdrawals")
def panel_withdrawals(status: Optional[str] = Query(None), _: dict = Depends(require_panel)) -> dict[str, Any]:
    if status and status != "all":
        rows = db.fetchall("SELECT * FROM withdrawals WHERE status = ? ORDER BY id DESC", (status,))
    else:
        rows = db.fetchall("SELECT * FROM withdrawals ORDER BY id DESC")
    pending = db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status = 'pending'")
    return {
        "items": [_serialize_withdrawal_admin(w) for w in rows],
        "pending_count": int(pending["c"]) if pending else 0,
        "pending_amount": round(float(pending["s"]) if pending else 0, 2),
    }


@app.post("/api/panel/withdrawals/{withdrawal_id}/approve")
def panel_withdraw_approve(withdrawal_id: int, body: WithdrawApproveBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    try:
        w = services.approve_withdrawal(withdrawal_id, body.tx_link)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})
    _finalize_withdrawal_approved(w)
    return _serialize_withdrawal_admin(w)


@app.post("/api/panel/withdrawals/{withdrawal_id}/reject")
def panel_withdraw_reject(withdrawal_id: int, _: dict = Depends(require_panel)) -> dict[str, Any]:
    try:
        w = services.reject_withdrawal(withdrawal_id)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})
    try:
        forum.remove_withdrawal_message(w)
    except Exception:  # noqa: BLE001
        pass
    return _serialize_withdrawal_admin(w)


def _finalize_withdrawal_approved(w: dict[str, Any]) -> None:
    """DM пользователю об одобрении + удаление сообщения из форума."""
    user = get_user(int(w["user_id"])) if w.get("user_id") else None
    tg = (user or {}).get("telegram_id")
    try:
        if tg:
            forum.dm_withdrawal_approved(int(tg), str(w.get("tx_link") or ""))
    except Exception:  # noqa: BLE001
        pass
    try:
        forum.remove_withdrawal_message(w)
    except Exception:  # noqa: BLE001
        pass


# ═════════════════════════════════════════════════════════════
# PANEL CONTENT / PLANS
# ═════════════════════════════════════════════════════════════

@app.get("/api/panel/content/offer")
def panel_get_offer(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return {"text": db.get_setting("offer_text", "")}


@app.put("/api/panel/content/offer")
def panel_put_offer(body: ContentTextBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    db.set_setting("offer_text", body.text)
    return {"text": body.text}


@app.get("/api/panel/content/privacy")
def panel_get_privacy(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return {"text": db.get_setting("privacy_text", "")}


@app.put("/api/panel/content/privacy")
def panel_put_privacy(body: ContentTextBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    db.set_setting("privacy_text", body.text)
    return {"text": body.text}


@app.get("/api/panel/plans")
def panel_get_plans(_: dict = Depends(require_panel)) -> list[dict[str, Any]]:
    return get_all_plans_panel()


@app.get("/api/panel/plans/meta")
def panel_plans_meta(_: dict = Depends(require_panel)) -> dict[str, Any]:
    return get_plans_meta()


@app.put("/api/panel/plans")
def panel_put_plans(body: PlansUpdateBody, _: dict = Depends(require_panel)) -> dict[str, Any]:
    if body.extra_device_price is not None:
        db.set_setting("extra_device_price", str(body.extra_device_price))
    if body.default_included_devices is not None:
        db.set_setting("default_included_devices", str(int(body.default_included_devices)))
    if body.trial_enabled is not None:
        db.set_setting("trial_enabled", "1" if body.trial_enabled else "0")
    if body.traffic_reset_price is not None:
        db.set_setting("traffic_reset_price", str(max(0.0, float(body.traffic_reset_price))))
    if body.antiabuse_enabled is not None:
        db.set_setting("antiabuse_enabled", "1" if body.antiabuse_enabled else "0")

    # Replace plans: update existing by id/devices, insert new, deactivate missing
    seen_ids: list[int] = []
    for idx, plan in enumerate(body.plans):
        sort_order = plan.sort_order if plan.sort_order else idx + 1
        price_rub = float(plan.price_rub)
        price_stars = round(price_rub)  # курс жёстко 1 звезда = 1 рубль
        existing = None
        if plan.id:
            existing = db.fetchone("SELECT id FROM plans WHERE id = ?", (plan.id,))
        if not existing:
            existing = db.fetchone("SELECT id FROM plans WHERE devices = ?", (plan.devices,))
        if existing:
            db.execute(
                "UPDATE plans SET devices = ?, price_rub = ?, price_stars = ?, is_active = ?, sort_order = ? "
                "WHERE id = ?",
                (
                    plan.devices,
                    price_rub,
                    price_stars,
                    1 if plan.is_active else 0,
                    sort_order,
                    existing["id"],
                ),
            )
            seen_ids.append(int(existing["id"]))
        else:
            db.execute(
                "INSERT INTO plans (devices, price_rub, price_stars, is_active, sort_order) VALUES (?, ?, ?, ?, ?)",
                (
                    plan.devices,
                    price_rub,
                    price_stars,
                    1 if plan.is_active else 0,
                    sort_order,
                ),
            )
            seen_ids.append(db.last_id())

    if seen_ids:
        placeholders = ",".join("?" * len(seen_ids))
        db.execute(
            f"UPDATE plans SET is_active = 0 WHERE id NOT IN ({placeholders})",
            seen_ids,
        )
    else:
        db.execute("UPDATE plans SET is_active = 0")

    return {
        "plans": get_all_plans_panel(),
        **get_plans_meta(),
    }


# ═════════════════════════════════════════════════════════════
# MINI-APP
# ═════════════════════════════════════════════════════════════

@app.get("/api/app/config")
def app_config() -> dict[str, Any]:
    bot_id = ""
    if TELEGRAM_BOT_TOKEN and ":" in TELEGRAM_BOT_TOKEN:
        bot_id = TELEGRAM_BOT_TOKEN.split(":", 1)[0]
    meta = get_plans_meta()
    prices = {p["devices"]: p["price_rub"] for p in get_active_plans()}
    offer = db.get_setting("offer_text", "")
    privacy = db.get_setting("privacy_text", "")
    return {
        "telegramOauthBotId": bot_id,
        "telegramOauthUrl": "",
        "botUsername": BOT_USERNAME,
        "prices": prices,
        "extraDevicePrice": meta["extra_device_price"],
        "defaultDevices": meta["default_included_devices"],
        "minPrice": min_plan_price(),
        "legalAvailable": bool(offer.strip() or privacy.strip()),
        "supportUrl": _env("SUPPORT_URL") or "https://t.me/blinteams",
        "trialEnabled": trial_enabled(),
        "trialDays": fulfillment.TRIAL_DAYS,
        "providerMin": PROVIDER_MIN_RUB,
        "trafficResetPrice": float(db.get_setting("traffic_reset_price", "0") or 0),
    }


def _resolve_app_user_from_tg(tg: dict[str, Any]) -> dict[str, Any]:
    telegram_id = int(tg.get("id") or 0)
    if not telegram_id:
        raise HTTPException(401, detail={"message": "Нет telegram id"})
    user = upsert_telegram_user(
        telegram_id=telegram_id,
        username=tg.get("username"),
        first_name=tg.get("first_name"),
        last_name=tg.get("last_name"),
    )
    if user.get("is_banned"):
        raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
    return user


def _resolve_app_user_from_email(email: str) -> dict[str, Any]:
    """Находит пользователя по email или создаёт нового (вход = регистрация)."""
    email = email.strip().lower()
    user = db.fetchone("SELECT * FROM users WHERE lower(email) = ?", (email,))
    if user:
        if user.get("is_banned"):
            raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
        return user
    db.execute(
        "INSERT INTO users (telegram_id, username, email, balance, status, is_banned, referral_code, "
        "is_partner, partner_balance, partner_rate, autopay_enabled, created_at) "
        "VALUES (NULL, NULL, ?, 0, 'Trial', 0, ?, 0, 0, 25, 0, ?)",
        (email, gen_ref_code(), db.utcnow_iso()),
    )
    fresh = get_user(db.last_id())
    assert fresh is not None
    return fresh


@app.post("/api/app/auth")
def app_auth(x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data")) -> dict[str, Any]:
    data = validate_webapp_init_data(x_telegram_init_data or "")
    user = _resolve_app_user_from_tg(data.get("user") or {})
    return {"user": serialize_app_user(user)}


@app.post("/api/app/auth/oauth")
def app_auth_oauth(body: OauthBody) -> dict[str, Any]:
    payload = body.model_dump()
    validated = validate_oauth_login(payload)
    user = _resolve_app_user_from_tg(
        {
            "id": validated.get("id"),
            "username": validated.get("username"),
            "first_name": validated.get("first_name"),
            "last_name": validated.get("last_name"),
        }
    )
    token = create_app_session(int(user["id"]))
    return {"user": serialize_app_user(user), "token": token}


# ── Вход по email (без паролей): запрос кода → проверка кода ──

@app.post("/api/app/auth/email/request")
def app_auth_email_request(body: EmailRequestBody, request: Request = None) -> dict[str, Any]:  # type: ignore[assignment]
    email = (body.email or "").strip().lower()
    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, detail={"message": "Введите корректный email"})

    # Не больше 3 писем за 5 минут на адрес (и защита по IP).
    allowed, retry = ratelimit.rate_limit(f"emailcode:{email}", 3, 300)
    if allowed:
        ip = _client_ip(request)
        if ip:
            allowed, retry = ratelimit.rate_limit(f"emailcode_ip:{ip}", 10, 300)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком много запросов. Повторите через {retry} сек."})

    code, throttled = create_email_code(email)
    if not throttled:
        send_login_code(email, code)
    resp: dict[str, Any] = {"ok": True, "throttled": throttled, "resend_after": EMAIL_CODE_RESEND}
    # Если доставка писем не настроена — отдаём код для отладки (не в проде).
    if ENV != "production" and not mailer.is_configured():
        resp["dev_code"] = code
    return resp


@app.post("/api/app/auth/email/verify")
def app_auth_email_verify(body: EmailVerifyBody) -> dict[str, Any]:
    email = (body.email or "").strip().lower()
    if not verify_email_code(email, body.code or ""):
        raise HTTPException(401, detail={"message": "Неверный или истёкший код"})
    user = _resolve_app_user_from_email(email)
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
    x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
    x_app_session: Optional[str] = Header(None, alias="X-App-Session"),
) -> dict[str, Any]:
    # 1) Telegram Mini App — подпись initData
    if x_telegram_init_data:
        data = validate_webapp_init_data(x_telegram_init_data)
        tg = data.get("user") or {}
        if tg.get("id"):
            return _resolve_app_user_from_tg(tg)
    # 2) Сессионный токен (веб-вход по email / OAuth)
    token = _extract_app_token(authorization, x_app_session)
    if token:
        sess = get_app_session(token)
        if not sess:
            raise HTTPException(401, detail={"message": "Сессия истекла, войдите заново"})
        user = get_user(int(sess["user_id"]))
        if not user:
            raise HTTPException(401, detail={"message": "Пользователь не найден"})
        if user.get("is_banned"):
            raise HTTPException(403, detail={"message": "Аккаунт заблокирован"})
        return user
    # 3) Dev/allow-unauth фолбэк (в проде бросит 401)
    data = validate_webapp_init_data(x_telegram_init_data or "")
    return _resolve_app_user_from_tg(data.get("user") or {})


# ── Обязательная подписка на канал (только вход через Telegram) ──────────

_CHANNEL_MEMBER_STATUSES = {"creator", "administrator", "member", "restricted"}


def _check_channel_membership(user: dict[str, Any], *, force: bool = False) -> bool:
    """
    Подписан ли Telegram-пользователь на обязательный канал. Кэшируется
    (channel_ok/channel_checked_at) на CHANNEL_CHECK_TTL, чтобы не упираться в
    лимиты Telegram. Если проверить нельзя (бот не админ канала/ошибка) —
    fail-open (True), чтобы не залочить всех, и пишем в лог.
    """
    tgid = user.get("telegram_id")
    if not tgid or not REQUIRED_CHANNEL_ID:
        return True
    # Кэш: подтверждённая подписка не перепроверяется чаще TTL.
    if not force and int(user.get("channel_ok") or 0) == 1:
        ts = parse_iso(user.get("channel_checked_at"))
        if ts and (utcnow() - ts).total_seconds() < CHANNEL_CHECK_TTL:
            return True
    status = notifier.get_chat_member_status(REQUIRED_CHANNEL_ID, int(tgid))
    if status is None:
        # Не смогли проверить (обычно бот не добавлен админом в канал).
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
    """Зависимость для действий: Telegram-вход без подписки на канал → 403."""
    if bool(x_telegram_init_data) and user.get("telegram_id") and REQUIRED_CHANNEL_ID:
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
    """
    Статус обязательной подписки на канал. Только для входа через Telegram;
    при веб-входе (email) — required=False.
    """
    is_tg = bool(x_telegram_init_data)
    fresh = get_user(int(user["id"])) or user
    if not is_tg or not fresh.get("telegram_id") or not REQUIRED_CHANNEL_ID:
        return {"required": False, "subscribed": True,
                "channel_url": REQUIRED_CHANNEL_URL, "optional_url": OPTIONAL_CHANNEL_URL}
    subscribed = _check_channel_membership(fresh, force=bool(force))
    return {
        "required": True,
        "subscribed": bool(subscribed),
        "channel_url": REQUIRED_CHANNEL_URL,
        "optional_url": OPTIONAL_CHANNEL_URL,
    }


@app.get("/api/app/me")
def app_me(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


@app.put("/api/app/me/email")
def app_me_email(body: UpdateEmailBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, detail={"message": "Некорректный email"})
    clash = db.fetchone("SELECT id FROM users WHERE lower(email) = ? AND id != ?", (email, user["id"]))
    if clash:
        raise HTTPException(409, detail={"message": "Этот email уже используется"})
    db.execute("UPDATE users SET email = ? WHERE id = ?", (email, user["id"]))
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


@app.delete("/api/app/me/email")
def app_me_email_unbind(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    if not fresh.get("telegram_id"):
        raise HTTPException(400, detail={"message": "Нельзя отвязать email: это единственный способ входа"})
    db.execute("UPDATE users SET email = NULL WHERE id = ?", (user["id"],))
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


@app.put("/api/app/me/telegram")
def app_me_telegram(body: OauthBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """Привязать/изменить Telegram (веб-вход). Отвязать нельзя."""
    validated = validate_oauth_login(body.model_dump())
    new_tg = int(validated.get("id") or 0)
    if not new_tg:
        raise HTTPException(400, detail={"message": "Нет Telegram id"})
    clash = db.fetchone("SELECT id FROM users WHERE telegram_id = ? AND id != ?", (new_tg, user["id"]))
    if clash:
        raise HTTPException(409, detail={"message": "Этот Telegram уже привязан к другому аккаунту"})
    db.execute(
        "UPDATE users SET telegram_id = ?, username = COALESCE(?, username) WHERE id = ?",
        (new_tg, validated.get("username"), user["id"]),
    )
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    return {"user": serialize_app_user(fresh)}


def _has_trial_ever(user_id: int) -> bool:
    return bool(db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND type = 'trial' LIMIT 1", (user_id,)
    ))


def _has_any_sub(user_id: int) -> bool:
    return bool(db.fetchone("SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1", (user_id,)))


def _trial_available_for(user_id: int) -> bool:
    """Пробный доступен: включён админом и пользователь ещё не брал никакую подписку."""
    return trial_enabled() and not _has_any_sub(user_id)


@app.get("/api/app/subscription")
def app_subscription(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    # Заморозка дольше 30 дней снимается автоматически при открытии приложения.
    try:
        auto_unfreeze_if_expired(int(fresh["id"]))
    except Exception:  # noqa: BLE001
        pass
    keys = db.fetchall(
        "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC", (fresh["id"],)
    )
    serialized = [serialize_key(k, fresh) for k in keys]
    active = next((k for k in serialized if k.get("status") in ("Active", "Frozen")), None)
    return {
        "status": subscription_status_for_user(fresh),
        "until": paid_until_for_user(int(fresh["id"])),
        "key": active,
        "keys": serialized,
        "frozen": bool(active and active.get("status") == "Frozen"),
        "trial_enabled": trial_enabled(),
        "trial_available": _trial_available_for(int(fresh["id"])),
    }


@app.get("/api/app/setup-status")
def app_setup_status(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """
    Нужно ли показать онбординг-модалку «Вы не завершили настройку»: у
    пользователя есть активная/замороженная подписка, но он ни разу не
    подключался к VPN (не добавил подписку в приложение). Если проверить
    подключение нельзя (Remnawave недоступна) — модалку НЕ показываем.
    """
    fresh = get_user(int(user["id"])) or user
    has_sub = bool(db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('Active','Frozen') LIMIT 1",
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


def _target_freeze_sub(user_id: int, want_frozen: bool) -> Optional[dict[str, Any]]:
    """Подписка для (раз)заморозки: платная/пробная, в нужном статусе."""
    status = "Frozen" if want_frozen else "Active"
    return db.fetchone(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status = ? "
        "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
        (user_id, status),
    )


FREEZE_COOLDOWN_HOURS = 24   # замораживать не чаще раза в сутки
FREEZE_MAX_DAYS = 30         # дольше 30 дней держать заморозку нельзя (авто-разморозка)


def freeze_subscription(user_id: int, *, enforce_cooldown: bool = True) -> dict[str, Any]:
    """
    Замораживает активную подписку: сохраняет остаток времени и ставит на паузу
    (в Remnawave — disable). Отсчёт дней останавливается.
    Лимит: не чаще раза в 24 часа (для действий пользователя; админ — без лимита).
    """
    sub = _target_freeze_sub(user_id, want_frozen=False)
    if not sub:
        raise HTTPException(400, detail={"message": "Нет активной подписки для заморозки"})
    # Ограничение частоты: не чаще раза в сутки.
    if enforce_cooldown:
        last = parse_iso(sub.get("last_freeze_at"))
        if last:
            elapsed = (utcnow() - last).total_seconds()
            if elapsed < FREEZE_COOLDOWN_HOURS * 3600:
                hrs = int((FREEZE_COOLDOWN_HOURS * 3600 - elapsed) // 3600) + 1
                raise HTTPException(429, detail={
                    "message": f"Замораживать можно не чаще раза в сутки. Попробуйте через ~{hrs} ч."})
    exp = parse_iso(sub.get("expires_at"))
    remaining = int(max(0, (exp - utcnow()).total_seconds())) if exp else 0
    now_iso = db.utcnow_iso()
    db.execute(
        "UPDATE subscriptions SET status = 'Frozen', frozen_at = ?, frozen_remaining = ?, "
        "last_freeze_at = ? WHERE id = ?",
        (now_iso, remaining, now_iso, sub["id"]),
    )
    user = get_user(user_id)
    if user:
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.disable_user(_rw_num_id(rw))
            except Exception:  # noqa: BLE001
                pass
    return refresh_subscription_row(db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (sub["id"],)))


def auto_unfreeze_if_expired(user_id: int) -> bool:
    """Если заморозка длится ≥ FREEZE_MAX_DAYS — автоматически размораживаем."""
    sub = _target_freeze_sub(user_id, want_frozen=True)
    if not sub:
        return False
    fa = parse_iso(sub.get("frozen_at"))
    if not fa or (utcnow() - fa).total_seconds() < FREEZE_MAX_DAYS * 86400:
        return False
    try:
        unfreeze_subscription(user_id)
        return True
    except HTTPException:
        return False


def auto_unfreeze_expired_all(log=print) -> int:
    """Фоновый проход: размораживает все подписки, замороженные ≥ 30 дней."""
    cutoff = iso(utcnow() - timedelta(days=FREEZE_MAX_DAYS))
    rows = db.fetchall(
        "SELECT DISTINCT user_id FROM subscriptions WHERE status = 'Frozen' "
        "AND frozen_at IS NOT NULL AND frozen_at <= ?",
        (cutoff,),
    )
    n = 0
    for r in rows:
        try:
            if auto_unfreeze_if_expired(int(r["user_id"])):
                n += 1
        except Exception:  # noqa: BLE001
            pass
    if n:
        log(f"[freeze] авто-разморозка (30 дней): {n}")
    return n


def unfreeze_subscription(user_id: int) -> dict[str, Any]:
    """
    Размораживает подписку: новый срок = сейчас + сохранённый остаток (человек не
    теряет оплаченное время). В Remnawave — enable + новая дата окончания.
    """
    sub = _target_freeze_sub(user_id, want_frozen=True)
    if not sub:
        raise HTTPException(400, detail={"message": "Нет замороженной подписки"})
    rem = sub.get("frozen_remaining")
    if rem is None:
        # запасной путь: считаем от frozen_at, иначе от expires_at
        rem = 0
    new_exp = utcnow() + timedelta(seconds=int(rem))
    db.execute(
        "UPDATE subscriptions SET status = 'Active', frozen_at = NULL, frozen_remaining = NULL, "
        "expires_at = ? WHERE id = ?",
        (iso(new_exp), sub["id"]),
    )
    user = get_user(user_id)
    if user:
        client, rw = _rw_find_user(user)
        if client and rw:
            try:
                client.enable_user(_rw_num_id(rw))
                client.update_user(id=_rw_num_id(rw), expire_at=new_exp, status="ACTIVE")
            except Exception:  # noqa: BLE001
                pass
    sync_user_status_from_subs(user_id)
    return refresh_subscription_row(db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (sub["id"],)))


@app.post("/api/app/subscription/freeze")
def app_freeze(user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    allowed, retry = ratelimit.rate_limit(f"freeze:{user['id']}", 10, 3600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})
    return {"success": True, "key": freeze_subscription(int(user["id"]))}


@app.post("/api/app/subscription/unfreeze")
def app_unfreeze(user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    return {"success": True, "key": unfreeze_subscription(int(user["id"]))}


@app.post("/api/app/trial")
def app_activate_trial(user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    """Активация бесплатного пробного периода (3 дня, 5 ГБ, 1 устройство)."""
    allowed, retry = ratelimit.rate_limit(f"trial:{user['id']}", 5, 3600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    if not trial_enabled():
        raise HTTPException(403, detail={"message": "Пробный период сейчас недоступен"})
    if not fresh.get("telegram_id"):
        raise HTTPException(400, detail={"message": "Пробный доступен только при входе через Telegram"})
    if _has_any_sub(int(fresh["id"])):
        raise HTTPException(400, detail={"message": "Пробный период уже был активирован"})
    try:
        result = fulfillment.grant_trial(fresh)
    except Exception as exc:  # noqa: BLE001
        forum.report_error("Не удалось выдать пробную подписку", f"{type(exc).__name__}: {exc}")
        raise HTTPException(502, detail={"message": "Не удалось активировать пробный период"})
    return {"success": True, **result}


def _app_sub_url(user: dict[str, Any]) -> Optional[str]:
    """URL подписки пользователя для импорта в приложение (Remnawave sub-link или fallback)."""
    # 1) Remnawave — настоящая ссылка подписки
    client, rw = _rw_find_user(user)
    if client and rw:
        try:
            u = client.subscription_url_for(rw)
            if u:
                return str(u)
        except Exception:  # noqa: BLE001
            pass
    # 2) Fallback: строим из short_uuid или берём сохранённый конфиг
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
    """
    Deep-link для добавления подписки в приложение (генерация на самой машине).
      app=incy  → incy://crypt1/... (шифрование на самой машине)
      app=happ  → happ://crypt5/... (внешний API happ, fallback crypt4)
      app=other → просто ссылка на подписку
    """
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
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail={"message": f"Не удалось сформировать ссылку: {exc}"})
        # Telegram не открывает схемы incy:// / happ:// напрямую, поэтому отдаём
        # https-страницу-редирект (на домене сайта), которая уже открывает схему.
        return {"app": which, "link": link, "encrypted": True, "open_url": _deeplink_redirect_url(link)}
    # other — просто ссылка (https, открывается напрямую)
    return {"app": "other", "link": sub_url, "encrypted": False, "open_url": sub_url}


def _deeplink_redirect_url(deep_link: str) -> str:
    """https://<сайт>/redirect.html?url=<incy|happ://...> — для открытия из Telegram."""
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
        "SELECT devices_limit FROM subscriptions WHERE user_id = ? AND status = 'Active'",
        (fresh["id"],),
    )
    limit = max((int(k.get("devices_limit") or 0) for k in keys), default=int(meta["default_included_devices"]))

    # Реальные HWID-устройства из Remnawave.
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
    return {"devices": devices, "used": len(devices), "limit": limit}


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
        # Отвязываем только у СВОЕГО аккаунта Remnawave — чужое устройство не тронуть.
        client.delete_hwid_device({"userId": _rw_num_id(rw), "hwid": device_id})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail={"message": f"Не удалось отвязать устройство: {exc}"})
    return {"success": True, "device_id": device_id}


def _compute_order_price(user: dict[str, Any], body: CreatePaymentBody) -> dict[str, Any]:
    """
    Считает цену заказа (₽ и звёзды) с учётом назначения и скидки. Единый источник
    для создания платежа и предпросмотра-квоты (чтобы цены совпадали).
    Бросает HTTPException при некорректных данных.
    """
    prices = plan_price_map()
    meta = get_plans_meta()
    months = min(24, max(1, int(body.months or 1)))
    extra = min(50, max(0, int(body.extra_devices or 0)))
    purpose = body.purpose or "subscription"
    extra_price = float(meta["extra_device_price"])

    if purpose == "traffic_reset":
        tr_price = float(db.get_setting("traffic_reset_price", "0") or 0)
        if tr_price <= 0:
            raise HTTPException(400, detail={"message": "Досрочный сброс трафика недоступен"})
        price = tr_price
        stars = int(round(tr_price))
    elif purpose == "devices":
        # Докупка устройств. Цена ∝ ОСТАТКУ дней: extra_price × (дней/30) × кол-во.
        if extra <= 0:
            raise HTTPException(400, detail={"message": "Не указано число устройств"})
        sub = None
        if body.subscription_id:
            sub = db.fetchone(
                "SELECT expires_at FROM subscriptions WHERE id = ? AND user_id = ?",
                (body.subscription_id, user["id"]),
            )
        if not sub:
            sub = db.fetchone(
                "SELECT expires_at FROM subscriptions WHERE user_id = ? AND status = 'Active' "
                "ORDER BY id DESC LIMIT 1",
                (user["id"],),
            )
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
        # Покупка/продление тарифа: число устройств ДОЛЖНО соответствовать плану.
        base = prices.get(int(body.plan_devices))
        if base is None:
            raise HTTPException(400, detail={"message": "Тариф не найден"})
        total_devices = int(body.plan_devices) + extra
        keep = fulfillment.retained_devices(
            int(user["id"]), purpose, body.subscription_id, total_devices)
        price = float(base) * months + (extra + keep) * extra_price
        stars = int(round(price))  # курс 1 звезда = 1 рубль

    # Скидка (сброс трафика скидкой не облагается). Промо/акция + бонус за опрос
    # суммируются.
    if purpose != "traffic_reset":
        percent = float(effective_discount(int(user["id"]))["percent"])
        if percent > 0:
            price = discounted(price, percent)
            stars = int(discounted(stars, percent))

    return {"price": round(float(price), 2), "stars": int(stars), "months": months,
            "extra": extra, "purpose": purpose}


def _referral_preview(user_id: int, price: float, method: str, use_ref: bool) -> dict[str, Any]:
    """Сколько спишется с реф. баланса и итоговая сумма к оплате (без заморозки)."""
    pmin = provider_min_rub(method)
    if not use_ref or method == "tg_stars" or price <= 0:
        return {"referral_applied": 0.0, "charge": round(price, 2), "provider_min": pmin}
    u = get_user(user_id)
    bal = float((u or {}).get("partner_balance") or 0)
    applied = 0.0
    if bal > 0:
        desired = min(bal, price)
        leftover = round(price - desired, 2)
        if 0 < leftover < pmin:
            desired = price if bal >= price else round(price - pmin, 2)
        applied = round(min(bal, desired), 2)
    return {"referral_applied": applied, "charge": round(price - applied, 2), "provider_min": pmin}


@app.post("/api/app/payment/quote")
def app_payment_quote(body: CreatePaymentBody, user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    """Предпросмотр цены (без создания платежа): итог, скидка, списание с баланса."""
    q = _compute_order_price(get_user(int(user["id"])) or user, body)
    is_stars = body.method == "tg_stars"
    prev = _referral_preview(int(user["id"]), q["price"], body.method, bool(body.use_referral_balance))
    return {
        "purpose": q["purpose"],
        "price": q["price"],
        "stars": q["stars"],
        "referral_applied": prev["referral_applied"],
        "charge": 0 if is_stars else prev["charge"],
        "provider_min": prev["provider_min"],
        "is_stars": is_stars,
    }


@app.post("/api/app/payment/create")
def app_payment_create(body: CreatePaymentBody, user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    # Ограничение частоты: не даём заваливать создание платежей.
    allowed, retry = ratelimit.rate_limit(f"pay:{user['id']}", 20, 600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})

    q = _compute_order_price(user, body)
    price = q["price"]
    stars = q["stars"]
    months = q["months"]
    extra = q["extra"]

    # Докупка устройств обязана быть привязана к конкретной подписке (grant по ней
    # прибавляет лимит). Если клиент не прислал id — берём активную подписку.
    if q["purpose"] == "devices" and not body.subscription_id:
        s = db.fetchone(
            "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'Active' "
            "ORDER BY id DESC LIMIT 1", (user["id"],))
        if s:
            body.subscription_id = int(s["id"])

    is_stars = body.method == "tg_stars"
    pmin = provider_min_rub(body.method)

    # ── Оплата реферальным балансом (только рубли, не Stars) — до 100% ──
    # Можно покрыть всю цену. Если после списания провайдеру осталось бы меньше
    # его минимума (>0 и <pmin) — либо покрываем полностью, либо оставляем ровно
    # минимум. Заморозка баланса — атомарная.
    referral_applied = 0.0
    if body.use_referral_balance and not is_stars and price > 0:
        fresh = get_user(int(user["id"]))
        bal = float((fresh or {}).get("partner_balance") or 0)
        if bal > 0:
            desired = min(bal, price)
            leftover = round(price - desired, 2)
            if 0 < leftover < pmin:
                desired = price if bal >= price else round(price - pmin, 2)
            referral_applied = round(min(bal, desired), 2)
            if referral_applied > 0:
                frozen = db.execute(
                    "UPDATE users SET partner_balance = partner_balance - ? "
                    "WHERE id = ? AND partner_balance >= ?",
                    (referral_applied, int(user["id"]), referral_applied),
                )
                if frozen.rowcount == 0:
                    referral_applied = 0.0  # баланс изменился между чтением и списанием

    charge = round(float(price) - referral_applied, 2)

    # ── Минимальная сумма провайдера (только если что-то платится провайдеру) ──
    if not is_stars and charge > 0 and charge < pmin:
        if referral_applied > 0:  # разморозить, раз платёж не создаём
            db.execute("UPDATE users SET partner_balance = partner_balance + ? WHERE id = ?",
                       (referral_applied, int(user["id"])))
        method_name = {"card": "картой", "sberpay": "через SberPay", "sbp": "через СБП"}.get(
            body.method, "этим способом")
        raise HTTPException(400, detail={
            "message": f"Минимальная сумма оплаты {method_name} — {int(pmin)} ₽"})

    # Полностью оплачено балансом → провайдер не нужен, выдаём сразу.
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

    # ── Полная оплата реферальным балансом: выдаём немедленно ──
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

    # Описание для провайдера и счёта Stars: «<Назначение> (внутренний id юзера)».
    title = "BlinVPN"
    description = _payment_description(q["purpose"], int(user["id"]))

    # ── Telegram Stars ───────────────────────────────────────
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

    # ── Platega (СБП / карта / SberPay) ──────────────────────
    if platega is None:
        fulfillment.mark_failed(payment_id, "platega_module_missing")
        raise HTTPException(503, detail={"message": "Платёжная система недоступна"})
    client = platega.get_client()
    if not client.is_configured():
        fulfillment.mark_failed(payment_id, "platega_not_configured")
        raise HTTPException(503, detail={"message": "Платёжная система не настроена"})

    method_code = platega.APP_METHOD_MAP.get(body.method, platega.METHOD_SBP)
    return_url = f"{PLATEGA_RETURN_URL}?payment_id={payment_id}" if PLATEGA_RETURN_URL else None
    failed_url = f"{PLATEGA_FAILED_URL}?payment_id={payment_id}" if PLATEGA_FAILED_URL else None
    try:
        tx = client.create_transaction(
            amount=float(charge),
            method=method_code,
            currency="RUB",
            description=description,
            return_url=return_url,
            failed_url=failed_url,
            payload=payment_id,
            user_id=str(user["telegram_id"]),
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


@app.get("/api/app/payment/status")
def app_payment_status(
    payment_id: str = Query(...), user: dict = Depends(_app_user_from_init)
) -> dict[str, Any]:
    payment = fulfillment.get_payment(payment_id)
    if not payment or int(payment["user_id"]) != int(user["id"]):
        raise HTTPException(404, detail={"message": "Платёж не найден"})

    # Если ещё в ожидании — активно опрашиваем провайдера (подстраховка на случай задержки callback).
    if payment["status"] == "pending":
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
        "subscription": sub,
    }



@app.post("/api/app/promocode/redeem")
def app_promo_redeem(body: RedeemPromoBody, user: dict = Depends(require_channel_dep)) -> dict[str, Any]:
    # Защита от перебора промокодов.
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
    """Итоговая скидка (промо/акция + бонус за опрос), либо {active: false}."""
    return effective_discount(int(user["id"]))


def mask_email(email: str) -> str:
    """user@gmail.com → u**er@gmail.com (маскируем локальную часть)."""
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
    """
    Данные приглашённого для мини-приложения: ник (или маскированная почта),
    буква-инициал для аватарки. Фото других пользователей Telegram недоступно,
    поэтому аватар рисуется по инициалу на клиенте.
    """
    username = (u.get("username") or "").lstrip("@")
    email = u.get("email")
    if username:
        name = f"@{username}"
    elif email:
        name = mask_email(str(email))
    elif u.get("telegram_id"):
        name = f"id{u.get('telegram_id')}"
    else:
        name = f"#{u.get('id')}"
    seed = (username or (str(email) if email else "") or str(u.get("telegram_id") or u.get("id") or "?"))
    initial = (seed.lstrip("@")[:1] or "?").upper()
    return {
        "id": u.get("id"),
        "username": username or None,
        "telegram_id": u.get("telegram_id"),
        "name": name,
        "initial": initial,
    }


@app.get("/api/app/referral")
def app_referral(user: dict = Depends(_app_user_from_init)) -> dict[str, Any]:
    fresh = get_user(int(user["id"]))
    assert fresh is not None
    refs = db.fetchall("SELECT * FROM users WHERE referred_by = ?", (fresh["id"],))
    return {
        "code": fresh.get("referral_code"),
        "link": f"https://t.me/{BOT_USERNAME}?start=ref_{fresh.get('referral_code')}",
        "is_partner": bool(fresh.get("is_partner")),
        "partner_balance": fresh.get("partner_balance", 0),
        "partner_rate": fresh.get("partner_rate", 25),
        "referrals_count": len(refs),
        "referrals": [_referral_display(u) for u in refs],
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
    # Ограничение частоты создания заявок на вывод.
    allowed, retry = ratelimit.rate_limit(f"withdraw:{user['id']}", 5, 600)
    if not allowed:
        raise HTTPException(429, detail={"message": f"Слишком часто. Повторите через {retry} сек."})
    try:
        w = services.request_withdrawal(int(user["id"]), body.amount, body.address)
    except services.ServiceError as exc:
        raise HTTPException(exc.status, detail={"message": exc.message})

    # Публикуем в форум «Выводы» и запоминаем message_id (чтобы удалить при одобрении).
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
    items = db.fetchall(
        "SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC",
        (user["id"],),
    )
    return {"items": [serialize_transaction(tx) for tx in items]}




@app.get("/api/app/plans")
def app_plans() -> dict[str, Any]:
    meta = get_plans_meta()
    return {
        "plans": get_active_plans(),
        "extra_device_price": meta["extra_device_price"],
        "default_devices": meta["default_included_devices"],
    }


@app.get("/api/app/legal")
def app_legal() -> dict[str, Any]:
    return {
        "offer": db.get_setting("offer_text", ""),
        "privacy": db.get_setting("privacy_text", ""),
    }


def _require_internal(secret: Optional[str]) -> None:
    """
    Доступ к внутренним service-to-service ручкам. Сравнение в постоянном времени.
    Fail-closed: если секрет не настроен, в проде доступ ЗАПРЕЩЁН (иначе кто угодно
    мог бы подтвердить свой платёж без оплаты).
    """
    if not INTERNAL_API_SECRET:
        if ENV == "production":
            raise HTTPException(403, detail="Forbidden")
        return
    if not secret or not hmac.compare_digest(str(secret), INTERNAL_API_SECRET):
        raise HTTPException(403, detail="Forbidden")


# ── Telegram webhook (режим Stars = webhook; по умолчанию используется polling) ──
@app.post("/api/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: Optional[str] = Header(None, alias="X-Telegram-Bot-Api-Secret-Token"),
) -> dict[str, Any]:
    # Подлинность апдейта — по секрет-токену, который мы задали в setWebhook.
    # Fail-closed: если секрет не настроен, в проде вебхук ЗАПРЕЩЁН (иначе кто
    # угодно мог бы прислать поддельный successful_payment и выдать себе подписку).
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
        # pre_checkout_query — подтвердить в течение 10 секунд.
        pcq = update.get("pre_checkout_query")
        if pcq:
            payment_id = pcq.get("invoice_payload") or ""
            payment = fulfillment.get_payment(payment_id) if payment_id else None
            ok = bool(payment) and payment.get("status") == "pending"
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
                    payment_id, stars_charge_id=charge_id, amount=sp.get("total_amount")
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


# Internal ping (bot / webhook ↔ api)
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


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "message" in detail:
        return JSONResponse(status_code=exc.status_code, content={"detail": detail, "error": detail.get("message")})
    if isinstance(detail, str):
        return JSONResponse(status_code=exc.status_code, content={"detail": detail, "error": detail})
    return JSONResponse(status_code=exc.status_code, content={"detail": detail})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("core:app", host="0.0.0.0", port=int(_env("API_PORT", "8000")), reload=ENV != "production")
