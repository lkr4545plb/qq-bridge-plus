# QQ Bridge Plus 代码评审报告

> 评审对象：`qq-bridge-plus` v1.1.0（HEAD `5c9e65b`）
> 评审日期：2026-10-24
> 评审方式：全量静态阅读 + 6 路并行模块审计 + ESLint `no-undef` 全仓库扫描 + 测试套件实跑 + 序列化/写入性能实测
> 结论性质：只读评审，未修改任何生产代码

---

## 0. 一句话结论

**这是一个安全意识明显高于同类个人项目的代码库**（常量时间令牌比较、Host 白名单挡 DNS rebinding、CSRF 双校验、SSRF 逐跳校验、confused-deputy 集中关卡、preset fail-closed、白名单默认空），**但它缺一层最基础的静态检查，这个缺口已经在生产路径上漏出了 3 簇未定义变量错误（14 处）**；同一类"写得细但没被机器验证"的问题还表现在另外三处：贴吧正则可让事件循环卡死 1-7 秒、每收一条群消息全量同步落盘 5 MB 状态、发送失败的回滚路径整段失效。

三条主症：

1. **没有静态检查** → 复制粘贴出来的作用域错误进了主线（P0 + 2 处 P1）；
2. **同步 I/O 和同步正则都压在事件循环上** → "机器人变卡/变哑"的根因；
3. **单文件 14,288 行** → 451 个可测单元里，最需要被测的路由与管线恰恰锁在闭包里，导致门禁只敢跑 90/119。

优先级最高的不是重构，而是：**装 ESLint → 修 14 行 → 把三条同步阻塞摘掉 → 把测试门禁补到全量 → 再谈拆分**。

---

## 1. 体检数字

| 指标 | 数值 | 说明 |
|---|---|---|
| 总代码量 | 76,770 行 JS/MJS | 含 scripts；`src/` 28,317 行 |
| 最大单文件 | `src/bridge.js` **14,288 行 / 829 KB** | 内嵌 301 个函数 |
| 最大单函数 | `startConsoleServer()` **4,546 行** | 含 141 个 `url.pathname` 分支、524 处 `sendJson` |
| 控制台前端 | `public/console.html` 5,101 行 / 243 KB | 单文件内联 SPA，无构建 |
| HTTP 路由 | 115+ 个 | 全部内联在一个函数里 |
| 测试脚本 | 111 个 `test-*.mjs` + 8 个 `verify-*.mjs` | 门禁 `FULL_TESTS` = **90** |
| 测试实跑（Linux） | **85 / 90 通过** | 5 项失败全部已归因，见 §7 |
| ESLint `no-undef` | **14 处错误 / 3 簇** | 全部是真实运行期 ReferenceError |
| 依赖漏洞 | 7 个（1 critical / 3 high / 3 moderate） | `proxy-addr` critical、`zod` high |
| 静态检查工具 | **0** | 无 eslint / prettier / tsconfig / CI / .editorconfig |
| 文档引用断链 | 10 处 | 含 `docs/ARCHITECTURE.md`、`roles/README.md` |
| 同步阻塞实测 | 每消息 35-100 ms（落盘）、正则 1.8-7 s（贴吧页面） | 见 P1-2、P1-10 |

---

## 1.5 架构快评：它是怎么组织的

**它做什么**：把真实登录的 QQ（经 SnowLuma 的 OneBot v11 网关）接到 DeepSeek Harness。QQ 消息 → 桥接整理成提示词 → DSH 会话里的 agent → agent 通过桥接注册的 MCP 工具把文本/表情/图片/语音/拍一拍发回 QQ。附带控制台、人格卡、共享记忆、黑话学习、只读贴吧抓取、按会话选模型。

**分层**（这一版的实际形状）：

| 层 | 内容 | 评价 |
|---|---|---|
| `src/bridge.js` | 入口 + 全部运行期编排：QQ/DSH 事件、授权、队列、唤醒状态机、`startConsoleServer` | ⚠️ 14,288 行，301 个内嵌函数共享一个巨型闭包 |
| `src/core/*.mjs`（22 个） | 纯策略与仓库层：唤醒、回复节奏、看门狗、配置归一、图片解析、JSON 原子写… | ✅ 依赖极浅（21 个是叶子模块），可注入时钟、可离线测 |
| `src/console/` | 路由模块（`role-routes.mjs`） | ✅ 提供了可复用的 `matches/handle` 契约——**但只用在一个端点上** |
| `src/mcp-*.js` | 4 个 stdio MCP 进程，把 agent 的工具调用翻译成桥接 HTTP | ✅ 错误一律回 `isError`，不污染 JSON-RPC |
| `plugins/` + `dsh/agent-presets/` | DSH 侧插件与 preset，含 `qq-tool-restrict` 工具守卫 | ✅ 这是"群友拿不到 shell"的真边界 |
| `scripts/`（119 文件 / 46k 行） | 测试 + 探针 + 安装 + 发布 | ⚠️ 无索引、命名靠猜、30 个不在门禁里 |

**架构上真正做对的几件事**：

1. **单一所有权**：状态集中在桥接进程，DSH 只是被调用方；没有分布式一致性问题。
2. **纯函数下沉**：唤醒/节奏/看门狗这些"决策"被抽成可注入时钟的纯模块，且 `bridge.js` 确实在调用它们（不是摆设）。
3. **失败关闭（fail-closed）**：preset 名不可用就拒绝建会话而不是回退到 `standard`；令牌为空就拒绝启动控制台；agent 声明头出现就强制校验会话令牌。
4. **注释解释"为什么"而非"是什么"**：`MODE_INPUT_ALIASES`、`hardenStateDirAcl`、`crossSessionSendCheckV2` 的注释里带着真实事故复盘，这是可维护性的真实资产。

**架构上真正的问题**：

1. **入口是 god file**：改动任何一处的回归半径是 14k 行；451 个可测单元里，最需要被测的那些（路由、管线）恰恰因为锁在闭包里而最难测。
2. **"模块化"抽的是叶子，不是复杂度**：策略抽走了，但控制台 115 个路由、mux 泵、消息管线仍在 `main()` 里。
3. **同一语义有两份实现**：`closed-agent` owner 判定（router vs `modeAllowed`）、分条间隔（`sendBurstToQQ` 内联 vs `core/send-gaps`）、`session-router` 整模块零引用。
4. **零类型、零 lint、零 CI**：76k 行动态代码完全靠人眼和自建测试兜底——P0-1/P1-1 就是这个缺口的直接产物。

---

## 2. 评审方法与证据等级

| 手段 | 覆盖 | 产出 |
|---|---|---|
| 全量静态阅读 | `src/` 28k 行按模块分工读完 | 逻辑/并发/生命周期缺陷 |
| ESLint `no-undef` | `src/` + `plugins/` 全量 | **3 簇共 14 处未定义变量（P0/P1）** |
| ESLint bug 类规则（26 条） | 同上 | 重复键、自赋值、无修改循环条件等 |
| 测试套件实跑 | `test-audit.mjs full`（90 项） | 85 通过 / 5 失败，逐项归因 |
| 性能实测 | 用生产同款序列化函数压测 | 30 会话 = 5.5 MB / 29 ms stringify + 6.6 ms 写 |
| 逻辑探针 | 直接调用纯函数模块 | 配置零值/非法值语义、原型链索引 |

> 标注约定：**【已验证】** = 本次亲手复现或读到行号并确认；**【转述】** = 并行审计报告给出、未逐行复核。

---

## 3. P0 —— 立即修（1 条）

### P0-1 `/reset` 引用未声明变量，重置半途而废且内存/磁盘不一致

**位置**：`src/bridge.js:13074`（`handleIncoming` 内，`/reset` 与 `/new` 分支）【已验证】

```js
// 13032
const old = state.sessions[key];
if (old) {
  ...
  delete state.sessions[key];
  ... 20 余行内存清理 ...
  if (oldSessionId) busyWatchdog.staleBusyTurns.delete(oldSessionId);  // ← 13074
  ...
  saveSocialV2State();
  saveState();
  try { await api.stopSessionWork(old); } ...
  await sendToQQ(key, '已重置会话，下次消息将开新上下文');
}
```

`oldSessionId` 的唯一声明在**另一个函数**里（`bridge.js:9049`，控制台 `/api/session/reset` 路由）。这是一个模块作用域下不存在的标识符，属于运行期 `ReferenceError`，`node --check` 抓不到。

**后果链**：

1. 管理员在 QQ 里发 `/reset` → 13074 抛 `ReferenceError: oldSessionId is not defined`；
2. 后续 14 行全部跳过：`pendingWakeKeys` / `wakeConfigUpdatedKeys` 清理、`forgetAgentToken(key)`、`socialV2.conversations.delete(key)`、`seenForwardIds.delete(key)`、**`saveSocialV2State()`**、**`saveState()`**、`stopSessionWork`、`archiveSession`；
3. 异常被 `bot.onPrivateMessage` 的 catch 吞成一行 `处理私聊消息出错: oldSessionId is not defined`（`bridge.js:14050`）；
4. 用户侧**完全没有任何回复**；`state.sessions[key]` 在内存里已删、磁盘 `sessions.json` 仍是旧映射 → **重启后旧会话"复活"**，DSH 侧旧会话继续烧 token。

**为什么测试没抓到**：这个分支在 `scripts/` 里只有间接覆盖（VM 夹具不进 `/reset` 主路径），且没有任何静态检查。

**最小修复**（1 行）：

```diff
-          if (oldSessionId) busyWatchdog.staleBusyTurns.delete(oldSessionId);
+          busyWatchdog.staleBusyTurns.delete(old);
```

建议同时把整个 `/reset` 分支包一层 `try/finally`，保证 `saveState()` / `saveSocialV2State()` 无论如何都执行——这条命令的语义就是"重置"，落盘失败等于没执行。

---

## 4. P1 —— 本周修（11 条）

### P1-1 发送失败回滚路径同样引用未定义变量（两处，同一处复制粘贴）【已验证】

| 位置 | 未定义标识符 |
|---|---|
| `bridge.js:6861-6864`（`/api/socialV2/send-burst` 的 catch） | `budgetSt`、`now` |
| `bridge.js:9029-9032`（`/api/send/*` 统一发送的 catch） | `budgetSt`、`now` |

```js
try {
  const budgetSt = ...; const now = Date.now();   // 作用域仅限 try 块
  for (let i = 0; i < messages.length; i++) budgetSt.sendTimes.push(now);  // 预占额度
  const sentMessages = await sendMessagesV2(...);
} catch (error) {
  const failedCount = ...;
  for (let i = 0; i < failedCount; i++) {
    const idx = budgetSt.sendTimes.indexOf(now);  // ← ReferenceError
  }
  if (budgetSt.sendTimes.length > 500) ...         // ← 再来一次
  saveSocialV2State();
  log('[cross-session] 代发失败 ...');            // ← 永不执行
  sendJson({ ok: false, error: error?.message }, 500);
}
```

**后果**（比 P0 影响面更大，因为这是**每一条发送失败**都会走的路径）：

1. 预占的发送额度**永不回滚**——注释里"避免假 429"的目的正好落空；
2. `saveSocialV2State()` 被跳过，内存额度与磁盘不一致；
3. `[cross-session] 代发失败` 审计行**永不落日志**（跨会话代发是被重点审计的能力）；
4. 调用方拿到的是 `{"error":"budgetSt is not defined"}` 而不是真实失败原因，模型可能据此**整批重发** → QQ 侧重复消息；
5. 累积效应：一次抖动的 OneBot 连接就能把 `maxSendPerMinute` / `maxSendPerHour` 额度吃满，之后**机器人静默**（返回 429「发送频率超限」）直到窗口滚动。

**为什么两处一模一样**：整段"检查→预占→发送→失败回滚"被逐字复制到 6 个发送端点——预占点 6 处（`6830`、`6987`、`7093`、`7472`、`7560`、`9002`），回滚点 7 处（`6861`、`6996`、`7035`、`7136`、`7512`、`7593`、`9029`）。**其中只有 6861 与 9029 这两处写错了作用域**（用了 `budgetSt`/`now`，其余用的是仍在作用域内的 `st`）——这恰恰说明复制粘贴是这类缺陷的温床。抽成一个 `deliverWithBudget()` 是根治手段，同时消掉"`indexOf(now)` 同毫秒误删"这个共性缺陷（见 §5.2）。

### P1-2 每收一条 QQ 消息就全量同步落盘 `social-v2.json`【已验证】

- `appendSocialV2Message()` 末尾无条件 `saveSocialV2State()`（`bridge.js:12247`），自己发言（12320）、每次唤醒前（12632）也各一次，共 48 个调用点。
- `saveSocialV2State()`（10216-10256）序列化**全部会话**：每会话 `recentMessages≤200`、`unread≤100`、`sendTimes≤500`、`seenForwardIds≤1000`、`memberImpressions` 全量。
- 落盘走 `atomicWriteJson` → `writeFileSync` + `renameSync`，**全同步**；Windows 上 rename 被占用时还用 `Atomics.wait` 同步忙等 40/80/120/160 ms（`core/json-store.mjs:56-70`）。

**实测成本**（本机 Linux，用生产同款 `JSON.stringify(obj, null, 2)`）：

| 会话数 | JSON 体积 | stringify |
|---|---|---|
| 5 | 0.92 MB | 8.9 ms |
| 15 | 2.76 MB | 15.7 ms |
| **30** | **5.52 MB** | **29.1 ms** |
| 60 | 11.04 MB | 57.7 ms |

加 `writeFileSync` 实测 6.6 ms/次（5 MB 量级），Windows + Defender 环境只会更差。**折合每条群消息阻塞事件循环 35-100 ms**，而这条线程同时负责 DSH 事件流泵、唤醒定时器、控制台 HTTP。

**修复方向**：`saveSocialV2State()` 改为 debounce 300-1000 ms 合并写；`renameSync` 重试改异步；`seenForwardIds`（每会话 1000 条）改存独立的紧凑文件或只存最近 N 条。

### P1-3 全局单条 `sendChain` 把语音/图片/文本串死【已验证】

`let sendChain = Promise.resolve()`（`bridge.js:9219`）是**进程级唯一**的一条链，文本（9240）、表情（1342）、语音（1145）、图片（1538）全部 `sendChain = sendChain.then(...)`。语音在链内预算 60 s（1148-1162），图片同理（1553）。

**后果**：任何一个会话的一条语音/图片卡住（SMB 图床慢、ffmpeg 慢、OneBot 超时），**全机器所有会话的所有发送**都被堵在链后面最长 60 s。对"多群同时聊"的场景是致命的。

**修复**：按 `key` 分链（`Map<key, Promise>`），或把媒体发送移出串行链（先占位、后台完成）。

### P1-4 语音限流"先检查后记账"跨 await，可并发绕过【已验证】

- `voiceBudgetCheck()`（1083-1094）只统计不预占；
- 1268 `await sendVoiceV2(...)`（内含 `inspectAudio` + 可能 60 s 的抓取/ffmpeg）；
- 1269 才 `voiceBudgetCommit()`；
- 端点侧 7380 再 check 一次，窗口被拉成两个 await。

`maxPerMinute=2` 时，N 个并发请求全部通过检查。文本路径（6829-6831）**已经做对了预占**，语音没有照抄。

**修复**：照文本路径先 `push(now)` 预占，失败/审计拦截时按 ticket 回滚。

### P1-5 暂停 / 限频 / DSH 离线三处丢唤醒，且没有补投【转述，已核对关键行】

| 场景 | 位置 | 现状 |
|---|---|---|
| 二代暂停期间 | `13132-13135` | 消息只 `appendActivity` 就 return |
| 唤醒被频率上限拒绝 | `12607-12611` | 只 `clearRearmMark()` 就 return |
| 恢复 / 重连 | `6127-6131`、`2607` | 只重建 `sleepTimer`/`proactiveTimer`，**不 replay unread、不重排 `pendingWakeReasons`** |

结果：会话出现"慢性不回复"——消息在 backlog 里躺着，没有任何东西会再次触发唤醒，直到下一条新消息到来。

**修复**：恢复时遍历有 unread 的会话 `scheduleWakeV2`；限频跳过时排一个 `replyCheckTimer` 兜底。

### P1-6 DSH `remote.mux` 事件流没有握手超时/空闲超时/外部中止【转述，已核对】

- `dsh-client.js:962-1199` 整个生成器只有一个 2 s 重订阅 `setTimeout`（1143），无 deadline；
- `bridge.js:13484` 调 `api.events.mux({})` **不传 signal**；`own` 控制器只在生成器自身 finally 里 abort；
- 对端半开（进程挂起 / NAT 超时 / 防火墙静默丢包）时 `for await` 永不返回也不抛错 → `pumpMux` 的 catch/重连（14010-14039）全不触发。

**症状**：DSH 的 HTTP 健康检查仍然成功（所以监控显示"在线"），但一条事件都收不到，`collectors` 不清、会话永久 busy。

**修复**：生成器内加握手超时（10 s）+ 空闲超时（90 s 无帧即 `endStream()`）；把 `pumpMux` 的 `AbortController` 暴露给健康检查。

### P1-7 `invalidateAuth()` 会覆盖用户显式配置的 `dsh.authToken`【转述】

`dsh-client.js:619-620`：

```js
const discovered = discoverDshLaunchToken();
if (discovered) this.launchToken = discovered;   // ← 不区分 tokenExplicit
```

而 `ensureAuth` 在 `tokenExplicit === true` 时跳过离线铸造（672），401 与 WS 关闭都走 `invalidateAuth`（864、990）。结果：用户填好 `authToken` 后，只要 `~/.dsh/logs/server-*.log` 里残留一个旧 token，第一次断流就被顶掉 → **永久 401**。

**修复**：`if (!this.tokenExplicit && discovered) ...`（一行）。

### P1-8 `state-acl` 在中文 Windows 上会把"收紧失败"判成成功【已验证】

`src/state-acl.mjs:94`：

```js
if (/access is denied/i.test(out)) { return { ok: false, ... } }
```

`icacls` 用 `/C` 时即使失败退出码仍是 0，所以**只能靠输出文本判定失败**。中文 Windows（本项目唯一实机验证平台）上 `icacls` 输出的是「拒绝访问」，正则不匹配 → 返回 `ok: true` → `bridge.js:208-216` 把 `stateDirHardened` 置真 → 控制台「访问与安全」页显示"已收紧"，**而 `state/` 里的 `console-token` / `accessToken` / 各会话 `agentToken` 仍对其他登录用户可读**。

另外 `/grant Administrators:F` 用英文组名，应改用 SID。

**修复**：判定改用退出码 + SID（`*S-1-5-32-544` / `*S-1-5-32-545` / `*S-1-5-11`）；错误检测同时匹配 `/\b(denied|拒绝访问)\b/i`；自检改成"用本进程实际 `readFileSync` 一个已知凭据文件"。

### P1-9 测试门禁只覆盖 90/119，且 `test-console` 会删掉被 git 跟踪的文件【已验证】

- 磁盘上 111 个 `test-*.mjs` + 8 个 `verify-*.mjs`，`FULL_TESTS` 只有 **90**；
- 至少 15 个**零入口**（既不在清单也无 npm 脚本）：`test-mcp-safe` / `test-mcp-exec` / `test-mcp-host` / `test-mcp-web-search` / `test-onebot-connection` / `test-deepseek-harness-mcp` / `test-deepseek-harness-wait` / `test-agent-preset-patches` / `verify-busy-watchdog` / `verify-cross-session-send` / `verify-slang-selection` …
- 这些门外测试**已经烂掉**：实测 `test-stickers` / `test-v2-wait` / `test-forward` 直接失败（前两个是因为硬读仓库根的 `config.json`，干净检出必然 ENOENT）。
- `scripts/test-console.mjs:99`：`fs.rmSync(new URL('../roles/测试人格Tmp.md'))` —— 这个文件**在 `git ls-files` 里**。跑一次 `npm run test-console` 就把仓库工作区里的人格卡删了，同一个脚本还会打真实 3100 端口、向真实 QQ 网关发消息。

**修复**：补齐 manifest（需外部服务的标 `skipWhenUnavailable`）；`test-console` 改 dry-run + 临时 ROOT；测试一律不读仓库根 `config.json`，改读 fixtures。

### P1-10 贴吧 HTML 解析正则超线性，可让事件循环卡死 1-2 秒【已复现】

`src/tieba-lib.js` 用正则解析百度贴吧 HTML，两处关键正则在"接近但不匹配"的输入上退化成 O(n²)：

| 位置 | 正则 | 实测（本机） |
|---|---|---|
| `htmlToText`（475-476） | `/<script[\s\S]*?<\/script>/gi`（`style` 同款） | 280 KB 伪造 `<script` 输入 → **1,804 ms**；300 KB → 7,035 ms（并行审计报告） |
| `parseBarPage`（529） | `String.split(/<li[^>]*class="[^"]*tl_(?:shadow\|top)/i)` | 196 KB `<li a` 输入 → **1,280 ms** |

`safeFetch` 只挡内网，不挡内容形态；而 `fetchBarPage` / `fetchThreadPage` 由 **bridge 主事件循环同步调用**（`bridge.js:6368`、`6449`），一次卡住 = 全部 QQ 消息 + 控制台 + 唤醒定时器一起停摆。`try/catch` 兜不住——V8 没有回溯上限，它不抛异常，只卡死。贴吧页面本身由第三方（含任何能发帖的人）控制，所以这是一条**可被外部内容触发的可用性攻击面**。

**修复**：① 这两处改单遍扫描（`indexOf` 找 `</script>` 边界）而不是非贪婪回溯；② 正则解析搬进 `worker_threads`，超时即弃；③ 或引入 HTML 解析器（单页 200 KB 量级，成本可接受）。

### P1-11 token 账本饱和后，每条事件都全量重写一遍【已核对逻辑】

`token-ledger.js` 的 `maybeCompact()`（349-354）：

```js
if (journalLines <= maxLines && samples.size <= maxLines && !evictedDirty) return;
```

而 `compact()` 写完后 `journalLines = out.length`（299），`out` = baselines + **全部 samples（可达 maxLines=20000）** + evicted。于是账本一旦跑满：

1. `journalLines ≈ 20001 > 20000` → 早退条件**永久为假**；
2. 每次 ingest 都调 `evictOldestSamples()`（此时 `overflow = 0`，什么也没淘汰）；
3. 紧接着无条件 `compact()` → **重写约 2 万行 / 3.8 MB 的 JSONL**。

并行审计实测：第 20001 条事件起，每条事件 ~21 ms、每次重写 3.8 MB。这本账在 QQ 事件路径上，等于把 P1-2 的落盘问题又叠了一层（只是它要跑几周才显现）。

**修复**：`compact()` 后设一个高水位（如 `journalLines > maxLines * 1.1` 才压），且 `dropped === 0 && !evictedDirty` 时直接跳过 rewrite。

---

## 5. P2 —— 排期修（按主题）

### 5.1 安全

| 位置 | 问题 | 建议 |
|---|---|---|
| `runtime-config.mjs`（全表） | **嵌套字段零校验**：`maxSendPerMinute:"abc"` → 消费点 `Number(x)\|\|0` → 0 → `maxPerMinute > 0` 为假 → **限流整条失效**（fail-open）；负数同理。【已验证】 | 加字段 schema（min/max/int/bool），非法值产出 diagnostic；把"0 = 无限"改成显式 `null` |
| `runtime-config.mjs:38-41` | `deny.groups:["12345","+86123"]` 里非法项被**静默丢弃** → 本该拒绝的号码变成**放行** | deny 出现不可解析项时 fail-closed 并 warn |
| `safe-fetch.js:66-110` | 私网表遗漏 `192.88.99.0/24` 与 Teredo `2001::/32`（实测两类 URL 均放行）【转述】 | 补表；其余 32 组敌意 URL 已全挡 |
| `bridge.js:4894` | 令牌可经 URL query（`?token=`）传递，401 页也用它重定向 | 只认 `x-console-token` 头；浏览器场景改一次性票据换 HttpOnly cookie |
| `bridge.js:4804-4810` | CSP 含 `script-src 'unsafe-inline'`（单文件内联 SPA 的必然结果） | 脚本外置 + nonce，补 `base-uri`/`object-src`/`form-action` |
| `bridge.js:5914` | 会话令牌**被写进模型上下文**（`【会话令牌】…`）。当前需同时持有 console token 才可用，属纵深风险 | 改由 MCP 进程从 `state/` 直接读，不进 prompt |
| `console.html:4812` | `usageMoney(n, sym)` 把 `pricing.symbol` 裸拼进 HTML（config 侧可控，非 QQ 可达） | 补 `esc()`，与同文件 4970 口径统一 |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs:238-239` | `restricted.add(name)` 在 `restrict()` 之前且循环无 try/catch → 一次抛错后该名字永久"已限制"不重试、后续名字全部漏 restrict（fail-open） | `restrict()` 成功后再 add；循环内 try/catch |
| `scripts/patch-snowluma-sdk.mjs` | postinstall 静默改 `node_modules`：正则只认单引号、dist 缺失只 log 后 exit 0、无回读校验、无测试 | 换 `patch-package`/`pnpm patch` 存 patch 文件；或加 `await import()` 冒烟 + 报错退出 |

### 5.2 稳定性 / 长跑

| 位置 | 问题 | 建议 |
|---|---|---|
| `core/json-store.mjs:73-97` | 原子写无 `fsync`（文件与父目录），断电可能留下 0 字节或旧内容 | 写后 `fsyncSync`；启动清理 `*.tmp` 残留 |
| `core/json-store.mjs:20-29` | `readJsonSafe` 非 required 时静默返回 fallback，配合"读-改-写"端点 = 把"文件损坏"变成"永久重置"（`current-role.json`、`mode.json` 都中） | fallback 时记日志；会被回写的状态文件加 `writable` 标志（`session-store` 已是正确范式） |
| `bridge.js` 9 处 `readConfigObject → atomicWriteJson` | 无互斥、无版本戳：`/api/dsh/model` 在读完 config 后 `await` 最长 5 s 才写回，期间任何其他写配置的请求都会被旧快照覆盖（丢更新） | 进程内串行化 + `stat(size,mtime)` 戳校验（`social-v2.json` 10075-10082 已有正确范式，复用它） |
| `bridge.js:2999-3018` | 看门狗 `setInterval` 只启动一次，`enabled=false` 时直接 return → 控制台热开 `enabled` 后**永不生效** | enabled 判定移进扫描体，或配置变更时重启定时器 |
| `bridge.js:3764-3813` | `retireSession` 漏清 `messageMediaStore` / `seenForwardIds`（只有 `/reset` 清）→ 每退役会话残留 ≤500 条媒体元数据 | 并入 `forgetConversationCaches` |
| `bridge.js` 7 处额度回滚 | 用 `sendTimes.indexOf(now)` 按**时间戳**删预占：同毫秒的并发请求会删掉别人的预占；预占条目被 `slice(-500)` 截断后 `indexOf` 失败 → 额度漏账（假 429 或超发） | 预占返回唯一 ticket，回滚按 ticket 删 |
| `bridge.js:683-689` | `withTimeout` 只 race 不 abort：超时"失败"的发送**可能仍然送达**，调用方按失败处理并重发 → 重复消息 | `AbortController` 贯穿到 `onebotSend` |
| `bridge.js:14277-14282` | `uncaughtException` 一律 `exit(1)`：一次 stdout EPIPE 就杀掉 24/7 进程、在途 turn 全丢 | 已知无害的 socket 错误只记日志 |
| `bridge.js:4280/4301` | `patrol-log.jsonl` **只追加、无上限、无轮转**，且升级 `outcome` 时 `readFileSync` 整文件 + `writeFileSync` 整文件 | 加上限轮转；或把"是否说话"记到独立小文件 |
| `core/wake-timers.mjs:64-72` | `schedule()` 不校验 callback 是函数；回调抛错发生在 timer 上下文 = `uncaughtException` → 进程崩 | 入口 `typeof callback !== 'function'` 直接 throw |
| `core/image-format.mjs:31-77` | 图片像素上限 fail-open：`imageDimensions()` 返回 null 时所有调用点 `if (dims && ...)` 跳过检查，未知格式还被兜底成 `image/jpeg` | 尺寸未知按超限处理 |

### 5.3 一致性（"已模块化"只覆盖一半）

| 位置 | 问题 |
|---|---|
| `bridge.js:9267-9305` | `sendBurstToQQ` 内联实现分条间隔（不走 `core/send-gaps` 的 `clampMessageGap`，也没有 `maxGapMs` 钳制），而 reserved2 工具路径走 core 版 → **两种模式间隔语义不同** |
| `bridge.js:13854-13862` | reserved（一代）自动回复**完全不走** `st.sendTimes` 额度，只有 reserved2 有 → 一代被刷屏时无闸 |
| `core/session-router.mjs`（623 行） | **整个模块零生产引用**，只被自己的 353 行测试引用；`closed-agent` 的 owner 边界在 `bridge.js:3668-3673` 另有第二份实现 → 两份一旦漂移就是一宽一窄 |
| `core/runtime-config.mjs:361/372` | `socialV2.sticker` 字面量里 `collect` 写了**两次**（第二个在 `...spread` 之后，属有意但极易误读）→ 阻塞 lint，建议加注释或重构 |
| `bridge.js:5502`、`:5727` | `merged.enabled = merged.enabled` / `next.interceptNotify = next.interceptNotify` 自赋值空操作（行为正确，纯死代码） |
| `core/wake-policy.mjs:107` | `priorities[base]` 裸索引走原型链：`wakePriority('constructor')` 返回 `Object` 构造函数【已验证】→ 用 `Object.create(null)` 或 `hasOwnProperty` |

### 5.4 贴吧 / 内容层（`tieba-lib` / `slang` / `sticker` / `voice` / `model-prices`）

| 位置 | 问题 | 建议 |
|---|---|---|
| `tieba-lib.js:1131-1219` | `buildTiebaImageContent` 只过滤 `^https?://`，**没有 `isTiebaImageHost`**；配合 `safe-fetch` 每跳只校验"是否内网"（不锁域名），白名单图床 302 到任意公网主机仍会被下载 | 图片下载前对**每一跳**校验图床域名白名单；`maxImages`/`maxBytes` 夹紧（目前 `-1` → `slice(0,-1)`、`Infinity` → 全取） |
| `model-prices.js:184-186` | `ratesAt()` 用 `table.models[key]` 裸索引：模型名取 `constructor` / `toString` / `__proto__` 时 **`TypeError: Cannot read properties of undefined (reading 'cacheHit')`**【已验证】→ `/api/tokens/*` 500 | `Object.create(null)` 或 `hasOwnProperty` 守卫（与 §5.3 的 `wakePriority` 同源问题） |
| `model-prices.js:123-154` | override 数值不校验：`peakWeekdays:["1","2"]`（字符串）→ 峰谷判定恒 false（**静默少算钱**）；`off.cacheMiss:null` → 单价 0；`"abc"` → cost `NaN` | 数值/类型校验，非法值回退默认并 warn |
| `slang-learner.js:411-459` | `extractJsonArray` 的"防 O(n²)"长度闸门设在 400000：`'['×100000` → 11.7 s，模型输出常见 32k → ~1.5 s，且是**同步**调用 | 闸门降到 64k；解析改单遍扫描 |
| `slang-learner.js:71-75` | 证据裁剪只裁对象项的 `text`，数组里的裸字符串与对象其它键不裁 → 5 MB 的键值可原样落盘；`.corrupt-<ts>` 每次加载失败新生成一个、从不清 | 按白名单投影 + 长度限制；`.corrupt` 只留最近一份 |
| `sticker-lib.js:103-164` | 表情库**没有任何条数上限**（黑话库有 2000），`id/resId/url` 也无长度上限；每次 note/use 全量重写 | 加上限与字段长度；写盘 debounce |
| `voice-core.js:129-145` | `safeJoinLibrary` 的 symlink 复核对**不存在的叶子**失效（`realpathSync` 抛 ENOENT 后直接返回词法路径）→ 库内 `sub → /etc` 的软链，`sub/x.mp3` 会被判为库内 | 词法判定后对**父目录**做 realpath 复核 |
| `voice-core.js:163/400-443` | `ffprobe` 把文件名作为位置参数（`-` 开头会被当选项）；ffmpeg 失败分支残留 `vol-*.wav` 临时文件 | 加 `--` 分隔符；`finally` 清理 |
| `tieba-lib.js:163-207` | `normalizePageRange` 在 `maxPages < 1` 时产出空计划（`{pages:[], requestedPages:1, truncated:true}`）；`'999'` 静默夹到 100 无提示 | 夹紧到 ≥1；截断时回 note |

### 5.5 工程化 / 文档

| 项 | 现状 | 建议 |
|---|---|---|
| 静态检查 | 无 eslint / prettier / tsconfig / editorconfig | **最高 ROI**：接 ESLint（`no-undef` + 26 条 bug 规则已可用，见 §6.1） |
| CI | 无 `.github`、无 `npm test` | 一个 workflow：node 22 + `npm ci` + `test:audit` + lint |
| **28 个** test/verify 脚本会 `readFileSync('src/bridge.js')`（VM 夹具 + 直接文本断言）；其中 `test-bridge-core-contract.mjs` 还 `deepEqual` 住整个 core import 清单 | 加一个 core 模块就得改测试；任何重构都会红 | VM 夹具改成注入依赖；import 清单断言从"全等"改为"存在且可解析" |
| 文档断链 | 10 处引用不存在的文件：`docs/ARCHITECTURE.md`、`docs/RUNBOOK.md`、`docs/FOLDER_MAP.md`、`docs/README.md`、`docs/guides/{VOICE,VOICE-TOOLS,PRIVACY,SECURITY_BASELINE}.md`、`roles/README.md` | 要么补，要么把引用改指现有 4 篇（`bridge.js:8` 的职责地图直接指向不存在的文件） |
| 依赖 | `npm audit`：critical `proxy-addr`、high `zod`(<4.6.6 内存放大)、`hono`、`ip-address` | `npm audit fix`；`zod` 升级顺带给 MCP 参数补 `.max()` |
| 批处理 | `restart.bat` 是 UTF-8 无 BOM + 12 行中文；三个 bat 都无 `setlocal`；`模型管理.bat` 用 `exit /b 0%code%` 且无 node 存在性检查；`start.bat` 无退避、exit 0 也重启 | 统一 `setlocal` + ASCII；start.bat 加指数退避 |

---

## 6. 架构建议

### 6.1 先上工具链（0.5 天，立刻见效）

本次评审用 ESLint 9 跑了两套规则，**在零配置下就抓出 14 处真实运行期错误**。建议直接落地：

```js
// eslint.config.mjs —— 只开"抓 bug"的规则，不掺风格
import globals from 'globals';
export default [{
  files: ['**/*.{js,mjs}'],
  ignores: ['node_modules/**', 'public/**'],
  languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  rules: {
    'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error',
    'no-self-assign': 'error', 'no-fallthrough': 'error', 'no-constant-condition': ['error', { checkLoops: false }],
    'no-promise-executor-return': 'error', 'use-isnan': 'error', 'valid-typeof': 'error',
    'require-atomic-updates': 'warn',
  },
}];
```

`npm run lint` 挂进门禁后，`node --check` 抓不到的这类错误就再也不会进主线。

### 6.2 再拆 `bridge.js`（3-5 天，唯一的结构性技术债）

现状：`main()` 内 301 个内嵌函数共享一个巨大的闭包，`startConsoleServer` 一个函数 4,546 行、115+ 路由。模块化只抽走了**纯策略叶子**（这是对的），但复杂度主体（控制台路由、mux 泵、消息管线）还在原地。

建议沿用仓库里**已有的**路由契约（`console/role-routes.mjs` 的 `matches()/handle(req, url, {readBody, sendJson})`），不要另造一套：

| # | 模块 | 从 `startConsoleServer` 搬出的内容 | 优先级 |
|---|---|---|---|
| 1 | `console/identity.mjs` | 令牌装载/校验、`agentTokenOk`、`isLiveAgentToken`、`crossSessionSendCheckV2` | P0 级（先把身份判定收敛成 `ctx.actor`） |
| 2 | `console/http-gate.mjs` | `createServer`、安全头、`sendJson`/`readBody`、Host 校验、CSRF、favicon | 同上 |
| 3 | `routes/config.mjs` | mode/role/whitelist/security/console-token（**配置写串行化队列放这里**） | 高 |
| 4 | `routes/send.mjs` | send-burst/send-message/poke/sticker/image + `deliverWithBudget()` 横切 | **最高**（顺带修 P1-1、P2 额度回滚） |
| 5-12 | `routes/{status,model,prompts,slang,social-v2-read,social-v2-write,media,ops}.mjs` | 按主题分 | 中 |
| 13 | `social/pipeline.mjs` | `pumpMux`、`handleIncoming`、唤醒/等待状态机 | 中 |

目标：`startConsoleServer` 最终只剩"建 server → 过 gate → 走路由表 → 404/catch"，≤120 行。

配套动作：
- 那 94 处手写的 `if (req.headers['x-agent-token'] && ...)` 组合删掉，改成端点声明 `requires: 'agent' | 'console'`；
- 抽 `projectForAgent(obj)` 统一"哪些字段可以给模型看"，避免逐处记得脱敏（现在 `7384` dryRun 回显绝对路径就是漏的一处）；
- 抽 `deliverWithBudget()` 消掉 5 份复制的限流/预占/回滚。

---

## 7. 测试套件实跑结果与归因

`node scripts/test-audit.mjs full` → **85 / 90 通过**（本机 Linux）。5 项失败全部已归因，**没有一项指向产品逻辑缺陷**：

| 失败项 | 原因 | 性质 |
|---|---|---|
| `test-start-guard` | `spawn cmd.exe ENOENT` | Windows-only |
| `test-console-encoding` | `chcp ENOENT` | Windows-only |
| `test-preset-local-tools` | 工具名发现只看到项目 `node_modules/@deepseek-ai` 里的 devDeps，看不到 `dsh-tool-*` → 76 个名字全被判"假名" | **测试设计缺陷**：部分发现时应跳过或要求 `DSH_TOOL_PACKAGES` 显式指定 |
| `test-dsh-cli-resolve` | `Promise resolution is still pending but the event loop has already resolved` | 悬空 Promise（与 `mcp-deepseek-harness` 里 `new Promise(()=>{})` 同源风险） |
| `test-dsh-discovery-logging` | 同上 | 同上 |

建议：给 Windows-only 测试加 `process.platform !== 'win32' && t.skip()`，让套件在 Linux 上也能作为 CI 门禁（这对一个想接 GitHub Actions 的项目是刚需）。

---

## 8. 已确认"做对了"的部分（避免后续误改）

这部分我逐项验证过，不是客套：

- **控制台鉴权**：`Host` 头白名单用**实际绑定端口**校验，挡 DNS rebinding（`4877-4890`）；`crypto.timingSafeEqual` + 长度短路（`4895-4901`）；空令牌拒绝启动（`4676`）；写操作强制 `application/json` + Origin 同源（`4931-4946`）；`readBody` 有 1 MB 上限 + 30 s 超时。
- **confused deputy 已修**：`x-agent-call: 1` 一律要求命中活跃会话令牌（`4922-4926`），端点漏写也不会退回管理端权限。
- **跨会话发送**：只有两条互不相交的放行路径（owner 私聊的 admin-letter 回合、任何会话→**恰好** owner 私聊），且预算记在来源会话上（`4740` 起）。设计正确且注释详尽。
- **SSRF**：`safe-fetch.js` 用**已解析 IP** 建连 + Host 头 + SNI，每跳重定向重新校验；32 组敌意 URL（十进制/八进制/十六进制 IP、IPv4-mapped、NAT64、6to4、zone-id、userinfo、trailing dot、`file:`）实测全部拦截。
- **前端 XSS**：40 处 `innerHTML`、162 处 `${}` 插值逐个核对，QQ 可控数据全部走 `esc()`（正确转义 5 个字符）；无 `insertAdjacentHTML`/`eval`/`new Function`/`document.write`/动态 `href`。
- **双唤醒防护**：单槽定时器 + 注册身份校验 + `pendingWakeKeys` 30 min 租约 + `isConversationBusyV2` + rearm 去重，四重闸门，未找到可达的双投路径。
- **缓存上限**：`retryTurnStates` 256、`pendingWakeReasons` 20、`wakeTimes` 200、`sendTimes` 500、`forwardIds` 1000、`messageMediaStore` 500、token 账本 20000 行（含淘汰压缩）——全部有序淘汰，唯独 `patrol-log.jsonl` 漏了。
- **人格卡路径穿越**：`sanitizeRoleName` 的白名单正则挡掉 `../`、`\`、`:`（ADS）、`.` 与 Windows 设备名。
- **配置零值语义**：`parseRuntimeConfig` 对 `0` 是**保留**的（不会 `|| default`），这个细节做得比大多数项目好——问题只在于**非法值**没有拦。

---

## 9. 行动清单（按 ROI 排序）

| # | 动作 | 工作量 | 收益 |
|---|---|---|---|
| 1 | 接 ESLint（§6.1 配置）+ `npm run lint` | 0.5 h | 立刻抓出 14 处运行期错误 |
| 2 | 修 P0-1（1 行）+ P1-1（2 处 × 6 行） | 2 h | 消除 `/reset` 崩溃 + 发送失败额度泄漏/审计丢失/假 429 |
| 3 | 贴吧 5 条正则换单遍扫描（或解析搬 worker） | 0.5-1 d | 消除 1-7 秒的事件循环卡死（可被第三方页面触发） |
| 4 | `saveSocialV2State()` 加 debounce + `renameSync` 改异步 | 0.5 d | 每消息 35-100 ms 阻塞 → 接近 0 |
| 5 | token 账本"批量淘汰 + 只在实际丢弃时 rewrite" | 2 h | 饱和后每条事件 21 ms → 归零 |
| 6 | `sendChain` 按 key 分链 | 0.5 d | 一条慢语音不再拖垮所有会话 |
| 7 | 语音限流改预占 + ticket 回滚（顺带修 7 处 `indexOf(now)`） | 0.5 d | 并发绕限流 / 假 429 |
| 8 | `safeFetch` 加 `allowHost` 逐跳白名单 + `buildTiebaImageContent` 补 `isTiebaImageHost` | 2 h | 堵住"图床 302 → 任意公网"这条链路 |
| 9 | `runtime-config` 上字段 schema + deny fail-closed | 1 d | 关掉一条 fail-open 的限流/权限缺口 |
| 10 | `state-acl` 改 SID + 中文错误判定 | 2 h | 中文 Windows 上"假安全"变真安全 |
| 11 | 测试门禁补齐 90→119；`test-console` 改 dry-run | 1 d | 门禁可信度 75% → 100% |
| 12 | CI（1 个 workflow）+ Windows-only 测试 skip | 0.5 d | 从"作者手动回归"到"每次 push 自动验证" |
| 13 | dsh-client 加握手/空闲超时 + `!tokenExplicit` 守卫 | 0.5 d | 消灭"DSH 在线但收不到事件" / 永久 401 |
| 14 | `model-prices` / `wake-policy` 的原型链索引改 `hasOwn` | 0.5 h | 消灭一类 `TypeError` / 优先级比较失效 |
| 15 | 拆 `bridge.js`（§6.2 顺序） | 3-5 d | 唯一的结构性技术债 |
| 16 | 补/改 10 处断链文档 | 0.5 d | 代码注释不再指向不存在的文件 |

第 1-2 项合计不到 3 小时，消掉的是**唯一一个 P0 和影响面最大的 P1**；第 3-8 项是"机器人变哑/变卡"这一类症状的根因，建议一周内做完。

---

## 附录 A：本报告之后的改动（2026-10-24 晚）

本报告是评审，不含代码改动。之后按用户要求先做了「记忆」这一块，顺带修了与之直接相关的一个 P0：

| 项 | 状态 | 说明 |
|---|---|---|
| **P0-1** `/reset` 的 `oldSessionId` | ✅ 已修 | 改为 `delete(old)`。注意：这一行在文件里**出现两处**（控制台 `/api/session/reset` 与 QQ 管理命令 `/reset`），控制台那处的 `oldSessionId` 本来就是对的；首次改动误伤了控制台分支，被 `test-audit-bridge.mjs` 的 “console reset cleanup” 用例当场拦下（500 ≠ 200），已按「最近声明」规则重新定位 |
| **记忆注入字符预算** | ✅ 新增 | `socialV2.memory.maxInjectChars`（默认 1800，400~8000）+ `traitsRenderMax`（默认 4）。纯算法在 `src/core/memory-budget.mjs`，接线在 `formatMemoryV2`；裁剪留痕（模型知道被省了什么、去哪查全量） |
| 上限吃满时的注入体积 | ✅ 实测 | 6,561 字符 → 1,632 字符（**−75%**）；典型一周的群（10 话题 + 5 熟人）通常在 700 字符上下，**不会触发裁剪**（预算是天花板，不是目标值） |
| 按需读取不裁剪 | ✅ | `qq_get_prompt` / `qq_memory_query` 走 `memoryReadBudgetV2()`（≥4000），否则用户刚让模型查的东西会被同一条预算裁掉 |
| 测试 | ✅ | 新增 `test-memory-budget.mjs`（12 项，纯算法）+ `test-memory-inject.mjs`（7 项，真桥接 VM 接线）；门禁 90 → **92**，实跑 **87/92**（5 项失败均为既有环境依赖：Windows 专用 cmd/chcp、本机未装 DSH 工具包、2 个悬空 Promise 用例） |

本次**未**改动（仍按本报告 §4 待排期）：P1-1（发送失败回滚的 `budgetSt`/`now`）、P1-2（每消息全量落盘）、P1-3（全局 sendChain）、P1-10（贴吧正则 O(n²)）、P1-11（账本饱和后全量重写）。

---

## 附录 B：唤醒概率的时段缩放（2026-11-05）

用户要求：DS 波峰时段与北京时间 0–8 点降低主动/概率唤醒的频率，但不能影响人为唤醒。

**做法**：新增 `src/core/wake-time-scale.mjs`（纯函数）+ `socialV2.wakeTimeScale` 配置，把原先硬编码在
`scheduleProactiveCheckV2` 里的 `hour >= 23 || hour < 8 → prob *= 0.3` 换成可配置的乘数，并接到其余三个
"摇概率"的软唤醒路径（`triggers.probability`、一代 `triggerProbability` / `proactiveProbability` /
`idleRetryProbability`）。

| 项 | 值 |
|---|---|
| 默认乘数 | 睡觉 0–8 点 ×0.2；DS 波峰 ×0.5；同时命中 ×0.1 |
| DS 波峰定义 | **复用** `model-prices.js` 的 `peakWindows/peakWeekdays/holidays`（与计价表同源，不另立一套） |
| 小时来源 | `beijingParts()`（固定 UTC+8），**不再用** `new Date().getHours()` |
| 显式触发 | @、名字、关键词、提问、拍一拍、指定成员、私聊、管理员命令 —— 一律不经过乘数 |
| 可观测 | `/api/status` 新增 `wakeTimeScale{scale,hour,clock,sleep,dsPeak,desc}`；被压低导致未唤醒时每会话 4 小时记一条 `[wake-scale]` |
| 测试 | `test-wake-time-scale.mjs`（12 项，纯窗口/乘数）+ `test-wake-time-scale-integration.mjs`（8 项，真桥接；其中 3 项专门断言 scale=0 时 @/关键词/私聊照样唤醒） |

**顺带修掉的两个既有缺陷**：

1. `proactive.activeHours` 用的也是 `new Date().getHours()` —— 云主机 TZ=UTC 时整段窗口偏移 8 小时。已改北京时间。
2. 时段乘数最初被我插在 `aiCount >= 5 → prob *= 0.3` **之前**，导致"刷屏后少主动"这条衰减失效（自审时发现，
   并补了顺序护栏断言：`aiCount` 那行必须出现在 `probByTime` 之前）。

---

## 附录 C：A/B/C 三档整改（2026-11-05）

按"全部都改"的要求，把报告 §4/§5/§5.5 里除架构拆分外的项目都做掉了。

### A 档（延迟与成本）

| 项 | 做法 | 效果 |
|---|---|---|
| **A1 每条消息全量落盘** | `saveSocialV2StateSoon()`：只在**入站消息**那条热路径合并写（`socialV2.state.saveDebounceMs`，默认 400ms）；`saveSocialV2State()` 仍同步，且会取消待写。退出/取消/异常路径都 `flushSocialV2SaveAtExit()` | 30 会话从"每条消息 5.5MB / 29ms+6.6ms"变成窗口内一次 |
| **A2 全局 sendChain 串行** | `enqueueSend(key, task)` + `sendChains: Map`：**会话内串行、会话间互不阻塞**；链尾吞掉失败避免毒化后续发送；媒体（语音/图片/表情）、文本、分条、重试通知全部改造 | 一条慢语音不再堵死所有会话 |
| **A3 唤醒样板 2,301 字符/次** | `wakeProseModeV2()`：`socialV2.wake.promptDedupe`（默认首轮 + 每 4 轮发全量），其余轮次省掉反 AI 味/积极性/表情策略/沉睡前观察四段静态说明，换成一句"规则同上轮"；**状态行一律保留** | 约 −660 字符/次（≈29%）；沉睡前观察本来就有桥接侧硬执行 |
| **A4 一代无时段闸门** | 抽出 `outsideProactiveHoursV2()`，二代与一代共用 `socialV2.proactive.activeHours` | 一代不再凌晨按概率主动 |

### B 档（稳健性与成本）

| 项 | 做法 |
|---|---|
| **B5 贴吧正则 O(n²) + 图床白名单** | 5 处正则改单遍扫描（见子代理报告）；`safeFetch/safeFetchBuffer` 加 `opts.allowHost` 逐跳校验；`buildTiebaImageContent` 补 `isTiebaImageHost` 并夹紧 `maxImages/maxBytes` |
| **B6 账本写放大** | 批量淘汰（到 90%）+ 高水位 1.1× + **5% 死区**（结构性开销可能本身就高于高水位，只按倍数判断会换个形状复发）；`compact()` 失败清 tmp；`maxLines` 归一。实测 200 次重写 → **1 次** |
| **B7 丢唤醒无补投** | 限频跳过时排 `replyCheck`；暂停恢复与"切回二代"时 `replayBacklogWakesV2()` 把有 unread 的会话重新排上 |
| **B8 mux 无超时** | 握手超时默认 10s；**空闲超时默认关闭**（安静时段 DSH 本就不发帧，误判会周期性重连并清空在途状态） |
| **B9 中文 Windows 假安全** | `classifyIcaclsOutput()` 多语言判定 + 退出码/stderr 也算失败；授权改 well-known SID；自检改成真读凭据文件；新增 `isHardened()` 供启动时"先查再改" |
| **B10 MCP 定时器** | `withDeadline()` 替代永不清理的 race；取消分支不再返回永不 settle 的 Promise；`ended` 加兜底 |

### C 档（工程化）

- `eslint.config.mjs` + `npm run lint`：只开抓 bug 的规则。**上线即抓到我自己引入的两个真 bug**（`flushSocialV2Save` 在 `main()` 闭包里、退出钩子在模块顶层够不到；以及 `wake` 键重复把整块默认值覆盖成 undefined）。
- `.github/workflows/ci.yml`：`npm ci` → patch → lint → 全量审计；排除项显式写在 workflow 里（需要本机 Windows / 本机 DSH 的三个脚本），runner 会把排除清单打进日志。
- `test-console.mjs` 默认 dry-run（`QQ_BRIDGE_CONSOLE_LIVE=1` 才真跑），人格文件改成"原来有就还原"。
- 门禁 90 → **104 项**：补进 7 个此前零入口但自包含的测试，加 4 个新回归（state-acl / 账本压缩 / mux 超时 / 记忆与时段缩放）。

### 部署

见 `docs/DEPLOY-LINUX-2026-11-05.md`：systemd 常驻 + 2GB swap + 两处本机适配（内网 IP 铸 Cookie、Cookie 名字端口口径双发）。

---

## 附录 D：2026-11-05 部署当天发现并修掉的两个真 bug

都是**上线后才暴露**、静态检查和既有测试都抓不到的那类。

### D1 SnowLuma 后启动 → 桥接静默失聪

`SnowLuma` 的 OneBot WS 服务端要等 **QQ 登录成功**后才监听。桥接若先启动，首次 `connect()`
直接失败；而 SDK 的自动重连挂在 `close` 事件上，**这次只发了 `error`、没发 `close`** ——
于是 `connectPromise` 永久挂在原地，之后每次 `connect()` 都原样返回那个死 promise。

症状极具误导性：HTTP 探活正常（`good: true`）、日志只有一条 `SnowLuma 错误: {}`、消息一条收不到。

修法（`src/bridge.js`）：15 秒兜底巡检，未连接就 **先 `bot.close()` 拆掉卡住的连接、再 `connect()`**，
只在状态翻转时打日志。实测：iptables 掐断 3001 → 重启桥接 → 出现「SnowLuma 未连接：开始定期重试」
→ 恢复端口 5 秒内自动连上。

### D2 巡逻静默时段 / 每日上限按宿主时区算（TZ=UTC 时整体偏 8 小时）

`isPatrolQuietHour` 用 `getHours()`、`patrolDayKey` 用本地日期。云主机 TZ=UTC，于是：

- 「夜里 01:00–08:00 静默」实际变成「**北京时间 09:00–16:00** 静默」——半夜照逛、白天装睡；
- 「每日 12 次」在北京时间 08:00 重置，凌晨那几小时被算进前一天。

同一个坑 `socialV2.proactive.activeHours` 早前已踩过并修好（`bridge.js` 里有注释），贴吧这处漏了。
修法：两处都改成固定 +8 的北京时区口径（与 `model-prices.beijingParts` 一致），
测试加了两条 UTC 宿主回归（北京 09:05 = UTC 01:05 必须放行；北京 01:05 必须静默）。

### D3 MCP 工具在网络错误时只会说「等待失败: socket hang up」

模型据此判断「等待工具坏了」，反复重试、连收尾都做不成。新增
`src/core/retry-http.mjs`（纯判定，9 项单测）：连接**没建立**（ECONNREFUSED 等）任何工具都可安全重试；
连接**中途断开**（ECONNRESET / socket hang up）只重试**只读**调用——发送类重试会导致重复发送。
错误文案改成「连不上桥接控制台…稍后重试；这是连接问题，不是工具失效。（已自动重试 1 次仍失败）」。

顺带修好两处测试夹具：`test-qq-model-view` 的临时目录复制清单漏了新增的 `src/core/`（子进程在
import 阶段就退出，报错只剩 `MCP error -32000: Connection closed`）。
