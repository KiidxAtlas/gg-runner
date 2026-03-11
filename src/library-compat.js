'use strict';

function isStandaloneSanityCheck(relPath) {
    return normalizePath(relPath).startsWith('Code/Sanity_Checks/');
}

function normalizePath(relPath) {
    return String(relPath || '').replace(/\\/g, '/');
}

function normalizeLibraryGcodeLine(relPath, rawLine) {
    const filePath = normalizePath(relPath);

    if (!isStandaloneSanityCheck(filePath)) return rawLine;

    let line = rawLine;

    // Several standalone sanity-check files compare the secondary allowed
    // footprint code against G58Z instead of G58X.  At that point in the
    // file G58Z still holds sanity_checks_disabled (always 0 or 1), while
    // G58X was just reloaded with footprint_type.  Replace only those
    // G58Z refs whose comparison value is NOT 1 (value 1 is the
    // sanity-disabled guard and must stay on G58Z).
    if (/^Code\/Sanity_Checks\/footprint_.*_sanity_check\.gcode$/i.test(filePath) && /^\s*M102\b/i.test(line)) {
        line = line.replace(/G58Z(\s*==\s*)(\d+(?:\.\d+)?)/gi, (match, operator, value) => {
            return Number(value) === 1 ? match : `G58X${operator}${value}`;
        });
    }

    return line;
}

module.exports = {
    normalizeLibraryGcodeLine,
};
