"""
cisPay Merchant API (https://cispay.app/developers, API: https://api.cispay.app).

Аутентификация — заголовки X-Shop-ID (UUID магазина) и X-Api-Key (cis_sec_...).
Все суммы в копейках, валюта RUB. Минимум: карта 50 ₽, СБП без ограничения.
Вебхук подписан HMAC-SHA256 от сырого тела запроса ключом X-Api-Key, подпись — в X-Signature (hex).
Статусы: PENDING, PAID, FAILED, EXPIRED (не оплачен за 30 мин), REFUNDED.
is_sandbox = true — тестовый платёж из Песочницы или заблокированный покупатель: денег нет.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

DEFAULT_API_URL = "https://api.cispay.app"

# способы оплаты cisPay
METHOD_SBP = "SBP"
METHOD_CARD = "CARD"
APP_METHOD_MAP: dict[str, str] = {"sbp": METHOD_SBP, "card": METHOD_CARD}
# минимальная сумма, ₽ (по документации cisPay)
MIN_RUB: dict[str, float] = {"card": 50.0, "sbp": 1.0}

# статусы платежа
STATUS_PENDING = "PENDING"
STATUS_PAID = "PAID"
STATUS_FAILED = "FAILED"
STATUS_EXPIRED = "EXPIRED"
STATUS_REFUNDED = "REFUNDED"


class CisPayError(Exception):
    def __init__(self, message: str, *, status: Optional[int] = None, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class CisPayClient:
    def __init__(self, shop_id: str = "", api_key: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.shop_id = (shop_id or "").strip()
        self.api_key = (api_key or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.shop_id and self.api_key)

    def _request(self, method: str, path: str, *, body: Optional[dict[str, Any]] = None,
                 params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if not self.is_configured():
            raise CisPayError("cisPay не настроена: укажите Shop ID и API-ключ")
        url = f"{self.base_url}/{path.lstrip('/')}"
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            method=method.upper(),
            headers={
                "X-Shop-ID": self.shop_id,
                "X-Api-Key": self.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace") if e.fp else ""
            try:
                payload: Any = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                payload = raw
            msg = None
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("message") or payload.get("error")
                msg = json.dumps(detail, ensure_ascii=False) if isinstance(detail, (dict, list)) else detail
            raise CisPayError(str(msg or raw or e.reason), status=e.code, payload=payload) from e
        except urllib.error.URLError as e:
            raise CisPayError(f"Не удалось связаться с cisPay ({self.base_url}): {e.reason}") from e
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError as e:
            raise CisPayError("Некорректный ответ cisPay", payload=raw) from e
        return data if isinstance(data, dict) else {"_raw": data}

    # создание платежа: ответ — id, status=PENDING, payment_url (страница оплаты cisPay)
    def create_payment(
        self,
        *,
        amount_kopeks: int,
        order_id: str,
        method: str = METHOD_SBP,
        customer_id: str,
        description: Optional[str] = None,
        success_url: Optional[str] = None,
        fail_url: Optional[str] = None,
        currency: str = "RUB",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "amount": int(amount_kopeks),
            "currency": currency,
            # order_id уникален в магазине; payload вернётся эхом в статусе и вебхуке
            "order_id": str(order_id),
            "payload": str(order_id),
            "payment_method": method,
            # для СБП провайдер требует идентификатор плательщика
            "customer_id": str(customer_id)[:255],
        }
        if description:
            body["description"] = description[:512]
        if success_url:
            body["redirect_success_url"] = success_url[:1024]
        if fail_url:
            body["redirect_fail_url"] = fail_url[:1024]
        data = self._request("POST", "/payments", body=body)
        if not data.get("id"):
            raise CisPayError("cisPay не вернул id платежа", payload=data)
        return data

    # статус платежа: PENDING / PAID / FAILED / EXPIRED / REFUNDED
    def get_payment(self, payment_id: Optional[str] = None, order_id: Optional[str] = None) -> dict[str, Any]:
        if not payment_id and not order_id:
            raise CisPayError("нужен id платежа или order_id")
        params = {"id": payment_id} if payment_id else {"order_id": order_id}
        return self._request("GET", "/payments/status", params=params)

    # полный возврат оплаченного платежа (необратимо): confirm_amount = charged_amount в копейках
    def refund(self, payment_id: str, confirm_amount_kopeks: int) -> dict[str, Any]:
        return self._request("POST", "/payments/refund", params={"id": payment_id},
                             body={"confirm_amount": int(confirm_amount_kopeks)})

    # магазин и способы оплаты: {is_active, payment_methods: [{payment_method, is_active, ...}]}
    def capabilities(self) -> dict[str, Any]:
        return self._request("GET", "/store/capabilities")

    def balance(self) -> dict[str, Any]:
        return self._request("GET", "/balance")

    def verify_signature(self, raw_body: bytes, signature: Optional[str]) -> bool:
        """X-Signature = hex(HMAC-SHA256(api_key, сырое тело))."""
        sig = (signature or "").strip().lower()
        if not sig or not self.api_key:
            return False  # без ключа подпись подделал бы кто угодно
        expected = hmac.new(self.api_key.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig)

    @staticmethod
    def normalize_status(status: Optional[str]) -> str:
        s = (status or "").strip().upper()
        if s == STATUS_PAID:
            return "paid"
        if s in (STATUS_FAILED, STATUS_EXPIRED):
            return "failed"
        if s == STATUS_REFUNDED:
            return "refunded"
        return "pending"


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    """сумма платежа cisPay в рублях (API отдаёт копейки)."""
    try:
        v = data.get("amount")
        return None if v is None else int(v) / 100.0
    except (TypeError, ValueError):
        return None


def matches(data: dict[str, Any], payment_id: str) -> bool:
    """платёж cisPay создан для нашего платежа (order_id и payload = наш payment_id)."""
    oid, pl = data.get("order_id"), data.get("payload")
    return (not oid or str(oid) == str(payment_id)) and (not pl or str(pl) == str(payment_id))


def is_test(data: dict[str, Any]) -> bool:
    """песочница или заблокированный покупатель — реальных денег нет."""
    return bool(data.get("is_sandbox")) or bool(data.get("block_reason"))


def active_methods(caps: dict[str, Any]) -> list[str]:
    """активные способы магазина из /store/capabilities: ['SBP', 'CARD', ...]."""
    out = []
    for m in caps.get("payment_methods") or []:
        if isinstance(m, dict) and m.get("is_active") and m.get("payment_method"):
            out.append(str(m["payment_method"]))
    return out
