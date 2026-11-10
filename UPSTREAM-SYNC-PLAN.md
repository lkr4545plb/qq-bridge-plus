# 上游 qq-bridge 同步盘点与移植清单（2026-11-10）

- 上游 remote 已加入本地：`qqbridge` = https://github.com/Derpyu520/qq-bridge.git（main 已 fetch，可直接 `git show qqbridge/main:src/xxx`）
- merge-base = `f6f128a`（2026-08-25 20:57 +0800）；两侧内容在 `9df6a7e`/`89c3dc1`（2026-10-03）树哈希完全一致 = 真实分叉点
- 上游分叉后 116 提交：33 个 patch-id 等价已在本地（10-03 前那批）；63 个未匹配 ≈ 34 个实质代码提交 + 29 个文档/CI/治理/merge
- 上游最新提交 `4ed0142`（2026-11-06）；src/ 层面 22 文件 +4686/-760，新增 4 文件

## 结论：不能 `git merge` / 整体 cherry-pick
本地 81 提交深度重构：bridge.js 15,236 行 vs 上游 13,048 行（diff ≈ 万行）；拆出 `src/core/` 25 模块；
新增 console/、贴吧、语音收发、ASR、图库、掉线告警、模型管理。直接 merge 会产生上千处冲突。
策略 = **零冲突直拿 + 手工逐项移植**。

## A. 已等价落地（勿重复移植）
| 上游项 | 本地对应 |
|---|---|
| dsh-endpoint.js 桌面随机端口发现（7fff72e） | src/dsh-desktop.js（tasklist+netstat 方案）已解决 |
| P0 `{{cwd}}`（374cb4f） | 本地 preset 无 `{{cwd}}`（dsh-021-team-patch.mjs 自做 0.2.1 适配） |
| df700c3 发送队列按会话分链 | enqueueSend/sendChainKeyOf（bridge.js:9945），且多了 lastSendFailed 不吞错 |
| 596626f sendChain ReferenceError | 本地实现不同（sendMessagesV2），无此 bug |
| 7c86cdd 唤醒注入完整人格卡 | bridge.js:12713 已有（mtime 缓存不截断） |

## B. P0 安全修复（本地确认缺失，优先移植）
1. **4ed0142+28bf1de 令牌拆条绕过**：本地 `onebotSend`（bridge.js:10047）只有逐条 `includes` 精确匹配，
   `sendMessagesV2`（bridge.js:10377）整批无 join 检查 → 拆条即可绕过。上游加 `hasKnownTokenFragment` + 整批前置拒绝
2. **1d6f889 sanitizeUntrustedText**（qq-model-view.js 新函数）群友可控文本入模净化 — 本地完全没有
3. **b9d6a84 敏感闸门伪装归一化**：本地 sensitive.js 仅 15 行（上游 80 行的子集）→ 整文件替换，冲突≈0
4. **c59443c** web_search/web_fetch 结果套不可信数据外壳
5. **90b413b** 消息 messageId 幂等入库 + 撤回事件处理 — 本地无任何撤回处理
6. **4d19073** forward-media 只读本会话媒体 + 媒体抓取端口白名单（safe-fetch.js `validateFetchUrl`）
7. **4de160b** 表情备注/黑话按会话隔离（sticker-lib.js / slang-learner.js + bridge 接线）
8. **040f159** 执行期会话绑定 selfKeyGuard（mcp-snowluma-safe.js）
9. **snowluma-conn.js:146** 本地日志泄露 token 前 4 字符（`slice(0,4)+'…'`），上游已改 `(已配置)` — 1 行
10. **voice-core.js** symlink/junction 逃逸（resolveExistingParent）— 本地 `catch{return abs}` 弱校验；
    ⚠️ 与本地 EPERM（ffprobe 输出文件）修复做双向合并，别整文件覆盖

## C. 功能优化/bug 修复（值得移植）
1. aa0b80b DSH 0.2.2 自定义模型思考强度（dsh-client.js）— 本地缺 reasoning/thinking 传参
2. web-search.js（新 496 行）DSH 同源联网搜索 + mcp-web-search-safe 重设计 — 本地还是旧版 Bing 版
3. md-to-plain.js ReDoS 限幅（`{0,500}`）+ "2*3*4" 斜体误删修复
4. forward.js emoji 代理对安全截断（truncateText）
5. mcp-host-server.js `server.tool`→`registerTool`+Zod（MCP SDK 新 API）
6. 2649f94 wait 并发拒绝补 retryAfterMs — 本地无
7. 6ccee53 定时器钳制 `Math.min(86400000, Math.max(0, …))` — 本地 sleep（bridge.js:696）完全无钳制
8. 176433a #93 reserved2 两处修复；239e6b9 prompt 错误外发收紧；0b2b373 相对实例路径拒绝停止
9. state-acl.mjs `hasPermissionGrant` + SID（S-1-5-11/32-545/1-0）检测增强 — 本地 360 行版部分有，缺 hasPermissionGrant
10. 2aca5a3 隐私扫描漏报/静默截断修复 — 对照吸收进本地 scripts/privacy-scan.mjs
11. token-ledger.js evictionCovered 等
12. 0ac4233 scripts/stop-bridge-instance.mjs（299 行运维脚本）+ 断线补发

## D. 治理项（自行定夺，非代码同步）
- 上游 license 改 PolyForm-Noncommercial-1.0.0（e29cff6），本地已改 MIT — 方向相反

## 进度（2026-11-10 更新）

### 批次 1 已完成（7 个 commit，全部测试通过）
| commit | 内容 |
|---|---|
| b99b859 | snowluma-conn 令牌前缀脱敏 |
| 114a215 | sensitive.js 伪装归一化 + base64 形态识别 |
| ef34490 | md-to-plain ReDoS 限幅 + 斜体误删 |
| 566f160 | forward emoji 安全截断 |
| 6f4d232 | mcp-host-server registerTool 迁移 |
| 993f139 | web-search.js 同源搜索 + 不可信外壳 + 端口白名单（含 safe-fetch 增量与测试夹具） |
| d8882ec | 本文档 |

验证：test-audit 106/109（3 个失败均为改动前既有：test-preset-local-tools、
test-dsh-cli-resolve、test-dsh-discovery-logging）；test-quick 64/66（同两项既有）；
test-md / test-forward / test-audit-security / test-audit-security-mcp / test-mcp-web-search /
token-economy 全绿（改动后无回归，已用 stash 做过基线对比）。

### 产品需求（非上游项，2026-11-10）
- ✅ **qq_set_effort 权限开放**（commit 4fbc07f）：agent 可改自己会话的思考强度覆盖，
  全局仍属管理员；控制台工具开关可关；v2 提示词已补说明

### 批次 2 进度

#### 已完成
- ✅ **令牌拆条绕过**（4ed0142+28bf1de，commit d62751f）— bridge.js 片段闸门 +
  整批审计 + redactKnownTokensOnly 整条替换；新增 test-token-fragment-guard.mjs
  （未修复代码上实测拆两段 HTTP 200，修复后全拒）；审计 107/110（失败集=既有 3 项）

- ✅ **dsh-client 思考强度**（aa0b80b，commit 757b765）— normalize 放宽 + none 标记 +
  GET options 跟随目录 + ensureChatModel 两段式降级（拒绝档位即换无 effort 段）
- ✅ **safe-fetch 端口白名单周边**（commit 23bff19）— resolveTarget/validateFetchUrl
  支持 allowPorts；多地址重试（IPv4 优先/8s 软预算/最多 4 地址）修「表情包时好时坏」
  根因；Azure WireServer 168.63.129.16 拦截；保留 t78 头部追加能力
- ✅ **voice-core 双向合并**（commit f66ae94）— resolveExistingParent 校验已有父目录
  （修 junction 逃逸漏判）；保留本地 fd 重定向 EPERM 修复；test-voice-gui +2 用例（旧代码 21/1）

#### 待办（按优先级）
1. sanitizeUntrustedText（1d6f889）— qq-model-view + bridge 接线
2. sanitizeUntrustedText（1d6f889）— qq-model-view + bridge 接线
3. 消息幂等入库 + 撤回事件（90b413b）— bridge.js
4. forward-media 会话校验（4d19073）— bridge.js 侧（forward 端点侧本地已有部分）
5. 表情/黑话会话隔离（4de160b）
6. selfKeyGuard 执行期会话绑定（040f159）
7. voice-core symlink 逃逸双向合并；state-acl hasPermissionGrant
8. DSH 0.2.2 思考强度（aa0b80b）— dsh-client

## 移植顺序建议（每项独立 commit，可回滚）
1. 零冲突直拿：snowluma-conn(1行) / sensitive(整文件) / md-to-plain / forward / mcp-host-server / web-search.js 新增
2. 单文件：dsh-client 思考强度、safe-fetch 端口白名单、voice-core 双向合并
3. bridge.js 逐项手工：令牌拆条 → sanitizeUntrustedText → 幂等+撤回 → media 会话校验 → 表情/黑话隔离 → 定时器钳制
4. 每项移植后跑 `npm run test:audit` + 对应 test 脚本
