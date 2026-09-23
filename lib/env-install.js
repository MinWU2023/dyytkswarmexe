'use strict';

/**
 * Node.js / 比特浏览器：真实检测、安装、卸载（Windows 为主，macOS 兼容）
 * 关键点：打包后 Electron 的 process.env.PATH 常不完整，不能只靠 where/which。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn, execFile, exec } = require('child_process');
const { createWriteStream } = require('fs');

function getElectronShell() {
  try {
    return require('electron').shell;
  } catch (_) {
    return null;
  }
}

function runCmd(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, opts.env || {}),
      shell: !!opts.shell,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout && child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error((stderr || stdout || ('exit ' + code)).trim().slice(0, 1200)));
    });
  });
}

function runPs(script, env) {
  return runCmd(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { shell: false, env }
  );
}

function elevateAndWait(filePath, args) {
  const fp = String(filePath).replace(/'/g, "''");
  const argList = (args || []).map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = argList
    ? `Start-Process -FilePath '${fp}' -ArgumentList @(${argList}) -Verb RunAs -Wait`
    : `Start-Process -FilePath '${fp}' -Verb RunAs -Wait`;
  return runPs(ps);
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
          return get(new URL(res.headers.location, target).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('下载失败 HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)));
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
      req.setTimeout(180000, () => {
        req.destroy();
        fail(new Error('下载超时'));
      });
    };
    get(url, 0);
  });
}

function execOut(bin, args, env) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      windowsHide: true,
      timeout: 10000,
      env: Object.assign({}, process.env, env || {}),
      maxBuffer: 2 * 1024 * 1024
    }, (err, stdout) => {
      if (err) resolve('');
      else resolve(String(stdout || '').trim());
    });
  });
}

function execShellOut(command, env) {
  return new Promise((resolve) => {
    exec(command, {
      windowsHide: true,
      timeout: 12000,
      env: Object.assign({}, process.env, env || {}),
      maxBuffer: 2 * 1024 * 1024
    }, (err, stdout) => {
      if (err) resolve('');
      else resolve(String(stdout || '').trim());
    });
  });
}

function uniqPaths(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const n = path.resolve(String(p));
    const key = process.platform === 'win32' ? n.toLowerCase() : n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** 从 Windows 注册表读取用户/系统 PATH 与 NVM 变量（打包后 process.env 常缺这些） */
async function readWindowsEnvFromRegistry() {
  if (process.platform !== 'win32') {
    return { pathDirs: [], nvmHome: '', nvmSymlink: '' };
  }
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$sys = [Environment]::GetEnvironmentVariable('Path','Machine')
$user = [Environment]::GetEnvironmentVariable('Path','User')
$nvmHome = [Environment]::GetEnvironmentVariable('NVM_HOME','User')
if (-not $nvmHome) { $nvmHome = [Environment]::GetEnvironmentVariable('NVM_HOME','Machine') }
$nvmLink = [Environment]::GetEnvironmentVariable('NVM_SYMLINK','User')
if (-not $nvmLink) { $nvmLink = [Environment]::GetEnvironmentVariable('NVM_SYMLINK','Machine') }
Write-Output ('PATH=' + $sys + ';' + $user)
Write-Output ('NVM_HOME=' + $nvmHome)
Write-Output ('NVM_SYMLINK=' + $nvmLink)
`;
  try {
    const r = await runPs(script);
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let pathStr = '';
    let nvmHome = '';
    let nvmSymlink = '';
    for (const line of lines) {
      if (line.startsWith('PATH=')) pathStr = line.slice(5);
      else if (line.startsWith('NVM_HOME=')) nvmHome = line.slice(9);
      else if (line.startsWith('NVM_SYMLINK=')) nvmSymlink = line.slice(12);
    }
    const pathDirs = pathStr.split(';').map((s) => s.trim()).filter(Boolean);
    return { pathDirs, nvmHome, nvmSymlink };
  } catch (_) {
    return { pathDirs: [], nvmHome: '', nvmSymlink: '' };
  }
}

async function buildEnrichedEnv() {
  const env = Object.assign({}, process.env);
  const extras = [];

  if (process.platform === 'win32') {
    const reg = await readWindowsEnvFromRegistry();
    const nvmHome = reg.nvmHome || env.NVM_HOME || '';
    const nvmSymlink = reg.nvmSymlink || env.NVM_SYMLINK || '';
    if (nvmHome) env.NVM_HOME = nvmHome;
    if (nvmSymlink) env.NVM_SYMLINK = nvmSymlink;

    extras.push(
      nvmSymlink,
      nvmHome,
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      'D:\\Applications\\nodejs',
      'C:\\nodejs',
      'C:\\Program Files\\nodejs'
    );
    extras.push(...(reg.pathDirs || []));
  } else {
    extras.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(os.homedir(), '.nvm', 'current', 'bin'),
      path.join(os.homedir(), '.fnm', 'current', 'bin'),
      path.join(os.homedir(), '.volta', 'bin')
    );
  }

  const current = String(env.PATH || env.Path || '').split(path.delimiter);
  const merged = uniqPaths([...extras, ...current]).filter((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
  // 也保留不存在但在注册表 PATH 里的目录（node 可能稍后装上）
  const soft = uniqPaths([...extras, ...current]);
  env.PATH = soft.join(path.delimiter);
  env.Path = env.PATH;
  return { env, pathDirs: merged, softPathDirs: soft };
}

function nodeCandidateFiles(extraDirs) {
  const isWin = process.platform === 'win32';
  const names = isWin ? ['node.exe'] : ['node'];
  const dirs = [];
  const push = (d) => { if (d) dirs.push(d); };

  push(process.env.NVM_SYMLINK);
  push(process.env.NVM_HOME);
  if (isWin) {
    push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
    push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'));
    push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'));
    push('D:\\Applications\\nodejs');
    push('C:\\nodejs');
    push(path.join(os.homedir(), 'scoop', 'apps', 'nodejs', 'current'));
    push(path.join(os.homedir(), 'scoop', 'shims'));
  } else {
    push('/usr/local/bin');
    push('/opt/homebrew/bin');
    push('/usr/bin');
    push(path.join(os.homedir(), '.nvm', 'current', 'bin'));
    push(path.join(os.homedir(), '.fnm', 'current', 'bin'));
    push(path.join(os.homedir(), '.volta', 'bin'));
  }
  for (const d of extraDirs || []) push(d);

  const files = [];
  for (const d of uniqPaths(dirs)) {
    for (const n of names) {
      files.push(path.join(d, n));
    }
  }
  return uniqPaths(files);
}

async function probeNodeBinary(nodePath, env) {
  if (!nodePath || !fs.existsSync(nodePath)) return null;
  try {
    const st = fs.statSync(nodePath);
    if (!st.isFile() && !(process.platform !== 'win32' && !st.isDirectory())) {
      // allow symlink file
    }
  } catch (_) {
    return null;
  }
  // 跳过明显是编辑器内置 helper 的 node（除非没有别的）
  const lower = nodePath.toLowerCase();
  const isEditorHelper = /\\cursor\\|\\vscode\\|\\code\\.*helpers\\|\/cursor\/|\/visual studio code\//i.test(lower)
    && /helpers[\\/]+node/i.test(lower);

  const verRaw = await execOut(nodePath, ['-v'], env);
  const version = String(verRaw || '').replace(/^v/i, '').trim();
  if (!version) return null;

  const dir = path.dirname(nodePath);
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmPath = path.join(dir, npmName);
  const npm = fs.existsSync(npmPath) ? npmPath : null;

  return {
    installed: true,
    version,
    path: nodePath,
    npm: !!npm,
    npmPath: npm,
    editorHelper: isEditorHelper
  };
}

async function detectNodeFromRegistry() {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $keys |
  Where-Object { $_.DisplayName -like 'Node.js*' } |
  Select-Object -First 3 DisplayName, DisplayVersion, InstallLocation, DisplayIcon |
  ForEach-Object {
    $loc = [string]$_.InstallLocation
    $icon = [string]$_.DisplayIcon
    $ver = [string]$_.DisplayVersion
    Write-Output ('LOC=' + $loc)
    Write-Output ('ICON=' + $icon)
    Write-Output ('VER=' + $ver)
  }
`;
  try {
    const r = await runPs(script);
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim());
    let loc = '';
    let icon = '';
    let ver = '';
    for (const line of lines) {
      if (line.startsWith('LOC=')) loc = line.slice(4);
      else if (line.startsWith('ICON=')) icon = line.slice(5);
      else if (line.startsWith('VER=')) ver = line.slice(4);
    }
    const candidates = [];
    if (loc) candidates.push(path.join(loc, 'node.exe'));
    if (icon) {
      const cleaned = icon.replace(/,.*$/, '').replace(/^"|"$/g, '').trim();
      if (/node\.exe$/i.test(cleaned)) candidates.push(cleaned);
      else if (cleaned) candidates.push(path.join(path.dirname(cleaned), 'node.exe'));
    }
    return { candidates: uniqPaths(candidates), versionHint: ver || null };
  } catch (_) {
    return { candidates: [], versionHint: null };
  }
}

async function detectNode() {
  const { env, softPathDirs } = await buildEnrichedEnv();
  const results = [];

  // 1) 常见路径 + NVM + 注册表 PATH 目录
  for (const file of nodeCandidateFiles(softPathDirs)) {
    const hit = await probeNodeBinary(file, env);
    if (hit) results.push(hit);
  }

  // 2) 注册表卸载项
  const regNode = await detectNodeFromRegistry();
  if (regNode && regNode.candidates) {
    for (const file of regNode.candidates) {
      const hit = await probeNodeBinary(file, env);
      if (hit) results.push(hit);
    }
  }

  // 3) where / which（使用补全后的 PATH）
  if (process.platform === 'win32') {
    const whereOut = await execShellOut('where.exe node', env);
    for (const line of whereOut.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      const hit = await probeNodeBinary(p, env);
      if (hit) results.push(hit);
    }
  } else {
    const whichOut = await execShellOut('command -v node || which node', env);
    if (whichOut) {
      const hit = await probeNodeBinary(whichOut.split(/\r?\n/)[0].trim(), env);
      if (hit) results.push(hit);
    }
  }

  if (!results.length) {
    return { installed: false, version: null, path: null, npm: false, npmPath: null };
  }

  // 优先非编辑器内置 node
  results.sort((a, b) => Number(a.editorHelper) - Number(b.editorHelper));
  const best = results[0];
  return {
    installed: true,
    version: best.version,
    path: best.path,
    npm: best.npm,
    npmPath: best.npmPath || null
  };
}

async function resolveNodeTools() {
  const info = await detectNode();
  const { env } = await buildEnrichedEnv();
  if (!info.installed) {
    return { ok: false, env, node: null, npm: null, info };
  }
  let npm = info.npmPath;
  if (!npm) {
    const dir = path.dirname(info.path);
    const cand = process.platform === 'win32'
      ? [path.join(dir, 'npm.cmd'), path.join(dir, 'npm.exe')]
      : [path.join(dir, 'npm')];
    npm = cand.find((p) => fs.existsSync(p)) || null;
  }
  if (!npm && process.platform === 'win32') {
    const w = await execShellOut('where.exe npm.cmd', env);
    npm = w.split(/\r?\n/).map((s) => s.trim()).find((p) => p && fs.existsSync(p)) || null;
  }
  return { ok: true, env, node: info.path, npm, info };
}

function bitExeNames() {
  return [
    'BitBrowser.exe',
    'bitbrowser.exe',
    'BitBrowserPro.exe',
    '比特浏览器.exe'
  ];
}

function bitSearchRoots() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const home = os.homedir();
  return uniqPaths([
    path.join(local, 'BitBrowser'),
    path.join(local, 'Programs', 'BitBrowser'),
    path.join(local, 'Programs'),
    path.join(local, '比特浏览器'),
    path.join(roaming, 'BitBrowser'),
    path.join(pf, 'BitBrowser'),
    path.join(pf86, 'BitBrowser'),
    path.join(pf, '比特浏览器'),
    path.join(home, 'AppData', 'Local', 'BitBrowser'),
    'C:\\BitBrowser',
    'D:\\BitBrowser',
    'E:\\BitBrowser',
    'D:\\Program Files\\BitBrowser',
    'D:\\Programs\\BitBrowser',
    '/Applications/BitBrowser.app',
    '/Applications/比特浏览器.app'
  ]);
}

function findBitInDir(dir, depth, maxDepth) {
  if (!dir || depth > maxDepth) return null;
  let st;
  try { st = fs.statSync(dir); } catch (_) { return null; }
  if (!st.isDirectory()) return null;

  for (const name of bitExeNames()) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  // mac .app
  if (process.platform === 'darwin' && dir.endsWith('.app') && fs.existsSync(dir)) {
    return dir;
  }

  if (depth >= maxDepth) return null;
  let children = [];
  try { children = fs.readdirSync(dir); } catch (_) { return null; }
  for (const name of children) {
    if (/node_modules|Cache|GPUCache|Code Cache|Crashpad|\.git/i.test(name)) continue;
    const full = path.join(dir, name);
    let cst;
    try { cst = fs.statSync(full); } catch (_) { continue; }
    if (!cst.isDirectory()) continue;
    if (/bit|比特/i.test(name)) {
      const hit = findBitInDir(full, depth + 1, maxDepth);
      if (hit) return hit;
    }
  }
  // 浅层再扫一层子目录里的 exe
  if (depth === 0) {
    for (const name of children) {
      const full = path.join(dir, name);
      let cst;
      try { cst = fs.statSync(full); } catch (_) { continue; }
      if (!cst.isDirectory()) continue;
      for (const exeName of bitExeNames()) {
        const exe = path.join(full, exeName);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

function findBitBrowserExeQuick() {
  for (const root of bitSearchRoots()) {
    if (root.endsWith('.app') && fs.existsSync(root)) return root;
    for (const name of bitExeNames()) {
      const full = path.join(root, name);
      if (fs.existsSync(full)) return full;
    }
    const hit = findBitInDir(root, 0, 2);
    if (hit) return hit;
  }
  return null;
}

async function detectBitFromRegistry() {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $keys |
  Where-Object { $_.DisplayName -match 'BitBrowser|Bit Browser|比特' } |
  Select-Object -First 5 DisplayName, DisplayVersion, InstallLocation, DisplayIcon |
  ForEach-Object {
    Write-Output ('NAME=' + [string]$_.DisplayName)
    Write-Output ('VER=' + [string]$_.DisplayVersion)
    Write-Output ('LOC=' + [string]$_.InstallLocation)
    Write-Output ('ICON=' + [string]$_.DisplayIcon)
    Write-Output '---'
  }
`;
  try {
    const r = await runPs(script);
    const blocks = String(r.stdout || '').split('---').map((b) => b.trim()).filter(Boolean);
    const out = [];
    for (const block of blocks) {
      let loc = '';
      let icon = '';
      let ver = '';
      let name = '';
      for (const line of block.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('NAME=')) name = t.slice(5);
        else if (t.startsWith('VER=')) ver = t.slice(4);
        else if (t.startsWith('LOC=')) loc = t.slice(4);
        else if (t.startsWith('ICON=')) icon = t.slice(5);
      }
      const candidates = [];
      if (loc) {
        for (const n of bitExeNames()) candidates.push(path.join(loc, n));
        candidates.push(loc);
      }
      if (icon) {
        const cleaned = icon.replace(/,.*$/, '').replace(/^"|"$/g, '').trim();
        if (cleaned) candidates.push(cleaned);
      }
      out.push({ name, version: ver || null, candidates: uniqPaths(candidates) });
    }
    return out;
  } catch (_) {
    return [];
  }
}

async function detectBitFromShortcuts() {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$dirs = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
)
$sh = New-Object -ComObject WScript.Shell
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem -Path $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match 'BitBrowser|比特浏览器|比特指紋|比特指纹' -or
      ($_.Name -match '比特' -and $_.Name -notmatch 'bit-|32-bit|64-bit|ODBC')
    } |
    Select-Object -First 20 |
    ForEach-Object {
      try {
        $t = $sh.CreateShortcut($_.FullName).TargetPath
        if ($t) { Write-Output $t }
      } catch {}
    }
}
`;
  try {
    const r = await runPs(script);
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of lines) {
      if (!p || !fs.existsSync(p)) continue;
      // 必须是比特可执行文件，排除系统/ODBC 等误匹配
      if (!isLikelyBitExe(p)) continue;
      return p;
    }
  } catch (_) {}
  return null;
}

function isLikelyBitExe(filePath) {
  if (!filePath) return false;
  const lower = String(filePath).toLowerCase();
  if (/\\windows\\|\\system32\\|\\syswow64\\|odbcad/i.test(lower)) return false;
  const base = path.basename(filePath);
  if (/^bitbrowser(pro)?\.exe$/i.test(base)) return true;
  if (/比特浏览器\.exe$/i.test(base)) return true;
  // 安装目录名含 BitBrowser / 比特，且是 exe
  if (/\.exe$/i.test(base) && /\\bitbrowser\\|\\比特浏览器\\|\\bit browser\\/i.test(lower)) return true;
  if (process.platform === 'darwin' && /\.app$/i.test(filePath) && /bitbrowser|比特/i.test(base)) return true;
  return false;
}

async function detectBitFromProcess() {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(BitBrowser|bitbrowser|BitBrowserPro)' } |
  Select-Object -First 5 ExecutablePath |
  ForEach-Object { if ($_.ExecutablePath) { Write-Output $_.ExecutablePath } }
`;
  try {
    const r = await runPs(script);
    const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((p) => p && isLikelyBitExe(p));
    return line || null;
  } catch (_) {
    return null;
  }
}

async function probeBitApi(bitApiUrl) {
  const base = String(bitApiUrl || 'http://127.0.0.1:54345').replace(/\/+$/, '');
  const urls = [`${base}/health`, `${base}/browser/list`, base];
  for (const url of urls) {
    try {
      const ok = await new Promise((resolve) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.request(url, { method: url.endsWith('/health') ? 'POST' : 'GET', timeout: 2500 }, (res) => {
          res.resume();
          resolve(res.statusCode > 0 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
        if (url.endsWith('/health')) {
          req.setHeader('Content-Type', 'application/json');
          req.write('{}');
        }
        req.end();
      });
      if (ok) return { online: true, url: base };
    } catch (_) {}
  }
  return { online: false, url: base };
}

async function readFileVersion(exe) {
  if (process.platform !== 'win32' || !exe) return null;
  try {
    const r = await runPs(`(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
    return (r.stdout || '').trim() || null;
  } catch (_) {
    return null;
  }
}

async function detectBit(options) {
  const opts = options || {};
  let exe = findBitBrowserExeQuick();
  let version = null;
  let source = exe ? 'path' : null;

  if (!exe) {
    const regItems = await detectBitFromRegistry();
    for (const item of regItems || []) {
      for (const c of item.candidates || []) {
        if (c && fs.existsSync(c) && isLikelyBitExe(c)) {
          exe = c;
          version = item.version || null;
          source = 'registry';
          break;
        }
        if (c && fs.existsSync(c)) {
          const hit = findBitInDir(c, 0, 3);
          if (hit && isLikelyBitExe(hit)) {
            exe = hit;
            version = item.version || null;
            source = 'registry';
            break;
          }
        }
      }
      if (exe) break;
    }
  }

  if (!exe) {
    const fromShortcut = await detectBitFromShortcuts();
    if (fromShortcut && isLikelyBitExe(fromShortcut)) {
      exe = fromShortcut;
      source = 'shortcut';
    }
  }

  if (!exe) {
    const fromProc = await detectBitFromProcess();
    if (fromProc && isLikelyBitExe(fromProc)) {
      exe = fromProc;
      source = 'process';
    }
  }

  const api = await probeBitApi(opts.bitApiUrl);
  if (!exe && api.online) {
    // API 在线说明本机一定装了且已启动
    return {
      installed: true,
      running: true,
      version: null,
      path: null,
      source: 'api',
      apiOnline: true,
      apiUrl: api.url
    };
  }

  if (exe && !version) {
    version = await readFileVersion(exe);
  }

  return {
    installed: !!exe || api.online,
    running: api.online,
    version,
    path: exe,
    source,
    apiOnline: api.online,
    apiUrl: api.url
  };
}

function findBitBrowserExe() {
  return findBitBrowserExeQuick();
}

async function installNode(versionMeta, cacheDir, onProgress) {
  if (!versionMeta || !versionMeta.id) throw new Error('请选择 Node.js 版本');
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const url = isWin
    ? versionMeta.winUrl
    : isMac
      ? versionMeta.macUrl
      : null;
  if (!url) throw new Error('当前系统暂无该 Node 版本的安装包直链');

  ensureDir(cacheDir);
  const ext = isWin ? '.msi' : '.pkg';
  const dest = path.join(cacheDir, `node-${versionMeta.id}${ext}`);
  onProgress && onProgress({ stage: 'download', percent: 0, message: `正在下载 Node.js ${versionMeta.id}…` });
  await downloadToFile(url, dest, (p) => {
    onProgress && onProgress({ stage: 'download', percent: p, message: `正在下载 Node.js ${versionMeta.id}… ${p}%` });
  });

  onProgress && onProgress({ stage: 'install', percent: 0, message: '正在安装 Node.js（可能弹出 UAC）…' });
  if (isWin) {
    await elevateAndWait('msiexec.exe', ['/i', dest, '/passive', 'ADDLOCAL=ALL']);
  } else if (isMac) {
    await runCmd('osascript', [
      '-e',
      `do shell script "installer -pkg '${dest.replace(/'/g, "'\\''")}' -target /" with administrator privileges`
    ], { shell: false });
  } else {
    throw new Error('当前平台请手动安装 Node.js');
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: 'Node.js 安装完成，请稍候点「重新检测」' });
  return { ok: true, file: dest };
}

async function uninstallNode(onProgress) {
  onProgress && onProgress({ stage: 'uninstall', percent: 0, message: '正在卸载 Node.js…' });
  if (process.platform === 'win32') {
    const ps = `
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$app = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'Node.js*' } |
  Select-Object -First 1
if (-not $app) { throw '未找到 Node.js 卸载项（若用 nvm 安装请用 nvm uninstall）' }
$u = $app.UninstallString
if ($u -match 'MsiExec\\.exe.*?\\{([0-9A-Fa-f-]+)\\}') {
  Start-Process msiexec.exe -ArgumentList @('/x', ('{'+$Matches[1]+'}'), '/passive') -Verb RunAs -Wait
} elseif ($u) {
  Start-Process cmd.exe -ArgumentList @('/c', $u) -Verb RunAs -Wait
} else { throw '无法解析卸载命令' }
`;
    await runPs(ps);
  } else if (process.platform === 'darwin') {
    throw new Error('macOS 请使用系统方式卸载 Node（或 brew uninstall node）');
  } else {
    throw new Error('当前平台暂不支持自动卸载 Node');
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: 'Node.js 已卸载' });
  return { ok: true };
}

async function waitForDownload(matcher, timeoutMs, onProgress) {
  const dirs = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), '下载'),
    appDownloadsFallback()
  ].filter((d) => d && fs.existsSync(d));

  const start = Date.now();
  const seen = new Set();
  for (const d of dirs) {
    try {
      for (const name of fs.readdirSync(d)) {
        seen.add(path.join(d, name));
      }
    } catch (_) {}
  }

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    const left = Math.max(0, Math.round((timeoutMs - elapsed) / 1000));
    onProgress && onProgress({
      stage: 'wait-download',
      percent: Math.min(90, Math.round((elapsed / timeoutMs) * 90)),
      message: `等待安装包下载完成（剩余约 ${left}s）…`
    });
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(d); } catch (_) { continue; }
      for (const name of names) {
        const full = path.join(d, name);
        if (seen.has(full)) continue;
        if (!matcher(name, full)) continue;
        if (/\.(crdownload|tmp|partial)$/i.test(name)) continue;
        try {
          const st = fs.statSync(full);
          if (!st.isFile() || st.size < 1024 * 1024) continue;
        } catch (_) { continue; }
        return full;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

function appDownloadsFallback() {
  try {
    const { app } = require('electron');
    return app.getPath('downloads');
  } catch (_) {
    return null;
  }
}

async function installBit(versionMeta, options, onProgress) {
  const opts = options || {};
  const isWin = process.platform === 'win32';
  let installer = opts.localFile || null;

  if (!installer && versionMeta && versionMeta.winUrl && isWin) {
    const cacheDir = opts.cacheDir;
    ensureDir(cacheDir);
    const dest = path.join(cacheDir, `bitbrowser-${versionMeta.id}.exe`);
    onProgress && onProgress({ stage: 'download', percent: 0, message: `正在下载比特 ${versionMeta.id}…` });
    await downloadToFile(versionMeta.winUrl, dest, (p) => {
      onProgress && onProgress({ stage: 'download', percent: p, message: `正在下载比特 ${versionMeta.id}… ${p}%` });
    });
    installer = dest;
  }

  if (!installer) {
    const page = (versionMeta && versionMeta.downloadPage) || 'https://www.bitbrowser.cn/download';
    onProgress && onProgress({
      stage: 'open-page',
      percent: 5,
      message: '比特官网无稳定直链，已打开下载页，请开始下载…'
    });
    const elShell = getElectronShell();
    if (!elShell) throw new Error('无法打开浏览器，请手动访问比特下载页');
    await elShell.openExternal(page);
    installer = await waitForDownload((name) => {
      return /\.(exe|dmg|pkg|zip)$/i.test(name) && /bit|比特/i.test(name);
    }, opts.waitMs || 180000, onProgress);
    if (!installer) {
      throw new Error('未在下载目录检测到比特安装包。请下载完成后使用「选择安装包安装」。');
    }
  }

  onProgress && onProgress({ stage: 'install', percent: 95, message: '正在启动比特安装程序（可能弹出 UAC）…' });
  if (isWin) {
    await elevateAndWait(installer, []);
  } else {
    const elShell2 = getElectronShell();
    if (elShell2) await elShell2.openPath(installer);
    else throw new Error('请手动打开安装包：' + installer);
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: '已启动安装，完成后请点「重新检测」' });
  return { ok: true, file: installer };
}

async function uninstallBit(onProgress) {
  onProgress && onProgress({ stage: 'uninstall', percent: 0, message: '正在卸载比特浏览器…' });
  let exe = findBitBrowserExeQuick();
  if (!exe) {
    const info = await detectBit();
    exe = info.path;
  }
  if (!exe) throw new Error('未找到已安装的比特浏览器');

  if (process.platform === 'win32') {
    const dir = path.dirname(exe);
    const candidates = [
      path.join(dir, 'Uninstall.exe'),
      path.join(dir, 'uninstall.exe'),
      path.join(dir, 'Uninstall BitBrowser.exe'),
      path.join(dir, 'unins000.exe')
    ];
    let un = candidates.find((p) => fs.existsSync(p));
    if (!un) {
      const ps = `
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$app = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'BitBrowser|比特' } |
  Select-Object -First 1
if (-not $app) { throw '未找到比特卸载项' }
$u = [string]$app.UninstallString
if (-not $u) { throw '无卸载命令' }
Write-Output $u
`;
      const r = await runPs(ps);
      const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) throw new Error('无法解析比特卸载命令');
      await runPs(`Start-Process cmd.exe -ArgumentList @('/c', '${line.replace(/'/g, "''")}') -Verb RunAs -Wait`);
    } else {
      await elevateAndWait(un, ['/S']);
    }
  } else if (process.platform === 'darwin') {
    const appPath = fs.existsSync('/Applications/BitBrowser.app')
      ? '/Applications/BitBrowser.app'
      : (fs.existsSync('/Applications/比特浏览器.app') ? '/Applications/比特浏览器.app' : exe);
    await runCmd('rm', ['-rf', appPath], { shell: false });
  } else {
    throw new Error('当前平台暂不支持自动卸载比特');
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: '比特浏览器已卸载' });
  return { ok: true };
}

module.exports = {
  detectNode,
  detectBit,
  resolveNodeTools,
  buildEnrichedEnv,
  installNode,
  uninstallNode,
  installBit,
  uninstallBit,
  findBitBrowserExe,
  downloadToFile
};
