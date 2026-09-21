import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// Каталог assets в корне репозитория (рядом с src). Локально это ../../assets,
// в Docker-сборке — ../assets (см. Dockerfile.panel). Берём тот, что существует.
function findAssetsDir(): string | null {
  for (const rel of ['../../assets', '../assets']) {
    const p = path.resolve(__dirname, rel)
    if (fs.existsSync(p)) return p
  }
  return null
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
}

/** Отдаёт /assets/* из корневого каталога assets в dev и копирует их в сборку. */
function rootAssets(): Plugin {
  return {
    name: 'blinvpn-panel-root-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? req.url.split('?')[0] : ''
        if (!url.startsWith('/assets/')) return next()
        const dir = findAssetsDir()
        if (!dir) return next()
        const file = path.join(dir, decodeURIComponent(url.slice('/assets/'.length)))
        if (file.startsWith(dir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
          fs.createReadStream(file).pipe(res)
          return
        }
        next()
      })
    },
    closeBundle() {
      const dir = findAssetsDir()
      if (!dir) return
      const out = path.resolve(__dirname, 'dist/assets')
      fs.mkdirSync(out, { recursive: true })
      for (const entry of fs.readdirSync(dir)) {
        if (entry.toLowerCase() === 'readme.md') continue
        const src = path.join(dir, entry)
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(out, entry))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), rootAssets()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: './index.html'
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 3001
  },
  preview: {
    host: '0.0.0.0',
    port: 3001
  }
})
