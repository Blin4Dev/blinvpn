'use strict';

require('./helpers/setup-env');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Изолированная директория для тестов persistence — иначе sticky-assignments.json
// в репо мутируется и ломает другие проверки.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-test-'));
const tmpFile = path.join(tmpDir, 'sticky.json');
process.env.STICKY_PERSIST_PATH = tmpFile;

// Мокаем config чтобы sticky-assignments взял наш TMP-путь.
// Здесь грязный приём: config.js загружается ДО sticky-assignments.js, и
// PERSIST_PATH = config.sticky_persist_path считывается на этапе require.
// Перезаписываем через monkey-patching самого config модуля до загрузки sticky.
const cfgPath = require.resolve('../src/config');
delete require.cache[cfgPath];
process.env.REMNAWAVE_URL = 'http://localhost';
process.env.SUB_PAGE_URL = 'http://localhost';
const cfgMod = require('../src/config');
cfgMod.config.sticky_persist_path = tmpFile;

const stickyPath = require.resolve('../src/sticky-assignments');
delete require.cache[stickyPath];
const sticky = require('../src/sticky-assignments');

test('getOrAssign — детерминированный hash: один токен всегда даёт один и тот же тег', () => {
    const tags = ['A', 'B', 'C', 'D'];
    const t1 = sticky.getOrAssign('user-fixed-1', 'TestG', tags, () => null);
    const t2 = sticky.getOrAssign('user-fixed-1', 'TestG', tags, () => null);
    assert.strictEqual(t1, t2);
});

test('getOrAssign — разные токены распределяются по серверам', () => {
    const tags = ['A', 'B', 'C', 'D', 'E', 'F'];
    const counts = {};
    for (let i = 0; i < 600; i++) {
        const t = sticky.getOrAssign(`u-${i}`, 'TestG2', tags, () => null);
        counts[t] = (counts[t] || 0) + 1;
    }
    // Каждый сервер должен получить хоть кого-то (с большим запасом).
    for (const tag of tags) assert.ok(counts[tag] > 0, `${tag} got 0 users — uneven distribution`);
});

test('getOrAssign — пропускает overloaded сервер при initial assign', () => {
    const tags = ['LOAD', 'OK1', 'OK2'];
    const loadLookup = (tag) => tag === 'LOAD' ? { load: 1.5 } : { load: 0.3 };
    let pickedLoad = 0;
    for (let i = 0; i < 100; i++) {
        const t = sticky.getOrAssign(`overload-test-${i}`, 'TestG3', tags, loadLookup);
        if (t === 'LOAD') pickedLoad++;
    }
    assert.strictEqual(pickedLoad, 0, 'LOAD server should never be picked when overloaded');
});

test('getOrAssign — реассигнит юзера если его сервер стал overloaded', () => {
    const tags = ['X', 'Y', 'Z'];
    const tok = 'reassign-user';
    // Initial: все ноды OK
    const t1 = sticky.getOrAssign(tok, 'TestG4', tags, () => ({ load: 0.3 }));
    // Теперь t1 перегружен, остальные ОК
    const loadLookup = (tag) => tag === t1 ? { load: 1.5 } : { load: 0.3 };
    const t2 = sticky.getOrAssign(tok, 'TestG4', tags, loadLookup);
    assert.notStrictEqual(t1, t2, 'should reassign when current is overloaded');
});

test('getOrAssign — null candidates → null result', () => {
    assert.strictEqual(sticky.getOrAssign('any', 'G', [], () => null), null);
    assert.strictEqual(sticky.getOrAssign('any', 'G', null, () => null), null);
});

test('describe — возвращает назначения юзера', () => {
    sticky.getOrAssign('describe-user', 'GroupA', ['a', 'b'], () => null);
    sticky.getOrAssign('describe-user', 'GroupB', ['c', 'd'], () => null);
    const d = sticky.describe('describe-user');
    assert.ok(d);
    assert.ok(d.GroupA && d.GroupA.tag);
    assert.ok(d.GroupB && d.GroupB.tag);
});

test('describe — возвращает null для неизвестного токена', () => {
    assert.strictEqual(sticky.describe('never-seen-this-token'), null);
});

// Cleanup
test.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
