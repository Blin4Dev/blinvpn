'use strict';

/**
 * Главный entry-point генераторов подписок. Re-exports из подмодулей:
 *   - common.js  — shared helpers (collectAllProxyOutbounds, isFakeConfig, prepareBaseTemplate)
 *   - xray.js    — buildGroupConfig (Xray-JSON для Happ/Xray-клиентов)
 *   - mihomo.js  — generateMihomoYaml (Clash Meta YAML)
 *   - singbox.js — generateSingboxConfig (SingBox JSON)
 *   - ../mihomo-pro.js — отдельный template-based генератор для Legiz-style
 */

const common = require('./common');
const xray = require('./xray');
const mihomo = require('./mihomo');
const singbox = require('./singbox');
const { generateMihomoYamlPro } = require('../mihomo-pro');

module.exports = {
    // Common helpers
    isFakeConfig: common.isFakeConfig,
    collectAllProxyOutbounds: common.collectAllProxyOutbounds,
    prepareBaseTemplate: common.prepareBaseTemplate,
    // Xray
    buildGroupConfig: xray.buildGroupConfig,
    resetRoutingWarning: xray.resetRoutingWarning,
    // Mihomo
    generateMihomoYaml: mihomo.generateMihomoYaml,
    generateMihomoYamlPro,
    // SingBox
    generateSingboxConfig: singbox.generateSingboxConfig,
};
