#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://100.100.80.117:7867';
const DEFAULT_AUDIO_PATH = path.resolve('prompt材料/bian.wav');

const baseUrl = normalizeBaseUrl(process.argv[2] || DEFAULT_BASE_URL);
const audioPath = path.resolve(process.argv[3] || DEFAULT_AUDIO_PATH);
let apiPrefix = '/gradio_api';

const RUN_INPUTS = {
  language: '自动识别',
  returnTimestamps: true,
  splitByPunctuation: true,
  diarize: false,
  maxChars: 40,
};

main().catch((error) => {
  console.error('[probe] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

async function main() {
  console.log(`[probe] base: ${baseUrl}`);
  console.log(`[probe] audio: ${audioPath}`);

  const config = await getJson('/config', 15000, false);
  apiPrefix = normalizeApiPrefix(config && config.api_prefix) || apiPrefix;
  printConfigSummary(config);

  const apiInfo = await getJson('/info', 15000);
  printApiSummary(apiInfo);

  const uploadedPath = await uploadAudio(audioPath);
  console.log(`[probe] uploaded path: ${uploadedPath}`);

  const eventId = await enqueueRun(uploadedPath, path.basename(audioPath));
  console.log(`[probe] event id: ${eventId}`);

  const data = await readRunSse(eventId, 10 * 60 * 1000);
  const [language, text, timestamps, srtFile, srtPreview] = Array.isArray(data) ? data : [];

  console.log('\n[probe] result');
  console.log(`language: ${language || ''}`);
  console.log(`text: ${text || ''}`);
  console.log(`timestamps: ${Array.isArray(timestamps) ? timestamps.length : 0}`);
  console.log(`srtFile: ${formatFileOutput(srtFile)}`);
  if (srtPreview) {
    console.log('\n[srt preview]');
    console.log(String(srtPreview).trim());
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeApiPrefix(value) {
  const text = String(value || '').trim();
  if (!text || text === '/') return '';
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

async function getJson(route, timeoutMs, useApiPrefix = true) {
  const response = await fetchWithTimeout(`${baseUrl}${useApiPrefix ? apiPrefix : ''}${route}`, {
    headers: { Accept: 'application/json' },
  }, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${route} did not return JSON: ${text.slice(0, 500)}`);
  }
}

async function uploadAudio(filePath) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: 'audio/wav' }), path.basename(filePath));

  const response = await fetchWithTimeout(`${baseUrl}${apiPrefix}/upload`, {
    method: 'POST',
    body: form,
  }, 120000);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${apiPrefix}/upload returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const uploaded = JSON.parse(text);
  if (!Array.isArray(uploaded) || !uploaded[0]) {
    throw new Error(`${apiPrefix}/upload returned unexpected payload: ${text.slice(0, 500)}`);
  }
  return uploaded[0];
}

async function enqueueRun(uploadedPath, originalName) {
  const fileData = {
    path: uploadedPath,
    orig_name: originalName,
    meta: { _type: 'gradio.FileData' },
  };
  const body = {
    data: [
      fileData,
      RUN_INPUTS.language,
      RUN_INPUTS.returnTimestamps,
      RUN_INPUTS.splitByPunctuation,
      RUN_INPUTS.diarize,
      RUN_INPUTS.maxChars,
    ],
  };

  const response = await fetchWithTimeout(`${baseUrl}${apiPrefix}/call/run`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, 120000);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${apiPrefix}/call/run returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }

  const payload = JSON.parse(text);
  if (!payload || !payload.event_id) {
    throw new Error(`${apiPrefix}/call/run returned unexpected payload: ${text.slice(0, 1000)}`);
  }
  return payload.event_id;
}

async function readRunSse(eventId, timeoutMs) {
  const response = await fetchWithTimeout(`${baseUrl}${apiPrefix}/call/run/${encodeURIComponent(eventId)}`, {
    headers: { Accept: 'text/event-stream' },
  }, timeoutMs);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${apiPrefix}/call/run/${eventId} returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  if (!response.body) {
    throw new Error('SSE response has no readable body');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let splitAt;
    while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseSseEvent(rawEvent);
      if (!parsed.event || parsed.event === 'heartbeat') continue;
      if (parsed.event === 'error') {
        throw new Error(`model error: ${parsed.dataText || '(empty error)'}`);
      }
      if (parsed.event === 'complete') {
        return parsed.data;
      }
      if (parsed.event === 'generating') {
        console.log('[probe] generating update received');
      }
    }
  }

  throw new Error('SSE stream ended before complete event');
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let event = '';
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }

  const dataText = dataLines.join('\n');
  let data = dataText;
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch (_) {}
  }
  return { event, data, dataText };
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

function printConfigSummary(config) {
  const dependencies = Array.isArray(config && config.dependencies) ? config.dependencies : [];
  const run = dependencies.find((dep) => dep && dep.api_name === 'run');
  console.log('[probe] /config ok');
  if (run) {
    console.log(`[probe] run fn_index: ${run.id ?? run.fn_index ?? '(unknown)'}`);
    console.log(`[probe] run inputs: ${(run.inputs || []).join(', ')}`);
    console.log(`[probe] run outputs: ${(run.outputs || []).join(', ')}`);
  } else {
    console.log('[probe] run endpoint not found in /config dependencies');
  }
}

function printApiSummary(apiInfo) {
  const endpoints = apiInfo && apiInfo.named_endpoints ? apiInfo.named_endpoints : {};
  console.log(`[probe] /gradio_api/info endpoints: ${Object.keys(endpoints).join(', ') || '(none)'}`);
  const run = endpoints['/run'];
  if (run) {
    const params = Array.isArray(run.parameters) ? run.parameters : [];
    const returns = Array.isArray(run.returns) ? run.returns : [];
    console.log(`[probe] /run parameters: ${params.map((item) => item.label || item.parameter_name || item.component).join(' | ')}`);
    console.log(`[probe] /run returns: ${returns.map((item) => item.label || item.component).join(' | ')}`);
  }
}

function formatFileOutput(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.path || value.url || JSON.stringify(value);
  return String(value);
}
