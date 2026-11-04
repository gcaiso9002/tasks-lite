'use strict';

/**
 * 智能解析快速添加。
 *
 * 输入一整句自然语言，回车直接拆成结构化字段：
 *   「明天下午3点 买牛奶 #家 @生活 !高」→ 截止 明天、提醒 15:00、标签 家、清单 生活、优先级 高
 *
 * 这个文件同时被渲染层（<script> 标签）和 Node 单测引用，所以结尾做了双导出。
 */

const WEEK_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };

const RECUR_MAP = [
  ['每个工作日', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['每工作日', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['每天', 'FREQ=DAILY'],
  ['每日', 'FREQ=DAILY'],
  ['每周', 'FREQ=WEEKLY'],
  ['每周日', 'FREQ=WEEKLY;BYDAY=SU'],
  ['每周一', 'FREQ=WEEKLY;BYDAY=MO'],
  ['每月', 'FREQ=MONTHLY'],
  ['每年', 'FREQ=YEARLY'],
];

const p2 = (n) => String(n).padStart(2, '0');

function ymd(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function todayStr() {
  return ymd(new Date());
}

/** 相对今天偏移 n 天的日期字符串 */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** 本周（周一起）该星期几的日期；已经过去就顺延一周 */
function weekDate(weekday, nextWeek) {
  const d = new Date();
  const shiftToMonday = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + shiftToMonday + (nextWeek ? 7 : 0));
  d.setDate(d.getDate() + ((weekday + 6) % 7));
  if (!nextWeek && ymd(d) < todayStr()) d.setDate(d.getDate() + 7);
  return ymd(d);
}

/** 把「下午3点半」「15:30」这类时间解析成 HH:MM */
function parseTime(text) {
  let m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (m) return `${p2(+m[1])}:${m[2]}`;
  m = /(上午|早上|早晨|中午|下午|晚上|夜里|傍晚)\s*(\d{1,2})\s*[点时]?\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/.exec(text);
  if (m) {
    let h = +m[2] % 24;
    const period = m[1];
    if (/下午|晚上|夜里|傍晚/.test(period) && h < 12) h += 12;
    if (/中午/.test(period) && h === 12) h = 12;
    if (/上午|早上|早晨/.test(period) && h === 12) h = 0;
    const tail = m[3] || '';
    const min = tail === '半' ? 30 : tail === '一刻' ? 15 : tail === '三刻' ? 45 : (tail ? parseInt(tail, 10) || 0 : 0);
    return `${p2(h)}:${p2(Math.min(59, min))}`;
  }
  m = /(\d{1,2})\s*[点时]\s*(半|\d{1,2})?\s*分?/.exec(text);
  if (m) return `${p2(+m[1] % 24)}:${p2(m[2] === '半' ? 30 : (parseInt(m[2], 10) || 0))}`;
  return '';
}

const DATE_PATTERNS = [
  // 大后天 / 后天 / 明天 / 今天
  { re: /大后天/, fn: () => dayOffset(3) },
  { re: /后天/, fn: () => dayOffset(2) },
  { re: /明天|明日|次日/, fn: () => dayOffset(1) },
  { re: /今天|今日|当天/, fn: () => dayOffset(0) },
  // 下周三 / 下礼拜三
  { re: /(?:下|下个)(?:周|星期|礼拜)([一二三四五六日天1-7])/, fn: (m) => weekDate(WEEK_CN[m[1]], true) },
  // 本周五 / 这周五 / 周五 / 星期五
  { re: /(?:本|这|这个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/, fn: (m) => weekDate(WEEK_CN[m[1]], false) },
  // 下周 / 下个星期
  { re: /(?:下|下个)(?:周|星期|礼拜)(?![一二三四五六日天1-7])/, fn: () => weekDate(1, true) },
  // 3 天后 / 两天后
  { re: /(\d+|[一二两三四五六七八九十])\s*天[以]?后/, fn: (m) => dayOffset(cnNum(m[1])) },
  // 3 天内 / 3 天以内
  { re: /(\d+|[一二两三四五六七八九十])\s*天[以]?内/, fn: (m) => dayOffset(cnNum(m[1])) },
  // 月底
  { re: /月底|本月底/, fn: () => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); } },
  // 下个月 5 号 / 下月 5 号
  { re: /(?:下|下个)月(?:\s*(\d{1,2})\s*[日号]?)?/, fn: (m) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    if (m[1]) d.setDate(Math.min(+m[1], new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return ymd(d);
  } },
  // 11月5日 / 11 月 5 号
  { re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/, fn: (m) => {
    const d = new Date();
    let y = d.getFullYear();
    let cand = new Date(y, +m[1] - 1, +m[2]);
    if (ymd(cand) < todayStr()) cand = new Date(y + 1, +m[1] - 1, +m[2]);
    return ymd(cand);
  } },
  // 11/5
  { re: /(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/, fn: (m) => {
    const d = new Date();
    let cand = new Date(d.getFullYear(), +m[1] - 1, +m[2]);
    if (ymd(cand) < todayStr()) cand = new Date(d.getFullYear() + 1, +m[1] - 1, +m[2]);
    return ymd(cand);
  } },
  // 2026-11-05 / 2026/11/05
  { re: /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, fn: (m) => ymd(new Date(+m[1], +m[2] - 1, +m[3])) },
  // 15 号
  { re: /(?<![\d月])(\d{1,2})\s*[日号]/, fn: (m) => {
    const d = new Date();
    let cand = new Date(d.getFullYear(), d.getMonth(), +m[1]);
    if (ymd(cand) < todayStr()) cand = new Date(d.getFullYear(), d.getMonth() + 1, +m[1]);
    return ymd(cand);
  } },
];

function cnNum(s) {
  if (/^\d+$/.test(s)) return +s;
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return map[s] || 1;
}

const TIME_PATTERN = /(?:上午|早上|早晨|中午|下午|晚上|夜里|傍晚)?\s*\d{1,2}\s*[:：]\s*\d{2}|(?:上午|早上|早晨|中午|下午|晚上|夜里|傍晚)\s*\d{1,2}\s*[点时](?:\s*(?:半|一刻|三刻|\d{1,2}\s*分?))?|(?<![\d:/])\d{1,2}\s*[点时](?:\s*(?:半|一刻|三刻|\d{1,2}\s*分?))?(?![\d])/;

const TIME_ONLY = /(?:(?:上午|早上|早晨|中午|下午|晚上|夜里|傍晚)\s*)?\d{1,2}\s*[:：]\s*\d{2}|(?:上午|早上|早晨|中午|下午|晚上|夜里|傍晚)\s*\d{1,2}\s*[点时](?:\s*(?:半|一刻|三刻|\d{1,2}\s*分?))?|(?<![\d:/])\d{1,2}\s*[点时](?:\s*(?:半|一刻|三刻|\d{1,2}\s*分?))?(?![\d])/;

/**
 * 解析一行快速添加输入。
 * @returns {{title:string,due:string|null,priority:number,tags:string[],list:string,rrule:string,remindAt:string}}
 */
function parseQuickInput(text) {
  let s = String(text || '');
  const out = { title: '', due: null, priority: 0, tags: [], list: '', rrule: '', remindAt: '' };

  // 1) 标签 #xxx（允许 # 后面跟空格，"# 家" 也认）
  s = s.replace(/#\s*([^\s#@!]{1,20})/g, (_, t) => { out.tags.push(t); return ' '; });

  // 2) 清单 @xxx
  s = s.replace(/@\s*([^\s#@]{1,20})/g, (_, t) => { out.list = t; return ' '; });

  // 3) 优先级 !高 / !1 / p高
  s = s.replace(/(?:!|p)(高|中|低|[159])/gi, (_, p) => {
    const v = /高/.test(p) ? 1 : /中/.test(p) ? 5 : /低/.test(p) ? 9 : Number(p);
    out.priority = v || out.priority;
    return ' ';
  });

  // 4) 循环（长词优先，"每个工作日" 必须排在 "每天" 前面）
  for (const [word, rule] of RECUR_MAP) {
    if (s.includes(word)) {
      out.rrule = rule;
      s = s.split(word).join(' ');
      break;
    }
  }

  // 5) 时间（先抽走，免得 "3月5号" 里的数字被时间正则吃掉）
  let time = '';
  const tm = TIME_ONLY.exec(s);
  if (tm) {
    time = parseTime(tm[0]);
    s = s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm[0].length);
  }

  // 6) 日期
  for (const { re, fn } of DATE_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      out.due = fn(m);
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      break;
    }
  }

  // 7) 提醒：有日期就用那天的该时刻，只有时间就用今天
  if (time) out.remindAt = `${out.due || todayStr()}T${time}`;

  out.title = s.replace(/\s+/g, ' ').replace(/^[\s,，。、:：;；\-—]+|[\s,，。、:：;；\-—]+$/g, '').trim();
  out.tags = [...new Set(out.tags)];
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseQuickInput };
} else {
  globalThis.parseQuickInput = parseQuickInput;
}
