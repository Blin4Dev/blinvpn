"""
Вебхуки WATA: POST /wata (адрес задаётся в кабинете для терминала).

  1) подпись: X-Signature = base64(RSA-SHA512 подпись тела), ключ — GET /public-key (кэш на час);
  2) GET-запросы у WATA ограничены (1 раз в 45 с), поэтому подписанному телу доверяем,
     а сумму сверяет выдача подписки;
  3) отвечаем 200, иначе WATA повторит.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments import wata
from payments.webhooks.common import apply_status, client_ip, find_payment, log, payments_config

router = APIRouter()


@router.get("/wata")
def wata_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/wata")
async def wata_callback(request: Request) -> JSONResponse:
    raw = await request.body()
    client = payments_config.wata_client()
    if not client.is_configured():
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    if not client.verify_webhook(raw, request.headers.get("X-Signature")):
        log(f"wata: отклонён вебхук с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    order_id = str(body.get("orderId") or "")
    link_id = str(body.get("paymentLinkId") or "")
    status = wata.normalize_status(body.get("transactionStatus"))
    kind = str(body.get("kind") or "Payment").lower()
    payment, why = find_payment("wata", order_id=order_id, txn_id=link_id)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": why})

    if kind == "refund":
        if status != "paid":
            return JSONResponse(status_code=200, content={"ok": True})
        res = apply_status(payment, "refunded", None, link_id, "wata")
    elif status == "failed":
        # отказ банка не финал: покупатель может оплатить ту же ссылку ещё раз — ждём, сверка отменит через сутки
        return JSONResponse(status_code=200, content={"ok": True, "note": "declined"})
    else:
        res = apply_status(payment, status, wata.amount_rub(body), link_id, "wata")
    return JSONResponse(status_code=res["http"], content={"ok": res["ok"]})
