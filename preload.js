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
  pickAndRunInstaller: () => ipcRenderer.invoke('pick-and-run-installer'),
  deployPackage: (options) => ipcRenderer.invoke('deploy-package', options),
  startService: (dir) => ipcRenderer.invoke('start-service', dir),
  onDeployProgress: (handler) => {
    const listener = (_event, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('deploy-progress', listener);
    return () => ipcRenderer.removeListener('deploy-progress', listener);
  }
});
