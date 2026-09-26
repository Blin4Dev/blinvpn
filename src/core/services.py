"""
Общие «чистые» операции над БД, нужные и API (core), и боту, и fulfillment.
Не зависят от FastAPI — только database.

Содержит:
  • активацию промокода-скидки (одноразово на пользователя, на 90 дней);
  • учёт переходов по трекинговым (специальным) ссылкам;
  • атрибуцию выручки трекинговым ссылкам при оплате.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import database as db  # type: ignore

PROMO_DISCOUNT_DAYS = 90

# Системные промокоды (персональные скидки от бота). Их нельзя ввести вручную:
# они хранятся с is_active = 0 и выдаются только кодом (grant_personal_discount).
SYSTEM_PROMO_CODES = {"DRIP10"}
MIN_WITHDRAW_RUB = 100.0
_TON_ADDR_RE = re.compile(r"^(?:UQ|EQ|0Q|kQ)[A-Za-z0-9_-]{46}$")


class ServiceError(Exception):
    """Ошибка бизнес-логики с человекочитаемым сообщением и HTTP-кодом."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ── Промокоды-скидки ─────────────────────────────────────────

def activate_promocode(user_id: int, code: str) -> dict[str, Any]:
    """
    Активирует промокод-скидку пользователю (одноразово). Бросает ServiceError.
    Возвращает {percent, expires_at, code, name}.
    """
    code = (code or "").upper().strip()
    if not code:
        raise ServiceError("Пустой промокод", 400)
    promo = db.fetchone("SELECT * FROM promocodes WHERE code = ?", (code,))
    if not promo or not promo.get("is_active") or code in SYSTEM_PROMO_CODES:
        raise ServiceError("Промокод не найден", 404)
    if promo.get("expires_at"):
        exp = _parse_iso(str(promo["expires_at"]))
        if exp and exp < _utcnow():
            raise ServiceError("Срок действия промокода истёк", 400)
    already = db.fetchone(
        "SELECT id FROM promocode_activations WHERE promocode_id = ? AND user_id = ?",
        (promo["id"], user_id),
    )
    if already:
        raise ServiceError("Промокод уже активирован", 400)

    percent = float(promo.get("value") or 0)
    expires_at = (_utcnow() + timedelta(days=PROMO_DISCOUNT_DAYS)).isoformat()

    # АТОМАРНО занимаем использование: условие uses_count < uses_limit в самом
    # UPDATE исключает гонку (иначе множество юзеров одновременно проходят
    # проверку до инкремента и лимит превышается).
    if promo.get("uses_limit") is not None:
        cur = db.execute(
            "UPDATE promocodes SET uses_count = uses_count + 1 "
            "WHERE id = ? AND uses_count < uses_limit",
            (promo["id"],),
        )
        if cur.rowcount == 0:
            raise ServiceError("Лимит использований исчерпан", 400)
    else:
        db.execute("UPDATE promocodes SET uses_count = uses_count + 1 WHERE id = ?", (promo["id"],))

    try:
        db.execute(
            "INSERT INTO promocode_activations (promocode_id, user_id, discount_percent, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (promo["id"], user_id, percent, expires_at, db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001 — гонка: уникальный индекс отсёк дубль
        # Возвращаем занятое использование обратно.
        db.execute("UPDATE promocodes SET uses_count = uses_count - 1 WHERE id = ?", (promo["id"],))
        raise ServiceError("Промокод уже активирован", 400)
    return {"percent": percent, "expires_at": expires_at, "code": code, "name": promo.get("name")}


def grant_personal_discount(user_id: int, percent: float, hours: int, code: str = "DRIP10") -> bool:
    """
    Выдаёт персональную временную скидку на `hours` часов (одноразово).
    Использует скрытый системный промокод. active_discount_for_user подхватит её.
    Возвращает True, если скидка была выдана (или уже действует).
    """
    promo = db.fetchone("SELECT * FROM promocodes WHERE code = ?", (code,))
    if not promo:
        db.execute(
            "INSERT INTO promocodes (code, name, type, value, uses_limit, uses_count, expires_at, is_active, created_at) "
            "VALUES (?, ?, 'discount', ?, NULL, 0, NULL, 0, ?)",
            (code, "Персональная скидка", float(percent), db.utcnow_iso()),
        )
        promo = db.fetchone("SELECT * FROM promocodes WHERE code = ?", (code,))
    if not promo:
        return False
    # Уже есть активация? Не дублируем.
    if db.fetchone(
        "SELECT id FROM promocode_activations WHERE promocode_id = ? AND user_id = ?",
        (promo["id"], user_id),
    ):
        return True
    expires_at = (_utcnow() + timedelta(hours=hours)).isoformat()
    try:
        db.execute(
            "INSERT INTO promocode_activations (promocode_id, user_id, discount_percent, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (promo["id"], user_id, float(percent), expires_at, db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001 — уже есть активация (гонка)
        return True
    db.execute("UPDATE promocodes SET uses_count = uses_count + 1 WHERE id = ?", (promo["id"],))
    return True


# ── Трекинговые (специальные) ссылки ─────────────────────────

def register_tracking_click(
    code: str,
    *,
    user_id: Optional[int],
    telegram_id: Optional[int],
    username: Optional[str] = None,
    full_name: Optional[str] = None,
    is_new_user: bool = False,
) -> Optional[dict[str, Any]]:
    """
    Регистрирует переход по трекинговой ссылке /start trk_<code>.
      • +1 к clicks всегда;
      • первый визит пользователя → +1 unique_users (и new_users, если он новый);
      • закрепляет за пользователем tracking_code (для атрибуции выручки);
      • автоактивирует промокод ссылки (если задан и ещё не активирован).
    Возвращает строку ссылки (dict) либо None, если код не найден/выключен.
    """
    code = (code or "").strip()
    if not code:
        return None
    link = db.fetchone("SELECT * FROM tracking_links WHERE code = ?", (code,))
    if not link or not link.get("is_active"):
        return None

    link_id = int(link["id"])
    now = db.utcnow_iso()
    db.execute("UPDATE tracking_links SET clicks = clicks + 1 WHERE id = ?", (link_id,))

    seen = None
    if user_id is not None:
        seen = db.fetchone(
            "SELECT id FROM tracking_link_users WHERE link_id = ? AND user_id = ?",
            (link_id, user_id),
        )
    if not seen:
        db.execute(
            "INSERT INTO tracking_link_users (link_id, user_id, telegram_id, username, full_name, "
            "is_new_user, visited_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (link_id, user_id, telegram_id, username, full_name, 1 if is_new_user else 0, now),
        )
        db.execute("UPDATE tracking_links SET unique_users = unique_users + 1 WHERE id = ?", (link_id,))
        if is_new_user:
            db.execute("UPDATE tracking_links SET new_users = new_users + 1 WHERE id = ?", (link_id,))

    # Закрепляем ссылку за пользователем (единожды) для учёта выручки.
    if user_id is not None:
        row = db.fetchone("SELECT tracking_code FROM users WHERE id = ?", (user_id,))
        if row is not None and not row.get("tracking_code"):
            db.execute("UPDATE users SET tracking_code = ? WHERE id = ?", (code, user_id))

    # Автоактивация промокода ссылки.
    if user_id is not None and link.get("promocode"):
        try:
            activate_promocode(user_id, str(link["promocode"]))
        except ServiceError:
            pass  # уже активирован / истёк — не мешаем онбордингу

    _recalc_conversion(link_id)
    return link


def credit_tracking_payment(user_id: int, amount: float) -> None:
    """При успешной оплате начисляет выручку трекинговой ссылке пользователя."""
    if amount is None or float(amount) <= 0:
        return
    row = db.fetchone("SELECT tracking_code FROM users WHERE id = ?", (user_id,))
    code = (row or {}).get("tracking_code")
    if not code:
        return
    link = db.fetchone("SELECT id FROM tracking_links WHERE code = ?", (code,))
    if not link:
        return
    link_id = int(link["id"])

    lu = db.fetchone(
        "SELECT id, has_paid FROM tracking_link_users WHERE link_id = ? AND user_id = ?",
        (link_id, user_id),
    )
    first_payment = not (lu and lu.get("has_paid"))
    db.execute(
        "UPDATE tracking_links SET total_revenue = total_revenue + ? WHERE id = ?",
        (float(amount), link_id),
    )
    if first_payment:
        db.execute("UPDATE tracking_links SET paid_users = paid_users + 1 WHERE id = ?", (link_id,))
    if lu:
        db.execute(
            "UPDATE tracking_link_users SET total_spent = total_spent + ?, has_paid = 1 WHERE id = ?",
            (float(amount), lu["id"]),
        )
    _recalc_conversion(link_id)


def _recalc_conversion(link_id: int) -> None:
    link = db.fetchone("SELECT unique_users, paid_users FROM tracking_links WHERE id = ?", (link_id,))
    if not link:
        return
    uniq = int(link.get("unique_users") or 0)
    paid = int(link.get("paid_users") or 0)
    rate = round((paid / uniq * 100.0), 2) if uniq else 0.0
    db.execute("UPDATE tracking_links SET conversion_rate = ? WHERE id = ?", (rate, link_id))


# ── Вывод реф. средств (USDT TON) ────────────────────────────

def valid_ton_address(address: str) -> bool:
    """
    Адрес для вывода: UQ…/EQ… (raw-friendly), либо домен *.ton / *.t.me.
    """
    a = (address or "").strip()
    if not a:
        return False
    low = a.lower()
    if low.endswith(".ton") or low.endswith(".t.me"):
        return len(a) >= 5
    return bool(_TON_ADDR_RE.match(a))


WITHDRAWAL_STATUSES = ("pending", "approved", "completed", "rejected")


def serialize_withdrawal(w: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": w.get("id"),
        "user_id": w.get("user_id"),
        "amount": float(w.get("amount") or 0),
        "address": w.get("address"),
        "method": w.get("method") or "usdt_ton",
        "status": w.get("status") or "pending",
        # Хэш транзакции (исторически колонка называется tx_link).
        "tx_hash": w.get("tx_link"),
        "tx_link": w.get("tx_link"),
        "reject_reason": w.get("reject_reason"),
        "refunded": bool(w.get("refunded")),
        "created_at": w.get("created_at"),
        "approved_at": w.get("approved_at"),
        "processed_at": w.get("processed_at"),
    }


def request_withdrawal(user_id: int, amount: float, address: str) -> dict[str, Any]:
    """
    Создаёт запрос на вывод и ЗАМОРАЖИВАЕТ сумму (списывает с partner_balance
    до решения администратора). Бросает ServiceError.
    """
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        raise ServiceError("Некорректная сумма", 400)
    amount = round(amount, 2)
    if amount < MIN_WITHDRAW_RUB:
        raise ServiceError(f"Минимальная сумма вывода — {int(MIN_WITHDRAW_RUB)}₽", 400)
    if not valid_ton_address(address):
        raise ServiceError("Неверный адрес. Нужен адрес USDT TON (UQ…/EQ…) или домен .ton / .t.me", 400)

    if not db.fetchone("SELECT id FROM users WHERE id = ?", (user_id,)):
        raise ServiceError("Пользователь не найден", 404)

    # Списание и заявка — одной транзакцией: либо оба шага, либо ни одного
    # (иначе при сбое на втором шаге деньги списались бы без заявки).
    # Условие partner_balance >= amount в самом UPDATE исключает двойной вывод.
    with db.transaction() as tx:
        cur = tx.execute(
            "UPDATE users SET partner_balance = partner_balance - ? WHERE id = ? AND partner_balance >= ?",
            (amount, user_id, amount),
        )
        if cur.rowcount == 0:
            raise ServiceError("Недостаточно средств на реферальном балансе", 400)
        ins = tx.execute(
            "INSERT INTO withdrawals (user_id, amount, address, method, status, created_at) "
            "VALUES (?, ?, ?, 'usdt_ton', 'pending', ?)",
            (user_id, amount, address.strip(), db.utcnow_iso()),
        )
        wid = ins.lastrowid
    return db.fetchone("SELECT * FROM withdrawals WHERE id = ?", (wid,))  # type: ignore[return-value]


def set_withdrawal_forum_ref(withdrawal_id: int, chat_id: Any, message_id: int) -> None:
    db.execute(
        "UPDATE withdrawals SET forum_chat_id = ?, forum_message_id = ? WHERE id = ?",
        (str(chat_id), int(message_id), withdrawal_id),
    )


def _get_withdrawal(withdrawal_id: int) -> dict[str, Any]:
    w = db.fetchone("SELECT * FROM withdrawals WHERE id = ?", (withdrawal_id,))
    if not w:
        raise ServiceError("Заявка не найдена", 404)
    return w


def approve_withdrawal(withdrawal_id: int) -> dict[str, Any]:
    """Шаг 1: заявка одобрена — админ видит адрес и делает перевод. Баланс уже заморожен."""
    _get_withdrawal(withdrawal_id)
    cur = db.execute(
        "UPDATE withdrawals SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'",
        (db.utcnow_iso(), withdrawal_id),
    )
    if cur.rowcount == 0:
        raise ServiceError("Заявку можно одобрить только в статусе «Ожидает»", 400)
    return _get_withdrawal(withdrawal_id)


def complete_withdrawal(withdrawal_id: int, tx_hash: str) -> dict[str, Any]:
    """Шаг 2: перевод сделан — сохраняем hash транзакции, статус «Завершено»."""
    _get_withdrawal(withdrawal_id)
    tx_hash = (tx_hash or "").strip()
    if not tx_hash:
        raise ServiceError("Укажите hash транзакции", 400)
    if len(tx_hash) > 300:
        raise ServiceError("Слишком длинный hash", 400)
    cur = db.execute(
        "UPDATE withdrawals SET status = 'completed', tx_link = ?, processed_at = ? "
        "WHERE id = ? AND status = 'approved'",
        (tx_hash, db.utcnow_iso(), withdrawal_id),
    )
    if cur.rowcount == 0:
        raise ServiceError("Завершить можно только одобренную заявку", 400)
    return _get_withdrawal(withdrawal_id)


def reject_withdrawal(withdrawal_id: int, reason: str = "", refund: bool = True) -> dict[str, Any]:
    """
    Отказ (из «Ожидает» или «Одобрен»). reason — причина, refund — вернуть ли
    замороженную сумму на реферальный баланс пользователя.
    """
    w = _get_withdrawal(withdrawal_id)
    reason = (reason or "").strip()[:500]
    # Смена статуса и возврат — одной транзакцией; возврат только если статус
    # сменили именно мы (защита от двойного возврата).
    with db.transaction() as tx:
        cur = tx.execute(
            "UPDATE withdrawals SET status = 'rejected', reject_reason = ?, refunded = ?, processed_at = ? "
            "WHERE id = ? AND status IN ('pending', 'approved')",
            (reason or None, 1 if refund else 0, db.utcnow_iso(), withdrawal_id),
        )
        if cur.rowcount == 0:
            raise ServiceError("Заявка уже обработана", 400)
        if refund:
            tx.execute(
                "UPDATE users SET partner_balance = partner_balance + ? WHERE id = ?",
                (float(w["amount"]), w["user_id"]),
            )
    return _get_withdrawal(withdrawal_id)


def reject_open_withdrawals_for_user(user_id: int, reason: str) -> list[dict[str, Any]]:
    """Отклоняет все незавершённые заявки пользователя с возвратом средств (при бане)."""
    rows = db.fetchall(
        "SELECT id FROM withdrawals WHERE user_id = ? AND status IN ('pending', 'approved')",
        (int(user_id),),
    )
    done: list[dict[str, Any]] = []
    for r in rows:
        try:
            done.append(reject_withdrawal(int(r["id"]), reason, refund=True))
        except ServiceError:
            pass
    return done
