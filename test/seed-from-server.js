'use strict';
/** 往服务器写一条任务，用来验证「服务器 → 客户端」方向的同步。凭据从环境变量读。 */
const { CaldavClient } = require('../src/main/caldav');

const SERVER = process.env.CALDAV_URL;
const USER = process.env.CALDAV_USER;
const PASS = process.env.CALDAV_PASS;

if (!SERVER || !USER || !PASS) {
  console.error('缺少环境变量 CALDAV_URL / CALDAV_USER / CALDAV_PASS');
  process.exit(2);
}

(async () => {
  const client = new CaldavClient({ fetchImpl: (u, i) => fetch(u, i), baseUrl: SERVER, username: USER, password: PASS });
  const { calendars } = await client.discover();
  const cal = calendars[0];
  if (!cal) { console.error('没有日历'); process.exit(1); }

  const todo = {
    uid: `from-server-${Date.now()}@local`,
    title: '来自服务器的任务（验证拉取）',
    notes: '这条是在服务器侧直接写入的，如果客户端同步正常，应该出现在客户端列表里。',
    completed: false,
    priority: 5,
    due: '2026-12-25',
  };
  const r = await client.putTodo(cal.href, todo);
  console.log(`已写入: ${todo.title}`);
  console.log(`href  : ${r.href}`);
  console.log(`uid   : ${todo.uid}`);
  console.log(`日历当前共 ${(await client.listTodos(cal.href)).length} 项`);
})();
