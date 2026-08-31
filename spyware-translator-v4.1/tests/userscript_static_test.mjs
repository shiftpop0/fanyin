#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'spyware-translator-v4.1.user.js');
const source = await readFile(scriptPath, 'utf8');

assert.match(source, /@version\s+0\.5\.4/);
assert.match(source, /SETTINGS_SCHEMA_VERSION\s*=\s*5/);
assert.match(source, /diarize:\s*true/);
assert.match(source, /merged\.diarize\s*=\s*true/);
assert.match(source, /modelBaseUrl:\s*'http:\/\/127\.0\.0\.1:8885'/);
assert.match(source, /model:\s*'Tailect_V4\.1'/);
assert.match(source, /\/v1\/audiototext/);
assert.doesNotMatch(source, /[?&]max_chars=/);
assert.doesNotMatch(source, /[?&]language=/);
assert.match(source, /\/translator\/csv/);
assert.match(source, /actualModel === 'Tailect_V4\.1'/);
assert.match(source, /function downmixPcmToMono/);
assert.match(source, /task\.audioBlobUrl = URL\.createObjectURL\(new Blob\(\[merged\.fullBuffer\]/);
assert.match(source, /callV1Api\(part\.buffer/);
assert.match(source, /声道已在本机合并为单声道/);
assert.match(source, /function isCurrentModelCsv/);
assert.match(source, /row\['识别模型'\].*=== 'Tailect_V4\.1'/);
assert.doesNotMatch(source, /option value="Taizhou"/);
assert.doesNotMatch(source, /option value="Tiantai"/);
assert.match(source, /当前“说话人识别”处于关闭状态/);

console.log('Tailect V4.1 userscript static checks passed.');
