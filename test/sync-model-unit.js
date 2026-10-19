'use strict';
/**
 * 同步模型单测：本地优先 + 脏标记 + 合并拉取。
 *
 * 这套逻辑决定了"我加的东西到底上没上服务器"，是最容易悄悄出错的地方：
 * 写错了不会报错，只会让用户的改动凭空消失。所以每条规则都钉死断言。
 *
 * 全部离线，用临时目录跑，测完即删。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskslite-sync-'));
const s = new Store(dir);
const HREF = (uid) => `https://example.com/c/cal/${uid}.ics`;

console.log('同步模型单测');

// ---------------------------------------------------------------- 1) 脏标记
s.upsert({ uid: 'a', title: '本地新加的', etag: '', href: '' }, { dirty: true });
assert.strictEqual(s.get('a').dirty, true, '新增时应该标脏');
s.upsert({ uid: 'b', title: '服务器上已有的', etag: 'e1', href: HREF('b') });
assert.ok(!s.get('b').dirty, '没改过的任务不该标脏');

s.markClean('a');
assert.ok(!s.get('a').dirty, '推送成功后脏标记要清掉');
s.upsert({ uid: 'c', title: '改了标题', etag: 'e2', href: HREF('c') }, { dirty: true });
console.log('  ✅ 脏标记：本地改动标脏、推送成功清脏');

// ---------------------------------------------------------------- 2) 拉取不覆盖本地改动
s.upsert({ uid: 'new1', title: '新加还没传上去的', etag: '', href: '' }, { dirty: true });
s.upsert({ uid: 'd', title: '本地改过的标题', etag: 'e3', href: HREF('d') }, { dirty: true });
s.upsertMany([
  { uid: 'a', title: '服务器版本A', etag: 'eA', href: HREF('a') },
  { uid: 'b', title: '服务器版本B', etag: 'eB', href: HREF('b') },
  { uid: 'c', title: '服务器版本C（旧的）', etag: 'eC', href: HREF('c') },
  { uid: 'd', title: '服务器版本D（旧的）', etag: 'eD', href: HREF('d') },
  { uid: 'new1', title: '服务器版本new1（不该出现）', etag: 'eN', href: HREF('new1') },
], s.pendingUids());
assert.strictEqual(s.get('b').title, '服务器版本B', '没改过的任务要以服务器为准');
assert.strictEqual(s.get('a').title, '服务器版本A', '已经推送成功的任务，服务器版本就是最新的');
assert.strictEqual(s.get('c').title, '改了标题', '标了 dirty 的任务，服务器版本不能盖掉本地内容');
assert.strictEqual(s.get('d').title, '本地改过的标题', '标了 dirty 的任务，服务器版本不能盖掉本地内容');
assert.strictEqual(s.get('new1').title, '新加还没传上去的', '新加还没传上去的任务，内容以本地为准');
console.log('  ✅ 拉取是合并不是覆盖：本地改动不会被服务器版本冲掉');

// ---------------------------------------------------------------- 3) 待传队列里的任务不被覆盖
s.enqueue({ op: 'put', todo: { uid: 'e', title: '排队中的' }, baseEtag: null });
s.upsert({ uid: 'e', title: '排队中的', etag: '', href: '' }, { dirty: true });
s.upsertMany([{ uid: 'e', title: '服务器版本E', etag: 'eE', href: HREF('e') }], s.pendingUids());
assert.strictEqual(s.get('e').title, '排队中的', '待传队列里的任务不能被服务器版本覆盖');
console.log('  ✅ 待传队列里的任务不受拉取影响');

// ---------------------------------------------------------------- 4) 待传队列去重
s.enqueue({ op: 'put', todo: { uid: 'e', title: '排队中的（改过）' }, baseEtag: null });
assert.strictEqual(s.data.pending.filter((o) => (o.todo && o.todo.uid) === 'e').length, 1,
  '同一条任务反复改只该留最新的一次，不能攒一堆旧操作');
assert.strictEqual(s.data.pending.find((o) => o.todo.uid === 'e').todo.title, '排队中的（改过）',
  '保留的应该是最新那次的改动');
console.log('  ✅ 待传队列按任务去重，只留最新改动');

// ---------------------------------------------------------------- 5) 本地删掉但没传上去的，不许复活
s.moveToTrash('b');
s.enqueue({ op: 'delete', uid: 'b', href: HREF('b'), etag: 'eB' });
s.upsertMany([{ uid: 'b', title: '服务器版本B', etag: 'eB', href: HREF('b') }], s.pendingUids());
assert.strictEqual(s.get('b'), undefined, '本地删掉但还没传上去的任务，不能被拉取"复活"');
console.log('  ✅ 本地删除没传上去的，不会被拉取复活');

// ---------------------------------------------------------------- 6) 清理孤儿任务时跳过脏的
s.upsert({ uid: 'f', title: '服务器上已删但本地有改动', etag: 'eF', href: HREF('f') }, { dirty: true });
s.upsert({ uid: 'g', title: '服务器上已删且本地没改动', etag: 'eG', href: HREF('g') });
const removed = s.pruneMissing(new Set(['a', 'b', 'c', 'd', 'e']), s.pendingUids());
assert.ok(s.get('f'), '有未上传改动的任务不能被当成"服务器上已删除"清掉');
assert.strictEqual(s.get('g'), undefined, '服务器上没了、本地也没改动的，应该清掉');
assert.ok(removed >= 1);
console.log('  ✅ 清理孤儿任务时跳过有未上传改动的');

// ---------------------------------------------------------------- 7) markSynced 不能清空待传队列
s.enqueue({ op: 'put', todo: { uid: 'h', title: '还没传上去的' }, baseEtag: null });
s.markSynced();
assert.ok(s.data.pending.length > 0, 'markSynced 绝不能清空待传队列，否则改动直接丢了');
assert.ok(s.data.lastSync, 'lastSync 还是要记的');
console.log('  ✅ markSynced 只记时间，不清空待传队列');

// ---------------------------------------------------------------- 8) 回收站里的任务不许复活
// 复现过的真 bug：断网时新建一条 → 删进回收站 → 网络恢复，
// 待传队列里那条 put 被重放成功，任务被重新塞回列表（还会被真的 PUT 回服务器）。
s.upsert({ uid: 'i', title: '离线新建的', etag: '', href: '' }, { dirty: true });
s.enqueue({ op: 'put', todo: { uid: 'i', title: '离线新建的' }, baseEtag: null });
s.moveToTrash('i');
// 模拟待传队列重放成功：服务器返回了 href/etag
s.upsert({ uid: 'i', title: '离线新建的', etag: 'eI', href: HREF('i') });
assert.strictEqual(s.get('i'), undefined, '回收站里的任务不能被重新塞回任务列表');
assert.ok(s.trash.find((t) => t.uid === 'i'), '回收站里应该还留着这条');
assert.strictEqual(s.trash.find((t) => t.uid === 'i').href, HREF('i'), '回收站副本要记下服务器信息');
console.log('  ✅ 回收站里的任务不会被 upsert 复活');

// ---------------------------------------------------------------- 9) 删除时要撤掉待传操作
s.upsert({ uid: 'j', title: '要删掉的', etag: '', href: '' }, { dirty: true });
s.enqueue({ op: 'put', todo: { uid: 'j', title: '要删掉的' }, baseEtag: null });
s.moveToTrash('j');
s.removePending('j');
assert.strictEqual(s.data.pending.filter((o) => (o.todo && o.todo.uid) === 'j').length, 0,
  '删除后待传队列里不该还留着这条的 put，否则网络一恢复它又会上传');
console.log('  ✅ 删除任务会撤掉待传队列里的操作');

// ---------------------------------------------------------------- 10) 彻底删除同样要撤掉
s.upsert({ uid: 'k', title: '彻底删掉的', etag: '', href: '' }, { dirty: true });
s.enqueue({ op: 'put', todo: { uid: 'k', title: '彻底删掉的' }, baseEtag: null });
s.moveToTrash('k');
s.purgeFromTrash('k');
assert.strictEqual(s.get('k'), undefined, '彻底删除后列表里不该有它');
assert.strictEqual(s.data.pending.filter((o) => (o.todo && o.todo.uid) === 'k').length, 0,
  '彻底删除后待传队列里不能还留着这条，否则同步时它会冒回列表');
console.log('  ✅ 彻底删除会撤掉待传队列里的操作');

// ---------------------------------------------------------------- 11) 清空回收站也要撤掉
s.upsert({ uid: 'l', title: '清空回收站前的', etag: '', href: '' }, { dirty: true });
s.enqueue({ op: 'put', todo: { uid: 'l', title: '清空回收站前的' }, baseEtag: null });
s.moveToTrash('l');
s.emptyTrash();
assert.strictEqual(s.data.pending.filter((o) => (o.todo && o.todo.uid) === 'l').length, 0,
  '清空回收站后待传队列里不能还留着这些操作');
console.log('  ✅ 清空回收站会撤掉待传队列里的操作');

fs.rmSync(dir, { recursive: true, force: true });
console.log('全部通过');
