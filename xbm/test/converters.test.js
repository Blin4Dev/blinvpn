'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const { outboundToLink, xrayToMihomo, xrayToSingbox, parseStream } = require('../src/converters');

function vlessOb({
    tag = 'srv', address = '1.2.3.4', port = 443, uuid = 'abc-uuid',
    flow = 'xtls-rprx-vision', security = 'reality', sni = 'example.com',
    publicKey = 'PK', shortId = '01', fingerprint = 'chrome', network = 'tcp',
} = {}) {
    return {
        tag, protocol: 'vless',
        settings: { vnext: [{ address, port, users: [{ id: uuid, flow }] }] },
        streamSettings: {
            network, security,
            realitySettings: security === 'reality'
                ? { serverName: sni, publicKey, shortId, fingerprint }
                : undefined,
            tlsSettings: security === 'tls'
                ? { serverName: sni, fingerprint }
                : undefined,
        },
    };
}

test('outboundToLink — vless reality format', () => {
    const link = outboundToLink(vlessOb({ tag: 'A' }), 'A');
    assert.match(link, /^vless:\/\/abc-uuid@1\.2\.3\.4:443\?/);
    assert.match(link, /security=reality/);
    assert.match(link, /pbk=PK/);
    assert.match(link, /fp=chrome/);
    assert.match(link, /flow=xtls-rprx-vision/);
    assert.match(link, /#A$/);
});

test('outboundToLink — vless tls format', () => {
    const ob = vlessOb({ tag: 'B', security: 'tls', flow: '' });
    const link = outboundToLink(ob, 'B');
    assert.match(link, /security=tls/);
    assert.match(link, /sni=example\.com/);
});

test('outboundToLink — vmess base64 form', () => {
    const ob = {
        tag: 'V', protocol: 'vmess',
        settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: 'u', alterId: 0 }] }] },
        streamSettings: { network: 'ws', security: 'tls',
            tlsSettings: { serverName: 'a.com' },
            wsSettings: { path: '/ws', headers: { Host: 'a.com' } } },
    };
    const link = outboundToLink(ob, 'V');
    assert.match(link, /^vmess:\/\//);
    const base64 = link.slice('vmess://'.length);
    const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    assert.strictEqual(decoded.add, '1.2.3.4');
    assert.strictEqual(decoded.id, 'u');
    assert.strictEqual(decoded.net, 'ws');
});

test('outboundToLink — trojan', () => {
    const ob = {
        tag: 'T', protocol: 'trojan',
        settings: { servers: [{ address: '1.2.3.4', port: 443, password: 'pass' }] },
        streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'a' } },
    };
    const link = outboundToLink(ob, 'T');
    assert.match(link, /^trojan:\/\/pass@1\.2\.3\.4:443\?/);
    assert.match(link, /security=tls/);
});

test('outboundToLink — shadowsocks', () => {
    const ob = {
        tag: 'S', protocol: 'shadowsocks',
        settings: { servers: [{ address: '1.2.3.4', port: 8388, method: 'aes-256-gcm', password: 'pw' }] },
        streamSettings: {},
    };
    const link = outboundToLink(ob, 'S');
    assert.match(link, /^ss:\/\//);
    const userPart = link.slice('ss://'.length).split('@')[0];
    const decoded = Buffer.from(userPart, 'base64').toString('utf8');
    assert.strictEqual(decoded, 'aes-256-gcm:pw');
});

test('outboundToLink — невалидный protocol → null', () => {
    assert.strictEqual(outboundToLink({ protocol: 'unknown', settings: {}, streamSettings: {} }), null);
});

test('xrayToMihomo — vless reality', () => {
    const proxy = xrayToMihomo(vlessOb({ tag: 'A' }));
    assert.strictEqual(proxy.type, 'vless');
    assert.strictEqual(proxy.server, '1.2.3.4');
    assert.strictEqual(proxy.tls, true);
    assert.strictEqual(proxy.servername, 'example.com');
    assert.strictEqual(proxy['client-fingerprint'], 'chrome');
    assert.deepStrictEqual(proxy['reality-opts'], { 'public-key': 'PK', 'short-id': '01' });
});

test('xrayToMihomo — vmess', () => {
    const ob = {
        tag: 'V', protocol: 'vmess',
        settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: 'u', alterId: 0 }] }] },
        streamSettings: { network: 'ws', security: 'tls',
            tlsSettings: { serverName: 'a' },
            wsSettings: { path: '/p' } },
    };
    const proxy = xrayToMihomo(ob);
    assert.strictEqual(proxy.type, 'vmess');
    assert.strictEqual(proxy.network, 'ws');
    assert.deepStrictEqual(proxy['ws-opts'], { path: '/p' });
});

test('xrayToMihomo — невалидный outbound → null', () => {
    assert.strictEqual(xrayToMihomo({ protocol: 'vless', settings: {}, streamSettings: {} }), null);
});

test('xrayToSingbox — vless reality', () => {
    const out = xrayToSingbox(vlessOb({ tag: 'A' }));
    assert.strictEqual(out.type, 'vless');
    assert.strictEqual(out.server, '1.2.3.4');
    assert.strictEqual(out.uuid, 'abc-uuid');
    assert.ok(out.tls.enabled);
    assert.ok(out.tls.reality?.enabled);
    assert.strictEqual(out.tls.reality.public_key, 'PK');
});

test('xrayToSingbox — trojan', () => {
    const ob = {
        tag: 'T', protocol: 'trojan',
        settings: { servers: [{ address: '1.2.3.4', port: 443, password: 'pwd' }] },
        streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'x' } },
    };
    const out = xrayToSingbox(ob);
    assert.strictEqual(out.type, 'trojan');
    assert.strictEqual(out.password, 'pwd');
});

test('parseStream — извлекает все streamSettings секции', () => {
    const st = {
        network: 'ws', security: 'tls',
        tlsSettings: { fingerprint: 'firefox' },
        wsSettings: { path: '/ws' },
    };
    const r = parseStream(st);
    assert.strictEqual(r.net, 'ws');
    assert.strictEqual(r.sec, 'tls');
    assert.deepStrictEqual(r.tls, { fingerprint: 'firefox' });
    assert.deepStrictEqual(r.ws, { path: '/ws' });
});
