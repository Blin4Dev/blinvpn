"""общее для вебхуков платёжек: пути, лог, IP, вызов внутреннего API."""
from __future__ import annotations

import json
import os
import sys as _sys
import urllib.request
from typing import Any

from fastapi import Request

# src/core (база, выдача подписок, настройки платёжек) в sys.path
_CORE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "core"))
if os.path.isdir(_CORE_DIR) and _CORE_DIR not in _sys.path:
    _sys.path.insert(0, _CORE_DIR)

import database as db  # type: ignore  # noqa: E402,F401
import fulfillment  # type: ignore  # noqa: E402,F401
import payments_config  # type: ignore  # noqa: E402,F401
import payment_gateways  # type: ignore  # noqa: E402,F401
import deploy  # type: ignore  # noqa: E402


def log(msg: str) -> None:
    print(f"[webhook] {msg}", flush=True)


def client_ip(request: Request) -> str:
    """IP отправителя уведомления. X-Real-IP учитывается только от своего прокси на 127.0.0.1
    (nginx / edge-ingress); X-Forwarded-For не читается — его подделывает кто угодно,
    а от этого IP зависят проверки ЮKassa и PLATEGA_WEBHOOK_IPS."""
    peer = request.client.host if request.client else ""
    return deploy.trusted_client_ip(request.headers, peer)


def internal_post(path: str, body: dict[str, Any]) -> bool:
    """вызов внутренней ручки API (127.0.0.1, заголовок X-Internal-Secret)."""
    url = f"http://127.0.0.1:{os.getenv('API_PORT', '8000')}{path}"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Internal-Secret": os.getenv("INTERNAL_API_SECRET", "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001
        log(f"internal call {path} failed: {exc}")
        return False


def apply_status(payment: dict[str, Any], norm: str, amount: Any, txn_id: str, provider: str) -> dict[str, Any]:
    """общий итог проверки у платёжки: выдать, отменить или сообщить о возврате."""
    pid = payment["payment_id"]
    if norm == "paid":
        if txn_id and not payment.get("provider_payment_id"):
            db.execute("UPDATE payments SET provider_payment_id = ? WHERE payment_id = ? AND provider_payment_id IS NULL",
                       (txn_id, pid))
        res = fulfillment.fulfill_payment(pid, provider_payment_id=txn_id or None, amount=amount)
        return {"ok": bool(res.get("ok")), "http": 200}
    if norm == "failed":
        fulfillment.mark_failed(pid, f"{provider}_canceled")
        return {"ok": True, "http": 200}
    if norm == "refunded":
        # возврат, который сделали из панели — не чарджбек
        if str(payment.get("status") or "") in ("refunding", "refunded"):
            return {"ok": True, "http": 200, "note": "own_refund"}
        ok = internal_post("/api/internal/payments/chargeback", {"payment_id": pid})
        return {"ok": ok, "http": 200 if ok else 503}
    return {"ok": True, "http": 200}


def find_payment(provider: str, *, order_id: str = "", txn_id: str = "") -> tuple[Any, str]:
    """наш платёж по order_id или id у платёжки; (платёж | None, причина)."""
    payment = fulfillment.get_payment(order_id) if order_id else None
    if payment is None and txn_id:
        payment = fulfillment.get_payment_by_provider_id(txn_id)
    if payment is None:
        return None, "unknown_payment"
    if payment.get("provider") != provider:
        log(f"{provider}: уведомление для платежа {payment['payment_id']} другого провайдера ({payment.get('provider')}) — игнор")
        return None, "ignored"
    stored = str(payment.get("provider_payment_id") or "")
    if stored and txn_id and txn_id != stored:
        log(f"{provider}: платёж {txn_id} не совпадает с {stored} ({payment['payment_id']}) — игнор")
        return None, "id_mismatch"
    return payment, ""
