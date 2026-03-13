'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function appendLog(el, text, cls = '') {
    if (el.children.length > 600) el.removeChild(el.firstChild);
    const d = document.createElement('div');
    d.className = 'log-line' + (cls ? ' ' + cls : '');
    d.textContent = text;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
}

// ── State ──────────────────────────────────────────────────────────────────

let connected = false;
let currentLibPath = '';
let workflowState = { phase: 'idle', slideKey: null, running: false };
let currentFeedOverride = 100;   // 10–200 %
let currentSpindleOverride = 100; // 10–200 % (internal GRBL value)
const SPINDLE_MAX_RPM = 8000;    // GG3 hardware max spindle speed
let footprintOpts = [];   // [{ key, label, positions }]
let depthOpts = [];   // [{ key, label? }]
let currentView = 'idle';

const runtimeState = window.__ggRunnerRuntime || (window.__ggRunnerRuntime = {
    uiBound: false,
    eventsBound: false,
    initialized: false,
});

const FOOTPRINT_FILE_FALLBACKS = {
    RMR: 'Code/Footprint_Milling/rmr_5-32.gcode',
    Docter: 'Code/Footprint_Milling/docter_5-32.gcode',
    MOS: 'Code/Footprint_Milling/mos_5-32.gcode',
    RMS: 'Code/Footprint_Milling/rms_5-32.gcode',
    RMRcc: 'Code/Footprint_Milling/RMRcc Rough and finish.gcode',
    Viper: 'Code/Footprint_Milling/Viper Rough and finish.gcode',
    Razor: 'Code/Footprint_Milling/Razor Rough and finish.gcode',
    DPP: 'Code/Footprint_Milling/DPP Rough and Finish.gcode',
};

const FOOTPRINT_FILE_1911_FALLBACKS = {
};

// GRBL real-time override byte codes
const RT = {
    FEED_RESET: 0x90,
    FEED_PLUS10: 0x91,
    FEED_MINUS10: 0x92,
    FEED_PLUS1: 0x93,
    FEED_MINUS1: 0x94,
    RAPID_100: 0x95,
    RAPID_50: 0x96,
    RAPID_25: 0x97,
    SPINDLE_RESET: 0x99,
    SPINDLE_PLUS10: 0x9A,
    SPINDLE_MINUS10: 0x9B,
    SPINDLE_PLUS1: 0x9C,
    SPINDLE_MINUS1: 0x9D,
    FEED_HOLD: '!',
    CYCLE_START: '~',
    SOFT_RESET: '\x18',
};

// ── DOM ────────────────────────────────────────────────────────────────────

const portSelect = $('port-select');
const btnRefresh = $('btn-refresh');
const btnConnect = $('btn-connect');
const connStatus = $('conn-status');
const fwStatus = $('fw-status');
const machinePos = $('machine-pos');
const selectedSlideState = $('selected-slide-state');
const configuredSlideState = $('configured-slide-state');
const slideRadios = $('slide-radios');
const btnPosition = $('btn-position');
const btnProbe = $('btn-probe');
const btnConfigure = $('btn-configure');
const btnAbort = $('btn-abort');
const gcodeLog = $('gcode-log');
const runStepText = $('run-step-text');
const runProgressFill = $('run-progress-fill');
const runStepCount = $('run-step-count');
const instrTitle = $('instr-title');
const instrText = $('instr-text');
const instrImage = $('instr-image');
const btnContinue = $('btn-continue');
const btnInstrAbort = $('btn-instr-abort');
const doneIcon = $('done-icon');
const doneTitle = $('done-title');
const doneBody = $('done-body');
const fpSelect = $('fp-select');
const posSelect = $('pos-select');
const depthSelect = $('depth-select');
const footprintFile = $('footprint-file');
const resumeLineInput = $('resume-line');
const btnRunFp = $('btn-run-fp');
const holeSelect = $('hole-select');
const btnRunHoles = $('btn-run-holes');
const btnToolChange = $('btn-tool-change');
const btnHome = $('btn-home');
const btnLeftClamp = $('btn-left-clamp');
const btnRightClamp = $('btn-right-clamp');
const outputLog = $('output-log');
const manualIn = $('manual-in');
const btnSendManual = $('btn-send-manual');
const btnClear = $('btn-clear');
const memWrap = $('mem-wrap');
const memDump = $('mem-dump');
const fpSection = $('fp-section');
const holeSection = $('hole-section');
const froVal = $('fro-val');
const sroVal = $('sro-val');
const froSlider = $('fro-slider');
const sroSlider = $('sro-slider');
const btnFeedHold = $('btn-feed-hold');
const btnCycleStart = $('btn-cycle-start');
const btnSoftReset = $('btn-soft-reset');
const chkDevMode = $('chk-dev-mode');
const chkSanityDisable = $('chk-sanity-disable');
const libPathDisplay = $('lib-path-display');
const btnBrowseLib = $('btn-browse-lib');
const runResultRow = $('run-result-row');
const runResultIcon = $('run-result-icon');
const runResultText = $('run-result-text');
const btnNewRun = $('btn-new-run');
const runFileBtn = $('run-file-btn');

// ── View switching ─────────────────────────────────────────────────────────

function showView(name) {
    currentView = name;
    document.querySelectorAll('.center-view').forEach(el => {
        el.classList.toggle('active', el.id === 'view-' + name);
    });
}

// ── Phase dot + next-step highlight ──────────────────────────────────────

const phaseOrder = ['idle', 'positioned', 'probed', 'ready'];

function updatePhaseDots(phase) {
    const idx = phaseOrder.indexOf(phase);
    // dot-1 = positioned, dot-2 = probed, dot-3 = ready
    [$('dot-1'), $('dot-2'), $('dot-3')].forEach((dot, i) => {
        const reached = idx >= i + 1;
        dot.className = 'phase-dot ' + (reached ? 'dot-done' : 'dot-pending');
    });

    // Highlight the recommended next step button
    const nextMap = { idle: 'btn-position', positioned: 'btn-probe', probed: 'btn-configure', ready: null };
    [btnPosition, btnProbe, btnConfigure].forEach(b => b.classList.remove('step-next'));
    const nextId = nextMap[phase];
    if (nextId) $(nextId)?.classList.add('step-next');
}

// ── Slide population ────────────────────────────────────────────────────────

async function populateSlides() {
    if (!currentLibPath) {
        slideRadios.innerHTML = '<p class="dim note lib-prompt">Select a library folder first (📂 Library)</p>';
        return;
    }
    const slides = await window.gg.getSlides();
    slideRadios.innerHTML = '';
    for (const s of slides) {
        const label = document.createElement('label');
        label.className = 'radio-row';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'slide';
        radio.value = s.key;
        radio.addEventListener('change', () => onSlideChange(s.key));
        label.appendChild(radio);
        const span = document.createElement('span');
        span.textContent = s.label;
        if (s.maxDepth) {
            const note = document.createElement('span');
            note.className = 'dim note';
            note.textContent = ` (max ${s.maxDepth})`;
            span.appendChild(note);
        }
        label.appendChild(span);
        slideRadios.appendChild(label);
    }
}

async function onSlideChange(slideKey) {
    await window.gg.setSlide(slideKey);
    await refreshFootprints(slideKey);
    await refreshDepths(slideKey);
    workflowState = await window.gg.getState();
    updateSlideStateSummary();
    updateButtonStates();
}

async function refreshFootprints(slideKey) {
    footprintOpts = await window.gg.getFootprints(slideKey);
    fpSelect.innerHTML = '<option value="">Select optic…</option>';
    for (const fp of footprintOpts) {
        const o = document.createElement('option');
        o.value = fp.key;
        o.textContent = fp.label;
        fpSelect.appendChild(o);
    }
    onFpChange();
}

async function refreshDepths(slideKey) {
    depthOpts = await window.gg.getDepths(slideKey);
    depthSelect.innerHTML = '';
    for (const d of depthOpts) {
        const o = document.createElement('option');
        o.value = d.key;
        o.textContent = d.key;
        depthSelect.appendChild(o);
    }
    // Default to middle depth
    if (depthOpts.length) {
        const mid = Math.floor(depthOpts.length / 2);
        depthSelect.value = depthOpts[mid].key;
    }
}

function onFpChange() {
    const key = fpSelect.value;
    const fp = footprintOpts.find(f => f.key === key);
    posSelect.innerHTML = '';
    if (fp) {
        for (const p of fp.positions) {
            const o = document.createElement('option');
            o.value = p;
            o.textContent = p;
            posSelect.appendChild(o);
        }
    }
    updateFootprintFileDisplay();
    updateButtonStates();
}

function resolveFootprintFile(fp) {
    if (!fp) return '';

    const slideKey = workflowState.slideKey;
    if (slideKey === '1911' && FOOTPRINT_FILE_1911_FALLBACKS[fp.key]) {
        return FOOTPRINT_FILE_1911_FALLBACKS[fp.key];
    }

    return fp.millFile || FOOTPRINT_FILE_FALLBACKS[fp.key] || '';
}

function updateFootprintFileDisplay() {
    const fp = footprintOpts.find(f => f.key === fpSelect.value);
    const file = resolveFootprintFile(fp);
    if (file && currentLibPath) {
        const name = file.split('/').pop();
        footprintFile.textContent = name;
        footprintFile.title = `${file}  —  click to open`;
        footprintFile.dataset.path = currentLibPath + '/' + file;
        footprintFile.disabled = false;
    } else {
        footprintFile.textContent = '—';
        footprintFile.title = 'No footprint file selected';
        delete footprintFile.dataset.path;
        footprintFile.disabled = true;
    }
}

function getResumeLine() {
    const raw = resumeLineInput.value.trim();
    if (!raw) return 1;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function updateResumeLineState() {
    const line = getResumeLine();
    resumeLineInput.classList.toggle('input-invalid', line === null);
    btnRunFp.textContent = line && line > 1 ? 'Mill Footprint From Line' : 'Mill Footprint';
}

// ── Button state management ────────────────────────────────────────────────

function updateButtonStates() {
    const { phase, slideKey, running, devMode } = workflowState;
    const hasSlide = !!slideKey;
    const active = connected || devMode;
    const canSetup = active && hasSlide && !running && !!currentLibPath;
    const isReady = phase === 'ready';
    const canCut = active && isReady && !running;
    const canManualMachineMove = active && !running && !!currentLibPath;
    const resumeLine = getResumeLine();
    // Configure requires probe to have been run at least once
    const canConfigure = canSetup && (phase === 'probed' || phase === 'ready');

    btnPosition.disabled = !canSetup;
    btnProbe.disabled = !canSetup || phase === 'idle';
    btnConfigure.disabled = !canConfigure;
    btnAbort.classList.toggle('hidden', !running);
    btnToolChange.disabled = !canManualMachineMove;
    btnHome.disabled = !canManualMachineMove;
    btnLeftClamp.disabled = !canManualMachineMove;
    btnRightClamp.disabled = !canManualMachineMove;

    // Right cut panel
    const locked = !canCut;
    fpSection.classList.toggle('locked', locked);
    holeSection.classList.toggle('locked', locked);
    btnRunFp.disabled = locked || !fpSelect.value || !depthSelect.value || resumeLine === null;
    btnRunHoles.disabled = locked;
    updateResumeLineState();
}

function updateSlideStateSummary() {
    const selected = workflowState.slideLabel || 'None';
    const configured = workflowState.configuredSlideLabel || 'None';

    selectedSlideState.textContent = selected;
    configuredSlideState.textContent = configured;

    selectedSlideState.className = 'state-value ' + (workflowState.slideLabel ? 'state-ok' : 'state-empty');
    configuredSlideState.className = 'state-value ' + (!workflowState.configuredSlideLabel
        ? 'state-empty'
        : workflowState.configuredSlideMatches === false ? 'state-warn' : 'state-ok');

    selectedSlideState.title = workflowState.slideLabel || 'No slide selected';
    configuredSlideState.title = !workflowState.configuredSlideLabel
        ? 'No configured slide loaded yet'
        : workflowState.configuredSlideMatches === false
            ? 'Configured slide does not match the selected slide'
            : 'Configured slide matches the selected slide';
}

// ── Serial ─────────────────────────────────────────────────────────────────

async function refreshPorts() {
    const ports = await window.gg.listPorts();
    portSelect.innerHTML = '<option value="">Select port…</option>';
    for (const p of ports) {
        const o = document.createElement('option');
        o.value = p.path;
        o.textContent = p.path + (p.manufacturer ? ' – ' + p.manufacturer : '');
        portSelect.appendChild(o);
    }
}

function setConnected(val) {
    connected = val;
    connStatus.textContent = val ? 'Connected' : 'Disconnected';
    connStatus.className = 'badge ' + (val ? 'badge-on' : 'badge-off');
    btnConnect.textContent = val ? 'Disconnect' : 'Connect';
    updateButtonStates();
}

function setFirmwareStatus(info) {
    if (!connected || !info) {
        fwStatus.textContent = '';
        fwStatus.className = 'dim';
        return;
    }

    if (info.fwVersion) {
        fwStatus.textContent = `FW ${info.fwVersion}`;
        fwStatus.className = info.compatible ? 'dim fw-ok' : 'dim fw-bad';
        fwStatus.title = info.versionText || `Firmware ${info.fwVersion}`;
        return;
    }

    if (info.detected) {
        fwStatus.textContent = 'FW detected';
        fwStatus.className = 'dim fw-ok';
        fwStatus.title = info.versionText || 'Controller responded, but no build date was reported.';
        return;
    }

    fwStatus.textContent = 'FW unknown';
    fwStatus.className = 'dim fw-bad';
    fwStatus.title = info.error || info.versionText || 'Unable to detect firmware version';
}

function applyLibStatus(status, notify = false) {
    currentLibPath = status?.ok ? status.path : '';
    if (status?.ok) {
        libPathDisplay.textContent = status.path;
        libPathDisplay.title = status.path;
        libPathDisplay.classList.remove('lib-invalid');
    } else if (status?.error && status.error !== 'No library selected') {
        libPathDisplay.textContent = status.error;
        libPathDisplay.title = status.error;
        libPathDisplay.classList.add('lib-invalid');
        if (notify) alert(status.error);
    } else {
        libPathDisplay.textContent = 'No library selected';
        libPathDisplay.title = 'Click 📂 Library to select your gcode library folder';
        libPathDisplay.classList.remove('lib-invalid');
    }
}

// ── Cut helpers ────────────────────────────────────────────────────────────

function startRun(label) {
    showView('running');
    gcodeLog.innerHTML = '';
    runStepText.textContent = label;
    runProgressFill.style.width = '0%';
    runStepCount.textContent = '';
    runResultRow.classList.add('hidden');
    btnNewRun.classList.add('hidden');
    runFileBtn.textContent = '—';
    delete runFileBtn.dataset.path;
    appendLog(gcodeLog, '▶ ' + label, 'dim');
}

function showDone(ok, title, body) {
    // Stay on view-running so the gcode log remains visible
    runResultRow.className = ok ? 'run-result-ok' : 'run-result-err';
    runResultIcon.textContent = ok ? '✓' : '✕';
    runResultText.textContent = body || title;
    if (ok) runProgressFill.style.width = '100%';
    runStepText.textContent = title;
    btnNewRun.classList.remove('hidden');
}

function resetRun() {
    gcodeLog.innerHTML = '';
    runResultRow.classList.add('hidden');
    btnNewRun.classList.add('hidden');
    runProgressFill.style.width = '0%';
    runStepCount.textContent = '';
    runStepText.textContent = 'Running…';
    showView('idle');
}

// ── Event bindings ─────────────────────────────────────────────────────────

function bindUI() {
    if (runtimeState.uiBound) return;
    runtimeState.uiBound = true;

    btnRefresh.addEventListener('click', refreshPorts);

    btnConnect.addEventListener('click', async () => {
        if (connected) {
            await window.gg.disconnect();
            setConnected(false);
        } else {
            const port = portSelect.value;
            if (!port) { alert('Select a port first.'); return; }
            const r = await window.gg.connect(port);
            if (r?.ok) {
                setConnected(true);
                setFirmwareStatus(r.firmware);
                if (r.firmware && !r.firmware.compatible) {
                    alert(r.firmware.fwVersion
                        ? `Detected firmware ${r.firmware.fwVersion}. The reference library requires at least 20220800.`
                        : 'Unable to detect firmware version. Operations will be blocked until the controller responds to $I.');
                }
            } else {
                alert('Connection failed: ' + (r?.error || 'Unknown error'));
            }
        }
    });

    btnPosition.addEventListener('click', () => {
        startRun('Positioning slide…');
        window.gg.position();
    });

    btnProbe.addEventListener('click', () => {
        startRun('Probing slide…');
        window.gg.probe();
    });

    btnConfigure.addEventListener('click', () => {
        startRun('Configuring work coordinates…');
        window.gg.configure();
    });

    btnAbort.addEventListener('click', () => {
        window.gg.abort();
    });

    fpSelect.addEventListener('change', onFpChange);
    depthSelect.addEventListener('change', updateButtonStates);
    resumeLineInput.addEventListener('input', updateButtonStates);

    btnRunFp.addEventListener('click', () => {
        const fp = fpSelect.value;
        const pos = posSelect.value;
        const depth = depthSelect.value;
        const startLine = getResumeLine();
        if (!fp || !depth || startLine === null) return;
        const fpLabel = footprintOpts.find(f => f.key === fp)?.label || fp;
        const lineSuffix = startLine > 1 ? ` from line ${startLine}` : '';
        startRun(`Milling ${fpLabel} – ${pos} at ${depth}${lineSuffix}…`);
        window.gg.runFootprint(fp, pos, depth, startLine, workflowState.slideKey);
    });

    btnRunHoles.addEventListener('click', () => {
        const holeType = holeSelect.value;
        startRun(`Drilling & Tapping (${holeType})…`);
        window.gg.runHoles(holeType);
    });

    btnToolChange.addEventListener('click', () => {
        startRun('Moving to tool change position…');
        window.gg.toolChange();
    });

    btnHome.addEventListener('click', () => {
        startRun('Homing machine…');
        window.gg.home();
    });

    btnLeftClamp.addEventListener('click', () => {
        startRun('Moving to left clamp position…');
        window.gg.leftClamp();
    });

    btnRightClamp.addEventListener('click', () => {
        startRun('Moving to right clamp position…');
        window.gg.rightClamp();
    });

    footprintFile.addEventListener('click', () => {
        if (footprintFile.dataset.path) window.gg.openFile(footprintFile.dataset.path);
    });

    btnContinue.addEventListener('click', () => {
        showView('running');
        window.gg.continueStep();
    });

    btnInstrAbort.addEventListener('click', () => {
        window.gg.abort();
        showView('running');
    });

    btnSendManual.addEventListener('click', sendManual);
    manualIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendManual(); });
    btnClear.addEventListener('click', () => { outputLog.innerHTML = ''; });

    btnNewRun.addEventListener('click', resetRun);

    runFileBtn.addEventListener('click', () => {
        if (runFileBtn.dataset.path) window.gg.openFile(runFileBtn.dataset.path);
    });

    memWrap.addEventListener('toggle', refreshMem);

    bindOverrides();
}

function sendManual() {
    const line = manualIn.value.trim();
    if (!line) return;
    window.gg.sendLine(line);
    appendLog(outputLog, '> ' + line, 'sent');
    manualIn.value = '';
}

function _setSliderPct(slider, value, min, max) {
    const pct = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--pct', pct.toFixed(1));
}

// Send RESET then ramp from 100 to target — used on final commit (mouseup/change).
function _sendIncrements(reset, target, plus10, minus10, plus1, minus1) {
    window.gg.sendRealtime(reset); // reset to 100%
    let v = 100;
    while (v < target - 9) { window.gg.sendRealtime(plus10); v += 10; }
    while (v > target + 9) { window.gg.sendRealtime(minus10); v -= 10; }
    while (v < target) { window.gg.sendRealtime(plus1); v += 1; }
    while (v > target) { window.gg.sendRealtime(minus1); v -= 1; }
}

// Send only the delta between current and next during drag — faster response.
function _sendDelta(from, to, plus10, minus10, plus1, minus1) {
    let v = from;
    while (v < to - 9) { window.gg.sendRealtime(plus10); v += 10; }
    while (v > to + 9) { window.gg.sendRealtime(minus10); v -= 10; }
    while (v < to) { window.gg.sendRealtime(plus1); v += 1; }
    while (v > to) { window.gg.sendRealtime(minus1); v -= 1; }
    return v;
}

function bindOverrides() {
    // Rapid preset buttons
    document.querySelectorAll('.btn-rapid').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-rapid').forEach(b => b.classList.remove('active-rapid'));
            btn.classList.add('active-rapid');
            window.gg.sendRealtime(parseInt(btn.dataset.cmd, 16));
        });
    });

    // Feed slider
    froSlider.addEventListener('input', () => {
        const target = parseInt(froSlider.value);
        froVal.textContent = target + '%';
        _setSliderPct(froSlider, target, 10, 200);
        // Send delta bytes immediately while dragging so the machine responds in real-time
        currentFeedOverride = _sendDelta(currentFeedOverride, target,
            RT.FEED_PLUS10, RT.FEED_MINUS10, RT.FEED_PLUS1, RT.FEED_MINUS1);
    });
    froSlider.addEventListener('change', () => {
        // On release: hard reset + ramp to guarantee sync with GRBL's actual state
        const target = parseInt(froSlider.value);
        _sendIncrements(RT.FEED_RESET, target,
            RT.FEED_PLUS10, RT.FEED_MINUS10, RT.FEED_PLUS1, RT.FEED_MINUS1);
        currentFeedOverride = target;
    });
    $('btn-fro-reset').addEventListener('click', () => {
        window.gg.sendRealtime(RT.FEED_RESET);
        currentFeedOverride = 100;
        froVal.textContent = '100%';
        froSlider.value = 100;
        _setSliderPct(froSlider, 100, 10, 200);
    });

    // RPM slider — value is actual RPM (1000–8000), converted to % override
    // relative to the gcode's programmed S value before sending to GRBL.
    sroSlider.addEventListener('input', () => {
        const rpm = parseInt(sroSlider.value);
        sroVal.textContent = rpm;
        _setSliderPct(sroSlider, rpm, 1000, 8000);
        const targetPct = Math.round(Math.max(10, Math.min(200, (rpm / SPINDLE_MAX_RPM) * 100)));
        currentSpindleOverride = _sendDelta(currentSpindleOverride, targetPct,
            RT.SPINDLE_PLUS10, RT.SPINDLE_MINUS10, RT.SPINDLE_PLUS1, RT.SPINDLE_MINUS1);
    });
    sroSlider.addEventListener('change', () => {
        // Do NOT send SPINDLE_RESET here — on a VFD spindle it cuts power momentarily
        // and stops the tool. Just send the remaining delta to reach the target.
        const rpm = parseInt(sroSlider.value);
        const targetPct = Math.round(Math.max(10, Math.min(200, (rpm / SPINDLE_MAX_RPM) * 100)));
        currentSpindleOverride = _sendDelta(currentSpindleOverride, targetPct,
            RT.SPINDLE_PLUS10, RT.SPINDLE_MINUS10, RT.SPINDLE_PLUS1, RT.SPINDLE_MINUS1);
    });
    $('btn-sro-reset').addEventListener('click', () => {
        window.gg.sendRealtime(RT.SPINDLE_RESET);
        currentSpindleOverride = 100;
        sroVal.textContent = SPINDLE_MAX_RPM;
        sroSlider.value = SPINDLE_MAX_RPM;
        _setSliderPct(sroSlider, SPINDLE_MAX_RPM, 1000, 8000);
    });

    btnFeedHold.addEventListener('click', () => window.gg.hold());
    btnCycleStart.addEventListener('click', () => window.gg.resume());
    btnSoftReset.addEventListener('click', () => window.gg.abort());
    chkDevMode.addEventListener('change', () => {
        window.gg.setDevMode(chkDevMode.checked);
    });

    chkSanityDisable.addEventListener('change', () => {
        window.gg.setSanityChecksDisabled(chkSanityDisable.checked);
    });
    btnBrowseLib.addEventListener('click', async () => {
        const result = await window.gg.browseLibPath();
        if (result.ok) {
            applyLibStatus(await window.gg.getLibStatus());
            await populateSlides();
            updateButtonStates();
        } else if (result.error) {
            applyLibStatus({ ok: false, error: result.error }, true);
        }
    });
}

// ── Machine / workflow events ──────────────────────────────────────────────

function bindEvents() {
    if (runtimeState.eventsBound) return;
    runtimeState.eventsBound = true;

    window.gg.on('machine:status', (s) => {
        const pos = s.pos
            ? `  X:${s.pos.x.toFixed(3)} Y:${s.pos.y.toFixed(3)} Z:${s.pos.z.toFixed(3)}`
            : '';
        machinePos.textContent = s.state + pos;
        if (s.overrides) {
            currentFeedOverride = s.overrides.feed;
            currentSpindleOverride = s.overrides.spindle;
            froVal.textContent = s.overrides.feed + '%';
            // Convert GRBL spindle % back to RPM for display
            const spindleRpm = Math.round((s.overrides.spindle / 100) * SPINDLE_MAX_RPM);
            sroVal.textContent = spindleRpm;
            if (!froSlider.matches(':active')) {
                froSlider.value = s.overrides.feed;
                _setSliderPct(froSlider, s.overrides.feed, 10, 200);
            }
            if (!sroSlider.matches(':active')) {
                sroSlider.value = spindleRpm;
                _setSliderPct(sroSlider, spindleRpm, 1000, 8000);
            }
        }
    });

    window.gg.on('machine:firmware', (info) => {
        setFirmwareStatus(info);
    });

    window.gg.on('machine:line', (l) => appendLog(outputLog, l));

    window.gg.on('machine:alarm', (a) => {
        appendLog(outputLog, 'ALARM: ' + a, 'err');
        appendLog(gcodeLog, 'ALARM: ' + a, 'err');
    });

    window.gg.on('gcode:file', ({ relPath, fullPath }) => {
        const name = relPath.split('/').pop();
        runFileBtn.textContent = name;
        runFileBtn.dataset.path = fullPath;
        runFileBtn.title = `${relPath}  —  click to open`;
    });

    window.gg.on('gcode:line', (l) => {
        const cls = l.startsWith('⚠') ? 'err' : l.startsWith('→') ? 'dim' : l.startsWith('✓') ? 'ok' : '';
        appendLog(gcodeLog, l, cls);
        // Mirror to output log so it's always visible on the right panel
        appendLog(outputLog, l, 'dim');
    });

    window.gg.on('gcode:done', async (result) => {
        if (result.error === 'Aborted') {
            appendLog(gcodeLog, '● Aborted', 'err');
            showDone(false, 'Aborted', 'Run stopped by user.');
        } else if (result.error) {
            appendLog(gcodeLog, '⚠ ' + result.error, 'err');
            showDone(false, 'Error', result.error);
        } else if (result.ok) {
            appendLog(gcodeLog, '✓ Complete', 'ok');
            const phaseMsg = {
                'positioned': 'Slide positioned — clamp the slide, then Probe.',
                'probed': 'Probe complete — click Configure to set work coordinates.',
                'ready': 'Machine configured and ready to cut.',
            };
            const msg = result.action === 'tool-change'
                ? 'Machine moved to the tool change position.'
                : phaseMsg[result.phase] || 'Operation complete.';
            showDone(true, 'Done', msg);
            await refreshMem();
        }
        // workflowState.running is reset via workflow:state event
    });

    window.gg.on('workflow:state', (state) => {
        workflowState = state;
        updatePhaseDots(state.phase);
        updateSlideStateSummary();
        updateFootprintFileDisplay();
        updateButtonStates();
        if (chkDevMode) chkDevMode.checked = !!state.devMode;
        if (chkSanityDisable) chkSanityDisable.checked = !!state.sanityChecksDisabled;
        btnFeedHold.classList.toggle('btn-rt-held', !!state.held);
        btnCycleStart.classList.toggle('btn-rt-active', !!state.held);
        // Restore the radio selection if slide changed
        if (state.slideKey) {
            const radio = slideRadios.querySelector(`input[value="${CSS.escape(state.slideKey)}"]`);
            if (radio) radio.checked = true;
        }
    });

    window.gg.on('workflow:step', (step) => {
        runStepText.textContent = step.text;
        if (step.total > 1) {
            runProgressFill.style.width = Math.round((step.index / step.total) * 100) + '%';
            runStepCount.textContent = `Step ${step.index} of ${step.total}`;
        }
    });

    window.gg.on('machine:disconnect', () => {
        setConnected(false);
        setFirmwareStatus(null);
        currentFeedOverride = 100;
        currentSpindleOverride = 100;
        froVal.textContent = '100%';
        sroVal.textContent = SPINDLE_MAX_RPM;
        froSlider.value = 100;
        sroSlider.value = SPINDLE_MAX_RPM;
        _setSliderPct(froSlider, 100, 10, 200);
        _setSliderPct(sroSlider, SPINDLE_MAX_RPM, 1000, 8000);
        appendLog(outputLog, '⚠ Machine disconnected', 'err');
    });

    window.gg.on('workflow:instruction', (step) => {
        instrTitle.textContent = 'Action Required';
        instrText.textContent = step.text;
        if (step.image) {
            instrImage.src = 'file://' + step.image;
            instrImage.classList.remove('hidden');
            instrImage.onerror = () => instrImage.classList.add('hidden');
        } else {
            instrImage.classList.add('hidden');
        }
        showView('instruction');
    });
}

async function refreshMem() {
    if (!memWrap.open) return;
    const data = await window.gg.dumpMemory();
    memDump.textContent = JSON.stringify(data, null, 2);
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
    if (runtimeState.initialized) return;
    runtimeState.initialized = true;

    await refreshPorts();
    const libStatus = await window.gg.getLibStatus();
    applyLibStatus(libStatus, !!libStatus?.path && !libStatus?.ok);
    await populateSlides();

    const firmware = await window.gg.getFirmwareInfo();
    setFirmwareStatus(firmware);

    // Restore last state from main process
    workflowState = await window.gg.getState();
    updatePhaseDots(workflowState.phase);
    updateSlideStateSummary();
    if (workflowState.slideKey) {
        await refreshFootprints(workflowState.slideKey);
        await refreshDepths(workflowState.slideKey);
        const radio = slideRadios.querySelector(
            `input[value="${CSS.escape(workflowState.slideKey)}"]`
        );
        if (radio) radio.checked = true;
    }

    updateButtonStates();
    updateResumeLineState();
    bindUI();
    bindEvents();
}

init();
