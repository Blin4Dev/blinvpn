import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";
import { initTelegramViewport, initStageScale } from "./utils/telegram";
import { captureWebRef } from "./utils/api";

// Разворачиваем на всю высоту и вписываем макет 402px в ширину экрана.
initStageScale();
initTelegramViewport();
// Реферальная ссылка сайта: /?ref=<id> — запоминаем до регистрации.
captureWebRef();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Снимаем стартовый лоадер после первого рендера
requestAnimationFrame(() => {
  const boot = document.getElementById("blin-boot");
  if (boot) boot.remove();
});

