"""
Вебхук cisPay: POST /cispay.

  1) подпись X-Signature = HMAC-SHA256 от сырого тела ключом X-Api-Key магазина;
  2) телу не доверяем: статус и сумму перепроверяем GET /payments/status по id,
     который cisPay вернул нам при создании платежа;
  3) не-2xx (не смогли перепроверить) — cisPay повторит уведомление позже.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from payments import cispay
from payments.webhooks.common import client_ip, db, fulfillment, internal_post, log, payments_config

router = APIRouter()


@router.get("/cispay")
def cispay_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/cispay")
async def cispay_callback(request: Request) -> JSONResponse:
    raw = await request.body()
    client = payments_config.cispay_client()
    if not client.is_configured():
        log("cispay: уведомление пришло, но ключи cisPay не заданы")
        return JSONResponse(status_code=503, content={"error": "not_configured"})
    if not client.verify_signature(raw, request.headers.get("X-Signature")):
        log(f"cispay: отклонено уведомление с неверной подписью (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    try:
        payload = json.loads(raw)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    cis_id = str(payload.get("id") or "")
    order_id = str(payload.get("order_id") or "")
    if not cis_id and not order_id:
        return JSONResponse(status_code=400, content={"error": "no_payment_id"})

    payment = fulfillment.get_payment(order_id) if order_id else None
    if payment is None and cis_id:
        payment = fulfillment.get_payment_by_provider_id(cis_id)
    if payment is None:
        return JSONResponse(status_code=200, content={"ok": True, "note": "unknown_payment"})
    if payment.get("provider") != "cispay":
        log(f"cispay: уведомление для платежа {payment['payment_id']} другого провайдера ({payment.get('provider')}) — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "ignored"})

    stored = str(payment.get("provider_payment_id") or "")
    if stored and cis_id and cis_id != stored:
        log(f"cispay: платёж {cis_id} не совпадает с {stored} ({payment['payment_id']}) — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "id_mismatch"})
    pay_id = stored or cis_id

    # статус и сумма — у cisPay напрямую
    try:
        data = client.get_payment(payment_id=pay_id) if pay_id else client.get_payment(order_id=payment["payment_id"])
    except Exception as exc:  # noqa: BLE001
        log(f"cispay: не удалось перепроверить платёж {pay_id or payment['payment_id']}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not cispay.matches(data, payment["payment_id"]):
        log(f"cispay: платёж {pay_id} создан не для {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "order_mismatch"})
    norm = cispay.CisPayClient.normalize_status(data.get("status"))
    claimed = cispay.CisPayClient.normalize_status(payload.get("status"))
    if cispay.is_test(data):
        # песочница или заблокированный покупатель: денег нет — подписку не выдаём
        log(f"cispay: платёж {payment['payment_id']} тестовый/заблокирован ({data.get('block_reason') or 'sandbox'}) — не выдаём")
        if norm in ("paid", "failed"):
            fulfillment.mark_failed(payment["payment_id"], "cispay_sandbox_or_blocked")
        return JSONResponse(status_code=200, content={"ok": True, "note": "sandbox"})
    if norm != claimed:
        log(f"cispay: для {payment['payment_id']} заявлен {claimed}, у cisPay {norm} — работаем по cisPay")

    if norm == "paid":
        real_id = str(data.get("id") or pay_id or "")
        if real_id and not stored:
            db.execute("UPDATE payments SET provider_payment_id = ? WHERE payment_id = ? AND provider_payment_id IS NULL",
                       (real_id, payment["payment_id"]))
        result = fulfillment.fulfill_payment(
            payment["payment_id"], provider_payment_id=real_id or None, amount=cispay.amount_rub(data),
        )
        # как у Platega: 200 в любом случае; зависшие платежи досмотрит фоновая сверка
        return JSONResponse(status_code=200, content={"ok": bool(result.get("ok"))})
    if norm == "failed":
        fulfillment.mark_failed(payment["payment_id"], f"provider_{str(data.get('status') or 'failed').lower()}")
        return JSONResponse(status_code=200, content={"ok": True})
    if norm == "refunded":
        # возврат, который мы сами сделали из панели — это не чарджбек
        if str(payment.get("status") or "") in ("refunding", "refunded"):
            return JSONResponse(status_code=200, content={"ok": True, "note": "own_refund"})
        ok = internal_post("/api/internal/payments/chargeback", {"payment_id": payment["payment_id"]})
        return JSONResponse(status_code=200 if ok else 503, content={"ok": ok})
    return JSONResponse(status_code=200, content={"ok": True})
