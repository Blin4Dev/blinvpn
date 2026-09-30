'use strict';

/**
 * Sticky-сессии: каждый юзер (по subscription token) получает персональный
 * сервер в каждой группе по детерминированному hash. Sticky-сервер держится
 * пока его пинг ≤ STICKY_THRESHOLD_MS (на стороне клиентского Xray через
 * burstObservatory + sticky-balancer fallback в Xray-конфиге).
 *
 * Persistence: периодический atomic write на диск (tmp + rename).
 * Cleanup: запись старше STICKY_HARD_MAX_AGE выкидывается.
 *
 * Все интервалы и лимиты тюнятся через config.json:
 *   - sticky_flush_interval_sec       (default 300)
 *   - sticky_hard_max_age_days        (default 30)
 *   - sticky_max_tokens_in_memory     (default 100000)
 *   - sticky_in_memory_cleanup_interval_hours (default 5)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');
const {
    STICKY_TTL_HOURS, STICKY_PERSIST_PATH,
    STICKY_FLUSH_INTERVAL_MS_CFG, STICKY_HARD_MAX_AGE_MS_CFG,
    STICKY_MAX_TOKENS_IN_MEMORY, STICKY_IN_MEMORY_CLEANUP_INTERVAL_MS,
} = require('./config');

const TTL_MS = STICKY_TTL_HOURS * 3600 * 1000;
const FLUSH_INTERVAL_MS = STICKY_FLUSH_INTERVAL_MS_CFG;
const MAX_AGE_MS = STICKY_HARD_MAX_AGE_MS_CFG;

/**
 * Soft-лимит на размер in-memory map — защита от DoS через спам разными токенами.
 * При превышении игнорим новые токены (старые получают свои назначения как обычно).
 * Default 100k токенов × ~200 байт = ~20 MB памяти.
 */
const MAX_TOKENS_IN_MEMORY = STICKY_MAX_TOKENS_IN_MEMORY;

/** Интервал periodic-cleanup для in-memory Map. */
const IN_MEMORY_CLEANUP_INTERVAL_MS = STICKY_IN_MEMORY_CLEANUP_INTERVAL_MS;

const assignments = new Map();
let dirty = false;
let flushTimer = null;
let cleanupTimer = null;

function loadFromDisk() {
    try {
        const raw = fs.readFileSync(STICKY_PERSIST_PATH, 'utf8');
        const obj = JSON.parse(raw);
        let count = 0;
        for (const [token, groups] of Object.entries(obj)) {
            if (!groups || typeof groups !== 'object') continue;
            const userMap = new Map();
            for (const [groupName, asg] of Object.entries(groups)) {
                if (!asg || typeof asg !== 'object' || !asg.tag || !asg.assignedAt) continue;
                if (Date.now() - asg.assignedAt > MAX_AGE_MS) continue;
                userMap.set(groupName, asg);
            }
            if (userMap.size > 0) {
                assignments.set(token, userMap);
                count++;
            }
            if (assignments.size >= MAX_TOKENS_IN_MEMORY) break;
        }
        logger.info('sticky', `Загружено ${count} назначений из ${STICKY_PERSIST_PATH}`);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            logger.warn('sticky', `Чтение ${STICKY_PERSIST_PATH}: ${err.message}`);
        }
    }
}

/**
 * Удалить из in-memory Map записи у которых ВСЕ группы старше MAX_AGE_MS.
 * Запускается раз в 5 часов, чтоб неактивные юзеры не висели в памяти.
 * @returns {number} сколько токенов удалено.
 */
function cleanupStaleEntries() {
    const cutoff = Date.now() - MAX_AGE_MS;
    let removed = 0;
    for (const [token, userMap] of assignments) {
        let hasFresh = false;
        for (const asg of userMap.values()) {
            if (asg && asg.assignedAt && asg.assignedAt >= cutoff) {
                hasFresh = true;
                break;
            }
        }
        if (!hasFresh) {
            assignments.delete(token);
            removed++;
        }
    }
    if (removed > 0) {
        dirty = true;
        logger.info('sticky', `Очистка in-memory: удалено ${removed} протухших токенов (>${MAX_AGE_MS / 86400000}d)`);
    }
    return removed;
}

function flushToDisk() {
    if (!dirty) return;
    // Снимок данных ДО очистки dirty — если что-то упадёт во время записи,
    // данные не теряются на следующий цикл.
    const obj = {};
    for (const [token, groups] of assignments) {
        obj[token] = Object.fromEntries(groups);
    }
    try {
        const dir = path.dirname(STICKY_PERSIST_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = STICKY_PERSIST_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, STICKY_PERSIST_PATH);
        // Только после успешного rename снимаем dirty.
        dirty = false;
    } catch (err) {
        logger.warn('sticky', `Запись ${STICKY_PERSIST_PATH}: ${err.message}`);
    }
}

function hashKey(token, tag) {
    const h = crypto.createHash('sha256').update(`${token}:${tag}`).digest();
    return h.readUInt32BE(0);
}

/**
 * Назначить или вернуть существующий sticky-сервер для (token, groupName).
 *
 * Логика:
 *   1. Если есть валидное (TTL не истёк, candidates содержит) назначение — вернуть его,
 *      проверив что нода не перегружена (load < 1.0 по node-stats).
 *   2. Иначе — отсортировать candidates по deterministic hash(token, tag),
 *      пройтись по списку и вернуть первый не-перегруженный.
 *
 * @param {string} token - subscription token
 * @param {string} groupName - имя группы
 * @param {string[]} candidateTags - возможные outbound теги
 * @param {function(string): {load: number}|null|undefined} loadLookup - tag → load info
 * @returns {string|null} назначенный тег или null если candidateTags пуст
 */
function getOrAssign(token, groupName, candidateTags, loadLookup) {
    if (!Array.isArray(candidateTags) || candidateTags.length === 0) return null;
    if (!token || typeof token !== 'string') return null;

    let userMap = assignments.get(token);
    if (!userMap) {
        // DoS защита: если карта переполнена — не создаём новые записи в памяти,
        // но всё равно возвращаем детерминированный hash (юзер получит сервер,
        // только без persistence).
        if (assignments.size >= MAX_TOKENS_IN_MEMORY) {
            const sorted = candidateTags.slice().sort((a, b) => hashKey(token, a) - hashKey(token, b));
            for (const tag of sorted) {
                const stats = loadLookup ? loadLookup(tag) : null;
                const load = stats?.load ?? 0.5;
                if (load < 1.0) return tag;
            }
            return sorted[0];
        }
        userMap = new Map();
        assignments.set(token, userMap);
    }

    const existing = userMap.get(groupName);
    const stillValid = existing
        && candidateTags.includes(existing.tag)
        && (Date.now() - existing.assignedAt < TTL_MS);

    if (stillValid) {
        const stats = loadLookup ? loadLookup(existing.tag) : null;
        const load = stats?.load ?? 0.5;
        if (load < 1.0) return existing.tag;
        logger.info('sticky', `Реассигн ${token.slice(-8)} в "${groupName}": ${existing.tag} перегружен (load=${load})`);
    }

    const sorted = candidateTags.slice().sort((a, b) => hashKey(token, a) - hashKey(token, b));
    let chosen = sorted[0];
    for (const tag of sorted) {
        const stats = loadLookup ? loadLookup(tag) : null;
        const load = stats?.load ?? 0.5;
        if (load < 1.0) {
            chosen = tag;
            break;
        }
    }

    userMap.set(groupName, { tag: chosen, assignedAt: Date.now() });
    dirty = true;
    return chosen;
}

/**
 * Вернуть назначения текущего токена (по группам). Используется на endpoint /sticky/<token>.
 * @param {string} token
 * @returns {{[groupName: string]: {tag: string, assignedAt: number, assignedAtIso: string, expiresAtIso: string}}|null}
 */
function describe(token) {
    if (!token) return null;
    const userMap = assignments.get(token);
    if (!userMap) return null;
    const result = {};
    const now = Date.now();
    for (const [groupName, asg] of userMap) {
        // Фильтруем expired записи на чтении (lazy cleanup).
        if (!asg || (now - asg.assignedAt > MAX_AGE_MS)) continue;
        result[groupName] = {
            tag: asg.tag,
            assignedAt: asg.assignedAt,
            assignedAtIso: new Date(asg.assignedAt).toISOString(),
            expiresAtIso: new Date(asg.assignedAt + TTL_MS).toISOString(),
        };
    }
    return Object.keys(result).length > 0 ? result : null;
}

/** Количество уникальных юзеров в памяти (для health/диагностики). */
function size() {
    return assignments.size;
}

/**
 * Инициализация модуля: загрузка с диска, periodic flush, graceful shutdown handlers.
 * Вызывается из server.js::start() ОДИН раз при старте.
 */
function init() {
    loadFromDisk();
    flushTimer = setInterval(flushToDisk, FLUSH_INTERVAL_MS);
    flushTimer.unref();
    cleanupTimer = setInterval(cleanupStaleEntries, IN_MEMORY_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    process.on('exit', flushToDisk);
    process.on('SIGTERM', () => { flushToDisk(); });
    process.on('SIGINT', () => { flushToDisk(); });
}

module.exports = { init, getOrAssign, describe, flushToDisk, size, cleanupStaleEntries, MAX_TOKENS_IN_MEMORY };
