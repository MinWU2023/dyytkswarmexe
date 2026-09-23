/**
 * Dyy TKSwarm Client 默认配置
 * Node 有官方版本直链，可自动下载安装；
 * 比特官网通常无稳定直链：安装时打开下载页并监控「下载」目录，也可选择本地安装包。
 */
window.__TKSWARM_EXE_CONFIG__ = {
  appName: 'Dyy TKSwarm Client',
  appVersion: '1.0.0',
  defaultApiBase: 'http://tkswarm-api.dyyweb.com',
  nodeHealthUrl: 'http://127.0.0.1:8400/api/health',
  bitApiUrl: 'http://127.0.0.1:54345',
  downloads: {
    node: 'https://nodejs.org/zh-cn/download/',
    bit: 'https://www.bitbrowser.cn/',
    bitDownload: 'https://www.bitbrowser.cn/download'
  },
  /**
   * 适配视频矩阵的主流 Node 版本（Electron/CDP/Playwright 友好）
   * recommended: 自动选中的最佳版本
   */
  nodeVersions: [
    {
      id: '22.14.0',
      label: '22.14.0 LTS（推荐·视频矩阵）',
      recommended: true,
      winUrl: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi',
      macUrl: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg'
    },
    {
      id: '20.18.1',
      label: '20.18.1 LTS（兼容）',
      recommended: false,
      winUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi',
      macUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1.pkg'
    },
    {
      id: '18.20.5',
      label: '18.20.5 LTS（旧环境）',
      recommended: false,
      winUrl: 'https://nodejs.org/dist/v18.20.5/node-v18.20.5-x64.msi',
      macUrl: 'https://nodejs.org/dist/v18.20.5/node-v18.20.5.pkg'
    }
  ],
  /**
   * 比特主流版本（推荐最新稳定）。若后续有直链可填 winUrl。
   */
  bitVersions: [
    {
      id: '7.1.4',
      label: '7.1.4（推荐·适配视频矩阵）',
      recommended: true,
      downloadPage: 'https://www.bitbrowser.cn/download',
      winUrl: ''
    },
    {
      id: '7.1.3',
      label: '7.1.3',
      recommended: false,
      downloadPage: 'https://www.bitbrowser.cn/download',
      winUrl: ''
    },
    {
      id: '7.1.2',
      label: '7.1.2',
      recommended: false,
      downloadPage: 'https://www.bitbrowser.cn/download',
      winUrl: ''
    }
  ]
};
