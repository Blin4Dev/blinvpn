# единый вход ко всем платёжкам с оплатой в рублях: создать ссылку, узнать статус, вернуть деньги.
# core.py (создание платежа, возвраты), fulfillment.py (фоновая сверка) и вебхуки работают через него.
from __future__ import annotations

from typing import Any, Optional

try:
    from . import payments_config  # type: ignore
except ImportError:  # pragma: no cover
    import payments_config  # type: ignore

from payments import cispay, heleket, lava, pay2328, paypalych, platega, rollypay, wata, yookassa  # noqa: E402

# платёжки, у которых статус можно перепроверить по API
VERIFIABLE = ("platega", "cispay", "yookassa", "lava", "paypalych", "rollypay", "wata", "heleket", "pay2328")
# возврат денег через API платёжки
API_REFUND = ("cispay", "yookassa", "wata")


class RefundError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# ── создание ─────────────────────────────────────────────────────

def create(provider: str, *, method: str, payment_id: str, charge: float, description: str,
           return_url: Optional[str], failed_url: Optional[str], customer: str,
           user: Optional[dict[str, Any]] = None) -> dict[str, str]:
    """ссылка на оплату → {txn: id у платёжки, pay_url}."""
    if provider == "cispay":
        data = payments_config.cispay_client().create_payment(
            amount_kopeks=int(round(float(charge) * 100)), order_id=payment_id,
            method=cispay.APP_METHOD_MAP.get(method, cispay.METHOD_SBP), customer_id=customer,
            description=description, success_url=return_url, fail_url=failed_url,
        )
        if not data.get("payment_url"):
            raise cispay.CisPayError("cisPay не вернул ссылку на оплату", payload=data)
        return {"txn": str(data.get("id") or ""), "pay_url": data["payment_url"]}

    if provider == "yookassa":
        receipt = None
        if payments_config.yookassa_fiscal():
            o = payments_config.yookassa_receipt_opts()
            receipt = yookassa.receipt_for(
                email=(user or {}).get("email") or o["email"] or None, phone=None,
                description=description, amount_rub=charge, vat_code=o["vat_code"],
                tax_system_code=o["tax_system_code"],
            )
        data = payments_config.yookassa_client().create_payment(
            amount_rub=charge, order_id=payment_id, method=yookassa.APP_METHOD_MAP.get(method),
            description=description, return_url=return_url, receipt=receipt,
        )
        url = (data.get("confirmation") or {}).get("confirmation_url")
        if not url:
            raise yookassa.YooKassaError("ЮKassa не вернула ссылку на оплату", payload=data)
        return {"txn": str(data["id"]), "pay_url": url}

    if provider == "lava":
        inv = payments_config.lava_client().create_invoice(
            amount_rub=charge, order_id=payment_id, hook_url=payments_config.webhook_url("lava") or None,
            success_url=return_url, fail_url=failed_url, comment=description,
        )
        return {"txn": str(inv["id"]), "pay_url": inv["url"]}

    if provider == "paypalych":
        data = payments_config.paypalych_client().create_bill(
            amount_rub=charge, order_id=payment_id, method=paypalych.APP_METHOD_MAP.get(method),
            description=description, success_url=return_url, fail_url=failed_url,
        )
        url = data.get("link_page_url") or data.get("link_url")
        if not url:
            raise paypalych.PayPalychError("PayPalych не вернул ссылку на оплату", payload=data)
        return {"txn": str(data["bill_id"]), "pay_url": url}

    if provider == "rollypay":
        data = payments_config.rollypay_client().create_payment(
            amount_rub=charge, order_id=payment_id, method=rollypay.APP_METHOD_MAP.get(method),
            description=description, success_url=return_url, fail_url=failed_url, customer_id=customer,
        )
        return {"txn": str(data["payment_id"]), "pay_url": data["pay_url"]}

    if provider == "wata":
        data = payments_config.wata_client().create_link(
            amount_rub=charge, order_id=payment_id, description=description,
            success_url=return_url, fail_url=failed_url,
        )
        return {"txn": str(data["id"]), "pay_url": data["url"]}

    if provider == "heleket":
        data = payments_config.heleket_client().create_invoice(
            amount_rub=charge, order_id=payment_id, callback_url=payments_config.webhook_url("heleket") or None,
            return_url=failed_url, success_url=return_url,
        )
        return {"txn": str(data["uuid"]), "pay_url": data["url"]}

    if provider == "pay2328":
        hook = payments_config.webhook_url("pay2328")
        if not hook:
            raise pay2328.Pay2328Error("Не задан домен вебхуков (WEBHOOK_URL в .env панели) — 2328 требует url_callback")
        data = payments_config.pay2328_client().create_invoice(
            amount_rub=charge, order_id=payment_id, callback_url=hook,
            return_url=failed_url, success_url=return_url, description=description,
        )
        return {"txn": str(data["uuid"]), "pay_url": data["url"]}

    # platega
    tx = payments_config.platega_client().create_transaction(
        amount=float(charge), method=platega.APP_METHOD_MAP.get(method, platega.METHOD_SBP), currency="RUB",
        description=description, return_url=return_url, failed_url=failed_url, payload=payment_id, user_id=customer,
    )
    txn = tx.get("transactionId") or tx.get("id")
    return {"txn": str(txn) if txn else "", "pay_url": tx.get("redirect") or tx.get("url")}


# ── статус ───────────────────────────────────────────────────────

def status(payment: dict[str, Any]) -> tuple[str, Optional[float], bool]:
    """(paid | failed | refunded | pending, сумма в ₽, создан ли платёж у платёжки для нашего)."""
    provider = payment.get("provider")
    pid = str(payment.get("provider_payment_id") or "")
    our = str(payment["payment_id"])
    if provider not in VERIFIABLE or not payments_config.configured(provider):
        return "pending", None, True

    if provider == "cispay":
        data = payments_config.cispay_client().get_payment(payment_id=pid) if pid \
            else payments_config.cispay_client().get_payment(order_id=our)
        norm = cispay.CisPayClient.normalize_status(data.get("status"))
        if cispay.is_test(data) and norm == "paid":
            norm = "failed"  # песочница / заблокированный покупатель — денег нет
        return norm, cispay.amount_rub(data), cispay.matches(data, our)

    if provider == "yookassa":
        cl = payments_config.yookassa_client()
        data = cl.get_payment(pid)
        norm = yookassa.YooKassaClient.normalize_status(data.get("status"))
        if norm == "capture":
            # создаём с capture=true, но если магазин настроен на двухстадийную оплату — подтверждаем
            amt = yookassa.amount_rub(data)
            if amt is not None and yookassa.matches(data, our):
                data = cl.capture(pid, amt)
                norm = yookassa.YooKassaClient.normalize_status(data.get("status"))
            if norm == "capture":
                norm = "pending"
        if str(data.get("status")) == "succeeded" and (data.get("refunded_amount") or {}).get("value") not in (None, "0.00"):
            norm = "refunded"
        return norm, yookassa.amount_rub(data), yookassa.matches(data, our)

    if provider == "lava":
        data = payments_config.lava_client().invoice_status(invoice_id=pid or None, order_id=None if pid else our)
        return lava.LavaClient.normalize_status(data.get("status")), lava.amount_rub(data), lava.matches(data, our)

    if provider == "paypalych":
        data = payments_config.paypalych_client().bill_status(pid)
        return (paypalych.PayPalychClient.normalize_status(data.get("status")), paypalych.amount_rub(data),
                paypalych.matches(data, our))

    if provider == "rollypay":
        data = payments_config.rollypay_client().get_payment(pid)
        return (rollypay.RollyPayClient.normalize_status(data.get("status")), rollypay.amount_rub(data),
                rollypay.matches(data, our))

    if provider == "wata":
        items = payments_config.wata_client().transactions(our)
        if wata.refunded(items):
            t = wata.paid_payment(items) or {}
            return "refunded", wata.amount_rub(t), True
        t = wata.paid_payment(items)
        if t:
            return "paid", wata.amount_rub(t), str(t.get("orderId") or our) == our
        return "pending", None, True  # отказ по карте не финал: покупатель может оплатить ссылку ещё раз

    if provider == "heleket":
        cl = payments_config.heleket_client()
        data = cl.payment_info(uuid=pid) if pid else cl.payment_info(order_id=our)
        return (heleket.HeleketClient.normalize_status(heleket.status_of(data)), heleket.amount_rub(data),
                heleket.matches(data, our))

    if provider == "pay2328":
        cl = payments_config.pay2328_client()
        data = cl.payment_info(uuid=pid) if pid else cl.payment_info(order_id=our)
        return (pay2328.Pay2328Client.normalize_status(data.get("payment_status")), pay2328.amount_rub(data),
                pay2328.matches(data, our))

    # platega
    tx = payments_config.platega_client().get_transaction(pid)
    return platega.PlategaClient.normalize_status(tx.get("status")), platega.tx_amount(tx), platega.tx_matches(tx, our)


# ── возврат (только платёжки с возвратом через API) ──────────────

def refund_check(payment: dict[str, Any]) -> dict[str, Any]:
    """можно ли вернуть прямо сейчас: {supported, kind, amount?, blockReason?}."""
    provider = payment.get("provider")
    if provider == "cispay":
        data = _cispay_paid(payment)
        return {"supported": True, "kind": "cispay", "amount": int(data["charged_amount"]) / 100.0}
    if provider == "yookassa":
        data = payments_config.yookassa_client().get_payment(str(payment["provider_payment_id"]))
        if data.get("status") != "succeeded":
            raise RefundError(f"У ЮKassa платёж в статусе {data.get('status')} — вернуть нельзя", 400)
        return {"supported": True, "kind": "yookassa", "amount": yookassa.amount_rub(data)}
    if provider == "wata":
        t = _wata_paid(payment)
        return {"supported": True, "kind": "wata", "amount": wata.amount_rub(t)}
    if provider in payments_config.PAID_PROVIDERS and provider not in API_REFUND:
        label = payments_config.PROVIDER_LABEL[provider]
        return {"supported": False, "blockReason": f"{label} не делает возврат через API — верните деньги в кабинете {label}"}
    raise RefundError("Возврат для этой платёжки не поддерживается", 400)


def refund(payment: dict[str, Any]) -> tuple[bool, str]:
    """вернуть деньги: (готово сразу, текст для истории)."""
    provider = payment.get("provider")
    pid = str(payment["provider_payment_id"])
    if provider == "cispay":
        data = _cispay_paid(payment)
        res = payments_config.cispay_client().refund(pid, int(data["charged_amount"]))
        done = str(res.get("status") or "").upper() == "REFUNDED"
        return done, ("Деньги возвращены через cisPay" if done
                      else f"Возврат принят cisPay ({res.get('refund_status') or res.get('status') or 'в обработке'})")
    if provider == "yookassa":
        cl = payments_config.yookassa_client()
        data = cl.get_payment(pid)
        amt = yookassa.amount_rub(data)
        if data.get("status") != "succeeded" or amt is None:
            raise RefundError(f"У ЮKassa платёж в статусе {data.get('status')} — вернуть нельзя", 400)
        receipt = None
        if payments_config.yookassa_fiscal():
            o = payments_config.yookassa_receipt_opts()
            receipt = yookassa.receipt_for(
                email=_user_email(payment) or o["email"] or None, phone=None,
                description=str(data.get("description") or "Подписка"),
                amount_rub=amt, vat_code=o["vat_code"], tax_system_code=o["tax_system_code"],
            )
        res = cl.refund(pid, amt, receipt)
        st = str(res.get("status") or "")
        if st == "canceled":
            reason = (res.get("cancellation_details") or {}).get("reason") or "отклонён"
            raise RefundError(f"ЮKassa отклонила возврат: {reason}")
        done = st == "succeeded"
        return done, "Деньги возвращены через ЮKassa" if done else "Возврат принят ЮKassa, обрабатывается"
    if provider == "wata":
        t = _wata_paid(payment)
        amt = wata.amount_rub(t)
        if amt is None:
            raise RefundError("WATA не вернула сумму платежа")
        res = payments_config.wata_client().refund(str(t["id"]), amt)
        st = str(res.get("transactionStatus") or "").lower()
        if st == "declined":
            raise RefundError(f"WATA отклонила возврат: {res.get('errorDescription') or res.get('errorCode') or 'без причины'}")
        done = st == "paid"
        return done, "Деньги возвращены через WATA" if done else "Возврат принят WATA, обрабатывается"
    raise RefundError("Возврат через API для этой платёжки недоступен", 400)


def _wata_paid(payment: dict[str, Any]) -> dict[str, Any]:
    items = payments_config.wata_client().transactions(str(payment["payment_id"]))
    if wata.refunded(items):
        raise RefundError("По этому платежу в WATA уже есть возврат", 400)
    t = wata.paid_payment(items)
    if not t or not t.get("id"):
        raise RefundError("В WATA нет оплаченной транзакции по этому платежу", 400)
    return t


def _user_email(payment: dict[str, Any]) -> str:
    try:
        row = payments_config.db.fetchone("SELECT email FROM users WHERE id = ?", (int(payment["user_id"]),))
        return str((row or {}).get("email") or "")
    except Exception:  # noqa: BLE001
        return ""


def _cispay_paid(payment: dict[str, Any]) -> dict[str, Any]:
    data = payments_config.cispay_client().get_payment(payment_id=str(payment["provider_payment_id"]))
    if cispay.is_test(data):
        raise RefundError("Тестовый платёж cisPay — возвращать нечего", 400)
    if str(data.get("status") or "").upper() != "PAID":
        raise RefundError(f"У cisPay платёж в статусе {data.get('status')} — вернуть нельзя", 400)
    if not data.get("charged_amount"):
        raise RefundError("cisPay не вернул сумму списания")
    return data
