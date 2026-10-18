'use strict';

// ─── Общий хелпер: извлечь параметры из streamSettings ───

/**
 * Приводит outbound к классическому виду, который понимают конвертеры:
 *  - network "raw" (новое имя TCP в Xray) → "tcp", rawSettings → tcpSettings;
 *  - упрощённый формат settings {address, port, id, ...} → vnext / servers.
 */
function normalizeOutbound(ob) {
    if (!ob || typeof ob !== 'object') return ob;
    const out = { ...ob };
    const st = ob.streamSettings;
    if (st && (st.network === 'raw' || st.rawSettings)) {
        out.streamSettings = { ...st };
        if (st.network === 'raw') out.streamSettings.network = 'tcp';
        if (st.rawSettings && !st.tcpSettings) out.streamSettings.tcpSettings = st.rawSettings;
    }
    const s = ob.settings;
    if (s && s.address && !s.vnext && !s.servers) {
        if (ob.protocol === 'vless' || ob.protocol === 'vmess') {
            const user = { id: s.id, encryption: s.encryption || 'none' };
            if (s.flow) user.flow = s.flow;
            if (s.alterId !== undefined) user.alterId = s.alterId;
            if (s.security) user.security = s.security;
            out.settings = { vnext: [{ address: s.address, port: s.port, users: [user] }] };
        } else if (ob.protocol === 'trojan' || ob.protocol === 'shadowsocks') {
            out.settings = { servers: [{ address: s.address, port: s.port, password: s.password, method: s.method }] };
        }
    }
    return out;
}

/**
 * Доп. настройки XHTTP (xPaddingBytes, noGRPCHeader, sessionPlacement, scMaxEachPostBytes, ...)
 * из Xray → ключи Mihomo (x-padding-bytes, no-grpc-header, session-placement, ...).
 * Диапазон {from, to} → "from-to". Вложенные объекты (xmux, downloadSettings, headers) пропускаются.
 */
function xhttpExtraToMihomo(sh) {
    const res = {};
    if (!sh || typeof sh !== 'object') return res;
    const skip = new Set(['path', 'host', 'mode', 'extra']);
    const src = { ...(sh.extra && typeof sh.extra === 'object' ? sh.extra : {}) };
    for (const [k, v] of Object.entries(sh)) if (!skip.has(k)) src[k] = v;
    for (const [k, v] of Object.entries(src)) {
        if (skip.has(k) || v === undefined || v === null || v === '') continue;
        let val = v;
        if (typeof v === 'object') {
            if (!Array.isArray(v) && ('from' in v || 'to' in v)) val = `${v.from ?? v.to}-${v.to ?? v.from}`;
            else continue;
        }
        const key = k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
        res[key] = val;
    }
    return res;
}

function parseStream(st) {
    return {
        net:  st.network || 'tcp',
        sec:  st.security || 'none',
        tls:  st.tlsSettings || {},
        real: st.realitySettings || {},
        ws:   st.wsSettings || {},
        grpc: st.grpcSettings || {},
        h2:   st.httpSettings || {},
        tcp:  st.tcpSettings || {},
        sh:   st.splithttpSettings || st.xhttpSettings || {},
        hu:   st.httpupgradeSettings || {},
        kcp:  st.kcpSettings || {},
    };
}

// ─── Общий хелпер: извлечь сервер/юзера из outbound.settings ───

function extractEndpoint(ob) {
    const s = ob.settings;
    const proto = ob.protocol;
    if (proto === 'vless' || proto === 'vmess') {
        const srv = s?.vnext?.[0];
        const user = srv?.users?.[0];
        return srv && user ? { srv, user } : null;
    }
    if (proto === 'trojan' || proto === 'shadowsocks') {
        const srv = s?.servers?.[0];
        return srv ? { srv, user: srv } : null;
    }
    return null;
}

// ════════════════════════════════════════════════════════════
//  Xray → Share Link (vless://, vmess://, trojan://, ss://)
// ════════════════════════════════════════════════════════════

function outboundToLink(ob, displayName) {
    ob = normalizeOutbound(ob);
    const s = ob.settings;
    const tag = displayName || ob.tag || 'server';
    const st = ob.streamSettings || {};

    if (ob.protocol === 'vless') {
        const ep = extractEndpoint(ob);
        if (!ep) return null;
        const { srv, user } = ep;
        const params = new URLSearchParams();
        const network = st.network || 'tcp';
        params.set('type', network);
        if (st.security) params.set('security', st.security);
        // TLS
        if (st.tlsSettings?.serverName) params.set('sni', st.tlsSettings.serverName);
        if (st.tlsSettings?.alpn?.length) params.set('alpn', st.tlsSettings.alpn.join(','));
        if (st.tlsSettings?.fingerprint) params.set('fp', st.tlsSettings.fingerprint);
        // Reality
        if (st.realitySettings?.serverName) params.set('sni', st.realitySettings.serverName);
        if (st.realitySettings?.publicKey) params.set('pbk', st.realitySettings.publicKey);
        if (st.realitySettings?.shortId) params.set('sid', st.realitySettings.shortId);
        if (st.realitySettings?.spiderX) params.set('spx', st.realitySettings.spiderX);
        if (st.realitySettings?.fingerprint) params.set('fp', st.realitySettings.fingerprint);
        if (user.flow) params.set('flow', user.flow);
        // Transports
        if (st.wsSettings?.path) params.set('path', st.wsSettings.path);
        if (st.wsSettings?.headers?.Host) params.set('host', st.wsSettings.headers.Host);
        if (st.grpcSettings?.serviceName) params.set('serviceName', st.grpcSettings.serviceName);
        if (st.grpcSettings?.multiMode) params.set('mode', 'multi');
        if (st.httpSettings?.path) params.set('path', st.httpSettings.path);
        if (st.httpSettings?.host?.length) params.set('host', st.httpSettings.host[0]);
        if (network === 'tcp' && st.tcpSettings?.header?.type === 'http') {
            params.set('headerType', 'http');
            const req = st.tcpSettings.header.request;
            if (req?.path?.[0]) params.set('path', req.path[0]);
            if (req?.headers?.Host?.[0]) params.set('host', req.headers.Host[0]);
        }
        if (st.splithttpSettings?.path) params.set('path', st.splithttpSettings.path);
        if (st.splithttpSettings?.host) params.set('host', st.splithttpSettings.host);
        if (st.xhttpSettings?.path) params.set('path', st.xhttpSettings.path);
        if (st.xhttpSettings?.host) params.set('host', st.xhttpSettings.host);
        // HTTPUpgrade
        if (st.httpupgradeSettings?.path) params.set('path', st.httpupgradeSettings.path);
        if (st.httpupgradeSettings?.host) params.set('host', st.httpupgradeSettings.host);
        return `vless://${user.id}@${srv.address}:${srv.port}?${params.toString()}#${encodeURIComponent(tag)}`;
    }

    if (ob.protocol === 'vmess') {
        const ep = extractEndpoint(ob);
        if (!ep) return null;
        const { srv, user } = ep;
        const network = st.network || 'tcp';
        let headerType = 'none';
        let vmPath = st.wsSettings?.path || st.httpSettings?.path || st.grpcSettings?.serviceName || '';
        let vmHost = st.wsSettings?.headers?.Host || '';
        if (network === 'tcp' && st.tcpSettings?.header?.type === 'http') {
            headerType = 'http';
            const req = st.tcpSettings.header.request;
            if (req?.path?.[0]) vmPath = req.path[0];
            if (req?.headers?.Host?.[0]) vmHost = req.headers.Host[0];
        }
        if (network === 'http' || network === 'h2') {
            if (st.httpSettings?.host?.[0]) vmHost = st.httpSettings.host[0];
        }
        const obj = {
            v: '2', ps: tag, add: srv.address, port: String(srv.port),
            id: user.id, aid: String(user.alterId || 0),
            net: network, type: headerType,
            tls: st.security === 'tls' ? 'tls' : '',
            sni: st.tlsSettings?.serverName || '',
            fp: st.tlsSettings?.fingerprint || '',
            alpn: st.tlsSettings?.alpn?.join(',') || '',
            path: vmPath, host: vmHost,
        };
        return `vmess://${Buffer.from(JSON.stringify(obj)).toString('base64')}`;
    }

    if (ob.protocol === 'trojan') {
        const srv = s?.servers?.[0];
        if (!srv) return null;
        const params = new URLSearchParams();
        params.set('type', st.network || 'tcp');
        if (st.security) params.set('security', st.security);
        if (st.tlsSettings?.serverName) params.set('sni', st.tlsSettings.serverName);
        if (st.tlsSettings?.fingerprint) params.set('fp', st.tlsSettings.fingerprint);
        if (st.tlsSettings?.alpn?.length) params.set('alpn', st.tlsSettings.alpn.join(','));
        if (st.wsSettings?.path) params.set('path', st.wsSettings.path);
        if (st.wsSettings?.headers?.Host) params.set('host', st.wsSettings.headers.Host);
        if (st.grpcSettings?.serviceName) params.set('serviceName', st.grpcSettings.serviceName);
        if (st.httpSettings?.path) params.set('path', st.httpSettings.path);
        if (st.httpSettings?.host?.length) params.set('host', st.httpSettings.host[0]);
        if (st.httpupgradeSettings?.path) params.set('path', st.httpupgradeSettings.path);
        if (st.httpupgradeSettings?.host) params.set('host', st.httpupgradeSettings.host);
        return `trojan://${srv.password}@${srv.address}:${srv.port}?${params.toString()}#${encodeURIComponent(tag)}`;
    }

    if (ob.protocol === 'shadowsocks') {
        const srv = s?.servers?.[0];
        if (!srv) return null;
        const userinfo = Buffer.from(`${srv.method}:${srv.password}`).toString('base64');
        return `ss://${userinfo}@${srv.address}:${srv.port}#${encodeURIComponent(tag)}`;
    }

    return null;
}

// ════════════════════════════════════════════════════════════
//  Xray → Mihomo (Clash Meta) proxy object
// ════════════════════════════════════════════════════════════

function applyTlsToMihomo(proxy, sec, tls, real) {
    if (sec === 'tls') {
        proxy.tls = true;
        if (tls.serverName) proxy.servername = tls.serverName;
        if (tls.fingerprint) proxy['client-fingerprint'] = tls.fingerprint;
        if (tls.alpn?.length) proxy.alpn = tls.alpn;
        proxy['skip-cert-verify'] = tls.allowInsecure || false;
    }
    if (sec === 'reality') {
        proxy.tls = true;
        if (real.serverName) proxy.servername = real.serverName;
        if (real.fingerprint) proxy['client-fingerprint'] = real.fingerprint;
        const ro = {};
        if (real.publicKey) ro['public-key'] = real.publicKey;
        if (real.shortId) ro['short-id'] = real.shortId;
        if (Object.keys(ro).length) proxy['reality-opts'] = ro;
    }
}

function applyTransportToMihomo(proxy, { net, ws, grpc, h2, tcp, hu, kcp, sh }) {
    // XHTTP (splithttp) — поддерживается в свежих Mihomo (Clash Verge Rev, Koala Clash)
    if (net === 'xhttp' || net === 'splithttp') {
        proxy.network = 'xhttp';
        const xo = {};
        if (sh && sh.path) xo.path = sh.path;
        if (sh && sh.host) xo.host = sh.host;
        if (sh && sh.mode) xo.mode = sh.mode;
        Object.assign(xo, xhttpExtraToMihomo(sh));
        if (Object.keys(xo).length) proxy['xhttp-opts'] = xo;
    }
    if (net === 'ws' && (ws.path || ws.headers)) {
        const wo = {};
        if (ws.path) wo.path = ws.path;
        if (ws.headers?.Host) wo.headers = { Host: ws.headers.Host };
        proxy['ws-opts'] = wo;
    }
    if (net === 'grpc' && grpc.serviceName) {
        proxy['grpc-opts'] = { 'grpc-service-name': grpc.serviceName };
    }
    if ((net === 'h2' || net === 'http') && (h2.path || h2.host)) {
        const ho = {};
        if (h2.path) ho.path = h2.path;
        if (h2.host) ho.host = h2.host;
        proxy['h2-opts'] = ho;
    }
    if (net === 'tcp' && tcp.header?.type === 'http') {
        proxy.network = 'http';
        const ho = {};
        if (tcp.header.request?.path?.[0]) ho.path = [tcp.header.request.path[0]];
        if (tcp.header.request?.headers?.Host) ho.host = tcp.header.request.headers.Host;
        proxy['http-opts'] = ho;
    }
    // HTTPUpgrade (Mihomo поддерживает как network: httpupgrade с ws-opts)
    if (net === 'httpupgrade') {
        proxy.network = 'ws';
        proxy['ws-opts'] = { 'v2ray-http-upgrade': true };
        if (hu.path) proxy['ws-opts'].path = hu.path;
        if (hu.host) proxy['ws-opts'].headers = { Host: hu.host };
    }
    // KCP/mKCP
    if (net === 'kcp') {
        proxy.network = 'kcp';
        if (kcp.header?.type) proxy['kcp-opts'] = { header: { type: kcp.header.type } };
    }
}

function xrayToMihomo(ob) {
    ob = normalizeOutbound(ob);
    const ep = extractEndpoint(ob);
    if (!ep) return null;

    const st = ob.streamSettings || {};
    const stream = parseStream(st);
    let proxy = null;

    if (ob.protocol === 'vless') {
        proxy = { name: ob.tag, type: 'vless', server: ep.srv.address, port: ep.srv.port, uuid: ep.user.id, udp: true, network: stream.net };
        if (ep.user.flow) proxy.flow = ep.user.flow;
        proxy['packet-encoding'] = 'xudp';
    } else if (ob.protocol === 'vmess') {
        proxy = { name: ob.tag, type: 'vmess', server: ep.srv.address, port: ep.srv.port, uuid: ep.user.id, alterId: ep.user.alterId || 0, cipher: 'auto', udp: true, network: stream.net };
    } else if (ob.protocol === 'trojan') {
        proxy = { name: ob.tag, type: 'trojan', server: ep.srv.address, port: ep.srv.port, password: ep.srv.password, udp: true, network: stream.net };
    } else if (ob.protocol === 'shadowsocks') {
        proxy = { name: ob.tag, type: 'ss', server: ep.srv.address, port: ep.srv.port, cipher: ep.srv.method, password: ep.srv.password, udp: true };
    }
    if (!proxy) return null;

    applyTlsToMihomo(proxy, stream.sec, stream.tls, stream.real);
    applyTransportToMihomo(proxy, stream);

    return proxy;
}

// ════════════════════════════════════════════════════════════
//  Xray → Sing-box outbound object
// ════════════════════════════════════════════════════════════

function applyTlsToSingbox(out, sec, tls, real) {
    if (sec !== 'tls' && sec !== 'reality') return;
    const t = { enabled: true };
    const sni = sec === 'reality' ? real.serverName : tls.serverName;
    if (sni) t.server_name = sni;
    const fp = real.fingerprint || tls.fingerprint;
    if (fp) t.utls = { enabled: true, fingerprint: fp };
    if (tls.alpn?.length) t.alpn = tls.alpn;
    if (sec === 'reality') {
        t.reality = { enabled: true };
        if (real.publicKey) t.reality.public_key = real.publicKey;
        if (real.shortId) t.reality.short_id = real.shortId;
    }
    out.tls = t;
}

function applyTransportToSingbox(out, { net, ws, grpc, h2, hu }) {
    if (net === 'ws') {
        const tr = { type: 'ws' };
        if (ws.path) tr.path = ws.path;
        if (ws.headers?.Host) tr.headers = { Host: ws.headers.Host };
        out.transport = tr;
    } else if (net === 'grpc') {
        out.transport = { type: 'grpc', service_name: grpc.serviceName || '' };
    } else if (net === 'h2' || net === 'http') {
        const tr = { type: 'http' };
        if (h2.path) tr.path = h2.path;
        if (h2.host?.length) tr.host = h2.host;
        out.transport = tr;
    } else if (net === 'httpupgrade') {
        const tr = { type: 'httpupgrade' };
        if (hu.path) tr.path = hu.path;
        if (hu.host) tr.host = hu.host;
        out.transport = tr;
    }
}

function xrayToSingbox(ob) {
    ob = normalizeOutbound(ob);
    const ep = extractEndpoint(ob);
    if (!ep) return null;

    const st = ob.streamSettings || {};
    const stream = parseStream(st);
    let out = null;

    if (ob.protocol === 'vless') {
        out = { type: 'vless', tag: ob.tag, server: ep.srv.address, server_port: ep.srv.port, uuid: ep.user.id };
        if (ep.user.flow) out.flow = ep.user.flow;
    } else if (ob.protocol === 'vmess') {
        out = { type: 'vmess', tag: ob.tag, server: ep.srv.address, server_port: ep.srv.port, uuid: ep.user.id, alter_id: ep.user.alterId || 0, security: 'auto' };
    } else if (ob.protocol === 'trojan') {
        out = { type: 'trojan', tag: ob.tag, server: ep.srv.address, server_port: ep.srv.port, password: ep.srv.password };
    } else if (ob.protocol === 'shadowsocks') {
        out = { type: 'shadowsocks', tag: ob.tag, server: ep.srv.address, server_port: ep.srv.port, method: ep.srv.method, password: ep.srv.password };
    }
    if (!out) return null;

    applyTlsToSingbox(out, stream.sec, stream.tls, stream.real);
    applyTransportToSingbox(out, stream);

    return out;
}

module.exports = { parseStream, outboundToLink, xrayToMihomo, xrayToSingbox };
