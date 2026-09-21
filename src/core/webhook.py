"""
BlinVPN — сервис платёжных вебхуков (порт 5000).

Nginx проксирует сюда:
  POST https://<miniapp>/platega   → callback Platega

Telegram Stars сюда НЕ приходят — они обрабатываются ботом (bot.py) через
апдейты pre_checkout_query / successful_payment.

Запуск:
  uvicorn webhook:app --host 0.0.0.0 --port 5000
"""

from __future__ import annotations

import os
import sys as _sys
from typing import Any, Optional

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

# src/api в путь импорта
_API_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "api"))
if os.path.isdir(_API_DIR) and _API_DIR not in _sys.path:
    _sys.path.insert(0, _API_DIR)

try:
    from . import database as db
except ImportError:
    import database as db  # type: ignore

try:
    from . import fulfillment
except ImportError:
    import fulfillment  # type: ignore

try:
    import platega  # type: ignore
except Exception:  # noqa: BLE001
    platega = None  # type: ignore


app = FastAPI(title="BlinVPN Webhooks", version="1.0.0", docs_url=None, redoc_url=None)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


@app.get("/health")
@app.get("/")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "webhook"}


# Platega проверяет доступность webhook GET-запросом → отвечаем 200.
@app.get("/platega")
def platega_probe() -> dict[str, Any]:
    return {"ok": True}


@app.post("/platega")
async def platega_callback(
    request: Request,
    x_merchant_id: Optional[str] = Header(None, alias="X-MerchantId"),
    x_secret: Optional[str] = Header(None, alias="X-Secret"),
) -> JSONResponse:
    if platega is None:
        return JSONResponse(status_code=503, content={"error": "platega_unavailable"})

    client = platega.get_client()
    if not client.verify_callback(x_merchant_id, x_secret):
        # Единственная защита эндпоинта — не подтверждаем ничего без валидных ключей.
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    provider_txn = str(payload.get("id") or "")
    status = str(payload.get("status") or "")
    our_payment_id = payload.get("payload")  # мы кладём наш payment_id в payload
    if not provider_txn and not our_payment_id:
        return JSONResponse(status_code=400, content={"error": "no_transaction_id"})

    payment = None
    if our_payment_id:
        payment = fulfillment.get_payment(str(our_payment_id))
    if payment is None and provider_txn:
        payment = fulfillment.get_payment_by_provider_id(provider_txn)
    if payment is None:
        # Неизвестный платёж — 200, чтобы Platega не ретраила бесконечно.
        return JSONResponse(status_code=200, content={"ok": True, "note": "unknown_payment"})

    norm = platega.PlategaClient.normalize_status(status)
    if norm == "paid":
        result = fulfillment.fulfill_payment(
            payment["payment_id"],
            provider_payment_id=provider_txn or None,
            amount=payload.get("amount"),
        )
        return JSONResponse(status_code=200, content={"ok": bool(result.get("ok"))})
    if norm == "failed":
        fulfillment.mark_failed(payment["payment_id"], "provider_canceled")
        return JSONResponse(status_code=200, content={"ok": True})

    # PENDING / прочее — просто подтверждаем приём.
    return JSONResponse(status_code=200, content={"ok": True})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("webhook:app", host="0.0.0.0", port=int(os.getenv("WEBHOOK_PORT", "5000")))
