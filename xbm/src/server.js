'use strict';

const http = require('http');

// ─── Модули ───
const { logger, setLevel, C } = require('./logger');
const cfg = require('./config');
const { fetchUrl } = require('./utils');
const { checkRateLimit } = require('./rate-limiter');
const { cacheUpstreamResponse, getCachedResponse, cache: upstreamCache } = require('./cache');
const routing = require('./routing');
const nodeStats = require('./node-stats');
const sticky = require('./sticky-assignments');
const { getGroups, matchGroup, detectClientType, isLteOutbound, refreshGroups } = require('./groups');
const { outboundToLink } = require('./converters');
const gen = require('./generators');
const panel = require('./panel-config');  // [BlinVPN] настройки из панели (на лету)

setLevel(cfg.LOG_LEVEL);

const STARTED_AT = Date.now();

// ─── Заголовки ───

const SKIP_REQUEST_HEADERS = new Set([
    'accept-encoding', 'host', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'upgrade', 'proxy-authorization', 'proxy-connection',
    'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range',
]);

const SKIP_RESPONSE_HEADERS = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade',
    'proxy-authenticate', 'proxy-authorization', 'content-length', 'content-encoding',
    'date', 'server', 'etag', 'last-modified', 'cache-control',
]);

function forwardResponseHeaders(upstreamHeaders, contentType) {
    const result = {
        'Content-Type': contentType || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
    };
    for (const [key, val] of Object.entries(upstreamHeaders || {})) {
        if (!SKIP_RESPONSE_HEADERS.has(key) && key !== 'content-type') result[key] = val;
    }
    if (cfg.config.profile_web_page_url) {
        result['profile-web-page-url'] = cfg.config.profile_web_page_url;
    }
    return result;
}

// ─── Bearer auth helper ───────────────────────────────────

/**
 * Проверяет что запрос содержит правильный Bearer-токен.
 * Возвращает true только если API_TOKEN задан и совпадает.
 */
function isAuthorized(req) {
    if (!cfg.API_TOKEN) return false;
    const auth = req.headers['authorization'];
    if (!auth || typeof auth !== 'string') return false;
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    // Constant-time compare через crypto.
    const provided = Buffer.from(m[1], 'utf8');
    const expected = Buffer.from(cfg.API_TOKEN, 'utf8');
    if (provided.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) diff |= provided[i] ^ expected[i];
    return diff === 0;
}

function unauthorized(res, msg = 'Unauthorized') {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: msg }));
}

// ─── Helpers для ?raw=1 ──────────────────────────────────

const RAW_REMARKS_STRIP_RE = /\s*\((WIFI|wifi|LTE|4G|4G\/LTE)\)\s*$/i;

/**
 * Strip remarks-суффиксов вида "Server (WIFI)" / "Server (4G/LTE)".
 * Это нужно для bypass'а Happ network-фильтра, который может скрывать сервера
 * с такими суффиксами в зависимости от типа подключения.
 */
function stripNetworkSuffixes(body) {
    try {
        const parsed = JSON.parse(body);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of arr) {
            if (c && typeof c.remarks === 'string') {
                c.remarks = c.remarks.replace(RAW_REMARKS_STRIP_RE, '').trim();
            }
        }
        return JSON.stringify(arr, null, 2);
    } catch {
        return body;
    }
}

// ─── HTTP сервер ───

const server = http.createServer(async (req, res) => {
    // [BlinVPN] Метка «ответ от XBM» — по ней install.sh проверяет, что nginx ходит в XBM
    res.setHeader('X-XBM', '1');
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const queryRaw = parsedUrl.searchParams.get('raw');

    // ─── Health: minimal без auth (для docker healthcheck), extended с Bearer ───
    if (pathname === '/health' || pathname === '/mw-health') {
        if (!isAuthorized(req)) {
            // Минимальный ответ для healthcheck — без раскрытия топологии.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        // С auth — полный отчёт.
        const groups = getGroups();
        const profile = routing.getRoutingProfile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime_sec: Math.round((Date.now() - STARTED_AT) / 1000),
            groups: Object.keys(groups),
            auto_groups: cfg.AUTO_GROUPS,
            fastest_group: cfg.config.fastest_group !== false,
            node_stats: {
                enabled: cfg.NODE_STATS_ENABLED,
                cached: Object.keys(nodeStats.getCache()).length,
                last_refresh_at: nodeStats.getLastRefreshAt(),
            },
            routing: {
                profile_active: profile?.Name || null,
                source: cfg.HAPP_ROUTING_URL ? 'url' : (profile ? 'config-base64' : 'fallback'),
            },
            sticky: {
                enabled: cfg.STICKY_SESSION,
                size: sticky.size(),
                threshold_ms: cfg.STICKY_THRESHOLD_MS,
                ttl_hours: cfg.STICKY_TTL_HOURS,
                exclude_groups: cfg.STICKY_EXCLUDE_GROUPS,
            },
            panel_auth: !!cfg.PANEL_AUTH_COOKIE,
            upstream_cache: { size: upstreamCache.size, ttl_sec: cfg.UPSTREAM_CACHE_TTL / 1000 },
            sub_page: cfg.SUB_PAGE_URL || 'disabled',
            udp_block: cfg.UDP_BLOCK,
            mihomo_enabled: cfg.MIHOMO_ENABLED,
            singbox_enabled: cfg.SINGBOX_ENABLED,
        }, null, 2));
        return;
    }

    // ─── /node-stats: Bearer required (раньше открыт = разглашение топологии) ───
    if (pathname === '/node-stats') {
        if (!isAuthorized(req)) return unauthorized(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nodeStats.getCache(), null, 2));
        return;
    }

    // ─── /refresh-* admin endpoints: Bearer required ───
    if (pathname === '/refresh-groups') {
        if (!isAuthorized(req)) return unauthorized(res);
        try {
            await refreshGroups();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', groups: getGroups() }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
        return;
    }

    if (pathname === '/refresh-stats') {
        if (!isAuthorized(req)) return unauthorized(res);
        try {
            await nodeStats.fetchNodeStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', nodes: nodeStats.getCache() }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
        return;
    }

    if (pathname === '/refresh-routing') {
        if (!isAuthorized(req)) return unauthorized(res);
        if (!cfg.HAPP_ROUTING_URL) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'happ_routing_url not configured' }));
            return;
        }
        try {
            await routing.fetchRoutingProfile();
            const profile = routing.getRoutingProfile();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', profile: profile?.Name ?? null, source: cfg.HAPP_ROUTING_URL }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
        return;
    }

    // ─── /sticky/<token>: Bearer required (показывает sticky-назначения юзера) ───
    const stickyMatch = pathname.match(/^\/sticky\/([a-zA-Z0-9_-]+)$/);
    if (stickyMatch) {
        if (!isAuthorized(req)) return unauthorized(res);
        const stickyToken = stickyMatch[1];
        const assignments = sticky.describe(stickyToken);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            token_suffix: stickyToken.slice(-8),
            sticky_enabled: cfg.STICKY_SESSION,
            threshold_ms: cfg.STICKY_THRESHOLD_MS,
            ttl_hours: cfg.STICKY_TTL_HOURS,
            assignments: assignments || {},
        }, null, 2));
        return;
    }

    // ─── Subscription route ───
    const match = pathname.match(/^(?:\/sub)?\/([a-zA-Z0-9_-]+)$/);
    if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    const token = match[1];
    const targetUrl = cfg.SUB_PAGE_URL
        ? `${cfg.SUB_PAGE_URL}/${token}`
        : `${cfg.REMNAWAVE_URL}${cfg.REMNAWAVE_SUB_PATH}/${token}`;

    // ─── Rate limit ───
    const rl = checkRateLimit(req);
    if (!rl.allowed) {
        res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(rl.retryAfter),
            'X-RateLimit-Limit': String(cfg.RATE_LIMIT_MAX),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + rl.retryAfter),
        });
        res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: rl.retryAfter }));
        return;
    }

    // ─── ?raw=1 dev bypass: только для whitelisted токенов ───
    const rawRequested = queryRaw === '1' || queryRaw === 'true';
    const rawAllowed = rawRequested && cfg.DEV_RAW_TOKENS.has(token);
    if (rawRequested && !rawAllowed) {
        logger.warn('raw', `🚫 ?raw=1 запрошен для токена ...${token.slice(-8)}, но он не в dev_raw_tokens whitelist — игнорируем`);
    }

    logger.debug('proxy', `→ ${req.method} ${pathname}${rawAllowed ? ' [RAW]' : ''} → ${targetUrl}`);

    try {
        const rawUA = req.headers['user-agent'] || '';
        const clientType = detectClientType(rawUA);
        // [BlinVPN] имя авто-выбора задаётся в панели и меняется без перезапуска
        const AUTO_GROUP_NAME = panel.autoGroupName(cfg.AUTO_GROUP_NAME);
        const shortUA = rawUA.split('/')[0].split(' ')[0] || 'неизвестно';

        // Форвардим заголовки
        const forwardHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!SKIP_REQUEST_HEADERS.has(key)) forwardHeaders[key] = value;
        }

        // ?raw=1: спуфим UA на Happ/1.0 ТОЛЬКО для не-VPN клиентов (браузер/curl).
        // Для известных VPN-клиентов (Happ/Mihomo/...) — оригинальный UA, чтоб
        // upstream вернул то что обычно возвращает им.
        if (rawAllowed && (clientType === 'other')) {
            forwardHeaders['user-agent'] = 'Happ/1.0';
            forwardHeaders['x-forwarded-for'] = '8.8.8.8';
            forwardHeaders['x-real-ip'] = '8.8.8.8';
            logger.info('raw', `[${shortUA}] токен ...${token.slice(-8)} → ?raw=1 (UA spoofed Happ/1.0, IP=8.8.8.8)`);
        } else if (clientType === 'mihomo' || clientType === 'singbox' || clientType === 'incy') {
            // Подменяем UA для mihomo/singbox/incy — middleware сам конвертирует
            // XRAY_JSON в нужный формат клиента.
            forwardHeaders['user-agent'] = 'Happ/1.0';
            logger.debug('proxy', `[${shortUA}] → подменяем UA на Happ/1.0 для XRAY_JSON`);
        }

        if (cfg.SUB_PAGE_URL) {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
            forwardHeaders['X-Forwarded-Proto'] = 'https';
            if (!rawAllowed) {  // при raw уже выставили выше
                forwardHeaders['X-Forwarded-For'] = clientIp;
                forwardHeaders['X-Real-IP'] = clientIp;
            }
            forwardHeaders['Host'] = cfg.SUB_DOMAIN || req.headers['host'] || 'localhost';
        }

        logger.debug('proxy', `   HWID=${req.headers['x-hwid'] || 'неизвестно'} Device=${req.headers['x-device-model'] || 'неизвестно'} OS=${req.headers['x-device-os'] || 'неизвестно'}`);

        const upstream = await fetchUrl(targetUrl, forwardHeaders);
        logger.info('proxy', `← ${req.headers['x-device-model'] || req.headers['x-hwid'] || 'client'} ${upstream.status} ${upstream.body.length}b`);

        if (upstream.status !== 200) {
            res.writeHead(upstream.status, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        // ─── ?raw=1: bypass балансера, возвращаем upstream как есть ───
        if (rawAllowed) {
            const stripped = stripNetworkSuffixes(upstream.body);
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'application/json; charset=utf-8'));
            res.end(stripped);
            return;
        }

        // Passthrough для определённых клиентов
        if (clientType === 'passthrough') {
            logger.info('proxy', `⏭  [${shortUA}] passthrough — проксируем upstream как есть`);
            cacheUpstreamResponse(token, upstream.body, upstream.headers, upstream.headers['content-type']);
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        let parsed;
        try { parsed = JSON.parse(upstream.body); } catch {
            logger.debug('proxy', '⏭  Не JSON, проксируем напрямую');
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        let configArray = Array.isArray(parsed) ? parsed : [parsed];
        if (configArray.length === 0) {
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        const baseConfig = configArray[0];
        if (baseConfig.routing?.rules) {
            logger.debug('routing', `baseConfig содержит ${baseConfig.routing.rules.length} правил (domainStrategy=${baseConfig.routing.domainStrategy || '—'})`);
        }

        if (gen.isFakeConfig(configArray)) {
            logger.warn('proxy', '⚠️  Фейковый конфиг (лимит устройств / истекла подписка) — проксируем как есть');
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        let allOutbounds = gen.collectAllProxyOutbounds(configArray);
        // [BlinVPN] Имя хоста Remnawave совпало с названием строки подписки из панели
        // (например, оба «🇳🇱 Нидерланды»): переименовываем служебное имя хоста, чтобы
        // в Clash / Sing-box строка называлась ровно как в панели, без «⚡».
        {
            const pcNow = panel.get();
            if (pcNow.present && pcNow.onlyGroups) {
                const reserved = new Set([AUTO_GROUP_NAME, ...pcNow.groups.map(g => g.name)]);
                const used = new Set(allOutbounds.map(o => o.tag));
                for (const ob of allOutbounds) {
                    if (!reserved.has(ob.tag)) continue;
                    let n = 2, t;
                    do { t = `${ob.tag} · ${n++}`; } while (used.has(t) || reserved.has(t));
                    panel.alias(t, ob.tag);
                    used.add(t);
                    ob.tag = t;
                }
            }
        }
        // Порядок хостов как в панели (до сортировки по нагрузке)
        const upstreamOrder = allOutbounds.map(o => o.tag);
        logger.debug('proxy', `Собрано ${allOutbounds.length} outbound(ов)`);

        if (allOutbounds.length === 0) {
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        // ─── Фильтрация по нагрузке ───
        const cache = nodeStats.getCache();
        const hasNodeStats = cfg.NODE_STATS_ENABLED && Object.keys(cache).length > 0;
        if (hasNodeStats) {
            const statsExclude = new Set(cfg.config.node_stats_exclude || []);
            const toFilter = [], excluded = [];
            for (const ob of allOutbounds) {
                const group = matchGroup(ob.tag);
                if (group && statsExclude.has(group)) excluded.push(ob);
                else toFilter.push(ob);
            }
            const before = toFilter.length;
            const filtered = nodeStats.filterAndSortByLoad(toFilter);
            if (before !== filtered.length) {
                logger.info('node-stats', `🔽 Отфильтровано: ${before} → ${filtered.length} серверов`);
            }
            if (excluded.length > 0) {
                logger.debug('node-stats', `Пропущено фильтрации: ${excluded.length} серверов (${[...statsExclude].join(', ')})`);
            }
            allOutbounds = [...filtered, ...excluded];
        }

        // ─── Группировка ───
        const GROUPS = getGroups();
        const grouped = {};
        const ungrouped = [];

        for (const ob of allOutbounds) {
            const group = matchGroup(ob.tag);
            if (group) {
                if (!grouped[group]) grouped[group] = [];
                grouped[group].push(ob);
            } else if (panel.get().present && panel.get().onlyGroups) {
                // [BlinVPN] Пользователям видны только хосты, собранные в панели; остальные
                // хосты Remnawave работают только внутри «Автоматического выбора».
                ungrouped.push(ob);
            } else if (cfg.AUTO_HOST_GROUPS) {
                // Новый хост без группы в config.json — показываем его как отдельную локацию
                grouped[ob.tag] = [ob];
            } else {
                ungrouped.push(ob);
            }
        }

        if (ungrouped.length > 0) {
            logger.debug('proxy', `${ungrouped.length} серверов без группы — игнорируем (${ungrouped.map(o => o.tag).join(', ')})`);
        }

        // Сортировка внутри групп по нагрузке
        if (hasNodeStats) {
            for (const [gn, obs] of Object.entries(grouped)) {
                grouped[gn] = obs.slice().sort((a, b) => {
                    const la = nodeStats.getNodeStats(a.tag)?.load ?? 0.5;
                    const lb = nodeStats.getNodeStats(b.tag)?.load ?? 0.5;
                    return la - lb;
                });
            }
        }

        const activeRoutingProfile = (clientType === 'happ' || clientType === 'incy') ? routing.getRoutingProfile() : null;

        // Порядок групп: явно заданные в config.groups + автообнаруженные после
        let groupOrder;
        const pc = panel.get();
        if (pc.present && pc.onlyGroups) {
            // [BlinVPN] Порядок строк — как в панели
            groupOrder = pc.groups.map(g => g.name).filter(n => grouped[n]);
        } else if (cfg.AUTO_HOST_GROUPS) {
            // Порядок = порядок хостов в панели Remnawave (группа встаёт на место своего первого хоста)
            groupOrder = [];
            for (const tag of upstreamOrder) {
                const gn = matchGroup(tag) || tag;
                if (grouped[gn] && !groupOrder.includes(gn)) groupOrder.push(gn);
            }
        } else {
            groupOrder = [...Object.keys(GROUPS)];
        }
        for (const gn of Object.keys(grouped)) {
            if (!groupOrder.includes(gn)) groupOrder.push(gn);
        }

        // ─── Sticky session: вычисляем назначения ───
        // Sticky failure не должен ломать весь request — оборачиваем в try/catch.
        // Если что-то пошло не так, отдадим клиенту конфиг без sticky-назначений.
        const stickyTags = {};  // groupName → assigned tag
        if (cfg.STICKY_SESSION) {
            try {
                const loadLookup = (tag) => nodeStats.getNodeStats(tag);

                // AUTO группа
                const fastestEnabled = cfg.config.fastest_group !== false;
                if (fastestEnabled && !cfg.STICKY_EXCLUDE_GROUPS.includes(AUTO_GROUP_NAME) && !cfg.STICKY_EXCLUDE_GROUPS.includes(cfg.AUTO_GROUP_NAME)) {
                    const fastestExclude = new Set(cfg.config.fastest_exclude || []);
                    const fastestFallback = new Set(cfg.config.fastest_fallback || []);
                    const autoCandidates = [];
                    for (const ob of allOutbounds) {
                        if (panel.isAutoExcluded(ob.tag)) continue;  // [BlinVPN] исключён в панели
                        if (isLteOutbound(ob.tag)) continue;         // [BlinVPN] белые списки — только резерв
                        const g = matchGroup(ob.tag);
                        if (g && fastestExclude.has(g)) continue;
                        if (g && fastestFallback.has(g)) continue;  // sticky над main, не fallback
                        autoCandidates.push(ob.tag);
                    }
                    if (autoCandidates.length > 1) {
                        const tag = sticky.getOrAssign(token, AUTO_GROUP_NAME, autoCandidates, loadLookup);
                        if (tag) stickyTags[AUTO_GROUP_NAME] = tag;
                    }
                }

                // Страновые группы
                for (const groupName of groupOrder) {
                    if (cfg.STICKY_EXCLUDE_GROUPS.includes(groupName)) continue;
                    const obs = grouped[groupName];
                    if (!obs || obs.length <= 1) continue;
                    const candidates = obs.map(o => o.tag).filter(t => !isLteOutbound(t));
                    const useCandidates = candidates.length > 1 ? candidates : obs.map(o => o.tag);
                    if (useCandidates.length <= 1) continue;
                    const tag = sticky.getOrAssign(token, groupName, useCandidates, loadLookup);
                    if (tag) stickyTags[groupName] = tag;
                }
            } catch (err) {
                logger.error('sticky', `Ошибка при вычислении sticky-назначений (продолжаем без них): ${err.message}`);
                // stickyTags остаётся пустым — клиент получит конфиг без sticky.
            }
        }

        // ─── Xray конфиги (Happ / INCY / xray_json / other) ───
        gen.resetRoutingWarning();
        const resultConfigs = [];

        if (clientType === 'happ' || clientType === 'incy' || clientType === 'xray_json' || clientType === 'other') {
            const baseTpl = gen.prepareBaseTemplate(baseConfig);

            // Fastest (AUTO)
            const fastestEnabled = cfg.config.fastest_group !== false;
            if (fastestEnabled && allOutbounds.length >= 1) {
                const fastestExclude = cfg.config.fastest_exclude || [];
                const fastestFallback = cfg.config.fastest_fallback || [];
                const excludeSet = new Set(fastestExclude);
                const fallbackSet = new Set(fastestFallback);

                // [BlinVPN] хосты, исключённые из авто-выбора в панели
                let fastestOutbounds = allOutbounds.filter(ob => !panel.isAutoExcluded(ob.tag));
                let fastestFallbackOutbounds = [];

                if (excludeSet.size > 0 || fallbackSet.size > 0) {
                    fastestOutbounds = [];
                    for (const ob of allOutbounds) {
                        if (panel.isAutoExcluded(ob.tag)) continue;
                        const group = matchGroup(ob.tag);
                        if (group && excludeSet.has(group)) continue;
                        else if (group && fallbackSet.has(group)) fastestFallbackOutbounds.push(ob);
                        else fastestOutbounds.push(ob);
                    }
                }

                const totalAutoOutbounds = fastestOutbounds.length + fastestFallbackOutbounds.length;
                if (totalAutoOutbounds >= 1) {
                    const autoCfg = gen.buildGroupConfig(
                        baseConfig, AUTO_GROUP_NAME, fastestOutbounds,
                        fastestFallbackOutbounds.length > 0 ? fastestFallbackOutbounds : undefined,
                        baseTpl, activeRoutingProfile,
                        stickyTags[AUTO_GROUP_NAME] || null,
                        true,
                    );
                    if (autoCfg) {
                        resultConfigs.push(autoCfg);
                        const parts = [];
                        const excl = allOutbounds.length - fastestOutbounds.length - fastestFallbackOutbounds.length;
                        if (excl > 0) parts.push(`исключено ${excl} из ${fastestExclude.join(', ')}`);
                        if (fastestFallbackOutbounds.length > 0) parts.push(`fallback ${fastestFallbackOutbounds.length} из ${fastestFallback.join(', ')}`);
                        logger.info('group', `${AUTO_GROUP_NAME}: ${fastestOutbounds.length} серверов${parts.length > 0 ? ` (${parts.join('; ')})` : ' (все)'}`);
                    }
                }
            }

            // Группы по странам
            for (const groupName of groupOrder) {
                const obs = grouped[groupName];
                if (!obs || obs.length === 0) continue;
                const groupCfg = gen.buildGroupConfig(
                    baseConfig, groupName, obs, undefined, baseTpl, activeRoutingProfile,
                    stickyTags[groupName] || null,
                );
                if (!groupCfg) continue;
                resultConfigs.push(groupCfg);

                if (hasNodeStats) {
                    const order = obs.map(ob => {
                        const s = nodeStats.getNodeStats(ob.tag);
                        if (!s) return ob.tag;
                        const ramStr = s.totalRamGb !== null ? `${s.totalRamGb.toFixed(1)}G` : '?G';
                        const cpuStr = s.cpuCount !== null ? `${s.cpuCount}C` : '?C';
                        return `${ob.tag}(${s.usersOnline}u/${ramStr}/${cpuStr})`;
                    }).join(', ');
                    logger.info('group', `${groupName}: ${obs.length} серверов → ${order}`);
                } else {
                    logger.info('group', `${groupName}: ${obs.length} серверов`);
                }
            }
        }

        // ─── Ответ клиенту ───
        cacheUpstreamResponse(token, upstream.body, upstream.headers, upstream.headers['content-type']);

        if (clientType === 'mihomo') {
            if (!cfg.MIHOMO_ENABLED) {
                logger.info('proxy', `↩️  [${shortUA}] Mihomo: генерация выключена в config — отдаём upstream как есть`);
                res.writeHead(200, forwardResponseHeaders(upstream.headers, 'text/yaml; charset=utf-8'));
                res.end(upstream.body);
                return;
            }
            // ?profile=pro: Legiz-style YAML с rule-sets и semantic groups (если включено в config).
            const profileMode = parsedUrl.searchParams.get('profile');
            const proAllowed = profileMode === 'pro' && cfg.MIHOMO_PRO_TOKENS.has(token);
            if (profileMode === 'pro' && !proAllowed) {
                logger.warn('mihomo-pro', `🚫 ?profile=pro для токена ...${token.slice(-8)} запрещён (не в whitelist mihomo_pro_tokens)`);
            }
            if (proAllowed) {
                const proYaml = gen.generateMihomoYamlPro(allOutbounds);
                if (proYaml) {
                    logger.info('proxy', `✅ [${shortUA}] Mihomo PRO YAML: ${allOutbounds.length} серверов`);
                    res.writeHead(200, forwardResponseHeaders(upstream.headers, 'text/yaml; charset=utf-8'));
                    res.end(proYaml);
                    return;
                }
                logger.warn('mihomo-pro', 'Шаблон не загрузился, fallback на обычный Mihomo YAML');
            }
            const yamlBody = gen.generateMihomoYaml(grouped, groupOrder, allOutbounds, routing.getRoutingProfile(), stickyTags, AUTO_GROUP_NAME);
            if (!yamlBody) {
                res.writeHead(200, forwardResponseHeaders(upstream.headers, 'text/plain'));
                res.end(upstream.body);
                return;
            }
            logger.info('proxy', `✅ [${shortUA}] Mihomo YAML: ${Object.keys(grouped).length} групп / ${allOutbounds.length} серверов`);
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'text/yaml; charset=utf-8'));
            res.end(yamlBody);
            return;
        }

        if (clientType === 'singbox') {
            if (!cfg.SINGBOX_ENABLED) {
                logger.info('proxy', `↩️  [${shortUA}] Sing-box: генерация выключена в config — отдаём upstream как есть`);
                res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
                res.end(upstream.body);
                return;
            }
            const sbConfig = gen.generateSingboxConfig(grouped, groupOrder, allOutbounds, routing.getRoutingProfile(), stickyTags, AUTO_GROUP_NAME);
            if (!sbConfig) {
                res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json'));
                res.end(upstream.body);
                return;
            }
            logger.info('proxy', `✅ [${shortUA}] Sing-box JSON: ${Object.keys(grouped).length} групп / ${allOutbounds.length} серверов`);
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(JSON.stringify(sbConfig, null, 2));
            return;
        }

        if (clientType === 'other') {
            logger.info('proxy', `⚠️  Неизвестный клиент [${shortUA}] — отдаём base64`);
            const links = [];
            for (const groupName of groupOrder) {
                const obs = grouped[groupName];
                if (!obs || obs.length === 0) continue;
                try {
                    const link = outboundToLink(obs[0], groupName);
                    if (link) links.push(link);
                } catch (e) { logger.debug('proxy', `Не удалось конвертировать ${obs[0].tag}: ${e.message}`); }
            }
            logger.info('proxy', `✅ [base64] ${links.length} серверов (по одному на группу)`);
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'text/plain; charset=utf-8'));
            res.end(Buffer.from(links.join('\n')).toString('base64'));
            return;
        }

        // Xray JSON (Happ / INCY / xray_json)
        const routingLabel = (clientType === 'happ' || clientType === 'incy') && routing.getRoutingProfile() ? 'happ_routing' : 'fallback';
        const stickyCount = Object.keys(stickyTags).length;
        const stickyLabel = stickyCount > 0 ? ` sticky=${stickyCount}` : '';
        logger.info('proxy', `✅ [${shortUA}] Xray JSON: ${resultConfigs.length} групп / ${allOutbounds.length} серверов (routing: ${routingLabel}${stickyLabel})`);
        res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
        res.end(JSON.stringify(resultConfigs, null, 2));

    } catch (err) {
        const errMsg = err?.message || String(err);
        logger.error('error', `❌ ${errMsg}`);
        if (!res.headersSent) {
            const cached = getCachedResponse(token);
            if (cached) {
                logger.warn('proxy', `⚠️  Upstream недоступен — отдаём кэшированный ответ (возраст ${Math.round((Date.now() - cached.cachedAt) / 1000)}с)`);
                res.writeHead(200, forwardResponseHeaders(cached.headers, cached.contentType || 'application/json; charset=utf-8'));
                res.end(cached.body);
            } else {
                // Не протекаем err.message в ответ — может содержать sensitive info
                // (SSRF guard text с private IP, file paths, etc).
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway');
            }
        }
    }
});

// ─── Graceful shutdown ───

function shutdown(signal) {
    logger.info('shutdown', `${signal} — завершаем...`);
    server.close(() => {
        try { sticky.flushToDisk(); } catch (e) {
            logger.warn('shutdown', `Ошибка финального flush sticky: ${e?.message || e}`);
        }
        logger.info('shutdown', 'Готово ✅');
        process.exit(0);
    });
    setTimeout(() => { process.exit(1); }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
    logger.error('error', '❌ Необработанная ошибка:', err?.message || err);
});

// ─── Старт ───

async function start() {
    await routing.init();

    if (cfg.AUTO_GROUPS && cfg.API_TOKEN) {
        await refreshGroups();
        setInterval(() => refreshGroups(), cfg.AUTO_GROUPS_INTERVAL).unref();
    }

    await nodeStats.init();

    if (cfg.STICKY_SESSION) {
        sticky.init();
    }

    const fastestEnabled = cfg.config.fastest_group !== false;
    const routingProfile = routing.getRoutingProfile();
    const routingSource = cfg.HAPP_ROUTING_URL
        ? `URL (обновление каждые ${cfg.HAPP_ROUTING_UPDATE_INTERVAL / 1000}с)`
        : routingProfile ? 'config (base64)' : '⚠️  не задан (fallback)';

    const GROUPS = getGroups();

    // HTTP server timeouts из config (production-friendly defaults: 65s/66s/30s).
    // keepAliveTimeout — время жизни idle keepalive-соединения от клиента.
    // headersTimeout — макс время на получение всех request headers.
    // requestTimeout — макс время на полный request (защита от slowloris).
    server.keepAliveTimeout = cfg.SERVER_KEEPALIVE_TIMEOUT_MS;
    server.headersTimeout = cfg.SERVER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = cfg.SERVER_REQUEST_TIMEOUT_MS;

    server.listen(cfg.PORT, () => {
        const sep = C.dim + '─'.repeat(50) + C.reset;
        process.stdout.write(`\n${sep}\n`);
        process.stdout.write(`${C.bold}${C.system}🚀 Xray Balancer Middleware v3.1${C.reset}  порт ${C.bold}${cfg.PORT}${C.reset}  уровень логов: ${C.bold}${cfg.LOG_LEVEL.toUpperCase()}${C.reset}\n`);
        process.stdout.write(`${sep}\n`);
        logger.info('system', `📋 Группы:     ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v.join(',')}]`).join(' | ') || '—'}`);
        logger.info('system', `🏁 Быстрые:    ${fastestEnabled ? `✅ "${cfg.AUTO_GROUP_NAME}"` : '❌'}`);
        logger.info('system', `🎯 Стратегия:  ${cfg.STRATEGY} (expected=${cfg.LOAD_EXPECTED}, tolerance=${cfg.BAL_TOLERANCE}/${cfg.BAL_TOLERANCE_FB})`);
        logger.info('system', `📡 Probe:      ${cfg.PROBE_URL} каждые ${cfg.PROBE_INTERVAL} (sampling=${cfg.PROBE_SAMPLING}, timeout=${cfg.PROBE_TIMEOUT})`);
        logger.info('system', `📊 Node stats: ${cfg.NODE_STATS_ENABLED ? `✅ каждые ${cfg.NODE_STATS_INTERVAL / 1000}с  макс ${cfg.MAX_USERS_PER_GB} u/GB  ${cfg.MAX_USERS_PER_CPU} u/CPU` : '❌'}`);
        logger.info('system', `🍪 Sticky:     ${cfg.STICKY_SESSION ? `✅ threshold=${cfg.STICKY_THRESHOLD_MS}ms TTL=${cfg.STICKY_TTL_HOURS}h persist=${cfg.STICKY_PERSIST_PATH}` : '❌'}`);
        logger.info('system', `🔧 Tier:       ${Object.keys(cfg.config.group_tiers || {}).length > 0 ? `✅ ${Object.keys(cfg.config.group_tiers).join(', ')}` : '❌'}`);
        logger.info('system', `🔐 Cookie:     ${cfg.PANEL_AUTH_COOKIE ? '✅' : '❌'}`);
        logger.info('system', `🌐 Sub page:   ${cfg.SUB_PAGE_URL || '—'}`);
        logger.info('system', `🗺  Routing:    ${routingProfile ? `✅ "${routingProfile.Name}" — ${routingSource}` : routingSource}`);
        logger.info('system', `🚦 Rate limit: ${cfg.RATE_LIMIT_MAX > 0 ? `✅ ${cfg.RATE_LIMIT_MAX} req/${cfg.RATE_LIMIT_WINDOW / 1000}s per HWID/IP` : '❌ отключён'}`);
        logger.info('system', `💾 Кэш:        ${cfg.UPSTREAM_CACHE_TTL > 0 ? `✅ TTL ${cfg.UPSTREAM_CACHE_TTL / 1000}с` : '❌ отключён'}`);
        logger.info('system', `🔓 Bearer:     ${cfg.API_TOKEN ? '✅ /health (extended), /node-stats, /refresh-*, /sticky' : '⚠️  не задан — admin endpoints закрыты'}`);
        logger.info('system', `🛠  Raw bypass: ${cfg.DEV_RAW_TOKENS.size > 0 ? `✅ ${cfg.DEV_RAW_TOKENS.size} whitelisted токенов` : '❌'}`);
        process.stdout.write(`${sep}\n`);
        logger.info('system', `   Подписка:  http://localhost:${cfg.PORT}/{token}`);
        logger.info('system', `   Health:    http://localhost:${cfg.PORT}/health  (Bearer для подробностей)`);
        logger.info('system', `   Stats:     http://localhost:${cfg.PORT}/node-stats  (Bearer)`);
        logger.info('system', `   Sticky:    http://localhost:${cfg.PORT}/sticky/{token}  (Bearer)`);
        process.stdout.write(`${sep}\n\n`);
    });
}

start().catch(err => { console.error('❌ Критическая ошибка:', err); process.exit(1); });
