'use strict';

/**
 * Android / 浏览器端的 window.api 实现。
 *
 * 桌面版由 Electron preload 通过 IPC 暴露 window.api；WebView 里没有 IPC，
 * 所以这里用同一套方法名、同一套 state 结构重新实现一遍，
 * 渲染层（src/renderer/app.js）可以原样复用。
 *
 * 网络请求走 window.fetch。Capacitor 开启 CapacitorHttp 后，
 * fetch 会被原生层接管，从而绕过 CalDAV 服务器没有 CORS 头的问题。
 */

const { CaldavClient } = require('../main/caldav');
const { cascadeCompletion } = require('../shared/cascade');
const { WebStore } = require('./store-web');

const CONFIG_KEY = 'taskslite.config.v1';
const ACCENT_FALLBACK = '#4f8cff';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

const CONFIG_DEFAULTS = {
  server: '',
  username: '',
  password: '',
  syncIntervalMin: 10,
  autoLaunch: false,
  theme: 'system',
  accentColor: '',
  proxyMode: 'direct',
};

let config = Object.assign({}, CONFIG_DEFAULTS, readJson(CONFIG_KEY));
const store = new WebStore();
const syncState = { syncing: false, error: null, reason: '' };
const listeners = [];
let syncTimer = null;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('[config] 读取失败：', e.message);
    return {};
  }
}

function writeConfig() {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    console.error('[config] 写入失败：', e.message);
  }
}

function resolvedTheme() {
  if (config.theme === 'dark' || config.theme === 'light') return config.theme;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  return mq && mq.matches ? 'dark' : 'light';
}

function accentColor() {
  const c = String(config.accentColor || '').trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : ACCENT_FALLBACK;
}

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

function snapshot() {
  return {
    tasks: store.tasks,
    trash: store.trash,
    lists: collectLists(),
    tags: collectTags(),
    config: Object.assign({}, config, {
      hasPassword: !!config.password,
      password: undefined,
      resolvedTheme: resolvedTheme(),
      accent: accentColor(),
    }),
    sync: Object.assign({}, syncState, {
      lastSync: store.data.lastSync,
      pendingCount: store.data.pending.length,
      dirtyCount: store.tasks.filter((t) => t.dirty).length,
    }),
  };
}

function broadcast() {
  const s = snapshot();
  for (const cb of listeners) {
    try { cb(s); } catch (e) { console.error('[api] 订阅回调出错：', e.message); }
  }
}

function newUid() {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${Date.now()}-${rand}@taskslite`;
}

// ---------------------------------------------------------------- CalDAV

function makeClient() {
  if (!config.server || !config.username || !config.password) {
    throw new Error('还没有配置服务器地址、用户名和密码');
  }
  return new CaldavClient({
    fetchImpl: (url, init) => fetch(url, init),
    baseUrl: config.server,
    username: config.username,
    password: config.password,
  });
}

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

/** 推一条改动；失败就留在待传队列里，下轮重试 */
async function pushOrQueue(op, clientFn) {
  try {
    const client = makeClient();
    const saved = await clientFn(client);
    store.markClean(op.uid || (op.todo && op.todo.uid));
    return { ok: true, todo: saved };
  } catch (e) {
    store.enqueue(op);
    return { ok: false, queued: true, error: e.message || String(e) };
  }
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

    for (const op of store.data.pending.slice()) {
      try {
        if (op.op === 'put') {
          const r = await client.putTodoResilient(cal.href, op.todo, op.baseEtag);
          store.upsert(Object.assign({}, op.todo, { href: r.href, etag: r.etag }));
          store.markClean(op.todo.uid);
        } else if (op.op === 'delete') {
          await client.deleteTodoResilient(op.href, op.etag);
          store.remove(op.uid);
        }
        const i = store.data.pending.indexOf(op);
        if (i >= 0) store.data.pending.splice(i, 1);
        store.save();
      } catch (e) {
        // 单条失败不影响后面的操作
        console.warn(`[sync] ${op.op} 失败，保留在待传队列：${e.message}`);
      }
    }

    const remote = await client.listTodos(cal.href);
    const pendUids = store.pendingUids();
    store.upsertMany(remote, pendUids);
    store.pruneMissing(new Set(remote.map((t) => t.uid)), pendUids);
    store.markSynced();
    return { ok: true, pulled: remote.length };
  } catch (e) {
    syncState.error = e.message || String(e);
    return { ok: false, error: syncState.error };
  } finally {
    syncState.syncing = false;
    broadcast();
  }
}

function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  const min = Math.max(1, Number(config.syncIntervalMin) || 10);
  syncTimer = setInterval(() => runSync('auto'), min * 60 * 1000);
}

// ---------------------------------------------------------------- 通知

function notify(title, body) {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
      return 'web';
    }
    return 'permission-denied';
  } catch (e) {
    console.error('[notify] 失败：', e.message);
    return 'error';
  }
}

/** 扫一遍到点的任务；同一个 remindAt 只弹一次 */
function checkReminders() {
  let fired = 0;
  for (const t of store.tasks) {
    if (t.completed || !t.remindAt) continue;
    const ts = new Date(t.remindAt).getTime();
    if (!Number.isFinite(ts) || ts > Date.now()) continue;
    // 超过一天的老提醒不再打扰
    if (Date.now() - ts > 24 * 60 * 60 * 1000) continue;
    if (store.alreadyReminded(t.uid, t.remindAt)) continue;
    store.markReminded(t.uid, t.remindAt);
    notify('任务提醒', t.title || '(无标题)');
    fired++;
  }
  return fired;
}

// ---------------------------------------------------------------- 对外 API

const api = {
  getState: async () => snapshot(),
  getVersion: async () => APP_VERSION,

  saveConfig: async (patch) => {
    const before = { theme: config.theme, accent: config.accentColor, interval: config.syncIntervalMin };
    Object.assign(config, patch || {});
    writeConfig();
    if (config.accentColor && !/^#[0-9a-f]{6}$/i.test(config.accentColor)) config.accentColor = '';
    if (config.theme !== before.theme || config.accentColor !== before.accent) writeConfig();
    if (config.syncIntervalMin !== before.interval) scheduleAutoSync();
    broadcast();
    return snapshot().config;
  },

  testConnection: async () => {
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
  },

  sync: async () => runSync('manual'),

  saveTask: async (todo) => {
    const t = Object.assign({}, todo);
    const isNew = !t.uid;
    if (!t.uid) t.uid = newUid();

    store.upsert(t, { dirty: true });
    broadcast();

    const r = await pushOrQueue({ op: 'put', todo: t, baseEtag: t.etag || null }, async (client) => {
      const href = store.data.calendarHref || (await ensureCalendar(client)).href;
      const r2 = await client.putTodoResilient(href, t, t.etag || null);
      const saved = Object.assign({}, t, { href: r2.href, etag: r2.etag });
      store.upsert(saved);
      return saved;
    });
    if (isNew && r && r.ok) setTimeout(() => runSync('after-add'), 300);
    return r;
  },

  trashTask: async (uid) => {
    const t = store.moveToTrash(uid);
    if (!t) return { ok: true };

    // 子任务不能挂在已经进回收站的父任务下面
    for (const c of store.tasks.filter((x) => x.parentUid === uid)) {
      c.parentUid = '';
      store.upsert(c);
      await pushOrQueue({ op: 'put', todo: c, baseEtag: c.etag || null }, async (client) => {
        const href = store.data.calendarHref || (await ensureCalendar(client)).href;
        const r = await client.putTodoResilient(href, c, c.etag || null);
        store.upsert(Object.assign({}, c, { href: r.href, etag: r.etag }));
        return c;
      });
    }

    if (t.href) {
      await pushOrQueue({ op: 'delete', uid, href: t.href, etag: t.etag || null }, async (client) => {
        await client.deleteTodoResilient(t.href, t.etag || null);
        return { uid };
      });
    } else {
      store.removePending(uid);
    }
    delete store.data.reminded[uid];
    store.save();
    broadcast();
    return { ok: true };
  },

  restoreTask: async (uid) => {
    const t = store.restoreFromTrash(uid);
    if (!t) return { ok: true };
    store.upsert(t, { dirty: true });
    broadcast();
    await pushOrQueue({ op: 'put', todo: t, baseEtag: null }, async (client) => {
      const href = store.data.calendarHref || (await ensureCalendar(client)).href;
      const r = await client.putTodoResilient(href, t, null);
      store.upsert(Object.assign({}, t, { href: r.href, etag: r.etag }));
      return t;
    });
    broadcast();
    return { ok: true };
  },

  purgeTask: async (uid) => {
    store.purgeFromTrash(uid);
    broadcast();
    return { ok: true };
  },

  emptyTrash: async () => {
    store.emptyTrash();
    broadcast();
    return { ok: true };
  },

  checkReminders: async () => ({ fired: checkReminders() }),

  testNotification: async () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    const channel = notify('Tasks Lite', '通知测试成功');
    return { channel, supported: typeof Notification !== 'undefined' };
  },

  netDiag: async () => ({
    ok: true,
    lines: [
      `平台：Android（Capacitor WebView）`,
      `连接方式：系统网络栈直连（CapacitorHttp）`,
      `服务器：${config.server || '未配置'}`,
    ],
  }),

  toggleTask: async (uid, completed) => {
    const t = store.get(uid);
    if (!t) return { ok: false };
    t.completed = !!completed;
    store.upsert(t, { dirty: true });

    const cascaded = cascadeCompletion(store.tasks, uid, !!completed);
    for (const p of cascaded) store.upsert(p, { dirty: true });
    broadcast();

    const push = (x) => pushOrQueue({ op: 'put', todo: x, baseEtag: x.etag || null }, async (client) => {
      const href = store.data.calendarHref || (await ensureCalendar(client)).href;
      const r = await client.putTodoResilient(href, x, x.etag || null);
      store.upsert(Object.assign({}, x, { href: r.href, etag: r.etag }));
      return x;
    });

    const r = await push(t);
    for (const p of cascaded) await push(p);
    broadcast();
    return Object.assign({}, r, { cascaded: cascaded.map((p) => p.title || '(无标题)') });
  },

  toggleMyDay: async (uid, on) => {
    const t = store.get(uid);
    if (!t) return { ok: false };
    t.myDay = !!on;
    store.upsert(t, { dirty: true });
    broadcast();
    return pushOrQueue({ op: 'put', todo: t, baseEtag: t.etag || null }, async (client) => {
      const href = store.data.calendarHref || (await ensureCalendar(client)).href;
      const r = await client.putTodoResilient(href, t, t.etag || null);
      return Object.assign({}, t, { href: r.href, etag: r.etag });
    });
  },

  onState: (cb) => {
    listeners.push(cb);
    // 注册后立刻推一次，避免错过启动瞬间的变更
    setTimeout(() => { try { cb(snapshot()); } catch (e) { /* ignore */ } }, 0);
  },

  onFocusComposer: () => {},
  onOpenTask: () => {},
};

window.api = api;

// 首次启动就把定时同步和提醒跑起来
scheduleAutoSync();
setInterval(checkReminders, 60 * 1000);
if (!config.server) {
  // 还没配置服务器时也先广播一次，让界面拿到默认配置
  setTimeout(broadcast, 0);
}
