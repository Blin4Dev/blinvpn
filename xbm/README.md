# xray-balancer-mw

**Production-grade middleware для [Remnawave VPN Panel](https://remna.st/)** — превращает обычную подписку в умную: с группировкой по странам, балансировкой нагрузки, sticky-сессиями и каскадным failover.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-103%2F103-brightgreen)]()
[![Version](https://img.shields.io/badge/version-3.1.0-blue)]()
[![License](https://img.shields.io/badge/license-See%20LICENSE-lightgrey)]()

---

## 📖 Содержание

- [Что он делает](#-что-он-делает)
- [Возможности](#-возможности)
- [Как это работает](#-как-это-работает)
- [Быстрый старт (Docker)](#-быстрый-старт-docker)
- [Установка без Docker](#-установка-без-docker)
- [Reverse proxy (nginx / Caddy)](#-reverse-proxy-nginx--caddy)
- [Настройка Remnawave (response rules)](#-настройка-remnawave-response-rules)
- [Конфигурация: config.json](#-конфигурация-configjson)
- [Тонкая настройка](#-тонкая-настройка)
- [Endpoints](#-endpoints)
- [Sticky-сессии](#-sticky-сессии)
- [Tier-failover](#-tier-failover)
- [LTE fallback](#-lte-fallback)
- [Расчёт нагрузки](#-расчёт-нагрузки)
- [Troubleshooting](#-troubleshooting)
- [Обновление](#-обновление)
- [Разработка](#-разработка)

---

## 🎯 Что он делает

Middleware стоит **между Remnawave panel и VPN-клиентом** пользователя. Он:

```
        ┌────────────────────────────┐
VPN     │   GET /<token>             │
клиент  ├────────────────────────────┤            ┌─────────────────────┐
   ───► │   xray-balancer-mw         │  ───────►  │  Remnawave panel    │
        │   • группирует по странам  │            │  /api/sub/<token>   │
        │   • балансирует нагрузку   │            └─────────────────────┘
        │   • sticky-сессии          │
        │   • tier-failover          │
        │   • генерирует под клиент  │
        └────────────────────────────┘
                    │
                    ▼
        ┌────────────────────────────┐
        │   готовая подписка         │
        │   Xray-JSON / Mihomo YAML  │
        │   / Sing-box JSON          │
        └────────────────────────────┘
```

---

## ✨ Возможности

| Фича | Что делает |
|---|---|
| 🌍 **Группировка по странам** | Серверы в подписке отображаются как `🇫🇮 Финляндия`, `🇩🇪 Германия` и т.д. |
| ⚖️ **Балансировка нагрузки** | `burstObservatory` пингует серверы, трафик распределяется через `leastLoad` |
| 🔄 **Каскадный failover** | main → LTE → all (или tier1 → tier2 → all). Юзер ВСЕГДА получает рабочий сервер |
| 📌 **Sticky-сессии** | Юзер прибивается к своему серверу. Не плавает IP → нет recaptcha и релогинов |
| 🚀 **Tier-failover** | Топ-N жирных серверов получают весь трафик, остальные ждут в резерве |
| 🎯 **Поддержка форматов** | Happ, V2RayTun, V2Ray, Mihomo (Clash Meta), FlClash, Sing-box, Hiddify |
| 🗺️ **Happ routing** | geosite/geoip правила из base64 или URL |
| 🛡️ **Защита** | Bearer auth, rate-limit per HWID/IP, SSRF guard, DoS-защита |
| 🎨 **Кастомизация** | Имя AUTO-группы настраивается, описания групп для Happ, ?raw=1 для дебага |

---

## 🏗 Как это работает

```
1. Клиент делает GET /<token>
2. Middleware → Remnawave /api/sub/<token>
3. Получает массив outbound-конфигов
4. detectClientType(UA)            → определяет формат (Happ/Mihomo/Sing-box/...)
5. collectAllProxyOutbounds(...)   → собирает все proxy outbounds
6. nodeStats.filterAndSortByLoad   → фильтрует перегруженные ноды
7. matchGroup(ob.tag)              → группирует по country patterns
8. sticky.getOrAssign(...)         → назначает persistent сервер per-user
9. buildGroupConfig(...)           → собирает Xray balancer cascade
10. generateMihomoYaml / generateSingboxConfig — для соответствующих клиентов
```

**Каскад балансера** (главное архитектурное решение): через **loopback outbounds**, не прямой `fallbackTag: balancer-tag` (это сломано в Xray-core, см. XTLS #3068).

```
sticky-balancer  →  fallback  →  sticky-loopback  →  routing rule  →  main-balancer
main-balancer    →  fallback  →  main-loopback    →  routing rule  →  tier2-balancer
tier2-balancer   →  fallback  →  tier2-loopback   →  routing rule  →  all-balancer (last resort)
```

---

## 🚀 Быстрый старт (Docker)

> **Это рекомендуемый способ.** Если у тебя уже стоит Remnawave в Docker — ставь так.

### Требования

- Docker + Docker Compose
- Запущенный Remnawave panel в Docker-сети `remnawave-network`
- API token из Remnawave panel

### 1. Клонирование

```bash
git clone https://github.com/Haxonate/xray-balancer-mw.git /opt/xray-balancer-mw
cd /opt/xray-balancer-mw
```

### 2. Заполнить `.env`

```bash
cp .env.example .env
nano .env
```

Минимум что нужно заполнить:

```env
# URL Remnawave panel (контейнер в той же сети)
REMNAWAVE_URL=http://remnawave:3000

# Subscription page (контейнер в той же сети)
SUB_PAGE_URL=http://remnawave-subscription-page:3010

# Публичный домен подписки
SUB_DOMAIN=sub.example.com

# API токен Remnawave (Panel → Settings → API Tokens → Create)
API_TOKEN=eyJhbGc...ваш_токен

# Cookie если панель за nginx-basic-auth, иначе оставь пустым
PANEL_AUTH_COOKIE=
```

> 🔑 **Где взять API_TOKEN:** Remnawave panel → Settings → API Tokens → **Create new**.
> Токен нужен для:
> - Опроса `/api/nodes/` (фильтр перегруженных нод)
> - Auth admin endpoints балансера

### 3. Заполнить `config.json`

```bash
cp config.json.example config.json
nano config.json
```

Минимальная рабочая конфигурация:

```json
{
    "port": 4100,
    "log_level": "info",
    "fastest_group": true,

    "groups": {
        "🇫🇮 Финляндия": ["Finland"],
        "🇩🇪 Германия": ["German"],
        "🇪🇺 Europe LTE": ["LTE"]
    },

    "lte_patterns": ["LTE"],

    "node_stats": true,
    "node_stats_interval_sec": 120,
    "max_users_per_gb": 50,
    "max_users_per_cpu": 80
}
```

> 💡 **Что значит `groups`:**
> - **Ключ** — имя группы как отобразится в VPN-клиенте
> - **Значение** — массив подстрок которые должны быть в **теге сервера в Remnawave**
>
> Например: сервер с тегом `Finland-1` попадёт в группу `🇫🇮 Финляндия` (потому что в массиве есть `"Finland"`).

### 4. Запуск

```bash
docker compose up -d
docker compose logs -f xray-balancer-mw
```

При успешном старте увидишь:

```
🚀 Xray Balancer Middleware v3.1  порт 4100  уровень логов: INFO
📋 Группы:     🇫🇮 Финляндия [Finland] | 🇩🇪 Германия [German] | 🇪🇺 Europe LTE [LTE]
🏁 Быстрые:    ✅ "🇪🇺 AUTO | Самые быстрые"
🎯 Стратегия:  leastLoad (expected=3, tolerance=0.5/0.8)
📡 Probe:      каждые 3m (sampling=3, timeout=3s)
📊 Node stats: ✅ каждые 120с  макс 50 u/GB  80 u/CPU
🍪 Sticky:     ❌
🔧 Tier:       ❌
🚦 Rate limit: ✅ 5 req/60s per HWID/IP
🔓 Bearer:     ✅ /health (extended), /node-stats, /refresh-*, /sticky
```

### 5. Проверка

```bash
# Health
curl http://localhost:4100/health
# → {"status":"ok"}

# Стату нод (с Bearer)
curl -H "Authorization: Bearer $(grep API_TOKEN .env | cut -d= -f2)" \
     http://localhost:4100/node-stats | jq

# Тестовая подписка с Happ User-Agent
curl -A "Happ/1.0" "http://localhost:4100/<твой-token>" | jq '.[0].remarks'
# → "🇪🇺 AUTO | Самые быстрые"
```

### 6. Подключить к reverse proxy

См. раздел [Reverse proxy](#-reverse-proxy-nginx--caddy).

---

## 🛠 Установка без Docker

### Требования

- **Node.js ≥ 18** (`node --version`)
- Remnawave panel доступен по сети
- API token

### Установка

```bash
git clone https://github.com/Haxonate/xray-balancer-mw.git /opt/xray-balancer-mw
cd /opt/xray-balancer-mw

# Зависимостей у балансера нет — только Node.js stdlib
# npm test проверит что окружение готово
npm test
# Ожидание: 103 pass, 0 fail
```

### Конфигурация

```bash
cp .env.example .env && nano .env
cp config.json.example config.json && nano config.json
```

(Содержимое — как в [Docker-варианте](#2-заполнить-env).)

### Запуск через systemd

```bash
sudo tee /etc/systemd/system/xray-balancer-mw.service > /dev/null << 'EOF'
[Unit]
Description=Xray Balancer Middleware
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/xray-balancer-mw
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
EnvironmentFile=/opt/xray-balancer-mw/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now xray-balancer-mw
sudo systemctl status xray-balancer-mw
```

Логи: `journalctl -u xray-balancer-mw -f`

---

## 🌐 Reverse proxy (nginx / Caddy)

Чтобы маршрутизировать **браузер на subscription page** и **VPN-клиенты на балансер**, нужен reverse proxy с маршрутизацией по `User-Agent`.

В папке `examples/` уже готовые конфиги:

- `examples/nginx.conf` — полный nginx с TLS, SNI reject, маршрутизацией по UA
- `examples/Caddyfile` — то же на Caddy
- `examples/docker-compose.nginx.yml` — docker-compose который добавляет nginx в сеть Remnawave

### Краткий пример nginx

```nginx
upstream subscription_page  { server remnawave-subscription-page:3010; }
upstream xray_balancer_mw   { server xray-balancer-mw:4100; }

map $http_user_agent $backend {
    default                          subscription_page;
    ~*(?:happ|streisand|v2raytun)    xray_balancer_mw;
    ~*(?:v2ray|neko|foxray|v2box)    xray_balancer_mw;
    ~*(?:clash|mihomo|hiddify)       xray_balancer_mw;
    ~*(?:^sfa|^sfi|^sfm|karing)      xray_balancer_mw;
    ~*(?:singbox|flclash|stash)      xray_balancer_mw;
}

server {
    listen 443 ssl http2;
    server_name sub.example.com;

    ssl_certificate     /etc/letsencrypt/live/sub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sub.example.com/privkey.pem;

    location / {
        proxy_pass http://$backend;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

> ⚠️ **Критично:** проброс `X-Real-IP` и `X-Forwarded-For` обязателен. Без них rate-limiter видит всех клиентов как `127.0.0.1` → один bucket на всех клиентов.

---

## 📦 Настройка Remnawave (response rules)

Чтобы Remnawave знал в каком формате отдавать каждому VPN-клиенту, нужно настроить **Response Rules** в админке.

В файле `examples/response-rules.json` готовые правила для всех популярных клиентов. Просто импортируй их в Remnawave.

Альтернативно — настрой вручную:

| User-Agent regex | Response type |
|---|---|
| `(happ\|streisand\|v2raytun\|v2ray\|neko\|foxray\|v2box\|invisibleman)` | `XRAY_JSON` |
| `(flclash\|clash-verge\|clash-meta\|mihomo\|stash)` | `XRAY_JSON` (балансер сам конвертит в Mihomo YAML) |
| `(^sfa\|^sfi\|^sfm\|karing\|singbox\|hiddify)` | `XRAY_JSON` (балансер конвертит в Sing-box JSON) |
| Всё остальное | `XRAY_BASE64` |

> 💡 Балансер получает от Remnawave всегда `XRAY_JSON`, а потом сам конвертит в формат клиента (Mihomo YAML / Sing-box JSON / base64) по User-Agent. Это упрощает Response Rules — все VPN-клиенты получают один тип `XRAY_JSON`.

---

## ⚙️ Конфигурация: config.json

Все параметры **опциональные** кроме `groups` (или `auto_groups`).

### 🌐 Соединение

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `port` | int | `4100` | HTTP порт |
| `remnawave_url` | str | — | URL Remnawave (можно через env `REMNAWAVE_URL`) |
| `sub_path` | str | `/api/sub` | Subscription endpoint Remnawave |
| `sub_page_url` | str | — | URL subscription page (если есть) |
| `panel_auth_cookie` | str | — | Cookie если Remnawave за basic-auth |
| `log_level` | str | `info` | `debug` / `info` / `warn` / `error` / `silent` |

### 👥 Группы

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `groups` | object | `{}` | `имя` → `[паттерны для матча по тегу outbound]` |
| `auto_groups` | bool | `false` | Автогруппировка по странам через Remnawave hosts API |
| `auto_groups_interval_sec` | int | `300` | Интервал опроса hosts API |
| `auto_group_name` | str | `🇪🇺 AUTO \| Самые быстрые` | **Имя AUTO-группы** (можно переименовать под бренд) |
| `lte_patterns` | str[] | `["LTE"]` | Подстроки которые делают сервер "LTE" |
| `group_descriptions` | object | `{}` | Карта `имя` → текст для Happ description (макс 30 симв, поддерживает `{count}`) |

### ⚡ AUTO группа

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `fastest_group` | bool | `true` | Создавать AUTO группу со всеми серверами |
| `fastest_exclude` | str[] | `[]` | Группы которые **НЕ** должны попадать в AUTO |
| `fastest_fallback` | str[] | `[]` | Группы которые попадают в AUTO как **fallback** (LTE, не main) |

### ⚖️ Балансер / probe (КРИТИЧНО ДЛЯ ПРОДА)

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `strategy` | str | `leastLoad` | `leastLoad` / `leastPing` / `random` |
| `probe_url` | str | `https://www.gstatic.com/generate_204` | URL который пингует burstObservatory |
| `probe_interval` | str | `3m` | **Как часто пингуются серверы** ([см. расчёт нагрузки](#-расчёт-нагрузки)) |
| `probe_sampling` | int | `3` | Сколько проб за цикл. **Для прода — `1`** |
| `probe_timeout` | str | `3s` | Таймаут одной пробы. **Можно `1s`** |
| `load_expected` | int | `3` | Сколько серверов балансер выбирает как "лучшие" |
| `balancer_tolerance` | float | `0.5` | Tolerance для main/tier1 |
| `balancer_tolerance_fallback` | float | `0.8` | Tolerance для tier2/lte/all |

### 📌 Sticky-сессии

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `sticky_session` | bool | `false` | Включить sticky |
| `sticky_threshold_ms` | int | `1000` | Если RTT sticky-сервера > этого → fallback на main |
| `sticky_ttl_hours` | int | `168` | TTL назначения (7 дней) |
| `sticky_persist_path` | str | `/app/data/sticky-assignments.json` | Файл persistence |
| `sticky_exclude_groups` | str[] | `[<auto_group_name>]` | Группы где sticky не нужен |

### 🚀 Tier-failover

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `group_tiers` | object | `{}` | `имя группы` → `{ tier1_count, tier1_baseline_ms, tier2_baseline_ms }` |

Пример:
```json
"group_tiers": {
    "🇫🇮 Финляндия": {
        "tier1_count": 3,
        "tier1_baseline_ms": 1500,
        "tier2_baseline_ms": 4000
    }
}
```

### 📊 Node stats

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `node_stats` | bool | `false` | Опрашивать `/api/nodes/` для фильтрации |
| `node_stats_interval_sec` | int | `120` | Интервал опроса |
| `max_users_per_gb` | int | `50` | Порог `usersOnline / RAM_GB` |
| `max_users_per_cpu` | int | `80` | Порог `usersOnline / CPU_count` |
| `node_load_threshold` | float | `1.0` | Порог `load` для исключения. **При incident'ах поднять до 2-3** |
| `node_stats_exclude` | str[] | `[]` | Группы которые НЕ фильтруются по load |

### 🗺️ Routing (Happ profiles)

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `happ_routing` | str | `""` | Base64 routing профиль (`happ://routing/onadd/<base64>`) |
| `happ_routing_url` | str | `""` | URL для динамической загрузки геобаз |
| `happ_routing_update_interval_sec` | int | `3600` | Интервал обновления геобаз с URL |
| `routing_name` | str | `""` | Override имени профиля |
| `geosite_cdn` | str | jsdelivr | Override CDN для geosite-rules |
| `geoip_cdn` | str | jsdelivr | Override CDN для geoip-rules |
| `udp_block` | bool | `true` | Блокировать UDP 443 (QUIC). `false` для Hysteria2 |
| `direct_domains` | str[] | `[]` | Домены которые гарантированно идут direct |

### 🎨 Прочее

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `mihomo_enabled` | bool | `true` | Генерировать Mihomo YAML |
| `singbox_enabled` | bool | `true` | Генерировать Sing-box JSON |
| `rate_limit.max` | int | `5` | Запросов в окне per HWID/IP. `0` отключает |
| `rate_limit.window_sec` | int | `60` | Окно |
| `upstream_cache_ttl_sec` | int | `300` | Кэш upstream-ответа (fallback при отказе Remnawave) |
| `dev_raw_tokens` | str[] | `[]` | Whitelist токенов для `?raw=1` (debug) |
| `mihomo_pro_tokens` | str[] | `[]` | Whitelist для `?profile=pro` (Legiz-style YAML) |
| `profile_web_page_url` | str | — | URL для заголовка `profile-web-page-url` Happ |

---

## 🔧 Тонкая настройка

Параметры для тюнинга внутренних таймаутов, лимитов и каскада. **Дефолты безопасны для прода**, но при необходимости можно ужесточить.

> 📄 **Полный пример со всеми параметрами:** `config.advanced.json.example`

### HTTP fetch (запросы к Remnawave)

| Параметр | Default | Описание |
|---|---|---|
| `http_timeout_ms` | `10000` | Таймаут одного fetch (10s) |
| `http_max_redirects` | `3` | Макс HTTP-redirect'ов |
| `max_response_bytes` | `10485760` | Лимит размера ответа upstream (10 MB) |

### HTTP server timeouts (защита от slowloris)

| Параметр | Default | Описание |
|---|---|---|
| `server_keepalive_timeout_sec` | `65` | Idle keepalive |
| `server_headers_timeout_sec` | `66` | Макс время на получение headers |
| `server_request_timeout_sec` | `30` | Макс время на полный request |

### Балансер baseline'ы

| Параметр | Default | Описание |
|---|---|---|
| `default_tier1_baseline_ms` | `1600` | RTT-порог tier1 |
| `default_tier2_baseline_ms` | `4000` | RTT-порог tier2 |
| `default_main_with_lte_baseline_ms` | `2000` | RTT-порог main в режиме main+LTE |
| `default_single_baseline_ms` | `4000` | RTT-порог одиночного балансера |
| `default_lte_baseline_ms` | `4000` | RTT-порог LTE балансера |

### Кэш upstream

| Параметр | Default | Описание |
|---|---|---|
| `upstream_cache_max_entries` | `5000` | Макс кэшированных ответов (LRU eviction) |
| `upstream_cache_cleanup_interval_sec` | `600` | Интервал очистки expired |

### Sticky-сессии internals

| Параметр | Default | Описание |
|---|---|---|
| `sticky_flush_interval_sec` | `300` | Как часто sticky пишется на диск |
| `sticky_hard_max_age_days` | `30` | После сколько дней неактивности токен забыт |
| `sticky_max_tokens_in_memory` | `100000` | Soft-лимит in-memory map (DoS защита) |
| `sticky_in_memory_cleanup_interval_hours` | `5` | Интервал очистки stale-записей |

### Mihomo / Sing-box

| Параметр | Default | Описание |
|---|---|---|
| `mihomo_urltest_tolerance_ms` | `50` | Tolerance для url-test Mihomo |
| `singbox_urltest_tolerance_ms` | `50` | То же для Sing-box |

### Rate-limiter

| Параметр | Default | Описание |
|---|---|---|
| `rate_limit_cleanup_interval_sec` | `300` | Интервал очистки expired-buckets |

---

## 🔌 Endpoints

### Публичные

| Endpoint | Описание |
|---|---|
| `GET /<token>` | Subscription endpoint. Формат подписки зависит от UA |
| `GET /sub/<token>` | Alias для `/<token>` (back-compat) |
| `GET /<token>?raw=1` | Bypass балансера. Только для whitelisted в `dev_raw_tokens` |
| `GET /<token>?profile=pro` | Mihomo PRO YAML. Только для whitelisted в `mihomo_pro_tokens` |
| `GET /health` | Без auth: `{"status":"ok"}` для docker healthcheck |

### Admin (требуют `Authorization: Bearer <api_token>`)

| Endpoint | Описание |
|---|---|
| `GET /health` | (с Bearer) расширенный health: статус всех компонентов |
| `GET /node-stats` | Кэш статистики нод от Remnawave |
| `GET /sticky/<token>` | Sticky-назначения юзера с ISO timestamps |
| `GET /refresh-groups` | Принудительный refresh auto-groups |
| `GET /refresh-stats` | Принудительный refresh node-stats |
| `GET /refresh-routing` | Принудительный refresh Happ routing с URL |

```bash
# Пример вызова admin endpoint
curl -H "Authorization: Bearer $(grep API_TOKEN .env | cut -d= -f2)" \
     http://localhost:4100/node-stats | jq
```

---

## 📌 Sticky-сессии

**Зачем:** если юзеры жалуются что «из-за смены IP сайты требуют релогина» / Google ставит recaptcha / банкинг просит подтверждение — это плавающий IP. Sticky прибивает юзера к одному серверу.

### Как работает

1. Каждый юзер имеет subscription token
2. Балансер вычисляет `SHA256(token + tag)` для каждого outbound и сортирует серверы по hash → **детерминированный порядок предпочтения для каждого юзера**
3. Назначение сохраняется в `sticky-assignments.json` (atomic write через `tmp + rename`)
4. В Xray-конфиге создаётся `sticky-balancer` поверх каскада: `selector = [stickyTag]`, `baseline = sticky_threshold_ms`
5. Если sticky-сервер пингуется быстрее threshold → весь трафик юзера на нём. Иначе → fallback через loopback на main-balancer
6. Через `sticky_ttl_hours` назначение пересчитывается

### Включение

```json
{
    "sticky_session": true,
    "sticky_threshold_ms": 1000,
    "sticky_ttl_hours": 168,
    "sticky_exclude_groups": ["🇪🇺 AUTO | Самые быстрые"]
}
```

### Защита от DoS

Soft-лимит `sticky_max_tokens_in_memory` (default 100k) токенов. Свыше — новые токены получают детерминированный hash без persistence (= sticky всё равно работает, просто не пишется на диск).

### Sticky для Mihomo / Sing-box

Там нет понятия «балансер», поэтому используются:
- **Mihomo**: `type: fallback` с `lazy: true`, sticky-сервер первым в `proxies`
- **Sing-box**: `type: selector` с `default: <stickyTag>`

---

## 🚀 Tier-failover

**Зачем:** в группе много серверов разной мощности. tier1 — топ-3 жирных серверов, tier2 — остальные. Юзер сначала идёт на tier1; если все тормозят — каскад на tier2; если и они — на all-balancer (без baseline = last resort).

### Конфиг (по количеству)

```json
"group_tiers": {
    "🇫🇮 Финляндия": {
        "tier1_count": 3,
        "tier1_baseline_ms": 1500,
        "tier2_baseline_ms": 4000
    }
}
```

`tier1_count: 3` — берётся natural sort по числу в имени тега (`Finland 1` < `Finland 10`), берутся первые 3.

### Конфиг (по whitelist)

```json
"group_tiers": {
    "🇫🇮 Финляндия": {
        "tier1_patterns": ["Finland 1 |", "Finland 5 |"],
        "tier1_baseline_ms": 1500,
        "tier2_baseline_ms": 4000
    }
}
```

### Что значат `baseline_ms`

- `tier1_baseline_ms: 1500` — пока хоть один tier1-сервер пингуется быстрее 1500ms, юзер на нём. Если **все** tier1 > 1500ms → каскад вниз
- `tier2_baseline_ms: 4000` — то же для tier2

> ⚠️ **Tier требует И tier1, И tier2.** Если tier1 включает все серверы группы — tier2 пуст → tier-mode не активируется.

---

## 📡 LTE fallback

**Сценарий:** есть LTE-серверы (мобильный интернет, медленные но стабильные с обходом блокировок). Должны срабатывать только если основные WiFi-серверы лагают.

### Настройка

```json
{
    "lte_patterns": ["LTE", "Mobile+", "WHITE"],
    "fastest_fallback": ["🇪🇺 LTE Bypass"]
}
```

- `lte_patterns` — серверы с этими подстроками в теге становятся LTE-резервом
- `fastest_fallback` — группы которые попадают в AUTO как fallback (не как main)

**Каскад без tier-mode:**
```
main → main-loopback → lte-balancer → lte-loopback → all-balancer
```

---

## 📊 Расчёт нагрузки

> ⚠️ **Главный урок** — incident "42к фантомных юзеров"
>
> Сервис на 5к реальных юзеров показывал в Remnawave **42 444 online**. Ноды LTE-3 на 800-900% load. Реальной нагрузки не было.

### Причина

Клиентский Xray (Happ/V2RayTun) при загрузке конфига запускает `burstObservatory`. Каждый цикл к **каждому серверу** делается N (=`probe_sampling`) TCP-соединений с TLS handshake. Remnawave node-агент считает **каждое такое соединение** как `usersOnline`. Балансер использует эту метрику для фильтрации → каскадная отказная система.

### Формула

```
phantom_users_per_node ≈ N_clients × probe_sampling × (probe_duration / probe_interval)
```

где `probe_duration` ≈ 1-3s (TLS + GET + close).

### Воспроизведение incident'а

**Было:** `5000 × 3 × (3s / 10s) = 4500 фантомных на ноду` × 13 нод × spillover = **42-50k наблюдалось** ✅

**После фикса:** `5000 × 1 × (1s / 600s) = 8.3 фантомных на ноду` — приемлемо.

**Снижение в ~540 раз** при сохранении балансировки.

### Рекомендации по размеру сервиса

| Юзеров | `probe_interval` | `probe_sampling` | `probe_timeout` | Phantom users |
|---|---|---|---|---|
| 100-500 | `3m` | `1` | `3s` | ~5-10 |
| 500-2k | `5m` | `1` | `2s` | ~10-20 |
| 2k-10k | `10m` | `1` | `1s` | ~20-50 |
| 10k+ | `15m` | `1` | `1s` | ~50-100 |

### Защита от каскадных отказов

Если включён `node_stats`, `max_users_per_cpu` **должен учитывать фантомных**:

```
max_users_per_cpu_safe ≈ 80 + (phantom_users / N_cpu) × 1.5
```

При incident'ах поднять оба:
```json
{
    "max_users_per_cpu": 200,
    "node_load_threshold": 3.0
}
```

3x запас на пиках → нода не вылетит при кратковременных всплесках.

---

## 🔧 Troubleshooting

### "В Remnawave аномальное количество online юзеров"

См. [Расчёт нагрузки](#-расчёт-нагрузки). Понизь `probe_sampling` до `1`, повысь `probe_interval` до `10m`.

### "Юзеры жалуются что IP постоянно меняется"

Это `load_expected: 3` (default) — балансер раскидывает каждое соединение между топ-3 серверов. Решения:
- Включить sticky-session
- ИЛИ вернуть `"load_expected": 1` (но тогда трафик группы концентрируется на одном сервере)

### "После рестарта балансера трафик резко падает на одной ноде"

`node_stats` поднял её load до пороговой и `filterAndSortByLoad` исключил. Решения:
- Поднять `max_users_per_cpu` / `max_users_per_gb`
- Поднять `node_load_threshold` до `2.0-3.0`
- Добавить ноду в `node_stats_exclude`

### "Mihomo клиенты не видят все серверы / V2RayTUN видит только 1"

V2RayTUN на Windows плохо парсит XRAY_JSON массив — известная проблема **клиента**, не балансера. Workaround: в Remnawave Response Rules для `V2RayTUN` UA задать `XRAY_BASE64` вместо `XRAY_JSON`.

### "Sticky-сервер перегружен, а юзера не перебрасывает"

Проверь:
1. `node_stats` включён? Без него sticky не знает что нода перегружена
2. `sticky_threshold_ms` — если установлен в `5000ms`, sticky отдаёт даже медленные ноды

### "Каскад tier1 → tier2 не работает"

Используй Xray-core ≥ 1.8.5 (раньше был баг с loopback). Также:
1. `group_tiers` имеет и `tier1_count`/`tier1_patterns`, и `tier2_baseline_ms`
2. В подписке должно быть **больше** серверов чем `tier1_count`

### "Имена групп с эмодзи / cyrillic в логах странные"

`sanitizeTag` использует `[^a-zA-Z0-9_-]` для tag prefix в Xray. Для cyrillic/emoji группы получают prefix вида `g3a41fc20` (sha256 hash) — это технический tag для balancer'ов в Xray, **не отображается юзеру**. В подписке имя группы отображается как настроено.

### "Rate-limiter режет всех клиентов"

Балансер за reverse proxy без проброса `X-Real-IP`. Все клиенты приходят как `127.0.0.1` → один bucket. **Обязательно** добавь в nginx/Caddy:

```
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
```

### Логи и диагностика

```bash
# Docker
docker compose logs -f xray-balancer-mw
docker compose logs --tail=100 xray-balancer-mw | grep ERR

# systemd
journalctl -u xray-balancer-mw -f
journalctl -u xray-balancer-mw --since "1 hour ago" | grep ERR
```

---

## 🔄 Обновление

### Docker

```bash
cd /opt/xray-balancer-mw

# Бэкап
tar czf /tmp/balancer-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
    config.json .env data/ 2>/dev/null

# Обновление кода
git pull

# Прогон тестов на новой версии
docker compose run --rm xray-balancer-mw npm test

# Если 103/103 ✅ — рестарт
docker compose up -d --build

# Проверить
docker compose logs --tail=30 xray-balancer-mw | grep "🚀"
```

### Manual / systemd

```bash
cd /opt/xray-balancer-mw

# Бэкап
tar czf /tmp/balancer-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
    config.json .env data/ 2>/dev/null

# Обновление
git pull

# Тесты
npm test

# Если 103/103 ✅
sudo systemctl restart xray-balancer-mw
sudo systemctl status xray-balancer-mw
```

### Откат если что-то пошло не так

```bash
# Найти бэкап
ls -t /tmp/balancer-backup-*.tar.gz | head -1

# Откатить код
git reset --hard HEAD~1
# ИЛИ к конкретной версии: git checkout v3.0.0

# Восстановить config из бэкапа если нужно
tar xzf /tmp/balancer-backup-XXX.tar.gz

# Рестарт
docker compose up -d --build  # или systemctl restart
```

---

## 🛠 Разработка

### Структура проекта

```
xray-balancer-mw/
├── src/
│   ├── server.js                  ← HTTP сервер, оркестрация
│   ├── config.js                  ← парсинг + валидация config
│   ├── constants.js               ← внутренние DEFAULT_*
│   ├── utils.js                   ← fetchUrl, parseRamGb, safeAsync
│   ├── cache.js                   ← LRU-кэш upstream-ответов
│   ├── rate-limiter.js            ← per-HWID/IP лимиты
│   ├── routing.js                 ← Happ routing profile
│   ├── node-stats.js              ← опрос Remnawave nodes API
│   ├── sticky-assignments.js      ← sticky-сессии
│   ├── logger.js                  ← цветное логирование
│   ├── mihomo-pro.js              ← Mihomo PRO template
│   ├── converters.js              ← Xray → Mihomo / Sing-box / link
│   ├── generators/
│   │   ├── xray.js                ← главный генератор Xray-JSON
│   │   ├── mihomo.js              ← Mihomo YAML
│   │   ├── singbox.js             ← Sing-box JSON
│   │   ├── common.js              ← shared helpers
│   │   └── index.js               ← entry point
│   ├── groups/
│   │   ├── clients.js             ← UA detection
│   │   ├── countries.js           ← country regex patterns
│   │   ├── tiers.js               ← getTier1Tags
│   │   └── index.js               ← public API
│   └── templates/
│       └── mihomo-pro.yaml        ← Legiz-style YAML template
├── test/                          ← 103 unit-тестов
├── examples/                      ← nginx, Caddy, response-rules
├── config.json.example            ← минимальный пример
├── config.advanced.json.example   ← все 90+ параметров
├── .env.example                   ← env vars
├── docker-compose.yml
├── Dockerfile
└── package.json                   ← v3.1.0
```

### Команды

```bash
# Прогон всех тестов
npm test

# Только синтаксис-чек
npm run check

# Запуск напрямую (без Docker)
npm start

# Логи в режиме разработки
LOG_LEVEL=debug npm start
```

### Добавить новый тест

```bash
# Создать файл test/my-feature.test.js
# Первая строка обязательно:
require('./helpers/setup-env');

# Дальше стандартный node:test
const test = require('node:test');
const assert = require('node:assert');

test('моя фича', () => {
    assert.strictEqual(1 + 1, 2);
});
```

### Environment variables (приоритет над config.json)

| Var | Описание |
|---|---|
| `CONFIG_PATH` | Путь к config.json (default `./config.json`) |
| `PORT` | Порт |
| `REMNAWAVE_URL` | URL Remnawave |
| `SUB_PAGE_URL` | URL subscription page |
| `SUB_DOMAIN` | Публичный домен подписки |
| `API_TOKEN` | Bearer для Remnawave API + admin endpoints |
| `PANEL_AUTH_COOKIE` | Cookie если панель за basic-auth |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` / `silent` |
| `NODE_STATS=true` | Включить опрос /api/nodes/ |
| `NODE_STATS_INTERVAL_SEC` | Интервал опроса |
| `MAX_USERS_PER_GB` | Порог по RAM |
| `MAX_USERS_PER_CPU` | Порог по CPU |

---

## 📝 Лицензия

См. файл [`LICENSE`](LICENSE).

## 🐛 Issues

[github.com/Haxonate/xray-balancer-mw/issues](https://github.com/Haxonate/xray-balancer-mw/issues)

## 🙏 Благодарности

- [Remnawave](https://remna.st/) — VPN panel
- [Xray-core](https://github.com/XTLS/Xray-core) — proxy core
- [Happ](https://happ.su/) — VPN client
