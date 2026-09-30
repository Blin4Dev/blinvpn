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


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """
    Несколько запросов одной транзакцией (всё или ничего):

        with db.transaction() as tx:
            tx.execute(...)
            tx.execute(...)

    BEGIN IMMEDIATE сразу берёт блокировку на запись — параллельный писатель
    подождёт (busy_timeout), а не прочитает промежуточное состояние.
    Внутри блока нельзя вызывать db.execute() — он коммитит сам.
    """
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
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

-- ── Служба поддержки (support.py) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    assigned_admin TEXT,                 -- кто нажал «Начать»
    started_at TEXT,
    last_message_at TEXT,
    last_preview TEXT,
    last_sender TEXT,
    unread_admin INTEGER NOT NULL DEFAULT 0,
    unread_user INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_support_chats_last ON support_chats(last_message_at);
CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender TEXT NOT NULL,                -- user | admin | system
    author TEXT,                         -- логин админа
    text TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES support_chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_support_messages_chat ON support_messages(chat_id, id);
-- Обращения (тикеты) внутри переписки: открывает пользователь, закрывает админ
CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    number INTEGER NOT NULL,             -- №1, №2… в пределах переписки
    status TEXT NOT NULL DEFAULT 'open', -- open | closed
    opened_by TEXT,                      -- user | admin
    opened_at TEXT NOT NULL,
    assigned_admin TEXT,
    closed_at TEXT,
    closed_by TEXT,
    FOREIGN KEY (chat_id) REFERENCES support_chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_chat ON support_tickets(chat_id, id);
CREATE TABLE IF NOT EXISTS support_files (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    message_id INTEGER,                  -- NULL — загружен, но ещё не отправлен
    uploader TEXT NOT NULL,              -- user | admin
    uploader_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- image | video | file (по содержимому)
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_files_msg ON support_files(message_id);

-- ── Сотрудники панели (роли и доступы) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS panel_staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,       -- логин (нижний регистр)
    name TEXT,                           -- имя для показа («Анна»)
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    telegram_id INTEGER NOT NULL,        -- куда приходит код 2FA
    permissions TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    last_login_at TEXT,
    last_login_ip TEXT
);
-- График работы сотрудника: один день (по Москве) = интервалы работы (перерывы
-- делят день на части) и оплата за день. Нет строки — выходной.
CREATE TABLE IF NOT EXISTS staff_days (
    staff_id INTEGER NOT NULL,
    day TEXT NOT NULL,                   -- YYYY-MM-DD (Москва)
    intervals TEXT NOT NULL,             -- JSON [["10:00","14:00"],["15:00","19:00"]]
    pay REAL NOT NULL DEFAULT 0,         -- ₽ за день
    updated_at TEXT,
    PRIMARY KEY (staff_id, day),
    FOREIGN KEY (staff_id) REFERENCES panel_staff(id) ON DELETE CASCADE
);
-- Штрафы (выдают владелец и кураторы) и выплаты зарплаты (отмечает владелец)
CREATE TABLE IF NOT EXISTS staff_fines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    reason TEXT NOT NULL,
    issued_by TEXT NOT NULL,             -- owner | staff:<id>
    issued_name TEXT,
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    cancelled_by TEXT,
    FOREIGN KEY (staff_id) REFERENCES panel_staff(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_staff_fines ON staff_fines(staff_id, id);
-- Премии (начисляет только владелец); отменённая премия в баланс не идёт
CREATE TABLE IF NOT EXISTS staff_bonuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    reason TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    issued_name TEXT,
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    cancelled_by TEXT,
    FOREIGN KEY (staff_id) REFERENCES panel_staff(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_staff_bonuses ON staff_bonuses(staff_id, id);
CREATE TABLE IF NOT EXISTS staff_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    paid_on TEXT NOT NULL,               -- YYYY-MM-DD
    created_at TEXT NOT NULL,
    FOREIGN KEY (staff_id) REFERENCES panel_staff(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_staff_payouts ON staff_payouts(staff_id, id);
-- Push-подписки браузеров панели (Web Push)
-- Общий чат сотрудников панели (владелец, кураторы, операторы)
CREATE TABLE IF NOT EXISTS team_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,                 -- owner | staff:<id>
    author_name TEXT,
    author_role TEXT,                    -- owner | curator | operator
    text TEXT NOT NULL,
    reply_to INTEGER,
    created_at TEXT NOT NULL,
    deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS team_reads (
    actor TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0
);
-- Журнал модерации пользователя: блокировки/разблокировки аккаунта и подписок,
-- предупреждения и баны анти-абуза, чарджбеки. Не очищается при разблокировке.
CREATE TABLE IF NOT EXISTS moderation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    sub_id INTEGER,
    kind TEXT NOT NULL,        -- ban | unban | key_block | key_unblock | aa_warn | aa_ban | blacklist
    reason TEXT,
    details TEXT,              -- JSON
    actor TEXT,                -- owner | staff:<id> | antiabuse | blacklist | system
    actor_name TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_user ON moderation_events(user_id, id);
-- HWID устройств, подключавшихся к пробным подпискам (анти-абуз пробного периода)
CREATE TABLE IF NOT EXISTS trial_hwids (
    hwid TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (hwid, user_id)
);
CREATE INDEX IF NOT EXISTS idx_trial_hwids_user ON trial_hwids(user_id);
-- Кого уже банили за пробные по HWID: после разбана вручную повторно не баним
CREATE TABLE IF NOT EXISTS trial_hwid_bans (
    user_id INTEGER PRIMARY KEY,
    hwid TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,                 -- owner | staff:<id>
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_ok_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subs_actor ON push_subs(actor);
-- Кто уже брал пробный период (по Telegram ID, навсегда): смена Telegram у
-- аккаунта и объединение аккаунтов не дают взять пробный ещё раз
CREATE TABLE IF NOT EXISTS trial_claims (
    telegram_id INTEGER PRIMARY KEY,
    user_id INTEGER,
    claimed_at TEXT NOT NULL
);
-- Журнал действий в панели (кто, что, когда)
CREATE TABLE IF NOT EXISTS panel_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,                 -- owner | staff:<id> | anon
    actor_name TEXT,
    action TEXT NOT NULL,                -- «POST /api/panel/…» или login_ok / login_fail …
    status INTEGER,
    ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_panel_audit_ts ON panel_audit(ts);
CREATE INDEX IF NOT EXISTS idx_panel_audit_actor ON panel_audit(actor, id);

-- Отправленные сообщения рассылки: нужны, чтобы удалить их у пользователей.
CREATE TABLE IF NOT EXISTS mailing_messages (
    mailing_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailing_messages_m ON mailing_messages(mailing_id);

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
-- Общий чёрный список Telegram ID (скачивается из BLACKLIST_URL, см. blacklist.py)
CREATE TABLE IF NOT EXISTS blacklist (
    telegram_id INTEGER PRIMARY KEY,
    reason TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sub_reminders (
    subscription_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    cycle_expires_at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (subscription_id, stage),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

-- ── Мониторинг серверов (агент blinmon, см. node.sh / monitoring.py) ──────────
CREATE TABLE IF NOT EXISTS mon_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 5055,
    secret_enc TEXT NOT NULL,              -- ключ агента, зашифрован (MONITOR_SECRET_KEY)
    enabled INTEGER NOT NULL DEFAULT 0,    -- 0 — ещё не запущен / остановлен
    created_at TEXT NOT NULL,
    started_at TEXT,
    last_seen TEXT,                        -- последний успешный ответ агента
    last_error TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    agent_version TEXT,
    boot_id TEXT,
    cursor INTEGER NOT NULL DEFAULT 0,
    speed_cursor INTEGER NOT NULL DEFAULT 0,
    uptime INTEGER,
    cores INTEGER,
    live_json TEXT,
    speed_running INTEGER NOT NULL DEFAULT 0,
    vless_enc TEXT,                        -- VLESS-ключ для проверки, зашифрован
    vless_ok INTEGER,
    vless_checked_at TEXT,
    vless_fail_count INTEGER NOT NULL DEFAULT 0,
    vless_error TEXT,
    pay_date TEXT,
    pay_url TEXT,
    pay_notified TEXT                      -- какие напоминания уже отправлены для pay_date
);

CREATE TABLE IF NOT EXISTS mon_metrics (
    node_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL, cpu_max REAL,
    ram_used INTEGER, ram_total INTEGER,
    disk_used INTEGER, disk_total INTEGER,
    disk_read INTEGER, disk_write INTEGER,
    net_rx INTEGER, net_tx INTEGER,
    load1 REAL,
    PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mon_pings (
    node_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    sent INTEGER NOT NULL,
    lost INTEGER NOT NULL,
    rtt_ms REAL,
    agent_ok INTEGER,
    PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mon_speed (
    node_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    down REAL, up REAL, ping_ms REAL,
    manual INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mon_vless (
    node_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    ms REAL,
    error TEXT,
    PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mon_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,               -- critical | warning | info
    title TEXT NOT NULL,
    details TEXT,
    started_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mon_inc_node ON mon_incidents(node_id, started_at);
CREATE INDEX IF NOT EXISTS idx_mon_inc_open ON mon_incidents(node_id, kind, resolved_at);

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
            # Когда пользователь принял оферту и политику конфиденциальности (при первом входе).
            "terms_accepted_at": "ALTER TABLE users ADD COLUMN terms_accepted_at TEXT",
            "first_start_at": "ALTER TABLE users ADD COLUMN first_start_at TEXT",
            # Кэш проверки обязательной подписки на канал (Telegram-вход).
            "channel_ok": "ALTER TABLE users ADD COLUMN channel_ok INTEGER NOT NULL DEFAULT 0",
            "channel_checked_at": "ALTER TABLE users ADD COLUMN channel_checked_at TEXT",
            # Причина блокировки (например, «Чёрный список: Шаринг»).
            "ban_reason": "ALTER TABLE users ADD COLUMN ban_reason TEXT",
            "banned_at": "ALTER TABLE users ADD COLUMN banned_at TEXT",
            # Админ разблокировал вручную — чёрный список больше не трогает.
            "blacklist_ignored": "ALTER TABLE users ADD COLUMN blacklist_ignored INTEGER NOT NULL DEFAULT 0",
        },
        "mailings": {
            "channel": "ALTER TABLE mailings ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'",
        },
        "support_chats": {
            "open_ticket_id": "ALTER TABLE support_chats ADD COLUMN open_ticket_id INTEGER",
            "last_email_at": "ALTER TABLE support_chats ADD COLUMN last_email_at TEXT",
            "assigned_name": "ALTER TABLE support_chats ADD COLUMN assigned_name TEXT",
        },
        "support_tickets": {
            # Кто ведёт обращение: 'owner' | 'staff:<id>' (assigned_admin) и имя для показа
            "assigned_name": "ALTER TABLE support_tickets ADD COLUMN assigned_name TEXT",
            # Активный вопрос «Могу ли я ещё чем-то помочь?» (id сообщения) и когда задан
            "close_prompt_id": "ALTER TABLE support_tickets ADD COLUMN close_prompt_id INTEGER",
            "prompt_at": "ALTER TABLE support_tickets ADD COLUMN prompt_at TEXT",
            # Передано админу (куратору/владельцу): в очереди «Админу», а не в общем пуле
            "escalated": "ALTER TABLE support_tickets ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0",
            "escalate_note": "ALTER TABLE support_tickets ADD COLUMN escalate_note TEXT",
            # Порядок в списке: старые сверху; ответ поддержки отправляет обращение вниз
            "queue_at": "ALTER TABLE support_tickets ADD COLUMN queue_at TEXT",
        },
        "panel_staff": {
            "role": "ALTER TABLE panel_staff ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'",  # curator | operator
        },
        "panel_sessions": {
            # NULL — владелец панели, иначе id сотрудника (panel_staff)
            "staff_id": "ALTER TABLE panel_sessions ADD COLUMN staff_id INTEGER",
            "created_at": "ALTER TABLE panel_sessions ADD COLUMN created_at REAL",
        },
        "temp_2fa": {
            "staff_id": "ALTER TABLE temp_2fa ADD COLUMN staff_id INTEGER",
        },
        "support_files": {
            "storage": "ALTER TABLE support_files ADD COLUMN storage TEXT NOT NULL DEFAULT 'local'",  # local | s3
            "deleted_at": "ALTER TABLE support_files ADD COLUMN deleted_at TEXT",  # удалён при заполнении хранилища
        },
        "support_messages": {
            "ticket_id": "ALTER TABLE support_messages ADD COLUMN ticket_id INTEGER",
            "reply_to": "ALTER TABLE support_messages ADD COLUMN reply_to INTEGER",
            "kind": "ALTER TABLE support_messages ADD COLUMN kind TEXT",  # NULL | close_prompt
            # Служебная пометка только для панели («вернул в пул», «передал админу») — пользователь не видит
            "internal": "ALTER TABLE support_messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0",
            # Кто из сотрудников написал (owner | staff:<id>) — править/удалять можно только своё
            "author_actor": "ALTER TABLE support_messages ADD COLUMN author_actor TEXT",
            "edited_at": "ALTER TABLE support_messages ADD COLUMN edited_at TEXT",
            "deleted_at": "ALTER TABLE support_messages ADD COLUMN deleted_at TEXT",
            # id уведомления в Telegram — чтобы поправить/удалить его вместе с сообщением
            "tg_msg_id": "ALTER TABLE support_messages ADD COLUMN tg_msg_id INTEGER",
            # Как служебное событие выглядит в панели («Анна подключилась»); '' — не показывать
            "panel_text": "ALTER TABLE support_messages ADD COLUMN panel_text TEXT",
        },
        "team_messages": {
            "edited_at": "ALTER TABLE team_messages ADD COLUMN edited_at TEXT",
        },
        "mon_incidents": {
            # Одна авария = один инцидент: активные условия и хронология (JSON).
            "state": "ALTER TABLE mon_incidents ADD COLUMN state TEXT",
            "timeline": "ALTER TABLE mon_incidents ADD COLUMN timeline TEXT",
        },
        "mon_nodes": {
            # Когда сервер перезагрузили из панели — недолгий простой не считаем аварией.
            "reboot_at": "ALTER TABLE mon_nodes ADD COLUMN reboot_at TEXT",
            # «Запустить» — с этого момента пытаемся достучаться до агента (статус «Подключение…»).
            "connect_since": "ALTER TABLE mon_nodes ADD COLUMN connect_since TEXT",
            # Автообновление агента: что и когда просили поставить, итог от агента.
            "update_target": "ALTER TABLE mon_nodes ADD COLUMN update_target TEXT",
            "update_requested_at": "ALTER TABLE mon_nodes ADD COLUMN update_requested_at TEXT",
            "update_state": "ALTER TABLE mon_nodes ADD COLUMN update_state TEXT",
            "allow_reboot": "ALTER TABLE mon_nodes ADD COLUMN allow_reboot INTEGER",
        },
        "payments": {
            # Сколько списано с реферального баланса (заморожено при создании).
            "referral_applied": "ALTER TABLE payments ADD COLUMN referral_applied REAL NOT NULL DEFAULT 0",
            # Возвраты (Platega cancel).
            "refunded_at": "ALTER TABLE payments ADD COLUMN refunded_at TEXT",
            "refund_info": "ALTER TABLE payments ADD COLUMN refund_info TEXT",
            # Когда платёж «занят» на выдачу — для восстановления после падения процесса.
            "processing_at": "ALTER TABLE payments ADD COLUMN processing_at TEXT",
            # Куда вернуть пользователя после оплаты и видел ли он результат
            # (чтобы после закрытия/перезагрузки приложения показать «Оплата прошла»).
            "return_to": "ALTER TABLE payments ADD COLUMN return_to TEXT",
            # Чарджбек: банк вернул деньги по спору → в панели «Чарджбек» откатывает
            # последствия платежа (без возврата денег). reported — Platega сообщила о споре.
            "chargeback_at": "ALTER TABLE payments ADD COLUMN chargeback_at TEXT",
            "chargeback_info": "ALTER TABLE payments ADD COLUMN chargeback_info TEXT",
            "chargeback_reported_at": "ALTER TABLE payments ADD COLUMN chargeback_reported_at TEXT",
            "result_seen_at": "ALTER TABLE payments ADD COLUMN result_seen_at TEXT",
            # Что именно выдал платёж (для частичной отмены при возврате).
            "grant_info": "ALTER TABLE payments ADD COLUMN grant_info TEXT",
        },
        "withdrawals": {
            "forum_chat_id": "ALTER TABLE withdrawals ADD COLUMN forum_chat_id TEXT",
            "forum_message_id": "ALTER TABLE withdrawals ADD COLUMN forum_message_id INTEGER",
            # Новый процесс: pending → approved (адрес показан админу) → completed (hash)
            # либо rejected (с причиной и выбором: вернуть на баланс или нет).
            "approved_at": "ALTER TABLE withdrawals ADD COLUMN approved_at TEXT",
            "reject_reason": "ALTER TABLE withdrawals ADD COLUMN reject_reason TEXT",
            "refunded": "ALTER TABLE withdrawals ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0",
        },
        "subscriptions": {
            # Заморозка подписки (пауза отсчёта дней).
            "frozen_at": "ALTER TABLE subscriptions ADD COLUMN frozen_at TEXT",
            "frozen_remaining": "ALTER TABLE subscriptions ADD COLUMN frozen_remaining INTEGER",
            # Когда последний раз замораживали (для лимита «не чаще раза в сутки»).
            "last_freeze_at": "ALTER TABLE subscriptions ADD COLUMN last_freeze_at TEXT",
            # Неоплаченная подписка удаляется через 7 дней после окончания:
            # строка остаётся для истории в панели со статусом 'Deleted'.
            "deleted_at": "ALTER TABLE subscriptions ADD COLUMN deleted_at TEXT",
            # Запрет продления (ставит админ): подписку нельзя продлить, после
            # окончания она сразу удаляется. Докупка устройств/сброс трафика — можно.
            "no_renew": "ALTER TABLE subscriptions ADD COLUMN no_renew INTEGER NOT NULL DEFAULT 0",
            # Анти-абуз: когда выдано предупреждение (первое нарушение не банит).
            "aa_warned_at": "ALTER TABLE subscriptions ADD COLUMN aa_warned_at TEXT",
            # Почему и когда заблокирована подписка (анти-абуз / вручную).
            "ban_reason": "ALTER TABLE subscriptions ADD COLUMN ban_reason TEXT",
            "banned_at": "ALTER TABLE subscriptions ADD COLUMN banned_at TEXT",
            # Grace-доступ после окончания: для какого срока (expires_at) выдан
            # и до какого момента действует (NULL — сейчас не действует).
            "grace_cycle": "ALTER TABLE subscriptions ADD COLUMN grace_cycle TEXT",
            "grace_until": "ALTER TABLE subscriptions ADD COLUMN grace_until TEXT",
            # Как аккаунт Remnawave выглядел до grace — это и показываем в панели и приложении
            "grace_snapshot": "ALTER TABLE subscriptions ADD COLUMN grace_snapshot TEXT",
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
    # Токены сессий теперь хранятся хэшами. Старые (открытым текстом) удаляем
    # один раз: веб-пользователи и админ просто войдут заново.
    try:
        done = conn.execute("SELECT value FROM settings WHERE key = 'sessions_hashed'").fetchone()
        if done is None:
            for t in ("app_sessions", "panel_sessions", "temp_2fa"):
                conn.execute(f"DELETE FROM {t}")
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sessions_hashed', '1')")
    except sqlite3.Error:
        pass
    # Системный промокод персональной скидки (DRIP10) раньше создавался активным —
    # его мог ввести кто угодно и получить скидку на 90 дней. Прячем его и снимаем
    # такие «ручные» активации (настоящая персональная скидка живёт ≤ 2 суток).
    try:
        row = conn.execute("SELECT id FROM promocodes WHERE code = 'DRIP10'").fetchone()
        if row is not None:
            conn.execute("UPDATE promocodes SET is_active = 0 WHERE id = ?", (row["id"],))
            conn.execute(
                "DELETE FROM promocode_activations WHERE promocode_id = ? "
                "AND julianday(expires_at) - julianday(created_at) > 2",
                (row["id"],),
            )
    except sqlite3.Error:
        pass
    # Раньше «кто ведёт обращение» хранился логином админа. Теперь — ключ
    # 'owner' | 'staff:<id>'; старые записи принадлежат владельцу панели.
    try:
        for t in ("support_tickets", "support_chats"):
            conn.execute(f"UPDATE {t} SET assigned_admin = 'owner', assigned_name = COALESCE(assigned_name, 'Администратор') "
                         f"WHERE assigned_admin IS NOT NULL AND assigned_admin != 'owner' AND assigned_admin NOT LIKE 'staff:%'")
    except sqlite3.Error:
        pass
    # Роли «разделы/уровни» заменены на «куратор / оператор»: полный доступ к
    # поддержке раньше = куратор, остальные — операторы. Один раз.
    try:
        done = conn.execute("SELECT value FROM settings WHERE key = 'staff_roles_v2'").fetchone()
        if done is None:
            for r in conn.execute("SELECT id, permissions FROM panel_staff").fetchall():
                try:
                    perms = json.loads(r["permissions"] or "{}")
                except ValueError:
                    perms = {}
                role = "curator" if perms.get("support") == "full" else "operator"
                conn.execute("UPDATE panel_staff SET role = ? WHERE id = ?", (role, r["id"]))
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('staff_roles_v2', '1')")
    except sqlite3.Error:
        pass
    # Имя и фамилия из Telegram больше не хранятся (не нужны сервису) — стираем один раз.
    try:
        done = conn.execute("SELECT value FROM settings WHERE key = 'names_wiped'").fetchone()
        if done is None:
            conn.execute("UPDATE users SET first_name = NULL, last_name = NULL")
            try:
                conn.execute("UPDATE tracking_link_users SET full_name = NULL")
            except sqlite3.Error:
                pass
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('names_wiped', '1')")
    except sqlite3.Error:
        pass
    # С этого момента реф. бонус хранит «за какой платёж» (hash = pay:<id>). Для более
    # старых платежей при откате бонус считается по ставке.
    try:
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('ref_hash_since', ?)", (utcnow_iso(),))
    except sqlite3.Error:
        pass
    try:
        conn.execute("INSERT OR IGNORE INTO trial_claims (telegram_id, user_id, claimed_at) "
                     "SELECT u.telegram_id, u.id, COALESCE(MIN(s.created_at), CURRENT_TIMESTAMP) FROM subscriptions s "
                     "JOIN users u ON u.id = s.user_id WHERE s.type = 'trial' AND u.telegram_id IS NOT NULL GROUP BY u.telegram_id")
    except sqlite3.Error:
        pass
    try:
        conn.execute("UPDATE support_tickets SET queue_at = opened_at WHERE queue_at IS NULL")
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
        # Цена подписки на 1 устройство (₽/мес). Каждое следующее — extra_device_price.
        "base_price": "99",
        # Пробная подписка
        "trial_days": "3",
        "trial_traffic_gb": "5",
        "trial_devices": "1",
        # Трафик платной подписки, ГБ/мес
        "paid_traffic_gb": "100",
        "backup_enabled": "0",
        "backup_interval_hours": "12",
        "backup_last": "",
        "squad_mapping_vpn": "[]",
        "squad_mapping_trial": "[]",
        # Цена досрочного сброса трафика (₽). 0 = функция выключена.
        "traffic_reset_price": "0",
        # Анти-абуз (сканирование HWID/IP из Remnawave). 1 = включён.
        "antiabuse_enabled": "1",
        # Grace-доступ: после окончания подписки до её удаления работает резервный
        # сквад (обычно один сервер) с небольшим лимитом трафика. 0 = выключен.
        "grace_enabled": "0",
        "grace_squads": "[]",
        "grace_traffic_gb": "1",
        "grace_trial": "0",
    }
    # Переход на модель «базовая цена + доп. устройство»: для существующей БД
    # базовой ценой становится цена старого тарифа на 1 устройство.
    try:
        old_one = conn.execute("SELECT price_rub FROM plans WHERE devices = 1").fetchone()
        if old_one is not None:
            defaults["base_price"] = str(int(float(old_one["price_rub"])) if float(old_one["price_rub"]).is_integer() else float(old_one["price_rub"]))
    except sqlite3.Error:
        pass
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
