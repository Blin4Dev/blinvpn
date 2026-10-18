'use strict';

const { UPSTREAM_CACHE_TTL, UPSTREAM_CACHE_MAX_ENTRIES, UPSTREAM_CACHE_CLEANUP_INTERVAL_MS } = require('./config');

/**
 * Soft-лимит на количество кэшированных ответов (config: `upstream_cache_max_entries`).
 * При превышении самые старые по `cachedAt` записи вытесняются (LRU-style).
 * Защищает от DoS-вектора: атакующий с массой токенов мог бы выжрать всю
 * память за счёт кэша.
 *
 * Default 5000 токенов × ~500KB body = ~2.5GB макс. Подберите под свой
 * профиль нагрузки.
 */
const MAX_CACHE_ENTRIES = UPSTREAM_CACHE_MAX_ENTRIES;

const cache = new Map();

/** Удалить записи старше TTL. */
function cleanupExpired() {
    if (UPSTREAM_CACHE_TTL <= 0) return;
    const now = Date.now();
    for (const [token, entry] of cache) {
        if (now - entry.cachedAt > UPSTREAM_CACHE_TTL) cache.delete(token);
    }
}

/** Вытеснить самые старые записи если переполнен. */
function evictIfFull() {
    if (cache.size <= MAX_CACHE_ENTRIES) return;
    // Сортируем по cachedAt и удаляем старые до возврата к лимиту.
    const entries = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const overflow = cache.size - MAX_CACHE_ENTRIES;
    for (let i = 0; i < overflow; i++) cache.delete(entries[i][0]);
}

function cacheUpstreamResponse(token, body, headers, contentType) {
    if (UPSTREAM_CACHE_TTL <= 0) return;
    cache.set(token, { body, headers, contentType, cachedAt: Date.now() });
    evictIfFull();
}

function getCachedResponse(token) {
    if (UPSTREAM_CACHE_TTL <= 0) return null;
    const entry = cache.get(token);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > UPSTREAM_CACHE_TTL) {
        cache.delete(token);
        return null;
    }
    return entry;
}

// Periodic cleanup. Запускается только если кэш активен.
if (UPSTREAM_CACHE_TTL > 0) {
    setInterval(cleanupExpired, UPSTREAM_CACHE_CLEANUP_INTERVAL_MS).unref();
}

module.exports = { cacheUpstreamResponse, getCachedResponse, cache, MAX_CACHE_ENTRIES };
