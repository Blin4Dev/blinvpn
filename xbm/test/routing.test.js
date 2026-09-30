'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const { buildRoutingRulesFromProfile } = require('../src/routing');

test('buildRoutingRulesFromProfile — null profile → null', () => {
    assert.strictEqual(buildRoutingRulesFromProfile(null, 'bal'), null);
});

test('buildRoutingRulesFromProfile — UDP 443 первым (QUIC block)', () => {
    const rules = buildRoutingRulesFromProfile({ RouteOrder: 'block-proxy-direct' }, 'bal');
    assert.strictEqual(rules[0].network, 'udp');
    assert.strictEqual(rules[0].port, '443');
    assert.strictEqual(rules[0].outboundTag, 'block');
});

test('buildRoutingRulesFromProfile — catch-all balancerTag в конце', () => {
    const rules = buildRoutingRulesFromProfile({ RouteOrder: 'block-proxy-direct' }, 'my-bal');
    const last = rules[rules.length - 1];
    assert.strictEqual(last.balancerTag, 'my-bal');
    assert.strictEqual(last.network, 'tcp,udp');
});

test('buildRoutingRulesFromProfile — block sites в правилах', () => {
    const profile = {
        RouteOrder: 'block-proxy-direct',
        BlockSites: ['geosite:malware', 'geosite:ads'],
    };
    const rules = buildRoutingRulesFromProfile(profile, 'b');
    const blockRule = rules.find(r => r.outboundTag === 'block' && Array.isArray(r.domain));
    assert.ok(blockRule);
    assert.deepStrictEqual(blockRule.domain, ['geosite:malware', 'geosite:ads']);
});

test('buildRoutingRulesFromProfile — proxy sites через balancerTag', () => {
    const profile = {
        RouteOrder: 'block-proxy-direct',
        ProxySites: ['geosite:youtube'],
    };
    const rules = buildRoutingRulesFromProfile(profile, 'mybal');
    const proxyRule = rules.find(r => r.balancerTag === 'mybal' && Array.isArray(r.domain));
    assert.ok(proxyRule);
    assert.deepStrictEqual(proxyRule.domain, ['geosite:youtube']);
});

test('buildRoutingRulesFromProfile — direct sites → outboundTag=direct', () => {
    const profile = {
        RouteOrder: 'block-proxy-direct',
        DirectSites: ['geosite:ru'],
        DirectIp: ['127.0.0.0/8'],
    };
    const rules = buildRoutingRulesFromProfile(profile, 'b');
    const dDomain = rules.find(r => r.outboundTag === 'direct' && Array.isArray(r.domain));
    const dIp = rules.find(r => r.outboundTag === 'direct' && Array.isArray(r.ip));
    assert.ok(dDomain);
    assert.ok(dIp);
    assert.deepStrictEqual(dDomain.domain, ['geosite:ru']);
    assert.deepStrictEqual(dIp.ip, ['127.0.0.0/8']);
});

test('buildRoutingRulesFromProfile — поддерживает DirectIP (capital P) — back-compat', () => {
    const profile = {
        RouteOrder: 'direct',
        DirectIP: ['10.0.0.0/8'],  // legacy field name
    };
    const rules = buildRoutingRulesFromProfile(profile, 'b');
    const dIp = rules.find(r => r.outboundTag === 'direct' && Array.isArray(r.ip));
    assert.ok(dIp);
    assert.deepStrictEqual(dIp.ip, ['10.0.0.0/8']);
});

test('buildRoutingRulesFromProfile — RouteOrder уважается', () => {
    // Если порядок direct-proxy-block, direct правила должны быть РАНЬШЕ proxy в массиве.
    const profile = {
        RouteOrder: 'direct-proxy-block',
        DirectSites: ['geosite:cn'],
        ProxySites: ['geosite:google'],
        BlockSites: ['geosite:ads'],
    };
    const rules = buildRoutingRulesFromProfile(profile, 'b');
    const directIdx = rules.findIndex(r => r.outboundTag === 'direct' && r.domain?.includes('geosite:cn'));
    const proxyIdx = rules.findIndex(r => r.balancerTag === 'b' && r.domain?.includes('geosite:google'));
    const blockIdx = rules.findIndex(r => r.outboundTag === 'block' && r.domain?.includes('geosite:ads'));
    assert.ok(directIdx > 0 && proxyIdx > directIdx && blockIdx > proxyIdx,
        `expected direct → proxy → block order, got idx ${directIdx} ${proxyIdx} ${blockIdx}`);
});
