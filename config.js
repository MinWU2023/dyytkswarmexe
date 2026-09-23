/**
 * Dyy TKSwarm Client 默认配置
 * Node / 比特版本优先从 API「环境安装包」目录拉取（按 win|mac），
 * 客户端选择版本后直链下载并自动安装，不再打开浏览器手动下载。
 * 下列列表仅作 API 不可用时的本地兜底。
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
  /** API 不可用时的 Node 兜底（含官方直链） */
  nodeVersions: [
    {
      id: '22.14.0',
      version: '22.14.0',
      label: '22.14.0 LTS（推荐·视频矩阵）',
      recommended: true,
      winUrl: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi',
      macUrl: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg'
    },
    {
      id: '20.18.1',
      version: '20.18.1',
      label: '20.18.1 LTS（兼容）',
      recommended: false,
      winUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi',
      macUrl: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1.pkg'
    }
  ],
  /** API 不可用且无直链时无法自动安装比特，需后台发布或「选择安装包」 */
  bitVersions: []
};
