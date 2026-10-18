'use strict';

// ─── Logger ───
// Уровни: debug < info < warn < error
// Управление: LOG_LEVEL=debug|info|warn|error (env или config.log_level)

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 99 };

const USE_COLOR = process.env.NO_COLOR !== '1' && process.env.NO_COLOR !== 'true';

const C = USE_COLOR ? {
    reset:  '\x1b[0m',
    dim:    '\x1b[2m',
    bold:   '\x1b[1m',
    debug:  '\x1b[36m',
    info:   '\x1b[32m',
    warn:   '\x1b[33m',
    error:  '\x1b[31m',
    proxy:  '\x1b[34m',
    group:  '\x1b[35m',
    stats:  '\x1b[33m',
    route:  '\x1b[96m',
    geo:    '\x1b[95m',
    happ:   '\x1b[92m',
    system: '\x1b[97m',
    lte:    '\x1b[94m',
} : new Proxy({}, { get: () => '' });

const LEVEL_LABELS = {
    debug: `${C.debug}DBG${C.reset}`,
    info:  `${C.info}INF${C.reset}`,
    warn:  `${C.warn}WRN${C.reset}`,
    error: `${C.error}ERR${C.reset}`,
};

const MODULE_COLORS = {
    proxy:          C.proxy,
    group:          C.group,
    'node-stats':   C.stats,
    routing:        C.route,
    geosite:        C.geo,
    'happ-routing': C.happ,
    lte:            C.lte,
    'auto-groups':  C.group,
    'rate-limit':   C.warn,
    config:         C.stats,
    shutdown:       C.system,
    error:          C.error,
};

function formatTag(tag) {
    const color = MODULE_COLORS[tag] || C.dim;
    return `${color}[${tag}]${C.reset}`;
}

function timestamp() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${C.dim}${hh}:${mm}:${ss}${C.reset}`;
}

let currentLevel = LEVELS.info;

function setLevel(level) {
    currentLevel = LEVELS[level] ?? LEVELS.info;
}

function log(level, tag, ...args) {
    if ((LEVELS[level] ?? 0) < currentLevel) return;
    const label = LEVEL_LABELS[level] || level;
    const tagStr = formatTag(tag);
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`${timestamp()} ${label} ${tagStr} ${args.join(' ')}\n`);
}

const logger = {
    debug: (tag, ...a) => log('debug', tag, ...a),
    info:  (tag, ...a) => log('info',  tag, ...a),
    warn:  (tag, ...a) => log('warn',  tag, ...a),
    error: (tag, ...a) => log('error', tag, ...a),
};

module.exports = { logger, setLevel, C, LEVELS };
