import React, { useEffect, useState } from "react";
import { MSIcon } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, requestWithdraw } from "../utils/api";

type RefUser = { id: number; username?: string | null; telegram_id?: number; name?: string; initial?: string };

type ReferralData = {
  code?: string;
  link?: string;
  is_partner?: boolean;
  partner_balance?: number;
  partner_rate?: number;
  referrals_count?: number;
  referrals?: RefUser[];
  min_withdraw?: number;
};

const MIN_WITHDRAW = 100;

export default function Referral() {
  const goBack = useSmartBack("/");
  const [data, setData] = useState<ReferralData | null>(null);
  const [copied, setCopied] = useState<"" | "tg" | "web">("");

  // Вывод средств
  const [sheet, setSheet] = useState(false);
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [wErr, setWErr] = useState("");
  const [wOk, setWOk] = useState(false);

  const loadRef = async () => {
    try {
      const d = await appFetch<ReferralData>("/referral");
      setData(d);
    } catch {
      setData({ referrals: [], referrals_count: 0, partner_balance: 0 });
    }
  };
  useEffect(() => { void loadRef(); }, []);

  const hasReferrals = (data?.referrals_count || 0) > 0;
  const balance = Number(data?.partner_balance || 0);
  const count = Number(data?.referrals_count || 0);
  const refs = data?.referrals || [];
  const minWithdraw = Number(data?.min_withdraw || MIN_WITHDRAW);
  const code = data?.code || "";

  const tgLink = data?.link || "";
  // «Ссылка для сайта» — публичный веб-адрес приложения с реф-кодом.
  const webLink = code ? `${window.location.origin}/?ref=${code}` : "";

  const openSheet = () => {
    setWErr(""); setWOk(false);
    setAmount(balance >= minWithdraw ? String(Math.floor(balance)) : "");
    setAddress("");
    setSheet(true);
  };

  const submitWithdraw = async () => {
    setWErr("");
    const amt = Number(amount);
    if (!amt || amt < minWithdraw) { setWErr(`Минимум ${minWithdraw}₽`); return; }
    if (amt > balance) { setWErr("Недостаточно средств"); return; }
    const a = address.trim();
    const okAddr = /^(UQ|EQ|0Q|kQ)[A-Za-z0-9_-]{46}$/.test(a) || /\.ton$/i.test(a) || /\.t\.me$/i.test(a);
    if (!okAddr) { setWErr("Неверный адрес. Нужен UQ…/EQ… или .ton / .t.me"); return; }
    setSubmitting(true);
    try {
      const res = await requestWithdraw(amt, a);
      setWOk(true);
      setData((prev) => (prev ? { ...prev, partner_balance: res.partner_balance } : prev));
      setTimeout(() => { setSheet(false); void loadRef(); }, 1600);
    } catch (e) {
      setWErr(e instanceof Error ? e.message : "Не удалось создать заявку");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string, which: "tg" | "web") => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(""), 1800);
    } catch { /* ignore */ }
  };

  const card: React.CSSProperties = { background: "#1E1A16", borderRadius: 24 };
  const caption: React.CSSProperties = { fontWeight: 600, fontSize: 13, color: "#A89B8C", margin: "18px 8px 8px" };

  const LinkField = ({ label, url, which }: { label: string; url: string; which: "tg" | "web" }) => (
    <div style={{ padding: "14px 16px", borderBottom: which === "tg" && webLink ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: "#A89B8C", marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            flex: 1, minWidth: 0, background: "#2A241E", borderRadius: 12, padding: "11px 14px",
            color: "#FFF8F0", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {url || "—"}
        </div>
        <button
          type="button"
          onClick={() => void copy(url, which)}
          style={{
            flex: "0 0 auto", height: 40, padding: "0 16px", borderRadius: 12, border: "none",
            background: copied === which ? "#3D8B4E" : "#FF6B1A", color: "#FFF8F0", fontWeight: 600,
            fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <MSIcon name={copied === which ? "check" : "content_copy"} style={{ color: "#FFF8F0", fontSize: 18 }} />
          {copied === which ? "Скоп." : "Копир."}
        </button>
      </div>
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#14110E",
        fontFamily: "'Outfit', system-ui, sans-serif",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 402,
          minHeight: "100vh",
          padding: "20px 20px 32px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Шапка */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <button
            type="button"
            onClick={goBack}
            aria-label="Назад"
            style={{
              flex: "0 0 auto", width: 40, height: 40, borderRadius: "50%",
              background: "#2A241E", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <MSIcon name="chevron_left" style={{ color: "#FFF8F0", fontSize: 24 }} />
          </button>
          <div style={{ fontWeight: 700, fontSize: 26, color: "#FFF8F0" }}>Друзья</div>
        </div>

        {/* Баланс / статистика */}
        <div style={{ ...card, padding: 18 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 26, color: "#FFF8F0" }}>{balance} ₽</div>
              <div style={{ fontWeight: 500, fontSize: 13, color: "#A89B8C", marginTop: 2 }}>Заработано</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 26, color: "#FFF8F0" }}>{count} чел</div>
              <div style={{ fontWeight: 500, fontSize: 13, color: "#A89B8C", marginTop: 2 }}>Приглашено</div>
            </div>
          </div>
          <button
            type="button"
            onClick={openSheet}
            style={{
              width: "100%", marginTop: 16, height: 46, borderRadius: 14, border: "none",
              background: "#352E26", color: "#FFF8F0", fontWeight: 600, fontSize: 15, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            <MSIcon name="arrow_outward" style={{ color: "#FF6B1A", fontSize: 20 }} />
            Вывести (USDT TON)
          </button>
        </div>

        {/* Ссылки для приглашения */}
        <div style={caption}>Ваши ссылки</div>
        <div style={card}>
          <LinkField label="Ссылка Telegram" url={tgLink} which="tg" />
          {webLink && <LinkField label="Ссылка для сайта" url={webLink} which="web" />}
        </div>

        {/* Приглашённые */}
        <div style={caption}>Приглашённые</div>
        <div style={{ ...card, padding: hasReferrals ? 10 : 24, flex: hasReferrals ? "0 0 auto" : "1 0 auto" }}>
          {hasReferrals ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {refs.map((u) => {
                const label = u.name
                  || (u.username ? `@${u.username}` : u.telegram_id ? `id${u.telegram_id}` : `Пользователь #${u.id}`);
                const initial = (u.initial || label.replace(/^[@#]/, "").charAt(0) || "?").toUpperCase();
                return (
                  <div
                    key={u.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      background: "#352E26", borderRadius: 16, padding: "12px 14px",
                    }}
                  >
                    <div
                      style={{
                        flex: "0 0 auto", width: 34, height: 34, borderRadius: "50%",
                        background: "radial-gradient(circle at 35% 30%, #ffb879 0%, #FF6B1A 45%, #8e4f12 100%)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#FFF8F0", fontWeight: 700, fontSize: 15,
                      }}
                    >
                      {initial}
                    </div>
                    <div style={{ minWidth: 0, fontWeight: 600, fontSize: 15, color: "#FFF8F0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {label}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 12, padding: "24px 8px" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#352E26", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MSIcon name="group_add" style={{ color: "#A89B8C", fontSize: 30 }} />
              </div>
              <div style={{ fontWeight: 600, fontSize: 16, color: "#FFF8F0" }}>Пока нет приглашённых</div>
              <div style={{ fontSize: 14, color: "#A89B8C", maxWidth: 260, lineHeight: "20px" }}>
                Отправьте свою ссылку друзьям — за их покупки вы получаете вознаграждение.
              </div>
            </div>
          )}
        </div>

        {sheet && (
          <div
            onClick={() => !submitting && setSheet(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(8,6,4,0.72)",
              display: "flex", alignItems: "flex-end", zIndex: 50,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%", maxWidth: 402, margin: "0 auto", background: "#14110E",
                borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: "22px 24px 28px",
                boxSizing: "border-box", borderTop: "1px solid rgba(255,248,240,0.12)",
              }}
            >
              <div style={{ width: 44, height: 5, borderRadius: 3, background: "#6F6458", margin: "0 auto 18px" }} />
              <div style={{ color: "#FFF8F0", fontWeight: 600, fontSize: 20, marginBottom: 4 }}>Вывод средств</div>
              <div style={{ color: "#A89B8C", fontSize: 13, marginBottom: 18 }}>
                Только USDT TON. Минимум {minWithdraw}₽. Доступно: {Math.floor(balance)}₽
              </div>

              {wOk ? (
                <div style={{ color: "#4ADE80", fontSize: 15, fontWeight: 500, padding: "18px 0" }}>
                  Заявка создана. Средства заморожены до решения администратора.
                </div>
              ) : (
                <>
                  <label style={{ color: "#A89B8C", fontSize: 12 }}>Сумма, ₽</label>
                  <input
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={String(minWithdraw)}
                    style={{
                      width: "100%", boxSizing: "border-box", marginTop: 6, marginBottom: 14,
                      background: "#2A241E", border: "none", borderRadius: 16, padding: "14px 16px",
                      color: "#FFF8F0", fontSize: 16, outline: "none",
                    }}
                  />
                  <label style={{ color: "#A89B8C", fontSize: 12 }}>Адрес (UQ… / EQ… / .ton / .t.me)</label>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="UQ… или name.ton"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{
                      width: "100%", boxSizing: "border-box", marginTop: 6, marginBottom: 8,
                      background: "#2A241E", border: "none", borderRadius: 16, padding: "14px 16px",
                      color: "#FFF8F0", fontSize: 15, outline: "none",
                    }}
                  />
                  {wErr && <div style={{ color: "#F87171", fontSize: 13, marginBottom: 8 }}>{wErr}</div>}
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitWithdraw()}
                    style={{
                      width: "100%", marginTop: 10, background: "#FF6B1A", border: "none",
                      borderRadius: 18, padding: "15px 0", color: "#FFF8F0", fontSize: 16, fontWeight: 600,
                      cursor: "pointer", opacity: submitting ? 0.6 : 1,
                    }}
                  >
                    {submitting ? "Отправка…" : "Запросить вывод"}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
