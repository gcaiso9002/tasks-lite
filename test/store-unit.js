'use strict';
// 本地缓存层的单测：回收站、提醒去重、父子环保护。
// 这些逻辑不碰网络，用临时目录跑，测完即删。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskslite-store-'));
const s = new Store(dir);

s.setCalendar('https://example.com/c/cal/', 'cal');
s.upsert({ uid: 'p', title: '父任务', etag: 'e1', href: 'https://example.com/c/cal/p.ics' });
s.upsert({ uid: 'c1', title: '子任务一', parentUid: 'p', etag: 'e2' });
s.upsert({ uid: 'c2', title: '子任务二', parentUid: 'c1', etag: 'e3' });

console.log('store 单测');

// 1) 移进回收站：任务从列表消失，进回收站，带删除时间
const moved = s.moveToTrash('p');
assert.ok(moved && moved.uid === 'p');
assert.strictEqual(s.tasks.length, 2, '移走父任务后列表应剩 2 条');
assert.strictEqual(s.trash.length, 1);
assert.ok(s.trash[0].trashedAt, '回收站条目应带 trashedAt');
assert.strictEqual(s.trash[0].title, '父任务', '回收站要留原标题，删除时能看见');

// 2) 恢复：href/etag 必须清掉，否则会以旧 etag 触发 409
const back = s.restoreFromTrash('p');
assert.strictEqual(s.tasks.length, 3);
assert.strictEqual(s.trash.length, 0);
assert.ok(!back.href && !back.etag, '恢复的条目不能带 href/etag');
assert.ok(!('trashedAt' in back), '恢复后不该残留 trashedAt');
console.log('  ✅ 回收站：移入 / 恢复');

// 3) 彻底删除与清空
s.moveToTrash('c1');
assert.strictEqual(s.trash.length, 1);
s.purgeFromTrash('c1');
assert.strictEqual(s.trash.length, 0);
s.moveToTrash('c1');
s.moveToTrash('c2');
s.emptyTrash();
assert.strictEqual(s.trash.length, 0);
assert.strictEqual(s.tasks.length, 1);
console.log('  ✅ 回收站：彻底删除 / 清空');

// 4) 提醒去重：同一个 remindAt 只弹一次，改了时间才重新弹
assert.strictEqual(s.alreadyReminded('p', '2026-11-01T09:00'), false);
s.markReminded('p', '2026-11-01T09:00');
assert.strictEqual(s.alreadyReminded('p', '2026-11-01T09:00'), true);
assert.strictEqual(s.alreadyReminded('p', '2026-11-02T09:00'), false, '改了提醒时间就该重新弹');
console.log('  ✅ 提醒去重');

// 5) 缓存文件被写坏也不能让应用起不来
fs.writeFileSync(path.join(dir, 'tasks.json'), '{ 这不是 JSON');
const broken = new Store(dir);
assert.deepStrictEqual(broken.tasks, []);
assert.deepStrictEqual(broken.trash, []);
assert.deepStrictEqual(broken.data.reminded, {});
console.log('  ✅ 损坏缓存可自愈');

// 6) 老版本缓存没有 trash/reminded 字段时要补默认值
fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: [{ uid: 'old' }] }));
const legacy = new Store(dir);
assert.deepStrictEqual(legacy.trash, []);
assert.deepStrictEqual(legacy.data.reminded, {});
assert.strictEqual(legacy.tasks.length, 1);
console.log('  ✅ 老缓存字段补默认值');

// 7) 服务器是权威：服务器上删掉的，本地也要跟着消失
s.upsert({ uid: 'srv1', title: '在服务器上', href: 'https://example.com/c/cal/srv1.ics', etag: 'x1' });
s.upsert({ uid: 'gone', title: '服务器上已删除', href: 'https://example.com/c/cal/gone.ics', etag: 'x2' });
s.upsert({ uid: 'local', title: '纯本地新建', href: '', etag: '' });
s.upsert({ uid: 'pend', title: '正在补传', href: 'https://example.com/c/cal/pend.ics', etag: 'x3' });
const removed = s.pruneMissing(new Set(['srv1', 'local', 'pend']), new Set(['pend']));
assert.strictEqual(removed, 1, '只有服务器上已删除且不在待传队列里的那条该被清掉');
assert.ok(s.get('srv1'), '服务器上还在的要保留');
assert.ok(s.get('local'), '从没上传过的纯本地条目要保留');
assert.ok(s.get('pend'), '正在待传队列里的要保留');
assert.strictEqual(s.get('gone'), undefined, '服务器上已删除的本地条目要被清掉');
console.log('  ✅ 服务器删掉的本地也跟着清掉');

fs.rmSync(dir, { recursive: true, force: true });
console.log('全部通过');
