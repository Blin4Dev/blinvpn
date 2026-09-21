"""
BlinVPN — SQLite database.

Хранит пользователей, подписки, транзакции, промокоды, рассылки,
тарифы, оферту/политику и прочие сущности панели и мини-приложения.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

DB_PATH = os.getenv("DB_PATH", "data/data.db")

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def get_db_path() -> str:
    return DB_PATH


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dir() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    """Thread-local SQLite connection."""
    global _initialized
    conn: Optional[sqlite3.Connection] = getattr(_local, "conn", None)
    if conn is None:
        _ensure_dir()
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        # Под нагрузкой два параллельных писателя не должны падать с "database is
        # locked": ждём освобождения до 5 секунд (важно, напр., для атомарной
        # заморозки баланса при выводе — сериализация записи + WHERE-условие).
        conn.execute("PRAGMA busy_timeout = 5000")
        _local.conn = conn
    if not _initialized:
        with _init_lock:
            if not _initialized:
                _create_schema(conn)
                _migrate(conn)
                _seed_defaults(conn)
                _initialized = True
    return conn


def init_db() -> None:
    connect()


def close() -> None:
    global _initialized
    conn: Optional[sqlite3.Connection] = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None
    _initialized = False


@contextmanager
def cursor() -> Iterator[sqlite3.Cursor]:
    conn = connect()
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def execute(sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
    conn = connect()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur
    except Exception:
        # На ошибке (например IntegrityError по уникальному индексу промокодов)
        # обязательно откатываем: иначе на соединении остаётся открытая
        # транзакция, удерживающая блокировку → соседние писатели получат
        # "database is locked".
        conn.rollback()
        raise


def executemany(sql: str, seq: list) -> None:
    conn = connect()
    try:
        conn.executemany(sql, seq)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def fetchone(sql: str, params: tuple | list = ()) -> Optional[dict[str, Any]]:
    row = connect().execute(sql, params).fetchone()
    return dict(row) if row else None


def fetchall(sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    rows = connect().execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def last_id() -> int:
    row = connect().execute("SELECT last_insert_rowid() AS id").fetchone()
    return int(row["id"]) if row else 0


def row_to_dict(row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    return dict(row) if row else None


# ─────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    balance REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Trial',
    is_banned INTEGER NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by INTEGER,
    is_partner INTEGER NOT NULL DEFAULT 0,
    partner_balance REAL NOT NULL DEFAULT 0,
    partner_rate REAL NOT NULL DEFAULT 25,
    autopay_enabled INTEGER NOT NULL DEFAULT 0,
    autopay_method TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    rw_id TEXT,
    key_uuid TEXT,
    short_uuid TEXT,
    key_config TEXT,
    status TEXT NOT NULL DEFAULT 'Active',
    expires_at TEXT,
    devices_limit INTEGER NOT NULL DEFAULT 1,
    devices_used INTEGER NOT NULL DEFAULT 0,
    traffic_used INTEGER NOT NULL DEFAULT 0,
    traffic_limit INTEGER NOT NULL DEFAULT 0,
    custom_name TEXT,
    type TEXT NOT NULL DEFAULT 'vpn',
    squads_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT,
    hash TEXT,
    payment_id TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'platega',
    method TEXT,
    provider_payment_id TEXT,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'RUB',
    stars INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    purpose TEXT NOT NULL DEFAULT 'subscription',
    plan_devices INTEGER,
    months INTEGER NOT NULL DEFAULT 1,
    extra_devices INTEGER NOT NULL DEFAULT 0,
    subscription_id INTEGER,
    pay_url TEXT,
    invoice_link TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS promocodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT,
    type TEXT NOT NULL DEFAULT 'discount',
    value REAL NOT NULL DEFAULT 0,
    uses_limit INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promocode_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promocode_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (promocode_id) REFERENCES promocodes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mailings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    message_text TEXT NOT NULL,
    target_users TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'Completed',
    sent_count INTEGER NOT NULL DEFAULT 0,
    button_type TEXT,
    button_value TEXT,
    image_url TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0,
    min_amount REAL,
    max_amount REAL,
    uses_limit INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracking_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    promocode TEXT,
    welcome_message TEXT,
    url TEXT,
    clicks INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    unique_users INTEGER NOT NULL DEFAULT 0,
    new_users INTEGER NOT NULL DEFAULT 0,
    total_revenue REAL NOT NULL DEFAULT 0,
    paid_users INTEGER NOT NULL DEFAULT 0,
    active_subscriptions INTEGER NOT NULL DEFAULT 0,
    total_keys INTEGER NOT NULL DEFAULT 0,
    conversion_rate REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracking_link_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    user_id INTEGER,
    telegram_id INTEGER,
    username TEXT,
    full_name TEXT,
    is_new_user INTEGER NOT NULL DEFAULT 1,
    visited_at TEXT NOT NULL,
    trial_used INTEGER NOT NULL DEFAULT 0,
    total_spent REAL NOT NULL DEFAULT 0,
    keys_count INTEGER NOT NULL DEFAULT 0,
    active_keys INTEGER NOT NULL DEFAULT 0,
    has_paid INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (link_id) REFERENCES tracking_links(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    address TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'usdt_ton',
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
    tx_link TEXT,
    forum_chat_id TEXT,
    forum_message_id INTEGER,
    created_at TEXT NOT NULL,
    processed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Ожидание ссылки на транзакцию от админа после нажатия «Одобрить» в форуме.
CREATE TABLE IF NOT EXISTS pending_tx_input (
    admin_chat_id INTEGER PRIMARY KEY,
    withdrawal_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

-- Rate-limiting (фиксированное окно).
CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start REAL NOT NULL DEFAULT 0
);

-- Онбординг-цепочка (напоминания тем, кто запустил бота, но не купил).
CREATE TABLE IF NOT EXISTS onboarding_reminders (
    user_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (user_id, stage),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trial_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    telegram_id INTEGER,
    granted_at TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0
);

-- Опрос: список на приглашение (через 1ч после первого подключения к VPN).
CREATE TABLE IF NOT EXISTS survey_invites (
    user_id INTEGER PRIMARY KEY,
    telegram_id INTEGER,
    enrolled_at TEXT NOT NULL,
    connected_at TEXT,
    invited INTEGER NOT NULL DEFAULT 0,
    invited_at TEXT,
    gave_up INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Опрос: прогресс прохождения (шаг, накопленные ответы).
CREATE TABLE IF NOT EXISTS survey_state (
    user_id INTEGER PRIMARY KEY,
    telegram_id INTEGER,
    step INTEGER NOT NULL DEFAULT 0,
    answers_json TEXT NOT NULL DEFAULT '{}',
    await_text INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Опрос: финальные ответы (нормализованно — одна строка на выбранный вариант).
CREATE TABLE IF NOT EXISTS survey_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question INTEGER NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_survey_answers_q ON survey_answers(question);
CREATE INDEX IF NOT EXISTS idx_survey_answers_user ON survey_answers(user_id);

CREATE TABLE IF NOT EXISTS squads (
    squad_uuid TEXT PRIMARY KEY,
    squad_name TEXT NOT NULL,
    squad_type TEXT NOT NULL DEFAULT 'vpn',
    max_users INTEGER NOT NULL DEFAULT 0,
    current_users INTEGER NOT NULL DEFAULT 0,
    inbounds_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    devices INTEGER NOT NULL UNIQUE,
    price_rub REAL NOT NULL,
    price_stars REAL NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    plaintext_once TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    expires_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS app_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_codes (
    email TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS temp_2fa (
    token TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    username TEXT NOT NULL,
    expires_at REAL NOT NULL
);

-- Отметки об отправленных напоминаниях об окончании подписки.
-- stage: '3d' | '2d' | '1d' | 'expired'. cycle_expires_at — то значение
-- expires_at, для которого отправлено напоминание: при продлении подписки оно
-- меняется, и напоминания рассылаются заново для нового срока.
CREATE TABLE IF NOT EXISTS sub_reminders (
    subscription_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    cycle_expires_at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (subscription_id, stage),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_tg ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_expiry ON subscriptions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_code ON promocodes(code);
CREATE INDEX IF NOT EXISTS idx_payments_pid ON payments(payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_pid ON payments(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
"""


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r["name"] for r in rows}


def _migrate(conn: sqlite3.Connection) -> None:
    """Лёгкие миграции для существующих БД: добавляем недостающие колонки."""
    add_columns = {
        "promocodes": {
            "name": "ALTER TABLE promocodes ADD COLUMN name TEXT",
        },
        "promocode_activations": {
            "discount_percent": "ALTER TABLE promocode_activations ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0",
            "expires_at": "ALTER TABLE promocode_activations ADD COLUMN expires_at TEXT",
        },
        "users": {
            "tracking_code": "ALTER TABLE users ADD COLUMN tracking_code TEXT",
            "first_start_at": "ALTER TABLE users ADD COLUMN first_start_at TEXT",
            # Кэш проверки обязательной подписки на канал (Telegram-вход).
            "channel_ok": "ALTER TABLE users ADD COLUMN channel_ok INTEGER NOT NULL DEFAULT 0",
            "channel_checked_at": "ALTER TABLE users ADD COLUMN channel_checked_at TEXT",
        },
        "mailings": {
            "channel": "ALTER TABLE mailings ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'",
        },
        "payments": {
            # Сколько списано с реферального баланса (заморожено при создании).
            "referral_applied": "ALTER TABLE payments ADD COLUMN referral_applied REAL NOT NULL DEFAULT 0",
            # Возвраты (Platega cancel).
            "refunded_at": "ALTER TABLE payments ADD COLUMN refunded_at TEXT",
            "refund_info": "ALTER TABLE payments ADD COLUMN refund_info TEXT",
        },
        "withdrawals": {
            "forum_chat_id": "ALTER TABLE withdrawals ADD COLUMN forum_chat_id TEXT",
            "forum_message_id": "ALTER TABLE withdrawals ADD COLUMN forum_message_id INTEGER",
        },
        "subscriptions": {
            # Заморозка подписки (пауза отсчёта дней).
            "frozen_at": "ALTER TABLE subscriptions ADD COLUMN frozen_at TEXT",
            "frozen_remaining": "ALTER TABLE subscriptions ADD COLUMN frozen_remaining INTEGER",
            # Когда последний раз замораживали (для лимита «не чаще раза в сутки»).
            "last_freeze_at": "ALTER TABLE subscriptions ADD COLUMN last_freeze_at TEXT",
        },
    }
    for table, cols in add_columns.items():
        try:
            existing = _column_names(conn, table)
        except sqlite3.Error:
            continue
        for col, ddl in cols.items():
            if col not in existing:
                try:
                    conn.execute(ddl)
                except sqlite3.Error:
                    pass
    # Одна активация промокода на пользователя (защита от гонки/дублей):
    # сначала убираем возможные дубли, затем ставим уникальный индекс.
    try:
        conn.execute(
            "DELETE FROM promocode_activations WHERE id NOT IN "
            "(SELECT MIN(id) FROM promocode_activations GROUP BY promocode_id, user_id)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_act_unique "
            "ON promocode_activations(promocode_id, user_id)"
        )
    except sqlite3.Error:
        pass
    # Защита от повторной обработки одного и того же платежа провайдера
    # (реплей callback на другой локальный payment): уникальный provider_payment_id.
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_pid "
            "ON payments(provider_payment_id) WHERE provider_payment_id IS NOT NULL"
        )
    except sqlite3.Error:
        pass
    conn.commit()


DEFAULT_OFFER = """Публичная оферта BlinVPN

1. Общие положения
Настоящий документ является официальным предложением (офертой) на оказание услуг VPN.

2. Предмет договора
Исполнитель предоставляет Заказчику доступ к сервису BlinVPN на условиях выбранного тарифа.

3. Оплата
Услуги оплачиваются по тарифам, указанным в мини-приложении. Момент оплаты — момент зачисления средств.

4. Ответственность
Сервис предоставляется «как есть». Запрещено использовать VPN для противоправной деятельности.

5. Контакты
По вопросам: поддержка BlinVPN.
"""

DEFAULT_PRIVACY = """Политика конфиденциальности BlinVPN

1. Какие данные мы собираем
Telegram ID, username, email (если указан), данные об оплатах и подписке.

2. Как используем
Для предоставления VPN-услуги, поддержки и улучшения сервиса.

3. Передача третьим лицам
Данные платёжных провайдеров передаются только для обработки платежей.

4. Хранение
Данные хранятся на защищённых серверах в течение срока использования сервиса.

5. Контакты
По вопросам персональных данных: поддержка BlinVPN.
"""


def _seed_defaults(conn: sqlite3.Connection) -> None:
    defaults = {
        "offer_text": DEFAULT_OFFER,
        "privacy_text": DEFAULT_PRIVACY,
        "extra_device_price": "40",
        "default_included_devices": "2",
        "backup_enabled": "0",
        "backup_interval_hours": "12",
        "backup_last": "",
        "squad_mapping_vpn": "[]",
        "squad_mapping_trial": "[]",
        # Цена досрочного сброса трафика (₽). 0 = функция выключена.
        "traffic_reset_price": "0",
        # Анти-абуз (сканирование HWID/IP из Remnawave). 1 = включён.
        "antiabuse_enabled": "1",
    }
    for k, v in defaults.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (k, v),
        )

    plan_count = conn.execute("SELECT COUNT(*) AS c FROM plans").fetchone()["c"]
    if plan_count == 0:
        plans = [
            (1, 99, 99, 1, 1),
            (2, 169, 169, 1, 2),
            (3, 229, 229, 1, 3),
            (5, 349, 349, 1, 4),
        ]
        conn.executemany(
            "INSERT INTO plans (devices, price_rub, price_stars, is_active, sort_order) VALUES (?, ?, ?, ?, ?)",
            plans,
        )
    conn.commit()


# ─────────────────────────────────────────────────────────────
# Settings helpers
# ─────────────────────────────────────────────────────────────

def get_setting(key: str, default: str = "") -> str:
    row = fetchone("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def get_settings(keys: list[str]) -> dict[str, str]:
    if not keys:
        return {}
    placeholders = ",".join("?" * len(keys))
    rows = fetchall(f"SELECT key, value FROM settings WHERE key IN ({placeholders})", keys)
    return {r["key"]: r["value"] for r in rows}


# ─────────────────────────────────────────────────────────────
# JSON helpers
# ─────────────────────────────────────────────────────────────

def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def loads(raw: Optional[str], default: Any = None) -> Any:
    if not raw:
        return default if default is not None else None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default if default is not None else None
