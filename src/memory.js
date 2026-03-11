'use strict';

// WCS index for G10 L2 Px commands
const WCS_P = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 };

class Memory {
    constructor() {
        this._named = {};
        // WCS registers stored in mm
        this._wcs = {};
        for (const g of ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']) {
            this._wcs[g] = { X: 0, Y: 0, Z: 0 };
        }
    }

    // Parse 'G54X' -> { g: 'G54', ax: 'X' } or null
    _parseRef(ref) {
        const m = String(ref).match(/^(G5[4-9])([XYZ])$/i);
        if (!m) return null;
        return { g: m[1].toUpperCase(), ax: m[2].toUpperCase() };
    }

    getRegister(ref) {
        const r = this._parseRef(ref);
        if (!r || !this._wcs[r.g]) return 0;
        return this._wcs[r.g][r.ax] ?? 0;
    }

    setRegister(ref, value) {
        const r = this._parseRef(ref);
        if (!r || !this._wcs[r.g]) return;
        this._wcs[r.g][r.ax] = Number(value);
    }

    setNamed(name, value) {
        this._named[name] = Number(value);
    }

    getNamed(name) {
        return this._named[name] ?? 0;
    }

    // Sync WCS registers from $# response lines e.g. "[G54:0.000,0.000,0.000]"
    syncFromHashResponse(lines) {
        for (const line of lines) {
            const m = line.match(/^\[(G5[4-9]):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]$/);
            if (m && this._wcs[m[1]]) {
                this._wcs[m[1]].X = parseFloat(m[2]);
                this._wcs[m[1]].Y = parseFloat(m[3]);
                this._wcs[m[1]].Z = parseFloat(m[4]);
            }
        }
    }

    dumpWCS() { return JSON.parse(JSON.stringify(this._wcs)); }
    dumpNamed() { return JSON.parse(JSON.stringify(this._named)); }
    reset() { this._named = {}; for (const g of Object.keys(this._wcs)) this._wcs[g] = { X: 0, Y: 0, Z: 0 }; }
}

module.exports = { Memory, WCS_P };
