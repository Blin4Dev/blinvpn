import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/**
 * Мини‑приложение BlinVPN
 * Vite root перенесён в src/app, чтобы системные файлы жили внутри app.
 */

// Единственный источник картинок — каталог assets в КОРНЕ репозитория (рядом с src).
const ASSETS_DIR = path.resolve(__dirname, "../../assets");
const OUT_ASSETS = path.resolve(__dirname, "../../dist/miniapp/assets");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

/** Отдаёт /assets/* из корневого каталога assets в dev-сервере и копирует их в сборку. */
function rootAssets(): Plugin {
  return {
    name: "blinvpn-root-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? req.url.split("?")[0] : "";
        if (!url.startsWith("/assets/")) return next();
        const rel = decodeURIComponent(url.slice("/assets/".length));
        const file = path.join(ASSETS_DIR, rel);
        if (
          file.startsWith(ASSETS_DIR + path.sep) &&
          fs.existsSync(file) &&
          fs.statSync(file).isFile()
        ) {
          res.setHeader(
            "Content-Type",
            MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          );
          fs.createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
    closeBundle() {
      // Страница-переходник для deep-link Incy/Happ (Telegram не открывает их схемы
      // напрямую). Без неё /redirect.html отдавал бы само мини-приложение.
      const redirectSrc = path.resolve(__dirname, "../site/redirect.html");
      if (fs.existsSync(redirectSrc)) {
        fs.copyFileSync(redirectSrc, path.resolve(__dirname, "../../dist/miniapp/redirect.html"));
      }
      if (!fs.existsSync(ASSETS_DIR)) return;
      fs.mkdirSync(OUT_ASSETS, { recursive: true });
      for (const entry of fs.readdirSync(ASSETS_DIR)) {
        if (entry.toLowerCase() === "readme.md") continue;
        const src = path.join(ASSETS_DIR, entry);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(OUT_ASSETS, entry));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), rootAssets()],
  // Запускаем Vite из корня проекта, поэтому root задаём как путь от корня.
  root: "src/app",
  base: "/",
  build: {
    outDir: "../../dist/miniapp",
    emptyOutDir: true,
  },
});
