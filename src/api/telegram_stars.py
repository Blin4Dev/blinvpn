"""
Telegram Stars — оплата звёздами Telegram (валюта XTR) для BlinVPN.

Звёзды не проходят через внешний платёжный вебхук: счёт (invoice) создаётся
через Bot API, мини-приложение открывает его методом
`Telegram.WebApp.openInvoice(link)`, а подтверждение прилетает боту как
апдейты `pre_checkout_query` (нужно подтвердить) и `message.successful_payment`.

Здесь — тонкая обёртка над Bot API на стандартной библиотеке.

Env:
  TELEGRAM_BOT_TOKEN
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

API_BASE = "https://api.telegram.org"
CURRENCY = "XTR"  # Telegram Stars


def _env(*keys: str, default: str = "") -> str:
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return default


class TelegramStarsError(Exception):
    pass


class TelegramStars:
    def __init__(self, bot_token: Optional[str] = None, *, timeout: float = 10.0) -> None:
        self.bot_token = bot_token or _env("TELEGRAM_BOT_TOKEN")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.bot_token)

    def _call(self, method: str, payload: dict[str, Any]) -> Any:
        if not self.bot_token:
            raise TelegramStarsError("TELEGRAM_BOT_TOKEN не задан")
        url = f"{API_BASE}/bot{self.bot_token}/{method}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                raise TelegramStarsError(f"HTTP {e.code}: {raw}") from e
        except urllib.error.URLError as e:
            raise TelegramStarsError(f"Не удалось связаться с Telegram: {e.reason}") from e

        if not body.get("ok"):
            raise TelegramStarsError(str(body.get("description") or body))
        return body.get("result")

    # ── invoices ─────────────────────────────────────────────

    def create_invoice_link(
        self,
        *,
        title: str,
        description: str,
        payload: str,
        stars: int,
        photo_url: Optional[str] = None,
    ) -> str:
        """
        Создаёт ссылку на счёт в звёздах (createInvoiceLink).
        `payload` — наш внутренний payment_id (вернётся в successful_payment).
        """
        amount = int(stars)
        if amount < 1:
            amount = 1
        body: dict[str, Any] = {
            "title": title[:32] or "BlinVPN",
            "description": description[:255] or "Подписка BlinVPN",
            "payload": payload,
            "currency": CURRENCY,
            "prices": [{"label": title[:32] or "BlinVPN", "amount": amount}],
        }
        if photo_url:
            body["photo_url"] = photo_url
        link = self._call("createInvoiceLink", body)
        if not isinstance(link, str):
            raise TelegramStarsError("Bot API не вернул ссылку на счёт")
        return link

    def answer_pre_checkout(self, pre_checkout_query_id: str, ok: bool = True, error: str = "") -> None:
        """Подтверждает pre_checkout_query (обязательно в течение 10 секунд)."""
        body: dict[str, Any] = {"pre_checkout_query_id": pre_checkout_query_id, "ok": bool(ok)}
        if not ok and error:
            body["error_message"] = error
        self._call("answerPreCheckoutQuery", body)

    def refund_star_payment(self, user_id: int, telegram_payment_charge_id: str) -> None:
        """Возврат звёзд (refundStarPayment)."""
        self._call(
            "refundStarPayment",
            {"user_id": int(user_id), "telegram_payment_charge_id": telegram_payment_charge_id},
        )

    def send_message(self, chat_id: Any, text: str, **extra: Any) -> Any:
        body: dict[str, Any] = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
        body.update(extra)
        return self._call("sendMessage", body)


def get_client() -> TelegramStars:
    return TelegramStars()
