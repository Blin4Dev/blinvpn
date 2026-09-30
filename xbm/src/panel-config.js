'use strict';

/**
 * [BlinVPN] Настройки из панели BlinVPN (раздел «Балансировщик»).
 *
 * Панель пишет файл PANEL_CONFIG_PATH (по умолчанию /app/state/panel.json):
 *   {
 *     "version": 2,
 *     "only_groups": true,          // пользователям видны только хосты из панели (+ авто-выбор)
 *     "auto_group_name": "🇪🇺 Автоматический выбор",
 *     "auto_template": { …Xray JSON из Remnawave… } | null,
 *     "reserve_tags":      ["de-wl-1", ...],   // «Белые списки»: в авто-выборе и в своей локации — только резерв
 *     "auto_exclude_tags": ["..."],            // хосты, которые не участвуют в авто-выборе
 *     "groups": [ { "name": "🇩🇪 Германия", "tags": ["de1", "de2"], "description": "…",
 *                   "template": { …Xray JSON… } | null } ]   // порядок = порядок в подписке
 *   }
 *
 * Хосты задаются ТОЧНЫМ названием (remark) — панель сама переводит выбранные в
 * списке хосты в их текущие названия, так что никаких «ключевых слов» в
 * названиях хостов не нужно. Файл перечитывается на лету (проверка раз в 2 с),
 * перезапуск XBM не нужен. Нет файла или он битый — работает как без панели
 * (последние удачно прочитанные настройки сохраняются).
 */

const fs = require('fs');
const { logger } = require('./logger');

const PANEL_CONFIG_PATH = process.env.PANEL_CONFIG_PATH || '/app/state/panel.json';
const CHECK_EVERY_MS = 2000;
const MAX_ITEMS = 2000;
const MAX_STR = 200;

const MAX_TEMPLATE_BYTES = 256 * 1024;

const EMPTY = Object.freeze({
    present: false,
    onlyGroups: false,
    autoTemplate: null,
    templates: {},
    autoGroupName: null,
    reserve: new Set(),
    autoExclude: new Set(),
    groups: [],
    tagToGroup: new Map(),
    descriptions: {},
});

let state = EMPTY;
// Служебные имена хостов, переименованных из-за совпадения с названием строки (см. alias())
const aliases = new Map();
let lastCheck = 0;
let lastMtime = -1;

function cleanStr(v, max = MAX_STR) {
    if (typeof v !== 'string') return null;
    // управляющие символы вон, длина ограничена
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return s ? s.slice(0, max) : null;
}

// Названия хостов сравниваются с remarks из Remnawave ТОЧНО (без обрезки пробелов),
// иначе хост с пробелом в конце названия молча выпал бы из своей строки.
function cleanTags(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const v of arr.slice(0, MAX_ITEMS)) {
        if (typeof v !== 'string' || !v || v.length > 1000 || /[\u0000-\u001f\u007f]/.test(v)) continue;
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

/** Шаблон Xray JSON: только объект разумного размера, иначе — без шаблона. */
function cleanTemplate(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    try {
        if (JSON.stringify(t).length > MAX_TEMPLATE_BYTES) return null;
    } catch { return null; }
    return t;
}

/** Разобрать и проверить содержимое panel.json. Бросает исключение на неверном формате. */
function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ожидается объект');
    const groups = [];
    const tagToGroup = new Map();
    const descriptions = {};
    const templates = {};
    const names = new Set();
    for (const g of (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 500)) {
        const name = cleanStr(g && g.name, 64);
        if (!name || names.has(name)) continue;
        const tags = cleanTags(g.tags);
        if (tags.length === 0) continue;
        names.add(name);
        groups.push({ name, tags });
        for (const t of tags) if (!tagToGroup.has(t)) tagToGroup.set(t, name);
        const d = cleanStr(g.description, 60);
        if (d) descriptions[name] = d;
        const tpl = cleanTemplate(g.template);
        if (tpl) templates[name] = tpl;
    }
    return {
        present: true,
        onlyGroups: raw.only_groups === true,
        autoTemplate: cleanTemplate(raw.auto_template),
        templates,
        autoGroupName: cleanStr(raw.auto_group_name, 64),
        reserve: new Set(cleanTags(raw.reserve_tags)),
        autoExclude: new Set(cleanTags(raw.auto_exclude_tags)),
        groups,
        tagToGroup,
        descriptions,
    };
}

function reload(force = false) {
    const now = Date.now();
    if (!force && now - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = now;
    let st;
    try {
        st = fs.statSync(PANEL_CONFIG_PATH);
    } catch {
        if (state.present) logger.warn('panel', `Файл настроек панели пропал (${PANEL_CONFIG_PATH}) — работаем без него`);
        state = EMPTY;
        lastMtime = -1;
        return;
    }
    if (st.mtimeMs === lastMtime) return;
    try {
        if (st.size > 2 * 1024 * 1024) throw new Error('файл слишком большой');
        const next = normalize(JSON.parse(fs.readFileSync(PANEL_CONFIG_PATH, 'utf8')));
        state = next;
        aliases.clear();  // настройки сменились — служебные переименования пересоберутся
        lastMtime = st.mtimeMs;
        logger.info('panel', `✅ Настройки панели: локаций ${next.groups.length}, белых списков ${next.reserve.size}, вне авто-выбора ${next.autoExclude.size}`);
    } catch (err) {
        // Файл пишется атомарно, но на всякий случай: битый файл не ломает подписку
        logger.warn('panel', `Не удалось прочитать настройки панели: ${err.message} — оставляем прежние`);
        lastMtime = st.mtimeMs;
    }
}

/** Текущие настройки панели (с проверкой изменений файла не чаще раза в 2 с). */
function get() {
    reload();
    return state;
}

// Служебные имена хостов, переименованных из-за совпадения с названием строки
// подписки (см. server.js): «de1 · 2» → «de1». Ограничено по размеру.
function alias(newTag, origTag) {
    if (aliases.size > 5000) aliases.clear();
    aliases.set(String(newTag), String(origTag));
}
function orig(tag) {
    const t = String(tag || '');
    return aliases.get(t) || t;
}

/**
 * Хосты сверяются по точному названию. Если в Remnawave два хоста с одинаковым
 * названием, XBM добавляет повтору «-N» — панель не даёт выбрать такие хосты.
 */
function groupOf(tag) {
    const s = get();
    return s.tagToGroup.get(orig(tag)) || null;
}

function isReserve(tag) { return get().reserve.has(orig(tag)); }
function isAutoExcluded(tag) { return get().autoExclude.has(orig(tag)); }
function autoGroupName(fallback) { return get().autoGroupName || fallback; }

/** Шаблон Xray JSON, выбранный в панели для строки подписки (или null — шаблон хоста из Remnawave). */
function templateFor(groupName, isAuto) {
    const s = get();
    return isAuto ? s.autoTemplate : (s.templates[groupName] || null);
}

module.exports = { PANEL_CONFIG_PATH, get, reload, normalize, groupOf, isReserve, isAutoExcluded, autoGroupName, templateFor, alias };
