'use strict';

/**
 * Tier-режим: разделение outbound'ов группы на tier1/tier2 для каскадного балансера.
 */

/**
 * Натуральная сортировка: вытаскивает первое число из тега.
 * "ЕВРОПА 2" < "ЕВРОПА 10" (по числу), а не алфавитно.
 * @param {string} t
 * @returns {number}
 */
function naturalSortKey(t) {
    const m = String(t).match(/\d+/);
    return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Извлечь tier1 теги из переданного списка по конфигу группы.
 * Поддерживает два режима (взаимоисключающих, patterns имеет приоритет):
 *   1. `tier1_patterns: string[]` — substring whitelist (case-insensitive).
 *   2. `tier1_count: number` — первые N тегов по натуральной сортировке номеров.
 *
 * @param {string[]} tags
 * @param {{tier1_patterns?: string[], tier1_count?: number}|null|undefined} tierCfg
 * @returns {string[]|null}
 */
function getTier1Tags(tags, tierCfg) {
    if (!tierCfg) return null;
    if (Array.isArray(tierCfg.tier1_patterns) && tierCfg.tier1_patterns.length > 0) {
        const pats = tierCfg.tier1_patterns.map(p => String(p).toLowerCase());
        return tags.filter(t => pats.some(p => t.toLowerCase().includes(p)));
    }
    if (Number.isInteger(tierCfg.tier1_count) && tierCfg.tier1_count > 0) {
        const sorted = tags.slice().sort((a, b) => {
            const na = naturalSortKey(a), nb = naturalSortKey(b);
            if (na !== nb) return na - nb;
            return a < b ? -1 : a > b ? 1 : 0;
        });
        return sorted.slice(0, tierCfg.tier1_count);
    }
    return null;
}

module.exports = { naturalSortKey, getTier1Tags };
