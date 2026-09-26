import React, { useEffect, useState } from "react";
import PaymentSheet, { type PendingPayment } from "./PaymentSheet";
import { fetchUnseenPayment, markPaymentSeen } from "../utils/api";

/**
 * Если приложение закрылось или перезагрузилось во время оплаты — при следующем
 * запуске снова показываем окно оплаты: «Ожидаем оплату…» или «Оплата прошла!»
 * с продолжением настройки.
 */
export default function PaymentResume() {
  const [p, setP] = useState<(PendingPayment & { returnTo?: string; status: string }) | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchUnseenPayment().then((u) => {
      if (!alive || !u) return;
      setP({
        paymentId: u.payment_id,
        provider: String(u.provider || ""),
        payUrl: u.pay_url || undefined,
        invoiceLink: u.invoice_link || undefined,
        purpose: u.purpose || "subscription",
        returnTo: u.return_to || "/subscription",
        status: u.status,
      });
    });
    return () => { alive = false; };
  }, []);

  if (!p) return null;
  return (
    <PaymentSheet
      payment={p}
      returnTo={p.returnTo}
      autoAdvance={false}
      onDone={() => setP(null)}
      onClose={() => {
        // Закрыли, не дождавшись оплаты — больше не навязываем это окно
        void markPaymentSeen(p.paymentId);
        setP(null);
      }}
    />
  );
}
