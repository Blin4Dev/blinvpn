import React, { useEffect, useState } from "react";
import { Btn, MSIcon, T, btnReset } from "./ui";
import SubLinkBox from "./SubLinkBox";
import { fetchAppLink, openDeepLink } from "../utils/api";
import { APP_META, DEVICE_TITLE, detectDeviceKind, installUrl, type AppKind, type DeviceKind } from "../utils/apps";

// pick → install (шаг 1: скачать) → add (шаг 2: добавить) → done;  «другое» → link
type Step = "pick" | "device" | "install" | "add" | "link" | "done";

const DEVICES: DeviceKind[] = ["ios", "android", "windows", "macos", "linux", "android_tv"];

const DEVICE_ICON: Record<DeviceKind, string> = {
  ios: "phone_iphone",
  android: "android",
  windows: "desktop_windows",
  macos: "laptop_mac",
  linux: "terminal",
  android_tv: "tv",
};

/** Небольшая кнопка-текст (как «Отмена»). */
function TextButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="blin-press"
      onClick={onClick}
      style={{ ...btnReset, background: "transparent", border: "none", alignSelf: "center", padding: "10px 16px", fontSize: 14, fontWeight: 600, color: T.textMuted, cursor: "pointer", fontFamily: T.font }}
    >
      {children}
    </button>
  );
}

/** Иконка приложения — как на прежней странице настройки. */
export function AppIcon({ app, size = 40 }: { app: AppKind; size?: number }) {
  const m = APP_META[app];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: T.surfaceRaised,
        flexShrink: 0,
      }}
    >
      {m.img ? (
        <img src={m.img} alt="" style={{ width: size, height: size, objectFit: "cover" }} />
      ) : (
        <MSIcon name={m.icon || "link"} style={{ color: T.text, fontSize: Math.round(size * 0.55) }} />
      )}
    </span>
  );
}

/**
 * Нижнее окно «Добавить подписку» — вся настройка без отдельной страницы:
 *   1. устройство → 2. приложение → 3. установка → 4. добавление подписки кнопкой;
 *   Android TV: 1. устройство → 2. установка Happ и ввод ссылки вручную;
 *   «Другое приложение»: 1. устройство → 2. приложение → 3. ссылка на подписку.
 */
export default function SetupSheet({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("device");
  const [app, setApp] = useState<AppKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [link, setLink] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [device, setDevice] = useState<DeviceKind>(() => detectDeviceKind());

  const needLink = step === "link" || (step === "install" && device === "android_tv");
  useEffect(() => {
    if (!needLink || link) return;
    let alive = true;
    setLinkLoading(true);
    setErr("");
    void fetchAppLink("other")
      .then((r) => { if (alive) setLink(r.link); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не удалось получить ссылку"); })
      .finally(() => { if (alive) setLinkLoading(false); });
    return () => { alive = false; };
  }, [needLink, link]);

  const pick = (a: AppKind) => {
    setApp(a);
    setErr("");
    setStep(a === "other" ? "link" : "install");
  };

  const install = () => {
    if (!app) return;
    const url = installUrl(app, device);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const add = async () => {
    if (!app || busy) return;
    setBusy(true);
    setErr("");
    try {
      openDeepLink(await fetchAppLink(app));
      setStep("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось получить ссылку");
    } finally {
      setBusy(false);
    }
  };

  const title = step === "device" ? "Добавить подписку"
    : step === "pick" ? "Приложение"
    : step === "link" ? "Ссылка на подписку"
    : step === "done" ? "" : step === "install" && device === "android_tv" ? "Happ" : APP_META[app || "incy"].title;

  // Android TV: без кнопок — только инструкция (Happ + ввод ссылки вручную)
  const tvGuide = step === "install" && device === "android_tv";

  const isTv = device === "android_tv";
  const back = step === "pick" || step === "install" || step === "add" || step === "link";
  const goBack = () => {
    setErr("");
    if (step === "add") setStep("install");
    else if (step === "install") setStep(isTv ? "device" : "pick");
    else if (step === "link") setStep("pick");
    else setStep("device");
  };
  // Номер шага и сколько всего: обычно 4, для Android TV — 2, для «другого приложения» — 3
  const stepTotal = isTv ? 2 : app === "other" && (step === "link" || step === "pick") ? 3 : 4;
  const stepNo = step === "device" ? 1
    : step === "pick" ? 2
    : step === "install" ? (isTv ? 2 : 3)
    : step === "add" ? 4
    : step === "link" ? 3 : 0;

  return (
    <div
      onClick={() => !busy && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,6,4,0.7)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 40,
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
          borderRadius: "22px 22px 0 0",
          padding: "16px 22px calc(26px + var(--blin-tg-pad-bottom, 0px) / var(--blin-scale))",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          animation: "blinvpnSheetUp 0.28s var(--ease-out) both",
        }}
      >
        <div style={{ width: 36, height: 3, borderRadius: 2, background: T.textDim, margin: "0 auto 6px" }} />

        {title ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
            {back ? (
              <button
                type="button"
                aria-label="Назад"
                className="blin-press"
                onClick={goBack}
                style={{ ...btnReset, width: 32, height: 32, borderRadius: 10, background: T.surface, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: T.text }}
              >
                <MSIcon name="chevron_left" style={{ fontSize: 20 }} />
              </button>
            ) : null}
            {(step === "install" || step === "add") && (app || isTv) ? <AppIcon app={tvGuide ? "happ" : (app || "happ")} size={32} /> : null}
            <div style={{ fontWeight: 600, fontSize: 18, color: T.text, flex: 1 }}>{title}</div>
            {stepNo ? (
              <div style={{ fontSize: 12, color: T.textDim, fontWeight: 500 }}>Шаг {stepNo} из {stepTotal}</div>
            ) : null}
          </div>
        ) : null}

        {step === "pick" && (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
              Выберите приложение для {DEVICE_TITLE[device]}.
            </div>
            {(["incy", "happ", "other"] as const).map((a) => {
              const m = APP_META[a];
              return (
                <button
                  key={a}
                  type="button"
                  className="blin-press"
                  onClick={() => pick(a)}
                  style={{
                    ...btnReset,
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    width: "100%",
                    minHeight: 64,
                    padding: "12px 16px",
                    borderRadius: T.radius.lg,
                    border: m.recommended ? `1px solid ${T.orange}` : `1px solid ${T.border}`,
                    background: T.surface,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <AppIcon app={a} />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 16, color: T.text }}>{m.title}</span>
                      {m.recommended ? <span style={{ fontSize: 11, fontWeight: 600, color: T.orange }}>рекомендуем</span> : null}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: T.textMuted, marginTop: 2 }}>{m.sub}</span>
                  </span>
                  <MSIcon name="chevron_right" style={{ color: T.orange }} />
                </button>
              );
            })}
          </>
        )}

        {step === "device" && (
          <>
            <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.45 }}>
              На каком устройстве будете пользоваться VPN?
            </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, margin: "4px 0 6px" }}>
                {DEVICES.map((d) => {
                  const on = d === device;
                  return (
                    <button
                      key={d}
                      type="button"
                      className="blin-press"
                      onClick={() => { setDevice(d); setErr(""); setStep(d === "android_tv" ? "install" : "pick"); }}
                      style={{
                        ...btnReset,
                        height: 68,
                        borderRadius: T.radius.md,
                        background: on ? T.orangeSoft : T.surface,
                        border: `1px solid ${on ? T.orange : T.border}`,
                        color: on ? T.orange : T.text,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 4,
                        cursor: "pointer",
                      }}
                    >
                      <MSIcon name={DEVICE_ICON[d]} style={{ fontSize: 24 }} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{DEVICE_TITLE[d]}</span>
                    </button>
                  );
                })}
              </div>
          </>
        )}

        {step === "install" && (app || isTv) && (
          <>
            {/* Выбранное устройство — можно сменить */}
              <button
                type="button"
                className="blin-press"
                onClick={() => setStep("device")}
                style={{
                  ...btnReset,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: T.radius.md,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <MSIcon name={DEVICE_ICON[device]} style={{ fontSize: 22, color: T.text }} />
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12, color: T.textDim }}>Устройство</span>
                  <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: T.text }}>{DEVICE_TITLE[device]}</span>
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.orange }}>Сменить</span>
              </button>

            {device === "android_tv" ? (
              <>
                {[
                  "На телевизоре откройте Google Play и установите Happ.",
                  "В Happ добавьте подписку вручную (кнопка «+») и введите ссылку:",
                ].map((text, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span style={{ width: 24, height: 24, borderRadius: 12, background: T.surfaceRaised, color: T.orange, fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {i + 1}
                    </span>
                    <span style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.45, paddingTop: 2 }}>{text}</span>
                  </div>
                ))}
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: T.radius.md,
                    background: T.surfaceRaised,
                    color: T.text,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 15,
                    lineHeight: 1.5,
                    wordBreak: "break-all",
                    userSelect: "all",
                    textAlign: "center",
                  }}
                >
                  {linkLoading ? "Загрузка…" : link || err || "—"}
                </div>
                <div style={{ fontSize: 12, color: T.textDim, textAlign: "center" }}>
                  Вводите внимательно: важны заглавные и строчные буквы.
                </div>
              </>
            ) : app ? (
              <>
                <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.45 }}>
                  Скачайте и установите {APP_META[app].title} на {DEVICE_TITLE[device]}.
                </div>
                <Btn onClick={install}>
                  <MSIcon name="download" style={{ fontSize: 18, marginRight: 6 }} /> Скачать {APP_META[app].title}
                </Btn>
                <TextButton onClick={() => { setErr(""); setStep("add"); }}>Далее</TextButton>
              </>
            ) : null}
          </>
        )}

        {step === "add" && app && (
          <>
            <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.45, marginBottom: 4 }}>
              Нажмите кнопку — подписка сама добавится в {APP_META[app].title}. После этого откройте приложение и подключитесь.
            </div>
            <Btn disabled={busy} onClick={() => void add()}>
              {busy ? "Открываем…" : "Добавить подписку"}
            </Btn>
            {err ? <div style={{ fontSize: 12, color: T.danger, textAlign: "center" }}>{err}</div> : null}
          </>
        )}

        {step === "link" && (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 4, lineHeight: 1.4 }}>
              Скопируйте ссылку и добавьте её в своё VPN-приложение как подписку.
            </div>
            <SubLinkBox link={link} loading={linkLoading} error={err} />
          </>
        )}

        {step === "done" && app && (
          <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
            <MSIcon name="check_circle" style={{ fontSize: 56, color: T.orange }} />
            <div style={{ fontWeight: 600, fontSize: 18, color: T.text, marginTop: 10 }}>Подписка добавлена</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6, lineHeight: 1.45 }}>
              Откройте {APP_META[app].title} и нажмите «Подключиться».
            </div>
          </div>
        )}


        {step === "device" ? <TextButton onClick={onClose}>Отмена</TextButton> : null}
        {step === "done" ? (
          <>
            <Btn onClick={onClose} style={{ marginTop: 6 }}>Готово</Btn>
            <TextButton onClick={() => void add()}>Не добавилась? Ещё раз</TextButton>
          </>
        ) : null}
      </div>
    </div>
  );
}
