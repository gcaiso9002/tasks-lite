'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  sync: () => ipcRenderer.invoke('sync'),
  saveTask: (todo) => ipcRenderer.invoke('task:save', todo),
  trashTask: (uid) => ipcRenderer.invoke('task:trash', uid),
  restoreTask: (uid) => ipcRenderer.invoke('task:restore', uid),
  purgeTask: (uid) => ipcRenderer.invoke('trash:purge', uid),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),
  checkReminders: () => ipcRenderer.invoke('reminder:check'),
  testNotification: () => ipcRenderer.invoke('notify:test'),
  netDiag: () => ipcRenderer.invoke('net:diag'),
  toggleTask: (uid, completed) => ipcRenderer.invoke('task:toggle', uid, completed),
  toggleMyDay: (uid, on) => ipcRenderer.invoke('task:myday', uid, on),
  onState: (cb) => ipcRenderer.on('state', (_evt, state) => cb(state)),
  /** 托盘菜单「新建任务」触发，把光标送到新建输入框 */
  onFocusComposer: (cb) => ipcRenderer.on('focus-composer', () => cb()),
  /** 点提醒通知后主进程会要求打开某条任务 */
  onOpenTask: (cb) => ipcRenderer.on('open-task', (_evt, uid) => cb(uid)),
});
