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
| `Tasks Lite 1.2.0.exe` | 绿色免安装版，双击即用，推荐 |
| `Tasks Lite Setup 1.2.0.exe` | NSIS 安装版，双击安装 |

两个版本都是 x64，未做代码签名，Windows 可能弹 SmartScreen 提示，选「仍要运行」即可。

> 推 `v*` 标签后 GitHub Actions 会自动打包并挂到 Release，本地不用等那几分钟构建。

## 功能

- **托盘常驻**：关窗口只是缩到右下角托盘，程序继续在后台同步
- **全局快捷键** `Ctrl+Shift+T` 唤起/隐藏，不需要先找到窗口
- **开机自启**（可开关）：开机直接进托盘，不弹窗口
- **主题**：浅色 / 深色 / 跟随系统，外加自定义强调色（即时生效、自动保存）
- **子任务**：任意层级，在任务编辑区的「上级任务」里指定，列表里自动缩进
- **循环任务**：每天 / 每周 / 每个工作日 / 每月 / 每年，也能手写任意 RRULE
- **提醒**：到点弹 Windows 通知，点通知直接跳到那条任务
- **列表 + 标签**：侧边栏按列表和标签分组，点一下就能筛
- **智能筛选**：明天到期 / 本周内 / 未来 7 天 / 无截止日 / 高优先级 / 循环任务 / 有提醒 / 是父任务 / 是子任务
- **回收站**：误删能原样恢复（本地，不会上传到服务器）
- 新建 / 编辑任务，优先级（高 / 中 / 低）、截止日期、备注
- 勾选完成（带系统通知）
- 全文搜索
- 自动同步（间隔可配）+ 窗口聚焦即同步 + Ctrl+R 手动同步
- 断网时操作照常进行，联网后自动补传（乐观队列）

### 退出方式

关窗口 ≠ 退出。要彻底关掉请用**托盘图标右键菜单里的「退出」**，或 `Ctrl+Q`。

## 使用

1. 双击绿色版 exe 或运行安装包
2. 点右上角 ⚙ 填服务器信息：

   | 字段 | 值 |
   |---|---|
   | 服务器地址 | `https://你的服务器/你的用户名/` |
   | 用户名 | `你的用户名` |
   | 密码 | 你自己的 |
   | 自动同步间隔 | 任意（分钟） |

3. 点「测试连接」，看到"连接成功，发现 N 个日历"就成了
4. 点「保存」

外观在同一面板下半部分的「外观」区域设置，**不用点保存，选了立刻生效**。

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

各功能对应的 ICS 字段：

| 功能 | 字段 |
|---|---|
| 子任务 | `RELATED-TO;RELTYPE=PARENT:<uid>` |
| 循环 | `RRULE`（FREQ / BYDAY 等，原样保留） |
| 提醒 | `VALARM` + `TRIGGER;VALUE=DATE-TIME`（也认别的客户端写的相对 `TRIGGER:-PT30M`，按截止日换算） |
| 标签 | 标准 `CATEGORIES`，别的客户端也认 |
| 列表 | `X-TASKSLITE-LIST`（iCalendar 没有"列表"这个概念，用自定义属性，不污染标准字段） |

### 同步策略

- 服务器是权威。每次同步 `REPORT` 全量拉取并覆盖本地
- 本地改动先写缓存保证界面立即响应，同时尝试 `PUT`
- `PUT` 失败（断网）就进 pending 队列，下次同步重放
- 队列重放时遇到 `409`（etag 不匹配）就丢弃该操作，交给下一次全量拉取覆盖 —— 避免死循环

### 回收站与提醒是本地的

回收站里的任务**不会上传到服务器**（服务器上确实删掉了），恢复时重新 `PUT`。这样就不会把一堆"已删除"的任务同步到 Task.org 之类的客户端里碍眼。代价是回收站内容只在本机，换设备看不到。

提醒的"已弹过"状态也存在本地，并单独放在 `reminded` 字段而不是任务里 —— 否则每次全量同步覆盖任务时，这个状态会被冲掉，导致同一个提醒反复弹。

### 数据位置

```
%APPDATA%\Tasks Lite\
  config.json     服务器配置与外观设置，密码字段是 enc:<DPAPI 密文>
  tasks.json      本地任务缓存、回收站、提醒记录
```

## 开发

```bash
npm install
npm start              # 开发模式运行
npm test               # 本地单测（ICS 字段往返 + 缓存层 + 渲染层自检）
node test/selftest.js  # 对真实 CalDAV 服务器做端到端自测（会写-读-删临时任务，需设 CALDAV_URL/USER/PASS 环境变量）
npm run dist           # 打包 portable + nsis
```

改完 UI 记得跑一下 `npm test` —— `scripts/check-dom.js` 会检查 `app.js` 里 `$('id')` 引用的元素在 HTML 里是否真的存在。本项目踩过一个相关的坑：`app.js` 顶层顺序执行，中间抛异常会导致后面的启动代码（包括绑定状态回调）全都不执行，界面一片空白但主进程毫无报错。

### 目录

```
src/main/caldav.js      CalDAV 协议客户端 + iCalendar 读写
src/main/store.js       本地缓存 + 回收站 + 提醒记录
src/main/config.js      配置 + DPAPI 密码加密
src/main/index.js       主进程、IPC、同步调度、托盘、快捷键、自启、主题
src/preload/preload.js  contextBridge
src/renderer/           UI（原生 HTML/CSS/JS，无框架）
scripts/check-dom.js    渲染层自检
test/ics-roundtrip.js   ICS 字段往返（离线）
test/store-unit.js      缓存层单测（离线）
test/selftest.js        端到端协议自测（需真实服务器）
```

## 已知限制

- 循环任务只按 RRULE 存规则，**到期时不会自动生成下一条**；完成一条后需要自己改下一次的日期
- 首次同步是全量拉取，任务量到几千条以上会变慢（家用场景无所谓）
- 换 Windows 账号后 DPAPI 解不开密码，需要重新填
