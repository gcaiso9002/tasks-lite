'use strict';
// A/B：用真实 tasks.json 对比「修复前（平铺+按 parentUid 缩进）」与「修复后（父子重排）」
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('找不到 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('花括号不配对 ' + name);
}

const groupByHierarchy = new Function(`${extractFn('groupByHierarchy')}\nreturn groupByHierarchy;`)();
const depthOf = new Function(`${extractFn('depthOf')}\nreturn depthOf;`)();

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tasks = data.tasks.filter((t) => !t.completed);

// 复刻 visibleTasks 的排序
const byUid = new Map(tasks.map((t) => [t.uid, t]));
function sorted(list) {
  return list.slice().sort((a, b) => {
    if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
    const pa = Number(a.priority) || 9, pb = Number(b.priority) || 9;
    if (pa !== pb) return pa - pb;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return (a.title || '').localeCompare(b.title || '', 'zh');
  });
}

const flat = sorted(tasks);
const short = (t) => (t.title || '').slice(0, 26);

console.log('=== 修复前：平铺 + 按 parentUid 缩进（↳ = 有父任务）===');
for (const t of flat.slice(0, 14)) {
  const d = depthOf(t, byUid);
  console.log(`${'  '.repeat(d)}${d ? '↳ ' : ''}${short(t)}`);
}
const misplacedOld = flat.filter((t) => {
  if (!t.parentUid) return false;
  const idx = flat.indexOf(t);
  return !flat[idx - 1] || flat[idx - 1].uid !== t.parentUid;
});
console.log(`\n  → 缩进着但上一行不是它父任务的条数：${misplacedOld.length} / ${flat.length}`);

console.log('\n=== 修复后：父子重排 ===');
const grouped = groupByHierarchy(flat);
for (const { task, depth } of grouped.slice(0, 14)) {
  console.log(`${'  '.repeat(depth)}${depth ? '↳ ' : ''}${short(task)}`);
}
const misplacedNew = grouped.filter((x, i) => {
  if (!x.task.parentUid) return false;
  return !grouped[i - 1] || grouped[i - 1].task.uid !== x.task.parentUid;
});
console.log(`\n  → 缩进着但上一行不是它父任务的条数：${misplacedNew.length} / ${grouped.length}`);
console.log(`\n结论：错位 ${misplacedOld.length} → ${misplacedNew.length}，条数不变 ${flat.length} → ${grouped.length}`);