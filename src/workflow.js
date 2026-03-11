'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DDCUT_MCODE = /^M(100|101|102|106|107|108)\b/i;

// ── Static data tables ──────────────────────────────────────────────────────

// Slide-install instructions shown after the endmill positions for slide loading.
// The user installs the slide against the endmill, then clicks Continue.
// After Continue the machine retracts (Slide 6) and probing can begin.
const SLIDE_INSTALL_NOTES = {
    // Glock 17/19/26 · 43/48 · 20: standard parallels, flat soft jaws
    glock: [
        'Install slide — standard parallels and flat soft jaws.',
        'Place BOTH standard (unmarked) parallels flat against the back of each clamp.',
        'Load slide on its side: muzzle points RIGHT, slide top (optic surface) points INWARD toward spindle. Rail side faces you.',
        'Gently bump the slide left against the endmill (no force) and back against the parallels. Hold in place.',
        'Add flat soft jaws and finger-tighten the M5 bolts. While pulling slide toward the clamps, tighten fully.',
        'Attach probe eyelet (angled neck UP) to the clamp with an M5×6 bolt. Plug probe wire into the Ghost Gunner.',
        'Short the clamp+endmill with a metal wrench — the green LED should light. If it does not, clean contact surfaces.',
        'Click Continue when the slide is secured and probe is verified.',
    ].join('\n'),
    // 1911: special tall (marked) parallels, special tall soft jaws (standard orientation)
    '1911': [
        'Install 1911 slide — SPECIAL tall (marked) parallels and SPECIAL tall soft jaws.',
        'Place BOTH special (marked) parallels flat against the back of each clamp. These are slightly taller than the standard ones.',
        'Load slide on its side: muzzle points RIGHT, slide top points INWARD toward spindle. Rail side faces you.',
        'Gently bump the slide left against the endmill (no force) and back against the parallels. Hold in place.',
        'Add special tall soft jaws (normal left/right orientation). Finger-tighten M5 bolts. While pulling slide toward clamps, tighten fully.',
        'Attach probe eyelet (angled neck UP) to the clamp with an M5×6 bolt. Plug probe wire into the Ghost Gunner.',
        'Short the clamp+endmill with a metal wrench — the green LED should light.',
        'Click Continue when the slide is secured and probe is verified.',
    ].join('\n'),
    // P320: special tall parallels, special tall soft jaws with RIGHT jaw rotated 90°
    'P320': [
        'Install P320 slide — SPECIAL tall (marked) parallels and SPECIAL tall P320 soft jaws.',
        'Place BOTH special (marked) parallels flat against the back of each clamp.',
        'Load slide on its side: muzzle points RIGHT, slide top points INWARD toward spindle. Rail side faces you.',
        'Gently bump the slide left against the endmill (no force) and back against the parallels. Hold in place.',
        'Install P320 special jaws: LEFT jaw in standard orientation; RIGHT jaw rotated 90°. Finger-tighten M5 bolts. While pulling toward clamps, tighten fully.',
        'Attach probe eyelet (angled neck UP) to the clamp with an M5×6 bolt. Plug probe wire into the Ghost Gunner.',
        'Short the clamp+endmill with a metal wrench — the green LED should light.',
        'Click Continue when the slide is secured and probe is verified.',
    ].join('\n'),
    // M&P 2.0: standard parallels, flat soft jaws, MUST remove roll pin first
    'M&P2.0': [
        '⚠ REQUIRED FIRST: Remove the M&P 2.0 roll pin and extractor BEFORE installing the slide. The endmill may contact the pin during milling.',
        'Install M&P 2.0 slide — standard (unmarked) parallels and flat soft jaws.',
        'Place BOTH standard parallels flat against the back of each clamp.',
        'Load slide on its side: muzzle points RIGHT, slide top points INWARD toward spindle. Rail side faces you.',
        'Gently bump the slide left against the endmill (no force) and back against the parallels. Hold in place.',
        'Add flat soft jaws and finger-tighten M5 bolts. While pulling toward clamps, tighten fully.',
        'Attach probe eyelet (angled neck UP) to the clamp with an M5×6 bolt. Plug probe wire into the Ghost Gunner.',
        'Short the clamp+endmill with a metal wrench — the green LED should light.',
        'Click Continue when the slide is secured and probe is verified.',
    ].join('\n'),
};

const SLIDE_TYPES = {
    'G17/19/26': {
        label: 'Glock 17/19/26',
        position: 'Code/Slide_Positioning/G17-19-26 Slide 5 position of slide.gcode',
        retract: 'Code/Slide 6 retract from slide.gcode',
        probe: 'Code/Slide_Probing/G17-19-26 Slide Probe 1.5 - 2.5 OAL.nc',
        configure: 'Code/Slide_Configs/G17-19-26_configure.gcode',
        installNote: SLIDE_INSTALL_NOTES.glock,
        footprints: ['RMR', 'Docter', 'MOS', 'RMS', 'RMRcc', 'Viper', 'Razor', 'DPP'],
        rearOnly: [],
    },
    'G43/48': {
        label: 'Glock 43/48',
        position: 'Code/Slide_Positioning/G43-48 Slide 5 position of slide.gcode',
        retract: 'Code/Slide 6 retract from slide.gcode',
        probe: 'Code/Slide_Probing/G43-48 Slide Probe 1.5 - 2.5 OAL.nc',
        configure: 'Code/Slide_Configs/G43-48_configure.gcode',
        installNote: SLIDE_INSTALL_NOTES.glock,
        footprints: ['RMS', 'RMRcc', 'DPP'],
        rearOnly: ['RMS', 'RMRcc', 'DPP'],
    },
    '1911': {
        label: '1911',
        position: 'Code/Slide_Positioning/1911 Slide 5 position of slide.gcode',
        retract: 'Code/Slide 6 retract from slide.gcode',
        probe: 'Code/Slide_Probing/1911 Slide Probe 1.5 - 2.5 OAL.nc',
        configure: 'Code/Slide_Configs/1911_configure.gcode',
        installNote: SLIDE_INSTALL_NOTES['1911'],
        footprints: ['RMS', 'RMRcc', 'MOS'],
        rearOnly: ['RMS', 'RMRcc', 'MOS'],
        is1911: true,
    },
    'P320': {
        label: 'P320',
        position: 'Code/Slide_Positioning/P320 Slide 5 position of slide.gcode',
        retract: 'Code/Slide 6 retract from slide.gcode',
        probe: 'Code/Slide_Probing/P320 Slide Probe 1.5 - 2.5 OAL.nc',
        configure: 'Code/Slide_Configs/P320_configure.gcode',
        installNote: SLIDE_INSTALL_NOTES['P320'],
        footprints: ['RMR', 'Docter', 'RMS', 'RMRcc', 'Viper', 'Razor', 'DPP'],
        rearOnly: [],
        maxDepth: '0.088"',
    },
    'G20': {
        label: 'Glock 20',
        position: 'Code/Slide_Positioning/G20 slide 5 position of slide.gcode',
        retract: 'Code/Slide 6 retract from slide.gcode',
        probe: 'Code/Slide_Probing/G20 Slide Probe 1.5 - 2.5 OAL.nc',
        configure: 'Code/Slide_Configs/G20_configure.gcode',
        installNote: SLIDE_INSTALL_NOTES.glock,
        footprints: ['RMR', 'Docter', 'MOS', 'RMS', 'RMRcc', 'Viper', 'Razor', 'DPP'],
        rearOnly: [],
    },
    'M&P2.0': {
        label: 'M&P 2.0',
        position: 'Code/Slide_Positioning/M&P2.0 slide 5 position of slide.gcode',
        retract: 'Code/Slide 6 retract from slide.gcode',
        probe: 'Code/Slide_Probing/M&P 2.0 Slide Probe 1.5 - 2.5 OAL.nc',
        configure: 'Code/Slide_Configs/M&P2.0_configure.gcode',
        installNote: SLIDE_INSTALL_NOTES['M&P2.0'],
        footprints: ['RMRcc', 'RMS'],
        rearOnly: ['RMRcc', 'RMS'],
    },
};

const FOOTPRINTS = {
    'RMR': { label: 'RMR / Holosun 407C·507C', configs: { Rear: 'Code/Footprint_Configs/rmr_rear_config.gcode', Standard: 'Code/Footprint_Configs/rmr_standard_config.gcode' }, mill: 'Code/Footprint_Milling/rmr_5-32.gcode' },
    'Docter': { label: 'Docter / Vortex Venom', configs: { Rear: 'Code/Footprint_Configs/docter_rear_config.gcode', Standard: 'Code/Footprint_Configs/docter_standard_config.gcode' }, mill: 'Code/Footprint_Milling/docter_5-32.gcode' },
    'MOS': {
        label: 'MOS / Holosun SCS', configs: { Rear: 'Code/Footprint_Configs/mos_rear_config.gcode', Standard: 'Code/Footprint_Configs/mos_standard_config.gcode' }, mill: 'Code/Footprint_Milling/mos_5-32.gcode',
        configs1911: { Rear: 'Code/Footprint_Configs/mos_1911_rear_config.gcode', Standard: 'Code/Footprint_Configs/mos_1911_standard_config.gcode' }, mill1911: 'Code/Footprint_Milling/1911_mos_platform_5-32.gcode'
    },
    'RMS': { label: 'RMS·RMSc / Sig Romeo Zero', configs: { Rear: 'Code/Footprint_Configs/rms_rear_config.gcode', Standard: 'Code/Footprint_Configs/rms_standard_config.gcode' }, mill: 'Code/Footprint_Milling/rms_5-32.gcode' },
    'RMRcc': { label: 'RMRcc (Trijicon)', configs: { Rear: 'Code/Footprint_Configs/rmrcc_rear_config.gcode', Standard: 'Code/Footprint_Configs/rmrcc_standard_config.gcode' }, mill: 'Code/Footprint_Milling/RMRcc Rough and finish.gcode' },
    'Viper': { label: 'Vortex Viper', configs: { Rear: 'Code/Footprint_Configs/viper_rear_config.gcode', Standard: 'Code/Footprint_Configs/viper_standard_config.gcode' }, mill: 'Code/Footprint_Milling/Viper Rough and finish.gcode' },
    'Razor': { label: 'Vortex Razor', configs: { Rear: 'Code/Footprint_Configs/razor_rear_config.gcode', Standard: 'Code/Footprint_Configs/razor_standard_config.gcode' }, mill: 'Code/Footprint_Milling/Razor Rough and finish.gcode' },
    'DPP': { label: 'Delta Point Pro (Leupold)', configs: { Rear: 'Code/Footprint_Configs/dpp_rear_config.gcode', Standard: 'Code/Footprint_Configs/dpp_standard_config.gcode' }, mill: 'Code/Footprint_Milling/DPP Rough and Finish.gcode' },
};

const DEPTHS = [
    { key: '0.088"', file: 'Code/Depth_Setting/088.gcode' },
    { key: '0.095"', file: 'Code/Depth_Setting/095.gcode' },
    { key: '0.125"', file: 'Code/Depth_Setting/125.gcode' },
    { key: '0.140"', file: 'Code/Depth_Setting/140.gcode' },
    { key: '0.145"', file: 'Code/Depth_Setting/145.gcode' },
    { key: '0.170"', file: 'Code/Depth_Setting/170.gcode' },
    { key: '0.180"', file: 'Code/Depth_Setting/180.gcode' },
    { key: '0.200"', file: 'Code/Depth_Setting/200.gcode' },
    { key: '0.240"', file: 'Code/Depth_Setting/240.gcode' },
];

// Each entry: { type:'gcode'|'instruction', text, image?, file? }
// 'gcode' steps run a file and stream output
// 'instruction' steps pause for user to click Continue
function buildHoleSequence(holeType) {
    const t = holeType; // '4-40' | 'M3' | '6-32'
    const borefile = { '4-40': 'Code/Hole_Cutting/4-40_1-16.gcode', 'M3': 'Code/Hole_Cutting/m3_1-16.gcode', '6-32': 'Code/Hole_Cutting/6-32 mill bore.gcode' }[t];
    const threadfile = { '4-40': 'Code/Hole_Cutting/4-40_threadmill.gcode', 'M3': 'Code/Hole_Cutting/m3_threadmill.gcode', '6-32': 'Code/Hole_Cutting/6-32 thread mill.gcode' }[t];
    const toolLabel = { '4-40': '4-40 threadmill (SPTM080LA)', 'M3': 'M3 threadmill', '6-32': '6-32 threadmill' }[t];

    return [
        { type: 'gcode', text: 'Moving to tool change position', file: 'Code/tool_change.gcode' },
        { type: 'instruction', text: `Install 1/16" endmill. Push it all the way in, tighten collet, re-attach chip fan.`, image: 'Image/DSC09761.jpg' },
        { type: 'gcode', text: 'Z probing with 1/16" endmill', file: 'Code/Slide_Probing/Z Reprobe 1.5 - 2.5 OAL.nc' },
        { type: 'gcode', text: 'Setting left hole position', file: 'Code/Hole_Cutting/set_left_hole.gcode' },
        { type: 'gcode', text: `Boring left hole (${t})`, file: borefile },
        { type: 'gcode', text: 'Setting right hole position', file: 'Code/Hole_Cutting/set_right_hole.gcode' },
        { type: 'gcode', text: `Boring right hole (${t})`, file: borefile },
        { type: 'gcode', text: 'Moving to tool change position', file: 'Code/tool_change.gcode' },
        { type: 'instruction', text: `Remove 1/16" endmill. Install ${toolLabel}. Push all the way in and tighten.`, image: null },
        // Z reprobe is required after installing the threadmill — it has a different tool length than the 1/16" endmill.
        { type: 'gcode', text: 'Z probing with threadmill', file: 'Code/Slide_Probing/Z Reprobe 1.5 - 2.5 OAL.nc' },
        { type: 'gcode', text: 'Setting left hole position', file: 'Code/Hole_Cutting/set_left_hole.gcode' },
        { type: 'gcode', text: `Threading left hole (${t})`, file: threadfile },
        { type: 'gcode', text: 'Setting right hole position', file: 'Code/Hole_Cutting/set_right_hole.gcode' },
        { type: 'gcode', text: `Threading right hole (${t})`, file: threadfile },
    ];
}

// ── WorkflowEngine ──────────────────────────────────────────────────────────

class WorkflowEngine extends EventEmitter {
    constructor(libPath, memory, interpreter, serial) {
        super();
        this.libPath = libPath;
        this.memory = memory;
        this.interpreter = interpreter;
        this.serial = serial;

        this.slideKey = null;
        // phases: idle | positioned | probed | ready
        this.phase = 'idle';
        this.running = false;
        this.devMode = false;
        this._aborted = false;
        this._held = false;
        this._holdPromise = null;
        this._holdResolve = null;
        this._continueResolve = null;
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    getSlideData() {
        return Object.entries(SLIDE_TYPES).map(([key, s]) => ({
            key,
            label: s.label,
            maxDepth: s.maxDepth || null,
        }));
    }

    getFootprintOptions(slideKey) {
        const slide = SLIDE_TYPES[slideKey];
        if (!slide) return [];
        return slide.footprints.map(k => {
            const fp = FOOTPRINTS[k];
            const rearOnly = slide.rearOnly.includes(k);
            return {
                key: k,
                label: fp.label,
                positions: rearOnly ? ['Rear'] : ['Rear', 'Standard'],
            };
        });
    }

    getDepthOptions(slideKey) {
        const slide = SLIDE_TYPES[slideKey];
        if (!slide) return DEPTHS;
        if (slide.maxDepth) {
            const idx = DEPTHS.findIndex(d => d.key === slide.maxDepth);
            return idx >= 0 ? DEPTHS.slice(0, idx + 1) : DEPTHS;
        }
        return DEPTHS;
    }

    getState() {
        return { phase: this.phase, slideKey: this.slideKey, running: this.running, devMode: this.devMode, held: this._held };
    }

    // ── Slide selection ──────────────────────────────────────────────────────

    setDevMode(val) {
        this.devMode = !!val;
        this._emitState();
    }

    setLibPath(newPath) {
        this.libPath = newPath;
    }

    setSlide(slideKey) {
        if (!SLIDE_TYPES[slideKey]) return;
        this.slideKey = slideKey;
        this.phase = 'idle';
        this._emitState();
    }

    // ── Probe sequence ───────────────────────────────────────────────────────

    async runPosition() {
        const slide = this._requireSlide();
        if (!slide) return;

        // Move endmill to slide-loading position (bumped against slide for X reference)
        await this._runFile(slide.position, 'Moving to slide loading position…');
        if (this._aborted) return;

        // Pause: user installs slide, soft jaws, probe eyelet, verifies conductivity
        const aborted = await this._waitForContinue(slide.installNote, 'Image/DSC09727.jpg');
        if (aborted) return;

        // Retract endmill from slide so Z probe can start
        await this._runFile(slide.retract, 'Retracting from slide…');
        if (!this._aborted) {
            this.phase = 'positioned';
            this._emitState();
            this.emit('gcode:done', { ok: true, phase: 'positioned' });
        }
    }

    async runProbe() {
        const slide = this._requireSlide();
        if (!slide) return;
        await this._runFile(slide.probe, 'Probing slide…');
        if (!this._aborted) {
            this.phase = 'probed';
            this._emitState();
            this.emit('gcode:done', { ok: true, phase: 'probed' });
        }
    }

    async runConfigure() {
        const slide = this._requireSlide();
        if (!slide) return;
        await this._runFile(slide.configure, 'Configuring work coordinates…');
        if (!this._aborted) {
            this.phase = 'ready';
            this._emitState();
            this.emit('gcode:done', { ok: true, phase: 'ready' });
        }
    }

    // ── Cut operations ───────────────────────────────────────────────────────

    async runFootprint(fpKey, position, depthKey) {
        const slide = this._requireSlide();
        const fp = FOOTPRINTS[fpKey];
        if (!slide || !fp) return;

        const is1911 = !!SLIDE_TYPES[this.slideKey].is1911;
        const cfgFile = (is1911 && fp.configs1911) ? fp.configs1911[position] : fp.configs[position];
        const millFile = (is1911 && fp.mill1911) ? fp.mill1911 : fp.mill;
        const depthObj = DEPTHS.find(d => d.key === depthKey);
        if (!cfgFile || !millFile || !depthObj) {
            this.emit('gcode:done', { error: 'Invalid footprint/depth combination' });
            return;
        }

        const files = [
            { file: cfgFile, text: `Configuring ${fp.label} – ${position}…` },
            { file: depthObj.file, text: `Setting depth to ${depthKey}…` },
        ];

        // 1911 MOS requires a home before milling to unlock the spindle
        if (is1911 && fp.mill1911) {
            files.push({ file: 'Code/home.gcode', text: 'Homing before milling…' });
        }
        files.push({ file: millFile, text: `Milling ${fp.label}…` });

        for (let i = 0; i < files.length; i++) {
            if (this._aborted) break;
            const { file, text } = files[i];
            this.emit('step', { index: i + 1, total: files.length, text });
            const result = await this._runFile(file, text);
            if (result?.error) return;
        }
        if (!this._aborted) {
            // Home the machine after completing the footprint cut
            await this._runFile('Code/home.gcode', 'Homing machine…');
            this.emit('gcode:done', { ok: true });
        }
    }

    async runHoles(holeType) {
        this._requireSlide();
        if (this._aborted) return;

        const steps = buildHoleSequence(holeType);

        for (let i = 0; i < steps.length; i++) {
            if (this._aborted) break;
            const step = steps[i];
            this.emit('step', { index: i + 1, total: steps.length, text: step.text });

            if (step.type === 'instruction') {
                // Pause for user, wait for continue() call
                const aborted = await this._waitForContinue(step.text, step.image);
                if (aborted) break;
            } else {
                const result = await this._runFile(step.file, step.text);
                if (result?.error) return;
            }
        }
        if (!this._aborted) {
            // Home the machine after completing the threading operation
            await this._runFile('Code/home.gcode', 'Homing machine…');
            this.emit('gcode:done', { ok: true });
        }
    }

    continue() {
        if (this._continueResolve) {
            const fn = this._continueResolve;
            this._continueResolve = null;
            fn(false); // false = not aborted
        }
    }

    hold() {
        if (!this._held) {
            this._held = true;
            this._holdPromise = new Promise(res => { this._holdResolve = res; });
            this._emitState();
        }
        this.serial.sendRaw('!');
    }

    resume() {
        if (this._held) {
            this._held = false;
            const fn = this._holdResolve;
            this._holdPromise = null;
            this._holdResolve = null;
            fn?.();
            this._emitState();
        }
        this.serial.sendRaw('~');
    }

    abort() {
        this._aborted = true;
        // Wake the held send loop so it can exit
        if (this._held) {
            this._held = false;
            const fn = this._holdResolve;
            this._holdPromise = null;
            this._holdResolve = null;
            fn?.();
        }
        if (this._continueResolve) {
            const fn = this._continueResolve;
            this._continueResolve = null;
            fn(true); // true = aborted
        }
        this.serial.abort();
        this.emit('gcode:done', { error: 'Aborted' });
    }

    // ── Internals ────────────────────────────────────────────────────────────

    _requireSlide() {
        const slide = SLIDE_TYPES[this.slideKey];
        if (!slide) {
            this.emit('gcode:done', { error: 'No slide type selected' });
            return null;
        }
        return slide;
    }

    _emitState() {
        this.emit('state', this.getState());
    }

    _waitIfHeld() {
        return this._holdPromise || Promise.resolve();
    }

    _waitForContinue(text, image) {
        this.emit('instruction', { text, image: image ? path.join(this.libPath, image) : null });
        return new Promise(resolve => {
            this._continueResolve = resolve;
        });
    }

    /**
     * Run a single gcode file through the interpreter/serial pipeline.
     * Emits 'gcode:line' per meaningful output line.
     * Returns {ok:true} or {error: string}.
     * Does NOT emit gcode:done — callers handle that.
     */
    async _runFile(relPath, _label) {
        if (this._aborted) return { error: 'Aborted' };

        const full = path.join(this.libPath, relPath);
        if (!fs.existsSync(full)) {
            const err = `File not found: ${relPath}`;
            this.emit('gcode:done', { error: err });
            return { error: err };
        }

        const lines = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n');

        for (const rawLine of lines) {
            if (this._aborted) return { error: 'Aborted' };

            // For DDcut M-codes, keep the raw line (parentheses are expressions, not comments).
            // For regular gcode, strip inline comments of the form (some text).
            const rawTrimmed = rawLine.trim();
            const stripped = DDCUT_MCODE.test(rawTrimmed)
                ? rawTrimmed
                : rawLine.replace(/\([^)]*\)/g, '').trim();
            if (!stripped) continue;

            if (DDCUT_MCODE.test(stripped)) {
                const result = this.interpreter.process(stripped);
                if (result.error) {
                    const err = result.error;
                    this.emit('gcode:done', { error: err });
                    return { error: err };
                }
                for (const gline of (result.gcodesToSend || [])) {
                    this.emit('gcode:line', `→ ${gline}`);
                    if (!this.devMode && !this.serial.connected) {
                        const err = 'Not connected to machine';
                        this.emit('gcode:done', { error: err });
                        return { error: err };
                    }
                    if (this.devMode) {
                        await new Promise(r => setTimeout(r, 5));
                    } else {
                        await this._waitIfHeld();
                        if (this._aborted) return { error: 'Aborted' };
                        try { await this.serial.send(gline); } catch (e) {
                            if (this._aborted) return { error: 'Aborted' };
                            this.emit('gcode:done', { error: e.message });
                            return { error: e.message };
                        }
                    }
                }
            } else {
                this.emit('gcode:line', stripped);
                if (!this.devMode && !this.serial.connected) {
                    const err = 'Not connected to machine';
                    this.emit('gcode:done', { error: err });
                    return { error: err };
                }
                if (this.devMode) {
                    await new Promise(r => setTimeout(r, 5));
                } else {
                    await this._waitIfHeld();
                    if (this._aborted) return { error: 'Aborted' };
                    // $ system commands (e.g. $H, $L, $HZ) require GRBL to be IDLE.
                    // Wait for the machine to finish any queued motion before sending.
                    if (stripped.startsWith('$')) {
                        await this.serial.waitForIdle();
                        if (this._aborted) return { error: 'Aborted' };
                    }
                    try {
                        await this.serial.send(stripped);
                    } catch (e) {
                        if (this._aborted) return { error: 'Aborted' };
                        this.emit('gcode:done', { error: e.message });
                        return { error: e.message };
                    }
                }
            }
        }

        // Sync WCS from machine after file completes
        if (!this.devMode) {
            try {
                const hashLines = await this.serial.queryHash();
                this.memory.syncFromHashResponse(hashLines);
            } catch (_) { /* non-fatal */ }
        }

        return { ok: true };
    }

    // Reset running state (call at start of each public run method)
    _beginRun() {
        this._aborted = false;
        this._held = false;
        this._holdPromise = null;
        this._holdResolve = null;
        this.running = true;
        this._emitState();
    }

    _endRun() {
        this.running = false;
        this._emitState();
    }
}

module.exports = { WorkflowEngine, SLIDE_TYPES, FOOTPRINTS, DEPTHS };
