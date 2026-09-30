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
import Support from "./pages/Support";
import { checkAuth, fetchMe, fetchMembership, fetchSetupStatus, type Membership } from "./utils/api";
import { trackRoute } from "./utils/navigation";
import PaymentResume from "./components/PaymentResume";
import TermsGate from "./pages/TermsGate";

// подсказка настройки: раз за сессию
const SETUP_PROMPT_DISMISSED_KEY = "blinvpn_setup_prompt_dismissed";

function AnimatedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const skipEnterAnimation = useRef(true);
  // ключ заблокирован: только главная
  const [blocked, setBlocked] = useState(false);
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

  // подписка есть, но ни разу не подключался
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

  // ключ заблокирован: любой deep link → на главную
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
  // оферта при первом входе
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

  // подписка на канал только для входа через telegram
  useEffect(() => {
    if (auth !== "authed") return;
    let mounted = true;
    // всегда проверяем; для email сервер вернёт required=false
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

  // рисуем приложение; канал — оверлей
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
          <Route path="/subscription/start" element={<Navigate to="/subscription?setup=1" replace />} />
          <Route path="/payment" element={<Payment />} />
          <Route path="/payment/return" element={<Navigate to="/" replace />} />
          <Route path="/promocode" element={<Promocode />} />
          <Route path="/referral" element={<Referral />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/security" element={<Security />} />
          <Route path="/support" element={<Support />} />
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
