'use strict';

/**
 * [BlinVPN] Сквозной тест настроек из панели: поддельная Remnawave отдаёт XRAY_JSON,
 * XBM запускается отдельным процессом с panel.json — проверяем, что получает клиент.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOSTS = [
    ['🇩🇪 Германия 1', '10.0.0.1'],
    ['🇩🇪 Германия 2', '10.0.0.2'],
    ['🇳🇱 Нидерланды', '10.0.0.3'],
    ['🇷🇺 Москва', '10.0.0.4'],            // «белые списки» — без особого слова в названии
    ['🇫🇮 Тестовый', '10.0.0.5'],          // исключён из авто-выбора
];

function xrayConfig(remarks, addr) {
    return {
        remarks,
        meta: { serverDescription: `desc ${remarks}` },
        dns: { servers: ['1.1.1.1'] },
        inbounds: [{ tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true } }],
        outbounds: [
            {
                tag: 'proxy', protocol: 'vless',
                settings: { vnext: [{ address: addr, port: 443, users: [{ id: '11111111-1111-1111-1111-111111111111', encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
                streamSettings: { network: 'tcp', security: 'reality', realitySettings: { serverName: 'ya.ru', publicKey: 'pk', shortId: 'ab', fingerprint: 'chrome' } },
            },
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
        routing: { domainStrategy: 'IPIfNonMatch', rules: [{ type: 'field', domain: ['geosite:ru'], outboundTag: 'direct' }] },
    };
}

function freePort() {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

function get(port, p, ua) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': ua } }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('panel.json: локации, белые списки, исключения, имя авто-выбора — на лету', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbm-panel-'));
    const panelPath = path.join(dir, 'panel.json');
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
        port: 0, log_level: 'silent', strategy: 'leastLoad', probe_interval: '3m', probe_sampling: 1, probe_timeout: '1s',
        node_stats: false, rate_limit: { max: 0, window_sec: 60 }, upstream_cache_ttl_sec: 0,
        fastest_group: true, auto_group_name: 'AUTO из config', auto_host_groups: true, lte_patterns: [], groups: {},
    }));
    const write = (obj) => {
        const tmp = panelPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, panelPath);
    };
    write({
        version: 1,
        auto_group_name: '🇪🇺 Автоматический выбор',
        reserve_tags: ['🇷🇺 Москва'],
        auto_exclude_tags: ['🇫🇮 Тестовый'],
        groups: [{ name: '🇩🇪 Германия', tags: ['🇩🇪 Германия 1', '🇩🇪 Германия 2'], description: 'Две ноды, меньше пинг' }],
    });

    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(HOSTS.map(([r, a]) => xrayConfig(r, a))));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    t.after(() => upstream.close());

    const port = await freePort();
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, CONFIG_PATH: cfgPath, PANEL_CONFIG_PATH: panelPath, PORT: String(port),
               REMNAWAVE_URL: `http://127.0.0.1:${upstream.address().port}`, SUB_PAGE_URL: '', LOG_LEVEL: 'error' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    for (let i = 0; i < 50; i++) {
        try { if ((await get(port, '/health', 'x')).status === 200) break; } catch { /* ещё стартует */ }
        await sleep(100);
    }

    // ── Happ: Xray JSON ──
    let r = await get(port, '/abcdef123', 'Happ/1.0');
    assert.strictEqual(r.status, 200);
    let cfgs = JSON.parse(r.body);
    const names = cfgs.map((c) => c.remarks);
    assert.deepStrictEqual(names, ['🇪🇺 Автоматический выбор', '🇩🇪 Германия', '🇳🇱 Нидерланды', '🇷🇺 Москва', '🇫🇮 Тестовый']);

    // Германия — одна локация из двух нод с описанием из панели
    const de = cfgs[1];
    const deProxies = de.outbounds.filter((o) => o.protocol === 'vless').map((o) => o.tag);
    assert.deepStrictEqual(deProxies.sort(), ['🇩🇪 Германия 1', '🇩🇪 Германия 2']);
    assert.strictEqual(de.meta.serverDescription, 'Две ноды, меньше пинг');

    // Авто-выбор: без «Тестового», Москва — только резерв (fallback), не в основном пуле
    const auto = cfgs[0];
    const autoProxies = auto.outbounds.filter((o) => o.protocol === 'vless').map((o) => o.tag);
    assert.ok(!autoProxies.includes('🇫🇮 Тестовый'), 'исключённый хост не должен попасть в авто-выбор');
    assert.ok(autoProxies.includes('🇷🇺 Москва'), 'белые списки есть в авто-выборе как резерв');
    const balancers = auto.routing.balancers || [];
    // каскад: основные → (если никто не отвечает) белые списки → все сразу
    const main = balancers.find((b) => /-balancer$/.test(b.tag) && !/-(lte|all|tier2|sticky)-balancer$/.test(b.tag));
    assert.ok(main, 'есть основной балансер');
    assert.ok(main.selector.includes('🇳🇱 Нидерланды') && !main.selector.includes('🇷🇺 Москва'), 'белые списки не в основном балансере');
    const reserve = balancers.find((b) => /-lte-balancer$/.test(b.tag));
    assert.deepStrictEqual(reserve && reserve.selector, ['🇷🇺 Москва'], 'белые списки — отдельный резервный балансер');
    assert.ok(main.fallbackTag, 'у основного есть переход на резерв');

    // ── Clash (Mihomo) ──
    r = await get(port, '/abcdef123', 'clash-verge/1.0');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('🇪🇺 Автоматический выбор · резерв'), 'в Clash есть резервная группа');
    const autoLine = r.body.split('\n').find((l) => l.includes('"name":"🇪🇺 Автоматический выбор","type":"fallback"'));
    assert.ok(autoLine, 'авто-выбор в Clash — fallback между основными и резервом');
    const mainLine = r.body.split('\n').find((l) => l.includes('"name":"🇪🇺 Автоматический выбор · основные"'));
    assert.ok(mainLine && !mainLine.includes('Тестовый') && !mainLine.includes('Москва'));

    // ── Sing-box: белые списки и исключённые не в авто-выборе ──
    r = await get(port, '/abcdef123', 'sfa/1.0');
    const sb = JSON.parse(r.body);
    const sbAuto = sb.outbounds.find((o) => o.tag === '🇪🇺 Автоматический выбор');
    assert.ok(sbAuto && !sbAuto.outbounds.includes('🇷🇺 Москва') && !sbAuto.outbounds.includes('🇫🇮 Тестовый'));

    // ── Меняем настройки в панели — XBM подхватывает без перезапуска ──
    await sleep(1100);  // mtime должен измениться
    write({ version: 1, auto_group_name: 'Лучший сервер', reserve_tags: [], auto_exclude_tags: [], groups: [] });
    await sleep(2300);
    r = await get(port, '/abcdef123', 'Happ/1.0');
    cfgs = JSON.parse(r.body);
    assert.strictEqual(cfgs[0].remarks, 'Лучший сервер');
    assert.ok(cfgs.map((c) => c.remarks).includes('🇩🇪 Германия 1'), 'группа убрана — хосты снова отдельными строками');

    // ── Битый файл не ломает подписку: остаются прежние настройки ──
    await sleep(1100);
    fs.writeFileSync(panelPath, '{broken');
    await sleep(2300);
    r = await get(port, '/abcdef123', 'Happ/1.0');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body)[0].remarks, 'Лучший сервер');

    // ── Файл удалён — работаем по config.json ──
    fs.unlinkSync(panelPath);
    await sleep(2300);
    r = await get(port, '/abcdef123', 'Happ/1.0');
    assert.strictEqual(JSON.parse(r.body)[0].remarks, 'AUTO из config');
});

test('v2: пользователям видны только хосты из панели, порядок и шаблоны из панели', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbm-panel2-'));
    const panelPath = path.join(dir, 'panel.json');
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, fs.readFileSync(path.resolve(__dirname, '..', 'config.json')));
    const tpl = {
        log: { loglevel: 'warning' },
        dns: { servers: ['9.9.9.9'] },
        inbounds: [{ tag: 'socks', port: 20808, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true } }],
        routing: { domainStrategy: 'IPIfNonMatch', rules: [{ type: 'field', domain: ['domain:gemini.google.com'], outboundTag: 'proxy' }, { type: 'field', domain: ['geosite:category-ru'], outboundTag: 'direct' }] },
    };
    fs.writeFileSync(panelPath, JSON.stringify({
        version: 2, only_groups: true, auto_group_name: '🌍 Авто',
        reserve_tags: ['🇷🇺 Москва'], auto_exclude_tags: [],
        groups: [
            { name: '🇳🇱 Нидерланды', tags: ['🇳🇱 Нидерланды'], description: 'Работает Gemini', template: tpl },
            { name: '🇷🇺 Белые списки', tags: ['🇷🇺 Москва'] },
            { name: '🇩🇪 Германия', tags: ['🇩🇪 Германия 1', '🇩🇪 Германия 2'] },
        ],
    }));
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(HOSTS.map(([r, a]) => xrayConfig(r, a))));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    t.after(() => upstream.close());
    const port = await freePort();
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, CONFIG_PATH: cfgPath, PANEL_CONFIG_PATH: panelPath, PORT: String(port),
               REMNAWAVE_URL: `http://127.0.0.1:${upstream.address().port}`, SUB_PAGE_URL: '', LOG_LEVEL: 'error' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    for (let i = 0; i < 50; i++) {
        try { if ((await get(port, '/health', 'x')).status === 200) break; } catch { /* стартует */ }
        await sleep(100);
    }
    const cfgs = JSON.parse((await get(port, '/tok12345', 'Happ/1.0')).body);
    // Только авто-выбор + хосты панели, в порядке панели; «🇫🇮 Тестовый» не виден, но работает в авто-выборе
    assert.deepStrictEqual(cfgs.map((c) => c.remarks), ['🌍 Авто', '🇳🇱 Нидерланды', '🇷🇺 Белые списки', '🇩🇪 Германия']);
    const autoTags = cfgs[0].outbounds.filter((o) => o.protocol === 'vless').map((o) => o.tag);
    assert.ok(autoTags.includes('🇫🇮 Тестовый'), 'нераспределённый хост участвует в авто-выборе');
    const lte = (cfgs[0].routing.balancers || []).find((b) => /-lte-balancer$/.test(b.tag));
    assert.deepStrictEqual(lte.selector, ['🇷🇺 Москва'], 'белые списки — резерв авто-выбора');
    // Шаблон из панели: DNS, инбаунды, правила; сервер — со своими настройками
    const nl = cfgs[1];
    assert.deepStrictEqual(nl.dns.servers, ['9.9.9.9']);
    assert.strictEqual(nl.inbounds[0].port, 20808);
    assert.strictEqual(nl.meta.serverDescription, 'Работает Gemini');
    const nlRules = JSON.stringify(nl.routing.rules);
    assert.ok(nlRules.includes('gemini.google.com') && nlRules.includes('category-ru'), 'правила из шаблона');
    const nlOut = nl.outbounds.find((o) => o.protocol === 'vless');
    assert.strictEqual(nlOut.settings.vnext[0].address, '10.0.0.3');
    assert.strictEqual(nlOut.streamSettings.realitySettings.serverName, 'ya.ru');
    // Без шаблона — Xray JSON своего хоста (как в Remnawave)
    assert.deepStrictEqual(cfgs[3].dns.servers, ['1.1.1.1']);
    // Clash: в выборе только авто + хосты панели
    const clash = (await get(port, '/tok12345', 'clash-verge/1.0')).body;
    const sel = clash.split('\n').find((l) => l.includes('"type":"select"'));
    assert.ok(sel.includes('🌍 Авто') && sel.includes('🇩🇪 Германия') && !sel.includes('🇫🇮 Тестовый'), sel);
    // хост панели из одного сервера — под названием из панели, а не «🇷🇺 Москва» из Remnawave
    assert.ok(sel.includes('🇷🇺 Белые списки') && !sel.includes('"🇷🇺 Москва"'), sel);
    const sb = JSON.parse((await get(port, '/tok12345', 'sfa/1.0')).body);
    const sbSel = sb.outbounds.find((o) => o.tag === 'proxy-out');
    assert.ok(sbSel.outbounds.includes('🇷🇺 Белые списки') && !sbSel.outbounds.includes('🇷🇺 Москва'), JSON.stringify(sbSel));
    // хост панели назван так же, как хост Remnawave («🇳🇱 Нидерланды»): в Clash без «⚡», и это одна группа
    assert.ok(sel.includes('"🇳🇱 Нидерланды"') && !sel.includes('Нидерланды ⚡'), sel);
    assert.ok(clash.includes('"name":"🇳🇱 Нидерланды","type":"url-test","proxies":["🇳🇱 Нидерланды · 2"]'), 'группа из переименованного хоста');
});

test('normalize: мусор и лимиты', () => {
    process.env.LOG_LEVEL = 'silent';
    require('./helpers/setup-env');
    const { normalize } = require('../src/panel-config');
    const s = normalize({
        auto_group_name: '  X\u0000Y  ',
        reserve_tags: ['a', 'a', 5, null, 'b'],
        groups: [{ name: 'G', tags: [] }, { name: 'G2', tags: ['a'] }, { name: 'G2', tags: ['b'] }, { tags: ['c'] }],
    });
    assert.strictEqual(s.autoGroupName, 'XY');
    assert.deepStrictEqual([...s.reserve], ['a', 'b']);
    assert.deepStrictEqual(s.groups.map((g) => g.name), ['G2']);
    assert.throws(() => normalize([]));
    assert.throws(() => normalize('x'));
});
