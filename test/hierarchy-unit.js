'use strict';
// 开发期自检：列表的父子层级重排（groupByHierarchy）。
//
// 修的是这个 bug：列表按「未完成→优先级→截止日→标题」全局排序，
// 完全不看父子关系；渲染时却按 parentUid 缩进。于是子任务会被缩进着
// 插在某个毫不相干的邻居下面，看起来像那个邻居的孩子。
// 真实症状：手机上 Task.org 正常（它用 ⌃N 折叠），桌面端「在rk3588上面
// 部署一个paddle」的孩子散落在列表各处，父任务自己跑到最底下。
//
// app.js 是浏览器脚本（直接摸 document/window），没法 require，
// 所以这里只把那个纯函数抠出来单独跑。它是自包含的，不引用外部变量。

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js 里找不到函数 ${name}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 的花括号不配对`);
}

// eslint-disable-next-line no-new-func
const groupByHierarchy = new Function(`${extractFn('groupByHierarchy')}\nreturn groupByHierarchy;`)();

let pass = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  OK  ' + name);
  } else {
    fails.push(name + (detail ? `  → ${detail}` : ''));
    console.log('  FAIL ' + name + (detail ? `  → ${detail}` : ''));
  }
}

const shape = (out) => out.map((x) => `${x.task.uid}@${x.depth}`).join(',');

// ---------------------------------------------------------------- 1
// 父任务和两个孩子全局排序后并不相邻 → 必须被重排成 父,子,子
{
  const parent = { uid: 'P', title: '在rk3588上面部署一个paddle', parentUid: '' };
  const kid1 = { uid: 'K1', title: '搞定桌面软件', parentUid: 'P' };
  const other = { uid: 'O', title: '搞定你好小何', parentUid: '' };
  const kid2 = { uid: 'K2', title: '部署paddle ocr', parentUid: 'P' };
  // 假设全局排序后是这个顺序（真实截图里的顺序）
  const sorted = [other, kid1, kid2, parent];
  const out = groupByHierarchy(sorted);
  check('父子被重排到一起', shape(out) === 'O@0,P@0,K1@1,K2@1', shape(out));
  check('孩子紧跟父任务之后', out[1].task.uid === 'P' && out[2].task.uid === 'K1');
}

// ---------------------------------------------------------------- 2
// 父任务被筛选掉（不在可见集）→ 孩子当顶级显示，不能假装是邻居的孩子
{
  const kid = { uid: 'K', parentUid: 'GONE' };
  const other = { uid: 'O', parentUid: '' };
  const out = groupByHierarchy([other, kid]);
  check('父不可见时孩子不缩进', out.find((x) => x.task.uid === 'K').depth === 0, shape(out));
}

// ---------------------------------------------------------------- 3
// 三层：父 → 子 → 孙，深度依次 0/1/2
{
  const g = { uid: 'G', parentUid: '' };
  const s = { uid: 'S', parentUid: 'G' };
  const l = { uid: 'L', parentUid: 'S' };
  const out = groupByHierarchy([l, s, g]);
  check('三层深度正确', shape(out) === 'G@0,S@1,L@2', shape(out));
}

// ---------------------------------------------------------------- 4
// 环路 A→B→A：不能死循环，也不能丢任务
{
  const a = { uid: 'A', parentUid: 'B' };
  const b = { uid: 'B', parentUid: 'A' };
  const out = groupByHierarchy([a, b]);
  const uids = out.map((x) => x.task.uid).sort().join(',');
  check('环路不死循环且不丢项', out.length === 2 && uids === 'A,B', shape(out));
}

// ---------------------------------------------------------------- 5
// 自我引用 parentUid === uid：当顶级，不缩进
{
  const self = { uid: 'S', parentUid: 'S' };
  const out = groupByHierarchy([self]);
  check('自引用当顶级', out.length === 1 && out[0].depth === 0, shape(out));
}

// ---------------------------------------------------------------- 6
// 兄弟之间保持传入时的排序（不能因为重排把优先级顺序打乱）
{
  const p = { uid: 'P', parentUid: '' };
  const k1 = { uid: 'K1', parentUid: 'P' };
  const k2 = { uid: 'K2', parentUid: 'P' };
  const k3 = { uid: 'K3', parentUid: 'P' };
  const out = groupByHierarchy([p, k1, k2, k3]);
  check('兄弟顺序不变', shape(out) === 'P@0,K1@1,K2@1,K3@1', shape(out));
}

// ---------------------------------------------------------------- 7
// 空列表 / 无父任务的全平铺：顺序原样
{
  const out = groupByHierarchy([
    { uid: 'A', parentUid: '' },
    { uid: 'B', parentUid: '' },
  ]);
  check('全平铺顺序不变', shape(out) === 'A@0,B@0', shape(out));
  check('空列表返回空', groupByHierarchy([]).length === 0);
}

// ---------------------------------------------------------------- 汇总
console.log('');
if (fails.length) {
  console.error(`❌ 层级重排：${pass} 通过 / ${fails.length} 失败`);
  fails.forEach((f) => console.error('   ' + f));
  process.exit(1);
}
console.log(`✅ 层级重排：${pass} 项全部通过`);