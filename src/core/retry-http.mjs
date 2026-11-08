// 桥接 HTTP 调用的「要不要重试」判定 —— 纯函数，无 IO，可离线单测。
//
// 背景（2026-11-05 实测踩到）：桥接重启时，正在长轮询 `qq_wait_for_messages` 的 MCP 工具
// 会收到 `socket hang up`，模型看到的是「等待失败」四个字，于是判断「等待工具坏了」，
// 反复重试、最后连收尾都做不成。实际上桥接几秒后就恢复了 —— 缺的只是一次重试和一句人话。
//
// 但**不能无脑重试**：
//   · 发送类工具重试会**重复发消息**（请求可能已经到达并执行，只是响应没回来）；
//   · 连接被拒（ECONNREFUSED）则相反 —— 请求根本没发出去，任何工具都能安全重试。
//
// 所以判定分三档：
//   1. 调用方主动中止（AbortError / TimeoutError）→ 不重试，那是预算用完了；
//   2. 连接建立失败（ECONNREFUSED / ENETUNREACH / EHOSTUNREACH / 连接超时）→ 任何工具都可重试；
//   3. 连接已建立但中途断开（ECONNRESET / EPIPE / socket hang up / UND_ERR_SOCKET）→ **只读才重试**。

/** 连接**根本没建立**的错误码：请求一定没到达服务端。 */
export const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DNS_LOOKUP_FAILED'
]);

/** 连接建立后**中途断开**的错误码：请求可能已经被执行。 */
export const DROP_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED'
]);

/** 这些名字说明是「预算用完了」，不是网络坏了。 */
export const ABORT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/** 递归取出错误链上的所有 code/name/message（fetch 会把真正原因藏在 cause 里）。 */
export function errorChain(error, { maxDepth = 4 } = {}) {
  const out = [];
  let cursor = error;
  for (let depth = 0; cursor && depth < maxDepth; depth += 1) {
    out.push({
      code: typeof cursor.code === 'string' ? cursor.code : '',
      name: typeof cursor.name === 'string' ? cursor.name : '',
      message: typeof cursor.message === 'string' ? cursor.message : ''
    });
    cursor = cursor.cause ?? cursor.errors?.[0] ?? null;
  }
  return out;
}

const anyMatch = (chain, predicate) => chain.some(predicate);
const codeIn = (set) => (entry) => set.has(entry.code);
const MESSAGE_HINTS = {
  connect: [/ECONNREFUSED/i, /request to .* failed, reason:/i],
  drop: [/socket hang up/i, /other side closed/i, /premature close/i, /aborted/i, /fetch failed/i]
};

/** 是不是「调用方自己中止的」。 */
export function isAbortError(error) {
  const chain = errorChain(error);
  return anyMatch(chain, (e) => ABORT_ERROR_NAMES.has(e.name)) || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * 判定顺序（踩过坑，别随手改）：
 *   `TypeError: fetch failed` 是**两种故障共同的外壳** —— 连接被拒和连接中途断开都长这样。
 *   所以必须：① 先看结构化的 code；② 再看比 code 更具体的文案（ECONNREFUSED / reason: connect）；
 *   ③ 最后才用兜底的 "fetch failed" 文案，并按**中途断开**处理（对发送类是保守的那一侧）。
 *
 * 曾经把 ③ 放在 ② 前面，于是 `fetch failed, reason: connect ECONNREFUSED` 被判成 drop，
 * 只读工具白白丢掉了一次本该做的重试。
 */
const hasCode = (chain, set) => anyMatch(chain, codeIn(set));
const hasMessage = (chain, hints) => anyMatch(chain, (e) => hints.some((re) => re.test(e.message)));

/** 连接是否压根没建立（请求一定没到达服务端）。 */
export function isConnectError(error) {
  const chain = errorChain(error);
  if (hasCode(chain, CONNECT_ERROR_CODES)) return true;   // ① 结构化：确定没连上
  if (hasCode(chain, DROP_ERROR_CODES)) return false;     //    结构化：已经连上又断了
  if (hasMessage(chain, MESSAGE_HINTS.connect)) return true; // ② 比 code 具体的文案
  if (hasMessage(chain, MESSAGE_HINTS.drop)) return false;   // ③ 只剩 "fetch failed" 这类外壳 → 按断开算
  return false;
}

/** 连接建立后中断（请求可能已经执行）。 */
export function isDropError(error) {
  const chain = errorChain(error);
  if (hasCode(chain, DROP_ERROR_CODES)) return true;
  if (hasCode(chain, CONNECT_ERROR_CODES)) return false;
  if (hasMessage(chain, MESSAGE_HINTS.connect)) return false;
  return hasMessage(chain, MESSAGE_HINTS.drop);
}

/**
 * 这次失败要不要再试一次？
 * @param {object} args
 * @param {unknown} args.error - 捕获到的错误
 * @param {boolean} args.isReadOnly - 该请求是否**幂等/只读**（发送类工具必须传 false）
 * @param {boolean} [args.alreadyRetried] - 是否已经重试过（本层只重试一次）
 */
export function shouldRetryRequest({ error, isReadOnly, alreadyRetried = false } = {}) {
  if (alreadyRetried) return false;
  if (isAbortError(error)) return false; // 预算用完 / 调用方取消：重试只会让它更慢
  if (isConnectError(error)) return true; // 请求没发出去，重试零风险
  if (isDropError(error) && isReadOnly) return true; // 可能已执行 → 只有只读能重试
  return false;
}

/**
 * 把底层网络错误翻成模型能据此决策的一句话。
 * 目标：模型读到之后应当**稍后重试或收尾**，而不是认为「这个工具坏了」。
 */
export function networkErrorHint(error) {
  const chain = errorChain(error);
  const raw = chain.map((e) => e.message).find(Boolean) ?? String(error?.message ?? error ?? '未知错误');
  if (isAbortError(error)) return `请求超时或被取消（${raw}）`;
  if (isConnectError(error)) {
    return `连不上桥接控制台（${raw}）——通常意味着桥接正在启动或已停止。稍后重试；这是连接问题，不是工具失效。`;
  }
  if (isDropError(error)) {
    return `桥接连接中途断开（${raw}）——通常是桥接正在重启。稍后重试；这是连接问题，不是工具失效。`;
  }
  return raw;
}
