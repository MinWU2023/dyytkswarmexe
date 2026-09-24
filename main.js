'use strict';

const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { createWriteStream } = require('fs');
const envInstall = require('./lib/env-install');

/** @type {BrowserWindow | null} */
let mainWindow = null;

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deploy-progress', payload);
  }
}

function sendEnvProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('env-progress', payload);
  }
}

function runCmd(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, opts.env || {}),
      shell: opts.shell !== false && process.platform === 'win32',
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout && child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error((stderr || stdout || ('exit ' + code)).trim().slice(0, 800)));
    });
  });
}

function commandExists(name) {
  return envInstall.resolveNodeTools().then((tools) => {
    if (name === 'node') return !!(tools && tools.ok && tools.node);
    if (name === 'npm') return !!(tools && tools.ok && tools.npm);
    return false;
  }).catch(() => false);
}

function defaultDeployDir() {
  return path.join(os.homedir(), 'TkSwarm');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function downloadToFile(url, destFile, onProgress) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destFile));
    const file = createWriteStream(destFile);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { file.close(); } catch (_) {}
      try { fs.unlinkSync(destFile); } catch (_) {}
      reject(err);
    };

    const get = (target, redirects) => {
      if (redirects > 8) return fail(new Error('下载重定向过多'));
      const lib = target.startsWith('https') ? https : http;
      const req = lib.get(target, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          return get(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('下载失败 HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.min(99, Math.round((received / total) * 100)));
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (settled) return;
            settled = true;
            if (onProgress) onProgress(100);
            resolve(destFile);
          });
        });
      });
      req.on('error', fail);
      req.setTimeout(120000, () => {
        req.destroy();
        fail(new Error('下载超时'));
      });
    };

    get(url, 0);
  });
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  const tmp = path.join(os.tmpdir(), 'tkswarm-extract-' + Date.now());
  ensureDir(tmp);
  try {
    if (process.platform === 'win32') {
      const ps = [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`
      ];
      await runCmd('powershell', ps, { shell: false });
    } else {
      await runCmd('unzip', ['-o', zipPath, '-d', tmp], { shell: false });
    }

    const entries = fs.readdirSync(tmp, { withFileTypes: true });
    let src = tmp;
    if (entries.length === 1 && entries[0].isDirectory()) {
      const inner = path.join(tmp, entries[0].name);
      if (fs.existsSync(path.join(inner, 'package.json')) || fs.existsSync(path.join(inner, 'start.bat'))) {
        src = inner;
      }
    }

    // 保留用户 data / .env / node_modules
    for (const name of fs.readdirSync(destDir)) {
      if (name === 'data' || name === '.env' || name === 'node_modules') continue;
      fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
    }
    for (const name of fs.readdirSync(src)) {
      fs.cpSync(path.join(src, name), path.join(destDir, name), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ensureDotEnv(dir, apiBase) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) return;
  const body = [
    `TKSWARM_API_BASE=${apiBase || 'http://tkswarm-api.dyyweb.com'}`,
    'TKSWARM_PORT=8999',
    'TKSWARM_HOST=127.0.0.1',
    'BIT_API_URL=http://127.0.0.1:54345',
    ''
  ].join('\n');
  fs.writeFileSync(envPath, body, 'utf8');
}

function writeDeployMarker(dir, version) {
  try {
    fs.writeFileSync(
      path.join(dir, '.tkswarm-deployed'),
      JSON.stringify({ version: version || '', at: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (_) {}
}

/** 防止误删本安装助手 EXE / Mac .app */
function assertSafeToClearDeployDir(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('部署目录无效');
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return { ok: true, resolved };
  }
  const st = fs.statSync(resolved);
  if (!st.isDirectory()) throw new Error('部署路径不是文件夹');

  const execPath = path.resolve(process.execPath);
  const execDir = path.dirname(execPath);
  const appPath = path.resolve(app.getAppPath());

  const norm = (p) => path.resolve(p).toLowerCase();
  const r = norm(resolved);
  const eDir = norm(execDir);
  const aPath = norm(appPath);

  // 不能是助手可执行文件所在目录，也不能是其父目录去删整个安装树
  if (app.isPackaged) {
    if (r === eDir || eDir.startsWith(r + path.sep.toLowerCase()) || eDir.startsWith(r + '\\') || eDir.startsWith(r + '/')) {
      throw new Error('不能删除安装助手所在目录，请更换部署目录');
    }
    if (r === aPath || aPath.startsWith(r + path.sep.toLowerCase())) {
      throw new Error('不能删除安装助手应用目录，请更换部署目录');
    }
  }

  // 目录内若直接是本助手 exe / .app，拒绝
  const dangerousNames = [
    'Dyy TKSwarm Client.exe',
    'TKSwarm Client.exe',
    'Dyy TKSwarm Client.app',
    'TKSwarm Client.app',
    'electron.exe'
  ];
  for (const name of dangerousNames) {
    if (fs.existsSync(path.join(resolved, name))) {
      throw new Error('该目录包含桌面客户端程序，已拒绝删除以免误删安装助手');
    }
  }

  // 拒绝系统关键路径
  const home = path.resolve(os.homedir()).toLowerCase();
  if (r === home || r === 'c:\\' || r === 'c:' || r === '/' || r === '/users' || r === '/home') {
    throw new Error('部署目录过于靠近系统目录，已拒绝清空');
  }

  return { ok: true, resolved };
}

function inspectDeployDir(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return { deployed: false, path: dir || '', markers: [] };
  }
  const markers = [];
  const checks = [
    ['package.json', 'package.json'],
    ['start.bat', 'start.bat'],
    ['start.sh', 'start.sh'],
    ['.tkswarm-deployed', '.tkswarm-deployed'],
    ['src/server.js', path.join('src', 'server.js')],
    ['node_modules', 'node_modules']
  ];
  for (const [label, rel] of checks) {
    if (fs.existsSync(path.join(dir, rel))) markers.push(label);
  }
  const deployed = markers.includes('package.json')
    || markers.includes('.tkswarm-deployed')
    || markers.includes('start.bat')
    || markers.includes('start.sh');
  return { deployed, path: path.resolve(dir), markers };
}

function clearDeployDir(dir) {
  const { resolved } = assertSafeToClearDeployDir(dir);
  if (!fs.existsSync(resolved)) {
    return { ok: true, cleared: false, path: resolved };
  }
  // 只清空目录内容，不删除部署目录本身；不触碰助手安装路径
  const entries = fs.readdirSync(resolved);
  for (const name of entries) {
    // 双保险：绝不删除这些文件名
    if (/^(Dyy\s+)?TKSwarm Client\.(exe|app)$/i.test(name) || /^electron\.exe$/i.test(name)) {
      continue;
    }
    fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
  }
  return { ok: true, cleared: true, path: resolved };
}

async function npmInstall(dir) {
  const tools = await envInstall.resolveNodeTools();
  if (!tools.ok || !tools.npm) {
    throw new Error('未找到 npm。请确认已安装 Node.js（含 npm），或安装后重启本客户端再试');
  }
  const npmCmd = tools.npm;
  // Windows 上 npm.cmd 需 shell；传入补全后的 PATH，避免子进程找不到 node
  await runCmd(npmCmd, ['install'], {
    cwd: dir,
    shell: process.platform === 'win32',
    env: tools.env
  });
}

async function startService(dir) {
  const tools = await envInstall.resolveNodeTools();
  const bat = path.join(dir, 'start.bat');
  const sh = path.join(dir, 'start.sh');
  const enrichedEnv = Object.assign({}, process.env, (tools && tools.env) || {}, {
    TKSWARM_NO_BROWSER: '1'
  });
  if (process.platform === 'win32' && fs.existsSync(bat)) {
    spawn('cmd.exe', ['/c', 'start', '""', bat], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: enrichedEnv
    }).unref();
    return { method: 'start.bat' };
  }
  if (fs.existsSync(sh)) {
    spawn('bash', [sh], { cwd: dir, detached: true, stdio: 'ignore', env: enrichedEnv }).unref();
    return { method: 'start.sh' };
  }
  const npmCmd = (tools && tools.npm)
    || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  spawn(npmCmd, ['start'], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    env: enrichedEnv
  }).unref();
  return { method: 'npm start' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#e8f4ff',
    autoHideMenuBar: true,
    title: 'Dyy TkSwarm Client',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:')) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('open-external', async (_e, url) => {
    if (!isHttpUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('get-app-info', async () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    arch: process.arch,
    isElectron: true,
    defaultDeployDir: defaultDeployDir()
  }));

  ipcMain.handle('check-commands', async () => ({
    node: await commandExists('node'),
    npm: await commandExists('npm')
  }));

  ipcMain.handle('pick-directory', async (_e, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择代码部署目录',
      defaultPath: defaultPath || defaultDeployDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('open-path', async (_e, target) => {
    if (!target || typeof target !== 'string') return false;
    ensureDir(target);
    const err = await shell.openPath(target);
    return !err;
  });

  ipcMain.handle('path-exists', async (_e, target) => {
    try {
      return fs.existsSync(target);
    } catch (_) {
      return false;
    }
  });

  ipcMain.handle('has-start-script', async (_e, dir) => {
    if (!dir) return false;
    return fs.existsSync(path.join(dir, 'start.bat'))
      || fs.existsSync(path.join(dir, 'start.sh'))
      || fs.existsSync(path.join(dir, 'package.json'));
  });

  ipcMain.handle('inspect-deploy-dir', async (_e, dir) => {
    return inspectDeployDir(dir);
  });

  ipcMain.handle('clear-deploy-dir', async (_e, dir) => {
    return clearDeployDir(dir);
  });

  ipcMain.handle('show-confirm', async (_e, options) => {
    const opts = options || {};
    const result = await dialog.showMessageBox(mainWindow, {
      type: opts.type || 'question',
      title: opts.title || '确认',
      message: opts.message || '是否确认？',
      detail: opts.detail || '',
      buttons: opts.buttons || ['取消', '确认'],
      defaultId: opts.defaultId != null ? opts.defaultId : 1,
      cancelId: opts.cancelId != null ? opts.cancelId : 0,
      noLink: true
    });
    // 约定：最后一个按钮为确认（index = buttons.length - 1），或 response === confirmIndex
    const confirmIndex = opts.confirmIndex != null ? opts.confirmIndex : ((opts.buttons || ['取消', '确认']).length - 1);
    return result.response === confirmIndex;
  });

  ipcMain.handle('show-message', async (_e, options) => {
    const opts = options || {};
    await dialog.showMessageBox(mainWindow, {
      type: opts.type || 'info',
      title: opts.title || '提示',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['知道了'],
      defaultId: 0,
      noLink: true
    });
    return true;
  });

  ipcMain.handle('pick-and-run-installer', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择比特浏览器安装包',
      filters: [
        { name: '安装包', extensions: ['exe', 'dmg', 'pkg', 'zip'] },
        { name: '全部', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    await shell.openPath(file);
    return file;
  });

  ipcMain.handle('deploy-package', async (_e, options) => {
    const opts = options || {};
    const url = opts.url;
    const deployDir = opts.deployDir || defaultDeployDir();
    const apiBase = opts.apiBase || 'http://tkswarm-api.dyyweb.com';
    const doNpm = opts.npmInstall !== false;
    const doStart = !!opts.startAfter;
    const version = opts.version || 'package';

    if (!isHttpUrl(url)) throw new Error('无效的下载地址');
    if (!deployDir) throw new Error('请先选择部署目录');

    ensureDir(deployDir);
    const cacheDir = path.join(app.getPath('temp'), 'TkSwarm-Client');
    ensureDir(cacheDir);
    const zipPath = path.join(cacheDir, `tkswarm-v${String(version).replace(/[^\w.-]+/g, '_')}.zip`);

    sendProgress({ stage: 'download', percent: 0, message: '正在下载代码包…' });
    await downloadToFile(url, zipPath, (p) => {
      sendProgress({ stage: 'download', percent: p, message: '正在下载代码包… ' + p + '%' });
    });

    sendProgress({ stage: 'extract', percent: 0, message: '正在解压…' });
    await extractZip(zipPath, deployDir);
    ensureDotEnv(deployDir, apiBase);
    writeDeployMarker(deployDir, version);

    if (doNpm) {
      const tools = await envInstall.resolveNodeTools();
      if (!tools.ok || !tools.npm) {
        throw new Error('未找到 npm，请先安装 Node.js（PATH/nvm 需可被检测到）后重新打开本客户端');
      }
      sendProgress({ stage: 'npm', percent: 0, message: '正在 npm install（可能需几分钟）…' });
      await npmInstall(deployDir);
    }

    let startInfo = null;
    if (doStart) {
      sendProgress({ stage: 'start', percent: 0, message: '正在启动服务…' });
      startInfo = await startService(deployDir);
    }

    sendProgress({ stage: 'done', percent: 100, message: '部署完成' });
    return {
      ok: true,
      deployDir,
      zipPath,
      startInfo
    };
  });

  ipcMain.handle('start-service', async (_e, dir) => {
    if (!dir || !fs.existsSync(dir)) throw new Error('部署目录不存在');
    return startService(dir);
  });

  ipcMain.handle('detect-node', async () => envInstall.detectNode());
  ipcMain.handle('detect-bit', async (_e, options) => envInstall.detectBit(options || {}));
  ipcMain.handle('resolve-node-tools', async () => {
    const tools = await envInstall.resolveNodeTools();
    return {
      ok: tools.ok,
      node: tools.node,
      npm: tools.npm,
      info: tools.info
    };
  });

  ipcMain.handle('install-node', async (_e, versionMeta) => {
    const cacheDir = path.join(app.getPath('temp'), 'TkSwarm-Client', 'installers');
    return envInstall.installNode(versionMeta, cacheDir, (p) => sendEnvProgress(Object.assign({ target: 'node' }, p)));
  });

  ipcMain.handle('uninstall-node', async () => {
    return envInstall.uninstallNode((p) => sendEnvProgress(Object.assign({ target: 'node' }, p)));
  });

  ipcMain.handle('install-bit', async (_e, payload) => {
    const cacheDir = path.join(app.getPath('temp'), 'TkSwarm-Client', 'installers');
    const versionMeta = (payload && payload.version) || payload || {};
    return envInstall.installBit(versionMeta, {
      cacheDir,
      localFile: payload && payload.localFile,
      waitMs: (payload && payload.waitMs) || 180000
    }, (p) => sendEnvProgress(Object.assign({ target: 'bit' }, p)));
  });

  ipcMain.handle('uninstall-bit', async () => {
    return envInstall.uninstallBit((p) => sendEnvProgress(Object.assign({ target: 'bit' }, p)));
  });

  ipcMain.handle('launch-bit', async (_e, exePath) => {
    return envInstall.launchBit(exePath);
  });

  ipcMain.handle('is-bit-running', async () => {
    return envInstall.isBitProcessRunning();
  });

  ipcMain.handle('pick-installer-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择安装包',
      filters: [
        { name: '安装包', extensions: ['exe', 'msi', 'dmg', 'pkg', 'zip'] },
        { name: '全部', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pick-bit-exe', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择已安装的比特浏览器程序（BitBrowser.exe）',
      filters: [
        { name: '可执行文件', extensions: ['exe'] },
        { name: '全部', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
