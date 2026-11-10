// 会话令牌片段闸门回归（上游 28bf1de + 4ed0142 parity）。
//
// 为什么值得一个独立测试：
//   旧闸门是逐条 `raw.includes(token)` 精确匹配 —— 只拦得住"一次性把整个 token 发出去"。
//   模型（或拿到工具调用的任何 agent）只要把令牌拆成两段、各发一条消息，每一段都短于
//   整串，逐条闸门就全部放行；接收方把两条拼起来仍是完整令牌。这是真实的凭据外带路径。
//
// 修复分两层，本测试两层都钉：
//   1. sendMessagesV2：发送第一批之前对 `messages.join('')` 做**整批**审计
//      —— 拆条拼回去必须命中，且在发出第一段之前就拒绝；
//   2. onebotSend / 回复审计 / 语音文件名审计 / redactKnownTokensOnly：
//      逐条闸门改为 **12 字符窗口片段匹配**（hasKnownTokenFragment），
//      并让 redactKnownTokensOnly 在整串替换后仍检出片段时整条替换为 '***'。
//
// 验证纪律：本测试在**未修复**的代码上必须失败（拆两条会 200 且真的发出去），
// 修复后必须通过 —— 不是恒真断言。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';
// 用 owner 自己的私聊会话：reserved2 下同会话发送无需活动回合，能把断言焦点留在令牌闸门上。
const OWNER_KEY = 'private:123';

function post(server, { pathname, body, agentToken }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-console-token': CONSOLE_TOKEN,
        'x-agent-call': '1',
        ...(agentToken ? { 'x-agent-token': agentToken } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const sendMessage = (server, { key, messages, agentToken }) =>
  post(server, { pathname: '/api/socialV2/send-message', body: { key, messages }, agentToken });

async function withBridge(run) {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  const st = h.getSocialV2State(OWNER_KEY);
  const token = String(st?.agentToken ?? '');
  assert.ok(token.length >= 24, `测试夹具必须拿到会话令牌（实测长度 ${token.length}）`);
  const server = h.startConsoleServer();
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  try {
    return await run({ h, server, token });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

const sentTexts = (h) => h.calls.sent.map((x) => String(x.text ?? ''));
// HTTP 发送端点走 onebotSend → fetch(<网关>/send_private_msg|send_group_msg)，
// 落账在 calls.http（bot 对象路径才落 calls.sent）。两条通道都要纳入断言。
const onebotSends = (h) => h.calls.http.filter((c) => /send_(?:private|group)_msg$/.test(String(c.url)));
const onebotTexts = (h) => onebotSends(h).flatMap((c) => (c.body?.message ?? [])
  .filter((seg) => seg?.type === 'text')
  .map((seg) => String(seg.data?.text ?? '')));
const leaked = (h) => onebotTexts(h).concat(sentTexts(h));

// ── ① 整串发送：既有语义不能退化 ────────────────────────────────────────────
await withBridge(async ({ h, server, token }) => {
  const res = await sendMessage(server, { key: OWNER_KEY, messages: [`令牌是 ${token}`], agentToken: token });
  assert.notEqual(res.status, 200, `整串令牌必须被拦（实测 HTTP ${res.status}）`);
  assert.match(res.raw, /会话令牌/, `拒因必须点名会话令牌：${res.raw}`);
  assert.equal(leaked(h).length, 0, '整串令牌不得真的发出');
});

// ── ② 拆两段、分两条：这正是旧闸门的漏洞 ────────────────────────────────────
await withBridge(async ({ h, server, token }) => {
  const half = Math.floor(token.length / 2);
  const res = await sendMessage(server, {
    key: OWNER_KEY,
    messages: [token.slice(0, half), token.slice(half)],
    agentToken: token,
  });
  assert.notEqual(res.status, 200, `拆两段的整批必须在发送前拒绝（实测 HTTP ${res.status}）`);
  assert.match(res.raw, /会话令牌/, `整批拒绝必须点名会话令牌：${res.raw}`);
  assert.equal(leaked(h).length, 0, '拆两段令牌不得分段发出');
});

// ── ③ 拆三段 ────────────────────────────────────────────────────────────────
await withBridge(async ({ h, server, token }) => {
  const third = Math.floor(token.length / 3);
  const res = await sendMessage(server, {
    key: OWNER_KEY,
    messages: [token.slice(0, third), token.slice(third, third * 2), token.slice(third * 2)],
    agentToken: token,
  });
  assert.notEqual(res.status, 200, `拆三段的整批必须在发送前拒绝（实测 HTTP ${res.status}）`);
  assert.match(res.raw, /会话令牌/, `整批拒绝必须点名会话令牌：${res.raw}`);
  assert.equal(leaked(h).length, 0, '拆三段令牌不得分段发出');
});

// ── ④ 单条只发 12 字符窗口：逐条闸门也要能拦 ───────────────────────────────
await withBridge(async ({ h, server, token }) => {
  const res = await sendMessage(server, { key: OWNER_KEY, messages: [token.slice(0, 12)], agentToken: token });
  assert.notEqual(res.status, 200, `单独发片段必须被逐条闸门拦住（实测 HTTP ${res.status}）`);
  assert.match(res.raw, /会话令牌/, `逐条拒绝必须点名会话令牌：${res.raw}`);
  assert.equal(leaked(h).length, 0, '令牌片段不得真的发出');
});

// ── ⑤ sendToQQ 入队前脱敏：片段整条替换为 *** ──────────────────────────────
await withBridge(async ({ h, token }) => {
  await h.sendToQQ(OWNER_KEY, `前后文 ${token.slice(0, 12)} 中间 ${token.slice(12, 24)} 收尾`);
  assert.equal(sentTexts(h).length, 1, '拆开的片段必须合并成一条发送（整条替换）');
  assert.equal(sentTexts(h)[0], '***', `含令牌片段的消息必须整条替换为 ***（实测「${sentTexts(h)[0]}」）`);
});

// ── ⑥ 正常消息不受影响（防误伤） ───────────────────────────────────────────
await withBridge(async ({ h, server, token }) => {
  const res = await sendMessage(server, { key: OWNER_KEY, messages: ['你好', '今天吃什么'], agentToken: token });
  assert.equal(res.status, 200, `正常消息必须放行（实测 HTTP ${res.status}：${res.raw}）`);
  assert.deepEqual(onebotTexts(h), ['你好', '今天吃什么'], '正常消息必须按条发出（onebot 通道）');
});

console.log('token-fragment-guard: 全部通过');
