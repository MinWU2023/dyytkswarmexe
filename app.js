(function () {
  'use strict';

  var CFG = window.__TKSWARM_EXE_CONFIG__ || {};
  var DESK = window.tkswarmDesktop || null;
  var LS = {
    api: 'tkswarm_exe_api_base',
    node: 'tkswarm_exe_node_url',
    bit: 'tkswarm_exe_bit_url',
    channel: 'tkswarm_exe_channel',
    deploy: 'tkswarm_exe_deploy_dir',
    token: 'tkswarm_exe_token',
    user: 'tkswarm_exe_user',
    rememberUser: 'tkswarm_exe_remember_user',
    bitPath: 'tkswarm_exe_bit_path'
  };
  var APP = { platform: 'unknown', version: CFG.appVersion || '1.0.0', defaultDeployDir: '' };
  var busy = false;
  var authUser = null;

  function $(id) { return document.getElementById(id); }

  function toast(message, type) {
    var host = $('toast-host');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : type === 'ok' ? ' ok' : '');
    el.textContent = String(message || '');
    host.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = '0.25s';
      setTimeout(function () { el.remove(); }, 280);
    }, 2800);
  }

  function stripSlash(u) {
    return String(u || '').trim().replace(/\/+$/, '');
  }

  function getApiBase() {
    return stripSlash(localStorage.getItem(LS.api) || CFG.defaultApiBase || 'http://tkswarm-api.dyyweb.com');
  }

  function getNodeUrl() {
    return stripSlash(localStorage.getItem(LS.node) || CFG.nodeHealthUrl || 'http://127.0.0.1:8999/api/health');
  }

  function getBitUrl() {
    return stripSlash(localStorage.getItem(LS.bit) || CFG.bitApiUrl || 'http://127.0.0.1:54345');
  }

  function getChannel() {
    return localStorage.getItem(LS.channel) || 'stable';
  }

  function getDeployDir() {
    var input = $('deploy-dir-input');
    var fromInput = input && input.value ? input.value.trim() : '';
    return fromInput || localStorage.getItem(LS.deploy) || APP.defaultDeployDir || '';
  }

  function setDeployDir(dir) {
    if (!dir) return;
    localStorage.setItem(LS.deploy, dir);
    var input = $('deploy-dir-input');
    if (input) input.value = dir;
  }

  function openExternal(url) {
    if (!url) return;
    if (DESK && typeof DESK.openExternal === 'function') {
      DESK.openExternal(url);
      return;
    }
    try {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      window.location.href = url;
    }
  }

  function formatBytes(n) {
    var x = Number(n) || 0;
    if (x < 1024) return x + ' B';
    if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
    return (x / 1024 / 1024).toFixed(1) + ' MB';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* —— 自定义下拉：美化弹出层，同步原生 select —— */
  var prettySelects = [];

  function closeAllPrettySelects(except) {
    prettySelects.forEach(function (inst) {
      if (inst !== except) inst.close();
    });
  }

  function enhanceSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT' || sel.dataset.pretty === '1') return null;
    sel.dataset.pretty = '1';

    var wrap = document.createElement('div');
    wrap.className = 'select-pretty' + (sel.classList.contains('select-version') ? ' select-version' : '');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.innerHTML =
      '<span class="select-trigger-text"></span>'
      + '<svg class="select-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">'
      + '<path d="M6 9l6 6 6-6"/></svg>';
    wrap.appendChild(trigger);

    var panel = document.createElement('div');
    panel.className = 'select-panel';
    panel.setAttribute('role', 'listbox');
    wrap.appendChild(panel);

    var textEl = trigger.querySelector('.select-trigger-text');
    var open = false;
    var inst = null;

    function syncLabel() {
      var opt = sel.options[sel.selectedIndex];
      var label = opt ? String(opt.textContent || '').trim() : '';
      var empty = !sel.value && (!opt || !label || /加载|暂无|请选择/.test(label));
      textEl.textContent = label || '请选择';
      textEl.classList.toggle('is-placeholder', empty || !label);
    }

    function rebuildOptions() {
      panel.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (opt, idx) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'select-option';
        btn.setAttribute('role', 'option');
        btn.dataset.index = String(idx);
        btn.textContent = opt.textContent;
        if (opt.disabled) {
          btn.disabled = true;
          btn.classList.add('is-disabled');
        }
        if (opt.selected) btn.classList.add('is-selected');
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (opt.disabled) return;
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          syncLabel();
          rebuildOptions();
          close();
        });
        btn.addEventListener('mouseenter', function () {
          panel.querySelectorAll('.select-option').forEach(function (el) {
            el.classList.remove('is-active');
          });
          btn.classList.add('is-active');
        });
        panel.appendChild(btn);
      });
      syncLabel();
    }

    function placePanel() {
      panel.classList.remove('drop-up');
      var rect = trigger.getBoundingClientRect();
      var maxH = Math.min(280, Math.floor(window.innerHeight * 0.42));
      var spaceBelow = window.innerHeight - rect.bottom - 10;
      var spaceAbove = rect.top - 10;
      var dropUp = spaceBelow < 180 && spaceAbove > spaceBelow;
      if (dropUp) panel.classList.add('drop-up');

      var width = Math.max(rect.width, 160);
      // 挂到 body，避开 app-shell / cards 的 overflow 与 transform 裁切
      if (panel.parentNode !== document.body) {
        document.body.appendChild(panel);
      }
      panel.classList.add('is-portaled');
      panel.style.position = 'fixed';
      panel.style.left = Math.min(rect.left, window.innerWidth - width - 8) + 'px';
      panel.style.width = width + 'px';
      panel.style.right = 'auto';
      panel.style.zIndex = '300';
      if (dropUp) {
        panel.style.top = 'auto';
        panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
        panel.style.maxHeight = Math.min(maxH, spaceAbove) + 'px';
      } else {
        panel.style.bottom = 'auto';
        panel.style.top = (rect.bottom + 6) + 'px';
        panel.style.maxHeight = Math.min(maxH, Math.max(120, spaceBelow)) + 'px';
      }
    }

    function clearPanelPos() {
      panel.classList.remove('is-portaled', 'drop-up');
      panel.style.position = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.right = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.maxHeight = '';
      panel.style.zIndex = '';
      if (panel.parentNode !== wrap) {
        wrap.appendChild(panel);
      }
    }

    function openPanel() {
      if (sel.disabled) return;
      closeAllPrettySelects(inst);
      open = true;
      wrap.classList.add('open');
      var card = wrap.closest('.card, .panel');
      var cards = wrap.closest('.cards');
      if (card) card.classList.add('has-open-select');
      if (cards) cards.classList.add('has-open-select');
      trigger.setAttribute('aria-expanded', 'true');
      rebuildOptions();
      placePanel();
    }

    function close() {
      open = false;
      wrap.classList.remove('open');
      var card = wrap.closest('.card, .panel');
      var cards = wrap.closest('.cards');
      if (card) card.classList.remove('has-open-select');
      if (cards) cards.classList.remove('has-open-select');
      trigger.setAttribute('aria-expanded', 'false');
      clearPanelPos();
    }

    function toggle() {
      if (open) close();
      else openPanel();
    }

    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    wrap.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    panel.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    sel.addEventListener('change', function () {
      syncLabel();
      rebuildOptions();
    });

    var mo = new MutationObserver(function () {
      rebuildOptions();
    });
    mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    inst = {
      el: sel,
      wrap: wrap,
      close: close,
      refresh: rebuildOptions,
      open: openPanel
    };
    prettySelects.push(inst);
    rebuildOptions();
    window.addEventListener('resize', function () {
      if (open) placePanel();
    });
    window.addEventListener('scroll', function () {
      if (open) placePanel();
    }, true);
    return inst;
  }

  function enhanceAllSelects() {
    document.querySelectorAll('select.select').forEach(function (sel) {
      enhanceSelect(sel);
    });
  }

  function refreshPrettySelect(selOrId) {
    var sel = typeof selOrId === 'string' ? $(selOrId) : selOrId;
    if (!sel) return;
    var inst = prettySelects.find(function (x) { return x.el === sel; });
    if (inst) inst.refresh();
    else enhanceSelect(sel);
  }

  document.addEventListener('click', function () {
    closeAllPrettySelects(null);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAllPrettySelects(null);
  });

  function setStatus(key, state, meta) {
    var badge = $('status-' + key);
    var metaEl = $('meta-' + key);
    if (badge) {
      badge.className = 'status ' + state;
      var labels = {
        online: '已就绪',
        installed: '已安装',
        offline: '未安装',
        warn: '待确认',
        checking: '检测中'
      };
      badge.textContent = labels[state] || '检测中';
    }
    if (metaEl) metaEl.innerHTML = meta || '';
  }

  function updatePills() {
    /* 顶部状态胶囊已移除 */
  }

  function showProgress(show, message, percent) {
    var wrap = $('progress-wrap');
    var label = $('progress-label');
    var fill = $('progress-fill');
    if (!wrap) return;
    wrap.hidden = !show;
    if (label) label.textContent = message || '';
    if (fill) fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
  }

  async function probeFetch(url, options) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 3500);
    try {
      var res = await fetch(url, Object.assign({
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      }, options || {}));
      clearTimeout(timer);
      var text = '';
      try { text = await res.text(); } catch (e) { text = ''; }
      var json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      return { ok: res.ok, status: res.status, json: json, text: text, cors: false };
    } catch (err) {
      clearTimeout(timer);
      try {
        var controller2 = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer2 = setTimeout(function () {
          if (controller2) controller2.abort();
        }, 2500);
        await fetch(url, {
          method: (options && options.method) || 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller2 ? controller2.signal : undefined,
          body: options && options.body,
          headers: options && options.headers
        });
        clearTimeout(timer2);
        return { ok: false, status: 0, json: null, text: '', cors: true };
      } catch (e2) {
        return { ok: false, status: 0, json: null, text: '', cors: false, error: String((err && err.message) || err) };
      }
    }
  }

  var envState = {
    nodeInstalled: false,
    bitInstalled: false,
    busy: false
  };

  /** 来自 API 的安装包目录；空则回退 CFG 本地列表 */
  var envCatalog = {
    node: [],
    bit: []
  };

  function clientEnvPlatform() {
    return APP.platform === 'darwin' ? 'mac' : 'win';
  }

  function absApiUrl(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return getApiBase() + (s.charAt(0) === '/' ? s : '/' + s);
  }

  function mapEnvCatalogItem(it) {
    var downloadUrl = absApiUrl(it.downloadUrl || it.url || '');
    return {
      id: String(it.id),
      version: String(it.version || ''),
      label: String(it.label || it.title || it.version || it.id),
      recommended: !!(it.recommended || it.isRecommended),
      downloadUrl: downloadUrl,
      winUrl: downloadUrl,
      macUrl: downloadUrl,
      fileName: String(it.fileName || '')
    };
  }

  function nodeVersionList() {
    return (envCatalog.node && envCatalog.node.length) ? envCatalog.node : (CFG.nodeVersions || []);
  }

  function bitVersionList() {
    return (envCatalog.bit && envCatalog.bit.length) ? envCatalog.bit : (CFG.bitVersions || []);
  }

  async function loadEnvCatalogs() {
    var plat = clientEnvPlatform();
    var nodeList = CFG.nodeVersions || [];
    var bitList = CFG.bitVersions || [];
    try {
      var nodeCat = await apiGet('/env-installers/catalog?kind=node&platform=' + encodeURIComponent(plat));
      var nItems = (nodeCat && nodeCat.items) || [];
      if (nItems.length) nodeList = nItems.map(mapEnvCatalogItem);
    } catch (e) { /* 网络失败时用本地兜底 */ }
    try {
      var bitCat = await apiGet('/env-installers/catalog?kind=bit&platform=' + encodeURIComponent(plat));
      var bItems = (bitCat && bitCat.items) || [];
      if (bItems.length) bitList = bItems.map(mapEnvCatalogItem);
    } catch (e2) { /* 同上 */ }
    envCatalog.node = nodeList;
    envCatalog.bit = bitList;
    fillEnvVersionSelect('node-ver-select', envCatalog.node);
    fillEnvVersionSelect('bit-ver-select', envCatalog.bit);
  }

  function pickRecommended(list) {
    var items = list || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].recommended) return items[i];
    }
    return items[0] || null;
  }

  function fillEnvVersionSelect(selectId, list) {
    var sel = $(selectId);
    if (!sel) return;
    var items = list || [];
    if (!items.length) {
      sel.innerHTML = '<option value="">暂无版本</option>';
      refreshPrettySelect(sel);
      return;
    }
    var rec = pickRecommended(items);
    sel.innerHTML = items.map(function (v) {
      return '<option value="' + esc(v.id) + '">' + esc(v.label || v.id) + '</option>';
    }).join('');
    if (rec) sel.value = String(rec.id);
    refreshPrettySelect(sel);
  }

  function getSelectedEnvVersion(selectId, list) {
    var sel = $(selectId);
    var id = sel && sel.value;
    var items = list || [];
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].id) === String(id)) return items[i];
    }
    return pickRecommended(items);
  }

  function setEnvButtons(target, installed) {
    var installBtn = $('btn-install-' + target);
    var uninstallBtn = $('btn-uninstall-' + target);
    if (installBtn) {
      installBtn.hidden = !!installed;
      installBtn.disabled = !!envState.busy;
    }
    if (uninstallBtn) {
      uninstallBtn.hidden = !installed;
      uninstallBtn.disabled = !!envState.busy;
    }
  }

  function showEnvProgress(message) {
    if (!message) return;
    // 复用部署进度条区域提示环境安装
    showProgress(true, message, 40);
  }

  async function refreshEnvInstallState() {
    if (!DESK || !DESK.detectNode) {
      setEnvButtons('node', false);
      setEnvButtons('bit', false);
      return;
    }
    try {
      var nodeInfo = await DESK.detectNode();
      envState.nodeInstalled = !!(nodeInfo && nodeInfo.installed);
      setEnvButtons('node', envState.nodeInstalled);
      if (envState.nodeInstalled) {
        var tip = '已安装 Node.js'
          + (nodeInfo.version ? ' v' + nodeInfo.version : '')
          + (nodeInfo.path ? '<br><code>' + esc(nodeInfo.path) + '</code>' : '');
        // 服务探测在 checkNodeService 里补充
        $('meta-node') && ($('meta-node').dataset.installTip = tip);
      }
    } catch (e) {
      setEnvButtons('node', false);
    }
    try {
      var bitInfo = await DESK.detectBit({ bitApiUrl: getBitUrl(), hintPath: localStorage.getItem(LS.bitPath) || '' });
      envState.bitInstalled = !!(bitInfo && bitInfo.installed);
      setEnvButtons('bit', envState.bitInstalled);
      if (envState.bitInstalled) {
        var tip2 = '已安装比特浏览器'
          + (bitInfo.version ? ' v' + bitInfo.version : '')
          + (bitInfo.path ? '<br><code>' + esc(bitInfo.path) + '</code>' : '');
        $('meta-bit') && ($('meta-bit').dataset.installTip = tip2);
      }
    } catch (e2) {
      setEnvButtons('bit', false);
    }
  }

  async function checkNode() {
    setStatus('node', 'checking', '正在检测 Node.js…');
    var installTip = '';
    envState.nodeInstalled = false;

    if (DESK && DESK.detectNode) {
      try {
        var info = await DESK.detectNode();
        envState.nodeInstalled = !!(info && info.installed);
        setEnvButtons('node', envState.nodeInstalled);
        if (info && info.installed) {
          installTip = '已安装 Node.js'
            + (info.version ? ' v' + info.version : '')
            + (info.npm ? ' · npm 可用' : ' · 未找到 npm')
            + (info.path ? '<br><code>' + esc(info.path) + '</code>' : '');
        } else {
          installTip = '未检测到 Node.js。已检查 PATH / nvm / 常见安装目录与注册表。';
        }
      } catch (e) {
        setEnvButtons('node', false);
        installTip = '检测 Node 失败：' + esc((e && e.message) || e);
      }
    } else {
      installTip = '请在 Electron 客户端中检测本机 Node。';
    }

    var r = await probeFetch(getNodeUrl(), { method: 'GET' });
    if (r.ok && r.json && (r.json.success || r.json.data || r.json.name)) {
      var name = (r.json.data && r.json.data.name) || r.json.name || 'TkSwarm';
      var ver = (r.json.data && r.json.data.version) || r.json.version || '';
      setStatus('node', 'online', (installTip ? installTip + '<br>' : '') + '服务已连接：' + name + (ver ? ' · v' + ver : ''));
      return true;
    }
    if (r.cors) {
      setStatus('node', 'warn', (installTip ? installTip + '<br>' : '') + '端口似乎有响应，但无法读结果。');
      return null;
    }
    if (!envState.nodeInstalled) {
      setStatus('node', 'offline', installTip + '<br>可选择推荐版本后点击「安装」。');
      return false;
    }
    // 本机 Node 已装，只是业务服务未起 —— 显示「已安装」，不要「不确定」
    setStatus('node', 'installed',
      installTip + '<br>服务未启动（默认 <code>127.0.0.1:8999</code>），请部署并启动代码包。');
    return false;
  }

  async function checkBit() {
    setStatus('bit', 'checking', '正在检测比特浏览器…');
    var installTip = '';
    envState.bitInstalled = false;
    var base = getBitUrl();

    if (DESK && DESK.detectBit) {
      try {
        var info = await DESK.detectBit({
          bitApiUrl: base,
          hintPath: localStorage.getItem(LS.bitPath) || ''
        });
        envState.bitInstalled = !!(info && info.installed);
        setEnvButtons('bit', envState.bitInstalled);
        if (info && info.installed) {
          if (info.path) localStorage.setItem(LS.bitPath, info.path);
          installTip = '已安装比特浏览器'
            + (info.version ? ' v' + info.version : '')
            + (info.path ? '<br><code>' + esc(info.path) + '</code>' : (info.source === 'api' ? '<br>（通过本地 API 确认已安装）' : ''))
            + (info.source ? '<br><span class="muted">检测来源：' + esc(info.source) + '</span>' : '');
        } else {
          installTip = '未检测到比特浏览器。已检查常见目录、开始菜单、注册表与进程。<br>可点「指定已安装位置」手动选择 BitBrowser.exe；或先启动比特并确认本地 API 端口。';
        }
      } catch (e) {
        setEnvButtons('bit', false);
        installTip = '检测比特失败：' + esc((e && e.message) || e);
      }
    }

    var r = await probeFetch(base + '/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (r.ok && r.json && (r.json.success === true || r.json.success === 'true' || r.json.data != null)) {
      envState.bitInstalled = true;
      setEnvButtons('bit', true);
      setStatus('bit', 'online', (installTip ? installTip + '<br>' : '') + '本地 API 在线 <code>' + esc(base) + '</code>');
      return true;
    }
    if (r.ok) {
      envState.bitInstalled = true;
      setEnvButtons('bit', true);
      setStatus('bit', 'online', (installTip ? installTip + '<br>' : '') + '本地 API 有响应（HTTP ' + r.status + '）');
      return true;
    }
    if (r.cors) {
      envState.bitInstalled = true;
      setEnvButtons('bit', true);
      setStatus('bit', 'warn', (installTip ? installTip + '<br>' : '') + '端口有响应，但无法确认详情。');
      return null;
    }
    if (!envState.bitInstalled) {
      setStatus('bit', 'offline', installTip + '<br>可选择版本安装，或「选择安装包安装」。');
      return false;
    }
    // 已安装但本地 API 未开 —— 显示「已安装」
    setStatus('bit', 'installed',
      installTip + '<br>请启动比特并开启本地 API <code>' + esc(base) + '</code>');
    return false;
  }

  async function runEnvAction(kind, action) {
    if (!DESK || !DESK.isElectron) {
      toast('请在桌面客户端中操作', 'error');
      return;
    }
    if (envState.busy) {
      toast('正在执行其他安装任务', 'error');
      return;
    }
    envState.busy = true;
    setEnvButtons('node', envState.nodeInstalled);
    setEnvButtons('bit', envState.bitInstalled);
    var off = DESK.onEnvProgress ? DESK.onEnvProgress(function (p) {
      showEnvProgress((p && p.message) || '处理中…');
    }) : null;
    try {
      if (kind === 'node' && action === 'install') {
        var nv = getSelectedEnvVersion('node-ver-select', nodeVersionList());
        if (!nv) throw new Error('请选择 Node 版本');
        await DESK.installNode(nv);
        toast('Node.js 安装流程已完成', 'ok');
      } else if (kind === 'node' && action === 'uninstall') {
        if (DESK.showConfirm) {
          var okNode = await DESK.showConfirm({
            title: '卸载 Node.js',
            message: '将按本机安装方式卸载当前 Node（nvm 或官方安装包）。',
            detail: '若使用 nvm，仅卸载当前版本，其他版本仍保留。官方 MSI 会弹出 UAC。',
            buttons: ['取消', '继续卸载'],
            confirmIndex: 1
          });
          if (!okNode) return;
        }
        var nodeUn = await DESK.uninstallNode();
        if (nodeUn && nodeUn.method === 'nvm' && nodeUn.currentVersion) {
          toast('已卸载 v' + nodeUn.removedVersion + '，当前仍可用 v' + nodeUn.currentVersion, 'ok');
        } else if (nodeUn && nodeUn.method === 'nvm') {
          toast('已卸载 Node.js v' + (nodeUn.removedVersion || ''), 'ok');
        } else {
          toast('Node.js 已卸载', 'ok');
        }
      } else if (kind === 'bit' && action === 'install') {
        var bv = getSelectedEnvVersion('bit-ver-select', bitVersionList());
        if (!bv) throw new Error('请选择比特版本');
        if (!bv.downloadUrl && !bv.winUrl && !bv.macUrl) {
          throw new Error('该版本暂无安装包直链，请在运营后台「环境安装包」上传/填写链接并发布');
        }
        await DESK.installBit({ version: bv });
        toast('比特安装流程已完成', 'ok');
      } else if (kind === 'bit' && action === 'uninstall') {
        if (DESK.showConfirm) {
          var okUn = await DESK.showConfirm({
            title: '卸载比特浏览器',
            message: '将结束比特进程并启动官方卸载程序。',
            detail: '若弹出 UAC 请点「是」。卸载窗口里请点完成/卸载，不要直接关掉。',
            buttons: ['取消', '继续卸载'],
            confirmIndex: 1
          });
          if (!okUn) return;
        }
        await DESK.uninstallBit();
        toast('比特浏览器已卸载', 'ok');
      } else if (kind === 'bit' && action === 'local') {
        var file = await DESK.pickInstallerFile();
        if (!file) return;
        var bv2 = getSelectedEnvVersion('bit-ver-select', bitVersionList());
        await DESK.installBit({ version: bv2, localFile: file });
        toast('已启动本地安装包', 'ok');
      }
      // 安装后 PATH 可能尚未刷新，稍等再检
      await new Promise(function (r) { setTimeout(r, 1200); });
      await refreshEnvInstallState();
      await Promise.all([checkNode(), checkBit()]);
    } catch (err) {
      toast((err && err.message) || String(err), 'error');
      await refreshEnvInstallState();
      await Promise.all([checkNode(), checkBit()]);
    } finally {
      if (typeof off === 'function') off();
      envState.busy = false;
      showProgress(false);
      setEnvButtons('node', envState.nodeInstalled);
      setEnvButtons('bit', envState.bitInstalled);
    }
  }

  function getAuthToken() {
    return localStorage.getItem(LS.token) || '';
  }

  function setAuthSession(token, user) {
    if (token) localStorage.setItem(LS.token, token);
    else localStorage.removeItem(LS.token);
    if (user) {
      authUser = user;
      try { localStorage.setItem(LS.user, JSON.stringify(user)); } catch (e) { /* ignore */ }
    } else {
      authUser = null;
      localStorage.removeItem(LS.user);
    }
    renderUserChip();
  }

  function clearAuthSession() {
    setAuthSession('', null);
  }

  function loadCachedUser() {
    try {
      var raw = localStorage.getItem(LS.user);
      if (raw) authUser = JSON.parse(raw);
    } catch (e) {
      authUser = null;
    }
  }

  function renderUserChip() {
    var chip = $('user-chip');
    var btn = $('btn-logout');
    var name = (authUser && (authUser.nickname || authUser.username)) || '';
    if (chip) {
      if (name) {
        var initial = String(name).trim().charAt(0).toUpperCase() || 'U';
        chip.hidden = false;
        chip.innerHTML =
          '<span class="user-chip-avatar" aria-hidden="true">' + esc(initial) + '</span>'
          + '<span class="user-chip-meta">'
          + '<span class="user-chip-label">已登录</span>'
          + '<span class="user-chip-name">' + esc(name) + '</span>'
          + '</span>';
        chip.title = name;
      } else {
        chip.hidden = true;
        chip.innerHTML = '';
        chip.removeAttribute('title');
      }
    }
    if (btn) btn.hidden = !getAuthToken();
  }

  function showLoginGate(msg) {
    var gate = $('login-gate');
    var shell = $('app-shell');
    if (gate) gate.hidden = false;
    if (shell) shell.hidden = true;
    var err = $('login-error');
    if (err) {
      if (msg) {
        err.hidden = false;
        err.textContent = msg;
      } else {
        err.hidden = true;
        err.textContent = '';
      }
    }
    var remembered = localStorage.getItem(LS.rememberUser) || '';
    if ($('login-username') && !$('login-username').value && remembered) {
      $('login-username').value = remembered;
    }
  }

  function showApp() {
    var gate = $('login-gate');
    var shell = $('app-shell');
    if (gate) gate.hidden = true;
    if (shell) shell.hidden = false;
    renderUserChip();
  }

  function getNodeBase() {
    var health = getNodeUrl();
    var m = String(health || '').match(/^(https?:\/\/[^/]+)/i);
    return (m && m[1]) || 'http://127.0.0.1:8999';
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function waitNodeReady(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 50000);
    while (Date.now() < deadline) {
      try {
        var res = await fetch(getNodeUrl(), { cache: 'no-store' });
        if (res.ok) return true;
      } catch (e) { /* retry */ }
      await sleep(900);
    }
    return false;
  }

  async function openNodeWithLoginToken() {
    var token = getAuthToken();
    var base = getNodeBase();
    var url = base + '/';
    if (token) url = base + '/?loginToken=' + encodeURIComponent(token);
    var ready = await waitNodeReady(50000);
    if (!ready) {
      toast('服务启动较慢，仍尝试打开页面…', 'warn');
    }
    openExternal(url);
  }

  async function apiGet(path) {
    var url = getApiBase() + '/api' + path;
    var headers = { Accept: 'application/json' };
    var token = getAuthToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await fetch(url, { cache: 'no-store', headers: headers });
    var json = await res.json().catch(function () { return { success: false, message: '响应无效' }; });
    if (!res.ok || !json.success) throw new Error(json.message || ('请求失败 HTTP ' + res.status));
    return json.data;
  }

  async function apiPost(path, body) {
    var url = getApiBase() + '/api' + path;
    var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    var token = getAuthToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: headers,
      body: JSON.stringify(body || {})
    });
    var json = await res.json().catch(function () { return { success: false, message: '响应无效' }; });
    if (!res.ok || !json.success) throw new Error(json.message || ('请求失败 HTTP ' + res.status));
    return json.data;
  }

  async function tryRestoreAuth() {
    try {
      var st = await apiGet('/auth/status');
      if (st && st.authEnabled === false) {
        loadCachedUser();
        return true;
      }
      if (!getAuthToken()) return false;
      if (st && st.authenticated) {
        authUser = st.user || authUser;
        if (st.user) {
          try { localStorage.setItem(LS.user, JSON.stringify(st.user)); } catch (e) { /* ignore */ }
        }
        return true;
      }
      clearAuthSession();
      return false;
    } catch (e) {
      if (getAuthToken()) {
        loadCachedUser();
        return true;
      }
      return false;
    }
  }

  async function doLogin(username, password, rememberMe) {
    var data = await apiPost('/auth/login', {
      username: username,
      password: password,
      rememberMe: !!rememberMe
    });
    if (!data || !data.token) throw new Error('登录成功但未返回令牌');
    setAuthSession(data.token, data.user || { username: username });
    if (rememberMe) localStorage.setItem(LS.rememberUser, username);
    else localStorage.removeItem(LS.rememberUser);
    return data;
  }

  async function doLogout() {
    try { await apiPost('/auth/logout', {}); } catch (e) { /* ignore */ }
    clearAuthSession();
    showLoginGate();
    toast('已退出登录', 'ok');
  }

  var currentPage = 'home';
  var docsState = { cats: [], catId: 0, docs: [], docId: 0 };

  function showPage(page) {
    currentPage = page || 'home';
    ['home', 'docs', 'ticket'].forEach(function (p) {
      var el = $('page-' + p);
      if (el) el.hidden = p !== currentPage;
    });
    document.querySelectorAll('#app-nav .nav-link').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-page') === currentPage);
    });
    if (currentPage === 'docs') loadDocsPage();
  }

  function simpleMarkdown(text) {
    var s = esc(text || '');
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function renderDocsCats() {
    var host = $('docs-cats');
    if (!host) return;
    var cats = docsState.cats || [];
    var html = '<button type="button" class="docs-cat-btn' + (!docsState.catId ? ' active' : '') + '" data-cat="0">全部</button>';
    html += cats.map(function (c) {
      return '<button type="button" class="docs-cat-btn' + (String(docsState.catId) === String(c.id) ? ' active' : '') + '" data-cat="' + c.id + '">' + esc(c.name) + '</button>';
    }).join('');
    host.innerHTML = html || '<div class="muted docs-loading">暂无分类</div>';
    host.querySelectorAll('.docs-cat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        docsState.catId = Number(btn.getAttribute('data-cat') || 0);
        docsState.docId = 0;
        renderDocsCats();
        loadDocsList();
      });
    });
  }

  function renderDocsList() {
    var host = $('docs-main');
    if (!host) return;
    var docs = docsState.docs || [];
    if (!docs.length) {
      host.innerHTML = '<div class="muted docs-loading">该分类下暂无文档</div>';
      return;
    }
    host.innerHTML = docs.map(function (d) {
      return '<button type="button" class="docs-list-item" data-doc="' + d.id + '">'
        + '<div class="docs-list-title">' + esc(d.title) + '</div>'
        + '<p class="docs-list-summary">' + esc(d.summary || '点击查看详情') + '</p>'
        + '</button>';
    }).join('');
    host.querySelectorAll('.docs-list-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openDocDetail(Number(btn.getAttribute('data-doc')));
      });
    });
  }

  async function openDocDetail(id) {
    var host = $('docs-main');
    if (!host || !id) return;
    host.innerHTML = '<div class="muted docs-loading">加载中…</div>';
    try {
      var d = await apiGet('/help/docs/' + id);
      docsState.docId = id;
      host.innerHTML =
        '<button type="button" class="docs-detail-back" id="docs-back">← 返回列表</button>'
        + '<h1 class="docs-detail-title">' + esc(d.title) + '</h1>'
        + '<div class="docs-detail-meta">'
        + (d.category && d.category.name ? esc(d.category.name) + ' · ' : '')
        + '阅读 ' + (d.viewCount || 0)
        + (d.updatedAt ? ' · 更新 ' + esc(d.updatedAt) : '')
        + '</div>'
        + '<div class="docs-detail-body">' + simpleMarkdown(d.content || d.summary || '') + '</div>';
      var back = $('docs-back');
      if (back) back.addEventListener('click', function () {
        docsState.docId = 0;
        renderDocsList();
      });
    } catch (err) {
      host.innerHTML = '<div class="muted docs-loading">加载失败：' + esc((err && err.message) || err) + '</div>';
    }
  }

  async function loadDocsList() {
    var host = $('docs-main');
    if (host) host.innerHTML = '<div class="muted docs-loading">加载中…</div>';
    try {
      var q = docsState.catId ? ('?category_id=' + encodeURIComponent(docsState.catId)) : '';
      var data = await apiGet('/help/docs' + q);
      docsState.docs = (data && data.items) || [];
      renderDocsList();
    } catch (err) {
      if (host) host.innerHTML = '<div class="muted docs-loading">加载失败：' + esc((err && err.message) || err) + '</div>';
    }
  }

  async function loadDocsPage() {
    var catsHost = $('docs-cats');
    if (catsHost) catsHost.innerHTML = '<div class="muted docs-loading">加载中…</div>';
    try {
      var data = await apiGet('/help/categories');
      docsState.cats = (data && data.items) || [];
      renderDocsCats();
      await loadDocsList();
    } catch (err) {
      if (catsHost) catsHost.innerHTML = '<div class="muted docs-loading">加载失败：' + esc((err && err.message) || err) + '</div>';
      var main = $('docs-main');
      if (main) main.innerHTML = '<div class="muted docs-loading">请检查服务器 API 地址与网络</div>';
    }
  }

  async function submitTicket(e) {
    e.preventDefault();
    var subject = ($('ticket-subject') && $('ticket-subject').value || '').trim();
    var content = ($('ticket-content') && $('ticket-content').value || '').trim();
    if (!subject || !content) {
      toast('请填写主题与问题描述', 'error');
      return;
    }
    var btn = $('btn-ticket-submit');
    if (btn) btn.disabled = true;
    try {
      var result = await apiPost('/tickets', {
        subject: subject,
        content: content,
        contactName: ($('ticket-name') && $('ticket-name').value || '').trim(),
        contactPhone: ($('ticket-phone') && $('ticket-phone').value || '').trim(),
        contactEmail: ($('ticket-email') && $('ticket-email').value || '').trim(),
        priority: ($('ticket-priority') && $('ticket-priority').value) || 'normal',
        clientPlatform: APP.platform || '',
        clientVersion: APP.version || ''
      });
      toast((result && result.message) || '提交成功', 'ok');
      var hint = $('ticket-hint');
      if (hint) hint.textContent = result && result.ticketNo ? ('工单号：' + result.ticketNo) : '';
      if ($('ticket-form')) $('ticket-form').reset();
    } catch (err) {
      toast((err && err.message) || String(err), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function downloadUrl(relOrAbs) {
    if (!relOrAbs) return '';
    if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
    return getApiBase() + relOrAbs;
  }

  var catalogById = {};

  function renderLatest(item) {
    var main = $('latest-main');
    var desc = $('latest-desc');
    if (!item) {
      if (main) main.textContent = '暂无已发布版本';
      if (desc) desc.textContent = '请管理员在后台「权限与系统 → 版本控制」上传并发布代码包';
      return;
    }
    if (main) {
      main.textContent = 'v' + item.version + (item.title ? ' · ' + item.title : '') + (item.isLatest ? '（最新）' : '');
    }
    if (desc) {
      var bits = [];
      if (item.fileSize) bits.push(formatBytes(item.fileSize));
      if (item.downloadCount != null) bits.push('下载 ' + item.downloadCount + ' 次');
      if (item.description) bits.push(item.description);
      desc.textContent = bits.join(' · ') || '可一键部署到本机目录';
    }
  }

  function getSelectedVersionItem() {
    var sel = $('version-select');
    if (!sel || !sel.value) return null;
    return catalogById[sel.value] || null;
  }

  function fillVersionSelect(items, preferredId) {
    var sel = $('version-select');
    catalogById = {};
    if (!sel) return;
    if (!items || !items.length) {
      sel.innerHTML = '<option value=\"\">暂无已发布版本</option>';
      renderLatest(null);
      refreshPrettySelect(sel);
      return;
    }
    var latestId = '';
    sel.innerHTML = items.map(function (v) {
      var id = String(v.id != null ? v.id : v.version);
      catalogById[id] = v;
      if (v.isLatest && !latestId) latestId = id;
      var label = 'v' + v.version
        + (v.title ? ' · ' + v.title : '')
        + (v.isLatest ? '（最新）' : '')
        + (v.fileSize ? ' · ' + formatBytes(v.fileSize) : '');
      return '<option value=\"' + esc(id) + '\">' + esc(label) + '</option>';
    }).join('');
    var pick = preferredId && catalogById[preferredId]
      ? preferredId
      : (latestId || String(items[0].id != null ? items[0].id : items[0].version));
    sel.value = pick;
    renderLatest(catalogById[pick] || items[0]);
    refreshPrettySelect(sel);
  }

  async function loadVersions() {
    var channel = getChannel();
    var chSel = $('channel-select');
    if (chSel) chSel.value = channel;
    refreshPrettySelect(chSel);
    updatePills();
    var verSel = $('version-select');
    if (verSel) {
      verSel.innerHTML = '<option value=\"\">加载版本…</option>';
      refreshPrettySelect(verSel);
    }
    try {
      var catalog = await apiGet('/client-versions/catalog?channel=' + encodeURIComponent(channel));
      var items = (catalog && catalog.items) || (Array.isArray(catalog) ? catalog : []);
      var preferred = null;
      try {
        var latest = await apiGet('/client-versions/latest?channel=' + encodeURIComponent(channel));
        if (latest && latest.id != null) preferred = String(latest.id);
      } catch (e) { /* ignore */ }
      fillVersionSelect(items, preferred);
    } catch (err) {
      fillVersionSelect([]);
      toast(err.message || '加载版本失败', 'error');
    }
  }

  async function ensureEnvReadyForDeploy() {
    if (DESK && DESK.detectNode && DESK.detectBit) {
      try {
        var nodeInfo = await DESK.detectNode();
        envState.nodeInstalled = !!(nodeInfo && nodeInfo.installed);
      } catch (e) {
        envState.nodeInstalled = false;
      }
      try {
        var bitInfo = await DESK.detectBit({ bitApiUrl: getBitUrl(), hintPath: localStorage.getItem(LS.bitPath) || '' });
        envState.bitInstalled = !!(bitInfo && bitInfo.installed);
      } catch (e2) {
        envState.bitInstalled = false;
      }
      setEnvButtons('node', envState.nodeInstalled);
      setEnvButtons('bit', envState.bitInstalled);
    }
    var missing = [];
    if (!envState.nodeInstalled) missing.push('Node.js');
    if (!envState.bitInstalled) missing.push('比特浏览器');
    if (missing.length) {
      toast('请先安装好环境再部署：' + missing.join('、'), 'error');
      return false;
    }
    return true;
  }

  async function deploySelected() {
    if (!(await ensureEnvReadyForDeploy())) return;
    var item = getSelectedVersionItem();
    if (!item || !item.downloadUrl) {
      toast('请先选择要部署的版本号', 'error');
      return;
    }
    var dir = getDeployDir();
    if (!dir) {
      toast('请先选择部署目录', 'error');
      return;
    }
    setDeployDir(dir);

    if (DESK && DESK.inspectDeployDir) {
      var info = await DESK.inspectDeployDir(dir);
      if (info && info.deployed) {
        var confirmed = await DESK.showConfirm({
          title: '已部署过程序',
          message: '当前目录已部署过代码，是否确认删除原程序？',
          detail: '将清空部署目录中的业务代码（node_modules、源码等）。\n不会删除本安装助手的 EXE / Mac 应用。\n删除成功后，请再次点击「一键部署」安装所选版本。',
          buttons: ['取消', '确认删除'],
          confirmIndex: 1,
          cancelId: 0,
          defaultId: 1
        });
        if (!confirmed) return;
        try {
          showProgress(true, '正在删除原程序…', 30);
          await DESK.clearDeployDir(dir);
          showProgress(false);
          toast('原程序已删除成功，请再次点击「一键部署」安装所选版本', 'ok');
        } catch (err) {
          showProgress(false);
          toast((err && err.message) || String(err), 'error');
        }
        return;
      }
    }

    // 目录干净：按所选版本下载 → npm install → 启动
    await deployByUrl(downloadUrl(item.downloadUrl), item.version, {
      npmInstall: true,
      startAfter: true
    });
  }

  async function downloadSelectedBrowser() {
    var item = getSelectedVersionItem();
    if (!item || !item.downloadUrl) {
      toast('请先选择版本', 'error');
      return;
    }
    openExternal(downloadUrl(item.downloadUrl));
    toast('已在浏览器开始下载 v' + item.version, 'ok');
  }

  async function deployByUrl(url, version, opts) {
    opts = opts || {};
    if (!DESK || typeof DESK.deployPackage !== 'function') {
      openExternal(url);
      toast('当前非 Electron 环境，已改为浏览器下载', 'warn');
      return;
    }
    if (busy) {
      toast('正在执行其他任务', 'error');
      return;
    }
    var dir = getDeployDir();
    if (!dir) {
      toast('请先选择部署目录', 'error');
      return;
    }
    setDeployDir(dir);
    busy = true;
    showProgress(true, '开始部署所选版本…', 5);
    var off = DESK.onDeployProgress ? DESK.onDeployProgress(function (p) {
      showProgress(true, (p && p.message) || '处理中…', (p && p.percent) || 0);
    }) : null;
    try {
      var doNpm = opts.npmInstall != null ? !!opts.npmInstall : true;
      var doStart = opts.startAfter != null ? !!opts.startAfter : true;
      var result = await DESK.deployPackage({
        url: url,
        version: version || 'latest',
        deployDir: dir,
        apiBase: getApiBase(),
        npmInstall: doNpm,
        startAfter: doStart
      });
      toast('部署完成：' + (result && result.deployDir ? result.deployDir : dir), 'ok');
      await checkNode();
      if (doStart) {
        try { await openNodeWithLoginToken(); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      toast((err && err.message) || String(err), 'error');
    } finally {
      if (typeof off === 'function') off();
      busy = false;
      showProgress(false);
    }
  }

  async function recheckAll() {
    await Promise.all([checkNode(), checkBit()]);
    toast('环境检测完成', 'ok');
  }

  function openSettings() {
    $('api-base-input').value = getApiBase();
    $('node-url-input').value = getNodeUrl();
    $('bit-url-input').value = getBitUrl();
    $('settings-modal').hidden = false;
  }

  function closeSettings() {
    $('settings-modal').hidden = true;
  }

  function bind() {
    document.querySelectorAll('#app-nav .nav-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showPage(btn.getAttribute('data-page') || 'home');
      });
    });
    $('ticket-form') && $('ticket-form').addEventListener('submit', submitTicket);

    $('login-form') && $('login-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var username = ($('login-username') && $('login-username').value || '').trim();
      var password = ($('login-password') && $('login-password').value || '');
      var remember = !!($('login-remember') && $('login-remember').checked);
      var btn = $('btn-login');
      var err = $('login-error');
      if (!username || !password) {
        if (err) { err.hidden = false; err.textContent = '请输入账号和密码'; }
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
      if (err) err.hidden = true;
      try {
        await doLogin(username, password, remember);
        if ($('login-password')) $('login-password').value = '';
        showApp();
        toast('登录成功', 'ok');
        updatePills();
        recheckAll();
        loadVersions();
        loadEnvCatalogs().catch(function () { /* ignore */ });
      } catch (ex) {
        if (err) {
          err.hidden = false;
          err.textContent = (ex && ex.message) || '登录失败';
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '登录'; }
      }
    });
    $('btn-login-api') && $('btn-login-api').addEventListener('click', openSettings);
    $('btn-logout') && $('btn-logout').addEventListener('click', function () { doLogout(); });

    $('btn-recheck') && $('btn-recheck').addEventListener('click', function () { recheckAll(); });
    $('btn-settings') && $('btn-settings').addEventListener('click', openSettings);
    $('btn-close-settings') && $('btn-close-settings').addEventListener('click', closeSettings);
    $('settings-modal') && $('settings-modal').addEventListener('click', function (e) {
      if (e.target === $('settings-modal')) closeSettings();
    });
    $('btn-reset-settings') && $('btn-reset-settings').addEventListener('click', function () {
      localStorage.removeItem(LS.api);
      localStorage.removeItem(LS.node);
      localStorage.removeItem(LS.bit);
      openSettings();
      toast('已恢复默认', 'ok');
      loadEnvCatalogs().catch(function () { /* ignore */ });
    });
    $('settings-form') && $('settings-form').addEventListener('submit', function (e) {
      e.preventDefault();
      localStorage.setItem(LS.api, stripSlash($('api-base-input').value));
      localStorage.setItem(LS.node, stripSlash($('node-url-input').value));
      localStorage.setItem(LS.bit, stripSlash($('bit-url-input').value));
      closeSettings();
      updatePills();
      toast('设置已保存', 'ok');
      recheckAll();
      loadVersions();
      loadEnvCatalogs().catch(function () { /* ignore */ });
      if (currentPage === 'docs') loadDocsPage();
    });

    $('btn-install-node') && $('btn-install-node').addEventListener('click', function () {
      runEnvAction('node', 'install');
    });
    $('btn-uninstall-node') && $('btn-uninstall-node').addEventListener('click', function () {
      runEnvAction('node', 'uninstall');
    });
    $('btn-open-node-site') && $('btn-open-node-site').addEventListener('click', function () {
      openExternal((CFG.downloads && CFG.downloads.node) || 'https://nodejs.org/');
    });
    $('btn-install-bit') && $('btn-install-bit').addEventListener('click', function () {
      runEnvAction('bit', 'install');
    });
    $('btn-uninstall-bit') && $('btn-uninstall-bit').addEventListener('click', function () {
      runEnvAction('bit', 'uninstall');
    });
    $('btn-open-bit-site') && $('btn-open-bit-site').addEventListener('click', function () {
      openExternal((CFG.downloads && CFG.downloads.bit) || 'https://www.bitbrowser.cn/');
    });
    $('btn-bit-local') && $('btn-bit-local').addEventListener('click', function () {
      runEnvAction('bit', 'local');
    });
    $('btn-bit-locate') && $('btn-bit-locate').addEventListener('click', async function () {
      if (!DESK || !DESK.pickBitExe) {
        toast('请在桌面客户端中操作', 'error');
        return;
      }
      try {
        var file = await DESK.pickBitExe();
        if (!file) return;
        localStorage.setItem(LS.bitPath, file);
        toast('已记录比特路径，正在重新检测…', 'ok');
        await checkBit();
      } catch (err) {
        toast((err && err.message) || String(err), 'error');
      }
    });
    $('btn-browse-dir') && $('btn-browse-dir').addEventListener('click', async function () {
      if (!DESK || !DESK.pickDirectory) {
        toast('请在 Electron 客户端中选择目录', 'error');
        return;
      }
      var dir = await DESK.pickDirectory(getDeployDir() || APP.defaultDeployDir);
      if (dir) {
        setDeployDir(dir);
        toast('已选择部署目录', 'ok');
      }
    });
    $('deploy-dir-input') && $('deploy-dir-input').addEventListener('change', function () {
      setDeployDir(getDeployDir());
    });

    $('btn-refresh-versions') && $('btn-refresh-versions').addEventListener('click', function () { loadVersions(); });
    $('btn-deploy-latest') && $('btn-deploy-latest').addEventListener('click', function () { deploySelected(); });
    $('btn-start-only') && $('btn-start-only').addEventListener('click', async function () {
      if (!(await ensureEnvReadyForDeploy())) return;
      var dir = getDeployDir();
      if (!dir) {
        toast('请先选择部署目录', 'error');
        return;
      }
      if (!DESK || !DESK.startService) {
        toast('请在 Electron 客户端中启动', 'error');
        return;
      }
      if (!getAuthToken()) {
        showLoginGate('请先登录后再启动');
        return;
      }
      try {
        var info = await DESK.startService(dir);
        toast('已启动（' + ((info && info.method) || 'service') + '）', 'ok');
        setTimeout(checkNode, 2500);
        await openNodeWithLoginToken();
      } catch (err) {
        toast((err && err.message) || String(err), 'error');
      }
    });
    $('channel-select') && $('channel-select').addEventListener('change', function (e) {
      localStorage.setItem(LS.channel, e.target.value || 'stable');
      loadVersions();
    });
    $('version-select') && $('version-select').addEventListener('change', function () {
      renderLatest(getSelectedVersionItem());
    });
  }

  async function boot() {
    if (DESK && DESK.getAppInfo) {
      try {
        var info = await DESK.getAppInfo();
        APP.platform = info.platform || APP.platform;
        APP.version = info.version || APP.version;
        APP.defaultDeployDir = info.defaultDeployDir || '';
      } catch (e) { /* ignore */ }
    } else {
      APP.platform = navigator.platform && /mac/i.test(navigator.platform) ? 'darwin' : 'win32';
    }

    var savedDir = localStorage.getItem(LS.deploy) || APP.defaultDeployDir || '';
    if ($('deploy-dir-input') && savedDir) $('deploy-dir-input').value = savedDir;

    var foot = $('footer-ver');
    if (foot) foot.textContent = (CFG.appName || 'Dyy TKSwarm Client') + ' v' + APP.version;

    fillEnvVersionSelect('node-ver-select', CFG.nodeVersions || []);
    fillEnvVersionSelect('bit-ver-select', CFG.bitVersions || []);
    enhanceAllSelects();

    bind();
    loadCachedUser();

    var ok = await tryRestoreAuth();
    if (!ok) {
      showLoginGate();
      return;
    }

    showApp();
    updatePills();
    recheckAll();
    loadVersions();
    loadEnvCatalogs().catch(function () { /* ignore */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
