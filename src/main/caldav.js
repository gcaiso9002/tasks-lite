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
   * @param {string}  opts.baseUrl      用户填的入口地址，例如 https://caldav.gcaiso9002.xin/zx/
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
      const err = new Error(
        res.status === 401
          ? '认证失败：用户名或密码不对'
          : `服务器返回 ${res.status} ${res.statusText}`
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

/** 把 ical.js 解析出的 VTODO 变成我们内部用的扁平对象 */
function parseTodo(icsText, href, etag) {
  const root = new ICAL.Component(ICAL.parse(icsText));
  const vtodo = root.getFirstSubcomponent('vtodo');
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
  };
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

  v.updatePropertyWithValue('summary', todo.title || '');
  if (Number(todo.priority) > 0) v.updatePropertyWithValue('priority', Number(todo.priority));
  if (todo.notes) v.updatePropertyWithValue('description', todo.notes);
  if (todo.due) {
    const [y, m, d] = String(todo.due).split('-').map(Number);
    if (y && m && d) {
      v.updatePropertyWithValue('due', ICAL.Time.fromJSDate(new Date(y, m - 1, d), false));
    }
  }

  vcal.addSubcomponent(v);
  return vcal.toString();
}

module.exports = { CaldavClient, parseMultistatus, decodeXml, normalizeBase, buildTodoIcs, parseTodo };
