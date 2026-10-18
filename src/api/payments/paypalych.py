"""
PayPalych / Pally (https://pally.info/reference/api, API: https://pal24.pro/api/v1/).

Аутентификация — заголовок Authorization: Bearer <API-токен>.
Счёт: POST bill/create (amount в рублях, shop_id, order_id, payment_method SBP / BANK_CARD)
→ bill_id, link_page_url (страница оплаты), link_url.
Статус счёта: GET bill/status?id=... → status NEW / PROCESS / UNDERPAID / SUCCESS / OVERPAID / FAIL.
Postback (Result URL магазина) — form: InvId (= order_id), OutSum, Status, TrsId, ...,
SignatureValue = upper(md5(OutSum:InvId:API-токен)).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Optional

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://pal24.pro/api/v1"
APP_METHOD_MAP: dict[str, str] = {"sbp": "SBP", "card": "BANK_CARD"}
PAID = {"SUCCESS", "OVERPAID"}
FAILED = {"FAIL"}


class PayPalychError(GatewayError):
    pass


class PayPalychClient:
    def __init__(self, shop_id: str = "", api_token: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.shop_id = (shop_id or "").strip()
        self.api_token = (api_token or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.shop_id and self.api_token)

    def _call(self, method: str, path: str, *, body: Optional[dict[str, Any]] = None,
              params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if not self.is_configured():
            raise PayPalychError("PayPalych не настроен: укажите ID магазина и API-токен")
        headers = {"Authorization": f"Bearer {self.api_token}", "Accept": "application/json",
                   "Content-Type": "application/json"}
        data = request(method, f"{self.base_url}/{path.lstrip('/')}", headers=headers, params=params,
                       body=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
                       timeout=self.timeout, name="PayPalych", error_cls=PayPalychError)
        if not isinstance(data, dict):
            raise PayPalychError("Некорректный ответ PayPalych", payload=data)
        if str(data.get("success", "true")).lower() in ("false", "0"):
            raise PayPalychError(str(data.get("message") or data.get("error") or data), payload=data)
        return data

    def create_bill(self, *, amount_rub: float, order_id: str, method: Optional[str], description: str,
                    success_url: Optional[str] = None, fail_url: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "amount": f"{float(amount_rub):.2f}",
            "shop_id": self.shop_id,
            "order_id": str(order_id),
            "description": (description or "")[:255],
            "type": "normal",
            "currency_in": "RUB",
            "custom": str(order_id),
            "name": "BlinVPN",
        }
        if method:
            body["payment_method"] = method
        if success_url:
            body["success_url"] = success_url
        if fail_url:
            body["fail_url"] = fail_url
        data = self._call("POST", "bill/create", body=body)
        if not data.get("bill_id"):
            raise PayPalychError("PayPalych не вернул номер счёта", payload=data)
        return data

    def bill_status(self, bill_id: str) -> dict[str, Any]:
        return self._call("GET", "bill/status", params={"id": bill_id})

    def balance(self) -> dict[str, Any]:
        return self._call("GET", "merchant/balance")

    def signature(self, out_sum: str, inv_id: str) -> str:
        return hashlib.md5(f"{out_sum}:{inv_id}:{self.api_token}".encode("utf-8")).hexdigest().upper()

    def verify_postback(self, out_sum: str, inv_id: str, signature: str) -> bool:
        if not self.api_token or not signature:
            return False
        return hmac.compare_digest(self.signature(out_sum, inv_id), str(signature).strip().upper())

    @staticmethod
    def normalize_status(status: Optional[str]) -> str:
        s = (status or "").strip().upper()
        if s in PAID:
            return "paid"
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
