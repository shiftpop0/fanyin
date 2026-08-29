#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, resolve, basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';

const HOST = process.env.FANYIN_LOCAL_HELPER_HOST || '127.0.0.1';
const PORT = Number(process.env.FANYIN_LOCAL_HELPER_PORT || 18885);
const DEFAULT_OUTPUT_DIR = process.env.FANYIN_OUTPUT_DIR || 'C:\\fanyin_output';
const SERVICE_NAME = 'fanyin-local-csv-helper';
const SERVICE_VERSION = '1.2.0';

const server = createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/local/health') {
      const ips = localIps();
      return sendJson(res, {
        code: 200,
        status: 'ok',
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        output_dir: DEFAULT_OUTPUT_DIR,
        ips,
        primary_ip: ips[0] || '127.0.0.1',
      });
    }

    if (req.method === 'GET' && url.pathname === '/local/ip') {
      return sendJson(res, { code: 200, ips: localIps(), primary_ip: localIps()[0] || '127.0.0.1' });
    }

    if (req.method === 'GET' && isRoute(url.pathname, '/local/csv/status', '/csv/status')) {
      const outputDir = url.searchParams.get('outputDir') || DEFAULT_OUTPUT_DIR;
      const target = safeTarget(outputDir, url.searchParams.get('filename') || url.searchParams.get('csv_filename') || '');
      return sendJson(res, await csvStatus(target));
    }

    if (req.method === 'GET' && isRoute(url.pathname, '/local/csv', '/csv')) {
      const outputDir = url.searchParams.get('outputDir') || DEFAULT_OUTPUT_DIR;
      const target = safeTarget(outputDir, url.searchParams.get('filename') || url.searchParams.get('csv_filename') || '');
      const status = await csvStatus(target);
      status.csv_text = status.exists ? await readUtf8MaybeBom(target) : '';
      return sendJson(res, status);
    }

    if (req.method === 'POST' && isRoute(url.pathname, '/local/csv/save', '/csv/save')) {
      const body = await readJson(req);
      const outputDir = body.output_dir || body.outputDir || DEFAULT_OUTPUT_DIR;
      const target = safeTarget(outputDir, body.csv_filename || body.filename || '');
      const csvText = stripBom(String(body.csv_text || ''));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `\ufeff${csvText}`, 'utf8');
      const status = await csvStatus(target);
      return sendJson(res, {
        ...status,
        code: 200,
        status: 'saved',
        content_hash: sha256(csvText),
      });
    }

    if (req.method === 'POST' && isRoute(url.pathname, '/local/csv/open-path', '/csv/open-path')) {
      const body = await readJson(req);
      const outputDir = body.output_dir || body.outputDir || DEFAULT_OUTPUT_DIR;
      const target = safeTarget(outputDir, body.csv_filename || body.filename || '');
      const status = await csvStatus(target);
      if (!status.exists) {
        return sendJson(res, { code: 404, message: 'CSV file does not exist', path: target }, 200);
      }
      await openExplorerSelect(target);
      return sendJson(res, { code: 200, status: 'opened', path: target, selected: true });
    }

    if (req.method === 'POST' && isRoute(url.pathname, '/local/feedback', '/feedback')) {
      const body = await readJson(req);
      const enabled = Boolean(body.feedback_history);
      if (!enabled) {
        return sendJson(res, { code: 200, status: 'skipped', feedback_history_written: false });
      }
      const outputDir = body.output_dir || body.outputDir || DEFAULT_OUTPUT_DIR;
      const root = resolve(String(outputDir || DEFAULT_OUTPUT_DIR));
      const target = join(root, 'feedback.jsonl');
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, `${JSON.stringify({ ...body, created_at: new Date().toISOString() })}\n`, 'utf8');
      return sendJson(res, { code: 200, status: 'saved', feedback_history_written: true, path: target });
    }

    sendJson(res, {
      code: 404,
      message: `Not found: ${url.pathname}`,
      service: SERVICE_NAME,
      routes: [
        'GET /local/health',
        'GET /local/ip',
        'GET /local/csv/status',
        'GET /local/csv',
        'POST /local/csv/save',
        'POST /local/csv/open-path',
        'POST /local/feedback',
      ],
    }, 404);
  } catch (error) {
    sendJson(res, { code: 500, message: error && error.message ? error.message : String(error) }, 200);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Fanyin local CSV helper listening on http://${HOST}:${PORT}`);
  console.log(`Default output dir: ${DEFAULT_OUTPUT_DIR}`);
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function isRoute(pathname, ...candidates) {
  return candidates.includes(pathname);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
  });
}

function safeFilename(value) {
  const text = String(value || 'translator.csv')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const filename = text || 'translator.csv';
  const stem = filename.toLowerCase().endsWith('.csv') ? filename.slice(0, -4) : filename;
  return `${(stem || 'translator').slice(0, 184)}.csv`;
}

function safeTarget(outputDir, filename) {
  const root = resolve(String(outputDir || DEFAULT_OUTPUT_DIR));
  const target = resolve(root, basename(safeFilename(filename)));
  const relative = target.slice(root.length);
  if (!target.toLowerCase().startsWith(root.toLowerCase()) || relative.includes('..')) {
    throw new Error('Invalid CSV path');
  }
  return target;
}

async function csvStatus(target) {
  try {
    const info = await stat(target);
    const text = await readUtf8MaybeBom(target);
    const rowCount = csvRowCount(text);
    return {
      code: 200,
      path: target,
      csv_filename: basename(target),
      exists: true,
      empty: rowCount <= 0,
      row_count: rowCount,
      size: info.size,
      updated_at: info.mtime.toISOString(),
      content_hash: sha256(stripBom(text)),
    };
  } catch (_) {
    return {
      code: 200,
      path: target,
      csv_filename: basename(target),
      exists: false,
      empty: true,
      row_count: 0,
      size: 0,
      updated_at: '',
      content_hash: '',
    };
  }
}

async function readUtf8MaybeBom(target) {
  return stripBom(await readFile(target, 'utf8'));
}

function stripBom(text) {
  return String(text || '').replace(/^\ufeff/, '');
}

function csvRowCount(text) {
  const lines = stripBom(text).split(/\r?\n/).filter((line) => line.trim());
  return Math.max(0, lines.length - 1);
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text || ''), 'utf8').digest('hex')}`;
}

function localIps() {
  const out = [];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === 'IPv4' && !item.internal) {
        out.push(item.address);
      }
    }
  }
  return out;
}

function openExplorerSelect(target) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    // Explorer requires the path itself to be quoted after /select,.
    // windowsVerbatimArguments prevents Node from quoting the whole switch.
    const child = spawn('explorer.exe', [`/select,"${target}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.once('error', (error) => {
      rejectLaunch(new Error(`Failed to launch Windows Explorer: ${error.message}`));
    });
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}
