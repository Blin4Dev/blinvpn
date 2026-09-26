import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Home from "./pages/Home";
import DevicesLists from "./pages/DevicesLists";
import ExtendSubscription from "./pages/ExtendSubscription";
import History from "./pages/History";
import IncreaseDevices from "./pages/IncreaseDevices";
import ManageSubscription from "./pages/ManageSubscription";
import Payment from "./pages/Payment";
import Promocode from "./pages/Promocode";
import Referral from "./pages/Referral";
import Settings from "./pages/Settings";
import Security from "./pages/Security";
import LegalDocument from "./pages/LegalDocument";
import Authentication from "./pages/Authentication";
import ChannelGate from "./pages/ChannelGate";
import SetupPrompt from "./components/SetupPrompt";
import { LoadingScreen } from "./components/ui";
import { AppErrorProvider } from "./components/ErrorModal";
import { checkAuth, fetchMe, fetchMembership, fetchSetupStatus, type Membership } from "./utils/api";
import { trackRoute } from "./utils/navigation";
import PaymentResume from "./components/PaymentResume";
import TermsGate from "./pages/TermsGate";

// Показываем онбординг-модалку не чаще одного раза за сессию приложения.
const SETUP_PROMPT_DISMISSED_KEY = "blinvpn_setup_prompt_dismissed";

function AnimatedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const skipEnterAnimation = useRef(true);
  // Блокировка ключа: если ключ заблокирован — держим пользователя только на главной
  const [blocked, setBlocked] = useState(false);
  // Онбординг-модалка «Вы не завершили настройку»
  const [showSetup, setShowSetup] = useState(false);

  useLayoutEffect(() => {
    skipEnterAnimation.current = false;
  }, []);

  useEffect(() => {
    let mounted = true;
    void fetchMe()
      .then((me) => { if (mounted) setBlocked(me?.subscription_status === "blocked" || me?.subscription_status === "banned"); })
      .catch(() => { /* ignore */ });
    return () => { mounted = false; };
  }, []);

  // Один раз за заход: если есть подписка, но пользователь ни разу не
  // подключался — показываем модалку. Крестик закрывает её до конца сессии.
  useEffect(() => {
    let mounted = true;
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(SETUP_PROMPT_DISMISSED_KEY) === "1"; } catch { /* ignore */ }
    if (dismissed) return;
    void fetchSetupStatus()
      .then((s) => { if (mounted) setShowSetup(!!s.show_setup_prompt); })
      .catch(() => { /* ignore */ });
    return () => { mounted = false; };
  }, []);

  const dismissSetup = () => {
    setShowSetup(false);
    try { sessionStorage.setItem(SETUP_PROMPT_DISMISSED_KEY, "1"); } catch { /* ignore */ }
  };
  const continueSetup = () => {
    dismissSetup();
    navigate("/subscription?setup=1");
  };

  // При заблокированном ключе любой прямой переход по URL выкидывает на главную
  useEffect(() => {
    if (blocked && location.pathname !== "/") {
      navigate("/", { replace: true });
    }
  }, [blocked, location.pathname, navigate]);

  const fromBack = navType === "POP";
  const animate = !skipEnterAnimation.current;
  const animation = animate
    ? `${fromBack ? "blinvpnPageInBackward" : "blinvpnPageInForward"} 0.42s cubic-bezier(0.22, 1, 0.36, 1) both`
    : "none";

  useEffect(() => {
    trackRoute(`${location.pathname}${location.search}`, navType === "REPLACE");
  }, [location.pathname, location.search, navType]);

  return (
    <div
      style={{
        height: "100%",
        overflow: "clip",
        background: "#14110E",
        isolation: "isolate",
      }}
    >
      <div
        key={location.pathname}
        style={{
          height: "100%",
          animation,
          backfaceVisibility: "hidden",
          ...(animate ? { willChange: "opacity, transform" } : {}),
        }}
      >
        <Outlet />
      </div>
      {showSetup && !blocked && (
        <SetupPrompt onContinue={continueSetup} onClose={dismissSetup} />
      )}
      {!blocked && <PaymentResume />}
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<"checking" | "authed" | "anon">("checking");
  const [gate, setGate] = useState<"checking" | "open" | "blocked">("checking");
  const [membership, setMembership] = useState<Membership | null>(null);
  // Согласие с документами: при первом входе (и у тех, кто ещё не соглашался)
  const [terms, setTerms] = useState<"checking" | "ok" | "need">("checking");

  useEffect(() => {
    let mounted = true;
    void checkAuth()
      .then((ok) => mounted && setAuth(ok ? "authed" : "anon"))
      .catch(() => mounted && setAuth("anon"));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (auth !== "authed") return;
    let mounted = true;
    void fetchMe()
      .then((me) => { if (mounted) setTerms(me && me.terms_accepted === false ? "need" : "ok"); })
      .catch(() => mounted && setTerms("ok"));
    return () => { mounted = false; };
  }, [auth]);

  // Обязательная подписка на канал — только для Telegram-входа.
  useEffect(() => {
    if (auth !== "authed") return;
    let mounted = true;
    // Проверяем всегда: сервер сам ответит required=false для входа по почте.
    void fetchMembership()
      .then((m) => {
        if (!mounted) return;
        setMembership(m);
        setGate(m.required && !m.subscribed ? "blocked" : "open");
      })
      .catch(() => mounted && setGate("open"));
    return () => {
      mounted = false;
    };
  }, [auth]);

  if (auth === "checking") return <LoadingScreen />;
  if (auth === "anon") return <Authentication onAuthed={() => setAuth("authed")} />;

  // Приложение рендерим сразу, а просьбу подписаться показываем
  // всплывающим окном поверх него.
  return (
    <>
      <RoutedApp />
      {terms === "need" ? (
        <TermsGate onAccepted={() => setTerms("ok")} />
      ) : gate === "blocked" && membership ? (
        <ChannelGate membership={membership} onPassed={() => setGate("open")} />
      ) : null}
    </>
  );
}

function RoutedApp() {
  return (
    <AppErrorProvider>
    <BrowserRouter>
      <Routes>
        <Route element={<AnimatedLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/history" element={<History />} />
          <Route path="/subscription" element={<ManageSubscription />} />
          {/* Старая страница настройки заменена окном «Добавить подписку» */}
          <Route path="/subscription/start" element={<Navigate to="/subscription?setup=1" replace />} />
          <Route path="/payment" element={<Payment />} />
          <Route path="/promocode" element={<Promocode />} />
          <Route path="/referral" element={<Referral />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/security" element={<Security />} />
          <Route path="/subscription/devices" element={<DevicesLists />} />
          <Route path="/subscription/extend" element={<ExtendSubscription />} />
          <Route path="/subscription/increase" element={<IncreaseDevices />} />
          <Route path="/legal/:kind" element={<LegalDocument />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </AppErrorProvider>
  );
}
