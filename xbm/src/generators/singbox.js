'use strict';

/**
 * SingBox JSON генератор.
 * Конвертирует Xray-outbound'ы в SingBox-формат с urltest groups (или selector для sticky).
 */

const { logger } = require('../logger');
const { PROBE_URL, PROBE_INTERVAL, AUTO_GROUP_NAME: CFG_AUTO_GROUP_NAME, SINGBOX_URLTEST_TOLERANCE_MS_CFG } = require('../config');
const panel = require('../panel-config');  // [BlinVPN]
const { xrayToSingbox } = require('../converters');
const { getGeoCdnUrls, iterateProfileRules } = require('./common');
const { isLteOutbound } = require('../groups');

/** Построить rule-sets + правила для SingBox на основе Happ routing профиля. */
function buildSingboxRuleSets(profile) {
    if (!profile) return { ruleSets: [], rules: [] };
    const { geosite: geositeCdn, geoip: geoipCdn } = getGeoCdnUrls();
    const ruleSets = [];
    const rules = [];
    const seen = new Set();

    function outboundFor(step) {
        return step === 'block' ? 'block' : step === 'direct' ? 'direct' : 'proxy-out';
    }

    for (const rule of iterateProfileRules(profile)) {
        const outbound = outboundFor(rule.step);

        if (rule.kind === 'quic-block') {
            rules.push({ protocol: 'quic', outbound: 'block' });
        } else if (rule.kind === 'geosite-private' || rule.kind === 'geoip-private') {
            rules.push({ ip_is_private: true, outbound: rule.step === 'block' ? 'block' : 'direct' });
        } else if (rule.kind === 'geosite') {
            const tag = `geosite-${rule.category}`;
            if (!seen.has(tag)) {
                seen.add(tag);
                ruleSets.push({ type: 'remote', tag, format: 'binary', url: `${geositeCdn}/sing-box/${rule.category}.srs`, download_detour: 'proxy-out' });
            }
            rules.push({ rule_set: [tag], outbound });
        } else if (rule.kind === 'geoip') {
            const tag = `geoip-${rule.category}`;
            if (!seen.has(tag)) {
                seen.add(tag);
                ruleSets.push({ type: 'remote', tag, format: 'binary', url: `${geoipCdn}/sing-box/${rule.category}.srs`, download_detour: 'proxy-out' });
            }
            rules.push({ rule_set: [tag], outbound });
        }
    }

    return { ruleSets, rules };
}

/**
 * Сгенерировать SingBox JSON подписку.
 *
 * @param {Object<string, Array>} grouped
 * @param {string[]} groupOrder
 * @param {Array} allOutbounds
 * @param {Object|null} profile
 * @param {Object<string, string>} [stickyTags] — карта groupName → tag.
 *        При наличии — group получает type='selector' с default=stickyTag (вместо urltest).
 * @returns {object|null}
 */
function generateSingboxConfig(grouped, groupOrder, allOutbounds, profile, stickyTags = {}, autoName = null) {
    // [BlinVPN] имя авто-выбора из панели
    const AUTO_GROUP_NAME = autoName || panel.autoGroupName(CFG_AUTO_GROUP_NAME);
    const { ruleSets, rules: routeRules } = buildSingboxRuleSets(profile);

    const outbounds = [];
    const allTags = new Set();
    for (const ob of allOutbounds) {
        const o = xrayToSingbox(ob);
        if (o && !allTags.has(o.tag)) { outbounds.push(o); allTags.add(o.tag); }
    }
    if (outbounds.length === 0) return null;

    const usedTags = new Set(allTags);
    function uniqueGroupTag(name) {
        let candidate = usedTags.has(name) ? `${name} ⚡` : name;
        let i = 2;
        while (usedTags.has(candidate)) {
            candidate = `${name} ⚡${i++}`;
        }
        usedTags.add(candidate);
        return candidate;
    }

    const autoTag = uniqueGroupTag(AUTO_GROUP_NAME);
    const selectorOutbounds = [autoTag];
    const urlTestGroups = [];

    const autoStickyTag = stickyTags[AUTO_GROUP_NAME];
    const useAutoSticky = autoStickyTag && allTags.has(autoStickyTag);
    if (useAutoSticky) {
        // Sticky-режим для AUTO: selector с default=stickyTag (юзер на своём сервере по умолчанию).
        const allTagsArr = [...allTags];
        const reordered = [autoStickyTag, ...allTagsArr.filter(t => t !== autoStickyTag)];
        urlTestGroups.push({
            type: 'selector', tag: autoTag, outbounds: reordered, default: autoStickyTag,
        });
        logger.info('sticky', `[singbox] AUTO → ${autoStickyTag} (type=selector, default)`);
    } else {
        // В Sing-box нет fallback-группы: резервные (lte_patterns) в авто-выбор не кладём,
        // они доступны отдельными локациями. Если основных нет — берём все.
        const autoPool = [...allTags].filter(t => !panel.isAutoExcluded(t));
        const pool = autoPool.length > 0 ? autoPool : [...allTags];
        const mainTags = pool.filter(t => !isLteOutbound(t));
        urlTestGroups.push({
            type: 'urltest', tag: autoTag, outbounds: mainTags.length > 0 ? mainTags : pool,
            url: PROBE_URL, interval: PROBE_INTERVAL, tolerance: SINGBOX_URLTEST_TOLERANCE_MS_CFG,
        });
    }

    for (const gn of groupOrder) {
        const obs = grouped[gn];
        if (!obs || obs.length === 0) continue;
        const names = obs.map(o => o.tag).filter(t => allTags.has(t));
        if (names.length === 0) continue;
        // Локация из одного сервера — сам сервер, без отдельной группы (без дублей)
        // [BlinVPN] В режиме панели пользователи видят название из панели, а не имя хоста Remnawave
        if (names.length === 1 && !panel.get().onlyGroups) { if (!selectorOutbounds.includes(names[0])) selectorOutbounds.push(names[0]); continue; }
        const tag = uniqueGroupTag(gn);

        const stickyTag = stickyTags[gn];
        const useSticky = stickyTag && names.includes(stickyTag);
        if (useSticky) {
            const reordered = [stickyTag, ...names.filter(n => n !== stickyTag)];
            urlTestGroups.push({
                type: 'selector', tag, outbounds: reordered, default: stickyTag,
            });
            logger.info('sticky', `[singbox] Группа "${gn}" → ${stickyTag} (type=selector, default)`);
        } else {
            urlTestGroups.push({
                type: 'urltest', tag, outbounds: names,
                url: PROBE_URL, interval: PROBE_INTERVAL, tolerance: SINGBOX_URLTEST_TOLERANCE_MS_CFG,
            });
        }
        selectorOutbounds.push(tag);
    }

    const selector = {
        type: 'selector', tag: 'proxy-out',
        outbounds: [...selectorOutbounds, 'direct'], default: autoTag,
    };

    return {
        log: { level: 'warn' },
        dns: {
            servers: [
                { tag: 'remote-dns', address: profile?.RemoteDNSDomain || 'https://8.8.8.8/dns-query', detour: 'proxy-out' },
                { tag: 'local-dns', address: profile?.DomesticDNSDomain || 'https://77.88.8.8/dns-query', detour: 'direct' },
            ],
            rules: [
                { outbound: 'direct', server: 'local-dns' },
                { outbound: 'any', server: 'remote-dns' },
            ],
            strategy: 'prefer_ipv4',
        },
        inbounds: [
            { type: 'tun', tag: 'tun-in', auto_route: true, strict_route: true, stack: 'system', sniff: true, sniff_override_destination: false },
        ],
        outbounds: [
            selector, ...urlTestGroups, ...outbounds,
            { type: 'direct', tag: 'direct' },
            { type: 'block', tag: 'block' },
            { type: 'dns', tag: 'dns-out' },
        ],
        route: {
            auto_detect_interface: true,
            rule_set: ruleSets,
            rules: [{ protocol: 'dns', outbound: 'dns-out' }, ...routeRules],
            final: 'proxy-out',
        },
    };
}

module.exports = { generateSingboxConfig, buildSingboxRuleSets };
