import React, { useEffect, useState } from "react";
import { BackCircleButton, MSIcon } from "../components/ui";
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
};

const MIN_WITHDRAW = 100;

export default function Referral() {
  const goBack = useSmartBack("/");
  const [data, setData] = useState<ReferralData | null>(null);
  const [copied, setCopied] = useState(false);

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
  const rate = Number(data?.partner_rate || 20);
  const refs = data?.referrals || [];
  const minWithdraw = Number((data as { min_withdraw?: number } | null)?.min_withdraw || MIN_WITHDRAW);

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

  const copyLink = async () => {
    const link = data?.link || "";
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#111",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "402px",
          height: "803px",
          background: "#212121",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        <BackCircleButton onClick={goBack} />

        <div
          style={{
            position: "absolute",
            width: "280px",
            height: "33px",
            left: "73px",
            top: "28px",
            fontWeight: 600,
            fontSize: "27px",
            lineHeight: "33px",
            display: "flex",
            alignItems: "center",
            color: "#FFFFFF",
          }}
        >
          Друзья
        </div>

        <div
          style={{
            position: "absolute",
            width: "350px",
            height: "139px",
            left: "26px",
            top: "87px",
            background: "#333333",
            borderRadius: "30px",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "56px",
            height: "56px",
            left: "42px",
            top: "103px",
            background: "#484848",
            borderRadius: "12px",
          }}
        />
        <MSIcon
          name="group"
          style={{
            position: "absolute",
            width: "36px",
            height: "36px",
            left: "52px",
            top: "113px",
            opacity: 0.5,
            color: "#FFFFFF",
            fontSize: 36,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "108px",
            top: "119px",
            fontWeight: 600,
            fontSize: "20px",
            lineHeight: "24px",
            color: "#FFFFFF",
          }}
        >
          Друзья
        </div>
        <div
          style={{
            position: "absolute",
            width: "310px",
            left: "42px",
            top: "169px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            color: "#FFFFFF",
            opacity: 0.53,
          }}
        >
          Приглашайте друзей и зарабатывайте. Комиссия: {rate}%
        </div>

        <button
          type="button"
          onClick={() => void copyLink()}
          style={{
            position: "absolute",
            left: "250px",
            top: "103px",
            height: "36px",
            padding: "0 12px",
            background: "#484848",
            borderRadius: "12px",
            border: "none",
            color: "#FFFFFF",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            zIndex: 2,
          }}
        >
          {copied ? "OK" : "Ссылка"}
        </button>

        <div
          onClick={openSheet}
          style={{
            position: "absolute",
            width: "170px",
            height: "93px",
            left: "26px",
            top: "236px",
            background: "#333333",
            borderRadius: "30px",
            cursor: "pointer",
          }}
        />
        <MSIcon
          name="arrow_outward"
          onClick={openSheet}
          style={{
            position: "absolute",
            left: "158px",
            top: "246px",
            fontSize: 22,
            color: "#F18726",
            cursor: "pointer",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "170px",
            height: "93px",
            left: "206px",
            top: "236px",
            background: "#333333",
            borderRadius: "30px",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "42px",
            top: "252px",
            fontWeight: 500,
            fontSize: "28px",
            lineHeight: "34px",
            color: "#FFFFFF",
          }}
        >
          {balance} ₽
        </div>
        <div
          style={{
            position: "absolute",
            left: "222px",
            top: "252px",
            fontWeight: 500,
            fontSize: "28px",
            lineHeight: "34px",
            color: "#FFFFFF",
          }}
        >
          {count} чел
        </div>
        <div
          style={{
            position: "absolute",
            left: "42px",
            top: "297px",
            fontWeight: 500,
            fontSize: "13px",
            color: "#FFFFFF",
            opacity: 0.53,
          }}
        >
          Заработано
        </div>
        <div
          style={{
            position: "absolute",
            left: "222px",
            top: "297px",
            fontWeight: 500,
            fontSize: "13px",
            color: "#FFFFFF",
            opacity: 0.53,
          }}
        >
          Приглашено
        </div>

        <MSIcon
          name="info"
          style={{
            position: "absolute",
            left: "26px",
            top: "339px",
            opacity: 0.53,
            color: "#E3E3E3",
            fontSize: 24,
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "320px",
            left: "56px",
            top: "339px",
            fontWeight: 500,
            fontSize: "13px",
            lineHeight: "16px",
            color: "#FFFFFF",
            opacity: 0.53,
          }}
        >
          Вы получаете {rate}% от каждой траты своего приглашённого. Нажмите на баланс, чтобы вывести (USDT TON).
          {copied ? " Ссылка скопирована." : data?.code ? ` Код: ${data.code}` : ""}
        </div>

        <div
          style={{
            position: "absolute",
            width: "350px",
            height: hasReferrals ? "381px" : "139px",
            left: "26px",
            top: "402px",
            background: "#333333",
            borderRadius: "30px",
          }}
        />

        {hasReferrals ? (
          <div
            style={{
              position: "absolute",
              width: "338px",
              height: "361px",
              left: "36px",
              top: "412px",
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              overscrollBehavior: "contain",
              paddingRight: "8px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            {refs.map((u) => {
              const label = u.name
                || (u.username ? `@${u.username}` : u.telegram_id ? `id${u.telegram_id}` : `Пользователь #${u.id}`);
              const initial = (u.initial || label.replace(/^[@#]/, "").charAt(0) || "?").toUpperCase();
              return (
                <div
                  key={u.id}
                  style={{
                    position: "relative",
                    width: "330px",
                    height: "68px",
                    flexShrink: 0,
                    background: "#3D3D3D",
                    borderRadius: "30px",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      width: "34px",
                      height: "34px",
                      left: "12px",
                      top: "17px",
                      borderRadius: "50%",
                      background:
                        "radial-gradient(circle at 35% 30%, #ffb879 0%, #f18726 45%, #8e4f12 100%)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: "16px",
                    }}
                  >
                    {initial}
                  </div>
                  <div
                    style={{
                      position: "absolute",
                      left: "56px",
                      top: "24px",
                      right: "16px",
                      fontWeight: 600,
                      fontSize: "16px",
                      color: "#FFFFFF",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <MSIcon
              name="link"
              style={{
                position: "absolute",
                left: "189px",
                top: "448px",
                color: "#E3E3E3",
                fontSize: 24,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: "56px",
                right: "56px",
                top: "486px",
                textAlign: "center",
                fontWeight: 500,
                fontSize: "13px",
                color: "#FFFFFF",
                opacity: 0.53,
              }}
            >
              Пока нет приглашённых. Нажмите «Ссылка», чтобы скопировать приглашение.
            </div>
          </>
        )}

        {sheet && (
          <div
            onClick={() => !submitting && setSheet(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "flex-end",
              zIndex: 50,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                background: "#212121",
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                padding: "22px 24px 28px",
                boxSizing: "border-box",
                borderTop: "1px solid #333",
              }}
            >
              <div style={{ width: 44, height: 5, borderRadius: 3, background: "#444", margin: "0 auto 18px" }} />
              <div style={{ color: "#fff", fontWeight: 600, fontSize: 20, marginBottom: 4 }}>Вывод средств</div>
              <div style={{ color: "#8A8A8A", fontSize: 13, marginBottom: 18 }}>
                Только USDT TON. Минимум {minWithdraw}₽. Доступно: {Math.floor(balance)}₽
              </div>

              {wOk ? (
                <div style={{ color: "#4ADE80", fontSize: 15, fontWeight: 500, padding: "18px 0" }}>
                  Заявка создана. Средства заморожены до решения администратора.
                </div>
              ) : (
                <>
                  <label style={{ color: "#8A8A8A", fontSize: 12 }}>Сумма, ₽</label>
                  <input
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={String(minWithdraw)}
                    style={{
                      width: "100%", boxSizing: "border-box", marginTop: 6, marginBottom: 14,
                      background: "#333", border: "none", borderRadius: 16, padding: "14px 16px",
                      color: "#fff", fontSize: 16, outline: "none",
                    }}
                  />
                  <label style={{ color: "#8A8A8A", fontSize: 12 }}>Адрес (UQ… / EQ… / .ton / .t.me)</label>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="UQ… или name.ton"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{
                      width: "100%", boxSizing: "border-box", marginTop: 6, marginBottom: 8,
                      background: "#333", border: "none", borderRadius: 16, padding: "14px 16px",
                      color: "#fff", fontSize: 15, outline: "none",
                    }}
                  />
                  {wErr && <div style={{ color: "#F87171", fontSize: 13, marginBottom: 8 }}>{wErr}</div>}
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitWithdraw()}
                    style={{
                      width: "100%", marginTop: 10, background: "#F18726", border: "none",
                      borderRadius: 18, padding: "15px 0", color: "#fff", fontSize: 16, fontWeight: 600,
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
