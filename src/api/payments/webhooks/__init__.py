"""
Сервис вебхуков платёжек (контейнер blinvpn-webhook, 127.0.0.1:5000):

    /platega   — platega_webhook.py
    /cispay    — cispay_webhook.py
    /yookassa  — yookassa_webhook.py
    /lava      — lava_webhook.py
    /paypalych — paypalych_webhook.py
    /rollypay  — rollypay_webhook.py
    /wata      — wata_webhook.py
    /heleket   — heleket_webhook.py
    /2328      — pay2328_webhook.py
    звёзды Telegram — stars_webhook.py (апдейты бота, сам сервис их не принимает)

Запуск: uvicorn payments.webhooks:app
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from payments.webhooks.common import db
from payments.webhooks.cispay_webhook import router as cispay_router
from payments.webhooks.heleket_webhook import router as heleket_router
from payments.webhooks.lava_webhook import router as lava_router
from payments.webhooks.pay2328_webhook import router as pay2328_router
from payments.webhooks.paypalych_webhook import router as paypalych_router
from payments.webhooks.platega_webhook import router as platega_router
from payments.webhooks.rollypay_webhook import router as rollypay_router
from payments.webhooks.wata_webhook import router as wata_router
from payments.webhooks.yookassa_webhook import router as yookassa_router

app = FastAPI(title="BlinVPN Webhooks", version="2.0.0", docs_url=None, redoc_url=None)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


@app.get("/health")
@app.get("/")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "webhook"}


for _r in (platega_router, cispay_router, yookassa_router, lava_router, paypalych_router,
           rollypay_router, wata_router, heleket_router, pay2328_router):
    app.include_router(_r)


if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run("payments.webhooks:app", host="0.0.0.0", port=int(os.getenv("WEBHOOK_PORT", "5000")))
