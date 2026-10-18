'use strict';

// настройки балансировщика из панели (panel.json)
// хосты по точному remark; файл перечитывается раз в 2с

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
// алиасы хостов, если tag совпал с именем группы (см. alias())
const aliases = new Map();
let lastCheck = 0;
let lastMtime = -1;

function cleanStr(v, max = MAX_STR) {
    if (typeof v !== 'string') return null;
    // убрать управляющие символы, ограничить длину
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return s ? s.slice(0, max) : null;
}

// точное совпадение remark (без trim), чтобы пробелы в конце тоже матчились
function cleanTags(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const v of arr.slice(0, MAX_ITEMS)) {
        if (typeof v !== 'string' || !v || v.length > 1000 || /[\u0000-\u001f\u007f]/.test(v)) continue;
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

// объект шаблона xray, или null если битый/слишком большой
function cleanTemplate(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    try {
        if (JSON.stringify(t).length > MAX_TEMPLATE_BYTES) return null;
    } catch { return null; }
    return t;
}

// разобрать и проверить panel.json
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
        aliases.clear();  // rebuild on next alias()
        lastMtime = st.mtimeMs;
        logger.info('panel', `✅ Настройки панели: локаций ${next.groups.length}, белых списков ${next.reserve.size}, вне авто-выбора ${next.autoExclude.size}`);
    } catch (err) {
        // оставить последний удачный конфиг при плохом чтении
        logger.warn('panel', `Не удалось прочитать настройки панели: ${err.message} — оставляем прежние`);
        lastMtime = st.mtimeMs;
    }
}

function get() {
    reload();
    return state;
}

// map «de1 · 2» → «de1», если tag совпал с именем группы
function alias(newTag, origTag) {
    if (aliases.size > 5000) aliases.clear();
    aliases.set(String(newTag), String(origTag));
}
function orig(tag) {
    const t = String(tag || '');
    return aliases.get(t) || t;
}

// группа по точному tag (с учётом alias)
function groupOf(tag) {
    const s = get();
    return s.tagToGroup.get(orig(tag)) || null;
}

function isReserve(tag) { return get().reserve.has(orig(tag)); }
function isAutoExcluded(tag) { return get().autoExclude.has(orig(tag)); }
function autoGroupName(fallback) { return get().autoGroupName || fallback; }

// шаблон xray группы/авто из панели
function templateFor(groupName, isAuto) {
    const s = get();
    return isAuto ? s.autoTemplate : (s.templates[groupName] || null);
}

module.exports = { PANEL_CONFIG_PATH, get, reload, normalize, groupOf, isReserve, isAutoExcluded, autoGroupName, templateFor, alias };
