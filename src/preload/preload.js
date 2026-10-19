'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  sync: () => ipcRenderer.invoke('sync'),
  saveTask: (todo) => ipcRenderer.invoke('task:save', todo),
  deleteTask: (uid) => ipcRenderer.invoke('task:delete', uid),
  toggleTask: (uid, completed) => ipcRenderer.invoke('task:toggle', uid, completed),
  onState: (cb) => ipcRenderer.on('state', (_evt, state) => cb(state)),
  /** 托盘菜单「新建任务」触发，把光标送到新建输入框 */
  onFocusComposer: (cb) => ipcRenderer.on('focus-composer', () => cb()),
});
