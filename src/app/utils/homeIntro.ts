const HOME_INTRO_READY = "blinvpn-home-intro-ready";

/** живёт только в этой загрузке JS: reload снова играет интро, «назад» — нет */
let introPlayed = false;

/** интро только при входе / перезагрузке, не при «назад» */
export function homeIntroPending(): boolean {
  return !introPlayed;
}

/** после онбординга логотип уже по центру — не держим сплэш */
let fastIntro = false;
export function setFastHomeIntro(): void {
  fastIntro = true;
}
export function consumeFastHomeIntro(): boolean {
  const v = fastIntro;
  fastIntro = false;
  return v;
}

/** главная смонтирована под оверлеем онбординга: ждём, пока его уберут */
const HOME_INTRO_RELEASE = "blinvpn-home-intro-release";
let introHeld = false;
export function holdHomeIntro(): void {
  introHeld = true;
}
export function releaseHomeIntro(): void {
  if (!introHeld) return;
  introHeld = false;
  try {
    window.dispatchEvent(new Event(HOME_INTRO_RELEASE));
  } catch { /* ignore */ }
}
export function whenHomeIntroReleased(cb: () => void): () => void {
  if (!introHeld) {
    cb();
    return () => {};
  }
  const on = () => cb();
  window.addEventListener(HOME_INTRO_RELEASE, on, { once: true });
  return () => window.removeEventListener(HOME_INTRO_RELEASE, on);
}

export function markHomeIntroPlayed(): void {
  introPlayed = true;
}

/** шиты и модалки можно показывать поверх главной */
export function signalHomeIntroReady(): void {
  markHomeIntroPlayed();
  try {
    window.dispatchEvent(new Event(HOME_INTRO_READY));
  } catch { /* ignore */ }
}

export function subscribeHomeIntroReady(cb: () => void): () => void {
  if (!homeIntroPending()) {
    cb();
    return () => {};
  }
  const onReady = () => cb();
  window.addEventListener(HOME_INTRO_READY, onReady);
  return () => window.removeEventListener(HOME_INTRO_READY, onReady);
}
