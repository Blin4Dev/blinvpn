"""
Оплата звёздами Telegram: pre_checkout_query и successful_payment.

Апдейты приходят боту (polling, src/bot/bot.py) или на /api/telegram/webhook
(режим TELEGRAM_STARS_DELIVERY=webhook, src/core/core.py) — оба вызывают эти функции.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from payments.webhooks.common import fulfillment

PAID_TEXT = "✅ <b>Оплата получена!</b>\nПодписка активирована. Откройте приложение, чтобы получить ключ."
FAILED_TEXT = ("⚠️ Оплата получена, но при активации возникла ошибка. Мы уже разбираемся — "
               "напишите в поддержку, если ключ не появился.")


def pre_checkout_answer(query: dict[str, Any]) -> dict[str, Any]:
    """тело answerPreCheckoutQuery: подтверждаем только свой неоплаченный счёт на верную сумму."""
    payment_id = query.get("invoice_payload") or ""
    payment = fulfillment.get_payment(payment_id) if payment_id else None
    ok = fulfillment.stars_precheckout_ok(payment, query)
    body: dict[str, Any] = {"pre_checkout_query_id": query["id"], "ok": ok}
    if not ok:
        body["error_message"] = "Платёж не найден или уже обработан. Попробуйте снова."
    return body


def handle_pre_checkout(query: dict[str, Any], call: Callable[[str, dict[str, Any]], Any]) -> None:
    # ответить нужно за 10 секунд
    call("answerPreCheckoutQuery", pre_checkout_answer(query))


def handle_successful_payment(message: dict[str, Any]) -> Optional[dict[str, Any]]:
    """выдать оплаченное. None — в сообщении нет нашего платежа."""
    sp = message.get("successful_payment") or {}
    payment_id = sp.get("invoice_payload") or ""
    if not payment_id:
        return None
    return fulfillment.fulfill_payment(
        payment_id,
        stars_charge_id=sp.get("telegram_payment_charge_id") or "",
        amount=sp.get("total_amount"),
        stars_payer_id=(message.get("from") or {}).get("id"),
    )
