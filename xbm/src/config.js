'use strict';

const fs = require('fs');
const path = require('path');
const { envInt } = require('./utils');
const {
    MAX_RESPONSE_BYTES, HTTP_TIMEOUT_MS, HTTP_MAX_REDIRECTS,
    STICKY_FLUSH_INTERVAL_MS, STICKY_HARD_MAX_AGE_MS,
    CACHE_CLEANUP_INTERVAL_MS, RATE_LIMIT_CLEANUP_INTERVAL_MS,
    DEFAULT_PROBE_SAMPLING, DEFAULT_PROBE_TIMEOUT, DEFAULT_BALANCER_STRATEGY,
    DEFAULT_BAL_TOLERANCE, DEFAULT_BAL_TOLERANCE_FALLBACK,
    DEFAULT_TIER1_BASELINE_MS, DEFAULT_TIER2_BASELINE_MS,
    DEFAULT_MAIN_WITH_LTE_BASELINE_MS, DEFAULT_SINGLE_BASELINE_MS,
    DEFAULT_STICKY_THRESHOLD_MS, DEFAULT_STICKY_TTL_HOURS,
    DEFAULT_STICKY_PERSIST_PATH,
    DEFAULT_PROBE_URL, DEFAULT_PROBE_INTERVAL,
    DEFAULT_AUTO_GROUP_NAME,
    MIHOMO_URLTEST_TOLERANCE_MS, SINGBOX_URLTEST_TOLERANCE_MS,
} = require('./constants');

// ─── Загрузка конфига ───
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error(`❌ Ошибка чтения ${CONFIG_PATH}:`, err.message);
    process.exit(1);
}

// ─── Валидация ───

function validateConfig(cfg) {
    const warnings = [];
    const errors = [];

    // groups
    if (cfg.groups && typeof cfg.groups === 'object') {
        for (const [name, patterns] of Object.entries(cfg.groups)) {
            if (!Array.isArray(patterns)) {
                errors.push(`groups["${name}"] — значение должно быть массивом паттернов, получено: ${typeof patterns}`);
            } else if (patterns.length === 0) {
                warnings.push(`groups["${name}"] — пустой массив паттернов, группа никогда не совпадёт`);
            }
        }
    }

    // strategy
    const validStrategies = ['leastLoad', 'leastPing', 'random'];
    if (cfg.strategy && !validStrategies.includes(cfg.strategy)) {
        warnings.push(`strategy="${cfg.strategy}" — неизвестная стратегия, допустимые: ${validStrategies.join(', ')}`);
    }

    // rate_limit
    if (cfg.rate_limit) {
        if (cfg.rate_limit.max !== undefined && (typeof cfg.rate_limit.max !== 'number' || cfg.rate_limit.max < 0)) {
            errors.push(`rate_limit.max должен быть числом >= 0, получено: ${cfg.rate_limit.max}`);
        }
        if (cfg.rate_limit.window_sec !== undefined && (typeof cfg.rate_limit.window_sec !== 'number' || cfg.rate_limit.window_sec <= 0)) {
            errors.push(`rate_limit.window_sec должен быть числом > 0, получено: ${cfg.rate_limit.window_sec}`);
        }
    }

    // arrays
    for (const field of ['fastest_exclude', 'fastest_fallback', 'lte_patterns', 'node_stats_exclude',
                          'sticky_exclude_groups', 'dev_raw_tokens', 'direct_domains', 'mihomo_pro_tokens']) {
        if (cfg[field] !== undefined && !Array.isArray(cfg[field])) {
            errors.push(`${field} должен быть массивом, получено: ${typeof cfg[field]}`);
        }
    }

    // group_tiers — object map "groupName" → {tier1_patterns?, tier1_count?, tier1_baseline_ms?, tier2_baseline_ms?}
    if (cfg.group_tiers !== undefined) {
        if (typeof cfg.group_tiers !== 'object' || Array.isArray(cfg.group_tiers) || cfg.group_tiers === null) {
            errors.push('group_tiers должен быть объектом: { "имя группы": { tier1_patterns: [...] | tier1_count: N, ... } }');
        } else {
            for (const [gn, t] of Object.entries(cfg.group_tiers)) {
                if (typeof t !== 'object' || t === null) {
                    errors.push(`group_tiers["${gn}"] должен быть объектом`);
                    continue;
                }
                const hasPatterns = Array.isArray(t.tier1_patterns) && t.tier1_patterns.length > 0;
                const hasCount = Number.isInteger(t.tier1_count) && t.tier1_count > 0;
                if (!hasPatterns && !hasCount) {
                    warnings.push(`group_tiers["${gn}"]: нужно задать tier1_patterns (whitelist) или tier1_count (число), tier-режим не активируется`);
                }
                if (t.tier1_baseline_ms !== undefined && (typeof t.tier1_baseline_ms !== 'number' || t.tier1_baseline_ms <= 0)) {
                    errors.push(`group_tiers["${gn}"].tier1_baseline_ms должен быть положительным числом`);
                }
                if (t.tier2_baseline_ms !== undefined && (typeof t.tier2_baseline_ms !== 'number' || t.tier2_baseline_ms <= 0)) {
                    errors.push(`group_tiers["${gn}"].tier2_baseline_ms должен быть положительным числом`);
                }
            }
        }
    }

    // API_TOKEN warnings
    if (cfg.node_stats === true && !process.env.API_TOKEN && !cfg.api_token) {
        warnings.push('node_stats=true, но API_TOKEN не задан — статистика нод не будет работать');
    }
    if (cfg.auto_groups === true && !process.env.API_TOKEN && !cfg.api_token) {
        warnings.push('auto_groups=true, но API_TOKEN не задан — автогруппировка не будет работать');
    }

    // booleans
    for (const field of ['udp_block', 'mihomo_enabled', 'singbox_enabled', 'sticky_session']) {
        if (cfg[field] !== undefined && typeof cfg[field] !== 'boolean') {
            errors.push(`${field} должен быть boolean, получено: ${typeof cfg[field]}`);
        }
    }

    // positive integers
    for (const field of ['load_expected', 'probe_sampling']) {
        if (cfg[field] !== undefined && (typeof cfg[field] !== 'number' || cfg[field] < 1 || !Number.isInteger(cfg[field]))) {
            errors.push(`${field} должен быть целым числом >= 1, получено: ${cfg[field]}`);
        }
    }

    // sticky thresholds
    if (cfg.sticky_threshold_ms !== undefined && (typeof cfg.sticky_threshold_ms !== 'number' || cfg.sticky_threshold_ms <= 0)) {
        errors.push(`sticky_threshold_ms должен быть положительным числом, получено: ${cfg.sticky_threshold_ms}`);
    }
    if (cfg.sticky_ttl_hours !== undefined && (typeof cfg.sticky_ttl_hours !== 'number' || cfg.sticky_ttl_hours <= 0)) {
        errors.push(`sticky_ttl_hours должен быть положительным числом, получено: ${cfg.sticky_ttl_hours}`);
    }
    if (cfg.sticky_persist_path !== undefined && typeof cfg.sticky_persist_path !== 'string') {
        errors.push(`sticky_persist_path должен быть строкой пути`);
    }

    // tolerance — float 0..1
    for (const field of ['balancer_tolerance', 'balancer_tolerance_fallback']) {
        if (cfg[field] !== undefined && (typeof cfg[field] !== 'number' || cfg[field] < 0 || cfg[field] > 1)) {
            errors.push(`${field} должен быть числом 0..1, получено: ${cfg[field]}`);
        }
    }

    // probe_timeout — string like '3s' / '500ms'
    if (cfg.probe_timeout !== undefined && typeof cfg.probe_timeout !== 'string') {
        errors.push(`probe_timeout должен быть строкой длительности (например "3s", "500ms"), получено: ${typeof cfg.probe_timeout}`);
    }

    // auto_group_name — non-empty string
    if (cfg.auto_group_name !== undefined) {
        if (typeof cfg.auto_group_name !== 'string') {
            errors.push(`auto_group_name должен быть строкой, получено: ${typeof cfg.auto_group_name}`);
        } else if (cfg.auto_group_name.trim().length === 0) {
            errors.push('auto_group_name не должен быть пустой строкой');
        }
    }

    // ─── Точечные настройки (positive integers / floats) ───

    // Positive integers
    const positiveIntFields = [
        'http_timeout_ms', 'http_max_redirects', 'max_response_bytes',
        'server_keepalive_timeout_sec', 'server_headers_timeout_sec', 'server_request_timeout_sec',
        'upstream_cache_max_entries', 'upstream_cache_cleanup_interval_sec',
        'sticky_flush_interval_sec', 'sticky_hard_max_age_days',
        'sticky_max_tokens_in_memory', 'sticky_in_memory_cleanup_interval_hours',
        'rate_limit_cleanup_interval_sec',
        'default_tier1_baseline_ms', 'default_tier2_baseline_ms',
        'default_main_with_lte_baseline_ms', 'default_single_baseline_ms', 'default_lte_baseline_ms',
        'mihomo_urltest_tolerance_ms', 'singbox_urltest_tolerance_ms',
    ];
    for (const field of positiveIntFields) {
        if (cfg[field] !== undefined &&
            (typeof cfg[field] !== 'number' || cfg[field] < 1 || !Number.isInteger(cfg[field]))) {
            errors.push(`${field} должен быть целым положительным числом, получено: ${cfg[field]}`);
        }
    }

    // node_load_threshold — float > 0
    if (cfg.node_load_threshold !== undefined &&
        (typeof cfg.node_load_threshold !== 'number' || cfg.node_load_threshold <= 0)) {
        errors.push(`node_load_threshold должен быть положительным числом, получено: ${cfg.node_load_threshold}`);
    }

    return { warnings, errors };
}

const { warnings: cfgWarnings, errors: cfgErrors } = validateConfig(config);
for (const w of cfgWarnings) console.warn(`⚠️  [config] ${w}`);
for (const e of cfgErrors) console.error(`❌ [config] ${e}`);
if (cfgErrors.length > 0) {
    console.error('❌ Исправьте ошибки в config.json и перезапустите.');
    process.exit(1);
}

// ─── Константы ───

const PORT = envInt(process.env.PORT, config.port ?? 4100);
const REMNAWAVE_URL = process.env.REMNAWAVE_URL || config.remnawave_url;
const SUB_PAGE_URL = process.env.SUB_PAGE_URL || config.sub_page_url || '';
const SUB_DOMAIN = process.env.SUB_DOMAIN || config.sub_domain || '';

if (!REMNAWAVE_URL && !SUB_PAGE_URL) {
    console.error('❌ REMNAWAVE_URL не задан (ни в .env, ни в config.json). Укажите хотя бы REMNAWAVE_URL или SUB_PAGE_URL.');
    process.exit(1);
}

const REMNAWAVE_SUB_PATH = process.env.SUB_PATH || config.sub_path || '/api/sub';
const API_TOKEN = process.env.API_TOKEN || config.api_token || '';
const PANEL_AUTH_COOKIE = process.env.PANEL_AUTH_COOKIE || config.panel_auth_cookie || '';

// ─── Балансер / probe ─────────────────────────────────────

const STRATEGY = config.strategy || DEFAULT_BALANCER_STRATEGY;
const PROBE_INTERVAL = config.probe_interval || DEFAULT_PROBE_INTERVAL;
const PROBE_URL = config.probe_url || DEFAULT_PROBE_URL;
const PROBE_TIMEOUT = config.probe_timeout || DEFAULT_PROBE_TIMEOUT;

// Сколько проб делать за один цикл burstObservatory. При sampling=N к каждому
// серверу делается N TCP-handshake'ов через прокси-цепочку каждые PROBE_INTERVAL.
// Дефолт — низкий, чтобы минимизировать "фантомных" пользователей в метриках нод.
const PROBE_SAMPLING = Math.max(1, parseInt(config.probe_sampling, 10) || DEFAULT_PROBE_SAMPLING);

// expected: сколько серверов балансер отдаёт как "лучшие" в leastLoad/leastPing.
// 1 → весь трафик группы концентрируется на одном (баг). >1 → распределение.
const LOAD_EXPECTED = Math.max(1, parseInt(config.load_expected, 10) || 3);

// Tolerance для leastLoad: насколько "соседние по RTT" сервера считаются равными.
// Узкий tolerance (0.5) для main/tier1 — строгая фильтрация. Широкий (0.8) для
// fallback/tier2 — мягче, чтобы fallback-pool работал даже при разнобое RTT.
const BAL_TOLERANCE = (typeof config.balancer_tolerance === 'number') ? config.balancer_tolerance : DEFAULT_BAL_TOLERANCE;
const BAL_TOLERANCE_FB = (typeof config.balancer_tolerance_fallback === 'number') ? config.balancer_tolerance_fallback : DEFAULT_BAL_TOLERANCE_FALLBACK;

// ─── Auto-groups / node-stats ─────────────────────────────

const AUTO_GROUPS = config.auto_groups === true;

/**
 * auto_host_groups: хосты, не попавшие ни в одну группу из `groups`, показываются
 * отдельной локацией с именем хоста из Remnawave (вместо того чтобы пропадать).
 * Порядок локаций = порядок хостов в панели Remnawave.
 */
const AUTO_HOST_GROUPS = config.auto_host_groups === true;
const AUTO_GROUPS_INTERVAL = (config.auto_groups_interval_sec || 300) * 1000;

const NODE_STATS_ENABLED = process.env.NODE_STATS === 'true' || config.node_stats === true;
const NODE_STATS_INTERVAL = envInt(process.env.NODE_STATS_INTERVAL_SEC, config.node_stats_interval_sec ?? 120) * 1000;
const MAX_USERS_PER_GB = envInt(process.env.MAX_USERS_PER_GB, config.max_users_per_gb ?? 20);
const MAX_USERS_PER_CPU = envInt(process.env.MAX_USERS_PER_CPU, config.max_users_per_cpu ?? 40);

const UPSTREAM_CACHE_TTL = (config.upstream_cache_ttl_sec ?? 300) * 1000;

const RATE_LIMIT_MAX = config.rate_limit?.max ?? 5;
const RATE_LIMIT_WINDOW = (config.rate_limit?.window_sec ?? 60) * 1000;

const HAPP_ROUTING_URL = config.happ_routing_url || '';
const HAPP_ROUTING_UPDATE_INTERVAL = (config.happ_routing_update_interval_sec || 3600) * 1000;

const LTE_PATTERNS = (config.lte_patterns || ['LTE']).map(p => String(p).toLowerCase());

// Блокировать UDP 443 (QUIC / HTTP/3). Дефолт true для обратной совместимости.
const UDP_BLOCK = config.udp_block !== false;

// Тумблеры генерации Mihomo/Sing-box. Default true.
const MIHOMO_ENABLED = config.mihomo_enabled !== false;
const SINGBOX_ENABLED = config.singbox_enabled !== false;

// ─── Имя AUTO группы ──────────────────────────────────────

/**
 * Имя группы "Самые быстрые" — отображается в подписке. Можно переименовать
 * через config.json `auto_group_name`. Должно содержать минимум один символ.
 * Default: "🇪🇺 AUTO | Самые быстрые".
 */
const AUTO_GROUP_NAME = (typeof config.auto_group_name === 'string' && config.auto_group_name.trim())
    ? config.auto_group_name.trim()
    : DEFAULT_AUTO_GROUP_NAME;

// ─── Sticky-сессии ────────────────────────────────────────

const STICKY_SESSION = config.sticky_session === true;
const STICKY_THRESHOLD_MS = (typeof config.sticky_threshold_ms === 'number') ? config.sticky_threshold_ms : DEFAULT_STICKY_THRESHOLD_MS;
const STICKY_TTL_HOURS = (typeof config.sticky_ttl_hours === 'number') ? config.sticky_ttl_hours : DEFAULT_STICKY_TTL_HOURS;
const STICKY_PERSIST_PATH = config.sticky_persist_path || DEFAULT_STICKY_PERSIST_PATH;
// Default exclude — AUTO группа (не имеет смысла назначать sticky на "самый быстрый" пул).
const STICKY_EXCLUDE_GROUPS = Array.isArray(config.sticky_exclude_groups) ? config.sticky_exclude_groups : [AUTO_GROUP_NAME];

// ─── Dev / raw bypass ─────────────────────────────────────

/**
 * Whitelist токенов, которым доступен `?raw=1` bypass балансера. Отдаётся
 * upstream-подписка как есть, для дебага. Без whitelist'а endpoint не активен.
 */
const DEV_RAW_TOKENS = new Set(Array.isArray(config.dev_raw_tokens) ? config.dev_raw_tokens : []);

/**
 * Whitelist токенов которым выдавать Mihomo PRO YAML (Legiz-style с semantic groups)
 * по `?profile=pro`. Без whitelist'а — обычный generateMihomoYaml.
 */
const MIHOMO_PRO_TOKENS = new Set(Array.isArray(config.mihomo_pro_tokens) ? config.mihomo_pro_tokens : []);

// ─── Тонкая настройка — таймауты HTTP / кэш / лимиты ─────

/** Таймаут одного fetch к upstream (Remnawave / sub-page / happ_routing_url). */
const HTTP_FETCH_TIMEOUT_MS = (typeof config.http_timeout_ms === 'number') ? config.http_timeout_ms : HTTP_TIMEOUT_MS;
/** Максимум redirect'ов которые fetchUrl следует. */
const HTTP_FETCH_MAX_REDIRECTS = (typeof config.http_max_redirects === 'number') ? config.http_max_redirects : HTTP_MAX_REDIRECTS;
/** Лимит размера ответа от upstream (байты). При превышении ошибка "Response too large". */
const HTTP_FETCH_MAX_RESPONSE_BYTES = (typeof config.max_response_bytes === 'number') ? config.max_response_bytes : MAX_RESPONSE_BYTES;

// HTTP server timeouts (применяются к http.createServer в server.js).
// Default'ы Node.js: keepAlive 5s, headers 60s, request 0 (нет лимита).
// Production-friendly defaults: 65s/66s/30s.
const SERVER_KEEPALIVE_TIMEOUT_MS = (config.server_keepalive_timeout_sec ?? 65) * 1000;
const SERVER_HEADERS_TIMEOUT_MS = (config.server_headers_timeout_sec ?? 66) * 1000;
const SERVER_REQUEST_TIMEOUT_MS = (config.server_request_timeout_sec ?? 30) * 1000;

// Cache (upstream-ответы)
const UPSTREAM_CACHE_MAX_ENTRIES = config.upstream_cache_max_entries ?? 5000;
const UPSTREAM_CACHE_CLEANUP_INTERVAL_MS = config.upstream_cache_cleanup_interval_sec
    ? config.upstream_cache_cleanup_interval_sec * 1000
    : CACHE_CLEANUP_INTERVAL_MS;

// Rate-limiter
const RATE_LIMIT_CLEANUP_INTERVAL_MS_CFG = config.rate_limit_cleanup_interval_sec
    ? config.rate_limit_cleanup_interval_sec * 1000
    : RATE_LIMIT_CLEANUP_INTERVAL_MS;

// Sticky internals
const STICKY_FLUSH_INTERVAL_MS_CFG = config.sticky_flush_interval_sec
    ? config.sticky_flush_interval_sec * 1000
    : STICKY_FLUSH_INTERVAL_MS;
const STICKY_HARD_MAX_AGE_MS_CFG = config.sticky_hard_max_age_days
    ? config.sticky_hard_max_age_days * 24 * 60 * 60 * 1000
    : STICKY_HARD_MAX_AGE_MS;
const STICKY_MAX_TOKENS_IN_MEMORY = config.sticky_max_tokens_in_memory ?? 100_000;
const STICKY_IN_MEMORY_CLEANUP_INTERVAL_MS = (config.sticky_in_memory_cleanup_interval_hours ?? 5) * 60 * 60 * 1000;

// ─── Балансер: baseline'ы (тюнинг для разных режимов) ─────

const TIER1_BASELINE_MS = config.default_tier1_baseline_ms ?? DEFAULT_TIER1_BASELINE_MS;
const TIER2_BASELINE_MS = config.default_tier2_baseline_ms ?? DEFAULT_TIER2_BASELINE_MS;
const MAIN_WITH_LTE_BASELINE_MS = config.default_main_with_lte_baseline_ms ?? DEFAULT_MAIN_WITH_LTE_BASELINE_MS;
const SINGLE_BASELINE_MS = config.default_single_baseline_ms ?? DEFAULT_SINGLE_BASELINE_MS;
const LTE_BASELINE_MS = config.default_lte_baseline_ms ?? DEFAULT_SINGLE_BASELINE_MS;

// ─── Node-stats: порог "перегруженной" ноды ───────────────

/**
 * При `load > NODE_LOAD_THRESHOLD` нода исключается из выдачи.
 * Default 1.0. Если у вас в проде каскадные отказы из-за фантомных юзеров —
 * поднимите до 2.0-3.0 (см. README раздел "Расчёт нагрузки").
 */
const NODE_LOAD_THRESHOLD = (typeof config.node_load_threshold === 'number') ? config.node_load_threshold : 1.0;

// ─── Mihomo / SingBox: tolerance для url-test ─────────────

const MIHOMO_URLTEST_TOLERANCE_MS_CFG = config.mihomo_urltest_tolerance_ms ?? MIHOMO_URLTEST_TOLERANCE_MS;
const SINGBOX_URLTEST_TOLERANCE_MS_CFG = config.singbox_urltest_tolerance_ms ?? SINGBOX_URLTEST_TOLERANCE_MS;

// ─── Логирование ──────────────────────────────────────────

const LOG_LEVEL = (process.env.LOG_LEVEL || config.log_level || 'info').toLowerCase();

/** Собрать заголовки для API панели */
function panelHeaders() {
    const h = {
        'Authorization': `Bearer ${API_TOKEN}`,
        'X-Forwarded-For': '127.0.0.1',
        'X-Forwarded-Proto': 'https',
    };
    if (PANEL_AUTH_COOKIE) h['Cookie'] = PANEL_AUTH_COOKIE;
    return h;
}

module.exports = {
    config, CONFIG_PATH,
    PORT, REMNAWAVE_URL, REMNAWAVE_SUB_PATH, API_TOKEN, PANEL_AUTH_COOKIE,
    SUB_PAGE_URL, SUB_DOMAIN,
    STRATEGY, PROBE_INTERVAL, PROBE_URL, PROBE_TIMEOUT, PROBE_SAMPLING,
    LOAD_EXPECTED,
    BAL_TOLERANCE, BAL_TOLERANCE_FB,
    AUTO_GROUPS, AUTO_GROUPS_INTERVAL, AUTO_HOST_GROUPS,
    NODE_STATS_ENABLED, NODE_STATS_INTERVAL, MAX_USERS_PER_GB, MAX_USERS_PER_CPU,
    UPSTREAM_CACHE_TTL,
    RATE_LIMIT_MAX, RATE_LIMIT_WINDOW,
    HAPP_ROUTING_URL, HAPP_ROUTING_UPDATE_INTERVAL,
    LTE_PATTERNS, UDP_BLOCK, LOG_LEVEL,
    MIHOMO_ENABLED, SINGBOX_ENABLED,
    STICKY_SESSION, STICKY_THRESHOLD_MS, STICKY_TTL_HOURS, STICKY_PERSIST_PATH, STICKY_EXCLUDE_GROUPS,
    AUTO_GROUP_NAME,
    DEV_RAW_TOKENS, MIHOMO_PRO_TOKENS,
    // Тонкие настройки
    HTTP_FETCH_TIMEOUT_MS, HTTP_FETCH_MAX_REDIRECTS, HTTP_FETCH_MAX_RESPONSE_BYTES,
    SERVER_KEEPALIVE_TIMEOUT_MS, SERVER_HEADERS_TIMEOUT_MS, SERVER_REQUEST_TIMEOUT_MS,
    UPSTREAM_CACHE_MAX_ENTRIES, UPSTREAM_CACHE_CLEANUP_INTERVAL_MS,
    RATE_LIMIT_CLEANUP_INTERVAL_MS_CFG,
    STICKY_FLUSH_INTERVAL_MS_CFG, STICKY_HARD_MAX_AGE_MS_CFG,
    STICKY_MAX_TOKENS_IN_MEMORY, STICKY_IN_MEMORY_CLEANUP_INTERVAL_MS,
    TIER1_BASELINE_MS, TIER2_BASELINE_MS,
    MAIN_WITH_LTE_BASELINE_MS, SINGLE_BASELINE_MS, LTE_BASELINE_MS,
    NODE_LOAD_THRESHOLD,
    MIHOMO_URLTEST_TOLERANCE_MS_CFG, SINGBOX_URLTEST_TOLERANCE_MS_CFG,
    panelHeaders,
};
