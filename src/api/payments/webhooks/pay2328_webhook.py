"""
Вебхуки 2328: POST /2328 (url_callback передаётся в каждом счёте).

  1) подпись в поле sign: hex(HMAC-SHA256(API-ключ, base64(json без sign)));
  2) телу не доверяем: статус и сумму перезапрашиваем POST /v1/payment/info;
  3) не-200 — 2328 повторит через 2 минуты (до 5 раз).
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments.webhooks.common import apply_status, client_ip, find_payment, log, payment_gateways, payments_config

router = APIRouter()


@router.get("/2328")
def pay2328_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/2328")
async def pay2328_callback(request: Request) -> JSONResponse:
    raw = await request.body()
    client = payments_config.pay2328_client()
    if not client.is_configured():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(body, dict) or not client.verify_webhook(body):
        log(f"2328: отклонён вебхук с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=401, content={"error": "forbidden"})

    uuid = str(body.get("uuid") or "")
    payment, why = find_payment("pay2328", order_id=str(body.get("order_id") or ""), txn_id=uuid)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": why})
    if not payment.get("provider_payment_id") and uuid:
        payment = {**payment, "provider_payment_id": uuid}
    try:
        norm, amount, ok = payment_gateways.status(payment)
    except Exception as exc:  # noqa: BLE001
        log(f"2328: не удалось перепроверить счёт {uuid}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not ok:
        return JSONResponse(status_code=200, content={"ok": True, "note": "order_mismatch"})
    res = apply_status(payment, norm, amount, uuid, "pay2328")
    return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
