"""
Чеки самозанятого в «Мой налог» (lknpd.nalog.ru) через библиотеку NaloGO (pip install nalogo).

Только для оплат через ЮKassa: после выдачи подписки платёж попадает в очередь nalogo_receipts,
фоновая задача регистрирует доход и сохраняет номер чека. При возврате или чарджбеке чек
аннулируется с причиной «Возврат средств». Другие платёжки сюда не попадают.

Настройки — в панели: Платежи → ЮKassa → «Чеки самозанятого» (ИНН и пароль от «Мой налог»).
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import threading
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

try:
    from . import database as db  # type: ignore
except ImportError:  # pragma: no cover
    import database as db  # type: ignore

PROVIDER = "yookassa"
MAX_ATTEMPTS = 72  # при цикле 5 мин — около 6 часов попыток
BATCH = 20
NAMES = {
    "subscription": "Доступ к VPN-сервису (подписка)",
    "extend": "Продление доступа к VPN-сервису",
    "devices": "Дополнительные устройства в VPN-сервисе",
    "traffic_reset": "Сброс лимита трафика в VPN-сервисе",
}

_lock = threading.Lock()


def _cfg() -> dict[str, Any]:
    try:
        from . import payments_config  # type: ignore
    except ImportError:  # pragma: no cover
        import payments_config  # type: ignore
    return payments_config.creds(PROVIDER)


def settings() -> tuple[bool, str, str]:
    c = _cfg()
    return bool(c.get("nalogo")), str(c.get("nalogo_inn") or "").strip(), str(c.get("nalogo_password") or "")


def enabled() -> bool:
    on, inn, pwd = settings()
    return on and bool(inn and pwd)


def _log(msg: str) -> None:
    print(f"[nalogo] {msg}", flush=True)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── клиент «Мой налог» ───────────────────────────────────────────

def _token_path(inn: str) -> str:
    base = os.path.dirname(os.path.abspath(os.getenv("DB_PATH", "data/data.db")))
    return os.path.join(base, f"nalogo_token_{hashlib.sha256(inn.encode()).hexdigest()[:12]}.json")


def _device_id(inn: str) -> str:
    return "blinvpn-" + hashlib.sha256(f"device:{inn}".encode()).hexdigest()[:21]


async def _session(inn: str, pwd: str, fn: Callable[[Any], Awaitable[Any]]) -> Any:
    from nalogo import Client  # type: ignore
    from nalogo.exceptions import UnauthorizedException  # type: ignore

    path = _token_path(inn)
    for attempt in (1, 2):
        client = Client(storage_path=path, device_id=_device_id(inn), timeout=30.0)
        try:
            if not await client.get_access_token():
                token = await client.create_new_access_token(inn, pwd)
                await client.authenticate(token)
            return await fn(client)
        except UnauthorizedException:
            # токен протух или сменили пароль — входим заново один раз
            try:
                os.remove(path)
            except OSError:
                pass
            if attempt == 2:
                raise
        finally:
            await client.aclose()
    return None


def _run(coro_fn: Callable[[Any], Awaitable[Any]], inn: str = "", pwd: str = "") -> Any:
    if not inn:
        _, inn, pwd = settings()
    return asyncio.run(_session(inn, pwd, coro_fn))


def check(inn: str, pwd: str) -> str:
    """вход в «Мой налог» с этими данными; возвращает имя/ИНН из профиля."""
    async def who(client: Any) -> str:
        try:
            prof = await client.user().get()
        except Exception:  # noqa: BLE001
            prof = {}
        name = " ".join(str(prof.get(k) or "") for k in ("lastName", "firstName")).strip() if isinstance(prof, dict) else ""
        return name or inn
    return str(_run(who, inn, pwd))


def print_url(inn: str, receipt_uuid: str) -> str:
    return f"https://lknpd.nalog.ru/api/v1/receipt/{inn}/{receipt_uuid}/print"


# ── очередь ─────────────────────────────────────────────────────

def enqueue(payment: dict[str, Any]) -> bool:
    """поставить чек по оплаченному платежу ЮKassa. Другие платёжки — пропускаем."""
    if payment.get("provider") != PROVIDER or not enabled():
        return False
    try:
        amount = float(payment.get("amount") or 0)
    except (TypeError, ValueError):
        amount = 0.0
    if amount <= 0:
        return False
    name = NAMES.get(str(payment.get("purpose") or ""), NAMES["subscription"])
    op_time = str(payment.get("paid_at") or "") or _now()
    cur = db.execute(
        "INSERT OR IGNORE INTO nalogo_receipts (payment_id, amount, name, operation_time, status, created_at) "
        "VALUES (?, ?, ?, ?, 'pending', ?)",
        (str(payment["payment_id"]), round(amount, 2), name, op_time, _now()),
    )
    if cur.rowcount:
        kick()
    return bool(cur.rowcount)


def kick() -> None:
    """отправить очередь сейчас, не дожидаясь фонового цикла."""
    threading.Thread(target=process_queue, name="nalogo", daemon=True).start()


CLAIM_STALE = 15 * 60  # строка «в работе» дольше 15 мин — процесс упал посреди отправки


def _ago(seconds: int) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _claim(pid: str, from_status: str, to_status: str) -> bool:
    """атомарный захват строки в БД: работает между процессами (api, вебхуки, бот),
    в отличие от threading.Lock — иначе один чек мог уйти в «Мой налог» дважды."""
    cur = db.execute("UPDATE nalogo_receipts SET status = ?, updated_at = ? WHERE payment_id = ? AND status = ?",
                     (to_status, _now(), pid, from_status))
    return bool(cur.rowcount == 1)


def _recover_stale(log: Callable[[str], None]) -> None:
    cutoff = _ago(CLAIM_STALE)
    # аннулирование можно безопасно повторить
    db.execute("UPDATE nalogo_receipts SET status = 'cancel_pending', updated_at = ? "
               "WHERE status = 'canceling' AND (updated_at IS NULL OR updated_at < ?)", (_now(), cutoff))
    # регистрацию — нет: чек мог уже появиться в «Мой налог». Отдаём человеку на проверку.
    for r in db.fetchall("SELECT * FROM nalogo_receipts WHERE status = 'sending' AND (updated_at IS NULL OR updated_at < ?)",
                         (cutoff,)):
        cur = db.execute("UPDATE nalogo_receipts SET status = 'check', last_error = ?, updated_at = ? "
                         "WHERE payment_id = ? AND status = 'sending'",
                         ("отправка прервалась — проверьте чек вручную", _now(), r["payment_id"]))
        if cur.rowcount:
            log(f"чек по платежу {r['payment_id']} — нужна ручная проверка")
            _report(str(r["payment_id"]), dict(r), RuntimeError(
                "отправка чека прервалась (перезапуск сервиса). Проверьте в «Мой налог», есть ли чек на эту сумму; "
                "если нет — пробейте вручную"))


def process_queue(log: Callable[[str], None] = _log) -> dict[str, int]:
    stats = {"sent": 0, "failed": 0, "canceled": 0}
    if not _lock.acquire(blocking=False):
        return stats
    try:
        on, inn, pwd = settings()
        try:
            _recover_stale(log)
        except Exception as exc:  # noqa: BLE001
            log(f"восстановление очереди: {exc}")
        rows = db.fetchall(
            "SELECT * FROM nalogo_receipts WHERE status IN ('pending', 'cancel_pending') AND attempts < ? "
            "ORDER BY created_at LIMIT ?", (MAX_ATTEMPTS, BATCH))
        if not rows or not (inn and pwd):
            return stats
        for r in rows:
            pid = str(r["payment_id"])
            if r["status"] == "pending":
                if not on or not _claim(pid, "pending", "sending"):
                    continue  # выключено или строку уже взял другой процесс
                back = "pending"
            else:
                if not _claim(pid, "cancel_pending", "canceling"):
                    continue
                back = "cancel_pending"
            try:
                if back == "pending":
                    res = _run(lambda c, r=r: c.income().create(
                        name=r["name"], amount=r["amount"], quantity=1, operation_time=r["operation_time"]), inn, pwd)
                    uuid = str((res or {}).get("approvedReceiptUuid") or "")
                    if not uuid:
                        raise RuntimeError(f"нет номера чека в ответе: {res}")
                    db.execute("UPDATE nalogo_receipts SET status = 'sent', receipt_uuid = ?, last_error = NULL, "
                               "updated_at = ? WHERE payment_id = ? AND status = 'sending'", (uuid, _now(), pid))
                    # пока отправляли, платёж могли вернуть
                    if (db.fetchone("SELECT status FROM payments WHERE payment_id = ?", (pid,)) or {}).get("status") \
                            in ("refunded", "refunding", "chargeback"):
                        cancel(pid)
                    stats["sent"] += 1
                    log(f"чек {uuid} по платежу {pid} на {r['amount']} ₽")
                else:
                    from nalogo.dto.income import CancelCommentType  # type: ignore
                    _run(lambda c, r=r: c.income().cancel(receipt_uuid=r["receipt_uuid"],
                                                           comment=CancelCommentType.REFUND), inn, pwd)
                    db.execute("UPDATE nalogo_receipts SET status = 'canceled', last_error = NULL, updated_at = ? "
                               "WHERE payment_id = ? AND status = 'canceling'", (_now(), pid))
                    stats["canceled"] += 1
                    log(f"чек {r['receipt_uuid']} по платежу {pid} аннулирован (возврат)")
            except Exception as exc:  # noqa: BLE001
                stats["failed"] += 1
                attempts = int(r["attempts"] or 0) + 1
                cur_status = "sending" if back == "pending" else "canceling"
                db.execute("UPDATE nalogo_receipts SET status = ?, attempts = ?, last_error = ?, updated_at = ? "
                           "WHERE payment_id = ? AND status = ?",
                           (back, attempts, f"{type(exc).__name__}: {exc}"[:500], _now(), pid, cur_status))
                if attempts >= MAX_ATTEMPTS:
                    _report(pid, r, exc)
        if any(stats.values()):
            log(f"очередь: {stats}")
        return stats
    finally:
        _lock.release()


def cancel(payment_id: str) -> None:
    """возврат / чарджбек: аннулировать чек (или не отправлять, если ещё в очереди)."""
    r = db.fetchone("SELECT * FROM nalogo_receipts WHERE payment_id = ?", (str(payment_id),))
    if not r:
        return
    if r["status"] == "pending":
        db.execute("UPDATE nalogo_receipts SET status = 'skipped', updated_at = ? WHERE payment_id = ? AND status = 'pending'",
                   (_now(), str(payment_id)))
        return
    if r["status"] == "sent" and r.get("receipt_uuid"):
        cur = db.execute("UPDATE nalogo_receipts SET status = 'cancel_pending', attempts = 0, updated_at = ? "
                         "WHERE payment_id = ? AND status = 'sent'", (_now(), str(payment_id)))
        if cur.rowcount:
            kick()


def receipt_for(payment_id: str) -> Optional[dict[str, Any]]:
    r = db.fetchone("SELECT * FROM nalogo_receipts WHERE payment_id = ?", (str(payment_id),))
    if not r:
        return None
    out = dict(r)
    _, inn, _ = settings()
    if r.get("receipt_uuid") and inn:
        out["url"] = print_url(inn, r["receipt_uuid"])
    return out


def _report(pid: str, r: dict[str, Any], exc: Exception) -> None:
    try:
        try:
            from . import forum  # type: ignore
        except ImportError:  # pragma: no cover
            import forum  # type: ignore
        what = "зарегистрировать чек" if r["status"] == "pending" else "аннулировать чек"
        forum.report_error(f"«Мой налог»: не удалось {what}",
                           f"payment_id={pid}, сумма {r['amount']} ₽ — сделайте это вручную в приложении «Мой налог». "
                           f"{type(exc).__name__}: {exc}")
    except Exception:  # noqa: BLE001
        pass
