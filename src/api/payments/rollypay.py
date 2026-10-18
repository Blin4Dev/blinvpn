"""
RollyPay (https://docs.rollypay.io/, API: https://rollypay.io/api/v1).

Аутентификация — заголовки X-API-Key (ключ кассы) и X-Nonce (уникальный на каждый запрос).
Платёж: POST /payments (amount — строка в рублях, payment_currency, order_id, payment_method sbp / card / crypto)
→ payment_id, pay_url.
Статус: GET /payments/{payment_id} → status created / processing / paid / expired / canceled / chargeback.
Колбэк (callback_url кассы): тело JSON {event_type, payment_id, order_id, status, amount, ...},
заголовки X-Timestamp и X-Signature = HMAC-SHA256(секрет подписи, "{timestamp}.{тело}").
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from typing import Any, Optional

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://rollypay.io/api/v1"
APP_METHOD_MAP: dict[str, str] = {"sbp": "sbp", "card": "card", "crypto": "crypto"}
PAID = {"paid"}
FAILED = {"expired", "canceled", "cancelled", "failed"}
REFUNDED = {"chargeback", "refunded"}


class RollyPayError(GatewayError):
    pass


class RollyPayClient:
    def __init__(self, api_key: str = "", signing_secret: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.api_key = (api_key or "").strip()
        self.signing_secret = (signing_secret or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.api_key and self.signing_secret)

    def _call(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if not self.api_key:
            raise RollyPayError("RollyPay не настроен: укажите API-ключ кассы")
        headers = {"X-API-Key": self.api_key, "X-Nonce": str(uuid.uuid4()), "Accept": "application/json",
                   "Content-Type": "application/json"}
        data = request(method, f"{self.base_url}{path}", headers=headers,
                       body=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
                       timeout=self.timeout, name="RollyPay", error_cls=RollyPayError)
        if not isinstance(data, dict):
            raise RollyPayError("Некорректный ответ RollyPay", payload=data)
        return data

    def create_payment(self, *, amount_rub: float, order_id: str, method: Optional[str], description: str,
                       success_url: Optional[str] = None, fail_url: Optional[str] = None,
                       customer_id: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"amount": f"{float(amount_rub):.2f}", "payment_currency": "RUB", "order_id": str(order_id)}
        if method:
            body["payment_method"] = method
        if description:
            body["description"] = description[:255]
        if success_url:
            body["success_redirect_url"] = success_url
        if fail_url:
            body["fail_redirect_url"] = fail_url
        if customer_id:
            body["customer_id"] = str(customer_id)
        data = self._call("POST", "/payments", body)
        if not data.get("payment_id") or not data.get("pay_url"):
            raise RollyPayError("RollyPay не вернул ссылку на оплату", payload=data)
        return data

    def get_payment(self, payment_id: str) -> dict[str, Any]:
        return self._call("GET", f"/payments/{payment_id}")

    def check_key(self) -> None:
        """проверка ключа: несуществующий платёж → 404 (ключ принят) или 401/403 (ключ неверный)."""
        try:
            self.get_payment(str(uuid.uuid4()))
        except RollyPayError as e:
            if e.status in (400, 404, 422):
                return
            raise

    def verify_webhook(self, raw_body: bytes, signature: Optional[str], timestamp: Optional[str]) -> bool:
        if not self.signing_secret or not signature or not timestamp:
            return False
        msg = f"{timestamp}.".encode("utf-8") + raw_body
        expected = hmac.new(self.signing_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature.strip().lower())

    @staticmethod
    def normalize_status(status: Optional[str]) -> str:
        s = (status or "").strip().lower()
        if s in PAID:
            return "paid"
        if s in REFUNDED:
            return "refunded"
        if s in FAILED:
            return "failed"
        return "pending"


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    try:
        return float(data.get("amount"))
    except (TypeError, ValueError):
        return None


def matches(data: dict[str, Any], payment_id: str) -> bool:
    oid = data.get("order_id")
    return not oid or str(oid) == str(payment_id)
