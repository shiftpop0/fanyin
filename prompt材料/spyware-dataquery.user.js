// ==UserScript==
// @name         分中心数据查询菜单增强
// @namespace    mailto:sonneay@gmail.com
// @version      0.3.11
// @description  在 spyware 页面右键菜单中直接注入分中心/公安网查询项，使用右键上下文值直接查询并展示结构化结果。
// @match        http://spyware.zj.jz/*
// @match        http://www.ses.st.zj.jz/*
// @match        https://spyware.zj.jz/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @updateURL    http://12.33.113.78/userscripts/spyware-dataquery.user.js
// @downloadURL  http://12.33.113.78/userscripts/spyware-dataquery.user.js
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const OPS_URL = 'http://spyware.zj.jz/spyware/api/base/operations/data';
  const MENU_ENDPOINT = '/api/public/plugin/menu-items';
  const API_BASE_CANDIDATES = ['http://12.33.113.78/', window.location.origin];
  const MODAL_ID = 'tm-dataquery-modal';
  const MENU_MARKER = 'data-dataquery-menu';
  const MENU_TTL_MS = 2 * 60 * 1000;
  const DEBUG = true;
  const GA_TYPE_ORDER = ['djxx', 'shxx', 'bjxx', 'gjxx', 'ajxx', 'qtxx', 'bszy', 'clxx', 'swtz'];
  const GA_TYPE_NAMES = {
    djxx: '登记信息',
    shxx: '社会信息',
    bjxx: '背景信息',
    gjxx: '轨迹信息',
    ajxx: '案件信息',
    qtxx: '其他信息',
    bszy: '部省资源',
    clxx: '车辆信息',
    swtz: '生物特征',
  };

  const state = {
    apiBase: '',
    menuItems: [],
    loadedAt: 0,
    loadingMenu: null,
    lastContextValue: '',
    modal: {
      open: false,
      title: '',
      loading: false,
      error: '',
      kind: '',
      rows: [],
      columns: [],
      imageUrl: '',
      data: null,
      meta: null,
      choices: [],
      layout: 'default',
      progressText: '',
      secondary: { open: false, value: '', groups: [] },
    },
  };

  let modalEls = null;
  let lastMenuActivationAt = 0;

  function debugLog() {
    if (!DEBUG || typeof console === 'undefined' || !console.log) return;
    const args = Array.from(arguments);
    args.unshift('[dataquery]');
    console.log.apply(console, args);
  }
  let menuScanRounds = 0;
  let menuScanTimer = 0;

  hookNetwork();
  document.addEventListener('contextmenu', (event) => {
    state.lastContextValue = pickContextValue(event.target);
    ensureMenuItemsLoaded();
    scheduleMenuScan(12);
  }, true);
  onReady(() => {
    addStyle();
    ensureModal();
    observeMenus();
    ensureMenuItemsLoaded();
    scheduleMenuScan(4);
  });

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      const fn = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : (typeof GM !== 'undefined' && GM ? GM.xmlHttpRequest : null);
      if (!fn) {
        reject(new Error('当前环境不支持 GM_xmlhttpRequest'));
        return;
      }
      fn({
        timeout: 45000,
        responseType: 'text',
        ...options,
        onload: resolve,
        onerror: () => reject(new Error('请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function hookNetwork() {
    try {
      const rawFetch = window.fetch;
      if (typeof rawFetch === 'function') {
        window.fetch = function (...args) {
          markOps(args[0]);
          return rawFetch.apply(this, args);
        };
      }
    } catch (_) {}
    try {
      const rawOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        markOps(url);
        return rawOpen.call(this, method, url, ...rest);
      };
    } catch (_) {}
  }

  function runMenuAction(handler, event) {
    const now = Date.now();
    if (now - lastMenuActivationAt < 320) return;
    lastMenuActivationAt = now;
    if (event) {
      try { event.preventDefault(); } catch (_) {}
      try { event.stopPropagation(); } catch (_) {}
      try { if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation(); } catch (_) {}
    }
    Promise.resolve()
      .then(() => handler && handler(event))
      .catch((error) => {
        showError('分中心数据查询', error && error.message ? error.message : String(error));
      });
  }

  function bindMenuAction(node, handler, options) {
    if (!(node instanceof HTMLElement) || typeof handler !== 'function') return;
    const settings = options || {};
    const activate = (event) => {
      if (settings.ignoreModified !== false && event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
      runMenuAction(handler, event);
    };
    node.addEventListener('pointerdown', activate, true);
    node.addEventListener('mousedown', activate, true);
    node.addEventListener('click', activate, true);
    node.addEventListener('keydown', (event) => {
      const key = String(event && event.key || '').toLowerCase();
      if (key === 'enter' || key === ' ') activate(event);
    }, true);
  }

  function markOps(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (String(url).indexOf(OPS_URL) === 0) {
      ensureMenuItemsLoaded();
      scheduleMenuScan(12);
    }
  }

  function pickContextValue(target) {
    const selected = extractContextQueryValue(window.getSelection ? window.getSelection() : '');
    if (selected) return selected;
    let node = target instanceof HTMLElement ? target : null;
    for (let i = 0; node && i < 8; i += 1, node = node.parentElement) {
      const candidates = [
        node.getAttribute && node.getAttribute('data-value'),
        node.getAttribute && node.getAttribute('title'),
        node.getAttribute && node.getAttribute('value'),
        node.innerText,
        node.textContent,
      ];
      for (const raw of candidates) {
        const value = extractContextQueryValue(raw);
        if (value) return value;
      }
    }
    return '';
  }

  function normalizeWideText(value) {
    return String(value || '')
      .replace(/\u3000/g, ' ')
      .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 65248));
  }

  function normalizeExtractedToken(token) {
    const text = normalizeWideText(token).trim();
    if (!text) return '';
    const compactDigits = text.replace(/[\s-]+/g, '');
    if (isPhoneNumber(compactDigits)) return compactDigits;
    if (isIdCardNumber(compactDigits)) return compactDigits.toUpperCase();
    const compactPlate = text.replace(/[\s·•・\-_.]+/g, '').toUpperCase();
    if (isPlateNumber(compactPlate)) return compactPlate;
    return '';
  }

  function extractContextQueryValue(raw) {
    const text = normalizeWideText(raw).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const patterns = [
      /\d(?:[\s-]*\d){16}[\s-]*[0-9Xx]/g,
      /1(?:[\s-]*\d){10}/g,
      /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领港澳][\s·•・\-_.]*[A-Z][\s·•・\-_.]*[A-HJ-NP-Z0-9]{5,6}/gi,
    ];
    for (const pattern of patterns) {
      const matched = text.match(pattern);
      if (!matched || !matched.length) continue;
      for (const candidate of matched) {
        const normalized = normalizeExtractedToken(candidate);
        if (normalized) return normalized;
      }
    }
    return '';
  }

  async function ensureMenuItemsLoaded(force) {
    const fresh = state.menuItems.length > 0 && (Date.now() - state.loadedAt) < MENU_TTL_MS;
    if (!force && fresh) return state.menuItems;
    if (!force && state.loadingMenu) return state.loadingMenu;
    state.loadingMenu = (async () => {
      const tried = [];
      for (const candidate of uniqueBases()) {
        const base = normalizeBase(candidate);
        if (!base) continue;
        const url = joinUrl(base, MENU_ENDPOINT);
        try {
          const resp = await gmRequest({ method: 'GET', url, headers: { Accept: 'application/json' } });
          if (resp.status < 200 || resp.status >= 300) {
            tried.push(`${base} -> HTTP ${resp.status}`);
            continue;
          }
          const data = JSON.parse(resp.responseText || '[]');
          if (!Array.isArray(data)) {
            tried.push(`${base} -> 非法 JSON`);
            continue;
          }
          state.apiBase = base;
          state.menuItems = data;
          state.loadedAt = Date.now();
          scheduleMenuScan(6);
          return state.menuItems;
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          tried.push(`${base} -> ${message}`);
        }
      }
      state.menuItems = [];
      throw new Error(`菜单加载失败：${tried.join('；') || '无可用服务地址'}`);
    })().finally(() => {
      state.loadingMenu = null;
    });
    return state.loadingMenu;
  }

  function uniqueBases() {
    const out = [];
    const activeBase = normalizeBase(state.apiBase);
    if (activeBase && !out.includes(activeBase)) out.push(activeBase);
    API_BASE_CANDIDATES.forEach((item) => {
      const base = normalizeBase(item);
      if (base && !out.includes(base)) out.push(base);
    });
    return out;
  }

  function normalizeBase(base) {
    return String(base || '').trim().replace(/\/$/, '');
  }

  function addStyle() {
    const css = `
#${MODAL_ID}{position:fixed;inset:0;display:none;z-index:2147483646;font-family:"Microsoft YaHei",sans-serif;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
#${MODAL_ID}.open{display:flex}
#${MODAL_ID} .dq-mask{position:absolute;inset:0;background:rgba(15,23,42,.45)}
#${MODAL_ID} .dq-dialog{position:relative;z-index:1;width:min(1180px,calc(100vw - 32px));max-width:100%;max-height:calc(100vh - 32px);margin:0 auto;overflow:hidden;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.25);display:flex;flex-direction:column}
#${MODAL_ID} .dq-head{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:linear-gradient(135deg,#0f766e,#155e75);color:#fff}
#${MODAL_ID} .dq-body{padding:16px 20px;overflow:auto;background:#f8fafc}
#${MODAL_ID} .dq-close{border:0;background:rgba(255,255,255,.16);color:#fff;width:36px;height:36px;border-radius:10px;cursor:pointer;font-size:20px}
#${MODAL_ID} .dq-status{display:none;margin-bottom:14px;padding:10px 12px;border-radius:10px;font-size:13px}
#${MODAL_ID} .dq-status.show{display:block}
#${MODAL_ID} .dq-status.info{background:#eff6ff;color:#1d4ed8}
#${MODAL_ID} .dq-status.error{background:#fef2f2;color:#b91c1c}
#${MODAL_ID} .dq-context{margin-bottom:14px;padding:10px 12px;border:1px solid #dbeafe;background:#fff;border-radius:10px;font-size:13px;color:#334155}
#${MODAL_ID} .dq-empty{padding:32px 16px;text-align:center;color:#64748b;background:#fff;border:1px solid #e2e8f0;border-radius:12px}
#${MODAL_ID} .dq-table-wrap{border:1px solid #e2e8f0;border-radius:12px;overflow:auto;max-height:60vh;background:#fff}
#${MODAL_ID} table{width:100%;border-collapse:collapse}
#${MODAL_ID} th,#${MODAL_ID} td{padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:left;vertical-align:top;white-space:pre-wrap;word-break:break-all}
#${MODAL_ID} th{position:sticky;top:0;background:#f8fafc;z-index:1}
#${MODAL_ID} .dq-image-wrap{display:flex;justify-content:center;align-items:center;min-height:320px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px}
#${MODAL_ID} .dq-image{max-width:100%;max-height:70vh;object-fit:contain;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
#${MODAL_ID} .dq-archives{display:flex;flex-direction:column;gap:14px}
#${MODAL_ID} .dq-card{background:#fff;border:1px solid #dbe2ea;border-radius:12px;padding:16px;box-shadow:0 3px 12px rgba(15,23,42,.04)}
#${MODAL_ID} .dq-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:10px}
#${MODAL_ID} .dq-card-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}
#${MODAL_ID} .dq-name{font-size:16px;font-weight:700;color:#0f172a}
#${MODAL_ID} .dq-subtle{font-size:13px;color:#64748b}
#${MODAL_ID} .dq-tag{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:#e0f2fe;color:#075985;font-size:12px;font-weight:600;white-space:nowrap}
#${MODAL_ID} .dq-meta{font-size:13px;color:#475569;margin-bottom:12px}
#${MODAL_ID} .dq-card-section{border-top:1px dashed #dbe2ea;padding-top:12px}
#${MODAL_ID} .dq-section-title{font-size:14px;font-weight:600;color:#0f172a;margin-bottom:8px}
#${MODAL_ID} .dq-source-list{display:flex;flex-direction:column;gap:6px}
#${MODAL_ID} .dq-source-row{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:#334155}
#${MODAL_ID} .dq-source-date{font-family:Consolas,monospace;color:#16a34a;white-space:nowrap}
#${MODAL_ID} .dq-profile{display:flex;flex-direction:column;gap:18px}
#${MODAL_ID} .dq-profile-section{background:#fff;border:1px solid #dbe2ea;border-radius:14px;overflow:hidden}
#${MODAL_ID} .dq-profile-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;background:linear-gradient(180deg,#f8fafc,#f1f5f9);border-bottom:1px solid #e2e8f0}
#${MODAL_ID} .dq-profile-section-title{font-size:15px;font-weight:700;color:#0f172a}
#${MODAL_ID} .dq-profile-section-meta{font-size:12px;color:#64748b}
#${MODAL_ID} .dq-profile-groups{display:flex;flex-direction:column;gap:14px;padding:14px}
#${MODAL_ID} .dq-profile-group{border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
#${MODAL_ID} .dq-profile-group-head{padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:14px;font-weight:600;color:#1e293b}
#${MODAL_ID} .dq-profile-group-count{margin-left:8px;font-size:12px;font-weight:400;color:#64748b}
#${MODAL_ID} .dq-profile-empty{padding:18px;text-align:center;color:#94a3b8;background:#fff}
#${MODAL_ID} .dq-cell-link{color:#1677ff;text-decoration:none}
#${MODAL_ID} .dq-cell-link:hover{text-decoration:underline}
div[${MENU_MARKER}="1"].dq-legacy-group{position:relative}
div[${MENU_MARKER}="1"] .dq-legacy-caret{margin-left:auto;font-size:12px;color:#94a3b8}
div[${MENU_MARKER}="1"] .dq-legacy-submenu{display:none;position:absolute;left:100%;top:0;min-width:220px;background:#fff;border-radius:8px;box-shadow:0 10px 28px rgba(15,23,42,.18);padding:4px 0;z-index:2147483647}
div[${MENU_MARKER}="1"].dq-legacy-group:hover>.dq-legacy-submenu{display:block}
#${MODAL_ID}.dq-layout-wide .dq-dialog{width:min(90vw,calc(100vw - 24px));max-width:100%}
#${MODAL_ID} .dq-dialog{background:linear-gradient(180deg,#f8fbff 0%,#ffffff 100%);border:1px solid rgba(191,219,254,.9);box-shadow:0 28px 80px rgba(37,99,235,.18)}
#${MODAL_ID} .dq-head{background:linear-gradient(135deg,#2563eb,#1d4ed8 58%,#3b82f6);color:#fff}
#${MODAL_ID} .dq-body{background:linear-gradient(180deg,#eff6ff 0%,#f8fbff 18%,#ffffff 100%)}
#${MODAL_ID} .dq-head-actions{display:flex;align-items:center;gap:10px}
#${MODAL_ID} .dq-home,#${MODAL_ID} .dq-close{backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.26)}
#${MODAL_ID} .dq-home{border:0;background:rgba(255,255,255,.16);color:#fff;height:36px;padding:0 14px;border-radius:10px;cursor:pointer;font-size:13px}
#${MODAL_ID} .dq-context{box-shadow:0 10px 24px rgba(37,99,235,.06)}
#${MODAL_ID} .dq-status{box-shadow:0 8px 20px rgba(37,99,235,.08)}
#${MODAL_ID} .dq-table-wrap,#${MODAL_ID} .dq-card,#${MODAL_ID} .dq-profile-section,#${MODAL_ID} .dq-choice-group{box-shadow:0 12px 28px rgba(15,23,42,.06)}
#${MODAL_ID} .dq-choice-group{background:rgba(255,255,255,.94);border:1px solid #dbeafe;border-radius:14px;padding:16px}
#${MODAL_ID} .dq-choice-title{font-size:15px;font-weight:700;color:#1d4ed8;margin-bottom:12px}
#${MODAL_ID} .dq-choice-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
#${MODAL_ID} .dq-choice-btn{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%;padding:14px 16px;border:1px solid #bfdbfe;border-radius:12px;background:linear-gradient(180deg,#ffffff 0%,#eff6ff 100%);color:#0f172a;cursor:pointer;text-align:left;transition:all .18s ease}
#${MODAL_ID} .dq-choice-btn:hover{transform:translateY(-1px);border-color:#60a5fa;box-shadow:0 14px 26px rgba(37,99,235,.14)}
#${MODAL_ID} .dq-choice-desc{font-size:12px;color:#64748b}
#${MODAL_ID} .dq-jump-link{display:inline-flex;align-items:center;border:0;background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:0 6px;margin:0 2px;line-height:1.8;cursor:pointer;font-size:12px}
#${MODAL_ID} .dq-jump-link:hover{background:#bfdbfe}
#${MODAL_ID} .dq-secondary{margin-bottom:16px;border:1px solid #bfdbfe;border-radius:18px;background:linear-gradient(180deg,#ffffff 0%,#eff6ff 100%);box-shadow:0 18px 36px rgba(37,99,235,.12);overflow:hidden}
#${MODAL_ID} .dq-secondary-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:1px solid #dbeafe;background:linear-gradient(135deg,#dbeafe,#eff6ff)}
#${MODAL_ID} .dq-secondary-title{font-size:16px;font-weight:700;color:#1d4ed8}
#${MODAL_ID} .dq-secondary-subtitle{margin-top:4px;font-size:12px;color:#64748b}
#${MODAL_ID} .dq-secondary-close{border:1px solid #bfdbfe;background:#fff;color:#1d4ed8;height:34px;padding:0 14px;border-radius:10px;cursor:pointer;font-size:13px}
#${MODAL_ID} .dq-secondary-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;padding:16px}
#${MODAL_ID} .dq-secondary-group{background:rgba(255,255,255,.92);border:1px solid #dbeafe;border-radius:14px;padding:14px;box-shadow:0 10px 24px rgba(37,99,235,.08)}
#${MODAL_ID} .dq-secondary-items{display:flex;flex-direction:column;gap:10px}
#${MODAL_ID} .dq-secondary-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:12px 14px;border:1px solid #bfdbfe;border-radius:12px;background:linear-gradient(180deg,#ffffff 0%,#f8fbff 100%);color:#0f172a;cursor:pointer;text-align:left;transition:all .18s ease}
#${MODAL_ID} .dq-secondary-item:hover{transform:translateY(-1px);border-color:#60a5fa;box-shadow:0 14px 26px rgba(37,99,235,.12)}
#${MODAL_ID} .dq-secondary-item::after{content:'选择';font-size:12px;color:#1d4ed8;font-weight:600}
`;
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function ensureModal() {
    if (modalEls) return;
    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.innerHTML = `
      <div class="dq-mask"></div>
      <div class="dq-dialog">
        <div class="dq-head">
          <div>
            <div class="dq-title" style="font-size:18px;font-weight:700">分中心数据查询</div>
            <div style="font-size:12px;opacity:.88;margin-top:4px">直接使用右键上下文值发起查询</div>
          </div>
          <div class="dq-head-actions"><button class="dq-home" type="button">返回首页</button><button class="dq-close" type="button">×</button></div>
        </div>
        <div class="dq-body">
          <div class="dq-context"></div>
          <div class="dq-status"></div>
          <div class="dq-result"></div>
        </div>
      </div>`;
    document.body.appendChild(root);
    modalEls = {
      root,
      mask: root.querySelector('.dq-mask'),
      home: root.querySelector('.dq-home'),
      close: root.querySelector('.dq-close'),
      title: root.querySelector('.dq-title'),
      context: root.querySelector('.dq-context'),
      status: root.querySelector('.dq-status'),
      result: root.querySelector('.dq-result'),
    };
    modalEls.mask.addEventListener('click', closeModal);
    modalEls.home.addEventListener('click', () => openChooserModal(state.lastContextValue));
    modalEls.close.addEventListener('click', closeModal);
    modalEls.result.addEventListener('click', async (event) => {
      const closeBtn = event.target.closest('.dq-secondary-close');
      if (closeBtn) {
        event.preventDefault();
        event.stopPropagation();
        state.modal.secondary = { open: false, value: '', groups: [] };
        renderModal();
        return;
      }
      const actionBtn = event.target.closest('.dq-secondary-item');
      if (actionBtn) {
        event.preventDefault();
        event.stopPropagation();
        const groupKey = String(actionBtn.getAttribute('data-choice-group') || '');
        const itemIndex = Number(actionBtn.getAttribute('data-choice-index') || -1);
        const groups = state.modal.secondary && Array.isArray(state.modal.secondary.groups) ? state.modal.secondary.groups : [];
        const group = groups.find((entry) => entry.key === groupKey);
        const item = group && Array.isArray(group.items) ? group.items[itemIndex] : null;
        const pickedValue = String(state.modal.secondary && state.modal.secondary.value || '').trim();
        if (item && pickedValue) await handleMenuItemClick(item, pickedValue);
        return;
      }
      const target = event.target.closest('.dq-jump-link');
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const value = String(target.getAttribute('data-dq-query') || '').trim();
      if (!value) return;
      openSecondaryChooser(value);
    });
  }

  function closeModal() {
    if (!modalEls) return;
    modalEls.root.classList.remove('open');
  }

  function openModal(title) {
    ensureModal();
    state.modal.open = true;
    state.modal.title = title || '分中心数据查询';
    modalEls.root.classList.add('open');
    renderModal();
  }

  function renderModal() {
    if (!modalEls) return;
    modalEls.title.textContent = state.modal.title || '分中心数据查询';
    if (modalEls.home) modalEls.home.style.display = state.modal.kind === 'chooser' ? 'none' : 'inline-flex';
    modalEls.context.innerHTML = `<strong>右键上下文：</strong>${esc(state.lastContextValue || '未识别到可用内容')}`;
    modalEls.status.textContent = state.modal.error || (state.modal.loading ? '查询中，请稍候...' : '');
    modalEls.status.className = `dq-status ${state.modal.error ? 'error' : (state.modal.loading ? 'info show' : '')}`.trim();
    if (!state.modal.loading && !state.modal.error) {
      modalEls.status.className = 'dq-status';
    } else if (state.modal.loading || state.modal.error) {
      modalEls.status.classList.add('show');
    }
    if (state.modal.loading) {
      modalEls.result.innerHTML = '<div class="dq-empty">正在查询，请稍候...</div>';
      return;
    }
    if (state.modal.error) {
      modalEls.result.innerHTML = '<div class="dq-empty">查询失败，请查看上方错误信息。</div>';
      return;
    }
    if (state.modal.kind === 'chooser') {
      renderChooserResult();
      renderSecondaryChooser();
      return;
    }
    if (state.modal.kind === 'table') {
      renderTableResult();
      renderSecondaryChooser();
      return;
    }
    if (state.modal.kind === 'image') {
      renderImageResult();
      renderSecondaryChooser();
      return;
    }
    if (state.modal.kind === 'ga_archives') {
      renderGaArchivesResult();
      renderSecondaryChooser();
      return;
    }
    if (state.modal.kind === 'ga_full_profile') {
      renderGaFullProfileResult();
      renderSecondaryChooser();
      return;
    }
    modalEls.result.innerHTML = '<div class="dq-empty">暂无结果</div>';
  }

  function renderSecondaryChooser() {
    const secondary = state.modal.secondary || {};
    if (!secondary.open || !Array.isArray(secondary.groups) || !secondary.groups.length) return;
    modalEls.result.insertAdjacentHTML('afterbegin', `<div class="dq-secondary"><div class="dq-secondary-head"><div><div class="dq-secondary-title">对 ${esc(secondary.value || '')} 进行二次查询</div><div class="dq-secondary-subtitle">在当前识别结果上继续选择查询类型，不需要回到首页</div></div><button class="dq-secondary-close" type="button">关闭</button></div><div class="dq-secondary-groups">${secondary.groups.map((group) => `<section class="dq-secondary-group"><div class="dq-choice-title">${esc(group.title)}</div><div class="dq-secondary-items">${group.items.map((item, index) => `<button class="dq-secondary-item" type="button" data-choice-group="${group.key}" data-choice-index="${index}">${esc(item.name || item.id || '未命名查询')}</button>`).join('')}</div></section>`).join('')}</div></div>`);
  }

  function renderChooserResult() {
    const groups = Array.isArray(state.modal.choices) ? state.modal.choices : [];
    if (!groups.length) {
      modalEls.result.innerHTML = '<div class="dq-empty">当前没有可用查询项</div>';
      return;
    }
    modalEls.result.innerHTML = `<div class="dq-chooser">${groups.map((group) => `<section class="dq-choice-group"><div class="dq-choice-title">${esc(group.title)}</div><div class="dq-choice-list">${group.items.map((item, index) => `<button class="dq-choice-btn" type="button" data-choice-group="${group.key}" data-choice-index="${index}"><span>${esc(item.name || item.id || '未命名查询')}</span><span class="dq-choice-desc">${esc(item.description || '')}</span></button>`).join('')}</div></section>`).join('')}</div>`;
    modalEls.result.querySelectorAll('.dq-choice-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const groupKey = button.getAttribute('data-choice-group');
        const itemIndex = Number(button.getAttribute('data-choice-index') || -1);
        const group = groups.find((entry) => entry.key === groupKey);
        const item = group && Array.isArray(group.items) ? group.items[itemIndex] : null;
        if (!item) return;
        await handleMenuItemClick(item);
      });
    });
  }

  function renderTableResult() {
    const rows = Array.isArray(state.modal.rows) ? state.modal.rows : [];
    if (!rows.length) {
      modalEls.result.innerHTML = '<div class="dq-empty">未查询到数据</div>';
      return;
    }
    const columns = Array.isArray(state.modal.columns) && state.modal.columns.length
      ? state.modal.columns.filter((item) => item && item.path)
      : Object.keys(rows[0] || {}).map((key) => ({ title: key, path: key }));
    modalEls.result.innerHTML = `<div class="dq-table-wrap"><table><thead><tr>${columns.map((col) => `<th>${esc(col.title || col.path || '字段')}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((col) => `<td>${renderLinkedText(textify(getByPath(row, col.path)))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function renderImageResult() {
    if (!state.modal.imageUrl) {
      modalEls.result.innerHTML = '<div class="dq-empty">没有可显示的图片地址</div>';
      return;
    }
    modalEls.result.innerHTML = `<div class="dq-image-wrap"><img class="dq-image" src="${esc(state.modal.imageUrl)}" alt="查询结果图片" /></div>`;
  }

  function renderGaArchivesResult() {
    const items = Array.isArray(state.modal.data) ? state.modal.data : [];
    if (!items.length) {
      modalEls.result.innerHTML = '<div class="dq-empty">未查询到相关数据</div>';
      return;
    }
    modalEls.result.innerHTML = `<div class="dq-archives">${items.map((item) => renderGaArchiveCard(item)).join('')}</div>`;
  }

  function renderGaArchiveCard(item) {
    const sources = splitArchiveSources(item && item.sjly_mc);
    const dateText = String((item && (item.cjsj_format || item.cjsj)) || '').split(' ')[0];
    return `
      <div class="dq-card">
        <div class="dq-card-head">
          <div class="dq-card-title">
            <span class="dq-name">${esc(item && item.name || '未知姓名')}</span>
            <span class="dq-subtle">证件号码：${renderLinkedText(item && item.zjhm || '-')}</span>
          </div>
          <span class="dq-tag">得分：${esc(item && item.score != null ? item.score : '-')}</span>
        </div>
        <div class="dq-meta">采集时间：${esc(dateText || '-')}</div>
        <div class="dq-card-section">
          <div class="dq-section-title">数据来源</div>
          ${sources.length ? `<div class="dq-source-list">${sources.map((source) => `<div class="dq-source-row"><span>${esc(source.text)}</span><span class="dq-source-date">${esc(source.date || '')}</span></div>`).join('')}</div>` : '<div class="dq-profile-empty">无来源信息</div>'}
        </div>
      </div>`;
  }

  function renderGaFullProfileResult() {
    const sections = Array.isArray(state.modal.data) ? state.modal.data : [];
    if (!sections.length) {
      modalEls.result.innerHTML = '<div class="dq-empty">未查询到全息档案数据</div>';
      return;
    }
    modalEls.result.innerHTML = `<div class="dq-profile">${sections.map((section) => renderGaProfileSection(section)).join('')}</div>`;
  }

  function renderGaProfileSection(section) {
    const groups = Array.isArray(section.groups) ? section.groups : [];
    const suffix = section.error ? '，接口返回异常' : (groups.length ? `，${groups.length}个分组` : '，暂无数据');
    return `
      <section class="dq-profile-section">
        <div class="dq-profile-section-head">
          <div class="dq-profile-section-title">${esc(section.title || section.key || '未命名分类')}</div>
          <div class="dq-profile-section-meta">${esc(suffix)}</div>
        </div>
        <div class="dq-profile-groups">
          ${section.error ? `<div class="dq-empty">${esc(section.error)}</div>` : (groups.length ? groups.map((group) => renderGaProfileGroup(section.key, group)).join('') : '<div class="dq-profile-empty">暂无数据</div>')}
        </div>
      </section>`;
  }

  function renderGaProfileGroup(typeKey, group) {
    const rows = Array.isArray(group && group.datas) ? group.datas : [];
    const columns = getGaGroupColumns(typeKey, group);
    return `
      <div class="dq-profile-group">
        <div class="dq-profile-group-head">${esc(group && group.title || '未命名分组')}${group && group.total > 0 ? `<span class="dq-profile-group-count">(${esc(group.total)}条)</span>` : ''}</div>
        ${rows.length ? `<div class="dq-table-wrap"><table><thead><tr>${columns.map((column) => `<th>${esc(column.title)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${renderGaCell(typeKey, group, row, column.key)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="dq-profile-empty">无记录</div>'}
      </div>`;
  }

  function renderGaCell(typeKey, group, row, key) {
    if (key === 'coordinates_merged') {
      const jd = row && (row.jd || row.longitude);
      const wd = row && (row.wd || row.latitude);
      return jd && wd ? esc(`${jd}, ${wd}`) : '-';
    }
    const title = group && group.zdsm && group.zdsm[key] ? group.zdsm[key] : key;
    const value = row ? row[key] : '';
    if (value == null || value === '') return '-';
    if (looksLikeImageField(key, title, value)) {
      const href = toAbsoluteHttpUrl(value);
      if (href) return `<a class="dq-cell-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">查看图片</a>`;
    }
    return renderLinkedText(textify(value));
  }

  function splitArchiveSources(raw) {
    return String(raw || '').split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
      const matched = item.match(/^(.*?)\[(.*?)\]$/);
      return { text: matched ? matched[1] : item, date: matched ? matched[2] : '' };
    });
  }

  function normalizeGaFullProfile(raw) {
    return GA_TYPE_ORDER.map((key) => {
      const sectionData = raw && raw[key];
      const groups = extractGaGroups(key, sectionData);
      const error = sectionData && sectionData.error ? String(sectionData.error) : '';
      return {
        key,
        title: GA_TYPE_NAMES[key] || key,
        groups,
        error,
      };
    });
  }

  function extractGaGroups(key, sectionData) {
    let groups = [];
    try {
      if (sectionData && sectionData.data && sectionData.data[key] && Array.isArray(sectionData.data[key].data)) {
        groups = sectionData.data[key].data;
      } else if (sectionData && sectionData.data && Array.isArray(sectionData.data[key])) {
        groups = sectionData.data[key];
      } else if (sectionData && Array.isArray(sectionData.data)) {
        groups = sectionData.data;
      }
    } catch (_) {}
    if (key === 'gjxx' && groups.length > 0) {
      const index = groups.findIndex((item) => String(item && item.title || '').includes('人像轨迹(含车内)'));
      if (index > 0) {
        const picked = groups[index];
        groups = [picked].concat(groups.slice(0, index), groups.slice(index + 1));
      }
    }
    return groups;
  }

  function getGaGroupColumns(typeKey, group) {
    const rows = Array.isArray(group && group.datas) ? group.datas : [];
    const first = rows[0] || {};
    const keys = Object.keys(first).filter((key) => key !== 'key');
    const merged = [];
    let hasCoordinates = false;
    keys.forEach((key) => {
      if (typeKey === 'gjxx' && /^(jd|wd|longitude|latitude)$/i.test(key)) {
        if (!hasCoordinates) {
          merged.push('coordinates_merged');
          hasCoordinates = true;
        }
        return;
      }
      merged.push(key);
    });
    if (String(group && group.title || '').includes('人像轨迹(含车内)')) {
      const imageKeys = merged.filter((key) => looksLikeImageField(key, group && group.zdsm && group.zdsm[key], first[key]));
      const otherKeys = merged.filter((key) => !imageKeys.includes(key));
      const coordIndex = otherKeys.indexOf('coordinates_merged');
      if (coordIndex !== -1) otherKeys.splice(coordIndex + 1, 0, ...imageKeys);
      else otherKeys.push(...imageKeys);
      return otherKeys.map((key) => ({ key, title: key === 'coordinates_merged' ? '地图坐标' : ((group && group.zdsm && group.zdsm[key]) || key) }));
    }
    return merged.map((key) => ({ key, title: key === 'coordinates_merged' ? '地图坐标' : ((group && group.zdsm && group.zdsm[key]) || key) }));
  }

  function looksLikeImageField(key, displayName, value) {
    const label = `${key || ''} ${displayName || ''}`.toLowerCase();
    const text = String(value || '').trim();
    if (!text) return false;
    const hasImageName = /(图|照片|image|img|url)/.test(label);
    const hasImageUrl = /^https?:\/\//i.test(text) && /\.(jpg|jpeg|png|gif|bmp|webp)(\?|$)/i.test(text);
    return hasImageName || hasImageUrl;
  }

  function toAbsoluteHttpUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('/')) return joinUrl(state.apiBase || window.location.origin, text);
    return '';
  }
  function observeMenus() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('div[class*="menuBox"]')) injectLegacyMenu(node);
        if (node.matches('ul.smart_menu_ul')) injectSmartMenu(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('div[class*="menuBox"]').forEach(injectLegacyMenu);
          node.querySelectorAll('ul.smart_menu_ul').forEach(injectSmartMenu);
        }
      }));
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  function scheduleMenuScan(rounds) {
    menuScanRounds = Math.max(menuScanRounds, Number(rounds) || 1);
    scanMenus();
    if (menuScanTimer) return;
    menuScanTimer = window.setTimeout(runMenuScan, 120);
  }

  function runMenuScan() {
    menuScanTimer = 0;
    if (menuScanRounds <= 0) return;
    menuScanRounds -= 1;
    scanMenus();
    if (menuScanRounds > 0) menuScanTimer = window.setTimeout(runMenuScan, 120);
  }

  function scanMenus() {
    document.querySelectorAll('div[class*="menuBox"]').forEach(injectLegacyMenu);
    document.querySelectorAll('ul.smart_menu_ul').forEach(injectSmartMenu);
  }

  function isTargetLegacyMenu(menu) {
    const titles = Array.from(menu.querySelectorAll('span[class*="itemTitle"]'))
      .map((element) => String(element.getAttribute('title') || element.textContent || '').trim())
      .filter(Boolean);
    if (!titles.length) return false;
    return titles.includes('复制') || titles.includes('经纬度信息查询') || titles.includes('侦控查询') || titles.includes('大数据查询');
  }

  function injectLegacyMenu(menu) {
    if (!(menu instanceof HTMLElement) || !isTargetLegacyMenu(menu)) return;
    const template = menu.querySelector('div[class*="menuItem"]');
    if (!template) return;
    menu.querySelectorAll(`[${MENU_MARKER}="1"]`).forEach((node) => node.remove());

    const items = Array.isArray(state.menuItems) ? state.menuItems : [];
    const node = buildLegacyLeaf(template, items.length ? '分中心查询' : '分中心查询-菜单加载中', async () => {
      await openChooserModal();
    });
    if (!items.length) node.style.opacity = '0.6';
    menu.appendChild(node);
  }

  function injectSmartMenu(menu) {
    if (!(menu instanceof HTMLElement) || !isTargetSmartMenu(menu)) return;
    const hostList = findSmartMenuHost(menu);
    if (!hostList) return;
    hostList.querySelectorAll(`li[${MENU_MARKER}="1"]`).forEach((node) => node.remove());

    const templateLeaf = findSmartLeafTemplate(hostList);
    if (!templateLeaf) {
      debugLog('injectSmartMenu:missing-template', { hasLeaf: !!templateLeaf });
      return;
    }
    const items = Array.isArray(state.menuItems) ? state.menuItems : [];
    const injectedNode = buildSmartLeafItem(templateLeaf, items.length ? '分中心查询' : '分中心查询-菜单加载中', async () => {
      await openChooserModal();
    });
    if (!items.length) injectedNode.style.opacity = '0.6';
    hostList.appendChild(injectedNode);
    debugLog('injectSmartMenu:appended-single', { hostChildren: hostList.children.length, injectedText: String(injectedNode.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) });
  }

  function buildChooserGroups(items) {
    const gaItems = [];
    const configItems = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (isGaItem(item)) gaItems.push(item);
      else configItems.push(item);
    });
    return [
      gaItems.length ? { key: 'ga', title: '公安网查询', items: gaItems } : null,
      configItems.length ? { key: 'config', title: '通用查询', items: configItems } : null,
    ].filter(Boolean);
  }

  function openSecondaryChooser(contextValue) {
    const pickedValue = String(contextValue || '').trim();
    if (!pickedValue) return;
    state.modal.secondary = {
      open: true,
      value: pickedValue,
      groups: buildChooserGroups(state.menuItems),
    };
    renderModal();
  }

  async function openChooserModal(contextValue) {
    if (typeof contextValue === 'string' && contextValue.trim()) state.lastContextValue = contextValue.trim();
    openModal('分中心数据查询');
    state.modal.loading = false;
    state.modal.error = '';
    state.modal.kind = 'chooser';
    state.modal.rows = [];
    state.modal.columns = [];
    state.modal.imageUrl = '';
    state.modal.data = null;
    state.modal.meta = null;
    state.modal.layout = 'default';
    state.modal.progressText = '';
    state.modal.secondary = { open: false, value: '', groups: [] };
    state.modal.choices = buildChooserGroups(await ensureMenuItemsLoaded());
    renderModal();
  }

  function buildMenuTree(items) {
    const gaItems = [];
    const configItems = [];
    items.forEach((item) => {
      if (isGaItem(item)) gaItems.push(item);
      else configItems.push(item);
    });
    return {
      label: '分中心查询',
      children: [
        gaItems.length ? { label: '公安网查询', children: gaItems.map((item) => ({ label: item.name || item.id || '未命名查询', item })) } : null,
        configItems.length ? { label: '通用查询', children: configItems.map((item) => ({ label: item.name || item.id || '未命名查询', item })) } : null,
      ].filter(Boolean),
    };
  }

  function isGaItem(item) {
    return String(item && (item.kind || '')).toLowerCase() === 'ga' || /^ga:/i.test(String(item && item.id || ''));
  }

  function isTargetSmartMenu(menu) {
    if (!(menu instanceof HTMLElement) || !menu.matches('ul.smart_menu_ul')) return false;
    const labels = Array.from(menu.querySelectorAll(':scope > li > a.smart_menu_a, :scope > li > .smart_menu_box a.smart_menu_a'))
      .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!labels.length) return false;
    return labels.some((label) => /快捷操作|复制|翻译|看数据|查询【|查看目标详情|通用查询/.test(label));
  }

  function findSmartMenuHost(menu) {
    debugLog('findSmartMenuHost:enter', { isRoot: isSmartRootMenu(menu), text: String(menu && menu.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) });
    if (isSmartRootMenu(menu)) {
      const queryOwner = Array.from(menu.querySelectorAll(':scope > li.smart_menu_li'))
        .find((item) => {
          const link = item.querySelector(':scope > a.smart_menu_a');
          const text = String(link && link.textContent || '').replace(/\s+/g, ' ').trim();
          return /查询【/.test(text) && item.querySelector(':scope > .smart_menu_box > .smart_menu_body > ul.smart_menu_ul');
        });
      if (queryOwner) {
        const host = queryOwner.querySelector(':scope > .smart_menu_box > .smart_menu_body > ul.smart_menu_ul');
        debugLog('findSmartMenuHost:found-query-owner', { ownerText: String(queryOwner.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120), hasHost: !!host });
        return host;
      }
      debugLog('findSmartMenuHost:use-root-menu');
      return menu;
    }
    const owner = menu.closest('li.smart_menu_li[data-hover="true"]') || menu.closest('li.smart_menu_li');
    if (owner) {
      const ownerLink = owner.querySelector(':scope > a.smart_menu_a');
      const ownerText = String(ownerLink && ownerLink.textContent || '').replace(/\s+/g, ' ').trim();
      if (/查询【/.test(ownerText)) {
        debugLog('findSmartMenuHost:use-owner-menu', { ownerText });
        return menu;
      }
    }
    debugLog('findSmartMenuHost:not-found');
    return null;
  }

  function isSmartRootMenu(menu) {
    if (!(menu instanceof HTMLElement)) return false;
    const rootBox = menu.closest('div#smartMenu_grid.smart_menu_box');
    if (!rootBox) return false;
    const rootList = rootBox.querySelector(':scope > .smart_menu_body > ul.smart_menu_ul');
    return rootList === menu;
  }

  function findSmartGroupTemplate(hostList) {
    return hostList.querySelector(':scope > li.smart_menu_li[data-hover="true"]') || hostList.querySelector(':scope > li.smart_menu_li');
  }

  function findSmartLeafTemplate(hostList) {
    const nested = hostList.querySelector(':scope > li.smart_menu_li[data-hover="true"] .smart_menu_ul > li.smart_menu_li');
    if (nested) return nested;
    return hostList.querySelector(':scope > li.smart_menu_li');
  }
  function buildSmartTreeNode(groupTemplate, leafTemplate, entry) {
    if (entry && Array.isArray(entry.children)) return buildSmartGroupNode(groupTemplate, leafTemplate, entry.label, entry.children);
    return buildSmartLeafItem(leafTemplate, entry && entry.label || '未命名查询', async () => {
      await handleMenuItemClick(entry.item);
    });
  }

  function buildSmartGroupNode(groupTemplate, leafTemplate, label, children) {
    const node = groupTemplate.cloneNode(true);
    node.setAttribute(MENU_MARKER, '1');
    node.classList.add('dq-smart-group');
    node.classList.remove('smart_menu_li_hover');
    node.removeAttribute('data-hover');
    node.style.position = 'relative';
    node.style.overflow = 'visible';
    const link = node.querySelector(':scope > a.smart_menu_a');
    if (link) {
      link.classList.remove('smart_menu_a_hover');
      link.setAttribute('data-key', `dataquery-group-${Math.random().toString(36).slice(2)}`);
      ensureSmartTriangle(link);
      setSmartAnchorLabel(link, label, true);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openSmartMenuGroup(node, box, link);
      }, true);
    }
    const box = node.querySelector(':scope > .smart_menu_box') || document.createElement('div');
    debugLog('buildSmartGroupNode:create-box', { label, reusedExistingBox: !!node.querySelector(':scope > .smart_menu_box') });
    if (!box.classList.contains('smart_menu_box')) box.className = 'smart_menu_box';
    box.style.display = 'none';
    box.style.position = 'absolute';
    box.style.top = '0px';
    box.style.left = '134px';
    box.style.zIndex = '2147483647';
    box.style.overflow = 'visible';
    let body = box.querySelector('.smart_menu_body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'smart_menu_body';
      box.appendChild(body);
    }
    let list = body.querySelector('ul.smart_menu_ul');
    if (!list) {
      list = document.createElement('ul');
      list.className = 'smart_menu_ul';
      body.appendChild(list);
    }
    list.innerHTML = '';
    children.forEach((child) => list.appendChild(buildSmartTreeNode(groupTemplate, leafTemplate, child)));
    if (!box.parentElement) node.appendChild(box);

    let closeTimer = 0;
    const keepOpen = () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = 0;
      }
      openSmartMenuGroup(node, box, link);
    };
    const delayClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => {
        closeSmartMenuGroup(node, box, link);
      }, 120);
    };

    node.addEventListener('mouseenter', () => { debugLog('buildSmartGroupNode:mouseenter', { label }); keepOpen(); }, true);
    node.addEventListener('mouseleave', () => { debugLog('buildSmartGroupNode:mouseleave', { label }); delayClose(); }, true);
    link && link.addEventListener('mouseenter', () => { debugLog('buildSmartGroupNode:link-mouseenter', { label }); keepOpen(); }, true);
    box.addEventListener('mouseenter', () => { debugLog('buildSmartGroupNode:box-mouseenter', { label }); keepOpen(); }, true);
    box.addEventListener('mouseleave', () => { debugLog('buildSmartGroupNode:box-mouseleave', { label }); delayClose(); }, true);
    return node;
  }

  function buildSmartLeafItem(template, label, onClick) {
    const node = template.cloneNode(true);
    node.setAttribute(MENU_MARKER, '1');
    node.removeAttribute('data-hover');
    node.querySelectorAll(':scope > .smart_menu_box').forEach((element) => element.remove());
    const link = node.querySelector(':scope > a.smart_menu_a') || node.querySelector('a.smart_menu_a');
    if (link) {
      link.classList.remove('smart_menu_a_hover');
      link.setAttribute('data-key', `dataquery-${Math.random().toString(36).slice(2)}`);
      setSmartAnchorLabel(link, label, false);
      bindMenuAction(link, onClick);
    }
    return node;
  }

  function ensureSmartTriangle(anchor) {
    if (!anchor || anchor.querySelector('.smart_menu_triangle')) return;
    const triangle = document.createElement('i');
    triangle.className = 'smart_menu_triangle';
    anchor.insertBefore(triangle, anchor.firstChild || null);
  }

  function setSmartAnchorLabel(anchor, label, keepTriangle) {
    const text = String(label || '').trim();
    const triangle = anchor.querySelector('.smart_menu_triangle');
    const icon = anchor.querySelector('span, i');
    Array.from(anchor.childNodes).forEach((child) => {
      if (child === triangle || child === icon) return;
      anchor.removeChild(child);
    });
    if (!keepTriangle && triangle) triangle.remove();
    anchor.appendChild(document.createTextNode(text));
  }

  function openSmartMenuGroup(node, box, link) {
    debugLog('openSmartMenuGroup', { label: String(link && link.textContent || '').trim(), beforeDisplay: box && box.style ? box.style.display : '' });
    node.setAttribute('data-hover', 'true');
    node.classList.add('smart_menu_li_hover');
    if (link) link.classList.add('smart_menu_a_hover');
    box.style.display = 'block';
    if (!box.style.left) box.style.left = '134px';
    if (!box.style.top) box.style.top = '0px';
  }

  function closeSmartMenuGroup(node, box, link) {
    debugLog('closeSmartMenuGroup', { label: String(link && link.textContent || '').trim(), beforeDisplay: box && box.style ? box.style.display : '' });
    node.removeAttribute('data-hover');
    node.classList.remove('smart_menu_li_hover');
    if (link) link.classList.remove('smart_menu_a_hover');
    box.style.display = 'none';
  }

  function buildLegacyTreeNode(template, entry) {
    if (entry && Array.isArray(entry.children)) return buildLegacyGroup(template, entry.label, entry.children.map((child) => buildLegacyTreeNode(template, child)));
    return buildLegacyLeaf(template, entry && entry.label || '未命名查询', async () => {
      await handleMenuItemClick(entry.item);
    });
  }

  function buildLegacyGroup(template, label, children) {
    const node = cloneLegacyMenuItem(template, label);
    node.setAttribute(MENU_MARKER, '1');
    node.classList.add('dq-legacy-group');
    node.style.position = 'relative';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    if (!node.querySelector('.dq-legacy-caret')) {
      const caret = document.createElement('span');
      caret.className = 'dq-legacy-caret';
      caret.textContent = '▶';
      node.appendChild(caret);
    }
    const submenu = document.createElement('div');
    submenu.className = 'dq-legacy-submenu';
    children.forEach((child) => submenu.appendChild(child));
    node.appendChild(submenu);
    return node;
  }

  function buildLegacyLeaf(template, label, onClick) {
    const node = cloneLegacyMenuItem(template, label);
    node.setAttribute(MENU_MARKER, '1');
    if (onClick) bindMenuAction(node, onClick);
    return node;
  }

  function cloneLegacyMenuItem(template, label) {
    const node = template.cloneNode(true);
    const title = node.querySelector('span[class*="itemTitle"]');
    if (title) {
      title.textContent = label;
      title.setAttribute('title', label);
    }
    const icon = node.querySelector('i');
    if (icon) icon.className = 'icon___17CC5 synway-410___1ytDP';
    node.querySelectorAll('svg,.anticon,.dq-legacy-caret,.dq-legacy-submenu').forEach((element) => element.remove());
    return node;
  }
  async function handleMenuItemClick(item, valueOverride) {
    const value = String(valueOverride || state.lastContextValue || '').trim();
    if (value) state.lastContextValue = value;
    if (item && item.pluginOpenInPlatform) {
      openPlatformQuery(item, value);
      return;
    }
    openModal(item && item.name || '分中心数据查询');
    if (!value) {
      showError(item && item.name || '分中心数据查询', '未识别到右键上下文值，无法直接查询');
      return;
    }
    state.modal.loading = true;
    state.modal.error = '';
    state.modal.kind = '';
    state.modal.rows = [];
    state.modal.columns = [];
    state.modal.imageUrl = '';
    state.modal.data = null;
    state.modal.meta = null;
    state.modal.layout = String(item && item.id || '') === 'ga:full-profile' ? 'wide' : 'default';
    state.modal.progressText = '';
    state.modal.secondary = { open: false, value: '', groups: [] };
    renderModal();
    try {
      const result = item && item.kind === 'config' ? await runConfigItem(item, value) : await runGaItem(item, value);
      state.modal.loading = false;
      state.modal.error = '';
      state.modal.kind = result.kind;
      state.modal.rows = result.rows || [];
      state.modal.columns = result.columns || [];
      state.modal.imageUrl = result.imageUrl || '';
      state.modal.data = result.data || null;
      state.modal.meta = result.meta || null;
      renderModal();
    } catch (error) {
      showError(item && item.name || '分中心数据查询', error && error.message ? error.message : String(error));
    }
  }

  async function runGaItem(item, value) {
    if (String(item && item.id || '') === 'ga:full-profile') {
      return await runGaFullProfileItem(item, value);
    }
    const endpoint = joinUrl(state.apiBase, item.endpoint);
    const url = new URL(endpoint, state.apiBase);
    url.searchParams.set(item.queryParam || 'key', value);
    const resp = await gmRequest({ method: 'GET', url: url.toString(), headers: { Accept: 'application/json' } });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`查询失败：HTTP ${resp.status}`);
    const data = parseJson(resp.responseText || 'null', '接口返回不是 JSON');
    if (item.resultType === 'image') {
      const imageUrl = joinMaybeRelativeUrl(state.apiBase, data && data.imageUrl);
      return { kind: 'image', imageUrl, data, meta: data };
    }
    if (String(item.id || '') === 'ga:archives') {
      const list = Array.isArray(data && data.dataList) ? data.dataList.slice() : [];
      list.sort((a, b) => (Number(b && b.score) || 0) - (Number(a && a.score) || 0));
      return { kind: 'ga_archives', data: list, meta: data };
    }
    return { kind: 'table', rows: Array.isArray(data) ? data : [data], columns: [], data, meta: data };
  }

  async function runGaFullProfileItem(item, value) {
    const ownerIdCard = await resolvePlatformOwnerIdCard().catch(() => '');
    const sessionResp = await gmRequest({
      method: 'POST',
      url: joinUrl(state.apiBase, '/api/public/plugin/open-session'),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      data: JSON.stringify({
        value,
        itemId: item && item.id ? String(item.id) : '',
        ownerIdCard,
      }),
    });
    if (sessionResp.status < 200 || sessionResp.status >= 300) {
      throw new Error(`查询初始化失败：HTTP ${sessionResp.status}`);
    }
    const sessionData = parseJson(sessionResp.responseText || 'null', '查询票据返回不是 JSON');
    const ticket = String(sessionData && sessionData.ticket || '').trim();
    if (!ticket) throw new Error('查询初始化失败：未返回票据');
    const results = {};
    for (let index = 0; index < GA_TYPE_ORDER.length; index += 1) {
      const typeKey = GA_TYPE_ORDER[index];
      state.modal.progressText = `正在加载全息档案 ${index + 1}/${GA_TYPE_ORDER.length}：${GA_TYPE_NAMES[typeKey] || typeKey}`;
      renderModal();
      try {
        const resp = await gmRequest({
          method: 'POST',
          url: joinUrl(state.apiBase, '/api/public/plugin/query'),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          data: JSON.stringify({ ticket, itemId: item && item.id ? String(item.id) : '', value, type: typeKey }),
        });
        if (resp.status < 200 || resp.status >= 300) {
          const text = String(resp.responseText || '').trim();
          throw new Error(extractHttpErrorMessage(resp.status, text));
        }
        const data = parseJson(resp.responseText || 'null', '接口返回不是 JSON');
        results[typeKey] = (data && data.data && data.data[typeKey]) ? data.data[typeKey] : (data && data.data) ? data.data : data;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        results[typeKey] = { error: message };
      }
      if (index < GA_TYPE_ORDER.length - 1) await delay(180);
    }
    state.modal.progressText = '';
    return { kind: 'ga_full_profile', data: normalizeGaFullProfile(results), meta: results };
  }

  async function runConfigItem(cfg, contextValue) {
    const invalidReason = validatePluginConfig(cfg);
    if (invalidReason) throw new Error(invalidReason);
    const method = String(cfg.method || 'GET').toUpperCase();
    const endpoint = resolveEndpoint(cfg.endpoint, state.apiBase);
    const params = buildParamsForContext(cfg, contextValue);
    const headers = { ...(cfg.headers || {}) };
    const resp = await gmRequest(method === 'GET'
      ? { method, url: buildUrl(endpoint, params), headers }
      : { method, url: endpoint, headers: { 'Content-Type': 'application/json', ...headers }, data: JSON.stringify(params) });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`查询失败：HTTP ${resp.status}`);
    let data = parseJson(resp.responseText || 'null', '接口返回不是 JSON');
    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'success')) {
      if (!okFlag(data.success)) throw new Error(String(data.message || '接口返回异常'));
      if (Object.prototype.hasOwnProperty.call(data, 'data')) data = data.data;
    }
    let list = Array.isArray(data) ? data : (cfg.listPath ? getByPath(data, cfg.listPath) : data);
    if (!Array.isArray(list)) {
      if (list && typeof list === 'object') list = [list];
      else throw new Error('响应不为数组，请检查接口返回结构或 listPath 配置');
    }
    return {
      kind: 'table',
      rows: list,
      columns: Array.isArray(cfg.columns) ? cfg.columns : [],
      data,
      meta: data,
    };
  }

  function buildParamsForContext(cfg, contextValue) {
    const base = { ...stripMeta(cfg.params || {}), configId: cfg.id || '' };
    const fields = Array.isArray(cfg.searchFields) ? cfg.searchFields : [];
    if (!fields.length) {
      base.key = caseVal(contextValue, cfg.searchCaseEnabled ? cfg.searchCaseMode : 'none');
      return base;
    }
    const selectedField = pickBestSearchField(fields, contextValue) || fields[0];
    const searchValues = {};
    fields.forEach((field) => {
      searchValues[field.name] = field === selectedField ? contextValue : '';
    });
    const extra = {};
    const parms = [];
    fields.forEach((field, index) => {
      const name = String(field.name || '');
      const raw = searchValues[name];
      if (raw == null || raw === '') return;
      const mode = String(field.caseMode || 'none').toLowerCase();
      const value = normalizeVal(raw, field);
      const match = name.match(/^(parms|params)(\d+)?(\[\])?$/i);
      if (match) {
        const order = match[2] ? parseInt(match[2], 10) : index;
        if ((field.type === 'string_list' || field.type === 'number_list') && Array.isArray(value)) {
          value.forEach((item, itemIndex) => parms.push({ ord: order + itemIndex, val: caseVal(item, mode !== 'none' ? mode : (cfg.searchCaseEnabled ? cfg.searchCaseMode : 'none')) }));
          return;
        }
        parms.push({ ord: order, val: caseVal(value, mode !== 'none' ? mode : (cfg.searchCaseEnabled ? cfg.searchCaseMode : 'none')) });
        return;
      }
      extra[name] = caseVal(value, mode !== 'none' ? mode : (cfg.searchCaseEnabled ? cfg.searchCaseMode : 'none'));
    });
    if (parms.length) {
      parms.sort((a, b) => a.ord - b.ord);
      extra.parms = parms.map((item) => item.val);
    }
    return { ...base, ...extra };
  }

  function validatePluginConfig(cfg) {
    const targetRequired = new Set(Array.isArray(cfg && cfg.targetRequiredFields) ? cfg.targetRequiredFields.map((item) => String(item || '').trim()).filter(Boolean) : []);
    const effectiveFields = (Array.isArray(cfg && cfg.searchFields) ? cfg.searchFields : [])
      .filter(Boolean)
      .filter((field) => !targetRequired.has(String(field && field.name || '').trim()));
    if (effectiveFields.length > 1) {
      return '该插件查询配置包含多个查询条件，请到业务页面补齐其他条件后再查询';
    }
    return '';
  }
  function pickBestSearchField(fields, value) {
    const normalized = String(value || '').trim();
    let best = null;
    let bestScore = -1;
    fields.forEach((field, index) => {
      const hay = `${field.label || ''} ${field.name || ''}`.toLowerCase();
      let score = fields.length - index;
      if (/^1\d{10}$/.test(normalized)) {
        if (/(phone|mobile|msisdn|tel|号码|手机)/.test(hay)) score += 50;
      }
      if (/^\d{17}[0-9xX]$/.test(normalized)) {
        if (/(sfzh|idcard|证件|身份证|zjhm)/.test(hay)) score += 50;
      }
      if (/^\d{15}$/.test(normalized)) {
        if (/(imsi)/.test(hay)) score += 45;
        if (/(imei)/.test(hay)) score += 40;
      }
      if (/^\d{14,17}$/.test(normalized) && /(imei)/.test(hay)) score += 42;
      if (/(keyword|key|查询|号码|身份证|phone|mobile|imsi|imei|msisdn)/.test(hay)) score += 12;
      if (String(field.type || 'text').toLowerCase() === 'date') score -= 20;
      if (score > bestScore) {
        best = field;
        bestScore = score;
      }
    });
    return best;
  }

  function normalizeVal(raw, field) {
    const type = String(field.type || 'text').toLowerCase();
    if (type === 'number') {
      const number = Number(raw);
      return Number.isNaN(number) ? raw : number;
    }
    if (type === 'string_list' || type === 'number_list') {
      const list = String(raw || '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      return type === 'number_list' ? list.map((item) => {
        const number = Number(item);
        return Number.isNaN(number) ? item : number;
      }) : list;
    }
    return raw;
  }

  function resolveEndpoint(endpoint, base) {
    const value = String(endpoint || '').trim();
    if (!value) throw new Error('当前配置未设置 endpoint');
    if (/^https?:\/\//i.test(value)) return value;
    return joinUrl(base, value);
  }

  function openPlatformQuery(item, value) {
    const pickedValue = String(value || state.lastContextValue || '').trim();
    if (!pickedValue) {
      showError(item && item.name || '分中心数据查询', '未识别到右键上下文值，无法直接跳转平台页');
      return;
    }
    const base = normalizeBase(state.apiBase || uniqueBases()[0] || window.location.origin);
    resolvePlatformOwnerIdCard().then((ownerIdCard) => gmRequest({
      method: 'POST',
      url: joinUrl(base, '/api/public/plugin/open-session'),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      data: JSON.stringify({ value: pickedValue, itemId: item && item.id ? String(item.id) : '', ownerIdCard }),
    })).then((resp) => {
      if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
      const data = parseJson(resp.responseText || 'null', '平台返回不是 JSON');
      const ticket = String(data && data.ticket || '').trim();
      const targetUrl = String(data && data.url || '').trim() || `/plugin/query?ticket=${encodeURIComponent(ticket)}`;
      if (!ticket) throw new Error('平台未返回查询票据');
      const finalUrl = joinUrl(base, targetUrl);
      try { window.open(finalUrl, '_blank', 'noopener,noreferrer'); } catch (_) { window.location.href = finalUrl; }
    }).catch((error) => {
      showError(item && item.name || '分中心数据查询', error && error.message ? error.message : String(error));
    });
  }

  async function resolvePlatformOwnerIdCard() {
    if (state.ownerIdCard) return state.ownerIdCard;
    const origins = [];
    const currentOrigin = normalizeBase(window.location.origin || '');
    if (currentOrigin) origins.push(currentOrigin);
    ['http://www.ses.st.zj.jz', 'https://www.ses.st.zj.jz'].forEach((origin) => {
      const normalized = normalizeBase(origin);
      if (normalized && !origins.includes(normalized)) origins.push(normalized);
    });
    const attempts = [];
    for (let index = 0; index < origins.length; index += 1) {
      const origin = origins[index];
      attempts.push({
        method: 'POST',
        url: joinUrl(origin, '/portalserver/user/getUserInfo'),
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        data: JSON.stringify({ theme: '8' }),
      });
      attempts.push({
        method: 'GET',
        url: joinUrl(origin, '/portalserver/user/getUserInf'),
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
    }
    const reasons = [];
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      try {
        const resp = await gmRequest({
          method: attempt.method,
          url: attempt.url,
          headers: attempt.headers,
          data: attempt.data,
        });
        if (resp.status < 200 || resp.status >= 300) {
          reasons.push(`${attempt.url} -> HTTP ${resp.status}`);
          continue;
        }
        const data = parseJson(resp.responseText || 'null', '当前用户信息返回不是 JSON');
        if (!data || Number(data.code || 0) !== 1) {
          reasons.push(`${attempt.url} -> ${String(data && data.msg || 'code_invalid')}`);
          continue;
        }
        const rows = Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
        const first = rows.find((item) => item && typeof item === 'object' && String(item.IDCARD || item.idCard || '').trim());
        const ownerIdCard = String(first && (first.IDCARD || first.idCard) || '').trim();
        if (!ownerIdCard) {
          reasons.push(`${attempt.url} -> missing_id_card`);
          continue;
        }
        state.ownerIdCard = ownerIdCard;
        return ownerIdCard;
      } catch (error) {
        reasons.push(`${attempt.url} -> ${error && error.message ? error.message : String(error)}`);
      }
    }
    debugLog('resolvePlatformOwnerIdCard failed', reasons.join('；') || 'no_attempts');
    return '';
  }

  function joinUrl(base, path) {
    const left = normalizeBase(base || window.location.origin);
    const right = String(path || '');
    if (/^https?:\/\//i.test(right)) return right;
    return left + (right.startsWith('/') ? right : `/${right}`);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function joinMaybeRelativeUrl(base, value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return joinUrl(base, raw);
  }

  function buildUrl(url, params) {
    const next = new URL(url, window.location.origin);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value == null || value === '') return;
      next.searchParams.set(key, String(value));
    });
    return next.toString();
  }

  function stripMeta(obj) {
    const next = { ...(obj || {}) };
    delete next.__types__;
    delete next.__case__;
    return next;
  }

  function caseVal(value, mode) {
    const currentMode = String(mode || 'none').toLowerCase();
    if (Array.isArray(value)) return value.map((item) => caseVal(item, currentMode));
    if (typeof value !== 'string') return value;
    if (currentMode === 'upper') return value.toUpperCase();
    if (currentMode === 'lower') return value.toLowerCase();
    return value;
  }

  function showError(title, message) {
    state.modal.loading = false;
    state.modal.title = title || '分中心数据查询';
    state.modal.error = message || '查询失败';
    state.modal.kind = '';
    state.modal.rows = [];
    state.modal.columns = [];
    state.modal.imageUrl = '';
    state.modal.data = null;
    state.modal.layout = 'default';
    state.modal.progressText = '';
    openModal(state.modal.title);
    renderModal();
  }

  function parseJson(text, message) {
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(message + `：${String(text || '').slice(0, 200)}`);
    }
  }

  function extractHttpErrorMessage(status, text) {
    const raw = String(text || '').trim();
    if (!raw) return `HTTP ${status}`;
    try {
      const parsed = JSON.parse(raw);
      const detail = parsed && parsed.detail;
      if (detail && typeof detail === 'object') {
        const message = detail.message || detail.error || detail.reason || detail.detail || '';
        const preview = detail.responsePreview ? `；响应片段：${String(detail.responsePreview).slice(0, 120)}` : '';
        const type = detail.type ? `；类型：${detail.type}` : '';
        if (message) return `HTTP ${status}：${message}${type}${preview}`;
      }
      if (detail != null && detail !== '') return `HTTP ${status}：${String(detail).slice(0, 160)}`;
      if (parsed && parsed.message) return `HTTP ${status}：${String(parsed.message).slice(0, 160)}`;
    } catch (_) {}
    return `HTTP ${status}：${raw.slice(0, 160)}`;
  }

  function getByPath(obj, path) {
    if (!path) return obj;
    return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((current, key) => (current == null ? undefined : current[key]), obj);
  }
  function isPhoneNumber(value) {
    return /^1\d{10}$/.test(normalizeWideText(value).replace(/[\s-]+/g, '').trim());
  }

  function isIdCardNumber(value) {
    return /^\d{17}[0-9Xx]$/.test(normalizeWideText(value).replace(/[\s-]+/g, '').trim());
  }

  function isPlateNumber(value) {
    return /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领港澳][A-Z][A-HJ-NP-Z0-9]{5,6}$/i.test(normalizeWideText(value).replace(/[\s·•・\-_.]+/g, '').trim());
  }

  function isStandaloneLinkedToken(text, start, match) {
    const prev = start > 0 ? text[start - 1] : '';
    const next = start + match.length < text.length ? text[start + match.length] : '';
    if (isPhoneNumber(match)) return !/[0-9]/.test(prev) && !/[0-9]/.test(next);
    if (isIdCardNumber(match)) return !/[0-9A-Za-z]/.test(prev) && !/[0-9A-Za-z]/.test(next);
    if (isPlateNumber(match)) return !/[0-9A-Za-z]/.test(prev) && !/[0-9A-Za-z]/.test(next);
    return false;
  }

  function renderLinkedText(value) {
    const text = String(value == null ? '' : value);
    if (!text) return '';
    const pattern = /(\d{17}[0-9Xx]|1\d{10}|[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领港澳][A-Z][A-HJ-NP-Z0-9]{5,6})/g;
    let lastIndex = 0;
    let output = '';
    let matched = false;
    text.replace(pattern, (match, _group, offset) => {
      if (!isStandaloneLinkedToken(text, offset, match)) return match;
      matched = true;
      output += esc(text.slice(lastIndex, offset));
      output += `<button class="dq-jump-link" type="button" data-dq-query="${esc(match)}">${esc(match)}</button>`;
      lastIndex = offset + match.length;
      return match;
    });
    if (!matched) return esc(text);
    output += esc(text.slice(lastIndex));
    return output;
  }

  function textify(value) {
    if (value == null) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch (_) {
        return String(value);
      }
    }
    return String(value);
  }

  function okFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'true' || normalized === 'ok' || normalized === 'success' || normalized === '1';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();














