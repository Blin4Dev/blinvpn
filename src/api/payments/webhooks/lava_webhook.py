"""
Уведомления Lava: POST /lava (адрес передаётся в каждом счёте — hookUrl).

  1) подпись в заголовке Authorization = HMAC-SHA256(тело, дополнительный ключ);
  2) телу не доверяем: статус и сумму перезапрашиваем POST /invoice/status;
  3) не-2xx — Lava повторит уведомление.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments.webhooks.common import apply_status, client_ip, find_payment, log, payment_gateways, payments_config

router = APIRouter()


@router.get("/lava")
def lava_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/lava")
async def lava_callback(request: Request) -> JSONResponse:
    raw = await request.body()
    client = payments_config.lava_client()
    if not client.is_configured():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    sig = request.headers.get("Authorization") or request.headers.get("Signature")
    if not client.verify_webhook(raw, sig):
        log(f"lava: отклонено уведомление с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    inv_id = str(body.get("invoice_id") or body.get("id") or "")
    order_id = str(body.get("order_id") or "")
    payment, why = find_payment("lava", order_id=order_id, txn_id=inv_id)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": why})
    if not payment.get("provider_payment_id") and inv_id:
        payment = {**payment, "provider_payment_id": inv_id}
    try:
        norm, amount, ok = payment_gateways.status(payment)
    except Exception as exc:  # noqa: BLE001
        log(f"lava: не удалось перепроверить счёт {inv_id or order_id}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not ok:
        log(f"lava: счёт {inv_id} создан не для {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "order_mismatch"})
    res = apply_status(payment, norm, amount, inv_id, "lava")
    return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
