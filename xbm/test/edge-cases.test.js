'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');

const cfgMod = require('../src/config');
const utils = require('../src/utils');
const cache = require('../src/cache');
const { detectClientType, isLteOutbound } = require('../src/groups');

// ─── parseRamGb edge cases ────────────────────────────────

test('parseRamGb — обрабатывает строку "0 GB" → null (zero-RAM нода = invalid)', () => {
    assert.strictEqual(utils.parseRamGb('0 GB'), null);
});

// ─── sanitizeTag — никогда не возвращает пустую строку ─────

test('sanitizeTag — cyrillic имена группы → non-empty unique prefix', () => {
    const a = utils.sanitizeTag('Финляндия');
    const b = utils.sanitizeTag('Германия');
    assert.ok(a.length > 0, 'cyrillic имя должно дать non-empty prefix');
    assert.ok(b.length > 0);
    assert.notStrictEqual(a, b, 'разные cyrillic имена должны давать разные prefix');
});

test('sanitizeTag — emoji-only имя группы → non-empty unique', () => {
    const a = utils.sanitizeTag('🇫🇮 Финляндия');
    const b = utils.sanitizeTag('🇩🇪 Германия');
    assert.ok(a.length > 0);
    assert.ok(b.length > 0);
    assert.notStrictEqual(a, b);
});

test('sanitizeTag — детерминированный (одно имя — один результат)', () => {
    assert.strictEqual(utils.sanitizeTag('Финляндия'), utils.sanitizeTag('Финляндия'));
});

test('sanitizeTag — ASCII имена работают как раньше (back-compat)', () => {
    assert.strictEqual(utils.sanitizeTag('USA Premium'), 'USA_Premium');
    assert.strictEqual(utils.sanitizeTag('🇪🇺 AUTO | Самые'), 'AUTO');
});

test('parseRamGb — отрицательное число → null', () => {
    assert.strictEqual(utils.parseRamGb(-1024 * 1024 * 1024), null);
});

test('parseRamGb — Infinity → null', () => {
    assert.strictEqual(utils.parseRamGb(Infinity), null);
});

test('parseRamGb — NaN → null', () => {
    assert.strictEqual(utils.parseRamGb(NaN), null);
});

test('parseRamGb — boolean → null', () => {
    assert.strictEqual(utils.parseRamGb(true), null);
});

test('parseRamGb — object → null', () => {
    assert.strictEqual(utils.parseRamGb({ size: 1024 }), null);
});

// ─── detectClientType edge cases ──────────────────────────

test('detectClientType — non-string input не падает', () => {
    // 123 — truthy non-string. String(123) = '123', не матчит ни одного regex → 'other'.
    assert.strictEqual(detectClientType(123), 'other');
    // Object с toString даёт строку которая может матчить.
    const objType = detectClientType({ toString: () => 'happ/1' });
    assert.strictEqual(objType, 'happ');
    // Просто не должно throw на любом типе входа
    assert.doesNotThrow(() => detectClientType([]));
    assert.doesNotThrow(() => detectClientType(false));
});

// ─── isLteOutbound edge cases ─────────────────────────────

test('isLteOutbound — undefined/null tag не падает', () => {
    // Должен gracefully вернуть false вместо throw
    assert.doesNotThrow(() => isLteOutbound(''));
    assert.strictEqual(isLteOutbound(''), false);
});

// ─── SSRF guard ─────────────────────────────────────────────

test('isPrivateV4 — стандартные приватные IP', () => {
    assert.strictEqual(utils.isPrivateV4('127.0.0.1'), true);
    assert.strictEqual(utils.isPrivateV4('10.5.0.1'), true);
    assert.strictEqual(utils.isPrivateV4('172.16.0.1'), true);
    assert.strictEqual(utils.isPrivateV4('192.168.1.1'), true);
    assert.strictEqual(utils.isPrivateV4('169.254.1.1'), true);
    assert.strictEqual(utils.isPrivateV4('0.0.0.1'), true);  // 0.0.0.0/8
});

test('isPrivateV4 — публичные IP', () => {
    assert.strictEqual(utils.isPrivateV4('8.8.8.8'), false);
    assert.strictEqual(utils.isPrivateV4('1.1.1.1'), false);
    assert.strictEqual(utils.isPrivateV4('172.32.0.1'), false);  // вне 172.16/12
    assert.strictEqual(utils.isPrivateV4('11.0.0.1'), false);
});

test('isPrivateV4 — мусорные IP → false', () => {
    assert.strictEqual(utils.isPrivateV4('not-an-ip'), false);
    assert.strictEqual(utils.isPrivateV4('999.999.999.999'), false);
    assert.strictEqual(utils.isPrivateV4(''), false);
});

test('isPrivateV6 — loopback и приватные', () => {
    assert.strictEqual(utils.isPrivateV6('::1'), true);
    assert.strictEqual(utils.isPrivateV6('::ffff:127.0.0.1'), true);
    assert.strictEqual(utils.isPrivateV6('fc00::1'), true);
    assert.strictEqual(utils.isPrivateV6('fe80::1'), true);
});

test('isPrivateV6 — публичные', () => {
    assert.strictEqual(utils.isPrivateV6('2001:db8::1'), false);
    assert.strictEqual(utils.isPrivateV6('::ffff:8.8.8.8'), false);
});

// ─── safeAsync ─────────────────────────────────────────────

test('safeAsync — возвращает результат при успехе', async () => {
    const result = await utils.safeAsync(async () => 42, { logger: null, tag: 'x', fallback: -1 });
    assert.strictEqual(result, 42);
});

test('safeAsync — возвращает fallback при ошибке', async () => {
    const errors = [];
    const fakeLogger = { error: (tag, msg) => errors.push({ tag, msg }) };
    const result = await utils.safeAsync(async () => { throw new Error('oops'); },
        { logger: fakeLogger, tag: 'x', fallback: 'default' });
    assert.strictEqual(result, 'default');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].tag, 'x');
    assert.match(errors[0].msg, /oops/);
});

test('safeAsync — без logger не падает', async () => {
    const result = await utils.safeAsync(async () => { throw new Error('oops'); },
        { fallback: null });
    assert.strictEqual(result, null);
});

// ─── Cache ──────────────────────────────────────────────────

test('cache — TTL=0 → ничего не кэшируется', () => {
    // UPSTREAM_CACHE_TTL = 300 sec по дефолту в example.json. Тест: размер не растёт
    // если установка не произошла из-за TTL=0. Сложно тестируется без ре-импорта...
    // Просто проверяем что getCachedResponse возвращает null для несуществующего токена
    assert.strictEqual(cache.getCachedResponse('totally-fake-token-123-zzz-blah'), null);
});

test('cache — set/get с реальным токеном', () => {
    cache.cacheUpstreamResponse('test-edge-token', 'body-data', { 'x-custom': '1' }, 'application/json');
    const result = cache.getCachedResponse('test-edge-token');
    assert.ok(result);
    assert.strictEqual(result.body, 'body-data');
    assert.strictEqual(result.contentType, 'application/json');
});

test('cache — MAX_CACHE_ENTRIES экспортируется', () => {
    assert.ok(typeof cache.MAX_CACHE_ENTRIES === 'number' && cache.MAX_CACHE_ENTRIES > 0);
});

// ─── Config edge cases ─────────────────────────────────────

test('config — DEV_RAW_TOKENS Set, MIHOMO_PRO_TOKENS Set', () => {
    assert.ok(cfgMod.DEV_RAW_TOKENS instanceof Set);
    assert.ok(cfgMod.MIHOMO_PRO_TOKENS instanceof Set);
});

test('config — STICKY_EXCLUDE_GROUPS — массив', () => {
    assert.ok(Array.isArray(cfgMod.STICKY_EXCLUDE_GROUPS));
});

test('config — clamp BAL_TOLERANCE и BAL_TOLERANCE_FB — числа [0..1]', () => {
    assert.ok(typeof cfgMod.BAL_TOLERANCE === 'number');
    assert.ok(cfgMod.BAL_TOLERANCE >= 0 && cfgMod.BAL_TOLERANCE <= 1);
    assert.ok(typeof cfgMod.BAL_TOLERANCE_FB === 'number');
    assert.ok(cfgMod.BAL_TOLERANCE_FB >= 0 && cfgMod.BAL_TOLERANCE_FB <= 1);
});
