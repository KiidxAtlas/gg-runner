'use strict';

const { WCS_P } = require('./memory');

class Interpreter {
    constructor(memory) {
        this.memory = memory;
    }

    /**
     * Process one gcode line.
     * Returns { handled, gcodesToSend, error }
     *   handled      – true if this was a DDcut M-code (do NOT send to machine)
     *   gcodesToSend – array of gcode strings to send to machine as a result
     *   error        – string if a user-visible error was triggered (M106)
     */
    process(line) {
        const stripped = line.replace(/\s+/g, ' ').trim();
        if (!stripped) return { handled: false };

        const upper = stripped.toUpperCase();
        if (upper.match(/^M100\b/)) return this._m100(stripped);
        if (upper.match(/^M102\b/)) return this._m102(stripped);
        if (upper.match(/^M106\b/)) return this._m106(stripped);
        if (upper.match(/^M107\b/)) return this._m107(stripped);
        if (upper.match(/^M108\b/)) return this._m108(stripped);

        return { handled: false };
    }

    // M100 <reg_a><reg_b><reg_dest>  – set dest = midpoint(a, b)
    // Example: M100 G56XG57XG54X
    _m100(line) {
        const m = line.match(/M100\s+(G5[4-9][XYZ])(G5[4-9][XYZ])(G5[4-9][XYZ])/i);
        if (!m) return { handled: true, gcodesToSend: [] };

        const a = this.memory.getRegister(m[1].toUpperCase());
        const b = this.memory.getRegister(m[2].toUpperCase());
        const dest = m[3].toUpperCase();
        const val = (a + b) / 2;

        this.memory.setRegister(dest, val);
        const send = this._wcsGcode(dest, val);
        return { handled: true, gcodesToSend: send ? [send] : [] };
    }

    // M102 <register> <expression>
    // Example: M102 G54Y (G59Y - (G58Y * 25.4))
    _m102(line) {
        const m = line.match(/M102\s+(G5[4-9][XYZ])\s+(.+)$/i);
        if (!m) return { handled: true, gcodesToSend: [] };

        const dest = m[1].toUpperCase();
        const expr = m[2].trim();

        let value;
        try {
            value = this._eval(expr);
        } catch (e) {
            return { handled: true, gcodesToSend: [], error: `Expression error in: ${expr}\n${e.message}` };
        }

        this.memory.setRegister(dest, value);
        const send = this._wcsGcode(dest, value);
        return { handled: true, gcodesToSend: send ? [send] : [] };
    }

    // M106 <register> <op> <value> <message>  – conditional error/halt
    // Example: M106 G58Y == 0 Error: message
    _m106(line) {
        const m = line.match(/M106\s+(G5[4-9][XYZ])\s*(==|!=|>=|<=|>|<)\s*(-?[\d.]+)\s+(.+)$/i);
        if (!m) return { handled: true, gcodesToSend: [] };

        const regVal = this.memory.getRegister(m[1].toUpperCase());
        const op = m[2];
        const cmp = parseFloat(m[3]);
        const msg = m[4].trim();

        const triggered =
            (op === '==' && regVal === cmp) ||
            (op === '!=' && regVal !== cmp) ||
            (op === '>' && regVal > cmp) ||
            (op === '<' && regVal < cmp) ||
            (op === '>=' && regVal >= cmp) ||
            (op === '<=' && regVal <= cmp);

        if (triggered) return { handled: true, gcodesToSend: [], error: msg };
        return { handled: true, gcodesToSend: [] };
    }

    // M107 <varname> <value>  – store named variable
    // Example: M107 rms_rear 2.1005
    _m107(line) {
        const m = line.match(/M107\s+(\S+)\s+(-?[\d.]+)/i);
        if (!m) return { handled: true, gcodesToSend: [] };
        this.memory.setNamed(m[1], parseFloat(m[2]));
        return { handled: true, gcodesToSend: [] };
    }

    // M108 <register> <varname>  – load named variable into register
    // Example: M108 G58Y rms_rear
    _m108(line) {
        const m = line.match(/M108\s+(G5[4-9][XYZ])\s+(\S+)/i);
        if (!m) return { handled: true, gcodesToSend: [] };
        const dest = m[1].toUpperCase();
        const val = this.memory.getNamed(m[2]);
        this.memory.setRegister(dest, val);
        // G58/G59 are scratch registers – don't need to sync to machine
        return { handled: true, gcodesToSend: [] };
    }

    // Build G10 L2 command to sync a WCS register to the machine.
    // Only syncs G54-G57; G58/G59 are internal scratch registers.
    _wcsGcode(ref, value) {
        const r = ref.match(/^(G5[4-7])([XYZ])$/);
        if (!r) return null;
        const p = WCS_P[r[1]];
        const axis = r[2];
        return `G21 G10 L2 P${p} ${axis}${value.toFixed(4)}`;
    }

    // ── Expression evaluator ──────────────────────────────────────────────────

    _eval(expr) {
        const mem = this.memory;

        // Replace register references (G54X, G58Y, etc.) with numeric values
        let js = expr.replace(/G5[4-9][XYZ]/gi, (match) =>
            mem.getRegister(match.toUpperCase())
        );

        // Transform if(cond, trueVal, falseVal) -> (cond ? trueVal : falseVal)
        js = this._transformIf(js);

        // Logic keywords
        js = js.replace(/\bor\b/g, '||')
            .replace(/\band\b/g, '&&');

        // Math functions
        js = js.replace(/\bfloor\(/g, 'Math.floor(')
            .replace(/\babs\(/g, 'Math.abs(')
            .replace(/\bsqrt\(/g, 'Math.sqrt(');

        // Safe function evaluation (no var access, input is internal)
        // eslint-disable-next-line no-new-func
        return Function('"use strict"; return (' + js + ');')();
    }

    // Recursively transform all if(cond, a, b) -> (cond ? a : b)
    _transformIf(expr) {
        let result = '';
        let i = 0;
        while (i < expr.length) {
            if (expr.substring(i, i + 3) === 'if(') {
                // Collect the three comma-separated arguments at depth 0
                let depth = 0;
                let j = i + 3;
                const args = [];
                let argStart = j;

                while (j < expr.length) {
                    const c = expr[j];
                    if (c === '(') { depth++; }
                    else if (c === ')') {
                        if (depth === 0) {
                            args.push(expr.slice(argStart, j).trim());
                            break;
                        }
                        depth--;
                    } else if (c === ',' && depth === 0) {
                        args.push(expr.slice(argStart, j).trim());
                        argStart = j + 1;
                    }
                    j++;
                }

                if (args.length === 3) {
                    const cond = this._transformIf(args[0]);
                    const tval = this._transformIf(args[1]);
                    const fval = this._transformIf(args[2]);
                    result += `(${cond} ? ${tval} : ${fval})`;
                } else {
                    // Malformed – pass through unchanged
                    result += expr.slice(i, j + 1);
                }
                i = j + 1;
            } else {
                result += expr[i];
                i++;
            }
        }
        return result;
    }
}

module.exports = { Interpreter };
