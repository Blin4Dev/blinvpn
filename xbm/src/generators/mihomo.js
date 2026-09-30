'use strict';

/**
 * Mihomo (Clash Meta) YAML генератор.
 * Конвертирует Xray-outbound'ы в proxies + proxy-groups (url-test или fallback для sticky)
 * + rule-providers + правила.
 */

const { logger } = require('../logger');
const { PROBE_URL, PROBE_INTERVAL, AUTO_GROUP_NAME: CFG_AUTO_GROUP_NAME, MIHOMO_URLTEST_TOLERANCE_MS_CFG } = require('../config');
const panel = require('../panel-config');  // [BlinVPN]
const { xrayToMihomo } = require('../converters');
const { getGeoCdnUrls, iterateProfileRules } = require('./common');
const { isLteOutbound } = require('../groups');

/**
 * Парсит PROBE_INTERVAL ('10m', '30s', '1h') в число секунд.
 * Mihomo url-test ожидает interval как число секунд (не строку).
 */
function probeIntervalSec() {
    const m = String(PROBE_INTERVAL).match(/^(\d+)\s*(s|m|h)?$/i);
    if (!m) return 600;  // fallback 10 min
    const n = parseInt(m[1], 10);
    const unit = (m[2] || 's').toLowerCase();
    return unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
}

/**
 * Построить rule-providers + rules для Mihomo на основе Happ routing профиля.
 */
function buildMihomoRuleProviders(profile) {
    if (!profile) return { providers: {}, rules: [] };
    const { geosite: geositeCdn, geoip: geoipCdn } = getGeoCdnUrls();
    const providers = {};
    const rules = [];
    // Уникальный placeholder для proxy-группы — заменяется на actual auto group
    // имя в generateMihomoYaml через .replace(). Использование уникального
    // символа исключает коллизии с пользовательскими именами групп.
    const proxyGroupName = '__AUTO_GROUP_PLACEHOLDER__';
    const actionMap = { block: 'REJECT', proxy: proxyGroupName, direct: 'DIRECT' };

    for (const rule of iterateProfileRules(profile)) {
        const action = actionMap[rule.step] || 'DIRECT';

        if (rule.kind === 'quic-block') {
            rules.push('AND,((NETWORK,udp),(DST-PORT,443)),REJECT');
        } else if (rule.kind === 'geosite-private') {
            rules.push(`GEOSITE,private,${action}`);
        } else if (rule.kind === 'geoip-private') {
            rules.push(`GEOIP,private,${action},no-resolve`);
        } else if (rule.kind === 'geosite') {
            const key = `geosite-${rule.category}`;
            if (!providers[key]) {
                providers[key] = { type: 'http', behavior: 'domain', format: 'mrs', url: `${geositeCdn}/mihomo/${rule.category}.mrs`, path: `./rules/${key}.mrs`, interval: 86400 };
            }
            rules.push(`RULE-SET,${key},${action}`);
        } else if (rule.kind === 'geoip') {
            const key = `geoip-${rule.category}`;
            if (!providers[key]) {
                providers[key] = { type: 'http', behavior: 'ipcidr', format: 'mrs', url: `${geoipCdn}/mihomo/${rule.category}.mrs`, path: `./rules/${key}.mrs`, interval: 86400 };
            }
            rules.push(`RULE-SET,${key},${action}`);
        } else if (rule.kind === 'catch-all') {
            rules.push(`MATCH,${proxyGroupName}`);
        }
    }

    return { providers, rules, proxyGroupName };
}

/**
 * Сгенерировать Mihomo YAML подписку.
 *
 * @param {Object<string, Array>} grouped — outbounds сгруппированные по имени.
 * @param {string[]} groupOrder — порядок групп для вывода.
 * @param {Array} allOutbounds — все outbound'ы.
 * @param {Object|null} profile — Happ routing profile.
 * @param {Object<string, string>} [stickyTags] — карта groupName → assignedTag.
 *        При наличии sticky-тега в группе — proxy-group получает type='fallback' с этим тегом первым (lazy=true).
 * @returns {string|null}
 */
function generateMihomoYaml(grouped, groupOrder, allOutbounds, profile, stickyTags = {}, autoName = null) {
    // [BlinVPN] имя авто-выбора из панели; исключённые в панели хосты в авто-выбор не входят
    const AUTO_GROUP_NAME = autoName || panel.autoGroupName(CFG_AUTO_GROUP_NAME);
    const { providers, rules, proxyGroupName } = buildMihomoRuleProviders(profile);

    const proxies = [];
    const seenNames = new Set();
    for (const ob of allOutbounds) {
        const p = xrayToMihomo(ob);
        if (p && !seenNames.has(p.name)) { proxies.push(p); seenNames.add(p.name); }
    }
    if (proxies.length === 0) return null;

    const allNames = proxies.map(p => p.name);
    const autoNamesAll = allNames.filter(n => !panel.isAutoExcluded(n));
    const autoNames = autoNamesAll.length > 0 ? autoNamesAll : allNames;
    const proxyGroups = [];
    const usedGroupNames = new Set(seenNames);

    function safeGroupName(name) {
        let candidate = usedGroupNames.has(name) ? `${name} ⚡` : name;
        let i = 2;
        while (usedGroupNames.has(candidate)) {
            candidate = `${name} ⚡${i++}`;
        }
        usedGroupNames.add(candidate);
        return candidate;
    }

    const autoTag = safeGroupName(AUTO_GROUP_NAME);
    const autoStickyTag = stickyTags[AUTO_GROUP_NAME];
    const useAutoSticky = autoStickyTag && autoNames.includes(autoStickyTag);
    if (useAutoSticky) {
        // Sticky-режим для AUTO: type=fallback с lazy=true — клиент держится sticky-сервера
        // пока он отвечает; при падении автоматом следующий из списка.
        const reordered = [autoStickyTag, ...autoNames.filter(n => n !== autoStickyTag)];
        proxyGroups.push({
            name: autoTag, type: 'fallback', proxies: reordered,
            url: PROBE_URL, interval: probeIntervalSec(), lazy: true,
        });
        logger.info('sticky', `[mihomo] AUTO → ${autoStickyTag} (type=fallback, lazy)`);
    } else {
        // Резервные сервера (lte_patterns, напр. «Белые списки»): сначала основные, резерв — только если
        // ни один основной не отвечает. Две скрытые url-test группы + fallback между ними.
        const mainNames = autoNames.filter(n => !isLteOutbound(n));
        const reserveNames = autoNames.filter(n => isLteOutbound(n));
        if (mainNames.length > 0 && reserveNames.length > 0) {
            const mainTag = safeGroupName(`${AUTO_GROUP_NAME} · основные`);
            const reserveTag = safeGroupName(`${AUTO_GROUP_NAME} · резерв`);
            proxyGroups.push({
                name: autoTag, type: 'fallback', proxies: [mainTag, reserveTag],
                url: PROBE_URL, interval: probeIntervalSec(),
            });
            proxyGroups.push({
                name: mainTag, type: 'url-test', proxies: mainNames, hidden: true,
                url: PROBE_URL, interval: probeIntervalSec(), tolerance: MIHOMO_URLTEST_TOLERANCE_MS_CFG,
            });
            proxyGroups.push({
                name: reserveTag, type: 'url-test', proxies: reserveNames, hidden: true,
                url: PROBE_URL, interval: probeIntervalSec(), tolerance: MIHOMO_URLTEST_TOLERANCE_MS_CFG,
            });
        } else {
            proxyGroups.push({
                name: autoTag, type: 'url-test', proxies: autoNames,
                url: PROBE_URL, interval: probeIntervalSec(), tolerance: MIHOMO_URLTEST_TOLERANCE_MS_CFG,
            });
        }
    }

    // Одна группа выбора (как в родной подписке Remnawave): авто-выбор + локации.
    // Локация из одного сервера — сам сервер, без отдельной группы (без дублей).
    const selectorEntries = [autoTag];
    for (const gn of groupOrder) {
        const obs = grouped[gn];
        if (!obs || obs.length === 0) continue;
        const names = obs.map(o => o.tag).filter(t => allNames.includes(t));
        if (names.length === 0) continue;
        // [BlinVPN] В режиме панели пользователи видят название из панели, а не имя хоста Remnawave
        if (names.length === 1 && !panel.get().onlyGroups) {
            if (!selectorEntries.includes(names[0])) selectorEntries.push(names[0]);
            continue;
        }
        const groupName = safeGroupName(gn);
        const stickyTag = stickyTags[gn];
        const useSticky = stickyTag && names.includes(stickyTag);
        if (useSticky) {
            const reordered = [stickyTag, ...names.filter(n => n !== stickyTag)];
            proxyGroups.push({
                name: groupName, type: 'fallback', proxies: reordered,
                url: PROBE_URL, interval: probeIntervalSec(), lazy: true,
            });
        } else {
            proxyGroups.push({
                name: groupName, type: 'url-test', proxies: names,
                url: PROBE_URL, interval: probeIntervalSec(), tolerance: MIHOMO_URLTEST_TOLERANCE_MS_CFG,
            });
        }
        selectorEntries.push(groupName);
    }
    const selectorTag = safeGroupName(require('../config').config.mihomo_selector_name || '🌐 Выбор сервера');
    proxyGroups.unshift({ name: selectorTag, type: 'select', proxies: selectorEntries });

    const finalRules = rules.length > 0
        ? rules.map(r => r.replaceAll(proxyGroupName, selectorTag))
        : [];
    if (finalRules.length > 0 && finalRules[finalRules.length - 1].startsWith('MATCH,')) {
        finalRules[finalRules.length - 1] = `MATCH,${selectorTag}`;
    } else {
        finalRules.push(`MATCH,${selectorTag}`);
    }

    const remoteDns = profile?.RemoteDNSDomain || 'https://8.8.8.8/dns-query';
    const domesticDns = profile?.DomesticDNSDomain || 'https://77.88.8.8/dns-query';

    let y = '';
    y += 'mixed-port: 7890\n';
    y += 'allow-lan: false\n';
    y += 'mode: rule\n';
    y += 'log-level: warning\n';
    y += 'ipv6: false\n';
    y += "find-process-mode: 'off'\n";
    y += 'unified-delay: true\n\n';

    y += 'dns:\n  enable: true\n  enhanced-mode: fake-ip\n';
    y += '  fake-ip-range: 198.18.0.1/16\n';
    y += '  fake-ip-filter:\n    - "+.*"\n';
    y += `  nameserver:\n    - ${remoteDns}\n`;
    y += `  default-nameserver:\n    - ${domesticDns.replace('https://', '').replace('/dns-query', '')}\n`;
    // Адреса самих серверов — обычным DNS (DoH Google в РФ часто недоступен)
    y += '  proxy-server-nameserver:\n    - 77.88.8.8\n    - 1.1.1.1\n\n';

    y += 'proxies:\n';
    for (const p of proxies) y += `  - ${JSON.stringify(p)}\n`;
    y += '\n';

    y += 'proxy-groups:\n';
    for (const g of proxyGroups) y += `  - ${JSON.stringify(g)}\n`;
    y += '\n';

    if (Object.keys(providers).length > 0) {
        y += 'rule-providers:\n';
        for (const [key, val] of Object.entries(providers)) {
            y += `  ${key}:\n`;
            for (const [k, v] of Object.entries(val)) y += `    ${k}: ${typeof v === 'string' ? `"${v}"` : v}\n`;
        }
        y += '\n';
    }

    y += 'rules:\n';
    for (const r of finalRules) y += `  - ${r}\n`;

    return y;
}

module.exports = { generateMihomoYaml, buildMihomoRuleProviders };
