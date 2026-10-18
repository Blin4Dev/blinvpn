'use strict';

/**
 * Общие helpers для генераторов подписок.
 * Используются всеми форматами: Xray-JSON, Mihomo YAML, SingBox JSON.
 */

const { config } = require('../config');
const {
    HAPP_DESCRIPTION_MAX_LENGTH,
    DEFAULT_GEOSITE_CDN, DEFAULT_GEOIP_CDN,
} = require('../constants');
const { getRoutingProfile } = require('../routing');
const panel = require('../panel-config');  // [BlinVPN] описания локаций из панели

const GROUP_DESCRIPTIONS = config.group_descriptions || {};
const MANAGED_FIELDS = new Set(['remarks', 'meta', 'dns', 'inbounds', 'outbounds', 'routing', 'burstObservatory', 'log']);

/**
 * Сгенерировать meta.serverDescription для Happ. Лимит 30 символов (см. constants).
 * Подставляет {count} = число outbound'ов в группе.
 */
function renderGroupDescription(groupName, outbounds) {
    const template = GROUP_DESCRIPTIONS[groupName] || panel.get().descriptions[groupName];
    if (typeof template !== 'string' || !template) return null;
    const rendered = template.replace(/\{count\}/g, String(outbounds.length));
    return rendered.length > HAPP_DESCRIPTION_MAX_LENGTH
        ? rendered.slice(0, HAPP_DESCRIPTION_MAX_LENGTH)
        : rendered;
}

/** Извлечь base-URL из geosite/geoip .dat URL (например `.../geosite.dat` → `...`). */
function deriveCdnBase(datUrl) {
    if (!datUrl) return null;
    try { return datUrl.replace(/@[^/]+/, '').replace(/\/[^/]+\.dat$/, ''); }
    catch { return null; }
}

/** Подобрать актуальные CDN-URL'ы для geosite/geoip. */
function getGeoCdnUrls() {
    const profile = getRoutingProfile();
    const geositeCfg = config.geosite_cdn ? config.geosite_cdn.replace(/\/geosite\.dat$/i, '') : '';
    const geoipCfg = config.geoip_cdn ? config.geoip_cdn.replace(/\/geoip\.dat$/i, '') : '';
    return {
        geosite: geositeCfg || deriveCdnBase(profile?.Geositeurl) || DEFAULT_GEOSITE_CDN,
        geoip:   geoipCfg   || deriveCdnBase(profile?.Geoipurl)   || DEFAULT_GEOIP_CDN,
    };
}

/**
 * Определить является ли upstream-ответ "фейковым конфигом" (HWID-лимит / истёкшая подписка).
 * Remnawave в таких случаях возвращает outbound с address=0.0.0.0 port=1.
 */
function isFakeConfig(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    let proxyCount = 0, fakeCount = 0;
    for (const cfg of configArray) {
        for (const ob of (cfg.outbounds || [])) {
            if (systemProtocols.has(ob.protocol) || !ob.tag) continue;
            proxyCount++;
            const addr = ob.settings?.vnext?.[0]?.address || ob.settings?.servers?.[0]?.address || '';
            const port = ob.settings?.vnext?.[0]?.port || ob.settings?.servers?.[0]?.port || null;
            if (addr === '0.0.0.0' && port === 1) fakeCount++;
        }
    }
    return proxyCount > 0 && proxyCount === fakeCount;
}

/**
 * Собрать все proxy-outbound'ы из массива конфигов upstream'а.
 * Системные (freedom/blackhole/dns) — исключены. Дубль-теги получают `-${index}` суффикс.
 */
function collectAllProxyOutbounds(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    const all = [];
    const seenTags = new Set();

    for (let i = 0; i < configArray.length; i++) {
        const cfg = configArray[i];
        const remarks = cfg.remarks || `connection-${i}`;
        for (const ob of (cfg.outbounds || [])) {
            if (systemProtocols.has(ob.protocol) || !ob.tag) continue;
            const cloned = structuredClone(ob);
            let tag = cloned.tag;
            if (tag === 'proxy' && remarks) tag = remarks;
            if (seenTags.has(tag)) tag = `${tag}-${i}`;
            cloned.tag = tag;
            // Конфиг хоста из Remnawave (его Xray JSON) — для шаблона своей локации
            Object.defineProperty(cloned, '_sourceCfg', { value: cfg, enumerable: false });
            // meta ноды из Remnawave (serverDescription и т.п.) — чтобы у каждой
            // локации было своё описание, а не описание первой ноды.
            if (cfg.meta) cloned._sourceMeta = structuredClone(cfg.meta);
            seenTags.add(tag);
            all.push(cloned);
        }
    }
    return all;
}

/**
 * Итератор правил из Happ routing профиля. Yields:
 *   { step: 'block'|'proxy'|'direct', kind: 'quic-block'|'geosite-private'|'geoip-private'|'geosite'|'geoip'|'catch-all', category? }
 */
function* iterateProfileRules(profile) {
    const order = (profile.RouteOrder || 'block-proxy-direct').split('-');
    yield { step: 'block', kind: 'quic-block' };

    for (const step of order) {
        const sites = step === 'block' ? (profile.BlockSites || [])
            : step === 'proxy' ? (profile.ProxySites || [])
            : (profile.DirectSites || []);
        const ips = step === 'block' ? (profile.BlockIp || [])
            : step === 'proxy' ? (profile.ProxyIp || [])
            : (profile.DirectIP || profile.DirectIp || []);

        for (const s of sites) {
            if (!s.startsWith('geosite:')) continue;
            if (s === 'geosite:private') { yield { step, kind: 'geosite-private' }; continue; }
            yield { step, kind: 'geosite', category: s.replace(/^geosite:/, '') };
        }
        for (const ip of ips) {
            if (!ip.startsWith('geoip:')) continue;
            if (ip === 'geoip:private') { yield { step, kind: 'geoip-private' }; continue; }
            yield { step, kind: 'geoip', category: ip.replace(/^geoip:/, '') };
        }
    }
    yield { step: 'proxy', kind: 'catch-all' };
}

/**
 * Подготовить общий template для buildGroupConfig: inherited fields, dns, inbounds.
 * Вызывается один раз на запрос, переиспользуется для всех групп.
 */
function prepareBaseTemplate(baseConfig) {
    const inherited = {};
    for (const [key, val] of Object.entries(baseConfig)) {
        if (!MANAGED_FIELDS.has(key)) inherited[key] = structuredClone(val);
    }
    const dns = baseConfig.dns ? structuredClone(baseConfig.dns) : {
        servers: ['1.1.1.1', '1.0.0.1'],
        queryStrategy: 'UseIP',
    };
    const inbounds = baseConfig.inbounds ? structuredClone(baseConfig.inbounds) : [
        {
            tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks',
            settings: { udp: true, auth: 'noauth' },
            sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
        },
        {
            tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http',
            settings: { allowTransparent: false },
            sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
        },
    ];
    return { inherited, dns, inbounds };
}

module.exports = {
    GROUP_DESCRIPTIONS, MANAGED_FIELDS,
    renderGroupDescription, deriveCdnBase, getGeoCdnUrls,
    isFakeConfig, collectAllProxyOutbounds,
    iterateProfileRules, prepareBaseTemplate,
};
