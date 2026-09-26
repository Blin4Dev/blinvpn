import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Btn, MSIcon, T } from "./ui";
import { fetchPaymentStatus, markPaymentSeen, openPayUrl, openStarsInvoice } from "../utils/api";

type Phase = "pending" | "paid" | "failed" | "error";

export type PendingPayment = {
  paymentId: string;
  provider: string;
  payUrl?: string;
  invoiceLink?: string;
  /** subscription | devices | traffic_reset — для текстов */
  purpose?: string;
};

const PAID_TEXT: Record<string, string> = {
  devices: "Устройства добавлены в подписку.",
  traffic_reset: "Трафик сброшен.",
};
const PENDING_TEXT: Record<string, string> = {
  devices: "устройства добавятся",
  traffic_reset: "трафик сбросится",
};

const POLL_MS = 2000;

/**
 * Нижнее всплывающее окно «Ожидаем оплату».
 * Опрашивает статус платежа (его выставляет вебхук провайдера) и само
 * переключается на «Оплата прошла», после чего уводит дальше.
 */
export default function PaymentSheet({
  payment,
  returnTo,
  onClose,
  autoAdvance = true,
  onDone,
}: {
  payment: PendingPayment;
  returnTo?: string;
  onClose: () => void;
  /** Сам уходить дальше после оплаты (false — ждать нажатия кнопки) */
  autoAdvance?: boolean;
  /** Вызывается после перехода дальше (окно больше не нужно) */
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("pending");
  const [payUrl, setPayUrl] = useState(payment.payUrl || "");
  const [invoiceLink, setInvoiceLink] = useState(payment.invoiceLink || "");
  const [purpose, setPurpose] = useState(payment.purpose || "subscription");
  const stopped = useRef(false);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (stopped.current || inFlight.current) return;
    inFlight.current = true;
    try {
      const s = await fetchPaymentStatus(payment.paymentId);
      if (s.pay_url) setPayUrl(s.pay_url);
      if (s.invoice_link) setInvoiceLink(s.invoice_link);
      if (s.purpose) setPurpose(s.purpose);
      if (s.status === "paid") {
        stopped.current = true;
        setPhase("paid");
      } else if (s.status === "failed") {
        stopped.current = true;
        setPhase("failed");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/не найден/i.test(msg)) {
        stopped.current = true;
        setPhase("error");
      }
      /* иначе — сетевой сбой, пробуем снова */
    } finally {
      inFlight.current = false;
    }
  }, [payment.paymentId]);

  // Опрос + мгновенная проверка, когда пользователь вернулся из банка/окна оплаты
  useEffect(() => {
    stopped.current = false;
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    const onBack = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [poll]);

  const finish = useCallback(() => {
    if (returnTo && returnTo.startsWith("/")) navigate(returnTo, { replace: true });
    else navigate("/subscription", { replace: true });
    onDone?.();
  }, [navigate, returnTo, onDone]);

  // Итог показан — при следующем запуске приложения повторно его не выводим
  useEffect(() => {
    if (phase === "paid" || phase === "failed") void markPaymentSeen(payment.paymentId);
  }, [phase, payment.paymentId]);

  const setupNext = !!returnTo && returnTo.includes("setup=1");

  // После оплаты страница меняется сама
  useEffect(() => {
    if (phase !== "paid" || !autoAdvance) return;
    const t = window.setTimeout(finish, 1500);
    return () => window.clearTimeout(t);
  }, [phase, finish, autoAdvance]);

  const reopen = async () => {
    if (invoiceLink) {
      const status = await openStarsInvoice(invoiceLink);
      if (status === "paid") void poll();
    } else if (payUrl) {
      openPayUrl(payUrl);
    }
  };

  const canClose = phase !== "paid";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => canClose && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(8,6,4,0.7)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        fontFamily: T.font,
        animation: "blinvpnFadeIn 0.18s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 402,
          background: T.bg,
          borderTop: `1px solid ${T.border}`,
          borderRadius: `${T.radius.xl}px ${T.radius.xl}px 0 0`,
          padding: "16px 26px calc(24px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          animation: "blinvpnSheetUp 0.28s var(--ease-out) both",
        }}
      >
        <div style={{ width: 36, height: 3, borderRadius: 2, background: T.textDim, marginBottom: 24 }} />

        {phase === "pending" && (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                border: `5px solid ${T.orangeSoft}`,
                borderTopColor: T.orange,
                animation: "blinvpnSpin 0.9s linear infinite",
              }}
            />
            <Title>Ожидаем оплату…</Title>
            <Text>
              {payment.provider === "tg_stars"
                ? "Подтвердите платёж в окне Telegram — подписка активируется автоматически."
                : `Завершите оплату на открывшейся странице — как только банк подтвердит платёж, ${PENDING_TEXT[purpose] || "подписка активируется"} автоматически.`}
            </Text>
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8, marginTop: 22 }}>
              {payUrl || invoiceLink ? (
                <Btn variant="secondary" onClick={() => void reopen()}>
                  <MSIcon name="open_in_new" style={{ fontSize: 20, color: "inherit" }} />
                  Открыть оплату снова
                </Btn>
              ) : null}
              <Btn variant="ghost" onClick={onClose}>
                Закрыть
              </Btn>
            </div>
          </>
        )}

        {phase === "paid" && (
          <>
            <StatusMark icon="check_circle" color={T.success} bg={T.successSoft} />
            <Title>Оплата прошла!</Title>
            <Text>
              {PAID_TEXT[purpose] || (setupNext ? "Подписка активирована. Осталось добавить её в приложение." : "Подписка активирована.")}
            </Text>
            <Btn style={{ marginTop: 22 }} onClick={finish}>
              {setupNext ? "Продолжить настройку" : "Перейти к подписке"}
              <MSIcon name="chevron_right" style={{ fontSize: 22, color: "inherit" }} />
            </Btn>
          </>
        )}

        {(phase === "failed" || phase === "error") && (
          <>
            <StatusMark icon="cancel" color={T.danger} bg={T.dangerSoft} />
            <Title>{phase === "failed" ? "Платёж отменён" : "Платёж не найден"}</Title>
            <Text>
              {phase === "failed"
                ? "Оплата не была завершена. Можно попробовать снова."
                : "Не удалось найти платёж. Попробуйте оплатить ещё раз."}
            </Text>
            <Btn style={{ marginTop: 22 }} onClick={onClose}>
              Попробовать снова
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18, fontSize: 20, fontWeight: 600, color: T.text, letterSpacing: "-0.02em" }}>
      {children}
    </div>
  );
}

function Text({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8, fontSize: 14, color: T.textMuted, lineHeight: 1.5, maxWidth: 320 }}>
      {children}
    </div>
  );
}

function StatusMark({ icon, color, bg }: { icon: string; color: string; bg: string }) {
  return (
    <div
      style={{
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MSIcon name={icon} style={{ fontSize: 40, color }} />
    </div>
  );
}
