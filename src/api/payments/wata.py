"""
WATA (https://api.wata.pro/, API: https://api.wata.pro/api/h2h).

Аутентификация — Authorization: Bearer <токен терминала>.
Ссылка на оплату: POST /links {amount, currency, description, orderId, successRedirectUrl, failRedirectUrl,
expirationDateTime} → id, url (покупатель сам выбирает карту / СБП / T-Pay).
Транзакции: GET /v2/transactions?OrderId=... → items[{id, status Created/Pending/Paid/Declined, amount, kind}].
Возврат: POST /transactions/refunds {originalTransactionId, amount} → transactionStatus.
Вебхук: тело JSON {transactionId, transactionStatus, kind, amount, orderId, paymentLinkId, ...},
заголовок X-Signature = base64(RSA-SHA512 подпись тела), публичный ключ — GET /public-key.
GET-запросы ограничены (1 раз в 45 с на объект) — поэтому подписанному вебхуку доверяем без перезапроса.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from payments._http import GatewayError, request

DEFAULT_API_URL = "https://api.wata.pro/api/h2h"
LINK_TTL_MIN = 60  # WATA требует срок жизни ссылки больше 10 минут
_KEY_TTL = 3600
_FORCE_MIN_INTERVAL = 60.0

_key_cache: dict[str, tuple[float, str]] = {}
_key_lock = threading.Lock()


class WataError(GatewayError):
    pass


class WataClient:
    def __init__(self, access_token: str = "", *, base_url: str = "", timeout: float = 30.0) -> None:
        self.access_token = (access_token or "").strip()
        self.base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        self.timeout = timeout

    def is_configured(self) -> bool:
        return bool(self.access_token)

    def _call(self, method: str, path: str, body: Optional[dict[str, Any]] = None,
              params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if not self.access_token:
            raise WataError("WATA не настроена: укажите токен терминала")
        headers = {"Authorization": f"Bearer {self.access_token}", "Accept": "application/json",
                   "Content-Type": "application/json"}
        data = request(method, f"{self.base_url}{path}", headers=headers, params=params,
                       body=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
                       timeout=self.timeout, name="WATA", error_cls=WataError)
        if not isinstance(data, dict):
            raise WataError("Некорректный ответ WATA", payload=data)
        return data

    def create_link(self, *, amount_rub: float, order_id: str, description: str,
                    success_url: Optional[str] = None, fail_url: Optional[str] = None) -> dict[str, Any]:
        expires = datetime.now(timezone.utc) + timedelta(minutes=LINK_TTL_MIN)
        body: dict[str, Any] = {
            "amount": round(float(amount_rub), 2),
            "currency": "RUB",
            "description": (description or "")[:255],
            "orderId": str(order_id),
            "type": "OneTime",
            "expirationDateTime": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if success_url:
            body["successRedirectUrl"] = success_url
        if fail_url:
            body["failRedirectUrl"] = fail_url
        data = self._call("POST", "/links", body)
        if not data.get("id") or not data.get("url"):
            raise WataError("WATA не вернула ссылку на оплату", payload=data)
        return data

    def transactions(self, order_id: str) -> list[dict[str, Any]]:
        data = self._call("GET", "/v2/transactions", params={"OrderId": order_id, "MaxResultCount": 20})
        items = data.get("items")
        return [x for x in items if isinstance(x, dict)] if isinstance(items, list) else []

    def refund(self, transaction_id: str, amount_rub: float) -> dict[str, Any]:
        return self._call("POST", "/transactions/refunds",
                          {"originalTransactionId": transaction_id, "amount": round(float(amount_rub), 2)})

    def balance(self) -> dict[str, Any]:
        return self._call("GET", "/finance/balance", params={"Date": datetime.now(timezone.utc).strftime("%Y-%m-%d")})

    # ── вебхук ──
    def public_key(self, force: bool = False) -> str:
        with _key_lock:
            cached = _key_cache.get(self.base_url)
            # принудительное обновление — не чаще раза в минуту: поток поддельных вебхуков
            # не должен превращаться в поток запросов к WATA
            if cached and (not force or time.time() - cached[0] < _FORCE_MIN_INTERVAL) \
                    and time.time() - cached[0] < _KEY_TTL:
                return cached[1]
        data = request("GET", f"{self.base_url}/public-key", headers={"Accept": "application/json"},
                       timeout=self.timeout, name="WATA", error_cls=WataError)
        key = str((data or {}).get("value") or "") if isinstance(data, dict) else ""
        if not key:
            raise WataError("WATA не вернула публичный ключ", payload=data)
        with _key_lock:
            _key_cache[self.base_url] = (time.time(), key)
        return key

    def verify_webhook(self, raw_body: bytes, signature: Optional[str]) -> bool:
        if not signature:
            return False
        try:
            sig = base64.b64decode(signature.strip())
        except ValueError:
            return False
        for force in (False, True):  # ключ мог смениться — второй раз берём свежий
            try:
                if _rsa_verify(self.public_key(force=force), sig, raw_body):
                    return True
            except WataError:
                return False
        return False


def _rsa_verify(pem: str, sig: bytes, data: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    if "BEGIN" not in pem:
        pem = "-----BEGIN PUBLIC KEY-----\n" + pem.strip() + "\n-----END PUBLIC KEY-----"
    try:
        key = serialization.load_pem_public_key(pem.encode("utf-8"))
        key.verify(sig, data, padding.PKCS1v15(), hashes.SHA512())  # type: ignore[union-attr]
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def normalize_status(status: Optional[str]) -> str:
    s = (status or "").strip().lower()
    if s == "paid":
        return "paid"
    if s == "declined":
        return "failed"
    return "pending"


def paid_payment(items: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """оплаченная транзакция-платёж (не возврат)."""
    for t in items:
        if str(t.get("kind") or "Payment").lower() == "payment" and str(t.get("status") or "").lower() == "paid":
            return t
    return None


def refunded(items: list[dict[str, Any]]) -> bool:
    return any(str(t.get("kind") or "").lower() == "refund" and str(t.get("status") or "").lower() == "paid"
               for t in items)


def amount_rub(data: dict[str, Any]) -> Optional[float]:
    try:
        return float(data.get("amount"))
    except (TypeError, ValueError):
        return None
