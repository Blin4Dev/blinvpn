"""
Колбэки RollyPay: POST /rollypay (callback_url кассы).

  1) подпись: X-Signature = HMAC-SHA256(секрет подписи, "{X-Timestamp}.{тело}");
  2) телу не доверяем: статус и сумму перезапрашиваем GET /payments/{id};
  3) не-200 — RollyPay повторит с нарастающей паузой.
"""
from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments.webhooks.common import apply_status, client_ip, find_payment, log, payment_gateways, payments_config

router = APIRouter()
MAX_SKEW = 24 * 3600  # старше суток — повтор старого колбэка, не принимаем


@router.get("/rollypay")
def rollypay_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/rollypay")
async def rollypay_callback(request: Request) -> JSONResponse:
    raw = await request.body()
    client = payments_config.rollypay_client()
    if not client.is_configured():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    ts = request.headers.get("X-Timestamp") or ""
    if not client.verify_webhook(raw, request.headers.get("X-Signature"), ts):
        log(f"rollypay: отклонён колбэк с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})
    try:
        if abs(time.time() - float(ts)) > MAX_SKEW:
            return JSONResponse(status_code=403, content={"error": "stale"})
    except ValueError:
        pass
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    rp_id = str(body.get("payment_id") or "")
    order_id = str(body.get("order_id") or "")
    payment, why = find_payment("rollypay", order_id=order_id, txn_id=rp_id)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": why})
    if not payment.get("provider_payment_id") and rp_id:
        payment = {**payment, "provider_payment_id": rp_id}
    try:
        norm, amount, ok = payment_gateways.status(payment)
    except Exception as exc:  # noqa: BLE001
        log(f"rollypay: не удалось перепроверить платёж {rp_id}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not ok:
        log(f"rollypay: платёж {rp_id} создан не для {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "order_mismatch"})
    res = apply_status(payment, norm, amount, rp_id, "rollypay")
    return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
