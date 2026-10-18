"""
Lava Business API (https://developer.lava.ru, API: https://api.lava.ru/business).

Запросы — POST JSON, подпись в заголовке Signature = hex(HMAC-SHA256(тело запроса, секретный ключ)).
Сумма (sum) — в рублях. Уведомление о счёте приходит на hookUrl, подпись — в заголовке
Authorization = hex(HMAC-SHA256(JSON, дополнительный ключ)); JSON подписывается как есть
или с отсортированными ключами — принимаем оба варианта.
Статусы счёта: created, success, expired (в уведомлении бывает error).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Optional
from urllib.parse import urlsplit

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://api.lava.ru/business"


class LavaError(GatewayError):
    pass


def _hmac(key: str, data: bytes) -> str:
    return hmac.new(key.encode("utf-8"), data, hashlib.sha256).hexdigest()


class LavaClient:
    def __init__(self, shop_id: str = "", secret_key: str = "", additional_key: str = "", *,
                 base_url: str = "", timeout: float = 30.0) -> None:
        self.shop_id = (shop_id or "").strip()
        self.secret_key = (secret_key or "").strip()
        self.additional_key = (additional_key or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.shop_id and self.secret_key and self.additional_key)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not (self.shop_id and self.secret_key):
            raise LavaError("Lava не настроена: укажите Shop ID и секретный ключ")
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = {"Accept": "application/json", "Content-Type": "application/json",
                   "Signature": _hmac(self.secret_key, body)}
        data = request("POST", f"{self.base_url}{path}", headers=headers, body=body, timeout=self.timeout,
                       name="Lava", error_cls=LavaError)
        if not isinstance(data, dict):
            raise LavaError("Некорректный ответ Lava", payload=data)
        if data.get("status_check") is False or str(data.get("status") or "").lower() == "error":
            err = data.get("error") or data.get("message") or data
            raise LavaError(json.dumps(err, ensure_ascii=False) if isinstance(err, (dict, list)) else str(err),
                            status=data.get("status") if isinstance(data.get("status"), int) else None, payload=data)
        return data

    # счёт на оплату: страница Lava со всеми подключёнными способами
    def create_invoice(self, *, amount_rub: float, order_id: str, hook_url: Optional[str] = None,
                       success_url: Optional[str] = None, fail_url: Optional[str] = None,
                       comment: Optional[str] = None, expire_minutes: int = 60) -> dict[str, Any]:
        payload: dict[str, Any] = {"sum": round(float(amount_rub), 2), "orderId": str(order_id), "shopId": self.shop_id}
        if hook_url:
            payload["hookUrl"] = hook_url[:500]
        # Lava не принимает ссылки с параметрами (?...) — такие не передаём
        for key, url in (("successUrl", success_url), ("failUrl", fail_url)):
            if url and not urlsplit(url).query:
                payload[key] = url[:500]
        payload["expire"] = max(1, min(7200, int(expire_minutes)))
        if comment:
            payload["comment"] = comment[:255]
        data = self._post("/invoice/create", payload)
        inv = data.get("data") or {}
        if not inv.get("id") or not inv.get("url"):
            raise LavaError("Lava не вернула ссылку на оплату", payload=data)
        return inv

    def invoice_status(self, *, order_id: Optional[str] = None, invoice_id: Optional[str] = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"shopId": self.shop_id}
        if invoice_id:
            payload["invoiceId"] = str(invoice_id)
        if order_id:
            payload["orderId"] = str(order_id)
        return self._post("/invoice/status", payload).get("data") or {}

    def tariffs(self) -> list[dict[str, Any]]:
        data = self._post("/invoice/get-available-tariffs", {"shopId": self.shop_id}).get("data")
        return data if isinstance(data, list) else []

    def verify_webhook(self, raw_body: bytes, signature: Optional[str]) -> bool:
        sig = (signature or "").strip().lower()
        if sig.startswith("bearer "):
            sig = sig[7:].strip()
        if not sig or not self.additional_key:
            return False
        if hmac.compare_digest(_hmac(self.additional_key, raw_body), sig):
            return True
        try:
            payload = json.loads(raw_body)
        except ValueError:
            return False
        if not isinstance(payload, dict):
            return False
        for variant in (
            json.dumps(dict(sorted(payload.items())), ensure_ascii=False, separators=(",", ":")),
            json.dumps(dict(sorted(payload.items())), separators=(",", ":")),
            json.dumps(dict(sorted(payload.items())), ensure_ascii=False),
        ):
            if hmac.compare_digest(_hmac(self.additional_key, variant.encode("utf-8")), sig):
                return True
        return False

    @staticmethod
    def normalize_status(status: Optional[str]) -> str:
        s = (status or "").strip().lower()
        if s == "success":
            return "paid"
        if s in ("expired", "error", "cancel", "canceled", "cancelled", "rejected"):
            return "failed"
        return "pending"


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    # уведомление: amount; ответ /invoice/status: sum
    for key in ("amount", "sum"):
        try:
            return float(data[key])
        except (KeyError, TypeError, ValueError):
            continue
    return None


def matches(data: dict[str, Any], payment_id: str) -> bool:
    oid = data.get("order_id") or data.get("orderId")
    return not oid or str(oid) == str(payment_id)
