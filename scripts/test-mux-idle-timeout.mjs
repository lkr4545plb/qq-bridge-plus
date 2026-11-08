// `remote.mux` 事件流的**握手/空闲超时**回归测试。
//
// 背景（真实缺陷）：生成器全程只有一个 2 秒的重订阅 setTimeout，没有任何 deadline。
// 对端半开（进程被挂起、NAT 表项过期、防火墙静默丢包）时既收不到帧、也不会收到
// close/error，于是 `for await` 永不返回也不抛错 —— 调用方的 catch/finally/重连全都不
// 触发。外部现象是「DSH 明明在线，但一条事件都收不到」，会话永久 busy，而且没有任何日志。
//
// 本测试用**假 WebSocket** 精确控制「建连 / 发帧 / 沉默」，不连真实 DSH、不发网络请求。
// 超时全部用 30–120ms 级别，不真等 10s/90s。
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 假 WebSocket：只实现生成器真正用到的表面（add/removeEventListener、send、close、
 * readyState、静态状态常量），并记录**解析后**的出站帧，便于断言 follow/$events 的 streamId。
 */
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static sockets = [];

  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sentFrames = [];
    this._listeners = new Map();
    FakeWebSocket.sockets.push(this);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }

  send(data) { this.sentFrames.push(JSON.parse(data)); }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', {});
  }

  _emit(type, event) { for (const fn of [...(this._listeners.get(type) ?? [])]) fn(event); }

  /** 模拟建连成功。 */
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this._emit('open', {}); }

  /** 模拟服务端下发一帧（生成器要求 data 是字符串）。 */
  frame(obj) { this._emit('message', { data: JSON.stringify(obj) }); }

  /** 生成器发给某个 endpoint 的 open 帧里的 streamId。 */
  streamIdOf(endpoint) {
    const frame = this.sentFrames.find((f) => f?.type === 'open' && f?.endpoint === endpoint);
    return frame?.streamId ?? null;
  }
}

// 生成器里用的是**全局** WebSocket，所以必须在 import dsh-client 之前装好。
globalThis.WebSocket = FakeWebSocket;

const {
  NodeApiClient,
  MUX_HANDSHAKE_TIMEOUT_MS,
  MUX_IDLE_TIMEOUT_MS,
  MUX_HANDSHAKE_TIMEOUT_CODE,
  MUX_IDLE_TIMEOUT_CODE,
} = await import(pathToFileURL(path.join(ROOT, 'src/dsh-client.js')).href);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 测试自己的 keep-alive。
 *
 * 被测的握手/空闲计时器全部 unref()（这是需求的一部分：不得阻止进程退出），
 * 而测试进程里没有桥接那样的 server/socket 一直占着事件循环 —— 结果是 Node 判定
 * 「没有待处理的句柄」直接退出，node:test 把用例标记成 cancelledByParent。
 * 所以这里**刻意**占一个 ref 的 interval，让断言有机会跑完；用例结束后清掉。
 */
let keepAliveTimer = null;
before(() => { keepAliveTimer = setInterval(() => {}, 1000); });
after(() => { if (keepAliveTimer !== null) clearInterval(keepAliveTimer); });

/** 造一个最小可用的 client：跳过真实鉴权，其余（baseUrl / _desiredFollows）用真的。 */
function makeClient({ follows = [] } = {}) {
  const client = new NodeApiClient('http://127.0.0.1:1', undefined, {});
  const state = { invalidated: 0 };
  client.ensureAuth = async () => { client.cookie = 'fixture-cookie'; };
  client.invalidateAuth = () => { state.invalidated += 1; };
  for (const sid of follows) client._desiredFollows.add(sid);
  return { client, state };
}

const lastSocket = () => FakeWebSocket.sockets.at(-1);

// ── 默认值 ────────────────────────────────────────────────────────────────
test('默认超时：握手 10s、空闲 90s，且两个超时各有稳定 code', () => {
  assert.equal(MUX_HANDSHAKE_TIMEOUT_MS, 10_000);
  assert.equal(MUX_IDLE_TIMEOUT_MS, 90_000);
  assert.equal(MUX_HANDSHAKE_TIMEOUT_CODE, 'mux/handshake-timeout');
  assert.equal(MUX_IDLE_TIMEOUT_CODE, 'mux/idle-timeout');
});

// ── 握手超时 ──────────────────────────────────────────────────────────────
test('握手阶段一帧都没有 → handshakeTimeoutMs 后抛错，并走完清理', async () => {
  const { client, state } = makeClient();
  const before = FakeWebSocket.sockets.length;
  const iterator = client._remoteMuxGenerator(undefined, () => {}, {
    handshakeTimeoutMs: 40,
    idleTimeoutMs: 5_000,
  });

  await assert.rejects(
    async () => { for await (const _ of iterator) { /* 不该收到任何帧 */ } },
    (error) => {
      assert.match(error.message, /DSH 事件流握手超时（40ms）/);
      assert.equal(error.code, MUX_HANDSHAKE_TIMEOUT_CODE, '调用方靠 code 区分「流不可用」与「流坏了」');
      return true;
    }
  );

  const socket = FakeWebSocket.sockets[before];
  assert.ok(socket, '应该建过一条 WebSocket');
  assert.equal(socket.readyState, FakeWebSocket.CLOSED, '超时后 socket 必须被关掉');
  assert.equal(state.invalidated, 1, '沿用 endStream 的清理路径：丢弃旧 Cookie 以便重连重鉴权');
  assert.equal(client._muxSendOpen, null, '_muxSendOpen 必须复位，否则重连后不再重放 follow');
});

test('握手超时后 generator 可再次迭代（异常不会把实例弄坏）', async () => {
  const { client } = makeClient();
  const opts = { handshakeTimeoutMs: 30, idleTimeoutMs: 5_000 };
  await assert.rejects(async () => {
    for await (const _ of client._remoteMuxGenerator(undefined, () => {}, opts)) { /* noop */ }
  }, /握手超时/);

  // 第二次照样能建连、能收帧：说明第一次的 finally 没留下脏状态。
  const iterator = client._remoteMuxGenerator(undefined, () => {}, { handshakeTimeoutMs: 2_000, idleTimeoutMs: 2_000 });
  const consumer = (async () => { for await (const _ of iterator) { /* noop */ } })();
  await sleep(5);
  const socket = lastSocket();
  socket.simulateOpen();
  await sleep(5);
  assert.ok(socket.sentFrames.some((f) => f.endpoint === '$events'), '重连后应重新发 $events open');
  socket.close();
  await consumer;
});

// ── 空闲超时 ──────────────────────────────────────────────────────────────
test('连上后停止发帧 → idleTimeoutMs 后流结束并抛错', async () => {
  const { client, state } = makeClient();
  const iterator = client._remoteMuxGenerator(undefined, () => {}, {
    handshakeTimeoutMs: 2_000,
    idleTimeoutMs: 60,
  });
  const received = [];
  const consumer = (async () => {
    for await (const envelope of iterator) received.push(envelope);
  })();

  await sleep(5);
  const socket = lastSocket();
  socket.simulateOpen();
  await sleep(5);
  // 一帧（畸形也无所谓）把它从「握手」推进到「已连上」，之后不再发任何帧。
  socket.frame({ type: 'item', streamId: 'unknown-stream', value: { type: 'noop' } });

  await assert.rejects(consumer, (error) => {
    assert.match(error.message, /DSH 事件流空闲超时（60ms）/);
    assert.equal(error.code, MUX_IDLE_TIMEOUT_CODE);
    return true;
  });
  assert.equal(received.length, 0, '沉默期不应产生任何信封');
  assert.equal(state.invalidated, 1, '空闲超时同样走 endStream 的清理路径');
});

// ── 不误杀 ────────────────────────────────────────────────────────────────
test('持续发帧（间隔 < idle 超时）不误杀：20 帧全部收到', async () => {
  const { client } = makeClient({ follows: ['sess-1'] });
  const abort = new AbortController();
  const iterator = client._remoteMuxGenerator(abort.signal, () => {}, {
    handshakeTimeoutMs: 2_000,
    idleTimeoutMs: 120,
  });
  const received = [];
  const consumer = (async () => {
    for await (const envelope of iterator) received.push(envelope);
  })();

  await sleep(5);
  const socket = lastSocket();
  socket.simulateOpen();
  await sleep(5);
  const sessionStream = socket.streamIdOf('session/follow');
  assert.ok(sessionStream, 'open 后必须发 session/follow');

  // 20 帧 × 20ms = 400ms，远大于 idle 的 120ms；但每两帧的间隔只有 20ms，不该被判空闲。
  for (let turn = 1; turn <= 20; turn += 1) {
    socket.frame({
      type: 'item',
      streamId: sessionStream,
      value: { type: 'event', event: { type: 'turn/start', data: { turn } } },
    });
    await sleep(20);
  }
  assert.equal(received.length, 20, `应收到全部 20 帧，实际 ${received.length}`);
  assert.ok(
    received.every((envelope) => envelope?.payload?.type === 'session/event'),
    '每帧都应映射成 session/event 信封'
  );

  abort.abort();
  await consumer;   // 主动中止：正常结束，不抛
});

test('畸形帧也算「活着」，不会触发空闲超时', async () => {
  const { client } = makeClient();
  const abort = new AbortController();
  const iterator = client._remoteMuxGenerator(abort.signal, () => {}, {
    handshakeTimeoutMs: 2_000,
    idleTimeoutMs: 80,
  });
  const consumer = (async () => { for await (const _ of iterator) { /* noop */ } })();
  await sleep(5);
  const socket = lastSocket();
  socket.simulateOpen();
  for (let i = 0; i < 5; i += 1) {
    // 不是合法 JSON：解析会失败并丢掉，但字节到达本身已证明对端活着。
    socket._emit('message', { data: '{not json' });
    await sleep(30);
  }
  abort.abort();
  await consumer;
});

// ── 计时器不残留 ──────────────────────────────────────────────────────────
test('所有计时器都调用了 unref()（不钉住进程退出）', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const records = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = originalSetTimeout(fn, ms, ...args);
    const record = { ms, unrefed: false };
    records.push(record);
    if (handle && typeof handle.unref === 'function') {
      const originalUnref = handle.unref.bind(handle);
      handle.unref = () => { record.unrefed = true; return originalUnref(); };
    }
    return handle;
  };
  try {
    const { client } = makeClient();
    await assert.rejects(async () => {
      for await (const _ of client._remoteMuxGenerator(undefined, () => {}, {
        handshakeTimeoutMs: 30,
        idleTimeoutMs: 30,
      })) { /* noop */ }
    }, /握手超时/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  const muxTimers = records.filter((r) => r.ms === 30);
  assert.ok(muxTimers.length >= 1, `应观察到 mux 自己的计时器，实际记录：${JSON.stringify(records)}`);
  assert.ok(muxTimers.every((r) => r.unrefed), '握手/空闲计时器都必须 unref()');
});

// ── 既有行为不回退 ────────────────────────────────────────────────────────
test('abort 后不再重放 follow，也不会再有 timer 触发', async () => {
  const { client } = makeClient({ follows: ['sess-9'] });
  const abort = new AbortController();
  const iterator = client._remoteMuxGenerator(abort.signal, () => {}, {
    handshakeTimeoutMs: 2_000,
    idleTimeoutMs: 2_000,
  });
  const consumer = (async () => { for await (const _ of iterator) { /* noop */ } })();
  await sleep(5);
  const socket = lastSocket();
  socket.simulateOpen();
  await sleep(5);
  const framesBeforeAbort = socket.sentFrames.length;

  abort.abort();
  await consumer;

  await sleep(30);
  assert.equal(socket.sentFrames.length, framesBeforeAbort, '中止后不应再有出站帧');
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});
