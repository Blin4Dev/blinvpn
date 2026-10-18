"""
HTTP-уведомления ЮKassa: POST /yookassa.

Подписи у ЮKassa нет, поэтому:
  1) запрос должен прийти с адресов ЮKassa (список из документации);
  2) телу не доверяем: статус и сумму перезапрашиваем GET /payments/{id};
  3) ответ 200 — иначе ЮKassa повторяет уведомление 24 часа.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments import yookassa
from payments.webhooks.common import apply_status, client_ip, find_payment, log, payment_gateways, payments_config

router = APIRouter()


@router.get("/yookassa")
def yookassa_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/yookassa")
async def yookassa_callback(request: Request) -> JSONResponse:
    ip = client_ip(request)
    # YOOKASSA_SKIP_IP_CHECK=1 — если перед сервером прокси/CDN, который подменяет адрес
    if os.getenv("YOOKASSA_SKIP_IP_CHECK", "").strip() not in ("1", "true", "yes") and not yookassa.ip_allowed(ip):
        log(f"yookassa: уведомление с чужого адреса {ip} — отклонено")
        return JSONResponse(status_code=403, content={"error": "forbidden"})
    if not payments_config.configured("yookassa"):
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(body, dict) or not isinstance(body.get("object"), dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    event = str(body.get("event") or "")
    obj = body["object"]
    if event.startswith("refund."):
        # возврат: object — возврат, платёж — в payment_id
        pay_id = str(obj.get("payment_id") or "")
        order_id = ""
    else:
        pay_id = str(obj.get("id") or "")
        order_id = str((obj.get("metadata") or {}).get("payment_id") or "")
    if not pay_id and not order_id:
        return JSONResponse(status_code=200, content={"ok": True, "note": "no_id"})

    payment, why = find_payment("yookassa", order_id=order_id, txn_id=pay_id)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": why})
    if not payment.get("provider_payment_id") and pay_id:
        payment = {**payment, "provider_payment_id": pay_id}

    try:
        norm, amount, ok = payment_gateways.status(payment)
    except Exception as exc:  # noqa: BLE001
        log(f"yookassa: не удалось перепроверить платёж {pay_id}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not ok:
        log(f"yookassa: платёж {pay_id} создан не для {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "order_mismatch"})
    res = apply_status(payment, norm, amount, pay_id, "yookassa")
    return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
