'use strict';

const ICAL = require('ical.js');

const NS_DAV = 'DAV:';
const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** 把 CalDAV 服务当成一个"带 VTODO 的日历集合"来访问 */
class CaldavClient {
  /**
   * @param {object} opts
   * @param {Function} opts.fetchImpl  (url, init) => Promise<Response>，通常是 Electron net.fetch
   * @param {string}  opts.baseUrl      用户填的入口地址，例如 https://caldav.example.com/用户名/
   * @param {string}  opts.username
   * @param {string}  opts.password
   */
  constructor({ fetchImpl, baseUrl, username, password }) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBase(baseUrl);
    this.origin = new URL(this.baseUrl).origin;
    this.authorization =
      'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  }

  // ---------------------------------------------------------------- 底层请求

  async request(url, { method = 'PROPFIND', headers = {}, body = '' } = {}) {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/xml; charset=utf-8',
        ...headers,
      },
      body: body || undefined,
      redirect: 'follow',
    });

    const text = method === 'PROPFIND' || method === 'REPORT' || res.ok
      ? await res.text()
      : '';

    if (!res.ok && res.status !== 207) {
      let host = '';
      try { host = new URL(url).host; } catch (e) { host = url; }
      const err = new Error(
        res.status === 401
          ? '认证失败：用户名或密码不对'
          // 402/407 是代理层特有的状态码，服务器本身不会返回。
          // 只报一个数字的话，用户既不知道是被谁挡的，也不知道该改什么。
          : res.status === 402 || res.status === 407
            ? `${res.status}：请求被中间的代理拦住了（${host}）。到设置里把「连接方式」改成「直连」`
            : res.status === 412
              ? '服务器返回 412：这条任务刚被另一个客户端改过，冲突没能自动合并'
              : `服务器返回 ${res.status} ${res.statusText}（${host}）`
      );
      err.status = res.status;
      throw err;
    }
    return { status: res.status, text, headers: res.headers };
  }

  /** 把 href（可能是绝对路径）还原成完整 URL */
  absolute(href) {
    if (/^https?:\/\//i.test(href)) return href;
    return this.origin + (href.startsWith('/') ? href : '/' + href);
  }

  // ---------------------------------------------------------------- 发现阶段

  /**
   * 从入口 URL 找到 calendar-home-set，再列出所有日历。
   * 注意：入口 URL 必须是 principal 路径（带用户名那层）。
   * 根路径虽然 current-user-principal 正常，但 calendar-home-set 会返回 404。
   */
  async discover() {
    const { text } = await this.request(this.baseUrl, {
      method: 'PROPFIND',
      headers: { Depth: '0' },
      body: `${XML_HEADER}
<d:propfind xmlns:d="${NS_DAV}" xmlns:c="${NS_CALDAV}">
  <d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop>
</d:propfind>`,
    });

    const responses = parseMultistatus(text);
    const self = responses[0] || {};

    // 拿到 calendar-home-set；拿不到就退回入口 URL 本身
    const homeMatch = text.match(/<[^>]*:?calendar-home-set[^>]*>\s*<[^>]*:?href[^>]*>([\s\S]*?)<\//i);
    const home = homeMatch ? this.absolute(decodeXml(homeMatch[1].trim())) : this.baseUrl;

    const principal = self.href ? this.absolute(self.href) : this.baseUrl;

    return { home, principal, calendars: await this.listCalendars(home) };
  }

  /** 列出 home 下的日历集合 */
  async listCalendars(home) {
    const { text } = await this.request(home, {
      method: 'PROPFIND',
      headers: { Depth: '1' },
      body: `${XML_HEADER}
<d:propfind xmlns:d="${NS_DAV}" xmlns:c="${NS_CALDAV}">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`,
    });

    return parseMultistatus(text)
      .filter((r) => r.isCalendar && r.href && r.href.replace(/\/$/, '') !== new URL(home).pathname.replace(/\/$/, ''))
      .map((r) => ({
        href: this.absolute(r.href),
        path: r.href,
        name: r.displayname || decodeURIComponent(r.path.split('/').filter(Boolean).pop() || '日历'),
      }));
  }

  /** 创建一个新日历（MKCALENDAR），默认支持 VTODO */
  async createCalendar(home, name) {
    const href = `${home.replace(/\/$/, '')}/${encodeURIComponent(name).replace(/%20/g, '-')}/`;
    await this.request(this.absolute(href), {
      method: 'MKCALENDAR',
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: `${XML_HEADER}
<d:mkcalendar xmlns:d="${NS_DAV}" xmlns:c="${NS_CALDAV}">
  <d:set><d:displayname>${escapeXml(name)}</d:displayname></d:set>
  <c:supported-calendar-component-set>
    <c:comp name="VTODO"/>
  </c:supported-calendar-component-set>
</d:mkcalendar>`,
    });
    return this.absolute(href);
  }

  // ---------------------------------------------------------------- 任务读写

  /** REPORT calendar-query 拉取日历里的全部 VTODO */
  async listTodos(calendarHref) {
    const { text } = await this.request(calendarHref, {
      method: 'REPORT',
      headers: { Depth: '1' },
      body: `${XML_HEADER}
<c:calendar-query xmlns:d="${NS_DAV}" xmlns:c="${NS_CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    });

    const out = [];
    for (const r of parseMultistatus(text)) {
      if (!r.data || !r.href) continue;
      try {
        const todo = parseTodo(r.data, this.absolute(r.href), r.etag);
        if (todo) out.push(todo);
      } catch (e) {
        // 单条坏数据不应该拖垮整次同步
      }
    }
    return out;
  }

  /** PUT 新建或更新一个任务。带 etag 时做乐观锁 */
  async putTodo(calendarHref, todo, etag) {
    const href = this.absolute(
      `${calendarHref.replace(/\/$/, '')}/${todo.uid}.ics`
    );
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';

    const { headers: resHeaders } = await this.request(href, {
      method: 'PUT',
      headers,
      body: buildTodoIcs(todo),
    });
    return { href, etag: resHeaders.get('etag') || '' };
  }

  async deleteTodo(href, etag) {
    await this.request(href, {
      method: 'DELETE',
      headers: etag ? { 'If-Match': etag } : {},
    });
  }

  // ------------------------------------------------------- 冲突自愈（412 重试）
  //
  // 只要同一个日历上有第二个客户端（手机、另一个窗口、Tasks.org），两边就会
  // 拿着各自缓存的 ETag 去写同一条任务，后写的那个必然拿到 412。
  // 单纯把 412 抛给用户是没用的——他什么也做不了，只能干瞪眼。
  // 这里改成：冲突了就重读一次服务器现状，拿最新 ETag 再写一遍（后写为准）。

  /** 读回服务器上某条任务的最新 ETag；服务器上没有就返回 null（当新建处理） */
  async freshEtag(calendarHref, uid) {
    const href = this.absolute(`${calendarHref.replace(/\/$/, '')}/${uid}.ics`);
    try {
      const { headers } = await this.request(href, { method: 'GET' });
      return headers.get('etag') || null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** PUT，遇 412 自动重读 ETag 再试一次 */
  async putTodoResilient(calendarHref, todo, etag, tries = 2) {
    let cur = etag;
    for (let i = 0; ; i++) {
      try {
        return await this.putTodo(calendarHref, todo, cur);
      } catch (e) {
        if (e.status !== 412 || i >= tries) throw e;
        cur = await this.freshEtag(calendarHref, todo.uid);
      }
    }
  }

  /** DELETE，遇 412 重读 ETag 再试；404 视为"服务器上已经没有了"，算成功 */
  async deleteTodoResilient(href, etag, tries = 2) {
    let cur = etag;
    for (let i = 0; ; i++) {
      try {
        await this.deleteTodo(this.absolute(href), cur);
        return { deleted: true };
      } catch (e) {
        if (e.status === 404) return { deleted: true, alreadyGone: true };
        if (e.status !== 412 || i >= tries) throw e;
        try {
          const { headers } = await this.request(this.absolute(href), { method: 'GET' });
          cur = headers.get('etag') || null;
        } catch (e2) {
          if (e2.status === 404) return { deleted: true, alreadyGone: true };
          throw e2;
        }
      }
    }
  }
}

// ================================================================ XML 工具

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(s) {
  if (s == null) return '';
  let out = String(s);
  const cdata = out.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) out = cdata[1];
  return out
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // &amp; 必须最后解
}

/** 解析 DAV multistatus，取出每个 response 的关键字段 */
function parseMultistatus(xml) {
  const out = [];
  const re = /<[a-z0-9]*:?response\b[^>]*>([\s\S]*?)<\/[a-z0-9]*:?response\s*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const pick = (tag) => {
      const r = body.match(new RegExp(`<[a-z0-9]*:?${tag}\\b[^>]*>([\\s\\S]*?)</[a-z0-9]*:?${tag}\\s*>`, 'i'));
      return r ? decodeXml(r[1].trim()) : null;
    };
    const href = pick('href');
    if (!href) continue;

    const statusRaw = pick('status');
    const rtBlock = body.match(/<[a-z0-9]*:?resourcetype\b[^>]*>([\s\S]*?)<\/[a-z0-9]*:?resourcetype\s*>/i);
    const dnRaw = body.match(/<[a-z0-9]*:?displayname\b[^>]*>([\s\S]*?)<\/[a-z0-9]*:?displayname\s*>/i);

    out.push({
      href: decodeXml(href.trim()),
      status: statusRaw ? parseInt(String(statusRaw).trim().split(/\s+/)[1], 10) || 0 : 0,
      etag: pick('getetag'),
      data: (() => {
        const r = body.match(/<[a-z0-9]*:?calendar-data\b[^>]*>([\s\S]*?)<\/[a-z0-9]*:?calendar-data\s*>/i);
        return r ? decodeXml(r[1]) : null;
      })(),
      displayname: dnRaw ? decodeXml(dnRaw[1]) : null,
      isCalendar: rtBlock ? /<[a-z0-9]*:?calendar\s*\/>/i.test(rtBlock[1]) : false,
    });
  }
  return out;
}

function normalizeBase(url) {
  let u = String(url || '').trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.endsWith('/') ? u : u + '/';
}

// ================================================================ VTODO 转换

/** iCalendar 允许的 FREQ 取值；写之前先校验，免得生成一条自己都解析不了的 ICS */
const ALLOWED_FREQ = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

function isValidRrule(s) {
  const m = /^FREQ=([A-Z]+)/i.exec(String(s || '').trim());
  return !!(m && ALLOWED_FREQ.includes(m[1].toUpperCase()));
}

/** 把 ical.js 解析出的 VTODO 变成我们内部用的扁平对象 */
function parseTodo(icsText, href, etag) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(icsText));
  } catch (e) {
    // 别的客户端可能写了不合法的 RRULE / TRIGGER，整份 ICS 会解析失败。
    // 摘掉那几行再试一次 —— 宁可少一个循环/提醒，也不能让整条任务从列表里消失。
    const cleaned = String(icsText)
      .replace(/^RRULE[;:].*$/gim, '')
      .replace(/^TRIGGER[;:].*$/gim, '');
    try {
      root = new ICAL.Component(ICAL.parse(cleaned));
      console.error('[ics] 摘掉不合法的 RRULE/TRIGGER 后才解析成功：', href);
    } catch (e2) {
      console.error('[ics] 解析失败，已跳过：', href, e2.message);
      return null;
    }
  }  const vtodo = root.getFirstSubcomponent('vtodo');
  if (!vtodo) return null;

  const uid = vtodo.getFirstPropertyValue('uid');
  if (!uid) return null;

  const status = String(vtodo.getFirstPropertyValue('status') || '').toUpperCase();
  const priority = Number(vtodo.getFirstPropertyValue('priority') || 0) || 0;

  let due = null;
  const dueProp = vtodo.getFirstProperty('due');
  if (dueProp) {
    const v = dueProp.getFirstValue();
    if (v) {
      // ical.js 的 toString() 给的是 2030-12-31，ICS 原文是 20301231，两种都要认
      const s = typeof v === 'string' ? v : String(v.toString());
      const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
      if (m) due = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }

  const dtstampProp = vtodo.getFirstProperty('dtstamp');
  let modified = null;
  if (dtstampProp) {
    const v = dtstampProp.getFirstValue();
    const s = typeof v === 'string' ? v : String(v.toString());
    const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})[T ]?(\d{2}):?(\d{2}):?(\d{2})/);
    if (m) modified = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }

  // 子任务：RELATED-TO;RELTYPE=PARENT:<父任务 uid>
  let parentUid = '';
  const relProp = vtodo.getFirstProperty('related-to');
  if (relProp) {
    const reltype = String(relProp.getParameter('reltype') || 'PARENT').toUpperCase();
    const val = String(relProp.getFirstValue() || '').trim();
    // 没写 RELTYPE 的 RELATED-TO 按规范默认就是 PARENT
    if (val && (reltype === 'PARENT' || reltype === '')) parentUid = val;
  }

  // 循环：保留 RRULE 原文（不含 "RRULE:" 前缀），方便原样回写
  let rrule = '';
  const rruleProp = vtodo.getFirstProperty('rrule');
  if (rruleProp) {
    const recur = rruleProp.getFirstValue();
    if (recur) {
      try {
        rrule = String(recur.toString()).toUpperCase().replace(/^RRULE:/, '');
      } catch (e) {
        rrule = '';
      }
    }
  }

  // 提醒：VALARM 里的 TRIGGER，绝对时间直接用，相对时间按截止日换算
  let remindAt = '';
  const alarm = vtodo.getFirstSubcomponent('valarm');
  if (alarm) {
    const trig = alarm.getFirstProperty('trigger');
    if (trig) {
      if (String(trig.type).toLowerCase() === 'duration') {
        const dur = trig.getFirstValue();
        const secs = dur && typeof dur.toSeconds === 'function' ? Math.round(dur.toSeconds()) : 0;
        if (secs && due) {
          const base = new Date(`${due}T00:00:00`);
          base.setSeconds(base.getSeconds() + secs);
          remindAt = toLocalInput(base);
        }
      } else {
        const v = trig.getFirstValue();
        if (v && typeof v.toJSDate === 'function') remindAt = toLocalInput(v.toJSDate());
      }
    }
  }

  // 标签用标准的 CATEGORIES（别的客户端也认），
  // 列表是 Tasks Lite 自己的概念，走 X- 属性，不污染标准字段
  const catsRaw = vtodo.getFirstPropertyValue('categories');
  const tags = (Array.isArray(catsRaw) ? catsRaw : catsRaw ? String(catsRaw).split(',') : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const list = unescapeText(vtodo.getFirstPropertyValue('x-taskslite-list') || '').trim();
  const myDay = unescapeText(vtodo.getFirstPropertyValue('x-taskslite-myday') || '').trim();
  const steps = parseSteps(unescapeText(vtodo.getFirstPropertyValue('x-taskslite-steps') || ''));

  return {
    uid,
    href,
    etag: etag || '',
    title: String(vtodo.getFirstPropertyValue('summary') || '').trim(),
    notes: String(vtodo.getFirstPropertyValue('description') || ''),
    completed: status === 'COMPLETED',
    priority, // 1 最高，0 表示无
    due,
    modified,
    parentUid,
    rrule,
    remindAt,
    tags,
    list,
    myDay,
    steps,
  };
}

/** 步骤存成一个 JSON 文本属性；坏数据宁可丢掉也不能拖垮整条任务 */
function parseSteps(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ text: String(x.text).trim(), done: !!x.done }));
  } catch (e) {
    console.error('[ics] 步骤 JSON 解析失败，已忽略：', e.message);
    return [];
  }
}

/** Date → <input type="datetime-local"> 认的本地时间字符串 */
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * X- 自定义属性的转义。
 *
 * ical.js 只会给**标准** TEXT 属性（SUMMARY / DESCRIPTION 等）转义 ,
 * ; \，自定义的 X- 属性类型是 unknown，它原样输出 ——
 * 于是 Radicale 按规范把未转义的逗号当成值分隔符，
 * 列表名或步骤 JSON 会在第一个逗号处被截断。
 * 这里自己转义：ical.js 原样输出（X- 属性它不碰反斜杠），
 * 服务器按规范保留，读取时用 unescapeText 解回来。
 *
 * 只用于 X- 属性。标准属性交给 ical.js 就行，多转一次反而会多一层反斜杠。
 */
function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/**
 * X- 属性的读取端解转义。
 * ical.js 只给标准属性解转义，X- 属性的值它按原始字符串给，得自己来。
 * 单遍扫描，避免先替 \n 再替 \\ 造成的顺序歧义。
 */
function unescapeText(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) {
      const n = str[++i];
      out += (n === 'n' || n === 'N') ? '\n' : n;
    } else {
      out += c;
    }
  }
  return out;
}

/** 由内部对象生成一份 VEVENT-free 的 VCALENDAR/VTODO 文本 */
function buildTodoIcs(todo) {
  // ical.js 的 jCal 结构固定是 [name, props, children] 三元素，少一个子组件就 push 不到
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', '-//Tasks Lite//Tasks Lite//ZH');
  vcal.updatePropertyWithValue('version', '2.0');

  const v = new ICAL.Component('vtodo');
  v.updatePropertyWithValue('uid', todo.uid);
  v.updatePropertyWithValue('dtstamp', ICAL.Time.now());

  if (todo.completed) {
    v.updatePropertyWithValue('status', 'COMPLETED');
    v.updatePropertyWithValue('completed', ICAL.Time.now());
    v.updatePropertyWithValue('percent-complete', 100);
  } else {
    v.updatePropertyWithValue('status', 'NEEDS-ACTION');
    v.updatePropertyWithValue('percent-complete', 0);
  }

  // 标准属性：ical.js 自己会转义 , ; \，别多手
  v.updatePropertyWithValue('summary', todo.title || '');
  if (Number(todo.priority) > 0) v.updatePropertyWithValue('priority', Number(todo.priority));
  if (todo.notes) v.updatePropertyWithValue('description', todo.notes);
  if (todo.due) {
    const [y, m, d] = String(todo.due).split('-').map(Number);
    if (y && m && d) {
      v.updatePropertyWithValue('due', ICAL.Time.fromJSDate(new Date(y, m - 1, d), false));
    }
  }

  if (todo.parentUid) {
    // 注意 ICAL.Property 的构造签名是 (jCal, parent)，不是 (name, value)，
    // 建属性一律走 addPropertyWithValue 再 setParameter
    const rel = v.addPropertyWithValue('related-to', todo.parentUid);
    rel.setParameter('reltype', 'PARENT');
  }

  if (isValidRrule(todo.rrule)) {
    try {
      v.addPropertyWithValue('rrule', ICAL.Recur.fromString(String(todo.rrule).toUpperCase()));
    } catch (e) {
      console.error('[ics] RRULE 无法解析，已忽略：', todo.rrule);
    }
  } else if (todo.rrule) {
    console.error('[ics] RRULE 格式不合法，已忽略：', todo.rrule);
  }

  const list = String(todo.list || '').trim();
  if (list) v.updatePropertyWithValue('x-taskslite-list', escapeText(list));
  if (todo.myDay) v.updatePropertyWithValue('x-taskslite-myday', escapeText(String(todo.myDay)));
  // CATEGORIES 是多值属性，逗号本来就是分隔符，不能转义
  const tags = (todo.tags || []).map((s) => String(s).trim()).filter(Boolean);
  if (tags.length) v.updatePropertyWithValue('categories', tags.join(','));
  const steps = (todo.steps || []).filter((s) => s && String(s.text || '').trim());
  if (steps.length) {
    v.updatePropertyWithValue(
      'x-taskslite-steps',
      escapeText(JSON.stringify(steps.map((s) => ({ text: String(s.text).trim(), done: !!s.done }))))
    );
  }

  if (todo.remindAt) {
    const m = String(todo.remindAt).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) {
      const local = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 9), +(m[5] || 0), 0);
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', todo.title || '提醒');
      // addPropertyWithValue → setValue 会按 value.icaltype 自动把类型切成 date-time，
      // 千万别再手动 resetType，那会把刚设进去的值清空
      const trig = alarm.addPropertyWithValue('trigger', ICAL.Time.fromJSDate(local, true));
      trig.setParameter('value', 'DATE-TIME');
      v.addSubcomponent(alarm);
    }
  }

  vcal.addSubcomponent(v);
  return vcal.toString();
}

module.exports = {
  CaldavClient, parseMultistatus, decodeXml, normalizeBase, buildTodoIcs, parseTodo, toLocalInput,
  escapeText, unescapeText,
};
