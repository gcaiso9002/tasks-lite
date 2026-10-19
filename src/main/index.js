'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, net, globalShortcut, nativeTheme,
} = require('electron');
const path = require('path');
const crypto = require('crypto');

const { CaldavClient } = require('./caldav');
const { Store } = require('./store');
const { Config } = require('./config');

const GLOBAL_TOGGLE = 'Control+Shift+T';
const ACCENT_FALLBACK = '#4f8cff';
const BG = { dark: '#0f1115', light: '#f5f6f8' };

let win = null;
let tray = null;
let config = null;
let store = null;
let syncTimer = null;
let isQuitting = false; // 区分「关窗口」与「真退出」

// ================================================================ 同步管理

const syncState = { syncing: false, error: null, lastSync: null, reason: '' };

function broadcast() {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('state', snapshot());
  }
}

function snapshot() {
  const cfg = config.publicView();
  cfg.resolvedTheme = resolvedTheme();
  cfg.accent = accentColor();
  return {
    tasks: store.tasks,
    trash: store.trash,
    lists: collectLists(),
    tags: collectTags(),
    config: cfg,
    sync: Object.assign({}, syncState, { lastSync: store.data.lastSync }),
  };
}

// ================================================================ 外观

/** 'system' | 'light' | 'dark' → 实际生效的 'light' | 'dark' */
function resolvedTheme() {
  const t = config.data.theme;
  if (t === 'dark' || t === 'light') return t;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/** 用户自定义的强调色；非法值一律退回默认蓝 */
function accentColor() {
  const c = String(config.data.accentColor || '').trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : ACCENT_FALLBACK;
}

/**
 * 把主题落到主进程（窗口底色 + nativeTheme），再推给渲染进程。
 * 必须在 config 初始化之后调用。
 */
function applyTheme() {
  const source = config.data.theme === 'dark' || config.data.theme === 'light'
    ? config.data.theme
    : 'system';
  // 只在真变了的时候写，否则 themeSource 赋值会再次触发 updated，
  // 和这里的 updated 监听组成死循环
  if (nativeTheme.themeSource !== source) {
    try {
      nativeTheme.themeSource = source;
    } catch (e) {
      console.error('[theme] 设置 themeSource 失败：', e.message);
    }
  }
  const resolved = resolvedTheme();
  if (win && !win.isDestroyed()) {
    try { win.setBackgroundColor(BG[resolved]); } catch (e) { /* 窗口还没建好 */ }
  }
  broadcast();
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
    // 删除类操作要真的从本地移除。之前这里一律 upsert，
    // 删除成功后会往 tasks 里塞一条只剩 uid 的空壳，下次同步又"复活"它。
    if (op.op === 'delete') store.remove(r.uid);
    else store.upsert(r);
    return { ok: true };
  } catch (e) {
    store.enqueue(op);
    console.error('[push] 入队等待下次同步：', e.message);
    return { ok: true, queued: true, error: e.message };
  }
}

// ================================================================ 列表 / 标签

function tally(names) {
  const m = new Map();
  for (const n of names) m.set(n, (m.get(n) || 0) + 1);
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function collectLists() {
  return tally(store.tasks.map((t) => String(t.list || '').trim() || '未分类'));
}

function collectTags() {
  const out = [];
  for (const t of store.tasks) {
    for (const tag of t.tags || []) {
      const s = String(tag).trim();
      if (s) out.push(s);
    }
  }
  return tally(out);
}

// ================================================================ 提醒

let reminderTimer = null;

/** 扫一遍到点的任务并弹 Windows 通知；同一个 remindAt 只弹一次 */
function checkReminders() {
  const now = Date.now();
  let fired = 0;
  for (const t of store.tasks) {
    if (t.completed || !t.remindAt) continue;
    const ts = new Date(t.remindAt).getTime();
    if (!Number.isFinite(ts) || ts > now) continue;
    if (store.alreadyReminded(t.uid, t.remindAt)) continue;
    store.markReminded(t.uid, t.remindAt);
    fired++;
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '任务提醒',
        body: t.title || '(无标题)',
      });
      n.on('click', () => openTaskInWindow(t.uid));
      n.show();
    }
  }
  if (fired) broadcast();
  return fired;
}

function scheduleReminders() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminders, 30000);
}

/** 通知点开后把窗口叫醒，并直接打开那条任务的编辑区 */
function openTaskInWindow(uid) {
  showWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('open-task', uid);
  }
}

// ================================================================ 开机自启

function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!config.data.autoLaunch,
      // 开机启动时直接进托盘，不弹窗口打扰
      openAsHidden: !!config.data.autoLaunch,
      args: ['--hidden'],
    });
  } catch (e) {
    console.error('[autolaunch] 设置失败：', e.message);
  }
}

// ================================================================ 窗口 / 托盘

function createWindow(startHidden) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Tasks Lite',
    backgroundColor: BG[resolvedTheme()],
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });

  win.on('focus', () => runSync('focus'));

  // 关窗口不等于退出，缩回托盘
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      updateTrayMenu();
    }
  });

  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(false);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showWindow();
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const hidden = !win || win.isDestroyed() || !win.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: hidden ? '显示窗口' : '隐藏窗口', click: () => (hidden ? showWindow() : win.hide()) },
    { label: '新建任务', click: () => { showWindow(); broadcast(); win.webContents.send('focus-composer'); } },
    { label: '立即同步', click: () => runSync('tray') },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!config.data.autoLaunch,
      click: (item) => {
        config.update({ autoLaunch: item.checked });
        applyAutoLaunch();
        broadcast();
      },
    },
    { type: 'separator' },
    { label: `退出  (全局快捷键 ${GLOBAL_TOGGLE})`, click: quitApp },
  ]));
  tray.setToolTip(hidden ? 'Tasks Lite — 在后台运行' : 'Tasks Lite');
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  tray = new Tray(iconPath);
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
  updateTrayMenu();
  // 托盘图标可能因为任务栏窗口过多而被挤到屏幕外，
  // 用 getBounds 确认它确实拿到了有效的显示区域
  const b = tray.getBounds();
  console.log(`[tray] 已创建  图标=${iconPath}  边界=${JSON.stringify(b)}  有效=${b.width > 0 && b.height > 0}`);
}

function quitApp() {
  isQuitting = true;
  globalShortcut.unregisterAll();
  app.quit();
}

// ================================================================ IPC

function registerIpc() {
  ipcMain.handle('get-state', () => snapshot());

  ipcMain.handle('save-config', async (_e, patch) => {
    const before = {
      theme: config.data.theme,
      accent: config.data.accentColor,
      interval: config.data.syncIntervalMin,
    };
    config.update(patch || {});
    if (patch && patch.password === '') config.update({ password: '' });
    if (patch && 'autoLaunch' in patch) applyAutoLaunch();
    // 外观即时生效，不必等用户点「保存」
    if (config.data.theme !== before.theme || config.data.accentColor !== before.accent) applyTheme();
    if (config.data.syncIntervalMin !== before.interval) scheduleAutoSync();
    broadcast();
    return snapshot().config;
  });

  ipcMain.handle('test-connection', async () => {
    try {
      const client = makeClient();
      const { home, calendars } = await client.discover();
      const cal = calendars[0];
      let todoCount = 0;
      if (cal) {
        try { todoCount = (await client.listTodos(cal.href)).length; }
        catch (e) { todoCount = -1; }
      }
      return { ok: true, home, calendars, todoCount };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('sync', async () => runSync('manual'));

  ipcMain.handle('task:save', async (_e, todo) => {
    const t = Object.assign({}, todo);
    if (!t.uid) t.uid = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}@taskslite`;
    const calHref = store.data.calendarHref;
    return pushOrQueue({ op: 'put', todo: t, baseEtag: t.etag || null }, async (client) => {
      const href = calHref || (await ensureCalendar(client)).href;
      const r = await client.putTodo(href, t, t.etag || null);
      return Object.assign({}, t, { href: r.href, etag: r.etag });
    });
  });

  /** 移进回收站：本地留档，服务器上真删，误删了能原样恢复 */
  ipcMain.handle('task:trash', async (_e, uid) => {
    const t = store.moveToTrash(uid);
    if (!t) return { ok: true };

    // 子任务不能认一个已经在回收站里的父任务，否则会缩进到看不见的地方
    for (const c of store.tasks.filter((x) => x.parentUid === uid)) {
      c.parentUid = '';
      store.upsert(c);
      await pushOrQueue({ op: 'put', todo: c, baseEtag: c.etag || null }, async (client) => {
        const href = store.data.calendarHref || (await ensureCalendar(client)).href;
        const r = await client.putTodo(href, c, c.etag || null);
        return Object.assign({}, c, { href: r.href, etag: r.etag });
      });
    }

    if (t.href) {
      await pushOrQueue({ op: 'delete', uid, href: t.href, etag: t.etag || null }, async (client) => {
        await client.deleteTodo(client.absolute(t.href), t.etag || null);
        return { uid };
      });
    }
    delete store.data.reminded[uid];
    store.save();
    broadcast();
    return { ok: true };
  });

  /** 从回收站恢复：服务器上那条已经删了，所以清掉 href/etag 重新 PUT */
  ipcMain.handle('task:restore', async (_e, uid) => {
    const t = store.restoreFromTrash(uid);
    if (!t) return { ok: true };
    await pushOrQueue({ op: 'put', todo: t, baseEtag: null }, async (client) => {
      const href = store.data.calendarHref || (await ensureCalendar(client)).href;
      const r = await client.putTodo(href, t, null);
      return Object.assign({}, t, { href: r.href, etag: r.etag });
    });
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('trash:purge', (_e, uid) => {
    store.purgeFromTrash(uid);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('trash:empty', () => {
    store.emptyTrash();
    broadcast();
    return { ok: true };
  });

  /** 手动扫一遍到点的提醒，设置完想立刻看到效果时用 */
  ipcMain.handle('reminder:check', () => ({ fired: checkReminders() }));

  ipcMain.handle('task:toggle', async (_e, uid, completed) => {
    const t = store.get(uid);
    if (!t) return { ok: false };
    t.completed = !!completed;
    store.upsert(t);
    broadcast();
    if (completed && Notification.isSupported()) {
      new Notification({ title: '任务完成', body: t.title }).show();
    }
    return pushOrQueue({ op: 'put', todo: t, baseEtag: t.etag || null }, async (client) => {
      const r = await client.putTodo(store.data.calendarHref, t, t.etag || null);
      return Object.assign({}, t, { href: r.href, etag: r.etag });
    });
  });
}

// ================================================================ 定时同步

function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  const min = Math.max(1, Number(config.data.syncIntervalMin) || 5);
  syncTimer = setInterval(() => runSync('auto'), min * 60 * 1000);
}

// ================================================================ 菜单

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '立即同步', accelerator: 'CmdOrCtrl+R', click: () => runSync('manual') },
        { label: '测试提醒通知', click: () => { checkReminders(); } },
        { label: '显示 / 隐藏', accelerator: GLOBAL_TOGGLE, click: toggleWindow },
        { type: 'separator' },
        { label: '退出', click: quitApp },
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
            message: 'Tasks Lite 1.2.0',
            detail: '本地 CalDAV 待办客户端。\n数据存在你自己搭的 CalDAV 服务器上，不经过任何第三方。\n\n'
                    + `Electron ${process.versions.electron} / Chrome ${process.versions.chrome}\nNode ${process.versions.node}\n`
                    + `全局快捷键 ${GLOBAL_TOGGLE}`,
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
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    config = new Config(userData);
    store = new Store(userData);

    // 主题跟随系统时，系统切换深浅色会触发 updated，这里重新广播给渲染进程
    nativeTheme.on('updated', applyTheme);
    applyTheme();

    registerIpc();
    buildMenu();
    createTray();

    const startHidden = process.argv.includes('--hidden');
    createWindow(startHidden);

    applyAutoLaunch();

    const ok = globalShortcut.register(GLOBAL_TOGGLE, toggleWindow);
    if (!ok) console.error(`[shortcut] 全局快捷键 ${GLOBAL_TOGGLE} 注册失败（可能已被占用）`);

    scheduleAutoSync();
    scheduleReminders();
    setTimeout(() => runSync('startup'), 1200);

    app.on('activate', () => showWindow());
  });

  // 注意：这里不处理 window-all-closed —— 关窗口只是缩回托盘，进程要留着
  app.on('before-quit', () => { isQuitting = true; });
}
