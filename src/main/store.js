'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 本地任务缓存。服务端是权威数据源，这里只做"离线可看 + 快速渲染"。
 * 结构：{ tasks: [...], calendarHref, calendarName, lastSync }
 */
class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'tasks.json');
    this.data = {
      tasks: [],
      calendarHref: null,
      calendarName: null,
      lastSync: null,
      pending: [], // 离线时排队等待上传的操作
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = Object.assign(this.data, raw);
        if (!Array.isArray(this.data.tasks)) this.data.tasks = [];
        if (!Array.isArray(this.data.pending)) this.data.pending = [];
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

  remove(uid) {
    this.data.tasks = this.data.tasks.filter((t) => t.uid !== uid);
    this.save();
  }

  get(uid) {
    return this.data.tasks.find((t) => t.uid === uid);
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
