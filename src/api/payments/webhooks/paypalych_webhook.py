"""
Postback PayPalych (Result URL магазина): POST /paypalych.

  1) SignatureValue = upper(md5(OutSum:InvId:API-токен));
  2) телу не доверяем: статус и сумму перезапрашиваем GET bill/status по номеру счёта;
  3) отвечаем 200, иначе PayPalych повторит.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from payments.webhooks.common import apply_status, client_ip, find_payment, log, payment_gateways, payments_config

router = APIRouter()


async def _payload(request: Request) -> dict[str, str]:
    raw = await request.body()
    ctype = (request.headers.get("content-type") or "").lower()
    if "json" in ctype:
        try:
            data = json.loads(raw)
            return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except ValueError:
            return {}
    from urllib.parse import parse_qsl
    return {k: v for k, v in parse_qsl(raw.decode("utf-8", "replace"), keep_blank_values=True)}


@router.get("/paypalych")
def paypalych_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/paypalych")
async def paypalych_callback(request: Request):
    client = payments_config.paypalych_client()
    if not client.is_configured():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    data = await _payload(request)
    inv_id, out_sum, sig = data.get("InvId", ""), data.get("OutSum", ""), data.get("SignatureValue", "")
    if not inv_id or not out_sum:
        return JSONResponse(status_code=400, content={"error": "bad_payload"})
    if not client.verify_postback(out_sum, inv_id, sig):
        log(f"paypalych: отклонён postback с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    payment, why = find_payment("paypalych", order_id=inv_id)
    if payment is None:
        return PlainTextResponse("OK")
    if not payment.get("provider_payment_id"):
        log(f"paypalych: у платежа {payment['payment_id']} нет номера счёта — проверим позже")
        return PlainTextResponse("OK")
    try:
        norm, amount, ok = payment_gateways.status(payment)
    except Exception as exc:  # noqa: BLE001
        log(f"paypalych: не удалось перепроверить счёт {payment.get('provider_payment_id')}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not ok:
        log(f"paypalych: счёт создан не для {payment['payment_id']} — игнор")
        return PlainTextResponse("OK")
    res = apply_status(payment, norm, amount, str(payment["provider_payment_id"]), "paypalych")
    if res["http"] != 200:
        return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
    return PlainTextResponse("OK")
