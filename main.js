'use strict';

const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { createWriteStream } = require('fs');

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
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, [name], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
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
    'TKSWARM_PORT=8400',
    'TKSWARM_HOST=127.0.0.1',
    'BIT_API_URL=http://127.0.0.1:54345',
    ''
  ].join('\n');
  fs.writeFileSync(envPath, body, 'utf8');
}

async function npmInstall(dir) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await runCmd(npmCmd, ['install'], { cwd: dir, shell: process.platform === 'win32' });
}

async function startService(dir) {
  const bat = path.join(dir, 'start.bat');
  const sh = path.join(dir, 'start.sh');
  if (process.platform === 'win32' && fs.existsSync(bat)) {
    spawn('cmd.exe', ['/c', 'start', '""', bat], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    return { method: 'start.bat' };
  }
  if (fs.existsSync(sh)) {
    spawn('bash', [sh], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    return { method: 'start.sh' };
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  spawn(npmCmd, ['start'], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32'
  }).unref();
  return { method: 'npm start' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#e8f4ff',
    autoHideMenuBar: true,
    title: 'TKSwarm Client',
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

    if (doNpm) {
      const hasNpm = await commandExists('npm');
      if (!hasNpm) throw new Error('未找到 npm，请先安装 Node.js 并重新打开本客户端');
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
