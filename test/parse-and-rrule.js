'use strict';
// 离线单测：RRULE 下一次日期计算 + 快速添加的智能解析。
// 日期相关的断言都用「相对今天」构造，避免测试哪天跑都会挂。

const assert = require('assert');
const { parseRrule, nextOccurrence, seriesUid } = require('../src/main/rrule');
const { parseQuickInput } = require('../src/renderer/quick-parse');

const p2 = (n) => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function dayOffset(n) { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }

let pass = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); process.exitCode = 1; }
}

console.log('\n=== RRULE 下一次 ===');

check('每天', nextOccurrence('FREQ=DAILY', '2026-11-02') === '2026-11-03', nextOccurrence('FREQ=DAILY', '2026-11-02'));
check('每 3 天', nextOccurrence('FREQ=DAILY;INTERVAL=3', '2026-11-02') === '2026-11-05', nextOccurrence('FREQ=DAILY;INTERVAL=3', '2026-11-02'));
check('每周（同一天）', nextOccurrence('FREQ=WEEKLY', '2026-11-02') === '2026-11-09', nextOccurrence('FREQ=WEEKLY', '2026-11-02'));
check('每周一三五', nextOccurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-11-02') === '2026-11-04',
  nextOccurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-11-02'));
check('每周日（跨周）', nextOccurrence('FREQ=WEEKLY;BYDAY=SU', '2026-11-04') === '2026-11-08',
  nextOccurrence('FREQ=WEEKLY;BYDAY=SU', '2026-11-04'));
check('每月 31 号落到 2 月底', nextOccurrence('FREQ=MONTHLY', '2027-01-31') === '2027-02-28',
  nextOccurrence('FREQ=MONTHLY', '2027-01-31'));
check('每月 15 号', nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', '2026-11-20') === '2026-12-15',
  nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', '2026-11-20'));
check('每年', nextOccurrence('FREQ=YEARLY', '2026-11-02') === '2027-11-02', nextOccurrence('FREQ=YEARLY', '2026-11-02'));
check('每 2 年', nextOccurrence('FREQ=YEARLY;INTERVAL=2', '2026-11-02') === '2028-11-02');
check('每季度（INTERVAL=3 月）', nextOccurrence('FREQ=MONTHLY;INTERVAL=3', '2026-11-02') === '2027-02-02',
  nextOccurrence('FREQ=MONTHLY;INTERVAL=3', '2026-11-02'));
check('认不出来的规则返回 null', nextOccurrence('这啥也不是', '2026-11-02') === null);
check('跨月（每月，1月31日）不越界', /^\d{4}-\d{2}-\d{2}$/.test(nextOccurrence('FREQ=MONTHLY', '2026-12-31')));
check('闰年 2/29 下一年落到 2/28', nextOccurrence('FREQ=YEARLY', '2028-02-29') === '2029-02-28',
  nextOccurrence('FREQ=YEARLY', '2028-02-29'));

console.log('\n=== 系列 UID 不撞车 ===');
const u1 = seriesUid('abc@x', '2026-11-03');
const u2 = seriesUid(u1, '2026-11-04');
check('首次滚动', u1 === 'abc@x#20261103', u1);
check('二次滚动会替换而不是叠加', u2 === 'abc@x#20261104', u2);
check('同一日期重复滚动结果稳定', seriesUid(u2, '2026-11-04') === u2);

console.log('\n=== 快速添加解析 ===');

let r = parseQuickInput('买牛奶');
check('纯文本只出标题', r.title === '买牛奶' && !r.due && !r.tags.length, JSON.stringify(r));

r = parseQuickInput('明天买牛奶 #家 @生活 !高');
check('标题去掉修饰', r.title === '买牛奶', r.title);
check('截止日期=明天', r.due === dayOffset(1), r.due);
check('标签', JSON.stringify(r.tags) === '["家"]', JSON.stringify(r.tags));
check('清单', r.list === '生活', r.list);
check('优先级=高', r.priority === 1, r.priority);

r = parseQuickInput('交房租 每月 15号');
check('循环规则', r.rrule === 'FREQ=MONTHLY', r.rrule);
check('15 号', r.due && /-15$/.test(r.due), r.due);
check('标题干净', r.title === '交房租', r.title);

r = parseQuickInput('每天 8:00 吃药');
check('每天', r.rrule === 'FREQ=DAILY', r.rrule);
check('时间 8 点 → 提醒', r.remindAt.endsWith('T08:00'), r.remindAt);

r = parseQuickInput('明天下午3点半 体检 #医院');
check('下午3点半 = 15:30', r.remindAt.endsWith('T15:30'), r.remindAt);
check('提醒落在明天', r.remindAt.startsWith(dayOffset(1)), r.remindAt);

r = parseQuickInput('晚上8点 遛狗');
check('只有时间就用今天', r.remindAt.startsWith(todayStrBase()) && r.remindAt.endsWith('T20:00'), r.remindAt);

r = parseQuickInput('2026-12-25 圣诞聚餐 #家人');
check('完整日期', r.due === '2026-12-25', r.due);
check('标题剩「圣诞聚餐」', r.title === '圣诞聚餐', r.title);

r = parseQuickInput('下周三 例会 @工作');
check('下周三', !!r.due && r.due > todayStrBase(), r.due);
check('周三', new Date(r.due + 'T00:00').getDay() === 3, r.due);

r = parseQuickInput('3天后 复诊');
check('3天后', r.due === dayOffset(3), r.due);

r = parseQuickInput('报销 #工作 # urgent 5号前');
check('两个标签', JSON.stringify(r.tags) === '["工作","urgent"]', JSON.stringify(r.tags));

r = parseQuickInput('每个工作日 站会');
check('每个工作日', r.rrule === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', r.rrule);
check('标题只剩站会', r.title === '站会', r.title);

r = parseQuickInput('整理房间 #家 #大扫除');
check('纯标签场景标题正确', r.title === '整理房间', r.title);

// 过滤掉了转发的正则里那组未使用变量，这里显式清掉，避免 lint 噪音
function todayStrBase() { return dayOffset(0); }

console.log(`\n=== ${pass} 项通过 ===\n`);
