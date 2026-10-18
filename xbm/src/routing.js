'use strict';

const { logger } = require('./logger');
const { config, HAPP_ROUTING_URL, HAPP_ROUTING_UPDATE_INTERVAL, UDP_BLOCK } = require('./config');
const { fetchUrl } = require('./utils');

// ─── Мутабельное состояние ───
let HAPP_ROUTING_PROFILE = null;

function getRoutingProfile() { return HAPP_ROUTING_PROFILE; }

// ─── Overrides из config ───

function applyProfileOverrides(profile) {
    if (config.routing_name) profile.Name = config.routing_name;
    // geosite_cdn/geoip_cdn — нормализуем: если пользователь указал полный URL с /geosite.dat, стрипаем
    if (config.geosite_cdn) {
        const base = config.geosite_cdn.replace(/\/geosite\.dat$/i, '');
        profile.Geositeurl = base + '/geosite.dat';
    }
    if (config.geoip_cdn) {
        const base = config.geoip_cdn.replace(/\/geoip\.dat$/i, '');
        profile.Geoipurl = base + '/geoip.dat';
    }
}

function logRoutingProfile(profile, source) {
    logger.info('happ-routing', `✅ Профиль: "${profile.Name}" RouteOrder=${profile.RouteOrder} (источник: ${source})`);
    logger.debug('happ-routing', `  Block:  ${(profile.BlockSites || []).concat(profile.BlockIp || []).join(', ') || '—'}`);
    logger.debug('happ-routing', `  Proxy:  ${(profile.ProxySites || []).concat(profile.ProxyIp || []).join(', ') || '—'}`);
    logger.debug('happ-routing', `  Direct: ${(profile.DirectSites || []).concat(profile.DirectIP || profile.DirectIp || []).join(', ') || '—'}`);
    logger.debug('happ-routing', `  GeoSite: ${profile.Geositeurl || '—'}`);
    logger.debug('happ-routing', `  GeoIP:   ${profile.Geoipurl || '—'}`);
}

// ─── Парсинг base64 профиля ───

function parseHappRoutingProfile(cfg) {
    const raw = cfg.happ_routing || '';
    if (!raw) return null;
    try {
        const b64 = raw.startsWith('happ://routing/onadd/')
            ? raw.slice('happ://routing/onadd/'.length)
            : raw.startsWith('happ://routing/add/')
                ? raw.slice('happ://routing/add/'.length)
                : raw;
        const json = Buffer.from(b64, 'base64').toString('utf8');
        const profile = JSON.parse(json);
        applyProfileOverrides(profile);
        logRoutingProfile(profile, 'config');
        return profile;
    } catch (e) {
        logger.error('happ-routing', '❌ Ошибка парсинга профиля из config:', e.message);
        return null;
    }
}

const _base64Profile = parseHappRoutingProfile(config);
HAPP_ROUTING_PROFILE = _base64Profile;

// ─── Загрузка с URL ───

let _fetchInFlight = null;

async function fetchRoutingProfile() {
    if (!HAPP_ROUTING_URL) return;
    // Race guard: если fetch уже идёт — переиспользуем тот же promise.
    // Без этого два параллельных fetch'а (init + первый interval, или два interval'а
    // близко друг к другу) могут перетереть _base64Profile.Geositeurl/Geoipurl.
    if (_fetchInFlight) return _fetchInFlight;

    _fetchInFlight = (async () => {
        try {
            const response = await fetchUrl(HAPP_ROUTING_URL);
            if (response.status !== 200) {
                logger.warn('happ-routing', `⚠️  URL вернул ${response.status}: ${HAPP_ROUTING_URL}`);
                return;
            }
            const urlProfile = JSON.parse(response.body);
            if (!urlProfile.Name || !urlProfile.RouteOrder) {
                logger.warn('happ-routing', '⚠️  Некорректный формат профиля (отсутствует Name или RouteOrder)');
                return;
            }

            if (_base64Profile) {
                _base64Profile.Geositeurl = urlProfile.Geositeurl;
                _base64Profile.Geoipurl = urlProfile.Geoipurl;
                if (urlProfile.LastUpdated) _base64Profile.LastUpdated = urlProfile.LastUpdated;
                applyProfileOverrides(_base64Profile);
                HAPP_ROUTING_PROFILE = _base64Profile;
                logger.info('happ-routing', '🔄 Геобазы обновлены из URL (правила из config base64)');
                logRoutingProfile(_base64Profile, 'base64 + url геобазы');
            } else {
                applyProfileOverrides(urlProfile);
                HAPP_ROUTING_PROFILE = urlProfile;
                logRoutingProfile(urlProfile, 'url');
            }
        } catch (err) {
            logger.error('happ-routing', `❌ Ошибка загрузки профиля с URL: ${err.message}`);
        } finally {
            _fetchInFlight = null;
        }
    })();

    return _fetchInFlight;
}

/**
 * Конвертировать Happ Routing профиль → массив Xray routing rules.
 */
function buildRoutingRulesFromProfile(profile, balancerTag) {
    if (!profile) return null;

    const rules = [];
    const order = (profile.RouteOrder || 'block-proxy-direct').split('-');

    const blockSites = profile.BlockSites || [];
    const blockIp = profile.BlockIp || [];
    const proxySites = profile.ProxySites || [];
    const proxyIp = profile.ProxyIp || [];
    const directSites = profile.DirectSites || [];
    const directIp = profile.DirectIP || profile.DirectIp || [];

    // UDP 443 блок (QUIC) — всегда первым, если включено
    if (UDP_BLOCK) rules.push({ type: 'field', network: 'udp', port: '443', outboundTag: 'block' });

    for (const step of order) {
        if (step === 'block') {
            if (blockSites.length > 0) rules.push({ type: 'field', domain: blockSites, outboundTag: 'block' });
            if (blockIp.length > 0) rules.push({ type: 'field', ip: blockIp, outboundTag: 'block' });
        } else if (step === 'proxy') {
            if (proxySites.length > 0) rules.push({ type: 'field', domain: proxySites, balancerTag });
            if (proxyIp.length > 0) rules.push({ type: 'field', ip: proxyIp, balancerTag });
        } else if (step === 'direct') {
            if (directSites.length > 0) rules.push({ type: 'field', domain: directSites, outboundTag: 'direct' });
            if (directIp.length > 0) rules.push({ type: 'field', ip: directIp, outboundTag: 'direct' });
        }
    }

    // Catch-all → балансировщик
    rules.push({ type: 'field', network: 'tcp,udp', balancerTag });

    return rules;
}

// ─── Инициализация и таймер ───

async function init() {
    if (HAPP_ROUTING_URL) {
        await fetchRoutingProfile();
        setInterval(() => fetchRoutingProfile(), HAPP_ROUTING_UPDATE_INTERVAL).unref();
    }
}

module.exports = {
    getRoutingProfile, fetchRoutingProfile,
    buildRoutingRulesFromProfile,
    init,
};
