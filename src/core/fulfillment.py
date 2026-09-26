"""
Единый модуль выдачи подписок и обработки платежей BlinVPN.

Используется ядром (core.py), вебхуком (webhook.py) и ботом (bot.py) —
одна точка правды для:
  • создания намерения оплаты (payments) + pending-транзакции;
  • идемпотентного подтверждения оплаты (fulfill_payment);
  • создания/продления подписки в локальной БД И в Remnawave;
  • начисления реферального бонуса и уведомления администратора.

Модуль НЕ импортирует core.py, чтобы не поднимать FastAPI в процессах
вебхука/бота и не ловить циклические импорты. Работает поверх database.py
и provisioning.py напрямую.
"""

from __future__ import annotations

import os
import secrets
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

try:
    from . import database as db  # type: ignore
except ImportError:
    import database as db  # type: ignore

try:
    from . import provisioning
except ImportError:
    import provisioning  # type: ignore

try:
    from . import services
except ImportError:
    import services  # type: ignore

try:
    from . import forum
except ImportError:
    import forum  # type: ignore


DAYS_PER_MONTH = 30

# Параметры подписок.
GB = 1024 ** 3
# Значения по умолчанию; реальные берутся из настроек панели (Настройки → Цены).
REGULAR_TRAFFIC_GB = 100    # обычная подписка, ГБ/мес
TRIAL_TRAFFIC_GB = 5        # пробная
TRIAL_DAYS = 3
TRIAL_DEVICES = 1


def _int_setting(key: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(float(db.get_setting(key, str(default)) or default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def trial_days() -> int:
    return _int_setting("trial_days", TRIAL_DAYS, 1, 365)


def trial_traffic_gb() -> int:
    """0 = без лимита."""
    return _int_setting("trial_traffic_gb", TRIAL_TRAFFIC_GB, 0, 100000)


def trial_devices() -> int:
    return _int_setting("trial_devices", TRIAL_DEVICES, 1, 20)


def paid_traffic_gb() -> int:
    """0 = без лимита."""
    return _int_setting("paid_traffic_gb", REGULAR_TRAFFIC_GB, 0, 100000)
# Через сколько дней после окончания неоплаченная подписка удаляется
# (из Remnawave и из активных подписок; в панели остаётся в истории).
DELETE_AFTER_DAYS = 7
RESET_STRATEGY = "MONTH"    # стратегия сброса трафика в Remnawave — «Ежемесячно»


# ─────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────

def _env(*keys: str, default: str = "") -> str:
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return default


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
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


def get_user(user_id: int) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM users WHERE id = ?", (user_id,))


def vpn_squads() -> list[str]:
    return db.loads(db.get_setting("squad_mapping_vpn", "[]"), []) or []


def trial_squads() -> list[str]:
    return db.loads(db.get_setting("squad_mapping_trial", "[]"), []) or vpn_squads()


def compute_user_state(user_id: int) -> str:
    """
    Состояние пользователя по его подпискам (единое для панели и статистики):
      Banned  — аккаунт заблокирован;
      Active  — есть действующая платная подписка;
      Trial   — есть действующая пробная (и нет платной);
      Expired — подписки были, но действующих нет;
      None    — подписок не было никогда.
    """
    u = db.fetchone("SELECT is_banned FROM users WHERE id = ?", (user_id,))
    if not u:
        return "None"
    if u.get("is_banned"):
        return "Banned"
    now = db.utcnow_iso()
    row = db.fetchone(
        "SELECT COUNT(*) AS total, "
        "MAX(CASE WHEN status = 'Active' AND type != 'trial' AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS paid_now, "
        "MAX(CASE WHEN status = 'Active' AND type = 'trial' AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS trial_now "
        "FROM subscriptions WHERE user_id = ?",
        (now, now, user_id),
    ) or {}
    if not int(row.get("total") or 0):
        return "None"
    if int(row.get("paid_now") or 0):
        return "Active"
    if int(row.get("trial_now") or 0):
        return "Trial"
    return "Expired"


def _sync_user_status(user_id: int) -> None:
    state = compute_user_state(user_id)
    if state == "Banned":
        return
    db.execute("UPDATE users SET status = ? WHERE id = ?", (state, user_id))


# ─────────────────────────────────────────────────────────────
# payment intents
# ─────────────────────────────────────────────────────────────

def create_payment_intent(
    *,
    user_id: int,
    provider: str,
    method: str,
    amount: float,
    currency: str = "RUB",
    stars: Optional[int] = None,
    purpose: str = "subscription",
    plan_devices: Optional[int] = None,
    months: int = 1,
    extra_devices: int = 0,
    subscription_id: Optional[int] = None,
    payment_id: Optional[str] = None,
    referral_applied: float = 0.0,
) -> dict[str, Any]:
    pid = payment_id or secrets.token_hex(12)
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO payments (payment_id, user_id, provider, method, amount, currency, stars, "
        "status, purpose, plan_devices, months, extra_devices, subscription_id, referral_applied, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
        (
            pid, int(user_id), provider, method, float(amount), currency,
            int(stars) if stars is not None else None,
            purpose, plan_devices, int(months or 1), int(extra_devices or 0),
            subscription_id, round(float(referral_applied or 0), 2), now,
        ),
    )
    # Ожидающая транзакция в общей ленте (payment_id связывает её с платежом).
    db.execute(
        "INSERT INTO transactions (user_id, amount, status, payment_method, hash, payment_id, description, created_at) "
        "VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
        (int(user_id), float(amount), method, pid, pid, f"{purpose} · {provider}", now),
    )
    return get_payment(pid)  # type: ignore[return-value]


def get_payment(payment_id: str) -> Optional[dict[str, Any]]:
    return db.fetchone("SELECT * FROM payments WHERE payment_id = ?", (payment_id,))


def get_payment_by_provider_id(provider_payment_id: str) -> Optional[dict[str, Any]]:
    return db.fetchone(
        "SELECT * FROM payments WHERE provider_payment_id = ?", (provider_payment_id,)
    )


def set_provider_data(
    payment_id: str,
    *,
    provider_payment_id: Optional[str] = None,
    pay_url: Optional[str] = None,
    invoice_link: Optional[str] = None,
) -> None:
    sets, params = [], []
    if provider_payment_id is not None:
        sets.append("provider_payment_id = ?")
        params.append(provider_payment_id)
    if pay_url is not None:
        sets.append("pay_url = ?")
        params.append(pay_url)
    if invoice_link is not None:
        sets.append("invoice_link = ?")
        params.append(invoice_link)
    if not sets:
        return
    params.append(payment_id)
    db.execute(f"UPDATE payments SET {', '.join(sets)} WHERE payment_id = ?", params)


def _release_referral_hold(payment: dict[str, Any]) -> None:
    """Возвращает замороженный при создании реферальный баланс (при отмене/сбое)."""
    try:
        applied = float(payment.get("referral_applied") or 0)
    except (TypeError, ValueError):
        applied = 0
    if applied <= 0:
        return
    try:
        db.execute(
            "UPDATE users SET partner_balance = partner_balance + ? WHERE id = ?",
            (round(applied, 2), int(payment["user_id"])),
        )
        # Чтобы повторная отмена/сбой не вернули баланс дважды.
        db.execute("UPDATE payments SET referral_applied = 0 WHERE payment_id = ?", (payment["payment_id"],))
    except Exception:  # noqa: BLE001
        pass


def mark_failed(payment_id: str, reason: str = "") -> None:
    payment = get_payment(payment_id)
    cur = db.execute(
        "UPDATE payments SET status = 'failed', error = ? WHERE payment_id = ? AND status IN ('pending', 'processing')",
        (reason[:500], payment_id),
    )
    db.execute(
        "UPDATE transactions SET status = 'failed' WHERE payment_id = ? AND status = 'pending'",
        (payment_id,),
    )
    # Разморозить реферальный баланс только если это МЫ перевели платёж в failed.
    if payment and cur.rowcount:
        _release_referral_hold(payment)


def _expected_provider_amount(payment: dict[str, Any]) -> float:
    """Сумма, которую должен подтвердить провайдер: рубли (Platega) или звёзды (Stars)."""
    if payment.get("provider") == "tg_stars":
        return float(payment.get("stars") or 0)
    return float(payment.get("amount") or 0)


def _grant_traffic_reset(user: dict[str, Any]) -> dict[str, Any]:
    """Досрочный сброс трафика (платная услуга): Remnawave + локальные счётчики."""
    res = provisioning.reset_traffic(int(user.get("telegram_id") or 0), user.get("email"))
    try:
        db.execute(
            "UPDATE subscriptions SET traffic_used = 0 WHERE user_id = ? AND status != 'Banned'",
            (int(user["id"]),),
        )
    except Exception:  # noqa: BLE001
        pass
    # активная подписка пользователя (для привязки в ответе)
    sub = db.fetchone(
        "SELECT id FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1", (int(user["id"]),))
    return {
        "subscription_id": sub["id"] if sub else None,
        "traffic_reset": bool(res.get("ok")),
        "remnawave": {"ok": bool(res.get("ok")), "error": res.get("error")},
    }


# ─────────────────────────────────────────────────────────────
# granting subscriptions (DB + Remnawave)
# ─────────────────────────────────────────────────────────────

def _create_subscription_row(
    *,
    user: dict[str, Any],
    devices: int,
    expire_at: datetime,
    provision: dict[str, Any],
    traffic_gb: int = REGULAR_TRAFFIC_GB,
    sub_type: str = "vpn",
    squads: Optional[list[str]] = None,
) -> dict[str, Any]:
    key_uuid = str(_uuid.uuid4())
    short = provision.get("short_uuid") or key_uuid.split("-")[0]
    rw_id = provision.get("rw_id") or str(_uuid.uuid4())
    key_config = provision.get("subscription_url") or provisioning.local_fallback_config(short)
    now = db.utcnow_iso()
    db.execute(
        "INSERT INTO subscriptions (user_id, rw_id, key_uuid, short_uuid, key_config, status, expires_at, "
        "devices_limit, devices_used, traffic_used, traffic_limit, custom_name, type, squads_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, 0, 0, ?, NULL, ?, ?, ?)",
        (
            int(user["id"]), rw_id, key_uuid, short, key_config, iso(expire_at),
            int(max(1, devices)), int(traffic_gb), sub_type,
            db.dumps(squads if squads is not None else vpn_squads()), now,
        ),
    )
    sub = db.fetchone("SELECT * FROM subscriptions WHERE id = ?", (db.last_id(),))
    _sync_user_status(int(user["id"]))
    # Ставим пользователя в очередь на опрос (приглашение уйдёт через 1ч после
    # первого подключения к VPN). Только один раз — user_id PRIMARY KEY.
    try:
        if user.get("telegram_id"):
            db.execute(
                "INSERT OR IGNORE INTO survey_invites (user_id, telegram_id, enrolled_at) "
                "VALUES (?, ?, ?)",
                (int(user["id"]), int(user["telegram_id"]), now),
            )
    except Exception:  # noqa: BLE001
        pass
    assert sub is not None
    return sub


def grant_trial(user: dict[str, Any]) -> dict[str, Any]:
    """
    Выдаёт бесплатную пробную подписку (срок/трафик/устройства — из настроек
    панели, по умолчанию 3 дня, 5 ГБ, 1 устройство), сброс «Ежемесячно».
    Вызывающий обязан проверить, что триал ещё не использовался и что он включён.
    """
    telegram_id = int(user["telegram_id"])
    t_days, t_gb, t_dev = trial_days(), trial_traffic_gb(), trial_devices()
    new_exp = utcnow() + timedelta(days=t_days)
    prov = provisioning.provision(
        user_id=int(user["id"]), telegram_id=telegram_id, username=user.get("username"), expire_at=new_exp,
        devices=t_dev, squads=trial_squads(), email=user.get("email"),
        traffic_limit_bytes=t_gb * GB, traffic_reset_strategy=RESET_STRATEGY,
    )
    sub = _create_subscription_row(
        user=user, devices=t_dev, expire_at=new_exp, provision=prov,
        traffic_gb=t_gb, sub_type="trial", squads=trial_squads(),
    )
    # Ставим отметку для проверки «подключился ли» через 15 минут (только для триала).
    try:
        db.execute(
            "INSERT INTO trial_checks (subscription_id, user_id, telegram_id, granted_at, checked) "
            "VALUES (?, ?, ?, ?, 0)",
            (sub["id"], int(user["id"]), telegram_id, db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001
        pass
    return {
        "subscription_id": sub["id"],
        "expires_at": sub.get("expires_at"),
        "devices": t_dev,
        "traffic_gb": t_gb,
        "remnawave": prov,
    }


def _apply_provision_to_sub(sub: dict[str, Any], provision: dict[str, Any]) -> None:
    """Записать данные Remnawave в существующую подписку (при продлении)."""
    if not provision.get("ok"):
        return
    sets, params = [], []
    if provision.get("rw_id"):
        sets.append("rw_id = ?")
        params.append(provision["rw_id"])
    if provision.get("short_uuid"):
        sets.append("short_uuid = ?")
        params.append(provision["short_uuid"])
    if provision.get("subscription_url"):
        sets.append("key_config = ?")
        params.append(provision["subscription_url"])
    if not sets:
        return
    params.append(sub["id"])
    db.execute(f"UPDATE subscriptions SET {', '.join(sets)} WHERE id = ?", params)


def find_extend_target(
    user_id: int, purpose: str, subscription_id: Optional[int]
) -> tuple[Optional[dict[str, Any]], bool]:
    """
    Определяет, какую подписку продлит grant_subscription (и апгрейд ли это триала).
    Вынесено отдельно, чтобы цена в панели/эндпоинте совпадала с фактической выдачей.
    Возвращает (target, upgrading_trial).
    """
    target: Optional[dict[str, Any]] = None
    if purpose == "extend" and subscription_id:
        target = db.fetchone(
            "SELECT * FROM subscriptions WHERE id = ? AND user_id = ? AND status != 'Deleted'",
            (subscription_id, user_id),
        )
    if target is None:
        target = db.fetchone(
            "SELECT * FROM subscriptions WHERE user_id = ? AND status != 'Deleted' AND type != 'trial' "
            "ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at DESC, id DESC LIMIT 1",
            (user_id,),
        )
    if target is None:
        target = db.fetchone(
            "SELECT * FROM subscriptions WHERE user_id = ? AND status != 'Deleted' AND type = 'trial' "
            "ORDER BY id DESC LIMIT 1",
            (user_id,),
        )
        return target, target is not None
    return target, False


def retained_devices(user_id: int, purpose: str, subscription_id: Optional[int],
                     total_devices: int) -> int:
    """
    Сколько устройств сверх оплаченного тарифа СОХРАНИТСЯ при продлении (grant берёт
    max со старым лимитом). За них надо доплатить, иначе можно продлить 5-устройств
    по цене 1. 0 — для апгрейда триала и новых подписок.
    """
    target, upgrading_trial = find_extend_target(user_id, purpose, subscription_id)
    if not target or upgrading_trial:
        return 0
    current = int(target.get("devices_limit") or 1)
    return max(0, current - int(total_devices))


def grant_subscription(
    *,
    user: dict[str, Any],
    purpose: str,
    plan_devices: Optional[int],
    months: int,
    extra_devices: int,
    subscription_id: Optional[int],
) -> dict[str, Any]:
    """
    Создаёт или продлевает подписку в БД и Remnawave.
    Возвращает {subscription_id, expires_at, devices, remnawave: {...}}.
    """
    months = max(1, int(months or 1))
    added_days = DAYS_PER_MONTH * months
    telegram_id = int(user["telegram_id"])
    username = user.get("username")
    email = user.get("email")

    if purpose == "devices" and subscription_id:
        # Увеличение числа устройств у конкретной подписки (без изменения срока).
        sub = db.fetchone(
            "SELECT * FROM subscriptions WHERE id = ? AND user_id = ?",
            (subscription_id, user["id"]),
        )
        if not sub:
            raise ValueError("subscription_not_found")
        new_devices = int(sub.get("devices_limit") or 1) + max(1, int(extra_devices or 1))
        expire_dt = parse_iso(sub.get("expires_at")) or (utcnow() + timedelta(days=added_days))
        prov = provisioning.provision(
            user_id=int(user["id"]), telegram_id=telegram_id, username=username, expire_at=expire_dt,
            devices=new_devices, squads=vpn_squads(), email=email,
        )
        db.execute(
            "UPDATE subscriptions SET devices_limit = ? WHERE id = ?",
            (new_devices, sub["id"]),
        )
        _apply_provision_to_sub(sub, prov)
        return {
            "subscription_id": sub["id"],
            "expires_at": sub.get("expires_at"),
            "devices": new_devices,
            "remnawave": prov,
        }

    # Найти целевую подписку для продления (та же логика, что и в ценообразовании).
    target, upgrading_trial = find_extend_target(int(user["id"]), purpose, subscription_id)

    total_devices = int(plan_devices or 1) + max(0, int(extra_devices or 0))

    if target:
        base = parse_iso(target.get("expires_at")) or utcnow()
        if base < utcnow():
            base = utcnow()
        new_exp = base + timedelta(days=added_days)
        # При апгрейде с триала HWID берём именно оплаченный (а не max со старым=1).
        new_devices = total_devices if upgrading_trial else max(int(target.get("devices_limit") or 1), total_devices)
        new_devices = max(1, new_devices)
        prov = provisioning.provision(
            user_id=int(user["id"]), telegram_id=telegram_id, username=username, expire_at=new_exp,
            devices=new_devices, squads=vpn_squads(), email=email,
            traffic_limit_bytes=paid_traffic_gb() * GB, traffic_reset_strategy=RESET_STRATEGY,
            reset_traffic=upgrading_trial,  # триал→платная: сбрасываем накопленный трафик
        )
        db.execute(
            "UPDATE subscriptions SET expires_at = ?, status = 'Active', devices_limit = ?, "
            "traffic_limit = ?, traffic_used = CASE WHEN ? THEN 0 ELSE traffic_used END, "
            "type = 'vpn', squads_json = ? WHERE id = ?",
            (iso(new_exp), new_devices, paid_traffic_gb(), 1 if upgrading_trial else 0,
             db.dumps(vpn_squads()), target["id"]),
        )
        _apply_provision_to_sub(target, prov)
        _sync_user_status(int(user["id"]))
        return {
            "subscription_id": target["id"],
            "expires_at": iso(new_exp),
            "devices": new_devices,
            "remnawave": prov,
        }

    # Новая подписка (нет ни платной, ни триала).
    new_exp = utcnow() + timedelta(days=added_days)
    prov = provisioning.provision(
        user_id=int(user["id"]), telegram_id=telegram_id, username=username, expire_at=new_exp,
        devices=max(1, total_devices), squads=vpn_squads(), email=email,
        traffic_limit_bytes=paid_traffic_gb() * GB, traffic_reset_strategy=RESET_STRATEGY,
    )
    sub = _create_subscription_row(
        user=user, devices=max(1, total_devices), expire_at=new_exp, provision=prov,
        traffic_gb=paid_traffic_gb(), sub_type="vpn",
    )
    return {
        "subscription_id": sub["id"],
        "expires_at": sub.get("expires_at"),
        "devices": int(sub.get("devices_limit") or total_devices),
        "remnawave": prov,
    }


# ─────────────────────────────────────────────────────────────
# fulfillment (idempotent)
# ─────────────────────────────────────────────────────────────

def fulfill_payment(
    payment_id: str,
    *,
    provider_payment_id: Optional[str] = None,
    amount: Optional[float] = None,
    stars_charge_id: Optional[str] = None,
) -> dict[str, Any]:
    """
    Идемпотентно подтверждает платёж и выдаёт подписку.
    Повторный вызов для уже оплаченного платежа безопасен.
    """
    payment = get_payment(payment_id)
    if not payment:
        return {"ok": False, "error": "payment_not_found", "payment_id": payment_id}

    if payment["status"] == "paid":
        return {"ok": True, "already": True, "payment_id": payment_id,
                "subscription_id": payment.get("subscription_id")}

    if payment["status"] in ("failed", "refunded"):
        return {"ok": False, "error": "payment_failed", "payment_id": payment_id}

    # Проверка суммы: провайдер должен подтвердить не меньше ожидаемого, иначе
    # недоплатой можно было бы получить полную подписку.
    expected = _expected_provider_amount(payment)
    if amount is not None and expected > 0:
        try:
            paid = float(amount)
        except (TypeError, ValueError):
            paid = 0.0
        if paid + 0.01 < expected:
            mark_failed(payment_id, f"amount_mismatch: paid {paid} < expected {expected}")
            try:
                forum.report_error(
                    "Недоплата по платежу — подписка НЕ выдана",
                    f"payment_id={payment_id}, оплачено {paid}, ожидалось {expected}",
                )
            except Exception:  # noqa: BLE001
                pass
            return {"ok": False, "error": "amount_mismatch", "payment_id": payment_id}

    # АТОМАРНО «занимаем» платёж: только один вызов переведёт pending→processing.
    # Исключает двойную выдачу подписки при гонке (callback + поллинг + ретраи).
    claim = db.execute(
        "UPDATE payments SET status = 'processing', processing_at = ? WHERE payment_id = ? AND status = 'pending'",
        (db.utcnow_iso(), payment_id),
    )
    if claim.rowcount == 0:
        fresh = get_payment(payment_id)
        st = (fresh or {}).get("status")
        if st == "paid":
            return {"ok": True, "already": True, "payment_id": payment_id,
                    "subscription_id": (fresh or {}).get("subscription_id")}
        # Кто-то уже обрабатывает (processing) либо платёж failed/refunded.
        return {"ok": False, "error": "already_processing", "payment_id": payment_id}

    user = get_user(int(payment["user_id"]))
    if not user:
        mark_failed(payment_id, "user_not_found")
        return {"ok": False, "error": "user_not_found", "payment_id": payment_id}

    _purpose = payment.get("purpose") or "subscription"
    try:
        if _purpose == "traffic_reset":
            grant = _grant_traffic_reset(user)
        else:
            grant = grant_subscription(
                user=user,
                purpose=_purpose,
                plan_devices=payment.get("plan_devices"),
                months=int(payment.get("months") or 1),
                extra_devices=int(payment.get("extra_devices") or 0),
                subscription_id=payment.get("subscription_id"),
            )
    except Exception as exc:  # noqa: BLE001
        # Выдача не удалась — возвращаем платёж в pending, чтобы повтор/поллинг
        # смог обработать заново (реферальный холд не трогаем).
        db.execute(
            "UPDATE payments SET status = 'pending' WHERE payment_id = ? AND status = 'processing'",
            (payment_id,),
        )
        try:
            forum.report_error("Ошибка выдачи подписки после оплаты",
                               f"payment_id={payment_id}: {type(exc).__name__}: {exc}")
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": "grant_failed", "payment_id": payment_id}

    now = db.utcnow_iso()
    db.execute(
        "UPDATE payments SET status = 'paid', paid_at = ?, subscription_id = ?, "
        "provider_payment_id = COALESCE(?, provider_payment_id) "
        "WHERE payment_id = ? AND status = 'processing'",
        (now, grant.get("subscription_id"), provider_payment_id or stars_charge_id, payment_id),
    )
    db.execute(
        "UPDATE transactions SET status = 'completed' WHERE payment_id = ?",
        (payment_id,),
    )

    _credit_referral(user, float(payment.get("amount") or 0), payment.get("currency") or "RUB")
    # Атрибуция выручки трекинговой (специальной) ссылке, если пользователь по ней пришёл.
    try:
        services.credit_tracking_payment(int(user["id"]), float(payment.get("amount") or 0))
    except Exception:  # noqa: BLE001
        pass

    # Платёж прошёл, но подписка в Remnawave не выдалась → пользователь получит
    # нерабочий ключ. Оплата НЕ отменяется, но админ должен узнать немедленно.
    # Для досрочного сброса трафика это уведомление не шлём.
    rw = grant.get("remnawave") or {}
    if _purpose != "traffic_reset" and not rw.get("ok"):
        try:
            forum.report_error(
                "Оплата прошла, но подписка в Remnawave НЕ выдана",
                f"payment_id={payment_id}, user id{user.get('id')}, ошибка: {rw.get('error')}",
            )
        except Exception:  # noqa: BLE001
            pass

    _notify_admin(user, payment, grant)


    return {
        "ok": True,
        "payment_id": payment_id,
        "subscription_id": grant.get("subscription_id"),
        "expires_at": grant.get("expires_at"),
        "remnawave_ok": bool((grant.get("remnawave") or {}).get("ok")),
    }


def platega_tx_amount(tx: dict[str, Any]) -> Optional[float]:
    """Сумма из ответа Platega GET /transaction/{id}: она лежит в paymentDetails.amount."""
    details = tx.get("paymentDetails") if isinstance(tx.get("paymentDetails"), dict) else {}
    for val in (details.get("amount"), tx.get("amount")):
        try:
            if val is not None:
                return float(val)
        except (TypeError, ValueError):
            continue
    return None


def platega_tx_matches(tx: dict[str, Any], payment: dict[str, Any]) -> bool:
    """Транзакция Platega действительно создана под этот платёж (payload = наш payment_id)."""
    tx_payload = tx.get("payload")
    return not tx_payload or str(tx_payload) == str(payment["payment_id"])


def confirm_via_provider(payment_id: str) -> dict[str, Any]:
    """
    Активная проверка статуса у провайдера (для поллинга страницы ожидания),
    когда callback ещё не пришёл. Работает только для Platega.
    """
    payment = get_payment(payment_id)
    if not payment:
        return {"ok": False, "status": "not_found"}
    if payment["status"] == "paid":
        return {"ok": True, "status": "paid", "subscription_id": payment.get("subscription_id")}
    if payment["status"] == "failed":
        return {"ok": False, "status": "failed"}
    if payment.get("provider") != "platega" or not payment.get("provider_payment_id"):
        return {"ok": True, "status": "pending"}

    try:
        import platega  # type: ignore
        client = platega.get_client()
        if not client.is_configured():
            return {"ok": True, "status": "pending"}
        tx = client.get_transaction(str(payment["provider_payment_id"]))
        if not platega_tx_matches(tx, payment):
            return {"ok": False, "status": "pending", "note": "payload_mismatch"}
        norm = platega.PlategaClient.normalize_status(tx.get("status"))
        if norm == "paid":
            res = fulfill_payment(
                payment_id,
                provider_payment_id=str(payment["provider_payment_id"]),
                amount=platega_tx_amount(tx),
            )
            return {"ok": res.get("ok", False), "status": "paid" if res.get("ok") else "pending",
                    "subscription_id": res.get("subscription_id")}
        if norm == "failed":
            mark_failed(payment_id, "provider_canceled")
            return {"ok": False, "status": "failed"}
        return {"ok": True, "status": "pending"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "status": "pending", "note": f"{type(exc).__name__}"}


# ─────────────────────────────────────────────────────────────
# Фоновая сверка платежей
# ─────────────────────────────────────────────────────────────

STUCK_PROCESSING_MIN = 10       # «processing» дольше — процесс упал посреди выдачи
RECHECK_AFTER_MIN = 3           # перепроверять у Platega не раньше чем через 3 мин
UNPAID_EXPIRE_HOURS = 24        # неоплаченный платёж через сутки отменяется
RECONCILE_BATCH = 50


def reconcile_payments(log=print) -> dict[str, int]:
    """
    1) Зависшие в processing (упал процесс) → снова pending.
    2) Ожидающие платежи Platega — спрашиваем статус у Platega (callback мог потеряться,
       а окно оплаты пользователь закрыл).
    3) Неоплаченные дольше суток — отменяем (реферальный баланс размораживается).
    """
    now = utcnow()
    stats = {"unstuck": 0, "confirmed": 0, "expired": 0}

    stuck_before = iso(now - timedelta(minutes=STUCK_PROCESSING_MIN))
    cur = db.execute(
        "UPDATE payments SET status = 'pending' WHERE status = 'processing' "
        "AND (processing_at IS NULL OR processing_at < ?)",
        (stuck_before,),
    )
    stats["unstuck"] = cur.rowcount or 0

    recheck_before = iso(now - timedelta(minutes=RECHECK_AFTER_MIN))
    rows = db.fetchall(
        "SELECT payment_id FROM payments WHERE status = 'pending' AND provider = 'platega' "
        "AND provider_payment_id IS NOT NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?",
        (recheck_before, RECONCILE_BATCH),
    )
    for r in rows:
        try:
            res = confirm_via_provider(str(r["payment_id"]))
            if res.get("status") == "paid" and res.get("ok"):
                stats["confirmed"] += 1
        except Exception:  # noqa: BLE001
            pass

    expire_before = iso(now - timedelta(hours=UNPAID_EXPIRE_HOURS))
    for r in db.fetchall(
        "SELECT payment_id FROM payments WHERE status = 'pending' AND created_at < ? LIMIT ?",
        (expire_before, RECONCILE_BATCH),
    ):
        mark_failed(str(r["payment_id"]), "expired_unpaid")
        stats["expired"] += 1

    if any(stats.values()):
        log(f"[payments] сверка: {stats}")
    return stats


# ─────────────────────────────────────────────────────────────
# referral bonus + notifications
# ─────────────────────────────────────────────────────────────

def _credit_referral(user: dict[str, Any], amount: float, currency: str) -> None:
    try:
        ref_by = user.get("referred_by")
        if not ref_by or amount <= 0 or currency not in ("RUB",):
            return
        referrer = get_user(int(ref_by))
        if not referrer:
            return
        rate = float(referrer.get("partner_rate") or 25)
        bonus = round(amount * rate / 100.0, 2)
        if bonus <= 0:
            return
        db.execute(
            "UPDATE users SET partner_balance = partner_balance + ? WHERE id = ?",
            (bonus, referrer["id"]),
        )
        db.execute(
            "INSERT INTO transactions (user_id, amount, status, payment_method, hash, payment_id, description, created_at) "
            "VALUES (?, ?, 'completed', 'referral', ?, ?, ?, ?)",
            (referrer["id"], bonus, secrets.token_hex(8), secrets.token_hex(8),
             f"referral bonus from user {user['id']}", db.utcnow_iso()),
        )
    except Exception:  # noqa: BLE001
        pass


def _notify_admin(user: dict[str, Any], payment: dict[str, Any], grant: dict[str, Any]) -> None:
    """Уведомление о покупке → топик «Покупки»."""
    is_stars = payment.get("provider") == "tg_stars"
    if is_stars:
        amount = payment.get("stars") or payment.get("amount")
        currency = " ⭐"
        method = "tg_stars"
    else:
        amount = payment.get("amount")
        currency = "₽"
        method = payment.get("method") or "sbp"
    try:
        forum.notify_purchase(user, _fmt_amount(amount), method, currency=currency)
    except Exception:  # noqa: BLE001
        pass


def _fmt_amount(v: Any) -> str:
    try:
        f = float(v)
        return str(int(f)) if f == int(f) else f"{f:.2f}"
    except (TypeError, ValueError):
        return str(v)
