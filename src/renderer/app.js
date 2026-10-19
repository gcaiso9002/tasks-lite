'use strict';

let state = { tasks: [], config: {}, sync: {} };
let filter = 'open';
let keyword = '';
let editingUid = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

// ================================================================ 工具

function todayStr() {
  const d = new Date();
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

// ================================================================ 过滤

function visibleTasks() {
  const today = todayStr();
  let list = state.tasks.slice();

  if (filter === 'open') list = list.filter((t) => !t.completed);
  else if (filter === 'done') list = list.filter((t) => t.completed);
  else if (filter === 'today') list = list.filter((t) => !t.completed && t.due && t.due <= today);
  else if (filter === 'overdue') list = list.filter((t) => !t.completed && t.due && t.due < today);

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
  const list = $('list');
  const items = visibleTasks();
  const today = todayStr();

  list.innerHTML = '';
  $('empty').hidden = items.length > 0;
  $('count').textContent = `${state.tasks.filter((t) => !t.completed).length} 项未完成 / 共 ${state.tasks.length} 项`;

  for (const t of items) {
    const row = document.createElement('div');
    row.className = 'item' + (t.completed ? ' done' : '') + (editingUid === t.uid ? ' editing' : '');
    row.dataset.uid = t.uid;

    const badges = [];
    const pl = priorityLabel(t.priority);
    if (pl) badges.push(`<span class="badge p${t.priority}">${pl}优先级</span>`);
    if (t.due) {
      const cls = t.completed ? 'due' : t.due < today ? 'overdue' : t.due === today ? 'today' : 'due';
      const label = t.due === today ? '今天' : t.due;
      badges.push(`<span class="badge ${cls}">📅 ${label}</span>`);
    }
    if (t.notes) badges.push('<span class="badge note">有备注</span>');
    if (t.etag === '' && t.href) badges.push('<span class="badge note">待上传</span>');

    row.innerHTML = `
      <div class="check" data-act="toggle">✓</div>
      <div class="body">
        <div class="title"></div>
        ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      </div>
      <button class="del" data-act="del" title="删除">✕</button>`;

    row.querySelector('.title').textContent = t.title || '(无标题)';
    list.appendChild(row);
  }

  // 同步状态
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
  $('newTitle').value = '';
  window.api.saveTask({
    title,
    priority: Number($('newPriority').value) || 0,
    due: $('newDue').value || null,
    notes: '',
  });
}

function openEditor(uid) {
  const t = state.tasks.find((x) => x.uid === uid);
  if (!t) return;
  editingUid = uid;
  $('edTitle').value = t.title || '';
  $('edPriority').value = String(t.priority || 0);
  $('edDue').value = t.due || '';
  $('edNotes').value = t.notes || '';
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
  const patch = {
    uid: t.uid,
    etag: t.etag,
    href: t.href,
    completed: t.completed,
    title: $('edTitle').value.trim() || '(无标题)',
    priority: Number($('edPriority').value) || 0,
    due: $('edDue').value || null,
    notes: $('edNotes').value,
  };
  closeEditor();
  const r = await window.api.saveTask(patch);
  if (r && r.queued) toast('离线：已存本地，下次同步自动上传');
}

$('btnAdd').addEventListener('click', addTask);
$('newTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });

$('list').addEventListener('click', (e) => {
  const row = e.target.closest('.item');
  if (!row) return;
  const uid = row.dataset.uid;
  const act = e.target.dataset.act;

  if (act === 'toggle') {
    const t = state.tasks.find((x) => x.uid === uid);
    window.api.toggleTask(uid, !(t && t.completed));
    e.stopPropagation();
    return;
  }
  if (act === 'del') {
    e.stopPropagation();
    const t = state.tasks.find((x) => x.uid === uid);
    if (confirm(`删除「${t ? t.title : ''}」？`)) window.api.deleteTask(uid);
    return;
  }
  if (editingUid === uid) return closeEditor();
  openEditor(uid);
});

$('edClose').addEventListener('click', closeEditor);
$('edSave').addEventListener('click', saveEditor);

document.querySelectorAll('.filter').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    filter = b.dataset.filter;
    render();
  });
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
  $('cfgAutoLaunch').checked = !!c.autoLaunch;
  $('cfgAccent').value = /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : ACCENT_DEFAULT;
  syncAppearanceUI();
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

// ---------------- 快捷键 ----------------

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  else if (e.ctrlKey && e.key === 'r') { e.preventDefault(); $('btnSync').click(); }
  else if (e.key === 'Escape') {
    if (!$('settings').hidden) $('settings').hidden = true;
    else if (!$('editor').hidden) closeEditor();
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
  $('newTitle').focus();
});
