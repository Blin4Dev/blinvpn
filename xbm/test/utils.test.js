'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const { parseRamGb, sanitizeTag, escapeRegex, envInt } = require('../src/utils');

test('parseRamGb — number bytes input', () => {
    assert.strictEqual(parseRamGb(2 * 1024 * 1024 * 1024), 2);
});

test('parseRamGb — string GB', () => {
    assert.strictEqual(parseRamGb('2.06 GB'), 2.06);
});

test('parseRamGb — string MB', () => {
    assert.ok(Math.abs(parseRamGb('512 MB') - 0.5) < 0.001);
});

test('parseRamGb — null/undefined → null (was 1 before fix)', () => {
    assert.strictEqual(parseRamGb(null), null);
    assert.strictEqual(parseRamGb(undefined), null);
});

test('parseRamGb — invalid string → null', () => {
    assert.strictEqual(parseRamGb('not a number'), null);
    assert.strictEqual(parseRamGb(''), null);
});

test('parseRamGb — zero bytes → null', () => {
    assert.strictEqual(parseRamGb(0), null);
});

test('sanitizeTag — replaces non-alphanumeric with underscore', () => {
    assert.strictEqual(sanitizeTag('🇫🇮 Finland (WIFI)'), 'Finland_WIFI');
    assert.strictEqual(sanitizeTag('Europe LTE'), 'Europe_LTE');
});

test('escapeRegex — escapes regex metacharacters', () => {
    assert.strictEqual(escapeRegex('a.b*c'), 'a\\.b\\*c');
    assert.strictEqual(escapeRegex('plain'), 'plain');
});

test('envInt — parses integer or fallback', () => {
    assert.strictEqual(envInt('42', 10), 42);
    assert.strictEqual(envInt('not-a-number', 10), 10);
    assert.strictEqual(envInt(undefined, 10), 10);
    assert.strictEqual(envInt('', 10), 10);
});
