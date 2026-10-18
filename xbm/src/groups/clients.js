'use strict';

/**
 * Детект типа клиента по User-Agent.
 * Используется в server.js для выбора формата подписки (Xray-JSON / Mihomo YAML / SingBox JSON / passthrough).
 */

const HAPP_RE = /happ/i;
const INCY_RE = /incy/i;
const XRAY_BALANCED_RE = /^(?:streisand|foxray|v2box|v2rayn|v2raytun|invisibleman|xray|neko)/i;
const MIHOMO_RE = /^(?:FlClash|FlClashX|Flowvy|clash-?verge|koala-?clash|murge|clash-nyanpasu|clash-?meta|mihomo|clash)/i;
const SINGBOX_RE = /^(?:sfa|sfi|sfm|sft|karing|singbox|hiddify)/i;
const PASSTHROUGH_APP_RE = /rabbithole|prizrak-box/i;
const PASSTHROUGH_RE = /^stash/i;

/**
 * Определить тип клиента по User-Agent.
 * @param {string|undefined|null} ua — заголовок User-Agent (могут быть с пробелами — trim'ается).
 * @returns {'happ'|'incy'|'mihomo'|'singbox'|'xray_json'|'passthrough'|'other'}
 */
function detectClientType(ua) {
    if (!ua) return 'happ';
    const trimmed = String(ua).trim();
    if (!trimmed) return 'happ';
    if (HAPP_RE.test(trimmed)) return 'happ';
    if (INCY_RE.test(trimmed)) return 'incy';
    if (PASSTHROUGH_APP_RE.test(trimmed)) return 'passthrough';
    if (MIHOMO_RE.test(trimmed)) return 'mihomo';
    if (SINGBOX_RE.test(trimmed)) return 'singbox';
    if (XRAY_BALANCED_RE.test(trimmed)) return 'xray_json';
    if (PASSTHROUGH_RE.test(trimmed)) return 'passthrough';
    return 'other';
}

module.exports = { detectClientType };
