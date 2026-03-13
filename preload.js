'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = [
    'machine:status',
    'machine:firmware',
    'machine:line',
    'machine:alarm',
    'machine:disconnect',
    'gcode:line',
    'gcode:done',
    'workflow:state',
    'workflow:step',
    'workflow:instruction',
];

contextBridge.exposeInMainWorld('gg', {
    // ── Serial ────────────────────────────────────────────────────────────
    listPorts: () => ipcRenderer.invoke('serial:list'),
    connect: (port) => ipcRenderer.invoke('serial:connect', port),
    disconnect: () => ipcRenderer.invoke('serial:disconnect'),
    sendLine: (line) => ipcRenderer.invoke('serial:send', line),
    sendRealtime: (code) => ipcRenderer.invoke('serial:realtime', code),
    getFirmwareInfo: () => ipcRenderer.invoke('serial:firmware'),

    // ── Workflow queries (sync-ish) ───────────────────────────────────────
    getSlides: () => ipcRenderer.invoke('workflow:slides'),
    getFootprints: (slideKey) => ipcRenderer.invoke('workflow:footprints', slideKey),
    getDepths: (slideKey) => ipcRenderer.invoke('workflow:depths', slideKey),
    getState: () => ipcRenderer.invoke('workflow:state'),

    // ── Slide selection ───────────────────────────────────────────────────
    setSlide: (slideKey) => ipcRenderer.invoke('workflow:setSlide', slideKey),

    // ── Setup phase ───────────────────────────────────────────────────────
    position: () => ipcRenderer.invoke('workflow:position'),
    toolChange: () => ipcRenderer.invoke('workflow:toolChange'),
    probe: () => ipcRenderer.invoke('workflow:probe'),
    configure: () => ipcRenderer.invoke('workflow:configure'),

    // ── Cut operations ────────────────────────────────────────────────────
    runFootprint: (fp, position, depth, startLine = 1, slideKey = null) =>
        ipcRenderer.invoke('workflow:runFootprint', { fp, position, depth, startLine, slideKey }),
    runHoles: (holeType) => ipcRenderer.invoke('workflow:runHoles', holeType),

    // ── Mid-operation control ─────────────────────────────────────────────
    continueStep: () => ipcRenderer.invoke('workflow:continue'),
    hold: () => ipcRenderer.invoke('workflow:hold'),
    resume: () => ipcRenderer.invoke('workflow:resume'),
    abort: () => ipcRenderer.invoke('workflow:abort'),
    setDevMode: (val) => ipcRenderer.invoke('workflow:setDevMode', val),

    // ── Debug ─────────────────────────────────────────────────────────────
    dumpMemory: () => ipcRenderer.invoke('memory:dump'),

    // ── Library path ─────────────────────────────────────────────────────
    getLibPath: () => ipcRenderer.invoke('lib:getPath'),
    getLibStatus: () => ipcRenderer.invoke('lib:getStatus'),
    browseLibPath: () => ipcRenderer.invoke('lib:browse'),

    // ── Event subscriptions ───────────────────────────────────────────────
    on(channel, fn) {
        if (ALLOWED_CHANNELS.includes(channel)) {
            ipcRenderer.on(channel, (_, data) => fn(data));
        }
    },
    off(channel, fn) {
        ipcRenderer.removeListener(channel, fn);
    },
});
