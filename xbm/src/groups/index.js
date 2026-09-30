'use strict';

/**
 * Главный модуль groups/. Держит in-memory GROUPS state, экспортирует matchGroup/isLteOutbound,
 * refreshGroups (auto-groups через Remnawave API). Re-exports из подмодулей countries / clients / tiers.
 */

const { logger } = require('../logger');
const { config, API_TOKEN, REMNAWAVE_URL, LTE_PATTERNS, panelHeaders } = require('../config');
const { fetchUrl, safeAsync } = require('../utils');
const { buildGroupsFromHosts, bestPatternMatch } = require("./countries");
const { detectClientType } = require('./clients');
const { getTier1Tags } = require('./tiers');
const panel = require('../panel-config');  // [BlinVPN] настройки из панели

// ─── Мутабельное состояние ───
let GROUPS = config.groups || {};

function getGroups() { return GROUPS; }
function setGroups(g) { GROUPS = g; }

/**
 * Найти к какой группе относится outbound-тег.
 * Использует best-match по длине паттерна.
 * @param {string} outboundTag
 * @returns {string|null}
 */
function matchGroup(outboundTag) {
    // [BlinVPN] сначала локации из панели (точное название хоста), потом паттерны из config.json
    return panel.groupOf(outboundTag) || bestPatternMatch(outboundTag, GROUPS);
}

/**
 * Проверить является ли outbound LTE-сервером (попадает в резервный пул).
 * @param {string} tag
 * @returns {boolean}
 */
function isLteOutbound(tag) {
    // [BlinVPN] Если настройки из панели есть — резерв только то, что отмечено в панели
    // (точное название хоста). Без них — по-старому, по словам из lte_patterns.
    if (panel.get().present) return panel.isReserve(tag);
    const tagLower = tag.toLowerCase();
    return LTE_PATTERNS.some(p => tagLower.includes(p));
}

// ─── Auto-groups: refresh из Remnawave API ───

async function fetchHostsFromApi() {
    if (!API_TOKEN) return null;
    return safeAsync(async () => {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/hosts/`, panelHeaders());
        if (response.status !== 200) return null;
        const data = JSON.parse(response.body);
        return data.response || (Array.isArray(data) ? data : null);
    }, { logger, tag: 'auto-groups', fallback: null });
}

async function refreshGroups() {
    const hosts = await fetchHostsFromApi();
    if (!hosts) return;
    const newGroups = buildGroupsFromHosts(hosts);
    if (Object.keys(newGroups).length === 0) return;
    GROUPS = { ...newGroups, ...(config.groups || {}) };
    logger.info('auto-groups', `✅ Обновлены: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v}]`).join(' | ')}`);
}

module.exports = {
    // Public API: используется в server.js / generators / tests
    getGroups,
    matchGroup, isLteOutbound,
    detectClientType,
    getTier1Tags,
    refreshGroups,
};
