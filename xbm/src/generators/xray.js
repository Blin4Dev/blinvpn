'use strict';

/**
 * Xray-JSON генератор: buildGroupConfig — основная функция для подписок Happ/Xray-клиентов.
 *
 * Каскад балансеров через loopback outbounds (XTLS discussion #3068).
 * В Xray-core fallbackTag балансера принимает только OUTBOUND tag, не balancer tag —
 * dispatcher ищет handler по тегу и при balancer-tag не находит ничего.
 * Канонический паттерн чейна: balancer.fallbackTag → loopback outbound → re-injects
 * с inboundTag → routing rule матчит inboundTag → следующий balancer.
 *
 * Режимы (по приоритету):
 *   1. Tier-mode (если задан group_tiers[groupName] с tier1):
 *      sticky? → tier1 → tier2 → all-balancer (без baseline)
 *   2. Main + LTE (если есть LTE серверы — inline или через fastest_fallback):
 *      sticky? → main → LTE → all-balancer (last resort)
 *   3. Один балансер (без LTE и tiers): просто один balancer над всеми серверами.
 */

const { logger } = require('../logger');
const {
    config, STRATEGY, PROBE_URL, PROBE_INTERVAL, PROBE_SAMPLING, PROBE_TIMEOUT,
    BAL_TOLERANCE, BAL_TOLERANCE_FB, LOAD_EXPECTED,
    STICKY_SESSION, STICKY_THRESHOLD_MS, STICKY_EXCLUDE_GROUPS,
    UDP_BLOCK,
    TIER1_BASELINE_MS, TIER2_BASELINE_MS,
    MAIN_WITH_LTE_BASELINE_MS, SINGLE_BASELINE_MS, LTE_BASELINE_MS,
} = require('../config');
const { sanitizeTag } = require('../utils');
const { isLteOutbound, getTier1Tags } = require('../groups');
const panel = require('../panel-config');  // [BlinVPN] шаблоны Xray JSON из панели
const { getRoutingProfile, buildRoutingRulesFromProfile } = require('../routing');
const { renderGroupDescription, prepareBaseTemplate } = require('./common');

let _routingFallbackWarned = false;
function resetRoutingWarning() { _routingFallbackWarned = false; }

/** Кламп expected по размеру селектора чтобы избежать undefined behavior. */
function clampExpected(selectorLen) {
    if (selectorLen <= 0) return 1;
    return Math.min(LOAD_EXPECTED, selectorLen);
}

/**
 * Создать loopback outbound + routing rule для chain между балансерами.
 * Возвращает { outbound, rule, loopbackTag }.
 *
 * Для использования: balancer1.fallbackTag = loopbackTag;
 * При срабатывании fallback Xray направит трафик в loopback outbound,
 * loopback вернёт его в роутинг с inboundTag = loopbackInboundTag,
 * routing rule (по inboundTag) направит в balancer2.
 */
function makeLoopback(prefix, kind, targetBalancerTag) {
    const tag = `${prefix}-${kind}-loopback`;
    const inboundTag = `${prefix}-${kind}-lb-in`;
    return {
        outbound: { tag, protocol: 'loopback', settings: { inboundTag } },
        rule: { type: 'field', inboundTag: [inboundTag], balancerTag: targetBalancerTag },
        loopbackTag: tag,
    };
}

/**
 * Построить Xray-JSON config для одной группы.
 *
 * @param {object} baseConfig — оригинальный config от Remnawave (для inheritance не-managed полей).
 * @param {string} groupName — имя группы (напр. "🇫🇮 Finland").
 * @param {Array<object>} outbounds — outbound'ы группы.
 * @param {Array<object>|null|undefined} fallbackOutbounds — внешний LTE-fallback (для AUTO группы).
 * @param {object} [_tpl] — pre-built template из prepareBaseTemplate.
 * @param {object|null} [routingProfile] — Happ routing profile.
 * @param {string|null} [stickyTag] — назначенный sticky-сервер.
 * @returns {object|null} Xray-JSON config или null если outbounds пуст.
 */
function buildGroupConfig(baseConfig, groupName, outbounds, fallbackOutbounds, _tpl, routingProfile, stickyTag, noMeta = false) {
    // Шаблон Xray JSON (правила, DNS, инбаунды) — от первого хоста этой группы,
    // а не от первого хоста всей подписки.
    {
        const hostCfg = (outbounds && outbounds[0] && outbounds[0]._sourceCfg)
            || (fallbackOutbounds && fallbackOutbounds[0] && fallbackOutbounds[0]._sourceCfg);
        if (hostCfg && hostCfg !== baseConfig) {
            baseConfig = hostCfg;
            _tpl = prepareBaseTemplate(hostCfg);
        }
        // [BlinVPN] В панели для этой строки выбран шаблон Xray JSON из Remnawave:
        // правила маршрутизации, DNS, инбаунды — из него. Выходы (сами сервера)
        // остаются от своих хостов, со всеми их настройками.
        const override = panel.templateFor(groupName, noMeta === true);
        if (override) {
            const src = baseConfig || {};
            baseConfig = { ...structuredClone(override), remarks: src.remarks, ...(src.meta ? { meta: src.meta } : {}) };
            _tpl = prepareBaseTemplate(baseConfig);
        }
    }
    if (!outbounds || outbounds.length === 0) {
        if (!fallbackOutbounds || fallbackOutbounds.length === 0) return null;
    }

    const tpl = _tpl || prepareBaseTemplate(baseConfig);
    const prefix = sanitizeTag(groupName);

    // ─── Классификация: main vs LTE ─────────────────────────
    // LTE может прийти двумя путями:
    //   (а) внутри outbounds через isLteOutbound() — inline LTE в страновой группе
    //   (б) через fallbackOutbounds — внешний LTE для AUTO группы
    const inlineMain = (outbounds || []).filter(o => !isLteOutbound(o.tag));
    const inlineLte = (outbounds || []).filter(o => isLteOutbound(o.tag));
    const externalLte = fallbackOutbounds || [];

    let main = inlineMain;
    let lte = [...externalLte, ...inlineLte];

    // Edge case: только LTE → повышаем до main, fallback не нужен
    if (main.length === 0 && lte.length > 0) {
        main = lte;
        lte = [];
    }
    if (main.length === 0) return null;

    const allOutbounds = [...main, ...lte];
    const mainTags = main.map(o => o.tag);
    const lteTags = lte.map(o => o.tag);
    const allTags = allOutbounds.map(o => o.tag);

    // ─── Tier-mode? ─────────────────────────────────────────
    const tierCfg = (config.group_tiers || {})[groupName];
    const tier1FromHelper = getTier1Tags(mainTags, tierCfg);
    const tierMode = Array.isArray(tier1FromHelper) && tier1FromHelper.length > 0;
    let tier1Tags = [];
    let tier2Tags = [];
    if (tierMode) {
        const tier1Set = new Set(tier1FromHelper);
        tier1Tags = tier1FromHelper;
        tier2Tags = mainTags.filter(t => !tier1Set.has(t));
    }
    // tier-mode требует и tier1, и tier2 (иначе нет смысла в каскаде)
    const tierActive = tierMode && tier1Tags.length > 0 && tier2Tags.length > 0;

    if (lte.length > 0 && !tierActive) {
        logger.info('lte', `Группа "${groupName}": основных=${main.length} LTE(резерв)=${lte.length}`);
    }

    // ─── Sticky? ─────────────────────────────────────────────
    // Sticky пропускается для 1-серверных групп (избыточен) и для групп в exclude-списке.
    // Глобальный switch STICKY_SESSION проверяется на уровне server.js (он не передаёт
    // stickyTag когда фича выключена) — здесь только локальные условия.
    const stickyActive = !!stickyTag
        && !STICKY_EXCLUDE_GROUPS.includes(groupName)
        && allTags.length > 1
        && allTags.includes(stickyTag);

    // ─── Building blocks ─────────────────────────────────────
    const balancers = [];
    const extraOutbounds = [];     // loopback outbounds
    const loopbackRules = [];      // routing rules с inboundTag-матчами; идут ПЕРЕД основными правилами

    const mainBalancerTag = `${prefix}-balancer`;
    const tier2BalancerTag = `${prefix}-tier2-balancer`;
    const lteBalancerTag = `${prefix}-lte-balancer`;
    const allBalancerTag = `${prefix}-all-balancer`;
    const stickyBalancerTag = `${prefix}-sticky-balancer`;

    // ─── Режим 1: Tier-mode каскад tier1 → tier2 → all ──────
    if (tierActive) {
        const t1Baseline = `${tierCfg.tier1_baseline_ms ?? TIER1_BASELINE_MS}ms`;
        const t2Baseline = `${tierCfg.tier2_baseline_ms ?? TIER2_BASELINE_MS}ms`;

        // all-balancer (last resort, без baseline — всегда что-то отдаёт)
        balancers.push({
            tag: allBalancerTag,
            selector: mainTags,  // все main, без LTE
            strategy: { type: STRATEGY, settings: { expected: clampExpected(mainTags.length), tolerance: BAL_TOLERANCE_FB } },
        });

        // tier2 → all через loopback
        const lbToAll = makeLoopback(prefix, 'tier2', allBalancerTag);
        extraOutbounds.push(lbToAll.outbound);
        loopbackRules.push(lbToAll.rule);
        balancers.push({
            tag: tier2BalancerTag,
            selector: tier2Tags,
            strategy: { type: STRATEGY, settings: { expected: clampExpected(tier2Tags.length), baselines: [t2Baseline], tolerance: BAL_TOLERANCE_FB } },
            fallbackTag: lbToAll.loopbackTag,
        });

        // tier1 → tier2 через loopback
        const lbToTier2 = makeLoopback(prefix, 'main', tier2BalancerTag);
        extraOutbounds.push(lbToTier2.outbound);
        loopbackRules.push(lbToTier2.rule);
        balancers.push({
            tag: mainBalancerTag,
            selector: tier1Tags,
            strategy: { type: STRATEGY, settings: { expected: clampExpected(tier1Tags.length), baselines: [t1Baseline], tolerance: BAL_TOLERANCE } },
            fallbackTag: lbToTier2.loopbackTag,
        });

        logger.info('tier', `Группа "${groupName}": tier1=${tier1Tags.length} (${t1Baseline}) → tier2=${tier2Tags.length} (${t2Baseline}) → all=${mainTags.length} (no baseline)`);
    }
    // ─── Режим 2: Main + LTE каскад main → lte → all ──────
    else if (lte.length > 0) {
        const allCombined = [...mainTags, ...lteTags];

        // all-balancer (last resort, все серверы группы без baseline)
        balancers.push({
            tag: allBalancerTag,
            selector: allCombined,
            strategy: { type: STRATEGY, settings: { expected: clampExpected(allCombined.length), tolerance: BAL_TOLERANCE_FB } },
        });

        // lte → all через loopback
        const lbToAll = makeLoopback(prefix, 'lte', allBalancerTag);
        extraOutbounds.push(lbToAll.outbound);
        loopbackRules.push(lbToAll.rule);
        balancers.push({
            tag: lteBalancerTag,
            selector: lteTags,
            strategy: { type: STRATEGY, settings: { expected: clampExpected(lteTags.length), baselines: [`${LTE_BASELINE_MS}ms`], tolerance: BAL_TOLERANCE_FB } },
            fallbackTag: lbToAll.loopbackTag,
        });

        // main → lte через loopback
        const lbToLte = makeLoopback(prefix, 'main', lteBalancerTag);
        extraOutbounds.push(lbToLte.outbound);
        loopbackRules.push(lbToLte.rule);
        balancers.push({
            tag: mainBalancerTag,
            selector: mainTags,
            strategy: { type: STRATEGY, settings: { expected: clampExpected(mainTags.length), baselines: [`${MAIN_WITH_LTE_BASELINE_MS}ms`], tolerance: BAL_TOLERANCE } },
            fallbackTag: lbToLte.loopbackTag,
        });
    }
    // ─── Режим 3: Один балансер ──────────────────────────────
    else {
        balancers.push({
            tag: mainBalancerTag,
            selector: mainTags,
            strategy: { type: STRATEGY, settings: { expected: clampExpected(mainTags.length), baselines: [`${SINGLE_BASELINE_MS}ms`], tolerance: BAL_TOLERANCE_FB } },
        });
    }

    // ─── Sticky balancer (поверх любого режима) ──────────────
    // Sticky → main через loopback. Если sticky-сервер тормозит (RTT > threshold),
    // балансер вернёт пусто → fallback → loopback → main balancer (со всем каскадом).
    let entryBalancerTag = mainBalancerTag;
    if (stickyActive) {
        const lbToMain = makeLoopback(prefix, 'sticky', mainBalancerTag);
        extraOutbounds.push(lbToMain.outbound);
        loopbackRules.push(lbToMain.rule);
        balancers.push({
            tag: stickyBalancerTag,
            selector: [stickyTag],
            strategy: { type: STRATEGY, settings: { expected: 1, baselines: [`${STICKY_THRESHOLD_MS}ms`], tolerance: 0 } },
            fallbackTag: lbToMain.loopbackTag,
        });
        entryBalancerTag = stickyBalancerTag;
        logger.info('sticky', `Группа "${groupName}" → ${stickyTag} (порог ${STICKY_THRESHOLD_MS}ms, fallback на ${prefix}-balancer)`);
    }

    // ─── Outbounds ───────────────────────────────────────────
    // proxyOutbound (мёртвый клон первого) удалён — был мусор + риск конфликта
    // если базовый шаблон где-то ссылается на тег 'proxy'.
    const cfgOutbounds = [
        ...structuredClone(allOutbounds).map(o => { delete o._sourceMeta; return o; }),
        ...extraOutbounds,
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'block', protocol: 'blackhole' },
    ];

    // ─── Meta / inbounds / dns ───────────────────────────────
    const descriptionText = renderGroupDescription(groupName, allOutbounds);
    // noMeta=true для авто-выбора: у него нет «своей» ноды, описание было бы чужим.
    const sourceMeta = (!noMeta && main[0]?._sourceMeta) ? main[0]._sourceMeta : null;
    const mergedMeta = descriptionText
        ? { ...(sourceMeta ? structuredClone(sourceMeta) : {}), serverDescription: descriptionText }
        : (sourceMeta ? structuredClone(sourceMeta) : null);

    const cfg = {
        remarks: groupName,
        ...(mergedMeta ? { meta: mergedMeta } : {}),
        ...structuredClone(tpl.inherited),
        dns: structuredClone(tpl.dns),
        inbounds: structuredClone(tpl.inbounds),
        outbounds: cfgOutbounds,
    };

    // burstObservatory наблюдает только реальные outbounds — loopback не пингуется.
    cfg.burstObservatory = {
        subjectSelector: allTags,
        pingConfig: {
            destination: PROBE_URL,
            interval: PROBE_INTERVAL,
            sampling: PROBE_SAMPLING,
            timeout: PROBE_TIMEOUT,
        },
    };

    // ─── Routing rules ───────────────────────────────────────
    const activeProfile = routingProfile !== undefined ? routingProfile : getRoutingProfile();
    const domainStrategy = activeProfile?.DomainStrategy || baseConfig.routing?.domainStrategy || 'IPIfNonMatch';

    let routingRules;
    if (activeProfile) {
        routingRules = buildRoutingRulesFromProfile(activeProfile, entryBalancerTag);
    } else if (Array.isArray(baseConfig.routing?.rules) && baseConfig.routing.rules.some(r =>
        true && (r.domain || r.ip || r.protocol || r.port || r.network || r.inboundTag || r.attrs))) {
        // Правила из Xray Template в Remnawave (direct-домены и т.п.).
        // Правила, ведущие на 'proxy', и пустые catch-all выкидываем — их роль играет балансер.
        const templateRules = structuredClone(baseConfig.routing.rules).filter(r =>
            true &&
            (r.domain || r.ip || r.protocol || r.port || r.network || r.inboundTag || r.attrs));
        if (!_routingFallbackWarned) {
            logger.info('routing', `✅ Используем ${templateRules.length} правил из Xray Template (Remnawave)`);
            _routingFallbackWarned = true;
        }
        routingRules = [
            ...(UDP_BLOCK ? [{ type: 'field', network: 'udp', port: '443', outboundTag: 'block' }] : []),
            ...templateRules,
            { type: 'field', network: 'tcp,udp', balancerTag: entryBalancerTag },
        ];
    } else {
        if (!_routingFallbackWarned) {
            if (!getRoutingProfile()) {
                logger.warn('routing', '⚠️  happ_routing не задан и в Xray Template нет правил — используем fallback-правила');
            } else {
                logger.debug('routing', 'Не-Happ клиент — используем fallback-правила (без geosite/geoip)');
            }
            _routingFallbackWarned = true;
        }
        routingRules = [
            ...(UDP_BLOCK ? [{ type: 'field', network: 'udp', port: '443', outboundTag: 'block' }] : []),
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
            {
                type: 'field',
                ip: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
                     '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'],
                outboundTag: 'direct',
            },
            { type: 'field', network: 'tcp,udp', balancerTag: entryBalancerTag },
        ];
    }

    // direct_domains override (если задан в config.json)
    const directDomains = config.direct_domains || [];
    if (directDomains.length > 0 && Array.isArray(directDomains)) {
        const catchAll = routingRules.pop();
        routingRules.push({ type: 'field', domain: directDomains, outboundTag: 'direct' });
        routingRules.push(catchAll);
    }

    // Loopback rules — впереди всего, чтоб реинжект перехватывался первым.
    if (loopbackRules.length > 0) {
        routingRules = [...loopbackRules, ...routingRules];
    }

    // _proxyToBalancer: правила шаблона, ведущие на 'proxy', отправляем в балансер группы
    routingRules = routingRules.map(r => {
        if (r && r.outboundTag === 'proxy') {
            const { outboundTag, ...rest } = r;
            return { ...rest, balancerTag: entryBalancerTag };
        }
        return r;
    });

    cfg.routing = {
        domainStrategy,
        domainMatcher: 'hybrid',
        balancers,
        rules: routingRules,
    };

    return cfg;
}

module.exports = { buildGroupConfig, resetRoutingWarning };
