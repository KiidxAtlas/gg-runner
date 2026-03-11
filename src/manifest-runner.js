'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { normalizeLibraryGcodeLine } = require('./library-compat');

// Regex to detect DDcut-only M-codes that must NOT be forwarded to machine
const DDCUT_MCODE = /^M(100|101|102|106|107|108)\b/i;

/**
 * DDcut YAML has two structural quirks that strict parsers reject:
 *
 * 1. Sibling keys in a sequence item are 1 col too deep:
 *      - step_name: Foo     ← first key at col N
 *       step_text: Bar      ← sibling at col N+1 (should be N)
 *
 * 2. Block-scalar content (after |) sits at col 0 regardless of key indent:
 *      step_markdown: |
 *    Content here…          ← col 0, but key is at col N
 *
 * This function fixes both before passing to js-yaml.
 */
function normalizeDDcutYaml(raw) {
    const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    let seqKeyCol = -1;  // col where the first mapping key of current seq item sits
    let inScalar = false;
    let scalarPad = '';  // spaces to prepend to under-indented scalar content

    for (const line of lines) {
        const trimmed = line.trimStart();
        const col = line.length - trimmed.length;

        // ── inside a block scalar ───────────────────────────────────────────
        if (inScalar) {
            if (!trimmed) {
                // blank line — keep empty (YAML ignores trailing spaces anyway)
                out.push('');
                continue;
            }
            // A non-blank line at or above seqKeyCol ends the scalar
            if (col >= seqKeyCol) {
                inScalar = false;
                // fall through to normal processing below
            } else {
                // content at col < seqKeyCol → re-indent it
                out.push(scalarPad + trimmed);
                continue;
            }
        }

        // ── blank / comment lines ───────────────────────────────────────────
        if (!trimmed || trimmed.startsWith('#')) {
            out.push(line);
            continue;
        }

        // ── new sequence item  `   - key: val` ─────────────────────────────
        const seqMatch = line.match(/^(\s*)-\s+\S/);
        if (seqMatch) {
            seqKeyCol = seqMatch[1].length + 2; // col of first key char
            out.push(line);
            // check if this sequence-item line ITSELF ends with a block scalar
            if (/[|>][-+]?\s*$/.test(line)) {
                inScalar = true;
                scalarPad = ' '.repeat(seqKeyCol + 2);
            }
            continue;
        }

        // ── normalise over-indented sibling mapping keys ────────────────────
        if (seqKeyCol >= 0 && col === seqKeyCol + 1 &&
            /^[a-z_][a-z0-9_]*\s*:/i.test(trimmed)) {
            const fixed = line.slice(1);   // strip exactly one leading space
            out.push(fixed);
            // check if this key opens a block scalar
            if (/[|>][-+]?\s*$/.test(fixed)) {
                inScalar = true;
                scalarPad = ' '.repeat(seqKeyCol + 2);
            }
            continue;
        }

        // ── a sibling key already at the right col may open a block scalar ──
        if (seqKeyCol >= 0 && col === seqKeyCol &&
            /^[a-z_][a-z0-9_]*\s*:/i.test(trimmed)) {
            out.push(line);
            if (/[|>][-+]?\s*$/.test(line)) {
                inScalar = true;
                scalarPad = ' '.repeat(seqKeyCol + 2);
            }
            continue;
        }

        // ── dedented past current seq-item scope ────────────────────────────
        if (col < seqKeyCol && trimmed.length > 0) {
            seqKeyCol = -1;
        }

        out.push(line);
    }

    return out.join('\n');
}

/**
 * Load and parse a YAML file with the DDcut normaliser applied first.
 * If normalisation makes things worse, falls back to raw parse so the
 * original error message surfaces.
 */
function loadYaml(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        return yaml.load(normalizeDDcutYaml(raw));
    } catch (_) {
        return yaml.load(raw);
    }
}


class ManifestRunner {
    constructor(libPath, memory, interpreter, serial) {
        this.libPath = libPath;
        this.memory = memory;
        this.interpreter = interpreter;
        this.serial = serial;

        this._jobs = [];
        this._steps = [];   // expanded, flattened step list for active job
        this._index = -1;
        this._aborted = false;
    }

    // Load manifest.yml
    load(manifestPath) {
        const jobs = loadYaml(manifestPath);
        this._jobs = Array.isArray(jobs) ? jobs : [];
        return this.listJobs();
    }

    listJobs() {
        return this._jobs.map((j, i) => ({
            index: i,
            name: j.job_name || `Job ${i}`,
            text: j.job_text || '',
        }));
    }

    startJob(jobIndex) {
        const job = this._jobs[jobIndex];
        if (!job) return null;
        this._steps = this._expand(job.job_steps || []);
        this._index = 0;
        this._aborted = false;
        return this._stepInfo(this._steps[0]);
    }

    /**
     * Advance the step pointer.
     * popupAnswer: true = Yes, false = No, null = plain Next
     * Returns the new step info object (or { done: true }).
     */
    advance(popupAnswer = null) {
        const curr = this._steps[this._index];
        if (!curr) return { done: true };

        // Determine jump
        let delta = 1;

        if (popupAnswer === true && curr.popup_yes_step != null) {
            delta = curr.popup_yes_step;
        } else if (popupAnswer === false && curr.popup_no_step != null) {
            delta = curr.popup_no_step;
        } else if (curr.step_goto != null) {
            delta = curr.step_goto;
        }

        this._index += delta;

        if (this._index < 0 || this._index >= this._steps.length) {
            return { done: true };
        }

        return this._stepInfo(this._steps[this._index]);
    }

    /**
     * Run the gcode for the current step.
     * onOutput(line) is called for each line sent or received.
     */
    async runCurrentGcode(onOutput = () => { }) {
        const step = this._steps[this._index];
        if (!step?.step_gcode) return { ok: true };

        const gcodePath = path.join(this.libPath, step.step_gcode);
        if (!fs.existsSync(gcodePath)) {
            return { error: `Gcode file not found: ${step.step_gcode}` };
        }

        this._aborted = false;
        const lines = fs.readFileSync(gcodePath, 'utf8').split('\n');

        for (const sourceLine of lines) {
            if (this._aborted) return { error: 'Aborted' };

            const rawLine = normalizeLibraryGcodeLine(step.step_gcode, sourceLine);

            const rawTrimmed = rawLine.trim();
            // For DDcut M-codes, preserve raw line (parentheses are expressions, not comments).
            // For regular gcode, strip inline comments of the form (some text).
            const stripped = DDCUT_MCODE.test(rawTrimmed)
                ? rawTrimmed
                : rawLine.replace(/\([^)]*\)/g, '').trim();
            if (!stripped) continue;

            const isM = DDCUT_MCODE.test(stripped);

            if (isM) {
                // Handle entirely in software
                const result = this.interpreter.process(stripped);
                if (result.error) {
                    onOutput(`⚠ ${result.error}`);
                    return { error: result.error };
                }
                for (const gline of (result.gcodesToSend || [])) {
                    onOutput(`→ ${gline}`);
                    if (!this.serial.connected) return { error: 'Not connected' };
                    try { await this.serial.send(gline); } catch (e) { return { error: e.message }; }
                }
            } else {
                // Forward to machine
                onOutput(`> ${stripped}`);
                if (!this.serial.connected) return { error: 'Not connected' };
                try {
                    await this.serial.send(stripped);
                } catch (e) {
                    if (this._aborted) return { error: 'Aborted' };
                    return { error: e.message };
                }
            }
        }

        // After file completes, sync WCS registers from machine
        try {
            const hashLines = await this.serial.queryHash();
            this.memory.syncFromHashResponse(hashLines);
        } catch (_) { /* non-fatal */ }

        return { ok: true };
    }

    abort() {
        this._aborted = true;
        this.serial.abort();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    // Recursively expand manifest_file includes into a flat step array
    _expand(rawSteps) {
        const out = [];
        for (const step of rawSteps) {
            if (step.manifest_file) {
                const p = path.join(this.libPath, step.manifest_file);
                if (fs.existsSync(p)) {
                    const sub = loadYaml(p) || [];
                    out.push(...this._expand(sub));
                }
            } else {
                out.push(step);
            }
        }
        return out;
    }

    _stepInfo(step) {
        if (!step) return null;

        const imgRel = step.step_image;
        const image = imgRel ? path.join(this.libPath, imgRel) : null;

        return {
            name: step.step_name || '',
            text: step.step_text || null,
            markdown: step.step_markdown || step.step_manifest || null,
            image,
            gcode: step.step_gcode || null,
            timeout: step.timeout || null,
            popup: (step.popup_title || step.popup_text) ? {
                title: step.popup_title || '',
                text: step.popup_text || '',
                hasNo: step.popup_no_step != null,
            } : null,
        };
    }
}

module.exports = { ManifestRunner };
