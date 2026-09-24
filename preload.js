'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tkswarmDesktop', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkCommands: () => ipcRenderer.invoke('check-commands'),
  pickDirectory: (defaultPath) => ipcRenderer.invoke('pick-directory', defaultPath),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  pathExists: (target) => ipcRenderer.invoke('path-exists', target),
  hasStartScript: (dir) => ipcRenderer.invoke('has-start-script', dir),
  inspectDeployDir: (dir) => ipcRenderer.invoke('inspect-deploy-dir', dir),
  clearDeployDir: (dir) => ipcRenderer.invoke('clear-deploy-dir', dir),
  showConfirm: (options) => ipcRenderer.invoke('show-confirm', options),
  showMessage: (options) => ipcRenderer.invoke('show-message', options),
  pickAndRunInstaller: () => ipcRenderer.invoke('pick-and-run-installer'),
  pickInstallerFile: () => ipcRenderer.invoke('pick-installer-file'),
  deployPackage: (options) => ipcRenderer.invoke('deploy-package', options),
  startService: (dir) => ipcRenderer.invoke('start-service', dir),
  detectNode: () => ipcRenderer.invoke('detect-node'),
  detectBit: (options) => ipcRenderer.invoke('detect-bit', options || {}),
  pickBitExe: () => ipcRenderer.invoke('pick-bit-exe'),
  launchBit: (exePath) => ipcRenderer.invoke('launch-bit', exePath),
  isBitRunning: () => ipcRenderer.invoke('is-bit-running'),
  resolveNodeTools: () => ipcRenderer.invoke('resolve-node-tools'),
  installNode: (versionMeta) => ipcRenderer.invoke('install-node', versionMeta),
  uninstallNode: () => ipcRenderer.invoke('uninstall-node'),
  installBit: (payload) => ipcRenderer.invoke('install-bit', payload),
  uninstallBit: () => ipcRenderer.invoke('uninstall-bit'),
  onDeployProgress: (handler) => {
    const listener = (_event, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('deploy-progress', listener);
    return () => ipcRenderer.removeListener('deploy-progress', listener);
  },
  onEnvProgress: (handler) => {
    const listener = (_event, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('env-progress', listener);
    return () => ipcRenderer.removeListener('env-progress', listener);
  }
});
