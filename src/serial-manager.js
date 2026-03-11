'use strict';

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

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
    }

    async connect(portPath) {
        if (this.port?.isOpen) await this.disconnect();

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

    // ── Internal ───────────────────────────────────────────────────────────────

    _handleLine(line) {
        if (!line) return;
        this.emit('line', line);

        // Realtime status response
        if (line.startsWith('<')) {
            this._parseStatus(line);
            return;
        }

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
            if (pending) pending.reject(new Error(line));
            return;
        }

        if (line.startsWith('ALARM:') || line.startsWith('[MSG:LIM')) {
            this.emit('alarm', line);
            this._drainQueue(new Error(line));
        }
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
        // <Idle | M:-91.500,-20.000,-0.500 | B:15,128 | Ov:100,100,100>
        const state = (line.match(/^<([^|>]+)/) || [])[1]?.trim() ?? 'Unknown';
        const pos = line.match(/M:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/);
        const ov = line.match(/Ov:(\d+),(\d+),(\d+)/);
        this._machineState = state;
        if ((state === 'Idle' || state === 'Alarm') && this._idleWaiters.length) {
            const waiters = this._idleWaiters.splice(0);
            waiters.forEach(fn => fn());
        }
        this.emit('status', {
            state,
            pos: pos ? { x: parseFloat(pos[1]), y: parseFloat(pos[2]), z: parseFloat(pos[3]) } : null,
            overrides: ov ? { feed: parseInt(ov[1]), rapid: parseInt(ov[2]), spindle: parseInt(ov[3]) } : null,
        });
    }

    _drainQueue(err) {
        while (this._queue.length) this._queue.shift().reject(err);
        const waiters = this._idleWaiters.splice(0);
        waiters.forEach(fn => fn()); // unblock so callers can exit cleanly
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
