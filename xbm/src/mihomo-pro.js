'use strict';

/**
 * Mihomo PRO template — Legiz-style YAML с rule-sets и semantic groups
 * (Недоступные сайты / YouTube / Discord / Telegram / RU / Остальные).
 *
 * Активируется через `mihomo_pro_tokens` whitelist в config.json или ?profile=pro
 * query-параметр. Иначе server.js отдаёт обычный generateMihomoYaml.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { xrayToMihomo } = require('./converters');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'mihomo-pro.yaml');

let templateCache = null;
let templateMtime = 0;

/** Lazy-load template из диска с инвалидацией по mtime. */
function loadTemplate() {
    try {
        const stat = fs.statSync(TEMPLATE_PATH);
        if (templateCache && stat.mtimeMs === templateMtime) return templateCache;
        templateCache = fs.readFileSync(TEMPLATE_PATH, 'utf8');
        templateMtime = stat.mtimeMs;
        return templateCache;
    } catch (err) {
        logger.error('mihomo-pro', `Не могу прочитать шаблон ${TEMPLATE_PATH}: ${err.message}`);
        return null;
    }
}

/** Квотирование имени для встраивания в YAML (JSON-encoded string = валидный flow scalar). */
function quoteYamlName(s) {
    return JSON.stringify(s);
}

/** Fisher-Yates shuffle, возвращает копию. */
function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Сгенерировать Mihomo PRO YAML на основе template'а.
 * @param {Array<object>} allOutbounds — все Xray outbound'ы.
 * @returns {string|null} YAML или null если template не загрузился / нет outbound'ов.
 */
function generateMihomoYamlPro(allOutbounds) {
    const template = loadTemplate();
    if (!template) return null;

    const proxies = [];
    const seen = new Set();
    for (const ob of allOutbounds) {
        const p = xrayToMihomo(ob);
        if (p && !seen.has(p.name)) { proxies.push(p); seen.add(p.name); }
    }
    if (proxies.length === 0) return null;

    const realProxiesYaml = proxies.map(p => `  - ${JSON.stringify(p)}`).join('\n');
    const allNames = proxies.map(p => p.name);
    const namesYaml = allNames.map(n => `      - ${quoteYamlName(n)}`).join('\n');
    const shuffledYaml = shuffleArray(allNames).map(n => `      - ${quoteYamlName(n)}`).join('\n');

    return template
        .replaceAll('{{REAL_PROXIES}}', realProxiesYaml)
        .replaceAll('{{ALL_PROXY_NAMES_SHUFFLED}}', shuffledYaml)
        .replaceAll('{{ALL_PROXY_NAMES}}', namesYaml);
}

module.exports = { generateMihomoYamlPro };
