// core/retry-http.mjs 的回归：决定「失败一次要不要再试」。
//
// 这条判定的代价是双向的：
//   · 该重试却不重试 → 桥接重启 3 秒，模型以为「等待工具坏了」，把回合收得乱七八糟；
//   · 不该重试却重试 → **重复发消息**（发送请求已经到达并执行，只是响应没回来）。
// 所以两种方向都要钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRetryRequest,
  networkErrorHint,
  isConnectError,
  isDropError,
  isAbortError,
  errorChain,
  CONNECT_ERROR_CODES,
  DROP_ERROR_CODES
} from '../src/core/retry-http.mjs';

const netError = (code, message = 'x') => Object.assign(new Error(message), { code });
const fetchFailed = (causeCode, causeMessage = 'x') => {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error(causeMessage), { code: causeCode });
  return error;
};

test('连接被拒：任何工具都能安全重试（请求根本没发出去）', () => {
  assert.equal(shouldRetryRequest({ error: netError('ECONNREFUSED'), isReadOnly: false }), true);
  assert.equal(shouldRetryRequest({ error: netError('ECONNREFUSED'), isReadOnly: true }), true);
  // fetch 把真正原因藏在 cause 里，判定必须能穿透
  assert.equal(shouldRetryRequest({ error: fetchFailed('ECONNREFUSED'), isReadOnly: false }), true);
});

test('中途断开：只读可重试，发送类绝不重试（避免重复发送）', () => {
  const hangUp = new Error('socket hang up');
  assert.equal(shouldRetryRequest({ error: hangUp, isReadOnly: true }), true);
  assert.equal(shouldRetryRequest({ error: hangUp, isReadOnly: false }), false);
  assert.equal(shouldRetryRequest({ error: netError('ECONNRESET'), isReadOnly: false }), false);
  assert.equal(shouldRetryRequest({ error: netError('ECONNRESET'), isReadOnly: true }), true);
  assert.equal(shouldRetryRequest({ error: fetchFailed('UND_ERR_SOCKET'), isReadOnly: false }), false);
});

test('调用方中止/超时：不重试（重试只会让预算更糟）', () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.equal(shouldRetryRequest({ error: abort, isReadOnly: true }), false);
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  assert.equal(shouldRetryRequest({ error: timeout, isReadOnly: false }), false);
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(timeout), true);
});

test('本层只重试一次', () => {
  assert.equal(shouldRetryRequest({ error: netError('ECONNREFUSED'), isReadOnly: true, alreadyRetried: true }), false);
});

test('普通业务错误不重试，文案原样透出', () => {
  const business = new Error('白名单不允许发送到该会话');
  assert.equal(shouldRetryRequest({ error: business, isReadOnly: false }), false);
  assert.equal(shouldRetryRequest({ error: business, isReadOnly: true }), false);
  assert.equal(networkErrorHint(business), '白名单不允许发送到该会话');
});

test('connect 与 drop 不会互相误判（ECONNRESET 不能当成连接被拒）', () => {
  // 同时带 ECONNRESET 码和 "fetch failed" 文案 —— 必须判成 drop，否则发送类工具会被重试
  const ambiguous = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
  assert.equal(isConnectError(ambiguous), false);
  assert.equal(isDropError(ambiguous), true);
  assert.equal(shouldRetryRequest({ error: ambiguous, isReadOnly: false }), false);
  // 纯 "fetch failed"（没有 code、没有 drop 痕迹）按连接失败处理
  assert.equal(isConnectError(new TypeError('fetch failed, reason: connect ECONNREFUSED')), true);
});

test('错误链有深度上限，不会跟着循环引用跑飞', () => {
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b;
  b.cause = a; // 人为造环
  const chain = errorChain(a, { maxDepth: 4 });
  assert.equal(chain.length, 4);
  assert.deepEqual(chain.map((e) => e.message), ['a', 'b', 'a', 'b']);
});

test('提示文案：说清是连接问题 + 让模型稍后重试，而不是"工具坏了"', () => {
  const hint = networkErrorHint(new TypeError('fetch failed'));
  assert.match(hint, /桥接|连接/);
  assert.match(hint, /稍后重试/);
  assert.match(hint, /不是工具失效/);
  const dropHint = networkErrorHint(new Error('socket hang up'));
  assert.match(dropHint, /断开|重启/);
  assert.doesNotMatch(hint, /等待失败:$/); // 旧的空泛指代
});

test('错误码集合本身是分开的（防止未来改坏）', () => {
  for (const code of CONNECT_ERROR_CODES) assert.equal(DROP_ERROR_CODES.has(code), false, `${code} 同时出现在两组里`);
});
