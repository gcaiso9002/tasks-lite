'use strict';

/**
 * RRULE 最小实现：只算「下一次是哪天」，够自动滚动循环任务用。
 *
 * 支持 FREQ=DAILY/WEEKLY/MONTHLY/YEARLY、INTERVAL、BYDAY、BYMONTHDAY、BYMONTH。
 * COUNT / UNTIL 故意不实现 —— 自动滚动是"完成一条再生成一条"，
 * 次数与终止日期对本地生成没有意义，真要用可在生成前自己判断。
 */

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(text) {
  const out = { freq: '', interval: 1, byday: [], bymonthday: [], bymonth: [] };
  for (const part of String(text || '').split(';')) {
    const [rawKey, rawVal] = part.split('=');
    if (!rawKey || !rawVal) continue;
    const key = rawKey.trim().toUpperCase();
    const val = rawVal.trim().toUpperCase();
    if (key === 'FREQ') out.freq = val;
    else if (key === 'INTERVAL') out.interval = Math.max(1, parseInt(val, 10) || 1);
    else if (key === 'BYDAY') out.byday = val.split(',').map((d) => d.replace(/[^A-Z]/g, '')).filter((d) => d in WEEKDAYS);
    else if (key === 'BYMONTHDAY') out.bymonthday = val.split(',').map((n) => parseInt(n, 10)).filter(Boolean);
    else if (key === 'BYMONTH') out.bymonth = val.split(',').map((n) => parseInt(n, 10)).filter(Boolean);
  }
  return out;
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从 YYYY-MM-DD 造一个本地时间的 Date */
function fromYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

/** 该月有没有这一天（1 月 31 日 -> 2 月 28 日） */
function clampDay(year, month, day) {
  const last = new Date(year, month, 0).getDate();
  return Math.min(day, last);
}

/**
 * 从 from（'YYYY-MM-DD'）出发，算下一次发生的日期。
 * 没有 due 的循环任务以"完成当天"为基准。
 * 返回 'YYYY-MM-DD'；规则认不出来时返回 null（调用方据此不做滚动）。
 */
function nextOccurrence(rrule, from) {
  const r = parseRrule(rrule);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq)) return null;
  const base = fromYmd(from);
  if (!base) return null;

  if (r.freq === 'DAILY') {
    const d = new Date(base);
    d.setDate(d.getDate() + r.interval);
    return ymd(d);
  }

  if (r.freq === 'WEEKLY') {
    if (!r.byday.length) {
      const d = new Date(base);
      d.setDate(d.getDate() + 7 * r.interval);
      return ymd(d);
    }
    // 在 byday 指定的星期几里找 base 之后的最近一天，且要跨满 INTERVAL 周
    const anchor = new Date(base);
    anchor.setDate(anchor.getDate() - anchor.getDay() + 1 - 7 * (r.interval - 1)); // 本周周一，回退 interval-1 周
    for (let i = 0; i <= 7 * r.interval; i++) {
      const cand = new Date(anchor);
      cand.setDate(anchor.getDate() + i);
      if (cand <= base) continue;
      if (r.byday.includes(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][cand.getDay()])) return ymd(cand);
    }
    return null;
  }

  if (r.freq === 'MONTHLY') {
    const day = r.bymonthday.length ? r.bymonthday[0] : base.getDate();
    const d = new Date(base);
    d.setDate(1);
    d.setMonth(d.getMonth() + r.interval);
    d.setDate(clampDay(d.getFullYear(), d.getMonth() + 1, day));
    return ymd(d);
  }

  // YEARLY
  const month = r.bymonth.length ? r.bymonth[0] : base.getMonth() + 1;
  const day = r.bymonthday.length ? r.bymonthday[0] : base.getDate();
  const d = new Date(base);
  d.setDate(1);
  d.setFullYear(d.getFullYear() + r.interval);
  d.setMonth(month - 1);
  d.setDate(clampDay(d.getFullYear(), month, day));
  return ymd(d);
}

/**
 * 给系列生成下一条的 UID。
 * 必须稳定且不撞车：同一条任务反复滚动会多次调用，
 * 所以从原 UID 里剥掉上一次追加的 #日期，再拼新的。
 */
function seriesUid(uid, nextDate) {
  const base = String(uid).split('#')[0];
  return `${base}#${String(nextDate).replace(/-/g, '')}`;
}

module.exports = { parseRrule, nextOccurrence, seriesUid, ymd, fromYmd };
