# TKSwarm Client（Electron · CI 云构建）

客服端安装助手：检测 **Node.js** / **比特浏览器**，引导安装，并从线上版本中心 **一键部署** 代码包（下载 → 解压 → npm install → 启动）。

推荐用 **GitHub Actions / GitLab CI** 在云端真实 Windows / macOS Runner 上打包（不是本地模拟），产出：

| 平台 | 产物 |
|------|------|
| Windows | NSIS 安装包 `.exe` + 绿色便携版 `*-portable.exe` |
| macOS | `.dmg` + `.zip`（x64 / arm64） |

## 目录

```text
tkswarm-exe/
├── main.js / preload.js     Electron 主进程 + 安全桥接
├── index.html / app.js …    界面与业务
├── electron-builder.yml     多平台打包配置
├── build/icon.png           应用图标
├── build/entitlements.mac.plist
└── package.json
```

仓库根目录 CI：

- `.github/workflows/tkswarm-client.yml` — GitHub Actions
- `.gitlab-ci.yml` — GitLab CI

## 客户端功能

1. **环境检测**：Node 服务 `:8999`、比特本地 API `:54345`、本机是否有 `node`/`npm`
2. **安装引导**：按平台打开 Node 安装包（Win MSI / Mac pkg）；打开比特官网下载；可选择本地安装包运行
3. **代码部署**：选目录 → 一键部署最新（或列表中指定版本）→ 解压并可选 `npm install` / 启动 `start.bat`|`npm start`
4. **服务器设置**：API / 健康检查 / 比特地址（localStorage）

## 本地调试（可选）

需本机 Node **20+**（CI 用 20，勿用过旧 Node）：

```bat
cd tkswarm-exe
npm ci
npm start
```

本地打包当前系统：

```bat
npm run dist:win
npm run dist:mac
```

## GitHub Actions（推荐）

云端在 `windows-latest` / `macos-latest` **真实打包**，不是本机交叉模拟。

### 一次性准备

1. 把代码推到 GitHub 仓库  
2. （可选）在仓库 Secrets 配置代码签名：  
   - Windows：`CSC_LINK`、`CSC_KEY_PASSWORD`  
   - macOS：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`（及证书）

### 触发方式

| 方式 | 说明 |
|------|------|
| **Actions → Build TKSwarm Client → Run workflow** | 手动构建，下载 Artifacts |
| 改 `tkswarm-exe/**` 并开 PR | 自动构建校验 |
| 打 tag：`client-v1.0.0` | 构建 + 自动创建 GitHub Release 并上传安装包 |

```bash
git tag client-v1.0.0
git push origin client-v1.0.0
```

产物在 Actions 的 Artifacts，或 Releases 页面。

> 未签名的 macOS 包首次打开需：右键 App → 打开。正式分发请配置 Apple 公证。

## GitLab CI

根目录 `.gitlab-ci.yml` 提供 Windows / macOS 双 Job。

- SaaS 默认 tags：`saas-windows-medium-amd64`、`saas-macos-medium-m1`（需 GitLab 计划支持；否则改成你的 Runner tags）  
- 手动 / MR / `client-v*` tag 会触发  
- 产物在 Job Artifacts 中下载  

## 版本号

改 `tkswarm-exe/package.json` 的 `"version"`，打对应 tag（如 `client-v1.0.1`）。`config.js` 的展示版本会在运行时以 Electron `app.getVersion()` 为准。

## 说明

- 云构建 = 官方 Runner 上本机编译，SmartScreen / Gatekeeper 行为与正式包一致（签名前可能仍有提示）  
- 业务代码 zip 仍由 `tkswarm-api` 版本中心分发；本客户端只负责安装助手 + 部署  
- 不需要 WebIntoApp；打包完全由 electron-builder + CI 完成
