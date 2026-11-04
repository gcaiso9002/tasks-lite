'use strict';

/**
 * 完成状态向父任务传播。
 *
 * - 勾完一条任务后，如果它的所有直接子任务都完成了，父任务也跟着完成，
 *   并继续向上检查（支持多层父任务）；
 * - 反过来，重新打开一条任务时，它的所有上级也一并重新打开 ——
 *   否则会出现「父任务已完成、子任务却还没做完」的矛盾状态。
 *
 * 返回被改动的父任务（不含传入的那条本身），调用方负责落库和上传。
 * 带环路保护，最多向上 10 层，parentUid 指错也不会死循环。
 *
 * 桌面端（Electron 主进程）和 Android 端（WebView 里）共用这一份实现。
 */
function cascadeCompletion(tasks, uid, completed, limit = 10) {
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  const start = byUid.get(uid);
  if (!start) return [];

  const changed = [];
  const seen = new Set([uid]);
  let cur = start;

  for (let depth = 0; depth < limit; depth++) {
    const parentUid = cur.parentUid;
    if (!parentUid || seen.has(parentUid)) break;
    const parent = byUid.get(parentUid);
    if (!parent) break;
    seen.add(parentUid);

    if (completed) {
      // 只有「确实有孩子、且孩子全都完成」才带动父任务
      const kids = tasks.filter((t) => t.parentUid === parentUid);
      if (!kids.length || kids.some((k) => !k.completed)) break;
      if (!parent.completed) {
        parent.completed = true;
        changed.push(parent);
      }
    } else if (parent.completed) {
      parent.completed = false;
      changed.push(parent);
    }

    cur = parent;
  }
  return changed;
}

module.exports = { cascadeCompletion };
