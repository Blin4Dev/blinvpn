# Changelog

Все значимые изменения проекта документируются здесь.
Формат: [Keep a Changelog](https://keepachangelog.com/) + Semantic Versioning.

## [3.1.0] — 2026-05-08

Stabilization-релиз поверх 3.0. Большая часть фичей 3.0 была заявлена в
CHANGELOG, но не подключена в активный код — этот релиз доводит всё до
рабочего состояния, исправляет регрессии и архитектурные баги.

### Fixed — финальный production sweep

- **🔴 `sanitizeTag` коллизия для cyrillic/emoji-имён групп.**
  `sanitizeTag('🇫🇮 Финляндия')` возвращал `""` (пустую строку) → все
  balancer-теги для не-ASCII имён получали один и тот же пустой prefix,
  Xray запутался → silent поломка cascade'а у всех с русскими именами.
  Теперь fallback на `'g' + sha256(name).slice(0,8)` — гарантированно
  уникальный non-empty prefix. Регрессионные тесты добавлены.
- **`getNodeStats(null)` бросал** на `outboundTag.toLowerCase()`.
  Защищён `if (!outboundTag || typeof !== 'string') return null`.
- **Error message могла протекать в 502 ответ** через `Bad Gateway: ${err.message}`.
  При SSRF-blocked redirect это раскрывало internal IP'ы; при ENOENT —
  пути к файлам. Production-safe: generic "Bad Gateway" клиенту, full err
  в логах.
- **Sticky shutdown без try/catch.** Если `flushToDisk` бросал в shutdown
  (EROFS, etc.) — process.exit не вызывался, balancer висел до 5s force-kill.
  Завернут в try/catch с warning log.
- **2 dead exports в constants.js**: `MIHOMO_URLTEST_INTERVAL_SEC`,
  `SINGBOX_URLTEST_INTERVAL`. Заменены на `PROBE_INTERVAL` propagation
  (раньше уже исправлено в коде, но мёртвые константы оставались в
  constants.js).
- **5 dead exports в `groups/index.js`**: `setGroups`, `detectCountryFromRemark`,
  `buildGroupsFromHosts` (oops, нужно было оставить — уточнено сразу),
  `naturalSortKey`, `COUNTRY_PATTERNS`. Чищены — internal API не должен
  быть в public surface.
- **Inconsistent defaults в config.js.** Для `STICKY_HARD_MAX_AGE_MS_CFG`,
  `STICKY_FLUSH_INTERVAL_MS_CFG`, `UPSTREAM_CACHE_CLEANUP_INTERVAL_MS`,
  `RATE_LIMIT_CLEANUP_INTERVAL_MS_CFG` использовались inline magic numbers
  вместо констант. Теперь default берётся из `constants.js` (single
  source of truth).
- **`crypto.require()` внутри `sanitizeTag`** — lazy load на каждый вызов.
  Вынесен в module-level (Node кэширует, но всё равно lookup).
- **README полностью переписан** под актуальное состояние v3.1.0:
  10 разделов, 600+ строк, описание всех ~90 параметров config с типами/
  defaults, все troubleshooting сценарии, формулы расчёта нагрузки,
  пошаговый migration guide.

### Added — финальная итерация

- **`auto_group_name` параметр** — имя AUTO-группы теперь настраивается из
  config.json. Default: `"🇪🇺 AUTO | Самые быстрые"`. Можно поменять
  под бренд: `"⚡ Турбо"`, `"Best servers"` и т.п. Имя автоматически
  подхватывается во всех генераторах (Xray, Mihomo, Sing-box) + в
  `STICKY_EXCLUDE_GROUPS` default.
- **Полный README.md** с разделами: быстрый старт, архитектура,
  конфигурация (вся), endpoints, sticky-сессии, tier-failover,
  LTE-fallback, **расчёт нагрузки и тюнинг для прода с формулами и
  таблицей рекомендаций** (объясняет incident "42к фантомных юзеров" и
  как его не повторить), troubleshooting, migration guide.
- **Mihomo placeholder теперь уникальный** — был `'🇪🇺 AUTO'` (мог
  совпасть с пользовательским именем группы), стал `'__AUTO_GROUP_PLACEHOLDER__'`.
- **`r.replace()` → `r.replaceAll()`** в Mihomo rules processing —
  если placeholder встречался в правиле дважды (нереально, но possible),
  старая версия заменяла только первое.
- **AUTO group name в startup banner** — баннер теперь показывает
  активное имя группы для подтверждения override'а.
- **6 новых тестов** для `auto_group_name`: проверяют что override
  применяется в config, попадает в `STICKY_EXCLUDE_GROUPS`, используется
  в Xray balancer prefix, в Mihomo proxy-group имени, в Sing-box urltest tag.

### Added — тонкая настройка (granular tuning)

Все внутренние таймауты, лимиты и baseline'ы вынесены в config.json. Дефолты
безопасны для прода, но можно ужесточить под нагрузку.

**HTTP fetch (для запросов к Remnawave/upstream):**
- `http_timeout_ms` (default 10000) — таймаут одного fetch
- `http_max_redirects` (default 3) — лимит redirect'ов
- `max_response_bytes` (default 10485760) — лимит размера ответа upstream

**HTTP server (защита от slowloris):**
- `server_keepalive_timeout_sec` (default 65)
- `server_headers_timeout_sec` (default 66)
- `server_request_timeout_sec` (default 30)

**Балансер baseline'ы (тюнинг каскада fallback):**
- `default_tier1_baseline_ms` (default 1600)
- `default_tier2_baseline_ms` (default 4000)
- `default_main_with_lte_baseline_ms` (default 2000)
- `default_single_baseline_ms` (default 4000)
- `default_lte_baseline_ms` (default 4000) — раньше использовалось то же значение что для single, теперь отдельное

**Node-stats (КРИТИЧНО для тюнинга при incident'ах):**
- `node_load_threshold` (default 1.0) — порог исключения нагруженной ноды.
  Если каскадные отказы от фантомных юзеров — поднимите до 2.0-3.0.

**Кэш upstream:**
- `upstream_cache_max_entries` (default 5000)
- `upstream_cache_cleanup_interval_sec` (default 600)

**Sticky-сессии (тюнинг для большого scale):**
- `sticky_flush_interval_sec` (default 300)
- `sticky_hard_max_age_days` (default 30)
- `sticky_max_tokens_in_memory` (default 100000) — soft-лимит in-memory map
- `sticky_in_memory_cleanup_interval_hours` (default 5)

**Rate-limiter:**
- `rate_limit_cleanup_interval_sec` (default 300)

**Mihomo / Sing-box:**
- `mihomo_urltest_tolerance_ms` (default 50)
- `singbox_urltest_tolerance_ms` (default 50)

Для полного примера со всеми параметрами добавлен `config.advanced.json.example`
в корне репозитория. Все параметры опциональны и обратно совместимы.

**11 новых тестов** для проверки tuning параметров: каждый параметр имеет
собственный тест на применение override'а из config, на разумный default,
плюс несколько integration-тестов на end-to-end (xray.js использует
config-driven baselines в balancer settings).

### Fixed — найдено в production-ревью (после первой итерации 3.1)

- **Mihomo / Sing-box urltest интервал захардкожен** — игнорировал
  `probe_interval` из config. У сервиса с 5к+ юзерами на Mihomo это вызывало
  лавину «фантомных online» в метриках Remnawave (regression incident'а tgshtt).
  Теперь оба генератора используют `PROBE_INTERVAL` (Mihomo через парсер
  `'10m'` → 600 сек, SingBox напрямую как строку).
- **`fetchUrl` unhandled rejection при битом `Location` header.**
  `new URL(res.headers.location, ...)` мог throw внутри HTTP callback —
  попадал в `unhandledRejection`. Завернул в try/catch + reject.
- **`cache.js` без лимита размера → DoS-вектор.** Атакующий с массой
  токенов мог выжрать память. Добавлен `MAX_CACHE_ENTRIES = 5000` с
  LRU-eviction по `cachedAt`. Также `setInterval` теперь использует
  `CACHE_CLEANUP_INTERVAL_MS` из constants (был хардкоден).
- **`generateMihomoYamlPro` мёртвый экспорт.** Не вызывался ни откуда.
  Подключён через `?profile=pro` query + `mihomo_pro_tokens` whitelist
  в config с валидацией. Без whitelist — fallback на обычный Mihomo YAML.
- **Magic string `'🇪🇺 AUTO | Самые быстрые'` в 6 местах.** Если бы кто-то
  изменил в одном месте — sticky сломался бы тихо. Вынесен в `AUTO_GROUP_NAME`
  константу в `constants.js`, используется в server/mihomo/singbox.
- **`sticky.getOrAssign` без try/catch в server.js.** Если sticky throws
  (поломанный node-stats lookup или unexpected) — ломал всю генерацию
  подписки. Завернут: при ошибке логируется и продолжается без sticky.
- **logger без `silent` уровня.** `setLevel('silent')` молча оставлял
  `info`. Добавлен уровень для тестов и production-quiet режима.
- **Edge-case тесты (+22)** для всех найденных багов: parseRamGb с
  отрицательными/Infinity/NaN/object/boolean, isPrivateV4/V6 проверки SSRF
  guard, safeAsync с/без logger'а, cache-set/get, detectClientType
  с non-string входами. Итого: **82/82 теста зелёные**.

### Fixed — критичные регрессии 3.0

- **Дубль файлов: модульная архитектура была мёртвым кодом.** В `src/`
  одновременно лежали старые монолиты `generators.js` + `groups.js` и новые
  папки `generators/` + `groups/`. Node разрешал `require('./generators')` и
  `require('./groups')` в **файлы**, не в директории — все новые модули
  никогда не выполнялись. Старые монолиты удалены, активна модульная версия.
- **Sticky-sessions не были подключены.** `server.js` не импортировал
  `./sticky-assignments`, никогда не вызывал `init()` или `getOrAssign()`.
  Подключено: при включённом `sticky_session` сервер инициализирует модуль,
  вычисляет sticky-назначения для каждой группы, передаёт их в `buildGroupConfig`.
- **`/sticky/<token>` и `?raw=1` endpoints отсутствовали** — добавлены в
  `server.js` с Bearer auth и whitelist токенов соответственно.
- **Bearer auth для admin endpoints не работал.** `if (cfg.API_TOKEN)` в коде
  проверял что токен задан в config, а не что клиент его прислал —
  `/refresh-*` могли быть вызваны кем угодно (DoS вектор). Добавлена
  настоящая проверка `Authorization: Bearer <API_TOKEN>` с constant-time
  compare; `/health`, `/node-stats`, `/refresh-*`, `/sticky/<token>` теперь
  требуют Bearer для расширенного ответа.
- **`fallbackTag: balancer-tag` ломал каскады в Xray-core.** В `xray.js`
  все каскады (sticky → main, main → LTE, tier1 → tier2, tier2 → all) были
  через `fallbackTag` указывающий на тег балансера. Xray-core принимает в
  `fallbackTag` только outbound-теги (XTLS discussion #3068, v2fly #3100),
  dispatcher не находит handler по balancer-тегу и возвращает пусто. Каскады
  переписаны на канонический паттерн через **loopback outbounds**: `balancer.fallbackTag`
  → loopback outbound → routing rule с `inboundTag` → следующий balancer.
- **`parseRamGb` регрессия.** Возвращал `1` при `null`/невалидном вводе —
  ноды с битыми метриками от Remnawave получали искусственный высокий load
  и выпадали из выдачи через node_stats фильтр. Теперь возвращает `null`.
- **`rate-limiter` за reverse proxy.** Использовал `req.socket.remoteAddress`
  — за Caddy/Nginx все клиенты делили один bucket (`127.0.0.1`). Читает
  `X-Real-IP` → `X-Forwarded-For` (первый IP) → fallback на socket.
- **`fetchUrl` SSRF guard.** При HTTP-redirect не проверялся target hostname
  — атакующий мог через подконтрольный публичный URL редиректнуть на
  `127.0.0.1:админ-порт`. Добавлена проверка через DNS lookup + IPv4/IPv6
  CIDR блок-листы (loopback, RFC1918, link-local, ULA) на каждом
  redirect-шаге. Initial request не проверяется (вызывающий отвечает за
  targetUrl).
- **`fetchUrl` body buffer.** `body += chunk` портил UTF-8 при разрезе
  multi-byte символа на границе чанков. Заменено на
  `Buffer.concat([...]).toString('utf8')`.
- **`fetchRoutingProfile` race guard.** Параллельные fetches могли частично
  перетереть `_base64Profile.Geositeurl/Geoipurl`. Добавлен `_fetchInFlight`
  — если запрос уже идёт, переиспользуем тот же promise.
- **`node-stats` shared reference.** `newCache[inb.tag] = newCache[name]`
  делал shared reference — мутация по тегу портила оригинальный объект.
  Заменено на shallow-clone (`{ ...stats }`).
- **`node-stats` обработка null метрик.** Теперь `load === null` (вместо
  `999` через `parseRamGb=1`-каскад) когда RAM или CPU неизвестны —
  `filterAndSortByLoad` НЕ выкидывает такие ноды.
- **`detectClientType` без trim().** Ведущий пробел в UA → fallback в
  `'other'` потому что регулярки якорены на `^`. Теперь `String(ua).trim()`.

### Added — функции из 3.0, теперь реально работающие

- **Sticky-сессии**: `sticky_session`, `sticky_threshold_ms`, `sticky_ttl_hours`,
  `sticky_persist_path`, `sticky_exclude_groups` параметры в `config.js`,
  валидация типов. `server.js` инициализирует sticky на старте, вычисляет
  назначения per-request и пробрасывает в Xray/Mihomo/SingBox генераторы.
  In-memory map имеет soft-limit 100k токенов (DoS защита).
- **Tier-failover**: `group_tiers` параметр в config с валидацией. Поддерживает
  `tier1_patterns` (whitelist) и `tier1_count` (число с natural-sort).
  Каскад tier1 → tier2 → all-balancer через loopback'и.
- **Last-resort all-balancer** для tier-mode и main+LTE — last resort без
  baseline, гарантирует доступность когда основные пулы лагают.
- **`?raw=1` dev endpoint** с whitelist в `dev_raw_tokens`. Strip `(WIFI)`/
  `4G/LTE` суффиксов из remarks, UA spoof на `Happ/1.0` для не-VPN клиентов
  (браузер/curl), IP override `8.8.8.8` для обхода SRR-фильтрации upstream.
- **Расширенный `/health`**: без auth — минимальный `{status: ok}` для docker
  healthcheck; с Bearer — поля `uptime_sec`, `groups`, `node_stats.{enabled,
  cached, last_refresh_at}`, `routing.profile_active`, `sticky.{size,
  threshold_ms, ttl_hours}`, `udp_block`, `mihomo_enabled`, `singbox_enabled`.
- **`balancer_tolerance` / `balancer_tolerance_fallback`** настраиваются в config
  (раньше были захардкожены в `xray.js`).
- **`probe_timeout`** настраивается (default `'3s'`).
- **`load_expected`** клампится по размеру селектора (`Math.min(LOAD_EXPECTED,
  selector.length)`) — без этого Xray мог получить `expected > selector.length`
  и вернуть пусто.

### Added — инфраструктура и качество

- **`safeAsync(fn, {logger, tag, fallback, level?})`** в `utils.js` —
  единообразная обёртка для async try/catch. Применена в `groups/index.js` и
  `node-stats.js`.
- **`isHostnameSafe`, `isPrivateV4`, `isPrivateV6`** утилиты в `utils.js` —
  для SSRF guard и других проверок.
- **`MAX_TOKENS_IN_MEMORY = 100k`** в sticky — DoS защита от спама токенов.
- **Atomic flush** в sticky: `dirty = false` ставится ТОЛЬКО после успешного
  `fs.renameSync` — partial write не теряет state.
- **`describe(token)` в sticky** возвращает human-readable ISO timestamps
  (`assignedAtIso`, `expiresAtIso`) + lazy-cleanup expired записей на чтении.
- **package.json**: bumped 2.0.0 → 3.1.0, добавлен `"test": "node --test test/"`.

### Changed — поведенческие изменения

- **Dead `proxyOutbound`** (мёртвый клон первого outbound с тегом 'proxy') убран
  из `xray.js` — был мусором + риск конфликта тега.
- **`expected: 1`** во всех balancers переведён на `LOAD_EXPECTED` (default 3)
  с клампом по размеру селектора.

### Тестирование

- Все **60 unit-тестов** проходят (раньше: groups.test.js падал целиком — модуль
  не грузился, generators.test.js — 3/9 fail на tier/sticky/all-balancer тестах,
  utils.test.js — 3/9 fail на parseRamGb null/zero/invalid).
- `test/generators.test.js` обновлён: тест `sticky-balancer fallback` теперь
  проверяет канонический loopback-pattern (был некорректный — проверял
  сломанное direct balancer-tag поведение).

### Migration notes

- **Конфиг полностью обратно совместим:** все новые поля опциональны.
- Если у вас был **самописный** `src/generators.js` или `src/groups.js`
  поверх 3.0 — нужно перенести правки в соответствующие модули
  `src/generators/` или `src/groups/` (старые монолиты удалены).
- **`config.json.example`** теперь содержит `remnawave_url` (раньше отсутствовал
  — тесты на чистом checkout'е падали).

---

## [3.0.0] — 2026-05-06

Большой релиз — введены sticky-сессии, многоуровневый каскад балансеров,
полный рефакторинг структуры модулей и набор багфиксов.

### Added — sticky-сессии и каскадный failover

- **Smart Sticky sessions** ([`src/sticky-assignments.js`](src/sticky-assignments.js)) — каждый
  пользователь получает персональный сервер в каждой группе по детерминированному hash
  от subscription-токена. Sticky-server держится пока его пинг ≤ `sticky_threshold_ms`,
  при превышении — каскадный fallback на групповой балансер.
  - Persistence на диск с TTL и периодической чисткой in-memory map (`5h interval`).
  - Server-side intelligence: при назначении пропускает перегруженные ноды по `node_stats`.
  - Поддержка для всех типов клиентов: Xray-JSON (Happ), Mihomo (`type: fallback`, `lazy: true`),
    SingBox (`type: selector`, `default`).
  - Diagnostic endpoint `GET /sticky/<token>` показывает назначения юзера + threshold.
  - Конфиг: `sticky_session`, `sticky_threshold_ms`, `sticky_ttl_hours`, `sticky_persist_path`,
    `sticky_exclude_groups`.

- **Tier-failover внутри группы** через `group_tiers` config:
  - Режим `tier1_patterns` (substring whitelist, back-compat).
  - Режим `tier1_count` (первые N серверов по натуральной сортировке номеров).
  - Каскад: tier1 → tier2 → all-balancer (last-resort, без baselines).

- **Last-resort `all-balancer`** для групп с LTE-fallback (например AUTO):
  гарантирует доступность когда и main pool и LTE-резерв одновременно деградировали.
  Каскад: sticky → main → LTE → all (no baseline).

- **`?raw=1` dev endpoint** — bypass балансера, возвращает upstream подписку как есть.
  Защищён whitelist'ом `dev_raw_tokens` в config. Strip `(WIFI)` / `4G/LTE` суффиксов
  из remarks для обхода Happ network-фильтра. IP override на `8.8.8.8` чтобы
  обойти возможные SRR-фильтрации upstream.

- **Расширенный `/health` endpoint** с Bearer auth для подробной информации
  (минимальный `{status: ok}` без auth — для docker healthcheck).
  Поля: `uptime_sec`, `groups`, `node_stats.{enabled,cached,last_refresh_at}`,
  `routing.profile_active`, `sticky.{size,threshold_ms,ttl_hours}`.

- **Configurable anti-flapping knobs**:
  - `probe_sampling` (default 3) — количество замеров RTT за probe-цикл.
  - `probe_timeout` (default `'3s'`).
  - `balancer_tolerance` (default 0.5) — узкий коридор «равных» серверов.
  - `balancer_tolerance_fallback` (default 0.8) — широкий для fallback-балансеров.

### Added — структура и качество

- **`src/constants.js`** — централизованные константы (TTL, intervals, лимиты, дефолты).
- **`src/groups/`** — split на 4 модуля: `index.js` (state + matchGroup), `countries.js`,
  `clients.js` (UA detection), `tiers.js` (getTier1Tags + naturalSortKey).
- **`src/generators/`** — split на 5 модулей: `common.js`, `xray.js`, `mihomo.js`,
  `singbox.js`, `index.js`.
- **`src/mihomo-pro.js`** — Mihomo PRO template вынесен в отдельный модуль.
- **`safeAsync(fn, {logger, tag, fallback})`** в [`src/utils.js`](src/utils.js) —
  единообразная обёртка для async try/catch блоков. Применён в `groups.js` и `node-stats.js`.
- **JSDoc** на всех ключевых public функциях (buildGroupConfig, getOrAssign,
  getTier1Tags, detectClientType, parseRamGb, и т.д.).
- **Тестовая инфраструктура** [`test/`](test/) с 60 unit-тестами через built-in `node:test`:
  utils, groups, sticky, generators, converters, routing.

### Changed — поведенческие изменения

- **`probe_interval`** дефолт остался `'3m'`, но конфиг рекомендует `'1m'` + `sampling: 5`
  для лучшего trade-off реакция-vs-стабильность.
- **`/node-stats`** требует `Authorization: Bearer <API_TOKEN>` — раньше был открыт.
- **`/health`** при наличии Bearer auth раскрывает подробную информацию;
  без auth возвращает минимальный `{status: ok}` для docker healthcheck.
- **`?raw=1`** теперь спуфит UA на `Happ/1.0` ТОЛЬКО для не-VPN клиентов
  (браузер/curl); для Happ/Mihomo/etc оригинальный UA пробрасывается.
- **Sticky-balancer пропускается** для групп с одним сервером (избыточен —
  ссылка на тот же сервер).
- **AUTO-группа** теперь поддерживает sticky-привязку (опционально через
  `sticky_exclude_groups`) и каскадный fallback на LTE через `fastest_fallback`.

### Fixed — багфиксы

- **rate-limiter за reverse proxy**: читает `X-Real-IP` / `X-Forwarded-For`
  вместо `req.socket.remoteAddress`. Раньше за Caddy все клиенты делили
  один IP-bucket (127.0.0.1).
- **`parseRamGb`**: возвращает `null` при невалидном входе вместо `1 GB`.
  Раньше «глючные» ноды получали искусственный высокий load и исключались
  фильтром.
- **`node-stats.js`**: корректная обработка `null` для RAM/CPU при
  частичных данных от Remnawave API. Удалена коллизия `nodeStatsCache[inb.tag]`
  где shared `inb.tag` перетирал статистику.
- **`detectClientType`**: trim UA перед matching — клиенты с пробелами в
  UA теперь корректно определяются.
- **`fetchRoutingProfile`**: race guard `_fetchInFlight` предотвращает
  concurrent fetches от перетирания `_base64Profile`.
- **`fetchUrl` SSRF guard**: блокирует redirect'ы на private IPs (10.x,
  127.x, 169.254, 172.16-31, 192.168, IPv6 link-local) и нерешённые TLD.
- **`fetchUrl` body buffer**: `body += chunk` → `Buffer.concat(chunks).toString('utf8')` —
  корректное декодирование любых тел.
- **Mihomo / SingBox proxy-group naming**: исправлена коллизия `⚡`-суффикса
  при дубликатах имён, добавлен счётчик для уникальности.
- **`buildGroupConfig` server.js logging**: `?G/?C` для нод с unknown RAM/CPU
  (раньше выводилось `nullC`).
- **Cosmetic в логах**: добавлены цвета для тегов `tier`, `sticky`, `raw`,
  `flap`, `mihomo-pro` (раньше выводились серым).

### Security

- **`/sticky/<token>` privacy**: токены маскируются в Caddy access logs
  (`request>uri regexp "/[a-zA-Z0-9_-]{8,}" "/<token>"`) и `X-Hwid`
  удаляется из логируемых заголовков.
- **`data/` permissions**: `chmod 750`, owned `1000:1000` (node user в
  контейнере). Раньше было `chmod 777`.
- **`?raw=1` whitelist**: доступно только токенам в `dev_raw_tokens`
  конфига, не любому юзеру.

### Infrastructure

- **`docker-compose.yml`**: добавлен volume `./data:/app/data` для sticky persistence.
- **`Caddyfile`** (на проде): добавлен `@raw` маршрут для `?raw=1` query
  параметра + `format filter` для маскирования токенов в логах.

### Migration notes

- Конфиг полностью обратно совместим: новые поля опциональны, без них
  поведение прежнее.
- **Включить sticky-сессии** на проде:
  ```json
  "sticky_session": true,
  "sticky_threshold_ms": 1000,
  "sticky_ttl_hours": 168,
  "sticky_persist_path": "/app/data/sticky-assignments.json"
  ```
- **Создать data-volume** перед включением sticky:
  ```bash
  sudo mkdir -p /opt/xray-balancer-mw/data
  sudo chown 1000:1000 /opt/xray-balancer-mw/data
  sudo chmod 750 /opt/xray-balancer-mw/data
  ```
- **Tier-режим Europe LTE** с tier1_count:
  ```json
  "group_tiers": {
    "🇪🇺 Europe LTE": {
      "tier1_count": 3,
      "tier1_baseline_ms": 2000,
      "tier2_baseline_ms": 4000
    }
  }
  ```

### Тестирование

- 60 unit-тестов через `node --test` (без зависимостей).
- Все pure functions покрыты: `parseRamGb`, `getTier1Tags`, `naturalSortKey`,
  `detectClientType`, `buildGroupConfig`, `outboundToLink`, `xrayToMihomo`,
  `xrayToSingbox`, `sticky.getOrAssign`, `buildRoutingRulesFromProfile`.
- Запуск: `npm test`.

---

## [2.0.0] — 2026-04-14

См. историю commit'ов `git log --oneline` до этого релиза.

Основные функции v2.0:
- Refactor monolithic `server.js` (1355 lines) → 11 модулей в `src/`.
- Server Description feature (Happ `meta.serverDescription`).
- `direct_domains` с Russian-domain bypass.
- Mihomo PRO template (Legiz-style).
- node-stats fix (Netherlands collision).
- Группы по странам, group_descriptions.
