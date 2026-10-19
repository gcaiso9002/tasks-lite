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

  upsert(todo, opts) {
    // 已经在回收站里的任务，不许被重新塞回任务列表。
    //
    // 典型场景：断网时新建一条 → 顺手删进回收站 → 网络恢复。
    // 待传队列里那条 put 操作这时被重放成功了，store.upsert 一执行，
    // 删掉的任务就"复活"回到列表里，而且它是真的被 PUT 回服务器的。
    // 挡在这里比在每个调用点判断可靠 —— 复活这条路必须堵死。
    const trashed = this.data.trash.find((t) => t.uid === todo.uid);
    if (trashed) {
      // 服务器信息（href/etag）还是要更新，将来从回收站恢复时用得上
      if (todo.href) trashed.href = todo.href;
      if (todo.etag) trashed.etag = todo.etag;
      if (opts && opts.dirty) trashed.dirty = true;
      this.save();
      return;
    }
    const i = this.data.tasks.findIndex((t) => t.uid === todo.uid);
    const next = Object.assign({}, this.data.tasks[i] || {}, todo);
    // dirty = 这条有还没被服务器确认的本地改动。拉取时不能被服务器版本盖掉。
    if (opts && opts.dirty) next.dirty = true;
    if (i >= 0) this.data.tasks[i] = next;
    else this.data.tasks.push(next);
    this.save();
  }

  /**
   * 撤掉某个任务的待传操作。
   *
   * 用在"这条已经不需要传上去了"的地方：比如一条从没传上去过的新任务
   * 被删进回收站 —— 服务器上根本没有它，队列里那条 put 就是多余的，
   * 不撤掉的话网络一恢复它还会被推上去。
   */
  removePending(uid) {
    const before = this.data.pending.length;
    this.data.pending = this.data.pending.filter((op) => (op.uid || (op.todo && op.todo.uid)) !== uid);
    const removed = before - this.data.pending.length;
    if (removed) this.save();
    return removed;
  }

  /** 服务器已经收下这条改动了，清掉脏标记 */
  markClean(uid) {
    const t = this.data.tasks.find((x) => x.uid === uid);
    const tr = this.data.trash.find((x) => x.uid === uid);
    if ((t && t.dirty) || (tr && tr.dirty)) {
      if (t) delete t.dirty;
      if (tr) delete tr.dirty;
      this.save();
    }
  }

  /** 待传队列里涉及的 uid 集合 */
  pendingUids() {
    return new Set(this.data.pending.map((op) => op.uid || (op.todo && op.todo.uid)).filter(Boolean));
  }

  /**
   * 拉取服务器数据并**合并**进本地。
   *
   * 不是覆盖 —— 服务器是权威，但「本地有还没上传的改动」优先级更高：
   *   - 有待传操作（改了/删了还没传上去）：服务器版本一律不覆盖它，
   *     只吸收服务器带来的 href / etag，免得下次推送用过期 etag 撞 412。
   *   - 标了 dirty（本地有改动但队列里已经没有对应操作了）：内容同样以本地为准。
   * 否则用户改了一半还没传上去，一次全量拉取就把他的改动静默改回去了。
   */
  upsertMany(list, pendingUids) {
    const pend = pendingUids || new Set();
    const trashed = new Set(this.data.trash.map((t) => t.uid));
    const byUid = new Map(this.data.tasks.map((t) => [t.uid, t]));
    for (const t of list) {
      const local = byUid.get(t.uid);
      if (pend.has(t.uid) || trashed.has(t.uid) || (local && local.dirty)) {
        // 本地有未完成的操作：保留本地内容，只更新服务器侧的元信息
        if (local) byUid.set(t.uid, Object.assign({}, local, { href: t.href, etag: t.etag }));
        // local 不存在 = 这条是本地删掉但还没传上去的，别让它从服务器"复活"
        continue;
      }
      byUid.set(t.uid, Object.assign({}, byUid.get(t.uid) || {}, t));
    }
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
      if (t.dirty) return true;      // 有没上传的改动，绝不能删
      if (!t.href) return true;      // 从没上传过，保留
      return false;                  // 服务器上没了 → 删
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

  /**
   * 从回收站彻底删掉。
   *
   * 连同待传队列里这条的操作一起撤掉：它已经被用户判定为"不要了"，
   * 留着的话网络一恢复它还会被推回服务器，再下一次同步时冒回列表里。
   */
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

  /**
   * 记一次同步完成的时间。
   *
   * 注意：**不要**在这里清空 pending 队列。待传操作是逐条管理的 ——
   * 推送成功才移除那一条。一次性清空等于把还没传上去的改动直接丢掉。
   */
  markSynced() {
    this.data.lastSync = new Date().toISOString();
    this.save();
  }

  /**
   * 把一次操作放进待传队列。
   *
   * 同一条任务只保留**最新**的一次：离线时反复改同一条，攒五个操作没意义，
   * 而且老操作带的是过期的 etag，上传时会互相打架（412）。
   * 最新的一次带的是完整任务内容，直接覆盖掉旧的就行。
   */
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

module.exports = { Store };
