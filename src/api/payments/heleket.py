"""
Heleket — криптовалюта (https://doc.heleket.com/ru, API: https://api.heleket.com/v1).

Аутентификация — заголовки merchant (UUID мерчанта) и sign = md5(base64(тело JSON) + платёжный API-ключ).
Счёт: POST /payment {amount, currency RUB, order_id, url_callback, url_return, url_success, lifetime}
→ result {uuid, url, ...}; покупатель выбирает монету и сеть на странице Heleket.
Статус: POST /payment/info {uuid | order_id} → result {status, amount, currency, order_id, is_final}.
Вебхук: JSON с полем sign = md5(base64(json без sign, слэши экранированы как в PHP) + API-ключ),
приходит с 31.133.220.8. Возврат крипты требует адрес кошелька — только вручную в кабинете.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any, Optional

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://api.heleket.com/v1"
WEBHOOK_IP = "31.133.220.8"
PAID = {"paid", "paid_over"}
FAILED = {"cancel", "fail", "system_fail"}
REFUNDED = {"refund_paid"}


class HeleketError(GatewayError):
    pass


def _encode(payload: Any, *, escape_slashes: bool = True, ascii_: bool = False) -> str:
    """JSON как у PHP json_encode: компактно, слэши экранированы."""
    s = json.dumps(payload, ensure_ascii=ascii_, separators=(",", ":"))
    return s.replace("/", "\\/") if escape_slashes else s


def _sign(body: str, key: str) -> str:
    return hashlib.md5((base64.b64encode(body.encode("utf-8")).decode() + key).encode("utf-8")).hexdigest()


class HeleketClient:
    def __init__(self, merchant_id: str = "", api_key: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.merchant_id = (merchant_id or "").strip()
        self.api_key = (api_key or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.merchant_id and self.api_key)

    def _post(self, path: str, payload: Optional[dict[str, Any]]) -> dict[str, Any]:
        if not self.is_configured():
            raise HeleketError("Heleket не настроен: укажите UUID мерчанта и API-ключ")
        body = _encode(payload) if payload is not None else ""
        headers = {"merchant": self.merchant_id, "sign": _sign(body, self.api_key),
                   "Content-Type": "application/json", "Accept": "application/json"}
        data = request("POST", f"{self.base_url}{path}", headers=headers, body=body.encode("utf-8") if body else None,
                       timeout=self.timeout, name="Heleket", error_cls=HeleketError)
        if not isinstance(data, dict):
            raise HeleketError("Некорректный ответ Heleket", payload=data)
        if data.get("state") not in (0, "0", None):
            msg = data.get("message") or data.get("errors") or data
            raise HeleketError(json.dumps(msg, ensure_ascii=False) if isinstance(msg, (dict, list)) else str(msg),
                               payload=data)
        return data

    def create_invoice(self, *, amount_rub: float, order_id: str, callback_url: Optional[str],
                       return_url: Optional[str] = None, success_url: Optional[str] = None,
                       lifetime: int = 3600) -> dict[str, Any]:
        payload: dict[str, Any] = {"amount": f"{float(amount_rub):.2f}", "currency": "RUB", "order_id": str(order_id),
                                   "lifetime": int(lifetime)}
        if callback_url:
            payload["url_callback"] = callback_url
        if return_url:
            payload["url_return"] = return_url
        if success_url:
            payload["url_success"] = success_url
        res = self._post("/payment", payload).get("result") or {}
        if not res.get("uuid") or not res.get("url"):
            raise HeleketError("Heleket не вернул ссылку на оплату", payload=res)
        return res

    def payment_info(self, *, uuid: Optional[str] = None, order_id: Optional[str] = None) -> dict[str, Any]:
        payload = {"uuid": uuid} if uuid else {"order_id": order_id}
        return self._post("/payment/info", payload).get("result") or {}

    def balance(self) -> Any:
        return self._post("/balance", None).get("result")

    def verify_webhook(self, payload: dict[str, Any]) -> bool:
        sig = str(payload.get("sign") or "")
        if not sig or not self.api_key:
            return False
        data = {k: v for k, v in payload.items() if k != "sign"}
        for esc in (True, False):
            if hmac.compare_digest(_sign(_encode(data, escape_slashes=esc), self.api_key), sig):
                return True
        return False

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


def status_of(data: dict[str, Any]) -> str:
    return str(data.get("status") or data.get("payment_status") or "")


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    """сумма счёта в рублях (счёт выставляется в RUB, монету выбирает покупатель)."""
    if str(data.get("currency") or "RUB").upper() != "RUB":
        return None
    try:
        return float(data.get("amount"))
    except (TypeError, ValueError):
        return None


def matches(data: dict[str, Any], payment_id: str) -> bool:
    oid = data.get("order_id")
    return not oid or str(oid) == str(payment_id)
