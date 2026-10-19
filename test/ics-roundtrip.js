'use strict';
// 不联网的纯转换自检：内部对象 → ICS → 内部对象，验证子任务/循环/提醒/标签/列表
// 都能原样往返。这层通过之后，协议层的问题才值得拿真实服务器去测。

const assert = require('assert');
const { buildTodoIcs, parseTodo } = require('../src/main/caldav');

const cases = [];
function roundtrip(name, todo, check) {
  const ics = buildTodoIcs(todo);
  const back = parseTodo(ics, 'https://example.com/c/x.ics', 'etag-1');
  assert.ok(back, `${name}: 解析结果为空`);
  check(back, ics);
  cases.push(name);
  console.log(`  ✅ ${name}`);
}

console.log('子任务 / 循环 / 提醒 / 标签 / 列表 往返测试');

roundtrip('基础字段', {
  uid: 'a@x', title: '买菜', notes: '西红柿\n鸡蛋', priority: 1, due: '2026-11-02',
  completed: false,
}, (t) => {
  assert.strictEqual(t.title, '买菜');
  assert.strictEqual(t.notes, '西红柿\n鸡蛋');
  assert.strictEqual(t.priority, 1);
  assert.strictEqual(t.due, '2026-11-02');
});

roundtrip('子任务上级', {
  uid: 'child@x', title: '洗菜', parentUid: 'parent@x',
}, (t, ics) => {
  assert.strictEqual(t.parentUid, 'parent@x');
  assert.ok(/RELATED-TO;RELTYPE=PARENT:parent@x/i.test(ics), 'ICS 里应有 RELTYPE=PARENT');
});

roundtrip('循环规则', {
  uid: 'r@x', title: '晨跑', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
}, (t, ics) => {
  assert.strictEqual(t.rrule, 'FREQ=WEEKLY;BYDAY=MO,WE,FR');
  assert.ok(/RRULE:FREQ=WEEKLY/i.test(ics), `ICS 里应有 RRULE，实际：\n${ics}`);
});

roundtrip('每日循环', { uid: 'd@x', title: '喝水', rrule: 'FREQ=DAILY' }, (t) => {
  assert.strictEqual(t.rrule, 'FREQ=DAILY');
});

roundtrip('每月循环', { uid: 'm@x', title: '交房租', rrule: 'FREQ=MONTHLY' }, (t) => {
  assert.strictEqual(t.rrule, 'FREQ=MONTHLY');
});

roundtrip('绝对时间提醒', {
  uid: 'a@x', title: '吃药', remindAt: '2026-11-02T08:30',
}, (t, ics) => {
  assert.strictEqual(t.remindAt, '2026-11-02T08:30');
  assert.ok(/BEGIN:VALARM/i.test(ics) && /TRIGGER;VALUE=DATE-TIME/i.test(ics), 'ICS 里应有 VALARM');
});

roundtrip('相对时间提醒（按截止日换算）', {
  uid: 'rel@x', title: '交材料', due: '2026-11-02', remindAt: '2026-11-01T18:00',
}, (t) => {
  // 存的是绝对时间，读回来必须一致
  assert.strictEqual(t.remindAt, '2026-11-01T18:00');
});

roundtrip('标签与列表', {
  uid: 't@x', title: '取快递', tags: ['家', '急'], list: '生活',
}, (t, ics) => {
  assert.deepStrictEqual(t.tags, ['家', '急']);
  assert.strictEqual(t.list, '生活');
  assert.ok(/CATEGORIES:家\\,急/i.test(ics), `ICS 里应有 CATEGORIES，实际：\n${ics}`);
  assert.ok(/X-TASKSLITE-LIST:生活/i.test(ics), 'ICS 里应有 X-TASKSLITE-LIST');
});

roundtrip('中文 emoji 与换行', {
  uid: 'e@x', title: '搞定 octop 搬家 🎉', notes: '第一行\n第二行\t制表符', list: '工作 🏢',
}, (t) => {
  assert.strictEqual(t.title, '搞定 octop 搬家 🎉');
  assert.strictEqual(t.notes, '第一行\n第二行\t制表符');
  assert.strictEqual(t.list, '工作 🏢');
});

roundtrip('已完成', { uid: 'c@x', title: '已完成的事', completed: true }, (t, ics) => {
  assert.strictEqual(t.completed, true);
  assert.ok(/STATUS:COMPLETED/i.test(ics));
});

roundtrip('英文逗号 / 分号 / 反斜杠', {
  uid: 'punct@x',
  title: '买牛奶, 鸡蛋; 面包\\卷',
  notes: '第一行, 有逗号\n第二行; 有分号',
  list: '家, 杂事',
  tags: ['重要'],
}, (t) => {
  assert.strictEqual(t.title, '买牛奶, 鸡蛋; 面包\\卷', t.title);
  assert.strictEqual(t.notes, '第一行, 有逗号\n第二行; 有分号', JSON.stringify(t.notes));
  assert.strictEqual(t.list, '家, 杂事', t.list);
});

roundtrip('今天 + 步骤', {
  uid: 'md@x', title: '今天要做', myDay: '2026-11-02',
  steps: [
    { text: '第一步：查资料', done: true },
    { text: '第二步：写文档，"重点"部分', done: false },
  ],
}, (t, ics) => {
  assert.strictEqual(t.myDay, '2026-11-02');
  assert.strictEqual(t.steps.length, 2);
  assert.strictEqual(t.steps[0].done, true);
  assert.strictEqual(t.steps[1].done, false);
  assert.ok(t.steps[1].text.includes('"重点"'), `步骤里的引号应还原：${t.steps[1].text}`);
  assert.ok(/X-TASKSLITE-MYDAY:2026-11-02/i.test(ics), 'ICS 里应有 X-TASKSLITE-MYDAY');
});

// 步骤字段被外部写坏时不能拖垮整条任务
const badSteps = parseTodo([
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO',
  'UID:bs@x', 'SUMMARY:步骤坏掉', 'X-TASKSLITE-STEPS:{不是合法 JSON',
  'END:VTODO', 'END:VCALENDAR',
].join('\r\n'), 'https://example.com/c/bs.ics', '');
assert.strictEqual(badSteps.title, '步骤坏掉');
assert.deepStrictEqual(badSteps.steps, []);
cases.push('坏步骤数据降级');
console.log('  ✅ 坏步骤数据降级');

// 无效 RRULE 不能让整条任务存崩
const bad = parseTodo(buildTodoIcs({ uid: 'b@x', title: '坏规则', rrule: '这不是RRULE' }), 'https://example.com/c/b.ics', '');
assert.ok(bad && bad.title === '坏规则', '非法 RRULE 不应导致保存失败');
assert.strictEqual(bad.rrule, '');
cases.push('非法 RRULE 降级');
console.log('  ✅ 非法 RRULE 降级');

// 相对 TRIGGER（别的客户端写的 -PT30M）要能换算成绝对时间
const relIcs = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//ZH', 'BEGIN:VTODO',
  'UID:ext@x', 'SUMMARY:别人写的提醒', 'DUE;VALUE=DATE:20261103',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:提醒',
  'TRIGGER:-PT60M', 'END:VALARM', 'END:VTODO', 'END:VCALENDAR',
].join('\r\n');
const relParsed = parseTodo(relIcs, 'https://example.com/c/ext.ics', 'e');
assert.strictEqual(relParsed.remindAt, '2026-11-02T23:00', `相对提醒换算不对：${relParsed.remindAt}`);
cases.push('外部相对 TRIGGER 换算');
console.log('  ✅ 外部相对 TRIGGER 换算');

console.log(`\n全部 ${cases.length} 项通过`);
