'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Изолированный config с custom auto_group_name.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-name-test-'));
const tmpConfig = path.join(tmpDir, 'config.json');
fs.writeFileSync(tmpConfig, JSON.stringify({
    port: 4100,
    remnawave_url: 'http://localhost:3000',
    log_level: 'silent',
    auto_group_name: '⚡ FAST',
    groups: { '🇫🇮 Finland': ['Finland'] },
}));

// Принудительно перезагружаем все модули с новым CONFIG_PATH.
process.env.CONFIG_PATH = tmpConfig;
for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/') || k.includes('/test/helpers/')) delete require.cache[k];
}

const cfg = require('../src/config');
const gen = require('../src/generators');

function mkOb(tag) {
    return {
        tag, protocol: 'vless',
        settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: 'u', flow: '' }] }] },
        streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'a' } },
    };
}

test('auto_group_name — config override применяется в config.AUTO_GROUP_NAME', () => {
    assert.strictEqual(cfg.AUTO_GROUP_NAME, '⚡ FAST');
});

test('auto_group_name — попадает в STICKY_EXCLUDE_GROUPS по умолчанию', () => {
    // Когда юзер не задал sticky_exclude_groups, дефолт = [AUTO_GROUP_NAME] из config
    assert.ok(cfg.STICKY_EXCLUDE_GROUPS.includes('⚡ FAST'));
});

test('auto_group_name — buildGroupConfig использует custom имя для prefix', () => {
    const result = gen.buildGroupConfig(
        cfg.config, cfg.AUTO_GROUP_NAME,
        [mkOb('S1'), mkOb('S2')],
        null, null, null,
    );
    assert.ok(result, 'config должен сгенериться');
    assert.strictEqual(result.remarks, '⚡ FAST');
    // prefix берётся через sanitizeTag('⚡ FAST') → 'FAST' (вырезает emoji)
    const balancer = result.routing.balancers[0];
    assert.match(balancer.tag, /FAST/, 'balancer tag должен содержать имя группы');
});

test('auto_group_name — Mihomo YAML использует custom имя как proxy-group', () => {
    const profile = { Name: 'test', RouteOrder: 'block-proxy-direct', BlockSites: [], BlockIp: [],
        ProxySites: [], ProxyIp: [], DirectSites: [], DirectIp: [] };
    const grouped = { '🇫🇮 Finland': [mkOb('Finland-1'), mkOb('Finland-2')] };
    const allObs = [mkOb('Finland-1'), mkOb('Finland-2')];
    const yaml = gen.generateMihomoYaml(grouped, ['🇫🇮 Finland'], allObs, profile);
    assert.ok(yaml.includes('"name":"⚡ FAST"'), 'YAML должен содержать AUTO группу с custom именем');
});

test('auto_group_name — Sing-box JSON использует custom имя как urltest tag', () => {
    const profile = { Name: 'test', RouteOrder: 'block-proxy-direct', BlockSites: [], BlockIp: [],
        ProxySites: [], ProxyIp: [], DirectSites: [], DirectIp: [] };
    const grouped = { '🇫🇮 Finland': [mkOb('Finland-1'), mkOb('Finland-2')] };
    const allObs = [mkOb('Finland-1'), mkOb('Finland-2')];
    const sb = gen.generateSingboxConfig(grouped, ['🇫🇮 Finland'], allObs, profile);
    const autoGroup = sb.outbounds.find(o => o.tag === '⚡ FAST');
    assert.ok(autoGroup, 'Sing-box должен содержать AUTO группу с custom именем');
    assert.strictEqual(autoGroup.type, 'urltest');
});

// Cleanup
test('cleanup tmp dir', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
