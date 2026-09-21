"""
Platega.io API client — платежи для BlinVPN.

Документация: https://docs.platega.io
Базовый URL: https://app.platega.io/
Авторизация: заголовки X-MerchantId и X-Secret на каждом запросе.

Эндпоинты:
  POST /transaction/process        — создать транзакцию с заданным методом
  POST /v2/transaction/process     — создать транзакцию (метод выбирает Platega)
  GET  /transaction/{id}           — статус транзакции

Callback приходит POST-ом на ваш URL с заголовками X-MerchantId / X-Secret и телом:
  { "id": <uuid>, "amount": <float>, "currency": "RUB",
    "status": "CONFIRMED" | "CANCELED", "paymentMethod": <int>, "payload": <str?> }

Env:
  PLATEGA_API_URL     (по умолчанию https://app.platega.io)
  PLATEGA_MERCHANT_ID
  PLATEGA_SECRET_KEY
  PLATEGA_RETURN_URL
  PLATEGA_FAILED_URL
"""

from __future__ import annotations

import hmac
import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────
# Способы оплаты (PaymentMethodInt)
# ─────────────────────────────────────────────────────────────

METHOD_SBP = 2            # СБП (QR-код)
METHOD_ERIP = 3           # ЕРИП
METHOD_CARD = 11          # Карточный эквайринг
METHOD_INTERNATIONAL = 12  # Международная оплата
METHOD_CRYPTO = 13        # Криптовалюта
METHOD_SBERPAY = 14       # SberPay

# Соответствие способов оплаты мини-приложения → код Platega.
APP_METHOD_MAP: dict[str, int] = {
    "sbp": METHOD_SBP,
    "card": METHOD_CARD,
    "sberpay": METHOD_SBERPAY,
    "crypto": METHOD_CRYPTO,
    "erip": METHOD_ERIP,
    "international": METHOD_INTERNATIONAL,
}

# Статусы транзакции Platega.
STATUS_PENDING = "PENDING"
STATUS_CONFIRMED = "CONFIRMED"
STATUS_CANCELED = "CANCELED"
STATUS_CHARGEBACKED = "CHARGEBACKED"


def _env(*keys: str, default: str = "") -> str:
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return default


class PlategaError(Exception):
    def __init__(self, message: str, *, status: Optional[int] = None, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class PlategaClient:
    """Синхронный клиент Platega на стандартной библиотеке (без внешних зависимостей)."""

    def __init__(
        self,
        merchant_id: Optional[str] = None,
        secret_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = (base_url or _env("PLATEGA_API_URL", default="https://app.platega.io")).rstrip("/")
        self.merchant_id = merchant_id or _env("PLATEGA_MERCHANT_ID")
        self.secret_key = secret_key or _env("PLATEGA_SECRET_KEY")
        self.timeout = timeout

    # ── configuration ────────────────────────────────────────

    def is_configured(self) -> bool:
        return bool(self.merchant_id and self.secret_key)

    def _require_config(self) -> None:
        if not self.is_configured():
            raise PlategaError(
                "Platega не настроена: задайте PLATEGA_MERCHANT_ID и PLATEGA_SECRET_KEY"
            )

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-MerchantId": self.merchant_id,
            "X-Secret": self.secret_key,
        }

    # ── low-level ────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> Any:
        self._require_config()
        if not path.startswith("/"):
            path = "/" + path
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                if not raw or resp.status == 204:
                    return None
                try:
                    return json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
            try:
                payload = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                payload = raw
            msg = None
            if isinstance(payload, dict):
                msg = payload.get("message") or payload.get("error") or payload.get("detail")
            raise PlategaError(str(msg or raw or e.reason), status=e.code, payload=payload) from e
        except urllib.error.URLError as e:
            raise PlategaError(f"Не удалось связаться с Platega ({self.base_url}): {e.reason}") from e

    # ── API ──────────────────────────────────────────────────

    def create_transaction(
        self,
        *,
        amount: float,
        method: int = METHOD_SBP,
        currency: str = "RUB",
        description: Optional[str] = None,
        return_url: Optional[str] = None,
        failed_url: Optional[str] = None,
        payload: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Создаёт транзакцию с заданным методом (POST /transaction/process).

        Возвращает словарь с полями transactionId, redirect (ссылка на оплату), status.
        """
        # Platega принимает сумму строкой, чтобы не терять копейки.
        body: dict[str, Any] = {
            "paymentMethod": int(method),
            "paymentDetails": {
                "amount": round(float(amount), 2),
                "currency": currency,
            },
        }
        if description:
            body["description"] = description
        ret = return_url or _env("PLATEGA_RETURN_URL")
        fail = failed_url or _env("PLATEGA_FAILED_URL")
        if ret:
            body["return"] = ret
        if fail:
            body["failedUrl"] = fail
        if payload:
            body["payload"] = payload
        if user_id:
            body["metadata"] = {"userId": str(user_id)}

        resp = self._request("POST", "/transaction/process", body)
        if not isinstance(resp, dict):
            raise PlategaError("Некорректный ответ Platega при создании транзакции", payload=resp)
        return resp

    def get_transaction(self, transaction_id: str) -> dict[str, Any]:
        """Статус транзакции (GET /transaction/{id})."""
        resp = self._request("GET", f"/transaction/{transaction_id}")
        if not isinstance(resp, dict):
            raise PlategaError("Некорректный ответ Platega при проверке статуса", payload=resp)
        return resp

    def cancel_supported(self, transaction_id: str) -> dict[str, Any]:
        """
        Можно ли отменить/вернуть транзакцию (GET /transaction/{id}/cancel-supported).
        Возвращает {supported, totalDeductUsdt, penaltyNativeAmount, ..., blockReason}.
        """
        resp = self._request("GET", f"/transaction/{transaction_id}/cancel-supported")
        if not isinstance(resp, dict):
            raise PlategaError("Некорректный ответ Platega при проверке возможности отмены", payload=resp)
        return resp

    def cancel_transaction(self, transaction_id: str) -> dict[str, Any]:
        """
        Отмена/возврат транзакции (POST /transaction/{id}/cancel).
        Возвращает {transactionId, accepted, manualControlRequired, message}.
        """
        resp = self._request("POST", f"/transaction/{transaction_id}/cancel")
        if not isinstance(resp, dict):
            raise PlategaError("Некорректный ответ Platega при отмене транзакции", payload=resp)
        return resp

    # ── callback verification ────────────────────────────────

    def verify_callback(self, merchant_id: Optional[str], secret: Optional[str]) -> bool:
        """
        Проверяет подлинность callback по заголовкам X-MerchantId / X-Secret.
        Сравнение в постоянном времени.
        """
        if not self.is_configured():
            return False
        ok_merchant = hmac.compare_digest(str(merchant_id or ""), self.merchant_id)
        ok_secret = hmac.compare_digest(str(secret or ""), self.secret_key)
        return ok_merchant and ok_secret

    @staticmethod
    def normalize_status(status: Optional[str]) -> str:
        """CONFIRMED → paid, CANCELED → failed, CHARGEBACKED → refunded, иначе pending."""
        s = (status or "").upper()
        if s == STATUS_CONFIRMED:
            return "paid"
        if s == STATUS_CANCELED:
            return "failed"
        if s == STATUS_CHARGEBACKED:
            return "refunded"
        return "pending"


def get_client() -> PlategaClient:
    """Клиент из переменных окружения."""
    return PlategaClient()
