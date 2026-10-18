'use strict';

const { logger } = require('./logger');
const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, RATE_LIMIT_CLEANUP_INTERVAL_MS_CFG } = require('./config');

const store = new Map();

// Очистка устаревших записей.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (now >= entry.resetAt) store.delete(key);
    }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS_CFG).unref();

/**
 * Извлечь client IP из request с учётом reverse proxy.
 * Проверяет в порядке: X-Real-IP → X-Forwarded-For (первый IP) → req.socket.remoteAddress.
 * Это критично за reverse proxy (Caddy/Nginx) — без этого все клиенты делят
 * один bucket (127.0.0.1).
 */
function clientIpFromRequest(req) {
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') return realIp.trim();

    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }

    return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
    if (RATE_LIMIT_MAX <= 0) return { allowed: true };

    const hwid = req.headers['x-hwid'];
    const ip = clientIpFromRequest(req);
    // HWID приоритетнее IP — он стабильнее, не страдает от NAT/общих IP.
    const key = hwid ? `hwid:${hwid}` : `ip:${ip}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
        store.set(key, entry);
    }

    entry.count++;

    const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

    if (entry.count > RATE_LIMIT_MAX) {
        logger.warn('rate-limit', `🚫 ${key} — превышен лимит (${entry.count}/${RATE_LIMIT_MAX}) retry=${retryAfter}s`);
        return { allowed: false, retryAfter, remaining: 0, key };
    }

    return { allowed: true, remaining, retryAfter, key };
}

module.exports = { checkRateLimit, clientIpFromRequest };
