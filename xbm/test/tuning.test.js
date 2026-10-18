'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Изолированный config с custom tuning параметрами.
function setupCustomConfig(overrides) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-test-'));
    const tmpConfig = path.join(tmpDir, 'config.json');
    fs.writeFileSync(tmpConfig, JSON.stringify({
        port: 4100,
        remnawave_url: 'http://localhost:3000',
        log_level: 'silent',
        groups: { 'TestGroup': ['Test'] },
        ...overrides,
    }));
    process.env.CONFIG_PATH = tmpConfig;
    for (const k of Object.keys(require.cache)) {
        if (k.includes('/src/') || k.includes('/test/helpers/')) delete require.cache[k];
    }
    return { tmpConfig, tmpDir };
}

test('tuning — http таймауты применяются из config', () => {
    setupCustomConfig({
        http_timeout_ms: 5000,
        http_max_redirects: 5,
        max_response_bytes: 5_000_000,
    });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.HTTP_FETCH_TIMEOUT_MS, 5000);
    assert.strictEqual(cfg.HTTP_FETCH_MAX_REDIRECTS, 5);
    assert.strictEqual(cfg.HTTP_FETCH_MAX_RESPONSE_BYTES, 5_000_000);
});

test('tuning — server таймауты применяются из config', () => {
    setupCustomConfig({
        server_keepalive_timeout_sec: 30,
        server_headers_timeout_sec: 35,
        server_request_timeout_sec: 60,
    });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.SERVER_KEEPALIVE_TIMEOUT_MS, 30_000);
    assert.strictEqual(cfg.SERVER_HEADERS_TIMEOUT_MS, 35_000);
    assert.strictEqual(cfg.SERVER_REQUEST_TIMEOUT_MS, 60_000);
});

test('tuning — cache настройки применяются из config', () => {
    setupCustomConfig({
        upstream_cache_max_entries: 1000,
        upstream_cache_cleanup_interval_sec: 120,
    });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.UPSTREAM_CACHE_MAX_ENTRIES, 1000);
    assert.strictEqual(cfg.UPSTREAM_CACHE_CLEANUP_INTERVAL_MS, 120_000);
});

test('tuning — sticky настройки применяются из config', () => {
    setupCustomConfig({
        sticky_flush_interval_sec: 60,
        sticky_hard_max_age_days: 7,
        sticky_max_tokens_in_memory: 50_000,
        sticky_in_memory_cleanup_interval_hours: 2,
    });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.STICKY_FLUSH_INTERVAL_MS_CFG, 60_000);
    assert.strictEqual(cfg.STICKY_HARD_MAX_AGE_MS_CFG, 7 * 24 * 3600 * 1000);
    assert.strictEqual(cfg.STICKY_MAX_TOKENS_IN_MEMORY, 50_000);
    assert.strictEqual(cfg.STICKY_IN_MEMORY_CLEANUP_INTERVAL_MS, 2 * 3600 * 1000);
});

test('tuning — балансер baseline настройки применяются', () => {
    setupCustomConfig({
        default_tier1_baseline_ms: 1000,
        default_tier2_baseline_ms: 3000,
        default_main_with_lte_baseline_ms: 1500,
        default_single_baseline_ms: 5000,
        default_lte_baseline_ms: 6000,
    });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.TIER1_BASELINE_MS, 1000);
    assert.strictEqual(cfg.TIER2_BASELINE_MS, 3000);
    assert.strictEqual(cfg.MAIN_WITH_LTE_BASELINE_MS, 1500);
    assert.strictEqual(cfg.SINGLE_BASELINE_MS, 5000);
    assert.strictEqual(cfg.LTE_BASELINE_MS, 6000);
});

test('tuning — node_load_threshold применяется из config', () => {
    setupCustomConfig({ node_load_threshold: 2.5 });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.NODE_LOAD_THRESHOLD, 2.5);
});

test('tuning — Mihomo/Sing-box tolerance применяются', () => {
    setupCustomConfig({
        mihomo_urltest_tolerance_ms: 100,
        singbox_urltest_tolerance_ms: 150,
    });
    const cfg = require('../src/config');
    assert.strictEqual(cfg.MIHOMO_URLTEST_TOLERANCE_MS_CFG, 100);
    assert.strictEqual(cfg.SINGBOX_URLTEST_TOLERANCE_MS_CFG, 150);
});

test('tuning — все параметры имеют разумные defaults без config override', () => {
    setupCustomConfig({});  // ничего не переопределяем
    const cfg = require('../src/config');

    // HTTP defaults
    assert.strictEqual(cfg.HTTP_FETCH_TIMEOUT_MS, 10_000);
    assert.strictEqual(cfg.HTTP_FETCH_MAX_REDIRECTS, 3);
    assert.strictEqual(cfg.HTTP_FETCH_MAX_RESPONSE_BYTES, 10 * 1024 * 1024);

    // Server timeouts
    assert.strictEqual(cfg.SERVER_KEEPALIVE_TIMEOUT_MS, 65_000);
    assert.strictEqual(cfg.SERVER_HEADERS_TIMEOUT_MS, 66_000);
    assert.strictEqual(cfg.SERVER_REQUEST_TIMEOUT_MS, 30_000);

    // Cache
    assert.strictEqual(cfg.UPSTREAM_CACHE_MAX_ENTRIES, 5000);

    // Sticky
    assert.strictEqual(cfg.STICKY_MAX_TOKENS_IN_MEMORY, 100_000);
    assert.strictEqual(cfg.STICKY_HARD_MAX_AGE_MS_CFG, 30 * 24 * 3600 * 1000);

    // Baselines
    assert.strictEqual(cfg.TIER1_BASELINE_MS, 1600);
    assert.strictEqual(cfg.TIER2_BASELINE_MS, 4000);
    assert.strictEqual(cfg.MAIN_WITH_LTE_BASELINE_MS, 2000);
    assert.strictEqual(cfg.SINGLE_BASELINE_MS, 4000);
    assert.strictEqual(cfg.LTE_BASELINE_MS, 4000);

    // Node-stats
    assert.strictEqual(cfg.NODE_LOAD_THRESHOLD, 1.0);

    // Mihomo/Sing-box tolerances
    assert.strictEqual(cfg.MIHOMO_URLTEST_TOLERANCE_MS_CFG, 50);
    assert.strictEqual(cfg.SINGBOX_URLTEST_TOLERANCE_MS_CFG, 50);
});

test('tuning — невалидный http_timeout_ms (отрицательный) → config валидация падает', () => {
    setupCustomConfig({ http_timeout_ms: -1 });
    let exited = false;
    const oe = process.exit; process.exit = (c) => { exited = c === 1; throw new Error('SIM_EXIT'); };
    const oc = console.error; console.error = () => {};
    try { require('../src/config'); } catch {}
    process.exit = oe; console.error = oc;
    assert.strictEqual(exited, true, 'config должен отвергать отрицательный http_timeout_ms');
});

test('tuning — невалидный node_load_threshold (0) → config валидация падает', () => {
    setupCustomConfig({ node_load_threshold: 0 });
    let exited = false;
    const oe = process.exit; process.exit = (c) => { exited = c === 1; throw new Error('SIM_EXIT'); };
    const oc = console.error; console.error = () => {};
    try { require('../src/config'); } catch {}
    process.exit = oe; console.error = oc;
    assert.strictEqual(exited, true, 'config должен отвергать node_load_threshold=0 (должно быть >0)');
});

test('tuning — баланcер xray.js использует config-driven baseline для main+LTE', () => {
    setupCustomConfig({
        default_main_with_lte_baseline_ms: 1234,
        default_lte_baseline_ms: 5678,
    });
    const cfg = require('../src/config');
    const gen = require('../src/generators');

    function mkOb(tag) {
        return {
            tag, protocol: 'vless',
            settings: { vnext: [{ address: '1.1.1.1', port: 443, users: [{ id: 'u', flow: '' }] }] },
            streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'a' } },
        };
    }

    const result = gen.buildGroupConfig(
        cfg.config, 'TestG',
        [mkOb('S1'), mkOb('S2')],         // main
        [mkOb('LTE-1'), mkOb('LTE-2')],   // LTE fallback
        null, null, null,
    );

    const mainBal = result.routing.balancers.find(b => b.tag === 'TestG-balancer');
    const lteBal = result.routing.balancers.find(b => b.tag === 'TestG-lte-balancer');

    assert.deepStrictEqual(mainBal.strategy.settings.baselines, ['1234ms']);
    assert.deepStrictEqual(lteBal.strategy.settings.baselines, ['5678ms']);
});
