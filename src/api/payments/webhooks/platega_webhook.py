"""
Callback Platega: POST /platega.

Защита в три слоя:
  1) заголовки X-MerchantId / X-Secret должны совпасть с нашими ключами;
  2) (необязательно) IP отправителя — из PLATEGA_WEBHOOK_IPS;
  3) телу callback НЕ доверяем: статус и сумму перепроверяем запросом к API
     Platega по ID транзакции, который мы сами сохранили при создании платежа.
Так поддельный (или ошибочный) callback не выдаст подписку и не отменит платёж.
"""
from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse

from payments import platega
from payments.webhooks.common import client_ip, db, fulfillment, internal_post, log, payments_config

router = APIRouter()


# healthcheck platega: get → 200
@router.get("/platega")
def platega_probe() -> dict[str, Any]:
    return {"ok": True}


@router.post("/platega")
async def platega_callback(
    request: Request,
    x_merchant_id: Optional[str] = Header(None, alias="X-MerchantId"),
    x_secret: Optional[str] = Header(None, alias="X-Secret"),
) -> JSONResponse:
    # выключенная в панели платёжка всё равно принимает уведомления по уже созданным платежам
    client = payments_config.platega_client()
    if not client.verify_callback(x_merchant_id, x_secret):
        log(f"platega: отклонён callback с неверными ключами (ip {client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    allowed_ips = [x.strip() for x in (os.getenv("PLATEGA_WEBHOOK_IPS") or "").split(",") if x.strip()]
    if allowed_ips and client_ip(request) not in allowed_ips:
        log(f"platega: отклонён callback с чужого IP {client_ip(request)}")
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    provider_txn = str(payload.get("id") or "")
    our_payment_id = payload.get("payload")  # наш payment_id в payload
    if not provider_txn and not our_payment_id:
        return JSONResponse(status_code=400, content={"error": "no_transaction_id"})

    payment = None
    if our_payment_id:
        payment = fulfillment.get_payment(str(our_payment_id))
    if payment is None and provider_txn:
        payment = fulfillment.get_payment_by_provider_id(provider_txn)
    if payment is None:
        # неизвестный платёж: 200 без ретраев
        return JSONResponse(status_code=200, content={"ok": True, "note": "unknown_payment"})

    # только platega-платежи
    if payment.get("provider") != "platega":
        log(f"platega: callback для платежа {payment['payment_id']} другого провайдера ({payment.get('provider')}) — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "ignored"})

    # txn id только из создания у platega
    stored_txn = str(payment.get("provider_payment_id") or "")
    if stored_txn and provider_txn and provider_txn != stored_txn:
        log(f"platega: транзакция {provider_txn} не совпадает с {stored_txn} платежа {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "txn_mismatch"})
    txn_id = stored_txn or provider_txn
    if not txn_id:
        return JSONResponse(status_code=200, content={"ok": True, "note": "no_txn"})

    # статус/сумма у platega напрямую
    try:
        tx = client.get_transaction(txn_id)
    except Exception as exc:  # noqa: BLE001
        log(f"platega: не удалось перепроверить транзакцию {txn_id}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not platega.tx_matches(tx, payment["payment_id"]):
        log(f"platega: транзакция {txn_id} создана не для платежа {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "payload_mismatch"})
    norm = platega.PlategaClient.normalize_status(tx.get("status"))
    claimed = platega.PlategaClient.normalize_status(payload.get("status"))
    if norm != claimed:
        log(f"platega: callback для {payment['payment_id']}: заявлен {claimed}, у Platega {norm} — работаем по Platega")

    if norm == "paid":
        if not stored_txn:
            db.execute("UPDATE payments SET provider_payment_id = ? WHERE payment_id = ? AND provider_payment_id IS NULL",
                       (txn_id, payment["payment_id"]))
        result = fulfillment.fulfill_payment(
            payment["payment_id"],
            provider_payment_id=txn_id,
            amount=platega.tx_amount(tx),
        )
        return JSONResponse(status_code=200, content={"ok": bool(result.get("ok"))})
    if norm == "failed":
        fulfillment.mark_failed(payment["payment_id"], "provider_canceled")
        return JSONResponse(status_code=200, content={"ok": True})
    if norm == "refunded":
        # chargeback: отзыв через api
        ok = internal_post("/api/internal/payments/chargeback", {"payment_id": payment["payment_id"]})
        # 5xx чтобы platega повторила
        return JSONResponse(status_code=200 if ok else 503, content={"ok": ok})

    # pending/прочее: ack
    return JSONResponse(status_code=200, content={"ok": True})
