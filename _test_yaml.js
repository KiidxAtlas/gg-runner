'use strict';
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

// Copy the normalizer so we can test it standalone
const { ManifestRunner } = require('./src/manifest-runner');
const { Memory } = require('./src/memory');

const LIB = path.join(__dirname, '..', 'accurate-arms', 'accurate arms');

// Test intro.yml directly
const introPath = path.join(LIB, 'intro.yml');
const raw = fs.readFileSync(introPath, 'utf8');
const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// Show raw structure
console.log('=== Intro.yml first 8 lines (raw) ===');
normalized.split('\n').slice(0, 8).forEach((l, i) => {
    console.log(`L${i + 1} col=${l.length - l.trimStart().length} ${JSON.stringify(l.slice(0, 60))}`);
});

// Test if raw normalised (CRLF-stripped) parses
try {
    yaml.load(normalized);
    console.log('\nRaw (CRLF stripped) parses OK');
} catch (e) {
    console.log('\nRaw (CRLF stripped) fails:', e.message.slice(0, 100));
}
