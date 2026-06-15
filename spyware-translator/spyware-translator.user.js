// ==UserScript==
// @name         Spyware 语音方言转普通话悬浮展示
// @namespace    local.spyware-translator
// @version      0.1.0
// @description  自动捕获 spyware 页面语音 wav，调用 Tailect ASR 本地模型转写为普通话文本，并在悬浮面板按句展示。
// @match        http://spyware.zj.jz/*
// @match        https://spyware.zj.jz/*
// @match        http://www.ses.st.zj.jz/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      spyware.zj.jz
// @connect      www.ses.st.zj.jz
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_CONFIG = {
    modelBaseUrl: 'http://127.0.0.1:7867',
    apiPrefix: '/gradio_api',
    language: '自动识别',
    returnTimestamps: true,
    splitByPunctuation: true,
    diarize: false,
    maxChars: 40,
    autoTranscribe: true,
    maxRecords: 8,
    requestTimeoutMs: 120000,
    modelTimeoutMs: 10 * 60 * 1000,
    debug: true,
  };

  const userConfig = window.__TAILECT_ASR_TRANSLATOR_CONFIG__ || {};
  const CONFIG = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    modelBaseUrl: normalizeBaseUrl(userConfig.modelBaseUrl || DEFAULT_CONFIG.modelBaseUrl),
    apiPrefix: normalizeApiPrefix(userConfig.apiPrefix || DEFAULT_CONFIG.apiPrefix),
  };

  const AUDIO_PATH_RE = /\/spyfile\/audiostream\.wav(?:\?|$)/i;
  const PANEL_ID = 'tailect-asr-translator-panel';
  const STYLE_ID = 'tailect-asr-translator-style';
  const STATUS_LABELS = {
    queued: '排队中',
    downloading: '下载音频',
    uploading: '上传模型',
    transcribing: '模型转写',
    done: '完成',
    error: '失败',
  };

  const state = {
    records: new Map(),
    order: [],
    queue: [],
    processing: false,
    panel: null,
    bodyReady: false,
    collapsed: false,
    apiPrefix: CONFIG.apiPrefix,
    configLoaded: false,
    autoTranscribe: CONFIG.autoTranscribe !== false,
    latestKey: '',
    lastGridRowContext: null,
  };

  hookNetwork();
  hookGridRowTracking();
  onReady(() => {
    state.bodyReady = true;
    addStyle();
    ensurePanel();
    observeAudioDom();
    scanAudioElements('ready');
    scanPerformanceEntries('ready');
    renderPanel();
  });

  setInterval(() => {
    scanAudioElements('interval');
    scanPerformanceEntries('interval');
  }, 3000);

  function hookNetwork() {
    try {
      const rawFetch = window.fetch;
      if (typeof rawFetch === 'function') {
        window.fetch = function (...args) {
          rememberMaybeAudioUrl(args[0], 'fetch');
          return rawFetch.apply(this, args);
        };
      }
    } catch (error) {
      debugLog('fetch hook failed', error);
    }

    try {
      const rawOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        rememberMaybeAudioUrl(url, 'xhr');
        return rawOpen.call(this, method, url, ...rest);
      };
    } catch (error) {
      debugLog('xhr hook failed', error);
    }
  }

  function hookGridRowTracking() {
    const rememberFromEvent = (event) => {
      const row = closestGridDataRow(event && event.target);
      if (!row) return;
      state.lastGridRowContext = buildGridRowContext(row);
    };

    try {
      document.addEventListener('pointerdown', rememberFromEvent, true);
      document.addEventListener('click', rememberFromEvent, true);
      document.addEventListener('dblclick', rememberFromEvent, true);
      document.addEventListener('focusin', rememberFromEvent, true);
    } catch (error) {
      debugLog('grid row tracking failed', error);
    }
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
#${PANEL_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483646;width:min(420px,calc(100vw - 28px));max-height:min(620px,72vh);display:flex;flex-direction:column;border:1px solid #cfd8e3;border-radius:8px;background:#fff;color:#172033;box-shadow:0 14px 38px rgba(15,23,42,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
#${PANEL_ID}.tm-collapsed{max-height:48px}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .tm-head{display:flex;align-items:center;gap:10px;min-height:46px;padding:9px 10px;border-bottom:1px solid #e6edf5;background:#f8fafc;cursor:move;user-select:none}
#${PANEL_ID}.tm-collapsed .tm-head{border-bottom:0}
#${PANEL_ID} .tm-title{font-weight:700;font-size:14px;white-space:nowrap;color:#102033}
#${PANEL_ID} .tm-status{margin-left:auto;padding:2px 8px;border-radius:999px;background:#edf2f7;color:#475569;font-size:12px;white-space:nowrap}
#${PANEL_ID} .tm-status.active{background:#e0f2fe;color:#075985}
#${PANEL_ID} .tm-status.done{background:#dcfce7;color:#166534}
#${PANEL_ID} .tm-status.error{background:#fee2e2;color:#991b1b}
#${PANEL_ID} .tm-head button,#${PANEL_ID} .tm-actions button{border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;height:26px;padding:0 8px;cursor:pointer;font:inherit}
#${PANEL_ID} .tm-head button:hover,#${PANEL_ID} .tm-actions button:hover{background:#f1f5f9}
#${PANEL_ID} .tm-body{overflow:auto;padding:10px;background:#fff}
#${PANEL_ID}.tm-collapsed .tm-body{display:none}
#${PANEL_ID} .tm-empty{padding:18px 12px;text-align:center;color:#64748b;border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc}
#${PANEL_ID} .tm-record{border:1px solid #dbe4ee;border-radius:8px;background:#fff;margin-bottom:10px;overflow:hidden}
#${PANEL_ID} .tm-record:last-child{margin-bottom:0}
#${PANEL_ID} .tm-record-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e6edf5}
#${PANEL_ID} .tm-record-title{min-width:0;flex:1;font-weight:600;color:#172033;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .tm-record-source{color:#64748b;font-size:12px}
#${PANEL_ID} .tm-record-kind{flex:0 0 auto;border:1px solid #bfdbfe;border-radius:999px;background:#eff6ff;color:#1d4ed8;padding:1px 7px;font-size:12px;white-space:nowrap}
#${PANEL_ID} .tm-record-status{font-size:12px;color:#475569;white-space:nowrap}
#${PANEL_ID} .tm-record-status.error{color:#b91c1c}
#${PANEL_ID} .tm-record-status.done{color:#166534}
#${PANEL_ID} .tm-record-body{padding:10px}
#${PANEL_ID} .tm-context{margin-bottom:8px;color:#475569;font-size:12px;word-break:break-word}
#${PANEL_ID} .tm-message{color:#64748b}
#${PANEL_ID} .tm-error{color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px}
#${PANEL_ID} .tm-full-text{margin-bottom:8px;padding:8px;border-radius:6px;background:#f8fafc;color:#172033;white-space:pre-wrap}
#${PANEL_ID} .tm-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 6px;color:#475569;font-size:12px}
#${PANEL_ID} .tm-detail-head button{border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;height:24px;padding:0 8px;cursor:pointer;font:inherit}
#${PANEL_ID} .tm-detail-head button:hover{background:#f1f5f9}
#${PANEL_ID} .tm-segments{display:flex;flex-direction:column;gap:6px}
#${PANEL_ID} .tm-segments.is-hidden{display:none}
#${PANEL_ID} .tm-segment{display:grid;grid-template-columns:72px 1fr;gap:8px;align-items:start;padding:7px 8px;border:1px solid #e2e8f0;border-radius:6px;background:#fff}
#${PANEL_ID} .tm-time{color:#64748b;font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}
#${PANEL_ID} .tm-text{color:#0f172a;word-break:break-word}
#${PANEL_ID} .tm-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
.tm-source-highlight{outline:3px solid #38bdf8!important;outline-offset:3px!important;transition:outline-color .2s ease}
.tm-source-highlight.wj-row .wj-cell{background:#e0f2fe!important;box-shadow:inset 0 0 0 2px #38bdf8!important}
.tm-source-highlight.wj-cell{background:#e0f2fe!important;box-shadow:inset 0 0 0 2px #38bdf8!important}
@media (max-width:520px){#${PANEL_ID}{right:8px;bottom:8px;width:calc(100vw - 16px);max-height:68vh}#${PANEL_ID} .tm-segment{grid-template-columns:1fr}#${PANEL_ID} .tm-time{font-size:11px}}
`;
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  function ensurePanel() {
    if (state.panel || !document.body) return state.panel;
    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.innerHTML = `
      <div class="tm-head" data-drag-handle="1">
        <div class="tm-title">方言转普通话</div>
        <div class="tm-status">等待音频</div>
        <button type="button" data-action="toggle-auto">自动开</button>
        <button type="button" data-action="collapse">收起</button>
      </div>
      <div class="tm-body"></div>
    `;
    document.body.appendChild(root);
    state.panel = root;

    root.addEventListener('click', handlePanelClick, true);
    makePanelDraggable(root, root.querySelector('[data-drag-handle="1"]'));
    return root;
  }

  function handlePanelClick(event) {
    const button = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!button || !state.panel || !state.panel.contains(button)) return;
    const action = button.getAttribute('data-action');
    const key = button.getAttribute('data-key') || '';
    event.preventDefault();
    event.stopPropagation();

    if (action === 'collapse') {
      state.collapsed = !state.collapsed;
      renderPanel();
    } else if (action === 'toggle-auto') {
      state.autoTranscribe = !state.autoTranscribe;
      if (state.autoTranscribe) processQueueSoon();
      renderPanel();
    } else if (action === 'retry') {
      retryRecord(key);
    } else if (action === 'copy') {
      copyRecordText(key);
    } else if (action === 'toggle-details') {
      toggleRecordDetails(key);
    } else if (action === 'locate') {
      locateRecordSource(key);
    }
  }

  function makePanelDraggable(root, handle) {
    if (!root || !handle) return;
    let dragging = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target && event.target.closest && event.target.closest('button')) return;
      const rect = root.getBoundingClientRect();
      dragging = {
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
      };
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, event.clientX - dragging.dx));
      const top = Math.min(maxTop, Math.max(0, event.clientY - dragging.dy));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      dragging = null;
    });
    handle.addEventListener('pointercancel', () => {
      dragging = null;
    });
  }

  function observeAudioDom() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          rememberMaybeAudioUrl(mutation.target && mutation.target.getAttribute && mutation.target.getAttribute('src'), 'dom-attr');
        }
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            scanAudioNode(node, 'dom-added');
          });
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  function scanAudioElements(source) {
    document.querySelectorAll('audio[src], source[src]').forEach((node) => {
      rememberMaybeAudioUrl(node.getAttribute('src'), source, node);
    });
  }

  function scanAudioNode(node, source) {
    if (!isElementNode(node)) return;
    if ((node.matches('audio[src]') || node.matches('source[src]'))) {
      rememberMaybeAudioUrl(node.getAttribute('src'), source, node);
    }
    node.querySelectorAll && node.querySelectorAll('audio[src], source[src]').forEach((item) => {
      rememberMaybeAudioUrl(item.getAttribute('src'), source, item);
    });
  }

  function scanPerformanceEntries(source) {
    if (!performance || typeof performance.getEntriesByType !== 'function') return;
    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        rememberMaybeAudioUrl(entry && entry.name, source);
      });
    } catch (_) {}
  }

  function rememberMaybeAudioUrl(input, source, contextNode) {
    const url = normalizeAudioUrl(input);
    if (!url || !AUDIO_PATH_RE.test(url)) return;
    const key = buildAudioKey(url);
    if (!key) return;
    const context = extractAudioContext(contextNode, url);

    let record = state.records.get(key);
    if (record) {
      record.lastSeenAt = Date.now();
      record.source = record.source || source;
      applyAudioContext(record, context);
      state.latestKey = key;
      renderPanel();
      return;
    }

    record = {
      key,
      url,
      source,
      status: 'queued',
      message: '已捕获音频，等待转写',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      filename: buildAudioFilename(url),
      contextKind: '',
      contextTitle: '',
      contextSnippet: '',
      contextElement: null,
      detailsCollapsed: false,
      language: '',
      text: '',
      srt: '',
      segments: [],
      error: '',
    };
    applyAudioContext(record, context);
    state.records.set(key, record);
    state.order.unshift(key);
    state.latestKey = key;
    trimRecords();
    enqueueRecord(key);
    renderPanel();
  }

  function applyAudioContext(record, context) {
    if (!record || !context) return;
    if (context.kind) record.contextKind = context.kind;
    if (context.title) record.contextTitle = context.title;
    if (context.snippet) record.contextSnippet = context.snippet;
    if (context.element) record.contextElement = context.element;
  }

  function extractAudioContext(contextNode, url) {
    const element = isElementNode(contextNode) ? contextNode : findAudioElementByUrl(url);
    const fallbackTitle = buildAudioFilename(url);
    if (!element) {
      const gridContext = findActiveGridRowContext();
      if (gridContext) return gridContext;
      return { kind: '音频', title: fallbackTitle, snippet: targetfileHint(url), element: null };
    }

    const vxMessage = closestByClassPrefix(element, 'wechatContent___');
    if (vxMessage) {
      const user = compactText(textFromClass(vxMessage, 'userName___'));
      const time = compactText(textFromClass(vxMessage, 'time___'));
      const duration = compactText(textFromClass(vxMessage, 'duration___'));
      const quote = compactText(textFromClass(vxMessage, 'quote___'));
      const title = compactText([user, time, duration].filter(Boolean).join(' ')) || fallbackTitle;
      return {
        kind: 'VX',
        title: truncateMiddle(title, 64),
        snippet: truncateMiddle(quote || compactText(vxMessage.innerText), 90),
        element: vxMessage,
      };
    }

    const audioBox = closestByClassPrefix(element, 'audioBox___');
    if (audioBox) {
      const gridContext = findActiveGridRowContext();
      if (gridContext) return gridContext;

      const titleText = compactText(textFromClass(audioBox, 'title___'));
      const timeline = compactText(textFromClass(audioBox, 'voiceTimeline___'));
      const title = titleText || fallbackTitle;
      return {
        kind: '通话',
        title: truncateMiddle(title, 72),
        snippet: timeline ? `播放进度 ${timeline}` : targetfileHint(url),
        element: audioBox,
      };
    }

    const audioContainer = closestByClassPrefix(element, 'audio___') || closestByClassPrefix(element, 'audioContainer___');
    const genericContainer = audioContainer || element.closest('li, section, article, [class*="Content"], [class*="content"]') || element.parentElement;
    const text = compactText(genericContainer && genericContainer.innerText);
    return {
      kind: '音频',
      title: truncateMiddle(text || fallbackTitle, 64),
      snippet: targetfileHint(url),
      element: genericContainer || element,
    };
  }

  function findActiveGridRowContext() {
    const recent = state.lastGridRowContext;
    if (recent && recent.element && document.documentElement.contains(recent.element)) {
      if (Date.now() - recent.updatedAt < 10 * 60 * 1000) return recent;
    }

    const selected = findSelectedGridRow();
    if (selected) return buildGridRowContext(selected);
    return null;
  }

  function findSelectedGridRow() {
    const rows = document.querySelectorAll ? document.querySelectorAll('.wj-row[role="row"][aria-selected="true"]') : [];
    for (const row of rows) {
      if (isGridDataRow(row)) return row;
    }
    return null;
  }

  function closestGridDataRow(node) {
    let element = isElementNode(node) ? node : null;
    for (let i = 0; element && i < 10; i += 1, element = element.parentElement) {
      if (hasClassName(element, 'wj-row') && element.getAttribute('role') === 'row' && isGridDataRow(element)) {
        return element;
      }
    }
    return null;
  }

  function isGridDataRow(row) {
    return isElementNode(row) && !!row.querySelector('.wj-cell[role="gridcell"]');
  }

  function buildGridRowContext(row) {
    const cells = getGridRowTexts(row);
    const caseName = cells[1] || '';
    const objectName = cells[2] || '';
    const selfNumber = cells[3] || '';
    const peerNumber = cells[4] || '';
    const callType = cells[5] || '';
    const duration = cells[6] || '';
    const startedAt = cells[7] || '';
    const summary = cells[11] || '';
    const durationText = duration && /^\d+$/.test(duration) ? `${duration}s` : duration;
    const title = compactText([caseName, objectName, startedAt, callType, durationText].filter(Boolean).join(' '));
    const snippet = compactText([selfNumber && `在控 ${selfNumber}`, peerNumber && `对方 ${peerNumber}`, summary].filter(Boolean).join('；'));
    return {
      kind: '列表项',
      title: truncateMiddle(title || cells.filter(Boolean).slice(0, 4).join(' ') || '列表音频', 72),
      snippet: truncateMiddle(snippet || cells.filter(Boolean).join(' '), 120),
      element: row,
      updatedAt: Date.now(),
    };
  }

  function getGridRowTexts(row) {
    const cells = row.querySelectorAll ? row.querySelectorAll('.wj-cell[role="gridcell"]') : [];
    return Array.from(cells).map((cell) => cleanGridCellText(cell.innerText || cell.textContent || ''));
  }

  function cleanGridCellText(value) {
    return compactText(String(value || '')
      .replace(/\b(zho|eng|yue|cmn)\b/gi, '')
      .replace(/翻/g, ''));
  }

  function closestByClassPrefix(element, prefix) {
    let node = element;
    for (let i = 0; node && i < 12; i += 1, node = node.parentElement) {
      if (hasClassPrefix(node, prefix)) return node;
    }
    return null;
  }

  function queryByClassPrefix(root, prefix) {
    if (!root) return null;
    if (hasClassPrefix(root, prefix)) return root;
    const nodes = root.querySelectorAll ? root.querySelectorAll('[class]') : [];
    for (const node of nodes) {
      if (hasClassPrefix(node, prefix)) return node;
    }
    return null;
  }

  function hasClassPrefix(node, prefix) {
    if (!isElementNode(node)) return false;
    return String(node.className || '').split(/\s+/).some((name) => name.indexOf(prefix) === 0);
  }

  function hasClassName(node, name) {
    if (!isElementNode(node)) return false;
    return String(node.className || '').split(/\s+/).includes(name);
  }

  function isElementNode(node) {
    return !!node && node.nodeType === 1 && typeof node.querySelectorAll === 'function';
  }

  function findAudioElementByUrl(url) {
    const key = buildAudioKey(url);
    const nodes = document.querySelectorAll ? document.querySelectorAll('audio[src], source[src]') : [];
    for (const node of nodes) {
      const src = node.getAttribute && node.getAttribute('src');
      if (src && buildAudioKey(normalizeAudioUrl(src)) === key) return node;
    }
    return null;
  }

  function textFromClass(root, prefix) {
    const node = queryByClassPrefix(root, prefix);
    return node ? node.innerText || node.textContent || '' : '';
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function targetfileHint(url) {
    try {
      const parsed = new URL(url);
      const target = parsed.searchParams.get('targetfile');
      const index = parsed.searchParams.get('index');
      return [target ? `targetfile=${target}` : '', index ? `index=${index}` : ''].filter(Boolean).join(' ');
    } catch (_) {
      return '';
    }
  }

  function trimRecords() {
    while (state.order.length > CONFIG.maxRecords) {
      const key = state.order.pop();
      if (key) state.records.delete(key);
    }
  }

  function enqueueRecord(key) {
    if (!state.queue.includes(key)) state.queue.push(key);
    processQueueSoon();
  }

  function processQueueSoon() {
    setTimeout(processQueue, 0);
  }

  async function processQueue() {
    if (state.processing || !state.autoTranscribe) return;
    const key = state.queue.shift();
    if (!key) return;
    const record = state.records.get(key);
    if (!record || record.status === 'done') {
      processQueueSoon();
      return;
    }

    state.processing = true;
    try {
      await transcribeRecord(record);
    } catch (error) {
      record.status = 'error';
      record.error = error && error.message ? error.message : String(error);
      record.message = '转写失败';
      debugLog('record failed', record.key, error);
      renderPanel();
    } finally {
      state.processing = false;
      processQueueSoon();
    }
  }

  async function transcribeRecord(record) {
    updateRecord(record, 'downloading', '正在下载网页音频');
    const audioBuffer = await downloadAudio(record.url);
    if (!audioBuffer || audioBuffer.byteLength < 44) {
      throw new Error('音频下载结果为空或不是有效 wav');
    }

    updateRecord(record, 'uploading', '正在上传到 Tailect ASR');
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    await ensureGradioConfig();
    const uploadedPath = await uploadAudio(blob, record.filename);

    updateRecord(record, 'transcribing', '模型正在转写');
    const eventId = await enqueueTailectRun(uploadedPath, record.filename);
    const output = await readTailectSse(eventId);
    const parsed = parseTailectOutput(output);

    record.status = 'done';
    record.message = '转写完成';
    record.language = parsed.language;
    record.text = parsed.text;
    record.srt = parsed.srt;
    record.srtFile = parsed.srtFile;
    record.segments = parsed.segments.length ? parsed.segments : splitPlainText(parsed.text);
    record.error = '';
    renderPanel();
  }

  function updateRecord(record, status, message) {
    record.status = status;
    record.message = message;
    renderPanel();
  }

  async function downloadAudio(url) {
    const response = await httpRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: { Accept: 'audio/wav,audio/x-wav,*/*' },
      timeout: CONFIG.requestTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载音频失败 HTTP ${response.status}`);
    }
    return response.response || response.responseText;
  }

  async function ensureGradioConfig() {
    if (state.configLoaded) return;
    try {
      const response = await httpRequest({
        method: 'GET',
        url: `${CONFIG.modelBaseUrl}/config`,
        responseType: 'text',
        headers: { Accept: 'application/json' },
        timeout: 15000,
      });
      if (response.status >= 200 && response.status < 300) {
        const config = JSON.parse(response.responseText || '{}');
        state.apiPrefix = normalizeApiPrefix(config.api_prefix) || state.apiPrefix;
      }
    } catch (error) {
      debugLog('config probe failed, keep default prefix', error);
    }
    state.configLoaded = true;
  }

  async function uploadAudio(blob, filename) {
    const form = new FormData();
    form.append('files', blob, filename);
    const response = await httpRequest({
      method: 'POST',
      url: `${CONFIG.modelBaseUrl}${state.apiPrefix}/upload`,
      data: form,
      responseType: 'text',
      timeout: CONFIG.requestTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`上传模型失败 HTTP ${response.status}: ${truncate(response.responseText, 180)}`);
    }
    const payload = JSON.parse(response.responseText || '[]');
    if (!Array.isArray(payload) || !payload[0]) {
      throw new Error(`上传模型返回异常: ${truncate(response.responseText, 180)}`);
    }
    return payload[0];
  }

  async function enqueueTailectRun(uploadedPath, filename) {
    const body = {
      data: [
        {
          path: uploadedPath,
          orig_name: filename,
          meta: { _type: 'gradio.FileData' },
        },
        CONFIG.language,
        Boolean(CONFIG.returnTimestamps),
        Boolean(CONFIG.splitByPunctuation),
        Boolean(CONFIG.diarize),
        Number(CONFIG.maxChars) || 40,
      ],
    };
    const response = await httpRequest({
      method: 'POST',
      url: `${CONFIG.modelBaseUrl}${state.apiPrefix}/call/run`,
      data: JSON.stringify(body),
      responseType: 'text',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: CONFIG.requestTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`模型入队失败 HTTP ${response.status}: ${truncate(response.responseText, 240)}`);
    }
    const payload = JSON.parse(response.responseText || '{}');
    if (!payload.event_id) {
      throw new Error(`模型入队返回异常: ${truncate(response.responseText, 240)}`);
    }
    return payload.event_id;
  }

  async function readTailectSse(eventId) {
    const response = await httpRequest({
      method: 'GET',
      url: `${CONFIG.modelBaseUrl}${state.apiPrefix}/call/run/${encodeURIComponent(eventId)}`,
      responseType: 'text',
      headers: { Accept: 'text/event-stream' },
      timeout: CONFIG.modelTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`读取模型结果失败 HTTP ${response.status}: ${truncate(response.responseText, 240)}`);
    }
    return parseSseComplete(response.responseText || '');
  }

  function parseTailectOutput(output) {
    const data = Array.isArray(output) ? output : [];
    const language = String(data[0] || '');
    const text = String(data[1] || '');
    const srtFile = formatFileOutput(data[3]);
    const srt = String(data[4] || '');
    return {
      language,
      text,
      srtFile,
      srt,
      segments: parseSrt(srt),
    };
  }

  function parseSseComplete(text) {
    const chunks = String(text || '').split(/\r?\n\r?\n/);
    let lastData = null;
    for (const chunk of chunks) {
      const event = parseSseEvent(chunk);
      if (!event.event || event.event === 'heartbeat') continue;
      if (event.event === 'error') {
        throw new Error(`模型报错: ${event.dataText || '(empty)'}`);
      }
      if (event.event === 'complete') return event.data;
      if (event.event === 'generating') lastData = event.data;
    }
    if (lastData) return lastData;
    throw new Error('模型结果流未返回 complete 事件');
  }

  function parseSseEvent(chunk) {
    const lines = String(chunk || '').split(/\r?\n/);
    let event = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trimStart());
    }
    const dataText = dataLines.join('\n');
    let data = dataText;
    if (dataText) {
      try { data = JSON.parse(dataText); } catch (_) {}
    }
    return { event, data, dataText };
  }

  function parseSrt(srt) {
    const normalized = String(srt || '').replace(/\r/g, '').trim();
    if (!normalized) return [];
    return normalized.split(/\n{2,}/).map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      const timeIndex = lines.findIndex((line) => line.includes('-->'));
      if (timeIndex < 0) return null;
      const times = lines[timeIndex].split('-->').map((item) => item.trim());
      const text = lines.slice(timeIndex + 1).join('\n').trim();
      if (!text) return null;
      return {
        start: times[0] || '',
        end: times[1] || '',
        text,
      };
    }).filter(Boolean);
  }

  function splitPlainText(text) {
    return String(text || '')
      .split(/(?<=[，。！？；：,.!?:;])\s*/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ start: '', end: '', text: item }));
  }

  function retryRecord(key) {
    const record = state.records.get(key);
    if (!record) return;
    if (['downloading', 'uploading', 'transcribing'].includes(record.status)) return;
    record.status = 'queued';
    record.message = '已重新加入队列';
    record.error = '';
    record.text = '';
    record.srt = '';
    record.segments = [];
    enqueueRecord(key);
    renderPanel();
  }

  function toggleRecordDetails(key) {
    const record = state.records.get(key);
    if (!record) return;
    record.detailsCollapsed = !record.detailsCollapsed;
    renderPanel();
  }

  function locateRecordSource(key) {
    const record = state.records.get(key);
    if (!record) return;
    const element = record.contextElement;
    if (!element || !document.documentElement.contains(element)) {
      record.message = '来源元素已不在当前页面';
      renderPanel();
      return;
    }
    try {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {
      element.scrollIntoView();
    }
    const highlighted = getHighlightElements(element);
    highlighted.forEach((item) => item.classList.add('tm-source-highlight'));
    setTimeout(() => {
      highlighted.forEach((item) => {
        try { item.classList.remove('tm-source-highlight'); } catch (_) {}
      });
    }, 2200);
  }

  function getHighlightElements(element) {
    if (!isElementNode(element)) return [];
    if (hasClassName(element, 'wj-row')) {
      const cells = element.querySelectorAll ? Array.from(element.querySelectorAll('.wj-cell[role="gridcell"]')) : [];
      return [element].concat(cells);
    }
    return [element];
  }

  async function copyRecordText(key) {
    const record = state.records.get(key);
    if (!record) return;
    const text = record.segments && record.segments.length
      ? record.segments.map((item) => item.text).join('\n')
      : record.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      record.message = '已复制转写文本';
    } catch (_) {
      record.message = '复制失败，请手动选择文本';
    }
    renderPanel();
  }

  function renderPanel() {
    if (!state.bodyReady) return;
    const root = ensurePanel();
    if (!root) return;
    root.classList.toggle('tm-collapsed', state.collapsed);
    const statusEl = root.querySelector('.tm-status');
    const autoButton = root.querySelector('[data-action="toggle-auto"]');
    const collapseButton = root.querySelector('[data-action="collapse"]');
    const active = currentActiveRecord();
    statusEl.textContent = active ? STATUS_LABELS[active.status] || active.status : '等待音频';
    statusEl.className = `tm-status ${active ? statusClass(active.status) : ''}`.trim();
    autoButton.textContent = state.autoTranscribe ? '自动开' : '自动关';
    collapseButton.textContent = state.collapsed ? '展开' : '收起';
    const body = root.querySelector('.tm-body');
    if (!state.order.length) {
      body.innerHTML = '<div class="tm-empty">等待页面播放或加载语音，捕获到 wav 后会自动转写。</div>';
      return;
    }
    body.innerHTML = state.order.map((key) => renderRecord(state.records.get(key))).join('');
  }

  function renderRecord(record) {
    if (!record) return '';
    const status = STATUS_LABELS[record.status] || record.status;
    const statusCls = statusClass(record.status);
    const title = record.contextTitle || record.filename || 'audio.wav';
    const hasSegments = Array.isArray(record.segments) && record.segments.length > 0;
    const detailButton = hasSegments
      ? `<button type="button" data-action="toggle-details" data-key="${escAttr(record.key)}">${record.detailsCollapsed ? '展开时间戳' : '收起时间戳'}</button>`
      : '';
    const locateButton = record.contextElement
      ? `<button type="button" data-action="locate" data-key="${escAttr(record.key)}">定位</button>`
      : '';
    const contextHtml = record.contextSnippet
      ? `<div class="tm-context">${esc(record.contextSnippet)}</div>`
      : '';
    let content = '';
    if (record.status === 'done') {
      content = `
        ${contextHtml}
        ${record.text ? `<div class="tm-full-text">${esc(record.text)}</div>` : ''}
        ${hasSegments ? `<div class="tm-detail-head"><span>时间戳 ${record.segments.length} 句</span>${detailButton}</div>` : ''}
        <div class="tm-segments ${record.detailsCollapsed ? 'is-hidden' : ''}">${(record.segments || []).map(renderSegment).join('')}</div>
        <div class="tm-actions">
          ${locateButton}
          <button type="button" data-action="copy" data-key="${escAttr(record.key)}">复制</button>
          <button type="button" data-action="retry" data-key="${escAttr(record.key)}">重识</button>
        </div>
      `;
    } else if (record.status === 'error') {
      content = `
        ${contextHtml}
        <div class="tm-error">${esc(record.error || record.message || '转写失败')}</div>
        <div class="tm-actions">${locateButton}<button type="button" data-action="retry" data-key="${escAttr(record.key)}">重试</button></div>
      `;
    } else {
      content = `${contextHtml}<div class="tm-message">${esc(record.message || status)}</div>`;
    }
    return `
      <section class="tm-record" data-key="${escAttr(record.key)}">
        <div class="tm-record-head">
          ${record.contextKind ? `<div class="tm-record-kind">${esc(record.contextKind)}</div>` : ''}
          <div class="tm-record-title" title="${escAttr(record.url)}">${esc(title)}</div>
          <div class="tm-record-source">${esc(record.source || '')}</div>
          <div class="tm-record-status ${statusCls}">${esc(status)}</div>
        </div>
        <div class="tm-record-body">${content}</div>
      </section>
    `;
  }

  function renderSegment(segment) {
    const time = segment.start || segment.end ? `${srtTimeToShort(segment.start)}-${srtTimeToShort(segment.end)}` : '';
    return `
      <div class="tm-segment">
        <div class="tm-time">${esc(time)}</div>
        <div class="tm-text">${esc(segment.text)}</div>
      </div>
    `;
  }

  function currentActiveRecord() {
    if (state.latestKey && state.records.has(state.latestKey)) return state.records.get(state.latestKey);
    for (const key of state.order) {
      const record = state.records.get(key);
      if (record) return record;
    }
    return null;
  }

  function statusClass(status) {
    if (status === 'done') return 'done';
    if (status === 'error') return 'error';
    if (['queued', 'downloading', 'uploading', 'transcribing'].includes(status)) return 'active';
    return '';
  }

  function normalizeAudioUrl(input) {
    if (!input) return '';
    let raw = '';
    if (typeof input === 'string') raw = input;
    else if (input && typeof input.url === 'string') raw = input.url;
    else raw = String(input || '');
    raw = raw.replace(/&amp;/g, '&').trim();
    if (!raw) return '';
    try {
      return new URL(raw, window.location.href).href;
    } catch (_) {
      return '';
    }
  }

  function buildAudioKey(url) {
    try {
      const parsed = new URL(url);
      const target = parsed.searchParams.get('targetfile') || '';
      const index = parsed.searchParams.get('index') || '0';
      if (target) return `${parsed.origin}${parsed.pathname}?targetfile=${target}&index=${index}`;
      return parsed.href;
    } catch (_) {
      return url;
    }
  }

  function buildAudioFilename(url) {
    try {
      const parsed = new URL(url);
      const target = parsed.searchParams.get('targetfile') || '';
      const name = target.split(/[\\/]/).pop() || 'spyware-audio.wav';
      return /\.wav$/i.test(name) ? sanitizeFilename(name) : `${sanitizeFilename(name)}.wav`;
    } catch (_) {
      return 'spyware-audio.wav';
    }
  }

  function sanitizeFilename(name) {
    return String(name || 'audio.wav').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'audio.wav';
  }

  function normalizeBaseUrl(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function normalizeApiPrefix(value) {
    const text = String(value || '').trim();
    if (!text || text === '/') return '';
    return `/${text.replace(/^\/+|\/+$/g, '')}`;
  }

  function httpRequest(options) {
    const gm = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);

    if (gm) {
      return new Promise((resolve, reject) => {
        gm({
          method: options.method || 'GET',
          url: options.url,
          data: options.data,
          headers: options.headers || {},
          responseType: options.responseType || 'text',
          timeout: options.timeout || CONFIG.requestTimeoutMs,
          anonymous: false,
          onload: resolve,
          onerror: () => reject(new Error(`请求失败: ${options.url}`)),
          ontimeout: () => reject(new Error(`请求超时: ${options.url}`)),
          onabort: () => reject(new Error(`请求取消: ${options.url}`)),
        });
      });
    }

    return fetchRequest(options);
  }

  async function fetchRequest(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || CONFIG.requestTimeoutMs);
    try {
      const response = await fetch(options.url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.data,
        credentials: 'include',
        signal: controller.signal,
      });
      const responseHeaders = Array.from(response.headers.entries()).map(([k, v]) => `${k}: ${v}`).join('\n');
      if (options.responseType === 'arraybuffer') {
        return {
          status: response.status,
          statusText: response.statusText,
          responseHeaders,
          response: await response.arrayBuffer(),
          responseText: '',
        };
      }
      const responseText = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        responseHeaders,
        response: responseText,
        responseText,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function formatFileOutput(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return value.path || value.url || JSON.stringify(value);
    return String(value);
  }

  function srtTimeToShort(value) {
    const text = String(value || '').trim();
    const matched = text.match(/(?:(\d{2}):)?(\d{2}):(\d{2}),(\d{3})/);
    if (!matched) return text;
    const hours = matched[1];
    const minutes = matched[2];
    const seconds = matched[3];
    return hours && hours !== '00' ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  }

  function truncate(value, size) {
    const text = String(value || '');
    return text.length > size ? `${text.slice(0, size)}...` : text;
  }

  function truncateMiddle(value, size) {
    const text = String(value || '');
    if (text.length <= size) return text;
    const keep = Math.max(8, Math.floor((size - 3) / 2));
    return `${text.slice(0, keep)}...${text.slice(-keep)}`;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#96;');
  }

  function debugLog() {
    if (!CONFIG.debug || typeof console === 'undefined' || !console.log) return;
    const args = Array.from(arguments);
    args.unshift('[tailect-translator]');
    console.log.apply(console, args);
  }
})();
