'use strict';

const { logger } = require('./logger');
const { config, API_TOKEN, REMNAWAVE_URL, MAX_USERS_PER_GB, MAX_USERS_PER_CPU, NODE_STATS_ENABLED, NODE_STATS_INTERVAL, NODE_LOAD_THRESHOLD, panelHeaders } = require('./config');
const { fetchUrl, escapeRegex, parseRamGb, safeAsync } = require('./utils');

let nodeStatsCache = {};
let _lastRefreshAt = null;

function getCache() { return nodeStatsCache; }
function getLastRefreshAt() { return _lastRefreshAt; }

// ─── Опрос API панели ───

async function fetchNodeStats() {
    if (!API_TOKEN || !REMNAWAVE_URL) return;
    return safeAsync(async () => {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/nodes/`, panelHeaders());
        if (response.status !== 200) {
            logger.warn('node-stats', `⚠️  API вернул статус ${response.status}`);
            return;
        }
        const data = JSON.parse(response.body);
        const nodes = data.response || (Array.isArray(data) ? data : []);

        const newCache = {};
        for (const node of nodes) {
            const name = node.name || '';
            if (!name) continue;
            const usersOnline = Number(node.usersOnline) || 0;
            // Remnawave 2.7+: node.system.info.memoryTotal / cpuCount
            // Fallback: node.system.memoryTotal, node.totalRam (старые версии)
            const sys = node.system || {};
            const sysInfo = sys.info || sys;
            const totalRamGb = parseRamGb(sysInfo.memoryTotal ?? sysInfo.totalRam ?? node.totalRam);
            const cpuCountRaw = sysInfo.cpuCount ?? sys.cpuCount ?? node.cpuCount;
            const cpuCount = (Number.isFinite(cpuCountRaw) && cpuCountRaw > 0) ? Number(cpuCountRaw) : null;
            const isConnected = Boolean(node.isConnected);
            const isDisabled = Boolean(node.isDisabled);

            // Если RAM или CPU неизвестны — load неопределён. Не выкидываем ноду
            // (как раньше делал баг с parseRamGb=1 → load=∞ → filter out), а
            // помечаем load=null. filterAndSortByLoad учтёт это и не отфильтрует.
            let load = null;
            let ramLoad = null;
            let cpuLoad = null;
            if (totalRamGb !== null && totalRamGb > 0) {
                ramLoad = usersOnline / totalRamGb;
            }
            if (cpuCount !== null && cpuCount > 0) {
                cpuLoad = usersOnline / cpuCount;
            }
            if (ramLoad !== null && cpuLoad !== null) {
                const ramNorm = ramLoad / MAX_USERS_PER_GB;
                const cpuNorm = cpuLoad / MAX_USERS_PER_CPU;
                load = Math.round(Math.max(ramNorm, cpuNorm) * 100) / 100;
            } else if (ramLoad !== null) {
                load = Math.round((ramLoad / MAX_USERS_PER_GB) * 100) / 100;
            } else if (cpuLoad !== null) {
                load = Math.round((cpuLoad / MAX_USERS_PER_CPU) * 100) / 100;
            }
            // load === null → метрик нет, не фильтруем

            const stats = {
                usersOnline,
                totalRamGb,
                cpuCount,
                ramLoad: ramLoad === null ? null : Math.round(ramLoad * 100) / 100,
                cpuLoad: cpuLoad === null ? null : Math.round(cpuLoad * 100) / 100,
                load,
                isConnected,
                isDisabled,
            };

            newCache[name] = stats;

            // Кэш по тегам inbound'ов: КЛОНИРУЕМ объект чтобы независимая мутация
            // через один тег не портила другой (раньше был shared reference баг).
            if (node.configProfile?.activeInbounds) {
                for (const inb of node.configProfile.activeInbounds) {
                    if (inb.tag && inb.tag !== name) newCache[inb.tag] = { ...stats };
                }
            }
        }

        nodeStatsCache = newCache;
        _lastRefreshAt = Date.now();

        const sorted = Object.entries(newCache)
            .filter(([_, s]) => s.isConnected && !s.isDisabled)
            .sort((a, b) => (a[1].load ?? 0.5) - (b[1].load ?? 0.5));

        logger.info('node-stats', `🔄 Обновлено ${sorted.length} нод (пороги: ${MAX_USERS_PER_GB} u/GB, ${MAX_USERS_PER_CPU} u/CPU)`);
        for (const [name, s] of sorted.slice(0, 5)) {
            const ramStr = s.totalRamGb !== null ? `${s.totalRamGb.toFixed(1)}G` : '?G';
            const cpuStr = s.cpuCount !== null ? `${s.cpuCount}C` : '?C';
            const loadStr = s.load !== null ? `load=${s.load}` : 'load=?';
            logger.debug('node-stats', `  ${name}: ${s.usersOnline}u RAM=${ramStr}/${cpuStr} ${loadStr}`);
        }
        if (sorted.length > 5) logger.debug('node-stats', `  ... и ещё ${sorted.length - 5}`);
    }, { logger, tag: 'node-stats' });
}

// ─── Получить стату ноды по тегу outbound'а ───

function getNodeStats(outboundTag) {
    if (!outboundTag || typeof outboundTag !== 'string') return null;
    if (nodeStatsCache[outboundTag]) return nodeStatsCache[outboundTag];

    const tagLower = outboundTag.toLowerCase();
    for (const [nodeName, stats] of Object.entries(nodeStatsCache)) {
        if (nodeName.toLowerCase() === tagLower) return stats;
    }

    // Fuzzy: word-boundary > substring
    let bestBoundaryMatch = null, bestBoundaryLen = 0;
    let bestSubstrMatch = null, bestSubstrLen = 0;

    for (const [nodeName, stats] of Object.entries(nodeStatsCache)) {
        const nameL = nodeName.toLowerCase();
        if (nameL.length < 3 || !tagLower.includes(nameL)) continue;

        const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(nameL)}(?:$|[^a-z0-9])`);
        if (re.test(tagLower) && nameL.length > bestBoundaryLen) {
            bestBoundaryMatch = stats;
            bestBoundaryLen = nameL.length;
        } else if (nameL.length > bestSubstrLen) {
            bestSubstrMatch = stats;
            bestSubstrLen = nameL.length;
        }
    }

    return bestBoundaryMatch || bestSubstrMatch;
}

// ─── Фильтрация и сортировка по нагрузке ───

/**
 * Отфильтровать перегруженные/отключённые ноды и отсортировать по load.
 * Ноды с unknown load (null) НЕ отфильтровываются — мы не знаем их состояния,
 * лучше отдать клиенту чем потерять.
 */
function filterAndSortByLoad(outbounds) {
    if (Object.keys(nodeStatsCache).length === 0) return outbounds;

    const withStats = outbounds.map(ob => {
        const stats = getNodeStats(ob.tag);
        return { ob, stats, load: stats?.load ?? 0.5 };
    });

    const filtered = withStats.filter(({ stats }) => {
        if (!stats) return true;
        if (!stats.isConnected || stats.isDisabled) return false;
        // load === null → метрик нет, не фильтруем (см. parseRamGb null fix).
        // Порог настраивается через config.node_load_threshold (default 1.0).
        // Если у сервиса каскадные отказы из-за фантомных юзеров от probe —
        // поднимите NODE_LOAD_THRESHOLD до 2.0-3.0.
        if (stats.load !== null && stats.load > NODE_LOAD_THRESHOLD) return false;
        return true;
    });

    if (filtered.length === 0) {
        // Все отфильтрованы — fallback'имся на connected без load-фильтра.
        const connected = withStats.filter(({ stats }) => !stats || (stats.isConnected && !stats.isDisabled));
        if (connected.length === 0) return outbounds;
        connected.sort((a, b) => a.load - b.load);
        return connected.map(({ ob }) => ob);
    }

    filtered.sort((a, b) => a.load - b.load);
    return filtered.map(({ ob }) => ob);
}

// ─── Инициализация ───

async function init() {
    if (!NODE_STATS_ENABLED || !API_TOKEN) return;
    await fetchNodeStats();
    setInterval(() => fetchNodeStats(), NODE_STATS_INTERVAL).unref();
}

module.exports = { getCache, getLastRefreshAt, getNodeStats, filterAndSortByLoad, fetchNodeStats, init };
