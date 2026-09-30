import React, { useEffect, useState } from "react";
import PaymentSheet, { type PendingPayment } from "./PaymentSheet";
import { useNavigate } from "react-router-dom";
import { fetchUnseenPayment, markPaymentSeen } from "../utils/api";

// возврат platega / tg startapp pay_… читаем при старте до редиректов
type ReturnInfo = { id: string; failed: boolean };

function readReturnId(): ReturnInfo | null {
  try {
    const url = new URL(window.location.href);
    if (url.pathname === "/payment/return") {
      const id = url.searchParams.get("payment_id") || "";
      if (/^[a-f0-9]{16,64}$/.test(id)) return { id, failed: url.searchParams.get("result") === "fail" };
    }
    const tg = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp;
    const sp = tg?.initDataUnsafe?.start_param || url.searchParams.get("tgWebAppStartParam") || "";
    const m = /^pay(fail)?_([a-f0-9]{16,64})$/.exec(sp);
    return m ? { id: m[2], failed: !!m[1] } : null;
  } catch {
    return null;
  }
}

let returnId: ReturnInfo | null = readReturnId();

// повтор ведёт туда, где начиналась оплата
function retryPath(purpose: string, returnTo?: string): string {
  if (purpose === "devices") return "/subscription/increase";
  if (purpose === "traffic_reset") return "/payment?type=traffic_reset";
  if (returnTo && returnTo.includes("setup=1")) return `/payment?return=${encodeURIComponent(returnTo)}`;
  return "/subscription/extend";
}

// снова открыть окно оплаты, если приложение закрыли во время платежа
export default function PaymentResume() {
  const [p, setP] = useState<(PendingPayment & { returnTo?: string; status: string }) | null>(null);
  const navigate = useNavigate();
  const [fromReturn] = useState(() => { const id = returnId; returnId = null; return id; });

  useEffect(() => {
    let alive = true;
    void fetchUnseenPayment(fromReturn?.id).then((u) => {
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
  }, [fromReturn]);

  if (!p) return null;
  return (
    <PaymentSheet
      payment={p}
      returnTo={p.returnTo}
      autoAdvance={!!fromReturn}
      failedHint={!!fromReturn?.failed && fromReturn.id === p.paymentId}
      onRetry={() => {
        void markPaymentSeen(p.paymentId);
        setP(null);
        navigate(retryPath(p.purpose || "subscription", p.returnTo));
      }}
      onDone={() => setP(null)}
      onClose={() => {
        // закрыли до оплаты: больше не навязывать
        void markPaymentSeen(p.paymentId);
        setP(null);
      }}
    />
  );
}
