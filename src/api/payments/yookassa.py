"""
ЮKassa API v3 (https://yookassa.ru/developers).

Аутентификация — HTTP Basic: shopId : секретный ключ. Каждый POST несёт
заголовок Idempotence-Key (повтор с тем же ключом не создаст второй платёж).
Сумма — строкой в рублях: {"value": "99.00", "currency": "RUB"}.
Статусы платежа: pending, waiting_for_capture, succeeded, canceled.
Уведомления (HTTP-уведомления в кабинете) приходят без подписи: проверяем IP
отправителя и перезапрашиваем объект через API.
"""

from __future__ import annotations

import base64
import ipaddress
import json
from typing import Any, Optional

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://api.yookassa.ru/v3"
APP_METHOD_MAP: dict[str, str] = {"sbp": "sbp", "card": "bank_card"}
MIN_RUB: dict[str, float] = {"sbp": 1.0, "card": 1.0}
# адреса, с которых ЮKassa шлёт уведомления (документация «Входящие уведомления»)
NOTIFY_NETS = [ipaddress.ip_network(n) for n in (
    "185.71.76.0/27", "185.71.77.0/27", "77.75.153.0/25", "77.75.156.11/32", "77.75.156.35/32",
    "77.75.154.128/25", "2a02:5180::/32",
)]


class YooKassaError(GatewayError):
    pass


def amount_obj(rub: float) -> dict[str, str]:
    return {"value": f"{float(rub):.2f}", "currency": "RUB"}


class YooKassaClient:
    def __init__(self, shop_id: str = "", secret_key: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.shop_id = (shop_id or "").strip()
        self.secret_key = (secret_key or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.shop_id and self.secret_key)

    def _call(self, method: str, path: str, body: Optional[dict[str, Any]] = None,
              idempotence_key: Optional[str] = None) -> dict[str, Any]:
        if not self.is_configured():
            raise YooKassaError("ЮKassa не настроена: укажите shopId и секретный ключ")
        token = base64.b64encode(f"{self.shop_id}:{self.secret_key}".encode()).decode()
        headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json", "Accept": "application/json"}
        if idempotence_key:
            headers["Idempotence-Key"] = idempotence_key[:64]
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        res = request(method, f"{self.base_url}{path}", headers=headers, body=data, timeout=self.timeout,
                      name="ЮKassa", error_cls=YooKassaError)
        return res if isinstance(res, dict) else {}

    # создание платежа с редиректом на страницу ЮKassa
    def create_payment(
        self,
        *,
        amount_rub: float,
        order_id: str,
        method: Optional[str],
        description: str,
        return_url: Optional[str],
        receipt: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "amount": amount_obj(amount_rub),
            "capture": True,
            "confirmation": {"type": "redirect", "return_url": return_url or "https://yookassa.ru"},
            "description": (description or "")[:128],
            "metadata": {"payment_id": str(order_id)},
        }
        if method:
            body["payment_method_data"] = {"type": method}
        if receipt:
            body["receipt"] = receipt
        data = self._call("POST", "/payments", body, idempotence_key=f"pay-{order_id}")
        if not data.get("id"):
            raise YooKassaError("ЮKassa не вернула id платежа", payload=data)
        return data

    def get_payment(self, payment_id: str) -> dict[str, Any]:
        return self._call("GET", f"/payments/{payment_id}")

    # подтвердить платёж в статусе waiting_for_capture (при capture=true обычно не нужно)
    def capture(self, payment_id: str, amount_rub: float) -> dict[str, Any]:
        return self._call("POST", f"/payments/{payment_id}/capture", {"amount": amount_obj(amount_rub)},
                          idempotence_key=f"cap-{payment_id}")

    # полный возврат; при включённых чеках нужен чек возврата
    def refund(self, payment_id: str, amount_rub: float, receipt: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"payment_id": payment_id, "amount": amount_obj(amount_rub)}
        if receipt:
            body["receipt"] = receipt
        return self._call("POST", "/refunds", body, idempotence_key=f"ref-{payment_id}")

    # информация о магазине: test, fiscalization_enabled, payment_methods, status
    def me(self) -> dict[str, Any]:
        return self._call("GET", "/me")

    @staticmethod
    def normalize_status(status: Optional[str]) -> str:
        s = (status or "").lower()
        if s == "succeeded":
            return "paid"
        if s == "canceled":
            return "failed"
        if s == "waiting_for_capture":
            return "capture"
        return "pending"


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    try:
        return float(((data.get("amount") or {}).get("value")))
    except (TypeError, ValueError):
        return None


def matches(data: dict[str, Any], payment_id: str) -> bool:
    pid = (data.get("metadata") or {}).get("payment_id")
    return not pid or str(pid) == str(payment_id)


def ip_allowed(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False
    return any(addr in net for net in NOTIFY_NETS)


def receipt_for(*, email: Optional[str], phone: Optional[str], description: str, amount_rub: float,
                vat_code: int = 1, tax_system_code: Optional[int] = None) -> dict[str, Any]:
    """чек 54-ФЗ: одна позиция-услуга на всю сумму."""
    customer: dict[str, str] = {}
    if email:
        customer["email"] = email
    elif phone:
        customer["phone"] = phone
    receipt: dict[str, Any] = {
        "customer": customer,
        "items": [{
            "description": (description or "Подписка")[:128],
            "quantity": 1,
            "amount": amount_obj(amount_rub),
            "vat_code": int(vat_code),
            "payment_mode": "full_payment",
            "payment_subject": "service",
        }],
    }
    if tax_system_code:
        receipt["tax_system_code"] = int(tax_system_code)
    return receipt
