'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const {
    MAX_RESPONSE_BYTES, HTTP_TIMEOUT_MS, HTTP_MAX_REDIRECTS,
} = require('./constants');

// Re-export for back-compat (some callers expect MAX_RESPONSE_SIZE).
const MAX_RESPONSE_SIZE = MAX_RESPONSE_BYTES;

function envInt(envVal, fallback) {
    if (envVal === undefined || envVal === null || envVal === '') return fallback;
    const parsed = parseInt(envVal, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeTag(name) {
    const cleaned = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (cleaned.length > 0) return cleaned;
    // Fallback для имён без ASCII-символов (cyrillic, emoji, CJK):
    // sha256 hash → 8 hex chars. Гарантирует уникальный non-empty prefix.
    return 'g' + crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 8);
}

/**
 * Парсинг RAM. Принимает:
 *   - число байт (Remnawave 2.7+ API): 8589934592 → 8 GB
 *   - строку с единицами ("2.06 GB", "512 MB", старый API)
 * Возвращает GB.
 *
 * При невалидном/пустом входе возвращает `null` (не 1!) — это позволяет
 * вызывающему коду понять что метрика недоступна и не "глюкнуть" ноду
 * выпадая из выдачи через node_stats фильтр.
 *
 * @param {*} ram
 * @returns {number|null}
 */
function parseRamGb(ram) {
    if (ram === null || ram === undefined) return null;
    if (typeof ram === 'number') {
        if (!Number.isFinite(ram) || ram <= 0) return null;
        return ram / (1024 * 1024 * 1024);
    }
    if (typeof ram !== 'string') return null;
    const match = ram.match(/([\d.]+)\s*(GB|MB|KB|B)/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    const unit = match[2].toUpperCase();
    if (unit === 'KB') return val / (1024 * 1024);
    if (unit === 'B')  return val / (1024 * 1024 * 1024);
    if (unit === 'MB') return val / 1024;
    return val;
}

// ─── SSRF guard ─────────────────────────────────────────────

/**
 * Private/loopback/link-local CIDR блоки. При HTTP-redirect блокируем
 * перенаправления в эти диапазоны чтобы исключить SSRF через подконтрольный
 * Location-header (например злоумышленник может настроить свой публичный
 * URL чтобы редиректнуть на 127.0.0.1:админ-порт балансера).
 *
 * IPv6: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local).
 */
const PRIVATE_V4_CIDRS = [
    [0x7f000000, 0xff000000],   // 127.0.0.0/8
    [0x0a000000, 0xff000000],   // 10.0.0.0/8
    [0xac100000, 0xfff00000],   // 172.16.0.0/12
    [0xc0a80000, 0xffff0000],   // 192.168.0.0/16
    [0xa9fe0000, 0xffff0000],   // 169.254.0.0/16 (link-local)
    [0x00000000, 0xff000000],   // 0.0.0.0/8
];

function ipv4ToUint32(ip) {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateV4(ip) {
    const u = ipv4ToUint32(ip);
    if (u === null) return false;
    return PRIVATE_V4_CIDRS.some(([net, mask]) => (u & mask) === (net & mask));
}

function isPrivateV6(ip) {
    if (!ip) return false;
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // IPv4-mapped: ::ffff:127.0.0.1
    const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateV4(v4Mapped[1]);
    // ULA: fc00::/7 — first byte 0xFC or 0xFD
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    // link-local: fe80::/10
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    return false;
}

/**
 * Резолвит hostname в IP и проверяет что это не private/loopback/link-local.
 * @returns {Promise<boolean>} true если hostname резолвится в публичный адрес
 */
async function isHostnameSafe(hostname) {
    if (!hostname) return false;
    if (net.isIP(hostname)) {
        if (net.isIPv4(hostname)) return !isPrivateV4(hostname);
        if (net.isIPv6(hostname)) return !isPrivateV6(hostname);
        return false;
    }
    try {
        const addrs = await dns.lookup(hostname, { all: true });
        if (addrs.length === 0) return false;
        for (const a of addrs) {
            if (a.family === 4 && isPrivateV4(a.address)) return false;
            if (a.family === 6 && isPrivateV6(a.address)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * HTTP GET с таймаутом, лимитом размера, auto-redirect, SSRF-guard.
 * Использует http/https (совместимость с Docker internal DNS).
 *
 * Лимиты (timeout, max redirects, max response bytes) берутся из config.js
 * через lazy require (config грузится после utils, поэтому в module-level
 * require'е недоступен). При недоступности config'а — fallback на constants.
 *
 * SSRF-guard: при следовании redirect'у проверяем что hostname Location
 * резолвится в публичный IP — иначе ошибка. Initial request пропускается
 * без проверки (вызывающий сам отвечает за targetUrl).
 *
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
function fetchUrl(targetUrl, headers = {}, maxRedirects, opts = {}) {
    // Lazy load — config.js requires utils.js, поэтому в module-level require
    // его ещё нет. К моменту вызова fetchUrl всё уже загружено.
    let cfg;
    try { cfg = require('./config'); } catch { cfg = null; }

    const timeoutMs = cfg?.HTTP_FETCH_TIMEOUT_MS ?? HTTP_TIMEOUT_MS;
    const maxBytes = cfg?.HTTP_FETCH_MAX_RESPONSE_BYTES ?? MAX_RESPONSE_BYTES;
    const effectiveMaxRedirects = (typeof maxRedirects === 'number')
        ? maxRedirects
        : (cfg?.HTTP_FETCH_MAX_REDIRECTS ?? HTTP_MAX_REDIRECTS);

    const { _isRedirect = false } = opts;

    return new Promise(async (resolve, reject) => {
        let parsed;
        try { parsed = new URL(targetUrl); } catch (e) { return reject(new Error(`Invalid URL: ${targetUrl}`)); }

        // SSRF guard для redirect-цепочек.
        if (_isRedirect) {
            const safe = await isHostnameSafe(parsed.hostname);
            if (!safe) {
                return reject(new Error(`SSRF guard: redirect to private/unresolved host "${parsed.hostname}" blocked`));
            }
        }

        const mod = parsed.protocol === 'https:' ? https : http;

        const req = mod.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { ...headers },
        }, (res) => {
            // Redirect
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                if (effectiveMaxRedirects <= 0) return reject(new Error('Too many redirects'));
                let nextUrl;
                try {
                    nextUrl = new URL(res.headers.location, targetUrl).href;
                } catch (e) {
                    return reject(new Error(`Invalid redirect Location: "${res.headers.location}"`));
                }
                return fetchUrl(nextUrl, headers, effectiveMaxRedirects - 1, { _isRedirect: true })
                    .then(resolve, reject);
            }

            const chunks = [];
            let size = 0;
            let done = false;

            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes && !done) {
                    done = true;
                    req.destroy();
                    reject(new Error(`Response too large (>${maxBytes} bytes)`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('error', (err) => { if (!done) { done = true; reject(err); } });
            res.on('end', () => {
                if (done) return;
                done = true;
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

/**
 * Унифицированная обёртка для async try/catch блоков. Логирует ошибку
 * с тегом и возвращает fallback вместо throw.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{logger: object, tag: string, fallback?: any, level?: 'error'|'warn'|'debug'}} opts
 * @returns {Promise<T|any>}
 */
async function safeAsync(fn, opts = {}) {
    const { logger, tag = 'async', fallback = null, level = 'error' } = opts;
    try {
        return await fn();
    } catch (err) {
        if (logger && typeof logger[level] === 'function') {
            logger[level](tag, `❌ ${err.message || err}`);
        }
        return fallback;
    }
}

module.exports = {
    envInt, escapeRegex, sanitizeTag,
    parseRamGb,
    fetchUrl, isHostnameSafe, isPrivateV4, isPrivateV6,
    safeAsync,
    MAX_RESPONSE_SIZE, MAX_RESPONSE_BYTES,
};
