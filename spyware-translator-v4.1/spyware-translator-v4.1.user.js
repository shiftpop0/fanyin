// ==UserScript==
// @name         Spyware 语音方言转普通话悬浮展示（Tailect V4.1）
// @namespace    local.spyware-translator-v4.1
// @version      0.5.1
// @description  捕获 spyware 页面语音切片，通过离线 8885 平台 API 调用 Tailect_V4.1，保存 CSV，并在列表/VX 页面展示和修正。
// @match        http://spyware.zj.jz/*
// @match        https://spyware.zj.jz/*
// @match        http://www.ses.st.zj.jz/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'tailect_asr_translator_v41_settings';
  const SETTINGS_SCHEMA_VERSION = 3;
  const PANEL_ID = 'tailect-v41-translator-panel';
  const MODAL_ID = 'tailect-v41-translator-modal';
  const TOAST_ID = 'tailect-v41-translator-toasts';
  const STYLE_ID = 'tailect-v41-translator-style';
  const AUDIO_PATH_RE = /\/spyfile\/audiostream\.wav(?:\?|$)/i;
  const LOCAL_HELPER_SERVICE = 'fanyin-local-csv-helper';
  const LOCAL_HELPER_BAT = 'spyware-translator-v4.1\\local_helper\\启动本机CSV助手.bat';
  const CSV_COLUMNS = [
    ['record_key', '记录键'],
    ['scene', '场景'],
    ['title', '标题'],
    ['case_name', '案件名称'],
    ['control_number', '侦控号码'],
    ['peer_number', '对方号码'],
    ['duration_seconds', '预估时长（秒）'],
    ['started_at', '通话开始时间'],
    ['targetfile', '音频文件'],
    ['index_range', '切片索引范围'],
    ['segment_no', '分段序号'],
    ['lid', '说话人'],
    ['begin_ms', '开始时间（毫秒）'],
    ['end_ms', '结束时间（毫秒）'],
    ['begin_time', '开始时间'],
    ['end_time', '结束时间'],
    ['text', '原始识别文本'],
    ['corrected_text', '修正文本'],
    ['is_corrected', '是否修正'],
    ['source_audio_url', '音频流地址'],
    ['model', '识别模型'],
    ['language', '识别语言'],
    ['uuid', '识别任务UUID'],
    ['created_at', '创建时间'],
    ['updated_at', '更新时间'],
  ];

  const DEFAULT_SETTINGS = {
    modelBaseUrl: 'http://127.0.0.1:8885',
    model: 'Tailect_V4.1',
    apiKey: '',
    localHelperUrl: 'http://127.0.0.1:18885',
    localOutputDir: 'C:\\fanyin_output',
    language: 'auto',
    diarize: false,
    autoTranscribe: true,
    maxChars: 40,
    maxMergeMinutes: 10,
    maxSliceCount: 0,
    sliceFailLimit: 2,
    transcriptColumnWidth: 420,
    panelWidth: 460,
    panelHeight: 460,
    panelLeft: 0,
    panelTop: 0,
    collapsed: false,
    feedbackHistory: false,
    requestTimeoutMs: 120000,
    modelTimeoutMs: 10 * 60 * 1000,
    debug: true,
  };

  const userConfig = window.__TAILECT_ASR_TRANSLATOR_CONFIG__ || {};
  const settings = loadSettings(userConfig);

  const STATUS_LABELS = {
    discovered: '已捕获',
    cached: '已有CSV',
    queued: '排队中',
    downloading: '下载切片',
    merging: '合并音频',
    transcribing: '模型识别',
    saving: '保存CSV',
    done: '完成',
    error: '失败',
  };

  const state = {
    tasks: new Map(),
    order: [],
    queue: [],
    processing: false,
    bodyReady: false,
    panel: null,
    modal: null,
    currentModalKey: '',
    latestKey: '',
    lastGridRowContext: null,
    localHelper: { ok: false, primaryIp: '', checkedAt: 0, message: '未检测' },
    modelService: { ok: false, checkedAt: 0, message: '未检测' },
    panelNotice: null,
    toastHost: null,
    confirmAction: null,
    pendingGridManual: null,
    refreshing: false,
    seenPerformanceAudio: new Set(),
    internalAudioUrls: new Set(),
    gridScanTimer: null,
    suppressNetworkCapture: 0,
  };

  hookNetwork();
  hookGridRowTracking();

  onReady(() => {
    state.bodyReady = true;
    addStyle();
    ensurePanel();
    ensureModal();
    observeDom();
    scanAudioElements('ready');
    scanPerformanceEntries('ready');
    scanInteractiveTargets();
    checkLocalHelper();
    checkModelService();
    renderPanel();
  });

  setInterval(() => {
    scanAudioElements('interval');
    scanPerformanceEntries('interval');
    scanInteractiveTargets();
  }, 2500);

  function loadSettings(overrides) {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (_) {}
    const resetSavedDiarize = Number(saved.settingsSchemaVersion || 0) < SETTINGS_SCHEMA_VERSION;
    const merged = { ...DEFAULT_SETTINGS, ...saved, ...overrides };
    if (resetSavedDiarize && !Object.prototype.hasOwnProperty.call(overrides || {}, 'diarize')) {
      merged.diarize = false;
    }
    merged.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
    delete merged.speakerCount;
    delete merged.__testSaveFilePicker;
    delete merged.__disableNativeSaveFilePicker;
    delete merged.__testBrowserDownload;
    merged.modelBaseUrl = normalizeBaseUrl(merged.modelBaseUrl);
    merged.localHelperUrl = normalizeBaseUrl(merged.localHelperUrl);
    merged.maxSliceCount = Math.max(0, Number(merged.maxSliceCount) || 0);
    merged.sliceFailLimit = Math.max(1, Number(merged.sliceFailLimit) || 2);
    merged.transcriptColumnWidth = Math.max(240, Number(merged.transcriptColumnWidth) || 420);
    merged.panelWidth = Math.max(360, Number(merged.panelWidth) || 460);
    merged.panelHeight = Math.max(280, Number(merged.panelHeight) || 460);
    return merged;
  }

  function saveSettings() {
    const payload = { ...settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function hookNetwork() {
    try {
      const rawFetch = window.fetch;
      if (typeof rawFetch === 'function') {
        window.fetch = function (...args) {
          if (!state.suppressNetworkCapture) rememberMaybeAudioUrl(args[0], 'fetch');
          return rawFetch.apply(this, args);
        };
      }
    } catch (error) {
      debugLog('fetch hook failed', error);
    }

    try {
      const rawOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (!state.suppressNetworkCapture) rememberMaybeAudioUrl(url, 'xhr');
        return rawOpen.call(this, method, url, ...rest);
      };
    } catch (error) {
      debugLog('xhr hook failed', error);
    }
  }

  function hookGridRowTracking() {
    const remember = (event) => {
      const row = closestGridDataRow(event && event.target);
      if (!row) return;
      state.lastGridRowContext = buildGridRowContext(row);
    };
    try {
      document.addEventListener('pointerdown', remember, true);
      document.addEventListener('click', remember, true);
      document.addEventListener('dblclick', remember, true);
      document.addEventListener('focusin', remember, true);
      document.addEventListener('click', handleDocumentClick, true);
    } catch (error) {
      debugLog('grid tracking failed', error);
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
#${PANEL_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483646;width:${settings.panelWidth}px;height:${settings.panelHeight}px;min-width:360px;min-height:280px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172033;box-shadow:0 18px 44px rgba(15,23,42,.2);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden;resize:both}
#${PANEL_ID}.tm-collapsed{height:48px!important;min-height:48px;resize:none}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .tm-head{display:flex;align-items:center;gap:8px;min-height:46px;padding:8px 10px;border-bottom:1px solid #e6edf5;background:#f8fafc;cursor:move;user-select:none}
#${PANEL_ID}.tm-collapsed .tm-head{border-bottom:0}
#${PANEL_ID} .tm-title{font-weight:700;font-size:14px;white-space:nowrap;color:#102033}
#${PANEL_ID} .tm-status{margin-left:auto;padding:2px 8px;border-radius:999px;background:#edf2f7;color:#475569;font-size:12px;white-space:nowrap}
#${PANEL_ID} button,.tm-modal button,.tm-grid-action,.tm-vx-action{border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;height:28px;padding:0 9px;cursor:pointer;font:inherit}
#${PANEL_ID} button:hover,.tm-modal button:hover,.tm-grid-action:hover,.tm-vx-action:hover{background:#f1f5f9}
#${PANEL_ID} button:disabled,.tm-modal button:disabled{cursor:not-allowed;opacity:.48;background:#f8fafc}
#${PANEL_ID} .tm-body{display:flex;flex-direction:column;gap:10px;overflow:auto;padding:10px;background:#fff}
#${PANEL_ID}.tm-collapsed .tm-body{display:none}
#${PANEL_ID} .tm-controls{display:flex;flex-direction:column;gap:10px}
#${PANEL_ID} .tm-config-section{padding-top:9px;border-top:1px solid #e2e8f0}
#${PANEL_ID} .tm-config-section:first-child{padding-top:0;border-top:0}
#${PANEL_ID} .tm-section-head{display:flex;align-items:center;gap:7px;margin-bottom:7px;color:#172033;font-weight:700}
#${PANEL_ID} .tm-section-head small{margin-left:auto;color:#64748b;font-weight:400}
#${PANEL_ID} .tm-form-grid{display:grid;grid-template-columns:108px minmax(0,1fr);gap:7px 8px;align-items:center}
#${PANEL_ID} .tm-field-label{display:flex;align-items:center;gap:5px;color:#475569;font-size:12px}
#${PANEL_ID} .tm-info{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:1px solid #94a3b8;border-radius:50%;color:#64748b;font:700 10px/1 sans-serif;cursor:help}
#${PANEL_ID} input[type="text"],#${PANEL_ID} input[type="password"],#${PANEL_ID} input[type="number"],#${PANEL_ID} select,.tm-modal textarea{width:100%;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#172033;padding:5px 7px;font:inherit;min-width:0}
#${PANEL_ID} .tm-switches,#${PANEL_ID} .tm-actions{display:flex;flex-wrap:wrap;gap:6px}
#${PANEL_ID} .tm-help{color:#64748b;font-size:12px}
#${PANEL_ID} .tm-subhelp{grid-column:2;color:#64748b;font-size:11px;margin-top:-4px}
#${PANEL_ID} .tm-toggle.is-on{border-color:#059669;background:#059669;color:#fff}
#${PANEL_ID} .tm-toggle.is-on:hover{background:#047857}
#${PANEL_ID} .tm-toggle.is-off{background:#f1f5f9;color:#475569}
#${PANEL_ID} .tm-service-line{display:flex;align-items:center;gap:7px;min-width:0;color:#475569;font-size:12px}
#${PANEL_ID} .tm-service-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex:0 0 auto}
#${PANEL_ID} .tm-service-dot.ok{background:#10b981}
#${PANEL_ID} .tm-service-dot.error{background:#dc2626}
#${PANEL_ID} .tm-notice{border-left:4px solid #2563eb;background:#eff6ff;color:#1e3a8a;padding:8px 10px;font-size:12px;white-space:pre-wrap}
#${PANEL_ID} .tm-notice.error{border-left-color:#dc2626;background:#fef2f2;color:#991b1b}
#${PANEL_ID} .tm-notice.warning{border-left-color:#d97706;background:#fffbeb;color:#92400e}
#${PANEL_ID} .tm-loading,.tm-modal .tm-loading{color:#2563eb;font-size:12px}
#${PANEL_ID} .tm-list-head{display:flex;align-items:center;gap:8px;padding:0 1px;color:#172033;font-weight:700}
#${PANEL_ID} .tm-list-head small{color:#64748b;font-weight:400}
#${PANEL_ID} .tm-list-head .tm-icon-control{margin-left:auto;width:30px;padding:0;display:inline-flex;align-items:center;justify-content:center}
#${PANEL_ID} .tm-icon-control.is-spinning svg{animation:tm-spin .8s linear infinite}
#${PANEL_ID} .tm-list{display:flex;flex-direction:column;gap:8px}
#${PANEL_ID} .tm-record{border:1px solid #dbe4ee;border-radius:8px;background:#fff;overflow:hidden}
#${PANEL_ID} .tm-record-head{display:flex;align-items:center;gap:8px;padding:7px 9px;background:#f8fafc;border-bottom:1px solid #e6edf5}
#${PANEL_ID} .tm-record-title{min-width:0;flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .tm-record-kind{flex:0 0 auto;border:1px solid #bfdbfe;border-radius:999px;background:#eff6ff;color:#1d4ed8;padding:1px 7px;font-size:12px}
#${PANEL_ID} .tm-record-status{font-size:12px;color:#475569}
#${PANEL_ID} .tm-record-status.done,#${PANEL_ID} .tm-record-status.cached{color:#166534}
#${PANEL_ID} .tm-record-status.error{color:#b91c1c}
#${PANEL_ID} .tm-record-body{padding:8px;color:#475569;font-size:12px}
.tm-transcript-cell{position:absolute;box-sizing:border-box;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;height:28px;padding:3px 6px;background:#fff;color:#475569;font-size:12px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.wj-row[aria-selected="true"] .tm-transcript-cell{background:#eff6ff}
.tm-transcript-cell.is-header{font-weight:600;color:#334155;background:#fff}
.tm-transcript-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis}
.tm-grid-action,.tm-vx-action{height:22px;line-height:20px;padding:0 6px;font-size:12px;flex:0 0 auto}
.tm-vx-tools{display:inline-flex;align-items:center;gap:5px;margin-left:6px;vertical-align:middle;white-space:nowrap}
.tm-vx-tools.tm-vx-tools-right{margin-left:auto;flex:0 0 auto}
.tm-modal-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.28);display:none;align-items:center;justify-content:center;padding:18px}
.tm-modal-backdrop.is-open{display:flex}
.tm-modal{width:min(900px,calc(100vw - 36px));max-height:calc(100vh - 36px);display:flex;flex-direction:column;border-radius:8px;background:#fff;color:#172033;box-shadow:0 22px 70px rgba(15,23,42,.28);overflow:hidden;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.tm-modal-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #e5e7eb;background:#f8fafc}
.tm-modal-title{font-weight:700;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-modal-body{padding:12px;overflow:auto}
.tm-modal audio{width:100%;margin-bottom:10px}
.tm-modal-confirm{display:flex;flex-direction:column;gap:12px;max-width:620px}
.tm-modal-confirm p{margin:0;color:#475569;white-space:pre-wrap}
.tm-modal-confirm .tm-confirm-warning{border-left:4px solid #d97706;background:#fffbeb;color:#92400e;padding:9px 10px}
.tm-segments{display:flex;flex-direction:column;gap:6px}
.tm-segment{display:grid;grid-template-columns:126px 60px minmax(0,1fr) 34px;gap:8px;align-items:start;border:1px solid #e2e8f0;border-radius:6px;padding:7px 8px}
.tm-time{color:#64748b;font-variant-numeric:tabular-nums;font-size:12px}
.tm-speaker{color:#475569;font-size:12px}
.tm-text{word-break:break-word;white-space:pre-wrap}
.tm-icon-button{width:28px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.tm-edit-box{display:flex;flex-direction:column;gap:8px;border:1px solid #dbe4ee;border-radius:8px;background:#f8fafc;padding:10px;margin-top:10px}
#${TOAST_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(420px,calc(100vw - 24px));font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
#${TOAST_ID} .tm-toast{border:1px solid #bfdbfe;border-left:4px solid #2563eb;border-radius:6px;background:#fff;color:#1e3a8a;box-shadow:0 12px 32px rgba(15,23,42,.2);padding:9px 11px;white-space:pre-wrap}
#${TOAST_ID} .tm-toast.success{border-color:#a7f3d0;border-left-color:#059669;color:#065f46}
#${TOAST_ID} .tm-toast.error{border-color:#fecaca;border-left-color:#dc2626;color:#991b1b}
#${TOAST_ID} .tm-toast.warning{border-color:#fde68a;border-left-color:#d97706;color:#92400e}
@keyframes tm-spin{to{transform:rotate(360deg)}}
@media(max-width:680px){#${PANEL_ID}{left:8px!important;right:auto;bottom:8px;width:calc(100vw - 16px)!important}.tm-segment{grid-template-columns:1fr}.tm-time,.tm-speaker{font-size:11px}}
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
    if (settings.panelLeft || settings.panelTop) {
      root.style.left = `${settings.panelLeft}px`;
      root.style.top = `${settings.panelTop}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }
    root.innerHTML = `
      <div class="tm-head" data-drag-handle="1">
        <div class="tm-title">方言转写控制台</div>
        <div class="tm-status">等待音频</div>
        <button type="button" data-action="collapse">${settings.collapsed ? '展开' : '收起'}</button>
      </div>
      <div class="tm-body"></div>
    `;
    document.body.appendChild(root);
    state.panel = root;
    root.classList.toggle('tm-collapsed', Boolean(settings.collapsed));
    root.addEventListener('click', handlePanelClick, true);
    root.addEventListener('change', handlePanelChange, true);
    makePanelDraggable(root, root.querySelector('[data-drag-handle="1"]'));
    try {
      new ResizeObserver(() => {
        if (settings.collapsed) return;
        settings.panelWidth = Math.round(root.getBoundingClientRect().width);
        settings.panelHeight = Math.round(root.getBoundingClientRect().height);
        saveSettings();
      }).observe(root);
    } catch (_) {}
    return root;
  }

  function ensureModal() {
    if (state.modal || !document.body) return state.modal;
    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.className = 'tm-modal-backdrop';
    root.innerHTML = '<div class="tm-modal"><div class="tm-modal-head"><div class="tm-modal-title"></div><button type="button" data-action="modal-close">关闭</button></div><div class="tm-modal-body"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', (event) => {
      const action = event.target && event.target.closest && event.target.closest('[data-action]');
      if (event.target === root || (action && action.getAttribute('data-action') === 'modal-close')) {
        closeModal();
      }
    }, true);
    state.modal = root;
    return root;
  }

  function ensureToastHost() {
    if (state.toastHost && document.documentElement.contains(state.toastHost)) return state.toastHost;
    if (!document.body) return null;
    const host = document.createElement('div');
    host.id = TOAST_ID;
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    state.toastHost = host;
    return host;
  }

  function showToast(message, type, duration) {
    const host = ensureToastHost();
    if (!host || !message) return;
    const toast = document.createElement('div');
    toast.className = `tm-toast ${type || ''}`.trim();
    toast.textContent = String(message);
    host.appendChild(toast);
    setTimeout(() => toast.remove(), Math.max(1800, Number(duration) || 4200));
  }

  function setPanelNotice(type, message, source) {
    if (state.panelNotice && state.panelNotice.source === 'helper' && source && source !== 'helper') {
      renderPanel();
      return;
    }
    state.panelNotice = message ? { type: type || 'info', message: String(message), source: source || '' } : null;
    renderPanel();
  }

  function clearPanelNotice(source) {
    if (!state.panelNotice || (source && state.panelNotice.source !== source)) return;
    state.panelNotice = null;
    renderPanel();
  }

  function localHelperStartMessage(detail) {
    const suffix = detail ? `\n错误详情：${detail}` : '';
    return `本机 CSV 助手未启动或无法连接。本机 CSV 自动保存和“打开文件路径”暂不可用，但模型识别、模型端 CSV 保存和“CSV另存”仍可继续。\n请在运行 userscript 的这台电脑上双击：${LOCAL_HELPER_BAT}${suffix}`;
  }

  function handlePanelClick(event) {
    const button = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!button || !state.panel || !state.panel.contains(button)) return;
    const action = button.getAttribute('data-action');
    const key = button.getAttribute('data-key') || state.latestKey || '';
    event.preventDefault();
    event.stopPropagation();
    if (action === 'collapse') {
      settings.collapsed = !settings.collapsed;
      saveSettings();
      renderPanel();
    } else if (action === 'toggle-auto') {
      settings.autoTranscribe = !settings.autoTranscribe;
      saveSettings();
      if (settings.autoTranscribe) processQueueSoon();
      showToast(`自动识别新音频已${settings.autoTranscribe ? '开启' : '关闭'}`, settings.autoTranscribe ? 'success' : '');
      renderPanel();
    } else if (action === 'toggle-diarize') {
      settings.diarize = !settings.diarize;
      saveSettings();
      showToast(`说话人识别已${settings.diarize ? '开启' : '关闭'}${settings.diarize ? '，识别耗时可能增加' : ''}`, settings.diarize ? 'success' : '');
      renderPanel();
    } else if (action === 'save-settings') {
      readSettingsFromPanel();
      saveSettings();
      scanInteractiveTargets();
      if (settings.modelBaseUrl === settings.localHelperUrl) {
        setPanelNotice('warning', '模型服务地址与本机助手地址相同，请确认没有把两个服务填到同一个端口。', 'settings');
      } else {
        clearPanelNotice('settings');
      }
      showToast('配置已保存到当前浏览器。', 'success');
      checkLocalHelper(true, false);
      checkModelService(true, false);
      renderPanel();
    } else if (action === 'helper-check') {
      checkLocalHelper(true, true);
    } else if (action === 'model-check') {
      checkModelService(true, true);
    } else if (action === 'refresh-all') {
      refreshAllState();
    } else if (action === 'manual-current') {
      confirmRetranscribeAll();
    } else if (action === 'open-task') {
      openTaskModal(key);
    } else if (action === 'retry-task') {
      const task = state.tasks.get(key);
      if (task) enqueueTask(task, true);
    } else if (action === 'open-path') {
      const task = state.tasks.get(key);
      if (task) openLocalCsvPath(task);
      else showToast('当前还没有可打开的 CSV。', 'warning');
    } else if (action === 'save-as-csv') {
      const task = state.tasks.get(key);
      if (task) saveTaskCsvAs(task);
      else showToast('当前还没有可用于 CSV另存 的内容。', 'warning');
    }
  }

  function confirmRetranscribeAll() {
    const tasks = state.order.map((key) => state.tasks.get(key)).filter(Boolean);
    if (!tasks.length) {
      showToast('当前还没有捕获到可识别的音频。', 'warning');
      return;
    }
    const busy = tasks.filter((task) => ['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status)).length;
    const warning = `将把 ${tasks.length} 条已捕获音频全部加入重新识别队列，并在完成后覆盖对应 CSV。${busy ? `\n其中 ${busy} 条当前正在处理，不会重复加入队列。` : ''}`;
    openConfirmModal({
      title: '确认全部重新识别',
      message: warning,
      confirmText: '确认重新识别',
      onConfirm: () => {
        let queued = 0;
        tasks.forEach((task) => {
          if (['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status)) return;
          enqueueTask(task, true);
          queued += 1;
        });
        showToast(`已将 ${queued} 条音频加入重新识别队列。`, queued ? 'success' : 'warning');
      },
    });
  }

  async function refreshAllState() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.panelNotice = null;
    renderPanel();
    const beforeCount = state.order.length;
    try {
      await Promise.allSettled([
        checkModelService(true, false),
        checkLocalHelper(true, false),
      ]);
      scanAudioElements('manual-refresh');
      scanPerformanceEntries('manual-refresh');
      scanInteractiveTargets();
      const discoveredCount = Math.max(0, state.order.length - beforeCount);
      const firstMergeCount = deduplicateTasks();
      if (state.localHelper.ok) {
        await Promise.all(state.order.map((key) => {
          const task = state.tasks.get(key);
          return task ? hydrateTaskFromLocalCsv(task, { resetMissing: true, preserveBusy: true, render: false }) : null;
        }));
      }
      const secondMergeCount = deduplicateTasks();
      scanInteractiveTargets();
      const unavailable = [];
      if (!state.modelService.ok) unavailable.push('模型服务不可用');
      if (!state.localHelper.ok) unavailable.push('本机 CSV 助手不可用');
      const summary = `刷新完成：当前 ${state.order.length} 条音频，新增 ${discoveredCount} 条，合并 ${firstMergeCount + secondMergeCount} 条重复项。`;
      showToast(unavailable.length ? `${summary} ${unavailable.join('；')}。` : summary, unavailable.length ? 'warning' : 'success');
    } catch (error) {
      const message = `刷新失败：${error.message || error}`;
      setPanelNotice('error', message, 'refresh');
      showToast(message, 'error');
    } finally {
      state.refreshing = false;
      renderPanel();
      scheduleGridScan();
    }
  }

  function openConfirmModal(options) {
    const modal = ensureModal();
    if (!modal) return;
    state.currentModalKey = '';
    state.confirmAction = typeof options.onConfirm === 'function' ? options.onConfirm : null;
    modal.querySelector('.tm-modal-title').textContent = options.title || '请确认';
    const body = modal.querySelector('.tm-modal-body');
    body.innerHTML = `
      <div class="tm-modal-confirm">
        <div class="tm-confirm-warning">${esc(options.message || '')}</div>
        <div class="tm-actions">
          <button type="button" data-action="confirm-submit">${esc(options.confirmText || '确认')}</button>
          <button type="button" data-action="confirm-cancel">取消</button>
        </div>
      </div>
    `;
    body.querySelector('[data-action="confirm-cancel"]')?.addEventListener('click', closeModal);
    body.querySelector('[data-action="confirm-submit"]')?.addEventListener('click', () => {
      const action = state.confirmAction;
      closeModal();
      if (action) action();
    });
    modal.classList.add('is-open');
  }

  function handlePanelChange(event) {
    const input = event.target;
    if (!input || !input.name) return;
    readSettingsFromPanel();
    saveSettings();
  }

  function readSettingsFromPanel() {
    const root = state.panel;
    if (!root) return;
    const value = (name) => {
      const node = root.querySelector(`[name="${name}"]`);
      return node ? node.value : '';
    };
    settings.modelBaseUrl = normalizeBaseUrl(value('modelBaseUrl') || settings.modelBaseUrl);
    settings.model = value('model') || settings.model;
    settings.apiKey = value('apiKey') || '';
    settings.localHelperUrl = normalizeBaseUrl(value('localHelperUrl') || settings.localHelperUrl);
    settings.localOutputDir = value('localOutputDir') || settings.localOutputDir;
    settings.maxSliceCount = Math.max(0, Number(value('maxSliceCount')) || 0);
    settings.sliceFailLimit = Math.max(1, Number(value('sliceFailLimit')) || 2);
    settings.transcriptColumnWidth = Math.max(240, Number(value('transcriptColumnWidth')) || 420);
    settings.maxChars = Math.max(1, Number(value('maxChars')) || 40);
    settings.feedbackHistory = Boolean(root.querySelector('[name="feedbackHistory"]')?.checked);
  }

  function makePanelDraggable(root, handle) {
    if (!root || !handle) return;
    let dragging = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target && event.target.closest && event.target.closest('button,input,select')) return;
      const rect = root.getBoundingClientRect();
      dragging = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - 80, event.clientX - dragging.dx));
      const top = Math.max(0, Math.min(window.innerHeight - 48, event.clientY - dragging.dy));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      settings.panelLeft = Math.round(left);
      settings.panelTop = Math.round(top);
    });
    const end = () => {
      if (dragging) saveSettings();
      dragging = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          rememberMaybeAudioUrl(mutation.target && mutation.target.getAttribute && mutation.target.getAttribute('src'), 'dom-attr');
        }
        if (mutation.type === 'childList') {
          shouldScan = true;
          mutation.addedNodes.forEach((node) => scanAudioNode(node, 'dom-added'));
        }
      }
      if (shouldScan) scheduleGridScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  function scheduleGridScan() {
    if (state.gridScanTimer) return;
    state.gridScanTimer = setTimeout(() => {
      state.gridScanTimer = null;
      scanInteractiveTargets();
    }, 120);
  }

  function scanInteractiveTargets() {
    injectGridTranscriptColumn();
    injectVxAudioButtons();
    injectGenericAudioButtons();
  }

  function scanAudioElements(source) {
    document.querySelectorAll('audio[src], source[src]').forEach((node) => rememberMaybeAudioUrl(node.getAttribute('src'), source, node));
  }

  function scanAudioNode(node, source) {
    if (!isElementNode(node)) return;
    if (node.matches('audio[src], source[src]')) rememberMaybeAudioUrl(node.getAttribute('src'), source, node);
    node.querySelectorAll && node.querySelectorAll('audio[src], source[src]').forEach((item) => rememberMaybeAudioUrl(item.getAttribute('src'), source, item));
  }

  function scanPerformanceEntries(source) {
    if (!performance || typeof performance.getEntriesByType !== 'function') return;
    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        const url = normalizeAudioUrl(entry && entry.name);
        if (!url || !AUDIO_PATH_RE.test(url)) return;
        const token = `${url}|${Number(entry.startTime || 0).toFixed(3)}`;
        if (state.seenPerformanceAudio.has(token)) return;
        state.seenPerformanceAudio.add(token);
        if (state.internalAudioUrls.has(url)) return;
        rememberMaybeAudioUrl(url, `performance:${source}`);
      });
      trimSet(state.seenPerformanceAudio, 2000);
    } catch (_) {}
  }

  function rememberMaybeAudioUrl(input, source, contextNode, contextOverride) {
    const url = normalizeAudioUrl(input);
    if (!url || !AUDIO_PATH_RE.test(url)) return null;
    const audio = parseAudioUrl(url);
    if (!audio.targetfile) return null;
    const pending = state.pendingGridManual;
    const pendingMatches = pending &&
      Date.now() - pending.startedAt < Number(pending.timeoutMs || 60000) &&
      audio.index === 0 &&
      (!pending.targetfile || pending.targetfile === audio.targetfile);
    const resolvedNode = isElementNode(contextNode) ? contextNode : findAudioElementByUrl(url);
    if (!resolvedNode && String(source || '').startsWith('performance') && !contextOverride && !pendingMatches && !findActiveGridRowContext()) return null;
    const context = contextOverride || (pendingMatches ? pending.context : extractAudioContext(resolvedNode || contextNode, url));
    const recordKey = buildRecordKey(context, audio);
    let task = state.tasks.get(recordKey) || adoptExistingAudioTask(recordKey, audio, context);
    let created = false;
    if (!task) {
      created = true;
      task = createTask(recordKey, audio, context, source);
      state.tasks.set(recordKey, task);
      state.order.unshift(recordKey);
      if (state.order.length > 30) {
        const old = state.order.pop();
        if (old) state.tasks.delete(old);
      }
      task.cacheLookupPending = true;
      hydrateTaskFromLocalCsv(task, { preserveBusy: true }).finally(() => {
        task.cacheLookupPending = false;
        maybeAutoQueueTask(task, source);
      });
    }
    task.lastSeenAt = Date.now();
    task.source = task.source || source;
    task.context = mergeContext(task.context, context);
    task.audio = { ...task.audio, ...audio, url };
    task.sourceTargetfiles = task.sourceTargetfiles || new Set();
    task.sourceAudioUrls = task.sourceAudioUrls || new Set();
    task.sourceTargetfiles.add(audio.targetfile);
    task.sourceAudioUrls.add(url);
    task.slices.set(audio.index, url);
    task.title = buildTaskTitle(task.context, task.audio);
    task.csvFilename = buildCsvFilename(task.context, task.audio);
    state.latestKey = task.key;
    if (pendingMatches || source === 'manual-grid') {
      const force = Boolean(task.hasLocalCsv || task.manualAttempted);
      task.manualAttempted = true;
      finishPendingGridManual(pending, true);
      enqueueTask(task, force);
    } else if (!created || !task.cacheLookupPending) {
      maybeAutoQueueTask(task, source);
    }
    renderPanel();
    scheduleGridScan();
    return task;
  }

  function adoptExistingAudioTask(recordKey, audio, context) {
    if (!audio || !audio.targetfile) return null;
    if (context && context.scene === 'generic') {
      return findTaskByTargetFile(audio.targetfile, (task) => task.context && task.context.scene !== 'generic');
    }
    const genericTask = findTaskByTargetFile(audio.targetfile, (task) => !task.context || task.context.scene === 'generic');
    if (!genericTask) return null;
    const oldKey = genericTask.key;
    const adoptedTask = oldKey !== recordKey ? rekeyTask(genericTask, recordKey) : genericTask;
    adoptedTask.context = mergeContext(adoptedTask.context, context);
    adoptedTask.csvFilename = buildCsvFilename(adoptedTask.context, audio);
    adoptedTask.title = buildTaskTitle(adoptedTask.context, audio);
    return adoptedTask;
  }

  function findTaskByTargetFile(targetfile, predicate) {
    for (const task of state.tasks.values()) {
      if (!task || !task.audio) continue;
      const matches = task.audio.targetfile === targetfile || (task.sourceTargetfiles && task.sourceTargetfiles.has(targetfile));
      if (!matches) continue;
      if (!predicate || predicate(task)) return task;
    }
    return null;
  }

  function createTask(recordKey, audio, context, source) {
    const title = buildTaskTitle(context, audio);
    return {
      key: recordKey,
      source,
      audio,
      context,
      slices: new Map([[audio.index, audio.url]]),
      sourceTargetfiles: new Set([audio.targetfile]),
      sourceAudioUrls: new Set([audio.url]),
      status: 'discovered',
      message: '已捕获音频',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      csvFilename: buildCsvFilename(context, audio),
      segments: [],
      language: '',
      uuid: '',
      text: '',
      error: '',
      audioBlobUrl: '',
      audioChannelText: '',
      audioIndexRange: '',
      hasLocalCsv: false,
      localCsvText: '',
      title,
      autoQueued: false,
      cacheLookupPending: false,
    };
  }

  function maybeAutoQueueTask(task, source) {
    if (!task || String(source || '').startsWith('manual-refresh')) return;
    if (!settings.autoTranscribe || task.autoQueued || task.hasLocalCsv || task.cacheLookupPending) return;
    if (['queued', 'downloading', 'merging', 'transcribing', 'saving', 'done', 'cached'].includes(task.status)) return;
    task.autoQueued = true;
    enqueueTask(task, false);
  }

  function rekeyTask(task, newKey) {
    if (!task || !newKey || task.key === newKey) return task;
    const oldKey = task.key;
    const existing = state.tasks.get(newKey);
    if (existing && existing !== task) {
      mergeDuplicateTask(existing, task);
      removeTaskReference(oldKey, newKey);
      return existing;
    }
    state.tasks.delete(oldKey);
    task.key = newKey;
    state.tasks.set(newKey, task);
    replaceTaskReference(oldKey, newKey);
    return task;
  }

  function replaceTaskReference(oldKey, newKey) {
    state.order = uniqueValues(state.order.map((key) => (key === oldKey ? newKey : key)));
    state.queue = uniqueValues(state.queue.map((key) => (key === oldKey ? newKey : key)));
    if (state.latestKey === oldKey) state.latestKey = newKey;
    if (state.currentModalKey === oldKey) state.currentModalKey = newKey;
  }

  function removeTaskReference(oldKey, replacementKey) {
    state.tasks.delete(oldKey);
    replaceTaskReference(oldKey, replacementKey);
  }

  function deduplicateTasks() {
    let merged = 0;
    const keys = state.order.slice();
    keys.forEach((key) => {
      const task = state.tasks.get(key);
      if (!task) return;
      const canonicalKey = buildRecordKey(task.context, task.audio);
      if (canonicalKey === key) return;
      const existing = state.tasks.get(canonicalKey);
      if (existing && existing !== task) {
        mergeDuplicateTask(existing, task);
        removeTaskReference(key, canonicalKey);
        merged += 1;
      } else {
        rekeyTask(task, canonicalKey);
      }
    });
    state.order = uniqueValues(state.order.filter((key) => state.tasks.has(key)));
    state.queue = uniqueValues(state.queue.filter((key) => state.tasks.has(key)));
    return merged;
  }

  function mergeDuplicateTask(primary, duplicate) {
    if (!primary || !duplicate || primary === duplicate) return primary;
    primary.context = mergeContext(primary.context, duplicate.context);
    primary.sourceTargetfiles = primary.sourceTargetfiles || new Set();
    primary.sourceAudioUrls = primary.sourceAudioUrls || new Set();
    for (const value of duplicate.sourceTargetfiles || []) primary.sourceTargetfiles.add(value);
    for (const value of duplicate.sourceAudioUrls || []) primary.sourceAudioUrls.add(value);
    for (const [index, url] of duplicate.slices || []) {
      if (!primary.slices.has(index) || duplicate.lastSeenAt >= primary.lastSeenAt) primary.slices.set(index, url);
    }
    if (duplicate.lastSeenAt >= primary.lastSeenAt) {
      primary.audio = { ...primary.audio, ...duplicate.audio };
      primary.lastSeenAt = duplicate.lastSeenAt;
      primary.source = duplicate.source || primary.source;
    }
    if ((!primary.segments || !primary.segments.length) && duplicate.segments && duplicate.segments.length) {
      primary.segments = duplicate.segments;
      primary.text = duplicate.text;
      primary.language = duplicate.language;
      primary.uuid = duplicate.uuid;
      primary.status = duplicate.status;
      primary.message = duplicate.message;
      primary.error = duplicate.error;
    }
    if (!primary.localCsvText && duplicate.localCsvText) primary.localCsvText = duplicate.localCsvText;
    primary.hasLocalCsv = primary.hasLocalCsv || duplicate.hasLocalCsv;
    primary.manualAttempted = primary.manualAttempted || duplicate.manualAttempted;
    primary.autoQueued = primary.autoQueued || duplicate.autoQueued;
    primary.audioBlobUrl = primary.audioBlobUrl || duplicate.audioBlobUrl;
    primary.audioChannelText = primary.audioChannelText || duplicate.audioChannelText;
    primary.audioIndexRange = primary.audioIndexRange || duplicate.audioIndexRange;
    primary.title = buildTaskTitle(primary.context, primary.audio);
    primary.csvFilename = buildCsvFilename(primary.context, primary.audio);
    return primary;
  }

  function mergeContext(oldContext, nextContext) {
    return {
      ...oldContext,
      ...Object.fromEntries(Object.entries(nextContext || {}).filter(([, value]) => value !== '' && value != null)),
      element: (nextContext && nextContext.element) || (oldContext && oldContext.element) || null,
    };
  }

  function enqueueTask(task, force) {
    if (!task) return;
    if (['downloading', 'merging', 'transcribing', 'saving'].includes(task.status)) return;
    task.status = 'queued';
    task.message = force ? '已加入重新识别队列' : '已加入识别队列';
    task.error = '';
    task.force = Boolean(force);
    task.manualAttempted = task.manualAttempted || Boolean(force);
    task.hasLocalCsv = false;
    if (!state.queue.includes(task.key)) state.queue.push(task.key);
    processQueueSoon();
    renderPanel();
    scheduleGridScan();
  }

  function processQueueSoon() {
    setTimeout(processQueue, 0);
  }

  async function processQueue() {
    if (state.processing) return;
    const key = state.queue.shift();
    if (!key) return;
    const task = state.tasks.get(key);
    if (!task) {
      processQueueSoon();
      return;
    }
    state.processing = true;
    try {
      await transcribeTask(task);
    } catch (error) {
      task.status = 'error';
      task.error = error && error.message ? error.message : String(error);
      task.message = '识别失败';
      refreshTaskModal(task);
      debugLog('task failed', task.key, error);
    } finally {
      state.processing = false;
      renderPanel();
      scheduleGridScan();
      processQueueSoon();
    }
  }

  async function transcribeTask(task) {
    updateTask(task, 'downloading', '正在下载音频切片');
    const slices = await downloadTaskSlices(task);
    if (!slices.length) throw new Error('没有下载到有效音频切片');
    task.audioIndexRange = indexRangeText(slices.map((item) => item.index));

    updateTask(task, 'merging', `正在合并 ${slices.length} 个切片`);
    const merged = mergeWavBuffers(slices.map((item) => item.buffer), settings.maxMergeMinutes);
    if (task.audioBlobUrl) URL.revokeObjectURL(task.audioBlobUrl);
    task.audioBlobUrl = URL.createObjectURL(new Blob([merged.fullBuffer], { type: 'audio/wav' }));
    task.audioChannelText = merged.sourceChannels > 1
      ? `${merged.sourceChannels} 声道已在本机合并为单声道`
      : '原音频为单声道';

    const allSegments = [];
    const speakerLabels = new Map();
    let language = '';
    let uuidText = '';
    for (let i = 0; i < merged.parts.length; i += 1) {
      const part = merged.parts[i];
      updateTask(task, 'transcribing', `模型识别 ${i + 1}/${merged.parts.length}`);
      const result = await callV1Api(part.buffer, `${stripCsvExt(task.csvFilename)}_part${i + 1}.wav`);
      if (result.code !== 200) throw new Error(result.message || `模型返回 code=${result.code}`);
      language = result.language || language;
      uuidText = result.uuid || uuidText;
      (result.data || []).forEach((row) => {
        allSegments.push({
          segment_no: allSegments.length + 1,
          lid: sequentialSpeakerLabel(row.lid, speakerLabels),
          text: String(row.text || ''),
          corrected_text: '',
          is_corrected: '',
          begin_ms: Number(row.begin || 0) + part.offsetMs,
          end_ms: Number(row.end || 0) + part.offsetMs,
        });
      });
    }

    task.segments = allSegments;
    task.language = language;
    task.uuid = uuidText;
    task.text = allSegments.map((item) => item.text).join('');
    task.status = 'saving';
    task.message = '正在保存 CSV';
    const csvText = buildCsv(task);
    const saveResult = await saveTaskCsv(task, csvText, task.force ? 'manual_retranscribe' : 'initial_transcribe');
    task.status = 'done';
    task.message = saveResult.localSaved ? '识别完成' : '识别完成；本机 CSV 未保存，结果已保存到模型端';
    task.hasLocalCsv = saveResult.localSaved;
    task.localCsvText = csvText;
    refreshTaskModal(task);
  }

  function updateTask(task, status, message) {
    task.status = status;
    task.message = message;
    renderPanel();
    scheduleGridScan();
    refreshTaskModal(task);
  }

  async function downloadTaskSlices(task) {
    const out = [];
    const maxCount = settings.maxSliceCount > 0 ? settings.maxSliceCount : 0;
    const failLimit = Math.max(1, Number(settings.sliceFailLimit) || 2);
    let failures = 0;
    for (let index = 0; ; index += 1) {
      if (maxCount && index >= maxCount) break;
      const url = task.slices.get(index) || audioUrlForIndex(task.audio.url, index);
      try {
        const buffer = await downloadAudio(url);
        if (buffer && buffer.byteLength > 44) {
          out.push({ index, url, buffer });
          task.slices.set(index, url);
          failures = 0;
        } else {
          failures += 1;
        }
      } catch (error) {
        failures += 1;
        debugLog('slice download failed', index, error);
      }
      if (failures >= failLimit) break;
      if (!maxCount && index > 10000) break;
    }
    return out;
  }

  async function downloadAudio(url) {
    state.internalAudioUrls.add(normalizeAudioUrl(url));
    trimSet(state.internalAudioUrls, 2000);
    const response = await httpRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: { Accept: 'audio/wav,audio/x-wav,*/*' },
      timeout: settings.requestTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载音频失败 HTTP ${response.status}`);
    }
    return response.response;
  }

  async function callV1Api(buffer, filename) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), filename);
    const url = `${settings.modelBaseUrl}/v1/audiototext?model=${encodeURIComponent(settings.model)}&diarize=${settings.diarize ? '1' : '0'}&language=${encodeURIComponent(settings.language || 'auto')}&max_chars=${encodeURIComponent(String(settings.maxChars || 40))}`;
    const headers = { Accept: 'application/json' };
    if (settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    const response = await httpRequest({
      method: 'POST',
      url,
      data: form,
      responseType: 'text',
      headers,
      timeout: settings.modelTimeoutMs,
    });
    const text = response.responseText || response.response || '';
    if (response.status < 200 || response.status >= 300) throw new Error(`v1 API HTTP ${response.status}: ${truncate(text, 220)}`);
    return JSON.parse(text || '{}');
  }

  async function saveTaskCsv(task, csvText, writeEvent) {
    let localSaved = false;
    const localBody = {
      output_dir: settings.localOutputDir,
      csv_filename: task.csvFilename,
      csv_text: csvText,
    };
    try {
      const local = await postJson(`${settings.localHelperUrl}/local/csv/save`, localBody, 15000);
      state.localHelper.ok = local.code === 200;
      state.localHelper.message = state.localHelper.ok ? '已连接' : '异常';
      state.localHelper.checkedAt = Date.now();
      task.localSaveError = '';
      localSaved = true;
      clearPanelNotice('helper');
    } catch (error) {
      state.localHelper.ok = false;
      state.localHelper.message = '未连接';
      state.localHelper.checkedAt = Date.now();
      task.localSaveError = localHelperStartMessage(error.message || error);
      setPanelNotice('error', task.localSaveError, 'helper');
      showToast('本机 CSV 自动保存失败。模型端仍会继续保存，也可点击“CSV另存”。', 'error', 6500);
    }
    const modelBody = {
      record_key: task.key,
      csv_filename: task.csvFilename,
      csv_text: csvText,
      write_event: writeEvent || 'manual_save',
      content_hash: await sha256Text(csvText),
      client_id: state.localHelper.primaryIp || '',
      client_ip_hint: state.localHelper.primaryIp || '',
    };
    try {
      await postJson(`${settings.modelBaseUrl}/translator/csv`, modelBody, 30000, true);
      state.modelService.ok = true;
      state.modelService.message = '已连接';
      state.modelService.checkedAt = Date.now();
      clearPanelNotice('model');
    } catch (error) {
      state.modelService.ok = false;
      state.modelService.message = '保存失败';
      state.modelService.checkedAt = Date.now();
      setPanelNotice('error', `模型端 CSV 保存失败：${error.message || error}\n请检查模型服务地址、API 服务状态及 API Key。`, 'model');
      throw error;
    }
    return { localSaved, modelSaved: true };
  }

  async function hydrateTaskFromLocalCsv(task, options) {
    const opts = options || {};
    try {
      const status = await getJson(`${settings.localHelperUrl}/local/csv?filename=${encodeURIComponent(task.csvFilename)}&outputDir=${encodeURIComponent(settings.localOutputDir)}`, 8000);
      if (status && status.exists && isCurrentModelCsv(status.csv_text || '')) {
        task.hasLocalCsv = true;
        task.localCsvText = status.csv_text || '';
        task.segments = parseCsvSegments(status.csv_text || '');
        if (!opts.preserveBusy || !['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status)) {
          task.status = status.row_count > 0 ? 'cached' : 'queued';
        }
        task.manualAttempted = true;
        task.message = status.row_count > 0 ? '已读取本机 CSV' : 'CSV 为空，可能正在识别';
      } else if (status && status.exists) {
        task.hasLocalCsv = false;
        task.localCsvText = '';
        task.segments = [];
        task.message = '已忽略旧版或无效 CSV';
      } else if (opts.resetMissing) {
        task.hasLocalCsv = false;
        task.localCsvText = '';
      }
    } catch (error) {
      debugLog('local csv hydrate failed', error);
    } finally {
      if (opts.render !== false) {
        renderPanel();
        scheduleGridScan();
      }
    }
  }

  function canSaveTaskCsv(task) {
    return Boolean(task && (
      isCurrentModelCsv(task.localCsvText || '') ||
      (task.segments && task.segments.length) ||
      task.status === 'done' ||
      task.status === 'cached' ||
      task.hasLocalCsv
    ));
  }

  async function resolveTaskCsvForSaveAs(task) {
    if (!task) throw new Error('没有可另存的任务');
    if (isCurrentModelCsv(task.localCsvText || '')) return task.localCsvText;
    if (task.segments && task.segments.length) return buildCsv(task);

    const query = new URLSearchParams({
      filename: task.csvFilename,
      record_key: task.key || '',
      client_ip_hint: state.localHelper.primaryIp || '',
    });
    const result = await getJson(`${settings.modelBaseUrl}/translator/csv?${query.toString()}`, 15000, true);
    const csvText = String(result && result.csv_text || '');
    if (!result || !result.exists || !isCurrentModelCsv(csvText)) {
      throw new Error('本机内存和模型端都没有可用的中文 CSV');
    }
    task.localCsvText = csvText;
    task.segments = parseCsvSegments(csvText);
    return csvText;
  }

  async function saveTaskCsvAs(task) {
    if (!task || task.csvSaveAsBusy) {
      if (task && task.csvSaveAsBusy) showToast('CSV另存正在处理中，请稍候。', 'warning');
      return;
    }
    task.csvSaveAsBusy = true;
    let fileHandle = null;
    try {
      const picker = typeof userConfig.__testSaveFilePicker === 'function'
        ? userConfig.__testSaveFilePicker
        : (!userConfig.__disableNativeSaveFilePicker && typeof window.showSaveFilePicker === 'function'
          ? window.showSaveFilePicker.bind(window)
          : null);
      if (picker) {
        showToast('正在打开 CSV 保存位置选择窗口。');
        try {
          fileHandle = await picker({
            suggestedName: task.csvFilename,
            types: [{
              description: 'CSV 文件',
              accept: { 'text/csv': ['.csv'] },
            }],
          });
        } catch (error) {
          if (error && error.name === 'AbortError') {
            showToast('已取消 CSV另存。', 'warning');
            return;
          }
          debugLog('showSaveFilePicker unavailable, falling back to browser download', error);
          showToast('无法打开保存位置选择窗口，已改用浏览器下载。', 'warning', 5500);
        }
      } else {
        showToast('当前浏览器不支持保存位置选择，已改用浏览器下载。', 'warning', 5500);
      }

      const csvText = await resolveTaskCsvForSaveAs(task);
      const blob = new Blob([`\ufeff${String(csvText || '').replace(/^\ufeff/, '')}`], {
        type: 'text/csv;charset=utf-8',
      });
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        try {
          await writable.write(blob);
        } finally {
          await writable.close();
        }
      } else {
        await fallbackBrowserDownload(blob, task.csvFilename);
      }
      clearPanelNotice('download');
      showToast(fileHandle ? `CSV 已保存：${task.csvFilename}` : `已触发 CSV 下载：${task.csvFilename}`, 'success');
      renderPanel();
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      showToast(`CSV另存失败：${detail}`, 'error', 6500);
      setPanelNotice('error', `CSV另存失败：${detail}`, 'download');
      renderPanel();
    } finally {
      task.csvSaveAsBusy = false;
    }
  }

  async function fallbackBrowserDownload(blob, filename) {
    if (typeof userConfig.__testBrowserDownload === 'function') {
      await userConfig.__testBrowserDownload(blob, filename);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }

  async function checkLocalHelper(force, notify) {
    if (!force && Date.now() - state.localHelper.checkedAt < 15000) return state.localHelper;
    try {
      const result = await getJson(`${settings.localHelperUrl}/local/health`, 5000);
      const identityOk = result && (
        result.service === LOCAL_HELPER_SERVICE ||
        (result.status === 'ok' && Object.prototype.hasOwnProperty.call(result, 'output_dir') && Array.isArray(result.ips))
      );
      if (!identityOk) throw new Error('该地址返回的不是本机 CSV 助手');
      state.localHelper.ok = result.code === 200 || result.status === 'ok';
      state.localHelper.primaryIp = result.primary_ip || (result.ips && result.ips[0]) || '';
      state.localHelper.message = state.localHelper.ok ? '已连接' : '异常';
      if (!state.localHelper.ok) throw new Error(result.message || '助手状态异常');
      clearPanelNotice('helper');
      if (force && notify !== false) showToast('本机 CSV 助手连接正常。', 'success');
    } catch (error) {
      state.localHelper.ok = false;
      state.localHelper.message = '未连接';
      const message = localHelperStartMessage(error.message || error);
      setPanelNotice('error', message, 'helper');
      if (force && notify !== false) showToast(message, 'error', 8000);
    }
    state.localHelper.checkedAt = Date.now();
    renderPanel();
    return state.localHelper;
  }

  async function checkModelService(force, notify) {
    if (!force && Date.now() - state.modelService.checkedAt < 15000) return state.modelService;
    try {
      const result = await getJson(`${settings.modelBaseUrl}/health`, 5000);
      const healthOk = Boolean(result && (result.status === 'ok' || result.code === 200));
      const actualModel = String(result && result.model || '未返回');
      state.modelService.ok = healthOk && actualModel === 'Tailect_V4.1';
      if (!healthOk) throw new Error(result && result.message ? result.message : '健康检查未返回正常状态');
      if (actualModel !== 'Tailect_V4.1') {
        throw new Error(`模型不一致：期望 Tailect_V4.1，服务返回 ${actualModel}`);
      }
      state.modelService.message = '已连接';
      clearPanelNotice('model');
      if (force && notify !== false) showToast('模型 API 服务连接正常。', 'success');
    } catch (error) {
      state.modelService.ok = false;
      state.modelService.message = '未连接';
      const message = `模型 API 服务不可用：${error.message || error}\n请检查模型服务地址，并确认 API 服务启动脚本已正常运行。`;
      setPanelNotice('error', message, 'model');
      if (force && notify !== false) showToast(message, 'error', 7000);
    }
    state.modelService.checkedAt = Date.now();
    renderPanel();
    return state.modelService;
  }

  async function openLocalCsvPath(task) {
    if (!task) return;
    try {
      const helper = await checkLocalHelper(true, false);
      if (!helper.ok) return;
      const result = await postJson(`${settings.localHelperUrl}/local/csv/open-path`, {
        output_dir: settings.localOutputDir,
        csv_filename: task.csvFilename,
      }, 8000);
      showToast(`已在资源管理器中选中：${result.path || task.csvFilename}`, 'success');
    } catch (error) {
      const detail = error.message || error;
      task.message = `打开文件路径失败：${detail}`;
      setPanelNotice('error', `打开文件路径失败：${detail}\n请确认本机 CSV 助手已启动，并且该 CSV 已成功保存到本机。`, 'helper');
      showToast(task.message, 'error', 6500);
      renderPanel();
    }
  }

  function renderPanel() {
    if (!state.bodyReady) return;
    const root = ensurePanel();
    if (!root) return;
    root.classList.toggle('tm-collapsed', Boolean(settings.collapsed));
    const active = currentTask();
    const statusEl = root.querySelector('.tm-status');
    if (statusEl) statusEl.textContent = active ? (STATUS_LABELS[active.status] || active.status) : '等待音频';
    const body = root.querySelector('.tm-body');
    if (!body) return;
    const notice = state.panelNotice
      ? `<div class="tm-notice ${escAttr(state.panelNotice.type)}">${esc(state.panelNotice.message)}</div>`
      : '';
    const helperStatusClass = state.localHelper.ok ? 'ok' : (state.localHelper.checkedAt ? 'error' : '');
    const modelStatusClass = state.modelService.ok ? 'ok' : (state.modelService.checkedAt ? 'error' : '');
    const helperEndpoint = serviceEndpointLabel(settings.localHelperUrl);
    body.innerHTML = `
      ${notice}
      <div class="tm-controls">
        <section class="tm-config-section">
          <div class="tm-section-head">模型服务 <small>负责音频识别和模型端 CSV</small></div>
          <div class="tm-form-grid">
            <div class="tm-field-label">服务地址 <span class="tm-info" title="Tailect v1 API 的地址。模型在另一台电脑时，填写模型电脑的 IP 和 8885 端口。">i</span></div>
            <input name="modelBaseUrl" type="text" value="${escAttr(settings.modelBaseUrl)}" placeholder="http://模型电脑IP:8885">
            <div class="tm-field-label">识别模型</div>
            <select name="model">
              <option value="Tailect_V4.1" selected>Tailect_V4.1</option>
            </select>
            <div class="tm-field-label">API Key <span class="tm-info" title="仅当模型服务启用了 TAILECT_API_KEY 鉴权时填写；未启用鉴权请留空。">i</span></div>
            <input name="apiKey" type="password" value="${escAttr(settings.apiKey)}" autocomplete="off" placeholder="未启用鉴权时留空">
            <div class="tm-field-label">服务状态</div>
            <div class="tm-service-line"><span class="tm-service-dot ${modelStatusClass}"></span><span>${esc(state.modelService.message)}</span><button type="button" data-action="model-check">检测模型服务</button></div>
          </div>
        </section>
        <section class="tm-config-section">
          <div class="tm-section-head">本机 CSV <small>运行在当前浏览器所在电脑</small></div>
          <div class="tm-form-grid">
            <div class="tm-field-label">本机助手地址 <span class="tm-info" title="本机助手负责把 CSV 写入当前电脑，并支持在资源管理器中选中文件。它与模型服务是两个独立进程。">i</span></div>
            <input name="localHelperUrl" type="text" value="${escAttr(settings.localHelperUrl)}" placeholder="http://127.0.0.1:18885">
            <div class="tm-subhelp">未连接时，请在本机双击 ${esc(LOCAL_HELPER_BAT)}</div>
            <div class="tm-field-label">本机保存目录</div>
            <input name="localOutputDir" type="text" value="${escAttr(settings.localOutputDir)}">
            <div class="tm-field-label">助手状态</div>
            <div class="tm-service-line"><span class="tm-service-dot ${helperStatusClass}"></span><span>${esc(state.localHelper.message)}${state.localHelper.ok && helperEndpoint ? `（${esc(helperEndpoint)}）` : ''}</span><button type="button" data-action="helper-check">检测本机助手</button></div>
            ${state.localHelper.ok && state.localHelper.primaryIp ? `<div class="tm-subhelp">模型端 CSV 归档 IP：${esc(state.localHelper.primaryIp)}。该 IP 仅用于模型端按脚本主机分目录，不是助手连接地址。</div>` : ''}
          </div>
        </section>
        <section class="tm-config-section">
          <div class="tm-section-head">识别设置</div>
          <div class="tm-form-grid">
            <div class="tm-field-label">切片数量上限 <span class="tm-info" title="最多探测多少个 index 切片。0 表示不限制，由连续失败阈值决定何时停止。">i</span></div>
            <input name="maxSliceCount" type="number" min="0" value="${escAttr(settings.maxSliceCount)}">
            <div class="tm-field-label">连续失败阈值 <span class="tm-info" title="连续多少个切片下载失败后停止继续探测，默认 2。">i</span></div>
            <input name="sliceFailLimit" type="number" min="1" value="${escAttr(settings.sliceFailLimit)}">
            <div class="tm-field-label">识别内容列宽 <span class="tm-info" title="普通语音列表新增的“识别内容”列宽度，单位为像素。">i</span></div>
            <input name="transcriptColumnWidth" type="number" min="240" value="${escAttr(settings.transcriptColumnWidth)}">
            <div class="tm-field-label">单行最大字数</div>
            <input name="maxChars" type="number" min="1" value="${escAttr(settings.maxChars)}">
            <div class="tm-field-label">反馈历史 <span class="tm-info" title="开启后额外记录 feedback.jsonl，便于审计和追溯；关闭时仍会直接修正双端 CSV。">i</span></div>
            <label><input name="feedbackHistory" type="checkbox" ${settings.feedbackHistory ? 'checked' : ''}> 记录修正历史（默认关闭）</label>
          </div>
        </section>
        <section class="tm-config-section">
          <div class="tm-section-head">识别控制</div>
          <div class="tm-switches">
            <button class="tm-toggle ${settings.autoTranscribe ? 'is-on' : 'is-off'}" type="button" data-action="toggle-auto">自动识别新音频：${settings.autoTranscribe ? '已开启' : '已关闭'}</button>
            <button class="tm-toggle ${settings.diarize ? 'is-on' : 'is-off'}" type="button" data-action="toggle-diarize">说话人识别：${settings.diarize ? '已开启' : '已关闭'}</button>
            <button type="button" data-action="manual-current">全部重新识别</button>
            <button type="button" data-action="save-as-csv" data-key="${escAttr(active ? active.key : '')}" ${canSaveTaskCsv(active) ? '' : 'disabled'} title="${canSaveTaskCsv(active) ? '选择位置保存当前中文 CSV；助手不可用时也可使用' : '当前任务还没有可用于另存的 CSV'}">CSV另存</button>
            <button type="button" data-action="open-path" data-key="${escAttr(active ? active.key : '')}" ${active && active.hasLocalCsv ? '' : 'disabled'} title="${active && active.hasLocalCsv ? '在资源管理器中选中当前本机 CSV' : '本机助手尚未确认该 CSV 已落盘'}">打开文件路径</button>
            <button type="button" data-action="save-settings">保存配置</button>
          </div>
        </section>
      </div>
      <div class="tm-list-head">
        <span>音频列表 <small>${state.order.length} 条</small></span>
        <button class="tm-icon-control ${state.refreshing ? 'is-spinning' : ''}" type="button" data-action="refresh-all" title="刷新顶部提示、服务状态和音频列表" aria-label="刷新状态" ${state.refreshing ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6"/></svg>
        </button>
      </div>
      <div class="tm-list">${state.order.length ? state.order.map((key) => renderTaskCard(state.tasks.get(key))).join('') : '<div class="tm-help">等待页面播放或加载语音。</div>'}</div>
    `;
  }

  function renderTaskCard(task) {
    if (!task) return '';
    const status = STATUS_LABELS[task.status] || task.status;
    const statusCls = task.status === 'done' || task.status === 'cached' ? 'done' : (task.status === 'error' ? 'error' : '');
    const summary = task.segments && task.segments.length ? transcriptSummary(task.segments, 96) : task.message;
    return `
      <section class="tm-record">
        <div class="tm-record-head">
          <span class="tm-record-kind">${esc(task.context.sceneLabel || task.context.kind || '音频')}</span>
          <span class="tm-record-title" title="${escAttr(task.csvFilename)}">${esc(task.title || task.context.title || task.csvFilename)}</span>
          <span class="tm-record-status ${statusCls}">${esc(status)}</span>
        </div>
        <div class="tm-record-body">
          <div>${esc(summary || '')}</div>
          ${task.error ? `<div style="color:#b91c1c">${esc(task.error)}</div>` : ''}
          ${task.localSaveError ? '<div style="color:#92400e">本机 CSV 未自动保存；模型端 CSV 已继续保存。可直接“CSV另存”，也可启动本机助手后重新识别或提交修正。</div>' : ''}
          <div class="tm-actions">
            ${task.hasLocalCsv || task.segments.length ? `<button type="button" data-action="open-task" data-key="${escAttr(task.key)}">展开</button>` : ''}
            <button type="button" data-action="retry-task" data-key="${escAttr(task.key)}">${task.hasLocalCsv || task.manualAttempted || task.status === 'done' ? '重新识别' : '手动识别'}</button>
            <button type="button" data-action="save-as-csv" data-key="${escAttr(task.key)}" ${canSaveTaskCsv(task) ? '' : 'disabled'} title="${canSaveTaskCsv(task) ? '选择位置保存中文 CSV；助手不可用时也可使用' : '当前任务还没有可用于另存的 CSV'}">CSV另存</button>
            <button type="button" data-action="open-path" data-key="${escAttr(task.key)}" ${task.hasLocalCsv ? '' : 'disabled'} title="${task.hasLocalCsv ? '在资源管理器中选中本机 CSV' : '本机助手尚未确认该 CSV 已落盘'}">打开文件路径</button>
          </div>
        </div>
      </section>
    `;
  }

  function injectGridTranscriptColumn() {
    const grids = document.querySelectorAll ? document.querySelectorAll('.wj-flexgrid, .wj-control[wj-part="root"]') : [];
    grids.forEach((grid) => {
      const rows = grid.querySelectorAll('[wj-part="chcells"] > .wj-row, [wj-part="cells"] > .wj-row');
      rows.forEach((row) => {
      const cells = Array.from(row.children).filter((cell) => (
        !cell.classList.contains('tm-transcript-cell') &&
        (cell.classList.contains('wj-cell') || cell.getAttribute('role') === 'gridcell' || cell.getAttribute('role') === 'columnheader')
      ));
      if (cells.length < 1) return;
      if (isHiddenGridAccessibilityRow(row, cells)) return;
      const previousWidth = Math.max(0, Number(row.dataset.tmTranscriptWidth) || 0);
      const cellRecords = cells.map((cell) => {
        const currentLeft = px(cell.style.left);
        let originalLeft = Number(cell.dataset.tmOriginalLeft);
        if (!Number.isFinite(originalLeft)) {
          originalLeft = currentLeft;
        } else {
          const firstCurrent = Math.min(...cells.map((item) => px(item.style.left)));
          const expectedLeft = originalLeft > firstCurrent ? originalLeft + previousWidth : originalLeft;
          if (Math.abs(currentLeft - expectedLeft) > 1 && Math.abs(currentLeft - originalLeft) > 1) {
            originalLeft = currentLeft;
          }
        }
        cell.dataset.tmOriginalLeft = String(originalLeft);
        return { cell, left: originalLeft };
      }).sort((a, b) => a.left - b.left);
      const first = cellRecords[0].cell;
      const firstLeft = cellRecords[0].left;
      const firstWidth = px(first.style.width) || first.getBoundingClientRect().width || 60;
      const colLeft = firstLeft + firstWidth;
      const width = settings.transcriptColumnWidth;
      cellRecords.forEach(({ cell, left }) => {
        cell.style.left = `${left > firstLeft ? left + width : left}px`;
      });
      row.dataset.tmTranscriptWidth = String(width);
      let transcriptCell = row.querySelector(':scope > .tm-transcript-cell');
      if (!transcriptCell) {
        transcriptCell = document.createElement('div');
        transcriptCell.className = 'tm-transcript-cell wj-cell';
        row.insertBefore(transcriptCell, first.nextSibling);
      }
      transcriptCell.style.left = `${colLeft}px`;
      transcriptCell.style.top = first.style.top || '0px';
      transcriptCell.style.width = `${width}px`;
      transcriptCell.style.height = first.style.height || '28px';
      transcriptCell.style.zIndex = '2';

      const isHeader = /序号/.test(compactText(first.textContent || '')) || row.closest('[wj-part="chcells"]');
      transcriptCell.classList.toggle('is-header', Boolean(isHeader));
      transcriptCell.classList.toggle('wj-header', Boolean(isHeader));
      transcriptCell.setAttribute('role', isHeader ? 'columnheader' : 'gridcell');
      if (isHeader) {
        if (transcriptCell.dataset.tmContent !== 'header') {
          transcriptCell.textContent = '识别内容';
          transcriptCell.dataset.tmContent = 'header';
        }
      } else if (isGridDataRow(row)) {
        const context = buildGridRowContext(row);
        const task = findTaskByContext(context);
        const content = renderGridCellContent(task, context);
        if (transcriptCell.dataset.tmContent !== content) {
          transcriptCell.innerHTML = content;
          transcriptCell.dataset.tmContent = content;
        }
      }
      });
      syncGridContentWidth(grid, settings.transcriptColumnWidth);
    });
  }

  function isHiddenGridAccessibilityRow(row, cells) {
    const first = cells[0];
    const top = px(first.style.top);
    const height = px(first.style.height);
    return top < -1000 || (height > 0 && height < 1) || first.style.opacity === '0' || row.getAttribute('aria-hidden') === 'true';
  }

  function syncGridContentWidth(grid, addedWidth) {
    const previousWidth = Math.max(0, Number(grid.dataset.tmTranscriptWidth) || 0);
    const parts = [
      grid.querySelector('[wj-part="cells"]'),
      grid.querySelector('[wj-part="chcells"]'),
      grid.querySelector('[wj-part="sz"]'),
    ].filter(Boolean);
    const originalCellRight = Array.from(grid.querySelectorAll('[wj-part="cells"] > .wj-row > .wj-cell:not(.tm-transcript-cell), [wj-part="chcells"] > .wj-row > .wj-cell:not(.tm-transcript-cell)'))
      .reduce((max, cell) => {
        const left = Number(cell.dataset.tmOriginalLeft);
        return Math.max(max, (Number.isFinite(left) ? left : px(cell.style.left)) + (px(cell.style.width) || 0));
      }, 0);
    parts.forEach((part) => {
      const currentWidth = px(part.style.width);
      let originalWidth = Number(part.dataset.tmOriginalWidth);
      if (!Number.isFinite(originalWidth)) {
        originalWidth = Math.max(originalCellRight, currentWidth);
      } else {
        const expected = originalWidth + previousWidth;
        if (currentWidth && Math.abs(currentWidth - expected) > 1 && Math.abs(currentWidth - originalWidth) > 1) {
          originalWidth = Math.max(originalCellRight, currentWidth);
        }
      }
      part.dataset.tmOriginalWidth = String(originalWidth);
      part.style.width = `${Math.max(originalCellRight, originalWidth) + addedWidth}px`;
    });
    grid.dataset.tmTranscriptWidth = String(addedWidth);
  }

  function findGridAudioUrl(row) {
    if (!row) return '';
    const directCandidates = [];
    Array.from(row.attributes || []).forEach((attr) => directCandidates.push(attr.value));
    row.querySelectorAll('[data-targetfile],[data-audio-url],[data-url],[title]').forEach((node) => {
      directCandidates.push(node.getAttribute('data-targetfile'), node.getAttribute('data-audio-url'), node.getAttribute('data-url'), node.getAttribute('title'));
    });
    const grid = row.closest('.wj-flexgrid, .wj-control');
    const control = getWijmoGridControl(grid);
    if (control) {
      const rowIndex = resolveWijmoRowIndex(control, row);
      const dataItem = rowIndex >= 0 && control.rows && control.rows[rowIndex]
        ? control.rows[rowIndex].dataItem
        : (control.collectionView && control.collectionView.currentItem);
      const columns = Array.from(control.columns || []);
      const audioColumnIndex = columns.findIndex((column) => /语音文件存放的路径|语音文件|音频文件|文件路径/.test(compactText(`${column.header || ''} ${column.name || ''} ${column.binding || ''}`)));
      if (audioColumnIndex >= 0) {
        const column = columns[audioColumnIndex];
        if (dataItem && column.binding) directCandidates.push(readObjectPath(dataItem, column.binding));
        if (rowIndex >= 0 && typeof control.getCellData === 'function') {
          try { directCandidates.push(control.getCellData(rowIndex, audioColumnIndex, false)); } catch (_) {}
        }
      }
      if (dataItem && typeof dataItem === 'object') {
        Object.entries(dataItem).forEach(([name, value]) => {
          if (/语音|音频|audio|voice|file|path/i.test(name) || looksLikeAudioPath(value)) directCandidates.push(value);
        });
      }
    }
    for (const candidate of directCandidates) {
      const url = audioUrlFromGridValue(candidate);
      if (url) return url;
    }
    return '';
  }

  function getWijmoGridControl(grid) {
    if (!grid) return null;
    if (grid.control && grid.control.rows && grid.control.columns) return grid.control;
    try {
      if (window.wijmo && window.wijmo.Control && typeof window.wijmo.Control.getControl === 'function') {
        return window.wijmo.Control.getControl(grid);
      }
    } catch (_) {}
    return null;
  }

  function resolveWijmoRowIndex(control, row) {
    try {
      const rect = row.getBoundingClientRect();
      if (typeof control.hitTest === 'function') {
        const hit = control.hitTest(rect.left + 4, rect.top + Math.max(2, rect.height / 2));
        if (hit && Number.isInteger(hit.row) && hit.row >= 0) return hit.row;
      }
    } catch (_) {}
    const ariaIndex = Number(row.getAttribute('aria-rowindex'));
    if (Number.isInteger(ariaIndex) && ariaIndex > 0) return ariaIndex - 1;
    const selectionRow = Number(control.selection && control.selection.row);
    return Number.isInteger(selectionRow) && selectionRow >= 0 ? selectionRow : -1;
  }

  function readObjectPath(object, path) {
    return String(path || '').split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
  }

  function looksLikeAudioPath(value) {
    return typeof value === 'string' && (/audiostream\.wav/i.test(value) || /\.wav(?:$|[?#])/i.test(value));
  }

  function audioUrlFromGridValue(value) {
    let text = compactText(value);
    if (!text) return '';
    text = text.replace(/^["']|["']$/g, '');
    if (AUDIO_PATH_RE.test(text)) return normalizeAudioUrl(text);
    const targetMatch = text.match(/[?&]targetfile=([^&]+)/i);
    if (targetMatch) {
      try { text = decodeURIComponent(targetMatch[1]); } catch (_) { text = targetMatch[1]; }
    }
    const wavMatch = text.match(/([A-Za-z]:[\\/][^<>"|?*\r\n]+\.wav|[^<>"|?*\s]+\.wav)/i);
    const targetfile = wavMatch ? wavMatch[1] : '';
    if (!targetfile) return '';
    const url = new URL('/spyfile/audiostream.wav', window.location.origin);
    url.searchParams.set('targetfile', targetfile);
    url.searchParams.set('index', '0');
    return url.href;
  }

  function renderGridCellContent(task, context) {
    if (task && ['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status)) {
      return `<button class="tm-grid-action" data-tm-action="open" data-key="${escAttr(task.key)}">加载</button><span class="tm-transcript-text">${esc(task.message || '识别中...')}</span>`;
    }
    if (task && (task.hasLocalCsv || task.status === 'done' || task.status === 'cached')) {
      const text = transcriptSummary(task.segments, 140);
      return `<button class="tm-grid-action" data-tm-action="open" data-key="${escAttr(task.key)}">展开</button><button class="tm-grid-action" data-tm-action="retry" data-key="${escAttr(task.key)}">重新识别</button><span class="tm-transcript-text" title="${escAttr(text)}">${esc(text)}</span>`;
    }
    const waiting = isPendingGridContext(context);
    const label = task && task.manualAttempted ? '重新识别' : (waiting ? '等待中...' : '等待点开音频');
    return `<button class="tm-grid-action" data-tm-action="manual-context" data-context="${escAttr(encodeContext(context))}" ${waiting ? 'disabled' : ''}>${label}</button><span class="tm-transcript-text">${task && task.error ? esc(truncate(task.error, 80)) : ''}</span>`;
  }

  function injectVxAudioButtons() {
    document.querySelectorAll('audio[src]').forEach((audioNode) => {
      const container = closestByClassPrefix(audioNode, 'wechatContent___') || closestByClassPrefix(audioNode, 'audioContainer___');
      if (!container) return;
      const src = normalizeAudioUrl(audioNode.getAttribute('src'));
      if (!src || !AUDIO_PATH_RE.test(src)) return;
      const context = extractAudioContext(audioNode, src);
      const info = parseAudioUrl(src);
      const key = buildRecordKey(context, info);
      const task = state.tasks.get(key);
      let tools = container.querySelector('.tm-vx-tools');
      const target = findOuterAudioContainer(audioNode, container) || audioNode.parentElement || container;
      if (!tools) {
        tools = document.createElement('span');
        tools.className = 'tm-vx-tools tm-vx-tools-right';
      }
      tools.classList.add('tm-vx-tools-right');
      if (tools.parentElement !== target) target.appendChild(tools);
      const busy = task && ['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status);
      const manualLabel = task && (task.hasLocalCsv || task.manualAttempted || task.status === 'done') ? '重新识别' : '手动识别';
      const content = `<button class="tm-vx-action" data-tm-action="manual-url" data-url="${escAttr(src)}">${manualLabel}</button>${task && (task.hasLocalCsv || task.segments.length || busy) ? `<button class="tm-vx-action" data-tm-action="open" data-key="${escAttr(key)}">${busy ? '加载中' : '展开'}</button>` : ''}`;
      if (tools.dataset.tmContent !== content) {
        tools.innerHTML = content;
        tools.dataset.tmContent = content;
      }
    });
  }

  function findOuterAudioContainer(audioNode, boundary) {
    let node = audioNode && audioNode.parentElement;
    let candidate = null;
    while (node && node !== boundary) {
      if (hasClassPrefix(node, 'audioContainer___')) candidate = node;
      node = node.parentElement;
    }
    return candidate;
  }

  function injectGenericAudioButtons() {
    document.querySelectorAll('audio[src]').forEach((audioNode) => {
      if (closestByClassPrefix(audioNode, 'wechatContent___')) return;
      const box = closestByClassPrefix(audioNode, 'audioBox___');
      if (!box) return;
      const src = normalizeAudioUrl(audioNode.getAttribute('src'));
      if (!src || !AUDIO_PATH_RE.test(src)) return;
      const context = extractAudioContext(audioNode, src);
      const info = parseAudioUrl(src);
      const key = buildRecordKey(context, info);
      const task = state.tasks.get(key);
      let tools = box.querySelector('.tm-vx-tools');
      if (!tools) {
        tools = document.createElement('span');
        tools.className = 'tm-vx-tools';
        box.appendChild(tools);
      }
      const busy = task && ['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status);
      const manualLabel = task && (task.hasLocalCsv || task.manualAttempted || task.status === 'done') ? '重新识别' : '手动识别';
      const content = `<button class="tm-vx-action" data-tm-action="manual-url" data-url="${escAttr(src)}">${manualLabel}</button>${task && (task.hasLocalCsv || task.segments.length || busy) ? `<button class="tm-vx-action" data-tm-action="open" data-key="${escAttr(key)}">${busy ? '加载中' : '展开'}</button>` : ''}`;
      if (tools.dataset.tmContent !== content) {
        tools.innerHTML = content;
        tools.dataset.tmContent = content;
      }
    });
  }

  function handleDocumentClick(event) {
    const actionNode = event.target && event.target.closest ? event.target.closest('[data-tm-action]') : null;
    if (!actionNode) return;
    const action = actionNode.getAttribute('data-tm-action');
    event.preventDefault();
    event.stopPropagation();
    if (action === 'open') {
      openTaskModal(actionNode.getAttribute('data-key') || '');
    } else if (action === 'retry') {
      const task = state.tasks.get(actionNode.getAttribute('data-key') || '');
      if (task) enqueueTask(task, true);
    } else if (action === 'manual-context') {
      const context = decodeContext(actionNode.getAttribute('data-context') || '');
      startManualGridRecognition(actionNode, context);
    } else if (action === 'manual-url') {
      const remembered = rememberMaybeAudioUrl(actionNode.getAttribute('data-url') || '', 'manual');
      const info = parseAudioUrl(actionNode.getAttribute('data-url') || '');
      const context = extractAudioContext(actionNode, info.url || '');
      const task = remembered || state.tasks.get(buildRecordKey(context, info));
      if (task) task.manualAttempted = true;
      if (task) enqueueTask(task, Boolean(task.hasLocalCsv));
    }
  }

  function startManualGridRecognition(actionNode, decodedContext) {
    const row = closestGridDataRow(actionNode);
    if (!row) {
      showToast('无法确定等待音频对应的列表行，请重新点击该列表项。', 'error');
      return;
    }
    const context = mergeContext(decodedContext || {}, buildGridRowContext(row));
    context.element = row;
    state.lastGridRowContext = context;
    const existing = findTaskByContext(context);
    if (existing && existing.audio && existing.audio.url) {
      enqueueTask(existing, Boolean(existing.hasLocalCsv || existing.manualAttempted || existing.status === 'done'));
      showToast(`已开始${existing.hasLocalCsv || existing.status === 'done' ? '重新' : ''}识别该条音频。`, 'success');
      return;
    }

    if (state.pendingGridManual) finishPendingGridManual(state.pendingGridManual, false);
    const timeoutMs = 60000;
    const pending = {
      context,
      row,
      startedAt: Date.now(),
      timeoutMs,
      targetfile: '',
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (state.pendingGridManual !== pending) return;
      finishPendingGridManual(pending, false);
      const message = '等待已结束，未捕获到音频。请再次点击“等待点开音频”，然后手动点开对应语音。';
      setPanelNotice('warning', message, 'manual-grid');
      showToast(message, 'warning', 7500);
      scheduleGridScan();
    }, timeoutMs);
    state.pendingGridManual = pending;
    clearPanelNotice('manual-grid');
    showToast('已进入等待状态。请在 60 秒内手动点开该行语音，脚本捕获音频流后会开始识别。', 'warning', 7500);
    scheduleGridScan();
  }

  function isPendingGridContext(context) {
    const pending = state.pendingGridManual;
    return Boolean(pending && pending.context && contextKeyPrefix(pending.context) === contextKeyPrefix(context));
  }

  function findGridCellByHeader(row, headerText) {
    if (!row) return null;
    const grid = row.closest('.wj-flexgrid, .wj-control');
    const headers = grid ? Array.from(grid.querySelectorAll('[wj-part="chcells"] > .wj-row > .wj-cell:not(.tm-transcript-cell)')) : [];
    const visibleHeaders = headers.filter((cell) => !isHiddenGridAccessibilityRow(cell.parentElement, [cell]))
      .sort((a, b) => originalCellLeft(a) - originalCellLeft(b));
    const columnIndex = visibleHeaders.findIndex((cell) => compactText(cell.textContent || '') === headerText);
    const cells = Array.from(row.children).filter((cell) => cell.classList.contains('wj-cell') && !cell.classList.contains('tm-transcript-cell'))
      .sort((a, b) => originalCellLeft(a) - originalCellLeft(b));
    if (columnIndex >= 0 && cells[columnIndex]) return cells[columnIndex];
    if (headerText === '案件名称' && cells[1]) return cells[1];
    return null;
  }

  function originalCellLeft(cell) {
    const stored = Number(cell && cell.dataset && cell.dataset.tmOriginalLeft);
    return Number.isFinite(stored) ? stored : px(cell && cell.style && cell.style.left);
  }

  function selectGridCell(row, cell) {
    const gridElement = row.closest('.wj-flexgrid, .wj-control');
    const control = getWijmoGridControl(gridElement);
    if (!control) return;
    const rowIndex = resolveWijmoRowIndex(control, row);
    const cells = Array.from(row.children).filter((item) => item.classList.contains('wj-cell') && !item.classList.contains('tm-transcript-cell'))
      .sort((a, b) => originalCellLeft(a) - originalCellLeft(b));
    const columnIndex = cells.indexOf(cell);
    try {
      if (typeof control.scrollIntoView === 'function' && rowIndex >= 0 && columnIndex >= 0) control.scrollIntoView(rowIndex, columnIndex);
    } catch (_) {}
    try {
      if (typeof control.select === 'function' && rowIndex >= 0 && columnIndex >= 0) control.select(rowIndex, columnIndex);
      else if (control.selection && rowIndex >= 0) {
        control.selection.row = rowIndex;
        control.selection.col = columnIndex;
      }
    } catch (_) {}
  }

  function dispatchGridCellDoubleClick(cell) {
    const target = cell.querySelector('[class*="ellipsisDiv"], [style*="cursor: pointer"], div') || cell;
    try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
    try { target.focus({ preventScroll: true }); } catch (_) {}
    const emit = (type, detail, EventCtor) => {
      target.dispatchEvent(new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0,
        detail,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }));
    };
    [1, 2].forEach((detail) => {
      const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      emit('pointerdown', detail, PointerCtor);
      emit('mousedown', detail, MouseEvent);
      emit('pointerup', detail, PointerCtor);
      emit('mouseup', detail, MouseEvent);
      emit('click', detail, MouseEvent);
    });
    emit('dblclick', 2, MouseEvent);
  }

  function finishPendingGridManual(pending, captured) {
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (state.pendingGridManual === pending) state.pendingGridManual = null;
    scheduleGridScan();
    if (!captured) return;
    clearPanelNotice('manual-grid');
    showToast('已捕获该行音频并开始识别。', 'success', 4500);
  }

  function openTaskModal(key) {
    const task = state.tasks.get(key);
    if (!task) return;
    state.confirmAction = null;
    state.currentModalKey = key;
    const modal = ensureModal();
    modal.querySelector('.tm-modal-title').textContent = task.title || task.context.title || task.csvFilename;
    const body = modal.querySelector('.tm-modal-body');
    const segments = task.segments && task.segments.length ? task.segments : parseCsvSegments(task.localCsvText);
    const isBusy = ['queued', 'downloading', 'merging', 'transcribing', 'saving'].includes(task.status);
    body.innerHTML = `
      ${task.audioBlobUrl ? `<audio controls src="${escAttr(task.audioBlobUrl)}"></audio>` : ''}
      <div class="tm-help">CSV：${esc(task.csvFilename)}；切片：${esc(task.audioIndexRange || '')}；音频：${esc(task.audioChannelText || '等待本机处理')}</div>
      ${isBusy ? `<div class="tm-loading">${esc(task.message || STATUS_LABELS[task.status] || '处理中')}</div>` : ''}
      <div class="tm-actions" style="margin:8px 0">
        <button type="button" data-tm-action="retry" data-key="${escAttr(task.key)}">重新识别</button>
        <button type="button" data-action="modal-save-as" ${canSaveTaskCsv(task) ? '' : 'disabled'} title="${canSaveTaskCsv(task) ? '选择位置保存中文 CSV；助手不可用时也可使用' : '当前任务还没有可用于另存的 CSV'}">CSV另存</button>
        <button type="button" data-action="modal-open-path" ${task.hasLocalCsv ? '' : 'disabled'} title="${task.hasLocalCsv ? '在资源管理器中选中本机 CSV' : '本机助手尚未确认该 CSV 已落盘'}">打开文件路径</button>
      </div>
      <div class="tm-segments">${segments.length ? segments.map((seg, index) => renderModalSegment(task, seg, index)).join('') : '<div class="tm-help">暂无识别内容</div>'}</div>
      <div class="tm-edit-box" style="display:none"></div>
    `;
    body.querySelector('[data-action="modal-save-as"]')?.addEventListener('click', () => saveTaskCsvAs(task));
    body.querySelector('[data-action="modal-open-path"]')?.addEventListener('click', () => openLocalCsvPath(task));
    body.querySelectorAll('[data-action="edit-segment"]').forEach((button) => {
      button.addEventListener('click', () => showEditBox(task, Number(button.getAttribute('data-index'))));
    });
    modal.classList.add('is-open');
  }

  function closeModal() {
    state.currentModalKey = '';
    state.confirmAction = null;
    if (state.modal) state.modal.classList.remove('is-open');
  }

  function refreshTaskModal(task) {
    if (!task || state.currentModalKey !== task.key || !state.modal || !state.modal.classList.contains('is-open')) return;
    openTaskModal(task.key);
  }

  function renderModalSegment(task, seg, index) {
    const text = seg.corrected_text || seg.text || '';
    return `
      <div class="tm-segment">
        <div class="tm-time">${esc(msRange(seg.begin_ms, seg.end_ms))}</div>
        <div class="tm-speaker">说话人 ${esc(seg.lid || '1')}</div>
        <div class="tm-text">${esc(text)}</div>
        <button class="tm-icon-button" type="button" title="修正" data-action="edit-segment" data-index="${index}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
      </div>
    `;
  }

  function showEditBox(task, index) {
    const seg = task.segments[index];
    if (!seg) return;
    const box = state.modal.querySelector('.tm-edit-box');
    box.style.display = 'flex';
    box.innerHTML = `
      <div class="tm-help">${esc(msRange(seg.begin_ms, seg.end_ms))} 说话人 ${esc(seg.lid || '1')}</div>
      <textarea rows="5">${esc(seg.corrected_text || seg.text || '')}</textarea>
      <div class="tm-actions"><button type="button" data-action="submit-edit">提交</button><button type="button" data-action="cancel-edit">取消</button></div>
    `;
    box.querySelector('[data-action="cancel-edit"]').addEventListener('click', () => { box.style.display = 'none'; });
    box.querySelector('[data-action="submit-edit"]').addEventListener('click', async () => {
      const value = box.querySelector('textarea').value;
      seg.corrected_text = value;
      seg.is_corrected = '1';
      const csvText = buildCsv(task);
      const saveResult = await saveTaskCsv(task, csvText, 'correction_submit');
      if (settings.feedbackHistory) {
        await postJson(`${settings.localHelperUrl}/local/feedback`, {
          output_dir: settings.localOutputDir,
          feedback_history: true,
          record_key: task.key,
          csv_filename: task.csvFilename,
          segment_no: seg.segment_no,
          original_text: seg.text,
          corrected_text: value,
        }, 8000).catch(() => {});
      }
      task.localCsvText = csvText;
      task.hasLocalCsv = saveResult.localSaved;
      box.style.display = 'none';
      openTaskModal(task.key);
      scheduleGridScan();
    });
  }

  function buildCsv(task) {
    const created = new Date(task.createdAt || Date.now()).toISOString();
    const updated = new Date().toISOString();
    const sourceTargetfiles = Array.from(task.sourceTargetfiles || [task.audio.targetfile]).filter(Boolean).join(';');
    const sourceAudioUrls = Array.from(task.sourceAudioUrls || [task.audio.url]).filter(Boolean).join(';');
    const rows = (task.segments || []).map((seg, index) => ({
      record_key: task.key,
      scene: task.context.scene || '',
      title: task.title || task.context.title || '',
      case_name: task.context.caseName || '',
      control_number: task.context.controlNumber || '',
      peer_number: task.context.peerNumber || '',
      duration_seconds: task.context.durationSeconds || '',
      started_at: task.context.startedAt || '',
      targetfile: sourceTargetfiles,
      index_range: task.audioIndexRange || '',
      segment_no: seg.segment_no || index + 1,
      lid: seg.lid || '1',
      begin_ms: Number(seg.begin_ms || 0),
      end_ms: Number(seg.end_ms || 0),
      begin_time: msToTime(Number(seg.begin_ms || 0)),
      end_time: msToTime(Number(seg.end_ms || 0)),
      text: seg.text || '',
      corrected_text: seg.corrected_text || '',
      is_corrected: seg.is_corrected || '',
      source_audio_url: sourceAudioUrls,
      model: settings.model,
      language: task.language || '',
      uuid: task.uuid || '',
      created_at: created,
      updated_at: updated,
    }));
    return toCsv(CSV_COLUMNS, rows);
  }

  function toCsv(columns, rows) {
    const escapeCell = (value) => {
      const text = String(value == null ? '' : value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [columns.map(([, title]) => escapeCell(title)).join(',')]
      .concat(rows.map((row) => columns.map(([field]) => escapeCell(row[field])).join(',')))
      .join('\n');
  }

  function parseCsvSegments(text) {
    const rows = parseCsv(text);
    const speakerLabels = new Map();
    return rows.map((row, index) => ({
      segment_no: Number(row['分段序号'] || index + 1),
      lid: sequentialSpeakerLabel(row['说话人'] || '1', speakerLabels),
      text: row['原始识别文本'] || '',
      corrected_text: row['修正文本'] || '',
      is_corrected: row['是否修正'] || '',
      begin_ms: Number(row['开始时间（毫秒）'] || 0),
      end_ms: Number(row['结束时间（毫秒）'] || 0),
    }));
  }

  function isChineseCsv(text) {
    const header = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/, 1)[0] || '';
    return header.includes('分段序号') && header.includes('原始识别文本') && header.includes('开始时间（毫秒）');
  }

  function isCurrentModelCsv(text) {
    if (!isChineseCsv(text)) return false;
    const rows = parseCsv(text);
    if (!rows.length) return true;
    return rows.every((row) => String(row['识别模型'] || '').trim() === 'Tailect_V4.1');
  }

  function parseCsv(text) {
    const source = String(text || '').replace(/^\ufeff/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch !== '\r') {
        cell += ch;
      }
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    const header = rows.shift() || [];
    return rows.filter((item) => item.some((value) => String(value).trim())).map((item) => {
      const out = {};
      header.forEach((field, index) => { out[field] = item[index] || ''; });
      return out;
    });
  }

  function mergeWavBuffers(buffers, maxMinutes) {
    const parsed = buffers.map(parseWav).filter(Boolean);
    if (parsed.length !== buffers.length) {
      throw new Error('音频切片不是受支持的 PCM WAV，无法在本机合并声道');
    }
    const first = parsed[0];
    const same = parsed.every((item) => item.audioFormat === first.audioFormat && item.channels === first.channels && item.sampleRate === first.sampleRate && item.bitsPerSample === first.bitsPerSample);
    if (!same) {
      throw new Error('音频切片格式不一致，无法安全拼接和合并声道');
    }
    const totalBytes = parsed.reduce((sum, item) => sum + item.data.byteLength, 0);
    const pcm = new Uint8Array(totalBytes);
    let pos = 0;
    parsed.forEach((item) => {
      pcm.set(new Uint8Array(item.data), pos);
      pos += item.data.byteLength;
    });
    const mono = downmixPcmToMono(first, pcm.buffer);
    const fullBuffer = makeWav(mono.fmt, mono.data);
    const maxBytesRaw = mono.fmt.byteRate * Math.max(1, Number(maxMinutes || 10)) * 60;
    const maxBytes = Math.max(mono.fmt.blockAlign, Math.floor(maxBytesRaw / mono.fmt.blockAlign) * mono.fmt.blockAlign);
    const parts = [];
    let offsetBytes = 0;
    const monoBytes = new Uint8Array(mono.data);
    while (offsetBytes < monoBytes.byteLength) {
      const end = Math.min(monoBytes.byteLength, offsetBytes + maxBytes);
      const alignedEnd = end < monoBytes.byteLength ? Math.max(offsetBytes + mono.fmt.blockAlign, Math.floor(end / mono.fmt.blockAlign) * mono.fmt.blockAlign) : end;
      const data = monoBytes.slice(offsetBytes, alignedEnd);
      parts.push({
        buffer: makeWav(mono.fmt, data.buffer),
        offsetMs: Math.round((offsetBytes / mono.fmt.byteRate) * 1000),
      });
      offsetBytes = alignedEnd;
    }
    return { fullBuffer, parts, sourceChannels: first.channels, outputChannels: mono.fmt.channels };
  }

  function downmixPcmToMono(fmt, dataBuffer) {
    if (fmt.channels <= 1) return { fmt: { ...fmt }, data: dataBuffer.slice(0) };
    const bytesPerSample = fmt.bitsPerSample / 8;
    const supported = (
      (fmt.audioFormat === 1 && [1, 2, 3, 4].includes(bytesPerSample)) ||
      (fmt.audioFormat === 3 && bytesPerSample === 4)
    );
    if (!supported || fmt.blockAlign < bytesPerSample * fmt.channels) {
      throw new Error(`不支持的 WAV 采样格式：format=${fmt.audioFormat}, bits=${fmt.bitsPerSample}, channels=${fmt.channels}`);
    }

    const source = new DataView(dataBuffer);
    const frameCount = Math.floor(dataBuffer.byteLength / fmt.blockAlign);
    let peak = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mixed = 0;
      const frameOffset = frame * fmt.blockAlign;
      for (let channel = 0; channel < fmt.channels; channel += 1) {
        mixed += readPcmSample(source, frameOffset + channel * bytesPerSample, fmt.audioFormat, fmt.bitsPerSample);
      }
      peak = Math.max(peak, Math.abs(mixed));
    }

    const gain = peak > 0.95 ? 0.95 / peak : 1;
    const output = new ArrayBuffer(frameCount * bytesPerSample);
    const target = new DataView(output);
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mixed = 0;
      const frameOffset = frame * fmt.blockAlign;
      for (let channel = 0; channel < fmt.channels; channel += 1) {
        mixed += readPcmSample(source, frameOffset + channel * bytesPerSample, fmt.audioFormat, fmt.bitsPerSample);
      }
      writePcmSample(target, frame * bytesPerSample, mixed * gain, fmt.audioFormat, fmt.bitsPerSample);
    }

    const monoFmt = {
      ...fmt,
      channels: 1,
      blockAlign: bytesPerSample,
      byteRate: fmt.sampleRate * bytesPerSample,
    };
    return { fmt: monoFmt, data: output };
  }

  function readPcmSample(view, offset, audioFormat, bitsPerSample) {
    if (audioFormat === 3 && bitsPerSample === 32) return view.getFloat32(offset, true);
    if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
    if (bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
    if (bitsPerSample === 24) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    if (bitsPerSample === 32) return view.getInt32(offset, true) / 2147483648;
    throw new Error(`不支持的 PCM 位深：${bitsPerSample}`);
  }

  function writePcmSample(view, offset, sample, audioFormat, bitsPerSample) {
    const value = Math.max(-1, Math.min(0.999999, Number.isFinite(sample) ? sample : 0));
    if (audioFormat === 3 && bitsPerSample === 32) {
      view.setFloat32(offset, value, true);
      return;
    }
    if (bitsPerSample === 8) {
      view.setUint8(offset, Math.max(0, Math.min(255, Math.round(value * 128 + 128))));
      return;
    }
    const positiveScale = bitsPerSample === 16 ? 32767 : (bitsPerSample === 24 ? 8388607 : 2147483647);
    const negativeScale = bitsPerSample === 16 ? 32768 : (bitsPerSample === 24 ? 8388608 : 2147483648);
    const integer = Math.round(value * (value < 0 ? negativeScale : positiveScale));
    if (bitsPerSample === 16) {
      view.setInt16(offset, integer, true);
    } else if (bitsPerSample === 24) {
      view.setUint8(offset, integer & 0xff);
      view.setUint8(offset + 1, (integer >> 8) & 0xff);
      view.setUint8(offset + 2, (integer >> 16) & 0xff);
    } else if (bitsPerSample === 32) {
      view.setInt32(offset, integer, true);
    } else {
      throw new Error(`不支持的 PCM 位深：${bitsPerSample}`);
    }
  }

  function parseWav(buffer) {
    const view = new DataView(buffer);
    if (text4(view, 0) !== 'RIFF' || text4(view, 8) !== 'WAVE') return null;
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= buffer.byteLength) {
      const id = text4(view, offset);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (id === 'fmt ') {
        fmt = {
          audioFormat: view.getUint16(start, true),
          channels: view.getUint16(start + 2, true),
          sampleRate: view.getUint32(start + 4, true),
          byteRate: view.getUint32(start + 8, true),
          blockAlign: view.getUint16(start + 12, true),
          bitsPerSample: view.getUint16(start + 14, true),
        };
      } else if (id === 'data') {
        data = buffer.slice(start, start + size);
      }
      offset = start + size + (size % 2);
    }
    const supported = fmt && (
      (fmt.audioFormat === 1 && [8, 16, 24, 32].includes(fmt.bitsPerSample)) ||
      (fmt.audioFormat === 3 && fmt.bitsPerSample === 32)
    );
    if (!supported || !data) return null;
    return { ...fmt, data };
  }

  function makeWav(fmt, dataBuffer) {
    const dataSize = dataBuffer.byteLength;
    const out = new ArrayBuffer(44 + dataSize);
    const view = new DataView(out);
    writeText(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeText(view, 8, 'WAVE');
    writeText(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, fmt.audioFormat, true);
    view.setUint16(22, fmt.channels, true);
    view.setUint32(24, fmt.sampleRate, true);
    view.setUint32(28, fmt.byteRate, true);
    view.setUint16(32, fmt.blockAlign, true);
    view.setUint16(34, fmt.bitsPerSample, true);
    writeText(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    new Uint8Array(out, 44).set(new Uint8Array(dataBuffer));
    return out;
  }

  function text4(view, offset) {
    return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  }

  function writeText(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function extractAudioContext(contextNode, url) {
    const element = isElementNode(contextNode) ? contextNode : findAudioElementByUrl(url);
    const audio = parseAudioUrl(url);
    const fallbackTitle = audio.filename || '音频';
    if (!element) {
      const grid = findActiveGridRowContext();
      if (grid) return grid;
      return genericContext(fallbackTitle, url, null);
    }
    const vx = closestByClassPrefix(element, 'wechatContent___');
    if (vx) {
      const user = compactText(textFromClass(vx, 'userName___')) || '未知联系人';
      const time = compactText(textFromClass(vx, 'time___')) || '';
      const durationText = compactText(textFromClass(vx, 'duration___')) || '';
      const seconds = parseDurationSeconds(durationText);
      const direction = hasClassPrefix(vx, 'isUser___') ? '发送' : '接收';
      const title = compactText(['VX', user, time, durationText].filter(Boolean).join('+'));
      return {
        scene: 'vx',
        sceneLabel: 'VX',
        kind: 'VX',
        title: title || fallbackTitle,
        user,
        direction,
        startedAt: time,
        durationText,
        durationSeconds: seconds,
        element: vx,
      };
    }
    const audioBox = closestByClassPrefix(element, 'audioBox___');
    if (audioBox) {
      const grid = findActiveGridRowContext();
      if (grid) return grid;
      const titleText = compactText(textFromClass(audioBox, 'title___')) || fallbackTitle;
      return genericContext(titleText, url, audioBox);
    }
    const genericContainer = element.closest('li, section, article, [class*="Content"], [class*="content"]') || element.parentElement;
    return genericContext(compactText(genericContainer && genericContainer.innerText) || fallbackTitle, url, genericContainer || element);
  }

  function genericContext(title, url, element) {
    return {
      scene: 'generic',
      sceneLabel: '音频',
      kind: '音频',
      title: truncateMiddle(title, 80),
      durationSeconds: 0,
      startedAt: '',
      caseName: '',
      controlNumber: '',
      peerNumber: '',
      element,
      url,
    };
  }

  function findActiveGridRowContext() {
    const recent = state.lastGridRowContext;
    if (recent && recent.element && document.documentElement.contains(recent.element) && Date.now() - recent.updatedAt < 10 * 60 * 1000) return recent;
    const selected = findSelectedGridRow();
    return selected ? buildGridRowContext(selected) : null;
  }

  function findSelectedGridRow() {
    const rows = document.querySelectorAll ? document.querySelectorAll('.wj-row[role="row"][aria-selected="true"], .wj-row[aria-selected="true"]') : [];
    for (const row of rows) {
      if (isGridDataRow(row)) return row;
    }
    return null;
  }

  function closestGridDataRow(node) {
    let element = isElementNode(node) ? node : null;
    for (let i = 0; element && i < 10; i += 1, element = element.parentElement) {
      if (hasClassName(element, 'wj-row') && isGridDataRow(element)) return element;
    }
    return null;
  }

  function isGridDataRow(row) {
    return isElementNode(row) && !!row.querySelector('.wj-cell[role="gridcell"], [role="gridcell"]');
  }

  function buildGridRowContext(row) {
    const fields = getGridRowFieldMap(row);
    const cells = getGridRowTexts(row);
    const rowNumber = pickGridField(fields, ['序号']) || cells[0] || '';
    const caseName = pickGridField(fields, ['案件名称', '案件名']) || cells[1] || '未知案件';
    const controlNumber = normalizePhoneField(pickGridField(fields, ['侦控号码', '在控号码', '己方号码']) || cells[3]) || '未知侦控号码';
    const peerNumber = normalizePhoneField(pickGridField(fields, ['对方号码', '对端号码', '另一方号码']) || cells[4]) || '未知对方号码';
    const direction = pickGridField(fields, ['主被叫', '呼叫方向']) || '';
    const duration = pickGridField(fields, ['预估时长(秒)', '预估时长（秒）', '预估时长', '通话时长(秒)', '通话时长']) || cells[6] || '';
    const startedAtCandidate = pickGridField(fields, ['通话开始时间', '开始时间', '通话时间']) || cells[7] || '';
    const parsedDuration = parseDurationSeconds(duration);
    const durationSeconds = parsedDuration > 0 && parsedDuration <= 24 * 60 * 60 ? parsedDuration : 0;
    const durationText = durationSeconds ? `${durationSeconds}秒` : '未知时长';
    const startedAt = looksLikeDateTime(startedAtCandidate) ? startedAtCandidate : '未知开始时间';
    const context = {
      scene: 'normal',
      sceneLabel: '列表',
      kind: '列表项',
      title: '',
      rowNumber,
      caseName,
      controlNumber,
      peerNumber,
      direction,
      durationText,
      durationSeconds,
      startedAt,
      element: row,
      updatedAt: Date.now(),
    };
    context.title = buildTaskTitle(context, { index: 0 });
    context.recordKey = contextKeyPrefix(context);
    return context;
  }

  function getGridRowTexts(row) {
    const cells = row.querySelectorAll ? row.querySelectorAll('.wj-cell[role="gridcell"], [role="gridcell"]') : [];
    return Array.from(cells)
      .filter((cell) => !cell.classList.contains('tm-transcript-cell'))
      .sort((a, b) => originalCellLeft(a) - originalCellLeft(b))
      .map((cell) => cleanGridCellText(cell.innerText || cell.textContent || ''));
  }

  function getGridRowFieldMap(row) {
    const out = new Map();
    const setValue = (header, value) => {
      const key = normalizeGridHeader(header);
      const text = cleanGridCellText(value);
      if (key && text && !out.has(key)) out.set(key, text);
    };
    const grid = row && row.closest ? row.closest('.wj-flexgrid, .wj-control') : null;
    const control = getWijmoGridControl(grid);
    if (control) {
      const rowIndex = resolveWijmoRowIndex(control, row);
      const dataItem = rowIndex >= 0 && control.rows && control.rows[rowIndex]
        ? control.rows[rowIndex].dataItem
        : (control.collectionView && control.collectionView.currentItem);
      const columns = Array.from(control.columns || []);
      columns.forEach((column, columnIndex) => {
        const header = compactText(`${column.header || column.name || column.binding || ''}`);
        let value;
        if (dataItem && column.binding) value = readObjectPath(dataItem, column.binding);
        if ((value == null || value === '') && rowIndex >= 0 && typeof control.getCellData === 'function') {
          try { value = control.getCellData(rowIndex, columnIndex, false); } catch (_) {}
        }
        setValue(header, value);
      });
      if (dataItem && typeof dataItem === 'object') {
        Object.entries(dataItem).forEach(([name, value]) => setValue(name, value));
      }
    }

    if (grid) {
      const headers = Array.from(grid.querySelectorAll('[wj-part="chcells"] > .wj-row > .wj-cell:not(.tm-transcript-cell)'))
        .filter((cell) => !isHiddenGridAccessibilityRow(cell.parentElement, [cell]));
      const cells = Array.from(row.children || []).filter((cell) => cell.classList.contains('wj-cell') && !cell.classList.contains('tm-transcript-cell'));
      headers.forEach((headerCell) => {
        const left = originalCellLeft(headerCell);
        let match = null;
        let distance = Number.POSITIVE_INFINITY;
        cells.forEach((cell) => {
          const nextDistance = Math.abs(originalCellLeft(cell) - left);
          if (nextDistance < distance) {
            match = cell;
            distance = nextDistance;
          }
        });
        if (match && distance <= 2) setValue(headerCell.textContent || '', match.innerText || match.textContent || '');
      });
    }
    return out;
  }

  function normalizeGridHeader(value) {
    return compactText(value).replace(/\s+/g, '').replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')')).toLowerCase();
  }

  function pickGridField(fields, aliases) {
    for (const alias of aliases || []) {
      const value = fields.get(normalizeGridHeader(alias));
      if (value) return value;
    }
    return '';
  }

  function normalizePhoneField(value) {
    const text = cleanGridCellText(value);
    if (!text || /^(主叫|被叫|未知|无)$/.test(text)) return '';
    const match = text.match(/(?:\+|00)?\d[\d*#xX-]{4,}/);
    return match ? match[0] : text;
  }

  function looksLikeDateTime(value) {
    return /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+|T)\d{1,2}:\d{2}(?::\d{2})?\b/.test(String(value || ''));
  }

  function cleanGridCellText(value) {
    return compactText(String(value || '').replace(/\b(zho|eng|yue|cmn)\b/gi, '').replace(/翻/g, ''));
  }

  function parseAudioUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      const targetfile = parsed.searchParams.get('targetfile') || '';
      const index = Number(parsed.searchParams.get('index') || '0') || 0;
      const name = (targetfile.split(/[\\/]/).pop() || 'audio.wav').replace(/[?#].*$/, '');
      return { url: parsed.href, origin: parsed.origin, path: parsed.pathname, targetfile, index, filename: /\.wav$/i.test(name) ? name : `${name}.wav` };
    } catch (_) {
      return { url, origin: '', path: '', targetfile: '', index: 0, filename: 'audio.wav' };
    }
  }

  function buildRecordKey(context, audio) {
    const prefix = contextKeyPrefix(context);
    if (context && (context.scene === 'normal' || context.scene === 'vx')) return `${prefix}|index=0`;
    return `${prefix}|${audio.targetfile || audio.filename || audio.url}`;
  }

  function contextKeyPrefix(context) {
    if (!context) return 'generic:unknown';
    if (context.scene === 'normal') return ['normal', context.caseName, context.controlNumber, context.peerNumber, context.startedAt, context.durationSeconds || context.durationText].map(stablePart).join(':');
    if (context.scene === 'vx') return ['vx', context.user, context.startedAt, context.durationSeconds || context.durationText, context.direction || 'unknown'].map(stablePart).join(':');
    return ['generic', context.title || 'audio'].map(stablePart).join(':');
  }

  function findTaskByContext(context) {
    if (!context) return null;
    const prefix = contextKeyPrefix(context);
    for (const task of state.tasks.values()) {
      if (task.key.startsWith(prefix)) return task;
    }
    return null;
  }

  function buildCsvFilename(context, audio) {
    return `${sanitizeFilename(buildTaskTitle(context, audio))}.csv`;
  }

  function buildTaskTitle(context, audio) {
    if (context && context.scene === 'normal') {
      const seconds = Number(context.durationSeconds || 0);
      const duration = seconds ? `${seconds}秒` : (context.durationText || '未知时长');
      return compactText([
        context.caseName || '未知案件',
        context.controlNumber || '未知侦控号码',
        context.peerNumber || '未知对方号码',
        context.startedAt || '未知开始时间',
        duration,
        'index=0',
      ].join('+'));
    }
    if (context && context.scene === 'vx') {
      const seconds = Number(context.durationSeconds || 0);
      const duration = seconds ? `${seconds}秒` : (context.durationText || '未知时长');
      return compactText([
        'VX',
        context.user || '未知联系人',
        context.direction || '未知方向',
        context.startedAt || '未知时间',
        duration,
        'index=0',
      ].join('+'));
    }
    return compactText(['Audio', (context && context.title) || '音频', (audio && (audio.targetfile || audio.filename)) || '未知音频'].join('+'));
  }

  function audioUrlForIndex(url, index) {
    const parsed = new URL(url, window.location.href);
    parsed.searchParams.set('index', String(index));
    return parsed.href;
  }

  function parseDurationSeconds(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const mmss = text.match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})/);
    if (mmss) return (Number(mmss[1] || 0) * 3600) + (Number(mmss[2] || 0) * 60) + Number(mmss[3] || 0);
    const number = Number((text.match(/\d+(?:\.\d+)?/) || ['0'])[0]);
    return Number.isFinite(number) ? Math.round(number) : 0;
  }

  function sequentialSpeakerLabel(value, labels) {
    const raw = String(value == null || value === '' ? '1' : value).trim() || '1';
    if (!labels.has(raw)) labels.set(raw, String(labels.size + 1));
    return labels.get(raw);
  }

  function transcriptSummary(segments, limit) {
    const text = (segments || []).map((seg) => `[${msRange(seg.begin_ms, seg.end_ms)}] ${seg.corrected_text || seg.text || ''}`).join('；');
    return truncate(text, limit || 140);
  }

  function currentTask() {
    if (state.latestKey && state.tasks.has(state.latestKey)) return state.tasks.get(state.latestKey);
    for (const key of state.order) {
      if (state.tasks.has(key)) return state.tasks.get(key);
    }
    return null;
  }

  function indexRangeText(indexes) {
    const sorted = Array.from(new Set(indexes)).sort((a, b) => a - b);
    if (!sorted.length) return '';
    return sorted.length === 1 ? String(sorted[0]) : `${sorted[0]}-${sorted[sorted.length - 1]}`;
  }

  function msToTime(ms) {
    const total = Math.max(0, Number(ms) || 0);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const milli = Math.floor(total % 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  }

  function msRange(start, end) {
    return `${msToTime(start)}-${msToTime(end)}`;
  }

  function stripCsvExt(name) {
    return String(name || 'audio').replace(/\.csv$/i, '');
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

  function normalizeBaseUrl(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function serviceEndpointLabel(value) {
    try {
      const parsed = new URL(String(value || ''));
      return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`;
    } catch (_) {
      return String(value || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    }
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
          timeout: options.timeout || settings.requestTimeoutMs,
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
    const timer = setTimeout(() => controller.abort(), options.timeout || settings.requestTimeoutMs);
    state.suppressNetworkCapture += 1;
    try {
      const response = await fetch(options.url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.data,
        credentials: 'include',
        signal: controller.signal,
      });
      if (options.responseType === 'arraybuffer') {
        return { status: response.status, response: await response.arrayBuffer(), responseText: '' };
      }
      const responseText = await response.text();
      return { status: response.status, response: responseText, responseText };
    } finally {
      state.suppressNetworkCapture = Math.max(0, state.suppressNetworkCapture - 1);
      clearTimeout(timer);
    }
  }

  async function getJson(url, timeout, includeApiKey) {
    const headers = { Accept: 'application/json' };
    if (includeApiKey && settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    const response = await httpRequest({ method: 'GET', url, responseType: 'text', headers, timeout: timeout || settings.requestTimeoutMs });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(response.responseText || response.response || '{}');
  }

  async function postJson(url, body, timeout, includeApiKey) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (includeApiKey && settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    const response = await httpRequest({ method: 'POST', url, data: JSON.stringify(body || {}), responseType: 'text', headers, timeout: timeout || settings.requestTimeoutMs });
    const text = response.responseText || response.response || '';
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}: ${truncate(text, 180)}`);
    const payload = JSON.parse(text || '{}');
    if (payload.code && payload.code !== 200) throw new Error(payload.message || `code=${payload.code}`);
    return payload;
  }

  async function sha256Text(text) {
    if (crypto && crypto.subtle) {
      const bytes = new TextEncoder().encode(String(text || ''));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return `sha256:${Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
    return '';
  }

  function closestByClassPrefix(element, prefix) {
    let node = element;
    for (let i = 0; node && i < 12; i += 1, node = node.parentElement) {
      if (hasClassPrefix(node, prefix)) return node;
    }
    return null;
  }

  function queryByClassPrefix(root, prefix) {
    if (!root || !root.querySelectorAll) return null;
    const nodes = root.querySelectorAll('[class]');
    for (const node of nodes) {
      if (hasClassPrefix(node, prefix)) return node;
    }
    return null;
  }

  function textFromClass(root, prefix) {
    const node = queryByClassPrefix(root, prefix);
    return node ? node.innerText || node.textContent || '' : '';
  }

  function hasClassPrefix(node, prefix) {
    if (!node || !node.classList) return false;
    return Array.from(node.classList).some((name) => name.indexOf(prefix) === 0);
  }

  function hasClassName(node, name) {
    return !!(node && node.classList && node.classList.contains(name));
  }

  function isElementNode(node) {
    return !!(node && node.nodeType === 1);
  }

  function findAudioElementByUrl(url) {
    const key = normalizeAudioUrl(url);
    const nodes = document.querySelectorAll ? document.querySelectorAll('audio[src], source[src]') : [];
    for (const node of nodes) {
      if (normalizeAudioUrl(node.getAttribute('src')) === key) return node;
    }
    return null;
  }

  function encodeContext(context) {
    try {
      const copy = { ...(context || {}) };
      delete copy.element;
      delete copy.updatedAt;
      return btoa(unescape(encodeURIComponent(JSON.stringify(copy))));
    } catch (_) {
      return '';
    }
  }

  function decodeContext(value) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(value))));
    } catch (_) {
      return {};
    }
  }

  function stablePart(value) {
    return String(value || '').replace(/\s+/g, '').slice(0, 80);
  }

  function sanitizeFilename(name) {
    const clean = String(name || 'audio').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'audio';
    if (clean.length <= 180) return clean;
    const suffix = clean.endsWith('+index=0') ? '+index=0' : '';
    const hash = shortTextHash(clean);
    return `${clean.slice(0, Math.max(20, 180 - suffix.length - hash.length - 1))}_${hash}${suffix}`;
  }

  function shortTextHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function uniqueValues(values) {
    return Array.from(new Set(values));
  }

  function px(value) {
    const n = Number(String(value || '').replace('px', ''));
    return Number.isFinite(n) ? n : 0;
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
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

  function trimSet(set, maxSize) {
    if (!set || set.size <= maxSize) return;
    const removeCount = set.size - maxSize;
    let removed = 0;
    for (const value of set) {
      set.delete(value);
      removed += 1;
      if (removed >= removeCount) break;
    }
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
    if (!settings.debug || typeof console === 'undefined' || !console.log) return;
    const args = Array.from(arguments);
    args.unshift('[tailect-translator]');
    console.log.apply(console, args);
  }
})();
