import React, { useEffect, useState } from "react";
import { Btn, Field, PageHeader, Screen, SectionLabel, Surface, T, btnReset } from "../components/ui";
import { useSmartBack } from "../utils/navigation";
import { appFetch, requestWithdraw } from "../utils/api";

type RefUser = { id: number; username?: string | null; telegram_id?: number; name?: string; initial?: string; earned?: number };

const rub = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace(".", ",")} ₽`;

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
  const webLink = code ? `${window.location.origin}/?ref=${code}` : "";

  const openSheet = () => {
    setWErr("");
    setWOk(false);
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

  return (
    <Screen>
      <PageHeader title="Друзья" onBack={goBack} />

      <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 28, color: T.text, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
            {balance} ₽
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Баланс</div>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 28, color: T.text, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
            {count}
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Приглашено</div>
        </div>
      </div>

      <Btn variant="secondary" onClick={openSheet} style={{ marginBottom: 8 }}>
        Вывести
      </Btn>

      <SectionLabel>Ссылки</SectionLabel>
      <Surface padded>
        {(
          [
            { label: "Telegram", url: tgLink, which: "tg" as const },
            ...(webLink ? [{ label: "Сайт", url: webLink, which: "web" as const }] : []),
          ]
        ).map((row, i, arr) => (
          <div
            key={row.which}
            style={{
              padding: "12px 0",
              borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : "none",
            }}
          >
            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>{row.label}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  color: T.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: T.font,
                }}
              >
                {row.url || "—"}
              </div>
              <button
                type="button"
                onClick={() => void copy(row.url, row.which)}
                className="blin-press"
                style={{
                  ...btnReset,
                  flexShrink: 0,
                  height: 36,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: `1px solid ${T.border}`,
                  background: copied === row.which ? T.successSoft : T.surfaceRaised,
                  color: copied === row.which ? T.success : T.text,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {copied === row.which ? "Готово" : "Копировать"}
              </button>
            </div>
          </div>
        ))}
      </Surface>

      <SectionLabel>Приглашённые</SectionLabel>
      {!hasReferrals ? (
        <div style={{ paddingTop: 8 }}>
          <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.5 }}>
            Пока никого нет. Отправьте ссылку — за покупки друзей начисляется вознаграждение.
          </div>
        </div>
      ) : (
        <Surface padded>
          {refs.map((u, i) => {
            const label =
              u.name ||
              (u.username ? `@${u.username}` : `Пользователь #${u.id}`);
            return (
              <div
                key={u.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "13px 0",
                  borderBottom: i < refs.length - 1 ? `1px solid ${T.border}` : "none",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontWeight: 500,
                    fontSize: 15,
                    color: T.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </div>
                <div
                  style={{
                    flexShrink: 0,
                    fontWeight: 600,
                    fontSize: 15,
                    fontVariantNumeric: "tabular-nums",
                    color: Number(u.earned) > 0 ? T.orange : T.textDim,
                  }}
                >
                  {Number(u.earned) > 0 ? `+${rub(Number(u.earned))}` : rub(0)}
                </div>
              </div>
            );
          })}
        </Surface>
      )}

      {sheet && (
        <div
          onClick={() => !submitting && setSheet(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(8,6,4,0.7)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 402,
              background: T.bg,
              borderTop: `1px solid ${T.border}`,
              padding: "16px 26px 28px",
              boxSizing: "border-box",
            }}
          >
            <div style={{ width: 36, height: 3, borderRadius: 2, background: T.textDim, margin: "0 auto 14px" }} />
            <div style={{ fontWeight: 600, fontSize: 17, color: T.text, marginBottom: 4 }}>Вывод средств</div>
            <div style={{ color: T.textMuted, fontSize: 13, marginBottom: 16, lineHeight: 1.4 }}>
              USDT в сети TON. Минимум {minWithdraw}₽. Доступно: {Math.floor(balance)}₽
            </div>

            {wOk ? (
              <div style={{ color: T.success, fontSize: 14, padding: "12px 0" }}>
                Заявка создана. Средства заморожены до решения администратора.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 6 }}>Сумма, ₽</div>
                <Field
                  value={amount}
                  onChange={(v) => setAmount(v.replace(/[^\d]/g, ""))}
                  placeholder={String(minWithdraw)}
                  inputMode="numeric"
                />
                <div style={{ fontSize: 13, color: T.textMuted, margin: "14px 0 6px" }}>
                  Адрес (UQ… / EQ… / .ton / .t.me)
                </div>
                <Field
                  value={address}
                  onChange={setAddress}
                  placeholder="UQ… или name.ton"
                />
                {wErr ? <div style={{ color: T.danger, fontSize: 13, marginTop: 8 }}>{wErr}</div> : null}
                <Btn disabled={submitting} onClick={() => void submitWithdraw()} style={{ marginTop: 16 }}>
                  {submitting ? "Отправка…" : "Запросить вывод"}
                </Btn>
              </>
            )}
          </div>
        </div>
      )}
    </Screen>
  );
}
