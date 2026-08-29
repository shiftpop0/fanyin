#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8885';
const DEFAULT_MODEL = 'Tailect_V4.1';
const audioArgument = process.argv[4] || process.env.TAILECT_TEST_AUDIO || '';

const baseUrl = normalizeBaseUrl(process.argv[2] || DEFAULT_BASE_URL);
const model = process.argv[3] || DEFAULT_MODEL;
const audioPath = audioArgument ? path.resolve(audioArgument) : '';

main().catch((error) => {
  console.error('[v1-probe] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

async function main() {
  if (!audioPath) {
    throw new Error('missing test audio path; usage: node tailect_v41_probe.mjs <baseUrl> <model> <audio.wav>');
  }
  console.log(`[v1-probe] base: ${baseUrl}`);
  console.log(`[v1-probe] model: ${model}`);
  console.log(`[v1-probe] audio: ${audioPath}`);

  const health = await getJson('/health', 15000);
  console.log(`[v1-probe] health: ${JSON.stringify(health)}`);
  if (health.model !== DEFAULT_MODEL) {
    throw new Error(`health model mismatch: expected ${DEFAULT_MODEL}, got ${health.model || ''}`);
  }

  await expectServiceError('missing model', '/v1/audiototext', new FormData(), 'E001');
  await expectServiceError('unsupported model', '/v1/audiototext?model=BadModel', new FormData(), 'E002');

  const missingFileForm = new FormData();
  missingFileForm.append('model', model);
  await expectServiceError('missing file', '/v1/audiototext', missingFileForm, 'E010');

  const emptyFileForm = new FormData();
  emptyFileForm.append('file', new Blob([], { type: 'audio/wav' }), 'empty.wav');
  await expectServiceError('empty file', `/v1/audiototext?model=${encodeURIComponent(model)}`, emptyFileForm, 'E007');

  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(audioPath));

  const payload = await postJson(`/v1/audiototext?model=${encodeURIComponent(model)}`, form, 10 * 60 * 1000);
  assertSuccessPayload(payload);

  console.log(`[v1-probe] code: ${payload.code}`);
  console.log(`[v1-probe] language: ${payload.language || ''}`);
  console.log(`[v1-probe] file_name: ${payload.file_name || ''}`);
  console.log(`[v1-probe] uuid: ${payload.uuid || ''}`);
  console.log(`[v1-probe] message: ${payload.message || ''}`);
  console.log(`[v1-probe] rows: ${Array.isArray(payload.data) ? payload.data.length : 0}`);
  if (Array.isArray(payload.data)) {
    for (const row of payload.data.slice(0, 8)) {
      console.log(`[v1-probe] row ${row.begin}-${row.end} lid=${row.lid}: ${row.text}`);
    }
  }
  console.log('[v1-probe] contract checks passed');
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function getJson(route, timeoutMs) {
  const headers = { Accept: 'application/json' };
  if (process.env.TAILECT_API_KEY) headers['X-API-Key'] = process.env.TAILECT_API_KEY;
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    headers,
  }, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function postJson(route, form, timeoutMs) {
  const headers = { Accept: 'application/json' };
  if (process.env.TAILECT_API_KEY) headers['X-API-Key'] = process.env.TAILECT_API_KEY;
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: form,
  }, timeoutMs);

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${route} did not return JSON: ${text.slice(0, 1000)}`);
  }
}

async function expectServiceError(label, route, form, expectedErrorId) {
  const payload = await postJson(route, form, 30000);
  assertBasePayload(payload, label);
  if (payload.code !== 500) {
    throw new Error(`${label}: expected code=500, got ${payload.code}`);
  }
  if (!String(payload.message || '').includes(`[${expectedErrorId}]`)) {
    throw new Error(`${label}: expected message to include [${expectedErrorId}], got ${payload.message}`);
  }
  console.log(`[v1-probe] ${label}: ${payload.message}`);
}

function assertSuccessPayload(payload) {
  assertBasePayload(payload, 'success');
  if (payload.code !== 200) {
    throw new Error(`success: expected code=200, got ${payload.code}, message=${payload.message || ''}`);
  }
  if (!['zh', 'en', 'ja', 'ko', 'yue', ''].includes(payload.language)) {
    throw new Error(`success: unsupported language code ${payload.language}`);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error('success: data must be an array');
  }
  for (const [index, row] of payload.data.entries()) {
    for (const key of ['lid', 'text', 'begin', 'end']) {
      if (!(key in row)) {
        throw new Error(`success: row ${index} missing ${key}`);
      }
    }
    if (typeof row.lid !== 'string' || typeof row.text !== 'string') {
      throw new Error(`success: row ${index} lid/text type mismatch`);
    }
    if (!Number.isInteger(row.begin) || !Number.isInteger(row.end)) {
      throw new Error(`success: row ${index} begin/end must be integers`);
    }
  }
}

function assertBasePayload(payload, label) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label}: payload must be an object`);
  }
  for (const key of ['code', 'language', 'data', 'file_name', 'message', 'uuid']) {
    if (!(key in payload)) {
      throw new Error(`${label}: missing top-level key ${key}`);
    }
  }
  if (!Number.isInteger(payload.code)) {
    throw new Error(`${label}: code must be an integer`);
  }
  if (typeof payload.uuid !== 'string' || payload.uuid.length < 8) {
    throw new Error(`${label}: uuid must be a non-empty string`);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
