import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { BrandSplash, LoadingScreen } from "./components/ui";
import { AppErrorProvider } from "./components/ErrorModal";
import { checkAuth, fetchMe, fetchMembership, fetchSetupStatus, type Membership } from "./utils/api";
import { holdHomeIntro, homeIntroPending, releaseHomeIntro, setFastHomeIntro, subscribeHomeIntroReady } from "./utils/homeIntro";
import { trackRoute } from "./utils/navigation";
import { checkMaintenance, useMaintenance } from "./utils/maintenance";
import Maintenance from "./pages/Maintenance";

/*
  загрузка по частям:
  1) основной файл — только сплэш, проверка входа и каркас (появляется сразу);
  2) главная — начинает качаться параллельно с проверкой входа;
  3) онбординг/вход — только если он нужен этому пользователю;
  4) остальные страницы — фоном, когда главная уже на экране.
*/
const loadHome = () => import("./pages/Home");
const loadOnboarding = () => import("./pages/Onboarding");
const Home = lazy(loadHome);
const Onboarding = lazy(loadOnboarding);
const pageLoaders = {
  history: () => import("./pages/History"),
  subscription: () => import("./pages/ManageSubscription"),
  payment: () => import("./pages/Payment"),
  promocode: () => import("./pages/Promocode"),
  referral: () => import("./pages/Referral"),
  settings: () => import("./pages/Settings"),
  security: () => import("./pages/Security"),
  support: () => import("./pages/Support"),
  devices: () => import("./pages/DevicesLists"),
  extend: () => import("./pages/ExtendSubscription"),
  increase: () => import("./pages/IncreaseDevices"),
  legal: () => import("./pages/LegalDocument"),
  setupPrompt: () => import("./components/SetupPrompt"),
  paymentResume: () => import("./components/PaymentResume"),
};
const History = lazy(pageLoaders.history);
const ManageSubscription = lazy(pageLoaders.subscription);
const Payment = lazy(pageLoaders.payment);
const Promocode = lazy(pageLoaders.promocode);
const Referral = lazy(pageLoaders.referral);
const Settings = lazy(pageLoaders.settings);
const Security = lazy(pageLoaders.security);
const Support = lazy(pageLoaders.support);
const DevicesLists = lazy(pageLoaders.devices);
const ExtendSubscription = lazy(pageLoaders.extend);
const IncreaseDevices = lazy(pageLoaders.increase);
const LegalDocument = lazy(pageLoaders.legal);
const SetupPrompt = lazy(pageLoaders.setupPrompt);
const PaymentResume = lazy(pageLoaders.paymentResume);

// главная и онбординг — сразу, параллельно с проверкой входа
// (онбординг ~12 КБ: новичку нужен всегда, у остальных уже лежит в кеше)
void loadHome().catch(() => { /* повторит lazy */ });
void loadOnboarding().catch(() => { /* повторит lazy */ });

// остальное — фоном, по одному, когда браузер свободен
let prefetched = false;
function prefetchPages() {
  if (prefetched) return;
  prefetched = true;
  const queue = Object.values(pageLoaders);
  const idle = (cb: () => void) =>
    "requestIdleCallback" in window
      ? (window as unknown as { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback(cb, { timeout: 2000 })
      : globalThis.setTimeout(cb, 300);
  const next = () => {
    const load = queue.shift();
    if (!load) return;
    void load().catch(() => { /* загрузится при переходе */ }).finally(() => idle(next));
  };
  idle(next);
}

// подсказка настройки: раз за сессию
const SETUP_PROMPT_DISMISSED_KEY = "blinvpn_setup_prompt_dismissed";

function useHomeIntroReady() {
  const [ready, setReady] = useState(() => !homeIntroPending());
  useEffect(() => {
    if (ready) return;
    return subscribeHomeIntroReady(() => setReady(true));
  }, [ready]);
  return ready;
}

function AnimatedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  // анимация входа только при навигации, не на первом экране и не при ре-рендере App
  const initialKey = useRef(location.key);
  const introReady = useHomeIntroReady();
  useEffect(() => {
    if (introReady) prefetchPages();
  }, [introReady]);
  // ключ заблокирован: только главная
  const [blocked, setBlocked] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

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
  const animate = location.key !== initialKey.current;
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
        <Suspense fallback={<LoadingScreen />}>
          <Outlet />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        {introReady && showSetup && !blocked && (
          <SetupPrompt onContinue={continueSetup} onClose={dismissSetup} />
        )}
        {introReady && !blocked && <PaymentResume />}
      </Suspense>
    </div>
  );
}

function MainApp() {
  const [auth, setAuth] = useState<"checking" | "authed" | "anon">("checking");
  const [gate, setGate] = useState<"checking" | "open" | "blocked">("checking");
  const [membership, setMembership] = useState<Membership | null>(null);
  // оферта при первом входе
  const [terms, setTerms] = useState<"checking" | "ok" | "need">("checking");
  // онбординг: show → handoff (главная монтируется под финалом) → done
  const [onboarding, setOnboarding] = useState<"show" | "handoff" | "done">("show");
  // вход на сайте идёт внутри онбординга; после входа он же продолжает шаги — не размонтируем
  const [authFlow, setAuthFlow] = useState(false);
  // главная уже была на экране — больше не размонтируем (поздний шаг канала — поверх неё)
  const [appShown, setAppShown] = useState(false);
  // шаг с каналом пройден в этой сессии
  const [channelPassed, setChannelPassed] = useState(false);
  useEffect(() => {
    if (auth !== "authed" || terms === "checking" || gate === "checking") return;
    const need = onboarding !== "done" && (authFlow || terms === "need" || gate === "blocked");
    if (!need || onboarding === "handoff") setAppShown(true);
  }, [auth, terms, gate, onboarding, authFlow]);
  // ответ про канал пришёл после онбординга — показываем шаг канала поверх главной
  useEffect(() => {
    if (gate === "blocked" && onboarding === "done" && !channelPassed) setOnboarding("show");
  }, [gate, onboarding, channelPassed]);
  useEffect(() => {
    if (auth === "anon") setAuthFlow(true);
  }, [auth]);

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
    // не дольше 6 с: при сбое считаем, что оферта принята (сервер всё равно проверит при действиях)
    void fetchMe(6000)
      .then((me) => { if (mounted) setTerms(me && me.terms_accepted === false ? "need" : "ok"); })
      .catch(() => mounted && setTerms("ok"));
    return () => { mounted = false; };
  }, [auth]);

  // подписка на канал только для входа через telegram
  useEffect(() => {
    if (auth !== "authed") return;
    let mounted = true;
    // сервер проверяет подписку через telegram api (до 5 с) — сплэш ждёт не дольше 2,5 с.
    // ответ позже: шаг с каналом добавится в онбординг или покажется поверх главной
    const soft = window.setTimeout(() => {
      if (mounted) setGate((g) => (g === "checking" ? "open" : g));
    }, 2500);
    // всегда проверяем; для email сервер вернёт required=false
    void fetchMembership(false, 15000)
      .then((m) => {
        if (!mounted) return;
        setMembership(m);
        setGate(m.required && !m.subscribed ? "blocked" : "open");
      })
      .catch(() => mounted && setGate((g) => (g === "checking" ? "open" : g)))
      .finally(() => window.clearTimeout(soft));
    return () => {
      mounted = false;
      window.clearTimeout(soft);
    };
  }, [auth]);

  if (auth === "checking") return <BrandSplash />;
  // пока не знаем про оферту/канал — тот же сплэш (логотип по центру)
  const inAuthFlow = authFlow || auth === "anon";
  if (!inAuthFlow && (terms === "checking" || gate === "checking")) return <BrandSplash />;

  const needOnboarding = onboarding !== "done" && (inAuthFlow || terms === "need" || gate === "blocked");
  // одна и та же структура дерева, чтобы главная не перемонтировалась после онбординга
  const showApp = appShown || !needOnboarding || onboarding === "handoff";
  return (
    <>
      {showApp ? <RoutedApp /> : null}
      {needOnboarding ? (
        <Suspense fallback={showApp ? null : <BrandSplash />}>
        <Onboarding
          needAuth={auth === "anon"}
          overlay={appShown}
          onAuthed={() => setAuth("authed")}
          needTerms={terms === "need"}
          membership={gate === "blocked" ? membership : null}
          onHandoff={() => {
            // финал кончается логотипом по центру → главная сразу продолжает интро
            setFastHomeIntro();
            holdHomeIntro();
            setOnboarding("handoff");
          }}
          onDone={(passed) => {
            if (passed.terms) setTerms("ok");
            if (passed.channel) {
              setChannelPassed(true);
              setGate("open");
            }
            setOnboarding("done");
            releaseHomeIntro();
          }}
        />
        </Suspense>
      ) : null}
    </>
  );
}

// корень: страница техработ подменяет ВСЁ приложение — ни маршрутов, ни онбординга под ней нет
export default function App() {
  const maint = useMaintenance();
  const active = maint === "manual" || maint === "down";
  const wasActive = useRef(false);

  useEffect(() => {
    void checkMaintenance();
  }, []);

  // пока открыто: раз в минуту (на странице техработ — каждые 10 с) и при возврате в приложение
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void checkMaintenance();
    };
    const id = window.setInterval(tick, active ? 10_000 : 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active]);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      try {
        (window as unknown as { Telegram?: { WebApp?: { BackButton?: { hide?: () => void } } } }).Telegram?.WebApp?.BackButton?.hide?.();
      } catch {
        /* ignore */
      }
    } else if (maint === "ok" && wasActive.current) {
      // работы закончились: начисто перезапускаем, чтобы не осталось ошибок, полученных во время сбоя
      window.location.reload();
    }
  }, [active, maint]);

  if (active) return <Maintenance />;
  return <MainApp />;
}

function RoutedApp() {
  return (
    <AppErrorProvider>
    <BrowserRouter>
      <Routes>
        <Route element={<AnimatedLayout />}>
          <Route path="/" element={<Suspense fallback={<BrandSplash />}><Home /></Suspense>} />
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
