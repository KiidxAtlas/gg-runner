'use strict';

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const GRBL_ERROR_MESSAGES = {
    8: 'Not idle: Grbl $ command cannot be used unless the machine is idle.',
    9: 'G-code lock: G-code commands are locked out during alarm or jog state.',
};

class SerialManager extends EventEmitter {
    constructor() {
        super();
        this.port = null;
        this.parser = null;
        this._queue = [];
        this._infoBuffer = [];
        this._aborted = false;
        this._intentionalClose = false;
        this._statusTimer = null;
        this._machineState = 'Unknown';
        this._idleWaiters = [];
        this._statusWaiters = [];
        this._lastOverrides = { feed: 100, rapid: 100, spindle: 100 };
        this._lastStatus = { state: 'Unknown', pos: null, overrides: this._lastOverrides };
        this._firmwareInfo = { rawLines: [], versionText: 'Unknown', fwVersion: null };
    }

    async connect(portPath) {
        if (this.port?.isOpen) await this.disconnect();
        this._lastOverrides = { feed: 100, rapid: 100, spindle: 100 };
        this._lastStatus = { state: 'Unknown', pos: null, overrides: this._lastOverrides };
        this._firmwareInfo = { rawLines: [], versionText: 'Unknown', fwVersion: null };

        return new Promise((resolve, reject) => {
            this.port = new SerialPort({ path: portPath, baudRate: 115200 });

            this.port.once('open', () => {
                this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
                this.parser.on('data', (line) => this._handleLine(line.trim()));
                this.port.on('close', () => {
                    this._stopPolling();
                    if (!this._intentionalClose) this.emit('disconnect');
                    this._intentionalClose = false;
                });
                this._startPolling();
                resolve({ ok: true });
            });

            this.port.once('error', reject);
        });
    }

    async disconnect() {
        this._intentionalClose = true;
        this._stopPolling();
        this._drainQueue(new Error('Disconnected'));
        this._lastOverrides = { feed: 100, rapid: 100, spindle: 100 };
        this._lastStatus = { state: 'Unknown', pos: null, overrides: this._lastOverrides };
        this._firmwareInfo = { rawLines: [], versionText: 'Unknown', fwVersion: null };
        if (this.port?.isOpen) {
            await new Promise((res) => this.port.close(res));
        }
        this.port = null;
    }

    get connected() { return this.port?.isOpen ?? false; }

    // Send one gcode line and wait for 'ok' or 'error:N'
    send(line) {
        if (!this.port?.isOpen) return Promise.reject(new Error('Not connected'));
        return new Promise((resolve, reject) => {
            this._queue.push({ resolve, reject });
            this.port.write(line + '\n');
            this.emit('sent', line);
        });
    }

    // Send a single real-time override byte (no newline)
    sendRaw(byteOrChar) {
        if (this.port?.isOpen) {
            this._applyRealtimeOverride(byteOrChar);
            this.port.write(typeof byteOrChar === 'number'
                ? Buffer.from([byteOrChar])
                : byteOrChar);
        }
    }

    // Feed-hold then soft-reset
    abort() {
        this._aborted = true;
        if (this.port?.isOpen) {
            this.port.write('!');
            setTimeout(() => this.port?.write('\x18'), 150);
        }
        this._drainQueue(new Error('Aborted'));
    }

    // Send $# and collect WCS offset lines, returned as an array
    async queryHash() {
        if (!this.port?.isOpen) return [];
        const lines = [];
        const onInfo = (l) => { if (l.match(/^\[G5[4-9]:/)) lines.push(l); };
        this.on('info', onInfo);
        try { await this.send('$#'); } catch (_) { /* non-fatal */ }
        this.off('info', onInfo);
        return lines;
    }

    async queryStatus(timeout = 2000) {
        if (!this.port?.isOpen) throw new Error('Not connected');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._statusWaiters = this._statusWaiters.filter(w => w !== waiter);
                reject(new Error('Timed out waiting for machine status'));
            }, timeout);
            const waiter = {
                resolve: (status) => {
                    clearTimeout(timer);
                    resolve(status);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            };
            this._statusWaiters.push(waiter);
            this.port.write('?');
        });
    }

    async queryBuildInfo(timeout = 3000) {
        if (!this.port?.isOpen) return this.getFirmwareInfo();

        const lines = [...this._firmwareInfo.rawLines];
        let lastFirmwareLineAt = 0;
        const onLine = (line) => {
            if (!this._isFirmwareLine(line)) return;
            if (!lines.includes(line)) lines.push(line);
            lastFirmwareLineAt = Date.now();
        };

        this.on('line', onLine);
        try {
            this.port.write('$I\n');
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                if (lines.length && lastFirmwareLineAt && (Date.now() - lastFirmwareLineAt) >= 200) break;
                await this._sleep(50);
            }
        } finally {
            this.off('line', onLine);
        }

        this._firmwareInfo = this._parseFirmwareInfo(lines);
        this.emit('firmware', this.getFirmwareInfo());
        return this.getFirmwareInfo();
    }

    getFirmwareInfo() {
        return {
            rawLines: [...this._firmwareInfo.rawLines],
            versionText: this._firmwareInfo.versionText,
            fwVersion: this._firmwareInfo.fwVersion,
            detected: this._firmwareInfo.detected,
        };
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _handleLine(line) {
        if (!line) return;
        this._recordFirmwareLine(line);

        // Realtime status response
        if (line.startsWith('<')) {
            this._parseStatus(line);
            return;
        }

        this.emit('line', line);

        // Info responses (from $#, $G, etc.)
        if (line.startsWith('[')) {
            this.emit('info', line);
            return;
        }

        if (line === 'ok' || line.startsWith('ok')) {
            const pending = this._queue.shift();
            if (pending) pending.resolve(line);
            return;
        }

        if (line.startsWith('error:')) {
            const pending = this._queue.shift();
            if (pending) pending.reject(new Error(this._formatControllerError(line)));
            return;
        }

        if (line.startsWith('ALARM:') || line.startsWith('[MSG:LIM')) {
            this.emit('alarm', line);
            this._drainQueue(new Error(line));
        }
    }

    _parseFirmwareInfo(lines) {
        const joined = lines.join(' | ');
        const versionText = lines.find(line => line.startsWith('[VER:'))
            || lines.find(line => line.startsWith('Grbl'))
            || joined
            || 'Unknown';
        const fwMatch = joined.match(/\b(20\d{6})\b/);

        return {
            rawLines: [...lines],
            versionText,
            fwVersion: fwMatch ? parseInt(fwMatch[1], 10) : null,
            detected: lines.length > 0 || versionText !== 'Unknown',
        };
    }

    _isFirmwareLine(line) {
        return line.startsWith('Grbl') || line.startsWith('[VER:') || line.startsWith('[OPT:') || line.startsWith('[MSG:');
    }

    _recordFirmwareLine(line) {
        if (!this._isFirmwareLine(line)) return;
        if (!this._firmwareInfo.rawLines.includes(line)) {
            this._firmwareInfo.rawLines.push(line);
        }
        this._firmwareInfo = this._parseFirmwareInfo(this._firmwareInfo.rawLines);
        this.emit('firmware', this.getFirmwareInfo());
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _formatControllerError(line) {
        const match = String(line).match(/^error:(\d+)$/i);
        if (!match) return line;
        const code = parseInt(match[1], 10);
        const detail = GRBL_ERROR_MESSAGES[code];
        return detail ? `error:${code} ${detail}` : line;
    }

    _applyRealtimeOverride(byteOrChar) {
        if (typeof byteOrChar !== 'number') return;

        const next = { ...this._lastOverrides };
        let changed = false;

        switch (byteOrChar) {
            case 0x90:
                next.feed = 100;
                changed = true;
                break;
            case 0x91:
                next.feed = Math.min(200, next.feed + 10);
                changed = true;
                break;
            case 0x92:
                next.feed = Math.max(10, next.feed - 10);
                changed = true;
                break;
            case 0x93:
                next.feed = Math.min(200, next.feed + 1);
                changed = true;
                break;
            case 0x94:
                next.feed = Math.max(10, next.feed - 1);
                changed = true;
                break;
            case 0x95:
                next.rapid = 100;
                changed = true;
                break;
            case 0x96:
                next.rapid = 50;
                changed = true;
                break;
            case 0x97:
                next.rapid = 25;
                changed = true;
                break;
            case 0x99:
                next.spindle = 100;
                changed = true;
                break;
            case 0x9A:
                next.spindle = Math.min(200, next.spindle + 10);
                changed = true;
                break;
            case 0x9B:
                next.spindle = Math.max(10, next.spindle - 10);
                changed = true;
                break;
            case 0x9C:
                next.spindle = Math.min(200, next.spindle + 1);
                changed = true;
                break;
            case 0x9D:
                next.spindle = Math.max(10, next.spindle - 1);
                changed = true;
                break;
            default:
                break;
        }

        if (!changed) return;

        this._lastOverrides = next;
        this._lastStatus = {
            ...this._lastStatus,
            overrides: this._lastOverrides,
        };
        this.emit('status', this._lastStatus);
    }

    // Wait until GRBL confirms a non-moving state via a fresh status poll.
    // Always forces a '?' query so we never act on a stale cached state
    // (the cached state can lag by up to 500 ms and show Idle while the
    // machine is still executing a queued motion command).
    // Times out after 30 s and resolves anyway so the job doesn't hang forever.
    waitForIdle(timeout = 30000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._idleWaiters = this._idleWaiters.filter(w => w !== waiter);
                resolve();
            }, timeout);
            const waiter = () => { clearTimeout(timer); resolve(); };
            this._idleWaiters.push(waiter);
            // Force an immediate status poll — the response will fire _parseStatus
            // which resolves the waiter as soon as Idle/Alarm is confirmed.
            if (this.port?.isOpen) this.port.write('?');
        });
    }

    _parseStatus(line) {
        // Examples:
        // <Idle | M:-91.500,-20.000,-0.500 | B:15,128 | Ov:100,100,100>
        // <Idle|MPos:-91.500,-20.000,-0.500|FS:0,0|Ov:100,100,100>
        const state = (line.match(/^<([^|>]+)/) || [])[1]?.trim() ?? 'Unknown';
        const pos = line.match(/(?:\bM:|\bMPos:|\bW:|\bWPos:)(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/);
        const ov = line.match(/Ov:(\d+),(\d+),(\d+)/);
        this._machineState = state;
        if (ov) {
            this._lastOverrides = {
                feed: parseInt(ov[1], 10),
                rapid: parseInt(ov[2], 10),
                spindle: parseInt(ov[3], 10),
            };
        }
        if ((state === 'Idle' || state === 'Alarm') && this._idleWaiters.length) {
            const waiters = this._idleWaiters.splice(0);
            waiters.forEach(fn => fn());
        }
        const status = {
            state,
            pos: pos ? { x: parseFloat(pos[1]), y: parseFloat(pos[2]), z: parseFloat(pos[3]) } : null,
            overrides: this._lastOverrides,
        };
        this._lastStatus = status;
        if (this._statusWaiters.length) {
            const waiters = this._statusWaiters.splice(0);
            waiters.forEach(waiter => waiter.resolve(status));
        }
        this.emit('status', status);
    }

    _drainQueue(err) {
        while (this._queue.length) this._queue.shift().reject(err);
        const waiters = this._idleWaiters.splice(0);
        waiters.forEach(fn => fn()); // unblock so callers can exit cleanly
        const statusWaiters = this._statusWaiters.splice(0);
        statusWaiters.forEach(waiter => waiter.reject(err));
    }

    _startPolling() {
        this._statusTimer = setInterval(() => {
            if (this.port?.isOpen) this.port.write('?');
        }, 500);
    }

    _stopPolling() {
        if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    }
}

module.exports = { SerialManager };
