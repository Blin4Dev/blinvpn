"""
Вебхуки Heleket: POST /heleket (url_callback передаётся в каждом счёте).

  1) подпись в поле sign: md5(base64(json без sign) + платёжный API-ключ);
  2) телу не доверяем: статус и сумму перезапрашиваем POST /payment/info;
  3) не-200 — Heleket повторит.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments.webhooks.common import apply_status, client_ip, find_payment, log, payment_gateways, payments_config

router = APIRouter()


@router.get("/heleket")
def heleket_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/heleket")
async def heleket_callback(request: Request) -> JSONResponse:
    raw = await request.body()
    client = payments_config.heleket_client()
    if not client.is_configured():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(body, dict) or not client.verify_webhook(body):
        log(f"heleket: отклонён вебхук с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})
    if str(body.get("type") or "payment") != "payment":
        return JSONResponse(status_code=200, content={"ok": True, "note": "not_payment"})

    uuid = str(body.get("uuid") or "")
    payment, why = find_payment("heleket", order_id=str(body.get("order_id") or ""), txn_id=uuid)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": why})
    if not payment.get("provider_payment_id") and uuid:
        payment = {**payment, "provider_payment_id": uuid}
    try:
        norm, amount, ok = payment_gateways.status(payment)
    except Exception as exc:  # noqa: BLE001
        log(f"heleket: не удалось перепроверить счёт {uuid}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not ok:
        return JSONResponse(status_code=200, content={"ok": True, "note": "order_mismatch"})
    res = apply_status(payment, norm, amount, uuid, "heleket")
    return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
