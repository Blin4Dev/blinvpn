import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";
import { initTelegramViewport, initStageScale } from "./utils/telegram";
import { captureWebRef } from "./utils/api";
import { ensureTelegram } from "./utils/tgBoot";

// масштаб — сразу (сплэш из index.html уже на экране)
initStageScale();

// внутри telegram ждём sdk (асинхронный, ≤4 с), на сайте — сразу
void ensureTelegram().then(() => {
  initTelegramViewport();
  // запомнить ?ref= до регистрации
  captureWebRef();

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  // убрать сплэш из index.html после первой отрисовки
  requestAnimationFrame(() => {
    const boot = document.getElementById("blin-boot");
    if (boot) boot.remove();
  });
});
