'use strict';

/**
 * Внутренние константы балансера, не настраиваемые из config.json.
 * Если что-то надо тюнить через конфиг — это не сюда, а в config.js.
 *
 * Сгруппировано по теме. Все числа в миллисекундах если в имени есть _MS,
 * в байтах если _BYTES, в секундах если _SEC.
 */

// ─── HTTP / fetch ──────────────────────────────────────────

/** Максимальный размер ответа от upstream (Remnawave / sub-page). 10 MB. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Таймаут одного HTTP-запроса наружу. */
const HTTP_TIMEOUT_MS = 10 * 1000;

/** Сколько перенаправлений (3xx) ждать прежде чем сдаться. */
const HTTP_MAX_REDIRECTS = 3;

// ─── Sticky-сессии ─────────────────────────────────────────

/** Как часто sticky-assignments сбрасываются на диск. */
const STICKY_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Жёсткий потолок возраста sticky-записи на диске.
 * При loadFromDisk записи старше этого срока выбрасываются — анти-bloat.
 * TTL обновления в config (sticky_ttl_hours) — это soft-TTL, проверяется при чтении.
 */
const STICKY_HARD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Cache (upstream-ответы) ───────────────────────────────

/** Как часто cache.js удаляет просроченные записи. */
const CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// ─── Rate-limiter ──────────────────────────────────────────

/** Как часто rate-limiter удаляет просроченные buckets. */
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ─── Probe / observatory (значения по умолчанию) ───────────

/** Дефолтное число замеров RTT за один probe-цикл (можно override через config.probe_sampling). */
const DEFAULT_PROBE_SAMPLING = 3;

/** Дефолтный таймаут одного probe-replay'а (config.probe_timeout). */
const DEFAULT_PROBE_TIMEOUT = '3s';

/** Дефолтная стратегия балансера (config.strategy). Допустимо: leastLoad, leastPing, random. */
const DEFAULT_BALANCER_STRATEGY = 'leastLoad';

// ─── Балансер tolerance / baseline (значения по умолчанию) ─

/** Узкий коридор tolerance для main/tier1 балансеров (config.balancer_tolerance). */
const DEFAULT_BAL_TOLERANCE = 0.5;

/** Широкий коридор tolerance для fallback/tier2/wide-pool (config.balancer_tolerance_fallback). */
const DEFAULT_BAL_TOLERANCE_FALLBACK = 0.8;

/** Дефолтный baseline для tier1 (если не задан в group_tiers). */
const DEFAULT_TIER1_BASELINE_MS = 1600;

/** Дефолтный baseline для tier2. */
const DEFAULT_TIER2_BASELINE_MS = 4000;

/** Дефолтный baseline для main+lte balancer когда смешана нормальная и LTE-нагрузка. */
const DEFAULT_MAIN_WITH_LTE_BASELINE_MS = 2000;

/** Дефолтный baseline для одиночного балансера (когда нет тиров и LTE). */
const DEFAULT_SINGLE_BASELINE_MS = 4000;

// ─── CDN URLs (geosite/geoip) ──────────────────────────────

const DEFAULT_GEOSITE_CDN = 'https://cdn.jsdelivr.net/gh/hydraponique/roscomvpn-geosite/release';
const DEFAULT_GEOIP_CDN = 'https://cdn.jsdelivr.net/gh/hydraponique/roscomvpn-geoip/release';

// ─── Имена групп ───────────────────────────────────────────

/**
 * Имя AUTO-группы (самые быстрые серверы) по умолчанию. Используется когда
 * `auto_group_name` не задан в config.json. Активное значение читается из
 * `config.js` как `AUTO_GROUP_NAME` — все модули должны импортировать оттуда,
 * не из constants.
 */
const DEFAULT_AUTO_GROUP_NAME = '🇪🇺 AUTO | Самые быстрые';

// ─── Sticky-сессии (значения по умолчанию для config) ─────

const DEFAULT_STICKY_THRESHOLD_MS = 1000;
const DEFAULT_STICKY_TTL_HOURS = 168;
const DEFAULT_STICKY_PERSIST_PATH = '/app/data/sticky-assignments.json';
// DEFAULT_STICKY_EXCLUDE_GROUPS вычисляется в config.js на основе AUTO_GROUP_NAME
// (раньше был [AUTO_GROUP_NAME] прямо здесь — но теперь имя настраиваемое).

// ─── Probe destination ─────────────────────────────────────

const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_PROBE_INTERVAL = '3m';

// ─── Server description (Happ meta.serverDescription) ──────

/** Лимит длины serverDescription согласно Happ docs. */
const HAPP_DESCRIPTION_MAX_LENGTH = 30;

// ─── Mihomo / SingBox (url-test tolerance) ─────────────────
// Note: интервал url-test берётся из probe_interval (см. config.js + generators/),
// раньше тут был MIHOMO_URLTEST_INTERVAL_SEC=180 / SINGBOX_URLTEST_INTERVAL='3m'
// — дубликат настройки, удалён.

/** Tolerance url-test для Mihomo (миллисекунды). */
const MIHOMO_URLTEST_TOLERANCE_MS = 50;

/** Tolerance для SingBox url-test. */
const SINGBOX_URLTEST_TOLERANCE_MS = 50;

module.exports = {
    MAX_RESPONSE_BYTES, HTTP_TIMEOUT_MS, HTTP_MAX_REDIRECTS,
    STICKY_FLUSH_INTERVAL_MS, STICKY_HARD_MAX_AGE_MS,
    CACHE_CLEANUP_INTERVAL_MS, RATE_LIMIT_CLEANUP_INTERVAL_MS,
    DEFAULT_PROBE_SAMPLING, DEFAULT_PROBE_TIMEOUT, DEFAULT_BALANCER_STRATEGY,
    DEFAULT_BAL_TOLERANCE, DEFAULT_BAL_TOLERANCE_FALLBACK,
    DEFAULT_TIER1_BASELINE_MS, DEFAULT_TIER2_BASELINE_MS,
    DEFAULT_MAIN_WITH_LTE_BASELINE_MS, DEFAULT_SINGLE_BASELINE_MS,
    DEFAULT_GEOSITE_CDN, DEFAULT_GEOIP_CDN,
    DEFAULT_STICKY_THRESHOLD_MS, DEFAULT_STICKY_TTL_HOURS,
    DEFAULT_STICKY_PERSIST_PATH,
    DEFAULT_PROBE_URL, DEFAULT_PROBE_INTERVAL,
    DEFAULT_AUTO_GROUP_NAME,
    HAPP_DESCRIPTION_MAX_LENGTH,
    MIHOMO_URLTEST_TOLERANCE_MS, SINGBOX_URLTEST_TOLERANCE_MS,
};
