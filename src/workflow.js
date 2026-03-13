'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { normalizeLibraryGcodeLine } = require('./library-compat');

const DDCUT_MCODE = /^M(100|101|102|106|107|108)\b/i;
const MIN_FW_VERSION = 20220800;
const SLIDE_TYPE_CODES = {
    'G17/19/26': 1,
    'G43/48': 2,
    '1911': 3,
    'P320': 4,
    'G20': 5,
    'M&P2.0': 6,
};
const CODE_TO_SLIDE_KEY = Object.fromEntries(
    Object.entries(SLIDE_TYPE_CODES).map(([key, code]) => [code, key])
);

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
        rearOnly: ['MOS'],
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
        footprints: ['RMR', 'Docter', 'RMS', 'RMRcc', 'Viper', 'Razor', 'DPP'],
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
        label: 'MOS / Holosun SCS', configs: { Rear: 'Code/Footprint_Configs/mos_rear_config.gcode' }, mill: 'Code/Footprint_Milling/mos_5-32.gcode',
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
        { type: 'instruction', text: 'Confirm the 1/16" endmill made good contact during Z probe. If you did not hear or see probe contact, clean the tool and clamp, then abort and rerun before continuing.', image: 'Image/_DSC9721.jpg' },
        { type: 'gcode', text: 'Setting left hole position', file: 'Code/Hole_Cutting/set_left_hole.gcode' },
        { type: 'gcode', text: `Boring left hole (${t})`, file: borefile },
        { type: 'gcode', text: 'Setting right hole position', file: 'Code/Hole_Cutting/set_right_hole.gcode' },
        { type: 'gcode', text: `Boring right hole (${t})`, file: borefile },
        { type: 'gcode', text: 'Moving to tool change position', file: 'Code/tool_change.gcode' },
        { type: 'instruction', text: `Remove 1/16" endmill. Install ${toolLabel}. Push all the way in and tighten.`, image: null },
        // Z reprobe is required after installing the threadmill — it has a different tool length than the 1/16" endmill.
        { type: 'gcode', text: 'Z probing with threadmill', file: 'Code/Slide_Probing/Z Reprobe 1.5 - 2.5 OAL.nc' },
        { type: 'instruction', text: 'Confirm the threadmill made good contact during Z probe. If contact looked wrong, clean the tool and clamp, then abort and rerun before continuing.', image: 'Image/_DSC9726.jpg' },
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
        const is1911 = !!slide.is1911;
        return slide.footprints.map(k => {
            const fp = FOOTPRINTS[k];
            const rearOnly = slide.rearOnly.includes(k);
            return {
                key: k,
                label: fp.label,
                positions: rearOnly ? ['Rear'] : ['Rear', 'Standard'],
                millFile: (is1911 && fp.mill1911) ? fp.mill1911 : fp.mill,
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
        const configuredSlideKey = this._getConfiguredSlideKey();
        return {
            phase: this.phase,
            slideKey: this.slideKey,
            slideLabel: this.slideKey ? SLIDE_TYPES[this.slideKey]?.label || this.slideKey : null,
            configuredSlideKey,
            configuredSlideLabel: configuredSlideKey ? SLIDE_TYPES[configuredSlideKey]?.label || configuredSlideKey : null,
            configuredSlideMatches: configuredSlideKey ? configuredSlideKey === this.slideKey : null,
            running: this.running,
            devMode: this.devMode,
            held: this._held,
        };
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
        this.memory.reset();
        this._emitState();
    }

    // ── Probe sequence ───────────────────────────────────────────────────────

    async runPosition() {
        const slide = this._requireSlide();
        if (!slide) return;
        const ready = await this._preflightCheck({ allowAlarm: true });
        if (!ready) return;

        // Move endmill to slide-loading position (bumped against slide for X reference)
        const positionResult = await this._runFile(slide.position, 'Moving to slide loading position…');
        if (positionResult?.error) return;
        if (this._aborted) return;

        // Pause: user installs slide, soft jaws, probe eyelet, verifies conductivity
        const aborted = await this._waitForContinue(slide.installNote, 'Image/DSC09727.jpg');
        if (aborted) return;

        // Retract endmill from slide so Z probe can start
        const retractResult = await this._runFile(slide.retract, 'Retracting from slide…');
        if (retractResult?.error) return;
        if (!this._aborted) {
            this.phase = 'positioned';
            this._emitState();
            this.emit('gcode:done', { ok: true, phase: 'positioned' });
        }
    }

    async runToolChange() {
        const ready = await this._preflightCheck({ allowAlarm: true });
        if (!ready) return;

        this.emit('step', { index: 1, total: 1, text: 'Moving to tool change position…' });
        const result = await this._runFile('Code/tool_change.gcode', 'Moving to tool change position…');
        if (result?.error || this._aborted) return;

        this.emit('gcode:done', { ok: true, action: 'tool-change' });
    }

    async runProbe() {
        const slide = this._requireSlide();
        if (!slide) return;
        if (this.phase === 'idle') {
            this.emit('gcode:done', { error: 'Run Position before Probe.' });
            return;
        }
        const ready = await this._preflightCheck({ allowAlarm: true });
        if (!ready) return;
        const probeResult = await this._runFile(slide.probe, 'Probing slide…');
        if (probeResult?.error) return;
        if (this._aborted) return;
        const aborted = await this._waitForContinue(
            'Confirm the slide probe made good contact. If you did not hear or see contact with the slide or clamp, abort, clean the contact surfaces, and rerun Probe.',
            'Image/_DSC9721.jpg'
        );
        if (aborted) return;
        if (!this._aborted) {
            this.phase = 'probed';
            this._emitState();
            this.emit('gcode:done', { ok: true, phase: 'probed' });
        }
    }

    async runConfigure() {
        const slide = this._requireSlide();
        if (!slide) return;
        if (this.phase !== 'probed' && this.phase !== 'ready') {
            this.emit('gcode:done', { error: 'Run Probe before Configure.' });
            return;
        }
        const ready = await this._preflightCheck();
        if (!ready) return;
        const configureResult = await this._runFile(slide.configure, 'Configuring work coordinates…');
        if (configureResult?.error) return;
        if (!this._aborted) {
            this.phase = 'ready';
            this._emitState();
            this.emit('gcode:done', { ok: true, phase: 'ready' });
        }
    }

    // ── Cut operations ───────────────────────────────────────────────────────

    async runFootprint(fpKey, position, depthKey, startLine = 1, selectedSlideKey = null) {
        if (selectedSlideKey && SLIDE_TYPES[selectedSlideKey] && selectedSlideKey !== this.slideKey) {
            this.slideKey = selectedSlideKey;
            this._emitState();
        }

        const slide = this._requireSlide();
        const fp = FOOTPRINTS[fpKey];
        if (!slide || !fp) return;
        if (this.phase !== 'ready') {
            this.emit('gcode:done', { error: 'Run Configure before milling a footprint.' });
            return;
        }
        if (!this._validateConfiguredSlide()) return;
        const ready = await this._preflightCheck();
        if (!ready) return;

        const resumeLine = Number.parseInt(startLine, 10);
        if (!Number.isInteger(resumeLine) || resumeLine < 1) {
            this.emit('gcode:done', { error: 'Start line must be a whole number greater than or equal to 1.' });
            return;
        }

        const is1911 = !!SLIDE_TYPES[this.slideKey].is1911;
        const cfgFile = (is1911 && fp.configs1911) ? fp.configs1911[position] : fp.configs[position];
        const millFile = (is1911 && fp.mill1911) ? fp.mill1911 : fp.mill;
        const depthObj = DEPTHS.find(d => d.key === depthKey);
        if (!cfgFile || !millFile || !depthObj) {
            this.emit('gcode:done', { error: 'Invalid footprint/depth combination' });
            return;
        }

        this.emit('gcode:line', `Selected slide: ${slide.label}`);
        this.emit('gcode:line', `Config file: ${cfgFile}`);
        this.emit('gcode:line', `Depth file: ${depthObj.file}`);
        this.emit('gcode:line', `Mill file: ${millFile}`);

        const files = [
            { file: cfgFile, text: `Configuring ${fp.label} – ${position}…` },
            { file: depthObj.file, text: `Setting depth to ${depthKey}…` },
        ];

        // 1911 MOS requires a home before milling to unlock the spindle
        if (is1911 && fp.mill1911) {
            files.push({ file: 'Code/home.gcode', text: 'Homing before milling…' });
        }
        files.push({
            file: millFile,
            text: resumeLine > 1
                ? `Milling ${fp.label} from line ${resumeLine}…`
                : `Milling ${fp.label}…`,
            startLine: resumeLine,
        });

        for (let i = 0; i < files.length; i++) {
            if (this._aborted) break;
            const { file, text, startLine: fileStartLine } = files[i];
            this.emit('step', { index: i + 1, total: files.length, text });
            const result = fileStartLine > 1
                ? await this._runFileFromLine(file, text, fileStartLine)
                : await this._runFile(file, text);
            if (result?.error) return;
        }
        if (!this._aborted) {
            // Home the machine after completing the footprint cut
            const homeResult = await this._runFile('Code/home.gcode', 'Homing machine…');
            if (homeResult?.error) return;
            this.emit('gcode:done', { ok: true });
        }
    }

    async runHoles(holeType) {
        const slide = this._requireSlide();
        if (!slide) return;
        if (this.phase !== 'ready') {
            this.emit('gcode:done', { error: 'Run Configure before drilling or tapping holes.' });
            return;
        }
        if (!this._validateConfiguredSlide()) return;
        const ready = await this._preflightCheck();
        if (!ready) return;
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
            const homeResult = await this._runFile('Code/home.gcode', 'Homing machine…');
            if (homeResult?.error) return;
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
        if (!this.running) return;
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

    _validateLibrary() {
        if (!this.libPath) {
            return { ok: false, error: 'No library selected.' };
        }
        if (!fs.existsSync(this.libPath)) {
            return { ok: false, error: 'Library folder not found.' };
        }
        if (!fs.statSync(this.libPath).isDirectory()) {
            return { ok: false, error: 'Library path is not a folder.' };
        }
        if (!fs.existsSync(path.join(this.libPath, 'Code'))) {
            return { ok: false, error: 'Library is missing the Code folder.' };
        }
        return { ok: true };
    }

    async _preflightCheck(options = {}) {
        const { allowAlarm = false } = options;
        const lib = this._validateLibrary();
        if (!lib.ok) {
            this.emit('gcode:done', { error: lib.error });
            return false;
        }

        if (this.devMode) return true;

        if (!this.serial.connected) {
            this.emit('gcode:done', { error: 'Not connected to machine.' });
            return false;
        }

        let firmware = this.serial.getFirmwareInfo();
        if (!firmware.fwVersion) {
            try {
                firmware = await this.serial.queryBuildInfo();
            } catch (_) {
                firmware = this.serial.getFirmwareInfo();
            }
        }
        if (!firmware.detected) {
            this.emit('gcode:done', { error: 'Unable to detect machine firmware. Reconnect and verify the controller responds to $I.' });
            return false;
        }
        if (firmware.fwVersion !== null && firmware.fwVersion < MIN_FW_VERSION) {
            this.emit('gcode:done', { error: `Firmware ${firmware.fwVersion} is below required ${MIN_FW_VERSION}.` });
            return false;
        }

        let status;
        try {
            status = await this.serial.queryStatus();
        } catch (e) {
            this.emit('gcode:done', { error: `Unable to read machine status: ${e.message}` });
            return false;
        }

        const state = String(status.state || 'Unknown').split(':')[0];
        if (state === 'Alarm') {
            if (allowAlarm) {
                // Unlock the alarm so subsequent G-code can run.
                // $H in the file will home if enabled; if homing is disabled,
                // $X is the only way to clear the lock.
                try { await this.serial.send('$X'); } catch (_) { /* best-effort */ }
                return true;
            }
            this.emit('gcode:done', { error: 'Machine is in Alarm. Clear the alarm before starting.' });
            return false;
        }
        if (state !== 'Idle') {
            this.emit('gcode:done', { error: `Machine must be Idle before starting. Current state: ${status.state}.` });
            return false;
        }

        return true;
    }

    _validateConfiguredSlide() {
        const expected = SLIDE_TYPE_CODES[this.slideKey];
        const configured = this.memory.getNamed('slide_type');

        if (!expected) return true;
        if (configured === expected) return true;

        const label = SLIDE_TYPES[this.slideKey]?.label || this.slideKey;
        if (!configured) {
            this.emit('gcode:done', { error: `Slide ${label} is selected, but no slide configuration is loaded. Run Configure again before cutting.` });
            return false;
        }

        this.emit('gcode:done', { error: `Selected slide is ${label}, but the loaded configuration belongs to a different slide. Re-run Position, Probe, and Configure before cutting.` });
        return false;
    }

    _getConfiguredSlideKey() {
        const code = this.memory.getNamed('slide_type');
        return CODE_TO_SLIDE_KEY[code] || null;
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
        this.emit('gcode:line', `File: ${relPath}`);

        return this._runLines(lines.map(sourceLine => normalizeLibraryGcodeLine(relPath, sourceLine)), _label);
    }

    async _runFileFromLine(relPath, _label, startLine) {
        if (startLine <= 1) return this._runFile(relPath, _label);
        if (this._aborted) return { error: 'Aborted' };

        const full = path.join(this.libPath, relPath);
        if (!fs.existsSync(full)) {
            const err = `File not found: ${relPath}`;
            this.emit('gcode:done', { error: err });
            return { error: err };
        }

        const lines = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n');
        if (startLine > lines.length) {
            const err = `Start line ${startLine} is past the end of ${path.basename(relPath)} (${lines.length} lines).`;
            this.emit('gcode:done', { error: err });
            return { error: err };
        }

        const preambleEndLine = this._findResumePreambleEndLine(relPath, lines);
        const usePreamble = preambleEndLine > 0 && startLine > preambleEndLine;
        const preamble = usePreamble ? lines.slice(0, preambleEndLine) : [];
        const sliced = lines
            .slice(startLine - 1)
            .map(sourceLine => normalizeLibraryGcodeLine(relPath, sourceLine));

        this.emit('gcode:line', `File: ${relPath}`);
        if (usePreamble) {
            this.emit('gcode:line', `↷ Preserving setup lines 1-${preambleEndLine}, then resuming at line ${startLine}`);
        } else {
            this.emit('gcode:line', `↷ Resuming ${path.basename(relPath)} from line ${startLine}`);
        }

        const resumeLines = usePreamble
            ? preamble.map(sourceLine => normalizeLibraryGcodeLine(relPath, sourceLine)).concat(sliced)
            : sliced;

        return this._runLines(resumeLines, _label);
    }

    _findResumePreambleEndLine(relPath, lines) {
        for (let i = 0; i < lines.length; i++) {
            const rawLine = normalizeLibraryGcodeLine(relPath, lines[i]);
            const rawTrimmed = rawLine.trim();
            const stripped = DDCUT_MCODE.test(rawTrimmed)
                ? rawTrimmed
                : rawLine.replace(/\([^)]*\)/g, '').trim();

            if (!stripped) continue;
            if (DDCUT_MCODE.test(stripped)) continue;

            // Stop once the file starts commanding motion with coordinates.
            if (/[XYZIJK]/i.test(stripped)) return i;
        }
        return 0;
    }

    async _runLines(lines, _label) {
        if (this._aborted) return { error: 'Aborted' };

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
                    // waitForIdle() resolves for both Idle and Alarm, so $H still
                    // works when clearing an alarm (no motion to wait on).
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
                await this.serial.waitForIdle();
                const hashLines = await this.serial.queryHash();
                this.memory.syncFromHashResponse(hashLines);
            } catch (_) { /* non-fatal */ }
        }

        return { ok: true };
    }
    // Reset running state (call at start of each public run method).
    // Returns false if already running — callers must check and bail.
    _beginRun() {
        if (this.running) return false;
        this._aborted = false;
        this._held = false;
        this._holdPromise = null;
        this._holdResolve = null;
        this.running = true;
        this._emitState();
        return true;
    }

    _endRun() {
        this.running = false;
        this._emitState();
    }
}

module.exports = { WorkflowEngine, SLIDE_TYPES, FOOTPRINTS, DEPTHS };
