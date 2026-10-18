"""
2328 — криптовалюта (https://2328.io/ru/api, API: https://api.2328.io/api).

Аутентификация — заголовки project (UUID проекта) и sign = hex(HMAC-SHA256(API-ключ, base64(тело JSON))),
для запросов без тела подписывается пустая строка. Тело — компактный JSON без экранирования юникода.
Счёт: POST /v1/payment {amount, currency RUB, order_id, url_callback, url_return, url_success, description, ttl_seconds}
→ result {uuid, url, ...}; монету и сеть покупатель выбирает на странице оплаты.
Статус: POST /v1/payment/info {uuid | order_id} → result {payment_status, amount, currency, order_id, ...}.
Вебхук: JSON с полем sign (та же подпись тела без sign). Возврат — только в кабинете 2328.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any, Optional

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://api.2328.io/api"
PAID = {"paid", "overpaid"}
FAILED = {"cancel", "canceled", "cancelled", "fail", "failed"}
REFUNDED = {"refund_paid"}
USER_AGENT = "BlinVPN/1.0 (+payments)"


class Pay2328Error(GatewayError):
    pass


def _encode(payload: Any, *, escape_slashes: bool = False) -> str:
    s = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return s.replace("/", "\\/") if escape_slashes else s


def _sign(body: str, key: str) -> str:
    b64 = base64.b64encode(body.encode("utf-8")).decode()
    return hmac.new(key.encode("utf-8"), b64.encode("utf-8"), hashlib.sha256).hexdigest()


class Pay2328Client:
    def __init__(self, project_id: str = "", api_key: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.project_id = (project_id or "").strip()
        self.api_key = (api_key or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.project_id and self.api_key)

    def _call(self, method: str, path: str, payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if not self.is_configured():
            raise Pay2328Error("2328 не настроен: укажите UUID проекта и API-ключ")
        body = _encode(payload) if payload is not None else ""
        headers = {"project": self.project_id, "sign": _sign(body, self.api_key), "User-Agent": USER_AGENT,
                   "Content-Type": "application/json", "Accept": "application/json"}
        data = request(method, f"{self.base_url}{path}", headers=headers, body=body.encode("utf-8") if body else None,
                       timeout=self.timeout, name="2328", error_cls=Pay2328Error)
        if not isinstance(data, dict):
            raise Pay2328Error("Некорректный ответ 2328", payload=data)
        if data.get("state") not in (0, "0", None):
            msg = data.get("message") or data.get("errors") or data
            raise Pay2328Error(json.dumps(msg, ensure_ascii=False) if isinstance(msg, (dict, list)) else str(msg),
                               payload=data)
        return data

    def create_invoice(self, *, amount_rub: float, order_id: str, callback_url: str,
                       return_url: Optional[str] = None, success_url: Optional[str] = None,
                       description: Optional[str] = None, ttl_seconds: int = 3600) -> dict[str, Any]:
        payload: dict[str, Any] = {"amount": f"{float(amount_rub):.2f}", "currency": "RUB", "order_id": str(order_id),
                                   "url_callback": callback_url, "ttl_seconds": int(ttl_seconds)}
        if return_url:
            payload["url_return"] = return_url
        if success_url:
            payload["url_success"] = success_url
        if description:
            payload["description"] = description[:500]
        res = self._call("POST", "/v1/payment", payload).get("result") or {}
        if not res.get("uuid") or not res.get("url"):
            raise Pay2328Error("2328 не вернул ссылку на оплату", payload=res)
        return res

    def payment_info(self, *, uuid: Optional[str] = None, order_id: Optional[str] = None) -> dict[str, Any]:
        payload = {"uuid": uuid} if uuid else {"order_id": order_id}
        return self._call("POST", "/v1/payment/info", payload).get("result") or {}

    def balance(self) -> Any:
        return self._call("GET", "/v1/balance").get("result")

    def verify_webhook(self, payload: dict[str, Any]) -> bool:
        sig = str(payload.get("sign") or "").strip().lower()
        if not sig or not self.api_key:
            return False
        data = {k: v for k, v in payload.items() if k != "sign"}
        for esc in (False, True):
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
        return "pending"  # check / awaiting_confirmation / underpaid* / aml_lock — ждём


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    if str(data.get("currency") or "RUB").upper() != "RUB":
        return None
    try:
        return float(data.get("amount"))
    except (TypeError, ValueError):
        return None


def matches(data: dict[str, Any], payment_id: str) -> bool:
    oid = data.get("order_id")
    return not oid or str(oid) == str(payment_id)
