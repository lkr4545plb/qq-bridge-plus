// 守卫：**所有发送类端点**都必须支持跨会话代发（`crossSessionSendCheckV2`）。
//
// 为什么值得一个测试：这不是某个端点写错了，而是一类反复复发的遗漏 ——
// 每个发送端点都各自写一遍 `if (!agentTokenOk(key, token)) → 403`，而"机器人在私聊里
// 被叫去群里说话"这个常见场景要求它接受 owner 私聊令牌。漏了的端点表现为：
//   群里发文字正常 → 发语音 403 → 修好 → 发表情 403 → 修好 → 发图片 403 ...
// 2026-11-08 一天之内连续踩了三次（语音 / 图片 / 表情+戳一戳），所以用静态扫描钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const LINES = SRC.split('\n');

/** 取某个端点块：从声明行到「下一个 if (req.method ===」之前。 */
function endpointBlock(endpoint) {
  const marker = `url.pathname === '${endpoint}'`;
  const start = LINES.findIndex((l) => l.includes(marker));
  if (start === -1) return null;
  let end = start + 1;
  while (end < LINES.length && !LINES[end].includes("if (req.method === '")) end += 1;
  return LINES.slice(start, end).join('\n');
}

/** 所有会**向 QQ 投递**的端点。新增发送端点时必须加进这个清单。 */
const SEND_ENDPOINTS = [
  '/api/socialV2/send-message',
  '/api/socialV2/send-burst',
  '/api/socialV2/send-image',
  '/api/socialV2/send-sticker',
  '/api/socialV2/send-voice',
  '/api/socialV2/speak',
  '/api/send/group',
  '/api/send/private',
  '/api/send/reply'
];

/** 明确**不需要**跨会话的端点（只读检查，不投递）。 */
const READ_ONLY_ENDPOINTS = ['/api/socialV2/check-send'];

/**
 * 有副作用但**有意不纳入**跨会话的端点：拍一拍。
 * 它是对「某个人」的动作，被跨会话代发后容易变成骚扰链（原设计即如此，见 bridge.js 的注释）。
 */
const DELIBERATELY_EXCLUDED = ['/api/socialV2/send-poke'];

test('每个发送类端点都实现了跨会话代发', () => {
  const missing = [];
  for (const ep of SEND_ENDPOINTS) {
    const block = endpointBlock(ep);
    if (block === null) { missing.push(`${ep}（端点不存在，清单过期？）`); continue; }
    if (!block.includes('agentTokenOk')) continue; // 无令牌体系的端点（操作者通道）不适用
    if (!block.includes('crossSessionSendCheckV2')) missing.push(ep);
  }
  assert.deepEqual(missing, [], `以下发送端点缺少跨会话代发（owner 私聊叫它去群里说话会被 403）：\n  ${missing.join('\n  ')}`);
});

test('跨会话豁免旁边必须留下审计日志（拒绝时要能查到是谁、发去哪）', () => {
  const missing = [];
  for (const ep of SEND_ENDPOINTS) {
    const block = endpointBlock(ep);
    if (!block || !block.includes('crossSessionSendCheckV2')) continue;
    if (!block.includes('logCrossSendDeniedV2')) missing.push(ep);
  }
  assert.deepEqual(missing, [], `以下端点的跨会话被拒时不留日志：${missing.join(', ')}`);
});

test('有意排除的端点（拍一拍）必须确实没有豁免', () => {
  for (const ep of DELIBERATELY_EXCLUDED) {
    const block = endpointBlock(ep);
    if (!block) continue;
    assert.equal(block.includes('crossSessionSendCheckV2'), false,
      `${ep} 被有意排除在跨会话之外（对某个人的动作，代发会变成骚扰链），不该出现代发逻辑`);
  }
});

test('只读检查端点不应被误加代发（避免把"能不能发"的探测变成实际放行）', () => {
  for (const ep of READ_ONLY_ENDPOINTS) {
    const block = endpointBlock(ep);
    if (!block) continue;
    assert.equal(block.includes('crossSessionSendCheckV2'), false, `${ep} 是只读端点，不该有代发逻辑`);
  }
});
