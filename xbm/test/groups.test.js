'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const { getTier1Tags, detectClientType, isLteOutbound, matchGroup } = require('../src/groups');

const lteTags = [
    '🇪🇺 ЕВРОПА 1 | LTE',
    '🇪🇺 ЕВРОПА 10 | LTE',
    '🇪🇺 ЕВРОПА 2 | LTE',
    '🇪🇺 ЕВРОПА 3 | LTE',
    '🇪🇺 ЕВРОПА 4 | LTE',
    '🇪🇺 ЕВРОПА 5 | LTE',
];

test('getTier1Tags — patterns mode (back-compat)', () => {
    const r = getTier1Tags(lteTags, { tier1_patterns: ['ЕВРОПА 1 ', 'ЕВРОПА 2 '] });
    assert.deepStrictEqual(r, ['🇪🇺 ЕВРОПА 1 | LTE', '🇪🇺 ЕВРОПА 2 | LTE']);
});

test('getTier1Tags — count mode picks 3 by natural sort', () => {
    const r = getTier1Tags(lteTags, { tier1_count: 3 });
    assert.deepStrictEqual(r, [
        '🇪🇺 ЕВРОПА 1 | LTE',
        '🇪🇺 ЕВРОПА 2 | LTE',
        '🇪🇺 ЕВРОПА 3 | LTE',
    ]);
});

test('getTier1Tags — count mode does NOT put ЕВРОПА 10 in tier1', () => {
    const r = getTier1Tags(lteTags, { tier1_count: 3 });
    assert.ok(!r.includes('🇪🇺 ЕВРОПА 10 | LTE'), 'ЕВРОПА 10 should not be in tier1 of count=3');
});

test('getTier1Tags — count > tags returns all', () => {
    const r = getTier1Tags(lteTags, { tier1_count: 100 });
    assert.strictEqual(r.length, lteTags.length);
});

test('getTier1Tags — null config returns null', () => {
    assert.strictEqual(getTier1Tags(lteTags, null), null);
    assert.strictEqual(getTier1Tags(lteTags, undefined), null);
    assert.strictEqual(getTier1Tags(lteTags, {}), null);
});

test('getTier1Tags — patterns wins over count when both set', () => {
    const r = getTier1Tags(lteTags, { tier1_patterns: ['ЕВРОПА 1 '], tier1_count: 5 });
    assert.deepStrictEqual(r, ['🇪🇺 ЕВРОПА 1 | LTE']);
});

test('getTier1Tags — empty patterns array → falls through to count if set', () => {
    const r = getTier1Tags(lteTags, { tier1_patterns: [], tier1_count: 2 });
    assert.deepStrictEqual(r, ['🇪🇺 ЕВРОПА 1 | LTE', '🇪🇺 ЕВРОПА 2 | LTE']);
});

test('detectClientType — Happ UA', () => {
    assert.strictEqual(detectClientType('Happ/1.0'), 'happ');
});

test('detectClientType — Mihomo variants', () => {
    assert.strictEqual(detectClientType('clash-meta/0.5'), 'mihomo');
    assert.strictEqual(detectClientType('mihomo/1.0'), 'mihomo');
    assert.strictEqual(detectClientType('FlClash'), 'mihomo');
});

test('detectClientType — singbox variants', () => {
    assert.strictEqual(detectClientType('sfa/1.0'), 'singbox');
    assert.strictEqual(detectClientType('hiddify/2.0'), 'singbox');
});

test('detectClientType — UA with whitespace gets trimmed (regression test)', () => {
    assert.strictEqual(detectClientType('  v2raytun/1.0  '), 'xray_json');
});

test('detectClientType — empty/null defaults to happ', () => {
    assert.strictEqual(detectClientType(''), 'happ');
    assert.strictEqual(detectClientType(null), 'happ');
    assert.strictEqual(detectClientType(undefined), 'happ');
});

test('detectClientType — unknown client → other', () => {
    assert.strictEqual(detectClientType('SomeRandomClient/1.0'), 'other');
});

test('isLteOutbound — matches LTE patterns', () => {
    assert.strictEqual(isLteOutbound('ЕВРОПА LTE 1'), true);
    assert.strictEqual(isLteOutbound('Finland LTE backup'), true);
});

test('isLteOutbound — non-LTE returns false', () => {
    assert.strictEqual(isLteOutbound('🇫🇮 Finland 1'), false);
});
