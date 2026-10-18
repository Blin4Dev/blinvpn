'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');

const cfgMod = require('../src/config');
const gen = require('../src/generators');

function mkOutbound(tag) {
    return {
        tag,
        protocol: 'vless',
        settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: 'u', flow: '' }] }] },
        streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: { serverName: 'a', publicKey: 'x', fingerprint: 'chrome', shortId: '01' },
        },
    };
}

test('isFakeConfig — true когда все outbounds на 0.0.0.0:1', () => {
    const fake = [{
        outbounds: [
            { protocol: 'vless', tag: 'a', settings: { vnext: [{ address: '0.0.0.0', port: 1, users: [{ id: 'u' }] }] } },
        ],
    }];
    assert.strictEqual(gen.isFakeConfig(fake), true);
});

test('isFakeConfig — false когда есть нормальные outbounds', () => {
    const ok = [{
        outbounds: [
            { protocol: 'vless', tag: 'a', settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: 'u' }] }] } },
        ],
    }];
    assert.strictEqual(gen.isFakeConfig(ok), false);
});

test('buildGroupConfig — single балансер для не-tier группы', () => {
    cfgMod.config.group_tiers = {};
    const out = gen.buildGroupConfig(cfgMod.config, '🇫🇮 Finland', [
        mkOutbound('Finland 1'), mkOutbound('Finland 2'), mkOutbound('Finland 3'),
    ], null, null, null);
    assert.strictEqual(out.routing.balancers.length, 1);
    assert.strictEqual(out.routing.balancers[0].tag, 'Finland-balancer');
    assert.strictEqual(out.routing.balancers[0].selector.length, 3);
});

test('buildGroupConfig — tier-mode 3-уровневый каскад (sticky → tier1 → tier2 → all)', () => {
    cfgMod.config.group_tiers = { 'TestT': { tier1_count: 3, tier1_baseline_ms: 2000, tier2_baseline_ms: 4000 } };
    const tags = ['A1', 'A2', 'A3', 'B4', 'B5', 'B6'];
    const out = gen.buildGroupConfig(cfgMod.config, 'TestT', tags.map(mkOutbound), null, null, null, 'A1');
    const balNames = out.routing.balancers.map(b => b.tag);
    assert.ok(balNames.includes('TestT-sticky-balancer'));
    assert.ok(balNames.includes('TestT-balancer'));
    assert.ok(balNames.includes('TestT-tier2-balancer'));
    assert.ok(balNames.includes('TestT-all-balancer'));
});

test('buildGroupConfig — all-balancer без baselines (last resort)', () => {
    cfgMod.config.group_tiers = { 'TestT2': { tier1_count: 2 } };
    const tags = ['A1', 'A2', 'B3', 'B4'];
    const out = gen.buildGroupConfig(cfgMod.config, 'TestT2', tags.map(mkOutbound), null, null, null, 'A1');
    const all = out.routing.balancers.find(b => b.tag === 'TestT2-all-balancer');
    assert.ok(all);
    assert.strictEqual(all.strategy.settings.baselines, undefined,
        'all-balancer must NOT have baselines (it is last resort)');
    assert.strictEqual(all.selector.length, tags.length);
});

test('buildGroupConfig — sticky-balancer fallback идёт через loopback (canonical Xray pattern)', () => {
    cfgMod.config.group_tiers = {};
    const out = gen.buildGroupConfig(cfgMod.config, 'TestT3', [
        mkOutbound('S1'), mkOutbound('S2'),
    ], null, null, null, 'S1');

    const sticky = out.routing.balancers.find(b => b.tag === 'TestT3-sticky-balancer');
    assert.ok(sticky, 'sticky-balancer должен быть создан');
    assert.strictEqual(sticky.selector.length, 1);
    assert.strictEqual(sticky.selector[0], 'S1');

    // fallbackTag в Xray-core принимает только OUTBOUND tag (не balancer tag).
    // Поэтому каскад делается через loopback outbound: sticky.fallbackTag → loopback
    // → routing rule с inboundTag → main-balancer.
    const fallbackTag = sticky.fallbackTag;
    assert.ok(fallbackTag, 'sticky должен иметь fallbackTag');
    const fallbackOutbound = out.outbounds.find(o => o.tag === fallbackTag);
    assert.ok(fallbackOutbound, `fallbackTag "${fallbackTag}" должен указывать на существующий outbound`);
    assert.strictEqual(fallbackOutbound.protocol, 'loopback', 'fallback должен быть loopback outbound');

    // Этот loopback должен направлять трафик в main-balancer через routing rule.
    const lbInboundTag = fallbackOutbound.settings.inboundTag;
    const reinjectRule = out.routing.rules.find(r =>
        Array.isArray(r.inboundTag) && r.inboundTag.includes(lbInboundTag)
    );
    assert.ok(reinjectRule, 'должно быть routing rule с inboundTag матчем для loopback');
    assert.strictEqual(reinjectRule.balancerTag, 'TestT3-balancer', 'reinject правило → main-balancer');

    // sticky-balancer baseline = STICKY_THRESHOLD_MS из конфига
    assert.deepStrictEqual(sticky.strategy.settings.baselines, [`${cfgMod.STICKY_THRESHOLD_MS}ms`]);
});

test('buildGroupConfig — без stickyTag и без tier-mode = только один balancer', () => {
    cfgMod.config.group_tiers = {};
    const out = gen.buildGroupConfig(cfgMod.config, 'PlainGroup', [
        mkOutbound('a'), mkOutbound('b'),
    ], null, null, null);
    assert.strictEqual(out.routing.balancers.length, 1);
});

test('buildGroupConfig — burstObservatory.sampling берётся из config', () => {
    cfgMod.config.group_tiers = {};
    const out = gen.buildGroupConfig(cfgMod.config, 'O', [mkOutbound('a')], null, null, null);
    assert.strictEqual(out.burstObservatory.pingConfig.sampling, cfgMod.PROBE_SAMPLING);
});

test('collectAllProxyOutbounds — фильтрует системные protocols', () => {
    const cfgs = [
        {
            remarks: 'X',
            outbounds: [
                { tag: 'real', protocol: 'vless', settings: {} },
                { tag: 'd', protocol: 'freedom' },
                { tag: 'b', protocol: 'blackhole' },
                { tag: 'dns', protocol: 'dns' },
            ],
        },
    ];
    const result = gen.collectAllProxyOutbounds(cfgs);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tag, 'real');
});
