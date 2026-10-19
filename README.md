# Tasks Lite

本地 CalDAV 待办客户端。数据直接存在你自己搭的 CalDAV 服务器上，**不经过任何第三方云服务**。

![stack](https://img.shields.io/badge/Electron-44-47848F) ![license](https://img.shields.io/badge/license-MIT-green)

---

## 为什么做这个

Tasks.org 的桌面版和 Android 版都把「自托管 CalDAV 同步」放在付费档里（最低 $0.99/年），而 CalDAV 服务端（Radicale）本来就完全免费开源。既然协议是开放的，就没必要为了同步自己的服务器付订阅费。

这个客户端：

- 只连你自己的 CalDAV 服务器，不碰任何第三方账号体系
- 密码用 Windows **DPAPI** 加密后存本地，只有当前 Windows 用户能解开
- 服务器是权威数据源，本地缓存只为「断网也能看」服务
- 单文件 exe，双击即用，不用装 Node、不用装运行时

## 下载

安装包放在 [Releases](https://github.com/gcaiso9002/tasks-lite/releases/latest) 里，不进 git 仓库 —— 两个 exe 加起来近 200 MB，塞进仓库会让每次 clone 都拖着走，而且 git 历史会永久保存二进制。

| 文件 | 说明 |
|---|---|
| `Tasks Lite 1.0.0.exe` | 绿色免安装版，双击即用，推荐 |
| `Tasks Lite Setup 1.0.0.exe` | NSIS 安装版，双击安装 |

两个版本都是 x64，未做代码签名，Windows 可能弹 SmartScreen 提示，选「仍要运行」即可。

## 功能

- 新建 / 编辑 / 删除任务
- 勾选完成（带系统通知）
- 优先级（高 / 中 / 低）、截止日期、备注
- 按「未完成 / 今天到期 / 已逾期 / 已完成 / 全部」筛选
- 全文搜索
- 自动同步（间隔可配，默认 10 分钟）+ 窗口聚焦即同步 + Ctrl+R 手动同步
- 断网时操作照常进行，联网后自动补传（乐观队列）

## 使用

1. 双击 `TasksLite-1.0.0-x64.exe`（绿色版）或运行安装包
2. 点右上角 ⚙ 填服务器信息：

   | 字段 | 值 |
   |---|---|
   | 服务器地址 | `https://你的服务器/你的用户名/` |
   | 用户名 | `你的用户名` |
   | 密码 | 你自己的 |
   | 自动同步间隔 | 任意（分钟） |

3. 点「测试连接」，看到"连接成功，发现 N 个日历"就成了
4. 点「保存」

### ⚠️ 服务器地址必须带用户名

必须是 `https://主机/用户名/` 这种 **principal 路径**，不能只写域名根路径。

原因：CalDAV 规范里根路径只是 collection 不是 principal，不提供 `calendar-home-set` 属性（会返回 404）。Task.org 一类客户端直接在入口 URL 上取这个属性，拿到 404 就判定为「无效」。这个坑在调试 Task.org 时踩过，本客户端也做了规避 —— 即使入口 URL 取不到 `calendar-home-set`，也会回退用你填的 URL 本身。

## 技术实现

### CalDAV 协议

全部手写，没用第三方 DAV 库：

| 操作 | 方法 |
|---|---|
| 发现 principal / calendar-home-set | `PROPFIND` Depth:0 |
| 列日历 | `PROPFIND` Depth:1 |
| 建日历 | `MKCALENDAR` |
| 拉取全部任务 | `REPORT` calendar-query + VTODO filter |
| 新建/更新任务 | `PUT`（带 `If-Match` etag 乐观锁） |
| 删除 | `DELETE` |

认证用 Basic。任务实体是标准 iCalendar VTODO（RFC 5545），所以 Task.org、DAVx⁵ 等其它客户端能直接读同一个日历。

### 同步策略

- 服务器是权威。每次同步 `REPORT` 全量拉取并覆盖本地
- 本地改动先写缓存保证界面立即响应，同时尝试 `PUT`
- `PUT` 失败（断网）就进 pending 队列，下次同步重放
- 队列重放时遇到 `409`（etag 不匹配）就丢弃该操作，交给下一次全量拉取覆盖 —— 避免死循环

### 数据位置

```
%APPDATA%\Tasks Lite\
  config.json     服务器配置，密码字段是 enc:<DPAPI 密文>
  tasks.json      本地任务缓存
```

## 开发

```bash
npm install
npm start          # 开发模式运行
node test/selftest.js   # 对真实 CalDAV 服务器做端到端自测（会写-读-删临时任务）
npm run dist       # 打包 portable + nsis
```

改完 UI 记得验证一下 `[hidden]` 有没有真的生效 —— CSS 里的 `display` 会盖掉 HTML 的 `hidden` 属性，这是本项目踩过的一个真 bug。

### 目录

```
src/main/caldav.js      CalDAV 协议客户端 + iCalendar 读写
src/main/store.js       本地缓存
src/main/config.js      配置 + DPAPI 密码加密
src/main/index.js       主进程、IPC、同步调度
src/preload/preload.js  contextBridge
src/renderer/           UI（原生 HTML/CSS/JS，无框架）
test/selftest.js        端到端协议自测
```

## 已知限制

- **不支持子任务层级、循环任务(RECURRENCE)、提醒(VALARM)** —— 只做基础 VTODO 字段
- 首次同步是全量拉取，任务量到几千条以上会变慢（家用场景无所谓）
- 换 Windows 账号后 DPAPI 解不开密码，需要重新填
