'use strict';

let state = { tasks: [], trash: [], lists: [], tags: [], config: {}, sync: {} };
let filter = 'open';          // open | today | overdue | done | all
let smartFilter = '';         // '' 表示不额外筛
let listFilter = '';          // '' 表示不按列表筛
let tagFilter = '';
let view = 'tasks';           // tasks | trash
let keyword = '';
let editingUid = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const NO_LIST = '未分类';

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
  parent: (t) => state.tasks.some((x) => x.parentUid === t.uid),
  sub: (t) => !t.completed && !!t.parentUid,
};

function visibleTasks() {
  const today = todayStr();
  let list = state.tasks.slice();

  if (filter === 'open') list = list.filter((t) => !t.completed);
  else if (filter === 'done') list = list.filter((t) => t.completed);
  else if (filter === 'today') list = list.filter((t) => !t.completed && t.due && t.due <= today);
  else if (filter === 'overdue') list = list.filter((t) => !t.completed && t.due && t.due < today);

  if (smartFilter && SMART[smartFilter]) list = list.filter(SMART[smartFilter]);
  if (listFilter) list = list.filter((t) => listNameOf(t) === listFilter);
  if (tagFilter) list = list.filter((t) => (t.tags || []).includes(tagFilter));

  if (keyword) {
    const k = keyword.toLowerCase();
    list = list.filter(
      (t) => (t.title || '').toLowerCase().includes(k) || (t.notes || '').toLowerCase().includes(k)
    );
  }

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

// ================================================================ 渲染

function render() {
  const byUid = new Map(state.tasks.map((t) => [t.uid, t]));
  const trashMode = view === 'trash';

  document.querySelector('.main').classList.toggle('trash-mode', trashMode);
  $('btnTrash').classList.toggle('active', trashMode);
  $('btnTrashEmpty').hidden = !(trashMode && state.trash.length);

  const list = $('list');
  list.innerHTML = '';

  if (trashMode) {
    renderTrash(list);
    return;
  }

  const items = visibleTasks();
  const today = todayStr();
  $('empty').hidden = items.length > 0;
  $('count').textContent = `${state.tasks.filter((t) => !t.completed).length} 项未完成 / 共 ${state.tasks.length} 项`;

  for (const t of items) {
    const depth = depthOf(t, byUid);
    const row = document.createElement('div');
    row.className = 'item' + (t.completed ? ' done' : '') + (editingUid === t.uid ? ' editing' : '')
      + (depth ? ' sub' : '');
    row.dataset.uid = t.uid;
    if (depth) row.style.paddingLeft = `${12 + depth * 20}px`;

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
    if (t.notes) badges.push('<span class="badge note">有备注</span>');
    if (t.etag === '' && t.href) badges.push('<span class="badge note">待上传</span>');

    row.innerHTML = `
      <div class="check" data-act="toggle">✓</div>
      <div class="body">
        <div class="title"></div>
        ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      </div>
      <button class="del" data-act="del" title="移到回收站">✕</button>`;

    row.querySelector('.title').textContent = t.title || '(无标题)';
    list.appendChild(row);
  }

  renderSidebar();
  renderSyncState();
}

function repeatLabel(rrule) {
  const s = String(rrule || '').toUpperCase();
  if (s === 'FREQ=DAILY') return '每天';
  if (s === 'FREQ=WEEKLY') return '每周';
  if (s === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return '工作日';
  if (s === 'FREQ=MONTHLY') return '每月';
  if (s === 'FREQ=YEARLY') return '每年';
  return '循环';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function renderSidebar() {
  // 注意 mk() 必须显式接收容器：列表和标签共用它，
  // 一旦闭包里写死 listNav，标签就会被追加到「列表」那一栏里去
  const mk = (host, label, active, count, onClick) => {
    const b = document.createElement('button');
    b.className = 'side-item' + (active ? ' active' : '');
    b.innerHTML = `<span class="side-label"></span><span class="pill"></span>`;
    b.querySelector('.side-label').textContent = label;
    b.querySelector('.pill').textContent = count > 0 ? String(count) : '';
    b.addEventListener('click', onClick);
    host.appendChild(b);
  };

  const listNav = $('listNav');
  listNav.innerHTML = '';
  for (const l of state.lists || []) {
    mk(listNav, l.name, listFilter === l.name, l.count, () => {
      listFilter = listFilter === l.name ? '' : l.name;
      view = 'tasks';
      render();
    });
  }
  if (!(state.lists || []).length) {
    const hint = document.createElement('div');
    hint.className = 'side-hint';
    hint.textContent = '还没有列表；在任务里填「列表」就会出现在这里';
    listNav.appendChild(hint);
  }

  const tagNav = $('tagNav');
  tagNav.innerHTML = '';
  for (const t of state.tags || []) {
    mk(tagNav, `#${t.name}`, tagFilter === t.name, t.count, () => {
      tagFilter = tagFilter === t.name ? '' : t.name;
      view = 'tasks';
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
    ss.classList.add('ok');
    const ls = state.sync.lastSync ? new Date(state.sync.lastSync) : null;
    txt.textContent = ls
      ? `已同步 ${String(ls.getHours()).padStart(2, '0')}:${String(ls.getMinutes()).padStart(2, '0')}`
      : '未同步';
    $('btnSync').classList.remove('spin');
  }
}

// ================================================================ 交互

function addTask() {
  const input = $('newTitle');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  window.api.saveTask({
    title,
    priority: Number($('newPriority').value) || 0,
    due: $('newDue').value || null,
    notes: '',
    // 侧边栏选中了列表就跟着走，省得每条都去编辑里补
    list: listFilter && listFilter !== NO_LIST ? listFilter : '',
    tags: tagFilter ? [tagFilter] : [],
  });
}

$('btnAdd').addEventListener('click', addTask);
$('newTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });

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

  if (act === 'toggle') {
    const t = state.tasks.find((x) => x.uid === uid);
    window.api.toggleTask(uid, !(t && t.completed));
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

// ---------------- 编辑区 ----------------

const KNOWN_REPEAT = [
  '', 'FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'FREQ=MONTHLY', 'FREQ=YEARLY',
];

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

  // 列表候选来自现有任务，避免每条都手打
  const dl = $('listOptions');
  dl.innerHTML = '';
  for (const l of state.lists || []) {
    if (l.name === NO_LIST) continue;
    const o = document.createElement('option');
    o.value = l.name;
    dl.appendChild(o);
  }

  // 上级任务下拉：排除自己和自己的子孙，防止选出环
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

  $('edMeta').textContent = t.etag === '' ? '尚未上传到服务器' : '已同步到服务器';
  $('editor').hidden = false;
  render();
  $('edTitle').focus();
}

function closeEditor() {
  editingUid = null;
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
  };
  closeEditor();
  const r = await window.api.saveTask(patch);
  if (r && r.queued) toast('离线：已存本地，下次同步自动上传');
}

$('edClose').addEventListener('click', closeEditor);
$('edSave').addEventListener('click', saveEditor);

// ---------------- 过滤 / 侧边栏 ----------------

document.querySelectorAll('.filter').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    filter = b.dataset.filter;
    view = 'tasks';
    render();
  });
});

$('filterSmart').addEventListener('change', (e) => {
  smartFilter = e.target.value;
  view = 'tasks';
  render();
});

$('btnTrash').addEventListener('click', () => {
  view = view === 'trash' ? 'tasks' : 'trash';
  render();
});

$('btnTrashEmpty').addEventListener('click', () => {
  if (confirm(`清空回收站里的 ${state.trash.length} 项？不可恢复。`)) {
    window.api.emptyTrash().then(() => toast('回收站已清空'));
  }
});

$('search').addEventListener('input', (e) => { keyword = e.target.value.trim(); render(); });

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
  const lines = (r.lines || []).map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  box.innerHTML = lines;
});

// ---------------- 快捷键 ----------------

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  else if (e.ctrlKey && e.key === 'r') { e.preventDefault(); $('btnSync').click(); }
  else if (e.key === 'Escape') {
    if (!$('settings').hidden) $('settings').hidden = true;
    else if (!$('editor').hidden) closeEditor();
    else if (view === 'trash') { view = 'tasks'; render(); }
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
  if (view === 'trash') { view = 'tasks'; render(); }
  $('newTitle').focus();
});

// 点提醒通知后主进程会点名要打开哪条任务
window.api.onOpenTask((uid) => {
  view = 'tasks';
  render();
  openEditor(uid);
});
