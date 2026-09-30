import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";
import { initTelegramViewport, initStageScale } from "./utils/telegram";
import { captureWebRef } from "./utils/api";

initStageScale();
initTelegramViewport();
// запомнить ?ref= до регистрации
captureWebRef();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// убрать спиннер после первой отрисовки
requestAnimationFrame(() => {
  const boot = document.getElementById("blin-boot");
  if (boot) boot.remove();
});

