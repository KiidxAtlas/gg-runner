'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Memory } = require('./src/memory');
const { Interpreter } = require('./src/interpreter');
const { SerialManager } = require('./src/serial-manager');
const { WorkflowEngine } = require('./src/workflow');

// ── Settings persistence ─────────────────────────────────────────────────────

const MIN_FW_VERSION = 20220800;

const SETTINGS_PATH = path.join(app.getPath('userData'), 'gg-runner-settings.json');

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch { return {}; }
}

function saveSettings(updates) {
    const current = loadSettings();
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ ...current, ...updates }, null, 2));
}

function validateLibPath(candidate) {
    if (!candidate) return { ok: false, path: '', error: 'No library selected' };
    if (!fs.existsSync(candidate)) return { ok: false, path: candidate, error: 'Library folder not found' };
    if (!fs.statSync(candidate).isDirectory()) return { ok: false, path: candidate, error: 'Library path is not a folder' };
    if (!fs.existsSync(path.join(candidate, 'Code'))) return { ok: false, path: candidate, error: 'Library is missing the Code folder' };
    if (!fs.existsSync(path.join(candidate, 'manifest.yml'))) return { ok: false, path: candidate, error: 'Library is missing manifest.yml' };
    return { ok: true, path: candidate };
}

const loadedSettings = loadSettings();
let libPath = loadedSettings.libPath || '';
if (libPath && !validateLibPath(libPath).ok) {
    libPath = '';
    saveSettings({ libPath: '' });
}

let mainWindow;
const memory = new Memory();
const interpreter = new Interpreter(memory);
const serial = new SerialManager();
const workflow = new WorkflowEngine(libPath, memory, interpreter, serial);
if (loadedSettings.devMode) workflow.setDevMode(true);
if (loadedSettings.sanityChecksDisabled) workflow.setSanityChecksDisabled(true);

function summarizeFirmware(info, error) {
    const detected = !!(info?.detected || (info?.rawLines && info.rawLines.length) || (info?.versionText && info.versionText !== 'Unknown'));
    const compatible = info?.fwVersion !== null && info?.fwVersion !== undefined
        ? info.fwVersion >= MIN_FW_VERSION
        : detected;
    return {
        ...info,
        detected,
        compatible,
        error,
    };
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1100,
        minHeight: 680,
        backgroundColor: '#0e1115',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'GG Runner',
    });

    if (process.env.VITE_DEV) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'renderer', 'index.html'));
    }
}

app.whenReady().then(() => {
    createWindow();

    // ── Forward serial events to renderer ───
    serial.on('status', (s) => mainWindow?.webContents.send('machine:status', s));
    serial.on('firmware', (s) => mainWindow?.webContents.send('machine:firmware', summarizeFirmware(s)));
    serial.on('line', (l) => mainWindow?.webContents.send('machine:line', l));
    serial.on('alarm', (a) => mainWindow?.webContents.send('machine:alarm', a));
    serial.on('disconnect', () => mainWindow?.webContents.send('machine:disconnect'));

    // ── Forward workflow events to renderer ──
    workflow.on('state', (s) => mainWindow?.webContents.send('workflow:state', s));
    workflow.on('step', (s) => mainWindow?.webContents.send('workflow:step', s));
    workflow.on('gcode:file', (f) => mainWindow?.webContents.send('gcode:file', f));
    workflow.on('instruction', (s) => mainWindow?.webContents.send('workflow:instruction', s));
    workflow.on('gcode:line', (l) => mainWindow?.webContents.send('gcode:line', l));
    workflow.on('gcode:done', (r) => {
        workflow._endRun();
        mainWindow?.webContents.send('gcode:done', r);
    });
});

app.on('window-all-closed', () => {
    serial.disconnect().catch(() => { });
    if (process.platform !== 'darwin') app.quit();
});

// ── Serial IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('serial:list', async () => {
    const { SerialPort } = require('serialport');
    return SerialPort.list();
});

ipcMain.handle('serial:connect', async (_, portPath) => {
    try {
        await serial.connect(portPath);
        let firmware;
        try {
            const info = await serial.queryBuildInfo();
            firmware = summarizeFirmware(info);
        } catch (e) {
            const info = serial.getFirmwareInfo();
            firmware = summarizeFirmware(info, e.message);
        }
        return { ok: true, firmware };
    }
    catch (e) { return { error: e.message }; }
});

ipcMain.handle('serial:disconnect', async () => {
    await serial.disconnect();
    return { ok: true };
});

ipcMain.handle('serial:send', async (_, line) => {
    try { await serial.send(line); return { ok: true }; }
    catch (e) { return { error: e.message }; }
});

ipcMain.handle('workflow:openFile', (_, fullPath) => {
    shell.openPath(fullPath);
    return { ok: true };
});

ipcMain.handle('serial:realtime', (_, code) => {
    serial.sendRaw(code);  // code is a number (byte) or single-char string
    return { ok: true };
});

ipcMain.handle('serial:firmware', () => {
    const info = serial.getFirmwareInfo();
    return summarizeFirmware(info);
});

// ── Workflow info (sync) ─────────────────────────────────────────────────────

ipcMain.handle('workflow:slides', () => workflow.getSlideData());
ipcMain.handle('workflow:footprints', (_, slideKey) => workflow.getFootprintOptions(slideKey));
ipcMain.handle('workflow:depths', (_, slideKey) => workflow.getDepthOptions(slideKey));
ipcMain.handle('workflow:state', () => workflow.getState());

// ── Workflow control ─────────────────────────────────────────────────────────

ipcMain.handle('workflow:setSlide', (_, slideKey) => {
    workflow.setSlide(slideKey);
    return { ok: true };
});

// Fire-and-forget: IPC returns immediately, progress comes via events.

ipcMain.handle('workflow:position', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runPosition().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:home', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runHome().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:toolChange', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runToolChange().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:leftClamp', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runLeftClamp().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:rightClamp', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runRightClamp().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:probe', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runProbe().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:configure', () => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runConfigure().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:runFootprint', (_, { fp, position, depth, startLine, slideKey }) => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runFootprint(fp, position, depth, startLine, slideKey).catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:runHoles', (_, holeType) => {
    if (!workflow._beginRun()) return { error: 'A workflow is already running.' };
    workflow.runHoles(holeType).catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:continue', () => {
    workflow.continue();
    return { ok: true };
});

ipcMain.handle('workflow:hold', () => {
    workflow.hold();
    return { ok: true };
});

ipcMain.handle('workflow:resume', () => {
    workflow.resume();
    return { ok: true };
});

ipcMain.handle('workflow:abort', () => {
    workflow.abort();
    return { ok: true };
});

ipcMain.handle('workflow:setDevMode', (_, val) => {
    workflow.setDevMode(val);
    saveSettings({ devMode: !!val });
    return { ok: true };
});

ipcMain.handle('workflow:setSanityChecksDisabled', (_, val) => {
    workflow.setSanityChecksDisabled(val);
    saveSettings({ sanityChecksDisabled: !!val });
    return { ok: true };
});

ipcMain.handle('memory:dump', () => ({
    wcs: memory.dumpWCS(),
    named: memory.dumpNamed(),
}));

// ── Library path ─────────────────────────────────────────────────────────────

ipcMain.handle('lib:getPath', () => libPath);
ipcMain.handle('lib:getStatus', () => validateLibPath(libPath));

ipcMain.handle('lib:browse', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Gcode Library Folder',
        defaultPath: libPath,
        properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const validation = validateLibPath(result.filePaths[0]);
    if (!validation.ok) return { ok: false, error: validation.error, path: validation.path };
    libPath = validation.path;
    saveSettings({ libPath });
    workflow.setLibPath(libPath);
    return { ok: true, path: libPath };
});
