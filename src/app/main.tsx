import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";
import { initTelegramViewport } from "./utils/telegram";

// Полноэкранный режим на телефоне / на всю высоту на компьютере.
initTelegramViewport();

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

