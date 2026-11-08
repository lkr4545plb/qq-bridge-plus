// 记忆注入的**接线**测试：跑真实 src/bridge.js（VM + 假 DSH/QQ），断言唤醒实际拿到的
// 记忆文本受 `socialV2.memory.maxInjectChars` 约束。
//
// 与 `test-memory-budget.mjs` 的分工：
//   · 那边测纯算法（输出永不超过预算、裁剪顺序、计数）；
//   · 这边测**桥接有没有真的用上它**——预算读的是配置、唤醒与按需读取走的是不同预算、
//     裁掉之后有没有留痕。纯算法全绿但没接线，是这类改动最常见的失败方式。
import assert from 'node:assert/strict';
import test from 'node:test';

import { busyHarness } from './busy-watchdog-harness.mjs';

const KEY = 'group:456';
const LONG = '这是一条被刻意拉长的话题描述，用来把注入文本推过预算'.repeat(6);

/** 造一份"内容明显超预算"的会话记忆：10 条长话题 + 5 个带 5 条 traits 的群友 + 3 条想法。 */
function seed(st) {
  const now = Date.now();
  st.activeTopics = Array.from({ length: 10 }, (_, i) => ({
    text: `话题${i}：${LONG}`,
    lastMentionAt: now - i * 60_000,
    pendingQuestion: '',
    participants: ['甲', '乙'],
  }));
  st.pendingThoughts = Array.from({ length: 3 }, (_, i) => ({
    text: `想说但没说 ${i}：${LONG.slice(0, 60)}`,
    createdAt: now,
    expiresAt: now + 3_600_000,
    motivation: 'curiosity',
  }));
  st.memberImpressions = {};
  for (let i = 0; i < 5; i += 1) {
    const uid = String(10001 + i);
    st.memberImpressions[uid] = {
      name: `群友${i}`,
      uid,
      traits: ['话多', '爱用梗', '夜猫子', '程序员', '偏好短句'],
      interactionCount: i + 1,
      lastSeenAt: now - i * 1000,
    };
  }
  return st;
}

test('唤醒注入的记忆受 maxInjectChars 约束，且裁剪后留痕', async (t) => {
  const bridge = await busyHarness({ config: { socialV2: { memory: { maxInjectChars: 600, traitsRenderMax: 2 } } } });
  t.after(() => bridge.stop?.());

  const st = seed(bridge.getSocialV2State(KEY));
  const injected = bridge.formatMemoryV2(st, { key: KEY });

  assert.ok(injected.length <= 600, `注入 ${injected.length} 字，超出 600 的预算`);
  assert.ok(injected.includes('【进行中的话题】'), '高优先级的话题段应被保留');
  assert.ok(/记忆已按 600 字预算省略/.test(injected), '裁掉必须留痕，并写清预算值');
  assert.ok(injected.includes('qq_memory_query'), '留痕里必须告诉模型去哪看全量');
  // 注：这里不断言 traits——600 的预算下印象段（优先级低于话题）会被整段裁掉，
  // traits 的截断行为放在下面「traitsRenderMax」两个用例里单独断言。
});

test('traits 只展示 traitsRenderMax 条，并注明剩余几条', async (t) => {
  const bridge = await busyHarness({ config: { socialV2: { memory: { maxInjectChars: 4000, traitsRenderMax: 2 } } } });
  t.after(() => bridge.stop?.());

  const st = seed(bridge.getSocialV2State(KEY));
  st.activeTopics = [];        // 只留印象段
  st.pendingThoughts = [];
  const text = bridge.formatMemoryV2(st, { key: KEY });
  assert.ok(text.includes('【对群友的印象】'));
  assert.ok(text.includes('话多、爱用梗'), '应展示前 2 条 traits');
  assert.ok(text.includes('（另 3 条未展开）'), `应注明还有 3 条未展示，实际：${text.slice(0, 260)}`);
  assert.ok(!text.includes('程序员'), '第 3 条之后的 traits 不该出现在提示里');
});

test('预算来自配置：改小配置，注入随之变短（不是写死的常量）', async (t) => {
  const small = await busyHarness({ config: { socialV2: { memory: { maxInjectChars: 400 } } } });
  t.after(() => small.stop?.());
  const stSmall = seed(small.getSocialV2State(KEY));
  const textSmall = small.formatMemoryV2(stSmall, { key: KEY });

  assert.ok(small.memoryInjectConfV2().maxInjectChars === 400);
  assert.ok(textSmall.length <= 400, `实际 ${textSmall.length}`);
});

test('按需读取（qq_get_prompt / qq_memory_query）用放宽的预算，拿到比唤醒更多的内容', async (t) => {
  const bridge = await busyHarness({ config: { socialV2: { memory: { maxInjectChars: 400, traitsRenderMax: 4 } } } });
  t.after(() => bridge.stop?.());

  const st = seed(bridge.getSocialV2State(KEY));
  const wake = bridge.formatMemoryV2(st, { key: KEY });
  const read = bridge.formatMemoryV2(st, { key: KEY, maxChars: bridge.memoryReadBudgetV2() });

  assert.ok(bridge.memoryReadBudgetV2() >= 4000, '读取预算至少 4000，否则会把用户刚查的东西也裁掉');
  assert.ok(read.length > wake.length, `读取(${read.length}) 应比唤醒(${wake.length}) 更长`);
  assert.ok(read.length <= 4000, `读取也不能无界，实际 ${read.length}`);
});

test('traitsRenderMax=0 时不展示任何 trait，但仍如实说明有几条', async (t) => {
  const bridge = await busyHarness({ config: { socialV2: { memory: { traitsRenderMax: 0, maxInjectChars: 4000 } } } });
  t.after(() => bridge.stop?.());

  const st = seed(bridge.getSocialV2State(KEY));
  st.activeTopics = [];   // 只留印象段，断言更好读
  st.pendingThoughts = [];
  const text = bridge.formatMemoryV2(st, { key: KEY });
  assert.ok(text.includes('【对群友的印象】'));
  assert.ok(text.includes('（5 条未展开）'), `应写明 5 条未展开，实际：${text.slice(0, 200)}`);
  assert.ok(!text.includes('话多'), 'traitsRenderMax=0 时一条 trait 都不该出现');
});

test('include 过滤仍然有效：关掉 memberImpression 后不出现印象段', async (t) => {
  const bridge = await busyHarness({ config: { socialV2: { memory: { maxInjectChars: 4000 } } } });
  t.after(() => bridge.stop?.());

  const st = seed(bridge.getSocialV2State(KEY));
  const text = bridge.formatMemoryV2(st, { key: KEY, include: { memberImpression: false, pendingThought: false } });
  assert.ok(text.includes('【进行中的话题】'));
  assert.ok(!text.includes('【对群友的印象】'));
  assert.ok(!text.includes('【你想说但还没说的】'));
});

test('唤醒提示里带的是裁剪后的记忆块，不是全量', async (t) => {
  const bridge = await busyHarness({ config: { socialV2: { memory: { maxInjectChars: 600 } } } });
  t.after(() => bridge.stop?.());

  seed(bridge.getSocialV2State(KEY));
  const prompt = bridge.buildWakePromptV2(KEY, 'replyCheck');
  const start = prompt.indexOf('【进行中的话题】');
  assert.ok(start >= 0, '唤醒提示里应包含记忆块');
  const end = prompt.indexOf('（记忆已按 600 字预算省略');
  assert.ok(end > start, '唤醒提示里的记忆块应是裁剪过的（带留痕）');
  const block = prompt.slice(start, prompt.indexOf('\n', end) + 1);
  assert.ok(block.length <= 600 + 120, `记忆块 ${block.length} 字，明显超出预算`);
});
