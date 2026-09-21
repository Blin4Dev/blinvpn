import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BackCircleButton, MSIcon } from "../components/ui";
import { fetchPaymentStatus, openPayUrl, openStarsInvoice } from "../utils/api";

type Phase = "pending" | "paid" | "failed" | "error";

export default function PaymentWaiting() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const paymentId = params.get("payment_id") || "";
  const provider = params.get("provider") || "";
  const payUrlParam = params.get("pay_url") || "";
  const invoiceParam = params.get("invoice_link") || "";

  const [phase, setPhase] = useState<Phase>("pending");
  const [payUrl, setPayUrl] = useState<string>(payUrlParam);
  const [invoiceLink, setInvoiceLink] = useState<string>(invoiceParam);
  const stopped = useRef(false);

  const poll = useCallback(async () => {
    if (!paymentId) {
      setPhase("error");
      return;
    }
    try {
      const s = await fetchPaymentStatus(paymentId);
      if (s.pay_url) setPayUrl(s.pay_url);
      if (s.invoice_link) setInvoiceLink(s.invoice_link);
      if (s.status === "paid") {
        stopped.current = true;
        setPhase("paid");
      } else if (s.status === "failed") {
        stopped.current = true;
        setPhase("failed");
      }
    } catch {
      /* оставляем pending и пробуем снова */
    }
  }, [paymentId]);

  useEffect(() => {
    if (!paymentId) {
      setPhase("error");
      return;
    }
    void poll();
    const id = window.setInterval(() => {
      if (stopped.current) {
        window.clearInterval(id);
        return;
      }
      void poll();
    }, 3000);
    return () => window.clearInterval(id);
  }, [paymentId, poll]);

  const reopen = async () => {
    if (invoiceLink) {
      const status = await openStarsInvoice(invoiceLink);
      if (status === "paid") void poll();
    } else if (payUrl) {
      openPayUrl(payUrl);
    }
  };

  const wrap: React.CSSProperties = {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    background: "#14110E",
    fontFamily: "'Outfit', system-ui, sans-serif",
  };
  const card: React.CSSProperties = {
    position: "relative",
    width: "402px",
    height: "803px",
    background: "#14110E",
    overflow: "hidden",
    boxSizing: "border-box",
  };
  const center: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    top: "270px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "0 36px",
    textAlign: "center",
  };
  const primaryBtn: React.CSSProperties = {
    width: "330px",
    height: "50px",
    background: "#FF6B1A",
    borderRadius: "30px",
    border: "none",
    cursor: "pointer",
    color: "#fff",
    fontSize: "17px",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
  };
  const ghostBtn: React.CSSProperties = {
    ...primaryBtn,
    background: "#352E26",
    marginTop: "12px",
  };

  return (
    <div style={wrap}>
      <div style={card}>
        <BackCircleButton onClick={() => navigate("/")} />
        <div
          style={{
            position: "absolute",
            left: "73px",
            top: "28px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            color: "#FFFFFF",
          }}
        >
          Оплата
        </div>

        <div style={center}>
          {phase === "pending" && (
            <>
              <Spinner />
              <div style={{ marginTop: 28, fontSize: 20, fontWeight: 600, color: "#fff" }}>
                Ожидаем оплату…
              </div>
              <div style={{ marginTop: 10, fontSize: 14, color: "#AFAFAF", lineHeight: 1.5 }}>
                {provider === "tg_stars"
                  ? "Подтвердите платёж в окне Telegram. Подписка активируется автоматически."
                  : "Завершите оплату на открывшейся странице. Как только банк подтвердит платёж, подписка активируется автоматически."}
              </div>
              {(payUrl || invoiceLink) && (
                <button type="button" style={{ ...ghostBtn, marginTop: 28 }} onClick={() => void reopen()}>
                  <MSIcon name="open_in_new" style={{ fontSize: 20, color: "#E3E3E3" }} />
                  <span>Открыть оплату снова</span>
                </button>
              )}
            </>
          )}

          {phase === "paid" && (
            <>
              <SuccessMark />
              <div style={{ marginTop: 28, fontSize: 22, fontWeight: 700, color: "#fff" }}>
                Оплата прошла!
              </div>
              <div style={{ marginTop: 10, fontSize: 14, color: "#AFAFAF", lineHeight: 1.5 }}>
                Подписка активирована. Ключ доступен в разделе подписки.
              </div>
              <button
                type="button"
                style={{ ...primaryBtn, marginTop: 28 }}
                onClick={() => navigate("/subscription", { replace: true })}
              >
                Перейти к подписке
                <MSIcon name="chevron_right" style={{ fontSize: 22, color: "#fff" }} />
              </button>
            </>
          )}

          {(phase === "failed" || phase === "error") && (
            <>
              <FailMark />
              <div style={{ marginTop: 28, fontSize: 22, fontWeight: 700, color: "#fff" }}>
                {phase === "failed" ? "Платёж отменён" : "Платёж не найден"}
              </div>
              <div style={{ marginTop: 10, fontSize: 14, color: "#AFAFAF", lineHeight: 1.5 }}>
                {phase === "failed"
                  ? "Оплата не была завершена. Можно попробовать снова."
                  : "Не удалось найти платёж. Вернитесь и создайте новый."}
              </div>
              <button
                type="button"
                style={{ ...primaryBtn, marginTop: 28 }}
                onClick={() => navigate("/payment", { replace: true })}
              >
                Попробовать снова
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`@keyframes blinspin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 72,
        height: 72,
        borderRadius: "50%",
        border: "6px solid rgba(255, 107, 26,0.2)",
        borderTopColor: "#FF6B1A",
        animation: "blinspin 0.9s linear infinite",
      }}
    />
  );
}

function SuccessMark() {
  return (
    <div
      style={{
        width: 84,
        height: 84,
        borderRadius: "50%",
        background: "rgba(76,175,80,0.15)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MSIcon name="check_circle" style={{ fontSize: 56, color: "#4CAF50" }} />
    </div>
  );
}

function FailMark() {
  return (
    <div
      style={{
        width: 84,
        height: 84,
        borderRadius: "50%",
        background: "rgba(244,67,54,0.15)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MSIcon name="cancel" style={{ fontSize: 56, color: "#F44336" }} />
    </div>
  );
}
