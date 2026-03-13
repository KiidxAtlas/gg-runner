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
    if (/^Code\/Sanity_Checks\/footprint_.*_sanity_check\.gcode$/i.test(filePath)) {
        // Standalone footprint sanity files use G58Z instead of G58X for some
        // footprint-type comparisons (non-1 values only; value 1 is the
        // sanity_checks_disabled guard and must stay on G58Z).
        if (/^\s*M102\b/i.test(line)) {
            line = line.replace(/G58Z(\s*==\s*)(\d+(?:\.\d+)?)/gi, (match, operator, value) => {
                return Number(value) === 1 ? match : `G58X${operator}${value}`;
            });
        }
        // Standalone files use `M106 G58Y == 1` where active workflow files use
        // `M106 G58Y == 0`.  Normalise to the active convention.
        if (/^\s*M106\b/i.test(line)) {
            line = line.replace(/(M106\s+G5[4-9][XYZ]\s*==\s*)1\b/i, '$10');
        }
    }

    return line;
}

module.exports = {
    normalizeLibraryGcodeLine,
};
