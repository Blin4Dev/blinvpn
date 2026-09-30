'use strict';

/**
 * Common test setup. Подключается ПЕРВОЙ строкой в каждом тест-файле:
 *   require('./helpers/setup-env');
 *
 * Гарантирует что CONFIG_PATH указывает на config.json.example (рабочий
 * пример конфига без секретов), env vars REMNAWAVE_URL/SUB_PAGE_URL
 * установлены — иначе config.js при загрузке делает process.exit(1).
 */

const path = require('path');

if (!process.env.CONFIG_PATH) {
    process.env.CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json.example');
}
if (!process.env.REMNAWAVE_URL) {
    process.env.REMNAWAVE_URL = 'http://localhost';
}
if (!process.env.SUB_PAGE_URL) {
    process.env.SUB_PAGE_URL = 'http://localhost';
}
if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = 'silent';
}
