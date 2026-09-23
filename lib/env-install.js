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
    'BitBrowser Global.exe',
    'BitBrowserCN.exe',
    'BitBrowser Soft.exe',
    '比特浏览器.exe',
    '比特指纹浏览器.exe'
  ];
}

function bitUninstallerNames() {
  return [
    'Uninstall BitBrowser Global.exe',
    'Uninstall BitBrowser.exe',
    'Uninstall.exe',
    'uninstall.exe',
    'unins000.exe',
    'Uninstall BitBrowser Global.lnk'
  ];
}

function bitSearchRoots() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const home = os.homedir();
  const roots = [
    path.join(local, 'BitBrowser'),
    path.join(local, 'BitBrowser Global'),
    path.join(local, 'BitBrowserCN'),
    path.join(local, 'Programs', 'BitBrowser'),
    path.join(local, 'Programs', 'BitBrowser Global'),
    path.join(local, 'Programs', 'BitBrowserCN'),
    path.join(local, 'Programs'),
    path.join(local, '比特浏览器'),
    path.join(local, '比特指纹浏览器'),
    path.join(roaming, 'BitBrowser'),
    path.join(roaming, 'BitBrowser Global'),
    path.join(pf, 'BitBrowser'),
    path.join(pf, 'BitBrowser Global'),
    path.join(pf, 'BitBrowserCN'),
    path.join(pf86, 'BitBrowser'),
    path.join(pf86, 'BitBrowser Global'),
    path.join(pf, '比特浏览器'),
    path.join(pf, '比特指纹浏览器'),
    path.join(home, 'AppData', 'Local', 'BitBrowser'),
    path.join(home, 'AppData', 'Local', 'Programs', 'BitBrowser Global'),
    path.join(home, 'Desktop'),
    path.join(home, '桌面'),
    'C:\\BitBrowser',
    'D:\\BitBrowser',
    'E:\\BitBrowser',
    'F:\\BitBrowser',
    'D:\\Program Files\\BitBrowser',
    'D:\\Program Files\\BitBrowser Global',
    'D:\\Programs\\BitBrowser',
    'D:\\Software\\BitBrowser',
    'D:\\Tools\\BitBrowser',
    'E:\\Software\\BitBrowser',
    'E:\\Tools\\BitBrowser',
    '/Applications/BitBrowser.app',
    '/Applications/BitBrowser Global.app',
    '/Applications/比特浏览器.app'
  ];

  // 常见盘符下一层目录名含 Bit / 比特 的也纳入
  if (process.platform === 'win32') {
    for (const letter of ['C', 'D', 'E', 'F', 'G']) {
      for (const mid of ['', 'Software', 'Tools', 'Programs', 'Apps', 'Program Files', 'Program Files (x86)']) {
        const base = mid ? `${letter}:\\${mid}` : `${letter}:\\`;
        let children = [];
        try { children = fs.readdirSync(base); } catch (_) { continue; }
        for (const name of children) {
          if (!/bit|比特/i.test(name)) continue;
          roots.push(path.join(base, name));
        }
      }
    }
  }
  return uniqPaths(roots);
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
  if (/\\windows\\|\\system32\\|\\syswow64\\|odbcad|\\microsoft\\/i.test(lower)) return false;
  const base = path.basename(filePath);
  if (/^bitbrowser/i.test(base) && /\.exe$/i.test(base)) return true;
  if (/比特/.test(base) && /浏览器|指纹/.test(base) && /\.exe$/i.test(base)) return true;
  // 安装目录名含 BitBrowser / 比特，且是 exe（排除卸载器）
  if (/\.exe$/i.test(base) && !/uninstall|unins/i.test(base)
    && /\\bitbrowser[^\\]*\\|\\比特浏览器\\|\\比特指纹/.test(lower)) {
    return true;
  }
  if (process.platform === 'darwin' && /\.app$/i.test(filePath) && /bitbrowser|比特/i.test(base)) return true;
  return false;
}

function findBitUninstallerNear(exePath) {
  if (!exePath) return null;
  const dirs = uniqPaths([
    path.dirname(exePath),
    path.dirname(path.dirname(exePath))
  ]);
  for (const dir of dirs) {
    for (const name of bitUninstallerNames()) {
      const full = path.join(dir, name);
      if (fs.existsSync(full) && /\.exe$/i.test(full)) return full;
    }
    // 扫一层子目录常见卸载器
    let children = [];
    try { children = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of children) {
      if (!/uninstall|unins/i.test(name)) continue;
      const full = path.join(dir, name);
      if (fs.existsSync(full) && /\.exe$/i.test(full) && /bit|比特/i.test(name + dir)) {
        return full;
      }
      if (fs.existsSync(full) && /\.exe$/i.test(full) && /uninstall/i.test(name)) {
        return full;
      }
    }
  }
  return null;
}

async function killBitProcesses() {
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @('BitBrowser','BitBrowser Global','bitbrowser','BitBrowserPro','比特浏览器')
Get-Process | Where-Object {
  $n = $_.ProcessName
  foreach ($x in $names) { if ($n -like ($x + '*') -or $n -eq $x) { return $true } }
  $false
} | Stop-Process -Force
Start-Sleep -Milliseconds 600
`;
  try { await runPs(script); } catch (_) {}
}

/** 解析 Windows UninstallString：返回 { file, args } */
function parseWinCommandLine(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const m = s.match(/^"([^"]+)"\s*(.*)$/);
    if (m) return { file: m[1], args: (m[2] || '').trim() };
  }
  const sp = s.indexOf(' ');
  if (sp < 0) return { file: s, args: '' };
  // 若第一段不是文件，尝试整段作为路径
  const first = s.slice(0, sp);
  if (fs.existsSync(first)) return { file: first, args: s.slice(sp + 1).trim() };
  if (fs.existsSync(s)) return { file: s, args: '' };
  return { file: first, args: s.slice(sp + 1).trim() };
}

async function findBitUninstallCommands(exePath) {
  const list = [];
  const near = findBitUninstallerNear(exePath);
  if (near) list.push({ file: near, args: '', source: 'dir' });

  if (process.platform !== 'win32') return list;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $keys |
  Where-Object { $_.DisplayName -match 'BitBrowser|Bit Browser|比特浏览器|比特指紋|比特指纹' } |
  ForEach-Object {
    $quiet = [string]$_.QuietUninstallString
    $normal = [string]$_.UninstallString
    $loc = [string]$_.InstallLocation
    $name = [string]$_.DisplayName
    if ($quiet) { Write-Output ('QUIET=' + $quiet) }
    if ($normal) { Write-Output ('NORM=' + $normal) }
    if ($loc) { Write-Output ('LOC=' + $loc) }
    Write-Output ('NAME=' + $name)
    Write-Output '---'
  }
`;
  try {
    const r = await runPs(script);
    const blocks = String(r.stdout || '').split('---');
    for (const block of blocks) {
      let quiet = '';
      let normal = '';
      let loc = '';
      for (const line of block.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
        if (line.startsWith('QUIET=')) quiet = line.slice(6);
        else if (line.startsWith('NORM=')) normal = line.slice(5);
        else if (line.startsWith('LOC=')) loc = line.slice(4);
      }
      if (quiet) {
        const p = parseWinCommandLine(quiet);
        if (p && p.file) list.push({ ...p, source: 'quiet-reg' });
      }
      if (normal) {
        const p = parseWinCommandLine(normal);
        if (p && p.file) list.push({ ...p, source: 'reg' });
      }
      if (loc && fs.existsSync(loc)) {
        const u = findBitUninstallerNear(path.join(loc, 'x.exe'));
        if (u) list.push({ file: u, args: '', source: 'reg-loc' });
      }
    }
  } catch (_) {}

  // 去重
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = (item.file + '|' + (item.args || '')).toLowerCase();
    if (seen.has(key)) continue;
    if (!item.file || !fs.existsSync(item.file)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runElevatedExe(filePath, argsString) {
  const fp = String(filePath).replace(/'/g, "''");
  const args = String(argsString || '').trim();
  // 用 ProcessStartInfo 正确传参，避免 /S 硬塞；保留卸载器自带参数
  const ps = `
$ErrorActionPreference = 'Stop'
$p = New-Object System.Diagnostics.ProcessStartInfo
$p.FileName = '${fp}'
$p.Arguments = '${args.replace(/'/g, "''")}'
$p.UseShellExecute = $true
$p.Verb = 'runas'
$proc = [System.Diagnostics.Process]::Start($p)
if (-not $proc) { throw '未能启动卸载程序（可能取消了 UAC）' }
$proc.WaitForExit()
Write-Output ('EXIT=' + $proc.ExitCode)
`;
  return runPs(ps);
}

async function uninstallBit(onProgress) {
  onProgress && onProgress({ stage: 'uninstall', percent: 5, message: '正在定位比特浏览器…' });
  let exe = findBitBrowserExeQuick();
  if (!exe) {
    const info = await detectBit();
    exe = info.path;
  }
  if (!exe && process.platform === 'win32') {
    // 即使找不到主程序，也尝试走注册表卸载
    const cmds0 = await findBitUninstallCommands(null);
    if (!cmds0.length) throw new Error('未找到已安装的比特浏览器');
  } else if (!exe) {
    throw new Error('未找到已安装的比特浏览器');
  }

  if (process.platform === 'win32') {
    onProgress && onProgress({ stage: 'uninstall', percent: 15, message: '正在结束比特相关进程…' });
    await killBitProcesses();

    onProgress && onProgress({ stage: 'uninstall', percent: 30, message: '正在查找卸载程序…' });
    const cmds = await findBitUninstallCommands(exe);
    if (!cmds.length) {
      throw new Error('未找到比特卸载程序。请到「设置 → 应用」中手动卸载 BitBrowser。');
    }

    let lastErr = null;
    for (const cmd of cmds) {
      try {
        onProgress && onProgress({
          stage: 'uninstall',
          percent: 55,
          message: '正在启动卸载（请在 UAC 中点允许）…'
        });
        // 不要强行追加 /S：比特官方卸载器常不支持，会导致“秒退但不卸载”
        await runElevatedExe(cmd.file, cmd.args || '');
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      throw new Error((lastErr && lastErr.message) || '卸载启动失败，请确认已允许 UAC');
    }

    onProgress && onProgress({ stage: 'uninstall', percent: 85, message: '正在确认卸载结果…' });
    await new Promise((r) => setTimeout(r, 1500));
    const still = findBitBrowserExeQuick() || (await detectBit()).path;
    if (still && fs.existsSync(still)) {
      throw new Error('卸载未完成：程序仍在 ' + still + '。请在弹出的卸载窗口中点完成，或到系统「应用和功能」手动卸载。');
    }
  } else if (process.platform === 'darwin') {
    const appPath = fs.existsSync('/Applications/BitBrowser.app')
      ? '/Applications/BitBrowser.app'
      : (fs.existsSync('/Applications/BitBrowser Global.app')
        ? '/Applications/BitBrowser Global.app'
        : (fs.existsSync('/Applications/比特浏览器.app') ? '/Applications/比特浏览器.app' : exe));
    await runCmd('rm', ['-rf', appPath], { shell: false });
  } else {
    throw new Error('当前平台暂不支持自动卸载比特');
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: '比特浏览器已卸载' });
  return { ok: true };
}

async function detectBitFromProcess() {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -match 'BitBrowser|bitbrowser|BitBrowserPro|比特' -or
    ($_.ExecutablePath -and ($_.ExecutablePath -match 'BitBrowser|比特浏览器|比特指纹'))
  } |
  Select-Object -First 8 Name, ExecutablePath |
  ForEach-Object {
    if ($_.ExecutablePath) { Write-Output $_.ExecutablePath }
  }
`;
  try {
    const r = await runPs(script);
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line && fs.existsSync(line) && isLikelyBitExe(line)) return line;
    }
    // 进程名像比特但路径校验过严时，仍返回第一个存在的 exe
    for (const line of lines) {
      if (line && fs.existsSync(line) && /\.exe$/i.test(line) && !/uninstall|unins/i.test(line)) return line;
    }
  } catch (_) {}
  return null;
}

async function detectBitFromAppPaths() {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @('BitBrowser.exe','BitBrowser Global.exe','BitBrowserPro.exe','BitBrowserCN.exe','比特浏览器.exe')
foreach ($n in $names) {
  $p = (Get-ItemProperty -Path ("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + $n) -ErrorAction SilentlyContinue).'(default)'
  if (-not $p) {
    $p = (Get-ItemProperty -Path ("HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + $n) -ErrorAction SilentlyContinue).'(default)'
  }
  if ($p) { Write-Output $p }
}
`;
  try {
    const r = await runPs(script);
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    for (const p of lines) {
      if (p && fs.existsSync(p) && isLikelyBitExe(p)) return p;
    }
  } catch (_) {}
  return null;
}

async function detectBitFromWhere() {
  if (process.platform !== 'win32') return null;
  try {
    const r = await runCmd('where.exe', ['BitBrowser'], { shell: false });
    const lines = String((r && r.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of lines) {
      if (p && fs.existsSync(p) && isLikelyBitExe(p)) return p;
    }
  } catch (_) {}
  return null;
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
  let exe = null;
  let version = null;
  let source = null;

  const hint = String(opts.hintPath || opts.path || '').trim();
  if (hint) {
    if (fs.existsSync(hint) && (isLikelyBitExe(hint) || (/\.exe$/i.test(hint) && /bit|比特/i.test(hint)))) {
      exe = hint;
      source = 'manual';
    } else if (fs.existsSync(hint)) {
      const hit = findBitInDir(hint, 0, 3);
      if (hit) {
        exe = hit;
        source = 'manual';
      }
    }
  }

  if (!exe) {
    exe = findBitBrowserExeQuick();
    if (exe) source = 'path';
  }

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
    const fromAppPaths = await detectBitFromAppPaths();
    if (fromAppPaths) {
      exe = fromAppPaths;
      source = 'app-paths';
    }
  }

  if (!exe) {
    const fromWhere = await detectBitFromWhere();
    if (fromWhere) {
      exe = fromWhere;
      source = 'where';
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
    if (fromProc) {
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
  if (!versionMeta) throw new Error('请选择 Node.js 版本');
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const versionStr = String(versionMeta.version || versionMeta.versionId || versionMeta.id || '').replace(/^v/i, '');
  if (!versionStr) throw new Error('请选择 Node.js 版本');

  // API 目录已按平台过滤，仅有 downloadUrl；本地兜底用 winUrl/macUrl
  const downloadUrl = String(
    (isWin && versionMeta.winUrl)
    || (isMac && versionMeta.macUrl)
    || versionMeta.downloadUrl
    || versionMeta.url
    || ''
  ).trim();

  // 有直链时优先下载安装包（可来自 API）；nvm 仅在无直链时作为备选
  if (!downloadUrl && isWin) {
    const nvm = await resolveNvmWindows();
    if (nvm && nvm.exe && /^\d+\.\d+\.\d+/.test(versionStr)) {
      onProgress && onProgress({ stage: 'install', percent: 10, message: `检测到 nvm，正在安装 Node ${versionStr}…` });
      try {
        await runCmd(nvm.exe, ['install', versionStr], { shell: false });
      } catch (e) { /* nvm 常把信息打到 stderr */ }
      onProgress && onProgress({ stage: 'install', percent: 70, message: `正在切换到 Node ${versionStr}…` });
      try {
        await runCmd(nvm.exe, ['use', versionStr], { shell: false });
      } catch (e) {
        throw new Error('nvm 安装/切换失败：' + ((e && e.message) || e));
      }
      const after = await detectNode();
      if (!after.installed) {
        throw new Error('nvm 已执行，但未检测到 Node。请新开终端执行 nvm use ' + versionStr);
      }
      onProgress && onProgress({ stage: 'done', percent: 100, message: '已通过 nvm 安装并切换 Node.js' });
      return { ok: true, method: 'nvm', version: after.version };
    }
  }

  if (!downloadUrl) {
    throw new Error('未获取到 Node 安装包下载地址，请在运营后台「环境安装包」配置并发布');
  }

  ensureDir(cacheDir);
  let ext = isWin ? '.msi' : '.pkg';
  const lower = downloadUrl.toLowerCase().split('?')[0];
  if (/\.exe$/i.test(lower)) ext = '.exe';
  else if (/\.msi$/i.test(lower)) ext = '.msi';
  else if (/\.pkg$/i.test(lower)) ext = '.pkg';
  else if (/\.dmg$/i.test(lower)) ext = '.dmg';
  const dest = path.join(cacheDir, `node-${versionStr.replace(/[^\w.-]+/g, '_')}${ext}`);

  onProgress && onProgress({ stage: 'download', percent: 0, message: `正在下载 Node.js ${versionStr}…` });
  await downloadToFile(downloadUrl, dest, (p) => {
    onProgress && onProgress({ stage: 'download', percent: p, message: `正在下载 Node.js ${versionStr}… ${p}%` });
  });

  onProgress && onProgress({ stage: 'install', percent: 0, message: '正在安装 Node.js（可能弹出 UAC）…' });
  if (isWin) {
    if (/\.msi$/i.test(dest)) {
      await elevateAndWait('msiexec.exe', ['/i', dest, '/passive', 'ADDLOCAL=ALL']);
    } else {
      await elevateAndWait(dest, []);
    }
  } else if (isMac) {
    if (/\.pkg$/i.test(dest)) {
      await runCmd('osascript', [
        '-e',
        `do shell script "installer -pkg '${dest.replace(/'/g, "'\\''")}' -target /" with administrator privileges`
      ], { shell: false });
    } else {
      const elShell = getElectronShell();
      if (elShell) await elShell.openPath(dest);
      else throw new Error('请手动打开安装包：' + dest);
    }
  } else {
    throw new Error('当前平台请手动安装 Node.js');
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: 'Node.js 安装完成，请稍候点「重新检测」' });
  return { ok: true, file: dest, method: 'download' };
}

async function resolveNvmWindows() {
  if (process.platform !== 'win32') return null;
  const { env } = await buildEnrichedEnv();
  const homes = uniqPaths([
    env.NVM_HOME,
    process.env.NVM_HOME,
    'D:\\nvm',
    'C:\\nvm',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nvm'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm')
  ]);
  let nvmExe = null;
  let nvmHome = '';
  for (const h of homes) {
    const exe = path.join(h, 'nvm.exe');
    if (fs.existsSync(exe)) {
      nvmExe = exe;
      nvmHome = h;
      break;
    }
  }
  if (!nvmExe) return null;
  const symlink = env.NVM_SYMLINK || process.env.NVM_SYMLINK || '';
  return { exe: nvmExe, home: nvmHome, symlink };
}

function isPathUnderNvm(nodePath, nvm) {
  if (!nodePath || !nvm) return false;
  const p = path.resolve(nodePath).toLowerCase();
  const home = nvm.home ? path.resolve(nvm.home).toLowerCase() : '';
  const link = nvm.symlink ? path.resolve(nvm.symlink).toLowerCase() : '';
  if (link) {
    const linkExe = path.join(link, 'node.exe').toLowerCase();
    if (p === linkExe || p.startsWith(link + '\\') || p.startsWith(link + '/')) return true;
  }
  if (home && (p.startsWith(home + '\\') || p.startsWith(home + '/'))) return true;
  return false;
}

async function listNodeMsiUninstallers() {
  if (process.platform !== 'win32') return [];
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $keys |
  Where-Object { $_.DisplayName -like 'Node.js*' } |
  ForEach-Object {
    Write-Output ('NAME=' + [string]$_.DisplayName)
    Write-Output ('VER=' + [string]$_.DisplayVersion)
    Write-Output ('UNINST=' + [string]$_.UninstallString)
    Write-Output ('QUIET=' + [string]$_.QuietUninstallString)
    Write-Output '---'
  }
`;
  try {
    const r = await runPs(script);
    const blocks = String(r.stdout || '').split('---').map((b) => b.trim()).filter(Boolean);
    const out = [];
    for (const block of blocks) {
      let name = '';
      let ver = '';
      let uninst = '';
      let quiet = '';
      for (const line of block.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
        if (line.startsWith('NAME=')) name = line.slice(5);
        else if (line.startsWith('VER=')) ver = line.slice(4);
        else if (line.startsWith('UNINST=')) uninst = line.slice(7);
        else if (line.startsWith('QUIET=')) quiet = line.slice(6);
      }
      out.push({ name, ver, uninst, quiet });
    }
    return out;
  } catch (_) {
    return [];
  }
}

async function uninstallNodeViaNvm(nvm, currentVersion, onProgress) {
  const ver = String(currentVersion || '').replace(/^v/i, '').trim();
  if (!ver) throw new Error('无法识别当前 Node 版本，无法通过 nvm 卸载');

  onProgress && onProgress({
    stage: 'uninstall',
    percent: 40,
    message: `检测到 nvm，正在卸载 Node ${ver}…`
  });

  // nvm uninstall 不需要交互；切换目录到 nvm home 更稳
  try {
    await runCmd(nvm.exe, ['uninstall', ver], { cwd: nvm.home || undefined, shell: false });
  } catch (e) {
    // 部分 nvm 版本卸载失败会非 0，再查是否还在
    const still = await detectNode();
    if (still.installed && String(still.version) === ver) {
      throw new Error('nvm uninstall 失败：' + ((e && e.message) || e));
    }
  }

  // 若还有其他版本，尝试切到剩余版本，避免残留坏链接被误判
  try {
    const listOut = await execOut(nvm.exe, ['list'], await buildEnrichedEnv().then((x) => x.env));
    const versions = String(listOut || '')
      .split(/\r?\n/)
      .map((l) => (l.match(/(\d+\.\d+\.\d+)/) || [])[1])
      .filter(Boolean);
    if (versions.length) {
      onProgress && onProgress({ stage: 'uninstall', percent: 75, message: `切换到剩余版本 ${versions[0]}…` });
      try { await runCmd(nvm.exe, ['use', versions[0]], { cwd: nvm.home || undefined, shell: false }); } catch (_) {}
    }
  } catch (_) {}

  return { method: 'nvm', version: ver };
}

async function uninstallNodeViaMsi(onProgress) {
  const apps = await listNodeMsiUninstallers();
  if (!apps.length) {
    throw new Error('未找到官方 Node.js 安装项（注册表无 Node.js*）');
  }
  onProgress && onProgress({
    stage: 'uninstall',
    percent: 35,
    message: `正在卸载官方 Node.js（${apps.length} 项，可能弹出 UAC）…`
  });

  for (const app of apps) {
    const cmd = app.quiet || app.uninst;
    if (!cmd) continue;
    const msi = cmd.match(/\{[0-9A-Fa-f-]{36}\}/);
    if (msi) {
      await runElevatedExe('msiexec.exe', `/x ${msi[0]} /passive`);
      continue;
    }
    const parsed = parseWinCommandLine(cmd);
    if (parsed && parsed.file) {
      await runElevatedExe(parsed.file, parsed.args || '');
    }
  }
  return { method: 'msi', count: apps.length };
}

async function uninstallNode(onProgress) {
  onProgress && onProgress({ stage: 'uninstall', percent: 5, message: '正在检测 Node.js 安装方式…' });
  const before = await detectNode();
  if (!before.installed) {
    throw new Error('未检测到已安装的 Node.js');
  }

  if (process.platform === 'win32') {
    const nvm = await resolveNvmWindows();
    const fromNvm = isPathUnderNvm(before.path, nvm);

    if (fromNvm && nvm && nvm.exe) {
      await uninstallNodeViaNvm(nvm, before.version, onProgress);
    } else {
      // 官方 MSI / 其他安装器
      try {
        await uninstallNodeViaMsi(onProgress);
      } catch (e) {
        if (nvm && nvm.exe) {
          // 回退：路径虽不像 nvm，但机器有 nvm，再试 nvm 卸载当前版本
          await uninstallNodeViaNvm(nvm, before.version, onProgress);
        } else {
          throw e;
        }
      }
    }

    onProgress && onProgress({ stage: 'uninstall', percent: 90, message: '正在确认卸载结果…' });
    await new Promise((r) => setTimeout(r, 1000));
    const after = await detectNode();

    // nvm 卸载当前版本后，若还切到了其他版本，算成功卸载「刚才那一版」，但仍显示已安装——这里按「当前检测版本是否变化/消失」判断
    if (fromNvm) {
      if (after.installed && String(after.version) === String(before.version)) {
        throw new Error('nvm 卸载后仍检测到相同版本 v' + before.version + '。请在终端执行：nvm uninstall ' + before.version);
      }
      onProgress && onProgress({
        stage: 'done',
        percent: 100,
        message: after.installed
          ? `已卸载 v${before.version}，当前可用 v${after.version}`
          : `已卸载 Node.js v${before.version}`
      });
      return {
        ok: true,
        method: 'nvm',
        removedVersion: before.version,
        currentVersion: after.installed ? after.version : null
      };
    }

    if (after.installed) {
      throw new Error('卸载后仍检测到 Node：' + (after.path || after.version) + '。请到「应用和功能」手动卸载 Node.js。');
    }
  } else if (process.platform === 'darwin') {
    throw new Error('macOS 请使用 brew uninstall node，或删除官方 pkg 安装');
  } else {
    throw new Error('当前平台暂不支持自动卸载 Node');
  }

  onProgress && onProgress({ stage: 'done', percent: 100, message: 'Node.js 已卸载' });
  return { ok: true, method: 'msi' };
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
  const isMac = process.platform === 'darwin';
  let installer = opts.localFile || null;
  const verLabel = (versionMeta && (versionMeta.version || versionMeta.label || versionMeta.id)) || 'bit';

  if (!installer) {
    const url = String(
      (versionMeta && (
        (isWin && versionMeta.winUrl)
        || (isMac && versionMeta.macUrl)
        || versionMeta.downloadUrl
        || versionMeta.url
        || versionMeta.winUrl
        || versionMeta.macUrl
      )) || ''
    ).trim();
    if (!url) {
      throw new Error('未获取到比特安装包下载地址。请在运营后台「环境安装包」上传/填写直链并发布，或使用「选择安装包安装」。');
    }
    const cacheDir = opts.cacheDir;
    ensureDir(cacheDir);
    let ext = isWin ? '.exe' : '.dmg';
    const lower = url.toLowerCase().split('?')[0];
    if (/\.msi$/i.test(lower)) ext = '.msi';
    else if (/\.exe$/i.test(lower)) ext = '.exe';
    else if (/\.dmg$/i.test(lower)) ext = '.dmg';
    else if (/\.pkg$/i.test(lower)) ext = '.pkg';
    else if (/\.zip$/i.test(lower)) ext = '.zip';
    const dest = path.join(cacheDir, `bitbrowser-${String(verLabel).replace(/[^\w.-]+/g, '_')}${ext}`);
    onProgress && onProgress({ stage: 'download', percent: 0, message: `正在下载比特 ${verLabel}…` });
    await downloadToFile(url, dest, (p) => {
      onProgress && onProgress({ stage: 'download', percent: p, message: `正在下载比特 ${verLabel}… ${p}%` });
    });
    installer = dest;
  }

  onProgress && onProgress({ stage: 'install', percent: 95, message: '正在启动比特安装程序（可能弹出 UAC）…' });
  if (isWin) {
    if (/\.msi$/i.test(installer)) {
      await elevateAndWait('msiexec.exe', ['/i', installer, '/passive']);
    } else if (/\.zip$/i.test(installer)) {
      throw new Error('暂不支持自动解压 zip，请上传 exe/msi 安装包，或解压后使用「选择安装包安装」');
    } else {
      await elevateAndWait(installer, []);
    }
  } else if (isMac) {
    const elShell2 = getElectronShell();
    if (elShell2) await elShell2.openPath(installer);
    else throw new Error('请手动打开安装包：' + installer);
  } else {
    throw new Error('当前平台暂不支持自动安装比特');
  }
  onProgress && onProgress({ stage: 'done', percent: 100, message: '已启动安装，完成后请点「重新检测」' });
  return { ok: true, file: installer };
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
