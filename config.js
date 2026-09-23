/**
 * TKSwarm Client（Electron）默认配置
 * 可在页面「服务器」里覆盖。
 */
window.__TKSWARM_EXE_CONFIG__ = {
  appName: 'TKSwarm Client',
  appVersion: '1.0.0',
  defaultApiBase: 'http://tkswarm-api.dyyweb.com',
  nodeHealthUrl: 'http://127.0.0.1:8400/api/health',
  bitApiUrl: 'http://127.0.0.1:54345',
  downloads: {
    node: 'https://nodejs.org/zh-cn/download/',
    nodeMsi: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi',
    nodeMac: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg',
    bit: 'https://www.bitbrowser.cn/',
    bitDownload: 'https://www.bitbrowser.cn/download'
  }
};
