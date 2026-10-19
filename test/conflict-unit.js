'use strict';
/**
 * 412 冲突自愈的离线单测：用一个假 fetch 模拟"服务器上的 ETag 被别的客户端改过"，
 * 不碰真实服务器。重点验证 putTodoResilient / deleteTodoResilient 的重试路径。
 */

const path = require('path');
const { CaldavClient } = require(path.join(__dirname, '..', 'src', 'main', 'caldav.js'));

let pass = 0;
let fail = 0;

function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function eq(a, b, name) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) console.log(`       期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  ok(same, name);
}

const BASE = 'https://dav.example.com/u/';
const CAL = 'https://dav.example.com/u/c/';

function client(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    calls.push({ method, ifMatch: headers['if-match'], ifNoneMatch: headers['if-none-match'] });
    const r = script(method, url, headers, calls.length);
    return r;
  };
  return { c: new CaldavClient({ fetchImpl, baseUrl: BASE, username: 'u', password: 'p' }), calls };
}

const html = (status, body = '') =>
  new Response(status === 204 || status === 205 ? null : body, { status });
const withEtag = (status, etag, body = '') => {
  // 204/205 不允许带 body，new Response 会直接抛
  const r = new Response(status === 204 || status === 205 ? null : body, { status });
  r.headers.set('etag', etag);
  return r;
};

const TODO = { uid: 'a@x', title: '标题', due: '2026-10-20', completed: false };

(async () => {
  console.log('\n[412 冲突自愈]');

  // 1) PUT 撞 412 → 重读 ETag → 再写成功
  {
    let putCount = 0;
    const { c, calls } = client((method) => {
      if (method === 'PUT') {
        putCount++;
        return putCount === 1 ? html(412) : withEtag(204, '"v2"');
      }
      if (method === 'GET') return withEtag(200, '"v1"');
      return html(500);
    });
    const r = await c.putTodoResilient(CAL, TODO, '"v0"');
    eq(r.etag, '"v2"', 'PUT 冲突后重试成功，返回新 ETag');
    eq(calls.map((x) => x.method), ['PUT', 'GET', 'PUT'], '中间重读了一次服务器现状');
    eq(calls[2].ifMatch, '"v1"', '第二次 PUT 用的是服务器上的最新 ETag');
  }

  // 2) PUT 撞 412，服务器上已经没这条了 → 当新建（If-None-Match: *）
  {
    let putCount = 0;
    const { c, calls } = client((method) => {
      if (method === 'PUT') { putCount++; return putCount === 1 ? html(412) : withEtag(201, '"new"'); }
      if (method === 'GET') return html(404);
      return html(500);
    });
    const r = await c.putTodoResilient(CAL, TODO, '"v0"');
    eq(r.etag, '"new"', '服务器上没有该任务时按新建写入');
    eq(calls[2].ifNoneMatch, '*', '新建走 If-None-Match: *');
    eq(calls[2].ifMatch, undefined, '新建不再带过期的 If-Match');
  }

  // 3) 连续冲突到上限 → 如实抛错，不无限重试
  {
    let puts = 0;
    const { c } = client((method) => {
      if (method === 'PUT') { puts++; return html(412); }
      if (method === 'GET') return withEtag(200, '"v9"');
      return html(500);
    });
    let thrown = null;
    try { await c.putTodoResilient(CAL, TODO, '"v0"'); } catch (e) { thrown = e; }
    ok(thrown && thrown.status === 412, '连续冲突会抛 412 而不是死循环');
    eq(puts, 3, '最多尝试 3 次（首次 + 2 次重试）');
  }

  // 4) DELETE 撞 412 → 服务器上已被别人删掉 → 视为成功
  {
    let delCount = 0;
    const { c, calls } = client((method) => {
      if (method === 'DELETE') { delCount++; return html(412); }
      if (method === 'GET') return html(404);
      return html(500);
    });
    const r = await c.deleteTodoResilient(CAL + 'a@x.ics', '"v0"');
    ok(r.deleted && r.alreadyGone, '目标已不存在时删除按成功处理');
    eq(calls.map((x) => x.method), ['DELETE', 'GET'], '只重读一次就收手，没有反复 DELETE');
  }

  // 5) DELETE 撞 412 → 服务器上还在但 ETag 变了 → 拿新 ETag 重删
  {
    let delCount = 0;
    const { c, calls } = client((method) => {
      if (method === 'DELETE') { delCount++; return delCount === 1 ? html(412) : html(204); }
      if (method === 'GET') return withEtag(200, '"v5"');
      return html(500);
    });
    const r = await c.deleteTodoResilient(CAL + 'a@x.ics', '"v0"');
    ok(r.deleted && !r.alreadyGone, 'ETag 变了重删成功');
    eq(calls[2].ifMatch, '"v5"', '重删用的是服务器上的最新 ETag');
  }

  // 6) DELETE 直接 404（本来就是幂等的）
  {
    const { c, calls } = client((method) => (method === 'DELETE' ? html(404) : html(500)));
    const r = await c.deleteTodoResilient(CAL + 'a@x.ics', '"v0"');
    ok(r.deleted && r.alreadyGone, '直接 404 也算删除成功');
    eq(calls.length, 1, '不会多发请求');
  }

  // 7) 其它状态码不吞：403 照旧抛出去
  {
    const { c } = client((method) => (method === 'PUT' ? html(403) : html(500)));
    let thrown = null;
    try { await c.putTodoResilient(CAL, TODO, '"v0"'); } catch (e) { thrown = e; }
    ok(thrown && thrown.status === 403, '403 不做重试，直接抛出');
  }

  console.log(`\n通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
