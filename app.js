(function () {
  'use strict';

  var CFG = window.__TKSWARM_EXE_CONFIG__ || {};
  var DESK = window.tkswarmDesktop || null;
  var LS = {
    api: 'tkswarm_exe_api_base',
    node: 'tkswarm_exe_node_url',
    bit: 'tkswarm_exe_bit_url',
    channel: 'tkswarm_exe_channel',
    deploy: 'tkswarm_exe_deploy_dir'
  };
  var APP = { platform: 'unknown', version: CFG.appVersion || '1.0.0', defaultDeployDir: '' };
  var busy = false;

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
    return stripSlash(localStorage.getItem(LS.node) || CFG.nodeHealthUrl || 'http://127.0.0.1:8400/api/health');
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

  function setStatus(key, state, meta) {
    var badge = $('status-' + key);
    var metaEl = $('meta-' + key);
    if (badge) {
      badge.className = 'status ' + state;
      badge.textContent = state === 'online' ? '已就绪' : state === 'offline' ? '未检测到' : state === 'warn' ? '不确定' : '检测中';
    }
    if (metaEl) metaEl.innerHTML = meta || '';
  }

  function updatePills() {
    var apiPill = $('pill-api');
    var chPill = $('pill-channel');
    var platPill = $('pill-platform');
    if (apiPill) {
      try {
        apiPill.textContent = 'API · ' + new URL(getApiBase()).host;
      } catch (e) {
        apiPill.textContent = 'API · ' + getApiBase();
      }
    }
    if (chPill) chPill.textContent = '通道 · ' + getChannel();
    if (platPill) {
      var label = APP.platform === 'darwin' ? 'macOS' : APP.platform === 'win32' ? 'Windows' : APP.platform;
      platPill.textContent = '平台 · ' + label;
    }
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

  async function checkNode() {
    setStatus('node', 'checking', '正在探测 <code>' + getNodeUrl() + '</code>…');
    var cmd = DESK && DESK.checkCommands ? await DESK.checkCommands() : { node: null, npm: null };
    var r = await probeFetch(getNodeUrl(), { method: 'GET' });
    if (r.ok && r.json && (r.json.success || r.json.data || r.json.name)) {
      var name = (r.json.data && r.json.data.name) || r.json.name || 'TkSwarm';
      var ver = (r.json.data && r.json.data.version) || r.json.version || '';
      setStatus('node', 'online', '已连接：' + name + (ver ? ' · v' + ver : '') + '<br>健康检查通过');
      return true;
    }
    if (r.cors) {
      setStatus('node', 'warn', '端口似乎有响应，但无法读结果。<br>若已启动 Node 服务可视为就绪。');
      return null;
    }
    var hint = cmd.node === false
      ? '本机未检测到 node 命令。请先安装 Node.js。'
      : '未检测到本机 Node 服务（默认 <code>127.0.0.1:8400</code>）。安装 Node 后请部署并启动代码包。';
    setStatus('node', 'offline', hint);
    return false;
  }

  async function checkBit() {
    var base = getBitUrl();
    setStatus('bit', 'checking', '正在探测 <code>' + base + '/health</code>…');
    var r = await probeFetch(base + '/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (r.ok && r.json && (r.json.success === true || r.json.success === 'true' || r.json.data != null)) {
      setStatus('bit', 'online', '比特本地 API 在线<br>地址 <code>' + base + '</code>');
      return true;
    }
    if (r.ok) {
      setStatus('bit', 'online', '比特本地 API 有响应（HTTP ' + r.status + '）<br>地址 <code>' + base + '</code>');
      return true;
    }
    if (r.cors) {
      setStatus('bit', 'warn', '本地端口有响应，但无法确认详情。<br>请确认比特已启动并开启本地 API。');
      return null;
    }
    setStatus('bit', 'offline', '未检测到比特浏览器本地 API。<br>请安装并启动比特，API 默认 <code>127.0.0.1:54345</code>');
    return false;
  }

  async function apiGet(path) {
    var url = getApiBase() + '/api' + path;
    var res = await fetch(url, { cache: 'no-store' });
    var json = await res.json().catch(function () { return { success: false, message: '响应无效' }; });
    if (!res.ok || !json.success) throw new Error(json.message || ('请求失败 HTTP ' + res.status));
    return json.data;
  }

  function downloadUrl(relOrAbs) {
    if (!relOrAbs) return '';
    if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
    return getApiBase() + relOrAbs;
  }

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

  function renderCatalog(items) {
    var tbody = $('version-tbody');
    if (!tbody) return;
    if (!items || !items.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无已发布版本</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (v) {
      var latest = v.isLatest ? '<span class="badge-latest">最新</span>' : '';
      var url = downloadUrl(v.downloadUrl);
      return (
        '<tr>' +
          '<td><b>v' + esc(v.version) + '</b>' + latest + '</td>' +
          '<td>' + esc(v.title || '-') + '</td>' +
          '<td>' + formatBytes(v.fileSize || 0) + '</td>' +
          '<td>' + (v.downloadCount || 0) + '</td>' +
          '<td class="acts">' +
            '<button type="button" class="btn soft tiny" data-deploy="' + esc(url) + '" data-ver="' + esc(v.version) + '">部署</button> ' +
            '<button type="button" class="btn ghost tiny" data-dl="' + esc(url) + '">下载</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadVersions() {
    var channel = getChannel();
    var chSel = $('channel-select');
    if (chSel) chSel.value = channel;
    updatePills();
    try {
      var latest = null;
      try {
        latest = await apiGet('/client-versions/latest?channel=' + encodeURIComponent(channel));
      } catch (e) {
        latest = null;
      }
      renderLatest(latest);
      var catalog = await apiGet('/client-versions/catalog?channel=' + encodeURIComponent(channel));
      var items = (catalog && catalog.items) || (Array.isArray(catalog) ? catalog : []);
      renderCatalog(items);
    } catch (err) {
      renderLatest(null);
      var tbody = $('version-tbody');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">加载失败：' + esc(err.message) + '<br>请在「服务器」中检查 API 地址</td></tr>';
      }
      toast(err.message || '加载版本失败', 'error');
    }
  }

  async function deployByUrl(url, version) {
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
    showProgress(true, '开始部署…', 5);
    var off = DESK.onDeployProgress ? DESK.onDeployProgress(function (p) {
      showProgress(true, (p && p.message) || '处理中…', (p && p.percent) || 0);
    }) : null;
    try {
      var result = await DESK.deployPackage({
        url: url,
        version: version || 'latest',
        deployDir: dir,
        apiBase: getApiBase(),
        npmInstall: !!($('chk-npm') && $('chk-npm').checked),
        startAfter: !!($('chk-start') && $('chk-start').checked)
      });
      toast('部署完成：' + (result && result.deployDir ? result.deployDir : dir), 'ok');
      await checkNode();
    } catch (err) {
      toast((err && err.message) || String(err), 'error');
    } finally {
      if (typeof off === 'function') off();
      busy = false;
      showProgress(false);
    }
  }

  async function deployLatest() {
    try {
      var item = await apiGet('/client-versions/latest?channel=' + encodeURIComponent(getChannel()));
      if (!item || !item.downloadUrl) throw new Error('暂无最新版本');
      await deployByUrl(downloadUrl(item.downloadUrl), item.version);
    } catch (err) {
      toast(err.message || '部署失败', 'error');
    }
  }

  async function downloadLatestBrowser() {
    try {
      var item = await apiGet('/client-versions/latest?channel=' + encodeURIComponent(getChannel()));
      if (!item || !item.downloadUrl) throw new Error('暂无最新版本');
      openExternal(downloadUrl(item.downloadUrl));
      toast('已在浏览器开始下载 v' + item.version, 'ok');
    } catch (err) {
      toast(err.message || '下载失败', 'error');
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

  function nodeInstallUrl() {
    var d = CFG.downloads || {};
    if (APP.platform === 'darwin') return d.nodeMac || d.node;
    return d.nodeMsi || d.node;
  }

  function bind() {
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
    });

    $('btn-install-node') && $('btn-install-node').addEventListener('click', function () {
      openExternal(nodeInstallUrl());
    });
    $('btn-open-node-site') && $('btn-open-node-site').addEventListener('click', function () {
      openExternal((CFG.downloads && CFG.downloads.node) || 'https://nodejs.org/');
    });
    $('btn-install-bit') && $('btn-install-bit').addEventListener('click', function () {
      openExternal((CFG.downloads && CFG.downloads.bitDownload) || (CFG.downloads && CFG.downloads.bit));
    });
    $('btn-open-bit-site') && $('btn-open-bit-site').addEventListener('click', function () {
      openExternal((CFG.downloads && CFG.downloads.bit) || 'https://www.bitbrowser.cn/');
    });
    $('btn-bit-local') && $('btn-bit-local').addEventListener('click', async function () {
      if (!DESK || !DESK.pickAndRunInstaller) {
        toast('请在 Electron 客户端中使用', 'error');
        return;
      }
      var file = await DESK.pickAndRunInstaller();
      if (file) toast('已打开安装包', 'ok');
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
    $('btn-open-dir') && $('btn-open-dir').addEventListener('click', async function () {
      var dir = getDeployDir();
      if (!dir) {
        toast('请先选择部署目录', 'error');
        return;
      }
      setDeployDir(dir);
      if (DESK && DESK.openPath) await DESK.openPath(dir);
      else toast(dir, 'ok');
    });
    $('deploy-dir-input') && $('deploy-dir-input').addEventListener('change', function () {
      setDeployDir(getDeployDir());
    });

    $('btn-refresh-versions') && $('btn-refresh-versions').addEventListener('click', function () { loadVersions(); });
    $('btn-deploy-latest') && $('btn-deploy-latest').addEventListener('click', function () { deployLatest(); });
    $('btn-download-only') && $('btn-download-only').addEventListener('click', function () { downloadLatestBrowser(); });
    $('btn-start-only') && $('btn-start-only').addEventListener('click', async function () {
      var dir = getDeployDir();
      if (!dir) {
        toast('请先选择部署目录', 'error');
        return;
      }
      if (!DESK || !DESK.startService) {
        toast('请在 Electron 客户端中启动', 'error');
        return;
      }
      try {
        var info = await DESK.startService(dir);
        toast('已启动（' + ((info && info.method) || 'service') + '）', 'ok');
        setTimeout(checkNode, 2500);
      } catch (err) {
        toast((err && err.message) || String(err), 'error');
      }
    });
    $('channel-select') && $('channel-select').addEventListener('change', function (e) {
      localStorage.setItem(LS.channel, e.target.value || 'stable');
      loadVersions();
    });

    $('version-tbody') && $('version-tbody').addEventListener('click', function (e) {
      var deployBtn = e.target.closest('[data-deploy]');
      if (deployBtn) {
        deployByUrl(deployBtn.getAttribute('data-deploy'), deployBtn.getAttribute('data-ver'));
        return;
      }
      var dlBtn = e.target.closest('[data-dl]');
      if (dlBtn) {
        openExternal(dlBtn.getAttribute('data-dl'));
        toast('已开始下载', 'ok');
      }
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
    if (foot) foot.textContent = (CFG.appName || 'TKSwarm Client') + ' v' + APP.version;

    var nodeBtn = $('btn-install-node');
    if (nodeBtn) {
      nodeBtn.textContent = APP.platform === 'darwin' ? '下载 Node (macOS)' : '下载 Node (Windows)';
    }

    bind();
    updatePills();
    recheckAll();
    loadVersions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
