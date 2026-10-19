'use strict';

const {
  app, BrowserWindow, ipcMain, Menu, shell, dialog, Notification, net, safeStorage,
} = require('electron');
const path = require('path');
const crypto = require('crypto');

const { CaldavClient } = require('./caldav');
const { Store } = require('./store');
const { Config } = require('./config');

let win = null;
let config = null;
let store = null;
let syncTimer = null;

// ================================================================ 同步管理

const syncState = { syncing: false, error: null, lastSync: null, reason: '' };

function broadcast() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', snapshot());
  }
}

function snapshot() {
  return {
    tasks: store.tasks,
    config: config.publicView(),
    sync: Object.assign({}, syncState, { lastSync: store.data.lastSync }),
  };
}

function makeClient() {
  if (!config.data.server || !config.data.username || !config.data.password) {
    throw new Error('还没有配置服务器地址、用户名和密码');
  }
  return new CaldavClient({
    fetchImpl: (url, init) => net.fetch(url, init),
    baseUrl: config.data.server,
    username: config.data.username,
    password: config.data.password,
  });
}

/** 确保我们有一个可写的日历；没有就建一个 */
async function ensureCalendar(client) {
  const { home, calendars } = await client.discover();
  if (calendars.length) {
    const chosen = calendars.find((c) => store.data.calendarHref === c.href) || calendars[0];
    store.setCalendar(chosen.href, chosen.name);
    return chosen;
  }
  const href = await client.createCalendar(home, 'TasksLite');
  store.setCalendar(href, 'TasksLite');
  return { href, name: 'TasksLite' };
}

async function runSync(reason = 'manual') {
  if (syncState.syncing) return { skipped: true };
  syncState.syncing = true;
  syncState.error = null;
  syncState.reason = reason;
  broadcast();

  try {
    const client = makeClient();
    const cal = await ensureCalendar(client);

    // 1) 先把本地排队（之前离线时）的操作推上去
    for (const op of store.data.pending.slice()) {
      try {
        if (op.op === 'put') {
          const r = await client.putTodo(cal.href, op.todo, op.baseEtag);
          store.upsert(Object.assign({}, op.todo, { href: r.href, etag: r.etag }));
        } else if (op.op === 'delete') {
          await client.deleteTodo(client.absolute(op.href), op.etag);
          store.remove(op.uid);
        }
        const i = store.data.pending.indexOf(op);
        if (i >= 0) store.data.pending.splice(i, 1);
        store.save();
      } catch (e) {
        // 409 说明服务端版本更新了，放弃这次推送，等下次 pull 覆盖
        if (e.status === 409) {
          const i = store.data.pending.indexOf(op);
          if (i >= 0) store.data.pending.splice(i, 1);
          store.save();
        } else {
          throw e;
        }
      }
    }

    // 2) 全量拉取，服务端是权威
    const remote = await client.listTodos(cal.href);
    store.upsertMany(remote);
    store.markSynced();

    return { ok: true, pulled: remote.length };
  } catch (e) {
    syncState.error = e.message || String(e);
    console.error('[sync] 失败：', e);
    return { ok: false, error: syncState.error };
  } finally {
    syncState.syncing = false;
    broadcast();
  }
}

/** 本地改动：先写缓存保证界面立刻响应，再尽力推服务器 */
async function pushOrQueue(op, clientFn) {
  try {
    const client = makeClient();
    if (!store.data.calendarHref) {
      await ensureCalendar(client);
    }
    const r = await clientFn(client);
    store.upsert(r);
    return { ok: true };
  } catch (e) {
    // 网络问题就排队，下次同步补上
    store.enqueue(op);
    console.error('[push] 入队等待下次同步：', e.message);
    return { ok: true, queued: true, error: e.message };
  }
}

// ================================================================ IPC

function registerIpc() {
  ipcMain.handle('get-state', () => snapshot());

  ipcMain.handle('save-config', async (_e, patch) => {
    config.update(patch || {});
    if (patch && patch.password === '') {
      // 允许显式清空密码
      config.update({ password: '' });
    }
    scheduleAutoSync();
    broadcast();
    return config.publicView();
  });

  ipcMain.handle('test-connection', async () => {
    try {
      const client = makeClient();
      const { home, calendars } = await client.discover();
      const cal = calendars[0];
      let todoCount = 0;
      if (cal) {
        try {
          todoCount = (await client.listTodos(cal.href)).length;
        } catch (e) {
          todoCount = -1;
        }
      }
      return { ok: true, home, calendars, todoCount };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('sync', async () => runSync('manual'));

  ipcMain.handle('task:save', async (_e, todo) => {
    const t = Object.assign({}, todo);
    if (!t.uid) {
      t.uid = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}@taskslite`;
    }
    const calHref = store.data.calendarHref;
    return pushOrQueue(
      { op: 'put', todo: t, baseEtag: t.etag || null },
      async (client) => {
        const href = calHref || (await ensureCalendar(client)).href;
        const r = await client.putTodo(href, t, t.etag || null);
        return Object.assign({}, t, { href: r.href, etag: r.etag });
      }
    );
  });

  ipcMain.handle('task:delete', async (_e, uid) => {
    const t = store.get(uid);
    if (!t) return { ok: true };
    store.remove(uid);
    if (!t.href) return { ok: true };
    return pushOrQueue({ op: 'delete', uid, href: t.href, etag: t.etag || null }, async (client) => {
      await client.deleteTodo(client.absolute(t.href), t.etag || null);
      return { uid, __deleted: true };
    }).then(async () => {
      store.remove(uid);
      broadcast();
      return { ok: true };
    });
  });

  ipcMain.handle('task:toggle', async (_e, uid, completed) => {
    const t = store.get(uid);
    if (!t) return { ok: false };
    t.completed = !!completed;
    store.upsert(t);
    broadcast();

    // 顺手来条系统通知
    if (completed && Notification.isSupported()) {
      new Notification({ title: '任务完成', body: t.title }).show();
    }

    return pushOrQueue(
      { op: 'put', todo: t, baseEtag: t.etag || null },
      async (client) => {
        const r = await client.putTodo(store.data.calendarHref, t, t.etag || null);
        return Object.assign({}, t, { href: r.href, etag: r.etag });
      }
    );
  });
}

// ================================================================ 定时同步

function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  const min = Math.max(1, Number(config.data.syncIntervalMin) || 5);
  syncTimer = setInterval(() => runSync('auto'), min * 60 * 1000);
}

// ================================================================ 窗口与菜单

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Tasks Lite',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 聚焦即同步，保证看到的不是陈旧数据
  win.on('focus', () => runSync('focus'));
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '立即同步', accelerator: 'CmdOrCtrl+R', click: () => runSync('manual') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'Tasks Lite',
            message: 'Tasks Lite 1.0.0',
            detail: '本地 CalDAV 待办客户端。\n数据存在你自己搭的 CalDAV 服务器上，不经过任何第三方。\n\n' +
                    `Electron ${process.versions.electron} / Chrome ${process.versions.chrome}\nNode ${process.versions.node}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ================================================================ 启动

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    config = new Config(userData);
    store = new Store(userData);

    registerIpc();
    buildMenu();
    createWindow();
    scheduleAutoSync();

    // 启动后先静默同步一次
    setTimeout(() => runSync('startup'), 1200);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
