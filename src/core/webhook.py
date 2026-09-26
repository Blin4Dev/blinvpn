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


def _internal_post(path: str, body: dict[str, Any]) -> bool:
    """Вызов внутренней ручки API (127.0.0.1, заголовок X-Internal-Secret)."""
    import json
    import urllib.request

    url = f"http://127.0.0.1:{os.getenv('API_PORT', '8000')}{path}"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Internal-Secret": os.getenv("INTERNAL_API_SECRET", "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001
        print(f"[webhook] internal call {path} failed: {exc}", flush=True)
        return False


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


def _log(msg: str) -> None:
    print(f"[webhook] {msg}", flush=True)


def _client_ip(request: Request) -> str:
    return (request.headers.get("x-real-ip")
            or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
            or (request.client.host if request.client else ""))


@app.post("/platega")
async def platega_callback(
    request: Request,
    x_merchant_id: Optional[str] = Header(None, alias="X-MerchantId"),
    x_secret: Optional[str] = Header(None, alias="X-Secret"),
) -> JSONResponse:
    """
    Callback Platega. Защита в три слоя:
      1) заголовки X-MerchantId / X-Secret должны совпасть с нашими ключами;
      2) (необязательно) IP отправителя — из PLATEGA_WEBHOOK_IPS;
      3) телу callback НЕ доверяем: статус и сумму перепроверяем запросом к API
         Platega по ID транзакции, который мы сами сохранили при создании платежа.
    Так поддельный (или ошибочный) callback не выдаст подписку и не отменит платёж.
    """
    if platega is None:
        return JSONResponse(status_code=503, content={"error": "platega_unavailable"})

    client = platega.get_client()
    if not client.verify_callback(x_merchant_id, x_secret):
        _log(f"отклонён callback с неверными ключами (ip {_client_ip(request)})")
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    allowed_ips = [x.strip() for x in (os.getenv("PLATEGA_WEBHOOK_IPS") or "").split(",") if x.strip()]
    if allowed_ips and _client_ip(request) not in allowed_ips:
        _log(f"отклонён callback с чужого IP {_client_ip(request)}")
        return JSONResponse(status_code=403, content={"error": "forbidden"})

    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "bad_json"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "bad_json"})

    provider_txn = str(payload.get("id") or "")
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

    # Callback Platega может относиться только к платежу Platega (не Stars / не баланс)
    if payment.get("provider") != "platega":
        _log(f"callback для платежа {payment['payment_id']} другого провайдера ({payment.get('provider')}) — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "ignored"})

    # ID транзакции — только тот, что мы получили от Platega при создании платежа
    stored_txn = str(payment.get("provider_payment_id") or "")
    if stored_txn and provider_txn and provider_txn != stored_txn:
        _log(f"callback: транзакция {provider_txn} не совпадает с {stored_txn} платежа {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "txn_mismatch"})
    txn_id = stored_txn or provider_txn
    if not txn_id:
        return JSONResponse(status_code=200, content={"ok": True, "note": "no_txn"})

    # Перепроверяем статус и сумму напрямую у Platega
    try:
        tx = client.get_transaction(txn_id)
    except Exception as exc:  # noqa: BLE001
        _log(f"не удалось перепроверить транзакцию {txn_id}: {exc} — попросим повторить")
        return JSONResponse(status_code=503, content={"error": "verify_failed"})
    if not fulfillment.platega_tx_matches(tx, payment):
        _log(f"транзакция {txn_id} создана не для платежа {payment['payment_id']} — игнор")
        return JSONResponse(status_code=200, content={"ok": True, "note": "payload_mismatch"})
    norm = platega.PlategaClient.normalize_status(tx.get("status"))
    claimed = platega.PlategaClient.normalize_status(payload.get("status"))
    if norm != claimed:
        _log(f"callback для {payment['payment_id']}: заявлен {claimed}, у Platega {norm} — работаем по Platega")

    if norm == "paid":
        if not stored_txn:
            db.execute("UPDATE payments SET provider_payment_id = ? WHERE payment_id = ? AND provider_payment_id IS NULL",
                       (txn_id, payment["payment_id"]))
        result = fulfillment.fulfill_payment(
            payment["payment_id"],
            provider_payment_id=txn_id,
            amount=fulfillment.platega_tx_amount(tx),
        )
        return JSONResponse(status_code=200, content={"ok": bool(result.get("ok"))})
    if norm == "failed":
        fulfillment.mark_failed(payment["payment_id"], "provider_canceled")
        return JSONResponse(status_code=200, content={"ok": True})
    if norm == "refunded":
        # Chargeback: отзыв подписки и реф. бонуса делает API (общая логика возвратов).
        ok = _internal_post("/api/internal/payments/chargeback", {"payment_id": payment["payment_id"]})
        # 5xx → Platega повторит callback, если API сейчас недоступен.
        return JSONResponse(status_code=200 if ok else 503, content={"ok": ok})

    # PENDING / прочее — просто подтверждаем приём.
    return JSONResponse(status_code=200, content={"ok": True})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("webhook:app", host="0.0.0.0", port=int(os.getenv("WEBHOOK_PORT", "5000")))
