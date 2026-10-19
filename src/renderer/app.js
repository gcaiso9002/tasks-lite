'use strict';

let state = { tasks: [], trash: [], lists: [], tags: [], config: {}, sync: {} };
let filter = 'open';          // open | today | overdue | done | all
let smartFilter = '';         // '' 表示不额外筛
let listFilter = '';          // '' 表示不按列表筛
let tagFilter = '';
let view = 'tasks';           // tasks | myday | quadrant | calendar | trash
let dayFilter = '';           // 日历里点某天时，列表只显示这一天
let calCursor = new Date();   // 日历当前月份
let calMode = 'month';        // month | week
let keyword = '';
let editingUid = null;
let editingSteps = [];        // 编辑区里正在改的步骤副本
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const NO_LIST = '未分类';
const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

// ================================================================ 工具

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function priorityLabel(p) {
  if (Number(p) === 1) return '高';
  if (Number(p) === 5) return '中';
  if (Number(p) === 9) return '低';
  return '';
}

function listNameOf(t) {
  return String(t.list || '').trim() || NO_LIST;
}

function shortText(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stepsDone(t) {
  const s = t.steps || [];
  return s.filter((x) => x.done).length;
}

// ================================================================ 主题

const ACCENT_DEFAULT = '#4f8cff';

function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 强调色只存一个色值，hover / 半透明底 / 按钮文字颜色都在这里现算 */
function accentVars(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const light = lum > 0.55;
  const k = light ? 0.82 : 1.18;           // 亮色压深、暗色提亮，当 hover 用
  const mix = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return {
    '--accent': hex,
    '--accent-hover': `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`,
    '--accent-soft': `rgba(${r}, ${g}, ${b}, .16)`,
    '--on-accent': light ? '#141821' : '#ffffff',
  };
}

/** cfg 来自主进程快照；accent 为空表示用默认蓝 */
function applyThemeView(cfg) {
  cfg = cfg || {};
  const root = document.documentElement;
  root.dataset.theme = cfg.resolvedTheme === 'light' ? 'light' : 'dark';
  root.dataset.themeSource = cfg.theme || 'system';
  const accent = /^#[0-9a-f]{6}$/i.test(cfg.accent || '') ? cfg.accent : ACCENT_DEFAULT;
  const vars = accentVars(accent);
  for (const k in vars) root.style.setProperty(k, vars[k]);
  root.style.colorScheme = root.dataset.theme;
}

// ================================================================ 层级

/** 任务在父子树里的缩进层级；带环路保护，最多 10 层 */
function depthOf(t, byUid) {
  let d = 0;
  const seen = new Set([t.uid]);
  let cur = t;
  while (cur && cur.parentUid) {
    const p = byUid.get(cur.parentUid);
    if (!p || seen.has(p.uid)) break;
    seen.add(p.uid);
    cur = p;
    d++;
    if (d >= 10) break;
  }
  return d;
}

/** 自己的子孙，父任务下拉里要排除，否则会选出一个环 */
function descendantUids(uid, tasks) {
  const out = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.parentUid && !out.has(t.uid) && (out.has(t.parentUid) || t.parentUid === uid)) {
        out.add(t.uid);
        changed = true;
      }
    }
  }
  return out;
}

// ================================================================ 过滤

const SMART = {
  tomorrow: (t) => !t.completed && t.due === todayStr(1),
  week: (t) => !t.completed && !!t.due && t.due >= todayStr() && t.due <= todayStr(6),
  next7: (t) => !t.completed && !!t.due && t.due >= todayStr() && t.due <= todayStr(6),
  nodue: (t) => !t.completed && !t.due,
  high: (t) => !t.completed && Number(t.priority) === 1,
  repeat: (t) => !t.completed && !!t.rrule,
  remind: (t) => !t.completed && !!t.remindAt,
  myday: (t) => !t.completed && !!t.myDay,
  parent: (t) => state.tasks.some((x) => x.parentUid === t.uid),
  sub: (t) => !t.completed && !!t.parentUid,
};

/** 侧边栏/筛选条之外的条件，与具体视图无关 */
function passCommon(t) {
  if (smartFilter && SMART[smartFilter] && !SMART[smartFilter](t)) return false;
  if (listFilter && listNameOf(t) !== listFilter) return false;
  if (tagFilter && !(t.tags || []).includes(tagFilter)) return false;
  if (dayFilter && t.due !== dayFilter) return false;
  if (keyword) {
    const k = keyword.toLowerCase();
    if (!((t.title || '').toLowerCase().includes(k) || (t.notes || '').toLowerCase().includes(k))) return false;
  }
  return true;
}

function visibleTasks() {
  const today = todayStr();
  let list = state.tasks.slice();

  if (view === 'myday') {
    // 「今天」= 手动加进来的未完成任务，一直留着直到做完或手动移出
    list = list.filter((t) => !t.completed && t.myDay);
  } else if (filter === 'open') list = list.filter((t) => !t.completed);
  else if (filter === 'done') list = list.filter((t) => t.completed);
  else if (filter === 'today') list = list.filter((t) => !t.completed && t.due && t.due <= today);
  else if (filter === 'overdue') list = list.filter((t) => !t.completed && t.due && t.due < today);

  list = list.filter(passCommon);

  // 未完成在前；组内按优先级、再按截止日、最后按标题
  list.sort((a, b) => {
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

  return list;
}

// ================================================================ 单行任务

function repeatLabel(rrule) {
  const s = String(rrule || '').toUpperCase();
  if (s === 'FREQ=DAILY') return '每天';
  if (s === 'FREQ=WEEKLY') return '每周';
  if (s === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return '工作日';
  if (s === 'FREQ=MONTHLY') return '每月';
  if (s === 'FREQ=YEARLY') return '每年';
  return '循环';
}

function buildRow(t, byUid, extraClass) {
  const depth = depthOf(t, byUid);
  const row = document.createElement('div');
  row.className = 'item' + (t.completed ? ' done' : '') + (editingUid === t.uid ? ' editing' : '')
    + (depth ? ' sub' : '') + (extraClass ? ' ' + extraClass : '');
  row.dataset.uid = t.uid;
  if (depth) row.style.paddingLeft = `${12 + depth * 20}px`;

  const today = todayStr();
  const badges = [];
  const pl = priorityLabel(t.priority);
  if (pl) badges.push(`<span class="badge p${t.priority}">${pl}优先级</span>`);
  if (t.due) {
    const cls = t.completed ? 'due' : t.due < today ? 'overdue' : t.due === today ? 'today' : 'due';
    const label = t.due === today ? '今天' : t.due;
    badges.push(`<span class="badge ${cls}">📅 ${label}</span>`);
  }
  if (t.rrule) badges.push(`<span class="badge repeat">🔁 ${repeatLabel(t.rrule)}</span>`);
  if (t.remindAt) badges.push(`<span class="badge remind">⏰ ${t.remindAt.replace('T', ' ')}</span>`);
  for (const tag of t.tags || []) badges.push(`<span class="badge tag">#${escapeHtml(tag)}</span>`);
  if ((t.steps || []).length) {
    badges.push(`<span class="badge step">☑ ${stepsDone(t)}/${t.steps.length}</span>`);
  }
  if (t.notes) badges.push('<span class="badge note">有备注</span>');
  // dirty = 本地改了还没被服务器确认。标出来，用户才知道"加了到底上去了没有"
  if (t.dirty) badges.push('<span class="badge pending">待上传</span>');

  row.innerHTML = `
    <div class="check" data-act="toggle">✓</div>
    <div class="body">
      <div class="title"></div>
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    </div>
    <button class="myday-btn${t.myDay && !t.completed ? ' on' : ''}" data-act="myday" title="${t.myDay ? '从今天移出' : '加入今天'}">☀</button>
    <button class="del" data-act="del" title="移到回收站">✕</button>`;

  row.querySelector('.title').textContent = t.title || '(无标题)';
  return row;
}

// ================================================================ 渲染

function render() {
  const byUid = new Map(state.tasks.map((t) => [t.uid, t]));
  const main = document.querySelector('.main');
  main.classList.toggle('trash-mode', view === 'trash');
  main.classList.toggle('cal-mode', view === 'calendar');
  main.classList.toggle('quad-mode', view === 'quadrant');

  // 日历/四象限/回收站有自己的"页头"或不需要筛选条，别把两套控件同时摆出来
  $('viewHead').hidden = view !== 'calendar';
  main.querySelector('.filters').hidden = view === 'calendar' || view === 'quadrant' || view === 'trash';
  main.querySelector('.composer').hidden = view === 'calendar' || view === 'quadrant' || view === 'trash';
  $('quickPreview').hidden = true;
  $('empty').hidden = true;

  $('btnTrash').classList.toggle('active', view === 'trash');
  $('btnTrashEmpty').hidden = !(view === 'trash' && state.trash.length);

  const list = $('list');
  const cal = $('calendar');
  list.innerHTML = '';
  cal.innerHTML = '';
  // #calendar 在 HTML 里是带 hidden 的，日历视图下必须显式打开，
  // 否则网格渲出来了也没人看得见（DOM 里有、屏幕上没有，最难查的一种）。
  // 同理日历视图下要收起 #list —— 它是 flex:1，不收的话会把日历挤到屏幕最下面。
  $('calendar').hidden = view !== 'calendar';
  $('list').hidden = view === 'calendar';

  if (view === 'trash') { renderTrash(list); renderSidebar(); renderSyncState(); return; }
  if (view === 'calendar') return renderCalendar(cal);
  if (view === 'quadrant') return renderQuadrant(list, byUid);

  const items = visibleTasks();
  $('empty').hidden = items.length > 0;
  $('count').textContent = view === 'myday'
    ? `${items.length} 项待办`
    : `${state.tasks.filter((t) => !t.completed).length} 项未完成 / 共 ${state.tasks.length} 项`;

  for (const t of items) list.appendChild(buildRow(t, byUid));

  renderSidebar();
  renderSyncState();
}

function renderTrash(list) {
  $('count').textContent = `回收站 ${state.trash.length} 项`;
  $('empty').hidden = state.trash.length > 0;
  if (!state.trash.length) {
    $('empty').querySelector('.empty-text').textContent = '回收站是空的';
    return;
  }
  for (const t of state.trash) {
    const row = document.createElement('div');
    row.className = 'item trash-item';
    row.dataset.uid = t.uid;
    const when = t.trashedAt ? new Date(t.trashedAt).toLocaleString('zh-CN') : '';
    row.innerHTML = `
      <div class="body">
        <div class="title"></div>
        <div class="badges"><span class="badge note">删除于 ${escapeHtml(when)}</span></div>
      </div>
      <button class="ghost tiny" data-act="restore">恢复</button>
      <button class="del show" data-act="purge" title="彻底删除">✕</button>`;
    row.querySelector('.title').textContent = t.title || '(无标题)';
    list.appendChild(row);
  }
}

// ---------------- 四象限 ----------------

function quadrants() {
  const today = todayStr();
  const open = state.tasks.filter((t) => !t.completed && passCommon(t));
  const important = (t) => Number(t.priority) === 1;
  const urgent = (t) => !!t.due && t.due <= today;
  return [
    { key: 'q1', name: '重要且紧急', hint: '马上做', items: open.filter((t) => important(t) && urgent(t)) },
    { key: 'q2', name: '重要不紧急', hint: '排进计划', items: open.filter((t) => important(t) && !urgent(t)) },
    { key: 'q3', name: '紧急不重要', hint: '尽快做或找人', items: open.filter((t) => !important(t) && urgent(t)) },
    { key: 'q4', name: '不重要不紧急', hint: '有空再说', items: open.filter((t) => !important(t) && !urgent(t)) },
  ];
}

function renderQuadrant(list, byUid) {
  const qs = quadrants();
  $('count').textContent = `未完成 ${qs.reduce((n, q) => n + q.items.length, 0)} 项`;
  $('empty').hidden = qs.some((q) => q.items.length);
  qs.forEach((q, i) => {
    const box = document.createElement('section');
    box.className = 'quad';
    const head = document.createElement('div');
    head.className = 'quad-head';
    head.innerHTML = `<span class="quad-name"></span><span class="quad-hint"></span><span class="pill"></span>`;
    head.querySelector('.quad-name').textContent = `${i + 1}. ${q.name}`;
    head.querySelector('.quad-hint').textContent = q.hint;
    head.querySelector('.pill').textContent = String(q.items.length);
    box.appendChild(head);
    if (!q.items.length) {
      const empty = document.createElement('div');
      empty.className = 'quad-empty';
      empty.textContent = '空';
      box.appendChild(empty);
    }
    for (const t of q.items) box.appendChild(buildRow(t, byUid, 'flat'));
    list.appendChild(box);
  });
  renderSidebar();
  renderSyncState();
}

// ---------------- 日历 ----------------

function tasksOnDay(day) {
  return state.tasks
    .filter((t) => t.due === day)
    .sort((a, b) => {
      if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
      return (a.title || '').localeCompare(b.title || '', 'zh');
    });
}

function renderCalendar(cal) {
  const byUid = new Map(state.tasks.map((t) => [t.uid, t]));
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  $('viewMode').value = calMode;
  const monthCount = state.tasks.filter((t) => t.due && t.due.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)).length;

  if (calMode === 'week') {
    const wkStart = mondayOf(calCursor);
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkStart.getDate() + 6);
    const weekCount = state.tasks.filter((t) => t.due && t.due >= ymdOf(wkStart) && t.due <= ymdOf(wkEnd)).length;
    $('viewCount').textContent = `本周 ${weekCount} 项有截止日`;
    $('viewTitle').textContent = weekRangeText(calCursor);
    const grid = document.createElement('div');
    grid.className = 'cal-week';
    const start = mondayOf(calCursor);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const day = ymdOf(d);
      const col = document.createElement('div');
      col.className = 'cal-col' + (day === todayStr() ? ' today' : '');
      col.dataset.day = day;
      const h = document.createElement('div');
      h.className = 'cal-col-head';
      h.textContent = `${m + 1}/${d.getDate()} 周${WEEK_HEAD[i]}`;
      col.appendChild(h);
      for (const t of tasksOnDay(day)) col.appendChild(buildRow(t, byUid, 'mini'));
      if (!tasksOnDay(day).length) {
        const e = document.createElement('div');
        e.className = 'cal-empty';
        e.textContent = '无';
        col.appendChild(e);
      }
      // 周视图的 + 放在列底部（一直可见），月视图的是格子右上角（悬停才出现）
      const addBtn = document.createElement('button');
      addBtn.className = 'cal-add cal-add-bottom';
      addBtn.type = 'button';
      addBtn.title = '在这一天加一条待办';
      addBtn.textContent = '+ 加一条';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCalAdd(col, day, calAdd && calAdd.day === day ? calAdd.value : '');
      });
      col.appendChild(addBtn);
      grid.appendChild(col);
    }
    cal.appendChild(grid);
  } else {
    $('viewCount').textContent = `本月 ${monthCount} 项有截止日`;
    $('viewTitle').textContent = `${y} 年 ${m + 1} 月`;
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    for (const w of WEEK_HEAD) {
      const h = document.createElement('div');
      h.className = 'cal-head';
      h.textContent = `周${w}`;
      grid.appendChild(h);
    }
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7;   // 周一为一周之始
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
    for (let i = 0; i < cells; i++) {
      const d = new Date(y, m, i - lead + 1);
      const day = ymdOf(d);
      const cell = document.createElement('div');
      cell.className = 'cal-cell';
      cell.dataset.day = day;
      if (d.getMonth() !== m) cell.classList.add('out');
      if (day === todayStr()) cell.classList.add('today');
      if (dayFilter === day) cell.classList.add('sel');
      const items = tasksOnDay(day);
      cell.innerHTML = `<div class="cal-num"></div><div class="cal-items"></div>`;
      cell.querySelector('.cal-num').textContent = String(d.getDate());
      const box = cell.querySelector('.cal-items');
      for (const t of items.slice(0, 3)) {
        const chip = document.createElement('div');
        chip.className = 'cal-chip' + (t.completed ? ' done' : '') + (Number(t.priority) === 1 ? ' hi' : '');
        chip.dataset.uid = t.uid;
        chip.textContent = shortText(t.title || '(无标题)', 14);
        box.appendChild(chip);
      }
      if (items.length > 3) {
        const more = document.createElement('div');
        more.className = 'cal-more';
        more.textContent = `+${items.length - 3}`;
        box.appendChild(more);
      }
      // 点空白处筛这一天，点任务条开编辑区 —— 用 target 判断，别抢任务条的点击
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.cal-chip') || e.target.closest('.cal-add') || e.target.closest('.cal-add-wrap')) return;
        dayFilter = dayFilter === day ? '' : day;
        view = dayFilter ? 'tasks' : 'calendar';
        filter = 'all';
        document.querySelectorAll('.filter').forEach((x) => x.classList.remove('active'));
        render();
      });
      attachCalAdd(cell, day);
      grid.appendChild(cell);
    }
    cal.appendChild(grid);
  }
  restoreCalAdd();
  renderSidebar();
  renderSyncState();
}

function ymdOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function mondayOf(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function weekRangeText(d) {
  const s = mondayOf(d);
  const e = new Date(s);
  e.setDate(s.getDate() + 6);
  return `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`;
}

// ---------------- 侧边栏 ----------------

function renderSidebar() {
  // 专注视图：置顶三个入口
  const nav = $('listNav');
  nav.innerHTML = '';
  const mkNav = (label, active, count, onClick) => {
    const b = document.createElement('button');
    b.className = 'side-item' + (active ? ' active' : '');
    b.innerHTML = `<span class="side-label"></span><span class="pill"></span>`;
    b.querySelector('.side-label').textContent = label;
    b.querySelector('.pill').textContent = count > 0 ? String(count) : '';
    b.addEventListener('click', onClick);
    nav.appendChild(b);
  };
  const myDayCount = state.tasks.filter((t) => !t.completed && t.myDay).length;
  mkNav('☀ 今天', view === 'myday', myDayCount, () => switchView('myday'));
  mkNav('◧ 四象限', view === 'quadrant', 0, () => switchView('quadrant'));
  mkNav('▦ 日历', view === 'calendar', 0, () => switchView('calendar'));

  const mk = (host, label, active, count, onClick) => {
    const b = document.createElement('button');
    b.className = 'side-item' + (active ? ' active' : '');
    b.innerHTML = `<span class="side-label"></span><span class="pill"></span>`;
    b.querySelector('.side-label').textContent = label;
    b.querySelector('.pill').textContent = count > 0 ? String(count) : '';
    b.addEventListener('click', onClick);
    host.appendChild(b);
  };

  const listBox = $('listBox');
  listBox.innerHTML = '';
  for (const l of state.lists || []) {
    mk(listBox, l.name, listFilter === l.name, l.count, () => {
      listFilter = listFilter === l.name ? '' : l.name;
      switchView('tasks');
    });
  }
  if (!(state.lists || []).length) {
    const hint = document.createElement('div');
    hint.className = 'side-hint';
    hint.textContent = '还没有列表；在任务里填「列表」就会出现在这里';
    listBox.appendChild(hint);
  }

  const tagNav = $('tagNav');
  tagNav.innerHTML = '';
  for (const t of state.tags || []) {
    mk(tagNav, `#${t.name}`, tagFilter === t.name, t.count, () => {
      tagFilter = tagFilter === t.name ? '' : t.name;
      render();
    });
  }
  if (!(state.tags || []).length) {
    const hint = document.createElement('div');
    hint.className = 'side-hint';
    hint.textContent = '还没有标签；在任务里填「标签」就会出现在这里';
    tagNav.appendChild(hint);
  }

  $('trashCount').textContent = state.trash.length ? String(state.trash.length) : '';
}

function switchView(next) {
  view = view === next && next !== 'tasks' ? 'tasks' : next;
  if (view === 'calendar') calCursor = new Date();
  if (view !== 'tasks') $('empty').querySelector('.empty-text').textContent = '这里没有任务';
  render();
}

function renderSyncState() {
  const ss = $('syncState');
  ss.className = 'sync-state';
  const txt = ss.querySelector('.txt');
  if (state.sync.syncing) {
    ss.classList.add('syncing');
    txt.textContent = '同步中…';
    $('btnSync').classList.add('spin');
  } else if (state.sync.error) {
    ss.classList.add('err');
    txt.textContent = state.sync.error.slice(0, 40);
    txt.title = state.sync.error;
    $('btnSync').classList.remove('spin');
  } else {
    const ls = state.sync.lastSync ? new Date(state.sync.lastSync) : null;
    const pending = state.sync.pendingCount || 0;
    if (pending > 0) {
      // 有改动还没被服务器收下 —— 说出来，别让用户以为"加了就是加上去了"
      ss.classList.add('warn');
      txt.textContent = `待上传 ${pending} 条`;
      txt.title = '这些改动还没传到服务器，连上网或点一下同步按钮就会补传';
    } else {
      ss.classList.add('ok');
      txt.textContent = ls
        ? `已同步 ${String(ls.getHours()).padStart(2, '0')}:${String(ls.getMinutes()).padStart(2, '0')}`
        : '未同步';
    }
    $('btnSync').classList.remove('spin');
  }
}

// ================================================================ 交互

// ---------------- 快速添加 ----------------

function quickPreviewText(raw) {
  if (!raw.trim()) return null;
  const p = parseQuickInput(raw);
  const bits = [];
  if (p.due) bits.push(`📅 ${p.due}`);
  if (p.remindAt) bits.push(`⏰ ${p.remindAt.replace('T', ' ')}`);
  if (p.rrule) bits.push(`🔁 ${repeatLabel(p.rrule)}`);
  for (const t of p.tags) bits.push(`#${t}`);
  if (p.list) bits.push(`@${p.list}`);
  if (p.priority) bits.push(`${priorityLabel(p.priority)}优先级`);
  return bits.length ? bits.join('  ') : null;
}

function updateQuickPreview() {
  const el = $('quickPreview');
  const txt = quickPreviewText($('newTitle').value);
  el.textContent = txt || '';
  el.hidden = !txt;
}

function addTask() {
  const input = $('newTitle');
  const raw = input.value.trim();
  if (!raw) return;
  const p = parseQuickInput(raw);
  // 解析不出来修饰就用原句当标题，绝不吞掉用户写的东西
  const title = p.title || raw;
  input.value = '';
  $('quickPreview').hidden = true;
  window.api.saveTask({
    title,
    // 句子里写了优先级/日期就用句子的，否则用输入框旁边的选择器
    priority: p.priority || Number($('newPriority').value) || 0,
    due: p.due || $('newDue').value || null,
    remindAt: p.remindAt || '',
    rrule: p.rrule || '',
    tags: p.tags,
    list: p.list || (listFilter && listFilter !== NO_LIST ? listFilter : ''),
    notes: '',
    steps: [],
  });
}

// ---------------- 日历里就地加待办 ----------------
//
// 日历格子点空白原本是"筛这一天"。这里再加一个 + 按钮，点它就在格子里
// 冒一个输入框，回车直接在那一天建一条待办，不用切回列表视图。
//
// 有个坑：每次同步完成整个日历都会重建，正在输入的内容会被冲掉。
// 所以把"正在编辑哪一天、输入了什么"记在 calAdd 里，重建后原样恢复。

let calAdd = null;   // { day, value }

function calCellOf(day) {
  return document.querySelector(`.cal-cell[data-day="${day}"]`)
    || document.querySelector(`.cal-col[data-day="${day}"]`);
}

/** 在格子里开一个输入框；value 非空时是恢复上一次被打断的输入 */
function openCalAdd(host, day, value) {
  if (!host) return;
  const box = document.createElement('div');
  box.className = 'cal-add-wrap';
  const input = document.createElement('input');
  input.className = 'cal-add-input';
  input.type = 'text';
  input.value = value || '';
  input.placeholder = '加一条待办…';
  const hint = document.createElement('div');
  hint.className = 'cal-add-hint';
  hint.textContent = '回车创建 · Esc 取消';
  box.appendChild(input);
  box.appendChild(hint);
  host.appendChild(box);
  calAdd = { day, value: value || '' };
  input.focus();
  if (value) input.setSelectionRange(value.length, value.length);

  const close = () => {
    if (calAdd && calAdd.day === day && calAdd.value === input.value) calAdd = null;
    box.remove();
  };
  input.addEventListener('input', () => { if (calAdd) calAdd.value = input.value; });
  input.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Enter') return;
    const raw = input.value.trim();
    if (!raw) { close(); return; }
    const p = parseQuickInput(raw);
    // 句子里自己写了日期就用句子的，否则用格子里的那天
    await window.api.saveTask({
      title: p.title || raw,
      priority: p.priority || 0,
      due: p.due || day,
      remindAt: p.remindAt || '',
      rrule: p.rrule || '',
      tags: p.tags,
      list: p.list || '',
      notes: '',
      steps: [],
    });
    close();
    toast('已添加到 ' + day);
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => { if (!input.value.trim()) close(); });
}

/** 日历重建后，把被打断的输入框恢复回去 */
function restoreCalAdd() {
  if (!calAdd) return;
  const host = calCellOf(calAdd.day);
  if (!host) { calAdd = null; return; }
  if (host.querySelector('.cal-add-input')) return;
  openCalAdd(host, calAdd.day, calAdd.value);
}

/** 给格子挂一个 + 按钮 */
function attachCalAdd(host, day) {
  const btn = document.createElement('button');
  btn.className = 'cal-add';
  btn.type = 'button';
  btn.title = '在这一天加一条待办';
  btn.textContent = '+';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCalAdd(host, day, calAdd && calAdd.day === day ? calAdd.value : '');
  });
  host.appendChild(btn);
}

$('btnAdd').addEventListener('click', addTask);
$('newTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
$('newTitle').addEventListener('input', updateQuickPreview);

// ---------------- 列表点击 ----------------

$('list').addEventListener('click', (e) => {
  const row = e.target.closest('.item');
  if (!row) return;
  const uid = row.dataset.uid;
  const act = e.target.dataset.act;

  if (act === 'restore') {
    e.stopPropagation();
    window.api.restoreTask(uid).then(() => toast('已恢复'));
    return;
  }
  if (act === 'purge') {
    e.stopPropagation();
    const t = state.trash.find((x) => x.uid === uid);
    if (confirm(`彻底删除「${t ? t.title : ''}」？这一步不可恢复。`)) {
      window.api.purgeTask(uid).then(() => toast('已彻底删除'));
    }
    return;
  }

  if (view === 'trash') return;

  if (act === 'myday') {
    e.stopPropagation();
    const t = state.tasks.find((x) => x.uid === uid);
    const on = !(t && t.myDay);
    window.api.toggleMyDay(uid, on).then(() => toast(on ? '已加入「今天」' : '已移出「今天」'));
    return;
  }

  if (act === 'toggle') {
    const t = state.tasks.find((x) => x.uid === uid);
    const willComplete = !(t && t.completed);
    // 有步骤没做完时提醒一句，别让人以为整件事都办完了
    if (willComplete && (t && (t.steps || []).some((s) => !s.done))) {
      const left = t.steps.filter((s) => !s.done).length;
      if (!confirm(`还有 ${left} 个步骤没完成，确定标记整条任务完成？`)) return;
    }
    window.api.toggleTask(uid, willComplete).then((r) => {
      if (r && r.rolled) toast(`已生成下一期：${r.rolled.due}`);
    });
    e.stopPropagation();
    return;
  }
  if (act === 'del') {
    e.stopPropagation();
    const t = state.tasks.find((x) => x.uid === uid);
    if (confirm(`把「${t ? t.title : ''}」移到回收站？`)) window.api.trashTask(uid);
    return;
  }
  if (editingUid === uid) return closeEditor();
  openEditor(uid);
});

// 日历里点任务条也能打开编辑区
$('calendar').addEventListener('click', (e) => {
  const chip = e.target.closest('.cal-chip');
  if (chip) {
    e.stopPropagation();
    openEditor(chip.dataset.uid);
  }
});

// ---------------- 编辑区 ----------------

const KNOWN_REPEAT = [
  '', 'FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'FREQ=MONTHLY', 'FREQ=YEARLY',
];

function renderSteps() {
  const ul = $('edSteps');
  ul.innerHTML = '';
  editingSteps.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'step' + (s.done ? ' done' : '');
    li.innerHTML = '<span class="step-box" data-i="' + i + '">✓</span><span class="step-text"></span><button class="step-del" data-i="' + i + '">✕</button>';
    li.querySelector('.step-text').textContent = s.text;
    ul.appendChild(li);
  });
  $('edStepsCount').textContent = editingSteps.length
    ? `已完成 ${editingSteps.filter((s) => s.done).length}/${editingSteps.length}`
    : '';
}

$('edSteps').addEventListener('click', (e) => {
  const box = e.target.closest('.step-box');
  const del = e.target.closest('.step-del');
  if (box) {
    editingSteps[+box.dataset.i].done = !editingSteps[+box.dataset.i].done;
    renderSteps();
  } else if (del) {
    editingSteps.splice(+del.dataset.i, 1);
    renderSteps();
  }
});

$('edStepNew').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (!v) return;
  editingSteps.push({ text: v, done: false });
  e.target.value = '';
  renderSteps();
});

function openEditor(uid) {
  const t = state.tasks.find((x) => x.uid === uid);
  if (!t) return;
  editingUid = uid;
  $('edTitle').value = t.title || '';
  $('edPriority').value = String(t.priority || 0);
  $('edDue').value = t.due || '';
  $('edNotes').value = t.notes || '';
  $('edRemind').value = t.remindAt || '';
  $('edList').value = t.list || '';
  $('edTags').value = (t.tags || []).join(', ');
  $('edMyDay').checked = !!t.myDay;

  // 不认识的 RRULE 补一条选项，别被下拉框默默改掉
  const rep = $('edRepeat');
  const extra = Array.from(rep.options).find((o) => o.value.startsWith('CUSTOM:'));
  if (extra) extra.remove();
  const rrule = String(t.rrule || '');
  if (rrule && !KNOWN_REPEAT.includes(rrule)) {
    const o = document.createElement('option');
    o.value = rrule;
    o.textContent = `自定义：${rrule}`;
    rep.insertBefore(o, rep.querySelector('option[value="__custom"]'));
  }
  rep.value = rrule || '';

  const dl = $('listOptions');
  dl.innerHTML = '';
  for (const l of state.lists || []) {
    if (l.name === NO_LIST) continue;
    const o = document.createElement('option');
    o.value = l.name;
    dl.appendChild(o);
  }

  const sel = $('edParent');
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '无（顶级任务）';
  sel.appendChild(none);
  const banned = descendantUids(uid, state.tasks);
  for (const x of state.tasks) {
    if (x.uid === uid || banned.has(x.uid)) continue;
    const o = document.createElement('option');
    o.value = x.uid;
    o.textContent = shortText(x.title || '(无标题)', 40);
    sel.appendChild(o);
  }
  sel.value = t.parentUid || '';

  editingSteps = (t.steps || []).map((s) => ({ text: s.text, done: !!s.done }));
  $('edStepNew').value = '';
  renderSteps();

  $('edMeta').textContent = t.etag === '' ? '尚未上传到服务器' : '已同步到服务器';
  $('editor').hidden = false;
  render();
  $('edTitle').focus();
}

function closeEditor() {
  editingUid = null;
  editingSteps = [];
  $('editor').hidden = true;
  render();
}

async function saveEditor() {
  const t = state.tasks.find((x) => x.uid === editingUid);
  if (!t) return closeEditor();

  let rrule = $('edRepeat').value;
  if (rrule === '__custom') {
    const s = prompt('输入 RRULE 规则，例如 FREQ=MONTHLY;BYMONTHDAY=15', t.rrule || 'FREQ=');
    rrule = s ? s.trim().toUpperCase() : (t.rrule || '');
    $('edRepeat').value = rrule;
  }

  const patch = {
    uid: t.uid,
    etag: t.etag,
    href: t.href,
    completed: t.completed,
    title: $('edTitle').value.trim() || '(无标题)',
    priority: Number($('edPriority').value) || 0,
    due: $('edDue').value || null,
    notes: $('edNotes').value,
    remindAt: $('edRemind').value || '',
    rrule,
    list: $('edList').value.trim(),
    tags: $('edTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    parentUid: $('edParent').value || '',
    myDay: $('edMyDay').checked ? (t.myDay || todayStr()) : '',
    steps: editingSteps,
  };
  closeEditor();
  const r = await window.api.saveTask(patch);
  if (r && r.queued) toast('离线：已存本地，下次同步自动上传');
}

$('edClose').addEventListener('click', closeEditor);
$('edSave').addEventListener('click', saveEditor);

// ---------------- 过滤 / 侧边栏 / 日历 ----------------

document.querySelectorAll('.filter').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    filter = b.dataset.filter;
    dayFilter = '';
    if (view !== 'tasks') view = 'tasks';
    render();
  });
});

$('filterSmart').addEventListener('change', (e) => {
  smartFilter = e.target.value;
  render();
});

$('btnTrash').addEventListener('click', () => switchView('trash'));

$('btnTrashEmpty').addEventListener('click', () => {
  if (confirm(`清空回收站里的 ${state.trash.length} 项？不可恢复。`)) {
    window.api.emptyTrash().then(() => toast('回收站已清空'));
  }
});

$('search').addEventListener('input', (e) => { keyword = e.target.value.trim(); render(); });

$('viewPrev').addEventListener('click', () => {
  const d = new Date(calCursor);
  if (calMode === 'month') d.setMonth(d.getMonth() - 1);
  else d.setDate(d.getDate() - 7);
  calCursor = d;
  render();
});
$('viewNext').addEventListener('click', () => {
  const d = new Date(calCursor);
  if (calMode === 'month') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 7);
  calCursor = d;
  render();
});
$('viewToday').addEventListener('click', () => { calCursor = new Date(); render(); });
$('viewMode').addEventListener('change', (e) => { calMode = e.target.value; render(); });

$('btnSync').addEventListener('click', async () => {
  const r = await window.api.sync();
  if (r && r.ok) toast(`同步完成，服务器上共 ${r.pulled} 项`);
  else if (r && r.error) toast(r.error, true);
});

// ---------------- 设置 ----------------

function openSettings() {
  const c = state.config || {};
  $('cfgServer').value = c.server || '';
  $('cfgUser').value = c.username || '';
  $('cfgPass').value = '';
  $('cfgPass').placeholder = c.hasPassword ? '已保存（留空表示不修改）' : '未设置';
  $('cfgInterval').value = c.syncIntervalMin || 10;
  $('cfgProxy').value = c.proxyMode === 'system' ? 'system' : 'direct';
  $('cfgAutoLaunch').checked = !!c.autoLaunch;
  $('cfgAccent').value = /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : ACCENT_DEFAULT;
  syncAppearanceUI();
  $('diagBox').hidden = true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  $('settings').hidden = false;
}

/** 主题按钮 / 色块的选中态要跟配置对上 */
function syncAppearanceUI() {
  const c = state.config || {};
  const src = c.theme || 'system';
  const accent = /^#[0-9a-f]{6}$/i.test(c.accentColor || '') ? c.accentColor.toLowerCase() : '';
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeOpt === src);
  });
  document.querySelectorAll('.swatch').forEach((b) => {
    b.classList.toggle('active', !!accent && b.dataset.accent.toLowerCase() === accent);
  });
}

/** 外观是即时生效并自动保存的：先本地上色，再用主进程回包校正 */
async function saveAppearance(patch, preview) {
  if (preview) applyThemeView(Object.assign({}, state.config, preview));
  const cfg = await window.api.saveConfig(patch);
  state.config = cfg;
  applyThemeView(cfg);
  syncAppearanceUI();
  return cfg;
}

document.querySelectorAll('.theme-opt').forEach((b) => {
  b.addEventListener('click', () => {
    const src = b.dataset.themeOpt;
    saveAppearance({ theme: src }, {
      theme: src,
      resolvedTheme: src === 'system' ? state.config.resolvedTheme : src,
    });
  });
});

// 拖动调色板时先本地预览，松手才落盘
$('cfgAccent').addEventListener('input', (e) => {
  applyThemeView(Object.assign({}, state.config, { accent: e.target.value }));
});
$('cfgAccent').addEventListener('change', (e) => {
  saveAppearance({ accentColor: e.target.value }, { accent: e.target.value });
});

document.querySelectorAll('.swatch').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.accent;
    $('cfgAccent').value = v;
    saveAppearance({ accentColor: v }, { accent: v });
  });
});

$('cfgAccentReset').addEventListener('click', () => {
  $('cfgAccent').value = ACCENT_DEFAULT;
  saveAppearance({ accentColor: '' }, { accent: ACCENT_DEFAULT });
});

$('btnSettings').addEventListener('click', openSettings);
$('setClose').addEventListener('click', () => { $('settings').hidden = true; });
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings').hidden = true; });

$('btnSaveCfg').addEventListener('click', async () => {
  const patch = {
    server: $('cfgServer').value.trim(),
    username: $('cfgUser').value.trim(),
    syncIntervalMin: Number($('cfgInterval').value) || 10,
    proxyMode: $('cfgProxy').value,
    autoLaunch: $('cfgAutoLaunch').checked,
  };
  const pw = $('cfgPass').value;
  if (pw) patch.password = pw;
  await window.api.saveConfig(patch);
  $('settings').hidden = true;
  toast(patch.autoLaunch ? '配置已保存，开机自启已开启' : '配置已保存');
  window.api.sync();
});

$('btnTest').addEventListener('click', async () => {
  const el = $('testResult');
  el.className = 'test-result';
  el.textContent = '测试中…';
  const pw = $('cfgPass').value;
  const patch = {
    server: $('cfgServer').value.trim(),
    username: $('cfgUser').value.trim(),
    syncIntervalMin: Number($('cfgInterval').value) || 10,
  };
  if (pw) patch.password = pw;
  if (pw || !$('cfgPass').placeholder.includes('已保存')) await window.api.saveConfig(patch);

  const r = await window.api.testConnection();
  if (r.ok) {
    el.className = 'test-result ok';
    el.textContent = r.calendars.length
      ? `连接成功，发现 ${r.calendars.length} 个日历（${r.calendars.map((c) => c.name).join('、')}），其中 ${r.todoCount} 项任务`
      : '连接成功，但还没有日历，同步时会自动创建';
  } else {
    el.className = 'test-result err';
    el.textContent = '失败：' + r.error;
  }
});

// ---------------- 连接诊断 ----------------

$('btnDiag').addEventListener('click', async () => {
  const box = $('diagBox');
  box.hidden = false;
  box.textContent = '诊断中…';
  box.className = 'diag-box';
  const r = await window.api.netDiag();
  box.className = 'diag-box ' + (r.ok ? 'ok' : 'err');
  box.innerHTML = (r.lines || []).map((l) => `<div>${escapeHtml(l)}</div>`).join('');
});

// ---------------- 系统通知测试 ----------------

$('btnTestNotify').addEventListener('click', async () => {
  const el = $('testResult');
  el.className = 'test-result';
  el.textContent = '发送中…';
  const r = await window.api.testNotification();
  if (r.channel === 'toast') {
    el.className = 'test-result ok';
    el.textContent = '已发出 Windows 通知（右下角 / 通知中心），看看屏幕右下角';
  } else if (r.channel === 'balloon') {
    el.className = 'test-result ok';
    el.textContent = '系统不支持通知中心，已退回托盘气泡';
  } else {
    el.className = 'test-result err';
    el.textContent = '这个系统没有可用的通知通道，提醒到点时不会弹窗';
  }
});

// ---------------- 快捷键 ----------------

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  else if (e.ctrlKey && e.key === 'r') { e.preventDefault(); $('btnSync').click(); }
  else if (e.key === 'Escape') {
    if (!$('settings').hidden) $('settings').hidden = true;
    else if (!$('editor').hidden) closeEditor();
    else if (dayFilter) { dayFilter = ''; view = 'calendar'; render(); }
    else if (view !== 'tasks') switchView('tasks');
  }
});

// ================================================================ 启动

function acceptState(s) {
  state = s;
  applyThemeView(state.config);
  syncAppearanceUI();
  render();
}

window.api.onState(acceptState);
window.api.getState().then(acceptState);

// 托盘「新建任务」：把光标送进输入框，省得再点一次
window.api.onFocusComposer(() => {
  $('settings').hidden = true;
  $('editor').hidden = true;
  if (view === 'trash' || view === 'quadrant' || view === 'calendar') view = 'tasks';
  render();
  $('newTitle').focus();
});

// 点提醒通知后主进程会点名要打开哪条任务
window.api.onOpenTask((uid) => {
  view = 'tasks';
  render();
  openEditor(uid);
});
