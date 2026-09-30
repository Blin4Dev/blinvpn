'use strict';

/**
 * Country detection — паттерны стран для автогруппировки + best-match utility.
 */

const COUNTRY_PATTERNS = {
    'Finland': { emoji: '🇫🇮', patterns: ['Finland', 'Финлянд', 'FI', 'Helsinki'] },
    'Germany': { emoji: '🇩🇪', patterns: ['Germany', 'German', 'Германи', 'DE', 'Berlin', 'Frankfurt'] },
    'Netherlands': { emoji: '🇳🇱', patterns: ['Netherlands', 'Нидерланд', 'NL', 'Amsterdam', 'Holland'] },
    'USA': { emoji: '🇺🇸', patterns: ['USA', 'United States', 'Америк', 'US', 'New York', 'Los Angeles', 'Dallas'] },
    'Sweden': { emoji: '🇸🇪', patterns: ['Sweden', 'Швеци', 'SE', 'Stockholm'] },
    'France': { emoji: '🇫🇷', patterns: ['France', 'Франци', 'FR', 'Paris'] },
    'UK': { emoji: '🇬🇧', patterns: ['United Kingdom', 'UK', 'Британи', 'GB', 'London', 'England'] },
    'Poland': { emoji: '🇵🇱', patterns: ['Poland', 'Польш', 'PL', 'Warsaw'] },
    'Turkey': { emoji: '🇹🇷', patterns: ['Turkey', 'Турци', 'TR', 'Istanbul'] },
    'Japan': { emoji: '🇯🇵', patterns: ['Japan', 'Япони', 'JP', 'Tokyo'] },
    'Singapore': { emoji: '🇸🇬', patterns: ['Singapore', 'Сингапур', 'SG'] },
    'Austria': { emoji: '🇦🇹', patterns: ['Austria', 'Австри', 'AT', 'Vienna'] },
    'Canada': { emoji: '🇨🇦', patterns: ['Canada', 'Канад', 'CA', 'Toronto'] },
    'Australia': { emoji: '🇦🇺', patterns: ['Australia', 'Австрали', 'AU', 'Sydney'] },
    'Italy': { emoji: '🇮🇹', patterns: ['Italy', 'Итали', 'IT', 'Rome', 'Milan'] },
    'Spain': { emoji: '🇪🇸', patterns: ['Spain', 'Испани', 'ES', 'Madrid'] },
    'Czech': { emoji: '🇨🇿', patterns: ['Czech', 'Чехи', 'CZ', 'Prague'] },
    'Romania': { emoji: '🇷🇴', patterns: ['Romania', 'Румыни', 'RO'] },
    'Bulgaria': { emoji: '🇧🇬', patterns: ['Bulgaria', 'Болгари', 'BG'] },
    'Latvia': { emoji: '🇱🇻', patterns: ['Latvia', 'Латви', 'LV', 'Riga'] },
    'Lithuania': { emoji: '🇱🇹', patterns: ['Lithuania', 'Литв', 'LT', 'Vilnius'] },
    'Estonia': { emoji: '🇪🇪', patterns: ['Estonia', 'Эстони', 'EE', 'Tallinn'] },
    'Ireland': { emoji: '🇮🇪', patterns: ['Ireland', 'Ирланди', 'IE', 'Dublin'] },
    'Kazakhstan': { emoji: '🇰🇿', patterns: ['Kazakhstan', 'Казахстан', 'KZ'] },
    'Ukraine': { emoji: '🇺🇦', patterns: ['Ukraine', 'Украин', 'UA', 'Kyiv'] },
    'Moldova': { emoji: '🇲🇩', patterns: ['Moldova', 'Молдов', 'MD'] },
    'India': { emoji: '🇮🇳', patterns: ['India', 'Инди', 'IN', 'Mumbai'] },
    'Brazil': { emoji: '🇧🇷', patterns: ['Brazil', 'Бразили', 'BR'] },
    'LTE': { emoji: '🇪🇺', patterns: ['LTE', 'ЕВРОПА'] },
};

/**
 * Найти лучшее совпадение паттерна в тексте. Используется для matchGroup и detectCountryFromRemark.
 * Best-match по длине совпавшего паттерна (длиннее → точнее).
 */
function bestPatternMatch(text, patternsMap) {
    const textLower = text.toLowerCase();
    let bestMatch = null;
    let bestLen = 0;

    for (const [key, info] of Object.entries(patternsMap)) {
        const patterns = Array.isArray(info) ? info : info.patterns;
        for (const pattern of patterns) {
            const patLower = pattern.toLowerCase();
            let matched = false;
            if (patLower.length <= 2) {
                const regex = new RegExp(`(?:^|[^a-z])${patLower}(?:$|[^a-z])`);
                matched = regex.test(textLower);
            } else {
                matched = textLower.includes(patLower);
            }
            if (matched && patLower.length > bestLen) {
                bestMatch = key;
                bestLen = patLower.length;
            }
        }
    }
    return bestMatch;
}

function detectCountryFromRemark(remark) {
    const key = bestPatternMatch(remark, COUNTRY_PATTERNS);
    if (!key) return null;
    const info = COUNTRY_PATTERNS[key];
    return { country: key, emoji: info.emoji, patterns: info.patterns };
}

function buildGroupsFromHosts(hosts) {
    const groups = {};
    const seen = new Set();
    for (const host of hosts.filter(h => !h.isDisabled)) {
        const remark = host.remark || host.tag || host.address || '';
        const detected = detectCountryFromRemark(remark);
        if (detected && !seen.has(detected.country)) {
            seen.add(detected.country);
            groups[`${detected.emoji} ${detected.country}`] = detected.patterns;
        }
    }
    return groups;
}

module.exports = { COUNTRY_PATTERNS, bestPatternMatch, detectCountryFromRemark, buildGroupsFromHosts };
