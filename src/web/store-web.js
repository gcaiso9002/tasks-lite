'use strict';

/**
 * Android / 浏览器端的本地任务缓存。
 *
 * 桌面版用 Node 的 fs 存 tasks.json；WebView 里没有 fs，所以换成 localStorage。
 * 数据结构和存储语义与 src/main/store.js 保持一致，渲染层不需要区分平台。
 */

const KEY = 'taskslite.state.v1';

function emptyState() {
  return {
    tasks: [],
    trash: [],
    calendarHref: null,
    calendarName: null,
    lastSync: null,
    pending: [],
    reminded: {},
  };
}

class WebStore {
  constructor() {
    this.data = emptyState();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = Object.assign(this.data, JSON.parse(raw));
    } catch (e) {
      console.error('[store] 读取失败：', e.message);
    }
    if (!Array.isArray(this.data.tasks)) this.data.tasks = [];
    if (!Array.isArray(this.data.pending)) this.data.pending = [];
    if (!Array.isArray(this.data.trash)) this.data.trash = [];
    if (!this.data.reminded || typeof this.data.reminded !== 'object') this.data.reminded = {};
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('[store] 写入失败：', e.message);
    }
  }

  get tasks() {
    return this.data.tasks;
  }

  get trash() {
    return this.data.trash;
  }

  get(uid) {
    return this.data.tasks.find((t) => t.uid === uid);
  }

  upsert(todo, opts) {
    const trashed = this.data.trash.find((t) => t.uid === todo.uid);
    if (trashed) {
      if (todo.href) trashed.href = todo.href;
      if (todo.etag) trashed.etag = todo.etag;
      if (opts && opts.dirty) trashed.dirty = true;
      this.save();
      return;
    }
    const i = this.data.tasks.findIndex((t) => t.uid === todo.uid);
    const next = Object.assign({}, this.data.tasks[i] || {}, todo);
    if (opts && opts.dirty) next.dirty = true;
    if (i >= 0) this.data.tasks[i] = next;
    else this.data.tasks.push(next);
    this.save();
  }

  upsertMany(list, pendingUids) {
    const pend = pendingUids || new Set();
    const trashed = new Set(this.data.trash.map((t) => t.uid));
    const byUid = new Map(this.data.tasks.map((t) => [t.uid, t]));
    for (const t of list) {
      const local = byUid.get(t.uid);
      if (pend.has(t.uid) || trashed.has(t.uid) || (local && local.dirty)) {
        if (local) byUid.set(t.uid, Object.assign({}, local, { href: t.href, etag: t.etag }));
        continue;
      }
      byUid.set(t.uid, Object.assign({}, byUid.get(t.uid) || {}, t));
    }
    this.data.tasks = [...byUid.values()];
    this.save();
  }

  pruneMissing(remoteUids, pendingUids) {
    const keep = remoteUids || new Set();
    const pend = pendingUids || new Set();
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => {
      if (keep.has(t.uid)) return true;
      if (pend.has(t.uid)) return true;
      if (t.dirty) return true;
      if (!t.href) return true;
      return false;
    });
    const removed = before - this.data.tasks.length;
    if (removed) this.save();
    return removed;
  }

  remove(uid) {
    this.data.tasks = this.data.tasks.filter((t) => t.uid !== uid);
    this.save();
  }

  removePending(uid) {
    const before = this.data.pending.length;
    this.data.pending = this.data.pending.filter((op) => (op.uid || (op.todo && op.todo.uid)) !== uid);
    const removed = before - this.data.pending.length;
    if (removed) this.save();
    return removed;
  }

  markClean(uid) {
    const t = this.data.tasks.find((x) => x.uid === uid);
    const tr = this.data.trash.find((x) => x.uid === uid);
    if ((t && t.dirty) || (tr && tr.dirty)) {
      if (t) delete t.dirty;
      if (tr) delete tr.dirty;
      this.save();
    }
  }

  pendingUids() {
    return new Set(this.data.pending.map((op) => op.uid || (op.todo && op.todo.uid)).filter(Boolean));
  }

  moveToTrash(uid) {
    const t = this.get(uid);
    if (!t) return null;
    this.remove(uid);
    this.data.trash.unshift(Object.assign({}, t, { trashedAt: new Date().toISOString() }));
    this.save();
    return t;
  }

  restoreFromTrash(uid) {
    const i = this.data.trash.findIndex((t) => t.uid === uid);
    if (i < 0) return null;
    const t = Object.assign({}, this.data.trash[i]);
    delete t.trashedAt;
    delete t.href;
    delete t.etag;
    this.data.trash.splice(i, 1);
    this.upsert(t);
    return t;
  }

  purgeFromTrash(uid) {
    this.data.trash = this.data.trash.filter((t) => t.uid !== uid);
    this.removePending(uid);
    this.save();
  }

  emptyTrash() {
    for (const t of this.data.trash) this.removePending(t.uid);
    this.data.trash = [];
    this.save();
  }

  alreadyReminded(uid, remindAt) {
    return this.data.reminded[uid] === remindAt;
  }

  markReminded(uid, remindAt) {
    this.data.reminded[uid] = remindAt;
    this.save();
  }

  setCalendar(href, name) {
    this.data.calendarHref = href;
    this.data.calendarName = name;
    this.save();
  }

  markSynced() {
    this.data.lastSync = new Date().toISOString();
    this.save();
  }

  enqueue(op) {
    const uid = op.uid || (op.todo && op.todo.uid);
    if (uid) {
      const i = this.data.pending.findIndex((x) => (x.uid || (x.todo && x.todo.uid)) === uid);
      if (i >= 0) this.data.pending[i] = op;
      else this.data.pending.push(op);
    } else {
      this.data.pending.push(op);
    }
    this.save();
  }
}

module.exports = { WebStore };
