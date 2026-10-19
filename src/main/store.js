'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 本地任务缓存。服务端是权威数据源，这里只做"离线可看 + 快速渲染"。
 * 结构：{ tasks: [...], trash: [...], calendarHref, calendarName, lastSync, reminded }
 *
 * 回收站和「已弹过提醒」是纯本地的：
 * - 回收站不进服务器，所以不会污染 Task.org 等其它客户端的列表；
 * - reminded 放任务之外，否则每次同步覆盖就会把「提醒过了」的状态冲掉。
 */
class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'tasks.json');
    this.data = {
      tasks: [],
      trash: [],
      calendarHref: null,
      calendarName: null,
      lastSync: null,
      pending: [], // 离线时排队等待上传的操作
      reminded: {}, // uid -> 已弹提醒的时间戳，同一个 remindAt 只弹一次
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
        this.data = Object.assign(this.data, JSON.parse(raw));
        if (!Array.isArray(this.data.tasks)) this.data.tasks = [];
        if (!Array.isArray(this.data.pending)) this.data.pending = [];
        if (!Array.isArray(this.data.trash)) this.data.trash = [];
        if (!this.data.reminded || typeof this.data.reminded !== 'object') this.data.reminded = {};
      }
    } catch (e) {
      // 缓存损坏不该让应用起不来，直接从空开始
      console.error('[store] 读取失败，已重置：', e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[store] 写入失败：', e.message);
    }
  }

  get tasks() {
    return this.data.tasks;
  }

  upsert(todo) {
    const i = this.data.tasks.findIndex((t) => t.uid === todo.uid);
    if (i >= 0) this.data.tasks[i] = Object.assign({}, this.data.tasks[i], todo);
    else this.data.tasks.push(todo);
    this.save();
  }

  upsertMany(list) {
    const byUid = new Map(this.data.tasks.map((t) => [t.uid, t]));
    for (const t of list) byUid.set(t.uid, Object.assign({}, byUid.get(t.uid) || {}, t));
    this.data.tasks = [...byUid.values()];
    this.save();
  }

  /**
   * 服务器是权威：把"以前在服务器上、现在服务器上没了"的本地条目清掉。
   *
   * 只合并不清理的话，在 Task.org / 手机上删掉一条任务，这边的列表里
   * 它会一直挂着，删不掉也同步不掉。
   *
   * 两种情况要留着：
   *   - 正在待传队列里（刚建还没传上去，删了就丢了）
   *   - 从来没传上去过（没有 href，纯本地新建的）
   */
  pruneMissing(remoteUids, pendingUids) {
    const keep = remoteUids || new Set();
    const pend = pendingUids || new Set();
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => {
      if (keep.has(t.uid)) return true;
      if (pend.has(t.uid)) return true;
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

  get(uid) {
    return this.data.tasks.find((t) => t.uid === uid);
  }

  // ---------------------------------------------------------------- 回收站

  get trash() {
    return this.data.trash;
  }

  /** 移进回收站：整条任务原样留下，删干净了还能原样恢复 */
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
    delete t.href;      // 服务器上那条已经删了，恢复时要重新 PUT
    delete t.etag;
    this.data.trash.splice(i, 1);
    this.upsert(t);
    return t;
  }

  purgeFromTrash(uid) {
    this.data.trash = this.data.trash.filter((t) => t.uid !== uid);
    this.save();
  }

  emptyTrash() {
    this.data.trash = [];
    this.save();
  }

  // ---------------------------------------------------------------- 提醒

  /** 这个 remindAt 是否已经弹过了（换了个时间就重新算一次） */
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
    this.data.pending = [];
    this.save();
  }

  enqueue(op) {
    this.data.pending.push(op);
    this.save();
  }
}

module.exports = { Store };
