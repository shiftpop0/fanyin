#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'spyware-translator-v4.1.user.js');
const source = await readFile(scriptPath, 'utf8');
const start = source.indexOf('  function mergeWavBuffers');
const end = source.indexOf('  function extractAudioContext', start);
assert.ok(start >= 0 && end > start, 'unable to locate userscript WAV helpers');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}\nthis.wavApi = { mergeWavBuffers, parseWav };`, sandbox);

const first = makeStereoPcm16([
  [10000, 0],
  [0, 6000],
]);
const second = makeStereoPcm16([
  [-8000, 0],
  [0, -4000],
]);
const merged = sandbox.wavApi.mergeWavBuffers([first, second], 10);
const parsed = sandbox.wavApi.parseWav(merged.fullBuffer);

assert.equal(merged.sourceChannels, 2);
assert.equal(merged.outputChannels, 1);
assert.equal(parsed.channels, 1);
assert.equal(parsed.sampleRate, 16000);
assert.equal(parsed.blockAlign, 2);
assert.equal(parsed.byteRate, 32000);
assert.equal(parsed.data.byteLength, 8, 'four stereo frames must become four mono PCM16 samples');
assert.deepEqual(readMonoPcm16(parsed.data), [10000, 6000, -8000, -4000]);
assert.equal(merged.parts.length, 1);
assert.equal(sandbox.wavApi.parseWav(merged.parts[0].buffer).channels, 1);

console.log('Tailect V4.1 userscript audio downmix checks passed.');

function makeStereoPcm16(frames) {
  const dataSize = frames.length * 4;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  writeText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(view, 8, 'WAVE');
  writeText(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 64000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  frames.forEach(([left, right], index) => {
    view.setInt16(44 + index * 4, left, true);
    view.setInt16(46 + index * 4, right, true);
  });
  return out;
}

function readMonoPcm16(buffer) {
  const view = new DataView(buffer);
  const samples = [];
  for (let offset = 0; offset < buffer.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

function writeText(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
