const HOME_INTRO_READY = "blinvpn-home-intro-ready";

/** живёт только в этой загрузке JS: reload снова играет интро, «назад» — нет */
let introPlayed = false;

/** интро только при входе / перезагрузке, не при «назад» */
export function homeIntroPending(): boolean {
  return !introPlayed;
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
