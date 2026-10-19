'use strict';

/**
 * CalDAV 客户端端到端自测。
 * 直接打真实的 Radicale：发现 → 建日历(必要时) → 写入测试任务 → 读回 → 删除 → 确认删除。
 *
 * 凭据一律从环境变量读，仓库里不落任何密码：
 *   PowerShell:
 *     $env:CALDAV_URL='https://caldav.example.com/你的用户名/'
 *     $env:CALDAV_USER='你的用户名'
 *     $env:CALDAV_PASS='你的密码'
 *     node test/selftest.js
 */

const { CaldavClient } = require('../src/main/caldav');

const SERVER = process.env.CALDAV_URL;
const USER = process.env.CALDAV_USER;
const PASS = process.env.CALDAV_PASS;

if (!SERVER || !USER || !PASS) {
  console.error('\n缺少环境变量 CALDAV_URL / CALDAV_USER / CALDAV_PASS —— 不把密码写进代码。');
  console.error('用法见本文件顶部注释。\n');
  process.exit(2);
}
const TEST_UID = `__taskslite-selftest-${Date.now()}@local`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
}

(async () => {
  const client = new CaldavClient({
    fetchImpl: (url, init) => fetch(url, init),
    baseUrl: SERVER, username: USER, password: PASS,
  });

  console.log('\n=== 1. 发现（PROPFIND principal） ===');
  const { home, calendars } = await client.discover();
  check('principal 可访问', !!home, home);
  console.log(`     home = ${home}`);
  console.log(`     已有日历 ${calendars.length} 个：${calendars.map((c) => `${c.name} (${c.href})`).join(', ') || '无'}`);

  console.log('\n=== 2. 日历就绪 ===');
  let cal = calendars[0];
  let created = false;
  if (!cal) {
    console.log('     没有日历，创建一个 TasksLite …');
    const href = await client.createCalendar(home, 'TasksLite');
    cal = { href, name: 'TasksLite' };
    created = true;
    console.log(`     已创建 ${href}`);
  } else {
    console.log(`     复用已有日历 ${cal.name} → ${cal.href}`);
  }

  console.log('\n=== 3. 写入测试任务（PUT） ===');
  const todo = {
    uid: TEST_UID,
    title: '__TasksLite 自测任务__',
    notes: '这是一条端到端自测写入的临时任务，验证完会被删除。\n含中文、逗号、换行、emoji 🎉',
    completed: false,
    priority: 1,
    due: '2030-12-31',
  };
  const put = await client.putTodo(cal.href, todo);
  check('PUT 成功并返回 etag', !!put.etag, put.href);
  console.log(`     href = ${put.href}\n     etag = ${put.etag}`);

  console.log('\n=== 4. 读回（REPORT calendar-query） ===');
  const all = await client.listTodos(cal.href);
  check(`REPORT 返回 ${all.length} 项`, all.length > 0);
  const found = all.find((t) => t.uid === TEST_UID);
  check('能读到刚写的任务', !!found);
  if (found) {
    check('  标题正确', found.title === todo.title, `实际="${found.title}"`);
    check('  优先级正确(1=高)', Number(found.priority) === 1, `实际=${found.priority}`);
    check('  截止日正确', found.due === '2030-12-31', `实际=${found.due}`);
    check('  备注保留换行', (found.notes || '').includes('\n'), JSON.stringify(found.notes));
    check('  备注保留 emoji', (found.notes || '').includes('🎉'));
    check('  未完成状态正确', found.completed === false);
    check('  etag 一致', found.etag === put.etag, `报告=${found.etag} 写入=${put.etag}`);
  }

  console.log('\n=== 5. 更新为已完成 ===');
  const done = Object.assign({}, todo, { completed: true });
  const put2 = await client.putTodo(cal.href, done, put.etag);
  check('按 etag 乐观锁更新成功', !!put2.etag);
  const after = (await client.listTodos(cal.href)).find((t) => t.uid === TEST_UID);
  check('状态已变为完成', after && after.completed === true);
  check('etag 已变化', after && after.etag !== put.etag);

  console.log('\n=== 6. 删除测试任务（DELETE） ===');
  await client.deleteTodo(put.href, put2.etag);
  const rest = await client.listTodos(cal.href);
  check('测试任务已消失', !rest.find((t) => t.uid === TEST_UID));
  check(`日历剩余 ${rest.length} 项任务`, true);

  if (created) {
    console.log('\n=== 7. 清理：删除自测期间创建的日历 ===');
    try {
      await client.deleteTodo(client.absolute(cal.href.replace(/\/$/, '') + '/'), null);
      console.log('     日历已删除');
    } catch (e) {
      console.log(`     ⚠️ 日历删除返回 ${e.message}（Radicale 默认 rights 可能不允许删集合）`);
      console.log(`     留了一个空日历 ${cal.href}，可以在客户端设置里换用别的`);
    }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n💥 自测异常终止：', e.message);
  if (e.status) console.error('   HTTP 状态码：', e.status);
  process.exit(1);
});
