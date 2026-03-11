'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { Memory } = require('./src/memory');
const { Interpreter } = require('./src/interpreter');
const { SerialManager } = require('./src/serial-manager');
const { WorkflowEngine } = require('./src/workflow');

// ── Settings persistence ─────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'gg-runner-settings.json');

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch { return {}; }
}

function saveSettings(updates) {
    const current = loadSettings();
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ ...current, ...updates }, null, 2));
}

let libPath = loadSettings().libPath || '';

let mainWindow;
const memory = new Memory();
const interpreter = new Interpreter(memory);
const serial = new SerialManager();
const workflow = new WorkflowEngine(libPath, memory, interpreter, serial);

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
    serial.on('line', (l) => mainWindow?.webContents.send('machine:line', l));
    serial.on('alarm', (a) => mainWindow?.webContents.send('machine:alarm', a));
    serial.on('disconnect', () => mainWindow?.webContents.send('machine:disconnect'));

    // ── Forward workflow events to renderer ──
    workflow.on('state', (s) => mainWindow?.webContents.send('workflow:state', s));
    workflow.on('step', (s) => mainWindow?.webContents.send('workflow:step', s));
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
    try { await serial.connect(portPath); return { ok: true }; }
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

ipcMain.handle('serial:realtime', (_, code) => {
    serial.sendRaw(code);  // code is a number (byte) or single-char string
    return { ok: true };
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
    workflow._beginRun();
    workflow.runPosition().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:probe', () => {
    workflow._beginRun();
    workflow.runProbe().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:configure', () => {
    workflow._beginRun();
    workflow.runConfigure().catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:runFootprint', (_, { fp, position, depth }) => {
    workflow._beginRun();
    workflow.runFootprint(fp, position, depth).catch(console.error);
    return { ok: true };
});

ipcMain.handle('workflow:runHoles', (_, holeType) => {
    workflow._beginRun();
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
    return { ok: true };
});

ipcMain.handle('memory:dump', () => ({
    wcs: memory.dumpWCS(),
    named: memory.dumpNamed(),
}));

// ── Library path ─────────────────────────────────────────────────────────────

ipcMain.handle('lib:getPath', () => libPath);

ipcMain.handle('lib:browse', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Gcode Library Folder',
        defaultPath: libPath,
        properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    libPath = result.filePaths[0];
    saveSettings({ libPath });
    workflow.setLibPath(libPath);
    return { ok: true, path: libPath };
});
